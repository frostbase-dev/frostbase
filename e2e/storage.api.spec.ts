import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	ensureProject,
	registryProjectPath,
	STORAGE_PROJECT,
	storageAdminObjectPath,
	storageAdminObjectsPath,
	storageAdminSignedUrlsPath,
	storageBucketPath,
	storageBucketsPath,
	storageObjectPath,
	storageObjectsPath,
	storageOverviewPath,
	storageSignedUrlsPath,
	storageSigningRotatePath,
	uniqueEmail
} from './helpers';

/**
 * The storage agent end to end (S1): bucket
 * lifecycle through the operator proxy, object round trips on the direct
 * agent byte path, per-bucket access modes against real project JWTs, the
 * serve-time inline allowlist, key validation, caps, and erase-then-re-mint.
 *
 * Buckets use FIXED names (creates are idempotent upserts) so reused local
 * stacks never accumulate toward the 5-bucket cap - and the suite runs at
 * the DEFAULT cap on purpose (the cap test pins it), so bucket families are
 * spread across dedicated registered projects to stay under it: the shared
 * STORAGE_PROJECT holds the four core buckets, token-mode buckets live on
 * AUTHZ_PROJECT (which mints its own project users), write-rule buckets on
 * RULES_PROJECT, and the tenant-isolation test uses two projects of its own.
 * Access-mode buckets are created with their FINAL config up front - the
 * worker caches a bucket's config per isolate for ~30s, so a spec that
 * flipped modes mid-test would race that TTL.
 */

const run = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Token-mode buckets (spec-auth, spec-owner) - needs its own auth users. */
const AUTHZ_PROJECT = 'e2e-storage-authz';
/** Write-rule buckets (spec-imgs, spec-small) plus the transient spec-temp. */
const RULES_PROJECT = 'e2e-storage-rules';

/** A cookie-less context, so nothing leans on the console session. */
async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

/** Signs up a fresh user on the given project and exchanges the session
 * token for a project JWT - the db spec's exact flow. */
