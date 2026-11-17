import * as Sentry from '@sentry/sveltekit';
import { CONSOLE_PROJECT_ID, type ConsoleIdentity } from '$lib/console';
import { agentUrl, requireAuthAgent } from '$lib/server/auth-agent';
import { z } from 'zod';

export type { ConsoleIdentity } from '$lib/console';

/**
 * The console authenticates its operators against a dedicated AuthAgent - the
 * same stack every customer project runs. Frostbase's own dashboard is
 * therefore its first customer.
 *
 * The instance is addressed by a reserved project id, so the registry must
 * never hand it out (see RESERVED_PROJECT_IDS in $lib/console).
 */
export { CONSOLE_PROJECT_ID, RESERVED_PROJECT_IDS, isDemoProjectId } from '$lib/console';

/**
 * Demo mode is what keeps frostbase.dev open to the public while every
 * self-hosted install is closed by default. It is opt-in: an unset DEMO_MODE
 * means a private console, which is the safe default for someone who just
 * deployed this to their own account.
 */
export function isDemoMode(platform: App.Platform | undefined): boolean {
	return platform?.env?.DEMO_MODE === 'true';
}

/**
 * Better Auth's get-session payload, narrowed to what the console needs. Parsed
 * rather than cast: this crosses a service binding, so it is untrusted input.
 */
const consoleSessionSchema = z.object({
	user: z.object({
		id: z.string().min(1),
		email: z.email(),
		name: z.string().default(''),
		role: z.string().default('user')
	})
});

const consoleOverviewSchema = z.object({
	users: z.array(z.unknown())
});

const consoleConfigSchema = z.object({
	providers: z.array(z.string()),
	consoleSignups: z.enum(['claimed', 'open']).default('claimed'),
	localPasswordReset: z.boolean().default(false)
});

export interface ConsoleAuthConfig {
	/** Social providers the sign-in form can offer (google/github only). */
	socialProviders: string[];
	/** The console's EFFECTIVE registration policy, for honest /login copy. */
	consoleSignups: 'claimed' | 'open';
	/** Local dev only (DISABLE_EMAIL_VERIFICATION on the agent): the login
	 * page offers the direct reset form instead of the emailed-token flow. */
	localPasswordReset: boolean;
}

/**
 * The console auth instance's public /config, narrowed to what the login page
 * needs: which social buttons to offer and whether public sign-up is open.
 * The agent reports the EFFECTIVE mode, so a misconfigured `open` never
 * renders a doomed sign-up form.
 */
export async function consoleAuthConfig(
	platform: App.Platform | undefined,
	origin: string
): Promise<ConsoleAuthConfig> {
	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/config'))
		.catch(() => null);

	const fallback: ConsoleAuthConfig = {
		socialProviders: [],
		consoleSignups: 'claimed',
		localPasswordReset: false
	};
	if (!response || !response.ok) return fallback;

	const body = await (response as unknown as Response).json().catch(() => null);
	const parsed = consoleConfigSchema.safeParse(body);
	if (!parsed.success) return fallback;
	return {
		socialProviders: parsed.data.providers.filter((name) => name === 'google' || name === 'github'),
		consoleSignups: parsed.data.consoleSignups,
		localPasswordReset: parsed.data.localPasswordReset
	};
}

export type ConsoleUser = z.infer<typeof consoleSessionSchema>['user'];

/**
 * The headers a session lookup carries to the auth agent.
 *
 * `cf-connecting-ip` matters as much as the cookie. A service-binding fetch
 * keeps NONE of the original request's Cloudflare headers, and Better Auth
 * rate limits per client IP - so without it the agent cannot resolve an
 * address and buckets every operator's session read into ONE shared counter
 * (100/60s). The console guard resolves an identity on every request and every
 * dashboard page polls on a 5s timer, so that counter runs out in under a
 * minute of ordinary use, after which the agent answers 429 and the console
 * reads it as "not signed in". Forwarding the address is what keeps the
 * limiter a per-client abuse ceiling instead of a console-wide one.
 */
function sessionLookupHeaders(
	origin: string,
	cookie: string | null,
	authorization: string | null,
	clientIp: string | null
): [string, string][] {
	const headers: [string, string][] = [['origin', origin]];
	if (cookie) headers.push(['cookie', cookie]);
	if (authorization) headers.push(['authorization', authorization]);
	if (clientIp) headers.push(['cf-connecting-ip', clientIp]);
	return headers;
}

/**
 * Resolves the operator session by asking the console's AuthAgent, forwarding
 * the browser's cookies - and, for the CLI, a bearer `Authorization` header
 * (the agent accepts session tokens as bearers; that is the documented
 * external-client path on every project instance, the console included).
 * Returns null when there is no valid session.
 *
 * This runs on the hot path for dashboard polling, so callers should memoize
 * per request (see `locals.consoleUser` in hooks.server.ts).
 */
