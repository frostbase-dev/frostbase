import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTableSql, prepareViewSql } from './table-sql.js';
import { compileTableAggregate } from './table-query.js';
import { tableColumnsSchema, type TableColumn } from './schemas.js';

/** The raw-SQL gate exists to refuse bypasses; pin the refusals hardest. */

function cols(...input: Record<string, unknown>[]): TableColumn[] {
	return tableColumnsSchema.parse(input);
}

const TODO = cols(
	{ name: 'title', type: 'text' },
	{ name: 'votes', type: 'integer' },
	{ name: 'meta', type: 'json' },
);

function ok(sql: string) {
	const prepared = prepareTableSql(sql, 'todos', TODO);
	if (!prepared.ok) throw new Error(`expected to pass the gate: ${prepared.error}`);
	return prepared;
}

function refused(sql: string, fragment: string) {
	const prepared = prepareTableSql(sql, 'todos', TODO);
	assert.equal(prepared.ok, false, `should refuse: ${sql}`);
	if (!prepared.ok) assert.match(prepared.error, new RegExp(fragment), sql);
}

test('sql gate: plain statements pass and DML gains RETURNING', () => {
	const select = ok('SELECT "id", "title" FROM "todos" WHERE "votes" > ?');
	assert.equal(select.kind, 'select');
	assert.ok(!/returning/i.test(select.sql));

	const insert = ok(`INSERT INTO todos (id, title, votes) VALUES (?, ?, ?);`);
	assert.equal(insert.kind, 'insert');
	assert.match(
		insert.sql,
		/RETURNING "id", "owner", "created_at", "updated_at", "title", "votes", "meta"$/,
	);

	const update = ok(`update "todos" set votes = votes + 1 where id = ?`);
	assert.equal(update.kind, 'update');
	assert.match(update.sql, /RETURNING/);

	const remove = ok(`DELETE FROM todos WHERE votes < ?`);
	assert.equal(remove.kind, 'delete');
	assert.match(remove.sql, /RETURNING/);
});

test('sql gate: multiple statements, DDL, and transactions are refused', () => {
	refused('SELECT 1; SELECT 2', 'one statement');
	refused('DROP TABLE todos', 'SELECT, INSERT, UPDATE');
	refused('CREATE INDEX x ON todos (title)', 'SELECT, INSERT, UPDATE');
	refused('SELECT * FROM todos; --', 'one statement');
	refused('BEGIN', 'SELECT, INSERT, UPDATE');
	refused("SELECT * FROM todos WHERE title = 'x'; DELETE FROM todos", 'one statement');
	refused('PRAGMA table_info(todos)', 'SELECT, INSERT, UPDATE');
	refused('SELECT * FROM todos JOIN pragma_table_info(?) LIMIT 1', 'plain SELECT');
});

test('sql gate: internal storage is unreachable, whatever the casing', () => {
	refused('SELECT * FROM changelog', 'internal storage');
	refused('SELECT * FROM "CHANGELOG"', 'internal storage');
	refused('SELECT token_exp FROM subscriptions', 'internal storage');
	refused('SELECT t.* FROM todos t, replica_meta', 'internal storage');
	refused('SELECT * FROM sqlite_master', 'sqlite internals');
	// Even in a string literal: bind it instead.
	refused(`SELECT * FROM todos WHERE title = 'changelog'`, 'bind it as a parameter');
});

