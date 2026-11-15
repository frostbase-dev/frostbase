import type { AggregateRequest, Query, WhereClause } from './schemas.js';

/**
 * Pure query module: one parsed Query drives BOTH evaluators - the SQL
 * compiler (snapshots and REST queries) and the JS matcher (live evaluation
 * on writes) - plus the order comparator the client SDK reuses. Their parity
 * is the invariant the unit tests pin; there are no Workers imports here so
 * the whole module runs under node:test.
 *
 * Semantics (documented in the package README):
 * - A missing field is indistinguishable from null (json_extract returns SQL
 *   NULL for both), so `== null` matches missing fields too.
 * - `!=` follows Firestore: documents missing the field are excluded.
 * - Comparisons are defined between same-typed values; booleans normalize to
 *   1/0 (matching SQLite's JSON representation). Cross-type comparisons and
 *   non-ASCII string ordering are unspecified in v1.
 * - Ordering ranks value types like SQLite: null < numbers < strings < rest.
 */

/** `a.b.c` -> nested lookup; missing anywhere yields null. */
export function getPath(data: Record<string, unknown>, path: string): unknown {
	let value: unknown = data;
	for (const segment of path.split('.')) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
		value = (value as Record<string, unknown>)[segment];
	}
	return value ?? null;
}

/** Field paths are regex-validated by the schema; segments never contain
 * quotes, so interpolating the JSON path literal is injection-free. */
function jsonPath(field: string): string {
	return `'$.${field}'`;
}

function extract(field: string): string {
	return `json_extract(data, ${jsonPath(field)})`;
}

