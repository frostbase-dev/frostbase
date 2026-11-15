import {
	aggregateRequestSchema,
	querySchema,
	serverFrameSchema,
	LSN_HEADER,
	MIN_LSN_HEADER,
	type AggregateRequest,
	type DbDocument,
	type Query,
	type ServerFrame,
	type ShardAddress,
} from './schemas.js';
import { orderComparator } from './query.js';
import { createRemoteConfig, type RemoteConfigOptions } from './remote-config-client.js';

export type {
	RemoteConfigClient,
	RemoteConfigFetchResult,
	RemoteConfigOptions,
	RemoteConfigValue,
} from './remote-config-client.js';

/**
 * Thin isomorphic client for the db agent (browsers and Node >= 22, which
 * ships a native WebSocket). No Workers imports. It reuses the SAME zod
 * schemas the agent validates with - client and server cannot drift.
 *
 * `baseUrl` is either the direct agent base
 * (`https://worker.example.com/agents/db-agent/<projectId>`) or the console
 * proxy base (`https://console.example.com/api/projects/<projectId>/db`).
 * Subscriptions always use the direct `/agents/...` path - WebSockets bypass
 * the REST proxy exactly like the dashboard's own realtime - so a proxy base
 * is rewritten for the socket URL.
 *
 * Collections and tables share ONE handle implementation (`ShardHandle`):
 * CRUD, query, and subscribe are identical by construction - a row is the
 * document envelope with `data` as the column map. Collections add
 * aggregate/count/export; tables gain their extras in later phases.
 */

export interface DbClientOptions {
	baseUrl: string;
	/** Called per request; return null for public collections. */
	getToken?: () => Promise<string | null> | string | null;
	/** Reconnect backoff cap in ms (default 15_000). */
	maxBackoffMs?: number;
	/**
	 * Realtime transport. `'auto'` (the default) multiplexes every
	 * subscription - collections and tables alike - over ONE WebSocket to the
	 * project's realtime gateway, falling back to a socket per shard when the
	 * gateway endpoint is unavailable (an agent deployed before it existed).
	 * `'per-shard'` forces the one-socket-per-shard transport.
	 */
	realtime?: 'auto' | 'per-shard';
}

/** A row/document whose data map is typed. Compile-time only. */
export type Typed<T extends Record<string, unknown>> = Omit<DbDocument, 'data'> & { data: T };

export interface QueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
	docs: Typed<T>[];
	nextCursor?: string;
}

export interface DocChange<T extends Record<string, unknown> = Record<string, unknown>> {
	kind: 'added' | 'modified' | 'removed';
	doc: Typed<T>;
}

export interface SubscribeHandlers<T extends Record<string, unknown> = Record<string, unknown>> {
	onSnapshot?: (docs: Typed<T>[]) => void;
	onChange?: (change: DocChange<T>, docs: Typed<T>[]) => void;
	onError?: (code: string, message: string) => void;
}

export class DbError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'DbError';
	}
}

export function createDbClient(options: DbClientOptions) {
	const baseUrl = options.baseUrl.replace(/\/$/, '');
	// ONE transport per client: every handle's subscriptions - documents and
	// rows alike - multiplex over the same gateway socket. Lazy: nothing
	// connects until the first subscribe.
	const transport = new GatewayTransport(baseUrl, options);

	return {
		/**
		 * A document collection. The optional type parameter types `data` end
		 * to end at zero runtime cost - the same contract tables have.
		 */
		collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
			return new CollectionHandle<T>(baseUrl, name, options, transport);
		},
		/**
		 * A typed-column SQL table. Same handle surface as collections (CRUD,
		 * query, subscribe) over `/tables/<name>/rows`. Tables are
		 * schema-first - declare columns from the dashboard (or the admin API)
		 * before writing.
		 */
		table<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
			return new TableHandle<T>(baseUrl, name, options, transport);
		},

		/**
		 * Remote Config: server-controlled values this app reads at startup.
		 *
		 * Nothing about it rides the shard machinery above - it is one GET to an
		 * endpoint that answers with values already evaluated for this caller -
		 * so it lives in its own module and simply borrows this client's
		 * `baseUrl` and token source.
		 *
		 * Declare `defaults` for everything you read. They are what runs before
		 * the first fetch answers and what keeps running if it never does.
		 */
		remoteConfig(config: Omit<RemoteConfigOptions, 'baseUrl' | 'getToken' | 'fetch'> = {}) {
			return createRemoteConfig({ ...config, baseUrl, getToken: options.getToken });
		},
	};
}

