import { DurableObject } from 'cloudflare:workers';
import { getAgentByName, type AgentNamespace } from 'agents';
import { count, eq, and } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from './migrations';
import * as schema from './db/schema';
import { gatewaySubs } from './db/schema';
import { corsHeadersFor, drainUnusedBody } from './access';
import { replicaName } from './replication';
import {
	gatewayClientFrameSchema,
	serverFrameSchema,
	socketReportStep,
	DEMO_GATEWAY_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	DEMO_PROJECT_PATTERN,
	GATEWAY_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	SIBLING_SPAWN_SOCKETS,
	type RemoteSubscribeResult,
	type ServerFrame,
	type ShardAddress,
} from './schemas';
import type { DbAgent } from './agent';
import type { DbCollection } from './collection';
import type { DbTable } from './table';

/**
 * One client WebSocket for the whole database: N live queries across any mix
 * of collections and tables, multiplexed over a single socket - Firestore's
 * single streaming channel, per project.
 *
 * The gateway is deliberately DUMB. It holds zero data and zero query state:
 * on `subscribe` it registers the subscription AT the shard
 * (`remoteSubscribe` - the shard re-verifies the token and runs its normal
 * live engine), and on every write the shard delivers resolved frames back
 * by RPC (`gatewayDeliver`), which wakes a hibernated gateway - the
 * primary->replica push pattern one level up. Never an outgoing socket: the
 * REP2 lesson is that one dies with hibernation exactly when delivery must
 * happen. The only durable state is `gateway_subs` (connId/subId -> shard
 * instance), enough for a woken instance to clean up shard rows on close.
 *
 * Instance name: `<projectId>:gw:<region>:<n>` - created with the
 * subscriber's region as the locationHint, so the socket terminates near the
 * client and only the shard->gateway RPC crosses regions. `<n>` grows under
 * socket pressure via the parent's `gatewaySubscribeTarget` (the replica
 * sibling-spawn mechanism verbatim).
 */

const GATEWAY_NAME = /^([^:]+):gw:([a-z-]+):(\d+)$/;
/** Shard-routing and origin config staleness ceiling (worker parity). */
const ROUTING_TTL_MS = 60_000;

export function gatewayName(projectId: string, region: string, n: number): string {
	return `${projectId}:gw:${region}:${n}`;
}

interface ShardRoutingEntry {
	kind: 'collection' | 'table' | null;
	auto: boolean;
	expires: number;
}

