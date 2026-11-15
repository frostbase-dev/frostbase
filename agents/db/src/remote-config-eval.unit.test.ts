import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	compareVersions,
	evaluateAll,
	evaluateParameter,
	matchesCondition,
	payloadEtag,
	rolloutBucket,
	EMPTY_CONTEXT,
	type EvaluableParameter,
	type RemoteConfigContext,
} from './remote-config.js';
import { remoteConfigConditionSchema, type RemoteConfigCondition } from './schemas.js';

/**
 * The evaluator decides which cohort a caller lands in, so the cases that
 * matter most are the ones where it must NOT match: an unresolved country, an
 * absent token, a missing uid. Every one of those has to fail closed, because
 * the failure mode is serving a caller the value that was aimed at somebody
 * else - internal-only flags being the case that hurts.
 */

function condition(input: unknown): RemoteConfigCondition {
	return remoteConfigConditionSchema.parse(input);
}

function context(overrides: Partial<RemoteConfigContext> = {}): RemoteConfigContext {
	return { ...EMPTY_CONTEXT, ...overrides };
}

test('country comes from the edge and matches exactly', () => {
	const rule = condition({ when: { country: ['DE', 'AT'] }, value: 'eur' });
	assert.equal(matchesCondition(rule, context({ country: 'DE' })), true);
	assert.equal(matchesCondition(rule, context({ country: 'AT' })), true);
	assert.equal(matchesCondition(rule, context({ country: 'US' })), false);
	// Lowercase from a trace or a header variant still matches - the schema
	// pins the RULE to uppercase, so only the context needs normalising.
	assert.equal(matchesCondition(rule, context({ country: 'de' })), true);
	// Unresolved country must not match a country rule.
	assert.equal(matchesCondition(rule, context({ country: null })), false);
});

test('role and permission need a verified token, and absence never matches', () => {
	const staff = condition({ when: { role: ['admin', 'staff'] }, value: true });
	assert.equal(matchesCondition(staff, context({ role: 'admin' })), true);
	assert.equal(matchesCondition(staff, context({ role: 'user' })), false);
	// The case that would leak an internal flag to everyone signed out.
	assert.equal(matchesCondition(staff, context({ role: null })), false);

	const gated = condition({ when: { permission: 'beta:read' }, value: true });
	assert.equal(matchesCondition(gated, context({ permissions: ['beta:read'] })), true);
	// `*` passes anything, the same meaning the access gate gives the claim.
	assert.equal(matchesCondition(gated, context({ permissions: ['*'] })), true);
	assert.equal(matchesCondition(gated, context({ permissions: ['other:read'] })), false);
	assert.equal(matchesCondition(gated, context()), false);
});

test('appVersion ranges are half-open, and a missing version never matches', () => {
	const modern = condition({ when: { appVersion: { gte: '2.1.0' } }, value: 'new' });
	assert.equal(matchesCondition(modern, context({ appVersion: '2.1.0' })), true);
	assert.equal(matchesCondition(modern, context({ appVersion: '2.10.0' })), true);
	assert.equal(matchesCondition(modern, context({ appVersion: '2.0.9' })), false);
	assert.equal(matchesCondition(modern, context({ appVersion: null })), false);

	const legacy = condition({ when: { appVersion: { lt: '2.0' } }, value: 'old' });
	assert.equal(matchesCondition(legacy, context({ appVersion: '1.9.9' })), true);
	// `lt` is exclusive: the boundary belongs to the newer range, so the two
	// halves of a split cannot both claim it.
	assert.equal(matchesCondition(legacy, context({ appVersion: '2.0' })), false);
	assert.equal(matchesCondition(legacy, context({ appVersion: '2.0.0' })), false);

	const window = condition({ when: { appVersion: { gte: '3.0', lt: '4.0' } }, value: 'three' });
	assert.equal(matchesCondition(window, context({ appVersion: '3.5' })), true);
	assert.equal(matchesCondition(window, context({ appVersion: '4.0' })), false);
});

test('version comparison treats missing parts as zero', () => {
	assert.equal(compareVersions('2.1', '2.1.0'), 0);
	assert.equal(compareVersions('2.1.1', '2.1'), 1);
	assert.equal(compareVersions('2.9', '2.10'), -1, 'numeric, not lexicographic');
	assert.equal(compareVersions('10', '9'), 1);
});

test('rollout buckets are stable, salted, and roughly even', () => {
	assert.equal(rolloutBucket('checkout', 'user-1'), rolloutBucket('checkout', 'user-1'));
	// The reason salt exists: two 10% rollouts must not target the same tenth,
	// or the same unlucky users get every experiment.
	const sameSalt: boolean[] = [];
	const otherSalt: boolean[] = [];
	for (let index = 0; index < 400; index++) {
		sameSalt.push(rolloutBucket('a', `user-${index}`) < 10);
		otherSalt.push(rolloutBucket('b', `user-${index}`) < 10);
	}
	const overlap = sameSalt.filter((inA, index) => inA && otherSalt[index]).length;
	const inA = sameSalt.filter(Boolean).length;
	assert.ok(inA > 20 && inA < 60, `a 10% rollout of 400 should be near 40, got ${inA}`);
	assert.ok(overlap < inA, 'the two cohorts must not be identical');

	// Spread: no bucket should swallow the population.
	const counts = new Array(10).fill(0);
	for (let index = 0; index < 2000; index++) {
		counts[Math.floor(rolloutBucket('spread', `u${index}`) / 10)]++;
	}
	for (const count of counts) {
		assert.ok(count > 100 && count < 320, `uneven decile: ${counts.join(',')}`);
	}
});

