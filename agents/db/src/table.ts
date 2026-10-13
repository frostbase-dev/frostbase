import * as Sentry from '@sentry/cloudflare';
import { getAgentByName, type AgentNamespace } from 'agents';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from './migrations';
import { checkAccess, corsHeadersFor, drainUnusedBody, withCors } from './access';
import { primaryLocation } from './colo';
import { collectionMeta } from './db/schema';
import { ProjectJwtVerifier } from './jwt';
import { LiveShard, type LiveGate } from './live';
import {
	appendLog,
	clearReplicas,
	horizonLsn,
	lastLsn,
	listPushReplicas,
	listReplicas,
	pickSubscribeSibling,
	readReplicaMeta,
	regionSocketCounts,
	registerReplica,
	serveRepPull,
	setReplicaPush,
	truncateLog,
	writeReplicaMeta,
	type ReplicaMeta,
	type ReplicaRole,
} from './replication';
import { getPath, encodeCursor, decodeCursor, type DecodedCursor } from './query';
import { shardBookmarkForTime, shardCurrentBookmark, shardRestoreTo } from './pitr';
import { hasPermission } from './rules';
import { prepareTableSql } from './table-sql';
import {
	applyColumnDefaults,
	isDuplicateColumnError,
	planDdl,
	quoteIdent,
	rowDataFromSql,
	selectList,
	toSqlValue,
	uniqueViolationColumn,
	validateRow,
} from './table-schema';
import { compileTableAggregate, compileTableQuery } from './table-query';
import { v7 as uuidv7 } from 'uuid';
import {
	aggregateRequestSchema,
	createDocumentSchema,
	documentDataSchema,
	importLineSchema,
	logEntrySchema,
	querySchema,
	repApplyInputSchema,
	repPullInputSchema,
	repSetPushInputSchema,
	storedTableMetaSchema,
	tableConfigSchema,
	tableSqlRequestSchema,
	EXPORT_CHUNK,
	IMPORT_RPC_CHUNK,
	LSN_HEADER,
	MAX_DOC_BYTES,
	MAX_REGION_SIBLINGS,
	MAX_REPLICA_LAG_MS,
	MIN_LSN_HEADER,
	REPLICATION_PULL_CHUNK,
	SIBLING_SPAWN_SOCKETS,
	socketReportStep,
	type AggregateRequest,
	type AggregateResult,
	type BookmarkOutcome,
	type DbRow,
	type ImportReport,
	type LogEntry,
	type Query,
	type RestoreOutcome,
	type RepApplyResult,
	type RepPullResult,
	type RepStatus,
	type TableColumn,
	type TableConfig,
	type TableMeta,
	type TableSqlResult,
} from './schemas';
import { isDurableObjectReset, type DbAgent } from './agent';

/**
 * One SQL table: typed columns over a physical SQLite table NAMED AFTER the
 * declared table with plain reserved system columns (id, owner, created_at,
 * updated_at) - the ORM-compatibility contract: drizzle/prisma-generated SQL
 * reads and writes the real schema unmodified. The live-query engine and the
 * access gate are inherited from LiveShard/access.ts, shared verbatim with
 * DbCollection.
 *
 * Instance name: `<projectId>:<tableName>` in the DbTable namespace. Tables
 * are schema-first: there is NO auto-creation - an instance with no cached
 * meta pulls the parent's registry once, and an unregistered table answers
 * 404. The cached meta carries the pushed config AND the applied-schema
 * record (`appliedColumns`), which replaces introspection because
 * pragma_table_info is SQLITE_AUTH; configure() plans the DDL diff between
 * the two and only advances the record once every statement landed.
 */

const DEMO_MAX_ROWS_PER_TABLE = 200;
const DEMO_MAX_ROW_BYTES = 8 * 1024;
const STATS_REPORT_MS = 500;

/** Compile refusals surface as 400s at REST/RPC boundaries. */
class TableQueryError extends Error {}

