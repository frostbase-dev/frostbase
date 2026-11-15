import type { ProjectJwtVerifier } from './jwt.js';
import { hasPermission } from './rules.js';
import type { AccessMode } from './schemas.js';

/**
 * The access gate and CORS policy shared by DbCollection and DbTable -
 * extracted (not copied) so the two engines can never drift on who gets in.
 * Behavior is exactly the collection v1 gate:
 *
 * - `public` mode: straight through, no token looked at.
 * - `none`: refused before the token is looked at - see below.
 * - `auth`/`owner`: Bearer token required (401 without), verified against
 *   the project JWKS (401 invalid, 503 when verification is unconfigured),
 *   then the optional permission key is checked - a VALID token lacking the
 *   key gets 403, distinct from the tokenless 401.
 * - `owner` resolves to the token's subject, scoping every read and write.
 */

export type AccessDecision = { ok: true; owner: string | null } | { ok: false; response: Response };

export async function checkAccess(
	request: Request,
	mode: AccessMode,
	permission: string | null,
	verifier: ProjectJwtVerifier,
): Promise<AccessDecision> {
	if (mode === 'public') return { ok: true, owner: null };

	// 403 rather than 401, and BEFORE the token is read: no token would work,
	// so asking for one would be a lie - and a 401 sends a client into a
	// sign-in loop it can never satisfy. The operator surfaces (admin routes,
	// service keys, the admin SDK) never reach this gate, so `none` closes the
	// public plane without closing the shard.
	if (mode === 'none') {
		return {
			ok: false,
			response: Response.json(
				{ error: 'that operation is closed on the public API - it is operator-only' },
				{ status: 403 },
			),
		};
	}

	const header = request.headers.get('authorization');
	const token = header?.match(/^Bearer (.+)$/i)?.[1];
	if (!token) {
		return {
			ok: false,
			response: Response.json({ error: 'a project token is required' }, { status: 401 }),
		};
	}

	const result = await verifier.verify(token);
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

	return { ok: true, owner: mode === 'owner' ? result.claims.sub : null };
}

/**
 * Exact-origin CORS echo over the deployment's own origin, environment
 * TRUSTED_ORIGINS, and the project's allowed origins - null means the origin
 * is untrusted (callers answer 403 for browser requests carrying one).
 */
export function corsHeadersFor(
	request: Request,
	trustedOriginsVar: string | undefined,
	allowedOrigins: string[],
): Headers | null {
	const origin = request.headers.get('origin');
	const sameOrigin = origin === new URL(request.url).origin;
	const trusted = [
		...(trustedOriginsVar ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean),
		...allowedOrigins,
	];
	if (!origin || (!sameOrigin && !trusted.includes(origin))) return null;
	return new Headers({
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'true',
		'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'access-control-allow-headers': 'authorization, content-type',
		vary: 'Origin',
	});
}

/**
 * Cancel an unread request body before a response goes out. A body-bearing
 * request forwarded to a Durable Object stub whose handler answers WITHOUT
 * reading the body (a 404 fallthrough, an auth refusal) crashes workerd with
 * an uncaught "Can't read from request stream after response has been sent"
 * that wedges the whole instance - reproduced against wrangler 4.115. Every
 * DO fetch/onRequest path drains through this before returning.
 */
export async function drainUnusedBody(request: Request): Promise<void> {
	if (request.body && !request.bodyUsed) {
		try {
			// CONSUME rather than cancel: cancelling races the runtime's own
			// body pipe and still detonates; a full read completes it. Bodies
			// on these surfaces are JSON far below platform caps.
			await request.arrayBuffer();
		} catch {
			// locked or already consumed - nothing to drain
		}
	}
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
