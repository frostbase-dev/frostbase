import * as Sentry from '@sentry/cloudflare';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { jwksResponseSchema, jwtClaimsSchema, type JwtClaims } from './schemas.js';

/**
 * Verifies auth-agent project JWTs without coupling the agents at runtime -
 * a COPY of agents/db/src/jwt.ts (the cross-project import ban stands),
 * adapted for the STATELESS worker: the object paths run in the worker, not
 * a Durable Object, so the JWKS cache is per isolate rather than DO storage.
 * Same acquisition paths, same TTLs, same fail-closed semantics:
 *
 * 1. `AUTH_AGENT` (service binding) - this repo's multi-worker deployment.
 * 2. `AuthAgent` (Durable Object namespace) - consumer single-worker installs.
 *
 * Neither configured -> verification reports `not-configured` and token-gated
 * buckets fail closed with 503 (public mode is unaffected).
 */

const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_INTERVAL_MS = 60 * 1000;
const ALLOWED_ALGS = ['EdDSA', 'RS256', 'ES256'];
/** Isolate caches are cheap but not free; bound the tenant map. */
const MAX_CACHED_PROJECTS = 5000;

interface JwksAuthEnv {
	AUTH_AGENT?: Fetcher;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AuthAgent?: DurableObjectNamespace<any>;
}

interface ProjectJwksCache {
	keys: JWK[];
	fetchedAt: number;
	lastAttemptAt: number;
	imported: Map<string, CryptoKey | Uint8Array>;
}

const jwksByProject = new Map<string, ProjectJwksCache>();

export type VerifyResult =
	| { ok: true; claims: JwtClaims; exp: number | null }
	| { ok: false; code: 'not-configured' | 'invalid' };

export function jwtConfigured(env: JwksAuthEnv): boolean {
	return Boolean(env.AUTH_AGENT || env.AuthAgent);
}

export async function verifyProjectJwt(
	env: JwksAuthEnv,
	projectId: string,
	token: string,
): Promise<VerifyResult> {
	if (!jwtConfigured(env)) return { ok: false, code: 'not-configured' };

	try {
		const { payload } = await jwtVerify(
			token,
			async (header) => {
				const key = await resolveKey(env, projectId, header.kid, header.alg);
				if (!key) throw new Error(`no JWKS key for kid "${header.kid ?? ''}"`);
				return key;
			},
			{
				issuer: `cloudflarebase:${projectId}`,
				audience: projectId,
				algorithms: ALLOWED_ALGS,
			},
		);
		const claims = jwtClaimsSchema.safeParse(payload);
		if (!claims.success) return { ok: false, code: 'invalid' };
		return { ok: true, claims: claims.data, exp: payload.exp ?? null };
	} catch {
		return { ok: false, code: 'invalid' };
	}
}

async function resolveKey(
	env: JwksAuthEnv,
	projectId: string,
	kid: string | undefined,
	alg: string | undefined,
): Promise<CryptoKey | Uint8Array | null> {
	let cache = jwksByProject.get(projectId);
	const cacheId = kid ?? 'default';
	const memoized = cache?.imported.get(cacheId);
	if (memoized && cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS) return memoized;

	if (!cache || Date.now() - cache.fetchedAt >= JWKS_TTL_MS) {
		cache = (await refetchJwks(env, projectId, cache ?? null)) ?? cache;
	}
	let jwk = pickKey(cache, kid);
	if (!jwk) {
		// Unknown kid: likely a rotation. One refetch, rate-limited so a stream
		// of garbage tokens cannot hammer the auth agent.
		cache = (await refetchJwks(env, projectId, cache ?? null)) ?? cache;
		jwk = pickKey(cache, kid);
	}
	if (!jwk || !cache) return null;

	const key = await importJWK(jwk, jwk.alg ?? alg);
	cache.imported.set(cacheId, key);
	return key;
}

function pickKey(cache: ProjectJwksCache | null | undefined, kid: string | undefined): JWK | null {
	if (!cache) return null;
	if (kid) return cache.keys.find((key) => key.kid === kid) ?? null;
	return cache.keys[0] ?? null;
}

async function refetchJwks(
	env: JwksAuthEnv,
	projectId: string,
	stale: ProjectJwksCache | null,
): Promise<ProjectJwksCache | null> {
	if (stale && Date.now() - stale.lastAttemptAt < REFETCH_MIN_INTERVAL_MS) return stale;
	if (stale) stale.lastAttemptAt = Date.now();

	try {
		const response = await fetchJwksResponse(env, projectId);
		if (!response?.ok) {
			// CANNOT VERIFY is not the same as "bad token", but both end up as
			// 401 at the caller - report so a broken binding is not silent.
			reportJwksFailure(
				projectId,
				new Error(`JWKS request responded ${response?.status ?? 'without a binding'}`),
			);
			return stale;
		}
		const parsed = jwksResponseSchema.safeParse(await response.json());
		if (!parsed.success) {
			reportJwksFailure(projectId, new Error('JWKS response did not match the expected shape'));
			return stale;
		}

		if (jwksByProject.size >= MAX_CACHED_PROJECTS) jwksByProject.clear();
		const fresh: ProjectJwksCache = {
			keys: parsed.data.keys as JWK[],
			fetchedAt: Date.now(),
			lastAttemptAt: Date.now(),
			imported: new Map(),
		};
		jwksByProject.set(projectId, fresh);
		return fresh;
	} catch (error) {
		reportJwksFailure(projectId, error);
		return stale;
	}
}

/** Rate-limited by the refetch window above: once a minute, not per request. */
function reportJwksFailure(projectId: string, error: unknown): void {
	try {
		Sentry.captureException(error, {
			level: 'error',
			tags: { projectId, operation: 'jwks-fetch' },
			extra: { note: 'token verification is failing closed - every gated request 401s' },
		});
	} catch {
		// reporting must never break verification
	}
}

function fetchJwksResponse(env: JwksAuthEnv, projectId: string): Promise<Response> | null {
	const url = `https://auth-agent/agents/auth-agent/${encodeURIComponent(projectId)}/api/auth/jwks`;
	if (env.AUTH_AGENT) {
		return env.AUTH_AGENT.fetch(url) as unknown as Promise<Response>;
	}
	if (env.AuthAgent) {
		// Instantiating get()/fetch() over DurableObjectNamespace<any> sends
		// tsc into unbounded recursion; the parameterless namespace type has
		// the same runtime shape without the explosion.
		const namespace = env.AuthAgent as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName(projectId));
		return stub.fetch(url) as unknown as Promise<Response>;
	}
	return null;
}
