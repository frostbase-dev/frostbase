import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FORCED_REFETCH_COOLDOWN_MS,
	MAX_PART_SIZE,
	agentObjectUrl,
	publicServeOrigin,
	serveObjectPath,
	MIN_PART_SIZE,
	SIGNED_URL_MAX_TTL_SECONDS,
	hasSignedParams,
	mayRefetchForVersion,
	mintSecret,
	openUpload,
	parseSignedParams,
	partCount,
	resolvePartSize,
	resolveTtlSeconds,
	sealUpload,
	signSubject,
	signaturePayload,
	verifySignature,
	type SignatureSubject,
	type SigningSecret,
	type UploadEnvelope,
} from './signing.js';

const HELD: SigningSecret = { version: 3, secret: 'a'.repeat(64) };
const NOW = 1_760_000_000;
/** The refetch throttle works in milliseconds; signatures work in seconds. */
const NOW_MS = NOW * 1000;

const SUBJECT: Omit<SignatureSubject, 'expires'> = {
	projectId: 'proj-one',
	bucket: 'avatars',
	key: 'users/u1/photo.png',
	method: 'GET',
};

async function signedParamsFor(
	overrides: Partial<SignatureSubject> = {},
	secret = HELD,
): Promise<{ version: number; expires: number; signature: string }> {
	const expires = overrides.expires ?? NOW + 600;
	const signature = await signSubject(secret.secret, { ...SUBJECT, ...overrides, expires });
	return { version: secret.version, expires, signature };
}

test('a signature minted for a subject verifies for that subject', async () => {
	const params = await signedParamsFor();
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), { ok: true });
});

test('the payload is NUL-separated so no field can bleed into the next', () => {
	// `bucket` cannot contain a slash and keys cannot contain NUL, so the only
	// way these two could collide is a separator that appears in real data.
	const a = signaturePayload({ ...SUBJECT, bucket: 'a', key: 'b/c', expires: 1 });
	const b = signaturePayload({ ...SUBJECT, bucket: 'a/b', key: 'c', expires: 1 });
	assert.notEqual(a, b);
	assert.ok(a.includes('\0'));
});

test('every signed field is covered: changing any one breaks the signature', async () => {
	const params = await signedParamsFor();
	const tampered: Array<Partial<typeof SUBJECT>> = [
		{ projectId: 'proj-two' },
		{ bucket: 'private' },
		{ key: 'users/u2/photo.png' },
		{ method: 'HEAD' },
	];
	for (const change of tampered) {
		const verdict = await verifySignature(HELD, params, { ...SUBJECT, ...change }, NOW);
		assert.deepEqual(verdict, { ok: false, reason: 'mismatch' }, JSON.stringify(change));
	}
});

test('a tampered expiry does not verify, so a URL cannot extend itself', async () => {
	const params = await signedParamsFor();
	const verdict = await verifySignature(
		HELD,
		{ ...params, expires: params.expires + 86_400 },
		SUBJECT,
		NOW,
	);
	assert.deepEqual(verdict, { ok: false, reason: 'mismatch' });
});

test('expiry is enforced, and the boundary second is already expired', async () => {
	const params = await signedParamsFor({ expires: NOW });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'expired',
	});
});

test('a different secret at the same version does not verify', async () => {
	const params = await signedParamsFor({}, { version: 3, secret: 'b'.repeat(64) });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'mismatch',
	});
});

test('a version mismatch reports `version`, never `mismatch`', async () => {
	// The caller refetches on `version` and refuses on `mismatch`, so conflating
	// them turns a routine rotation into a hard failure for every live URL.
	const params = await signedParamsFor({}, { version: 2, secret: HELD.secret });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'version',
		version: 2,
		held: 3,
	});
});

test('a version mismatch reports BOTH versions, so the caller can compare them', async () => {
	// The worker refetches only when the requested version could be newer, and
	// must not parse the URL itself to find that out (issue #72).
	for (const version of [1, 2, 4, 9_999_999_999]) {
		const params = await signedParamsFor({}, { version, secret: HELD.secret });
		const verdict = await verifySignature(HELD, params, SUBJECT, NOW);
		assert.equal(verdict.ok, false);
		assert.equal(verdict.ok === false && verdict.reason, 'version');
		assert.deepEqual(
			verdict.ok === false && verdict.reason === 'version'
				? { version: verdict.version, held: verdict.held }
				: null,
			{ version, held: HELD.version },
		);
	}
});

