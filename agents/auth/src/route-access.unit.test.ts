import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ROUTES, gateOperatorRoutes, routeAccess } from './route-access.js';

/**
 * The gate only ever runs in deployments we do not operate (a consumer's
 * public Worker, where `EXPOSE_OPERATOR_API` is unset), so nothing in the
 * e2e stack exercises it - every environment we run sets the flag and the
 * gate is a no-op. These tests are the coverage for the other shape.
 */

const manifest = JSON.parse(
	// The manifest is written with a BOM; JSON.parse chokes on one.
	// .href, then fileURLToPath: the ambient URL here is workerd's, which is
	// not assignable to node:fs's PathOrFileDescriptor, and a bare pathname
	// would lose the drive letter on Windows.
	readFileSync(
		fileURLToPath(new URL('../frostbase.agent.json', import.meta.url).href),
		'utf8',
	).replace(/^\uFEFF/, ''),
) as { routes: { path: string; access: string }[] };

test('the route table mirrors the manifest', () => {
	// The manifest is the declaration the console guard and the CLI read;
	// this copy is what the runtime can reach. Drift closes a public route
	// (loud) rather than opening an operator one, but it should not drift.
	assert.deepEqual([...ROUTES], manifest.routes);
});

test('declared public routes are public, prefixes included', () => {
	assert.equal(routeAccess('/config'), 'public');
	assert.equal(routeAccess('/api/auth'), 'public');
	assert.equal(routeAccess('/api/auth/sign-in/email'), 'public');
	assert.equal(routeAccess('/api/auth/jwks'), 'public');
});

test('everything else is operator, declared or not', () => {
	assert.equal(routeAccess('/admin/users'), 'operator');
	assert.equal(routeAccess('/admin'), 'operator');
	assert.equal(routeAccess('/overview'), 'operator');
	assert.equal(routeAccess('/analytics'), 'operator');
	assert.equal(routeAccess('/chat'), 'operator');
	// Undeclared: the console/me lookup and the SDK state-sync socket.
	assert.equal(routeAccess('/console/me'), 'operator');
	assert.equal(routeAccess('/'), 'operator');
	// A prefix must not match a longer sibling segment.
	assert.equal(routeAccess('/config-dump'), 'operator');
	assert.equal(routeAccess('/api/authorize'), 'operator');
});

const gate = (path: string, env: { EXPOSE_OPERATOR_API?: string } = {}) =>
	gateOperatorRoutes(new URL(`https://app.example${path}`), env);

test('a public Worker serves public routes and refuses the rest', () => {
	assert.equal(gate('/agents/auth-agent/p1/api/auth/sign-in/email'), null);
	assert.equal(gate('/agents/auth-agent/p1/config'), null);

	for (const path of [
		'/agents/auth-agent/p1/admin/users',
		'/agents/auth-agent/p1/admin/roles',
		'/agents/auth-agent/p1/overview',
		'/agents/auth-agent/p1/analytics',
		'/agents/auth-agent/p1/console/me',
		'/agents/auth-agent/p1',
		'/internal/projects/p1',
		'/fleet/overview',
	]) {
		assert.equal(gate(path)?.status, 404, path);
	}
});

test('a traversal cannot reach an operator route through a public prefix', () => {
	// The URL parser normalizes before the gate reads the path, so the
	// classification runs on what the agent will actually dispatch on.
	assert.equal(gate('/agents/auth-agent/p1/api/auth/../admin/users')?.status, 404);
	assert.equal(gate('/agents/auth-agent/p1/api/auth/%2e%2e/admin/users')?.status, 404);
});

test('the flag opens the operator plane for a control-plane-only Worker', () => {
	assert.equal(gate('/agents/auth-agent/p1/admin/users', { EXPOSE_OPERATOR_API: 'true' }), null);
	assert.equal(gate('/internal/projects/p1', { EXPOSE_OPERATOR_API: 'true' }), null);
	// Only the exact string - a truthy-looking value is not an opt-in.
	assert.equal(
		gate('/agents/auth-agent/p1/admin/users', { EXPOSE_OPERATOR_API: '1' })?.status,
		404,
	);
});
