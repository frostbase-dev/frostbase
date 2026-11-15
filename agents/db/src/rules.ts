import type { CollectionValidator, FieldRule } from './schemas.js';

/**
 * Rules-lite document validation: a declarative per-collection validator
 * (type / required / bounds / enum over top-level fields) enforced on the
 * PUBLIC write path only. Operator surfaces - the dashboard editor and admin
 * import - bypass it exactly like they bypass access modes, mirroring how
 * Firestore security rules never bind the Admin SDK.
 *
 * Pure module with no Workers imports so it runs under node:test; PATCH is
 * validated on the merged result, so a merge can never sneak an invalid
 * document past rules that the same body would fail on create.
 */

type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'other';

function jsonTypeOf(value: unknown): JsonType {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	switch (typeof value) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'object':
			return 'object';
		default:
			return 'other';
	}
}

/** Every rule violation in the document; an empty array means it passes. */
export function validateDocument(
	validator: CollectionValidator,
	data: Record<string, unknown>,
): string[] {
	const issues: string[] = [];

	for (const [field, rule] of Object.entries(validator.fields)) {
		// undefined is indistinguishable from absent after JSON serialization.
		const present = field in data && data[field] !== undefined;
		if (!present) {
			if (rule.required) issues.push(`"${field}" is required`);
			continue;
		}
		issues.push(...checkRule(field, rule, data[field]));
	}

	if (validator.additionalFields === 'reject') {
		for (const key of Object.keys(data)) {
			if (data[key] === undefined) continue;
			if (!(key in validator.fields)) issues.push(`"${key}" is not a declared field`);
		}
	}

	return issues;
}

function checkRule(field: string, rule: FieldRule, value: unknown): string[] {
	const actual = jsonTypeOf(value);
	if (rule.type !== 'any' && actual !== rule.type) {
		// A wrong-typed value fails once; bounds against it would only confuse.
		const wanted =
			rule.type === 'null'
				? 'null'
				: rule.type === 'array' || rule.type === 'object'
					? `an ${rule.type}`
					: `a ${rule.type}`;
		return [`"${field}" must be ${wanted}, got ${actual}`];
	}

	const issues: string[] = [];
	if (rule.maxLength !== undefined && (actual === 'string' || actual === 'array')) {
		const length = (value as string | unknown[]).length;
		if (length > rule.maxLength) {
			issues.push(
				`"${field}" is limited to ${rule.maxLength} ${actual === 'string' ? 'characters' : 'items'}`,
			);
		}
	}
	if (actual === 'number') {
		const numeric = value as number;
		if (rule.min !== undefined && numeric < rule.min) {
			issues.push(`"${field}" must be at least ${rule.min}`);
		}
		if (rule.max !== undefined && numeric > rule.max) {
			issues.push(`"${field}" must be at most ${rule.max}`);
		}
	}
	if (rule.enum !== undefined && !rule.enum.some((allowed) => allowed === value)) {
		issues.push(
			`"${field}" must be one of: ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
		);
	}
	return issues;
}

/**
 * Permission gate: a required key passes when the verified JWT's
 * `permissions` claim carries it exactly or carries the `*` wildcard (the
 * built-in admin role). No requirement always passes.
 */
export function hasPermission(required: string | null, claimed: string[] | undefined): boolean {
	if (!required) return true;
	if (!claimed?.length) return false;
	return claimed.includes('*') || claimed.includes(required);
}