export class DbTable extends LiveShard {
	private meta: TableMeta | null = null;
	private verifier: ProjectJwtVerifier | null = null;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;
	/** LSN of the current request's write, surfaced as the session bookmark. */
	private pendingLsn: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Idempotent - drizzle tracks applied migrations in its own table. Only
		// `subscriptions` and `collection_meta` are used here; the physical data
		// table is created by configure() from the declared columns and lives
		// entirely outside drizzle.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			this.meta = storedTableMetaSchema.parse(await this.loadStoredMeta());
		});
		// Absolute-count self-healing on every wake, exactly like collections.
		this.scheduleStatsReport();
	}

	private async loadStoredMeta(): Promise<unknown> {
		const [row] = await this.db.select().from(collectionMeta).limit(1);
		if (!row) return null;
		try {
			return JSON.parse(row.config);
		} catch {
			return null;
		}
	}

	private get config(): TableConfig | null {
		return this.meta?.config ?? null;
	}

	private get columns(): TableColumn[] {
		return this.meta?.config.columns ?? [];
	}

	// -------------------------------------------------------------------------
	// RPC surface (parent and worker entrypoint only - never public HTTP)

	/**
	 * Parent push on declare/config change. Stale versions are ignored. The
	 * DDL diff between the applied record and the declared columns runs FIRST;
	 * `appliedColumns` only advances when every statement landed, so a partial
	 * failure retries the remainder (ADD COLUMN tolerates "duplicate column
	 * name" - the already-applied detector - and index statements are
	 * IF [NOT] EXISTS). A genuine DDL failure (e.g. uniquifying a column with
	 * duplicate data) throws with SQLite's message for the parent to surface,
	 * and the previous meta stays authoritative.
	 */
	async configure(input: unknown): Promise<void> {
		const parsed = tableConfigSchema.parse(input);
		if (this.meta && parsed.configVersion < this.meta.config.configVersion) return;

		const applied = this.meta?.appliedColumns ?? null;
		const plan = planDdl(parsed.table, applied, parsed.columns);
		if (!plan.ok) {
			// The parent refuses destructive diffs before pushing; reaching this
			// is defensive, not expected.
			throw new Error(plan.reason);
		}
		for (const statement of plan.statements) {
			try {
				this.ctx.storage.sql.exec(statement);
			} catch (error) {
				if (isDuplicateColumnError(error)) continue;
				throw error;
			}
		}

		const previous = this.meta?.config;
		this.meta = { config: parsed, appliedColumns: parsed.columns };
		this.verifier = null;
		const serialized = JSON.stringify(this.meta);
		await this.db
			.insert(collectionMeta)
			.values({ id: 1, config: serialized, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: collectionMeta.id,
				set: { config: serialized, updatedAt: new Date() },
			});

		if (this.role.kind === 'primary') {
			if (parsed.replication === 'auto') {
				// Config AND schema changes replicate in write order: a replica
				// applying this entry runs the same DDL diff path.
				const image = JSON.stringify(parsed);
				const lsn = appendLog(this.ctx.storage.sql, 'cfg', '', image);
				this.schedulePush([{ lsn, op: 'cfg', id: '', image, ts: Date.now() }]);
			} else if (previous?.replication === 'auto') {
				await this.repDisable();
			}
		}
	}

	/** Operator query over the dashboard proxy (parent-forwarded). Compile
	 * refusals come back as a discriminated result - RPC error text is not a
	 * contract - and the parent answers 400 with the message. */
	async adminQuery(
		input: unknown,
	): Promise<{ ok: true; docs: DbRow[]; nextCursor?: string } | { ok: false; error: string }> {
		const query = querySchema.parse(input);
		try {
			return { ok: true, ...(await this.runQuery(query, null)) };
		} catch (error) {
			if (error instanceof TableQueryError) return { ok: false, error: error.message };
			throw error;
		}
	}

	/**
	 * Operator upsert (dashboard row editor). Structure always validates -
	 * the schema IS the storage - but policy rules (bounds/enum) are bypassed
	 * exactly like document validators on operator surfaces. With `ifAbsent`,
	 * an existing id reports a conflict instead of replacing.
	 */
	async adminPut(
		id: string,
		data: unknown,
		ifAbsent = false,
	): Promise<DbRow | { conflict: true } | { invalid: string[] }> {
		const parsed = documentDataSchema.parse(data);
		if (ifAbsent && this.rowById(id)) return { conflict: true };

		const full = applyColumnDefaults(this.columns, parsed);
		const issues = validateRow(this.columns, full, { skipPolicy: true });
		if (issues.length) return { invalid: issues };

		return this.writeRow(id, full, { owner: undefined });
	}

	/**
	 * Operator read by id - the collection twin.
	 *
	 * Tables could already do this through `POST /admin/tables/:name/sql`
	 * (`SELECT * FROM t WHERE id = ?`), but only because they happen to have a
	 * raw-SQL surface that collections do not. Going through SQL for a
	 * single-row read is not an API, and the two kinds must not need different
	 * idioms for the same operation.
	 */
	async adminGet(id: string): Promise<DbRow | null> {
		const row = this.rowById(id);
		return row ? this.toDto(row) : null;
	}

	/**
	 * Operator shallow merge - the public PATCH's semantics on the operator
	 * surface. STRUCTURE always validates (the schema is the storage) while
	 * policy bounds are bypassed, exactly like adminPut.
	 *
	 * Never creates: PUT is the upsert.
	 */
	async adminPatch(id: string, partial: unknown): Promise<DbRow | { invalid: string[] } | null> {
		const parsed = documentDataSchema.parse(partial);
		const existing = this.rowById(id);
		if (!existing) return null;

		const merged = { ...rowDataFromSql(this.columns, existing), ...parsed };
		const issues = validateRow(this.columns, merged, { skipPolicy: true });
		if (issues.length) return { invalid: issues };

		return this.writeRow(id, merged, { owner: (existing.owner as string | null) ?? null });
	}

	/** Operator delete. Returns false when the row does not exist. */
	async adminDelete(id: string): Promise<boolean> {
		return this.deleteRow(id, null);
	}

	/** Exact live count, for parent-initiated reconciliation. */
	async getRowCount(): Promise<number> {
		if (!this.meta) return 0;
		const [row] = this.ctx.storage.sql
			.exec(`SELECT COUNT(*) AS n FROM ${quoteIdent(this.meta.config.table)}`)
			.toArray() as { n: number }[];
		return row?.n ?? 0;
	}

	/** Operator export chunk (parent-forwarded; no owner scoping). Same page
	 * shape as the collection twin; the optional-string parameter rule from
	 * exportChunk there applies here too. */
	async exportChunk(afterId?: string): Promise<{ docs: DbRow[]; nextAfterId: string | null }> {
		const docs = this.exportTableRows(afterId ?? null, EXPORT_CHUNK, null);
		return { docs, nextAfterId: docs.length < EXPORT_CHUNK ? null : docs[docs.length - 1].id };
	}

	/**
	 * Operator import chunk (parent-forwarded), the collection contract on
	 * typed rows: upserts by id preserving owner and timestamps, so exported
	 * lines round-trip exactly. STRUCTURE always validates - the schema is
	 * the storage - but policy bounds are bypassed like every operator
	 * surface; per-line failures (bad types, UNIQUE violations, demo caps)
	 * are reported rather than fatal.
	 */
	async importRows(input: unknown): Promise<ImportReport> {
		const lines = z.array(importLineSchema).max(IMPORT_RPC_CHUNK).parse(input);
		const report: ImportReport = { imported: 0, updated: 0, errors: [] };

		for (const [index, line] of lines.entries()) {
			try {
				const full = applyColumnDefaults(this.columns, line.data);
				const sizeIssue = this.rowSizeIssue(full);
				if (sizeIssue) {
					report.errors.push({ line: index, error: sizeIssue });
					continue;
				}
				const issues = validateRow(this.columns, full, { skipPolicy: true });
				if (issues.length) {
					report.errors.push({ line: index, error: issues.join('; ') });
					continue;
				}
				const id = line.id ?? uuidv7();
				const existing = this.rowById(id);
				if (
					!existing &&
					this.config?.demo &&
					(await this.getRowCount()) >= DEMO_MAX_ROWS_PER_TABLE
				) {
					report.errors.push({
						line: index,
						error: `demo tables are capped at ${DEMO_MAX_ROWS_PER_TABLE} rows`,
					});
					continue;
				}
				await this.writeRow(id, full, {
					owner: line.owner ?? null,
					createdAt: line.createdAt ? Date.parse(line.createdAt) : undefined,
					updatedAt: line.updatedAt ? Date.parse(line.updatedAt) : undefined,
					replaceOwner: line.owner !== undefined,
				});
				if (existing) report.updated += 1;
				else report.imported += 1;
			} catch (error) {
				const column = uniqueViolationColumn(error);
				report.errors.push({
					line: index,
					error: column
						? `a row with that ${column} already exists (unique column)`
						: error instanceof Error
							? error.message
							: String(error),
				});
			}
		}
		return report;
	}

	/** Point-in-time restore - the shared pitr.ts sequence, table-labeled. */
	async restoreTo(input: unknown): Promise<RestoreOutcome> {
		return shardRestoreTo(this.ctx, input, {
			label: this.config?.table ?? 'unknown',
			closeReason: 'table restored',
		});
	}

	/** The current-moment bookmark, doubling as the PITR support probe. */
	async currentBookmark(): Promise<{ ok: true; bookmark: string } | { ok: false }> {
		return shardCurrentBookmark(this.ctx);
	}

	/** D1-restore-style timestamp -> closest-available-bookmark resolution. */
	async bookmarkForTime(input: unknown): Promise<BookmarkOutcome> {
		return shardBookmarkForTime(this.ctx, input);
	}

	/** Erase this table - the collection destroy sequence verbatim, with a
	 * primary destroying its registered replicas first. */
	async destroy(): Promise<void> {
		if (this.role.kind === 'primary') {
			await this.destroyReplicaInstances();
		}
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1001, 'table erased');
			} catch {
				// closing a half-dead socket must not block the erase
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// Replication (mirrors collection.ts's machinery; the table-specific parts
	// are the snapshot source and the row-image apply)

	private logChange(op: 'put' | 'del', id: string, image: string | null): void {
		const entry = this.appendChange(op, id, image);
		if (!entry) return;
		this.pendingLsn = entry.lsn;
		this.schedulePush([entry]);
	}

	/** Append one entry to the transactional change log and hand it back for
	 * the CALLER to deliver. The append rolls back with the data write it
	 * describes; the bookmark and the push must not - and sqlite_sequence
	 * rolls back too, so a rolled-back LSN is REISSUED to the next committed
	 * write. A push that escaped a rollback would therefore not only serve a
	 * phantom row: the replica's applied position would swallow the reissued
	 * LSN as a duplicate and silently drop a committed write, permanently.
	 * Anything running inside transactionSync may only COLLECT entries and
	 * act on them after the commit (see runSqlStatements). */
	private appendChange(op: 'put' | 'del', id: string, image: string | null): LogEntry | null {
		if (this.role.kind !== 'primary' || this.config?.replication !== 'auto') return null;
		const lsn = appendLog(this.ctx.storage.sql, op, id, image);
		return { lsn, op, id, image, ts: Date.now() };
	}

	/** REP2 delivery by RPC - the collection twin's reasoning applies.
	 * Entries must already be COMMITTED: never call this from inside a
	 * transaction, and never with an entry a rollback could retract. */
	private schedulePush(entries: LogEntry[]): void {
		const config = this.config;
		const name = this.ctx.id.name;
		if (!config || !name) return;
		const targets = listPushReplicas(this.ctx.storage.sql);
		if (!targets.length) return;

		const namespace = this.env.DbTable as unknown as DurableObjectNamespace<DbTable>;
		this.ctx.waitUntil(
			(async () => {
				for (const replica of targets) {
					try {
						const stub = namespace.get(namespace.idFromName(`${name}:${replica.id}`));
						const result = (await stub.repApply({
							entries,
							epoch: config.repEpoch,
						})) as RepApplyResult;
						if ('stop' in result) {
							setReplicaPush(this.ctx.storage.sql, replica.id, replica.region, { push: false });
						}
					} catch {
						// best-effort: the replica's pull path heals on next touch
					}
				}
			})(),
		);
	}

	async repSetPush(input: unknown): Promise<void> {
		if (this.role.kind !== 'primary') return;
		const parsed = repSetPushInputSchema.parse(input);
		setReplicaPush(this.ctx.storage.sql, parsed.replicaId, parsed.region, {
			push: parsed.push,
			sockets: parsed.sockets,
		});
	}

	/** Sibling routing for NEW subscribers; see DbCollection.repSubscribeTarget. */
	async repSubscribeTarget(region: string): Promise<number> {
		if (this.role.kind !== 'primary' || this.config?.replication !== 'auto' || this.config.demo) {
			return 1;
		}
		return pickSubscribeSibling(
			regionSocketCounts(this.ctx.storage.sql, region),
			this.spawnThreshold(),
			MAX_REGION_SIBLINGS,
		);
	}

	/** Env-overridable so the e2e stack can force spawn with 2 sockets. */
	private spawnThreshold(): number {
		return Number(this.env.SIBLING_SPAWN_SOCKETS ?? '') || SIBLING_SPAWN_SOCKETS;
	}

	async repApply(input: unknown): Promise<RepApplyResult> {
		if (this.role.kind !== 'replica') return { ok: true };
		const parsed = repApplyInputSchema.parse(input);
		if ((await this.subscriptionCount()) === 0) return { stop: true };

		const sql = this.ctx.storage.sql;
		const meta = readReplicaMeta(sql);
		if (!meta || parsed.epoch !== meta.epoch) {
			await this.replicaPullLoop(meta ?? { epoch: parsed.epoch, appliedLsn: 0, pulledAt: 0 });
			return { healed: true };
		}

		const fresh = parsed.entries.filter((entry) => entry.lsn > meta.appliedLsn);
		if (!fresh.length) return { ok: true };
		if (fresh[0].lsn !== meta.appliedLsn + 1) {
			await this.replicaPullLoop(meta);
			return { healed: true };
		}

		for (const entry of fresh) await this.applyLogEntry(entry, true);
		writeReplicaMeta(sql, {
			epoch: meta.epoch,
			appliedLsn: fresh[fresh.length - 1].lsn,
			pulledAt: Date.now(),
		});
		return { ok: true };
	}

	private withLsn(response: Response): Response {
		if (this.pendingLsn === null) return response;
		const headers = new Headers(response.headers);
		headers.set(LSN_HEADER, String(this.pendingLsn));
		this.pendingLsn = null;
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/** Caller registered BEFORE data leaves - see the collection twin. */
	async repBootstrap(
		input: unknown,
	): Promise<{ ok: true; config: TableConfig; epoch: number; lsn: number } | { ok: false }> {
		const caller = repPullInputSchema.parse(input);
		const config = this.config;
		if (this.role.kind !== 'primary' || !config || config.replication !== 'auto') {
			return { ok: false };
		}
		registerReplica(this.ctx.storage.sql, caller.replicaId, caller.region, caller.since);
		return { ok: true, config, epoch: config.repEpoch, lsn: lastLsn(this.ctx.storage.sql) };
	}

	/** Snapshot page for replica bootstrap - the export pager verbatim. */
	async repSnapshotChunk(afterId?: string): Promise<{ docs: DbRow[]; nextAfterId: string | null }> {
		return this.exportChunk(afterId);
	}

	/**
	 * Keyset page in id order for exports and replica snapshots. Not a
	 * point-in-time snapshot: writes racing the export may or may not appear,
	 * but keyset pagination guarantees each id shows up at most once.
	 */
	private exportTableRows(afterId: string | null, limit: number, owner: string | null): DbRow[] {
		const table = this.requireTableName();
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (afterId !== null) {
			conditions.push('"id" > ?');
			params.push(afterId);
		}
		if (owner) {
			conditions.push('"owner" = ?');
			params.push(owner);
		}
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT ${selectList(this.columns)} FROM ${quoteIdent(table)}` +
					` WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'}` +
					` ORDER BY "id" ASC LIMIT ?`,
				...([...params, limit] as (string | number | null)[]),
			)
			.toArray() as Record<string, unknown>[];
		return rows.map((row) => this.toDto(row));
	}

	async repPull(input: unknown): Promise<RepPullResult> {
		const parsed = repPullInputSchema.parse(input);
		const config = this.config;
		if (this.role.kind !== 'primary' || !config || config.replication !== 'auto') {
			return { resync: true, epoch: this.config?.repEpoch ?? 0 };
		}
		return serveRepPull(this.ctx.storage.sql, parsed, config.repEpoch);
	}

	async repStatus(): Promise<RepStatus> {
		const sql = this.ctx.storage.sql;
		const enabled = this.role.kind === 'primary' && this.config?.replication === 'auto';
		const last = enabled ? lastLsn(sql) : 0;
		return {
			enabled,
			epoch: this.config?.repEpoch ?? 0,
			lastLsn: last,
			horizonLsn: enabled ? horizonLsn(sql) : 0,
			primary: await primaryLocation(),
			replicas: enabled
				? listReplicas(sql).map((replica) => ({
						id: replica.id,
						region: replica.region,
						appliedLsn: replica.appliedLsn,
						lagLsn: Math.max(0, last - replica.appliedLsn),
						push: replica.push,
						sockets: replica.sockets,
						lastSeenAt: new Date(replica.lastSeenAt).toISOString(),
					}))
				: [],
		};
	}

	async repDisable(): Promise<void> {
		if (this.role.kind !== 'primary') return;
		await this.destroyReplicaInstances();
		const sql = this.ctx.storage.sql;
		truncateLog(sql);
		clearReplicas(sql);
	}

	private async destroyReplicaInstances(): Promise<void> {
		const name = this.ctx.id.name;
		if (!name) return;
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace<DbTable>;
		for (const replica of listReplicas(this.ctx.storage.sql)) {
			const stub = namespace.get(namespace.idFromName(`${name}:${replica.id}`));
			try {
				await stub.destroy();
			} catch (error) {
				if (!isDurableObjectReset(error)) throw error;
			}
		}
	}

	private primaryTableStub() {
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace<DbTable>;
		return namespace.get(namespace.idFromName((this.role as ReplicaRole).primaryName));
	}

	private async forwardToPrimary(request: Request): Promise<Response> {
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName((this.role as ReplicaRole).primaryName));
		return (await stub.fetch(request)) as unknown as Response;
	}

	private async replicaDispatch(request: Request, subPath: string): Promise<Response> {
		// REP2: subscribers land HERE, on the local copy fed by primary pushes.
		if (request.method === 'GET' && subPath === '/subscribe') {
			const ready = await this.ensureReplica(0);
			if (!ready || !this.config) return this.forwardToPrimary(request);
			return this.acceptSubscriber(request);
		}

		// T2: raw SQL routes here, but only all-SELECT requests serve locally
		// - classifying requires the body, so it is re-materialized either way.
		if (request.method === 'POST' && subPath === '/sql') {
			const bodyText = await request.text();
			const remade = () =>
				new Request(request.url, { method: 'POST', headers: request.headers, body: bodyText });
			let allSelect = true;
			try {
				const parsed = tableSqlRequestSchema.parse(JSON.parse(bodyText));
				const statements = 'batch' in parsed ? parsed.batch : [parsed];
				allSelect = statements.every((statement) => /^\s*(select|with)\b/i.test(statement.sql));
			} catch {
				// malformed: let whichever side handles it shape the 400
			}
			if (!allSelect) return this.forwardToPrimary(remade());
			const wantLsn = Number(request.headers.get(MIN_LSN_HEADER) ?? 0) || 0;
			const fresh = await this.ensureReplica(wantLsn);
			if (!fresh || !this.config) return this.forwardToPrimary(remade());
			const sqlCors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, this.config.allowedOrigins);
			if (request.headers.get('origin') && !sqlCors) {
				return Response.json({ error: 'origin is not trusted' }, { status: 403 });
			}
			return withCors(await this.route(remade(), subPath, this.config), sqlCors);
		}

		const isRead =
			request.method === 'GET' ||
			(request.method === 'POST' && (subPath === '/query' || subPath === '/aggregate'));
		if (!isRead) return this.forwardToPrimary(request);

		const minLsn = Number(request.headers.get(MIN_LSN_HEADER) ?? 0) || 0;
		const ready = await this.ensureReplica(minLsn);
		if (!ready || !this.config) return this.forwardToPrimary(request);

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, this.config.allowedOrigins);
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		return withCors(await this.route(request, subPath, this.config), cors);
	}

	private async ensureReplica(minLsn: number): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		let meta = readReplicaMeta(sql);
		if (!meta || !this.meta) {
			if (!(await this.replicaBootstrap())) return false;
			meta = readReplicaMeta(sql);
			if (!meta) return false;
		}
		const stale = Date.now() - meta.pulledAt > MAX_REPLICA_LAG_MS;
		if (stale || minLsn > meta.appliedLsn) {
			meta = await this.replicaPullLoop(meta);
		}
		return minLsn <= meta.appliedLsn;
	}

	private async replicaBootstrap(): Promise<boolean> {
		const role = this.role as ReplicaRole;
		try {
			const primary = this.primaryTableStub();
			const boot = (await primary.repBootstrap({
				since: 0,
				replicaId: role.replicaId,
				region: role.region,
			})) as unknown as Awaited<ReturnType<DbTable['repBootstrap']>>;
			if (!boot.ok) return false;
			// configure() plans and applies the physical DDL locally.
			await this.configure(boot.config);
			this.ctx.storage.sql.exec(`DELETE FROM ${quoteIdent(boot.config.table)}`);

			let afterId: string | undefined;
			for (;;) {
				const chunk = (await primary.repSnapshotChunk(afterId)) as unknown as Awaited<
					ReturnType<DbTable['repSnapshotChunk']>
				>;
				for (const row of chunk.docs) this.applyRowImage(row);
				if (chunk.nextAfterId === null) break;
				afterId = chunk.nextAfterId;
			}

			writeReplicaMeta(this.ctx.storage.sql, {
				epoch: boot.epoch,
				appliedLsn: boot.lsn,
				pulledAt: Date.now(),
			});
			this.writeDbEvent('replica.bootstrap');
			return true;
		} catch (error) {
			try {
				Sentry.captureException(error, {
					level: 'error',
					tags: { operation: 'replica-bootstrap', shard: this.ctx.id.name ?? 'unknown' },
				});
			} catch {
				// reporting must never break the request path
			}
			return false;
		}
	}

	private async replicaPullLoop(meta: ReplicaMeta): Promise<ReplicaMeta> {
		const role = this.role as ReplicaRole;
		const sql = this.ctx.storage.sql;
		try {
			const primary = this.primaryTableStub();
			// Subscribers must see pull-healed changes as deltas too.
			const notify = (await this.subscriptionCount()) > 0;
			let current = meta;
			for (;;) {
				const result = (await primary.repPull({
					since: current.appliedLsn,
					replicaId: role.replicaId,
					region: role.region,
				})) as RepPullResult;
				if (result.resync || result.epoch !== current.epoch) {
					this.writeDbEvent('replica.resync');
					if (!(await this.replicaBootstrap())) return current;
					return readReplicaMeta(sql) ?? current;
				}
				for (const entry of result.entries) await this.applyLogEntry(entry, notify);
				current = {
					epoch: result.epoch,
					appliedLsn: result.entries.length
						? result.entries[result.entries.length - 1].lsn
						: current.appliedLsn,
					pulledAt: Date.now(),
				};
				writeReplicaMeta(sql, current);
				if (result.entries.length < REPLICATION_PULL_CHUNK) return current;
			}
		} catch {
			return meta;
		}
	}

	/** Apply one entry; with `notify` the local live engine fires deltas. */
	private async applyLogEntry(entry: LogEntry, notify = false): Promise<void> {
		const parsed = logEntrySchema.parse(entry);
		if (parsed.op === 'cfg') {
			if (parsed.image) await this.configure(JSON.parse(parsed.image));
			return;
		}
		const table = this.requireTableName();
		if (parsed.op === 'del') {
			const before = notify ? await this.fetchDocById(parsed.id) : null;
			this.ctx.storage.sql.exec(`DELETE FROM ${quoteIdent(table)} WHERE "id" = ?`, parsed.id);
			if (notify && before) await this.notifySubscribers(before, null);
			return;
		}
		if (!parsed.image) return;
		const after = JSON.parse(parsed.image) as DbRow;
		const before = notify ? await this.fetchDocById(after.id) : null;
		this.applyRowImage(after);
		if (notify) await this.notifySubscribers(before, after);
	}

	/** Idempotent row-image upsert against the physical table. */
	private applyRowImage(row: DbRow): void {
		const table = this.requireTableName();
		const columns = this.columns;
		const names = columns.map((column) => quoteIdent(column.name));
		const values = columns.map((column) => toSqlValue(column, row.data[column.name]));
		this.ctx.storage.sql.exec(
			`INSERT INTO ${quoteIdent(table)} ("id", "owner", "created_at", "updated_at"` +
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

	// -------------------------------------------------------------------------
	// HTTP surface: /agents/db-agent/<pid>/tables/<name>/...

	async fetch(request: Request): Promise<Response> {
		// EVERY exit drains an unread body first - see drainUnusedBody.
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)\/tables\/([^/]+)(\/.*)?$/);
		if (!match) return Response.json({ error: 'not found' }, { status: 404 });
		const subPath = match[3] ?? '/';

		// Replicas never consult the parent - their config arrives from the
		// primary's feed, and everything non-read forwards to the primary.
		if (this.role.kind === 'replica') {
			return this.replicaDispatch(request, subPath);
		}

		const state = await this.ensureMeta(match[1], match[2]);
		if (state === 'unknown') {
			// Schema-first: nothing auto-creates a table.
			return Response.json({ error: 'no such table - declare it first' }, { status: 404 });
		}
		if (state === 'unavailable') {
			return Response.json({ error: 'table is unavailable' }, { status: 503 });
		}
		const config = state;

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, config.allowedOrigins);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		return withCors(await this.route(request, subPath, config), cors);
	}

	private async route(request: Request, subPath: string, config: TableConfig): Promise<Response> {
		if (subPath === '/subscribe' && request.method === 'GET') {
			return this.acceptSubscriber(request);
		}

		if (subPath === '/rows' && request.method === 'POST') {
			return this.guarded(request, 'write', config, (owner) => this.handleCreate(request, owner));
		}
		if (subPath === '/query' && request.method === 'POST') {
			return this.guarded(request, 'read', config, (owner) => this.handleQuery(request, owner));
		}
		if (subPath === '/aggregate' && request.method === 'POST') {
			return this.guarded(request, 'read', config, (owner) => this.handleAggregate(request, owner));
		}
		if (subPath === '/sql' && request.method === 'POST') {
			return this.handleSql(request, config);
		}
		if (subPath === '/export' && request.method === 'GET') {
			return this.guarded(request, 'read', config, (owner) =>
				Promise.resolve(this.handleExport(owner)),
			);
		}

		const row = subPath.match(/^\/rows\/([^/]+)$/);
		if (row) {
			const rowId = decodeURIComponent(row[1]);
			switch (request.method) {
				case 'GET':
					return this.guarded(request, 'read', config, (owner) => this.handleGet(rowId, owner));
				case 'PUT':
				case 'PATCH':
					return this.guarded(request, 'write', config, (owner) =>
						this.handleWrite(request, rowId, owner),
					);
				case 'DELETE':
					return this.guarded(request, 'write', config, (owner) => this.handleDelete(rowId, owner));
			}
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async guarded(
		request: Request,
		side: 'read' | 'write',
		config: TableConfig,
		handler: (owner: string | null) => Promise<Response>,
	): Promise<Response> {
		const decision = await checkAccess(
			request,
			side === 'read' ? config.readAccess : config.writeAccess,
			side === 'read' ? config.readPermission : config.writePermission,
			this.getVerifier(),
		);
		if (!decision.ok) return decision.response;
		return handler(decision.owner);
	}

	// -------------------------------------------------------------------------
	// Row handlers

	private async handleCreate(request: Request, owner: string | null): Promise<Response> {
		const body = createDocumentSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid row', issues: body.error.issues }, { status: 400 });
		}

		const full = applyColumnDefaults(this.columns, body.data.data);
		const invalid = this.checkRow(full);
		if (invalid) return invalid;

		if (this.config?.demo && (await this.getRowCount()) >= DEMO_MAX_ROWS_PER_TABLE) {
			return Response.json(
				{ error: `demo tables are capped at ${DEMO_MAX_ROWS_PER_TABLE} rows` },
				{ status: 429 },
			);
		}

		const id = body.data.id ?? uuidv7();
		if (this.rowById(id)) {
			return Response.json({ error: 'a row with that id already exists' }, { status: 409 });
		}

		try {
			const written = await this.writeRow(id, full, { owner });
			return this.withLsn(Response.json(written, { status: 201 }));
		} catch (error) {
			return this.uniqueViolationResponse(error) ?? this.rethrow(error);
		}
	}

	private async handleGet(rowId: string, owner: string | null): Promise<Response> {
		const row = this.rowById(rowId);
		// Owner mode 404s on other people's rows: their existence is private.
		if (!row || (owner && row.owner !== owner)) {
			return Response.json({ error: 'no such row' }, { status: 404 });
		}
		return Response.json(this.toDto(row));
	}

	private async handleWrite(request: Request, rowId: string, owner: string | null) {
		const body = documentDataSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid row', issues: body.error.issues }, { status: 400 });
		}

		const existing = this.rowById(rowId);
		if (!existing || (owner && existing.owner !== owner)) {
			return Response.json({ error: 'no such row' }, { status: 404 });
		}

		// PATCH merges column-by-column over the materialized row; PUT replaces
		// (missing columns fall back to defaults/null). Both validate the final
		// row, so a merge can never sneak an invalid value past the schema.
		const replacement = applyColumnDefaults(this.columns, body.data);
		const merged =
			request.method === 'PATCH'
				? { ...rowDataFromSql(this.columns, existing), ...body.data }
				: replacement;
		const invalid = this.checkRow(merged);
		if (invalid) return invalid;

		try {
			const written = await this.writeRow(rowId, merged, {
				owner: (existing.owner as string | null) ?? null,
			});
			return this.withLsn(Response.json(written));
		} catch (error) {
			return this.uniqueViolationResponse(error) ?? this.rethrow(error);
		}
	}

	private async handleDelete(rowId: string, owner: string | null): Promise<Response> {
		const deleted = await this.deleteRow(rowId, owner);
		if (!deleted) return Response.json({ error: 'no such row' }, { status: 404 });
		return this.withLsn(Response.json({ deleted: true }));
	}

	private async handleQuery(request: Request, owner: string | null): Promise<Response> {
		const parsed = querySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid query', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		try {
			return Response.json(await this.runQuery(parsed.data, owner));
		} catch (error) {
			if (error instanceof TableQueryError) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	}

	/**
	 * NDJSON export of every readable row, gated exactly like a query (owner
	 * mode exports only the caller's rows). Streamed in keyset pages so a
	 * 10 GB table never materializes in memory.
	 */
	private handleExport(owner: string | null): Response {
		const table = this.requireTableName();
		const encoder = new TextEncoder();
		const nextRows = (after: string | null) => this.exportTableRows(after, EXPORT_CHUNK, owner);
		let afterId: string | null = null;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (done) return;
				const rows = nextRows(afterId);
				for (const row of rows) controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
				if (rows.length < EXPORT_CHUNK) {
					done = true;
					controller.close();
				} else {
					afterId = rows[rows.length - 1].id;
				}
			},
		});

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'content-disposition': `attachment; filename="${table}.ndjson"`,
			},
		});
	}

	private async handleAggregate(request: Request, owner: string | null): Promise<Response> {
		const parsed = aggregateRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid aggregate request', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		const result = this.runAggregate(parsed.data, owner);
		if ('error' in result) return Response.json({ error: result.error }, { status: 400 });
		return Response.json(result);
	}

	private runAggregate(
		request: AggregateRequest,
		ownerSub: string | null,
	): AggregateResult | { error: string } {
		const compiled = compileTableAggregate(this.requireTableName(), request, this.columns, {
			ownerSub,
		});
		if (!compiled.ok) return { error: compiled.error };
		const [row] = this.ctx.storage.sql
			.exec(compiled.compiled.sql, ...(compiled.compiled.params as (string | number | null)[]))
			.toArray() as Record<string, unknown>[];
		const results: Record<string, number | null> = {};
		compiled.compiled.aliases.forEach((alias, index) => {
			const value = row?.[`agg_${index}`];
			results[alias] = typeof value === 'number' ? value : null;
		});
		return { results };
	}

	// -------------------------------------------------------------------------
	// The D1-shaped SQL endpoint (T2): ORM-grade single-table SQL

	/**
	 * Raw SQL ALWAYS requires a project JWT - public access modes open the
	 * typed API, never arbitrary SQL - and owner-scoped tables refuse it
	 * outright (arbitrary SQL cannot be owner-scoped without rewriting it).
	 * SELECT binds readPermission, DML binds writePermission; DML is
	 * operator-grade like adminPut (structure enforced by the schema itself,
	 * policy bounds not re-checked). The statement gate is table-sql.ts.
	 */
	private async handleSql(request: Request, config: TableConfig): Promise<Response> {
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
			const gate = prepareTableSql(statement.sql, config.table, this.columns);
			if (!gate.ok) {
				return Response.json({ success: false, error: gate.error }, { status: 400 });
			}
			prepared.push({ ...gate, params: statement.params ?? [] });
		}

		// A batch carrying ANY write is judged on the write side - a mixed batch
		// is a write.
		const wantsWrite = prepared.some((statement) => statement.kind !== 'select');
		const mode = wantsWrite ? config.writeAccess : config.readAccess;

		// This path deliberately does NOT go through checkAccess (raw SQL always
		// demands a token, whatever the mode says), so every mode the gate
		// refuses has to be refused again HERE. Miss one and raw SQL becomes the
		// way around it - which is exactly the bypass `none` exists to prevent.
		if (mode === 'owner') {
			return Response.json(
				{ success: false, error: 'owner-scoped tables refuse raw SQL - use the typed API' },
				{ status: 403 },
			);
		}
		if (mode === 'none') {
			return Response.json(
				{
					success: false,
					error: wantsWrite
						? 'this table is read-only over the public API'
						: 'this table is not readable over the public API',
				},
				{ status: 403 },
			);
		}

		const header = request.headers.get('authorization');
		const token = header?.match(/^Bearer (.+)$/i)?.[1];
		if (!token) {
			return Response.json(
				{ success: false, error: 'raw SQL requires a project token' },
				{ status: 401 },
			);
		}
		const verified = await this.getVerifier().verify(token);
		if (!verified.ok) {
			return Response.json(
				{
					success: false,
					error:
						verified.code === 'not-configured'
							? 'auth verification is not configured'
							: 'invalid or expired token',
				},
				{ status: verified.code === 'not-configured' ? 503 : 401 },
			);
		}
		const required = wantsWrite ? config.writePermission : config.readPermission;
		if (!hasPermission(required, verified.claims.permissions)) {
			return Response.json(
				{ success: false, error: 'the token does not carry the required permission' },
				{ status: 403 },
			);
		}

		try {
			const outcome = this.runSqlStatements(prepared);
			for (const notice of outcome.notifications) {
				if (notice.kind === 'delete') {
					await this.notifySubscribers(notice.row, null);
				} else {
					// UPDATE before-images are not recoverable from raw SQL; the
					// live engine receives before=null (documented limitation:
					// predicate-EXIT deltas are not emitted for raw updates).
					await this.notifySubscribers(null, notice.row);
				}
			}
			// SELECT-only requests reach here too, and they cannot have moved the
			// row count - reporting them made every read mint a `rows.changed`.
			if (outcome.notifications.length) this.scheduleStatsReport();
			const payload =
				'batch' in body.data
					? { success: true as const, batch: outcome.results }
					: { success: true as const, result: outcome.results[0] };
			return this.withLsn(Response.json(payload));
		} catch (error) {
			const conflict = this.uniqueViolationResponse(error);
			if (conflict) return conflict;
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ success: false, error: message.slice(0, 512) }, { status: 400 });
		}
	}

	/** Execute inside ONE transactionSync (a failing batch rolls back whole);
	 * log entries are appended in the same transaction, notifications AND
	 * replica pushes are collected for after the commit. The push used to be
	 * scheduled per-entry from inside the transaction, which a rollback
	 * cannot retract: replicas applied rows the primary never committed, and
	 * because the rolled-back LSN is reissued (sqlite_sequence reverts with
	 * the transaction), the next committed write was then dropped as a
	 * duplicate - permanent divergence. Same for pendingLsn: it must only
	 * ever name a committed LSN, so it is set here, after the commit. */
	private runSqlStatements(
		statements: {
			kind: 'select' | 'insert' | 'update' | 'delete';
			sql: string;
			params: unknown[];
		}[],
	): {
		results: TableSqlResult[];
		notifications: { kind: 'upsert' | 'delete'; row: DbRow }[];
	} {
		const results: TableSqlResult[] = [];
		const notifications: { kind: 'upsert' | 'delete'; row: DbRow }[] = [];
		const entries: LogEntry[] = [];

		this.ctx.storage.transactionSync(() => {
			for (const statement of statements) {
				const cursor = this.ctx.storage.sql.exec(
					statement.sql,
					...(statement.params as (string | number | null)[]),
				);
				const columns = cursor.columnNames;
				const raw = [...cursor.raw()] as unknown[][];
				const objects = raw.map((values) => {
					const record: Record<string, unknown> = {};
					columns.forEach((column, index) => (record[column] = values[index]));
					return record;
				});

				if (statement.kind !== 'select') {
					for (const row of objects) {
						const dto = this.toDto(row);
						if (statement.kind === 'delete') {
							const entry = this.appendChange('del', dto.id, null);
							if (entry) entries.push(entry);
							notifications.push({ kind: 'delete', row: dto });
						} else {
							const entry = this.appendChange('put', dto.id, JSON.stringify(dto));
							if (entry) entries.push(entry);
							notifications.push({ kind: 'upsert', row: dto });
						}
					}
				}

				results.push({
					results: objects,
					columns,
					raw,
					meta: {
						changes: statement.kind === 'select' ? 0 : objects.length,
						rows_read: cursor.rowsRead,
						rows_written: cursor.rowsWritten,
					},
				});
			}
		});

		// The commit landed: only now may the entries drive anything a
		// rollback could not have retracted - the session bookmark and the
		// replica pushes (one batched RPC per replica, all-or-nothing like
		// the transaction they describe).
		if (entries.length) {
			this.pendingLsn = entries[entries.length - 1].lsn;
			this.schedulePush(entries);
		}

		return { results, notifications };
	}

	/** Operator SQL (dashboard console / copilot) - no JWT, session-guarded
	 * upstream; same statement gate, same owner-mode indifference. */
	async adminSql(
		input: unknown,
	): Promise<{ ok: true; batch: TableSqlResult[] } | { ok: false; error: string }> {
		const body = tableSqlRequestSchema.safeParse(input);
		if (!body.success) return { ok: false, error: 'invalid sql request' };
		const statements = 'batch' in body.data ? body.data.batch : [body.data];
		const prepared = [];
		for (const statement of statements) {
			const gate = prepareTableSql(statement.sql, this.requireTableName(), this.columns);
			if (!gate.ok) return { ok: false, error: gate.error };
			prepared.push({ ...gate, params: statement.params ?? [] });
		}
		try {
			const outcome = this.runSqlStatements(prepared);
			for (const notice of outcome.notifications) {
				if (notice.kind === 'delete') await this.notifySubscribers(notice.row, null);
				else await this.notifySubscribers(null, notice.row);
			}
			// Same as the public SQL route: a read never changes the count.
			if (outcome.notifications.length) this.scheduleStatsReport();
			return { ok: true, batch: outcome.results };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message.slice(0, 512) };
		}
	}

	/** Operator aggregate mirror; discriminated like adminQuery. */
	async adminAggregate(
		input: unknown,
	): Promise<{ ok: true; results: Record<string, number | null> } | { ok: false; error: string }> {
		const parsed = aggregateRequestSchema.safeParse(input);
		if (!parsed.success) return { ok: false, error: 'invalid aggregate request' };
		const result = this.runAggregate(parsed.data, null);
		if ('error' in result) return { ok: false, error: result.error };
		return { ok: true, results: result.results };
	}

	/** Row size + schema validation; null when the row passes. */
	private checkRow(data: Record<string, unknown>): Response | null {
		const sizeIssue = this.rowSizeIssue(data);
		if (sizeIssue) return Response.json({ error: sizeIssue }, { status: 413 });
		const issues = validateRow(this.columns, data);
		if (issues.length) {
			return Response.json({ error: 'row failed validation', issues }, { status: 400 });
		}
		return null;
	}

	private rowSizeIssue(data: Record<string, unknown>): string | null {
		const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
		const cap = this.config?.demo ? DEMO_MAX_ROW_BYTES : MAX_DOC_BYTES;
		if (bytes > cap) {
			return `row data is limited to ${cap} bytes${this.config?.demo ? ' in demo projects' : ''}`;
		}
		return null;
	}

	/** UNIQUE violations become 409s naming the offending column. */
	private uniqueViolationResponse(error: unknown): Response | null {
		const column = uniqueViolationColumn(error);
		if (!column) return null;
		return Response.json(
			{ error: `a row with that ${column} already exists (unique column)` },
			{ status: 409 },
		);
	}

	private rethrow(error: unknown): never {
		throw error;
	}

	// -------------------------------------------------------------------------
	// Write path: every mutation computes old/new and notifies subscribers

	private async writeRow(
		id: string,
		data: Record<string, unknown>,
		options: {
			owner: string | null | undefined;
			/** Import fidelity: keep the exported timestamps instead of now. */
			createdAt?: number;
			updatedAt?: number;
			/** Import fidelity: overwrite the owner column on update too. */
			replaceOwner?: boolean;
		},
	): Promise<DbRow> {
		const table = this.requireTableName();
		const before = this.rowById(id);
		const now = Date.now();
		const columns = this.columns;

		const declaredNames = columns.map((column) => quoteIdent(column.name));
		const values = columns.map((column) => toSqlValue(column, data[column.name]));

		if (before) {
			this.ctx.storage.sql.exec(
				`UPDATE ${quoteIdent(table)} SET "updated_at" = ?` +
					(options.replaceOwner ? `, "owner" = ?` : '') +
					(declaredNames.length
						? `, ${declaredNames.map((name) => `${name} = ?`).join(', ')}`
						: '') +
					` WHERE "id" = ?`,
				options.updatedAt ?? now,
				...(options.replaceOwner ? [options.owner ?? null] : []),
				...values,
				id,
			);
		} else {
			this.ctx.storage.sql.exec(
				`INSERT INTO ${quoteIdent(table)} ("id", "owner", "created_at", "updated_at"` +
					(declaredNames.length ? `, ${declaredNames.join(', ')}` : '') +
					`) VALUES (?, ?, ?, ?${declaredNames.length ? `, ${declaredNames.map(() => '?').join(', ')}` : ''})`,
				id,
				options.owner ?? null,
				options.createdAt ?? now,
				options.updatedAt ?? now,
				...values,
			);
		}

		const after = this.rowById(id);
		if (!after) throw new Error('row vanished mid-write');

		// Log BEFORE any await: write coalescing keeps data + log atomic.
		this.logChange('put', id, JSON.stringify(this.toDto(after)));
		this.writeDbEvent(before ? 'row.updated' : 'row.created');
		await this.notifySubscribers(before ? this.toDto(before) : null, this.toDto(after));
		this.scheduleStatsReport();
		return this.toDto(after);
	}

	private async deleteRow(id: string, owner: string | null): Promise<boolean> {
		const table = this.requireTableName();
		const before = this.rowById(id);
		if (!before || (owner && before.owner !== owner)) return false;

		this.ctx.storage.sql.exec(`DELETE FROM ${quoteIdent(table)} WHERE "id" = ?`, id);
		this.logChange('del', id, null);
		this.writeDbEvent('row.deleted');
		await this.notifySubscribers(this.toDto(before), null);
		this.scheduleStatsReport();
		return true;
	}

	// -------------------------------------------------------------------------
	// Query execution

	private async runQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbRow[]; nextCursor?: string }> {
		const table = this.requireTableName();
		const cursor: DecodedCursor | null = query.cursor ? decodeCursor(query.cursor) : null;
		const result = compileTableQuery(query, this.columns, { ownerSub, cursor });
		if (!result.ok) throw new TableQueryError(result.error);
		const compiled = result.compiled;

		const rows = this.ctx.storage.sql
			.exec(
				`SELECT ${selectList(this.columns)} FROM ${quoteIdent(table)} ` +
					`WHERE ${compiled.whereSql} ORDER BY ${compiled.orderSql} LIMIT ?`,
				...([...compiled.params, compiled.limit] as (string | number | null)[]),
			)
			.toArray() as Record<string, unknown>[];

		const docs = rows.map((row) => this.toDto(row));
		const result2: { docs: DbRow[]; nextCursor?: string } = { docs };
		if (docs.length === compiled.limit && docs.length > 0) {
			const last = docs[docs.length - 1];
			result2.nextCursor = encodeCursor({
				values: (query.orderBy ?? []).map((order) => getPath(last.data, order.field)),
				id: last.id,
			});
		}
		return result2;
	}

	private rowById(id: string): Record<string, unknown> | null {
		if (!this.meta) return null;
		const [row] = this.ctx.storage.sql
			.exec(
				`SELECT ${selectList(this.columns)} FROM ${quoteIdent(this.meta.config.table)} WHERE "id" = ?`,
				id,
			)
			.toArray() as Record<string, unknown>[];
		return row ?? null;
	}

	private toDto(row: Record<string, unknown>): DbRow {
		return {
			id: row.id as string,
			data: rowDataFromSql(this.columns, row),
			owner: (row.owner as string | null) ?? null,
			createdAt: new Date(row.created_at as number).toISOString(),
			updatedAt: new Date(row.updated_at as number).toISOString(),
		};
	}

	private requireTableName(): string {
		const table = this.meta?.config.table;
		if (!table) throw new Error('table is not configured');
		return table;
	}

	// -------------------------------------------------------------------------
	// The LiveShard surface

	protected liveGate(): LiveGate | null {
		return this.config
			? {
					readAccess: this.config.readAccess,
					readPermission: this.config.readPermission,
					demo: this.config.demo,
				}
			: null;
	}

	/** Tables refuse subscribe queries over undeclared columns up front. */
	protected validateSubscribeQuery(query: Query): string | null {
		const result = compileTableQuery(query, this.columns);
		return result.ok ? null : result.error;
	}

	protected async runLiveQuery(query: Query, ownerSub: string | null): Promise<{ docs: DbRow[] }> {
		return this.runQuery(query, ownerSub);
	}

	protected async fetchDocById(id: string): Promise<DbRow | null> {
		const row = this.rowById(id);
		return row ? this.toDto(row) : null;
	}

	protected writeShardEvent(eventType: string): void {
		this.writeDbEvent(eventType);
	}

	/** Replicas freshen before serving a subscribe snapshot. */
	protected async beforeSnapshot(): Promise<void> {
		if (this.role.kind === 'replica') await this.ensureReplica(0);
	}

	/** RPC-path readiness: primaries pull the declared config on first touch
	 * (schema-first - an undeclared table stays unconfigured and the caller
	 * answers accordingly); replicas ensure their local copy. */
	protected async ensureShardReady(): Promise<void> {
		if (this.role.kind === 'replica') {
			await this.ensureReplica(0);
			return;
		}
		const name = this.ctx.id.name;
		if (!this.meta && name) {
			const [projectId, table] = name.split(':');
			if (projectId && table) await this.ensureMeta(projectId, table);
		}
	}

	/** Track what the primary believes; flip only on transitions. */
	private pushWanted: boolean | null = null;
	/** Last socket count reported. In-memory on purpose: hibernation resets
	 * it to null and the next accepted socket re-reports - self-healing. */
	private lastReportedSockets: number | null = null;

	protected async onSubscriptionsChanged(count: number): Promise<void> {
		if (this.role.kind !== 'replica') return;
		const want = count > 0;
		if (this.pushWanted === want) return;
		// Transitions carry the socket count for free.
		await this.reportToPrimary({ push: want, sockets: this.ctx.getWebSockets().length });
	}

	protected async onSocketAccepted(count: number): Promise<void> {
		if (this.role.kind !== 'replica') return;
		const step = socketReportStep(this.spawnThreshold());
		if (this.lastReportedSockets !== null && Math.abs(count - this.lastReportedSockets) < step) {
			return;
		}
		await this.reportToPrimary({ sockets: count });
	}

	private async reportToPrimary(update: { push?: boolean; sockets?: number }): Promise<void> {
		const role = this.role as ReplicaRole;
		try {
			await this.primaryTableStub().repSetPush({
				replicaId: role.replicaId,
				region: role.region,
				...update,
			});
			if (update.push !== undefined) this.pushWanted = update.push;
			if (update.sockets !== undefined) this.lastReportedSockets = update.sockets;
		} catch {
			if (update.push !== undefined) this.pushWanted = null;
			if (update.sockets !== undefined) this.lastReportedSockets = null;
		}
	}

	// -------------------------------------------------------------------------
	// Config, auth, analytics, stats

	/** Cached meta, or a one-time lazy pull from the parent on first touch.
	 * 'unknown' = the registry has no such table (404 - schema-first);
	 * 'unavailable' = the parent could not be reached (503). */
	private async ensureMeta(
		projectId: string,
		table: string,
	): Promise<TableConfig | 'unknown' | 'unavailable'> {
		if (this.meta) return this.meta.config;

		try {
			const parent = await this.parentStub(projectId);
			const config = await parent.getTableConfig(table);
			if (!config) return 'unknown';
			await this.configure(config);
			return this.meta ? (this.meta as TableMeta).config : 'unavailable';
		} catch (error) {
			try {
				Sentry.captureException(error, {
					level: 'error',
					tags: { projectId, table, operation: 'ensure-table-meta' },
					extra: { note: 'table is answering 503 - config pull from the parent failed' },
				});
			} catch {
				// reporting must never break the request path
			}
			return 'unavailable';
		}
	}

	private async parentStub(projectId: string) {
		const namespace = this.env.DbAgent as unknown as AgentNamespace<DbAgent>;
		// getAgentByName, never a raw namespace stub - see the twin comment in
		// collection.ts: a raw RPC can reach a cold parent before onStart's
		// migrations and turn every first touch into a 503.
		return getAgentByName(namespace, projectId);
	}

	protected getVerifier(): ProjectJwtVerifier {
		if (!this.verifier) {
			this.verifier = new ProjectJwtVerifier(
				this.ctx.storage,
				this.env as { AUTH_AGENT?: Fetcher },
				this.config?.projectId ?? this.ctx.id.name?.split(':')[0] ?? '',
			);
		}
		return this.verifier;
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		const config = this.config;
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [config?.projectId ?? 'unknown'],
				// Schema: event, collection/table, country, subject, reserved.
				blobs: [eventType, config?.table ?? 'unknown', 'unknown', 'none', 'none'],
				doubles: [1],
			});
		} catch {
			// never let metrics break a write
		}
	}

	/** Debounced absolute-count report; self-healing because it is absolute. */
	private scheduleStatsReport(): void {
		if (this.statsTimer) return;
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			void this.reportStats();
		}, STATS_REPORT_MS);
	}

	private async reportStats(): Promise<void> {
		const config = this.config;
		// Replicas wake on their own schedule and can be arbitrarily far behind
		// the feed, so their count is neither authoritative nor newsworthy - the
		// registry number belongs to the primary.
		if (!config || this.role.kind !== 'primary') return;
		try {
			const parent = await this.parentStub(config.projectId);
			await parent.reportTableStats(config.table, { rows: await this.getRowCount() });
		} catch {
			// best-effort: the next write re-arms the timer and corrects the count
		}
	}
}
