import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName, routeAgentRequest } from 'agents';
import { drainUnusedBody } from './access.js';
import { gateOperatorRoutes } from './route-access.js';
import { isDurableObjectReset, DbAgent as DbAgentBase } from './agent.js';
import { DbCollection as DbCollectionBase } from './collection.js';
import { DbGateway as DbGatewayBase, gatewayName } from './gateway.js';
import { DbTable as DbTableBase } from './table.js';
import { DbView as DbViewBase } from './view.js';
import { viewInstanceName } from './replication.js';
import { regionHint, REGION_HINTS } from './region.js';
import { replicaName } from './replication.js';
import { collectionNameSchema, projectIdSchema } from './schemas.js';
import {
	evaluateAll,
	payloadEtag,
	type EvaluableParameter,
	type RemoteConfigContext,
} from './remote-config.js';

export type {
	DbActivityEvent,
	DbAgentState,
	DbCollectionSummary,
	DbTableSummary,
	DbOverview,
} from './agent.js';
export type { AssertDbAgentEnv, DbAgentBindings } from './bindings.js';
export type {
	AccessMode,
	AggregateRequest,
	AggregateResult,
	CollectionValidator,
	ColumnType,
	DbDocument,
	DbRow,
	FieldRule,
	ImportReport,
	Query,
	RestoreRequest,
	ServerFrame,
	TableColumn,
	TableConfig,
} from './schemas.js';

const sentryOptions = (env: Env) => ({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENV,
	tracesSampleRate: 0.1,
	enableRpcTracePropagation: true,
});

/**
 * Isolate-local replication-flag cache for read routing. A stale answer is a
 * latency wobble only: replicas forward what they should not serve, and the
 * primary serves everything - so 60 seconds of staleness cannot produce a
 * wrong result, and a non-replicated shard keeps its one-hop path with zero
 * added requests.
 */
const ROUTING_TTL_MS = 60_000;
const routingCache = new Map<string, { auto: boolean; expires: number }>();

async function shardReplicationAuto(env: Env, projectId: string, shard: string): Promise<boolean> {
	const key = `${projectId}:${shard}`;
	const cached = routingCache.get(key);
	const now = Date.now();
	if (cached && cached.expires > now) return cached.auto;
	try {
		const agent = await getAgentByName<Env, DbAgentBase>(env.DbAgent, projectId);
		const routing = await agent.getShardRouting(shard);
		const auto = routing?.replication === 'auto';
		routingCache.set(key, { auto, expires: now + ROUTING_TTL_MS });
		return auto;
	} catch {
		// The parent being unreachable must not break reads: route primary.
		routingCache.set(key, { auto: false, expires: now + ROUTING_TTL_MS });
		return false;
	}
}

/** Replicated-read detection per engine; everything else stays primary.
 * REP2 routes /subscribe (replicas run the live engine locally); T2 routes
 * /sql - the replica itself classifies and forwards DML to the primary. */
function isRoutableRead(_kind: string, method: string, subPath: string): boolean {
	if (method === 'GET') return subPath !== '/';
	if (method !== 'POST') return false;
	return subPath === '/query' || subPath === '/aggregate' || subPath === '/sql';
}

/**
 * Sibling routing for NEW subscribers: the primary knows each region
 * replica's reported socket count and answers which sibling has headroom
 * (`pickSubscribeSibling`). Cached per isolate like the replication flag -
 * a stale answer routes to a fuller (or drained) sibling, which still WORKS,
 * so this is latency-shaped state, never correctness. Plain reads always
 * stay on sibling 1: read QPS is not the ceiling being hardened, and
 * spreading them would multiply warm data copies for nothing.
 */
const SIBLING_TTL_MS = 60_000;
const siblingCache = new Map<string, { n: number; expires: number }>();

/** Gateway sibling routing: same shape, answered by the project parent
 * (which holds the gateway socket-count registry). */
const gatewayCache = new Map<string, { n: number; expires: number }>();