interface ShardPaths {
	/** URL segment under the agent base: collections | tables. */
	shard: 'collections' | 'tables';
	/** Item segment under the shard: documents | rows. */
	item: 'documents' | 'rows';
}

/** A console-proxy base rewrites to the direct agent path for sockets -
 * WebSockets bypass the REST proxy exactly like the dashboard's own. */
function directAgentBase(baseUrl: string): string {
	return baseUrl.replace(/\/api\/projects\/([^/]+)\/db$/, '/agents/db-agent/$1');
}

/**
 * The one-socket realtime transport: every subscription rides a single
 * WebSocket to `/realtime` (a DbGateway in the subscriber's region), each
 * frame addressed by subscription id. If the endpoint has NEVER answered -
 * an agent deployed before gateways existed - the transport marks itself
 * unsupported and every subscription falls back to its shard's own socket;
 * once it has connected, drops just reconnect with backoff (fresh snapshots,
 * the v1 rule).
 */
class GatewayTransport {
	private socket: WebSocket | null = null;
	private everOpened = false;
	private unsupportedFlag = false;
	private nextSubId = 1;
	private backoffMs = 500;
	private subs = new Map<
		string,
		{
			shard: ShardAddress;
			query: Query;
			onFrame: (frame: ServerFrame) => void;
			onFallback: () => void;
		}
	>();

	constructor(
		private readonly baseUrl: string,
		private readonly options: DbClientOptions,
	) {}

	get unsupported(): boolean {
		return this.unsupportedFlag || this.options.realtime === 'per-shard';
	}

	/** Register one live query. Returns a release function; `onFallback`
	 * fires (instead of frames, exactly once) if the gateway turns out to be
	 * unavailable and the subscription should ride its shard socket. */
	subscribe(
		shard: ShardAddress,
		query: Query,
		onFrame: (frame: ServerFrame) => void,
		onFallback: () => void,
	): () => void {
		const subId = `g${this.nextSubId++}`;
		this.subs.set(subId, { shard, query, onFrame, onFallback });

		void this.ensureSocket().then((socket) => {
			if (socket && this.subs.has(subId)) void this.sendSubscribe(socket, subId);
		});

		return () => {
			this.subs.delete(subId);
			if (this.socket?.readyState === WebSocket.OPEN) {
				this.socket.send(JSON.stringify({ type: 'unsubscribe', id: subId }));
			}
			if (this.subs.size === 0) {
				this.socket?.close(1000, 'no subscribers');
				this.socket = null;
			}
		};
	}

	private wsUrl(): string {
		return `${directAgentBase(this.baseUrl).replace(/^http/, 'ws')}/realtime`;
	}

	private ensureSocket(): Promise<WebSocket | null> {
		if (this.unsupported) return Promise.resolve(null);
		if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
			const socket = this.socket;
			if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
			return new Promise((resolve) => {
				socket.addEventListener('open', () => resolve(socket), { once: true });
				socket.addEventListener('close', () => resolve(null), { once: true });
			});
		}

		const socket = new WebSocket(this.wsUrl());
		this.socket = socket;

		socket.addEventListener('message', (event) => {
			this.handleFrame(typeof event.data === 'string' ? event.data : '');
		});
		socket.addEventListener('close', () => {
			if (this.socket === socket) this.socket = null;
			if (!this.everOpened) this.giveUp();
			else this.scheduleReconnect();
		});