test('a version below the held one never earns a coordinator hop', async () => {
	// Versions only ever increment, so a lower one cannot be a rotation this
	// isolate has yet to see - it is a retired secret or a forgery, and neither
	// is worth asking the single-threaded parent about (issue #72).
	for (const requested of [0, 1, 2, 3]) {
		assert.equal(mayRefetchForVersion(requested, 3, undefined, NOW_MS), false, `v=${requested}`);
	}
});

test('a version above the held one earns exactly one hop per cooldown', async () => {
	// The gate above bounds nothing on its own: a forged version can be
	// arbitrarily high. The cooldown is what turns a flood of distinct bogus
	// versions into one hop per bucket per window instead of one per request.
	assert.equal(mayRefetchForVersion(4, 3, undefined, NOW_MS), true, 'none forced yet');
	assert.equal(mayRefetchForVersion(9_999_999_999, 3, NOW_MS, NOW_MS), false, 'just forced one');
	assert.equal(
		mayRefetchForVersion(4, 3, NOW_MS - FORCED_REFETCH_COOLDOWN_MS + 1, NOW_MS),
		false,
		'inside the window',
	);
	assert.equal(
		mayRefetchForVersion(4, 3, NOW_MS - FORCED_REFETCH_COOLDOWN_MS, NOW_MS),
		true,
		'the boundary has elapsed',
	);
});

test('the FIRST mismatch an isolate sees always asks, which is the rotation case', async () => {
	// A URL is minted on the console origin and read on the CDN - different
	// isolates - so the serving isolate's first sight of a new version must not
	// be refused. Only a SECOND inside the window is, which is a flood's shape
	// and not a rotation's.
	assert.equal(mayRefetchForVersion(4, 3, undefined, NOW_MS), true);
	assert.equal(mayRefetchForVersion(4, 3, NOW_MS, NOW_MS), false);
	assert.equal(
		mayRefetchForVersion(4, 3, NOW_MS, NOW_MS + FORCED_REFETCH_COOLDOWN_MS),
		true,
		'and it converges after one window even under a flood',
	);
});

test('rotation invalidates outstanding URLs', async () => {
	const params = await signedParamsFor();
	const rotated: SigningSecret = { version: 4, secret: mintSecret() };
	const verdict = await verifySignature(rotated, params, SUBJECT, NOW);
	assert.equal(verdict.ok, false);
});

test('signed parameters parse only in their expected shapes', () => {
	const base = 'https://cdn.example.com/p/b/k';
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99&sig=abc`))?.expires, 99);
	// Missing any one of the three is not a signed URL.
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?exp=99&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&sig=abc`)), null);
	// Non-numeric or over-long fields are refused rather than coerced.
	assert.equal(parseSignedParams(new URL(`${base}?v=x&exp=99&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=9.5&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99&sig=a+b`)), null);
});

test('a request is only treated as signed when it carries a signature', () => {
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k')), false);
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k?v=1&exp=2')), false);
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k?sig=abc')), true);
});

test('expiry windows clamp into the allowed range', () => {
	assert.equal(resolveTtlSeconds(undefined), 3600);
	assert.equal(resolveTtlSeconds(60), 60);
	assert.equal(resolveTtlSeconds(0), 1);
	assert.equal(resolveTtlSeconds(-100), 1);
	assert.equal(resolveTtlSeconds(90.7), 90);
	// Capped rather than refused: a caller asking for a year gets seven days.
	assert.equal(resolveTtlSeconds(365 * 24 * 3600), SIGNED_URL_MAX_TTL_SECONDS);
});

test('minted secrets are 32 bytes of hex and do not repeat', () => {
	const first = mintSecret();
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.notEqual(first, mintSecret());
});

test('signatures are URL-safe, so the query string survives a round trip', async () => {
	const { signature } = await signedParamsFor();
	assert.match(signature, /^[A-Za-z0-9_-]+$/);
	const url = new URL(`https://cdn.example.com/p/b/k?sig=${signature}`);
	assert.equal(url.searchParams.get('sig'), signature);
});

// ---------------------------------------------------------------------------
// Multipart upload envelopes

const ENVELOPE: UploadEnvelope = {
	projectId: 'proj-one',
	bucket: 'uploads',
	key: 'video/raw.mp4',
	reservationId: 'res-1',
	r2UploadId: 'r2-upload-abc',
	partSize: 8 * 1024 * 1024,
	size: 40 * 1024 * 1024,
	contentType: 'video/mp4',
	owner: 'user-1',
	expires: NOW + 3600,
};

