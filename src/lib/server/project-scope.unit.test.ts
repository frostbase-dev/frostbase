import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsoleIdentity } from '../console';
import { mayReachUnownedProjects, operatorProjectScope } from './project-scope';

function identity(role: string, orgIds: string[]): ConsoleIdentity {
	return {
		user: {
			id: 'u1',
			email: 'u1@example.test',
			name: 'U1',
			role,
			emailVerified: true,
			image: null
		},
		activeOrganizationId: orgIds[0] ?? null,
		organizations: orgIds.map((id) => ({ id, name: id, slug: id, role: 'owner' })),
		pendingInvitations: []
	};
}

// On an open-signup console every stranger who registers is an operator, so
// an unowned row open to "any operator" is open to the internet.
test('a self-registered operator never reaches unowned projects', () => {
	for (const role of ['user', '', 'member', 'owner', 'Admin']) {
		assert.equal(mayReachUnownedProjects(identity(role, ['org-a'])), false, role);
	}
	assert.equal(mayReachUnownedProjects(null), false);
});

test('only the console admin reaches unowned projects', () => {
	assert.equal(mayReachUnownedProjects(identity('admin', [])), true);
});

test('an operator with no orgs gets an empty scope, never an unscoped one', () => {
	const scope = operatorProjectScope(identity('user', []));
	assert.deepEqual(scope, { orgIds: [], includeUnowned: false });
});

test('the scope carries the operator memberships, or an explicit override', () => {
	assert.deepEqual(operatorProjectScope(identity('user', ['org-a', 'org-b'])), {
		orgIds: ['org-a', 'org-b'],
		includeUnowned: false
	});
	assert.deepEqual(operatorProjectScope(identity('admin', ['org-a', 'org-b']), ['org-b']), {
		orgIds: ['org-b'],
		includeUnowned: true
	});
});
