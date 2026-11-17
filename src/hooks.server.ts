import { dev } from '$app/environment';
import { agentByApiPrefix, agentByWorkerSegment, routeAccess } from '$lib/agent-registry';
import {
	CONSOLE_DASHBOARD_PAGES,
	CONSOLE_PROJECT_ID,
	isPrivateSurface,
	RESERVED_PROJECT_IDS
} from '$lib/console';
import { projectIdSchema } from '$lib/schemas/auth';
import { agentFetcher, agentUrl, serverError } from '$lib/server/agents';
import { isDemoMode, isDemoProjectId, resolveConsoleIdentity } from '$lib/server/console';
import { guardConsoleClaim } from '$lib/server/console-setup';
import { isServiceKeySurface, verifyServiceKey } from '$lib/server/service-keys';
import {
	getProjectOwnership,
	mayReachUnownedProjects,
	projectExists,
	type ProjectOwnership
} from '$lib/server/registry';
import { handleErrorWithSentry, initCloudflareSentryHandle, sentryHandle } from '@sentry/sveltekit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import type { AppAgentEntry } from '$lib/agent-registry';
import type { Handle } from '@sveltejs/kit';
import { movedLocation } from '$lib/safe-redirect';

let platform: App.Platform;

if (dev) {
	const { getPlatformProxy } = await import('wrangler');

	// @ts-expect-error wrangler dev local context
	platform = await getPlatformProxy({
		persist: true,
		environment: 'local'
	});
}

const platformHandle: Handle = async ({ event, resolve }) => {
	if (platform) {
		event.platform = {
			...event.platform,
			...platform
		};
	}

	if (event.platform?.ctx) {
		(event.platform as App.Platform & { context: ExecutionContext }).context = event.platform.ctx;
	}

	return resolve(event);
};

/**
 * `/api/projects/<id>/<apiPrefix>/<rest>` -> the agent-worker URL the REST
 * proxy routes build, or null when the path is not an agent proxy. Mirrors
 * the translation `classifyAccess` does, so the guard and the passthrough
 * agree on what a proxied path means.
 */
function agentProxyTarget(url: URL): { entry: AppAgentEntry; target: string } | null {
	const segments = url.pathname.split('/').filter(Boolean);
	if (segments[0] !== 'api' || segments[1] !== 'projects') return null;

	const projectId = projectIdSchema.safeParse(segments[2]);
	const entry = segments[3] ? agentByApiPrefix(segments[3]) : undefined;
	if (!projectId.success || !entry) return null;

	const rest = segments.slice(4).join('/');
	const subPath = `${entry.manifest.proxy.agentBasePath}${rest ? `/${rest}` : ''}` || '/';
	return { entry, target: agentUrl(url.origin, entry, projectId.data, `${subPath}${url.search}`) };
}

const applicationHandle: Handle = async ({ event, resolve }) => {
	// Agent traffic (HTTP + WebSocket state sync) goes straight through to the
	// agent worker the manifest registry names for the path's worker segment.
	// In local dev the dashboard connects directly to the agent workers'
	// ports instead, since Vite's dev server can't proxy workerd WebSockets.
	if (event.url.pathname.startsWith('/agents/')) {
		const entry = agentByWorkerSegment(event.url.pathname.split('/')[2] ?? '');
		const agent = entry && agentFetcher(event.platform, entry);
		if (agent) {
			return agent.fetch(event.request) as unknown as Promise<Response>;
		}
	}

	// An upgrade aimed at the REST proxy base takes the SAME untouched
	// passthrough. The `+server.ts` proxies re-wrap every answer, and a 101
	// cannot be re-wrapped - its status is outside what `new Response` accepts
	// and the `webSocket` never survives a copy - so a subscribe that arrived
	// here died as a RangeError 500. The SDK rewrites a proxy base to
	// `/agents/...` for exactly this reason; raw clients that don't now work
	// too. Returning the fetcher's response verbatim is what makes it possible,
	// which only a hook can do.
	if (event.request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		const proxied = agentProxyTarget(event.url);
		const agent = proxied && agentFetcher(event.platform, proxied.entry);
		if (proxied && agent) {
			// url + init, never a Request: the dev binding is a miniflare proxy
			// that cannot consume Requests from the Node realm.
			return agent.fetch(proxied.target, {
				method: event.request.method,
				headers: [...event.request.headers]
			}) as unknown as Promise<Response>;
		}
	}

	return resolve(event);
};

