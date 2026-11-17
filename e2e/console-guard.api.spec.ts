import { expect, test } from '@playwright/test';
import {
	adminUserPath,
	adminUsersPath,
	analyticsPath,
	authPath,
	chatPath,
	configPath,
	CONSOLE_OWNER,
	consoleAuthPath,
	dbAdminImportPath,
	dbAdminQueryPath,
	dbAdminRestorePath,
	dbAdminTablePath,
	dbAdminTableRowPath,
	dbOverviewPath,
	overviewPath,
	SCRATCH_PROJECT,
	SEED_PROJECT,
	settingsPath,
	uniqueEmail
} from './helpers';

/**
 * The console guard is the boundary that makes this repository safe to publish:
 * without it, anyone holding a project id could read that project's users and
 * delete them. These tests run deliberately unauthenticated.
 */
test.describe('console guard', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('operator endpoints reject anonymous callers', async ({ request }) => {
		const forbidden = [
			overviewPath(SEED_PROJECT),
			analyticsPath(SEED_PROJECT),
			settingsPath(SEED_PROJECT),
			'/api/registry/projects'
		];

		for (const path of forbidden) {
			const response = await request.get(path);
			expect(response.status(), `${path} should require an operator session`).toBe(401);
		}
	});

	test('destructive admin routes reject anonymous callers', async ({ request }) => {
		const response = await request.delete(adminUserPath(SEED_PROJECT, 'any-user-id'));
		expect(response.status()).toBe(401);
	});

	test('a percent-encoded path prefix does not slip past the guard', async ({ request }) => {
		// SvelteKit's router decodes `%61pi` to `api` and runs the `/api/...`
		// handler, but the guard used to classify the still-encoded path: it saw
		// `%61pi`, matched no protected prefix, and waved the request through as
		// public. So `/%61pi/registry/projects` reached every operator endpoint
		// with no session. The guard must now see the same decoded path the
		// router dispatches on, GET and POST alike.
		const listed = await request.get('/%61pi/registry/projects');
		expect(listed.status(), 'encoded /api must stay operator-only').toBe(401);

		const me = await request.get('/%61pi/console/me');
		expect(me.status()).toBe(401);

		const created = await request.post('/%61pi/registry/projects', {
			data: { id: 'guard-bypass-probe', name: 'probe' }
		});
		expect(created.status(), 'encoded /api must not create a project').toBe(401);
	});

	test('the chat endpoint is not a free anonymous AI proxy', async ({ request }) => {
		const response = await request.post(chatPath(SEED_PROJECT), {
			data: { question: 'who are the users?' }
		});
		expect(response.status()).toBe(401);
	});

	test('the agents passthrough is guarded too', async ({ request }) => {
		// The same Durable Object, reached by its public path rather than the
		// dashboard proxy - the guard has to cover both or it covers neither.
		const response = await request.get(`/agents/auth-agent/${SEED_PROJECT}/overview`);
		expect(response.status()).toBe(401);
	});

	test('the db agent passthrough is guarded too', async ({ request }) => {
		// The db manifest declares only /collections/*, /tables/*, and /config
		// public; the overview and every admin route stay operator-only on the
		// passthrough.
		const overview = await request.get(`/agents/db-agent/${SEED_PROJECT}/overview`);
		expect(overview.status()).toBe(401);

		const configure = await request.put(`/agents/db-agent/${SEED_PROJECT}/admin/collections/x`, {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(configure.status()).toBe(401);

		const declare = await request.put(`/agents/db-agent/${SEED_PROJECT}/admin/tables/x`, {
			data: { columns: [{ name: 'a', type: 'text' }] }
		});
		expect(declare.status()).toBe(401);
	});

	test('the db console proxy rejects anonymous callers', async ({ request }) => {
		// The same operator surface, reached over the dashboard proxy instead of
		// the passthrough - the guard has to cover both or it covers neither.
		const overview = await request.get(dbOverviewPath(SEED_PROJECT));
		expect(overview.status()).toBe(401);

		const query = await request.post(dbAdminQueryPath(SEED_PROJECT), {
			data: { collection: 'x', query: {} }
		});
		expect(query.status()).toBe(401);

		// The destructive admin surfaces (restore rolls data back, import
		// writes it) must never be reachable without a session.
		const restore = await request.post(dbAdminRestorePath(SEED_PROJECT, 'x'), {
			data: { timestamp: new Date().toISOString() }
		});
		expect(restore.status()).toBe(401);

		const importDocs = await request.post(dbAdminImportPath(SEED_PROJECT, 'x'), {
			headers: { 'content-type': 'application/x-ndjson' },
			data: '{"data":{}}'
		});
		expect(importDocs.status()).toBe(401);

		// The table admin surface (DDL!) is operator-only on both hops too.
		const declare = await request.put(dbAdminTablePath(SEED_PROJECT, 'x'), {
			data: { columns: [{ name: 'a', type: 'text' }] }
		});
		expect(declare.status()).toBe(401);

		const rowWrite = await request.put(dbAdminTableRowPath(SEED_PROJECT, 'x', 'row-1'), {
			data: { data: {} }
		});
		expect(rowWrite.status()).toBe(401);
	});

	test('the product API stays public', async ({ request }) => {
		// A customer's app must be able to sign users up without an operator.
		// Writes go to the scratch project - the seed project's counts are
		// asserted exactly elsewhere.
		const signUp = await request.post(authPath(SCRATCH_PROJECT, 'sign-up/email'), {
			data: {
				name: 'Guard Probe',
				email: uniqueEmail('guard-probe'),
				password: 'guard-probe-password-1'
			}
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();

		const config = await request.get(configPath(SCRATCH_PROJECT));
		expect(config.ok()).toBeTruthy();
	});

	test('the demo dashboard needs no operator to be useful', async ({ request }) => {
		// The three surfaces are distinct: the demo is anonymous, /admin is the
		// operator's own monitoring, and the dashboard needs a session only where
		// it holds real projects. A demo deployment refuses console claims
		// entirely - nobody is meant to operate it - which is why the agent under
		// test does not set DEMO_MODE even though the web Worker does.
		const config = await request.get(configPath('console'));
		expect(config.ok(), 'the console instance is reachable for the login page').toBeTruthy();
	});

	test('the console instance refuses a second owner and guest sign-in', async ({ request }) => {
		const second = await request.post(consoleAuthPath('sign-up/email'), {
			data: {
				name: 'Interloper',
				email: uniqueEmail('interloper'),
				password: 'interloper-password-1'
			}
		});
		expect(second.status(), 'the console must accept exactly one owner').toBe(403);

		// Sent with a body so a rejection can only come from the console rule,
		// never from Better Auth's content-type check.
		const guest = await request.post(consoleAuthPath('sign-in/anonymous'), { data: {} });
		expect(guest.status(), 'the console must never issue guest sessions').toBe(403);
	});

	test('the console instance is administered, never owned', async ({ request }) => {
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();

		// The console AuthAgent holds every operator account on the deployment.
		// It answers to the admin role and nothing else - never to ownership,
		// which cannot speak for it (it is not a registry row). The owner
		// claimed this deployment, so the agent healed them into the admin
		// role and these surfaces open for them.
		const overview = await request.get(overviewPath('console'));
		expect(overview.ok(), await overview.text()).toBeTruthy();

		const passthrough = await request.get('/agents/auth-agent/console/admin/users');
		expect(passthrough.ok(), 'the passthrough follows the same rule').toBeTruthy();

		const page = await request.get('/dashboard/console', { maxRedirects: 0 });
		expect(page.status(), 'the admin reaches the console dashboard').toBe(200);

		// The console's PUBLIC surfaces are what the login page and the account
		// menu are built on, and stay reachable regardless of role.
		const config = await request.get(configPath('console'));
		expect(config.ok(), 'the login page still reads the console config').toBeTruthy();

		const session = await request.get(consoleAuthPath('get-session'));
		expect(session.ok(), 'the console auth proxy still serves sessions').toBeTruthy();
	});

	test('the console can never lock itself out of its own admin role', async ({ request }) => {
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();

		const session = (await (await request.get(consoleAuthPath('get-session'))).json()) as {
			user: { id: string };
		};
		const ownId = session.user.id;
		const rolePath = `/api/projects/console/admin/users/${encodeURIComponent(ownId)}/role`;

		// Self-demotion is refused OUTRIGHT, whatever the admin count: the
		// operator making the change is the one who loses the page they are
		// making it on - the exact door that was walked through before this
		// guard existed.
		const demote = await request.put(rolePath, { data: { role: 'user' } });
		expect(demote.status(), 'an admin cannot remove their own admin role').toBe(409);

		// limit=200 (the max): the list is newest-first and the owner is the
		// OLDEST account, so a reused stack's accumulated invitees must not
		// push them off the page.
		const me = (await (
			await request.get('/agents/auth-agent/console/admin/users?limit=200')
		).json()) as { users: { id: string; role?: string }[] };
		const self = me.users.find((user) => user.id === ownId);
		expect(self?.role, 'the refused demotion changed nothing').toBe('admin');

		// Deleting the last admin is the other door to the same lockout. Only
		// deterministic when this stack has exactly one admin (a reused local
		// stack may have accumulated more from other suites).
		const admins = me.users.filter((user) => user.role === 'admin');
		if (admins.length === 1) {
			const erase = await request.delete(`/api/projects/console/admin/users/${ownId}`);
			expect(erase.status(), 'the last admin cannot be deleted').toBe(409);
		}
	});

	test('reserved ids other than console are not projects at all', async ({ request }) => {
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();

		// These name dashboard routes and system endpoints. Nothing legitimate
		// lives behind them, and reaching one would provision a Durable Object
		// on a name the registry refuses to mint.
		for (const reserved of ['admin', 'fleet', 'organization', 'agents']) {
			const response = await request.get(overviewPath(reserved));
			expect(response.status(), `${reserved} must not be a project`).toBe(404);
		}

		// ...and the real console page behind one of those names still works -
		// it is a console route, not a project.
		const orgPage = await request.get('/dashboard/organization', { maxRedirects: 0 });
		expect(orgPage.status(), 'the organization page is not a project surface').toBe(200);
	});

	test('an unregistered project id is nobody’s project', async ({ request }) => {
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();

		// Typing an id into the URL used to MINT a backend: the agents
		// provision a Durable Object on first touch, so any signed-in account
		// got an auth stack and a database outside every ownership check and
		// every per-org ceiling - and two accounts guessing the same id landed
		// in the same data. Only a registry row makes a project.
		const unminted = `e2e-never-minted-${Date.now().toString(36)}`;

		const overview = await request.get(overviewPath(unminted));
		expect(overview.status(), 'no row, no project').toBe(404);

		const users = await request.get(adminUsersPath(unminted));
		expect(users.status()).toBe(404);

		const settings = await request.put(settingsPath(unminted), {
			data: { allowedOrigins: ['https://evil.example.com'] }
		});
		expect(settings.status()).toBe(404);

		const passthrough = await request.get(`/agents/auth-agent/${unminted}/overview`);
		expect(passthrough.status(), 'the passthrough is not a way around it').toBe(404);

		const page = await request.get(`/dashboard/${unminted}`, { maxRedirects: 0 });
		expect(page.status()).toBe(303);
		expect(page.headers()['location']).toBe('/dashboard');

		// The refusal is identical to the one a project owned by someone else
		// gets (orgs.api.spec.ts), so neither answer tells you the other exists.
	});

	test('a valid operator session unlocks the same endpoints', async ({ request }) => {
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();

		const overview = await request.get(overviewPath(SEED_PROJECT));
		expect(overview.ok()).toBeTruthy();
	});
});
