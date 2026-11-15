import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	duplicateRestorePointIds,
	isPlatformShard,
	remoteConfigPublishSummary,
	MAX_REMOTE_CONFIG_VALUE_BYTES,
	remoteConfigKeySchema,
	remoteConfigPending,
	remoteConfigValueIssue,
	REMOTE_CONFIG_COLUMNS,
	REMOTE_CONFIG_TABLE,
	tableColumnsSchema,
} from './schemas.js';

/**
 * Remote Config's pure parts: the value/type check, the pending rule the whole
 * draft model hangs off, and the platform-shard reservation.
 *
 * The declared columns are parsed here too. They are the one place a typo would
 * not show up until a project tried to provision the table on a deployed agent
 * - by which point the failure is a 500 in someone else's console.
 */

test('the declared columns are a valid table schema', () => {
	const columns = tableColumnsSchema.parse(REMOTE_CONFIG_COLUMNS);
	assert.deepEqual(
		columns.map((column) => column.name),
		[
			'value_type',
			'draft_value',
			'published_value',
			'draft_conditions',
			'published_conditions',
			'state',
			'description',
			'updated_by',
		],
	);
	// Every value and rule column must be json: a config value is any JSON, and
	// a scalar column would quietly reject an object default.
	for (const name of [
		'draft_value',
		'published_value',
		'draft_conditions',
		'published_conditions',
	]) {
		assert.equal(columns.find((column) => column.name === name)?.type, 'json', name);
	}
	// The draft/published pairs must be NULLABLE, which is what lets the DDL
	// planner add them to a table an earlier version already created - a project
	// provisioned before targeting existed gains them on next touch rather than
	// needing a migration nobody can run.
	for (const name of ['draft_conditions', 'published_conditions']) {
		assert.equal(columns.find((column) => column.name === name)?.nullable, true, name);
	}
});

test('values are checked against their declared type', () => {
	assert.equal(remoteConfigValueIssue('boolean', true), null);
	assert.equal(remoteConfigValueIssue('number', 25), null);
	assert.equal(remoteConfigValueIssue('string', 'eur'), null);
	assert.equal(remoteConfigValueIssue('json', { variant: 'b' }), null);
	assert.equal(remoteConfigValueIssue('json', [1, 2]), null);
	// null is a legitimate json value and the reason json is not just "object".
	assert.equal(remoteConfigValueIssue('json', null), null);

	assert.match(remoteConfigValueIssue('boolean', 'yes') ?? '', /boolean/);
	assert.match(remoteConfigValueIssue('number', '25') ?? '', /number/);
	assert.match(remoteConfigValueIssue('string', 25) ?? '', /string/);
	// A scalar in a json parameter is a mistake worth naming: the operator
	// wanted one of the three scalar types.
	assert.match(remoteConfigValueIssue('json', 'plain') ?? '', /scalar types/);
	assert.match(remoteConfigValueIssue('string', undefined) ?? '', /required/);
	// NaN and Infinity do not survive JSON, so they are not numbers here.
	assert.match(remoteConfigValueIssue('number', Number.NaN) ?? '', /number/);
	assert.match(remoteConfigValueIssue('number', Number.POSITIVE_INFINITY) ?? '', /number/);
});

test('a value too large to ship on every app start is refused', () => {
	const huge = 'x'.repeat(MAX_REMOTE_CONFIG_VALUE_BYTES + 1);
	assert.match(remoteConfigValueIssue('string', huge) ?? '', /limited to/);
	assert.equal(remoteConfigValueIssue('string', 'x'.repeat(64)), null);
});

test('keys are client identifiers, so they read like one', () => {
	for (const key of ['checkoutV2', 'max_upload_mb', 'a', 'feature-flag']) {
		assert.equal(remoteConfigKeySchema.safeParse(key).success, true, key);
	}
	for (const key of ['9lives', '_private', 'has space', 'trailing/slash', '', 'x'.repeat(65)]) {
		assert.equal(remoteConfigKeySchema.safeParse(key).success, false, key);
	}
});

