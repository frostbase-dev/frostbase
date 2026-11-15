import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	aggregateDocs,
	compileAggregate,
	compileQuery,
	decodeCursor,
	encodeCursor,
	getPath,
	isWindowed,
	matchesQuery,
	orderComparator,
} from './query.js';
import {
	aggregateRequestSchema,
	querySchema,
	type AggregateRequest,
	type Query,
} from './schemas.js';

/**
 * The SQL compiler and the JS matcher are derived from one parsed Query and
 * MUST agree - snapshots come from SQL, live deltas from the matcher. The
 * compiler is pinned with exact SQL + bound params; the matcher with
 * behavioral fixtures over the same clauses. End-to-end SQL-vs-JS parity on
 * real SQLite is pinned by the live-query e2e spec.
 */

function q(input: unknown): Query {
	return querySchema.parse(input);
}

const doc = (id: string, data: Record<string, unknown>, owner: string | null = null) => ({
	id,
	data,
	owner,
});

test('compiler: equality, null semantics, and bound params', () => {
	const compiled = compileQuery(q({ where: [{ field: 'status', op: '==', value: 'open' }] }));
	assert.equal(compiled.whereSql, `json_extract(data, '$.status') = ?`);
	assert.deepEqual(compiled.params, ['open']);

	const isNull = compileQuery(q({ where: [{ field: 'status', op: '==', value: null }] }));
	assert.equal(isNull.whereSql, `json_extract(data, '$.status') IS NULL`);
	assert.deepEqual(isNull.params, []);

	const notEqual = compileQuery(q({ where: [{ field: 'n', op: '!=', value: 3 }] }));
	assert.equal(
		notEqual.whereSql,
		`json_extract(data, '$.n') IS NOT NULL AND json_extract(data, '$.n') != ?`,
	);
	assert.deepEqual(notEqual.params, [3]);
});

test('compiler: booleans bind as 1/0, matching SQLite JSON representation', () => {
	const compiled = compileQuery(q({ where: [{ field: 'done', op: '==', value: true }] }));
	assert.deepEqual(compiled.params, [1]);
});

test('compiler: in and array-contains', () => {
	const inQuery = compileQuery(q({ where: [{ field: 'p', op: 'in', value: [1, 2, 3] }] }));
	assert.equal(inQuery.whereSql, `json_extract(data, '$.p') IN (?, ?, ?)`);
	assert.deepEqual(inQuery.params, [1, 2, 3]);

	const contains = compileQuery(
		q({ where: [{ field: 'tags', op: 'array-contains', value: 'urgent' }] }),
	);
	assert.match(contains.whereSql, /json_type\(data, '\$\.tags'\) = 'array' AND EXISTS/);
	assert.deepEqual(contains.params, ['urgent']);
});

test('compiler: order, limit, and the id tiebreak', () => {
	const compiled = compileQuery(
		q({ orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: 50 }),
	);
	assert.equal(compiled.whereSql, '1=1');
	assert.equal(compiled.orderSql, `json_extract(data, '$.createdAt') DESC, id ASC`);
	assert.equal(compiled.limit, 50);
});

test('compiler: owner scoping is a bound column condition', () => {
	const compiled = compileQuery(q({}), { ownerSub: 'user-1' });
	assert.equal(compiled.whereSql, 'owner = ?');
	assert.deepEqual(compiled.params, ['user-1']);
});

test('compiler: keyset cursor produces the strict-after continuation', () => {
	const query = q({ orderBy: [{ field: 'age', direction: 'asc' }], limit: 2 });
	const cursor = decodeCursor(encodeCursor({ values: [30], id: 'doc-b' }));
	assert.ok(cursor);
	const compiled = compileQuery(query, { cursor });
	assert.equal(
		compiled.whereSql,
		`((json_extract(data, '$.age') > ?) OR (json_extract(data, '$.age') = ? AND id > ?))`,
	);
	assert.deepEqual(compiled.params, [30, 30, 'doc-b']);
});

test('cursor: a cursor from a different query shape is ignored, and garbage decodes to null', () => {
	const compiled = compileQuery(q({ orderBy: [{ field: 'a', direction: 'asc' }] }), {
		cursor: { values: [1, 2], id: 'x' },
	});
	assert.equal(compiled.whereSql, '1=1');
	assert.equal(decodeCursor('not-base64!!'), null);
	assert.equal(decodeCursor(btoa('{"nope":true}')), null);
});