export async function getConsoleSession(
	platform: App.Platform | undefined,
	origin: string,
	cookie: string | null,
	authorization: string | null = null,
	clientIp: string | null = null
): Promise<ConsoleUser | null> {
	if (!cookie && !authorization) return null;

	const headers = sessionLookupHeaders(origin, cookie, authorization, clientIp);

	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/api/auth/get-session'), {
			method: 'GET',
			headers
		})
		.catch((cause: unknown) => {
			// Failing closed is right, but silence is not: an unreachable auth
			// agent logs EVERY operator out, and that must not look like a
			// pile of expired cookies.
			Sentry.captureException(cause, {
				level: 'error',
				tags: { operation: 'console-session' },
				extra: { note: 'operators are being signed out - the console guard cannot verify' }
			});
			return null;
		});

	if (!response) return null;
	// 401/403 is the ordinary "not signed in" answer; anything else is broken.
	if (!response.ok) {
		if (response.status !== 401 && response.status !== 403) {
			Sentry.captureMessage(`console session lookup responded ${response.status}`, {
				level: 'error',
				tags: { operation: 'console-session' }
			});
		}
		return null;
	}

	const body: unknown = await (response as unknown as Response).json().catch(() => undefined);
	// Better Auth answers a signed-out get-session with 200 and a JSON null
	// body - the ORDINARY case for any visitor carrying unrelated cookies
	// (e.g. the demo-project cookie), not a contract drift. Only a 200 whose
	// body is neither null nor the session shape means the contract moved.
	if (body === null) return null;
	const parsed = consoleSessionSchema.safeParse(body);
	if (!parsed.success) {
		// A valid 200 the guard cannot read means the session contract drifted.
		Sentry.captureMessage('console session response did not match the expected shape', {
			level: 'error',
			tags: { operation: 'console-session' }
		});
		return null;
	}

	const { user } = parsed.data;
	return { ...user, name: user.name || user.email };
}

const consoleIdentitySchema = z
	.object({
		user: z.object({
			id: z.string().min(1),
			email: z.email(),
			name: z.string().default(''),
			role: z.string().default('user'),
			emailVerified: z.boolean().default(false),
			image: z.string().nullable().default(null)
		}),
		session: z.object({ activeOrganizationId: z.string().nullable().default(null) }),
		organizations: z.array(
			z.object({
				id: z.string().min(1),
				name: z.string(),
				slug: z.string(),
				role: z.string().default('member')
			})
		),
		pendingInvitations: z
			.array(
				z.object({
					id: z.string().min(1),
					organizationId: z.string(),
					organizationName: z.string(),
					role: z.string().nullable().default(null),
					inviterEmail: z.string().nullable().default(null),
					expiresAt: z.string()
				})
			)
			.default([])
	})
	.nullable();

/**
 * Three answers, not two. `anonymous` means the agent checked and there is no
 * session; `unavailable` means it never got to check (unreachable agent, rate
 * limiter, 5xx). Collapsing the second into the first is what turns a blip
 * into a sign-out - and into a /login loop, since that page resolves the
 * session the same way and cannot succeed either.
 */
export type ConsoleIdentityResult =
	{ status: 'ok'; identity: ConsoleIdentity } | { status: 'anonymous' } | { status: 'unavailable' };

const UNAVAILABLE = { status: 'unavailable' } as const;
const ANONYMOUS = { status: 'anonymous' } as const;

/**
 * Resolves the operator's identity - session AND org memberships - in one
 * agent round trip via GET /console/me. This is what the per-request guard
 * uses: ownership checks need memberships, and the dashboard must never pay
 * two RPCs per request (memoized as `locals.consoleIdentity`).
 *
 * A 404 falls back to the plain session lookup with no memberships: an agent
 * deployed before /console/me existed must degrade to the pre-ownership
 * behaviour (null org visibility), never sign every operator out.
 */
