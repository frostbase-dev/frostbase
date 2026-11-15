import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShardRole, pickSubscribeSibling, replicaName } from './replication.js';
import { regionHint, DEFAULT_REGION, REGION_HINTS } from './region.js';
import { socketReportStep } from './schemas.js';

/**
 * The pure halves of the replication substrate: role parsing (what makes an
 * instance a replica), the geography map, and the sibling-spawn pick. The
 * log helpers need real SQLite and are pinned by the replication e2e spec
 * instead.
 */

test('roles: primaries are anything without the reserved suffix', () => {
	assert.deepEqual(parseShardRole('proj:todos'), { kind: 'primary' });
	assert.deepEqual(parseShardRole('proj:my-table_2'), { kind: 'primary' });
	assert.deepEqual(parseShardRole(undefined), { kind: 'primary' });
	// A shard whose NAME merely contains r is not a replica.
	assert.deepEqual(parseShardRole('proj:river'), { kind: 'primary' });
});

test('roles: the :r:<region>:<n> suffix parses into a replica role', () => {
	const role = parseShardRole('proj:todos:r:weur:1');
	assert.deepEqual(role, {
		kind: 'replica',
		region: 'weur',
		n: 1,
		primaryName: 'proj:todos',
		replicaId: 'r:weur:1',
	});
});

test('roles: replicaName round-trips through parseShardRole', () => {
	const name = replicaName('proj:orders', 'apac', 3);
	assert.equal(name, 'proj:orders:r:apac:3');
	const role = parseShardRole(name);
	assert.equal(role.kind, 'replica');
	if (role.kind === 'replica') {
		assert.equal(role.primaryName, 'proj:orders');
		assert.equal(role.n, 3);
	}
});

test('regions: continents map to hints, with longitude splitting NA and EU', () => {
	assert.equal(regionHint({ continent: 'NA', longitude: '-122.4' }), 'wnam'); // SF
	assert.equal(regionHint({ continent: 'NA', longitude: '-74.0' }), 'enam'); // NYC
	assert.equal(regionHint({ continent: 'EU', longitude: '2.35' }), 'weur'); // Paris
	assert.equal(regionHint({ continent: 'EU', longitude: '21.0' }), 'eeur'); // Warsaw
	assert.equal(regionHint({ continent: 'SA' }), 'sam');
	assert.equal(regionHint({ continent: 'OC' }), 'oc');
	assert.equal(regionHint({ continent: 'AF' }), 'afr');
});

test('regions: Middle-East countries beat the AS default; unknowns fall back', () => {
	assert.equal(regionHint({ continent: 'AS', country: 'AE' }), 'me');
	assert.equal(regionHint({ continent: 'AS', country: 'JP' }), 'apac');
	assert.equal(regionHint({}), DEFAULT_REGION);
	assert.equal(regionHint({ continent: 'NA' }), 'enam'); // no longitude
});

test('siblings: no replicas or headroom on 1 means sibling 1', () => {
	assert.equal(pickSubscribeSibling([], 24_000, 8), 1);
	assert.equal(pickSubscribeSibling([100], 24_000, 8), 1);
	assert.equal(pickSubscribeSibling([23_999], 24_000, 8), 1);
});

test('siblings: a full sibling 1 spawns sibling 2 (unregistered counts as 0)', () => {
	assert.equal(pickSubscribeSibling([24_000], 24_000, 8), 2);
	// Registered-but-light sibling 2 keeps taking traffic before a 3 spawns.
	assert.equal(pickSubscribeSibling([24_000, 3], 24_000, 8), 2);
});

test('siblings: drained lower siblings are reused before spawning higher', () => {
	assert.equal(pickSubscribeSibling([1_000, 20_000], 24_000, 8), 1);
	assert.equal(pickSubscribeSibling([24_000, 24_000, 500], 24_000, 8), 3);
});

test('siblings: all full falls back to the least loaded, never past the cap', () => {
	const full = Array.from({ length: 8 }, (_, index) => 24_000 + index * 10);
	assert.equal(pickSubscribeSibling(full, 24_000, 8), 1);
	full[4] = 24_001;
	full[0] = 30_000;
	assert.equal(pickSubscribeSibling(full, 24_000, 8), 5);
	// A ninth sibling never exists, whatever the counts say.
	const nine = Array.from({ length: 9 }, () => 24_000);
	assert.ok(pickSubscribeSibling(nine, 24_000, 8) <= 8);
});

test('siblings: the report step scales with the threshold but never hits 0', () => {
	assert.equal(socketReportStep(24_000), 1_500);
	assert.equal(socketReportStep(2), 1);
	assert.equal(socketReportStep(1), 1);
});

test('regions: every hint the map can produce is a legal location hint', () => {
	const cases = [
		{ continent: 'NA', longitude: '-122' },
		{ continent: 'NA', longitude: '-70' },
		{ continent: 'EU', longitude: '0' },
		{ continent: 'EU', longitude: '25' },
		{ continent: 'SA' },
		{ continent: 'AS', country: 'JP' },
		{ continent: 'AS', country: 'SA' },
		{ continent: 'OC' },
		{ continent: 'AF' },
		{},
	];
	for (const geo of cases) {
		assert.ok(REGION_HINTS.has(regionHint(geo)), JSON.stringify(geo));
	}
});
