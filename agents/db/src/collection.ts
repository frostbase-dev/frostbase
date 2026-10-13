import * as Sentry from '@sentry/cloudflare';
import { getAgentByName, type AgentNamespace } from 'agents';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from './migrations';
import { checkAccess, corsHeadersFor, drainUnusedBody, withCors } from './access';
import { primaryLocation } from './colo';
import { collectionMeta, documents } from './db/schema';
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
import {
	compileAggregate,
	compileQuery,
	decodeCursor,
	encodeCursor,
	type DecodedCursor,
} from './query';
import { shardBookmarkForTime, shardCurrentBookmark, shardRestoreTo } from './pitr';
import { validateDocument } from './rules';
import { v7 as uuidv7 } from 'uuid';
import {
	aggregateRequestSchema,
	collectionConfigSchema,
	createDocumentSchema,
	documentDataSchema,
	importLineSchema,
	logEntrySchema,
	querySchema,
	storedConfigSchema,
	repApplyInputSchema,
	repPullInputSchema,
	repSetPushInputSchema,
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
	type AccessMode,
	type AggregateRequest,
	type AggregateResult,
	type BookmarkOutcome,
	type CollectionConfig,
	type DbDocument,
	type ImportReport,
	type LogEntry,
	type Query,
	type RepApplyResult,
	type RepPullResult,
	type RepStatus,
	type RestoreOutcome,
} from './schemas';
import { isDurableObjectReset, type DbAgent } from './agent';

/**
 * One collection's documents, query engine, and live-query subscriptions.
 *
 * Deliberately a plain DurableObject, not an Agents SDK Agent: the public
 * subscriber socket must never receive SDK protocol frames (state sync would
 * broadcast operator data to anonymous clients), and the raw WebSocket
 * Hibernation API gives exact control over subscription survival. The
 * attachment carries only `{ connId }`; the `subscriptions` table is the
 * durable source of truth, so a hibernated instance woken by a frame
 * restores full context from SQLite with zero in-memory state.
 *
 * Instance name: `<projectId>:<collectionName>` - the first `:` is an
 * unambiguous separator because neither id allows one. The hot data path
 * (worker -> this DO) is a single hop; config is cached locally and pushed
 * by the parent, so serving a request never consults the parent. The one
 * exception is first touch: an instance with no cached config pulls it once
 * via `DbAgent.getCollectionConfig({ autoCreate: true })`, which is also
 * what heals a parent-side row whose config push failed.
 */

const DEMO_MAX_DOCS_PER_COLLECTION = 200;
const DEMO_MAX_DOC_BYTES = 8 * 1024;
/**
 * Debounce for absolute-count reports to the parent. This is the dashboard's
 * freshness ceiling (write -> child report -> parent rev bump -> console
 * refetch), kept short enough to feel live while still coalescing write
 * bursts into one RPC. The PRODUCT live-query socket pushes deltas
 * immediately and never waits on this.
 */
const STATS_REPORT_MS = 500;

type DocumentRow = typeof documents.$inferSelect;

