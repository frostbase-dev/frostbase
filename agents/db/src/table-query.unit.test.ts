import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesQuery, orderComparator } from './query.js';
import { compileTableQuery } from './table-query.js';
import { querySchema, tableColumnsSchema, type Query, type TableColumn } from './schemas.js';

/**
 * The table compiler and the SHARED JS matcher must agree - snapshots come
 * from compiled SQL over typed columns, live deltas from matchesQuery over
 * the DTO's data map (json parsed, booleans true/false). The compiler is
 * pinned with exact SQL + bound params; parity with the matcher is pinned
 * behaviorally over the same clauses. End-to-end SQL-vs-JS parity on real
 * SQLite is the live e2e spec's job, like the document engine.
 */

function q(input: unknown): Query {
	return querySchema.parse(input);
}

function cols(...input: Record<string, unknown>[]): TableColumn[] {
	return tableColumnsSchema.parse(input);
}

const TODO = cols(
	{ name: 'title', type: 'text' },
	{ name: 'done', type: 'boolean' },
	{ name: 'priority', type: 'integer' },
	{ name: 'meta', type: 'json' },
);

function compiled(query: Query, options = {}) {
	const result = compileTableQuery(query, TODO, options);
	if (!result.ok) throw new Error(`expected the query to compile: ${result.error}`);
	return result.compiled;
}

const row = (data: Record<string, unknown>, owner: string | null = null) => ({ data, owner });

// ---------------------------------------------------------------------------
// Compiler pins

test('compiler: typed columns compile to bare quoted identifiers', () => {
	const c = compiled(q({ where: [{ field: 'title', op: '==', value: 'x' }] }));
	assert.equal(c.whereSql, '"title" = ?');
	assert.deepEqual(c.params, ['x']);
});

test('compiler: null semantics and Firestore !=', () => {
	const isNull = compiled(q({ where: [{ field: 'title', op: '==', value: null }] }));
	assert.equal(isNull.whereSql, '"title" IS NULL');

	const notEqual = compiled(q({ where: [{ field: 'priority', op: '!=', value: 3 }] }));
	assert.equal(notEqual.whereSql, '"priority" IS NOT NULL AND "priority" != ?');
	assert.deepEqual(notEqual.params, [3]);
});

test('compiler: booleans bind as their storage shape', () => {
	const c = compiled(q({ where: [{ field: 'done', op: '==', value: true }] }));
	assert.equal(c.whereSql, '"done" = ?');
	assert.deepEqual(c.params, [1]);
});

test('compiler: dotted paths reach into json columns only', () => {
	const c = compiled(q({ where: [{ field: 'meta.author', op: '==', value: 'ada' }] }));
	assert.equal(c.whereSql, `json_extract("meta", '$.author') = ?`);

	const refused = compileTableQuery(q({ where: [{ field: 'title.x', op: '==', value: 1 }] }), TODO);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.match(refused.error, /dotted paths only reach into json columns/);
});

test('compiler: unknown columns are refusals, not silent misses', () => {
	const result = compileTableQuery(q({ where: [{ field: 'ghost', op: '==', value: 1 }] }), TODO);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, '"ghost" is not a declared column');

	const order = compileTableQuery(q({ orderBy: [{ field: 'ghost', direction: 'asc' }] }), TODO);
	assert.equal(order.ok, false);
});

test('compiler: array-contains needs json; compiles type-guarded json_each', () => {
	const c = compiled(q({ where: [{ field: 'meta', op: 'array-contains', value: 'tag' }] }));
	assert.equal(
		c.whereSql,
		`json_type("meta") = 'array' AND EXISTS ` +
			`(SELECT 1 FROM json_each("meta") WHERE json_each.value = ?)`,
	);

	const path = compiled(q({ where: [{ field: 'meta.tags', op: 'array-contains', value: 'x' }] }));
	assert.equal(
		path.whereSql,
		`json_type("meta", '$.tags') = 'array' AND EXISTS ` +
			`(SELECT 1 FROM json_each("meta", '$.tags') WHERE json_each.value = ?)`,
	);

	const refused = compileTableQuery(
		q({ where: [{ field: 'title', op: 'array-contains', value: 'x' }] }),
		TODO,
	);
	assert.equal(refused.ok, false);
});

test('compiler: order, limit, id tiebreak, owner scoping', () => {
	const c = compiled(q({ orderBy: [{ field: 'priority', direction: 'desc' }], limit: 50 }), {
		ownerSub: 'user-1',
	});
	assert.equal(c.whereSql, '"owner" = ?');
	assert.equal(c.orderSql, '"priority" DESC, "id" ASC');
	assert.equal(c.limit, 50);
});

test('compiler: keyset cursor over resolved expressions', () => {
	const c = compiled(q({ orderBy: [{ field: 'priority', direction: 'asc' }] }), {
		cursor: { values: [3], id: 'r5' },
	});
	assert.equal(c.whereSql, '(("priority" > ?) OR ("priority" = ? AND "id" > ?))');
	assert.deepEqual(c.params, [3, 3, 'r5']);

	// A cursor from a different query shape is ignored rather than misapplied.
	const mismatched = compiled(q({}), { cursor: { values: [1, 2], id: 'r1' } });
	assert.equal(mismatched.whereSql, '1=1');
});

// ---------------------------------------------------------------------------
// Matcher parity: the shared matcher agrees with what the SQL would select

test('parity: typed equality, null, and boolean normalization', () => {
	const done = q({ where: [{ field: 'done', op: '==', value: true }] });
	assert.equal(matchesQuery(done, row({ done: true })), true);
	assert.equal(matchesQuery(done, row({ done: false })), false);

	const isNull = q({ where: [{ field: 'title', op: '==', value: null }] });
	assert.equal(matchesQuery(isNull, row({ title: null })), true);
	assert.equal(matchesQuery(isNull, row({ title: 'x' })), false);

	const notEqual = q({ where: [{ field: 'priority', op: '!=', value: 3 }] });
	assert.equal(matchesQuery(notEqual, row({ priority: 4 })), true);
	// Firestore semantics: null column excluded from != - matching IS NOT NULL.
	assert.equal(matchesQuery(notEqual, row({ priority: null })), false);
});

test('parity: json paths and array-contains over parsed json columns', () => {
	const author = q({ where: [{ field: 'meta.author', op: '==', value: 'ada' }] });
	assert.equal(matchesQuery(author, row({ meta: { author: 'ada' } })), true);
	assert.equal(matchesQuery(author, row({ meta: null })), false);

	const tags = q({ where: [{ field: 'meta.tags', op: 'array-contains', value: 'x' }] });
	assert.equal(matchesQuery(tags, row({ meta: { tags: ['x', 'y'] } })), true);
	assert.equal(matchesQuery(tags, row({ meta: { tags: 'x' } })), false);
});

test('parity: owner scoping matches the compiled owner column condition', () => {
	const query = q({});
	assert.equal(matchesQuery(query, row({ title: 'x' }, 'user-1'), 'user-1'), true);
	assert.equal(matchesQuery(query, row({ title: 'x' }, 'user-2'), 'user-1'), false);
});

test('parity: the shared comparator orders like the compiled ORDER BY', () => {
	const query = q({ orderBy: [{ field: 'priority', direction: 'desc' }] });
	const compare = orderComparator(query);
	const rows = [
		{ id: 'b', data: { priority: 1 } },
		{ id: 'a', data: { priority: 3 } },
		{ id: 'c', data: { priority: 3 } },
	];
	assert.deepEqual(
		[...rows].sort(compare).map((entry) => entry.id),
		['a', 'c', 'b'],
	);
});
