import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	MAX_KEY_BYTES,
	parseObjectKey,
	r2BucketPrefix,
	r2ObjectKey,
	r2ProjectPrefix,
} from './keys.js';

test('accepts ordinary keys, nested paths, and unicode', () => {
	for (const key of [
		'avatar.png',
		'users/42/avatar.png',
		'deep/ly/nest/ed/file.bin',
		'no-extension',
		'名前.txt',
		'with space.txt',
		'0',
	]) {
		const result = parseObjectKey(key);
		assert.ok(result.ok, `expected "${key}" to be accepted`);
		assert.equal(result.ok && result.key, key);
	}
});

test('refuses traversal and structural abuse', () => {
	for (const key of [
		'',
		'/leading',
		'trailing/',
		'/',
		'a//b',
		'..',
		'.',
		'../escape',
		'a/../b',
		'a/..',
		'./a',
		'a/./b',
	]) {
		assert.ok(!parseObjectKey(key).ok, `expected "${key}" to be refused`);
	}
});

test('refuses control characters (header injection surface)', () => {
	for (const key of ['a\x00b', 'a\nb', 'a\rb', 'a\tb', 'a\x1fb', 'a\x7fb']) {
		assert.ok(!parseObjectKey(key).ok, `expected ${JSON.stringify(key)} to be refused`);
	}
});

test('enforces the prefixed-key byte budget', () => {
	assert.ok(parseObjectKey('a'.repeat(MAX_KEY_BYTES)).ok);
	assert.ok(!parseObjectKey('a'.repeat(MAX_KEY_BYTES + 1)).ok);
	// Multi-byte characters count in BYTES, not code points.
	const wide = 'é'.repeat(MAX_KEY_BYTES / 2 + 1); // 2 bytes each
	assert.ok(!parseObjectKey(wide).ok);
});

test('worst-case ids still compose under the R2 1024-byte ceiling', () => {
	const projectId = 'p'.repeat(48);
	const bucket = 'b'.repeat(63);
	const key = 'k'.repeat(MAX_KEY_BYTES);
	const composed = r2ObjectKey(projectId, bucket, key);
	assert.ok(new TextEncoder().encode(composed).length <= 1024);
});

test('prefixes nest: object under bucket under project', () => {
	assert.equal(r2ProjectPrefix('pid'), 'p/pid/');
	assert.equal(r2BucketPrefix('pid', 'avatars'), 'p/pid/avatars/');
	assert.ok(r2ObjectKey('pid', 'avatars', 'a.png').startsWith(r2BucketPrefix('pid', 'avatars')));
	assert.ok(r2BucketPrefix('pid', 'avatars').startsWith(r2ProjectPrefix('pid')));
});
