import { logEntrySchema, MAX_LOG_ROWS, REPLICATION_PULL_CHUNK, type LogEntry } from './schemas.js';

/**
 * The replication substrate's shared plumbing:
 * role parsing from instance names, change-log append/read/prune on the
 * primary, and applied-position bookkeeping helpers for replicas. The feed
 * itself (bootstrap/pullSince RPCs) lives on the shard classes; everything
 * here is deliberately small and transport-shaped so a native platform
 * replication feature could replace the transport without touching callers.
 *
 * Raw `ctx.storage.sql` throughout rather than drizzle: log writes must land
 * in the SAME event-loop task as the data mutation they describe (DO write
 * coalescing is what makes data+log atomic - no await may separate them),
 * and the apply path runs against dynamic physical tables drizzle cannot
 * model anyway.
 */

export interface PrimaryRole {
	kind: 'primary';
}

export interface ReplicaRole {
	kind: 'replica';
	region: string;
	n: number;
	/** The primary's instance name: this one minus the `:r:` suffix. */
	primaryName: string;
	/** The registered id: `r:<region>:<n>`. */
	replicaId: string;
}

export type ShardRole = PrimaryRole | ReplicaRole;

const REPLICA_SUFFIX = /^(.+):r:([a-z-]+):(\d+)$/;

/**
 * Role from the Durable Object instance name. Project and shard names cannot
 * contain `:`, so the `:r:` suffix is unambiguous; anything else (including
 * a missing name on preview stubs) is the primary role.
 */
export function parseShardRole(instanceName: string | undefined): ShardRole {
	const match = instanceName ? REPLICA_SUFFIX.exec(instanceName) : null;
	if (!match) return { kind: 'primary' };
	return {
		kind: 'replica',
		region: match[2],
		n: Number(match[3]),
		primaryName: match[1],
		replicaId: `r:${match[2]}:${match[3]}`,
	};
}

export function replicaName(primaryName: string, region: string, n: number): string {
	return `${primaryName}:r:${region}:${n}`;
}

// ---------------------------------------------------------------------------
// Primary side: the change log

/**
 * Append one entry in the SAME task as the data write it describes. Returns
 * the new LSN (the write's session bookmark). Opportunistically prunes the
 * horizon - a replica older than the horizon is FORCED to re-bootstrap by
 * pullSince, so pruning can never create a silent gap.
 */
export function appendLog(
	sql: SqlStorage,
	op: 'put' | 'del' | 'cfg',
	id: string,
	image: string | null,
): number {
	sql.exec(
		`INSERT INTO changelog (op, id, image, ts) VALUES (?, ?, ?, ?)`,
		op,
		id,
		image,
		Date.now(),
	);
	const [row] = sql.exec(`SELECT last_insert_rowid() AS lsn`).toArray() as { lsn: number }[];
	const lsn = row?.lsn ?? 0;
	// Amortized prune: one DELETE every 512 appends keeps the log bounded
	// without paying a delete per write.
	if (lsn % 512 === 0) {
		sql.exec(`DELETE FROM changelog WHERE lsn < ?`, lsn - MAX_LOG_ROWS);
	}
	return lsn;
}

/** Current log position (0 when the log is empty or replication is off). */
export function lastLsn(sql: SqlStorage): number {
	const [row] = sql.exec(`SELECT MAX(lsn) AS lsn FROM changelog`).toArray() as {
		lsn: number | null;
	}[];
	return row?.lsn ?? 0;
}

/** Oldest retained LSN, or 0 for an empty log. */
export function horizonLsn(sql: SqlStorage): number {
	const [row] = sql.exec(`SELECT MIN(lsn) AS lsn FROM changelog`).toArray() as {
		lsn: number | null;
	}[];
	return row?.lsn ?? 0;
}

/** A bounded page of entries strictly after `since`, oldest first. */
export function readLogSince(sql: SqlStorage, since: number): LogEntry[] {
	const rows = sql
		.exec(
			`SELECT lsn, op, id, image, ts FROM changelog WHERE lsn > ? ORDER BY lsn ASC LIMIT ?`,
			since,
			REPLICATION_PULL_CHUNK,
		)
		.toArray();
	return rows.map((row) => logEntrySchema.parse(row));
}

