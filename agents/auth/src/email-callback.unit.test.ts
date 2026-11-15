import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmailCallback } from './email-callback.js';

/**
 * The rewrite runs on every emailed auth link, and its input origin is an
 * attacker-writable header - anyone can curl the sign-up route with any
 * Origin. These tests hold the two safety rules: only an allowlisted origin
 * is ever used, and only a path that cannot re-anchor the URL is rewritten.
 */

const API = 'https://frostbase.dev';
const APP = 'https://app.example.com';
const TRUSTED = [APP, 'http://localhost:3000'];

function verifyLink(callback: string): string {
	return `${API}/api/projects/test-project/auth/verify-email?token=abc.def-ghi&callbackURL=${encodeURIComponent(callback)}`;
}

function requestFrom(origin?: string): Request {
	return new Request(`${API}/api/projects/test-project/auth/sign-up/email`, {
		method: 'POST',
		headers: origin ? { origin } : {},
	});
}

test('a relative callback resolves against the trusted requesting origin', () => {
	const out = new URL(resolveEmailCallback(verifyLink('/'), requestFrom(APP), TRUSTED));
	assert.equal(out.searchParams.get('callbackURL'), `${APP}/`);
	// The verification token must ride through the rewrite untouched.
	assert.equal(out.searchParams.get('token'), 'abc.def-ghi');
	assert.equal(out.origin + out.pathname, `${API}/api/projects/test-project/auth/verify-email`);
});

test('deep paths and their query strings survive the rewrite', () => {
	const out = new URL(
		resolveEmailCallback(verifyLink('/welcome?tab=account'), requestFrom(APP), TRUSTED),
	);
	assert.equal(out.searchParams.get('callbackURL'), `${APP}/welcome?tab=account`);
});

test('reset-password links (token in the path) rewrite the same way', () => {
	const url = `${API}/api/projects/test-project/auth/reset-password/tok123?callbackURL=%2Freset`;
	const out = new URL(resolveEmailCallback(url, requestFrom(APP), TRUSTED));
	assert.equal(out.searchParams.get('callbackURL'), `${APP}/reset`);
	assert.match(out.pathname, /\/reset-password\/tok123$/);
});

test('an origin not on the allowlist changes nothing', () => {
	const url = verifyLink('/');
	assert.equal(resolveEmailCallback(url, requestFrom('https://evil.example.com'), TRUSTED), url);
});

test('a missing Origin header or missing request changes nothing', () => {
	const url = verifyLink('/');
	assert.equal(resolveEmailCallback(url, requestFrom(), TRUSTED), url);
	assert.equal(resolveEmailCallback(url, undefined, TRUSTED), url);
});

test('a same-origin caller keeps its relative callback', () => {
	// The console signs users up against its own origin; '/login' must stay
	// relative there even when the deployment origin appears in the list.
	const url = verifyLink('/login');
	assert.equal(resolveEmailCallback(url, requestFrom(API), [API, ...TRUSTED]), url);
});

test('escaping "relative" paths are never rewritten', () => {
	// //host and /\host re-anchor the URL to another origin when a browser
	// resolves them; concatenating a trusted origin in front would launder
	// them into an absolute URL that passes the verify-time origin check.
	for (const escape of ['//evil.example.com', '/\\evil.example.com']) {
		const url = verifyLink(escape);
		assert.equal(resolveEmailCallback(url, requestFrom(APP), TRUSTED), url);
	}
});

test('an already-absolute callback is left for the verify-time check', () => {
	const url = verifyLink('https://elsewhere.example.com/done');
	assert.equal(resolveEmailCallback(url, requestFrom(APP), TRUSTED), url);
});

test('a link without a callbackURL param, or unparseable, passes through', () => {
	const bare = `${API}/api/projects/test-project/auth/verify-email?token=abc`;
	assert.equal(resolveEmailCallback(bare, requestFrom(APP), TRUSTED), bare);
	assert.equal(resolveEmailCallback('not a url', requestFrom(APP), TRUSTED), 'not a url');
});
