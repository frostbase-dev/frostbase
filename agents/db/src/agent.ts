import * as Sentry from '@sentry/cloudflare';
import { Agent, type AgentContext } from 'agents';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from './migrations.js';
import * as schema from './db/schema.js';
import { collections, gateways, restorePoints } from './db/schema.js';
import { pickSubscribeSibling, viewInstanceName } from './replication.js';
import {
	aggregateRequestSchema,
	checkpointRequestSchema,
	collectionModesSchema,
	collectionNameSchema,
	viewModesSchema,
	viewNameSchema,
	MAX_VIEWS_PER_PROJECT,
	RESERVED_SHARD_TABLES,
	demoTtlHoursSchema,
	importLineSchema,
	projectIdSchema,
	querySchema,
	restoreRequestSchema,
	settingsRequestSchema,
	tableColumnsSchema,
	tableModesSchema,
	validatorSchema,
	DEMO_PROJECT_PATTERN,
	IMPORT_RPC_CHUNK,
	MAX_GATEWAY_SIBLINGS,
	MAX_IMPORT_BYTES,
	MAX_IMPORT_DOCS,
	MAX_REMOTE_CONFIG_PARAMETERS,
	MAX_RESTORE_POINTS,
	duplicateRestorePointIds,
	remoteConfigPublishSummary,
	PLATFORM_SHARD_PREFIX,
	REMOTE_CONFIG_COLUMNS,
	REMOTE_CONFIG_TABLE,
	SIBLING_SPAWN_SOCKETS,
	isPlatformShard,
	remoteConfigKeySchema,
	remoteConfigParameterInputSchema,
	remoteConfigValueIssue,
	remoteConfigPending,
	remoteConfigStateSchema,
	storedConditionsSchema,
	remoteConfigValueTypeSchema,
	type AccessMode,
	type BookmarkOutcome,
	type CollectionConfig,
	type CollectionValidator,
	type DbDocument,
	type DbRow,
	type ImportLine,
	type ImportReport,
	type RemoteConfigParameter,
	type RestoreOutcome,
	type RestorePoint,
	type RestoreRequest,
	type TableColumn,
	type TableConfig,
	type ViewConfig,
	type ViewStatus,
} from './schemas.js';
import { drainUnusedBody } from './access.js';
import type { EvaluableParameter } from './remote-config.js';
import { ProjectJwtVerifier } from './jwt.js';
import { primaryLocation, type PrimaryLocation } from './colo.js';

/** The persisted form of the coordinator's location: the probe result plus
 * when it was taken, so a relocated instance can correct itself. */
interface StoredLocation extends PrimaryLocation {
	probedAt: number;
}

/** How stale a stored location may get before the next read refreshes it in
 * the background. Matches the isolate-level cache in colo.ts - a shorter
 * window here would only re-read that cache and write the same value back. */
const LOCATION_REFRESH_MS = 6 * 60 * 60 * 1000;
import { planDdl, uniqueViolationColumn } from './table-schema.js';
import type { DbCollection } from './collection.js';
import type { DbGateway } from './gateway.js';
import type { DbTable } from './table.js';
import type { DbView } from './view.js';

/**
 * JOIN1 materializes ONE instance per view, not one per region.
 *
 * A view already stores a second copy of every member; per-region views would
 * multiply that by the number of regions reading, and regional placement is a
 * latency optimization for a feature whose first job is being correct. The
 * NAME grammar still carries the region slot (`<pid>:v:<view>:<region>:<n>`),
 * so adding real regions later is a routing change - not a data migration and
 * not a new id shape on every member's feed.
 */
const VIEW_REGION = 'global';

/**
 * The per-project coordinator: owns the authoritative collection registry
 * (names, access modes, reported counts), the operator admin surface, the
 * dashboard's live state (Agents SDK state sync, consumed by AgentClient
 * exactly like the auth agent), demo TTL scheduling, and the erase fan-out
 * to its collection children.
 *
 * The hot data path never touches this class - the worker entrypoint routes
 * collection traffic straight to DbCollection instances, which cache their
 * config locally. This class is the single authority that creates children
 * and pushes config to them; a child with no config pulls it here once
 * (`getCollectionConfig({ autoCreate: true })`), which is also what heals a
 * registry row whose config push failed.
 */

const MAX_EVENTS = 50;
const MAX_COLLECTIONS = 200;
const DEMO_MAX_COLLECTIONS = 5;

/**
 * The runtime's "Application called abort() to reset Durable Object" family.
 * A destroyed/restored instance schedules abort() a tick after replying; in
 * PRODUCTION that abort can outrace the RPC reply across colos, so a
 * completed operation surfaces as this error at the caller. Local workerd
 * always flushes the reply first, which is why only deployed stacks see it.
 */
const DO_RESET_PATTERN = /abort\(\) to reset|durable object reset/i;

export function isDurableObjectReset(error: unknown): boolean {
	return DO_RESET_PATTERN.test(error instanceof Error ? error.message : String(error));
}