/**
 * Whether `since` is still serviceable from the log. Retained rows cover
 * [horizon, last]; a replica at `since` needs (since, last], so it must sit
 * at or past `horizon - 1`. Two forced-resync cases fall out naturally:
 *
 * - `since > last`: the primary's log is BEHIND the replica - a PITR restore
 *   rewound it (the log rewinds with the rest of storage). This is the
 *   restore detector that works even before the parent's epoch bump lands.
 * - empty log with `since > 0`: the log was truncated (disable/re-enable);
 *   continuity cannot be verified.
 */
export function canServeSince(sql: SqlStorage, since: number): boolean {
	const last = lastLsn(sql);
	if (since > last) return false;
	if (since === last) return true;
	return since >= horizonLsn(sql) - 1;
}

export function truncateLog(sql: SqlStorage): void {
	sql.exec(`DELETE FROM changelog`);
}

// ---------------------------------------------------------------------------
// Primary side: the feed server (shared verbatim by both shard classes)

export interface RepPullInput {
	since: number;
	replicaId: string;
	region: string;
}

/**
 * Durable registration - MUST happen before any data leaves the primary
 * (bootstrap included): the erase fan-out iterates this registry.
 *
 * JOIN VIEWS ARE NOT REGISTERED (`v:<view>:<region>:<n>`, JOIN1). They follow
 * the same feed, but they are not replicas OF this shard, and one guard here
 * keeps every consumer of the table honest at once:
 *
 * - `destroyReplicaInstances` resolves each row as `<shardName>:<id>` in the
 *   SHARD's own namespace. For a view that names a different Durable Object
 *   entirely, so the primary would destroy an empty stranger while the real
 *   view survived - the worst possible outcome for an erase.
 * - the replica map would render a view as a region replica of this table.
 * - `regionSocketCounts` would fold it into the sibling-spawn arithmetic.
 *
 * A view's lifecycle belongs to the PARENT instead, which is the only party
 * that knows a view's whole membership: it destroys views before their
 * members, and refuses to drop a member a view still covers.
 */
export function registerReplica(
	sql: SqlStorage,
	replicaId: string,
	region: string,
	appliedLsn: number,
): void {
	if (!replicaId.startsWith('r:')) return;
	sql.exec(
		`INSERT INTO replicas (id, region, applied_lsn, last_seen_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET applied_lsn = excluded.applied_lsn, last_seen_at = excluded.last_seen_at`,
		replicaId,
		region,
		appliedLsn,
		Date.now(),
	);
}

/**
 * Serve one pull. The replica is registered DURABLY before any data leaves -
 * the erase fan-out iterates that registry, so a replica holding data can
 * never be unknown to its primary. DO storage writes coalesce with the read
 * in this same task, and single-threaded execution means the registration
 * commits before any other request observes the table.
 */
export function serveRepPull(
	sql: SqlStorage,
	input: RepPullInput,
	epoch: number,
): import('./schemas.js').RepPullResult {
	registerReplica(sql, input.replicaId, input.region, input.since);

	if (!canServeSince(sql, input.since)) return { resync: true, epoch };

	const entries = readLogSince(sql, input.since);
	const applied = entries.length ? entries[entries.length - 1].lsn : input.since;
	sql.exec(`UPDATE replicas SET applied_lsn = ? WHERE id = ?`, applied, input.replicaId);
	return { resync: false, entries, lastLsn: lastLsn(sql), epoch };
}

export interface RegisteredReplica {
	id: string;
	region: string;
	appliedLsn: number;
	/** True while the replica holds subscribers and receives live pushes. */
	push: boolean;
	/** Last reported hibernatable-socket count (sibling-spawn signal). */
	sockets: number;
	lastSeenAt: number;
}

export function listReplicas(sql: SqlStorage): RegisteredReplica[] {
	return (
		sql
			.exec(`SELECT id, region, applied_lsn, push, sockets, last_seen_at FROM replicas ORDER BY id`)
			.toArray() as {
			id: string;
			region: string;
			applied_lsn: number;
			push: number;
			sockets: number;
			last_seen_at: number;
		}[]
	).map((row) => ({
		id: row.id,
		region: row.region,
		appliedLsn: row.applied_lsn,
		push: row.push === 1,
		sockets: row.sockets,
		lastSeenAt: row.last_seen_at,
	}));
}

