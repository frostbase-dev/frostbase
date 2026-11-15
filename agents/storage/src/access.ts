import { verifyProjectJwt, type VerifyResult } from './jwt.js';
import type { AccessMode } from './schemas.js';

/**
 * The per-request access gate and CORS policy for the object paths - the db
 * agent's `access.ts` contract (a copy, not an import: the cross-project ban
 * stands), adapted to the stateless worker:
 *
 * - `public` mode: straight through, no token looked at.
 * - `none`: refused before the token is looked at - see below.
 * - `auth`/`owner`: Bearer token required (401 without), verified against
 *   the project JWKS (401 invalid, 503 when verification is unconfigured),
 *   then the optional permission key is checked - a VALID token lacking the
 *   key gets 403, distinct from the tokenless 401.
 * - `owner` resolves to the token's subject; the object paths compare it to
 *   the `owner` custom metadata on the stored object.
 */

export type AccessDecision =
	{ ok: true; owner: string | null; subject: string | null } | { ok: false; response: Response };

export function hasPermission(required: string | null, claimed: string[] | undefined): boolean {
	if (!required) return true;
	if (!claimed?.length) return false;
	return claimed.includes('*') || claimed.includes(required);
}

export async function checkAccess(
	request: Request,
	env: { AUTH_AGENT?: Fetcher; AuthAgent?: DurableObjectNamespace },
	projectId: string,
	mode: AccessMode,
	permission: string | null,
): Promise<AccessDecision> {
	const header = request.headers.get('authorization');
	const token = header?.match(/^Bearer (.+)$/i)?.[1];

	// 403 rather than 401, and before the token is verified: no token would
	// work, so asking for one would be a lie - and a 401 sends a client into a
	// sign-in loop it can never satisfy.
	//
	// Signed URLs stay coherent with this. VERIFYING one bypasses the read mode
	// by design (that is what a capability is) and never reaches this gate, but
	// MINTING one on the public path passes `config.read` through here - so on a
	// `read: 'none'` bucket only the admin mirror can mint, and a client cannot
	// hand itself the capability the mode just refused.
	if (mode === 'none') {
		return {
			ok: false,
			response: Response.json(
				{ error: 'that operation is closed on the public API - it is operator-only' },
				{ status: 403 },
			),
		};
	}

	if (mode === 'public') {
		// A public bucket still resolves a VALID token's subject so writes can
		// stamp an owner; an absent or bad token is simply anonymous here.
		if (token) {
			const result = await verifyProjectJwt(env, projectId, token);
			if (result.ok) return { ok: true, owner: null, subject: result.claims.sub };
		}
		return { ok: true, owner: null, subject: null };
	}

	if (!token) {
		return {
			ok: false,
			response: Response.json({ error: 'a project token is required' }, { status: 401 }),
		};
	}

	const result: VerifyResult = await verifyProjectJwt(env, projectId, token);
	if (!result.ok) {
		if (result.code === 'not-configured') {
			return {
				ok: false,
				response: Response.json({ error: 'auth verification is not configured' }, { status: 503 }),
			};
		}
		return {
			ok: false,
			response: Response.json({ error: 'invalid or expired token' }, { status: 401 }),
		};
	}

	// 403, not 401: the token is valid, it just lacks the right.
	if (!hasPermission(permission, result.claims.permissions)) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'the token does not carry the required permission' },
				{ status: 403 },
			),
		};
	}

	return {
		ok: true,
		owner: mode === 'owner' ? result.claims.sub : null,
		subject: result.claims.sub,
	};
}

/**
 * Exact-origin CORS echo over the deployment's own origin and environment
 * TRUSTED_ORIGINS - null means the origin is untrusted (callers answer 403
 * for browser requests carrying one). Per-project allowed origins arrive
 * with the client SDK; env-level trust covers S1.
 */
export function corsHeadersFor(
	request: Request,
	trustedOriginsVar: string | undefined,
): Headers | null {
	const origin = request.headers.get('origin');
	const sameOrigin = origin === new URL(request.url).origin;
	const trusted = (trustedOriginsVar ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!origin || (!sameOrigin && !trusted.includes(origin))) return null;
	return new Headers({
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'true',
		'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
		'access-control-allow-headers':
			'authorization, content-type, if-match, if-none-match, if-modified-since, range',
		'access-control-expose-headers': 'etag, content-range, accept-ranges',
		vary: 'Origin',
	});
}

/** Apply CORS to a routed response without mutating the original. */
export function withCors(response: Response, cors: Headers | null): Response {
	if (!cors) return response;
	const headers = new Headers(response.headers);
	cors.forEach((value, key) => headers.set(key, value));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Cancel an unread request body before a response goes out. A body-bearing
 * request answered without its body consumed wedges workerd ("Can't read
 * from request stream after response has been sent"). Bodies on the object
 * paths can be 100 MB, so CANCEL, never consume - not the db agent's
 * JSON-sized read.
 */
export async function drainUnusedBody(request: Request): Promise<void> {
	try {
		if (request.body && !request.bodyUsed) await request.body.cancel();
	} catch {
		// draining is belt-and-braces, never a failure
	}
}
