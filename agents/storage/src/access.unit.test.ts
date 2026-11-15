import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAccess, hasPermission } from './access.js';
import type { AccessMode } from './schemas.js';

/**
 * This gate is a COPY of the db agent's, so the modes must behave identically
 * or the two drift - which is exactly the failure the copy invites. The `none`
 * cases mirror `agents/db/src/access.unit.test.ts` case for case.
 *
 * `none` is refused before `verifyProjectJwt` is reached, so these tests need
 * no env at all: an empty one would explode on any path that got as far as
 * verification, which makes it the assertion rather than a gap.
 */

const NO_ENV = {} as { AUTH_AGENT?: Fetcher; AuthAgent?: DurableObjectNamespace };

function request(token?: string): Request {
	return new Request('https://agent.example/buckets/assets/objects/logo.png', {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

async function decide(mode: AccessMode, token?: string, permission: string | null = null) {
	const decision = await checkAccess(request(token), NO_ENV, 'p1', mode, permission);
	return decision.ok
		? { ok: true as const, owner: decision.owner, subject: decision.subject }
		: { ok: false as const, status: decision.response.status };
}

test('public admits an anonymous caller with no subject', async () => {
	assert.deepEqual(await decide('public'), { ok: true, owner: null, subject: null });
});

test('auth refuses a caller with no token', async () => {
	assert.deepEqual(await decide('auth'), { ok: false, status: 401 });
});

test('none refuses an anonymous caller with 403, not 401', async () => {
	assert.deepEqual(await decide('none'), { ok: false, status: 403 });
});

test('none refuses a token-bearing caller without verifying the token', async () => {
	// Reaching verification with NO_ENV would fail differently (or throw), so a
	// clean 403 is the proof that the mode short-circuits ahead of it. That is
	// what keeps a closed bucket from costing a JWKS fetch per probe - and from
	// answering differently for a valid token than a garbage one, which would
	// make it a token oracle.
	assert.deepEqual(await decide('none', 'a.valid.looking.token'), { ok: false, status: 403 });
	assert.deepEqual(await decide('none', 'garbage'), { ok: false, status: 403 });
	assert.deepEqual(await decide('none', 'a.valid.looking.token', 'files:read'), {
		ok: false,
		status: 403,
	});
});

test('the permission helper matches the auth agent grammar', () => {
	assert.equal(hasPermission(null, undefined), true);
	assert.equal(hasPermission('files:read', undefined), false);
	assert.equal(hasPermission('files:read', ['files:read']), true);
	assert.equal(hasPermission('files:read', ['*']), true);
	assert.equal(hasPermission('files:read', ['files:write']), false);
});