async function projectUserToken(
	baseURL: string | undefined,
	prefix: string,
	project: string
): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(project, 'sign-up/email'), {
			data: {
				name: 'Storage Spec User',
				email: uniqueEmail(prefix),
				password: 'storage-spec-password-1'
			}
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		expect(sessionToken, 'set-auth-token must be exposed for external clients').toBeTruthy();

		const token = await anon.get(authPath(project, 'token'), {
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		const { token: jwt } = await token.json();
		expect(jwt).toBeTruthy();
		return jwt;
	} finally {
		await anon.dispose();
	}
}

/** Create-or-update a bucket through the operator proxy; 200 and 201 are both
 * success (a reused stack already holds the row). */
async function ensureBucket(
	request: APIRequestContext,
	bucket: string,
	config: Record<string, unknown> = {},
	project: string = STORAGE_PROJECT
): Promise<void> {
	const response = await request.put(storageBucketPath(project, bucket), { data: config });
	expect([200, 201], await response.text().catch(() => '')).toContain(response.status());
}

test.describe('storage agent (S1)', () => {
	test.beforeAll(async ({ request }) => {
		await ensureProject(request, STORAGE_PROJECT);
		await ensureProject(request, AUTHZ_PROJECT);
		await ensureProject(request, RULES_PROJECT);
	});

	test('the overview reports a configured install, its buckets, and its caps', async ({
		request
	}) => {
		const response = await request.get(storageOverviewPath(STORAGE_PROJECT));
		expect(response.ok(), await response.text()).toBeTruthy();
		const overview = await response.json();
		expect(overview.projectId).toBe(STORAGE_PROJECT);
		// The e2e stack declares the R2 binding (miniflare simulator).
		expect(overview.configured).toBe(true);
		expect(overview.erasing).toBe(false);
		expect(overview.caps.maxBuckets).toBeGreaterThan(0);
		expect(Array.isArray(overview.buckets)).toBe(true);
	});

	test('bucket lifecycle: secure defaults, read back, config update', async ({ request }) => {
		const create = await request.put(storageBucketPath(STORAGE_PROJECT, 'spec-lifecycle'), {
			data: {}
		});
		expect([200, 201]).toContain(create.status());
		const created = (await create.json()).bucket;
		// Secure by default: never anonymous, never listable, no public modes.
		expect(created.read).toBe('auth');
		expect(created.write).toBe('auth');
		expect(created.publicListing).toBe(false);

		const update = await request.put(storageBucketPath(STORAGE_PROJECT, 'spec-lifecycle'), {
			data: { maxObjectBytes: 1024 }
		});
		expect(update.status(), await update.text()).toBe(200);
		// Omitted fields keep their stored value.
		const updated = (await update.json()).bucket;
		expect(updated.read).toBe('auth');
		expect(updated.maxObjectBytes).toBe(1024);

		const list = await request.get(storageBucketsPath(STORAGE_PROJECT));
		expect(list.ok()).toBeTruthy();
		const names = (await list.json()).buckets.map((bucket: { name: string }) => bucket.name);
		expect(names).toContain('spec-lifecycle');

		const single = await request.get(storageBucketPath(STORAGE_PROJECT, 'spec-lifecycle'));
		expect(single.ok()).toBeTruthy();
		expect((await single.json()).bucket.maxObjectBytes).toBe(1024);

		const invalid = await request.put(storageBucketPath(STORAGE_PROJECT, 'Bad_Name'), { data: {} });
		expect(invalid.status()).toBe(400);
	});

	test('a fresh bucket is private: anonymous object traffic answers 401', async ({
		request,
		baseURL
	}) => {
		await ensureBucket(request, 'spec-private');
		const anon = await anonymousContext(baseURL);
		try {
			const key = `${run}/secret.txt`;
			const put = await anon.put(storageObjectPath(STORAGE_PROJECT, 'spec-private', key), {
				data: 'nope',
				headers: { 'content-type': 'text/plain' }
			});
			expect(put.status(), await put.text()).toBe(401);
			const get = await anon.get(storageObjectPath(STORAGE_PROJECT, 'spec-private', key));
			expect(get.status()).toBe(401);
			const list = await anon.get(storageObjectsPath(STORAGE_PROJECT, 'spec-private'));
			expect(list.status()).toBe(401);
		} finally {
			await anon.dispose();
		}
	});

	test('the operator surface round-trips bytes whatever the modes say', async ({ request }) => {
		await ensureBucket(request, 'spec-private');
		const key = `${run}/operator/report.txt`;
		const body = `operator bytes ${run}`;

		const put = await request.put(storageAdminObjectPath(STORAGE_PROJECT, 'spec-private', key), {
			data: body,
			headers: { 'content-type': 'text/plain' }
		});
		expect(put.status(), await put.text()).toBe(200);
		const stored = (await put.json()).object;
		expect(stored.size).toBe(body.length);
		expect(stored.etag).toBeTruthy();

		const get = await request.get(storageAdminObjectPath(STORAGE_PROJECT, 'spec-private', key));
		expect(get.status()).toBe(200);
		expect(await get.text()).toBe(body);
		expect(get.headers()['x-content-type-options']).toBe('nosniff');
		// Operator reads are never publicly cacheable.
		expect(get.headers()['cache-control']).toContain('private');

		const list = await request.get(
			`${storageAdminObjectsPath(STORAGE_PROJECT, 'spec-private')}?prefix=${encodeURIComponent(`${run}/operator/`)}`
		);
		expect(list.status(), await list.text()).toBe(200);
		const page = await list.json();
		expect(page.total).toBe(1);
		expect(page.objects[0].key).toBe(key);

		const del = await request.delete(storageAdminObjectPath(STORAGE_PROJECT, 'spec-private', key));
		expect(del.status()).toBe(200);
		const gone = await request.get(storageAdminObjectPath(STORAGE_PROJECT, 'spec-private', key));
		expect(gone.status()).toBe(404);
	});

	test('a public bucket serves anonymous round trips; listing is a separate grant', async ({
		request,
		baseURL
	}) => {
		await ensureBucket(request, 'spec-public', { read: 'public', write: 'public' });
		await ensureBucket(request, 'spec-listable', {
			read: 'public',
			write: 'public',
			publicListing: true
		});
		const anon = await anonymousContext(baseURL);
		try {
			const key = `${run}/pixel.png`;
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
			const put = await anon.put(storageObjectPath(STORAGE_PROJECT, 'spec-public', key), {
				data: bytes,
				headers: { 'content-type': 'image/png' }
			});
			expect(put.status(), await put.text()).toBe(200);

			const get = await anon.get(storageObjectPath(STORAGE_PROJECT, 'spec-public', key));
			expect(get.status()).toBe(200);
			expect(Buffer.from(await get.body()).equals(bytes)).toBe(true);
			expect(get.headers()['content-type']).toBe('image/png');
			expect(get.headers()['content-disposition']).toBe('inline');
			expect(get.headers()['x-content-type-options']).toBe('nosniff');
			expect(get.headers()['cache-control']).toContain('public');
			const etag = get.headers()['etag'];
			expect(etag).toBeTruthy();

			// Conditionals and ranges are real: 304 on a matching etag, 206 on a
			// byte range.
			const conditional = await anon.get(storageObjectPath(STORAGE_PROJECT, 'spec-public', key), {
				headers: { 'if-none-match': etag }
			});
			expect(conditional.status()).toBe(304);
			const range = await anon.get(storageObjectPath(STORAGE_PROJECT, 'spec-public', key), {
				headers: { range: 'bytes=0-3' }
			});
			expect(range.status()).toBe(206);
			expect(Buffer.from(await range.body()).equals(bytes.subarray(0, 4))).toBe(true);
			expect(range.headers()['content-range']).toBe(`bytes 0-3/${bytes.length}`);

			// Serving one known key to anyone is not the same as enumerating
			// every key: public read does NOT imply public listing.
			const list = await anon.get(storageObjectsPath(STORAGE_PROJECT, 'spec-public'));
			expect(list.status()).toBe(403);

			const listableKey = `${run}/listed.txt`;
			await anon.put(storageObjectPath(STORAGE_PROJECT, 'spec-listable', listableKey), {
				data: 'listed',
				headers: { 'content-type': 'text/plain' }
			});
			const listable = await anon.get(
				`${storageObjectsPath(STORAGE_PROJECT, 'spec-listable')}?prefix=${encodeURIComponent(`${run}/`)}`
			);
			expect(listable.status(), await listable.text()).toBe(200);
			expect((await listable.json()).objects.map((o: { key: string }) => o.key)).toContain(
				listableKey
			);

			// Overwrites round-trip fresh bytes (the worker's colo cache is
			// purged). The query param is a DEV-ONLY cache buster: wrangler dev
			// puts a simulated edge cache in front of every worker's HTTP entry
			// (CF-Cache-Status: HIT), and through the web door that cache lives
			// in the WEB process where no storage-side purge can reach it -
			// production caches worker responses on neither door. The worker's
			// own cache keys on the bare path, so what this asserts is still the
			// real property: purge-then-fresh from the agent.
			const fresh = Buffer.from([9, 9, 9, 9]);
			await anon.put(storageObjectPath(STORAGE_PROJECT, 'spec-public', key), {
				data: fresh,
				headers: { 'content-type': 'image/png' }
			});
			const reread = await anon.get(
				`${storageObjectPath(STORAGE_PROJECT, 'spec-public', key)}?fresh=${run}`
			);
			expect(Buffer.from(await reread.body()).equals(fresh)).toBe(true);

			const del = await anon.delete(storageObjectPath(STORAGE_PROJECT, 'spec-public', key));
			expect(del.status()).toBe(200);
			expect(
				(
					await anon.get(`${storageObjectPath(STORAGE_PROJECT, 'spec-public', key)}?gone=${run}`)
				).status()
			).toBe(404);
		} finally {
			await anon.dispose();
		}
	});

	test('auth mode requires a project token end to end', async ({ request, baseURL }) => {
		await ensureBucket(request, 'spec-auth', {}, AUTHZ_PROJECT);
		const jwt = await projectUserToken(baseURL, 'storage-auth', AUTHZ_PROJECT);
		const anon = await anonymousContext(baseURL);
		try {
			const key = `${run}/gated.txt`;
			const tokenless = await anon.put(storageObjectPath(AUTHZ_PROJECT, 'spec-auth', key), {
				data: 'no token',
				headers: { 'content-type': 'text/plain' }
			});
			expect(tokenless.status()).toBe(401);

			const put = await anon.put(storageObjectPath(AUTHZ_PROJECT, 'spec-auth', key), {
				data: 'with token',
				headers: { 'content-type': 'text/plain', authorization: `Bearer ${jwt}` }
			});
			expect(put.status(), await put.text()).toBe(200);
			// The writer's subject is stamped as the owner.
			expect((await put.json()).object.owner).toBeTruthy();

			expect((await anon.get(storageObjectPath(AUTHZ_PROJECT, 'spec-auth', key))).status()).toBe(
				401
			);
			const read = await anon.get(storageObjectPath(AUTHZ_PROJECT, 'spec-auth', key), {
				headers: { authorization: `Bearer ${jwt}` }
			});
			expect(read.status()).toBe(200);
			expect(await read.text()).toBe('with token');

			const garbage = await anon.get(storageObjectPath(AUTHZ_PROJECT, 'spec-auth', key), {
				headers: { authorization: 'Bearer not-a-jwt' }
			});
			expect(garbage.status()).toBe(401);
		} finally {
			await anon.dispose();
		}
	});

	test('owner mode scopes reads, overwrites, and deletes to the token subject', async ({
		request,
		baseURL
	}) => {
		await ensureBucket(request, 'spec-owner', { read: 'owner', write: 'owner' }, AUTHZ_PROJECT);
		const jwtA = await projectUserToken(baseURL, 'storage-owner-a', AUTHZ_PROJECT);
		const jwtB = await projectUserToken(baseURL, 'storage-owner-b', AUTHZ_PROJECT);
		const anon = await anonymousContext(baseURL);
		try {
			const key = `${run}/mine.txt`;
			const put = await anon.put(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				data: 'owned by A',
				headers: { 'content-type': 'text/plain', authorization: `Bearer ${jwtA}` }
			});
			expect(put.status(), await put.text()).toBe(200);

			const mine = await anon.get(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				headers: { authorization: `Bearer ${jwtA}` }
			});
			expect(mine.status()).toBe(200);

			// Not-yours answers exactly like not-there - never a hint.
			const theirs = await anon.get(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				headers: { authorization: `Bearer ${jwtB}` }
			});
			expect(theirs.status()).toBe(404);

			// B cannot hijack A's key with an overwrite, and cannot delete it.
			const hijack = await anon.put(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				data: 'stolen',
				headers: { 'content-type': 'text/plain', authorization: `Bearer ${jwtB}` }
			});
			expect(hijack.status()).toBe(403);
			const theirDelete = await anon.delete(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				headers: { authorization: `Bearer ${jwtB}` }
			});
			expect(theirDelete.status()).toBe(404);

			// Owner-scoped listing: B sees only B's objects.
			const keyB = `${run}/theirs.txt`;
			await anon.put(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', keyB), {
				data: 'owned by B',
				headers: { 'content-type': 'text/plain', authorization: `Bearer ${jwtB}` }
			});
			const listB = await anon.get(
				`${storageObjectsPath(AUTHZ_PROJECT, 'spec-owner')}?prefix=${encodeURIComponent(`${run}/`)}`,
				{ headers: { authorization: `Bearer ${jwtB}` } }
			);
			expect(listB.status(), await listB.text()).toBe(200);
			const keysB = (await listB.json()).objects.map((o: { key: string }) => o.key);
			expect(keysB).toContain(keyB);
			expect(keysB).not.toContain(key);

			const del = await anon.delete(storageObjectPath(AUTHZ_PROJECT, 'spec-owner', key), {
				headers: { authorization: `Bearer ${jwtA}` }
			});
			expect(del.status()).toBe(200);
		} finally {
			await anon.dispose();
		}
	});

	test('the serve-time inline allowlist neutralises scriptable content', async ({
		request,
		baseURL
	}) => {
		await ensureBucket(request, 'spec-public', { read: 'public', write: 'public' });
		const anon = await anonymousContext(baseURL);
		try {
			const cases = [
				{ key: `${run}/page.html`, type: 'text/html', disposition: 'attachment' },
				{ key: `${run}/vector.svg`, type: 'image/svg+xml', disposition: 'attachment' },
				{ key: `${run}/feed.xml`, type: 'application/xml', disposition: 'attachment' },
				// Any +xml subtype renders as an XML document whatever its top-level
				// type, so an XHTML body behind a "video" label is still script.
				{ key: `${run}/clip.xhtml`, type: 'video/x+xml', disposition: 'attachment' },
				{ key: `${run}/track.xhtml`, type: 'audio/a+xml', disposition: 'attachment' },
				{ key: `${run}/clip.mp4`, type: 'video/mp4', disposition: 'inline' },
				{ key: `${run}/note.txt`, type: 'text/plain', disposition: 'inline' },
				{ key: `${run}/doc.pdf`, type: 'application/pdf', disposition: 'inline' }
			];
			for (const item of cases) {
				const put = await anon.put(storageObjectPath(STORAGE_PROJECT, 'spec-public', item.key), {
					data: '<script>alert(1)</script>',
					headers: { 'content-type': item.type }
				});
				expect(put.status(), `${item.key}: ${await put.text()}`).toBe(200);
				const get = await anon.get(storageObjectPath(STORAGE_PROJECT, 'spec-public', item.key));
				expect(get.status()).toBe(200);
				expect(get.headers()['content-disposition'], item.key).toBe(item.disposition);
				expect(get.headers()['x-content-type-options']).toBe('nosniff');
			}
		} finally {
			await anon.dispose();
		}
	});

	test('the write-time content-type allowlist refuses off-list uploads', async ({
		request,
		baseURL
	}) => {
		await ensureBucket(
			request,
			'spec-imgs',
			{ read: 'public', write: 'public', allowedContentTypes: ['image/*'] },
			RULES_PROJECT
		);
		const anon = await anonymousContext(baseURL);
		try {
			const refused = await anon.put(
				storageObjectPath(RULES_PROJECT, 'spec-imgs', `${run}/sneaky.html`),
				{ data: '<!doctype html>', headers: { 'content-type': 'text/html' } }
			);
			expect(refused.status()).toBe(415);
			const allowed = await anon.put(
				storageObjectPath(RULES_PROJECT, 'spec-imgs', `${run}/ok.png`),
				{ data: Buffer.from([1]), headers: { 'content-type': 'image/png' } }
			);
			expect(allowed.status(), await allowed.text()).toBe(200);
		} finally {
			await anon.dispose();
		}
	});

	test('object keys refuse traversal, empty segments, and control characters', async ({
		request
	}) => {
		await ensureBucket(request, 'spec-private');
		const base = storageAdminObjectsPath(STORAGE_PROJECT, 'spec-private');
		// Only spellings that SURVIVE URL normalization reach the worker - a
		// bare `%2e%2e` segment is resolved by the URL parser before any code
		// runs, inside the same bucket path (route-access.unit.test.ts pins
		// that it cannot climb into the operator plane either).
		for (const rawKey of ['%2e%2e%2fescape', 'a%2F..%2Fb', 'trailing%2f', 'nul%00byte']) {
			const response = await request.put(`${base}/${rawKey}`, {
				data: 'x',
				headers: { 'content-type': 'text/plain' }
			});
			expect([400, 404], `${rawKey} answered ${response.status()}`).toContain(response.status());
			expect(response.ok()).toBe(false);
		}

		// A literal empty segment is collapsed by the console origin's HTTP
		// stack BEFORE the agent classifies (SvelteKit rebuilds the URL), so
		// through this door `a//b` is a write to the normalized `a/b` - never
		// a stored empty segment, and never a traversal: the agent validates
		// whatever arrives, and the tenant prefix is composed from validated
		// parts. The strict refusal of the raw spelling is the agent door's
		// contract, pinned by keys.unit.test.ts.
		const collapsed = await request.put(`${base}/${run}/a//b`, {
			data: 'x',
			headers: { 'content-type': 'text/plain' }
		});
		expect(collapsed.status(), await collapsed.text()).toBe(200);
		expect((await collapsed.json()).object.key).toBe(`${run}/a/b`);
	});

	test('per-bucket object-size ceilings bite before a byte lands', async ({ request, baseURL }) => {
		await ensureBucket(
			request,
			'spec-small',
			{ read: 'public', write: 'public', maxObjectBytes: 10 },
			RULES_PROJECT
		);
		const anon = await anonymousContext(baseURL);
		try {
			const big = await anon.put(storageObjectPath(RULES_PROJECT, 'spec-small', `${run}/big.bin`), {
				data: Buffer.alloc(11, 1),
				headers: { 'content-type': 'application/octet-stream' }
			});
			expect(big.status()).toBe(413);
			const fits = await anon.put(
				storageObjectPath(RULES_PROJECT, 'spec-small', `${run}/fits.bin`),
				{ data: Buffer.alloc(10, 1), headers: { 'content-type': 'application/octet-stream' } }
			);
			expect(fits.status(), await fits.text()).toBe(200);
		} finally {
			await anon.dispose();
		}
	});

	test('deleting a bucket removes its objects and frees the name', async ({ request }) => {
		await ensureBucket(request, 'spec-temp', {}, RULES_PROJECT);
		const key = `${run}/doomed.txt`;
		const put = await request.put(storageAdminObjectPath(RULES_PROJECT, 'spec-temp', key), {
			data: 'doomed',
			headers: { 'content-type': 'text/plain' }
		});
		expect(put.status(), await put.text()).toBe(200);

		const del = await request.delete(storageBucketPath(RULES_PROJECT, 'spec-temp'));
		expect(del.status(), await del.text()).toBe(200);

		const list = await request.get(storageBucketsPath(RULES_PROJECT));
		const names = (await list.json()).buckets.map((bucket: { name: string }) => bucket.name);
		expect(names).not.toContain('spec-temp');

		// Recreating the name starts empty - the bytes died with the bucket.
		await ensureBucket(request, 'spec-temp', {}, RULES_PROJECT);
		const gone = await request.get(storageAdminObjectPath(RULES_PROJECT, 'spec-temp', key));
		expect(gone.status()).toBe(404);
		await request.delete(storageBucketPath(RULES_PROJECT, 'spec-temp'));
	});

	test('projects are limited to five buckets', async ({ request }) => {
		await ensureProject(request, 'e2e-storage-caps');
		for (let index = 1; index <= 5; index++) {
			const response = await request.put(
				`/api/projects/e2e-storage-caps/storage/admin/buckets/cap-${index}`,
				{ data: {} }
			);
			expect([200, 201], await response.text()).toContain(response.status());
		}
		const sixth = await request.put('/api/projects/e2e-storage-caps/storage/admin/buckets/cap-6', {
			data: {}
		});
		expect(sixth.status()).toBe(409);
	});

	test('tenant isolation: same bucket name and key, different projects, different bytes', async ({
		request,
		baseURL
	}) => {
		await ensureProject(request, 'e2e-storage-a');
		await ensureProject(request, 'e2e-storage-b');
		const key = `${run}/shared-name.txt`;
		for (const project of ['e2e-storage-a', 'e2e-storage-b']) {
			const create = await request.put(`/api/projects/${project}/storage/admin/buckets/files`, {
				data: { read: 'public', write: 'public' }
			});
			expect([200, 201], await create.text()).toContain(create.status());
		}
		const anon = await anonymousContext(baseURL);
		try {
			await anon.put(storageObjectPath('e2e-storage-a', 'files', key), {
				data: 'tenant A bytes',
				headers: { 'content-type': 'text/plain' }
			});
			await anon.put(storageObjectPath('e2e-storage-b', 'files', key), {
				data: 'tenant B bytes',
				headers: { 'content-type': 'text/plain' }
			});
			const readA = await anon.get(storageObjectPath('e2e-storage-a', 'files', key));
			const readB = await anon.get(storageObjectPath('e2e-storage-b', 'files', key));
			expect(await readA.text()).toBe('tenant A bytes');
			expect(await readB.text()).toBe('tenant B bytes');
		} finally {
			await anon.dispose();
		}
	});

	test('erase then re-mint: a recreated project id starts empty', async ({ request, baseURL }) => {
		const projectId = `e2e-storage-wipe-${run.slice(0, 8)}`;
		await ensureProject(request, projectId);
		const create = await request.put(`/api/projects/${projectId}/storage/admin/buckets/wiped`, {
			data: { read: 'public', write: 'public' }
		});
		expect([200, 201]).toContain(create.status());
		const key = `${run}/relic.txt`;
		const anon = await anonymousContext(baseURL);
		try {
			const put = await anon.put(storageObjectPath(projectId, 'wiped', key), {
				data: 'old tenant bytes',
				headers: { 'content-type': 'text/plain' }
			});
			expect(put.status(), await put.text()).toBe(200);

			const erase = await request.delete(registryProjectPath(projectId));
			expect(erase.ok(), await erase.text()).toBeTruthy();

			// Re-mint the id. Storage refuses writes with 503 until the R2 drain
			// confirms the prefix empty, so the new tenant polls its way in -
			// which is itself the pinned behavior: drain and tenant never
			// interleave.
			await ensureProject(request, projectId);
			await expect
				.poll(
					async () => {
						const recreate = await request.put(
							`/api/projects/${projectId}/storage/admin/buckets/wiped`,
							{ data: { read: 'public', write: 'public' } }
						);
						return recreate.status();
					},
					{ timeout: 30_000, message: 'bucket creation must succeed once the drain completes' }
				)
				.toBeLessThan(500);

			const relic = await request.get(storageAdminObjectPath(projectId, 'wiped', key));
			expect(relic.status(), 'the old tenant’s bytes must not survive the erase').toBe(404);
			const list = await request.get(storageAdminObjectsPath(projectId, 'wiped'));
			expect((await list.json()).total).toBe(0);
		} finally {
			await anon.dispose();
			await request.delete(registryProjectPath(projectId));
		}
	});

	test('demo projects get a read-only sample bucket, never a write surface', async ({
		baseURL
	}) => {
		const anon = await anonymousContext(baseURL);
		try {
			const demoId = 'demo-aaaaaaaaaaaa';

			// It reads, anonymously, with no project ever provisioned - the whole
			// answer is generated in the worker from bundled bytes.
			const overview = await anon.get(storageOverviewPath(demoId));
			expect(overview.status(), await overview.text()).toBe(200);
			const body = await overview.json();
			expect(body.demo).toBe(true);
			expect(body.buckets.map((bucket: { name: string }) => bucket.name)).toEqual(['samples']);

			const listed = await anon.get(
				`${storageObjectsPath(demoId, 'samples')}?delimiter=/&limit=50`
			);
			expect(listed.status()).toBe(200);
			const page = await listed.json();
			expect(page.objects.map((o: { key: string }) => o.key)).toContain('readme.txt');
			expect(page.folders.map((f: { prefix: string }) => f.prefix)).toEqual(['docs/', 'images/']);

			const file = await anon.get(storageObjectPath(demoId, 'samples', 'readme.txt'));
			expect(file.status()).toBe(200);
			expect(await file.text()).toContain('read-only sample bucket');
			// The real serve policy, not a shortcut around it.
			expect(file.headers()['x-content-type-options']).toBe('nosniff');
			expect(file.headers()['content-disposition']).toBe('inline');

			// But nothing can be written, minted, or configured.
			const put = await anon.put(storageObjectPath(demoId, 'samples', 'x.txt'), {
				data: 'x',
				headers: { 'content-type': 'text/plain' }
			});
			expect(put.status()).toBe(403);
			expect((await put.json()).demo).toBe(true);

			const del = await anon.delete(storageObjectPath(demoId, 'samples', 'readme.txt'));
			expect(del.status()).toBe(403);

			const signed = await anon.post(storageSignedUrlsPath(demoId, 'samples'), {
				data: { key: 'readme.txt' },
				headers: { 'content-type': 'application/json' }
			});
			expect(signed.status()).toBe(403);

			// And a bucket that is not the sample one does not exist.
			const other = await anon.get(storageObjectsPath(demoId, 'private'));
			expect(other.status()).toBe(404);
		} finally {
			await anon.dispose();
		}
	});

	/**
	 * The stack SERVES on cdn.frostbase.test (via the x-frostbase-host stand-in) but
	 * that host resolves nowhere, so it must never appear in anything handed to
	 * a caller. This is the e2e half of the routed-vs-set rule; the unit tests
	 * cover the routed branch, which no environment here can honestly stand up.
	 */
	test('an unrouted serving domain is served on but never advertised', async ({ request }) => {
		const overview = await request.get(storageOverviewPath(STORAGE_PROJECT));
		expect(overview.ok(), await overview.text()).toBeTruthy();
		const body = (await overview.json()) as { serveOrigin?: string | null };
		expect(body.serveOrigin ?? null).toBeNull();

		// And a minted URL falls back to the origin the request arrived on,
		// which is reachable by definition - the caller just used it.
		await ensureBucket(request, 'spec-public', { read: 'public', write: 'public' });
		const key = `${run}/advert.txt`;
		const seeded = await request.put(storageAdminObjectPath(STORAGE_PROJECT, 'spec-public', key), {
			data: 'bytes',
			headers: { 'content-type': 'text/plain' }
		});
		expect(seeded.status(), await seeded.text()).toBe(200);

		const minted = await request.post(storageAdminSignedUrlsPath(STORAGE_PROJECT, 'spec-public'), {
			data: { key, expiresIn: 300 }
		});
		expect(minted.ok(), await minted.text()).toBeTruthy();
		const { signedUrl } = (await minted.json()) as { signedUrl: string };
		expect(signedUrl).not.toContain('cdn.frostbase.test');

		// The proof that matters: the URL actually resolves and serves.
		const fetched = await request.get(signedUrl);
		expect(fetched.status(), await fetched.text()).toBe(200);
		expect(await fetched.text()).toBe('bytes');
	});

	test('the serving domain answers reads with the same enforcement', async ({ request }) => {
		test.skip(!!process.env.BASE_URL, 'direct agent access only exists on the local stack');
		await ensureBucket(request, 'spec-public', { read: 'public', write: 'public' });
		await ensureBucket(request, 'spec-private');
		const key = `${run}/cdn.txt`;
		const seeded = await request.put(storageAdminObjectPath(STORAGE_PROJECT, 'spec-public', key), {
			data: 'cdn bytes',
			headers: { 'content-type': 'text/plain' }
		});
		expect(seeded.status(), await seeded.text()).toBe(200);

		// No Origin header on purpose: a CDN <img>/download fetch carries none,
		// and the direct-dialled worker would refuse a foreign one. The empty
		// extraHTTPHeaders is load-bearing - inside the runner a bare
		// newContext INHERITS the api project's `origin` header, and the web
		// origin is foreign to the direct-dialled agent worker.
		const cdn = await playwrightRequest.newContext({
			baseURL: 'http://localhost:8801',
			extraHTTPHeaders: {}
		});
		try {
			const host = { 'x-frostbase-host': 'cdn.frostbase.test' };
			const get = await cdn.get(`/${STORAGE_PROJECT}/spec-public/${run}/cdn.txt`, {
				headers: host
			});
			expect(get.status(), await get.text()).toBe(200);
			expect(await get.text()).toBe('cdn bytes');
			expect(get.headers()['x-content-type-options']).toBe('nosniff');

			// Per-bucket modes hold on the serving domain too.
			const priv = await cdn.get(`/${STORAGE_PROJECT}/spec-private/anything.txt`, {
				headers: host
			});
			expect(priv.status()).toBe(401);

			// Read-only by design: the serving hostname takes no writes.
			const write = await cdn.put(`/${STORAGE_PROJECT}/spec-public/${run}/cdn.txt`, {
				data: 'nope',
				headers: { ...host, 'content-type': 'text/plain' }
			});
			expect(write.status()).toBe(405);
		} finally {
			await cdn.dispose();
		}
	});
});

