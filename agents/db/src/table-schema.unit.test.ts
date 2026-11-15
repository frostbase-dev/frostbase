import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	applyColumnDefaults,
	isDuplicateColumnError,
	planDdl,
	quoteIdent,
	rowDataFromSql,
	selectList,
	toSqlValue,
	validateRow,
} from './table-schema.js';
import { tableColumnsSchema, type TableColumn } from './schemas.js';

/**
 * The DDL planner and the row validator are what stand between user input
 * and raw SQL against a storage engine whose affinity accepts anything -
 * these fixtures pin the refusals as hard as the happy paths.
 */

function cols(...input: Record<string, unknown>[]): TableColumn[] {
	return tableColumnsSchema.parse(input);
}

const TODO = cols(
	{ name: 'title', type: 'text', nullable: false },
	{ name: 'done', type: 'boolean', default: false },
	{ name: 'priority', type: 'integer', min: 1, max: 5, default: 3 },
	{ name: 'meta', type: 'json' },
);

// ---------------------------------------------------------------------------
// Schema-level refusals (zod)

test('schema: reserved and duplicate column names are refused', () => {
	for (const reserved of ['id', 'owner', 'created_at', 'updated_at']) {
		assert.equal(
			tableColumnsSchema.safeParse([{ name: reserved, type: 'text' }]).success,
			false,
			`"${reserved}" must be reserved`,
		);
	}
	assert.equal(
		tableColumnsSchema.safeParse([
			{ name: 'a', type: 'text' },
			{ name: 'a', type: 'integer' },
		]).success,
		false,
	);
});

test('schema: defaults must fit the type; json takes no default', () => {
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 'n', type: 'integer', default: 'x' }]).success,
		false,
	);
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 'n', type: 'integer', default: 1.5 }]).success,
		false,
	);
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 'j', type: 'json', default: 'x' }]).success,
		false,
	);
	// NOT NULL without a default is LEGAL - it means required-on-write.
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 't', type: 'text', nullable: false }]).success,
		true,
	);
});

test('schema: bounds bind to their types', () => {
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 'n', type: 'integer', maxLength: 3 }]).success,
		false,
	);
	assert.equal(tableColumnsSchema.safeParse([{ name: 't', type: 'text', min: 1 }]).success, false);
	assert.equal(
		tableColumnsSchema.safeParse([{ name: 'b', type: 'boolean', enum: [true] }]).success,
		false,
	);
});

// ---------------------------------------------------------------------------
// Row validation and defaults

test('validateRow: unknown columns are always rejected', () => {
	const issues = validateRow(TODO, { title: 'x', extra: 1 });
	assert.deepEqual(issues, ['"extra" is not a declared column']);
});

test('validateRow: required means NOT NULL without default', () => {
	assert.deepEqual(validateRow(TODO, {}), ['"title" is required']);
	assert.deepEqual(validateRow(TODO, { title: null }), ['"title" cannot be null']);
	assert.deepEqual(validateRow(TODO, { title: 'x' }), []);
});

test('validateRow: types are enforced in JS, not left to affinity', () => {
	assert.deepEqual(validateRow(TODO, { title: 7 }), ['"title" must be a text, got number']);
	assert.deepEqual(validateRow(TODO, { title: 'x', priority: 2.5 }), [
		'"priority" must be an integer, got number',
	]);
	assert.deepEqual(validateRow(TODO, { title: 'x', done: 'yes' }), [
		'"done" must be a boolean, got string',
	]);
	// json accepts any JSON value.
	assert.deepEqual(validateRow(TODO, { title: 'x', meta: { a: [1] } }), []);
	assert.deepEqual(validateRow(TODO, { title: 'x', meta: 'scalar' }), []);
});

test('validateRow: bounds and enum', () => {
	assert.deepEqual(validateRow(TODO, { title: 'x', priority: 9 }), [
		'"priority" must be at most 5',
	]);
	const withEnum = cols({ name: 'state', type: 'text', enum: ['open', 'closed'] });
	assert.deepEqual(validateRow(withEnum, { state: 'gone' }), [
		'"state" must be one of: "open", "closed"',
	]);
	const bounded = cols({ name: 'slug', type: 'text', maxLength: 3 });
	assert.deepEqual(validateRow(bounded, { slug: 'abcd' }), ['"slug" is limited to 3 characters']);
});

test('validateRow: skipPolicy bypasses bounds and enum but never structure', () => {
	const bounded = cols({ name: 'state', type: 'text', enum: ['open'], maxLength: 2 });
	// Policy violations pass on operator surfaces...
	assert.deepEqual(validateRow(bounded, { state: 'closed' }, { skipPolicy: true }), []);
	// ...but structure always holds: the schema IS the storage.
	assert.deepEqual(validateRow(bounded, { state: 7 }, { skipPolicy: true }), [
		'"state" must be a text, got number',
	]);
	assert.deepEqual(validateRow(bounded, { ghost: 1 }, { skipPolicy: true }), [
		'"ghost" is not a declared column',
	]);
});

test('applyColumnDefaults: defaults then null; required stays absent', () => {
	const full = applyColumnDefaults(TODO, { title: 'x' });
	assert.deepEqual(full, { title: 'x', done: false, priority: 3, meta: null });
	// title has no default and is NOT NULL: left absent so validateRow reports.
	assert.equal('title' in applyColumnDefaults(TODO, {}), false);
});

// ---------------------------------------------------------------------------
// DDL planning