async function gatewaySibling(env: Env, projectId: string, region: string): Promise<number> {
	const key = `${projectId}:${region}`;
	const now = Date.now();
	const cached = gatewayCache.get(key);
	if (cached && cached.expires > now) return cached.n;
	const ttl = Number(env.SIBLING_ROUTING_TTL_MS ?? '') || SIBLING_TTL_MS;
	let n = 1;
	try {
		const agent = await getAgentByName<Env, DbAgentBase>(env.DbAgent, projectId);
		const answer = await agent.gatewaySubscribeTarget(region);
		if (Number.isInteger(answer) && answer >= 1) n = answer;
	} catch {
		// The parent being unreachable must not break realtime: sibling 1.
	}
	gatewayCache.set(key, { n, expires: now + ttl });
	return n;
}

async function subscribeSibling(
	env: Env,
	kind: 'collections' | 'tables',
	projectId: string,
	shard: string,
	region: string,
): Promise<number> {
	const key = `${kind}:${projectId}:${shard}:${region}`;
	const now = Date.now();
	const cached = siblingCache.get(key);
	if (cached && cached.expires > now) return cached.n;
	const ttl = Number(env.SIBLING_ROUTING_TTL_MS ?? '') || SIBLING_TTL_MS;
	let n = 1;
	try {
		const namespace = (kind === 'tables'
			? env.DbTable
			: env.DbCollection) as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName(`${projectId}:${shard}`)) as unknown as {
			repSubscribeTarget(region: string): Promise<number>;
		};
		const answer = await stub.repSubscribeTarget(region);
		if (Number.isInteger(answer) && answer >= 1) n = answer;
	} catch {
		// The primary being unreachable must not break subscribes: sibling 1
		// is exactly yesterday's behavior.
	}
	siblingCache.set(key, { n, expires: now + ttl });
	return n;
}

/**
 * The caller's country, for Remote Config targeting.
 *
 * `request.cf` is authoritative and is checked first: it is set by the runtime
 * and a client cannot forge it. `cf-ipcountry` is consulted only when there is
 * no `cf` object at all, which on a real deployment means a service-binding
 * hop - and the console's proxy deletes the caller's own copy of that header
 * before setting the edge-resolved one.
 *
 * Anything that is not two letters is discarded rather than passed through, so
 * a junk header cannot become a cohort nobody can name.
 */
function resolveCountry(request: Request, env: Env): string | null {
	// Test-only, behind the same flag that lets specs pin region routing on a
	// single-colo local stack: a local workerd resolves no country at all, so
	// without this, country targeting could only be tested by not testing it.
	// Never set in production, and gated before it is read - on a deployment
	// that leaves the flag unset this branch does not exist.
	if (env.REGION_OVERRIDE_HEADER === 'true') {
		const override = request.headers.get('x-cfb-country');
		if (override && /^[A-Za-z]{2}$/.test(override)) return override.toUpperCase();
	}
	const fromEdge = (request as Request & { cf?: { country?: string } }).cf?.country;
	const claimed = fromEdge ?? request.headers.get('cf-ipcountry');
	if (!claimed || !/^[A-Za-z]{2}$/.test(claimed)) return null;
	return claimed.toUpperCase();
}

export const DbAgent = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbAgentBase);
export const DbCollection = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	DbCollectionBase,
);
export const DbTable = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbTableBase);
export const DbGateway = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbGatewayBase);
export const DbView = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbViewBase);

/**
 * Worker entrypoint. Routing:
 *
 * - `/health` - liveness for dev/test harnesses.
 * - `DELETE /internal/projects/:id` - erase fan-in from the console, outside
 *   /agents/* on purpose: this Worker has no public route (workers_dev and
 *   preview_urls false), so the endpoint is reachable only over the
 *   dashboard's service binding. The parent agent destroys every collection
 *   child before wiping itself.
 * - `/agents/db-agent/<pid>/collections/<c>/**` - the HOT PATH, dispatched
 *   straight to the DbCollection instance (`<pid>:<c>`) in ONE hop,
 *   including the /subscribe WebSocket upgrade.
 * - `/agents/db-agent/<pid>/tables/<t>/**` - the second hot path, same
 *   shape, straight to the DbTable instance.
 * - everything else under /agents/* - routeAgentRequest -> DbAgent
 *   (/config, /overview, /admin/*, and the AgentClient state-sync socket).
 *   Never with `cors: true`: the agents own their per-project CORS policy.
 */
