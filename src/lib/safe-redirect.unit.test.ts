import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movedLocation, safeNext } from './safe-redirect';

/** What a browser does with a Location header relative to the console. */
function browserTarget(location: string): string {
	return new URL(location, 'https://frostbase.dev/login').host;
}

test('safeNext refuses every spelling that leaves the origin', () => {
	for (const value of [
		'//evil.example',
		'/\\evil.example',
		'/\\/evil.example',
		'\\\\evil.example',
		'/%5Cevil.example'.replace('%5C', '\\'),
		'https://evil.example',
		'javascript:alert(1)',
		'/\tevil',
		'/\nevil',
		'evil.example',
		'',
		null
	]) {
		const next = safeNext(value);
		assert.equal(next, '/dashboard', JSON.stringify(value));
	}
});

test('safeNext keeps same-origin paths, query and hash intact', () => {
	for (const [value, expected] of [
		['/dashboard/e2e-seed', '/dashboard/e2e-seed'],
		['/cli-auth?port=4123&code=abc', '/cli-auth?port=4123&code=abc'],
		['/dashboard#members', '/dashboard#members'],
		['/a/../dashboard', '/dashboard']
	] as const) {
		const next = safeNext(value);
		assert.equal(next, expected, value);
		assert.equal(browserTarget(next), 'frostbase.dev', value);
	}
});

test('movedLocation never leaves the canonical origin', () => {
	for (const pathname of ['//evil.example/x', '///evil.example', '/\\evil.example', '/']) {
		const location = movedLocation(pathname, '', 'https://frostbase.dev');
		assert.equal(browserTarget(location), 'frostbase.dev', pathname);
	}
});

test('movedLocation keeps the path and query', () => {
	assert.equal(
		movedLocation('/docs/db', '?tab=sql', 'https://frostbase.dev'),
		'https://frostbase.dev/docs/db?tab=sql'
	);
	assert.equal(movedLocation('/', '', 'https://frostbase.dev/'), 'https://frostbase.dev/');
});