test('sql gate: DML targets this table whether or not the name is quoted', () => {
	// Every DML test below this one wrote the name unquoted, which is exactly
	// how `DELETE FROM "todos"` - what drizzle and every other ORM emits -
	// stayed refused by the target check for as long as it did.
	for (const sql of [
		'INSERT INTO "todos" (id, title) VALUES (?, ?)',
		'UPDATE "todos" SET votes = 1 WHERE id = ?',
		'DELETE FROM "todos" WHERE votes < ?',
		'DELETE FROM "todos"',
	]) {
		assert.match(ok(sql).sql, /RETURNING/, sql);
	}

	// Unbalanced quotes are not a name, and a longer name that merely starts
	// with this one is a different table - a hyphen is a word boundary, so the
	// guard cannot be `\b`.
	refused('INSERT INTO "todos (id) VALUES (?)', 'must target "todos"');
	refused('DELETE FROM todos"', 'must target "todos"');
	refused('DELETE FROM todos-archive', 'must target "todos"');
	refused('UPDATE todos_backup SET x = 1', 'must target "todos"');
});

test('sql gate: DML must target this table; RETURNING is ours to add', () => {
	refused('INSERT INTO other (id) VALUES (?)', 'must target "todos"');
	refused('UPDATE elsewhere SET x = 1', 'must target "todos"');
	refused('DELETE FROM other', 'must target "todos"');
	refused('INSERT INTO todos (id) VALUES (?) RETURNING id', 'added automatically');
	refused('WITH x AS (SELECT 1) INSERT INTO todos (id) SELECT * FROM x', 'CTEs');
	// A CTE-fronted SELECT is legitimate ORM output.
	const cte = ok(
		'WITH ranked AS (SELECT id, votes FROM todos) SELECT * FROM ranked WHERE votes > ?',
	);
	assert.equal(cte.kind, 'select');
});

test('sql gate: a comment cannot swallow the appended RETURNING', () => {
	// Appending ` RETURNING ...` to a statement ending in a line comment put
	// the clause INSIDE the comment. The write still ran, but with no returned
	// row there is no live-query delta and no changelog entry - and the
	// changelog IS the replication feed, so every replica would silently
	// diverge from the primary, permanently.
	const commented = ok('UPDATE todos SET votes = votes + 1 WHERE id = ? -- bump');
	assert.match(commented.sql, /\nRETURNING "id"/);
	// The clause is on its own line, so the comment can no longer reach it.
	assert.ok(!/--[^\n]*RETURNING/.test(commented.sql));

	// A block comment left open runs to end of INPUT in SQLite, which nothing
	// appended can escape - so it is refused rather than trusted.
	refused('UPDATE todos SET votes = 1 /* trailing', 'unterminated block comment');
	refused("DELETE FROM todos WHERE id = ? /* trace: '*/ /* still open", 'unterminated');
	// A closed one is ordinary ORM output (query tags) and still passes.
	// Trailing, not leading: the statement kind is read from the first token,
	// so a comment in front of it is refused - unrelated to this, and a
	// compatibility gap rather than a safety one.
	const tagged = ok('UPDATE todos SET votes = 1 WHERE id = ? /* traceparent=abc */');
	assert.match(tagged.sql, /RETURNING/);
	// `/*` inside a string literal is not a comment at all.
	const literal = ok(`UPDATE todos SET title = '/*' WHERE id = ?`);
	assert.match(literal.sql, /RETURNING/);
});

test('sql gate: every internal table stays unreachable, shadowing included', () => {
	// The shard applies the whole schema, so a table missing from the gate's
	// list is a table raw SQL can read.
	for (const name of [
		'collections',
		'documents',
		'subscriptions',
		'restore_points',
		'collection_meta',
		'changelog',
		'replicas',
		'replica_meta',
		'gateways',
		'gateway_subs',
		'view_sources',
	]) {
		refused(`SELECT * FROM ${name}`, 'internal storage');
	}

	// And a table that SHADOWS internal storage - only possible for a row
	// grandfathered in before the name was reserved - is exactly the case that
	// must stay refused: the physical table it reaches IS the internal one.
	const shadow = prepareTableSql('SELECT * FROM subscriptions', 'subscriptions', TODO);
	assert.equal(shadow.ok, false, 'a shadowing table does not unlock internal storage');
});