test('a sealed envelope opens to exactly what went in', async () => {
	const token = await sealUpload(HELD, ENVELOPE);
	const opened = await openUpload(HELD, token, NOW);
	assert.equal(opened.ok, true);
	assert.deepEqual(opened.ok && opened.envelope, ENVELOPE);
});

test('every envelope field is signed: editing the payload breaks the seal', async () => {
	const token = await sealUpload(HELD, ENVELOPE);
	const [version, body, signature] = token.split('.');
	const decoded = JSON.parse(
		Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
	) as UploadEnvelope;

	// The interesting forgery: point a valid envelope at another tenant.
	for (const change of [
		{ projectId: 'proj-two' },
		{ bucket: 'other' },
		{ key: 'video/someone-else.mp4' },
		{ partSize: 1024 },
		{ size: 5 },
		{ reservationId: 'res-2' },
		{ r2UploadId: 'r2-upload-xyz' },
		{ owner: 'user-2' },
		{ expires: NOW + 999_999 },
	]) {
		const forged = { ...decoded, ...change };
		const reencoded = Buffer.from(JSON.stringify(forged))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const verdict = await openUpload(HELD, `${version}.${reencoded}.${signature}`, NOW);
		assert.deepEqual(verdict, { ok: false, reason: 'mismatch' }, JSON.stringify(change));
	}
});

test('a NUL inside a field cannot re-slice the signed payload', async () => {
	// The signature covers the NUL-JOINED fields, so the join is only injective
	// while no field may contain the separator. A NUL smuggled into one field
	// makes the same signed bytes decode as different field values - here the
	// same payload re-sliced so `owner` becomes someone else. Both spellings
	// must be refused outright, not verified.
	const smuggled = { ...ENVELOPE, contentType: 'video/mp4\0forged-owner\0x', owner: 'y' };
	const resliced = { ...ENVELOPE, contentType: 'video/mp4', owner: 'forged-owner\0x\0y' };
	for (const envelope of [smuggled, resliced]) {
		const token = await sealUpload(HELD, envelope);
		const verdict = await openUpload(HELD, token, NOW);
		assert.deepEqual(verdict, { ok: false, reason: 'malformed' });
	}
});

test('an envelope with a missing or mistyped field is refused', async () => {
	const token = await sealUpload(HELD, ENVELOPE);
	const [version, , signature] = token.split('.');
	for (const broken of [
		{ ...ENVELOPE, contentType: 7 as unknown as string },
		{ ...ENVELOPE, owner: undefined as unknown as string },
	]) {
		const reencoded = Buffer.from(JSON.stringify(broken))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const verdict = await openUpload(HELD, `${version}.${reencoded}.${signature}`, NOW);
		assert.deepEqual(verdict, { ok: false, reason: 'malformed' });
	}
});

test('an upload envelope and a download signature cannot be swapped', async () => {
	// One secret signs both, so each payload names its own protocol. Without
	// the context label a value signed for one would verify as the other.
	const download = await signSubject(HELD.secret, { ...SUBJECT, expires: NOW + 600 });
	const verdict = await openUpload(HELD, `${HELD.version}.e30.${download}`, NOW);
	assert.equal(verdict.ok, false);
});

test('an expired envelope is refused, and reports why', async () => {
	const token = await sealUpload(HELD, { ...ENVELOPE, expires: NOW - 1 });
	assert.deepEqual(await openUpload(HELD, token, NOW), { ok: false, reason: 'expired' });
});

test('a rotated secret kills in-flight uploads along with URLs', async () => {
	const token = await sealUpload(HELD, ENVELOPE);
	const rotated: SigningSecret = { version: HELD.version + 1, secret: mintSecret() };
	assert.deepEqual(await openUpload(rotated, token, NOW), {
		ok: false,
		reason: 'version',
		version: HELD.version,
		held: rotated.version,
	});
});

test('malformed tokens are refused rather than throwing', async () => {
	for (const token of ['', 'a', 'a.b', 'a.b.c.d', 'x.e30.sig', '1.!!!.sig']) {
		const verdict = await openUpload(HELD, token, NOW);
		assert.equal(verdict.ok, false, token);
	}
});