test('planDdl: full create emits table, system indexes, column indexes', () => {
	const withIndexes = cols(
		{ name: 'email', type: 'text', unique: true },
		{ name: 'age', type: 'integer', index: true },
	);
	const plan = planDdl('users', null, withIndexes);
	assert.equal(plan.ok, true);
	if (!plan.ok) return;
	assert.match(
		plan.statements[0],
		/^CREATE TABLE IF NOT EXISTS "users" \("id" TEXT PRIMARY KEY, "owner" TEXT, "created_at" INTEGER NOT NULL DEFAULT \(CAST.*"updated_at" INTEGER NOT NULL DEFAULT \(CAST.*"email" TEXT, "age" INTEGER\)$/,
	);
	assert.ok(
		plan.statements.includes('CREATE INDEX IF NOT EXISTS "idx_users_owner" ON "users" ("owner")'),
	);
	assert.ok(
		plan.statements.includes(
			'CREATE UNIQUE INDEX IF NOT EXISTS "uniq_users_email" ON "users" ("email")',
		),
	);
	assert.ok(
		plan.statements.includes('CREATE INDEX IF NOT EXISTS "idx_users_age" ON "users" ("age")'),
	);
});

test('planDdl: NOT NULL columns carry their backfill default on create', () => {
	const plan = planDdl(
		't',
		null,
		cols({ name: 'state', type: 'text', nullable: false, default: 'open' }),
	);
	assert.equal(plan.ok, true);
	if (!plan.ok) return;
	assert.match(plan.statements[0], /"state" TEXT NOT NULL DEFAULT 'open'/);
});

test('planDdl: additive column lands as ALTER; NOT NULL without default is refused', () => {
	const applied = cols({ name: 'title', type: 'text' });
	const grown = cols(
		{ name: 'title', type: 'text' },
		{ name: 'votes', type: 'integer', default: 0 },
	);
	const plan = planDdl('posts', applied, grown);
	assert.equal(plan.ok, true);
	if (plan.ok) {
		assert.deepEqual(plan.statements, ['ALTER TABLE "posts" ADD COLUMN "votes" INTEGER']);
	}

	const refused = planDdl(
		'posts',
		applied,
		cols({ name: 'title', type: 'text' }, { name: 'state', type: 'text', nullable: false }),
	);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.match(refused.reason, /cannot be added as NOT NULL without a default/);
});

test('planDdl: destructive changes are refused', () => {
	const applied = cols({ name: 'title', type: 'text' }, { name: 'votes', type: 'integer' });
	const removed = planDdl('t', applied, cols({ name: 'title', type: 'text' }));
	assert.equal(removed.ok, false);

	const retyped = planDdl(
		't',
		applied,
		cols({ name: 'title', type: 'json' }, { name: 'votes', type: 'integer' }),
	);
	assert.equal(retyped.ok, false);

	const nullability = planDdl(
		't',
		cols({ name: 'state', type: 'text', nullable: false, default: 'open' }),
		cols({ name: 'state', type: 'text', default: 'open' }),
	);
	assert.equal(nullability.ok, false);
});

test('planDdl: index toggles create and drop; metadata changes emit nothing', () => {
	const applied = cols({ name: 'email', type: 'text' });
	const uniqued = planDdl('u', applied, cols({ name: 'email', type: 'text', unique: true }));
	assert.equal(uniqued.ok, true);
	if (uniqued.ok) {
		assert.deepEqual(uniqued.statements, [
			'CREATE UNIQUE INDEX IF NOT EXISTS "uniq_u_email" ON "u" ("email")',
		]);
	}

	const dropped = planDdl('u', cols({ name: 'email', type: 'text', unique: true }), applied);
	assert.equal(dropped.ok, true);
	if (dropped.ok) assert.deepEqual(dropped.statements, ['DROP INDEX IF EXISTS "uniq_u_email"']);

	// default/bounds changes are write-path metadata, never DDL.
	const metadata = planDdl(
		'u',
		cols({ name: 'n', type: 'integer', default: 1, max: 5 }),
		cols({ name: 'n', type: 'integer', default: 2, max: 9 }),
	);
	assert.equal(metadata.ok, true);
	if (metadata.ok) assert.deepEqual(metadata.statements, []);
});

test('planDdl: identical schema plans zero statements', () => {
	const plan = planDdl('todos', TODO, TODO);
	assert.equal(plan.ok, true);
	if (plan.ok) assert.deepEqual(plan.statements, []);
});

// ---------------------------------------------------------------------------
// Conversions

test('sql round trip: booleans 1/0, json text, nulls', () => {
	const byName = new Map(TODO.map((column) => [column.name, column]));
	assert.equal(toSqlValue(byName.get('done')!, true), 1);
	assert.equal(toSqlValue(byName.get('done')!, false), 0);
	assert.equal(toSqlValue(byName.get('meta')!, { a: 1 }), '{"a":1}');
	assert.equal(toSqlValue(byName.get('title')!, null), null);

	const data = rowDataFromSql(TODO, {
		title: 'x',
		done: 1,
		priority: 3,
		meta: '{"a":[1,2]}',
	});
	assert.deepEqual(data, { title: 'x', done: true, priority: 3, meta: { a: [1, 2] } });
	// Unreadable json degrades to null rather than throwing mid-read.
	assert.deepEqual(rowDataFromSql(cols({ name: 'j', type: 'json' }), { j: '{oops' }), { j: null });
});

test('selectList and quoteIdent', () => {
	assert.equal(
		selectList(cols({ name: 'title', type: 'text' })),
		'"id", "owner", "created_at", "updated_at", "title"',
	);
	assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test('isDuplicateColumnError matches SQLite phrasing', () => {
	assert.equal(isDuplicateColumnError(new Error('duplicate column name: votes')), true);
	assert.equal(isDuplicateColumnError(new Error('UNIQUE constraint failed')), false);
});