export function clearReplicas(sql: SqlStorage): void {
	sql.exec(`DELETE FROM replicas`);
}

/** Update a replica's push flag and/or socket count (registers it if somehow
 * unknown). Omitted fields stay as they are - a sockets-only report must not
 * clobber the push flag, and vice versa. */
export function setReplicaPush(
	sql: SqlStorage,
	replicaId: string,
	region: string,
	update: { push?: boolean; sockets?: number },
): void {
	sql.exec(
		`INSERT INTO replicas (id, region, applied_lsn, push, sockets, last_seen_at) VALUES (?, ?, 0, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			push = CASE WHEN ? THEN excluded.push ELSE push END,
			sockets = CASE WHEN ? THEN excluded.sockets ELSE sockets END,
			last_seen_at = excluded.last_seen_at`,
		replicaId,
		region,
		update.push ? 1 : 0,
		update.sockets ?? 0,
		Date.now(),
		update.push !== undefined ? 1 : 0,
		update.sockets !== undefined ? 1 : 0,
	);
}

/** Replicas that asked for live pushes (they hold subscribers). */
export function listPushReplicas(sql: SqlStorage): RegisteredReplica[] {
	return (
		sql
			.exec(
				`SELECT id, region, applied_lsn, sockets, last_seen_at FROM replicas WHERE push = 1 ORDER BY id`,
			)
			.toArray() as {
			id: string;
			region: string;
			applied_lsn: number;
			sockets: number;
			last_seen_at: number;
		}[]
	).map((row) => ({
		id: row.id,
		region: row.region,
		appliedLsn: row.applied_lsn,
		push: true,
		sockets: row.sockets,
		lastSeenAt: row.last_seen_at,
	}));
}

// ---------------------------------------------------------------------------
// Sibling spawn (socket-pressure scale-out within a region)

/** Reported socket counts per sibling, indexed n-1 (holes = never seen). */
export function regionSocketCounts(sql: SqlStorage, region: string): number[] {
	const rows = sql.exec(`SELECT id, sockets FROM replicas WHERE region = ?`, region).toArray() as {
		id: string;
		sockets: number;
	}[];
	const counts: number[] = [];
	for (const row of rows) {
		const n = Number(row.id.split(':')[2]);
		if (Number.isInteger(n) && n >= 1) counts[n - 1] = row.sockets;
	}
	return counts;
}

/**
 * Which sibling a NEW subscriber should land on: the lowest n with headroom
 * (an unregistered n counts as 0 sockets - picking it IS the spawn; the
 * subscriber's arrival bootstraps it), else the least-loaded. Deterministic
 * and memoryless on purpose: thousands of isolates cannot coordinate a
 * round-robin, and fill-lowest reuses drained siblings before spawning new
 * ones. An overfull answer still WORKS (the replica never refuses on count),
 * so staleness is a latency wobble, never a correctness bug.
 */
export function pickSubscribeSibling(
	counts: number[],
	spawnAt: number,
	maxSiblings: number,
): number {
	let least = 1;
	for (let n = 1; n <= maxSiblings; n += 1) {
		const load = counts[n - 1] ?? 0;
		if (load < spawnAt) return n;
		if (load < (counts[least - 1] ?? 0)) least = n;
	}
	return least;
}

// ---------------------------------------------------------------------------
// Replica side: applied-position bookkeeping

export interface ReplicaMeta {
	epoch: number;
	appliedLsn: number;
	pulledAt: number;
}

// ---------------------------------------------------------------------------
// Join views (JOIN1): names, and the per-source position vector

/** `<pid>:v:<view>:<region>:<n>` - the view instance's Durable Object name.
 * `:` cannot appear in a project or shard name, so the `:v:` infix is as
 * unambiguous as `:r:` is for replicas. */
export function viewInstanceName(
	projectId: string,
	view: string,
	region: string,
	n: number,
): string {
	return `${projectId}:v:${view}:${region}:${n}`;
}