class DbService extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		// Answering a body-bearing request without consuming the body wedges
		// the whole worker (uncaught "Can't read from request stream after
		// response has been sent") - every DO drains its own, and this covers
		// the entry-level answers (/health, 404s); already-forwarded bodies
		// no-op because the DO consumed the shared stream.
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ service: 'db-agent', status: 'ok' });
		}

		// The collection and table paths below are public by design and carry
		// their own access modes and JWT gate. The operator plane behind them
		// (/admin/*, /overview, state sync, /internal/*) carries none: the
		// console guard is its gate, and the package cannot assume one exists -
		// the documented consumer install mounts this handler on their own
		// PUBLIC Worker. Closed unless the deployment says otherwise
		// (src/route-access.ts); a no-op wherever EXPOSE_OPERATOR_API is set.
		const gated = gateOperatorRoutes(url, this.env);
		if (gated) return gated;

		const erase = url.pathname.match(/^\/internal\/projects\/([^/]+)$/);
		if (erase && request.method === 'DELETE') {
			const projectId = decodeURIComponent(erase[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, DbAgentBase>(this.env.DbAgent, projectId);
			try {
				await agent.destroy();
			} catch (error) {
				// The agent's own deferred abort can outrace the RPC reply in
				// production; children and storage are already gone by then.
				if (!isDurableObjectReset(error)) throw error;
			}
			return Response.json({ erased: true });
		}

		// The gateway socket: one client WebSocket for the whole database,
		// terminated on a DbGateway instance in the SUBSCRIBER'S region
		// (locationHint) - shards RPC resolved frames back to it.
		const realtime = url.pathname.match(/^\/agents\/db-agent\/([^/]+)\/realtime$/);
		if (realtime) {
			const projectId = decodeURIComponent(realtime[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			// WebSocket clients cannot set headers, so the test override also
			// rides a query param (same env.test-only gate as shard routing).
			const override =
				this.env.REGION_OVERRIDE_HEADER === 'true'
					? (request.headers.get('x-cfb-region') ?? url.searchParams.get('cfb-region'))
					: null;
			const region =
				override && REGION_HINTS.has(override)
					? override
					: regionHint(
							(
								request as Request & {
									cf?: { continent?: string; country?: string; longitude?: string };
								}
							).cf ?? {},
						);
			const sibling = await gatewaySibling(this.env, projectId, region);
			const stub = this.env.DbGateway.get(
				this.env.DbGateway.idFromName(gatewayName(projectId, region, sibling)),
				{ locationHint: region as DurableObjectLocationHint },
			);
			const gatewayResponse = (await stub.fetch(request)) as unknown as Response;
			await this.reportServerError(request, url, gatewayResponse);
			return gatewayResponse;
		}

		// Join views (JOIN1): one instance per view, resolved with no parent
		// hop - the same one-hop shape as the shard paths. The instance name
		// carries a region slot that JOIN1 always fills with `global`; making
		// views regional later is a change here and nowhere else.
		const view = url.pathname.match(/^\/agents\/db-agent\/([^/]+)\/views\/([^/]+)(\/.*)?$/);
		if (view) {
			const projectId = decodeURIComponent(view[1]);
			const name = decodeURIComponent(view[2]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!collectionNameSchema.safeParse(name).success
			) {
				return Response.json({ error: 'invalid project or view name' }, { status: 400 });
			}
			const namespace = this.env.DbView;
			const stub = namespace.get(
				namespace.idFromName(viewInstanceName(projectId, name, 'global', 1)),
			);
			const viewResponse = (await stub.fetch(request)) as unknown as Response;
			await this.reportServerError(request, url, viewResponse);
			return viewResponse;
		}

		const hot = url.pathname.match(
			/^\/agents\/db-agent\/([^/]+)\/(collections|tables)\/([^/]+)(\/.*)?$/,
		);
		if (hot) {
			const projectId = decodeURIComponent(hot[1]);
			const shard = decodeURIComponent(hot[3]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!collectionNameSchema.safeParse(shard).success
			) {
				return Response.json({ error: 'invalid project or shard name' }, { status: 400 });
			}
			// The two namespaces cannot cross wires: a name only routes within
			// its own kind's namespace, whatever the registry says about it.
			const namespace = hot[2] === 'tables' ? this.env.DbTable : this.env.DbCollection;
			const subPath = hot[4] ?? '/';

			// Replicated reads land on the caller's region replica; everything
			// else (and every non-replicated shard) keeps the primary hop.
			let instanceName = `${projectId}:${shard}`;
			let locationHint: DurableObjectLocationHint | undefined;
			if (
				isRoutableRead(hot[2], request.method, subPath) &&
				(await shardReplicationAuto(this.env, projectId, shard))
			) {
				// WebSocket clients cannot set headers, so the test override also
				// rides a query param (same env.test-only gate).
				const override =
					this.env.REGION_OVERRIDE_HEADER === 'true'
						? (request.headers.get('x-cfb-region') ?? url.searchParams.get('cfb-region'))
						: null;
				const region =
					override && REGION_HINTS.has(override)
						? override
						: regionHint(
								(
									request as Request & {
										cf?: { continent?: string; country?: string; longitude?: string };
									}
								).cf ?? {},
							);
				// Subscribers spread across siblings under socket pressure; every
				// other read keeps sibling 1.
				const sibling =
					subPath === '/subscribe'
						? await subscribeSibling(
								this.env,
								hot[2] as 'collections' | 'tables',
								projectId,
								shard,
								region,
							)
						: 1;
				instanceName = replicaName(instanceName, region, sibling);
				locationHint = region as DurableObjectLocationHint;
			}

			const stub = namespace.get(
				namespace.idFromName(instanceName),
				locationHint ? { locationHint } : undefined,
			);
			// The hot path is the whole customer-facing data API, so it gets the
			// same 5xx reporting as everything else - it used to return here,
			// outside the net below, which made a 500 on a document read or a
			// live-query upgrade invisible in every deployable.
			const hotResponse = (await stub.fetch(request)) as unknown as Response;
			await this.reportServerError(request, url, hotResponse);
			return hotResponse;
		}

		// Remote Config: the only PUBLIC coordinator route, and the only place in
		// this worker that resolves who is asking.
		const remoteConfig = url.pathname.match(/^\/agents\/db-agent\/([^/]+)\/remote-config$/);
		if (remoteConfig) {
			const configResponse = await this.serveRemoteConfig(
				request,
				url,
				decodeURIComponent(remoteConfig[1]),
			);
			await this.reportServerError(request, url, configResponse);
			return configResponse;
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		await this.reportServerError(request, url, response);
		return response;
	}

	/**
	 * `GET /agents/db-agent/<pid>/remote-config` - the evaluated config.
	 *
	 * Three things happen here rather than in the Durable Object, and each for
	 * its own reason:
	 *
	 * 1. **Country is resolved from `request.cf`**, which only exists out here.
	 *    It is never read from a header, so a caller cannot claim a country.
	 * 2. **Evaluation runs in the worker**, over parameters cached per PROJECT.
	 *    Evaluating in the DO would make the cohort part of the cache key, and a
	 *    per-cohort cache barely caches at all once a rollout exists - a rollout
	 *    buckets by uid, so the key would be per user.
	 * 3. **Only resolved values go out.** The rules are read here and stop here;
	 *    which cohorts exist and what the percentages are never ship.
	 */
	private async serveRemoteConfig(
		request: Request,
		url: URL,
		projectId: string,
	): Promise<Response> {
		const cors = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': 'authorization, content-type, if-none-match',
			'access-control-expose-headers': 'etag',
		};
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: { ...cors, 'access-control-allow-methods': 'GET, OPTIONS' },
			});
		}
		if (request.method !== 'GET') {
			return Response.json({ error: 'not found' }, { status: 404, headers: cors });
		}
		if (!projectIdSchema.safeParse(projectId).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400, headers: cors });
		}

		const parameters = await this.publishedConfig(projectId);

		// A verified token contributes role and permissions; an unverified or
		// absent one contributes nothing. Remote Config never REQUIRES a token -
		// config has to resolve for a logged-out first run, which is the whole
		// moment it exists for - so a bad token is anonymous, not an error.
		const agent = await getAgentByName<Env, DbAgentBase>(this.env.DbAgent, projectId);
		const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
		const claims = bearer ? await agent.verifyProjectToken(bearer) : null;

		const context: RemoteConfigContext = {
			// `request.cf` FIRST and the header only as a fallback, in that order
			// deliberately. On a consumer's public Worker the request arrives with
			// real `cf` properties, so a client-sent `cf-ipcountry` can never
			// displace them; the header path exists for the console's service
			// binding, which strips the caller's copy before setting its own
			// (see the proxy route) because a binding fetch keeps no `cf` at all.
			country: resolveCountry(request, this.env),
			uid: claims?.sub ?? url.searchParams.get('uid') ?? null,
			role: claims?.role ?? null,
			permissions: claims?.permissions ?? [],
			appVersion: url.searchParams.get('appVersion'),
		};

		const params = evaluateAll(parameters, context);
		const etag = payloadEtag(params);
		const headers = {
			...cors,
			etag,
			// Per-caller output, so any shared cache in front of this must not
			// reuse one caller's answer for another.
			'cache-control': 'private, max-age=0, must-revalidate',
		};
		if (request.headers.get('if-none-match') === etag) {
			return new Response(null, { status: 304, headers });
		}
		return Response.json({ params, fetchedAt: new Date().toISOString() }, { headers });
	}

	/**
	 * Published parameters for a project, cached per project in the edge cache.
	 *
	 * ONE entry per project rather than one per cohort - the whole reason
	 * evaluation happens in the worker. A publish therefore reaches clients when
	 * this expires, so the window is short and stated rather than hidden;
	 * `REMOTE_CONFIG_CACHE_SECONDS` tunes it, 0 disables it.
	 *
	 * A cache miss costs one RPC to the coordinator. A cache that cannot be
	 * reached (no Cache API in a given runtime) degrades to exactly that, which
	 * is correct but slower - never to a stale or empty config.
	 */
	private async publishedConfig(projectId: string): Promise<EvaluableParameter[]> {
		const seconds = Number.parseInt(this.env.REMOTE_CONFIG_CACHE_SECONDS ?? '', 10);
		const ttl = Number.isInteger(seconds) && seconds >= 0 ? seconds : 30;
		// A synthetic key: this never goes to the network, it only has to be
		// stable and per-project.
		const key = new Request(
			`https://remote-config.frostbase.internal/${encodeURIComponent(projectId)}`,
		);

		if (ttl > 0) {
			const hit = await caches.default.match(key).catch(() => undefined);
			if (hit) {
				const cached = (await hit.json().catch(() => null)) as EvaluableParameter[] | null;
				if (cached) return cached;
			}
		}

		const agent = await getAgentByName<Env, DbAgentBase>(this.env.DbAgent, projectId);
		const parameters = (await agent.remoteConfigPublished()) as EvaluableParameter[];

		if (ttl > 0) {
			const stored = Response.json(parameters, {
				headers: { 'cache-control': `public, max-age=${ttl}` },
			});
			this.ctx.waitUntil(caches.default.put(key, stored).catch(() => undefined));
		}
		return parameters;
	}

	/** Records any 5xx leaving this worker. Never replaces the response. */
	private async reportServerError(request: Request, url: URL, response: Response): Promise<void> {
		if (response.status < 500) return;
		try {
			// A 101 upgrade has no body to clone; only real responses get here.
			const body = (await response.clone().text()).slice(0, 2048);
			Sentry.captureMessage(`Db agent returned HTTP ${response.status}`, {
				level: 'error',
				tags: {
					'http.method': request.method,
					'http.status_code': response.status,
				},
				contexts: {
					response: { body, contentType: response.headers.get('content-type') ?? '' },
				},
				extra: { pathname: url.pathname },
			});
		} catch {
			// reporting must never replace the response
		}
	}
}

export default Sentry.withSentry(sentryOptions, DbService);
