import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import { authPath, DB_PROJECT, dbAdminTablePath, uniqueEmail } from './helpers';

/**
 * T2: the D1-shaped SQL endpoint. ORM-grade single-table SQL - SELECT and
 * DML with automatic RETURNING, atomic batches, the statement gate's
 * refusals over HTTP, and the access rules that differ from the typed API:
 * raw SQL ALWAYS requires a project JWT, and owner-scoped tables refuse it
 * outright (arbitrary SQL cannot be owner-scoped).
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function sqlPath(table: string): string {
	return `/api/projects/${DB_PROJECT}/db/tables/${table}/sql`;
}

function aggregatePath(table: string): string {
	return `/api/projects/${DB_PROJECT}/db/tables/${table}/aggregate`;
}

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: { name: 'Sql Spec User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		return (await token.json()).token as string;
	} finally {
		await anon.dispose();
	}
}

test.describe('db agent (SQL endpoint)', () => {
	test('runs ORM-shaped SQL round trips with automatic RETURNING', async ({ request, baseURL }) => {
		const table = `sql-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'off',
				columns: [
					{ name: 'title', type: 'text', nullable: false },
					{ name: 'votes', type: 'integer', default: 0 }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'sql-user');
		const anon = await anonymousContext(baseURL);
		const asUser = { authorization: `Bearer ${token}` };
		try {
			// Tokenless raw SQL is refused whatever the access modes.
			const refused = await anon.post(sqlPath(table), {
				data: { sql: `SELECT * FROM "${table}"` }
			});
			expect(refused.status()).toBe(401);

			// INSERT: the endpoint appends RETURNING - the full row comes back,
			// drizzle-style, as objects AND value arrays with column order.
			const inserted = await anon.post(sqlPath(table), {
				headers: asUser,
				data: {
					sql: `INSERT INTO "${table}" (id, title, votes) VALUES (?, ?, ?)`,
					params: ['s1', 'ship the endpoint', 3]
				}
			});
			expect(inserted.ok(), await inserted.text()).toBeTruthy();
			const insertBody = await inserted.json();
			expect(insertBody.success).toBe(true);
			expect(insertBody.result.results[0].title).toBe('ship the endpoint');
			expect(insertBody.result.columns).toContain('created_at');
			expect(insertBody.result.raw[0].length).toBe(insertBody.result.columns.length);
			expect(insertBody.result.meta.changes).toBe(1);

			// SELECT with ORM-style quoting and params.
			const selected = await anon.post(sqlPath(table), {
				headers: asUser,
				data: { sql: `SELECT "id", "votes" FROM "${table}" WHERE "votes" > ?`, params: [1] }
			});
			expect(selected.ok(), await selected.text()).toBeTruthy();
			const selectBody = await selected.json();
			expect(selectBody.result.results).toEqual([{ id: 's1', votes: 3 }]);

			// UPDATE returns the post-image rows.
			const updated = await anon.post(sqlPath(table), {
				headers: asUser,
				data: { sql: `UPDATE "${table}" SET votes = votes + 1 WHERE id = ?`, params: ['s1'] }
			});
			expect(updated.ok(), await updated.text()).toBeTruthy();
			expect((await updated.json()).result.results[0].votes).toBe(4);

			// The typed API sees SQL-written rows (one storage, two views).
			const viaTyped = await request.post(`/api/projects/${DB_PROJECT}/db/admin/query`, {
				data: { table, query: {} }
			});
			expect(viaTyped.ok(), await viaTyped.text()).toBeTruthy();
			expect((await viaTyped.json()).docs[0].data.votes).toBe(4);
		} finally {
			await anon.dispose();
		}
	});

	test('batches are atomic: one failure rolls back the whole batch', async ({
		request,
		baseURL
	}) => {
		const table = `sqlb-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'off',
				columns: [{ name: 'title', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'sql-batch');
		const anon = await anonymousContext(baseURL);
		try {
			const failing = await anon.post(sqlPath(table), {
				headers: { authorization: `Bearer ${token}` },
				data: {
					batch: [
						{ sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['b1', 'first'] },
						// NOT NULL violation - the batch must roll back whole.
						{ sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['b2', null] }
					]
				}
			});
			expect(failing.status()).toBe(400);

			const check = await request.post(`/api/projects/${DB_PROJECT}/db/admin/query`, {
				data: { table, query: {} }
			});
			expect((await check.json()).docs, 'b1 must have rolled back').toHaveLength(0);
		} finally {
			await anon.dispose();
		}
	});

	test('the statement gate refuses bypasses over HTTP', async ({ request, baseURL }) => {
		const table = `sqlg-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'off',
				columns: [{ name: 'title', type: 'text' }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'sql-gate');
		const anon = await anonymousContext(baseURL);
		const asUser = { authorization: `Bearer ${token}` };
		try {
			for (const [sql, fragment] of [
				['SELECT * FROM changelog', 'internal storage'],
				['SELECT token_exp FROM subscriptions', 'internal storage'],
				['DROP TABLE ' + table, 'SELECT, INSERT'],
				['SELECT 1; SELECT 2', 'one statement'],
				['INSERT INTO elsewhere (id) VALUES (?)', 'must target'],
				// Never terminates on its own, inside a single-threaded shard.
				[
					'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
					'recursive CTEs'
				]
			] as const) {
				const refusedSql = await anon.post(sqlPath(table), {
					headers: asUser,
					data: { sql }
				});
				expect(refusedSql.status(), sql).toBe(400);
				expect((await refusedSql.json()).error, sql).toContain(fragment);
			}
		} finally {
			await anon.dispose();
		}
	});

	test('owner-scoped tables refuse raw SQL outright', async ({ request, baseURL }) => {
		const table = `sqlo-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'owner',
				writeAccess: 'owner',
				replication: 'off',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'sql-owner');
		const anon = await anonymousContext(baseURL);
		try {
			const refused = await anon.post(sqlPath(table), {
				headers: { authorization: `Bearer ${token}` },
				data: { sql: `SELECT * FROM "${table}"` }
			});
			expect(refused.status()).toBe(403);
			expect((await refused.json()).error).toContain('owner');
		} finally {
			await anon.dispose();
		}
	});

	test('table aggregates serve typed sums and the admin mirrors both engines', async ({
		request,
		baseURL
	}) => {
		const table = `sqla-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [{ name: 'votes', type: 'integer', default: 0 }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			for (const votes of [2, 3, 5]) {
				const created = await anon.post(`/api/projects/${DB_PROJECT}/db/tables/${table}/rows`, {
					data: { data: { votes } }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			const aggregated = await anon.post(aggregatePath(table), {
				data: { aggregates: { total: { op: 'count' }, sum: { op: 'sum', field: 'votes' } } }
			});
			expect(aggregated.ok(), await aggregated.text()).toBeTruthy();
			expect(await aggregated.json()).toEqual({ results: { total: 3, sum: 10 } });

			// Unknown columns are refusals here too.
			const unknown = await anon.post(aggregatePath(table), {
				data: { aggregates: { s: { op: 'sum', field: 'ghost' } } }
			});
			expect(unknown.status()).toBe(400);

			// The unified operator mirror takes `table` like /admin/query does.
			const viaAdmin = await request.post(`/api/projects/${DB_PROJECT}/db/admin/aggregate`, {
				data: { table, aggregate: { aggregates: { avg: { op: 'avg', field: 'votes' } } } }
			});
			expect(viaAdmin.ok(), await viaAdmin.text()).toBeTruthy();
			expect((await viaAdmin.json()).results.avg).toBeCloseTo(10 / 3);

			// Operator SQL console route.
			const adminSql = await request.post(
				`/api/projects/${DB_PROJECT}/db/admin/tables/${table}/sql`,
				{ data: { sql: `SELECT COUNT(*) AS n FROM "${table}"` } }
			);
			expect(adminSql.ok(), await adminSql.text()).toBeTruthy();
			expect((await adminSql.json()).batch[0].results[0].n).toBe(3);
		} finally {
			await anon.dispose();
		}
	});
});