test('view gate: joins run, and nothing that writes does', () => {
	const refusedView = (sql: string, fragment: string) => {
		const prepared = prepareViewSql(sql);
		assert.equal(prepared.ok, false, `should refuse: ${sql}`);
		if (!prepared.ok) assert.match(prepared.error, new RegExp(fragment), sql);
	};

	// The whole point: a join across member tables, which the single-table
	// gate has no way to express.
	const joined = prepareViewSql(
		'SELECT t."title", u."email" FROM todos t JOIN users u ON u."id" = t."owner" WHERE t."votes" > ?',
	);
	assert.equal(joined.ok, true, !joined.ok ? new Error(joined.error) : undefined);
	if (joined.ok) {
		assert.equal(joined.kind, 'select');
		// No RETURNING is ever appended: there is no write to capture.
		assert.ok(!/returning/i.test(joined.sql));
	}

	// CTEs, subqueries, aggregates and window functions were never blocked -
	// only unavailable across tables.
	assert.equal(
		prepareViewSql(
			'WITH top AS (SELECT "owner", COUNT(*) c FROM todos GROUP BY "owner") ' +
				'SELECT u."email", top.c FROM top JOIN users u ON u."id" = top."owner"',
		).ok,
		true,
	);
	assert.equal(
		prepareViewSql('SELECT "id", ROW_NUMBER() OVER (ORDER BY "votes" DESC) FROM todos').ok,
		true,
	);

	// A view is read-only, and says so rather than failing obscurely later.
	refusedView('INSERT INTO todos (id) VALUES (?)', 'read-only');
	refusedView('UPDATE todos SET votes = 1', 'read-only');
	refusedView('DELETE FROM todos', 'read-only');
	refusedView('WITH x AS (SELECT 1) INSERT INTO todos (id) SELECT * FROM x', 'CTEs');

	// Everything the table gate refuses, the view gate refuses too.
	refusedView('SELECT 1; SELECT 2', 'one statement');
	refusedView('DROP TABLE todos', 'read-only');
	refusedView('CREATE INDEX x ON todos (title)', 'read-only');
	refusedView('SELECT * FROM changelog', 'internal storage');
	refusedView('SELECT t.* FROM todos t JOIN replica_meta', 'internal storage');
	refusedView('SELECT * FROM view_sources', 'internal storage');
	refusedView('SELECT * FROM sqlite_master', 'sqlite internals');
	refusedView('SELECT * FROM todos JOIN pragma_table_info(?)', 'plain SELECT');
});

test('table aggregates: typed columns sum directly, json paths stay gated', () => {
	const typed = compileTableAggregate(
		'todos',
		{
			where: [{ field: 'title', op: '==', value: 'x' }],
			aggregates: { total: { op: 'count' }, v: { op: 'sum', field: 'votes' } },
		},
		TODO,
	);
	assert.equal(typed.ok, true, !typed.ok ? new Error(typed.error) : undefined);
	if (typed.ok) {
		assert.equal(
			typed.compiled.sql,
			`SELECT COUNT(*) AS agg_0, COALESCE(SUM("votes"), 0) AS agg_1 FROM "todos" WHERE "title" = ?`,
		);
		assert.deepEqual(typed.compiled.aliases, ['total', 'v']);
	}

	const json = compileTableAggregate(
		'todos',
		{ aggregates: { avg: { op: 'avg', field: 'meta.score' } } },
		TODO,
	);
	assert.equal(json.ok, true);
	if (json.ok)
		assert.match(json.compiled.sql, /json_type\("meta", '\$\.score'\) IN \('integer', 'real'\)/);

	const text = compileTableAggregate(
		'todos',
		{ aggregates: { s: { op: 'sum', field: 'title' } } },
		TODO,
	);
	assert.equal(text.ok, false);
	if (!text.ok) assert.match(text.error, /text column/);

	const unknown = compileTableAggregate(
		'todos',
		{ aggregates: { s: { op: 'sum', field: 'ghost' } } },
		TODO,
	);
	assert.equal(unknown.ok, false);
});
