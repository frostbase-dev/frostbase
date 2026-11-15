import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPermission, validateDocument } from './rules.js';
import { validatorSchema, type CollectionValidator } from './schemas.js';

/**
 * Rules-lite behavior: the validator DSL over top-level fields, and the
 * permission gate against JWT claims. Enforcement wiring (public path only,
 * operator bypass, PATCH-validates-merged) is pinned by the db e2e spec.
 */

function v(input: unknown): CollectionValidator {
	return validatorSchema.parse(input);
}

test('validator: type checks cover every JSON type, any accepts all', () => {
	const validator = v({
		fields: {
			title: { type: 'string' },
			votes: { type: 'number' },
			done: { type: 'boolean' },
			meta: { type: 'object' },
			tags: { type: 'array' },
			gone: { type: 'null' },
			free: { type: 'any' },
		},
	});
	assert.deepEqual(
		validateDocument(validator, {
			title: 'x',
			votes: 1,
			done: false,
			meta: {},
			tags: [],
			gone: null,
			free: ['anything', { at: 'all' }],
		}),
		[],
	);
	const issues = validateDocument(validator, { title: 1, votes: 'one', tags: 'not-an-array' });
	assert.deepEqual(issues, [
		'"title" must be a string, got number',
		'"votes" must be a number, got string',
		'"tags" must be an array, got string',
	]);
	// null is its own type, never a valid string/number/object.
	assert.deepEqual(validateDocument(validator, { title: null }), [
		'"title" must be a string, got null',
	]);
});

test('validator: required fields; null present, undefined and absent are not', () => {
	const validator = v({ fields: { title: { type: 'any', required: true } } });
	assert.deepEqual(validateDocument(validator, {}), ['"title" is required']);
	assert.deepEqual(validateDocument(validator, { title: undefined }), ['"title" is required']);
	assert.deepEqual(validateDocument(validator, { title: null }), []);
	assert.deepEqual(validateDocument(validator, { title: '' }), []);
});

test('validator: bounds - maxLength on strings and arrays, min/max on numbers', () => {
	const validator = v({
		fields: {
			title: { type: 'string', maxLength: 5 },
			tags: { type: 'array', maxLength: 2 },
			votes: { type: 'number', min: 0, max: 10 },
		},
	});
	assert.deepEqual(validateDocument(validator, { title: 'short', tags: [1, 2], votes: 10 }), []);
	assert.deepEqual(validateDocument(validator, { title: 'too long here' }), [
		'"title" is limited to 5 characters',
	]);
	assert.deepEqual(validateDocument(validator, { tags: [1, 2, 3] }), [
		'"tags" is limited to 2 items',
	]);
	assert.deepEqual(validateDocument(validator, { votes: -1 }), ['"votes" must be at least 0']);
	assert.deepEqual(validateDocument(validator, { votes: 11 }), ['"votes" must be at most 10']);
});

test('validator: enum membership over scalars', () => {
	const validator = v({ fields: { status: { enum: ['open', 'closed', null] } } });
	assert.deepEqual(validateDocument(validator, { status: 'open' }), []);
	assert.deepEqual(validateDocument(validator, { status: null }), []);
	assert.deepEqual(validateDocument(validator, { status: 'pending' }), [
		'"status" must be one of: "open", "closed", null',
	]);
});

test('validator: additionalFields reject refuses undeclared keys', () => {
	const validator = v({
		fields: { title: { type: 'string' } },
		additionalFields: 'reject',
	});
	assert.deepEqual(validateDocument(validator, { title: 'ok' }), []);
	assert.deepEqual(validateDocument(validator, { title: 'ok', sneaky: 1 }), [
		'"sneaky" is not a declared field',
	]);
	// Default is allow.
	assert.deepEqual(validateDocument(v({ fields: { title: {} } }), { extra: true }), []);
});

test('validator schema: field-count window and top-level-only names', () => {
	assert.equal(validatorSchema.safeParse({ fields: {} }).success, false);
	assert.equal(validatorSchema.safeParse({ fields: { 'a.b': {} } }).success, false);
	assert.equal(validatorSchema.safeParse({ fields: { 'bad-name': {} } }).success, false);
	const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`f${index}`, {}]));
	assert.equal(validatorSchema.safeParse({ fields: many }).success, false);
});

test('permission gate: exact match, wildcard, and the no-requirement pass', () => {
	assert.equal(hasPermission(null, undefined), true);
	assert.equal(hasPermission(null, []), true);
	assert.equal(hasPermission('posts:read', undefined), false);
	assert.equal(hasPermission('posts:read', []), false);
	assert.equal(hasPermission('posts:read', ['posts:read']), true);
	assert.equal(hasPermission('posts:read', ['posts:write']), false);
	assert.equal(hasPermission('posts:read', ['*']), true);
	assert.equal(hasPermission('*', ['posts:read']), false); // require * = admin only
	assert.equal(hasPermission('*', ['*']), true);
});