/** SQLite stores JSON booleans as 1/0; bind and compare the same shape. */
function bind(value: unknown): unknown {
	return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

export interface CompiledQuery {
	/** WHERE clause body ('1=1' when unconstrained) with `?` placeholders. */
	whereSql: string;
	params: unknown[];
	/** Full ORDER BY body; id is always the final tiebreak. */
	orderSql: string;
	limit: number;
}

export const DEFAULT_QUERY_LIMIT = 100;

export interface CompileOptions {
	/** Owner-mode restriction: only documents whose owner column matches. */
	ownerSub?: string | null;
	/** Decoded continuation from a previous page. */
	cursor?: DecodedCursor | null;
}

export function compileQuery(query: Query, options: CompileOptions = {}): CompiledQuery {
	const conditions: string[] = [];
	const params: unknown[] = [];

	for (const clause of query.where ?? []) {
		compileClause(clause, conditions, params);
	}

	if (options.ownerSub) {
		conditions.push('owner = ?');
		params.push(options.ownerSub);
	}

	if (options.cursor) {
		compileCursor(query, options.cursor, conditions, params);
	}

	const orderParts = (query.orderBy ?? []).map(
		(order) => `${extract(order.field)} ${order.direction === 'desc' ? 'DESC' : 'ASC'}`,
	);
	orderParts.push('id ASC');

	return {
		whereSql: conditions.length ? conditions.join(' AND ') : '1=1',
		params,
		orderSql: orderParts.join(', '),
		limit: query.limit ?? DEFAULT_QUERY_LIMIT,
	};
}

function compileClause(clause: WhereClause, conditions: string[], params: unknown[]): void {
	const column = extract(clause.field);

	switch (clause.op) {
		case '==':
			if (clause.value === null) {
				conditions.push(`${column} IS NULL`);
			} else {
				conditions.push(`${column} = ?`);
				params.push(bind(clause.value));
			}
			return;
		case '!=':
			if (clause.value === null) {
				conditions.push(`${column} IS NOT NULL`);
			} else {
				// Firestore semantics: a document missing the field does not match.
				conditions.push(`${column} IS NOT NULL AND ${column} != ?`);
				params.push(bind(clause.value));
			}
			return;
		case '<':
		case '<=':
		case '>':
		case '>=':
			conditions.push(`${column} ${clause.op} ?`);
			params.push(bind(clause.value));
			return;
		case 'in': {
			const values = clause.value as unknown[];
			conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
			params.push(...values.map(bind));
			return;
		}
		case 'array-contains':
			// json_type guard: json_each over a scalar yields the scalar itself,
			// which would false-positive without it.
			conditions.push(
				`json_type(data, ${jsonPath(clause.field)}) = 'array' AND EXISTS ` +
					`(SELECT 1 FROM json_each(data, ${jsonPath(clause.field)}) WHERE json_each.value = ?)`,
			);
			params.push(bind(clause.value));
			return;
	}
}

// ---------------------------------------------------------------------------
// Aggregations: the SQL side and the JS side compute from ONE parsed request;
// their parity is pinned by the unit tests exactly like query/matcher parity.

export interface CompiledAggregate {
	/** Full SELECT; expressions are aliased agg_0.. in `aliases` order. */
	sql: string;
	params: unknown[];
	aliases: string[];
}

export function compileAggregate(
	request: AggregateRequest,
	options: { ownerSub?: string | null } = {},
): CompiledAggregate {
	const compiled = compileQuery({ where: request.where }, { ownerSub: options.ownerSub });
	const aliases = Object.keys(request.aggregates);

	const expressions = aliases.map((alias, index) => {
		const spec = request.aggregates[alias];
		if (spec.op === 'count') return `COUNT(*) AS agg_${index}`;
		// json_type gates to genuine JSON numbers: booleans are 'true'/'false'
		// and strings 'text', so sum/avg skip them - Firestore semantics.
		const numeric =
			`CASE WHEN json_type(data, ${jsonPath(spec.field ?? '')}) IN ('integer', 'real') ` +
			`THEN ${extract(spec.field ?? '')} END`;
		return spec.op === 'sum'
			? `COALESCE(SUM(${numeric}), 0) AS agg_${index}`
			: `AVG(${numeric}) AS agg_${index}`;
	});

	return {
		sql: `SELECT ${expressions.join(', ')} FROM documents WHERE ${compiled.whereSql}`,
		params: compiled.params,
		aliases,
	};
}

/** The JS evaluation of the same request, used by the parity tests. */
export function aggregateDocs(
	request: AggregateRequest,
	docs: { data: Record<string, unknown>; owner: string | null }[],
	ownerSub?: string | null,
): Record<string, number | null> {
	const matching = docs.filter((doc) => matchesQuery({ where: request.where }, doc, ownerSub));
	const results: Record<string, number | null> = {};

	for (const [alias, spec] of Object.entries(request.aggregates)) {
		if (spec.op === 'count') {
			results[alias] = matching.length;
			continue;
		}
		const values = matching
			.map((doc) => getPath(doc.data, spec.field ?? ''))
			.filter((value): value is number => typeof value === 'number');
		if (spec.op === 'sum') {
			results[alias] = values.reduce((sum, value) => sum + value, 0);
		} else {
			results[alias] = values.length
				? values.reduce((sum, value) => sum + value, 0) / values.length
				: null;
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Cursor pagination (REST only)

export interface DecodedCursor {
	/** Order-field values of the last row, in orderBy order. */
	values: unknown[];
	id: string;
}

export function encodeCursor(cursor: DecodedCursor): string {
	return btoa(JSON.stringify([cursor.values, cursor.id]));
}

export function decodeCursor(raw: string): DecodedCursor | null {
	try {
		const parsed: unknown = JSON.parse(atob(raw));
		if (!Array.isArray(parsed) || parsed.length !== 2) return null;
		const [values, id] = parsed as [unknown, unknown];
		if (!Array.isArray(values) || typeof id !== 'string') return null;
		return { values, id };
	} catch {
		return null;
	}
}

/**
 * Keyset continuation: strictly after the cursor row in query order.
 * (o1 gt v1) OR (o1 = v1 AND o2 gt v2) OR (o1 = v1 AND o2 = v2 AND id > ?),
 * with gt flipped to lt for descending fields.
 */
function compileCursor(
	query: Query,
	cursor: DecodedCursor,
	conditions: string[],
	params: unknown[],
): void {
	const orders = query.orderBy ?? [];
	if (cursor.values.length !== orders.length) {
		// A cursor from a different query shape; ignore rather than misapply.
		return;
	}

	const branches: string[] = [];
	const branchParams: unknown[] = [];

	for (let i = 0; i <= orders.length; i += 1) {
		const equalities: string[] = [];
		const equalityParams: unknown[] = [];
		for (let j = 0; j < i; j += 1) {
			equalities.push(`${extract(orders[j].field)} = ?`);
			equalityParams.push(bind(cursor.values[j]));
		}
		if (i < orders.length) {
			const op = orders[i].direction === 'desc' ? '<' : '>';
			branches.push([...equalities, `${extract(orders[i].field)} ${op} ?`].join(' AND '));
			branchParams.push(...equalityParams, bind(cursor.values[i]));
		} else {
			branches.push([...equalities, 'id > ?'].join(' AND '));
			branchParams.push(...equalityParams, cursor.id);
		}
	}

	conditions.push(`(${branches.map((branch) => `(${branch})`).join(' OR ')})`);
	params.push(...branchParams);
}

// ---------------------------------------------------------------------------
// JS matcher (live evaluation) and order comparator (shared with the SDK)

type Matchable = { data: Record<string, unknown>; owner: string | null };

function norm(value: unknown): unknown {
	return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function normEqual(a: unknown, b: unknown): boolean {
	return norm(a) === norm(b);
}

export function matchesQuery(query: Query, doc: Matchable, ownerSub?: string | null): boolean {
	if (ownerSub && doc.owner !== ownerSub) return false;

	for (const clause of query.where ?? []) {
		if (!matchesClause(clause, doc.data)) return false;
	}
	return true;
}

function matchesClause(clause: WhereClause, data: Record<string, unknown>): boolean {
	const docValue = getPath(data, clause.field);

	switch (clause.op) {
		case '==':
			return clause.value === null ? docValue === null : normEqual(docValue, clause.value);
		case '!=':
			if (clause.value === null) return docValue !== null;
			return docValue !== null && !normEqual(docValue, clause.value);
		case '<':
		case '<=':
		case '>':
		case '>=': {
			const left = norm(docValue);
			const right = norm(clause.value);
			if (typeof left !== typeof right) return false;
			if (typeof left === 'number' && typeof right === 'number') {
				return compareOp(clause.op, left, right);
			}
			if (typeof left === 'string' && typeof right === 'string') {
				return compareOp(clause.op, left, right);
			}
			return false;
		}
		case 'in':
			return (clause.value as unknown[]).some((value) => normEqual(docValue, value));
		case 'array-contains':
			return Array.isArray(docValue) && docValue.some((entry) => normEqual(entry, clause.value));
	}
}

function compareOp(op: '<' | '<=' | '>' | '>=', a: number | string, b: number | string): boolean {
	if (op === '<') return a < b;
	if (op === '<=') return a <= b;
	if (op === '>') return a > b;
	return a >= b;
}

/** SQLite type ranking: NULL < numbers < text < everything else. */
function typeRank(value: unknown): number {
	if (value === null) return 0;
	if (typeof value === 'number') return 1;
	if (typeof value === 'string') return 2;
	return 3;
}

function compareValues(a: unknown, b: unknown): number {
	const left = norm(a);
	const right = norm(b);
	const rankDiff = typeRank(left) - typeRank(right);
	if (rankDiff !== 0) return rankDiff;
	if (typeof left === 'number' && typeof right === 'number') {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof left === 'string' && typeof right === 'string') {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	return 0;
}

type Orderable = { id: string; data: Record<string, unknown> };

/** Comparator matching the compiled ORDER BY; id is the final tiebreak. */
export function orderComparator(query: Query): (a: Orderable, b: Orderable) => number {
	const orders = query.orderBy ?? [];
	return (a, b) => {
		for (const order of orders) {
			const diff = compareValues(getPath(a.data, order.field), getPath(b.data, order.field));
			if (diff !== 0) return order.direction === 'desc' ? -diff : diff;
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	};
}

/** True when the query has a bounded, ordered window (limit + orderBy). */
export function isWindowed(query: Query): boolean {
	return query.limit !== undefined && (query.orderBy?.length ?? 0) > 0;
}