test('part size is server-dictated, and the floor governs every legal size', () => {
	// Small files still get the floor: parts under R2's 5 MiB minimum cannot
	// be uploaded at all except as the last one.
	assert.equal(resolvePartSize(1024), MIN_PART_SIZE);
	assert.equal(resolvePartSize(100 * 1024 * 1024), MIN_PART_SIZE);

	// At the 5 GB multipart ceiling the floor STILL wins - 5 GB over 10,000
	// parts is only ~0.5 MiB each - so every legal upload runs at 8 MiB parts
	// and lands well inside the 10,000 limit. MAX_PART_SIZE is therefore
	// defensive rather than reachable: the size that would exceed it is ~80 GB,
	// far above what create() accepts. Worth knowing before anyone "optimizes"
	// the clamp away.
	const ceiling = 5 * 1024 * 1024 * 1024;
	assert.equal(resolvePartSize(ceiling), MIN_PART_SIZE);
	assert.equal(partCount(ceiling, MIN_PART_SIZE), 640);

	// The clamp still holds where it does apply.
	const huge = resolvePartSize(10_000 * MAX_PART_SIZE * 2);
	assert.equal(huge, MAX_PART_SIZE);
	assert.equal(huge % (1024 * 1024), 0, 'whole MiB');
});

test('part counts never round down, and never reach zero', () => {
	assert.equal(partCount(0, MIN_PART_SIZE), 1);
	assert.equal(partCount(1, MIN_PART_SIZE), 1);
	assert.equal(partCount(MIN_PART_SIZE, MIN_PART_SIZE), 1);
	assert.equal(partCount(MIN_PART_SIZE + 1, MIN_PART_SIZE), 2);
});

/**
 * Advertising a serving domain is a SEPARATE decision from serving on one.
 * This is the rule that keeps e2e's dead host - and production's, for the
 * fortnight it was set but unrouted - out of URLs handed to callers.
 */
test('a serving domain is only advertised once it is routed', () => {
	// Set but not routed: the shape local dev and the e2e stack run in, and
	// the shape production ran in until the custom domain was attached.
	assert.equal(publicServeOrigin({ STORAGE_SERVE_DOMAIN: 'cdn.frostbase.test' }), null);
	assert.equal(
		publicServeOrigin({
			STORAGE_SERVE_DOMAIN: 'cdn.frostbase.test',
			STORAGE_SERVE_DOMAIN_ROUTED: '',
		}),
		null,
	);
	// Only the exact string - a truthy-looking value is not a promise that DNS
	// exists, and getting this wrong mints URLs that resolve nowhere.
	assert.equal(
		publicServeOrigin({
			STORAGE_SERVE_DOMAIN: 'cdn.example.com',
			STORAGE_SERVE_DOMAIN_ROUTED: 'yes',
		}),
		null,
	);
	assert.equal(
		publicServeOrigin({
			STORAGE_SERVE_DOMAIN: 'cdn.example.com',
			STORAGE_SERVE_DOMAIN_ROUTED: 'true',
		}),
		'https://cdn.example.com',
	);
	// Routed with no domain is meaningless, not a crash.
	assert.equal(publicServeOrigin({ STORAGE_SERVE_DOMAIN_ROUTED: 'true' }), null);
	assert.equal(
		publicServeOrigin({ STORAGE_SERVE_DOMAIN: '   ', STORAGE_SERVE_DOMAIN_ROUTED: 'true' }),
		null,
	);
});

test('the two URL spellings address the same object, and neither leaks the R2 prefix', () => {
	const serve = serveObjectPath('proj', 'avatars', 'me.png');
	assert.equal(serve, '/proj/avatars/me.png');
	const agent = agentObjectUrl('https://console.example', 'proj', 'avatars', 'me.png');
	assert.equal(
		agent,
		'https://console.example/agents/storage-agent/proj/buckets/avatars/objects/me.png',
	);

	// `p/` is how the worker keys the object INSIDE the shared bucket - the
	// tenant boundary - and it must never appear in a URL, on either door.
	assert.ok(!serve.startsWith('/p/'));
	assert.ok(!agent.includes('/p/'));

	// Key separators stay separators; every segment is encoded individually,
	// so a folder path survives and a stray `?` or `#` cannot escape the path.
	assert.equal(serveObjectPath('proj', 'b', 'a/b/c.txt'), '/proj/b/a/b/c.txt');
	assert.equal(serveObjectPath('proj', 'b', 'a b?c.txt'), '/proj/b/a%20b%3Fc.txt');
});