		return new Promise((resolve) => {
			socket.addEventListener(
				'open',
				() => {
					this.everOpened = true;
					this.backoffMs = 500;
					resolve(socket);
				},
				{ once: true },
			);
			socket.addEventListener('error', () => resolve(null), { once: true });
		});
	}

	/** The endpoint never answered: hand every subscription to its shard
	 * socket, permanently for this client instance. */
	private giveUp(): void {
		this.unsupportedFlag = true;
		const pending = [...this.subs.values()];
		this.subs.clear();
		for (const sub of pending) sub.onFallback();
	}

	private scheduleReconnect(): void {
		if (this.subs.size === 0) return;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 15_000);
		setTimeout(() => {
			if (this.subs.size === 0) return;
			void this.ensureSocket().then((socket) => {
				if (!socket) return;
				for (const subId of this.subs.keys()) void this.sendSubscribe(socket, subId);
			});
		}, delay);
	}

	private async sendSubscribe(socket: WebSocket, subId: string): Promise<void> {
		const entry = this.subs.get(subId);
		if (!entry || socket.readyState !== WebSocket.OPEN) return;
		const token = await this.options.getToken?.();
		socket.send(
			JSON.stringify({
				type: 'subscribe',
				id: subId,
				shard: entry.shard,
				query: entry.query,
				...(token ? { token } : {}),
			}),
		);
	}

	private handleFrame(raw: string): void {
		let frame: ServerFrame;
		try {
			frame = serverFrameSchema.parse(JSON.parse(raw));
		} catch {
			return;
		}
		const subId = 'id' in frame ? frame.id : undefined;
		if (!subId) return;
		this.subs.get(subId)?.onFrame(frame);
	}
}

class ShardHandle<T extends Record<string, unknown> = Record<string, unknown>> {
	private socket: WebSocket | null = null;
	private subscribers = new Map<
		string,
		{
			query: Query;
			handlers: SubscribeHandlers<T>;
			docs: Typed<T>[];
			/** Release for a gateway-held subscription; null = shard socket. */
			release: (() => void) | null;
		}
	>();
	private nextSubId = 1;
	private backoffMs = 500;
	private closedByUser = false;
	/** Session bookmark (D1-style): the highest LSN this handle has seen.
	 * Writes advance it; reads echo it so replicas serve read-your-writes. */
	private lastLsn = 0;

	constructor(
		protected readonly baseUrl: string,
		protected readonly name: string,
		protected readonly options: DbClientOptions,
		protected readonly paths: ShardPaths,
		private readonly transport: GatewayTransport,
	) {}

	protected url(subPath: string): string {
		return `${this.baseUrl}/${this.paths.shard}/${this.name}${subPath}`;
	}

	protected async headers(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		const token = await this.options.getToken?.();
		if (token) headers.authorization = `Bearer ${token}`;
		return headers;
	}