/**
 * Signed download URLs (S2's first item).
 *
 * The claim under test is narrow and load-bearing: a URL minted by someone who
 * could read the object lets someone holding NO credential read exactly that
 * object, and nothing else. So every containment case below first proves the
 * signed URL is LIVE in the same context - a suite whose assertions all expect
 * a refusal is green on nothing (the service-key spec's lesson).
 */
test.describe('storage signed URLs (S2)', () => {
	const SIGN_PROJECT = 'e2e-storage-sign';
	const BUCKET = 'spec-signed';
	const KEY = 'reports/q3.txt';
	const BODY = 'signed bytes';

	/** No cookies, no bearer: a stranger holding nothing but a link. */
	async function stranger(baseURL: string | undefined): Promise<APIRequestContext> {
		const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
		return playwrightRequest.newContext({ baseURL: base });
	}

	async function mint(
		request: APIRequestContext,
		data: Record<string, unknown>
	): Promise<Record<string, string>> {
		const response = await request.post(storageAdminSignedUrlsPath(SIGN_PROJECT, BUCKET), { data });
		expect(response.status(), await response.text()).toBe(200);
		return response.json();
	}

	test.beforeAll(async ({ request }) => {
		await ensureProject(request, SIGN_PROJECT);
		// `auth` read mode: unreachable without a project JWT, which is exactly
		// the case a signed URL exists to serve.
		const bucket = await request.put(storageBucketPath(SIGN_PROJECT, BUCKET), {
			data: { read: 'auth', write: 'auth' }
		});
		expect([200, 201]).toContain(bucket.status());
		const put = await request.put(storageAdminObjectPath(SIGN_PROJECT, BUCKET, KEY), {
			data: BODY,
			headers: { 'content-type': 'text/plain' }
		});
		expect(put.ok(), await put.text()).toBeTruthy();
	});

	test('a signed URL reads a private object with no credential at all', async ({
		request,
		baseURL
	}) => {
		const minted = await mint(request, { key: KEY });
		expect(minted.signedUrl).toContain('sig=');
		expect(minted.method).toBe('GET');

		const anon = await stranger(baseURL);
		try {
			// The control: unsigned, this object is simply refused.
			const bare = await anon.get(storageObjectPath(SIGN_PROJECT, BUCKET, KEY));
			expect(bare.status(), 'the bucket must really be private').toBe(401);

			const signed = await anon.get(minted.signedUrl);
			expect(signed.status(), await signed.text()).toBe(200);
			expect(await signed.text()).toBe(BODY);
			// Never shared-cacheable: the cache key is path-only, so one cached
			// signed response would serve every later caller of that path.
			expect(signed.headers()['cache-control']).toContain('private');
			expect(signed.headers()['x-content-type-options']).toBe('nosniff');
		} finally {
			await anon.dispose();
		}
	});

	test('the signature covers the key, the project, and the expiry', async ({
		request,
		baseURL
	}) => {
		const minted = await mint(request, { key: KEY });
		const anon = await stranger(baseURL);
		try {
			expect((await anon.get(minted.signedUrl)).status(), 'live before tampering').toBe(200);
			const query = new URL(minted.signedUrl).search;

			// The same signature against a different key in the same bucket.
			const otherKey = storageObjectPath(SIGN_PROJECT, BUCKET, 'reports/q4.txt') + query;
			expect((await anon.get(otherKey)).status()).toBe(403);

			// And against another project's identically-named object.
			const otherProject = storageObjectPath('e2e-storage-sign-b', BUCKET, KEY) + query;
			expect([403, 404]).toContain((await anon.get(otherProject)).status());

			// A stretched expiry is not what was signed.
			const stretched = new URL(minted.signedUrl);
			stretched.searchParams.set('exp', String(Number(stretched.searchParams.get('exp')) + 86400));
			expect((await anon.get(stretched.toString())).status()).toBe(403);

			// A flipped signature character.
			const tampered = new URL(minted.signedUrl);
			const sig = String(tampered.searchParams.get('sig'));
			tampered.searchParams.set('sig', sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'));
			expect((await anon.get(tampered.toString())).status()).toBe(403);
		} finally {
			await anon.dispose();
		}
	});

	test('a signed URL expires', async ({ request, baseURL }) => {
		// 3s, not 1s: the pre-expiry assertion has to fit a mint round trip, a
		// context creation, and a GET inside the TTL, and at 1s a loaded runner
		// (or a worker reload) spends the whole budget before the first fetch -
		// which fails as "live before expiry", looking like a signing bug rather
		// than the timing artifact it is. The property is unchanged: live now,
		// refused after the expiry passes.
		const minted = await mint(request, { key: KEY, expiresIn: 3 });
		const anon = await stranger(baseURL);
		try {
			expect((await anon.get(minted.signedUrl)).status(), 'live before expiry').toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 3500));
			const expired = await anon.get(minted.signedUrl);
			expect(expired.status()).toBe(403);
			expect((await expired.json()).error).toContain('expired');
		} finally {
			await anon.dispose();
		}
	});

	test('a signed URL authorizes reads only, never writes', async ({ request, baseURL }) => {
		const minted = await mint(request, { key: KEY });
		const anon = await stranger(baseURL);
		try {
			expect((await anon.get(minted.signedUrl)).status(), 'live for reading').toBe(200);

			// The same URL used to write. A read signature must never read as
			// write authorization - uploads have their own protocol.
			const write = await anon.put(minted.signedUrl, {
				data: 'overwritten',
				headers: { 'content-type': 'text/plain' }
			});
			expect([401, 403]).toContain(write.status());
			expect([401, 403]).toContain((await anon.delete(minted.signedUrl)).status());

			// And the bytes are untouched.
			expect(await (await anon.get(minted.signedUrl)).text()).toBe(BODY);
		} finally {
			await anon.dispose();
		}
	});

	test('rotating the signing secret invalidates every outstanding URL', async ({
		request,
		baseURL
	}) => {
		const minted = await mint(request, { key: KEY });
		const anon = await stranger(baseURL);
		try {
			expect((await anon.get(minted.signedUrl)).status(), 'live before rotation').toBe(200);

			const rotate = await request.post(storageSigningRotatePath(SIGN_PROJECT));
			expect(rotate.status(), await rotate.text()).toBe(200);
			expect((await rotate.json()).rotated).toBe(true);

			// A URL minted from the NEW secret works at once, even though the
			// worker isolate is still caching the old one: the version it does
			// not hold is what makes it refetch.
			const fresh = await mint(request, { key: KEY });
			expect((await anon.get(fresh.signedUrl)).status(), await rotate.text()).toBe(200);

			// And that refetch is what retires the old URL. Revocation is bounded
			// by the isolate's access-cache TTL rather than instant - without the
			// fetch above, the pre-rotation URL keeps verifying against the stale
			// secret until that entry expires. Asserted the deterministic way
			// round, because sleeping out the TTL would be a flaky 30s.
			expect((await anon.get(minted.signedUrl)).status()).toBe(403);
		} finally {
			await anon.dispose();
		}
	});

	test('the batch form reports per-key outcomes instead of failing the call', async ({
		request
	}) => {
		const response = await request.post(storageAdminSignedUrlsPath(SIGN_PROJECT, BUCKET), {
			data: { keys: [KEY, 'reports/../escape.txt'] }
		});
		expect(response.status(), await response.text()).toBe(200);
		const { signedUrls } = await response.json();
		expect(signedUrls).toHaveLength(2);
		expect(signedUrls[0].signedUrl).toContain('sig=');
		expect(signedUrls[0].error).toBeNull();
		// Keys are validated, never repaired into something valid.
		expect(signedUrls[1].signedUrl).toBeNull();
		expect(signedUrls[1].error).toBeTruthy();
	});

	test('exactly one of key and keys is required', async ({ request }) => {
		for (const data of [{}, { key: KEY, keys: [KEY] }]) {
			const response = await request.post(storageAdminSignedUrlsPath(SIGN_PROJECT, BUCKET), {
				data
			});
			expect(response.status(), JSON.stringify(data)).toBe(400);
		}
	});

	test('minting requires what reading requires', async ({ baseURL }) => {
		const anon = await stranger(baseURL);
		try {
			// The public door on a private bucket: no token, no mint. Otherwise
			// anyone could mint their way straight past the read mode.
			const response = await anon.post(storageSignedUrlsPath(SIGN_PROJECT, BUCKET), {
				data: { key: KEY },
				headers: { 'content-type': 'application/json' }
			});
			expect(response.status(), await response.text()).toBe(401);
		} finally {
			await anon.dispose();
		}
	});

	test('forged versions are refused and never wedge the bucket (issue #72)', async ({
		request,
		baseURL
	}) => {
		// A version mismatch is what asks the single-threaded coordinator for a
		// fresh secret, and it is checked before the signature - so unthrottled,
		// each forged request bought a DO hop. The hop count is not observable
		// from out here (`mayRefetchForVersion` is unit-pinned for that); this
		// pins the wire contract the throttle must not have changed.
		const minted = await mint(request, { key: KEY });
		const anon = await stranger(baseURL);
		try {
			expect((await anon.get(minted.signedUrl)).status(), 'live before the burst').toBe(200);

			const url = new URL(minted.signedUrl);
			for (const version of ['0', '1', '9999999999', '4294967295']) {
				url.searchParams.set('v', version);
				const response = await anon.get(url.toString());
				expect(response.status(), `v=${version}`).toBe(403);
			}

			// Still healthy, and still bounded by the signature rather than by
			// the version: a good URL works, a tampered signature does not.
			expect((await anon.get(minted.signedUrl)).status(), 'live after the burst').toBe(200);
			const tampered = new URL(minted.signedUrl);
			tampered.searchParams.set('sig', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
			expect((await anon.get(tampered.toString())).status()).toBe(403);
		} finally {
			await anon.dispose();
		}
	});
});

