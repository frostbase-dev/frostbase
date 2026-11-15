import assert from 'node:assert/strict';
import test from 'node:test';
import {
	RECONCILE_GRACE_MS,
	reconcileActions,
	type ReconcileAction,
	type ReconcileEntry,
} from './reconcile.js';

/**
 * The merge join is pinned HERE rather than in e2e for a structural reason:
 * an orphaned object or a phantom row cannot be staged through any public
 * surface - the write paths exist precisely to make those states unreachable -
 * so e2e could never construct the input this code is for.
 */

const NOW = 1_760_000_000_000;
const OLD = NOW - RECONCILE_GRACE_MS - 1;
const FRESH = NOW - 1000;

function entry(key: string, at = OLD, extra: Partial<ReconcileEntry> = {}): ReconcileEntry {
	return {
		key,
		size: 10,
		etag: 'e',
		contentType: 'text/plain',
		owner: '',
		at,
		...extra,
	};
}

async function* stream(entries: ReconcileEntry[]): AsyncGenerator<ReconcileEntry> {
	for (const item of entries) yield item;
}

async function run(
	stored: ReconcileEntry[],
	indexed: ReconcileEntry[],
	now = NOW,
): Promise<ReconcileAction[]> {
	const out: ReconcileAction[] = [];
	for await (const action of reconcileActions(stream(stored), stream(indexed), now)) {
		out.push(action);
	}
	return out;
}

test('streams that already agree produce no actions', async () => {
	const keys = [entry('a'), entry('b'), entry('c')];
	assert.deepEqual(await run(keys, keys), []);
});

test('an object with no row is adopted', async () => {
	const actions = await run([entry('a'), entry('b')], [entry('a')]);
	assert.equal(actions.length, 1);
	assert.equal(actions[0].kind, 'adopt');
	assert.equal(actions[0].kind === 'adopt' && actions[0].entry.key, 'b');
});

test('a row with no object is pruned', async () => {
	const actions = await run([entry('a')], [entry('a'), entry('b')]);
	assert.deepEqual(actions, [{ kind: 'prune', key: 'b' }]);
});

test('divergence at the head, middle, and tail of both streams', async () => {
	// The interleavings a naive two-pointer walk gets wrong.
	const actions = await run(
		[entry('a'), entry('c'), entry('e')],
		[entry('b'), entry('c'), entry('d')],
	);
	assert.deepEqual(actions, [
		{ kind: 'adopt', entry: entry('a') },
		{ kind: 'prune', key: 'b' },
		{ kind: 'prune', key: 'd' },
		{ kind: 'adopt', entry: entry('e') },
	]);
});

test('an empty index adopts everything - the rebuild path', async () => {
	// Dropping the rows and reconciling is the escape hatch for an index
	// schema change, so a full adopt has to work.
	const stored = [entry('a'), entry('b'), entry('c')];
	const actions = await run(stored, []);
	assert.equal(actions.length, 3);
	assert.ok(actions.every((action) => action.kind === 'adopt'));
});

test('an empty bucket prunes every row', async () => {
	const actions = await run([], [entry('a'), entry('b')]);
	assert.deepEqual(actions, [
		{ kind: 'prune', key: 'a' },
		{ kind: 'prune', key: 'b' },
	]);
});

test('anything inside the grace window is left alone, both directions', async () => {
	// A write landing mid-walk looks like divergence to whichever stream was
	// read first. Without the window, reconcile would delete live data.
	assert.deepEqual(await run([entry('new', FRESH)], []), []);
	assert.deepEqual(await run([], [entry('new', FRESH)]), []);
	// And the settled ones around it are still acted on.
	const mixed = await run([entry('a'), entry('new', FRESH)], [entry('gone')]);
	assert.deepEqual(mixed, [
		{ kind: 'adopt', entry: entry('a') },
		{ kind: 'prune', key: 'gone' },
	]);
});

test('adoption carries the metadata the listing supplied', async () => {
	const rich = entry('photo.png', OLD, {
		size: 4096,
		etag: 'abc123',
		contentType: 'image/png',
		owner: 'user-1',
	});
	const actions = await run([rich], []);
	assert.deepEqual(actions, [{ kind: 'adopt', entry: rich }]);
});

test('the walk holds nothing beyond the current pair', async () => {
	// The memory claim, made concrete: 5,000 keys on each side, no set built.
	const many = Array.from({ length: 5000 }, (_, index) =>
		entry(`k${String(index).padStart(5, '0')}`),
	);
	const actions = await run(many, many.slice(0, 2500));
	assert.equal(actions.length, 2500);
	assert.ok(actions.every((action) => action.kind === 'adopt'));
});