/**
 * Keeps the console out of search results.
 *
 * `/dashboard` on a demo deployment hands an anonymous visitor a throwaway
 * project - and a crawler is an anonymous visitor, so Googlebot followed the
 * landing page's demo link, was redirected into `demo-<hex>`, and indexed that
 * page under the `/dashboard` URL. The indexed project is erased by the demo
 * TTL days later, leaving a dead id as the site's dashboard result.
 *
 * A header rather than robots.txt: a disallowed URL is never fetched, so a
 * `noindex` in the markup would never be seen and an already-indexed URL would
 * stay indexed forever. This is served on every response, including the guard's
 * redirects and 401s, which is what lets Google drop what it already has.
 *
 * `noindex` is not the whole job, though: it governs SEARCH, and a link preview
 * is not a search engine - WhatsApp, iMessage, and every chat client that
 * unfurls a URL ignore it entirely. The same surface list therefore also drives
 * the root layout's Open Graph, which is what stops a shared `/dashboard` link
 * previewing as somebody's throwaway demo project.
 */
const noindexHandle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (isPrivateSurface(event.url.pathname)) {
		// Responses proxied from an agent carry immutable headers; the console
		// pages this actually targets do not, and a crawler never reaches those.
		try {
			response.headers.set('x-robots-tag', 'noindex, nofollow');
		} catch {
			// Nothing to do - an unmodifiable response is agent traffic, not a page.
		}
	}
	return response;
};

/**
 * The document is the pointer to the module graph, so it must never outlive a
 * deploy.
 *
 * SvelteKit sets no cache headers on a rendered page and neither did this app,
 * which left every HTML response with no freshness information AND no validator
 * - the exact shape RFC 9111 lets any cache assign a lifetime it invented
 * (heuristic freshness), with nothing to revalidate against. A browser that
 * takes that license serves the same stale HTML back on an ordinary reload, and
 * that HTML names hashed chunks the deploy already removed (why:
 * `$lib/stale-build`) - which is why the failure survived reloading and only a
 * wiped cache cleared it, the one thing no visitor thinks to do.
 *
 * The DOCUMENT was the only thing left bare: SvelteKit already answers its own
 * `__data.json` payloads with `private, no-store`, and hashed assets are served
 * by the asset binding without ever reaching this Worker - their immutable
 * year-long max-age being correct precisely BECAUSE their URL changes whenever
 * their content does. Redirects need nothing either: 302/303/307 are not in the
 * set RFC 9111 allows a heuristic on, which 200 and 404 are.
 *
 * `no-cache` rather than `no-store`: the document must be REVALIDATED, not
 * forbidden from being stored, and no-store would cost the back/forward cache
 * too. `private` because every page here varies by session - the landing page
 * swaps its CTA once signed in, console pages render the operator's own data -
 * so no shared cache may ever hold one. Anything that already claimed the
 * header keeps it.
 */
const documentCacheHandle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const isDocument = (response.headers.get('content-type') ?? '').startsWith('text/html');

	if (isDocument && !response.headers.has('cache-control')) {
		try {
			response.headers.set('cache-control', 'private, no-cache');
		} catch {
			// Nothing to do - an unmodifiable response is agent traffic, not a page.
		}
	}
	return response;
};

const apiRateLimitHandle: Handle = async ({ event, resolve }) => {
	const limited = event.url.pathname === '/api' || event.url.pathname.startsWith('/api/');
	if (limited) {
		const limiter = event.platform?.env?.API_RATE_LIMITER;

		if (limiter) {
			const { success } = await limiter.limit({ key: event.getClientAddress() });

			if (!success) {
				return Response.json(
					{ error: 'rate limit exceeded' },
					{
						status: 429,
						headers: { 'Retry-After': '60' }
					}
				);
			}
		}
	}

	return resolve(event);
};