export interface ViewRole {
	projectId: string;
	view: string;
	region: string;
	n: number;
	/** What the view calls itself on every member's feed. ONE id for all
	 * members: it identifies the follower, not the thing followed. */
	followerId: string;
}

const VIEW_SUFFIX = /^(.+):v:([a-z][a-z0-9_-]{0,63}):([a-z-]+):(\d+)$/;

/** The view's identity from its instance name, or null for a malformed one
 * (a bare stub with no name included) - a DbView cannot serve without it.
 * The project id comes from the NAME rather than from pushed config, so a
 * view can resolve its members before the parent has ever reached it. */
export function parseViewRole(instanceName: string | undefined): ViewRole | null {
	const match = instanceName ? VIEW_SUFFIX.exec(instanceName) : null;
	if (!match) return null;
	return {
		projectId: match[1],
		view: match[2],
		region: match[3],
		n: Number(match[4]),
		followerId: `v:${match[2]}:${match[3]}:${match[4]}`,
	};
}

export interface ViewSourceRow {
	table: string;
	epoch: number;
	appliedLsn: number;
	/** 0 = registered but never bootstrapped. */
	pulledAt: number;
	config: string | null;
}

export function readViewSources(sql: SqlStorage): ViewSourceRow[] {
	return sql
		.exec(
			`SELECT "table", epoch, applied_lsn, pulled_at, config FROM view_sources ORDER BY "table"`,
		)
		.toArray()
		.map((row) => ({
			table: row.table as string,
			epoch: row.epoch as number,
			appliedLsn: row.applied_lsn as number,
			pulledAt: row.pulled_at as number,
			config: (row.config ?? null) as string | null,
		}));
}

export function readViewSource(sql: SqlStorage, table: string): ViewSourceRow | null {
	const [row] = sql
		.exec(
			`SELECT "table", epoch, applied_lsn, pulled_at, config FROM view_sources WHERE "table" = ?`,
			table,
		)
		.toArray() as {
		table: string;
		epoch: number;
		applied_lsn: number;
		pulled_at: number;
		config: string | null;
	}[];
	return row
		? {
				table: row.table,
				epoch: row.epoch,
				appliedLsn: row.applied_lsn,
				pulledAt: row.pulled_at,
				config: row.config ?? null,
			}
		: null;
}

export function writeViewSource(sql: SqlStorage, row: ViewSourceRow): void {
	sql.exec(
		`INSERT INTO view_sources ("table", epoch, applied_lsn, pulled_at, config)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT("table") DO UPDATE SET epoch = excluded.epoch,
		   applied_lsn = excluded.applied_lsn, pulled_at = excluded.pulled_at,
		   config = excluded.config`,
		row.table,
		row.epoch,
		row.appliedLsn,
		row.pulledAt,
		row.config,
	);
}

/** Drop sources no longer in the member list (a view was reconfigured). The
 * COPIES they left behind are dropped by the caller, which knows the physical
 * table names - orphaned rows here would otherwise keep being pulled. */
export function pruneViewSources(sql: SqlStorage, keep: string[]): string[] {
	const dropped = readViewSources(sql)
		.map((row) => row.table)
		.filter((table) => !keep.includes(table));
	for (const table of dropped) sql.exec(`DELETE FROM view_sources WHERE "table" = ?`, table);
	return dropped;
}

export function readReplicaMeta(sql: SqlStorage): ReplicaMeta | null {
	const [row] = sql
		.exec(`SELECT epoch, applied_lsn, pulled_at FROM replica_meta WHERE id = 1`)
		.toArray() as { epoch: number; applied_lsn: number; pulled_at: number }[];
	return row ? { epoch: row.epoch, appliedLsn: row.applied_lsn, pulledAt: row.pulled_at } : null;
}

export function writeReplicaMeta(sql: SqlStorage, meta: ReplicaMeta): void {
	sql.exec(
		`INSERT INTO replica_meta (id, epoch, applied_lsn, pulled_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, applied_lsn = excluded.applied_lsn, pulled_at = excluded.pulled_at`,
		meta.epoch,
		meta.appliedLsn,
		meta.pulledAt,
	);
}