test('matcher: equality and Firestore != semantics (missing field excluded)', () => {
	const query = q({ where: [{ field: 'status', op: '!=', value: 'done' }] });
	assert.equal(matchesQuery(query, doc('a', { status: 'open' })), true);
	assert.equal(matchesQuery(query, doc('b', { status: 'done' })), false);
	assert.equal(matchesQuery(query, doc('c', {})), false); // missing -> excluded

	const isNull = q({ where: [{ field: 'status', op: '==', value: null }] });
	assert.equal(matchesQuery(isNull, doc('d', {})), true); // missing == null
	assert.equal(matchesQuery(isNull, doc('e', { status: null })), true);
	assert.equal(matchesQuery(isNull, doc('f', { status: 'x' })), false);
});

test('matcher: boolean/number normalization matches the SQL representation', () => {
	const query = q({ where: [{ field: 'done', op: '==', value: true }] });
	assert.equal(matchesQuery(query, doc('a', { done: true })), true);
	assert.equal(matchesQuery(query, doc('b', { done: 1 })), true); // SQLite stores true as 1
	assert.equal(matchesQuery(query, doc('c', { done: false })), false);
	assert.equal(matchesQuery(query, doc('d', { done: 'true' })), false);
});

test('matcher: range comparisons are same-type only', () => {
	const query = q({ where: [{ field: 'age', op: '>=', value: 21 }] });
	assert.equal(matchesQuery(query, doc('a', { age: 30 })), true);
	assert.equal(matchesQuery(query, doc('b', { age: 20 })), false);
	assert.equal(matchesQuery(query, doc('c', { age: '30' })), false); // cross-type: no match
	assert.equal(matchesQuery(query, doc('d', {})), false);
});

test('matcher: in, array-contains, nested paths, owner scoping', () => {
	const inQuery = q({ where: [{ field: 'priority', op: 'in', value: [1, 2] }] });
	assert.equal(matchesQuery(inQuery, doc('a', { priority: 2 })), true);
	assert.equal(matchesQuery(inQuery, doc('b', { priority: 3 })), false);

	const contains = q({ where: [{ field: 'tags', op: 'array-contains', value: 'urgent' }] });
	assert.equal(matchesQuery(contains, doc('c', { tags: ['urgent', 'bug'] })), true);
	assert.equal(matchesQuery(contains, doc('d', { tags: 'urgent' })), false); // scalar: no
	assert.equal(matchesQuery(contains, doc('e', {})), false);

	const nested = q({ where: [{ field: 'author.name', op: '==', value: 'ada' }] });
	assert.equal(matchesQuery(nested, doc('f', { author: { name: 'ada' } })), true);
	assert.equal(matchesQuery(nested, doc('g', { author: 'ada' })), false);

	const anyQuery = q({});
	assert.equal(matchesQuery(anyQuery, doc('h', {}, 'user-1'), 'user-1'), true);
	assert.equal(matchesQuery(anyQuery, doc('i', {}, 'user-2'), 'user-1'), false);
	assert.equal(matchesQuery(anyQuery, doc('j', {}, null), 'user-1'), false);
});

test('comparator: field order, direction, null-first ranking, id tiebreak', () => {
	const query = q({ orderBy: [{ field: 'score', direction: 'desc' }] });
	const compare = orderComparator(query);
	const docs = [
		doc('a', { score: 1 }),
		doc('b', { score: 3 }),
		doc('c', {}), // missing -> null -> ranks lowest -> LAST in desc
		doc('d', { score: 3 }),
	];
	const sorted = [...docs].sort(compare).map((entry) => entry.id);
	assert.deepEqual(sorted, ['b', 'd', 'a', 'c']);

	const byName = orderComparator(q({ orderBy: [{ field: 'name', direction: 'asc' }] }));
	const names = [doc('x', { name: 'b' }), doc('y', { name: 'a' }), doc('z', { name: 'a' })];
	assert.deepEqual(
		[...names].sort(byName).map((entry) => entry.id),
		['y', 'z', 'x'],
	);
});

test('getPath and isWindowed', () => {
	assert.equal(getPath({ a: { b: 2 } }, 'a.b'), 2);
	assert.equal(getPath({ a: 1 }, 'a.b'), null);
	assert.equal(getPath({}, 'missing'), null);

	assert.equal(isWindowed(q({ limit: 5, orderBy: [{ field: 'a', direction: 'asc' }] })), true);
	assert.equal(isWindowed(q({ limit: 5 })), false);
	assert.equal(isWindowed(q({ orderBy: [{ field: 'a', direction: 'asc' }] })), false);
});

