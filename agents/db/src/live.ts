import { DurableObject } from 'cloudflare:workers';
import { and, count, eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './db/schema.js';
import { subscriptions } from './db/schema.js';
import type { ProjectJwtVerifier } from './jwt.js';
import { parseShardRole, type ShardRole } from './replication.js';
import { isWindowed, matchesQuery } from './query.js';
import { hasPermission } from './rules.js';
import {
	clientFrameSchema,
	querySchema,
	remoteSubscribeInputSchema,
	remoteUnsubscribeInputSchema,
	subscribeFrameSchema,
	type AccessMode,
	type DbDocument,
	type Query,
	type RemoteSubscribeResult,
	type ServerFrame,
} from './schemas.js';
import type { DbGateway } from './gateway.js';

/**
 * The live-query engine, shared by DbCollection and DbTable as a base class
 * - extracted (not copied) so the two engines cannot drift on subscription
 * survival, windowed-diff semantics, or the socket protocol. Everything here
 * is the collection v1 machinery verbatim; the subclasses supply what
 * genuinely differs through the small abstract surface at the bottom:
 * snapshot execution, doc fetch, the live gate's config, and (for tables)
 * schema validation of the subscribe query.
 *
 * Design invariants (see agents/db/CLAUDE.md):
 * - The socket attachment holds ONLY `{ connId }`; the `subscriptions` table
 *   is the durable state, so hibernation wakes restore full context from
 *   SQLite with zero in-memory state.
 * - On every write: unlimited queries get a predicate diff over old/new;
 *   windowed queries (orderBy+limit) re-run the compiled query and diff ids
 *   against `lastMembership`, which is what gets displacement right.
 * - Token expiry is lazy; reconnects are fresh snapshots.
 */

export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;
export const DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION = 5;

export interface LiveGate {
	readAccess: AccessMode;
	readPermission: string | null;
	demo: boolean;
}

export abstract class LiveShard extends DurableObject<Env> {
	protected db: DrizzleSqliteDODatabase<typeof schema>;
	/** primary or `:r:<region>:<n>` replica - decided by the instance name. */
	protected readonly role: ShardRole;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
		this.role = parseShardRole(ctx.id.name);
	}

	// -------------------------------------------------------------------------
	// The abstract surface the two engines fill in

	/** The current live-gate config, or null when the shard is unconfigured. */
	protected abstract liveGate(): LiveGate | null;
	protected abstract getVerifier(): ProjectJwtVerifier;
	/** Snapshot execution for subscribe and windowed re-runs. */
	protected abstract runLiveQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbDocument[] }>;
	/** One document/row by id, for displaced-out-of-window removals. */
	protected abstract fetchDocById(id: string): Promise<DbDocument | null>;
	protected abstract writeShardEvent(eventType: string): void;
	/** Tables refuse queries over undeclared columns; documents accept all. */
	protected validateSubscribeQuery(_query: Query): string | null {
		return null;
	}

	/** Replicas freshen from the primary before a snapshot; primaries no-op. */
	protected async beforeSnapshot(): Promise<void> {}

	/**
	 * Make the shard serveable for an RPC that arrives without the HTTP
	 * path's lazy-config heal: primaries pull their config from the parent on
	 * first touch, replicas ensure their local copy. Implemented per class;
	 * a shard that stays unconfigured afterwards reports through liveGate().
	 */
	protected async ensureShardReady(): Promise<void> {}

	/** Fired whenever the subscription set changes, with the remaining count
	 * - how a replica keeps its primary's push flag honest. */
	protected async onSubscriptionsChanged(_count: number): Promise<void> {}

	/** Fired on every accepted socket with the current hibernatable-socket
	 * count - how a replica reports pressure for sibling spawn. Counts bare
	 * sockets that never subscribe too: they consume the ceiling all the same. */
	protected async onSocketAccepted(_count: number): Promise<void> {}

	protected async subscriptionCount(): Promise<number> {
		const [row] = await this.db.select({ value: count() }).from(subscriptions);
		return row?.value ?? 0;
	}

	// -------------------------------------------------------------------------
	// Socket lifecycle

	protected acceptSubscriber(request: Request): Response {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return Response.json({ error: 'expected a WebSocket upgrade' }, { status: 426 });
		}

		const pair = new WebSocketPair();
		const connId = crypto.randomUUID();
		// The tag is the connection id; the attachment carries nothing else.
		// Everything a woken instance needs lives in the subscriptions table.
		this.ctx.acceptWebSocket(pair[1], [connId]);
		pair[1].serializeAttachment({ connId });

		this.ctx.waitUntil(this.onSocketAccepted(this.ctx.getWebSockets().length));

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const connId = this.connIdOf(ws);
		if (!connId) return;

		let frame;
		try {
			frame = clientFrameSchema.parse(JSON.parse(typeof raw === 'string' ? raw : ''));
		} catch {
			this.send(ws, {
				type: 'error',
				code: 'invalid-frame',
				message: 'frames are JSON subscribe/unsubscribe messages',
			});
			return;
		}

		if (frame.type === 'unsubscribe') {
			await this.db
				.delete(subscriptions)
				.where(and(eq(subscriptions.connId, connId), eq(subscriptions.subId, frame.id)));
			this.send(ws, { type: 'unsubscribed', id: frame.id });
			await this.onSubscriptionsChanged(await this.subscriptionCount());
			return;
		}

		await this.handleSubscribe(ws, connId, frame);
	}

	private async handleSubscribe(
		ws: WebSocket,
		connId: string,
		frame: (typeof subscribeFrameSchema)['_output'],
	): Promise<void> {
		const gate = this.liveGate();
		if (!gate) {
			this.send(ws, { type: 'error', id: frame.id, code: 'internal', message: 'not configured' });
			return;
		}

		const queryIssue = this.validateSubscribeQuery(frame.query);
		if (queryIssue) {
			this.send(ws, { type: 'error', id: frame.id, code: 'invalid-query', message: queryIssue });
			return;
		}

		const auth = await this.authorizeSubscribe(gate, frame.token);
		if (!auth.ok) {
			this.send(ws, { type: 'error', id: frame.id, code: auth.code, message: auth.message });
			return;
		}

		const cap = gate.demo
			? DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION
			: MAX_SUBSCRIPTIONS_PER_CONNECTION;
		if ((await this.connectionSubCount(connId)) >= cap) {
			this.send(ws, {
				type: 'error',
				id: frame.id,
				code: 'subscription-limit',
				message: `a connection is limited to ${cap} subscriptions`,
			});
			return;
		}

		await this.beforeSnapshot();
		const snapshot = await this.runLiveQuery(frame.query, auth.ownerSub);
		this.send(ws, { type: 'snapshot', id: frame.id, docs: snapshot.docs });

		await this.upsertSubscription(connId, frame.id, frame.query, auth, null, snapshot.docs);

		this.writeShardEvent('subscription.opened');
		await this.onSubscriptionsChanged(await this.subscriptionCount());
	}

	/** The read-mode gate, mirroring the REST guard - shared verbatim by the
	 * direct socket path and the gateway RPC path so they cannot drift. */
	private async authorizeSubscribe(
		gate: LiveGate,
		token: string | undefined,
	): Promise<
		| { ok: true; ownerSub: string | null; tokenExp: number | null }
		| { ok: false; code: 'unauthorized'; message: string }
	> {
		if (gate.readAccess === 'public') return { ok: true, ownerSub: null, tokenExp: null };
		// `none` closes the public read plane outright, exactly as checkAccess
		// does for REST - and BEFORE the token is read, because no token opens
		// it. Without this a closed collection streamed its snapshot and every
		// later write to any caller holding a valid token, a guest's included.
		if (gate.readAccess === 'none') {
			return {
				ok: false,
				code: 'unauthorized',
				message: 'this collection is not readable over the public API - it is operator-only',
			};
		}
		if (!token) {
			return {
				ok: false,
				code: 'unauthorized',
				message: 'a project token is required to subscribe',
			};
		}
		const result = await this.getVerifier().verify(token);
		if (!result.ok) {
			return {
				ok: false,
				code: 'unauthorized',
				message:
					result.code === 'not-configured'
						? 'auth verification is not configured'
						: 'invalid or expired token',
			};
		}
		// Mirror the REST guard: a required permission binds subscriptions too.
		if (!hasPermission(gate.readPermission, result.claims.permissions)) {
			return {
				ok: false,
				code: 'unauthorized',
				message: 'the token does not carry the required permission',
			};
		}
		return {
			ok: true,
			ownerSub: gate.readAccess === 'owner' ? result.claims.sub : null,
			tokenExp: result.exp,
		};
	}

	private async connectionSubCount(connId: string): Promise<number> {
		const [existing] = await this.db
			.select({ value: count() })
			.from(subscriptions)
			.where(eq(subscriptions.connId, connId));
		return existing?.value ?? 0;
	}

	private async upsertSubscription(
		connId: string,
		subId: string,
		query: Query,
		auth: { ownerSub: string | null; tokenExp: number | null },
		via: string | null,
		snapshotDocs: DbDocument[],
	): Promise<void> {
		const lastMembership = isWindowed(query)
			? JSON.stringify(snapshotDocs.map((doc) => doc.id))
			: null;
		await this.db
			.insert(subscriptions)
			.values({
				connId,
				subId,
				query: JSON.stringify(query),
				ownerSub: auth.ownerSub,
				tokenExp: auth.tokenExp,
				lastMembership,
				via,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [subscriptions.connId, subscriptions.subId],
				set: {
					query: JSON.stringify(query),
					ownerSub: auth.ownerSub,
					tokenExp: auth.tokenExp,
					lastMembership,
					via,
				},
			});
	}

	// -------------------------------------------------------------------------
	// The gateway surface: subscriptions held by a DbGateway on behalf of a
	// client socket that lives THERE. The shard runs the same live engine over
	// them; only delivery differs (RPC to the gateway instead of a socket
	// send). The token is re-verified here - the gateway is never trusted.

	async remoteSubscribe(input: unknown): Promise<RemoteSubscribeResult> {
		const parsed = remoteSubscribeInputSchema.parse(input);
		await this.ensureShardReady();
		const gate = this.liveGate();
		if (!gate) {
			// A replica that could not bootstrap forwards to the primary; an
			// unconfigured primary (undeclared table) is the shard's answer.
			if (this.role.kind === 'replica') return { forward: true };
			return { ok: false, code: 'shard-unavailable', message: 'shard is not configured' };
		}

		const queryIssue = this.validateSubscribeQuery(parsed.query);
		if (queryIssue) return { ok: false, code: 'invalid-query', message: queryIssue };

		const auth = await this.authorizeSubscribe(gate, parsed.token);
		if (!auth.ok) return auth;

		const cap = gate.demo
			? DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION
			: MAX_SUBSCRIPTIONS_PER_CONNECTION;
		if ((await this.connectionSubCount(parsed.connId)) >= cap) {
			return {
				ok: false,
				code: 'subscription-limit',
				message: `a connection is limited to ${cap} subscriptions per shard`,
			};
		}

		await this.beforeSnapshot();
		const snapshot = await this.runLiveQuery(parsed.query, auth.ownerSub);
		await this.upsertSubscription(
			parsed.connId,
			parsed.subId,
			parsed.query,
			auth,
			parsed.gateway,
			snapshot.docs,
		);

		this.writeShardEvent('subscription.opened');
		await this.onSubscriptionsChanged(await this.subscriptionCount());
		return { ok: true, docs: snapshot.docs };
	}

	async remoteUnsubscribe(input: unknown): Promise<void> {
		const parsed = remoteUnsubscribeInputSchema.parse(input);
		await this.db
			.delete(subscriptions)
			.where(
				parsed.subId === undefined
					? eq(subscriptions.connId, parsed.connId)
					: and(eq(subscriptions.connId, parsed.connId), eq(subscriptions.subId, parsed.subId)),
			);
		this.writeShardEvent('subscription.closed');
		await this.onSubscriptionsChanged(await this.subscriptionCount());
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	private async dropConnection(ws: WebSocket): Promise<void> {
		const connId = this.connIdOf(ws);
		if (!connId) return;
		await this.db.delete(subscriptions).where(eq(subscriptions.connId, connId));
		this.writeShardEvent('subscription.closed');
		await this.onSubscriptionsChanged(await this.subscriptionCount());
	}

	private connIdOf(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as { connId?: string } | null;
		return attachment?.connId ?? null;
	}

	protected send(ws: WebSocket, frame: ServerFrame): void {
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// a half-closed socket: close cleanup will prune its rows
		}
	}

	// -------------------------------------------------------------------------
	// The matching pass every mutation pays

	/**
	 * Unlimited queries diff the predicate on old/new. Windowed queries
	 * (orderBy+limit) re-run the query only when the write could have changed
	 * membership, then diff the id set against lastMembership - which is what
	 * gets displacement right: a doc pushed out by an insert emits `removed`,
	 * one pulled in by a delete emits `added`.
	 */
	protected async notifySubscribers(
		before: DbDocument | null,
		after: DbDocument | null,
	): Promise<void> {
		const rows = await this.db.select().from(subscriptions);
		if (!rows.length) return;

		const nowSeconds = Math.floor(Date.now() / 1000);
		/** Frames for gateway-held subscriptions, grouped gateway -> connId and
		 * flushed by RPC after the loop (batched per connection, off the write
		 * path's latency via waitUntil). */
		const gatewayFrames = new Map<string, Map<string, ServerFrame[]>>();

		for (const sub of rows) {
			let sink: (frame: ServerFrame) => void;
			if (sub.via) {
				const perConn = gatewayFrames.get(sub.via) ?? new Map<string, ServerFrame[]>();
				gatewayFrames.set(sub.via, perConn);
				const list = perConn.get(sub.connId) ?? [];
				perConn.set(sub.connId, list);
				sink = (frame) => list.push(frame);
			} else {
				const sockets = this.ctx.getWebSockets(sub.connId);
				if (!sockets.length) {
					// Connection died without a close event (eviction); prune lazily.
					await this.db.delete(subscriptions).where(eq(subscriptions.connId, sub.connId));
					continue;
				}
				const ws = sockets[0];
				sink = (frame) => this.send(ws, frame);
			}

			if (sub.tokenExp && sub.tokenExp < nowSeconds) {
				sink({
					type: 'error',
					id: sub.subId,
					code: 'token-expired',
					message: 'the token this subscription was opened with has expired',
				});
				await this.db
					.delete(subscriptions)
					.where(and(eq(subscriptions.connId, sub.connId), eq(subscriptions.subId, sub.subId)));
				continue;
			}

			let query: Query;
			try {
				query = querySchema.parse(JSON.parse(sub.query));
			} catch {
				continue;
			}

			const matchedBefore = before ? matchesQuery(query, before, sub.ownerSub) : false;
			const matchedAfter = after ? matchesQuery(query, after, sub.ownerSub) : false;
			if (!matchedBefore && !matchedAfter) continue;

			if (isWindowed(query)) {
				await this.notifyWindowed(sink, sub.connId, sub.subId, query, sub, after, before);
				continue;
			}

			if (!matchedBefore && matchedAfter && after) {
				sink({ type: 'change', id: sub.subId, kind: 'added', doc: after });
			} else if (matchedBefore && matchedAfter && after) {
				sink({ type: 'change', id: sub.subId, kind: 'modified', doc: after });
			} else if (matchedBefore && !matchedAfter && before) {
				sink({ type: 'change', id: sub.subId, kind: 'removed', doc: before });
			}
		}

		if (gatewayFrames.size) {
			this.ctx.waitUntil(this.flushGatewayFrames(gatewayFrames));
		}
	}

	private async notifyWindowed(
		sink: (frame: ServerFrame) => void,
		connId: string,
		subId: string,
		query: Query,
		sub: typeof subscriptions.$inferSelect,
		afterDoc: DbDocument | null,
		beforeDoc: DbDocument | null,
	): Promise<void> {
		const fresh = await this.runLiveQuery(query, sub.ownerSub);
		const freshIds = fresh.docs.map((doc) => doc.id);
		const freshSet = new Set(freshIds);
		const previous: string[] = sub.lastMembership ? JSON.parse(sub.lastMembership) : [];
		const previousSet = new Set(previous);
		const byId = new Map(fresh.docs.map((doc) => [doc.id, doc]));

		for (const id of freshIds) {
			if (!previousSet.has(id)) {
				const doc = byId.get(id);
				if (doc) sink({ type: 'change', id: subId, kind: 'added', doc });
			}
		}
		for (const id of previous) {
			if (!freshSet.has(id)) {
				// Displaced out of the window, or deleted. Prefer the written doc's
				// old value; otherwise fetch the still-existing displaced doc.
				const doc = beforeDoc?.id === id ? beforeDoc : ((await this.fetchDocById(id)) ?? beforeDoc);
				if (doc) sink({ type: 'change', id: subId, kind: 'removed', doc });
			}
		}
		if (afterDoc && freshSet.has(afterDoc.id) && previousSet.has(afterDoc.id)) {
			sink({ type: 'change', id: subId, kind: 'modified', doc: afterDoc });
		}

		await this.db
			.update(subscriptions)
			.set({ lastMembership: JSON.stringify(freshIds) })
			.where(and(eq(subscriptions.connId, connId), eq(subscriptions.subId, subId)));
	}

	/**
	 * Deliver buffered frames to their gateways by RPC - the primary->replica
	 * push pattern one level up: the RPC WAKES a hibernated gateway, which
	 * forwards to the right client socket. A `{stop}` answer means that
	 * connection is gone; its rows are pruned (the same self-healing the push
	 * flags use). An unreachable gateway keeps its rows - the next delivery
	 * or the gateway's own close cleanup retries.
	 */
	private async flushGatewayFrames(
		byGateway: Map<string, Map<string, ServerFrame[]>>,
	): Promise<void> {
		const namespace = this.env.DbGateway as unknown as DurableObjectNamespace<DbGateway>;
		for (const [gateway, perConn] of byGateway) {
			const stub = namespace.get(namespace.idFromName(gateway));
			for (const [connId, frames] of perConn) {
				if (!frames.length) continue;
				try {
					const result = (await stub.gatewayDeliver(connId, frames)) as
						{ ok: true } | { stop: true };
					if ('stop' in result && result.stop) {
						await this.db.delete(subscriptions).where(eq(subscriptions.connId, connId));
						await this.onSubscriptionsChanged(await this.subscriptionCount());
					}
				} catch {
					// best-effort: the gateway may be mid-restart; rows heal on the
					// next delivery or the gateway's own close cleanup
				}
			}
		}
	}
}