export class DbCollection extends LiveShard {
	private config: CollectionConfig | null = null;
	private verifier: ProjectJwtVerifier | null = null;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;
	private localAnalyticsReady = false;
	/** LSN of the current request's write, surfaced as the session bookmark. */
	private pendingLsn: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Idempotent - drizzle tracks applied migrations in its own table.
		// Tables the parent class owns simply stay empty here.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			this.config = storedConfigSchema.parse(await this.loadStoredConfig());
		});
		// Counts are otherwise only reported after a WRITE, so the parent's
		// number goes stale whenever documents change without one: a
		// point-in-time restore (which rewrites the whole table), a collection
		// whose documents predate count reporting, or a failed report. Sending
		// the absolute count on every wake makes it self-heal on first touch -
		// the report is debounced and best-effort, so a cold start pays one
		// cheap RPC and nothing depends on it succeeding.
		this.scheduleStatsReport();
	}

	private async loadStoredConfig(): Promise<unknown> {
		const [row] = await this.db.select().from(collectionMeta).limit(1);
		if (!row) return null;
		try {
			return JSON.parse(row.config);
		} catch {
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// RPC surface (parent and worker entrypoint only - never public HTTP)

	/** Parent push on create/config change (replicas run it applying `cfg`
	 * log entries and during bootstrap). Stale versions are ignored. */
	async configure(input: unknown): Promise<void> {
		const parsed = collectionConfigSchema.parse(input);
		if (this.config && parsed.configVersion < this.config.configVersion) return;
		const previous = this.config;
		this.config = parsed;
		this.verifier = null;
		await this.db
			.insert(collectionMeta)
			.values({ id: 1, config: JSON.stringify(parsed), updatedAt: new Date() })
			.onConflictDoUpdate({
				target: collectionMeta.id,
				set: { config: JSON.stringify(parsed), updatedAt: new Date() },
			});

		if (this.role.kind === 'primary') {
			if (parsed.replication === 'auto') {
				// Config changes replicate IN WRITE ORDER with the data.
				const image = JSON.stringify(parsed);
				const lsn = appendLog(this.ctx.storage.sql, 'cfg', '', image);
				this.schedulePush({ lsn, op: 'cfg', id: '', image, ts: Date.now() });
			} else if (previous?.replication === 'auto') {
				await this.repDisable();
			}
		}
	}

	/** Operator query over the dashboard proxy (parent-forwarded). */
	async adminQuery(input: unknown): Promise<{ docs: DbDocument[]; nextCursor?: string }> {
		const query = querySchema.parse(input);
		return this.runQuery(query, null);
	}

	/** Operator aggregate (parent-forwarded); bypasses access modes. */
	async adminAggregate(input: unknown): Promise<AggregateResult> {
		return this.runAggregate(aggregateRequestSchema.parse(input), null);
	}

	/** Operator export chunk (parent-forwarded; no owner scoping). The
	 * parameter is an optional string rather than `string | null` because a
	 * null union breaks the workers-types RPC transform (the stub method
	 * collapses to `never`). */
	async exportChunk(afterId?: string): Promise<{ docs: DbDocument[]; nextAfterId: string | null }> {
		const docs = this.exportRows(afterId ?? null, EXPORT_CHUNK, null);
		return { docs, nextAfterId: docs.length < EXPORT_CHUNK ? null : docs[docs.length - 1].id };
	}

	/**
	 * Operator import chunk (parent-forwarded). Upserts by id, preserving
	 * owner and timestamps when the line carries them, so round-tripping an
	 * export restores what was there. Validator rules do NOT apply - this is
	 * an operator surface, like the dashboard editor - but size and demo caps
	 * do. Per-line failures are reported rather than fatal: a 900-line dump
	 * should not be all-or-nothing across RPC chunks that cannot share a
	 * transaction anyway.
	 */
	async importDocs(input: unknown): Promise<ImportReport> {
		const lines = z.array(importLineSchema).max(IMPORT_RPC_CHUNK).parse(input);
		const report: ImportReport = { imported: 0, updated: 0, errors: [] };

		for (const [index, line] of lines.entries()) {
			try {
				const sizeIssue = this.docSizeIssue(line.data);
				if (sizeIssue) {
					report.errors.push({ line: index, error: sizeIssue });
					continue;
				}
				const id = line.id ?? uuidv7();
				const [existing] = await this.db
					.select()
					.from(documents)
					.where(eq(documents.id, id))
					.limit(1);
				if (
					!existing &&
					this.config?.demo &&
					(await this.getDocCount()) >= DEMO_MAX_DOCS_PER_COLLECTION
				) {
					report.errors.push({
						line: index,
						error: `demo collections are capped at ${DEMO_MAX_DOCS_PER_COLLECTION} documents`,
					});
					continue;
				}
				await this.writeDocument(id, line.data, {
					mode: 'replace',
					owner: line.owner ?? null,
					upsert: true,
					createdAt: line.createdAt ? new Date(line.createdAt) : undefined,
					updatedAt: line.updatedAt ? new Date(line.updatedAt) : undefined,
					replaceOwner: line.owner !== undefined,
				});
				if (existing) report.updated += 1;
				else report.imported += 1;
			} catch (error) {
				report.errors.push({
					line: index,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return report;
	}

	/** Point-in-time restore over the platform's SQLite bookmarks - the shared
	 * sequence lives in pitr.ts; see shardRestoreTo for the contract. */
	async restoreTo(input: unknown): Promise<RestoreOutcome> {
		return shardRestoreTo(this.ctx, input, {
			label: this.config?.collection ?? 'unknown',
			closeReason: 'collection restored',
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

	/**
	 * Operator upsert (dashboard document editor). With `ifAbsent`, an
	 * existing id reports a conflict instead of replacing - the dashboard's
	 * ADD flow uses it so a typo cannot silently overwrite a document, while
	 * edit/import keep their deliberate replace semantics.
	 */
	async adminPut(
		id: string,
		data: unknown,
		ifAbsent = false,
	): Promise<DbDocument | { conflict: true }> {
		const parsed = documentDataSchema.parse(data);
		if (ifAbsent) {
			const [existing] = await this.db
				.select()
				.from(documents)
				.where(eq(documents.id, id))
				.limit(1);
			if (existing) return { conflict: true };
		}
		return this.writeDocument(id, parsed, { mode: 'replace', owner: undefined, upsert: true });
	}

	/**
	 * Operator read by id.
	 *
	 * The admin surface had no way to fetch ONE document, and no way to emulate
	 * it: `compileQuery` turns every `where.field` into a JSON path into the
	 * `data` blob, so `id` - a system column - is unreachable by any query the
	 * DSL can express. A server holding a service key could write a document
	 * and then never read it back.
	 *
	 * Null, not a throw, so the parent can answer 404 - and so an older
	 * deployed agent's route-level 404 stays distinguishable from this one.
	 */
	async adminGet(id: string): Promise<DbDocument | null> {
		const [row] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		return row ? toDto(row) : null;
	}

	/**
	 * Operator shallow merge into `data` - the public PATCH's semantics on an
	 * operator surface, so validators and permission keys do not apply (the
	 * Admin-SDK contract adminPut already follows).
	 *
	 * Never creates. PUT is the upsert; a PATCH that invented a document from a
	 * partial body would write a record missing every field the caller assumed
	 * was already there.
	 */
	async adminPatch(id: string, partial: unknown): Promise<DbDocument | null> {
		const parsed = documentDataSchema.parse(partial);
		const [existing] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		if (!existing) return null;

		const merged = { ...(JSON.parse(existing.data) as Record<string, unknown>), ...parsed };
		return this.writeDocument(id, merged, {
			mode: 'replace',
			owner: existing.owner,
			upsert: false,
		});
	}

	/** Operator delete. Returns false when the document does not exist. */
	async adminDelete(id: string): Promise<boolean> {
		return this.deleteDocument(id, null);
	}

	/** Exact live count, for parent-initiated reconciliation. */
	async getDocCount(): Promise<number> {
		const [row] = await this.db.select({ value: count() }).from(documents);
		return row?.value ?? 0;
	}

	/**
	 * Erase this collection. A PRIMARY destroys its registered replicas first
	 * - the parent's children-before-registry contract extends one level down,
	 * and the `replicas` table (populated before any pull is served) is what
	 * makes the fan-out complete. deleteAll leaves any alarm armed; this class
	 * schedules none, but deleteAlarm is kept for symmetry with the auth
	 * agent's hard-won sequence. The deferred abort preserves the RPC's own
	 * response - aborting synchronously would fail every successful erase.
	 */
	async destroy(): Promise<void> {
		if (this.role.kind === 'primary') {
			await this.destroyReplicaInstances();
		}
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1001, 'collection erased');
			} catch {
				// closing a half-dead socket must not block the erase
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// Replication: the primary's feed

	/** Append to the change log in the SAME task as the data write, then
	 * schedule the live push to any replica holding subscribers. */
	private logChange(op: 'put' | 'del', id: string, image: string | null): void {
		if (this.role.kind !== 'primary' || this.config?.replication !== 'auto') return;
		const lsn = appendLog(this.ctx.storage.sql, op, id, image);
		this.pendingLsn = lsn;
		this.schedulePush({ lsn, op, id, image, ts: Date.now() });
	}

	/**
	 * REP2 delivery: an RPC per push-flagged replica, AFTER the response
	 * (waitUntil). RPC wakes a hibernated replica, which applies the entry
	 * and notifies its own subscribers - no sockets, no keep-alive fights.
	 * Failures are absorbed: the pull path heals gaps, and a replica that
	 * reports no subscribers left gets its flag flipped off.
	 */
	private schedulePush(entry: LogEntry): void {
		const config = this.config;
		const name = this.ctx.id.name;
		if (!config || !name) return;
		const targets = listPushReplicas(this.ctx.storage.sql);
		if (!targets.length) return;

		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace<DbCollection>;
		this.ctx.waitUntil(
			(async () => {
				for (const replica of targets) {
					try {
						const stub = namespace.get(namespace.idFromName(`${name}:${replica.id}`));
						const result = (await stub.repApply({
							entries: [entry],
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

	/** A replica reports push transitions and socket counts as they move. */
	async repSetPush(input: unknown): Promise<void> {
		if (this.role.kind !== 'primary') return;
		const parsed = repSetPushInputSchema.parse(input);
		setReplicaPush(this.ctx.storage.sql, parsed.replicaId, parsed.region, {
			push: parsed.push,
			sockets: parsed.sockets,
		});
	}

	/**
	 * Which sibling a NEW subscriber in `region` should land on - the worker
	 * asks (60s isolate cache) before naming the instance. Non-primary,
	 * non-replicated, and demo shards always answer 1: demo subscription caps
	 * make sibling pressure unreachable, and a throwaway project must not be
	 * able to spawn data copies.
	 */
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

	/**
	 * Primary -> replica live delivery. Entries at or below the applied
	 * position are already-haves; a gap or epoch mismatch triggers a healing
	 * pull (which notifies subscribers too); with no subscribers left the
	 * primary is told to stop pushing.
	 */
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

	/** Attach the session bookmark to a write response, when one was logged. */
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

	/** Replica bootstrap: config + the log position the snapshot starts from.
	 * The caller is registered BEFORE any data leaves - the erase fan-out
	 * iterates that registry, so a bootstrapped replica is never an orphan.
	 * A disabled shard answers `ok: false` (never a throw: stale routing hits
	 * this constantly right after a disable, and it is not an error). */
	async repBootstrap(
		input: unknown,
	): Promise<{ ok: true; config: CollectionConfig; epoch: number; lsn: number } | { ok: false }> {
		const caller = repPullInputSchema.parse(input);
		const config = this.config;
		if (this.role.kind !== 'primary' || !config || config.replication !== 'auto') {
			return { ok: false };
		}
		registerReplica(this.ctx.storage.sql, caller.replicaId, caller.region, caller.since);
		return { ok: true, config, epoch: config.repEpoch, lsn: lastLsn(this.ctx.storage.sql) };
	}

	/** Replica catch-up; registers the caller durably before serving data. */
	async repPull(input: unknown): Promise<RepPullResult> {
		const parsed = repPullInputSchema.parse(input);
		const config = this.config;
		if (this.role.kind !== 'primary' || !config || config.replication !== 'auto') {
			// Disabled mid-flight: force the replica to notice via resync; the
			// disable path destroys it moments later anyway.
			return { resync: true, epoch: this.config?.repEpoch ?? 0 };
		}
		return serveRepPull(this.ctx.storage.sql, parsed, config.repEpoch);
	}

	/** Observability for /admin/replication/:name and the copilot. */
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

	/** Turn replication off: destroy every registered replica, drop the log. */
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
		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace<DbCollection>;
		for (const replica of listReplicas(this.ctx.storage.sql)) {
			const stub = namespace.get(namespace.idFromName(`${name}:${replica.id}`));
			try {
				await stub.destroy();
			} catch (error) {
				// The deferred-abort race again; an empty replica proves the wipe.
				if (!isDurableObjectReset(error)) throw error;
			}
		}
	}

	// -------------------------------------------------------------------------
	// Replication: the replica role

	private primaryStub() {
		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace<DbCollection>;
		return namespace.get(namespace.idFromName((this.role as ReplicaRole).primaryName));
	}

	/** Anything that is not a replicated read belongs to the primary. */
	private async forwardToPrimary(request: Request): Promise<Response> {
		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName((this.role as ReplicaRole).primaryName));
		return (await stub.fetch(request)) as unknown as Response;
	}

	/**
	 * Replica request handling: reads serve locally (bounded staleness +
	 * session bookmarks), everything else forwards - correctness never
	 * depends on the worker's routing cache being fresh.
	 */
	private async replicaDispatch(request: Request, url: URL, subPath: string): Promise<Response> {
		// REP2: subscribers land HERE - the replica runs the live engine over
		// its local copy, fed by primary pushes.
		if (request.method === 'GET' && subPath === '/subscribe') {
			const ready = await this.ensureReplica(0);
			if (!ready || !this.config) return this.forwardToPrimary(request);
			return this.acceptSubscriber(request);
		}

		const isRead =
			request.method === 'GET' ||
			(request.method === 'POST' && (subPath === '/query' || subPath === '/aggregate'));
		if (!isRead) return this.forwardToPrimary(request);

		const minLsn = Number(request.headers.get(MIN_LSN_HEADER) ?? 0) || 0;
		const ready = await this.ensureReplica(minLsn);
		// An unsatisfiable bookmark (or a failed bootstrap) is answered with
		// the primary's truth rather than an error or stale data.
		if (!ready || !this.config) return this.forwardToPrimary(request);

		const cors = this.corsHeaders(request);
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		return withCors(await this.route(request, url, subPath, this.config), cors);
	}

	/** Bootstrapped and fresh enough for this request's bookmark? */
	private async ensureReplica(minLsn: number): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		let meta = readReplicaMeta(sql);
		if (!meta || !this.config) {
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

	/** Full state transfer: config, snapshot pages, applied position. */
	private async replicaBootstrap(): Promise<boolean> {
		const role = this.role as ReplicaRole;
		try {
			const primary = this.primaryStub();
			const boot = (await primary.repBootstrap({
				since: 0,
				replicaId: role.replicaId,
				region: role.region,
			})) as unknown as Awaited<ReturnType<DbCollection['repBootstrap']>>;
			if (!boot.ok) return false;
			await this.configure(boot.config);
			await this.db.delete(documents);

			let afterId: string | undefined;
			for (;;) {
				const chunk = (await primary.exportChunk(afterId)) as unknown as Awaited<
					ReturnType<DbCollection['exportChunk']>
				>;
				for (const doc of chunk.docs) this.applyDocImage(doc);
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

	/**
	 * Catch up from the primary's log. A pull failure returns the old meta -
	 * bounded staleness is acceptable, and the caller's bookmark check is
	 * what decides between serving and forwarding. A resync answer or an
	 * epoch change (post-restore) discards everything and re-bootstraps.
	 */
	private async replicaPullLoop(meta: ReplicaMeta): Promise<ReplicaMeta> {
		const role = this.role as ReplicaRole;
		const sql = this.ctx.storage.sql;
		try {
			const primary = this.primaryStub();
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

	/** Apply one entry; with `notify` the local live engine fires deltas, so
	 * subscribers see pull-healed changes too, not only pushed ones. */
	private async applyLogEntry(entry: LogEntry, notify = false): Promise<void> {
		const parsed = logEntrySchema.parse(entry);
		if (parsed.op === 'cfg') {
			if (parsed.image) await this.configure(JSON.parse(parsed.image));
			return;
		}
		if (parsed.op === 'del') {
			const before = notify ? await this.fetchDocById(parsed.id) : null;
			this.ctx.storage.sql.exec(`DELETE FROM documents WHERE id = ?`, parsed.id);
			if (notify && before) await this.notifySubscribers(before, null);
			return;
		}
		if (!parsed.image) return;
		const after = JSON.parse(parsed.image) as DbDocument;
		const before = notify ? await this.fetchDocById(after.id) : null;
		this.applyDocImage(after);
		if (notify) await this.notifySubscribers(before, after);
	}

	/** Idempotent image upsert - ids, owners, and timestamps verbatim. */
	private applyDocImage(doc: DbDocument): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO documents (id, data, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, owner = excluded.owner,
			   created_at = excluded.created_at, updated_at = excluded.updated_at`,
			doc.id,
			JSON.stringify(doc.data),
			doc.owner,
			Date.parse(doc.createdAt),
			Date.parse(doc.updatedAt),
		);
	}

	// -------------------------------------------------------------------------
	// HTTP surface: /agents/db-agent/<pid>/collections/<name>/...

	async fetch(request: Request): Promise<Response> {
		// EVERY exit drains an unread body first - see drainUnusedBody.
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)\/collections\/([^/]+)(\/.*)?$/);
		if (!match) return Response.json({ error: 'not found' }, { status: 404 });
		const subPath = match[3] ?? '/';

		// Replicas never consult the parent - their config arrives from the
		// primary's feed, and everything non-read forwards to the primary.
		if (this.role.kind === 'replica') {
			return this.replicaDispatch(request, url, subPath);
		}

		const config = await this.ensureConfig(match[1], match[2]);
		if (!config) {
			return Response.json({ error: 'collection is unavailable' }, { status: 503 });
		}

		const cors = this.corsHeaders(request);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		// A browser request from an untrusted origin gets an explicit refusal,
		// mirroring the auth agent's INVALID_ORIGIN behavior.
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		return withCors(await this.route(request, url, subPath, config), cors);
	}

	private async route(
		request: Request,
		url: URL,
		subPath: string,
		config: CollectionConfig,
	): Promise<Response> {
		if (subPath === '/subscribe' && request.method === 'GET') {
			return this.acceptSubscriber(request);
		}

		if (subPath === '/documents' && request.method === 'POST') {
			return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
				this.handleCreate(request, owner),
			);
		}
		if (subPath === '/query' && request.method === 'POST') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				this.handleQuery(request, owner),
			);
		}
		if (subPath === '/aggregate' && request.method === 'POST') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				this.handleAggregate(request, owner),
			);
		}
		if (subPath === '/export' && request.method === 'GET') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				Promise.resolve(this.handleExport(owner)),
			);
		}

		const doc = subPath.match(/^\/documents\/([^/]+)$/);
		if (doc) {
			const docId = decodeURIComponent(doc[1]);
			switch (request.method) {
				case 'GET':
					return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
						this.handleGet(docId, owner),
					);
				case 'PUT':
				case 'PATCH':
					return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
						this.handleWrite(request, docId, owner),
					);
				case 'DELETE':
					return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
						this.handleDelete(docId, owner),
					);
			}
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	/**
	 * Access-mode gate over the shared checkAccess (see access.ts). `owner`
	 * is null for public/auth requests and the JWT subject for owner-mode
	 * ones, which scopes every read and write.
	 */
	private async guarded(
		request: Request,
		mode: AccessMode,
		permission: string | null,
		handler: (owner: string | null) => Promise<Response>,
	): Promise<Response> {
		const decision = await checkAccess(request, mode, permission, this.getVerifier());
		if (!decision.ok) return decision.response;
		return handler(decision.owner);
	}

	// -------------------------------------------------------------------------
	// Document handlers

	private async handleCreate(request: Request, owner: string | null): Promise<Response> {
		const body = createDocumentSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid document', issues: body.error.issues },
				{ status: 400 },
			);
		}

		const sizeError = this.checkDocSize(body.data.data);
		if (sizeError) return sizeError;
		const rulesError = this.checkRules(body.data.data);
		if (rulesError) return rulesError;

		if (this.config?.demo) {
			const total = await this.getDocCount();
			if (total >= DEMO_MAX_DOCS_PER_COLLECTION) {
				return Response.json(
					{ error: `demo collections are capped at ${DEMO_MAX_DOCS_PER_COLLECTION} documents` },
					{ status: 429 },
				);
			}
		}

		// UUIDv7: ids sort chronologically, so id order - the default
		// for exports, cursor pages, and the dashboard browser - reads oldest
		// first with no orderBy.
		const id = body.data.id ?? uuidv7();
		const [existing] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		if (existing) {
			return Response.json({ error: 'a document with that id already exists' }, { status: 409 });
		}

		const written = await this.writeDocument(id, body.data.data, {
			mode: 'replace',
			owner,
			upsert: true,
		});
		return this.withLsn(Response.json(written, { status: 201 }));
	}

	private async handleGet(docId: string, owner: string | null): Promise<Response> {
		const [row] = await this.db.select().from(documents).where(eq(documents.id, docId)).limit(1);
		// Owner mode 404s on other people's documents rather than 403: their
		// existence is itself private.
		if (!row || (owner && row.owner !== owner)) {
			return Response.json({ error: 'no such document' }, { status: 404 });
		}
		return Response.json(toDto(row));
	}

	private async handleWrite(request: Request, docId: string, owner: string | null) {
		const body = documentDataSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid document', issues: body.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(documents)
			.where(eq(documents.id, docId))
			.limit(1);
		if (!existing || (owner && existing.owner !== owner)) {
			return Response.json({ error: 'no such document' }, { status: 404 });
		}

		const merged =
			request.method === 'PATCH'
				? { ...(JSON.parse(existing.data) as Record<string, unknown>), ...body.data }
				: body.data;
		const sizeError = this.checkDocSize(merged);
		if (sizeError) return sizeError;
		// PATCH validates the merged result: a merge can never sneak an invalid
		// document past rules the same body would fail on create.
		const rulesError = this.checkRules(merged);
		if (rulesError) return rulesError;

		const written = await this.writeDocument(docId, merged, {
			mode: 'replace',
			owner: existing.owner,
			upsert: false,
		});
		return this.withLsn(Response.json(written));
	}

	private async handleDelete(docId: string, owner: string | null): Promise<Response> {
		const deleted = await this.deleteDocument(docId, owner);
		if (!deleted) return Response.json({ error: 'no such document' }, { status: 404 });
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
		return Response.json(await this.runQuery(parsed.data, owner));
	}

	private async handleAggregate(request: Request, owner: string | null): Promise<Response> {
		const parsed = aggregateRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid aggregate request', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		return Response.json(this.runAggregate(parsed.data, owner));
	}

	/**
	 * NDJSON export of every readable document, gated exactly like a query
	 * (owner mode exports only the caller's documents). Streamed in keyset
	 * pages so a 10 GB collection never materializes in memory.
	 */
	private handleExport(owner: string | null): Response {
		const collection = this.config?.collection ?? 'collection';
		const encoder = new TextEncoder();
		const nextRows = (after: string | null) => this.exportRows(after, EXPORT_CHUNK, owner);
		let afterId: string | null = null;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (done) return;
				const rows = nextRows(afterId);
				for (const doc of rows) controller.enqueue(encoder.encode(`${JSON.stringify(doc)}\n`));
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
				'content-disposition': `attachment; filename="${collection}.ndjson"`,
			},
		});
	}

	private checkDocSize(data: Record<string, unknown>): Response | null {
		const issue = this.docSizeIssue(data);
		return issue ? Response.json({ error: issue }, { status: 413 }) : null;
	}

	private docSizeIssue(data: Record<string, unknown>): string | null {
		const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
		const cap = this.config?.demo ? DEMO_MAX_DOC_BYTES : MAX_DOC_BYTES;
		if (bytes > cap) {
			return `document data is limited to ${cap} bytes${this.config?.demo ? ' in demo projects' : ''}`;
		}
		return null;
	}

	/** Rules-lite enforcement for the public write path; null when it passes. */
	private checkRules(data: Record<string, unknown>): Response | null {
		const validator = this.config?.validator;
		if (!validator) return null;
		const issues = validateDocument(validator, data);
		if (!issues.length) return null;
		return Response.json({ error: 'document failed validation', issues }, { status: 400 });
	}

	// -------------------------------------------------------------------------
	// Write path: every mutation computes old/new and notifies subscribers

	private async writeDocument(
		id: string,
		data: Record<string, unknown>,
		options: {
			mode: 'replace';
			owner: string | null | undefined;
			upsert: boolean;
			/** Import fidelity: keep the exported timestamps instead of now. */
			createdAt?: Date;
			updatedAt?: Date;
			/** Import fidelity: overwrite the owner column on update too. */
			replaceOwner?: boolean;
		},
	): Promise<DbDocument> {
		const [before] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		const now = new Date();
		const serialized = JSON.stringify(data);

		let row: DocumentRow;
		if (before) {
			[row] = await this.db
				.update(documents)
				.set({
					data: serialized,
					updatedAt: options.updatedAt ?? now,
					...(options.replaceOwner ? { owner: options.owner ?? null } : {}),
				})
				.where(eq(documents.id, id))
				.returning();
		} else {
			[row] = await this.db
				.insert(documents)
				.values({
					id,
					data: serialized,
					owner: options.owner ?? null,
					createdAt: options.createdAt ?? now,
					updatedAt: options.updatedAt ?? now,
				})
				.returning();
		}

		// Log BEFORE any await: DO write coalescing commits the data row and
		// its log entry atomically only while no I/O yield separates them.
		this.logChange('put', id, JSON.stringify(toDto(row)));
		this.writeDbEvent(before ? 'doc.updated' : 'doc.created');
		await this.notifySubscribers(before ? toDto(before) : null, toDto(row));
		this.scheduleStatsReport();
		return toDto(row);
	}

	private async deleteDocument(id: string, owner: string | null): Promise<boolean> {
		const [before] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		if (!before || (owner && before.owner !== owner)) return false;

		await this.db.delete(documents).where(eq(documents.id, id));
		this.logChange('del', id, null);
		this.writeDbEvent('doc.deleted');
		await this.notifySubscribers(toDto(before), null);
		this.scheduleStatsReport();
		return true;
	}

	// -------------------------------------------------------------------------
	// Query execution

	private async runQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbDocument[]; nextCursor?: string }> {
		const cursor: DecodedCursor | null = query.cursor ? decodeCursor(query.cursor) : null;
		const compiled = compileQuery(query, { ownerSub, cursor });

		const rows = this.rawQuery(
			`SELECT id, data, owner, created_at, updated_at FROM documents ` +
				`WHERE ${compiled.whereSql} ORDER BY ${compiled.orderSql} LIMIT ?`,
			[...compiled.params, compiled.limit],
		);

		const docs = rows.map(rowToDto);
		const result: { docs: DbDocument[]; nextCursor?: string } = { docs };
		if (docs.length === compiled.limit && docs.length > 0) {
			const last = rows[rows.length - 1];
			result.nextCursor = encodeCursor({
				values: (query.orderBy ?? []).map((order) =>
					jsonValueAtPath(last.data as string, order.field),
				),
				id: last.id as string,
			});
		}
		return result;
	}

	private runAggregate(request: AggregateRequest, ownerSub: string | null): AggregateResult {
		const compiled = compileAggregate(request, { ownerSub });
		const [row] = this.rawQuery(compiled.sql, compiled.params);
		const results: Record<string, number | null> = {};
		compiled.aliases.forEach((alias, index) => {
			const value = row?.[`agg_${index}`];
			results[alias] = typeof value === 'number' ? value : null;
		});
		return { results };
	}

	/**
	 * Keyset page in id order for exports. Not a point-in-time snapshot:
	 * writes racing the export may or may not appear, but keyset pagination
	 * guarantees each id shows up at most once.
	 */
	private exportRows(afterId: string | null, limit: number, owner: string | null): DbDocument[] {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (afterId !== null) {
			conditions.push('id > ?');
			params.push(afterId);
		}
		if (owner) {
			conditions.push('owner = ?');
			params.push(owner);
		}
		return this.rawQuery(
			`SELECT id, data, owner, created_at, updated_at FROM documents ` +
				`WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'} ORDER BY id ASC LIMIT ?`,
			[...params, limit],
		).map(rowToDto);
	}

	private rawQuery(sql: string, params: unknown[]): Record<string, unknown>[] {
		// The SQL text is assembled ONLY from compileQuery output, whose field
		// paths are regex-validated; every value is a bound parameter.
		return this.ctx.storage.sql
			.exec(sql, ...(params as (string | number | null)[]))
			.toArray() as Record<string, unknown>[];
	}

	// -------------------------------------------------------------------------
	// The LiveShard surface (the engine itself lives in live.ts)

	protected liveGate(): LiveGate | null {
		return this.config
			? {
					readAccess: this.config.readAccess,
					readPermission: this.config.readPermission,
					demo: this.config.demo,
				}
			: null;
	}

	protected async runLiveQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbDocument[] }> {
		return this.runQuery(query, ownerSub);
	}

	protected async fetchDocById(id: string): Promise<DbDocument | null> {
		const [row] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		return row ? toDto(row) : null;
	}

	protected writeShardEvent(eventType: string): void {
		this.writeDbEvent(eventType);
	}

	/** Replicas freshen before serving a subscribe snapshot. */
	protected async beforeSnapshot(): Promise<void> {
		if (this.role.kind === 'replica') await this.ensureReplica(0);
	}

	/** RPC-path readiness (the gateway's remoteSubscribe arrives without the
	 * HTTP path's lazy-config heal): primaries pull config from the parent on
	 * first touch - auto-creating exactly like a first write - and replicas
	 * ensure their local copy. */
	protected async ensureShardReady(): Promise<void> {
		if (this.role.kind === 'replica') {
			await this.ensureReplica(0);
			return;
		}
		const name = this.ctx.id.name;
		if (!this.config && name) {
			const [projectId, collection] = name.split(':');
			if (projectId && collection) await this.ensureConfig(projectId, collection);
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
			await this.primaryStub().repSetPush({
				replicaId: role.replicaId,
				region: role.region,
				...update,
			});
			if (update.push !== undefined) this.pushWanted = update.push;
			if (update.sockets !== undefined) this.lastReportedSockets = update.sockets;
		} catch {
			// Unknown at the primary: the next transition (or a stop answer to
			// a stray push) reconciles it.
			if (update.push !== undefined) this.pushWanted = null;
			if (update.sockets !== undefined) this.lastReportedSockets = null;
		}
	}

	// -------------------------------------------------------------------------
	// Config, auth, CORS, analytics, stats

	/** Cached config, or a one-time lazy pull from the parent on first touch. */
	private async ensureConfig(
		projectId: string,
		collection: string,
	): Promise<CollectionConfig | null> {
		if (this.config) return this.config;

		try {
			const parent = await this.parentStub(projectId);
			const config = await parent.getCollectionConfig(collection, { autoCreate: true });
			if (config) await this.configure(config);
			return this.config;
		} catch (error) {
			// Null here becomes a 503 for the whole collection, so a broken
			// parent<->child link is an outage, not a hiccup - report it.
			try {
				Sentry.captureException(error, {
					level: 'error',
					tags: { projectId, collection, operation: 'ensure-config' },
					extra: { note: 'collection is answering 503 - config pull from the parent failed' },
				});
			} catch {
				// reporting must never break the request path
			}
			return null;
		}
	}

	private async parentStub(projectId: string) {
		const namespace = this.env.DbAgent as unknown as AgentNamespace<DbAgent>;
		// getAgentByName, never a raw namespace stub: plain RPC bypasses the
		// SDK's fetch-path initialization, so a cold parent would serve the
		// config pull before onStart's migrations and every first REST touch
		// of a fresh project would 503 ("no such table: collections").
		// getAgentByName synchronizes on onStart before returning the stub.
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

	private corsHeaders(request: Request): Headers | null {
		return corsHeadersFor(request, this.env.TRUSTED_ORIGINS, this.config?.allowedOrigins ?? []);
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		const config = this.config;
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [config?.projectId ?? 'unknown'],
				// Schema: event, collection, country, subject, reserved.
				blobs: [eventType, config?.collection ?? 'unknown', 'unknown', 'none', 'none'],
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
			await parent.reportCollectionStats(config.collection, { docs: await this.getDocCount() });
		} catch {
			// best-effort: the next write re-arms the timer and corrects the count
		}
	}
}

function toDto(row: DocumentRow): DbDocument {
	return {
		id: row.id,
		data: JSON.parse(row.data) as Record<string, unknown>,
		owner: row.owner,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function rowToDto(row: Record<string, unknown>): DbDocument {
	return {
		id: row.id as string,
		data: JSON.parse(row.data as string) as Record<string, unknown>,
		owner: (row.owner as string | null) ?? null,
		createdAt: new Date(row.created_at as number).toISOString(),
		updatedAt: new Date(row.updated_at as number).toISOString(),
	};
}

function jsonValueAtPath(dataJson: string, field: string): unknown {
	try {
		const data = JSON.parse(dataJson) as Record<string, unknown>;
		let value: unknown = data;
		for (const segment of field.split('.')) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
			value = (value as Record<string, unknown>)[segment];
		}
		return value ?? null;
	} catch {
		return null;
	}
}