type Access =
	| {
			scope: 'open';
			/**
			 * The project a PUBLIC route addresses, when it addresses one. Open
			 * does not mean unaddressed: the product API is public on purpose and
			 * still names a project, whose Durable Objects it provisions on first
			 * touch - so the id still has to be one this installation knows.
			 */
			projectId?: string | null;
	  }
	| {
			scope: 'operator';
			projectId: string | null;
			kind: 'page' | 'api';
			/** The bare /dashboard entry, the only page demo mode hands to anonymous visitors. */
			demoEntry?: boolean;
	  };

/**
 * Splits project-scoped surfaces into public product API and operator console.
 *
 * Public routes are the ones each agent's manifest declares `public` - the
 * product API a customer's app calls, and safe client config. Everything else
 * - overviews, analytics, admin mutations, and the realtime WebSockets -
 * reads or mutates a project's user data and needs an operator. Undeclared
 * routes and unknown agents fail closed to operator.
 *
 * This is the single enforcement point for the `/agents/*` passthrough too.
 * The agent workers have no public route (`workers_dev` and `preview_urls`
 * are both false), so every external request to them arrives through here.
 */
function classifyAccess(pathname: string): Access {
	const segments = pathname.split('/').filter(Boolean);

	// /agents/<worker>/<projectId>/<subPath...>
	if (segments[0] === 'agents') {
		const entry = agentByWorkerSegment(segments[1] ?? '');
		const subPath = `/${segments.slice(3).join('/')}`;
		if (entry && routeAccess(entry.manifest, subPath) === 'public') {
			return { scope: 'open', projectId: segments[2] ?? null };
		}
		return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
	}

	// Everything under /api is operator surface unless published below, so a
	// route added later is private until someone deliberately opens it.
	if (segments[0] === 'api') {
		// The first-run setup unlock. Public because an unclaimed console has
		// no session to authenticate against, and CONSOLE_SETUP_TOKEN - writable
		// only with Cloudflare account credentials - is the credential the
		// route checks.
		if (segments[1] === 'console' && segments[2] === 'setup' && segments.length === 3) {
			return { scope: 'open' };
		}
		// Registry mutations name their project in the path; surfacing the id
		// here is what routes them through the same ownership gate as the
		// project-scoped proxies (deleting a project is as project-scoped as
		// reading it).
		if (segments[1] === 'registry' && segments[2] === 'projects' && segments[3]) {
			return { scope: 'operator', projectId: segments[3], kind: 'api' };
		}
		if (segments[1] === 'projects') {
			const rest = segments.slice(3);
			// /api/projects/<id>/<apiPrefix>/... proxies onto an agent; translate
			// to the agent-relative path and ask its manifest route table.
			const entry = rest[0] ? agentByApiPrefix(rest[0]) : undefined;
			if (entry) {
				const restPath = rest.slice(1).join('/');
				const agentPath =
					`${entry.manifest.proxy.agentBasePath}${restPath ? `/${restPath}` : ''}` || '/';
				if (routeAccess(entry.manifest, agentPath) === 'public') {
					return { scope: 'open', projectId: segments[2] ?? null };
				}
				return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
			}
			// /config and /openapi.json both describe the public product API and
			// carry no secrets; being fetchable is the point for API tooling.
			if (rest.length === 1 && (rest[0] === 'config' || rest[0] === 'openapi.json')) {
				return { scope: 'open', projectId: segments[2] ?? null };
			}
			return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
		}
		return { scope: 'operator', projectId: null, kind: 'api' };
	}

	if (segments[0] === 'dashboard') {
		// A static console page (/dashboard/organization) is not a project page.
		// SvelteKit resolves it ahead of [projectId]; classifying it as a
		// project would hand it a reserved id and get it refused below.
		if (segments[1] && CONSOLE_DASHBOARD_PAGES.has(segments[1])) {
			return { scope: 'operator', projectId: null, kind: 'page' };
		}
		return {
			scope: 'operator',
			projectId: segments[1] ?? null,
			kind: 'page',
			demoEntry: segments.length === 1
		};
	}

	// The CLI login hand-off page: operator-only so a signed-out visitor
	// bounces through /login (social sign-in included) before approving.
	if (segments[0] === 'cli-auth') {
		return { scope: 'operator', projectId: null, kind: 'page' };
	}

	return { scope: 'open' };
}

