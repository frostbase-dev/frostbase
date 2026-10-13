import { expect, test } from '@playwright/test';
import {
	authPath,
	configPath,
	dbAdminCollectionPath,
	dbAdminTablePath,
	dbDocumentsPath,
	dbQueryPath,
	dbRowsPath,
	dbTableQueryPath,
	overviewPath,
	settingsPath,
	uniqueEmail
} from './helpers';

/**
 * A demo project has to be a real, working backend - everything the dashboard's
 * Integration tab tells a visitor to paste must actually run against it, with
 * no account and no operator session. The demo's ceilings (user cap, daily AI
 * cap, no outbound mail, self-erasure) exist to bound cost and abuse, and none
 * of them may cost the visitor the thing they came to try.
 *
 * These tests run unauthenticated on purpose.
 */
const DEMO_PROJECT = `demo-${'a1b2c3d4e5f6a7b8c9d0'}`;

test.describe('demo project', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('serves the full REST auth flow the integration guide advertises', async ({ request }) => {
		const email = uniqueEmail('demo-rest');
		const password = 'demo-rest-password-1';
		const base = (endpoint: string) => authPath(DEMO_PROJECT, endpoint);

		// 1. Sign up - the first snippet on the Integration tab.
		const signUp = await request.post(base('sign-up/email'), {
			data: { name: 'Demo Visitor', email, password }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();

		// 2. Bearer token for clients that are not same-origin, which is what the
		// snippet reads off the response for external apps.
		const token = signUp.headers()['set-auth-token'];
		expect(token, 'set-auth-token must be exposed for external clients').toBeTruthy();

		// 3. Read the session back with that token alone.
		const session = await request.get(base('get-session'), {
			headers: { authorization: `Bearer ${token}` }
		});
		expect(session.ok()).toBeTruthy();
		const body = await session.json();
		expect(body.user.email).toBe(email);

		// 4. Sign in again with the credentials, as a returning user would.
		const signIn = await request.post(base('sign-in/email'), { data: { email, password } });
		expect(signIn.ok(), await signIn.text()).toBeTruthy();
	});

	test('guest sign-in works for demo projects', async ({ request }) => {
		// Better Auth requires the JSON content type even on a bodyless POST.
		const guest = await request.post(authPath(DEMO_PROJECT, 'sign-in/anonymous'), { data: {} });
		expect(guest.ok(), await guest.text()).toBeTruthy();
	});

	test('exposes its public client config', async ({ request }) => {
		const config = await request.get(configPath(DEMO_PROJECT));
		expect(config.ok()).toBeTruthy();

		const body = await config.json();
		expect(body.projectId).toBe(DEMO_PROJECT);
		expect(body.providers).toContain('email-password');
		expect(body.bearerTokens).toBe(true);
	});

	test('a visitor can drive the console for their own demo project', async ({ request }) => {
		// No operator session: the demo bypass has to cover the dashboard reads
		// and the settings write, or the Integration tab's "add your origin"
		// step would be impossible for the visitor it is written for.
		const overview = await request.get(overviewPath(DEMO_PROJECT));
		expect(overview.ok()).toBeTruthy();

		const settings = await request.put(settingsPath(DEMO_PROJECT), {
			data: { allowedOrigins: ['https://demo-visitor.example.com'] }
		});
		expect(settings.ok(), await settings.text()).toBeTruthy();
	});

	test('the first REST touch of a brand-new project auto-creates, never 503s', async ({
		request
	}) => {
		// Regression: the collection's lazy config pull used a raw namespace
		// stub, which bypasses the SDK's fetch-path initialization - so a parent
		// DbAgent that had never been woken over HTTP had no schema yet, the
		// pull died on "no such table: collections", and EVERY first REST touch
		// of a fresh project answered a persistent 503. Every other test here
		// provisions through the admin surface first (which wakes the parent
		// over HTTP), which is exactly why this path went uncovered. A unique
		// id per run keeps this a genuine first touch.
		const fresh = `demo-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const write = await request.post(dbDocumentsPath(fresh, 'posts'), {
			data: { data: { title: 'first touch' } }
		});
		// Default collection access is 'auth', so the correct answer to an
		// anonymous write is an auth refusal - which proves the config pull and
		// the auto-create both ran. The bug's signature is a 503.
		expect(write.status(), await write.text()).toBe(401);
	});

	test('serves the demo database flow without an operator', async ({ request }) => {
		// The Database snippets must run for the anonymous visitor too: the demo
		// bypass covers the admin surface (creating the collection), and the
		// collection then serves plain unauthenticated CRUD through the proxy.
		const provision = await request.put(dbAdminCollectionPath(DEMO_PROJECT, 'notes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// The demo project id is fixed, so a unique marker keeps documents from
		// earlier reused-stack runs out of the assertion.
		const marker = `demo-db-${Date.now()}`;
		const created = await request.post(dbDocumentsPath(DEMO_PROJECT, 'notes'), {
			data: { data: { title: 'hello from the demo', marker } }
		});
		expect(created.status(), await created.text()).toBe(201);
		const doc = await created.json();

		// Replication defaults to auto for demo projects too - the demo IS the
		// pitch - so the write answers with a session bookmark, and threading it
		// into the read is the documented read-your-writes contract.
		const lsn = Number(created.headers()['cfb-lsn']);
		expect(lsn, 'demo shards replicate by default').toBeGreaterThan(0);

		const queried = await request.post(dbQueryPath(DEMO_PROJECT, 'notes'), {
			data: { where: [{ field: 'marker', op: '==', value: marker }] },
			headers: { 'cfb-min-lsn': String(lsn) }
		});
		expect(queried.ok(), await queried.text()).toBeTruthy();
		const { docs } = await queried.json();
		expect(docs.map((entry: { id: string }) => entry.id)).toEqual([doc.id]);
	});

	test('serves the demo SQL-table flow without an operator', async ({ request }) => {
		// Tables ride the same demo bypass: the anonymous visitor declares a
		// typed schema and round-trips rows through the proxy.
		const declare = await request.put(dbAdminTablePath(DEMO_PROJECT, 'demo_todos'), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				columns: [
					{ name: 'title', type: 'text', nullable: false },
					{ name: 'done', type: 'boolean', default: false }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const marker = `demo-table-${Date.now()}`;
		const created = await request.post(dbRowsPath(DEMO_PROJECT, 'demo_todos'), {
			data: { data: { title: marker } }
		});
		expect(created.status(), await created.text()).toBe(201);
		expect((await created.json()).data.done).toBe(false);

		// Same bookmark threading as the collection flow: tables replicate by
		// default on demo projects too.
		const lsn = Number(created.headers()['cfb-lsn']);
		expect(lsn, 'demo tables replicate by default').toBeGreaterThan(0);

		const queried = await request.post(dbTableQueryPath(DEMO_PROJECT, 'demo_todos'), {
			data: { where: [{ field: 'title', op: '==', value: marker }] },
			headers: { 'cfb-min-lsn': String(lsn) }
		});
		expect(queried.ok(), await queried.text()).toBeTruthy();
		expect((await queried.json()).docs).toHaveLength(1);
	});

	test('demo limits do not reach named projects', async ({ request }) => {
		// The ceilings key off the demo id pattern, so a self-hosted project
		// called something ordinary must be unaffected even on this deployment.
		const named = await request.get(configPath('e2e-scratch'));
		expect(named.ok()).toBeTruthy();
	});
});
