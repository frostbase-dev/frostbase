import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteConfig } from './remote-config-client.js';

/**
 * The client's job is to make config safe to read on the hot path of rendering.
 * So the tests that matter are the unhappy ones: an endpoint that is down, a
 * body that will not parse, a key nobody declared. Every one of them has to end
 * with the app holding usable values rather than an exception.
 */

type Answer = { status: number; body?: unknown; etag?: string };

/** A fetch stand-in that replays queued answers and records the requests. */
function fakeFetch(answers: Answer[]) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const impl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const answer = answers.shift() ?? { status: 500 };
		if (answer.status === 0) throw new Error('network down');
		return {
			status: answer.status,
			ok: answer.status >= 200 && answer.status < 300,
			headers: { get: (name: string) => (name === 'etag' ? (answer.etag ?? null) : null) },
			json: async () => answer.body,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

test('defaults answer before any fetch, and get never returns undefined', () => {
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		defaults: { checkoutV2: false, maxUploadMb: 25 },
		fetch: fakeFetch([]).impl,
	});
	assert.equal(config.get('checkoutV2'), false);
	assert.equal(config.get('maxUploadMb'), 25);
	assert.equal(config.isFetched, false);
	// A key nobody declared falls to the inline fallback rather than undefined:
	// this is read while rendering, and `undefined` there is a blank screen.
	assert.equal(config.get('neverHeardOf', 'safe'), 'safe');
	assert.deepEqual(config.getAll(), { checkoutV2: false, maxUploadMb: 25 });
});

test('fetched values win, and untouched defaults survive', async () => {
	const { impl } = fakeFetch([
		{ status: 200, body: { params: { checkoutV2: true }, fetchedAt: '2026-08-19T00:00:00.000Z' } },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		defaults: { checkoutV2: false, maxUploadMb: 25 },
		fetch: impl,
	});
	const result = await config.fetch();
	assert.deepEqual(result, { changed: true, failed: false });
	assert.equal(config.get('checkoutV2'), true);
	// The server said nothing about this one, so the default stands.
	assert.equal(config.get('maxUploadMb'), 25);
	assert.equal(config.isFetched, true);
	assert.equal(config.fetchedAt, '2026-08-19T00:00:00.000Z');
});

test('an unreachable endpoint reports failure and changes nothing', async () => {
	const { impl } = fakeFetch([
		{ status: 200, body: { params: { flag: 'live' } } },
		{ status: 0 },
		{ status: 500 },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		defaults: { flag: 'fallback' },
		fetch: impl,
	});
	await config.fetch();
	assert.equal(config.get('flag'), 'live');

	// A thrown network error must not propagate: a config fetch that rejects
	// turns a flag into a crash on launch.
	assert.deepEqual(await config.fetch(), { changed: false, failed: true });
	assert.equal(config.get('flag'), 'live');

	assert.deepEqual(await config.fetch(), { changed: false, failed: true });
	assert.equal(config.get('flag'), 'live');
});

test('a 200 that cannot be read is a failure, not an empty config', async () => {
	// Treating an unreadable body as `{}` would silently reset every flag to its
	// default - the loudest possible change, reported as success.
	const { impl } = fakeFetch([
		{ status: 200, body: { params: { flag: 'live' } } },
		{ status: 200, body: { nonsense: true } },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		defaults: { flag: 'fallback' },
		fetch: impl,
	});
	await config.fetch();
	assert.deepEqual(await config.fetch(), { changed: false, failed: true });
	assert.equal(config.get('flag'), 'live');
});

test('the etag is echoed, and a 304 is not a change', async () => {
	const { impl, calls } = fakeFetch([
		{ status: 200, body: { params: { flag: 1 } }, etag: '"abc"' },
		{ status: 304 },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		fetch: impl,
	});
	await config.fetch();
	assert.equal(calls[0].headers['if-none-match'], undefined);

	const second = await config.fetch();
	assert.equal(calls[1].headers['if-none-match'], '"abc"');
	assert.deepEqual(second, { changed: false, failed: false });
	assert.equal(config.get('flag'), 1);
});

test('a token identifies the caller, so uid is only sent without one', async () => {
	const withToken = fakeFetch([{ status: 200, body: { params: {} } }]);
	await createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		uid: 'install-1',
		appVersion: '2.1.0',
		getToken: () => 'jwt-here',
		fetch: withToken.impl,
	}).fetch();
	assert.equal(withToken.calls[0].headers.authorization, 'Bearer jwt-here');
	// Sending both would let the token subject and the uid disagree about who
	// this is.
	assert.equal(withToken.calls[0].url.includes('uid='), false);
	assert.equal(withToken.calls[0].url.includes('appVersion=2.1.0'), true);

	const anonymous = fakeFetch([{ status: 200, body: { params: {} } }]);
	await createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		uid: 'install-1',
		fetch: anonymous.impl,
	}).fetch();
	assert.equal(anonymous.calls[0].url.includes('uid=install-1'), true);
	assert.equal(anonymous.calls[0].headers.authorization, undefined);
});

test('subscribers hear real changes only', async () => {
	const { impl } = fakeFetch([
		{ status: 200, body: { params: { flag: 'a' } } },
		{ status: 200, body: { params: { flag: 'a' } } },
		{ status: 200, body: { params: { flag: 'b' } } },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		fetch: impl,
	});
	const seen: unknown[] = [];
	const stop = config.subscribe((values) => seen.push(values.flag));

	await config.fetch();
	// Same values again: a handler that fired here would make every poll look
	// like a config change.
	await config.fetch();
	await config.fetch();
	stop();

	assert.deepEqual(seen, ['a', 'b']);

	// After releasing, nothing more arrives.
	await config.fetch();
	assert.deepEqual(seen, ['a', 'b']);
});

test('a value structurally equal to the last one is not a change', async () => {
	const { impl } = fakeFetch([
		{ status: 200, body: { params: { theme: { mode: 'dark' } } } },
		{ status: 200, body: { params: { theme: { mode: 'dark' } } } },
	]);
	const config = createRemoteConfig({
		baseUrl: 'https://console.example/api/projects/p1/db',
		fetch: impl,
	});
	let fired = 0;
	config.subscribe(() => fired++);
	await config.fetch();
	await config.fetch();
	// A fresh object from JSON is never identity-equal to the last one, so
	// identity comparison would report a change on every single poll.
	assert.equal(fired, 1);
});
