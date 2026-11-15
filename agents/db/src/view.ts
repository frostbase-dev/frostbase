import * as Sentry from '@sentry/cloudflare';
import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { corsHeadersFor, drainUnusedBody, withCors } from './access.js';
import * as schema from './db/schema.js';
import { ProjectJwtVerifier } from './jwt.js';
import migrations from './migrations.js';
import {
	parseViewRole,
	readViewSource,
	readViewSources,
	pruneViewSources,
	writeViewSource,
	type ViewRole,
	type ViewSourceRow,
} from './replication.js';
import { hasPermission } from './rules.js';
import { planDdl, quoteIdent, toSqlValue } from './table-schema.js';
import { prepareViewSql } from './table-sql.js';
import {
	logEntrySchema,
	storedViewConfigSchema,
	tableConfigSchema,
	tableSqlRequestSchema,
	viewConfigSchema,
	MAX_VIEW_LAG_MS,
	type DbRow,
	type LogEntry,
	type TableColumn,
	type TableConfig,
	type TableSqlResult,
	type ViewConfig,
	type ViewStatus,
} from './schemas.js';
import type { DbTable } from './table.js';

/**
 * `DbView` - the join view (JOIN1).
 *
 * A region replica is a Durable Object that follows ONE primary's change log
 * into a copy of ONE table. A view is the same machinery pointed at SEVERAL:
 * it bootstraps and then follows every member table's feed into ONE SQLite,
 * where a plain SELECT can join them. Writes never come here - they stay on
 * the member primaries, so sharding, write throughput, and every existing
 * shard's behaviour are untouched. This is additive by construction.
 *
 * What that buys, and what it costs, both stated plainly:
 *
 * - joins, subqueries across members, CTEs, window functions - anything
 *   SQLite can do over tables that are actually in one database;
 * - read-only, and eventually consistent within `MAX_VIEW_LAG_MS`. Two
 *   members pulled at different instants can show a join that never existed
 *   as a committed state. That is the bargain of a derived read copy, and it
 *   is why views are for reporting reads rather than for invariants;
 * - member rows are stored twice (once in the member, once here), against
 *   this instance's own 10 GB.
 *
 * A plain `DurableObject`, deliberately not a `LiveShard`: JOIN1 serves no
 * subscriptions, and a view that ran the live engine would be a second source
 * of truth for data it does not own. Live joins are JOIN2.
 */

/** Bootstrap snapshot paging - the member's own export chunk size. */
const SNAPSHOT_GUARD = 10_000;

type MemberState = { row: ViewSourceRow; config: TableConfig | null };

