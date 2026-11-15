import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAccess } from './access.js';
import type { ProjectJwtVerifier } from './jwt.js';
import type { AccessMode } from './schemas.js';

/**
 * The shared gate. `access.ts` is EXTRACTED, not copied - DbCollection and
 * DbTable both call this one function - so a mode's behavior only has to be
 * pinned once, and pinning it here is what stops the two engines drifting on
 * who gets in.
 *
 * The `none` cases are the ones with teeth: the whole point of the mode is
 * that a VALID token carrying every permission still does not open the shard,
 * which is a property that fails silently if it ever regresses. A read-only
 * collection whose gate quietly started accepting tokens would look completely
 * normal until someone rewrote your feature flags.
 */

/** A verifier that accepts anything, so a refusal can only come from the mode. */
const acceptAll: ProjectJwtVerifier = {
	verify: async () => ({
		ok: true as const,
		claims: { sub: 'user-1', permissions: ['*'] },
	}),
} as unknown as ProjectJwtVerifier;

/** A verifier that must never be consulted; calling it fails the test. */
const neverCalled: ProjectJwtVerifier = {
	verify: async () => {
		assert.fail('the gate verified a token it should have refused without looking');
	},
} as unknown as ProjectJwtVerifier;

function request(token?: string): Request {
	return new Request('https://agent.example/collections/flags/documents', {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

async function decide(
	mode: AccessMode,
	options: { token?: string; permission?: string | null; verifier?: ProjectJwtVerifier } = {},
) {
	const decision = await checkAccess(
		request(options.token),
		mode,
		options.permission ?? null,
		options.verifier ?? acceptAll,
	);
	return decision.ok
		? { ok: true as const, owner: decision.owner }
		: { ok: false as const, status: decision.response.status };
}

test('public lets anyone through without looking at a token', async () => {
	assert.deepEqual(await decide('public', { verifier: neverCalled }), { ok: true, owner: null });
});

test('auth demands a token, then admits a valid one', async () => {
	assert.deepEqual(await decide('auth', { verifier: neverCalled }), { ok: false, status: 401 });
	assert.deepEqual(await decide('auth', { token: 'good' }), { ok: true, owner: null });
});

test('owner resolves the token subject so reads and writes can be scoped', async () => {
	assert.deepEqual(await decide('owner', { token: 'good' }), { ok: true, owner: 'user-1' });
});

test('none refuses a request carrying no token at all', async () => {
	// 403 and not 401: a 401 advertises that some token would work, which sends
	// a client into a sign-in loop it can never satisfy.
	assert.deepEqual(await decide('none', { verifier: neverCalled }), { ok: false, status: 403 });
});

test('none refuses a VALID token carrying every permission', async () => {
	// The property the mode exists for. `acceptAll` verifies anything and claims
	// `*`, so the only thing that can produce a refusal here is the mode itself.
	assert.deepEqual(await decide('none', { token: 'good', verifier: neverCalled }), {
		ok: false,
		status: 403,
	});
	assert.deepEqual(
		await decide('none', { token: 'good', permission: 'flags:write', verifier: neverCalled }),
		{ ok: false, status: 403 },
	);
});

test('none never reaches the verifier', async () => {
	// `neverCalled` above already asserts this, but state it as its own case:
	// refusing BEFORE verification is why a closed shard costs no JWKS fetch and
	// cannot be used as an oracle for whether a token is valid.
	await decide('none', { token: 'anything at all', verifier: neverCalled });
});

test('a valid token still needs the permission key on auth and owner', async () => {
	const noPermissions = {
		verify: async () => ({ ok: true as const, claims: { sub: 'user-1', permissions: [] } }),
	} as unknown as ProjectJwtVerifier;
	// 403 here means "valid token, wrong rights" - the same status `none`
	// answers, and deliberately so: both are authorization failures, not
	// authentication ones.
	assert.deepEqual(
		await decide('auth', { token: 'good', permission: 'flags:write', verifier: noPermissions }),
		{ ok: false, status: 403 },
	);
});

test('an unverifiable token is 401, an unconfigured project 503', async () => {
	const rejects = {
		verify: async () => ({ ok: false as const, code: 'invalid' as const }),
	} as unknown as ProjectJwtVerifier;
	const unconfigured = {
		verify: async () => ({ ok: false as const, code: 'not-configured' as const }),
	} as unknown as ProjectJwtVerifier;
	assert.deepEqual(await decide('auth', { token: 'bad', verifier: rejects }), {
		ok: false,
		status: 401,
	});
	assert.deepEqual(await decide('auth', { token: 'good', verifier: unconfigured }), {
		ok: false,
		status: 503,
	});
});
