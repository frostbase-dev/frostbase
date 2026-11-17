import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminQueryPath,
	dbAdminTablePath,
	dbAdminTableRowPath,
	dbAdminViewPath,
	dbDocumentPath,
	dbDocumentsPath,
	dbQueryPath,
	dbRowPath,
	dbRowsPath,
	uniqueEmail
} from './helpers';
import { LiveSocket, WEB_WS } from './live-socket';

/**
 * The `none` access mode - the closed one.
 *
 * `writeAccess: 'none'` is a read-only collection or table: the shape every
 * server-owned dataset has (feature flags, pricing tiers, a catalog), and the
 * substrate Remote Config is built on. `readAccess: 'none'` is its mirror -
 * append-only ingest a client may write but never read back.
 *
 * This spec is written as an ATTACK, not a demonstration. The interesting
 * assertion is never "the operator can write"; it is that a caller holding a
 * genuine, freshly minted project JWT is refused anyway - because that is the
 * property that fails silently. A read-only collection whose gate quietly
 * started admitting tokens looks completely normal right up until someone
 * rewrites your flags, so every closed surface is probed here with a real
 * credential rather than an absent one.
 *
 * It also covers the two ways around the typed gate: raw SQL (which does not
 * call checkAccess at all and re-implements the refusal) and a join view
 * (which is a second copy of its members).
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

/** A real signed-in user's project JWT - the credential the attack rides. */
async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: {
				name: 'Readonly Spec User',
				email: uniqueEmail(prefix),
				password: 'db-spec-password-1'
			}
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		expect(sessionToken).toBeTruthy();

		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
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

function sqlPath(table: string): string {
	return `/api/projects/${DB_PROJECT}/db/tables/${table}/sql`;
}

/** The operator mirror of a document write - the surface that bypasses the
 * gate, and the only thing that can seed a collection closed to writes. */
function adminDocumentPath(collection: string, docId: string): string {
	return `${dbAdminCollectionPath(DB_PROJECT, collection)}/documents/${encodeURIComponent(docId)}`;
}