test('pending is what the publish button counts', () => {
	// Never published: pending whatever the values say.
	assert.equal(
		remoteConfigPending({ state: 'draft', draftValue: false, publishedValue: null }),
		true,
	);
	// Marked for removal: pending, because the removal has not happened yet.
	assert.equal(remoteConfigPending({ state: 'deleting', draftValue: 1, publishedValue: 1 }), true);
	// Live and unchanged.
	assert.equal(
		remoteConfigPending({ state: 'published', draftValue: 1, publishedValue: 1 }),
		false,
	);
	// Live and edited.
	assert.equal(remoteConfigPending({ state: 'published', draftValue: 2, publishedValue: 1 }), true);
	// Structural equality, not identity - two equal objects are not a change,
	// or every page load would report edits nobody made.
	assert.equal(
		remoteConfigPending({
			state: 'published',
			draftValue: { a: [1, 2] },
			publishedValue: { a: [1, 2] },
		}),
		false,
	);
	// null and undefined both mean "no value" and must not read as a change.
	assert.equal(
		remoteConfigPending({ state: 'published', draftValue: null, publishedValue: undefined }),
		false,
	);
});

test('the platform namespace is a prefix, so the next feature needs no new rule', () => {
	assert.equal(isPlatformShard(REMOTE_CONFIG_TABLE), true);
	assert.equal(isPlatformShard('cfb_anything_later'), true);
	// An operator's own tables are untouched, including ones that merely start
	// with the letters.
	assert.equal(isPlatformShard('cfb'), false);
	assert.equal(isPlatformShard('cfbase_notes'), false);
	assert.equal(isPlatformShard('remote_config'), false);
	assert.equal(isPlatformShard('todos'), false);
});

test('a publish label says what happened to which keys, in words', () => {
	assert.equal(
		remoteConfigPublishSummary({ added: ['signupsOpen'], edited: ['maxUploadMb'], removed: [] }),
		'added signupsOpen · edited maxUploadMb',
	);
	assert.equal(
		remoteConfigPublishSummary({ added: [], edited: [], removed: ['promoBanner'] }),
		'removed promoBanner',
	);
	// Nothing pending answers the plain word rather than an empty string.
	assert.equal(remoteConfigPublishSummary({ added: [], edited: [], removed: [] }), 'publish');

	// The checkpoint reason caps at 80 chars: key lists collapse to counts from
	// the back until the label fits, and it NEVER exceeds the cap.
	const many = Array.from({ length: 30 }, (_, at) => `parameterNumber${at}`);
	const collapsed = remoteConfigPublishSummary({ added: ['one'], edited: many, removed: [] });
	assert.ok(collapsed.length <= 80, collapsed);
	assert.equal(collapsed, 'added one · edited 30');
	const allCounts = remoteConfigPublishSummary({ added: many, edited: many, removed: many });
	assert.equal(allCounts, 'added 30 · edited 30 · removed 30');
});

test('one bookmark keeps one restore point, under its original label', () => {
	// Publish (id 2), then an immediate rollback captured the SAME bookmark as
	// "before rollback" (id 3) - the flow that broke the version list. Rows
	// arrive newest-first, as adminRestorePoints reads them.
	const rows = [
		{ id: 3, bookmark: 'bm-2' }, // before rollback - the duplicate
		{ id: 2, bookmark: 'bm-2' }, // the publish that created the state
		{ id: 1, bookmark: 'bm-1' },
	];
	assert.deepEqual(duplicateRestorePointIds(rows), [3]);

	// No duplicates, nothing to remove - and an undo chain that re-captures an
	// OLD bookmark loses the re-capture, not the original.
	assert.deepEqual(duplicateRestorePointIds([{ id: 1, bookmark: 'bm-1' }]), []);
	assert.deepEqual(
		duplicateRestorePointIds([
			{ id: 4, bookmark: 'bm-1' },
			{ id: 3, bookmark: 'bm-2' },
			{ id: 1, bookmark: 'bm-1' },
		]),
		[4],
	);
	assert.deepEqual(duplicateRestorePointIds([]), []);
});