/**
 * The guard's answer when the auth agent could not verify the session at all.
 * A 503, never a bounce to /login: the operator's credentials are not the
 * problem, and re-entering them cannot help.
 */
function cannotVerifySession(kind: 'page' | 'api'): Response {
	if (kind === 'page') {
		// serverError, not error(): a 503 the operator sees is one Sentry must
		// see too, and a bare `error()` never reaches handleError.
		serverError(503, 'Cannot verify your session right now. Please retry in a moment.');
	}
	return Response.json(
		{ error: 'cannot verify your session right now' },
		{ status: 503, headers: { 'Retry-After': '5' } }
	);
}

/**
 * Whether a PUBLIC project route may reach its project.
 *
 * Three ids qualify without a registry row: demo projects (throwaway by
 * construction, never rows, and only while demo mode is on), and `console`,
 * whose public auth surface is what the login page is built on. Everything
 * else must be a project this installation actually minted.
 *
 * Fails OPEN when the control plane cannot answer - deliberately the opposite
 * of the operator paths. What this gate prevents is unbounded Durable Object
 * creation, a cost problem; failing closed would turn a D1 blip into every
 * customer's app losing authentication, which is a worse outage than the
 * abuse it defends against, and it is the behaviour the platform had all
 * along.
 */
async function publicProjectReachable(
	event: Parameters<Handle>[0]['event'],
	projectId: string
): Promise<boolean> {
	if (projectId === CONSOLE_PROJECT_ID) return true;
	if (event.locals.demoMode && isDemoProjectId(projectId)) return true;
	return (await projectExists(event.platform, projectId)) !== false;
}

/**
 * "This project is not yours to reach" - deliberately the SAME answer for a
 * project that does not exist, one someone else owns, and one whose id is
 * reserved. Distinguishing them would turn the guard into an oracle for
 * enumerating other tenants' project ids.
 */
function noSuchProject(kind: 'page' | 'api'): Response {
	if (kind === 'page') redirect(303, '/dashboard');
	return Response.json({ error: 'no such project' }, { status: 404 });
}

/**
 * Requires an operator session for every console surface, and - since Phase A
 * of the managed service - membership in the owning org for project-scoped
 * ones. Fails closed: an install that never sets DEMO_MODE is private the
 * moment it is deployed.
 */