export class DbView extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;
	private readonly role: ViewRole | null;
	private migrated = false;
	private config: ViewConfig | null = null;
	private verifier: ProjectJwtVerifier | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
		this.role = parseViewRole(ctx.id.name);
	}

	private getVerifier(): ProjectJwtVerifier {
		if (!this.verifier) {
			this.verifier = new ProjectJwtVerifier(
				this.ctx.storage,
				this.env as { AUTH_AGENT?: Fetcher },
				this.role?.projectId ?? this.config?.projectId ?? '',
			);
		}
		return this.verifier;
	}

	private async ensureMigrated(): Promise<void> {
		if (this.migrated) return;
		await migrate(this.db, migrations);
		this.migrated = true;
		if (!this.config) {
			this.config = storedViewConfigSchema.parse(
				await this.ctx.storage.get<unknown>('view-config'),
			);
		}
	}

	// -------------------------------------------------------------------------
	// Parent-pushed configuration

	/**
	 * Parent -> view config push. Monotonic like the shard configs: a stale
	 * push after a failed retry can never regress a newer one.
	 *
	 * Dropping a member drops its LOCAL COPY too. Leaving the physical table
	 * behind would leave rows joinable through a view that no longer declares
	 * them - stale data reachable through a surface nobody thinks covers it.
	 */
	async configure(input: unknown): Promise<void> {
		await this.ensureMigrated();
		const next = viewConfigSchema.parse(input);
		if (this.config && next.configVersion < this.config.configVersion) return;

		const sql = this.ctx.storage.sql;
		for (const dropped of pruneViewSources(sql, next.members)) {
			sql.exec(`DROP TABLE IF EXISTS ${quoteIdent(dropped)}`);
		}
		for (const member of next.members) {
			if (readViewSource(sql, member)) continue;
			writeViewSource(sql, {
				table: member,
				epoch: 0,
				appliedLsn: 0,
				pulledAt: 0,
				config: null,
			});
		}

		this.config = next;
		await this.ctx.storage.put('view-config', next);
	}

	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	/** The multi-source answer to `repStatus`: one row per member. */
	async viewStatus(): Promise<ViewStatus> {
		await this.ensureMigrated();
		const sources = readViewSources(this.ctx.storage.sql);
		const members = await Promise.all(
			sources.map(async (row) => {
				let lagLsn: number | null = null;
				try {
					const status = await this.memberStub(row.table).repStatus();
					lagLsn = Math.max(0, status.lastLsn - row.appliedLsn);
				} catch {
					// A member being unreachable is a status gap, never an error:
					// the view keeps serving what it already has.
				}
				return {
					table: row.table,
					appliedLsn: row.appliedLsn,
					lagLsn,
					epoch: row.epoch,
					pulledAt: row.pulledAt ? new Date(row.pulledAt).toISOString() : null,
					bootstrapped: row.pulledAt > 0,
				};
			}),
		);
		const stalest = sources.reduce(
			(oldest, row) => (row.pulledAt && (!oldest || row.pulledAt < oldest) ? row.pulledAt : oldest),
			0,
		);
		return {
			view: this.role?.view ?? '',
			members,
			stalestPulledAt: stalest ? new Date(stalest).toISOString() : null,
		};
	}

	// -------------------------------------------------------------------------
	// HTTP surface: /agents/db-agent/<pid>/views/<v>/...

	async fetch(request: Request): Promise<Response> {
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)\/views\/([^/]+)(\/.*)?$/);
		if (!match) return Response.json({ error: 'not found' }, { status: 404 });

		await this.ensureMigrated();
		const config = this.config;
		if (!config || !this.role) {
			// Views are declared, never auto-created - the tables rule.
			return Response.json({ error: 'no such view - declare it first' }, { status: 404 });
		}

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, config.allowedOrigins);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		const subPath = match[3] ?? '/';
		if (subPath === '/sql' && request.method === 'POST') {
			return withCors(await this.handleSql(request, config), cors);
		}
		return withCors(Response.json({ error: 'not found' }, { status: 404 }), cors);
	}

	/**
	 * The read path. Order matters: gate the STATEMENTS first (a refusal must
	 * not depend on who is asking), then authorize, then freshen, then run.
	 */
	private async handleSql(request: Request, config: ViewConfig): Promise<Response> {
		const body = tableSqlRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ success: false, error: 'invalid sql request', issues: body.error.issues },
				{ status: 400 },
			);
		}
		const statements = 'batch' in body.data ? body.data.batch : [body.data];
		const prepared = [];
		for (const statement of statements) {
			const gate = prepareViewSql(statement.sql);
			if (!gate.ok) return Response.json({ success: false, error: gate.error }, { status: 400 });
			prepared.push({ sql: gate.sql, params: statement.params ?? [] });
		}

		// Token first (it is the cheapest refusal and the only one that needs no
		// member state), THEN freshen, THEN the per-member checks - in that
		// order for a reason, see authorizeMembers.
		const identified = await this.authorizeToken(request, config);
		if ('response' in identified) return identified.response;

		const ready = await this.freshen();
		if (!ready.ok) {
			return Response.json({ success: false, error: ready.error }, { status: ready.status });
		}

		const denied = this.authorizeMembers(identified.permissions);
		if (denied) return denied;

		try {
			const results = prepared.map((statement) => this.runSelect(statement.sql, statement.params));
			const payload =
				'batch' in body.data
					? { success: true as const, batch: results }
					: { success: true as const, result: results[0] };
			return Response.json(payload);
		} catch (error) {
			return Response.json(
				{ success: false, error: error instanceof Error ? error.message : String(error) },
				{ status: 400 },
			);
		}
	}

	/**
	 * A valid project token, plus the view's own permission key. Neither check
	 * needs any member state, so this is what runs before the view does any
	 * work on an unauthenticated caller's behalf.
	 */
	private async authorizeToken(
		request: Request,
		config: ViewConfig,
	): Promise<{ permissions: string[] | undefined } | { response: Response }> {
		const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
		if (!token) {
			return {
				response: Response.json(
					{ success: false, error: 'a view requires a project token' },
					{ status: 401 },
				),
			};
		}
		const verified = await this.getVerifier().verify(token);
		if (!verified.ok) {
			return {
				response: Response.json(
					{
						success: false,
						error:
							verified.code === 'not-configured'
								? 'auth verification is not configured'
								: 'invalid or expired token',
					},
					{ status: verified.code === 'not-configured' ? 503 : 401 },
				),
			};
		}
		if (!hasPermission(config.readPermission, verified.claims.permissions)) {
			return {
				response: Response.json(
					{ success: false, error: 'the token does not carry the required permission' },
					{ status: 403 },
				),
			};
		}
		return { permissions: verified.claims.permissions };
	}

	/**
	 * EVERY member's read permission. All of them, never any of them: a join
	 * reads each member, so anything less would let a view launder access to a
	 * table the caller could not read directly.
	 *
	 * Two things make this correct, and both were bugs first:
	 *
	 * - It runs AFTER `freshen()`. Member configs arrive from each member's
	 *   own feed, so before the first bootstrap there are none - and checking
	 *   permissions against an empty config set passes everything. The e2e
	 *   spec caught exactly that: an unentitled token read a permission-gated
	 *   member through a brand-new view, and only that view's FIRST request,
	 *   which is the worst possible shape for a hole.
	 * - A member with no config after freshening FAILS CLOSED (503). "We do
	 *   not know what this table requires" can never mean "so let it through".
	 *
	 * `owner` mode is refused when the view is declared and when a member is
	 * reconfigured, but it is re-checked here too: the config comes from the
	 * member's feed, so a member that turned owner-scoped underneath the view
	 * is caught before it is served rather than after.
	 */
	private authorizeMembers(permissions: string[] | undefined): Response | null {
		for (const member of this.members()) {
			const memberConfig = member.config;
			if (!memberConfig) {
				return Response.json(
					{
						success: false,
						error: `"${member.row.table}" has not replicated into this view yet - retry shortly`,
					},
					{ status: 503 },
				);
			}
			if (memberConfig.readAccess === 'owner') {
				return Response.json(
					{
						success: false,
						error: `"${member.row.table}" is owner-scoped - it cannot be read through a view`,
					},
					{ status: 403 },
				);
			}
			// The parent refuses this pairing when a view is declared or a member
			// reconfigured, so reaching it means the member closed AFTER the view
			// was built and the feed delivered the new config. Refusing here too
			// is what stops a join serving rows the member's own gate refuses -
			// the config arrives by replication, so there is a window.
			if (memberConfig.readAccess === 'none') {
				return Response.json(
					{
						success: false,
						error: `"${member.row.table}" is not readable over the public API - it cannot be read through a view`,
					},
					{ status: 403 },
				);
			}
			if (!hasPermission(memberConfig.readPermission, permissions)) {
				return Response.json(
					{
						success: false,
						error: `the token does not carry the permission "${member.row.table}" requires`,
					},
					{ status: 403 },
				);
			}
		}
		return null;
	}

	private runSelect(sql: string, params: unknown[]): TableSqlResult {
		const cursor = this.ctx.storage.sql.exec(sql, ...(params as (string | number | null)[]));
		const results = cursor.toArray() as Record<string, unknown>[];
		const columns = results.length ? Object.keys(results[0]) : [];
		return {
			results,
			columns,
			raw: results.map((row) => columns.map((column) => row[column])),
			meta: { changes: 0, rows_read: results.length, rows_written: 0 },
		};
	}

	// -------------------------------------------------------------------------
	// Following the members' feeds

	private members(): MemberState[] {
		return readViewSources(this.ctx.storage.sql).map((row) => ({
			row,
			config: row.config
				? tableConfigSchema.nullable().catch(null).parse(safeJson(row.config))
				: null,
		}));
	}

	private memberStub(table: string): DbTable {
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace;
		const projectId = this.role?.projectId ?? this.config?.projectId ?? '';
		return namespace.get(namespace.idFromName(`${projectId}:${table}`)) as unknown as DbTable;
	}

	/**
	 * Bring every member within the freshness window before a read.
	 *
	 * A member that has never bootstrapped BLOCKS the read (503): answering a
	 * join from a table that is not there yet would silently return fewer rows
	 * than exist, and a quietly wrong join is worse than a slow one. A member
	 * that is merely stale is pulled; if the pull fails but the member has
	 * data, the read proceeds against what is here - bounded staleness is the
	 * stated contract, and a member primary being briefly unreachable must not
	 * take the whole view down.
	 */
	private async freshen(): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
		const now = Date.now();
		for (const member of this.members()) {
			if (member.row.pulledAt === 0) {
				const booted = await this.bootstrapMember(member.row.table);
				if (!booted) {
					return {
						ok: false,
						error: `"${member.row.table}" is not replicated into this view yet - retry shortly`,
						status: 503,
					};
				}
				continue;
			}
			if (now - member.row.pulledAt >= MAX_VIEW_LAG_MS) {
				await this.pullMember(member.row.table);
			}
		}
		return { ok: true };
	}

	/**
	 * First contact with a member: register on its feed, copy its schema, page
	 * in its rows, and record the LSN the snapshot started from. Writes racing
	 * the snapshot are safe - applying the log from that LSN is idempotent by
	 * image, exactly as it is for a region replica.
	 */
	private async bootstrapMember(table: string): Promise<boolean> {
		const role = this.role;
		if (!role) return false;
		try {
			const primary = this.memberStub(table);
			const boot = (await primary.repBootstrap({
				since: 0,
				replicaId: role.followerId,
				region: role.region,
			})) as unknown as Awaited<ReturnType<DbTable['repBootstrap']>>;
			if (!boot.ok) return false;

			const config = tableConfigSchema.parse(boot.config);
			this.applyMemberSchema(config);
			this.ctx.storage.sql.exec(`DELETE FROM ${quoteIdent(config.table)}`);

			let afterId: string | undefined;
			for (let page = 0; page < SNAPSHOT_GUARD; page += 1) {
				const chunk = (await primary.repSnapshotChunk(afterId)) as unknown as Awaited<
					ReturnType<DbTable['repSnapshotChunk']>
				>;
				for (const row of chunk.docs) this.applyRowImage(config, row);
				if (chunk.nextAfterId === null) break;
				afterId = chunk.nextAfterId;
			}

			writeViewSource(this.ctx.storage.sql, {
				table,
				epoch: boot.epoch,
				appliedLsn: boot.lsn,
				pulledAt: Date.now(),
				config: JSON.stringify(config),
			});
			return true;
		} catch (error) {
			this.report(error, 'view-bootstrap', table);
			return false;
		}
	}

	/** Catch one member up. A resync or an epoch bump (the member was restored)
	 * re-bootstraps just that member - the others keep their positions. */
	private async pullMember(table: string): Promise<void> {
		const role = this.role;
		const sql = this.ctx.storage.sql;
		const source = readViewSource(sql, table);
		if (!role || !source) return;
		try {
			const primary = this.memberStub(table);
			let current = source;
			for (;;) {
				const result = await primary.repPull({
					since: current.appliedLsn,
					replicaId: role.followerId,
					region: role.region,
				});
				if (result.resync || result.epoch !== current.epoch) {
					await this.bootstrapMember(table);
					return;
				}
				const config = current.config
					? tableConfigSchema.nullable().catch(null).parse(safeJson(current.config))
					: null;
				for (const entry of result.entries)
					current.config = this.applyEntry(config, entry, current);
				current = {
					...current,
					appliedLsn: result.entries.length
						? result.entries[result.entries.length - 1].lsn
						: current.appliedLsn,
					pulledAt: Date.now(),
				};
				writeViewSource(sql, current);
				if (result.entries.length < 500) return;
			}
		} catch (error) {
			this.report(error, 'view-pull', table);
		}
	}

	/** Apply one log entry; returns the member config JSON to persist (a `cfg`
	 * entry replaces it, and its DDL is applied in write order with the data). */
	private applyEntry(
		config: TableConfig | null,
		entry: LogEntry,
		source: ViewSourceRow,
	): string | null {
		const parsed = logEntrySchema.parse(entry);
		if (parsed.op === 'cfg') {
			if (!parsed.image) return source.config;
			const next = tableConfigSchema.parse(JSON.parse(parsed.image));
			this.applyMemberSchema(next, config);
			return JSON.stringify(next);
		}
		if (!config) return source.config;
		if (parsed.op === 'del') {
			this.ctx.storage.sql.exec(
				`DELETE FROM ${quoteIdent(config.table)} WHERE "id" = ?`,
				parsed.id,
			);
			return source.config;
		}
		if (parsed.image) this.applyRowImage(config, JSON.parse(parsed.image) as DbRow);
		return source.config;
	}

	/** Create or extend the local copy of a member's physical table. The
	 * planner is the member's own (`planDdl`), so the copy's shape is produced
	 * by the same code that produced the original - never inferred here. */
	private applyMemberSchema(config: TableConfig, applied: TableConfig | null = null): void {
		const plan = planDdl(config.table, applied?.columns ?? null, config.columns);
		if (!plan.ok) return;
		for (const statement of plan.statements) {
			try {
				this.ctx.storage.sql.exec(statement);
			} catch (error) {
				// ADD COLUMN is not idempotent; a retry after a partial apply
				// re-runs statements that already landed.
				if (!/duplicate column name/i.test(String(error))) throw error;
			}
		}
	}

	private applyRowImage(config: TableConfig, row: DbRow): void {
		const columns: TableColumn[] = config.columns;
		const names = columns.map((column) => quoteIdent(column.name));
		const values = columns.map((column) => toSqlValue(column, row.data[column.name]));
		this.ctx.storage.sql.exec(
			`INSERT INTO ${quoteIdent(config.table)} ("id", "owner", "created_at", "updated_at"` +
				(names.length ? `, ${names.join(', ')}` : '') +
				`) VALUES (?, ?, ?, ?${names.length ? `, ${names.map(() => '?').join(', ')}` : ''})
			 ON CONFLICT("id") DO UPDATE SET "owner" = excluded."owner",
			   "created_at" = excluded."created_at", "updated_at" = excluded."updated_at"` +
				(names.length ? `, ${names.map((name) => `${name} = excluded.${name}`).join(', ')}` : ''),
			row.id,
			row.owner,
			Date.parse(row.createdAt),
			Date.parse(row.updatedAt),
			...values,
		);
	}

	private report(error: unknown, operation: string, table: string): void {
		try {
			Sentry.captureException(error, {
				level: 'error',
				tags: { operation, view: this.ctx.id.name ?? 'unknown', member: table },
			});
		} catch {
			// Reporting must never break the request path.
		}
	}
}

/** Stored JSON that predates a schema change must degrade, never throw. */
function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