	protected async request<R>(method: string, subPath: string, body?: unknown): Promise<R> {
		const headers = await this.headers();
		// Reads carry the session bookmark so a region replica either catches
		// up past our own writes or hands the read to the primary.
		const isRead = method === 'GET' || subPath === '/query' || subPath === '/aggregate';
		if (isRead && this.lastLsn > 0) headers[MIN_LSN_HEADER] = String(this.lastLsn);

		const response = await fetch(this.url(subPath), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const lsn = Number(response.headers.get(LSN_HEADER) ?? 0);
		if (lsn > this.lastLsn) this.lastLsn = lsn;

		const payload = (await response.json().catch(() => null)) as (R & { error?: string }) | null;
		if (!response.ok) {
			throw new DbError(response.status, payload?.error ?? `request failed (${response.status})`);
		}
		return payload as R;
	}

	async create(data: T, options: { id?: string } = {}): Promise<Typed<T>> {
		return this.request('POST', `/${this.paths.item}`, { id: options.id, data });
	}

	async get(id: string): Promise<Typed<T>> {
		return this.request('GET', `/${this.paths.item}/${encodeURIComponent(id)}`);
	}

	/** Full replace of `data`. */
	async update(id: string, data: T): Promise<Typed<T>> {
		return this.request('PUT', `/${this.paths.item}/${encodeURIComponent(id)}`, data);
	}

	/** Shallow merge into `data` (tables: set the named columns). */
	async patch(id: string, partial: Partial<T>): Promise<Typed<T>> {
		return this.request('PATCH', `/${this.paths.item}/${encodeURIComponent(id)}`, partial);
	}

	async delete(id: string): Promise<void> {
		await this.request('DELETE', `/${this.paths.item}/${encodeURIComponent(id)}`);
	}

	async query(query: Query = {}): Promise<QueryResult<T>> {
		return this.request('POST', '/query', querySchema.parse(query));
	}

	/** count/sum/avg server-side; sum/avg skip non-numeric values. Both
	 * engines serve it (tables compile against declared columns). */
	async aggregate(request: AggregateRequest): Promise<Record<string, number | null>> {
		const { results } = await this.request<{ results: Record<string, number | null> }>(
			'POST',
			'/aggregate',
			aggregateRequestSchema.parse(request),
		);
		return results;
	}

	/** Matching count (everything readable when `where` is omitted). */
	async count(where?: AggregateRequest['where']): Promise<number> {
		const results = await this.aggregate({ where, aggregates: { total: { op: 'count' } } });
		return results.total ?? 0;
	}

	/**
	 * Live query. Returns an unsubscribe function. By default subscriptions
	 * ride the client's ONE gateway socket (all collections and tables
	 * multiplexed together); when the gateway is unavailable they fall back
	 * to a socket per shard. On reconnect every active subscription is
	 * re-sent and receives a fresh snapshot (the server keeps no resume
	 * state). Local doc order is maintained with the same comparator the
	 * server's ORDER BY compiles to.
	 */
	subscribe(query: Query, handlers: SubscribeHandlers<T>): () => void {
		const parsed = querySchema.parse(query);
		const subId = `s${this.nextSubId++}`;
		const entry = {
			query: parsed,
			handlers,
			docs: [] as Typed<T>[],
			release: null as (() => void) | null,
		};
		this.subscribers.set(subId, entry);

		if (!this.transport.unsupported) {
			entry.release = this.transport.subscribe(
				{ kind: this.paths.shard === 'tables' ? 'table' : 'collection', name: this.name },
				parsed,
				(frame) => this.applyFrame(subId, frame),
				() => {
					// The gateway never answered: this subscription rides the
					// shard socket from here on.
					entry.release = null;
					this.shardSubscribe(subId);
				},
			);
		} else {
			this.shardSubscribe(subId);
		}

		return () => {
			const current = this.subscribers.get(subId);
			this.subscribers.delete(subId);
			if (current?.release) {
				current.release();
				return;
			}
			if (this.socket?.readyState === WebSocket.OPEN) {
				this.socket.send(JSON.stringify({ type: 'unsubscribe', id: subId }));
			}
			if (this.shardSocketSubCount() === 0) {
				this.closedByUser = true;
				this.socket?.close(1000, 'no subscribers');
				this.socket = null;
			}
		};
	}

	/** Subscriptions riding this handle's own shard socket. */
	private shardSocketSubCount(): number {
		let total = 0;
		for (const entry of this.subscribers.values()) {
			if (entry.release === null) total += 1;
		}
		return total;
	}

	private shardSubscribe(subId: string): void {
		void this.ensureSocket().then((socket) => {
			if (socket && this.subscribers.has(subId)) void this.sendSubscribe(socket, subId);
		});
	}

	private wsUrl(): string {
		return `${directAgentBase(this.baseUrl).replace(/^http/, 'ws')}/${this.paths.shard}/${this.name}/subscribe`;
	}

	private ensureSocket(): Promise<WebSocket | null> {
		if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
			const socket = this.socket;
			if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
			return new Promise((resolve) => {
				socket.addEventListener('open', () => resolve(socket), { once: true });
				socket.addEventListener('close', () => resolve(null), { once: true });
			});
		}

		this.closedByUser = false;
		const socket = new WebSocket(this.wsUrl());
		this.socket = socket;

		socket.addEventListener('message', (event) => {
			this.handleFrame(typeof event.data === 'string' ? event.data : '');
		});
		socket.addEventListener('close', () => {
			if (this.socket === socket) this.socket = null;
			this.scheduleReconnect();
		});

		return new Promise((resolve) => {
			socket.addEventListener(
				'open',
				() => {
					this.backoffMs = 500;
					resolve(socket);
				},
				{ once: true },
			);
			socket.addEventListener('error', () => resolve(null), { once: true });
		});
	}