function agg(input: unknown): AggregateRequest {
	return aggregateRequestSchema.parse(input);
}

test('aggregate compiler: count, sum, avg with the shared where compilation', () => {
	const compiled = compileAggregate(
		agg({
			where: [{ field: 'status', op: '==', value: 'open' }],
			aggregates: { total: { op: 'count' }, votes: { op: 'sum', field: 'votes' } },
		}),
	);
	assert.equal(
		compiled.sql,
		`SELECT COUNT(*) AS agg_0, ` +
			`COALESCE(SUM(CASE WHEN json_type(data, '$.votes') IN ('integer', 'real') ` +
			`THEN json_extract(data, '$.votes') END), 0) AS agg_1 ` +
			`FROM documents WHERE json_extract(data, '$.status') = ?`,
	);
	assert.deepEqual(compiled.params, ['open']);
	assert.deepEqual(compiled.aliases, ['total', 'votes']);

	const avg = compileAggregate(agg({ aggregates: { mean: { op: 'avg', field: 'age' } } }), {
		ownerSub: 'user-1',
	});
	assert.match(avg.sql, /AVG\(CASE WHEN json_type\(data, '\$\.age'\)/);
	assert.match(avg.sql, /WHERE owner = \?$/);
	assert.deepEqual(avg.params, ['user-1']);
});

test('aggregate JS side: count/sum/avg skip non-numeric values, Firestore-style', () => {
	const docs = [
		doc('a', { votes: 3, status: 'open' }),
		doc('b', { votes: 5, status: 'open' }),
		doc('c', { votes: 'many', status: 'open' }), // string: skipped by sum/avg
		doc('d', { votes: true, status: 'open' }), // boolean: skipped too
		doc('e', { status: 'open' }), // missing: skipped
		doc('f', { votes: 100, status: 'done' }), // filtered out by where
	];
	const request = agg({
		where: [{ field: 'status', op: '==', value: 'open' }],
		aggregates: {
			total: { op: 'count' },
			votes: { op: 'sum', field: 'votes' },
			mean: { op: 'avg', field: 'votes' },
		},
	});
	assert.deepEqual(aggregateDocs(request, docs), { total: 5, votes: 8, mean: 4 });

	// Empty matches: count 0, sum 0, avg null - the SQL side's exact shape.
	const none = agg({
		where: [{ field: 'status', op: '==', value: 'nope' }],
		aggregates: {
			total: { op: 'count' },
			votes: { op: 'sum', field: 'votes' },
			mean: { op: 'avg', field: 'votes' },
		},
	});
	assert.deepEqual(aggregateDocs(none, docs), { total: 0, votes: 0, mean: null });

	// Owner scoping applies before aggregation, like every query.
	const owned = [doc('a', { n: 1 }, 'u1'), doc('b', { n: 2 }, 'u2')];
	assert.deepEqual(aggregateDocs(agg({ aggregates: { total: { op: 'count' } } }), owned, 'u1'), {
		total: 1,
	});
});

test('aggregate schema: alias grammar, op/field pairing, and the 1-5 window', () => {
	assert.equal(aggregateRequestSchema.safeParse({ aggregates: {} }).success, false);
	assert.equal(
		aggregateRequestSchema.safeParse({ aggregates: { total: { op: 'count', field: 'x' } } })
			.success,
		false,
	);
	assert.equal(
		aggregateRequestSchema.safeParse({ aggregates: { votes: { op: 'sum' } } }).success,
		false,
	);
	assert.equal(
		aggregateRequestSchema.safeParse({ aggregates: { 'bad alias': { op: 'count' } } }).success,
		false,
	);
	const six = Object.fromEntries(
		['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => [alias, { op: 'count' }]),
	);
	assert.equal(aggregateRequestSchema.safeParse({ aggregates: six }).success, false);
});

test('schema: query validation rejects what the engine cannot honor', () => {
	assert.equal(
		querySchema.safeParse({ where: [{ field: 'a', op: 'in', value: 1 }] }).success,
		false,
	);
	assert.equal(
		querySchema.safeParse({ where: [{ field: 'a', op: '<', value: null }] }).success,
		false,
	);
	assert.equal(
		querySchema.safeParse({ where: [{ field: 'bad-field!', op: '==', value: 1 }] }).success,
		false,
	);
	assert.equal(querySchema.safeParse({ limit: 0 }).success, false);
	assert.equal(querySchema.safeParse({ limit: 201 }).success, false);
});