const consoleGuardHandle: Handle = async ({ event, resolve }) => {
	event.locals.demoMode = isDemoMode(event.platform);
	event.locals.consoleUser = null;
	event.locals.consoleIdentity = null;
	event.locals.serviceKey = null;

	const access = classifyAccess(event.url.pathname);
	if (access.scope === 'open') {
		// Public still has to mean "public surface of a project that exists".
		// The agents provision a Durable Object on first touch, so a sign-up
		// against an invented id minted a fresh database - anonymously,
		// unboundedly, for an id nobody owns and no console can ever erase.
		if (access.projectId && !(await publicProjectReachable(event, access.projectId))) {
			return noSuchProject('api');
		}
		// The console's auth surface is public so the login page can exist, and
		// on an UNCLAIMED console that surface hands out ownership of the whole
		// deployment. Arriving first is not a credential: the claim has to prove
		// control of the deployment itself (src/lib/server/console-setup.ts).
		const unproven = await guardConsoleClaim(event);
		if (unproven) return unproven;
		return resolve(event);
	}

	// Reserved ids are not projects. Everything except `console` names a
	// dashboard route or a system endpoint and has no instance behind it worth
	// reaching, so it is refused here - before the session is resolved, so the
	// answer cannot depend on who is asking. `console` DOES have an instance
	// (the operator accounts themselves) and is admin-gated further down,
	// after the identity is known.
	if (
		access.projectId &&
		access.projectId !== CONSOLE_PROJECT_ID &&
		RESERVED_PROJECT_IDS.has(access.projectId)
	) {
		return noSuchProject(access.kind);
	}

	// Service keys (SK1): an `fsb_` (or legacy `cfbs_`) bearer is the
	// credential a SERVER holds for the cases with no user to relay - crons,
	// queue consumers, webhook handlers, seed scripts. It reaches the DATA
	// plane of its own project and nothing else (isServiceKeySurface), so it
	// can never mint another credential, re-role an operator, or delete the
	// project it belongs to.
	//
	// It is ADMIN-GRADE on that surface, exactly like the operator session it
	// stands in for: those agent routes already bypass access modes, validators,
	// and permission keys, which is why this is an authentication change and not
	// an authorization one.
	//
	// A REQUEST CARRYING AN `Origin` IS REFUSED, whatever the key. Server
	// fetches send no Origin and browsers always do, so a key pasted into
	// frontend code fails immediately at the developer's desk instead of
	// shipping inside a JS bundle on a CDN. All or nothing: a key bearer never
	// falls through to session resolution.
	const serviceBearer = event.request.headers
		.get('authorization')
		?.match(/^Bearer\s+((?:fsb|cfbs)_[0-9a-f]{64})$/i)?.[1];
	if (serviceBearer) {
		// A PRESENT-but-empty Origin counts as absent, and only that: browsers
		// cannot produce one (they send a real origin or the literal `null`,
		// which is a non-empty string and stays refused), while HTTP clients
		// that blank the header out can. `Origin` is a forbidden header name in
		// browsers, so no page can strip its own.
		const origin = event.request.headers.get('origin');
		if (
			access.projectId &&
			!origin &&
			isServiceKeySurface(event.url.pathname, access.projectId) &&
			!isDemoProjectId(access.projectId)
		) {
			const grant = await verifyServiceKey(event.platform, serviceBearer.toLowerCase());
			// Exact project, never a family: for data the branch IS the isolation
			// boundary, and that is most of what branches are for.
			//
			// The registry row is checked too, even though the key already proves
			// its project: keys are dropped with their project, so a key for a
			// missing row means a delete fan-out that half-failed - and reaching
			// an unregistered id is what mints a Durable Object by URL. Nearly
			// free (projectExists memoizes positives per isolate), and `null` -
			// the control plane being unreachable - proceeds, because the key was
			// just verified against that same D1 a line ago.
			if (grant && grant.projectId === access.projectId) {
				if ((await projectExists(event.platform, access.projectId)) !== false) {
					event.locals.serviceKey = grant;
					return resolve(event);
				}
			}
		}
		return Response.json({ error: 'invalid service key' }, { status: 401 });
	}

	// Public demo: anonymous visitors may drive ephemeral demo projects, whose
	// ids are unguessable and whose data self-destructs after the TTL. Demos
	// are throwaway - never registry rows, never owned - so the visit skips
	// the ownership lookup and the session resolution entirely. Named projects
	// always require an operator session, even on the demo deployment.
	if (event.locals.demoMode && access.projectId && isDemoProjectId(access.projectId)) {
		return resolve(event);
	}

	// Ownership of the target project, resolved once per request. The console
	// instance is exempt: it is not a registry row and answers to the admin
	// role instead, checked below once the identity is known.
	const ownership: ProjectOwnership | null =
		access.projectId && access.projectId !== CONSOLE_PROJECT_ID
			? await getProjectOwnership(event.platform, access.projectId)
			: null;

	// Cloudflare resolves the client address at the edge; a service-binding
	// fetch keeps none of it, so the guard has to carry it to the agent by
	// hand or the agent's per-IP rate limiter degrades to one shared bucket
	// for the whole console (see sessionLookupHeaders).
	const clientIp = event.request.headers.get('cf-connecting-ip');

	// The bare /dashboard entry decides for itself: in demo mode it hands an
	// anonymous visitor a throwaway project, while a signed-in operator gets
	// the real project list. Its loader branches on consoleUser, so the
	// session must be resolved here too (the lookup no-ops without a cookie,
	// keeping the first-time demo visit free of a session round trip).
	// Scoped to that one entry: other project-less operator pages (/cli-auth)
	// keep the hard bounce through /login even on the public demo.
	if (event.locals.demoMode && access.demoEntry) {
		const resolved = await resolveConsoleIdentity(
			event.platform,
			event.url.origin,
			event.request.headers.get('cookie'),
			null,
			clientIp
		);
		if (resolved.status === 'unavailable') return cannotVerifySession(access.kind);
		event.locals.consoleIdentity = resolved.status === 'ok' ? resolved.identity : null;
		event.locals.consoleUser = event.locals.consoleIdentity?.user ?? null;
		return resolve(event);
	}

	const resolved = await resolveConsoleIdentity(
		event.platform,
		event.url.origin,
		event.request.headers.get('cookie'),
		event.request.headers.get('authorization'),
		clientIp
	);

	// Could not CHECK is not the same answer as not signed in, and the
	// difference is the whole user experience: bouncing to /login here loops
	// (that page resolves the session the same way and fails the same way) and
	// asks an operator to retype credentials against an outage they cannot
	// fix. Say so instead, and let the request be retried.
	if (resolved.status === 'unavailable') return cannotVerifySession(access.kind);

	const identity = resolved.status === 'ok' ? resolved.identity : null;

	if (identity) {
		event.locals.consoleIdentity = identity;
		event.locals.consoleUser = identity.user;

		// The console's own instance holds every operator account on the
		// deployment, so it is administered, not owned: no registry row can
		// speak for it, and membership in some org says nothing about it. The
		// admin role is the only key, and a non-admin gets the same "no such
		// project" as everyone else rather than a hint that it exists.
		if (access.projectId === CONSOLE_PROJECT_ID) {
			if (identity.user.role !== 'admin') return noSuchProject(access.kind);
			return resolve(event);
		}

		if (ownership) {
			// A control plane that cannot answer must not read as "not yours" -
			// the ownership lookup returns `unavailable` for that, distinct from
			// a row that genuinely is not there.
			if (ownership.unavailable) return cannotVerifySession(access.kind);

			// An id with no registry row is nobody's project, and reaching one
			// used to MINT a working backend by URL: the agents provision a
			// Durable Object on first touch, so /dashboard/<anything> handed out
			// an auth stack and a database outside every org ceiling - and any
			// other account guessing the same id landed in the same data.
			if (!ownership.registered) return noSuchProject(access.kind);

			// Owned rows require membership in the owning org. Rows with a null
			// org predate ownership (or were released by a console reset) and
			// belong to the console admin alone - "any operator" stopped meaning
			// "the same person" once sign-ups could be open.
			if (ownership.orgId) {
				const isMember = identity.organizations.some((org) => org.id === ownership.orgId);
				if (!isMember) return noSuchProject(access.kind);
			} else if (!mayReachUnownedProjects(identity)) {
				return noSuchProject(access.kind);
			}
		}
		return resolve(event);
	}

	if (access.kind === 'page') {
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	return Response.json({ error: 'authentication required' }, { status: 401 });
};

const cloudflareSentryHandle: Handle = async (input) => {
	// One DSN for server and browser: a DSN is not a secret (it ships in the
	// client bundle by design), so the server reads the PUBLIC_ var too.
	const dsn = input.event.platform?.env?.PUBLIC_SENTRY_DSN;

	if (!dsn) {
		return input.resolve(input.event);
	}

	return initCloudflareSentryHandle({
		dsn,
		environment: dev
			? 'development'
			: input.event.url.hostname === 'frostbase.dev'
				? 'production'
				: 'preview',
		tracesSampleRate: 0.1
	})(input);
};

/**
 * CSRF, credential-aware - replacing SvelteKit's blanket check, which is
 * disabled in svelte.config.js (`csrf.checkOrigin: false`) precisely so this
 * can run instead. Never delete one without the other.
 *
 * THE ATTACK: a page on evil.com submits a form to this origin. The browser
 * attaches the visitor's session cookie automatically, so the request runs as
 * them. Browsers can only do this without asking permission for three content
 * types - the ones a plain HTML form can produce - so refusing those on a
 * cross-origin write is the defence, and it is exactly SvelteKit's rule.
 *
 * WHY IT NEEDED REPLACING: SvelteKit treats a MISSING Origin as cross-site.
 * A service-key request has no Origin BY CONSTRUCTION - the guard refuses the
 * key outright if one is present - and `fetch` defaults a string body to
 * `text/plain;charset=UTF-8`, `JSON.stringify(...)` included. So the most
 * natural call a server can write was refused 403 before the key was ever
 * read, on the primary documented server path rather than some edge.
 *
 * WHY SKIPPING ON A BEARER IS SOUND: CSRF works only because the browser
 * supplies the credential by itself. It never adds a `Bearer` Authorization
 * header on its own, and a cross-origin fetch that sets one triggers a CORS
 * preflight this app does not answer for untrusted origins. So a request
 * carrying one cannot have been forged by a victim's browser - and an
 * attacker who already knows the bearer does not need CSRF at all. Cookie
 * requests keep the full check.
 *
 * The skip is BEARER-shaped only, not any Authorization header: every
 * credential this app accepts is a bearer (session token or service key),
 * while `Basic` is one a browser CAN attach by itself (a `user:pass@host`
 * top-level navigation), riding beside the victim's cookies
 * on a request the guard would then authenticate from those cookies. A
 * non-bearer Authorization therefore keeps the full check.
 *
 * SvelteKit applies this before ANY hook, so the replacement sits first in the
 * sequence - ahead of the rate limiter and the guard - to keep the same
 * ordering guarantee.
 */
const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
];

