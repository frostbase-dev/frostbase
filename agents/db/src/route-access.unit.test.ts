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
	assert.deepEqual([...ROUTES], manifest.routes);
});

test('the customer data paths stay public', () => {
	assert.equal(routeAccess('/collections/orders/documents/1'), 'public');
	assert.equal(routeAccess('/collections/orders/subscribe'), 'public');
	assert.equal(routeAccess('/tables/users/sql'), 'public');
	assert.equal(routeAccess('/realtime'), 'public');
	assert.equal(routeAccess('/config'), 'public');
});

test('the operator plane is operator, declared or not', () => {
	assert.equal(routeAccess('/admin/query'), 'operator');
	assert.equal(routeAccess('/admin/collections/orders/import'), 'operator');
	assert.equal(routeAccess('/admin/tables/users/sql'), 'operator');
	assert.equal(routeAccess('/overview'), 'operator');
	// The SDK state-sync socket, and anything a later version adds.
	assert.equal(routeAccess('/'), 'operator');
	assert.equal(routeAccess('/whatever-comes-next'), 'operator');
	// A prefix must not match a longer sibling segment.
	assert.equal(routeAccess('/collections-export'), 'operator');
	assert.equal(routeAccess('/realtime-admin'), 'operator');
});

const gate = (path: string, env: { EXPOSE_OPERATOR_API?: string } = {}) =>
	gateOperatorRoutes(new URL(`https://app.example${path}`), env);

test('a public Worker serves the data paths and refuses the rest', () => {
	assert.equal(gate('/agents/db-agent/p1/collections/orders/query'), null);
	assert.equal(gate('/agents/db-agent/p1/tables/users/rows'), null);
	assert.equal(gate('/agents/db-agent/p1/realtime'), null);

	for (const path of [
		'/agents/db-agent/p1/admin/query',
		'/agents/db-agent/p1/admin/collections/orders/export',
		'/agents/db-agent/p1/overview',
		'/agents/db-agent/p1',
		'/internal/projects/p1',
	]) {
		assert.equal(gate(path)?.status, 404, path);
	}
});

test('a traversal cannot reach an operator route through a public prefix', () => {
	assert.equal(gate('/agents/db-agent/p1/collections/../admin/query')?.status, 404);
	assert.equal(gate('/agents/db-agent/p1/collections/%2e%2e/admin/query')?.status, 404);
});

test('the flag opens the operator plane for a control-plane-only Worker', () => {
	assert.equal(gate('/agents/db-agent/p1/admin/query', { EXPOSE_OPERATOR_API: 'true' }), null);
	assert.equal(gate('/internal/projects/p1', { EXPOSE_OPERATOR_API: 'true' }), null);
	assert.equal(gate('/agents/db-agent/p1/admin/query', { EXPOSE_OPERATOR_API: '1' })?.status, 404);
});
