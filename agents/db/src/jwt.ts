import * as Sentry from '@sentry/cloudflare';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { jwksResponseSchema, jwtClaimsSchema, type JwtClaims } from './schemas.js';

/**
 * Verifies auth-agent project JWTs without coupling the agents at runtime.
 *
 * Better Auth's jwt plugin signs with a per-project keypair (EdDSA by
 * default; operators can configure RS256/ES256) and serves the public keys
 * at /api/auth/jwks. Two acquisition paths cover both deployment shapes:
 *
 * 1. `AUTH_AGENT` (service binding) - this repo's multi-worker deployment.
 *    The auth worker has no public URL, so the fetch uses a synthetic host
 *    over the binding, the same idiom as the console's erase fan-out.
 * 2. `AuthAgent` (Durable Object namespace) - consumer single-worker
 *    installs, where `add auth` put the class in the same Worker. A Worker
 *    fetching its own hostname would trip recursion protection, so the
 *    namespace is the supported single-worker mechanism.
 *
 * Neither configured -> token verification reports `not-configured` and
 * token-gated collections fail closed with 503 (public mode is unaffected).
 *
 * Keys cache in DO storage for an hour; an unknown `kid` triggers one
 * refetch per minute at most, then the token is rejected.
 */

const JWKS_CACHE_KEY = 'jwks-cache';
const JWKS_REFETCH_KEY = 'jwks-refetch-at';
const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_INTERVAL_MS = 60 * 1000;
const ALLOWED_ALGS = ['EdDSA', 'RS256', 'ES256'];

interface JwksAuthEnv {
	AUTH_AGENT?: Fetcher;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AuthAgent?: DurableObjectNamespace<any>;
}

interface CachedJwks {
	keys: JWK[];
	fetchedAt: number;
}

export type VerifyResult =
	| { ok: true; claims: JwtClaims; exp: number | null }
	| { ok: false; code: 'not-configured' | 'invalid' };

export class ProjectJwtVerifier {
	/** Imported keys memoized per kid - cheap to rebuild after hibernation. */
	private imported = new Map<string, CryptoKey | Uint8Array>();

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly env: JwksAuthEnv,
		private readonly projectId: string,
	) {}

	get configured(): boolean {
		return Boolean(this.env.AUTH_AGENT || this.env.AuthAgent);
	}

	async verify(token: string): Promise<VerifyResult> {
		if (!this.configured) return { ok: false, code: 'not-configured' };

		try {
			const { payload } = await jwtVerify(
				token,
				async (header) => {
					const key = await this.resolveKey(header.kid, header.alg);
					if (!key) throw new Error(`no JWKS key for kid "${header.kid ?? ''}"`);
					return key;
				},
				{
					issuer: `cloudflarebase:${this.projectId}`,
					audience: this.projectId,
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

	private async resolveKey(
		kid: string | undefined,
		alg: string | undefined,
	): Promise<CryptoKey | Uint8Array | null> {
		const cacheId = kid ?? 'default';
		const memoized = this.imported.get(cacheId);
		if (memoized) return memoized;

		let jwk = this.pickKey(await this.cachedJwks(), kid);
		if (!jwk) {
			// Unknown kid: likely a rotation. One refetch, rate-limited so a
			// stream of garbage tokens cannot hammer the auth agent.
			const refreshed = await this.refetchJwks();
			jwk = this.pickKey(refreshed, kid);
		}
		if (!jwk) return null;

		const key = await importJWK(jwk, jwk.alg ?? alg);
		this.imported.set(cacheId, key);
		return key;
	}

	private pickKey(jwks: CachedJwks | null, kid: string | undefined): JWK | null {
		if (!jwks) return null;
		if (kid) return jwks.keys.find((key) => key.kid === kid) ?? null;
		return jwks.keys[0] ?? null;
	}

	private async cachedJwks(): Promise<CachedJwks | null> {
		const cached = await this.storage.get<CachedJwks>(JWKS_CACHE_KEY);
		if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached;
		return this.refetchJwks(cached ?? null);
	}

	private async refetchJwks(stale: CachedJwks | null = null): Promise<CachedJwks | null> {
		const lastAttempt = (await this.storage.get<number>(JWKS_REFETCH_KEY)) ?? 0;
		if (Date.now() - lastAttempt < REFETCH_MIN_INTERVAL_MS) return stale;
		await this.storage.put(JWKS_REFETCH_KEY, Date.now());

		try {
			const response = await this.fetchJwksResponse();
			if (!response?.ok) {
				// CANNOT VERIFY is not the same as "bad token", but both end up as
				// 401 at the caller - so without this every authenticated read and
				// write on every token-gated collection fails silently when the
				// auth agent is down or the binding is broken.
				this.reportJwksFailure(
					new Error(`JWKS request responded ${response?.status ?? 'without a binding'}`),
				);
				return stale;
			}
			const parsed = jwksResponseSchema.safeParse(await response.json());
			if (!parsed.success) {
				this.reportJwksFailure(new Error('JWKS response did not match the expected shape'));
				return stale;
			}

			const fresh: CachedJwks = { keys: parsed.data.keys as JWK[], fetchedAt: Date.now() };
			await this.storage.put(JWKS_CACHE_KEY, fresh);
			this.imported.clear();
			return fresh;
		} catch (error) {
			this.reportJwksFailure(error);
			return stale;
		}
	}

	/**
	 * A key-acquisition failure means tokens cannot be verified at all, which
	 * the caller can only express as 401. Rate-limited by the same refetch
	 * window above, so a storm of requests reports once a minute, not once per
	 * request.
	 */
	private reportJwksFailure(error: unknown): void {
		try {
			Sentry.captureException(error, {
				level: 'error',
				tags: { projectId: this.projectId, operation: 'jwks-fetch' },
				extra: { note: 'token verification is failing closed - every gated request 401s' },
			});
		} catch {
			// reporting must never break verification
		}
	}

	private fetchJwksResponse(): Promise<Response> | null {
		const url = `https://auth-agent/agents/auth-agent/${this.projectId}/api/auth/jwks`;
		if (this.env.AUTH_AGENT) {
			return this.env.AUTH_AGENT.fetch(url) as unknown as Promise<Response>;
		}
		if (this.env.AuthAgent) {
			// Instantiating get()/fetch() over DurableObjectNamespace<any> sends
			// tsc into unbounded recursion; the parameterless namespace type has
			// the same runtime shape without the explosion.
			const namespace = this.env.AuthAgent as unknown as DurableObjectNamespace;
			const stub = namespace.get(namespace.idFromName(this.projectId));
			return stub.fetch(url) as unknown as Promise<Response>;
		}
		return null;
	}
}