const csrfHandle: Handle = async ({ event, resolve }) => {
	const { request, url } = event;
	const method = request.method;
	if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
		// A bearer is not ambient - see above. This is the only relaxation.
		if (!/^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '')) {
			const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
			const origin = request.headers.get('origin');
			if (FORM_CONTENT_TYPES.includes(type) && origin !== url.origin) {
				return new Response('Cross-site form submissions are forbidden', { status: 403 });
			}
		}
	}
	return resolve(event);
};

/**
 * The hosted console moved from cloudflarebase.com to frostbase.dev. The old
 * hostname stays attached to this Worker (MOVED_FROM_HOSTS) so links, bookmarks
 * and search results land on the same path at CANONICAL_ORIGIN.
 *
 * Pages redirect; the API does NOT. `/api/*` and `/agents/*` keep answering on
 * the old host, because an integration that hard-codes the old base URL would
 * otherwise break: a cross-origin fetch only follows a redirect that itself
 * passes CORS, and a redirected POST is a request no client should have to
 * re-send. Unset vars (self-hosted, local, e2e) make this a no-op.
 */
const domainMoveHandle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env as
		{ MOVED_FROM_HOSTS?: string; CANONICAL_ORIGIN?: string } | undefined;
	const canonical = env?.CANONICAL_ORIGIN;
	const moved = env?.MOVED_FROM_HOSTS?.split(',').map((host) => host.trim().toLowerCase());
	if (!canonical || !moved?.includes(event.url.hostname.toLowerCase())) return resolve(event);
	if (/^\/(api|agents)(\/|$)/.test(event.url.pathname)) return resolve(event);
	const target = movedLocation(event.url.pathname, event.url.search, canonical);
	// 308 keeps the method for the odd form POST; navigations get a plain 301.
	const status = event.request.method === 'GET' || event.request.method === 'HEAD' ? 301 : 308;
	return new Response(null, { status, headers: { location: target } });
};

export const handle = sequence(
	// Ahead of everything, the CSRF check included: a moved host answers with
	// a redirect and nothing else, so nothing behind it needs to run.
	domainMoveHandle,
	// Before everything: SvelteKit's own version of this ran ahead of every
	// hook, and the ordering guarantee is part of the protection. A refused
	// forgery never reaches Sentry's wrappers, exactly as it never did under
	// SvelteKit's built-in check.
	csrfHandle,
	platformHandle,
	cloudflareSentryHandle,
	sentryHandle(),
	// Outside the guard: its redirects and 401s are responses a crawler sees
	// too, and they need the header as much as a rendered page does.
	noindexHandle,
	// Beside noindexHandle and for the same reason: a redirect or an error page
	// is a document too, and a cached one keeps pointing at a dead module graph.
	documentCacheHandle,
	apiRateLimitHandle,
	// Must precede applicationHandle: that one forwards /agents/* straight to
	// the agent worker, so the guard is the last chance to reject.
	consoleGuardHandle,
	applicationHandle
);
export const handleError = handleErrorWithSentry();