/** Registry rows store the validator as JSON text; unreadable = none. */
function parseStoredValidator(raw: string | null): CollectionValidator | null {
	if (!raw) return null;
	try {
		return validatorSchema.nullable().catch(null).parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** View rows store their member names as JSON text; unreadable = []. */
function parseStoredMembers(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * Why a table may not sit in a view - checked when the view is declared AND
 * whenever a member is reconfigured, since either side can break the pairing.
 *
 * `owner` mode is the one that matters. Row ownership does not survive a
 * join: `todos JOIN users` over owner-scoped todos returns the `users` rows
 * selected by OTHER owners' todos, and the general fix is a row-level
 * security engine, which this is not. Refusing at both edges is the whole
 * mitigation, so the message has to say why rather than just say no.
 *
 * `none` on the read side is refused for the same structural reason: a view is
 * a second copy of every member, so a member nobody may read through the public
 * API must not become readable by being joined. DbView re-checks it at read
 * time as well - the member's config travels by replication, so a member closed
 * after the view was built has a window.
 */
function viewMemberRefusal(
	member: string,
	readAccess: string,
	replication: 'off' | 'auto',
): string | null {
	if (readAccess === 'owner') {
		return (
			`"${member}" is owner-scoped, so it cannot be a view member - row ownership ` +
			`does not survive a join, and the join would expose other owners' rows`
		);
	}
	if (readAccess === 'none') {
		return (
			`"${member}" is closed to the public API, so it cannot be a view member - ` +
			`a view is a second copy of it, and the join would serve rows its own gate refuses`
		);
	}
	if (replication !== 'auto') {
		return `"${member}" has replication off - a view follows its members' change logs`;
	}
	return null;
}

/** Table rows store the declared columns as JSON text; unreadable = []. */
function parseStoredColumns(raw: string | null): TableColumn[] {
	if (!raw) return [];
	try {
		return tableColumnsSchema.parse(JSON.parse(raw));
	} catch {
		return [];
	}
}

/**
 * The kind-specific surface behind the shared shard admin actions (export,
 * import, PITR). Both engines expose the same RPC contract; the adapter is
 * what keeps the six admin routes single-sourced instead of copied per kind.
 */
interface ShardAdminOps {
	kind: 'collection' | 'table';
	row(): Promise<typeof collections.$inferSelect | null>;
	notFound(): Response;
	exportChunk(afterId?: string): Promise<{ docs: DbDocument[]; nextAfterId: string | null }>;
	importChunk(lines: ImportLine[]): Promise<ImportReport>;
	currentBookmark(): Promise<{ ok: true; bookmark: string } | { ok: false }>;
	bookmarkForTime(iso: string): Promise<BookmarkOutcome>;
	restoreTo(body: RestoreRequest): Promise<RestoreOutcome>;
	reconcileCount(): Promise<void>;
	pushShardConfig(row: typeof collections.$inferSelect): Promise<void>;
}

export interface DbActivityEvent {
	id: string;
	type:
		| 'project.provisioned'
		| 'collection.created'
		| 'collection.deleted'
		| 'collection.configured'
		| 'collection.restored'
		| 'documents.changed'
		| 'documents.imported'
		| 'table.created'
		| 'table.configured'
		| 'table.deleted'
		| 'table.restored'
		| 'rows.changed'
		| 'rows.imported'
		| 'view.created'
		| 'view.configured'
		| 'view.deleted'
		| 'remote-config.changed';
	message: string;
	at: string;
}

export interface DbCollectionSummary {
	name: string;
	readAccess: AccessMode;
	writeAccess: AccessMode;
	readPermission: string | null;
	writePermission: string | null;
	validator: CollectionValidator | null;
	replication: 'off' | 'auto';
	docs: number;
}

export interface DbTableSummary {
	name: string;
	readAccess: AccessMode;
	writeAccess: AccessMode;
	readPermission: string | null;
	writePermission: string | null;
	columns: TableColumn[];
	replication: 'off' | 'auto';
	rows: number;
}

export interface DbViewSummary {
	name: string;
	members: string[];
	readPermission: string | null;
}

export interface DbAgentState {
	projectId: string;
	provisionedAt: string | null;
	allowedOrigins: string[];
	collections: DbCollectionSummary[];
	tables: DbTableSummary[];
	/** Optional: state persisted before JOIN1 has no views key, and a stored
	 * state must never fail to parse because a later version added a field. */
	views?: DbViewSummary[];
	totalDocs: number;
	totalRows: number;
	/** Bumped on any reported change; dashboards refetch when it moves. */
	rev: number;
	totalEvents: number;
	lastEventAt: string | null;
	events: DbActivityEvent[];
}

export interface DbOverview {
	projectId: string;
	collections: DbCollectionSummary[];
	tables: DbTableSummary[];
	/**
	 * Where the COORDINATOR runs. Shards self-report their colo in `repStatus`,
	 * which is what normally places the dashboard's replication hub - but a
	 * project with no shards yet has nobody to ask, and the map fell back to a
	 * fixed mid-continent point that is a guess dressed as a fact. The parent
	 * is a Durable Object with a real location of its own, and it is where the
	 * first shard will be created, so it is the honest answer until one exists.
	 * Nulls in local dev, like every other colo probe.
	 */
	location: PrimaryLocation;
	state: DbAgentState;
}

export class DbAgent extends Agent<Env, DbAgentState> {
	initialState: DbAgentState = {
		projectId: '',
		provisionedAt: null,
		allowedOrigins: [],
		collections: [],
		tables: [],
		totalDocs: 0,
		totalRows: 0,
		rev: 0,
		totalEvents: 0,
		lastEventAt: null,
		events: [],
	};

	db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	private get isEphemeral(): boolean {
		return this.env.DEMO_MODE === 'true' && DEMO_PROJECT_PATTERN.test(this.name);
	}

	/** A row's replication, normalized to the union. The column defaults to
	 * 'auto' (read replicas out of the box, demos included - the demo IS the
	 * pitch for this feature); 'off' is the explicit opt-out. One choke point
	 * for every config build, routing answer, and state summary. */
	private shardReplication(row: { replication: string }): 'off' | 'auto' {
		return row.replication === 'auto' ? 'auto' : 'off';
	}

	async onStart(): Promise<void> {
		// Idempotent - drizzle tracks applied migrations in its own table.
		await migrate(this.db, migrations);

		if (this.env.LOCAL_ANALYTICS) {
			await this.env.LOCAL_ANALYTICS.batch([
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE TABLE IF NOT EXISTS db_events (
						id integer PRIMARY KEY AUTOINCREMENT,
						project_id text NOT NULL,
						event_type text NOT NULL,
						collection text NOT NULL,
						timestamp integer NOT NULL
					)`,
				),
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE INDEX IF NOT EXISTS db_events_project_time ON db_events(project_id, timestamp)`,
				),
			]);
		}

		if (!this.state.projectId) {
			this.setState({
				...this.state,
				projectId: this.name,
				provisionedAt: new Date().toISOString(),
			});
			this.writeDbEvent('project.provisioned');
			this.recordEvent('project.provisioned', `database provisioned for project "${this.name}"`);
		} else {
			// Re-derive summaries from the registry on wake: persisted state can
			// predate newer summary fields (readPermission, validator, ...), and
			// broadcasting the stale shape would fail the console's overview
			// parse for exactly the projects that already hold data.
			await this.syncCollectionsState();
		}

		if (this.isEphemeral) {
			const hours = demoTtlHoursSchema.parse(this.env.DEMO_TTL_HOURS);
			// idempotent so repeated wakes reuse the existing row - the deadline
			// runs from first provision, not the visitor's last page load.
			await this.schedule(hours * 3600, 'expireDemoProject', undefined, { idempotent: true });
		}
	}

	async expireDemoProject(): Promise<void> {
		// Re-check: schedules outlive configuration changes.
		if (!this.isEphemeral) return;
		await this.destroy();
	}

	// -------------------------------------------------------------------------
	// RPC surface

	/**
	 * The child's lazy config pull. With autoCreate, an unknown collection is
	 * registered with default modes - which is how first-write auto-creation
	 * stays parent-mediated even on the direct hot path.
	 */
	async getCollectionConfig(
		name: string,
		options: { autoCreate?: boolean } = {},
	): Promise<CollectionConfig | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;

		let [row] = await this.db.select().from(collections).where(eq(collections.name, name)).limit(1);
		// A name registered as a table never resolves as a collection (names
		// are unique across kinds), and auto-create must not squat on it.
		if (row && row.kind !== 'collection') return null;
		if (!row) {
			if (!options.autoCreate) return null;
			const denied = this.checkShardCap();
			if (denied) return null;
			[row] = await this.db
				.insert(collections)
				.values({ name, createdAt: new Date() })
				.onConflictDoNothing()
				.returning();
			if (!row) return null;
			this.writeDbEvent('collection.created');
			this.recordEvent('collection.created', `collection "${name}" created on first use`);
			await this.syncCollectionsState();
		}

		return this.buildConfig(row);
	}

	/** The table child's lazy config pull. NO auto-creation - tables are
	 * schema-first, so an unregistered name stays null and the child 404s. */
	async getTableConfig(name: string): Promise<TableConfig | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row || row.kind !== 'table') return null;
		return this.buildTableConfig(row);
	}

	/**
	 * The worker's routing lookup: is this shard replicated, and what kind is
	 * it? Cached isolate-locally for 60s at the caller; a stale answer is a
	 * latency wobble, never a correctness problem (replicas forward).
	 */
	async getShardRouting(
		name: string,
	): Promise<{ kind: 'collection' | 'table'; replication: 'off' | 'auto' } | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row) return null;
		return {
			kind: row.kind === 'table' ? 'table' : 'collection',
			replication: this.shardReplication(row),
		};
	}

	/** The project's per-project extra origins, for the gateway's socket-level
	 * origin gate (per-shard authorization still happens at each shard). */
	async getAllowedOrigins(): Promise<string[]> {
		return this.state.allowedOrigins;
	}

	/** Step-debounced socket-count report from a gateway instance - the
	 * sibling-spawn signal, registered durably for the erase fan-out too. */
	async reportGatewaySockets(id: string, region: string, sockets: number): Promise<void> {
		if (!/^gw:[a-z-]+:\d+$/.test(id)) return;
		const clean = Number.isFinite(sockets) && sockets >= 0 ? Math.floor(sockets) : 0;
		await this.db
			.insert(gateways)
			.values({ id, region, sockets: clean, lastSeenAt: new Date() })
			.onConflictDoUpdate({
				target: gateways.id,
				set: { sockets: clean, lastSeenAt: new Date() },
			});
	}

	/** Which gateway sibling a NEW realtime socket should land on - the
	 * replica sibling-spawn mechanism verbatim (fill-lowest with headroom,
	 * unregistered = 0 sockets so picking it IS the spawn). Demo projects
	 * never spawn siblings. */
	async gatewaySubscribeTarget(region: string): Promise<number> {
		if (this.isEphemeral) return 1;
		const rows = await this.db.select().from(gateways).where(eq(gateways.region, region));
		const counts: number[] = [];
		for (const row of rows) {
			const n = Number(row.id.split(':')[2]);
			if (Number.isInteger(n) && n >= 1) counts[n - 1] = row.sockets;
		}
		const threshold = Number(this.env.SIBLING_SPAWN_SOCKETS ?? '') || SIBLING_SPAWN_SOCKETS;
		return pickSubscribeSibling(counts, threshold, MAX_GATEWAY_SIBLINGS);
	}

	/** Debounced absolute row-count report from a table child. */
	async reportTableStats(name: string, stats: { rows: number }): Promise<void> {
		if (!collectionNameSchema.safeParse(name).success) return;
		const rows = Number.isFinite(stats.rows) && stats.rows >= 0 ? Math.floor(stats.rows) : 0;

		const [row] = await this.db
			.select()
			.from(collections)
			.where(and(eq(collections.name, name), eq(collections.kind, 'table')))
			.limit(1);
		if (!row) return;

		await this.db
			.update(collections)
			.set({ docs: rows, reportedAt: new Date() })
			.where(and(eq(collections.name, name), eq(collections.kind, 'table')));
		if (row.docs === rows) return;
		this.recordEvent('rows.changed', `table "${name}" now holds ${rows} rows`);
		await this.syncCollectionsState();
	}

	/**
	 * Debounced absolute-count report from a child. Best-effort by design.
	 *
	 * Reports are a HEARTBEAT, not a change notification: children send them on
	 * every wake (the self-healing path - see the child constructors), so most
	 * carry a count that has not moved. Logging those made a plain read look
	 * like a write in the activity feed, and each one pushed agent state twice,
	 * which the dashboard answers with a refetch. The event and the state sync
	 * belong to a real delta; the row's `reportedAt` is updated either way.
	 */
	async reportCollectionStats(name: string, stats: { docs: number }): Promise<void> {
		if (!collectionNameSchema.safeParse(name).success) return;
		const docs = Number.isFinite(stats.docs) && stats.docs >= 0 ? Math.floor(stats.docs) : 0;

		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row) return;

		await this.db
			.update(collections)
			.set({ docs, reportedAt: new Date() })
			.where(eq(collections.name, name));
		if (row.docs === docs) return;
		this.recordEvent('documents.changed', `collection "${name}" now holds ${docs} documents`);
		await this.syncCollectionsState();
	}

	/**
	 * Erase the whole project. Children are destroyed FIRST, and the registry
	 * survives until every one of them confirmed - so a failed fan-out can be
	 * retried by id and still find them. Nothing may leave an orphaned
	 * Durable Object holding user data.
	 */
	async destroy(): Promise<void> {
		const rows = await this.db.select().from(collections).orderBy(asc(collections.name));
		// VIEWS FIRST. A view holds copies of its members' rows, so a member
		// erased ahead of it would leave those rows readable through the view
		// until the view's own erase landed - and if that erase failed, forever.
		for (const row of rows.filter((entry) => entry.kind === 'view')) {
			await this.destroyChild('view', row.name);
		}
		for (const row of rows.filter((entry) => entry.kind !== 'view')) {
			await this.destroyChild(row.kind === 'table' ? 'table' : 'collection', row.name);
		}
		// Gateways hold only routing rows, but they are project-derived state:
		// close their sockets and wipe them before the registry goes.
		const gatewayRows = await this.db.select().from(gateways);
		const gatewayNamespace = this.env.DbGateway as unknown as DurableObjectNamespace<DbGateway>;
		for (const row of gatewayRows) {
			try {
				await gatewayNamespace.get(gatewayNamespace.idFromName(`${this.name}:${row.id}`)).destroy();
			} catch (error) {
				if (!isDurableObjectReset(error)) throw error;
			}
		}

		await this.ctx.storage.deleteAll();
		// deleteAll leaves the Durable Object's alarm armed; an orphaned alarm
		// would wake the erased object where the SDK's handler dies reading its
		// dropped cf_agents_schedules table.
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// HTTP surface (operator routes are enforced by the console guard; only
	// /config is declared public in the manifest)

	async onRequest(request: Request): Promise<Response> {
		try {
			const response = await this.routeRequest(request);
			await drainUnusedBody(request);
			return response;
		} catch (error) {
			// The Agents SDK's own _tryCatch converts handler exceptions into a
			// bare 500 BEFORE Sentry's DO instrumentation (which only sees
			// uncaught errors) gets a look - capture the real stack first, then
			// let the SDK answer. A no-op without a DSN, so consumers unaffected.
			Sentry.captureException(error);
			throw error;
		}
	}

	private async routeRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!projectIdSchema.safeParse(this.name).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400 });
		}
		const subPath = url.pathname.match(/\/agents\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? '/';

		if (subPath === '/config' && request.method === 'GET') {
			return Response.json({ projectId: this.name, realtime: true });
		}

		if (subPath === '/overview' && request.method === 'GET') {
			return Response.json(await this.getOverview());
		}

		if (subPath === '/admin/query' && request.method === 'POST') {
			return this.adminQuery(request);
		}

		if (subPath === '/admin/aggregate' && request.method === 'POST') {
			return this.adminAggregate(request);
		}

		if (subPath === '/admin/settings' && request.method === 'PUT') {
			return this.updateSettings(request);
		}

		// Platform-owned shards (`cfb_*`) are created and configured by the
		// feature that owns them, never through the generic routes. Remote
		// Config's parameter table is closed on both sides, and the Tables page
		// would otherwise be one dropdown away from opening it to public writes -
		// which hands every client the ability to rewrite their own feature
		// flags. Reads are deliberately untouched: this is the operator's
		// project, and hiding storage from them would be worse than reserving it.
		const shardMutation = subPath.match(/^\/admin\/(?:collections|tables|views)\/([^/]+)$/);
		if (shardMutation && (request.method === 'PUT' || request.method === 'DELETE')) {
			const name = decodeURIComponent(shardMutation[1]);
			if (isPlatformShard(name)) {
				return Response.json(
					{
						error:
							`"${name}" belongs to Frostbase - the "${PLATFORM_SHARD_PREFIX}" prefix is ` +
							`reserved for shards the platform owns. Manage it from the feature that created it.`,
					},
					{ status: 403 },
				);
			}
		}

		if (subPath === '/admin/remote-config' && request.method === 'GET') {
			return this.remoteConfigList();
		}
		if (subPath === '/admin/remote-config' && request.method === 'DELETE') {
			// The way back out. Reserving the `cfb_` prefix makes the parameter
			// table undeletable through the Tables page - which is the point - but
			// a project that stops using Remote Config must not be stuck with the
			// shard forever. The feature that owns a platform shard owns removing
			// it, so the teardown lives HERE rather than being an exception carved
			// into the generic route.
			if (!(await this.tableRow(REMOTE_CONFIG_TABLE))) {
				return Response.json({ deleted: false });
			}
			return this.deleteTable(REMOTE_CONFIG_TABLE);
		}
		if (subPath === '/admin/remote-config/publish' && request.method === 'POST') {
			return this.remoteConfigPublish(request);
		}
		if (subPath === '/admin/remote-config/discard' && request.method === 'POST') {
			return this.remoteConfigDiscard();
		}
		if (subPath === '/admin/remote-config/versions' && request.method === 'GET') {
			await this.ensureRemoteConfigTable();
			return this.adminRestorePoints('table', REMOTE_CONFIG_TABLE);
		}
		if (subPath === '/admin/remote-config/restore' && request.method === 'POST') {
			await this.ensureRemoteConfigTable();
			return this.adminRestore(request, 'table', REMOTE_CONFIG_TABLE);
		}
		const remoteConfigKey = subPath.match(/^\/admin\/remote-config\/([^/]+)$/);
		if (remoteConfigKey) {
			const key = decodeURIComponent(remoteConfigKey[1]);
			if (request.method === 'PUT') return this.remoteConfigPut(request, key);
			if (request.method === 'DELETE') return this.remoteConfigDelete(key);
		}

		const collectionDoc = subPath.match(/^\/admin\/collections\/([^/]+)\/documents\/([^/]+)$/);
		if (collectionDoc) {
			return this.adminDocumentWrite(
				request,
				decodeURIComponent(collectionDoc[1]),
				decodeURIComponent(collectionDoc[2]),
			);
		}

		const shardAction = subPath.match(
			/^\/admin\/(collections|tables)\/([^/]+)\/(export|import|restore|restore-points|checkpoint|bookmark)$/,
		);
		if (shardAction) {
			const kind = shardAction[1] === 'tables' ? ('table' as const) : ('collection' as const);
			const name = decodeURIComponent(shardAction[2]);
			switch (shardAction[3]) {
				case 'export':
					if (request.method === 'GET') return this.adminExport(kind, name);
					break;
				case 'import':
					if (request.method === 'POST') return this.adminImport(request, kind, name);
					break;
				case 'restore':
					if (request.method === 'POST') return this.adminRestore(request, kind, name);
					break;
				case 'restore-points':
					if (request.method === 'GET') return this.adminRestorePoints(kind, name);
					break;
				case 'checkpoint':
					if (request.method === 'POST') return this.adminCheckpoint(request, kind, name);
					break;
				case 'bookmark':
					if (request.method === 'GET') return this.adminBookmarkForTime(url, kind, name);
					break;
			}
			return Response.json({ error: 'not found' }, { status: 404 });
		}

		const collection = subPath.match(/^\/admin\/collections\/([^/]+)$/);
		if (collection && request.method === 'PUT') {
			return this.configureCollection(request, decodeURIComponent(collection[1]));
		}
		if (collection && request.method === 'DELETE') {
			return this.deleteCollection(decodeURIComponent(collection[1]));
		}

		const replicationStatus = subPath.match(/^\/admin\/replication\/([^/]+)$/);
		if (replicationStatus && request.method === 'GET') {
			return this.adminReplicationStatus(decodeURIComponent(replicationStatus[1]));
		}

		if (subPath === '/admin/realtime' && request.method === 'GET') {
			const rows = await this.db.select().from(gateways).orderBy(asc(gateways.id));
			return Response.json({
				gateways: rows.map((row) => ({
					id: row.id,
					region: row.region,
					sockets: row.sockets,
					lastSeenAt: row.lastSeenAt.toISOString(),
				})),
			});
		}

		const tableSql = subPath.match(/^\/admin\/tables\/([^/]+)\/sql$/);
		if (tableSql && request.method === 'POST') {
			return this.adminTableSql(request, decodeURIComponent(tableSql[1]));
		}

		const tableRow = subPath.match(/^\/admin\/tables\/([^/]+)\/rows\/([^/]+)$/);
		if (tableRow) {
			return this.adminTableRowWrite(
				request,
				decodeURIComponent(tableRow[1]),
				decodeURIComponent(tableRow[2]),
			);
		}

		const table = subPath.match(/^\/admin\/tables\/([^/]+)$/);
		if (table && request.method === 'PUT') {
			return this.configureTable(request, decodeURIComponent(table[1]));
		}
		if (table && request.method === 'DELETE') {
			return this.deleteTable(decodeURIComponent(table[1]));
		}

		const view = subPath.match(/^\/admin\/views\/([^/]+)$/);
		if (view) {
			const name = decodeURIComponent(view[1]);
			if (request.method === 'PUT') return this.configureView(request, name);
			if (request.method === 'DELETE') return this.deleteView(name);
			if (request.method === 'GET') return this.adminViewStatus(name);
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	/**
	 * The coordinator's own colo, persisted so a cold isolate never has to pay
	 * a trace probe before the replication map can place its hub.
	 *
	 * DO KV storage, deliberately NOT a SQLite column: this is one row of
	 * per-instance state, the key-value API is exactly what that is for, and a
	 * migration to carry two nullable strings would have to ship in every
	 * consumer's deployed agent before the console could read it.
	 *
	 * Stored WITH the time it was probed, and refreshed in the background once
	 * stale. An instance is not guaranteed to stay where it started - a
	 * relocated DO whose location was written once would report the old colo
	 * forever, which is the exact failure this field exists to fix. The stale
	 * value still answers immediately: a location a few hours out of date is
	 * worth far more than a blocked response, and the next read has the new
	 * one.
	 *
	 * Nulls are never written, so local dev (where the probe cannot answer)
	 * keeps retrying instead of freezing an empty answer. `deleteAll()` in
	 * destroy() drops the key with everything else.
	 */
	private async selfLocation(): Promise<PrimaryLocation> {
		const stored = await this.ctx.storage.get<StoredLocation>('agent-location');
		if (!stored) return await this.probeLocation();

		const location = { colo: stored.colo, country: stored.country };
		if (Date.now() - stored.probedAt >= LOCATION_REFRESH_MS) {
			// Behind the response, never in front of it.
			this.ctx.waitUntil(this.probeLocation());
		}
		return location;
	}

	private async probeLocation(): Promise<PrimaryLocation> {
		const probed = await primaryLocation();
		if (probed.colo || probed.country) {
			await this.ctx.storage.put('agent-location', { ...probed, probedAt: Date.now() });
		}
		return probed;
	}

	// -------------------------------------------------------------------------
	// Remote Config (RC1)
	//
	// The first Frostbase feature whose storage is the platform's own
	// primitive rather than a private table. Parameters live in a real DbTable,
	// so publish is a PITR checkpoint, rollback is a restore, and export is a
	// config backup - none of which had to be written here.
	//
	// Every operator route below funnels through `ensureRemoteConfigTable`, so
	// the console needs no setup step and a project that never opens the page
	// never pays for a shard.

	/**
	 * The parameter table, created on first touch.
	 *
	 * It goes through `configureTable` rather than inserting a registry row
	 * directly - a synthetic Request is a small ugliness next to a second copy
	 * of DDL planning, rollback-on-failure, event recording, and state sync that
	 * would then have to be kept in step with the real one.
	 */
	private async ensureRemoteConfigTable(): Promise<void> {
		const existing = await this.tableRow(REMOTE_CONFIG_TABLE);
		if (existing) return;
		const body = {
			// Closed on BOTH sides. Nothing public reads the parameter table
			// itself: RC2 serves an EVALUATED endpoint that reads it from in
			// here, so the raw rules - which cohorts exist, what the rollout
			// percentages are - never leave the server.
			readAccess: 'none',
			writeAccess: 'none',
			replication: 'auto',
			columns: REMOTE_CONFIG_COLUMNS,
		};
		const response = await this.configureTable(
			new Request('https://db-agent/internal/remote-config', {
				method: 'PUT',
				body: JSON.stringify(body),
			}),
			REMOTE_CONFIG_TABLE,
			{ platform: true },
		);
		if (!response.ok) {
			throw new Error(`remote config table could not be provisioned: ${await response.text()}`);
		}
	}

	private remoteConfigRow(row: DbRow): RemoteConfigParameter {
		const data = row.data as Record<string, unknown>;
		const state = remoteConfigStateSchema.catch('published').parse(data.state);
		const draftValue = data.draft_value ?? null;
		const publishedValue = data.published_value ?? null;
		const draftConditions = storedConditionsSchema.parse(data.draft_conditions ?? null);
		const publishedConditions = storedConditionsSchema.parse(data.published_conditions ?? null);
		return {
			key: row.id,
			valueType: remoteConfigValueTypeSchema.catch('json').parse(data.value_type),
			draftValue,
			publishedValue,
			draftConditions,
			publishedConditions,
			state,
			pending: remoteConfigPending({
				state,
				draftValue,
				publishedValue,
				draftConditions,
				publishedConditions,
			}),
			description: typeof data.description === 'string' ? data.description : null,
			updatedBy: typeof data.updated_by === 'string' ? data.updated_by : null,
			updatedAt: row.updatedAt,
		};
	}

	private async remoteConfigRows(): Promise<DbRow[]> {
		const child = this.tableStub(REMOTE_CONFIG_TABLE);
		const { docs } = (await child.adminQuery({
			limit: MAX_REMOTE_CONFIG_PARAMETERS,
		})) as unknown as { docs: DbRow[] };
		return docs;
	}

	/**
	 * The published parameters, for the worker to evaluate against a caller.
	 *
	 * An RPC method rather than a route, deliberately: this returns the raw
	 * targeting rules, and RPC is not reachable from outside the worker at all -
	 * there is no URL to leave undeclared, no route table to get wrong, and no
	 * gate to forget. The worker caches THIS (one entry per project) and does the
	 * per-caller evaluation itself, so a cohort never becomes a cache key.
	 *
	 * Drafts are excluded here, not filtered later: what is not published cannot
	 * reach a client even through a bug downstream.
	 */
	/**
	 * Verify a project JWT and hand back the claims Remote Config targets on.
	 *
	 * The verifier needs Durable Object storage for its JWKS cache, so it cannot
	 * live in the stateless worker - hence an RPC. Returns null for anything that
	 * does not verify, including an unconfigured project: Remote Config never
	 * REQUIRES a token, so a bad one makes a caller anonymous rather than an
	 * error. It must never make them privileged, which is why only a verified
	 * result contributes role and permissions at all.
	 */
	async verifyProjectToken(
		token: string,
	): Promise<{ sub: string; role: string | null; permissions: string[] } | null> {
		if (!this.remoteConfigVerifier) {
			this.remoteConfigVerifier = new ProjectJwtVerifier(
				this.ctx.storage,
				this.env as { AUTH_AGENT?: Fetcher },
				this.name,
			);
		}
		const result = await this.remoteConfigVerifier.verify(token);
		if (!result.ok) return null;
		return {
			sub: result.claims.sub,
			role: result.claims.role ?? null,
			permissions: result.claims.permissions ?? [],
		};
	}

	private remoteConfigVerifier: ProjectJwtVerifier | null = null;

	async remoteConfigPublished(): Promise<EvaluableParameter[]> {
		if (!(await this.tableRow(REMOTE_CONFIG_TABLE))) return [];
		const published: EvaluableParameter[] = [];
		for (const row of await this.remoteConfigRows()) {
			const data = row.data as Record<string, unknown>;
			// `deleting` is still live until the publish that removes it.
			if (data.state === 'draft') continue;
			published.push({
				key: row.id,
				valueType: remoteConfigValueTypeSchema.catch('json').parse(data.value_type),
				value: data.published_value ?? null,
				conditions: storedConditionsSchema.parse(data.published_conditions ?? null),
			});
		}
		return published;
	}

	private async remoteConfigList(): Promise<Response> {
		await this.ensureRemoteConfigTable();
		const parameters = (await this.remoteConfigRows())
			.map((row) => this.remoteConfigRow(row))
			.sort((a, b) => a.key.localeCompare(b.key));
		return Response.json({
			parameters,
			pendingChanges: parameters.filter((parameter) => parameter.pending).length,
			/** Whether anything has EVER been published - the empty-state copy
			 * needs to tell those two cases apart. */
			everPublished: parameters.some((parameter) => parameter.state !== 'draft'),
			limit: MAX_REMOTE_CONFIG_PARAMETERS,
		});
	}

	private async remoteConfigPut(request: Request, key: string): Promise<Response> {
		const validKey = remoteConfigKeySchema.safeParse(key);
		if (!validKey.success) {
			return Response.json(
				{ error: validKey.error.issues[0]?.message ?? 'invalid parameter key' },
				{ status: 400 },
			);
		}
		const body = remoteConfigParameterInputSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid parameter', issues: body.error.issues },
				{ status: 400 },
			);
		}
		const issue = remoteConfigValueIssue(body.data.valueType, body.data.defaultValue);
		if (issue) return Response.json({ error: issue }, { status: 400 });

		// A condition's override is a value for this parameter, so it answers to
		// the declared type exactly like the default does. Checking it here is
		// what stops a boolean flag resolving to the string "yes" for one cohort.
		for (const [index, condition] of (body.data.conditions ?? []).entries()) {
			const conditionIssue = remoteConfigValueIssue(body.data.valueType, condition.value);
			if (conditionIssue) {
				return Response.json(
					{ error: `condition ${index + 1}: ${conditionIssue}` },
					{ status: 400 },
				);
			}
		}

		await this.ensureRemoteConfigTable();
		const child = this.tableStub(REMOTE_CONFIG_TABLE);

		// The ceiling is checked on CREATE only, so an install already at the
		// limit can still edit and delete its way back under it.
		const existing = (await child.adminGet(key)) as unknown as DbRow | null;
		if (!existing) {
			const { docs } = (await child.adminQuery({
				limit: MAX_REMOTE_CONFIG_PARAMETERS,
			})) as unknown as { docs: DbRow[] };
			if (docs.length >= MAX_REMOTE_CONFIG_PARAMETERS) {
				return Response.json(
					{ error: `a project is limited to ${MAX_REMOTE_CONFIG_PARAMETERS} parameters` },
					{ status: 409 },
				);
			}
		}

		// An edit only ever touches the DRAFT. `published_value` and the state
		// transition to `published` belong to publish alone, which is what makes
		// editing safe to do in the open.
		const previous = existing?.data as Record<string, unknown> | undefined;
		const result = (await child.adminPut(
			key,
			{
				value_type: body.data.valueType,
				draft_value: body.data.defaultValue ?? null,
				published_value: previous?.published_value ?? null,
				// Three-state, like every other config field in this agent:
				// omitted leaves the drafted rules alone, null clears them.
				draft_conditions:
					body.data.conditions === undefined
						? (previous?.draft_conditions ?? null)
						: (body.data.conditions ?? null),
				published_conditions: previous?.published_conditions ?? null,
				// An edit to a parameter marked for deletion revives it: the
				// operator is plainly no longer removing it.
				state: previous && previous.state !== 'draft' ? 'published' : 'draft',
				description: body.data.description ?? null,
				// Resolved by the console guard from the session, never read off
				// the caller's own request - see the db admin proxy.
				updated_by: request.headers.get('cfb-operator') ?? null,
			},
			false,
		)) as unknown as DbRow | { invalid: string[] };

		if ('invalid' in result) {
			return Response.json(
				{ error: 'parameter failed validation', issues: result.invalid },
				{ status: 400 },
			);
		}
		this.recordEvent(
			'remote-config.changed',
			`remote config "${key}" ${existing ? 'edited' : 'added'} (draft)`,
		);
		return Response.json(this.remoteConfigRow(result));
	}

	/**
	 * Removing a parameter is itself a draft change.
	 *
	 * A parameter clients have never seen just goes; one that is live is MARKED
	 * and keeps being served until the next publish. Deleting it outright would
	 * make removal the one edit that takes effect immediately - the exact
	 * surprise the draft model exists to prevent.
	 */
	private async remoteConfigDelete(key: string): Promise<Response> {
		await this.ensureRemoteConfigTable();
		const child = this.tableStub(REMOTE_CONFIG_TABLE);
		const existing = (await child.adminGet(key)) as unknown as DbRow | null;
		if (!existing) return Response.json({ error: 'no such parameter' }, { status: 404 });

		const data = existing.data as Record<string, unknown>;
		if (data.state === 'draft') {
			await child.adminDelete(key);
			this.recordEvent('remote-config.changed', `remote config "${key}" discarded`);
			return Response.json({ deleted: true, pendingPublish: false });
		}

		await child.adminPut(key, { ...data, state: 'deleting' }, false);
		this.recordEvent('remote-config.changed', `remote config "${key}" marked for removal`);
		return Response.json({ deleted: false, pendingPublish: true });
	}

	/**
	 * Publish: drafts become what clients get, in one step, then a named PITR
	 * checkpoint records the result.
	 *
	 * The checkpoint is why there is no version store to build. A version IS a
	 * restore point on this table, so the history list and one-click rollback
	 * are the shard's own machinery - Firebase's change history for the cost of
	 * calling something that already existed.
	 */
	private async remoteConfigPublish(request: Request): Promise<Response> {
		await this.ensureRemoteConfigTable();
		const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
		const reason =
			typeof body?.reason === 'string' && body.reason.trim()
				? body.reason.trim().slice(0, 80)
				: 'publish';

		const child = this.tableStub(REMOTE_CONFIG_TABLE);
		const rows = await this.remoteConfigRows();
		// Keys by what happened to them - the checkpoint label is built from
		// these, because "publish (3)" told the rollback dialog nothing about
		// what a version contains.
		const addedKeys: string[] = [];
		const editedKeys: string[] = [];
		const removedKeys: string[] = [];
		for (const row of rows) {
			const data = row.data as Record<string, unknown>;
			if (data.state === 'deleting') {
				await child.adminDelete(row.id);
				removedKeys.push(row.id);
				continue;
			}
			const parameter = this.remoteConfigRow(row);
			if (!parameter.pending) continue;
			await child.adminPut(
				row.id,
				{
					...data,
					published_value: data.draft_value ?? null,
					published_conditions: data.draft_conditions ?? null,
					state: 'published',
				},
				false,
			);
			(parameter.state === 'draft' ? addedKeys : editedKeys).push(row.id);
		}
		const published = addedKeys.length + editedKeys.length;
		const removed = removedKeys.length;

		if (!published && !removed) {
			return Response.json({ error: 'there is nothing to publish' }, { status: 409 });
		}

		// The checkpoint is captured AFTER the flip, so restoring a version puts
		// back a config that was actually served rather than the draft that
		// preceded it.
		const summary = remoteConfigPublishSummary({
			added: addedKeys,
			edited: editedKeys,
			removed: removedKeys,
		});
		const checkpoint = await this.adminCheckpoint(
			new Request('https://db-agent/internal/remote-config/publish', {
				method: 'POST',
				body: JSON.stringify({
					// The console's default reason disappears into the summary; an
					// operator's own reason leads it.
					reason: (reason === 'publish' ? summary : `${reason}: ${summary}`).slice(0, 80),
				}),
			}),
			'table',
			REMOTE_CONFIG_TABLE,
		);
		this.recordEvent(
			'remote-config.changed',
			`remote config published (${published} changed, ${removed} removed)`,
		);
		// A checkpoint failure is not a publish failure - the flip already
		// happened, and reporting it as failed would invite a second publish.
		return Response.json({
			published,
			removed,
			versionCaptured: checkpoint.ok,
		});
	}

	/**
	 * Discard: put every draft back to what clients are being served.
	 *
	 * The counterpart publish needs. Without it an operator who edits five
	 * parameters and thinks better of it has no way back except re-typing the
	 * old values from memory - and the old values are right there in
	 * `published_value`.
	 */
	private async remoteConfigDiscard(): Promise<Response> {
		await this.ensureRemoteConfigTable();
		const child = this.tableStub(REMOTE_CONFIG_TABLE);
		let discarded = 0;
		for (const row of await this.remoteConfigRows()) {
			const data = row.data as Record<string, unknown>;
			const parameter = this.remoteConfigRow(row);
			if (!parameter.pending) continue;
			if (data.state === 'draft') {
				// Never published: there is no earlier value to return to.
				await child.adminDelete(row.id);
			} else {
				await child.adminPut(
					row.id,
					{
						...data,
						draft_value: data.published_value ?? null,
						draft_conditions: data.published_conditions ?? null,
						state: 'published',
					},
					false,
				);
			}
			discarded++;
		}
		if (discarded) {
			this.recordEvent('remote-config.changed', `remote config drafts discarded (${discarded})`);
		}
		return Response.json({ discarded });
	}

	async getOverview(): Promise<DbOverview> {
		return {
			projectId: this.name,
			collections: this.state.collections,
			tables: this.state.tables ?? [],
			location: await this.selfLocation(),
			state: this.state,
		};
	}

	/**
	 * One operator query surface for both engines (and the copilot's query
	 * tool): the body names exactly one of `collection` or `table`. Table
	 * compile refusals (unknown column, illegal dotted path) answer 400 with
	 * the compiler's message.
	 */
	private async adminQuery(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			table?: unknown;
			query?: unknown;
		} | null;
		const query = querySchema.safeParse(body?.query ?? {});
		const hasCollection = body?.collection !== undefined;
		const hasTable = body?.table !== undefined;
		if (!query.success || hasCollection === hasTable) {
			return Response.json(
				{ error: 'name exactly one of collection or table, plus a valid query' },
				{ status: 400 },
			);
		}

		if (hasTable) {
			const name = collectionNameSchema.safeParse(body?.table);
			if (!name.success) return Response.json({ error: 'invalid table name' }, { status: 400 });
			if (!(await this.tableRow(name.data))) {
				return Response.json({ error: 'no such table' }, { status: 404 });
			}
			const result = (await this.tableStub(name.data).adminQuery(query.data)) as unknown as Awaited<
				ReturnType<DbTable['adminQuery']>
			>;
			if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
			const { ok: _ok, ...payload } = result;
			return Response.json(payload);
		}

		const name = collectionNameSchema.safeParse(body?.collection);
		if (!name.success) return Response.json({ error: 'invalid collection name' }, { status: 400 });
		if (!(await this.collectionRow(name.data))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const child = this.childStub(name.data);
		return Response.json(await child.adminQuery(query.data));
	}

	/** The collection registry row, or null for invalid/unknown/table names. */
	private async collectionRow(name: string): Promise<typeof collections.$inferSelect | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		return row && row.kind === 'collection' ? row : null;
	}

	/** The table registry row, or null for invalid/unknown/collection names. */
	private async tableRow(name: string): Promise<typeof collections.$inferSelect | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		return row && row.kind === 'table' ? row : null;
	}

	/** One operator aggregate surface for both engines (T2): the body names
	 * exactly one of `collection` or `table`, like /admin/query. */
	private async adminAggregate(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			table?: unknown;
			aggregate?: unknown;
		} | null;
		const aggregate = aggregateRequestSchema.safeParse(body?.aggregate);
		const hasCollection = body?.collection !== undefined;
		const hasTable = body?.table !== undefined;
		if (!aggregate.success || hasCollection === hasTable) {
			return Response.json(
				{ error: 'name exactly one of collection or table, plus a valid aggregate request' },
				{ status: 400 },
			);
		}

		if (hasTable) {
			const name = collectionNameSchema.safeParse(body?.table);
			if (!name.success) return Response.json({ error: 'invalid table name' }, { status: 400 });
			if (!(await this.tableRow(name.data))) {
				return Response.json({ error: 'no such table' }, { status: 404 });
			}
			const result = (await this.tableStub(name.data).adminAggregate(
				aggregate.data,
			)) as unknown as Awaited<ReturnType<DbTable['adminAggregate']>>;
			if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
			return Response.json({ results: result.results });
		}

		const name = collectionNameSchema.safeParse(body?.collection);
		if (!name.success) return Response.json({ error: 'invalid collection name' }, { status: 400 });
		if (!(await this.collectionRow(name.data))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		return Response.json(await this.childStub(name.data).adminAggregate(aggregate.data));
	}

	/** Operator SQL over one table - the dashboard console and the copilot's
	 * read tool ride this; the statement gate is the same table-sql.ts. */
	private async adminTableSql(request: Request, name: string): Promise<Response> {
		if (!(await this.tableRow(name))) {
			return Response.json({ error: 'no such table' }, { status: 404 });
		}
		const body = await request.json().catch(() => null);
		const result = (await this.tableStub(name).adminSql(body)) as unknown as Awaited<
			ReturnType<DbTable['adminSql']>
		>;
		if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });
		return Response.json({ success: true, batch: result.batch });
	}

	/**
	 * The kind adapter behind the shared admin actions. The exportChunk casts
	 * mirror the DurableObjectNamespace<any> gotcha: DbDocument carries
	 * Record<string, unknown>, and `unknown` fails the stub's Rpc.Serializable
	 * transform, collapsing the return type to never. The values are plain
	 * JSON objects; only the type system objects.
	 */
	private shardOps(kind: 'collection' | 'table', name: string): ShardAdminOps {
		if (kind === 'table') {
			const stub = () => this.tableStub(name);
			return {
				kind,
				row: () => this.tableRow(name),
				notFound: () => Response.json({ error: 'no such table' }, { status: 404 }),
				exportChunk: async (afterId?: string) =>
					(await stub().exportChunk(afterId)) as unknown as Awaited<
						ReturnType<DbTable['exportChunk']>
					>,
				importChunk: (lines: ImportLine[]) => stub().importRows(lines),
				currentBookmark: () => stub().currentBookmark(),
				bookmarkForTime: (iso: string) => stub().bookmarkForTime(iso),
				restoreTo: (body: RestoreRequest) => stub().restoreTo(body),
				reconcileCount: async () =>
					this.reportTableStats(name, { rows: await stub().getRowCount() }),
				pushShardConfig: (row) => this.pushTableConfig(row),
			};
		}
		const stub = () => this.childStub(name);
		return {
			kind,
			row: () => this.collectionRow(name),
			notFound: () => Response.json({ error: 'no such collection' }, { status: 404 }),
			exportChunk: async (afterId?: string) =>
				(await stub().exportChunk(afterId)) as unknown as Awaited<
					ReturnType<DbCollection['exportChunk']>
				>,
			importChunk: (lines: ImportLine[]) => stub().importDocs(lines),
			currentBookmark: () => stub().currentBookmark(),
			bookmarkForTime: (iso: string) => stub().bookmarkForTime(iso),
			restoreTo: (body: RestoreRequest) => stub().restoreTo(body),
			reconcileCount: async () =>
				this.reportCollectionStats(name, { docs: await stub().getDocCount() }),
			pushShardConfig: (row) => this.pushConfig(row),
		};
	}

	/** Operator NDJSON export, streamed chunk by chunk over child RPC. */
	private async adminExport(kind: 'collection' | 'table', name: string): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const encoder = new TextEncoder();
		let afterId: string | undefined;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (done) return;
				const chunk = await ops.exportChunk(afterId);
				for (const doc of chunk.docs) {
					controller.enqueue(encoder.encode(`${JSON.stringify(doc)}\n`));
				}
				if (chunk.nextAfterId === null) {
					done = true;
					controller.close();
				} else {
					afterId = chunk.nextAfterId;
				}
			},
		});

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'content-disposition': `attachment; filename="${name}.ndjson"`,
			},
		});
	}

	/** Persist a named PITR bookmark for the dashboard's restore-point list. */
	private async saveRestorePoint(
		name: string,
		bookmark: string,
		reason: string,
	): Promise<RestorePoint> {
		// Capturing with no writes since the last capture yields the SAME
		// bookmark - publish, then an immediate rollback's "before rollback"
		// capture, is the ordinary way there. One bookmark is one storage state,
		// so it gets one row, under the label it was first captured with; a
		// duplicate would list the same state twice and broke the version list
		// that keys by bookmark.
		const [existing] = await this.db
			.select()
			.from(restorePoints)
			.where(and(eq(restorePoints.collection, name), eq(restorePoints.bookmark, bookmark)))
			.limit(1);
		if (existing) {
			return {
				bookmark,
				reason: existing.reason,
				capturedAt: existing.capturedAt.toISOString(),
			};
		}
		const capturedAt = new Date();
		await this.db.insert(restorePoints).values({ collection: name, bookmark, reason, capturedAt });
		// Marker-list cap only - restore-by-timestamp reaches any moment in the
		// 30-day window regardless of what is listed here.
		const rows = await this.db
			.select()
			.from(restorePoints)
			.where(eq(restorePoints.collection, name))
			.orderBy(desc(restorePoints.capturedAt), desc(restorePoints.id));
		for (const stale of rows.slice(MAX_RESTORE_POINTS)) {
			await this.db.delete(restorePoints).where(eq(restorePoints.id, stale.id));
		}
		return { bookmark, reason, capturedAt: capturedAt.toISOString() };
	}

	/** Capture the shard's current-moment bookmark; null when the environment
	 * has no PITR (local dev) - callers degrade gracefully. */
	private async captureRestorePoint(
		ops: ShardAdminOps,
		name: string,
		reason: string,
	): Promise<RestorePoint | null> {
		try {
			const current = await this.probeBookmark(ops);
			if (!current.ok) return null;
			return await this.saveRestorePoint(name, current.bookmark, reason);
		} catch {
			return null;
		}
	}

	/**
	 * The child's current bookmark, retried once on an abort-reset: a restore
	 * leaves that instance resetting for a tick, and without the retry a
	 * capture or a support probe in that window reports "unsupported" for a
	 * shard whose PITR is perfectly fine. The async wrapper is also what
	 * collapses the RPC stub's union return type for inference.
	 */
	private async probeBookmark(ops: ShardAdminOps) {
		const probe = async () => ops.currentBookmark();
		try {
			return await probe();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			return await probe();
		}
	}

	/**
	 * The dashboard's restore-point list: named markers plus whether this
	 * environment supports PITR at all, so the dialog can explain up front
	 * instead of failing after a submit.
	 */
	private async adminRestorePoints(kind: 'collection' | 'table', name: string): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const probe = await this.probeBookmark(ops);
		// The platform window is 30 days; older markers are dead weight.
		await this.db
			.delete(restorePoints)
			.where(
				and(
					eq(restorePoints.collection, name),
					lt(restorePoints.capturedAt, new Date(Date.now() - 30 * 24 * 3600 * 1000)),
				),
			);
		const rows = await this.db
			.select()
			.from(restorePoints)
			.where(eq(restorePoints.collection, name))
			.orderBy(desc(restorePoints.capturedAt), desc(restorePoints.id));
		// Same-bookmark rows written before saveRestorePoint refused duplicates
		// heal here, on read - the oldest row keeps the bookmark's original
		// label, the re-captures go.
		const duplicates = duplicateRestorePointIds(rows);
		for (const id of duplicates) {
			await this.db.delete(restorePoints).where(eq(restorePoints.id, id));
		}
		const removed = new Set(duplicates);
		return Response.json({
			supported: probe.ok,
			points: rows
				.filter((row) => !removed.has(row.id))
				.map((row) => ({
					bookmark: row.bookmark,
					reason: row.reason,
					capturedAt: row.capturedAt.toISOString(),
				})),
		});
	}

	/**
	 * D1-restore-style: `?at=<ISO time>` in, the closest available bookmark
	 * out - the dialog shows it BEFORE the operator commits to a restore.
	 */
	private async adminBookmarkForTime(
		url: URL,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const at = url.searchParams.get('at') ?? '';
		const target = new Date(at).getTime();
		const now = Date.now();
		if (!at || Number.isNaN(target) || target > now || now - target > 30 * 24 * 3600 * 1000) {
			return Response.json(
				{ error: 'pass ?at=<ISO timestamp> within the past 30 days' },
				{ status: 400 },
			);
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();

		const resolve = async () => ops.bookmarkForTime(new Date(target).toISOString());
		let outcome;
		try {
			outcome = await resolve();
		} catch (error) {
			// Same reset window as probeBookmark: retry once on the fresh instance.
			if (!isDurableObjectReset(error)) throw error;
			outcome = await resolve();
		}
		if (!outcome.ok) {
			if (outcome.code === 'unsupported') {
				return Response.json(
					{
						error:
							'point-in-time recovery is not available in this environment - ' +
							'local development keeps no durable change log',
					},
					{ status: 501 },
				);
			}
			return Response.json({ error: outcome.message ?? 'bookmark lookup failed' }, { status: 400 });
		}
		return Response.json({ bookmark: outcome.bookmark, at: new Date(target).toISOString() });
	}

	/** Manual checkpoint: capture "now" as a named restore point. */
	private async adminCheckpoint(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const body = checkpointRequestSchema.safeParse(await request.json().catch(() => ({})));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid checkpoint request', issues: body.error.issues },
				{ status: 400 },
			);
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const point = await this.captureRestorePoint(
			ops,
			name,
			body.data.reason ?? 'manual checkpoint',
		);
		if (!point) {
			return Response.json(
				{
					error:
						'point-in-time recovery is not available in this environment - ' +
						'local development keeps no durable change log',
				},
				{ status: 501 },
			);
		}
		return Response.json(point);
	}

	/**
	 * Operator NDJSON import: parse every line up front (bad lines are
	 * reported with their 1-based line number, good ones still land), then
	 * feed the children in RPC-sized chunks and merge their reports.
	 */
	private async adminImport(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const text = await request.text().catch(() => '');
		if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
			return Response.json(
				{ error: `imports are limited to ${MAX_IMPORT_BYTES} bytes per request` },
				{ status: 413 },
			);
		}

		const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
		if (lines.length === 0) {
			return Response.json({ error: 'the import body carried no NDJSON lines' }, { status: 400 });
		}
		if (lines.length > MAX_IMPORT_DOCS) {
			return Response.json(
				{ error: `imports are limited to ${MAX_IMPORT_DOCS} documents per request` },
				{ status: 400 },
			);
		}

		// A free undo for the whole import (deployed stacks; local has no PITR).
		await this.captureRestorePoint(ops, name, 'before import');

		const report: ImportReport = { imported: 0, updated: 0, errors: [] };
		const valid: { line: number; parsed: ImportLine }[] = [];
		for (const [index, line] of lines.entries()) {
			let json: unknown;
			try {
				json = JSON.parse(line);
			} catch {
				report.errors.push({ line: index + 1, error: 'not valid JSON' });
				continue;
			}
			const parsed = importLineSchema.safeParse(json);
			if (!parsed.success) {
				report.errors.push({ line: index + 1, error: 'not an importable document line' });
				continue;
			}
			valid.push({ line: index + 1, parsed: parsed.data });
		}

		for (let start = 0; start < valid.length; start += IMPORT_RPC_CHUNK) {
			const chunk = valid.slice(start, start + IMPORT_RPC_CHUNK);
			const chunkReport = await ops.importChunk(chunk.map((entry) => entry.parsed));
			report.imported += chunkReport.imported;
			report.updated += chunkReport.updated;
			for (const error of chunkReport.errors) {
				report.errors.push({ line: chunk[error.line]?.line ?? -1, error: error.error });
			}
		}

		const noun = kind === 'table' ? 'rows' : 'documents';
		const importedEvent =
			kind === 'table' ? ('rows.imported' as const) : ('documents.imported' as const);
		this.writeDbEvent(importedEvent);
		this.recordEvent(
			importedEvent,
			`imported ${report.imported + report.updated} ${noun} into "${name}"` +
				(report.errors.length ? ` (${report.errors.length} lines failed)` : ''),
		);
		// Immediate count reconcile so the dashboard reflects the import now
		// rather than after the next organic write.
		try {
			await ops.reconcileCount();
		} catch {
			// best-effort: the count self-heals on the next write
		}
		return Response.json(report);
	}

	/**
	 * Point-in-time rollback of ONE shard (either kind). The child validates
	 * support and performs the platform restore; this route owns the 30-day
	 * window check and the operator-facing error shapes (501 = the environment
	 * has no durable change log, i.e. local development).
	 */
	private async adminRestore(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const parsed = restoreRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid restore request', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		if (parsed.data.timestamp !== undefined) {
			const target = new Date(parsed.data.timestamp).getTime();
			const now = Date.now();
			if (target > now || now - target > 30 * 24 * 3600 * 1000) {
				return Response.json(
					{ error: 'restore timestamps must fall within the past 30 days' },
					{ status: 400 },
				);
			}
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();

		// Capture the undo point BEFORE the restore: the child aborts a tick
		// after arming it, and in production that abort can outrace the RPC
		// reply. With the pre-restore bookmark already persisted, an
		// abort-reset error still reports success with a working undo.
		// The undo point names its target - a history full of bare "before
		// rollback" rows says nothing about which version each one stepped to.
		let undoReason = 'before rollback';
		if (parsed.data.bookmark) {
			const [target] = await this.db
				.select()
				.from(restorePoints)
				.where(
					and(eq(restorePoints.collection, name), eq(restorePoints.bookmark, parsed.data.bookmark)),
				)
				.limit(1);
			if (target) undoReason = `before rollback to "${target.reason}"`.slice(0, 80);
		} else if (parsed.data.timestamp) {
			undoReason = `before rollback to ${parsed.data.timestamp}`.slice(0, 80);
		}
		const undoPoint = await this.captureRestorePoint(ops, name, undoReason);
		let outcome: RestoreOutcome;
		try {
			outcome = await ops.restoreTo(parsed.data);
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			// An abort-reset here is ambiguous: THIS restore's abort raced its
			// reply (armed - success), or the call landed in the teardown of the
			// PREVIOUS restore (rapid undo chains) and never ran. Retry once
			// against the fresh instance - re-arming the same bookmark is
			// idempotent - and only a second race counts as armed-and-raced.
			try {
				outcome = await ops.restoreTo(parsed.data);
			} catch (retryError) {
				if (!isDurableObjectReset(retryError)) throw retryError;
				outcome = { ok: true, undoBookmark: undoPoint?.bookmark ?? '' };
			}
		}
		if (!outcome.ok) {
			if (outcome.code === 'unsupported') {
				return Response.json(
					{
						error:
							'point-in-time recovery is not available in this environment - ' +
							'local development keeps no durable change log',
					},
					{ status: 501 },
				);
			}
			return Response.json({ error: outcome.message ?? 'restore failed' }, { status: 400 });
		}

		const restoredEvent =
			kind === 'table' ? ('table.restored' as const) : ('collection.restored' as const);
		this.writeDbEvent(restoredEvent);
		this.recordEvent(
			restoredEvent,
			parsed.data.timestamp
				? `${kind} "${name}" rolled back to ${parsed.data.timestamp}`
				: `${kind} "${name}" restored to a bookmark`,
		);
		// A restore rewinds the primary's storage INCLUDING its change log, so
		// the epoch that tells replicas to discard and re-bootstrap must live
		// here, in the parent. Bump it and push the config carrying it.
		const restoredRow = await ops.row();
		if (restoredRow && this.shardReplication(restoredRow) === 'auto') {
			await this.db
				.update(collections)
				.set({ repEpoch: restoredRow.repEpoch + 1 })
				.where(eq(collections.name, name));
			const bumped = await ops.row();
			if (bumped) {
				try {
					await ops.pushShardConfig(bumped);
				} catch {
					// the child heals via lazy pull; replicas resync on next pull
				}
			}
		}
		// The undo point was captured before the restore, so it is already in
		// the list; the response carries whichever undo handle survived.
		// The child aborts a tick after answering; give the restored session a
		// moment, then reconcile the count. Best-effort - the count self-heals.
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			await ops.reconcileCount();
		} catch {
			// the restored instance reports on its next write
		}
		return Response.json({ restored: true, undoBookmark: outcome.undoBookmark });
	}

	private async adminDocumentWrite(
		request: Request,
		name: string,
		docId: string,
	): Promise<Response> {
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const child = this.childStub(name);

		if (request.method === 'PUT') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid document body' }, { status: 400 });
			}
			// ?ifAbsent=1: the dashboard's ADD flow refuses taken ids with 409;
			// a plain PUT keeps the editor's deliberate replace semantics. The
			// cast mirrors adminExport: DbDocument in an RPC return collapses
			// the stub's type to never.
			const ifAbsent = new URL(request.url).searchParams.get('ifAbsent') === '1';
			const result = (await child.adminPut(docId, data.data, ifAbsent)) as unknown as Awaited<
				ReturnType<DbCollection['adminPut']>
			>;
			if (typeof result === 'object' && result !== null && 'conflict' in result) {
				return Response.json({ error: 'a document with that id already exists' }, { status: 409 });
			}
			return Response.json(result);
		}
		// GET and PATCH landed with the server-side service path
		//: until then this route was PUT and
		// DELETE only, so a service key could write a document and never read it
		// back - /admin/query cannot filter on `id` at all.
		if (request.method === 'GET') {
			const found = (await child.adminGet(docId)) as unknown as Awaited<
				ReturnType<DbCollection['adminGet']>
			>;
			if (!found) return Response.json({ error: 'no such document' }, { status: 404 });
			return Response.json(found);
		}
		if (request.method === 'PATCH') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid document body' }, { status: 400 });
			}
			const merged = (await child.adminPatch(docId, data.data)) as unknown as Awaited<
				ReturnType<DbCollection['adminPatch']>
			>;
			if (!merged) return Response.json({ error: 'no such document' }, { status: 404 });
			return Response.json(merged);
		}
		if (request.method === 'DELETE') {
			const deleted = await child.adminDelete(docId);
			if (!deleted) return Response.json({ error: 'no such document' }, { status: 404 });
			return Response.json({ deleted: true });
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async configureCollection(request: Request, name: string): Promise<Response> {
		if (!collectionNameSchema.safeParse(name).success) {
			return Response.json(
				{ error: 'collection names are lowercase letters, digits, _ and - (max 64 chars)' },
				{ status: 400 },
			);
		}
		const modes = collectionModesSchema.safeParse(await request.json().catch(() => ({})));
		if (!modes.success) {
			return Response.json(
				{ error: 'invalid access modes', issues: modes.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);

		// Names are unique across kinds (the registry PK): a table already
		// holds this one.
		if (existing && existing.kind !== 'collection') {
			return Response.json({ error: `"${name}" is already a table` }, { status: 409 });
		}
		if (!existing) {
			const denied = this.checkShardCap();
			if (denied) return denied;
		}

		// Omitted permission/validator fields stay as they are - a modes-only
		// save from the Access tab can never clobber rules configured earlier.
		const patch: Partial<typeof collections.$inferInsert> = {
			readAccess: modes.data.readAccess,
			writeAccess: modes.data.writeAccess,
		};
		if (modes.data.readPermission !== undefined) patch.readPermission = modes.data.readPermission;
		if (modes.data.writePermission !== undefined) {
			patch.writePermission = modes.data.writePermission;
		}
		if (modes.data.validator !== undefined) {
			patch.validator = modes.data.validator === null ? null : JSON.stringify(modes.data.validator);
		}
		if (modes.data.replication !== undefined) {
			patch.replication = modes.data.replication;
		}

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				readPermission: null,
				writePermission: null,
				validator: null,
				...patch,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({ target: collections.name, set: patch })
			.returning();

		// Row first, THEN push: if the push fails the child heals via lazy pull.
		await this.pushConfig(row);

		this.writeDbEvent(existing ? 'collection.configured' : 'collection.created');
		this.recordEvent(
			existing ? 'collection.configured' : 'collection.created',
			existing
				? `collection "${name}" set to read=${modes.data.readAccess} write=${modes.data.writeAccess}`
				: `collection "${name}" created (read=${modes.data.readAccess} write=${modes.data.writeAccess})`,
		);
		await this.syncCollectionsState();
		return Response.json({
			name,
			readAccess: row.readAccess,
			writeAccess: row.writeAccess,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			validator: parseStoredValidator(row.validator),
		});
	}

	private async deleteCollection(name: string): Promise<Response> {
		const row = await this.collectionRow(name);
		if (!row) return Response.json({ error: 'no such collection' }, { status: 404 });

		// Child first, registry second - a failure leaves the row so the
		// operator can retry; the reverse order would orphan the child's data.
		await this.destroyChild('collection', name);
		await this.db.delete(collections).where(eq(collections.name, name));
		// A deliberate erase must stay erased - drop its restore markers too.
		await this.db.delete(restorePoints).where(eq(restorePoints.collection, name));

		this.writeDbEvent('collection.deleted');
		this.recordEvent('collection.deleted', `collection "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
	}

	/**
	 * Declare or alter a table: full desired schema in, destructive diffs
	 * refused HERE (before any row write or push - the child's planner is
	 * defensive only), row first, then push. A DDL failure at the child (e.g.
	 * uniquifying a column holding duplicates) must not leave the registry
	 * claiming columns that never applied: the row reverts and the SQLite
	 * message surfaces as the 409.
	 */
	/**
	 * `options.platform` marks a shard the PLATFORM owns rather than the
	 * operator: it is how Remote Config declares its own table through the very
	 * same path an operator's table takes (so the two can never drift on DDL
	 * planning or failure rollback), and it exempts that table from the
	 * per-project shard cap - the platform's storage is not the operator's
	 * quota. The `cfb_` reservation itself is enforced at the ROUTE, so this
	 * flag is unreachable from outside.
	 */
	private async configureTable(
		request: Request,
		name: string,
		options: { platform?: boolean } = {},
	): Promise<Response> {
		if (!collectionNameSchema.safeParse(name).success) {
			return Response.json(
				{ error: 'table names are lowercase letters, digits, _ and - (max 64 chars)' },
				{ status: 400 },
			);
		}
		// A declared table is a REAL SQLite table of that name, so it must not
		// name one the shard's own migrations already created - it would adopt
		// internal storage rather than create anything (RESERVED_SHARD_TABLES).
		if (RESERVED_SHARD_TABLES.has(name)) {
			return Response.json(
				{ error: `"${name}" is reserved for internal storage - pick another name` },
				{ status: 400 },
			);
		}
		const modes = tableModesSchema.safeParse(await request.json().catch(() => ({})));
		if (!modes.success) {
			return Response.json(
				{ error: 'invalid table schema', issues: modes.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (existing && existing.kind !== 'table') {
			return Response.json({ error: `"${name}" is already a collection` }, { status: 409 });
		}
		if (!existing && !options.platform) {
			const denied = this.checkShardCap();
			if (denied) return denied;
		}

		if (existing) {
			const plan = planDdl(name, parseStoredColumns(existing.columns), modes.data.columns);
			if (!plan.ok) return Response.json({ error: plan.reason }, { status: 400 });
		}

		// A member can break its own pairing with a view - turning owner-scoped
		// or switching replication off would leave a view reading rows it must
		// not, or following a feed that no longer exists. Refuse the CHANGE
		// rather than silently breaking the view (the view re-checks at read
		// time too, since a config it holds always comes from the member's feed).
		const covering = await this.viewsCovering(name);
		if (covering.length) {
			const denied = viewMemberRefusal(
				name,
				modes.data.readAccess,
				modes.data.replication ?? this.shardReplication(existing ?? { replication: 'auto' }),
			);
			if (denied) {
				return Response.json(
					{
						error:
							`${denied} (member of view ` +
							`${covering.map((view) => `"${view.name}"`).join(', ')})`,
					},
					{ status: 409 },
				);
			}
		}

		const patch: Partial<typeof collections.$inferInsert> = {
			readAccess: modes.data.readAccess,
			writeAccess: modes.data.writeAccess,
			columns: JSON.stringify(modes.data.columns),
		};
		if (modes.data.readPermission !== undefined) patch.readPermission = modes.data.readPermission;
		if (modes.data.writePermission !== undefined) {
			patch.writePermission = modes.data.writePermission;
		}
		if (modes.data.replication !== undefined) {
			patch.replication = modes.data.replication;
		}

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				kind: 'table',
				readPermission: null,
				writePermission: null,
				validator: null,
				...patch,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({ target: collections.name, set: patch })
			.returning();

		try {
			await this.pushTableConfig(row);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (existing) {
				await this.db
					.update(collections)
					.set({
						readAccess: existing.readAccess,
						writeAccess: existing.writeAccess,
						readPermission: existing.readPermission,
						writePermission: existing.writePermission,
						columns: existing.columns,
					})
					.where(eq(collections.name, name));
			} else {
				await this.db.delete(collections).where(eq(collections.name, name));
			}
			return Response.json(
				{ error: `schema change failed: ${message.slice(0, 256)}` },
				{ status: 409 },
			);
		}

		this.writeDbEvent(existing ? 'table.configured' : 'table.created');
		this.recordEvent(
			existing ? 'table.configured' : 'table.created',
			existing
				? `table "${name}" reconfigured (${modes.data.columns.length} columns)`
				: `table "${name}" declared (${modes.data.columns.length} columns)`,
		);
		await this.syncCollectionsState();
		return Response.json({
			name,
			readAccess: row.readAccess,
			writeAccess: row.writeAccess,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			columns: parseStoredColumns(row.columns),
		});
	}

	/**
	 * `PUT /admin/views/:name` - declare a join view (JOIN1).
	 *
	 * Every constraint here is checked BEFORE the row is written, because a
	 * view that cannot legally exist must never be pushed to a child: the
	 * child would bootstrap from members it should not be reading.
	 */
	private async configureView(request: Request, name: string): Promise<Response> {
		if (!viewNameSchema.safeParse(name).success || RESERVED_SHARD_TABLES.has(name)) {
			return Response.json(
				{ error: 'view names are lowercase letters, digits, _ and - (max 64 chars)' },
				{ status: 400 },
			);
		}
		// A view is derived reporting state; a demo project is throwaway state
		// with a 200-row ceiling per table. Copying it for joins is pure cost.
		if (this.isEphemeral) {
			return Response.json({ error: 'demo projects have no views' }, { status: 403 });
		}
		const body = viewModesSchema.safeParse(await request.json().catch(() => ({})));
		if (!body.success) {
			return Response.json({ error: 'invalid view', issues: body.error.issues }, { status: 400 });
		}
		const members = body.data.members;
		if (new Set(members).size !== members.length) {
			return Response.json({ error: 'a table can only be listed once' }, { status: 400 });
		}
		if (members.includes(name)) {
			return Response.json({ error: 'a view cannot be its own member' }, { status: 400 });
		}

		const existing = await this.viewRow(name);
		if (!existing) {
			const [clash] = await this.db
				.select()
				.from(collections)
				.where(eq(collections.name, name))
				.limit(1);
			if (clash) {
				return Response.json({ error: `"${name}" is already a ${clash.kind}` }, { status: 409 });
			}
			const views = await this.db.select().from(collections).where(eq(collections.kind, 'view'));
			if (views.length >= MAX_VIEWS_PER_PROJECT) {
				return Response.json(
					{ error: `projects are capped at ${MAX_VIEWS_PER_PROJECT} views` },
					{ status: 429 },
				);
			}
		}

		for (const member of members) {
			const row = await this.tableRow(member);
			if (!row) {
				return Response.json({ error: `"${member}" is not a declared table` }, { status: 400 });
			}
			const denied = viewMemberRefusal(member, row.readAccess, this.shardReplication(row));
			if (denied) return Response.json({ error: denied }, { status: 400 });
		}

		const patch: Partial<typeof collections.$inferInsert> = {
			members: JSON.stringify(members),
		};
		if (body.data.readPermission !== undefined) patch.readPermission = body.data.readPermission;

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				kind: 'view',
				readAccess: 'auth',
				writeAccess: 'auth',
				readPermission: null,
				writePermission: null,
				validator: null,
				columns: null,
				replication: 'off',
				...patch,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({ target: collections.name, set: patch })
			.returning();

		await this.viewStub(name).configure(await this.buildViewConfig(row));
		this.writeDbEvent(existing ? 'view.configured' : 'view.created');
		this.recordEvent(
			existing ? 'view.configured' : 'view.created',
			`view "${name}" ${existing ? 'reconfigured' : 'created'} over ${members.join(', ')}`,
		);
		await this.syncCollectionsState();
		return Response.json(
			{ name, members, readPermission: row.readPermission },
			{
				status: existing ? 200 : 201,
			},
		);
	}

	private async deleteView(name: string): Promise<Response> {
		const row = await this.viewRow(name);
		if (!row) return Response.json({ error: 'no such view' }, { status: 404 });

		await this.destroyChild('view', name);
		await this.db.delete(collections).where(eq(collections.name, name));

		this.writeDbEvent('view.deleted');
		this.recordEvent('view.deleted', `view "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
	}

	/** `GET /admin/views/:name` - per-member follow state, the multi-source
	 * answer to the replica map. */
	private async adminViewStatus(name: string): Promise<Response> {
		const row = await this.viewRow(name);
		if (!row) return Response.json({ error: 'no such view' }, { status: 404 });
		const status = (await this.viewStub(name).viewStatus()) as unknown as ViewStatus;
		return Response.json(status);
	}

	private async deleteTable(name: string): Promise<Response> {
		const row = await this.tableRow(name);
		if (!row) return Response.json({ error: 'no such table' }, { status: 404 });
		// A view missing a member is not degraded, it is invalid - and leaving
		// one serving joins over a table the operator just deleted is the wrong
		// failure. Naming the view makes the fix obvious.
		const covering = await this.viewsCovering(name);
		if (covering.length) {
			return Response.json(
				{
					error:
						`"${name}" is a member of view ${covering.map((view) => `"${view.name}"`).join(', ')}` +
						` - delete the view first`,
				},
				{ status: 409 },
			);
		}

		// Child first, registry second - the collection erase discipline.
		await this.destroyChild('table', name);
		await this.db.delete(collections).where(eq(collections.name, name));
		// A deliberate erase must stay erased - drop its restore markers too.
		await this.db.delete(restorePoints).where(eq(restorePoints.collection, name));

		this.writeDbEvent('table.deleted');
		this.recordEvent('table.deleted', `table "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
	}

	/** The replica map: lag and last-seen per region, for either kind. */
	private async adminReplicationStatus(name: string): Promise<Response> {
		const routing = await this.getShardRouting(name);
		if (!routing) return Response.json({ error: 'no such collection or table' }, { status: 404 });
		const status =
			routing.kind === 'table'
				? await this.tableStub(name).repStatus()
				: await this.childStub(name).repStatus();
		return Response.json(status);
	}

	private async adminTableRowWrite(
		request: Request,
		name: string,
		rowId: string,
	): Promise<Response> {
		if (!(await this.tableRow(name))) {
			return Response.json({ error: 'no such table' }, { status: 404 });
		}
		const child = this.tableStub(name);

		if (request.method === 'PUT') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid row body' }, { status: 400 });
			}
			const ifAbsent = new URL(request.url).searchParams.get('ifAbsent') === '1';
			let result: Awaited<ReturnType<DbTable['adminPut']>>;
			try {
				result = (await child.adminPut(rowId, data.data, ifAbsent)) as unknown as Awaited<
					ReturnType<DbTable['adminPut']>
				>;
			} catch (error) {
				const column = uniqueViolationColumn(error);
				if (!column) throw error;
				return Response.json(
					{ error: `a row with that ${column} already exists (unique column)` },
					{ status: 409 },
				);
			}
			if (typeof result === 'object' && result !== null && 'conflict' in result) {
				return Response.json({ error: 'a row with that id already exists' }, { status: 409 });
			}
			if (typeof result === 'object' && result !== null && 'invalid' in result) {
				return Response.json(
					{ error: 'row failed validation', issues: result.invalid },
					{ status: 400 },
				);
			}
			return Response.json(result);
		}
		// The collection twin's GET/PATCH, so both kinds read and merge through
		// the same idiom. Tables could already do
		// this via /admin/tables/:name/sql; raw SQL is not an API for a
		// single-row read.
		if (request.method === 'GET') {
			const found = (await child.adminGet(rowId)) as unknown as Awaited<
				ReturnType<DbTable['adminGet']>
			>;
			if (!found) return Response.json({ error: 'no such row' }, { status: 404 });
			return Response.json(found);
		}
		if (request.method === 'PATCH') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid row body' }, { status: 400 });
			}
			let merged: Awaited<ReturnType<DbTable['adminPatch']>>;
			try {
				merged = (await child.adminPatch(rowId, data.data)) as unknown as Awaited<
					ReturnType<DbTable['adminPatch']>
				>;
			} catch (error) {
				const column = uniqueViolationColumn(error);
				if (!column) throw error;
				return Response.json(
					{ error: `a row with that ${column} already exists (unique column)` },
					{ status: 409 },
				);
			}
			if (!merged) return Response.json({ error: 'no such row' }, { status: 404 });
			if (typeof merged === 'object' && 'invalid' in merged) {
				return Response.json(
					{ error: 'row failed validation', issues: merged.invalid },
					{ status: 400 },
				);
			}
			return Response.json(merged);
		}
		if (request.method === 'DELETE') {
			const deleted = await child.adminDelete(rowId);
			if (!deleted) return Response.json({ error: 'no such row' }, { status: 404 });
			return Response.json({ deleted: true });
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async updateSettings(request: Request): Promise<Response> {
		const parsed = settingsRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid settings', issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		this.setState({ ...this.state, allowedOrigins: parsed.data.allowedOrigins });

		// Re-push every child - both kinds - so cached CORS lists update.
		// Retry once; a child that still fails heals on its next lazy pull.
		const rows = await this.db.select().from(collections);
		for (const row of rows) {
			const push =
				row.kind === 'table' ? () => this.pushTableConfig(row) : () => this.pushConfig(row);
			try {
				await push();
			} catch {
				try {
					await push();
				} catch {
					// seconds-level staleness accepted; documented risk
				}
			}
		}
		return Response.json({ allowedOrigins: parsed.data.allowedOrigins });
	}

	// -------------------------------------------------------------------------
	// Children, config push, state sync

	private childStub(name: string) {
		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace<DbCollection>;
		return namespace.get(namespace.idFromName(`${this.name}:${name}`));
	}

	private tableStub(name: string) {
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace<DbTable>;
		return namespace.get(namespace.idFromName(`${this.name}:${name}`));
	}

	private viewStub(name: string) {
		const namespace = this.env.DbView as unknown as DurableObjectNamespace<DbView>;
		return namespace.get(namespace.idFromName(viewInstanceName(this.name, name, VIEW_REGION, 1)));
	}

	private async viewRow(name: string) {
		const [row] = await this.db
			.select()
			.from(collections)
			.where(and(eq(collections.name, name), eq(collections.kind, 'view')))
			.limit(1);
		return row ?? null;
	}

	/** Every view that lists `table` as a member. Membership lives on the
	 * registry, so this is the parent's alone to answer - which is exactly why
	 * the parent, not a member primary, owns a view's lifecycle. */
	private async viewsCovering(table: string) {
		const rows = await this.db.select().from(collections).where(eq(collections.kind, 'view'));
		return rows.filter((row) => parseStoredMembers(row.members).includes(table));
	}

	private async buildViewConfig(row: typeof collections.$inferSelect): Promise<ViewConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			kind: 'view',
			projectId: this.name,
			view: row.name,
			members: parseStoredMembers(row.members),
			readPermission: row.readPermission,
			allowedOrigins: this.state.allowedOrigins,
			demo: this.isEphemeral,
			configVersion: version,
		};
	}

	/**
	 * Destroy one child of either kind, tolerating the abort-vs-reply race:
	 * an abort-reset error is verified against a fresh instance instead of
	 * failing the operation - zero documents/rows means the wipe landed. A
	 * genuine failure rethrows, and the registry row survives so the operator
	 * can retry; nothing may orphan a Durable Object holding data.
	 */
	private async destroyChild(kind: 'collection' | 'table' | 'view', name: string): Promise<void> {
		// A view holds only DERIVED copies, so there is nothing to verify after
		// an abort-reset: the members still hold the authoritative rows, and a
		// half-erased view is re-bootstrapped from scratch by the next one.
		if (kind === 'view') {
			try {
				await this.viewStub(name).destroy();
			} catch (error) {
				if (!isDurableObjectReset(error)) throw error;
			}
			return;
		}
		try {
			if (kind === 'table') await this.tableStub(name).destroy();
			else await this.childStub(name).destroy();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			const remaining =
				kind === 'table'
					? await this.tableStub(name).getRowCount()
					: await this.childStub(name).getDocCount();
			if (remaining > 0) throw error;
		}
	}

	private async buildConfig(row: typeof collections.$inferSelect): Promise<CollectionConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			projectId: this.name,
			collection: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			validator: parseStoredValidator(row.validator),
			allowedOrigins: this.state.allowedOrigins,
			demo: this.isEphemeral,
			configVersion: version,
			replication: this.shardReplication(row),
			repEpoch: row.repEpoch,
		};
	}

	private async pushConfig(row: typeof collections.$inferSelect): Promise<void> {
		const child = this.childStub(row.name);
		await child.configure(await this.buildConfig(row));
	}

	private async buildTableConfig(row: typeof collections.$inferSelect): Promise<TableConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			kind: 'table',
			projectId: this.name,
			table: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			columns: parseStoredColumns(row.columns),
			allowedOrigins: this.state.allowedOrigins,
			demo: this.isEphemeral,
			configVersion: version,
			replication: this.shardReplication(row),
			repEpoch: row.repEpoch,
		};
	}

	private async pushTableConfig(row: typeof collections.$inferSelect): Promise<void> {
		await this.tableStub(row.name).configure(await this.buildTableConfig(row));
	}

	/** ONE pool across kinds: a project holds at most MAX_COLLECTIONS shards
	 * (collections + tables together), DEMO_MAX_COLLECTIONS in demos. */
	private checkShardCap(): Response | null {
		const cap = this.isEphemeral ? DEMO_MAX_COLLECTIONS : MAX_COLLECTIONS;
		const total = this.state.collections.length + (this.state.tables ?? []).length;
		if (total >= cap) {
			return Response.json(
				{
					error: this.isEphemeral
						? `demo projects are capped at ${DEMO_MAX_COLLECTIONS} collections and tables`
						: `projects are capped at ${MAX_COLLECTIONS} collections and tables`,
				},
				{ status: 429 },
			);
		}
		return null;
	}

	private async syncCollectionsState(): Promise<void> {
		const rows = await this.db.select().from(collections).orderBy(asc(collections.name));
		const summaries: DbCollectionSummary[] = rows
			.filter((row) => row.kind === 'collection')
			.map((row) => ({
				name: row.name,
				readAccess: row.readAccess as AccessMode,
				writeAccess: row.writeAccess as AccessMode,
				readPermission: row.readPermission,
				writePermission: row.writePermission,
				validator: parseStoredValidator(row.validator),
				replication: this.shardReplication(row),
				docs: row.docs,
			}));
		const tables: DbTableSummary[] = rows
			.filter((row) => row.kind === 'table')
			.map((row) => ({
				name: row.name,
				readAccess: row.readAccess as AccessMode,
				writeAccess: row.writeAccess as AccessMode,
				readPermission: row.readPermission,
				writePermission: row.writePermission,
				columns: parseStoredColumns(row.columns),
				replication: this.shardReplication(row),
				rows: row.docs,
			}));
		const views: DbViewSummary[] = rows
			.filter((row) => row.kind === 'view')
			.map((row) => ({
				name: row.name,
				members: parseStoredMembers(row.members),
				readPermission: row.readPermission,
			}));
		this.setState({
			...this.state,
			collections: summaries,
			tables,
			views,
			totalDocs: summaries.reduce((sum, entry) => sum + entry.docs, 0),
			totalRows: tables.reduce((sum, entry) => sum + entry.rows, 0),
			rev: this.state.rev + 1,
		});
	}

	private recordEvent(type: DbActivityEvent['type'], message: string): void {
		const at = new Date().toISOString();
		const event: DbActivityEvent = { id: crypto.randomUUID(), type, message, at };
		this.setState({
			...this.state,
			events: [event, ...this.state.events].slice(0, MAX_EVENTS),
			totalEvents: this.state.totalEvents + 1,
			lastEventAt: at,
		});
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [this.name],
				// Schema: event, collection, country, subject, reserved.
				blobs: [eventType, 'none', 'unknown', 'none', 'none'],
				doubles: [1],
			});
		} catch {
			// never let metrics break the operation
		}
		if (this.env.LOCAL_ANALYTICS) {
			this.ctx.waitUntil(
				this.env.LOCAL_ANALYTICS.prepare(
					`INSERT INTO db_events (project_id, event_type, collection, timestamp) VALUES (?, ?, ?, ?)`,
				)
					.bind(this.name, eventType, 'none', Date.now())
					.run()
					.then(() => undefined)
					.catch(() => undefined),
			);
		}
	}
}