	private scheduleReconnect(): void {
		if (this.closedByUser || this.shardSocketSubCount() === 0) return;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 15_000);
		setTimeout(() => {
			if (this.closedByUser || this.shardSocketSubCount() === 0) return;
			void this.ensureSocket().then((socket) => {
				if (!socket) return;
				for (const [subId, entry] of this.subscribers) {
					if (entry.release === null) void this.sendSubscribe(socket, subId);
				}
			});
		}, delay);
	}

	private async sendSubscribe(socket: WebSocket, subId: string): Promise<void> {
		const entry = this.subscribers.get(subId);
		if (!entry || socket.readyState !== WebSocket.OPEN) return;
		const token = await this.options.getToken?.();
		socket.send(
			JSON.stringify({
				type: 'subscribe',
				id: subId,
				query: entry.query,
				...(token ? { token } : {}),
			}),
		);
	}

	private handleFrame(raw: string): void {
		let frame: ServerFrame;
		try {
			frame = serverFrameSchema.parse(JSON.parse(raw));
		} catch {
			return;
		}
		const subId = 'id' in frame ? frame.id : undefined;
		if (!subId) return;
		this.applyFrame(subId, frame);
	}

	/** One server frame for one subscription - shared by the shard socket and
	 * the gateway transport, so the two paths cannot diverge on ordering or
	 * windowing behavior. */
	private applyFrame(subId: string, frame: ServerFrame): void {
		const entry = this.subscribers.get(subId);
		if (!entry) return;

		if (frame.type === 'error') {
			entry.handlers.onError?.(frame.code, frame.message);
			return;
		}
		if (frame.type === 'unsubscribed') return;

		const compare = orderComparator(entry.query);

		if (frame.type === 'snapshot') {
			entry.docs = [...(frame.docs as Typed<T>[])].sort(compare);
			entry.handlers.onSnapshot?.(entry.docs);
			return;
		}

		const doc = frame.doc as Typed<T>;
		if (frame.kind === 'removed') {
			entry.docs = entry.docs.filter((existing) => existing.id !== doc.id);
		} else {
			entry.docs = [...entry.docs.filter((existing) => existing.id !== doc.id), doc].sort(compare);
			if (entry.query.limit !== undefined) {
				entry.docs = entry.docs.slice(0, entry.query.limit);
			}
		}
		entry.handlers.onChange?.({ kind: frame.kind, doc }, entry.docs);
	}

	/**
	 * The shared NDJSON export stream both handles expose under their own
	 * names. Items materialize one line at a time, so a large shard never has
	 * to fit in memory.
	 */
	protected async *exportShard(): AsyncGenerator<DbDocument, void, undefined> {
		const response = await fetch(this.url('/export'), { headers: await this.headers() });
		if (!response.ok || !response.body) {
			const payload = (await response.json().catch(() => null)) as { error?: string } | null;
			throw new DbError(response.status, payload?.error ?? `export failed (${response.status})`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim()) yield JSON.parse(line) as DbDocument;
			}
		}
		if (buffer.trim()) yield JSON.parse(buffer) as DbDocument;
	}
}

export class CollectionHandle<
	T extends Record<string, unknown> = Record<string, unknown>,
> extends ShardHandle<T> {
	constructor(
		baseUrl: string,
		name: string,
		options: DbClientOptions,
		transport: GatewayTransport,
	) {
		super(baseUrl, name, options, { shard: 'collections', item: 'documents' }, transport);
	}

	/**
	 * Stream every readable document (owner-mode collections yield only
	 * yours). The server sends NDJSON in id order; documents materialize one
	 * at a time, so a large collection never has to fit in memory.
	 */
	async *exportDocuments(): AsyncGenerator<Typed<T>, void, undefined> {
		yield* this.exportShard() as AsyncGenerator<Typed<T>, void, undefined>;
	}
}

export class TableHandle<
	T extends Record<string, unknown> = Record<string, unknown>,
> extends ShardHandle<T> {
	constructor(
		baseUrl: string,
		name: string,
		options: DbClientOptions,
		transport: GatewayTransport,
	) {
		super(baseUrl, name, options, { shard: 'tables', item: 'rows' }, transport);
	}

	/** Stream every readable row - the collection export contract on typed
	 * rows (owner-mode tables yield only yours; NDJSON in id order). */
	async *exportRows(): AsyncGenerator<Typed<T>, void, undefined> {
		yield* this.exportShard() as AsyncGenerator<Typed<T>, void, undefined>;
	}
}