export class DbGateway extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;
	private readonly projectId: string;
	private readonly region: string;
	/** The registered id: `gw:<region>:<n>`. */
	private readonly gatewayId: string;
	/** Isolate-local shard routing (kind + replication flag); staleness is a
	 * latency wobble only - replicas forward, primaries always serve. */
	private routing = new Map<string, ShardRoutingEntry>();
	private origins: { allowed: string[]; expires: number } | null = null;
	/** In-memory on purpose: hibernation resets it and the next accepted
	 * socket re-reports - self-healing, like the replica twin. */
	private lastReportedSockets: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
		const match = GATEWAY_NAME.exec(ctx.id.name ?? '');
		this.projectId = match?.[1] ?? '';
		this.region = match?.[2] ?? 'enam';
		this.gatewayId = match ? `gw:${match[2]}:${match[3]}` : 'gw:enam:1';
	}

	// -------------------------------------------------------------------------
	// Socket lifecycle

	async fetch(request: Request): Promise<Response> {
		const response = await this.accept(request);
		await drainUnusedBody(request);
		return response;
	}

	private async accept(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return Response.json({ error: 'expected a WebSocket upgrade' }, { status: 426 });
		}
		// Same origin discipline as a direct shard socket, against the
		// project-wide allowlist (per-shard origin lists do not exist; shard
		// AUTHORIZATION happens per subscription at the shard).
		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, await this.allowedOrigins());
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		const pair = new WebSocketPair();
		const connId = crypto.randomUUID();
		this.ctx.acceptWebSocket(pair[1], [connId]);
		pair[1].serializeAttachment({ connId });
		this.ctx.waitUntil(this.reportSockets());

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const connId = this.connIdOf(ws);
		if (!connId) return;

		let frame;
		try {
			frame = gatewayClientFrameSchema.parse(JSON.parse(typeof raw === 'string' ? raw : ''));
		} catch {
			this.send(ws, {
				type: 'error',
				code: 'invalid-frame',
				message: 'frames are JSON subscribe (with a shard address) / unsubscribe messages',
			});
			return;
		}

		if (frame.type === 'unsubscribe') {
			await this.handleUnsubscribe(ws, connId, frame.id);
			return;
		}
		await this.handleSubscribe(ws, connId, frame.id, frame.shard, frame.query, frame.token);
	}

	private async handleSubscribe(
		ws: WebSocket,
		connId: string,
		subId: string,
		shard: ShardAddress,
		query: unknown,
		token: string | undefined,
	): Promise<void> {
		const cap = (await this.isDemoProject())
			? DEMO_GATEWAY_MAX_SUBSCRIPTIONS_PER_CONNECTION
			: GATEWAY_MAX_SUBSCRIPTIONS_PER_CONNECTION;
		const [held] = await this.db
			.select({ value: count() })
			.from(gatewaySubs)
			.where(eq(gatewaySubs.connId, connId));
		if ((held?.value ?? 0) >= cap) {
			this.send(ws, {
				type: 'error',
				id: subId,
				code: 'subscription-limit',
				message: `a connection is limited to ${cap} subscriptions`,
			});
			return;
		}

		const routing = await this.shardRouting(shard.name);
		if (routing.kind && routing.kind !== shard.kind) {
			this.send(ws, {
				type: 'error',
				id: subId,
				code: 'shard-unavailable',
				message: `"${shard.name}" is a ${routing.kind}, not a ${shard.kind}`,
			});
			return;
		}

		// Reusing a subId for a DIFFERENT shard replaces the subscription; the
		// old shard's row must not keep delivering.
		const [previous] = await this.db
			.select()
			.from(gatewaySubs)
			.where(and(eq(gatewaySubs.connId, connId), eq(gatewaySubs.subId, subId)))
			.limit(1);
		if (previous && (previous.shardKind !== shard.kind || previous.shardName !== shard.name)) {
			await this.remoteUnsubscribe(
				previous.shardKind as ShardAddress['kind'],
				previous.instance,
				connId,
				subId,
			);
		}

		const primary = `${this.projectId}:${shard.name}`;
		// Subscribers land on their region replica when replication is on -
		// the same routing the worker does for direct sockets. Stale routing
		// is safe: a replica that cannot serve answers { forward } and the
		// subscription lands on the primary instead.
		const target = routing.auto ? replicaName(primary, this.region, 1) : primary;

		let result: RemoteSubscribeResult;
		let instance = target;
		try {
			result = await this.remoteSubscribe(shard.kind, target, connId, subId, query, token);
			if ('forward' in result) {
				instance = primary;
				result = await this.remoteSubscribe(shard.kind, primary, connId, subId, query, token);
			}
		} catch {
			this.send(ws, {
				type: 'error',
				id: subId,
				code: 'shard-unavailable',
				message: 'the shard could not be reached - retry the subscription',
			});
			return;
		}
		if ('forward' in result) {
			// A primary never answers forward; defensive against a stale replica.
			this.send(ws, {
				type: 'error',
				id: subId,
				code: 'shard-unavailable',
				message: 'the shard could not serve the subscription - retry',
			});
			return;
		}
		if (!result.ok) {
			this.send(ws, { type: 'error', id: subId, code: result.code, message: result.message });
			return;
		}

		await this.db
			.insert(gatewaySubs)
			.values({
				connId,
				subId,
				shardKind: shard.kind,
				shardName: shard.name,
				instance,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [gatewaySubs.connId, gatewaySubs.subId],
				set: { shardKind: shard.kind, shardName: shard.name, instance },
			});
		this.send(ws, { type: 'snapshot', id: subId, docs: result.docs });
	}

	private async handleUnsubscribe(ws: WebSocket, connId: string, subId: string): Promise<void> {
		const [row] = await this.db
			.select()
			.from(gatewaySubs)
			.where(and(eq(gatewaySubs.connId, connId), eq(gatewaySubs.subId, subId)))
			.limit(1);
		if (row) {
			await this.db
				.delete(gatewaySubs)
				.where(and(eq(gatewaySubs.connId, connId), eq(gatewaySubs.subId, subId)));
			await this.remoteUnsubscribe(
				row.shardKind as ShardAddress['kind'],
				row.instance,
				connId,
				subId,
			);
		}
		this.send(ws, { type: 'unsubscribed', id: subId });
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	private async dropConnection(ws: WebSocket): Promise<void> {
		const connId = this.connIdOf(ws);
		if (connId) await this.cleanupConnection(connId);
		await this.reportSockets();
	}

	/** Tell every shard this connection subscribed on to drop its rows, then
	 * forget the connection. Best-effort per shard - a shard that cannot be
	 * reached heals through `{stop}` on its next delivery attempt. */
	private async cleanupConnection(connId: string): Promise<void> {
		const rows = await this.db.select().from(gatewaySubs).where(eq(gatewaySubs.connId, connId));
		const instances = new Map<string, ShardAddress['kind']>();
		for (const row of rows) {
			instances.set(row.instance, row.shardKind as ShardAddress['kind']);
		}
		for (const [instance, kind] of instances) {
			await this.remoteUnsubscribe(kind, instance, connId);
		}
		await this.db.delete(gatewaySubs).where(eq(gatewaySubs.connId, connId));
	}

	// -------------------------------------------------------------------------
	// Delivery (the shard calls this on every matching write)

	/** Forward resolved frames to the client socket. `{stop}` tells the shard
	 * the connection is gone so it prunes its rows - the push-flag healing
	 * pattern. A token-expired error also drops the local row: the shard
	 * already dropped its own. */
	async gatewayDeliver(connId: string, frames: unknown): Promise<{ ok: true } | { stop: true }> {
		const parsed = z.array(serverFrameSchema).max(200).parse(frames);
		const sockets = this.ctx.getWebSockets(connId);
		if (!sockets.length) {
			await this.db.delete(gatewaySubs).where(eq(gatewaySubs.connId, connId));
			return { stop: true };
		}
		for (const frame of parsed) {
			this.send(sockets[0], frame);
			if (frame.type === 'error' && frame.code === 'token-expired' && frame.id) {
				await this.db
					.delete(gatewaySubs)
					.where(and(eq(gatewaySubs.connId, connId), eq(gatewaySubs.subId, frame.id)));
			}
		}
		return { ok: true };
	}

	/** Erase (project delete / disable): close every socket, drop the routing
	 * rows, and reset - the shard-side rows heal via `{stop}` answers. */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1001, 'gateway erased');
			} catch {
				// closing a half-dead socket must not block the erase
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// Shard RPC plumbing

	private shardNamespace(kind: ShardAddress['kind']) {
		return (kind === 'table'
			? this.env.DbTable
			: this.env.DbCollection) as unknown as DurableObjectNamespace;
	}

	private async remoteSubscribe(
		kind: ShardAddress['kind'],
		instance: string,
		connId: string,
		subId: string,
		query: unknown,
		token: string | undefined,
	): Promise<RemoteSubscribeResult> {
		const namespace = this.shardNamespace(kind) as unknown as DurableObjectNamespace<
			DbCollection | DbTable
		>;
		const stub = namespace.get(namespace.idFromName(instance));
		// The cast collapses the stub's DbDocument-carrying union (the
		// workers-types Rpc.Serializable gotcha) - the value is plain JSON.
		return (await stub.remoteSubscribe({
			gateway: this.ctx.id.name ?? '',
			connId,
			subId,
			query,
			...(token ? { token } : {}),
		})) as unknown as RemoteSubscribeResult;
	}

	private async remoteUnsubscribe(
		kind: ShardAddress['kind'],
		instance: string,
		connId: string,
		subId?: string,
	): Promise<void> {
		try {
			const namespace = this.shardNamespace(kind) as unknown as DurableObjectNamespace<
				DbCollection | DbTable
			>;
			const stub = namespace.get(namespace.idFromName(instance));
			await stub.remoteUnsubscribe({ connId, ...(subId ? { subId } : {}) });
		} catch {
			// best-effort: the shard heals via {stop} on its next delivery
		}
	}

	// -------------------------------------------------------------------------
	// Parent plumbing (routing, origins, socket-pressure reports)

	private async parentStub() {
		const namespace = this.env.DbAgent as unknown as AgentNamespace<DbAgent>;
		// getAgentByName, never a raw namespace stub - see the twin comment in
		// collection.ts: a raw RPC can reach a cold parent before onStart's
		// migrations and turn every first touch into a 503.
		return getAgentByName(namespace, this.projectId);
	}

	private routingTtl(): number {
		return Number(this.env.SIBLING_ROUTING_TTL_MS ?? '') || ROUTING_TTL_MS;
	}

	private async shardRouting(name: string): Promise<ShardRoutingEntry> {
		const cached = this.routing.get(name);
		const now = Date.now();
		if (cached && cached.expires > now) return cached;
		let entry: ShardRoutingEntry = { kind: null, auto: false, expires: now + this.routingTtl() };
		try {
			const routing = await (await this.parentStub()).getShardRouting(name);
			if (routing) {
				entry = {
					kind: routing.kind,
					auto: routing.replication === 'auto',
					expires: now + this.routingTtl(),
				};
			}
		} catch {
			// The parent being unreachable must not break subscribes: an
			// unknown shard routes to the primary, which serves or refuses.
		}
		this.routing.set(name, entry);
		return entry;
	}

	/**
	 * Whether demo caps apply to this project - env + id shape, the same
	 * decision every shard makes. Demos are throwaway; nothing lifts their
	 * caps, so no parent consult is needed.
	 */
	private async isDemoProject(): Promise<boolean> {
		return this.env.DEMO_MODE === 'true' && DEMO_PROJECT_PATTERN.test(this.projectId);
	}

	private async allowedOrigins(): Promise<string[]> {
		const now = Date.now();
		if (this.origins && this.origins.expires > now) return this.origins.allowed;
		let allowed: string[] = [];
		try {
			allowed = await (await this.parentStub()).getAllowedOrigins();
		} catch {
			// Fail open to the environment allowlist only - a broken parent
			// link must not take realtime down for same-origin clients.
		}
		this.origins = { allowed, expires: now + this.routingTtl() };
		return allowed;
	}

	/** Step-debounced socket-count report - the sibling-spawn signal, exactly
	 * like replicas. A zero count always reports so drained gateways free
	 * their slot. */
	private async reportSockets(): Promise<void> {
		const sockets = this.ctx.getWebSockets().length;
		const threshold = Number(this.env.SIBLING_SPAWN_SOCKETS ?? '') || SIBLING_SPAWN_SOCKETS;
		const step = socketReportStep(threshold);
		if (
			this.lastReportedSockets !== null &&
			sockets !== 0 &&
			Math.abs(sockets - this.lastReportedSockets) < step
		) {
			return;
		}
		try {
			await (await this.parentStub()).reportGatewaySockets(this.gatewayId, this.region, sockets);
			this.lastReportedSockets = sockets;
		} catch {
			this.lastReportedSockets = null;
		}
	}

	// -------------------------------------------------------------------------

	private connIdOf(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as { connId?: string } | null;
		return attachment?.connId ?? null;
	}

	private send(ws: WebSocket, frame: ServerFrame): void {
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// a half-closed socket: close cleanup will prune its rows
		}
	}
}