test.describe('db agent (the none access mode)', () => {
	test('a read-only collection serves reads and refuses every public write', async ({
		request,
		baseURL
	}) => {
		const collection = `flags-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'none', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// The operator plane never passes through the gate - that is what makes
		// the mode useful rather than merely restrictive.
		const seed = await request.put(adminDocumentPath(collection, 'checkout-v2'), {
			data: { data: { enabled: true, rollout: 10 } }
		});
		expect(seed.ok(), await seed.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'readonly-write');
		const anon = await anonymousContext(baseURL);
		try {
			// Reads are open, anonymously and with a token alike.
			const read = await anon.get(dbDocumentPath(DB_PROJECT, collection, 'checkout-v2'));
			expect(read.ok(), await read.text()).toBeTruthy();
			expect((await read.json()).data).toEqual({ enabled: true, rollout: 10 });

			const query = await anon.post(dbQueryPath(DB_PROJECT, collection), { data: {} });
			expect(query.ok(), await query.text()).toBeTruthy();

			// Writes are closed - and closed the same way for an anonymous caller
			// and for a real signed-in user. 403 throughout: a 401 would advertise
			// that some token opens this, and none does.
			const authed = { authorization: `Bearer ${token}` };
			for (const [label, response] of [
				[
					'anonymous create',
					await anon.post(dbDocumentsPath(DB_PROJECT, collection), {
						data: { data: { enabled: false } }
					})
				],
				[
					'authenticated create',
					await anon.post(dbDocumentsPath(DB_PROJECT, collection), {
						headers: authed,
						data: { data: { enabled: false } }
					})
				],
				[
					'authenticated overwrite',
					await anon.put(dbDocumentPath(DB_PROJECT, collection, 'checkout-v2'), {
						headers: authed,
						data: { data: { enabled: false, rollout: 100 } }
					})
				],
				[
					'authenticated patch',
					await anon.patch(dbDocumentPath(DB_PROJECT, collection, 'checkout-v2'), {
						headers: authed,
						data: { data: { rollout: 100 } }
					})
				],
				[
					'authenticated delete',
					await anon.delete(dbDocumentPath(DB_PROJECT, collection, 'checkout-v2'), {
						headers: authed
					})
				]
			] as const) {
				expect(response.status(), label).toBe(403);
			}

			// The document the attacker tried five ways to change is untouched.
			const after = await anon.get(dbDocumentPath(DB_PROJECT, collection, 'checkout-v2'));
			expect((await after.json()).data).toEqual({ enabled: true, rollout: 10 });
		} finally {
			await anon.dispose();
		}
	});

	test('an ingest collection accepts writes and refuses every public read', async ({
		request,
		baseURL
	}) => {
		const collection = `ingest-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'none', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'readonly-read');
		const anon = await anonymousContext(baseURL);
		try {
			const submitted = await anon.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: `report-${run}`, data: { message: 'the contact form works' } }
			});
			expect(submitted.ok(), await submitted.text()).toBeTruthy();

			// Having written it does not entitle anyone to read it back - not
			// anonymously, not with a valid token, and not by enumerating.
			const authed = { authorization: `Bearer ${token}` };
			for (const [label, response] of [
				['anonymous get', await anon.get(dbDocumentPath(DB_PROJECT, collection, `report-${run}`))],
				[
					'authenticated get',
					await anon.get(dbDocumentPath(DB_PROJECT, collection, `report-${run}`), {
						headers: authed
					})
				],
				['anonymous query', await anon.post(dbQueryPath(DB_PROJECT, collection), { data: {} })],
				[
					'authenticated query',
					await anon.post(dbQueryPath(DB_PROJECT, collection), { headers: authed, data: {} })
				]
			] as const) {
				expect(response.status(), label).toBe(403);
			}
		} finally {
			await anon.dispose();
		}

		// The operator can still read what was submitted - otherwise the mode
		// would be a write-only hole rather than an ingest surface.
		const operator = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { collection, query: {} }
		});
		expect(operator.ok(), await operator.text()).toBeTruthy();
		const { docs } = await operator.json();
		expect(docs.some((doc: { id: string }) => doc.id === `report-${run}`)).toBeTruthy();
	});

	test('a closed collection or table cannot be read through a live subscription', async ({
		request,
		baseURL
	}) => {
		const collection = `livein-${run}`;
		const table = `liveint-${run}`;
		const provisionCollection = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'none', writeAccess: 'public', replication: 'off' }
		});
		expect(provisionCollection.ok(), await provisionCollection.text()).toBeTruthy();
		const declareTable = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'none',
				writeAccess: 'auth',
				replication: 'off',
				columns: [{ name: 'message', type: 'text' }]
			}
		});
		expect(declareTable.ok(), await declareTable.text()).toBeTruthy();

		const seedDoc = await request.put(adminDocumentPath(collection, 'secret-doc'), {
			data: { data: { message: 'operator eyes only' } }
		});
		expect(seedDoc.ok(), await seedDoc.text()).toBeTruthy();
		const seedRow = await request.put(dbAdminTableRowPath(DB_PROJECT, table, 'secret-row'), {
			data: { data: { message: 'operator eyes only' } }
		});
		expect(seedRow.ok(), await seedRow.text()).toBeTruthy();

		// The socket re-implements the read gate rather than calling
		// checkAccess, so it is attacked with a real token on both doors: the
		// one-socket gateway and the table's own direct socket.
		const token = await projectUserToken(baseURL, 'readonly-live');
		const gateway = await LiveSocket.connect(
			`${WEB_WS}/agents/db-agent/${DB_PROJECT}/realtime?cfb-region=weur`
		);
		const direct = await LiveSocket.connect(
			`${WEB_WS}/agents/db-agent/${DB_PROJECT}/tables/${table}/subscribe`
		);
		try {
			gateway.send({
				type: 'subscribe',
				id: 'c1',
				shard: { kind: 'collection', name: collection },
				query: {},
				token
			});
			gateway.send({
				type: 'subscribe',
				id: 't1',
				shard: { kind: 'table', name: table },
				query: {},
				token
			});
			direct.send({ type: 'subscribe', id: 's1', query: {}, token });

			for (const [socket, id] of [
				[gateway, 'c1'],
				[gateway, 't1'],
				[direct, 's1']
			] as const) {
				const refused = await socket.next(
					(frame) => frame.id === id && (frame.type === 'error' || frame.type === 'snapshot'),
					`the answer to ${id}`
				);
				expect(refused.type, `${id} must be refused, not snapshotted`).toBe('error');
				expect(refused.code).toBe('unauthorized');
			}
		} finally {
			gateway.close();
			direct.close();
		}
	});

	test('an ingest table or collection cannot be read back through a write', async ({
		request,
		baseURL
	}) => {
		const table = `inbox-${run}`;
		const collection = `inboxc-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'none',
				writeAccess: 'auth',
				replication: 'off',
				columns: [{ name: 'message', type: 'text' }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'none', writeAccess: 'auth', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// Somebody else's submissions - the thing the attacker is after.
		const seedRow = await request.put(dbAdminTableRowPath(DB_PROJECT, table, 'victim-row'), {
			data: { data: { message: 'someone else wrote this' } }
		});
		expect(seedRow.ok(), await seedRow.text()).toBeTruthy();
		const seedDoc = await request.put(adminDocumentPath(collection, 'victim-doc'), {
			data: { data: { message: 'someone else wrote this' } }
		});
		expect(seedDoc.ok(), await seedDoc.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'readonly-readback');
		const anon = await anonymousContext(baseURL);
		try {
			const authed = { authorization: `Bearer ${token}` };

			// A write is allowed, and a no-op UPDATE over every row used to answer
			// with every row - RETURNING is appended to all DML.
			const dump = await anon.post(sqlPath(table), {
				headers: authed,
				data: { sql: `UPDATE "${table}" SET message = message` }
			});
			expect(dump.ok(), await dump.text()).toBeTruthy();
			const dumped = (await dump.json()).result;
			expect(dumped.results).toEqual([]);
			expect(dumped.raw).toEqual([]);
			expect(JSON.stringify(dumped)).not.toContain('someone else wrote this');

			// A SELECT hidden in a write batch is judged as the read it is.
			const smuggled = await anon.post(sqlPath(table), {
				headers: authed,
				data: {
					batch: [
						{ sql: `SELECT message FROM "${table}"` },
						{ sql: `UPDATE "${table}" SET message = message WHERE 0` }
					]
				}
			});
			expect(smuggled.status()).toBe(403);

			// The typed update merges over fields the caller never sent; an empty
			// PATCH must not hand them back.
			for (const [label, path] of [
				['row', dbRowPath(DB_PROJECT, table, 'victim-row')],
				['document', dbDocumentPath(DB_PROJECT, collection, 'victim-doc')]
			] as const) {
				const patched = await anon.patch(path, { headers: authed, data: {} });
				expect(patched.ok(), `${label}: ${await patched.text()}`).toBeTruthy();
				const body = await patched.json();
				expect(body, label).toEqual({ id: label === 'row' ? 'victim-row' : 'victim-doc' });
			}
		} finally {
			await anon.dispose();
		}
	});

	test('raw SQL cannot write a read-only table', async ({ request, baseURL }) => {
		const table = `catalog-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'none',
				replication: 'off',
				columns: [
					{ name: 'sku', type: 'text', nullable: false },
					{ name: 'price', type: 'integer', default: 0 }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const seed = await request.put(dbAdminTableRowPath(DB_PROJECT, table, 'sku-1'), {
			data: { data: { sku: 'sku-1', price: 999 } }
		});
		expect(seed.ok(), await seed.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'readonly-sql');
		const anon = await anonymousContext(baseURL);
		try {
			const authed = { authorization: `Bearer ${token}` };

			// Raw SQL always demands a token, and the read side is `auth`, so a
			// SELECT is exactly as open as it would be on the typed API.
			const select = await anon.post(sqlPath(table), {
				headers: authed,
				data: { sql: `SELECT sku, price FROM "${table}"` }
			});
			expect(select.ok(), await select.text()).toBeTruthy();
			expect((await select.json()).result.results).toHaveLength(1);

			// The SQL path does NOT call the shared gate - it re-implements the
			// refusal - so a mode enforced only in checkAccess would be wide open
			// right here. Each of these is a write the typed API refuses.
			for (const sql of [
				`INSERT INTO "${table}" (id, sku, price) VALUES ('sku-2', 'sku-2', 1)`,
				`UPDATE "${table}" SET price = 1 WHERE sku = 'sku-1'`,
				`DELETE FROM "${table}"`
			]) {
				const write = await anon.post(sqlPath(table), { headers: authed, data: { sql } });
				expect(write.status(), sql).toBe(403);
			}

			// A batch that hides a write behind a SELECT is still a write.
			const batch = await anon.post(sqlPath(table), {
				headers: authed,
				data: {
					batch: [{ sql: `SELECT sku FROM "${table}"` }, { sql: `UPDATE "${table}" SET price = 0` }]
				}
			});
			expect(batch.status()).toBe(403);

			// And the typed row API refuses the same writes.
			const typed = await anon.post(dbRowsPath(DB_PROJECT, table), {
				headers: authed,
				data: { data: { sku: 'sku-3', price: 5 } }
			});
			expect(typed.status()).toBe(403);

			// Nothing moved.
			const after = await anon.post(sqlPath(table), {
				headers: authed,
				data: { sql: `SELECT price FROM "${table}" WHERE sku = 'sku-1'` }
			});
			expect((await after.json()).result.results[0].price).toBe(999);
		} finally {
			await anon.dispose();
		}
	});

	test('a table closed to public reads cannot be laundered through a view', async ({ request }) => {
		const closed = `closed-${run}`;
		const plain = `plainro-${run}`;
		const view = `launder-${run}`;

		const declareClosed = await request.put(dbAdminTablePath(DB_PROJECT, closed), {
			data: {
				readAccess: 'none',
				writeAccess: 'none',
				replication: 'auto',
				columns: [{ name: 'secret', type: 'text' }]
			}
		});
		expect(declareClosed.ok(), await declareClosed.text()).toBeTruthy();

		const declarePlain = await request.put(dbAdminTablePath(DB_PROJECT, plain), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'auto',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(declarePlain.ok(), await declarePlain.text()).toBeTruthy();

		// A view is a second COPY of every member, so a member nobody may read
		// through the public API must not become readable by being joined. The
		// refusal is at declare time and it says why.
		const refused = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [closed, plain] }
		});
		expect(refused.status()).toBe(400);
		expect((await refused.json()).error).toContain('closed to the public API');
	});
});