test('a rollout with no uid does not match', () => {
	// Fail closed: without something to bucket on, "10% of callers" would
	// otherwise mean either everybody or nobody depending on the hash of ''.
	const rule = condition({ when: { rollout: { percent: 50, salt: 's' } }, value: true });
	assert.equal(matchesCondition(rule, context({ uid: null })), false);
});

test('predicates within one condition are AND', () => {
	const rule = condition({
		when: { country: ['DE'], role: ['admin'] },
		value: true,
	});
	assert.equal(matchesCondition(rule, context({ country: 'DE', role: 'admin' })), true);
	assert.equal(matchesCondition(rule, context({ country: 'DE', role: 'user' })), false);
	assert.equal(matchesCondition(rule, context({ country: 'US', role: 'admin' })), false);
});

test('first match wins, and no match yields the default', () => {
	const parameter: EvaluableParameter = {
		key: 'currency',
		valueType: 'string',
		value: 'usd',
		conditions: [
			condition({ when: { country: ['DE'] }, value: 'eur' }),
			// Also matches a German caller - and must never be reached.
			condition({ when: { country: ['DE', 'GB'] }, value: 'gbp' }),
		],
	};
	assert.equal(evaluateParameter(parameter, context({ country: 'DE' })), 'eur');
	assert.equal(evaluateParameter(parameter, context({ country: 'GB' })), 'gbp');
	assert.equal(evaluateParameter(parameter, context({ country: 'US' })), 'usd');
	assert.equal(evaluateParameter(parameter, context()), 'usd');
});

test('a parameter with no conditions is just its value', () => {
	const parameter: EvaluableParameter = {
		key: 'maxUploadMb',
		valueType: 'number',
		value: 25,
		conditions: null,
	};
	assert.equal(evaluateParameter(parameter, context({ country: 'DE' })), 25);
});

test('the payload is values only - never the rules that produced them', () => {
	const parameters: EvaluableParameter[] = [
		{
			key: 'checkoutV2',
			valueType: 'boolean',
			value: false,
			conditions: [
				condition({
					label: 'internal staff',
					when: { role: ['admin'], rollout: { percent: 5, salt: 'secret-experiment' } },
					value: true,
				}),
			],
		},
	];
	const payload = evaluateAll(parameters, context({ role: 'user' }));
	assert.deepEqual(payload, { checkoutV2: false });

	// The thing this asserts is a NEGATIVE: nothing about the cohort, the
	// percentage, the salt, or the label may appear in what ships to a caller.
	const serialized = JSON.stringify(payload);
	for (const secret of ['admin', 'rollout', 'percent', 'secret-experiment', 'internal staff']) {
		assert.equal(serialized.includes(secret), false, `payload leaked "${secret}"`);
	}
});

test('the etag follows the resolved values, not the stored ones', () => {
	const german = evaluateAll(
		[
			{
				key: 'currency',
				valueType: 'string',
				value: 'usd',
				conditions: [condition({ when: { country: ['DE'] }, value: 'eur' })],
			},
		],
		context({ country: 'DE' }),
	);
	const american = evaluateAll(
		[
			{
				key: 'currency',
				valueType: 'string',
				value: 'usd',
				conditions: [condition({ when: { country: ['DE'] }, value: 'eur' })],
			},
		],
		context({ country: 'US' }),
	);
	// Two cohorts sharing a validator is how a cache serves one of them the
	// other's config.
	assert.notEqual(payloadEtag(german), payloadEtag(american));
	// Same payload, same etag - key order must not change it.
	assert.equal(payloadEtag({ a: 1, b: 2 }), payloadEtag({ b: 2, a: 1 }));
	// And it is quoted, because an ETag header without quotes is not one.
	assert.match(payloadEtag({ a: 1 }), /^".+"$/);
});

test('a condition with no rules is refused by the schema, not matched by the evaluator', () => {
	// A rule matching everyone is indistinguishable from a changed default, and
	// far easier to create by accident - so the schema refuses it up front.
	assert.equal(remoteConfigConditionSchema.safeParse({ when: {}, value: true }).success, false);
	// Percent bounds: 0 and 100 are a rule that should be deleted or made the
	// default, and accepting them invites both.
	for (const percent of [0, 100, -1, 101]) {
		assert.equal(
			remoteConfigConditionSchema.safeParse({
				when: { rollout: { percent, salt: 's' } },
				value: true,
			}).success,
			false,
			`percent ${percent}`,
		);
	}
	// Lowercase country codes are refused so a rule cannot silently never match.
	assert.equal(
		remoteConfigConditionSchema.safeParse({ when: { country: ['de'] }, value: 1 }).success,
		false,
	);
	// An appVersion rule with neither bound is a no-op dressed as a rule.
	assert.equal(
		remoteConfigConditionSchema.safeParse({ when: { appVersion: {} }, value: 1 }).success,
		false,
	);
});