/**
 * Folder listing (`delimiter=/`) - the shape a file browser and the client
 * SDK's `list()` both sit on. Object keys are flat strings; a "folder" is
 * derived at read time by collapsing everything below the next separator,
 * which is SQL arithmetic over `instr`/`substr` and therefore worth running
 * rather than reasoning about.
 */
test.describe('storage folder listing (S2)', () => {
	const FOLDER_PROJECT = 'e2e-storage-folders';
	const BUCKET = 'spec-folders';
	const KEYS = ['root.txt', 'docs/one.txt', 'docs/two.txt', 'docs/deep/three.txt', 'img/logo.png'];

	function list(
		request: APIRequestContext,
		query: Record<string, string> = {}
	): Promise<import('@playwright/test').APIResponse> {
		const search = new URLSearchParams(query).toString();
		const base = storageAdminObjectsPath(FOLDER_PROJECT, BUCKET);
		return request.get(search ? `${base}?${search}` : base);
	}

	test.beforeAll(async ({ request }) => {
		await ensureProject(request, FOLDER_PROJECT);
		const bucket = await request.put(storageBucketPath(FOLDER_PROJECT, BUCKET), { data: {} });
		expect([200, 201]).toContain(bucket.status());
		for (const key of KEYS) {
			const put = await request.put(storageAdminObjectPath(FOLDER_PROJECT, BUCKET, key), {
				data: `bytes for ${key}`,
				headers: { 'content-type': 'text/plain' }
			});
			expect(put.ok(), `${key}: ${await put.text()}`).toBeTruthy();
		}
	});

	test('no delimiter lists the whole subtree flat', async ({ request }) => {
		const response = await list(request);
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = await response.json();
		expect(body.objects.map((o: { key: string }) => o.key).sort()).toEqual([...KEYS].sort());
		// Flat listings have no notion of a folder at all.
		expect(body.folders).toBeUndefined();
	});

	test('delimiter=/ collapses everything below the next separator', async ({ request }) => {
		const response = await list(request, { delimiter: '/' });
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = await response.json();

		// Direct children only.
		expect(body.objects.map((o: { key: string }) => o.key)).toEqual(['root.txt']);
		expect(body.total).toBe(1);

		// Folders carry their trailing separator and count everything beneath
		// them at ANY depth - docs/ holds three, including docs/deep/three.txt.
		expect(body.folders).toEqual([
			{ prefix: 'docs/', objectCount: 3 },
			{ prefix: 'img/', objectCount: 1 }
		]);
		expect(body.foldersTruncated).toBe(false);
	});

	test('descending a folder re-collapses at the next level', async ({ request }) => {
		const response = await list(request, { prefix: 'docs/', delimiter: '/' });
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = await response.json();
		expect(body.objects.map((o: { key: string }) => o.key)).toEqual([
			'docs/one.txt',
			'docs/two.txt'
		]);
		expect(body.folders).toEqual([{ prefix: 'docs/deep/', objectCount: 1 }]);
	});

	test('a prefix that is not a folder boundary still works', async ({ request }) => {
		// `do` is a legitimate prefix even though no folder is named it.
		const response = await list(request, { prefix: 'do', delimiter: '/' });
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = await response.json();
		expect(body.objects).toEqual([]);
		expect(body.folders).toEqual([{ prefix: 'docs/', objectCount: 3 }]);
	});

	test('only / is accepted as a delimiter', async ({ request }) => {
		const response = await list(request, { delimiter: '|' });
		expect(response.status(), await response.text()).toBe(400);
	});

	test('reconcile rebuilds the index from a walk of R2', async ({ request }) => {
		// The escape hatch made concrete: the walk is what lets rows be dropped
		// and regenerated, which is how an index schema change or a reshard
		// would ever be survivable. Also the crash backstop.
		const response = await request.post(
			`/agents/storage-agent/${FOLDER_PROJECT}/admin/buckets/${BUCKET}/reconcile`
		);
		expect(response.status(), await response.text()).toBe(200);
		const result = await response.json();
		// Everything here was written through the normal path minutes ago, so a
		// healthy bucket reconciles to a no-op - and freshly-written objects sit
		// inside the grace window regardless.
		expect(result).toEqual({ adopted: 0, pruned: 0 });

		// The listing is unchanged by the walk.
		const listed = await list(request, { delimiter: '/' });
		expect((await listed.json()).objects.map((o: { key: string }) => o.key)).toEqual(['root.txt']);
	});
});