export async function resolveConsoleIdentity(
	platform: App.Platform | undefined,
	origin: string,
	cookie: string | null,
	authorization: string | null = null,
	clientIp: string | null = null,
	/** An invitation id the caller holds (from the invite link). An account
	 * whose email is unverified is shown only the invitation it holds. */
	invitationId: string | null = null
): Promise<ConsoleIdentityResult> {
	if (!cookie && !authorization) return ANONYMOUS;

	const headers = sessionLookupHeaders(origin, cookie, authorization, clientIp);

	const agent = requireAuthAgent(platform);
	const attempt = () =>
		agent
			.fetch(
				agentUrl(
					origin,
					CONSOLE_PROJECT_ID,
					invitationId
						? `/console/me?invitation=${encodeURIComponent(invitationId)}`
						: '/console/me'
				),
				{ method: 'GET', headers }
			)
			.catch((cause: unknown) => {
				Sentry.captureException(cause, {
					level: 'error',
					tags: { operation: 'console-identity' },
					extra: {
						note: 'the console guard cannot verify sessions - the auth agent is unreachable'
					}
				});
				return null;
			});

	let response = await attempt();
	// A Durable Object reset is a ONE-SHOT event: a storage timeout or a
	// deploy eviction kills the instance mid-request, and the very next call
	// lands on a fresh one. Retrying once absorbs that whole class - the
	// operator never sees the 503 page for a blip the platform already
	// recovered from. Only the outage shapes are retried: 401/403 are real
	// answers, 404 is the old-agent fallback, and a 429 must never be fed
	// another request.
	const outage = (value: typeof response) =>
		!value || (!value.ok && ![401, 403, 404, 429].includes(value.status));
	if (outage(response)) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		response = await attempt();
	}

	if (!response) return UNAVAILABLE;
	if (response.status === 404) {
		const user = await getConsoleSession(platform, origin, cookie, authorization, clientIp);
		if (!user) return ANONYMOUS;
		return {
			status: 'ok',
			identity: {
				user: { ...user, emailVerified: false, image: null },
				activeOrganizationId: null,
				organizations: [],
				pendingInvitations: []
			}
		};
	}
	if (!response.ok) {
		// 401/403 is the agent's ordinary "not signed in". Everything else -
		// a 503 from the agent's own could-not-verify answer, a 429, a 5xx -
		// is an outage, and an outage must not read as a sign-out.
		if (response.status === 401 || response.status === 403) return ANONYMOUS;
		Sentry.captureMessage(`console identity lookup responded ${response.status}`, {
			level: 'error',
			tags: { operation: 'console-identity' }
		});
		return UNAVAILABLE;
	}

	const body: unknown = await (response as unknown as Response).json().catch(() => undefined);
	if (body === null) return ANONYMOUS;
	const parsed = consoleIdentitySchema.safeParse(body);
	if (!parsed.success || !parsed.data) {
		Sentry.captureMessage('console identity response did not match the expected shape', {
			level: 'error',
			tags: { operation: 'console-identity' }
		});
		return UNAVAILABLE;
	}

	const { user, session, organizations, pendingInvitations } = parsed.data;
	return {
		status: 'ok',
		identity: {
			user: { ...user, name: user.name || user.email, emailVerified: user.emailVerified },
			activeOrganizationId: session.activeOrganizationId,
			organizations,
			pendingInvitations
		}
	};
}

/**
 * The identity or nothing, for callers that render the same thing either way
 * (the landing page, /login). The guard uses `resolveConsoleIdentity` instead:
 * it is the one caller whose response depends on WHY there is no identity.
 */
export async function getConsoleIdentity(
	platform: App.Platform | undefined,
	origin: string,
	cookie: string | null,
	authorization: string | null = null,
	clientIp: string | null = null,
	invitationId: string | null = null
): Promise<ConsoleIdentity | null> {
	const resolved = await resolveConsoleIdentity(
		platform,
		origin,
		cookie,
		authorization,
		clientIp,
		invitationId
	);
	return resolved.status === 'ok' ? resolved.identity : null;
}

/**
 * Whether the console has been claimed - in THREE answers, not two.
 *
 * `unavailable` is the one that matters: an agent that could not be asked is
 * not the same as a console with no owner, and collapsing them is what turns
 * an outage into either a refused sign-in or - far worse for the claim gate -
 * an ownership window that opens whenever the agent hiccups. Same lesson as
 * resolveConsoleIdentity, which learned it the expensive way.
 */
export type ConsoleOwnerState = 'claimed' | 'unclaimed' | 'unavailable';

/**
 * Memoised `claimed` answers, per isolate.
 *
 * Claiming is one-way (the only thing that unclaims a console is the deliberate
 * reset in console-setup.ts), so a positive answer stays true, and the claim
 * gate consults this on every console sign-up and social sign-in - which on a
 * console taking public sign-ups would otherwise fetch the whole operator list
 * each time. Only `claimed` is cached: caching a negative would keep the gate
 * open on stale information, and 60s bounds how long a reset stays invisible.
 */
const CLAIMED_TTL_MS = 60_000;
const claimedUntil = new WeakMap<Fetcher, number>();

export async function consoleOwnerState(
	platform: App.Platform | undefined,
	origin: string
): Promise<ConsoleOwnerState> {
	const agent = requireAuthAgent(platform);

	const cached = claimedUntil.get(agent);
	if (cached !== undefined && cached > Date.now()) return 'claimed';

	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/overview'))
		.catch(() => null);
	if (!response || !response.ok) return 'unavailable';

	const body = await (response as unknown as Response).json().catch(() => null);
	const parsed = consoleOverviewSchema.safeParse(body);
	if (!parsed.success) return 'unavailable';

	if (parsed.data.users.length === 0) return 'unclaimed';

	claimedUntil.set(agent, Date.now() + CLAIMED_TTL_MS);
	return 'claimed';
}

/** Forgets the memo, so a reset is visible to the claim gate immediately. */
export function forgetConsoleOwnerState(platform: App.Platform | undefined): void {
	const agent = requireAuthAgent(platform);
	claimedUntil.delete(agent);
}

/**
 * Whether the console has been claimed, for callers that render the same thing
 * either way - the login page offers owner creation while this is false. The
 * claim gate uses `consoleOwnerState` instead: it is the caller whose answer
 * depends on WHY there is no owner.
 */
export async function consoleOwnerExists(
	platform: App.Platform | undefined,
	origin: string
): Promise<boolean> {
	return (await consoleOwnerState(platform, origin)) === 'claimed';
}
