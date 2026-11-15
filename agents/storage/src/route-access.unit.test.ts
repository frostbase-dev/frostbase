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
	// The manifest may carry a BOM; JSON.parse chokes on one. .href, then
	// fileURLToPath: the ambient URL here is workerd's, and a bare pathname
	// would lose the drive letter on Windows.
	readFileSync(
		fileURLToPath(new URL('../frostbase.agent.json', import.meta.url).href),
		'utf8',
	).replace(/^\uFEFF/, ''),
) as { routes: { path: string; access: string }[] };

test('the route table mirrors the manifest', () => {
	assert.deepEqual([...ROUTES], manifest.routes);
});

test('only the object paths are public', () => {
	assert.equal(routeAccess('/buckets/avatars/objects/a.png'), 'public');
	assert.equal(routeAccess('/buckets/avatars/objects'), 'public');
	assert.equal(routeAccess('/buckets'), 'public');
	assert.equal(routeAccess('/overview'), 'operator');
	assert.equal(routeAccess('/admin/buckets/avatars'), 'operator');
	assert.equal(routeAccess('/admin/buckets/avatars/objects/a.png'), 'operator');
	assert.equal(routeAccess('/'), 'operator');
	assert.equal(routeAccess('/whatever-comes-next'), 'operator');
});

const gate = (path: string, env: { EXPOSE_OPERATOR_API?: string } = {}) =>
	gateOperatorRoutes(new URL(`https://app.example${path}`), env);

test('a public Worker serves the object paths and nothing else', () => {
	assert.equal(gate('/agents/storage-agent/p1/buckets/avatars/objects/a.png'), null);
	assert.equal(gate('/agents/storage-agent/p1/buckets/avatars/objects'), null);
	for (const path of [
		'/agents/storage-agent/p1/overview',
		'/agents/storage-agent/p1/admin/buckets/avatars',
		'/agents/storage-agent/p1/admin/buckets/avatars/objects/a.png',
		'/agents/storage-agent/p1',
		'/internal/projects/p1',
	]) {
		assert.equal(gate(path)?.status, 404, path);
	}
});

test('encoded dot segments cannot cross into the operator plane', () => {
	// WHATWG URL resolves a bare %2e%2e segment BEFORE the gate reads the
	// path, so a spelling that climbs into /admin is classified AS /admin -
	// normalization first, classification second, no gap between them.
	assert.equal(
		gate('/agents/storage-agent/p1/buckets/a/%2e%2e/%2e%2e/admin/buckets/x')?.status,
		404,
	);
	// An encoded dot the URL parser does NOT resolve (an encoded slash keeps
	// it one segment) survives into the path - refused outright, never
	// classified, because something downstream might decode it.
	assert.equal(gate('/agents/storage-agent/p1/buckets/a/objects/%2E%2E%2fescape')?.status, 404);
});

test('the flag opens the surface for a control-plane-only Worker', () => {
	assert.equal(
		gate('/agents/storage-agent/p1/admin/buckets/avatars', { EXPOSE_OPERATOR_API: 'true' }),
		null,
	);
	assert.equal(gate('/internal/projects/p1', { EXPOSE_OPERATOR_API: 'true' }), null);
	assert.equal(
		gate('/agents/storage-agent/p1/overview', { EXPOSE_OPERATOR_API: '1' })?.status,
		404,
	);
});
