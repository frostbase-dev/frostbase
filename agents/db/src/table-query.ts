import type { CompiledQuery, DecodedCursor } from './query.js';
import { quoteIdent } from './table-schema.js';
import type { AggregateRequest, Query, TableColumn, WhereClause } from './schemas.js';

/**
 * Pure table-query compiler: the SAME parsed Query the document engine uses,
 * compiled against declared typed columns instead of json_extract over a
 * blob. The JS matcher and order comparator are NOT duplicated -
 * `matchesQuery`/`orderComparator` from query.ts operate on the DTO's data
 * map, which for rows carries json columns parsed and booleans as
 * true/false, so live evaluation is shared by construction. This module's
 * parity with that matcher is pinned by table-query.unit.test.ts exactly
 * like query.ts pins the document pair.
 *
 * Field resolution is where tables differ:
 * - a single-segment field must be a DECLARED column -> `"col"`
 * - a dotted path is legal only when its first segment is a `json` column ->
 *   `json_extract("col", '$.rest')` (the schema's regex already guarantees
 *   quote-free segments, so interpolating the path literal stays
 *   injection-free)
 * - anything else is a compile-time refusal the caller answers 400 with
 *   (the socket's `invalid-query`), never silent mis-evaluation
 */

export type TableCompileResult =
	{ ok: true; compiled: CompiledQuery } | { ok: false; error: string };

interface ResolvedField {
	/** SQL expression for the field. */
	sql: string;
	column: TableColumn;
	/** Present when the field digs into a json column. */
	jsonPath: string | null;
}

function resolveField(field: string, byName: Map<string, TableColumn>): ResolvedField | string {
	const [head, ...rest] = field.split('.');
	const column = byName.get(head);
	if (!column) return `"${head}" is not a declared column`;
	if (rest.length === 0) return { sql: quoteIdent(column.name), column, jsonPath: null };
	if (column.type !== 'json') {
		return `"${head}" is a ${column.type} column - dotted paths only reach into json columns`;
	}
	const jsonPath = `'$.${rest.join('.')}'`;
	return { sql: `json_extract(${quoteIdent(column.name)}, ${jsonPath})`, column, jsonPath };
}

/** Booleans bind as 1/0 (their storage shape), like the document compiler. */
function bind(value: unknown): unknown {
	return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

export interface TableCompileOptions {
	/** Owner-mode restriction over the real owner column. */
	ownerSub?: string | null;
	/** Decoded continuation from a previous page. */
	cursor?: DecodedCursor | null;
}

export const DEFAULT_QUERY_LIMIT = 100;

export function compileTableQuery(
	query: Query,
	columns: TableColumn[],
	options: TableCompileOptions = {},
): TableCompileResult {
	const byName = new Map(columns.map((column) => [column.name, column]));
	const conditions: string[] = [];
	const params: unknown[] = [];

	for (const clause of query.where ?? []) {
		const resolved = resolveField(clause.field, byName);
		if (typeof resolved === 'string') return { ok: false, error: resolved };
		const issue = compileClause(clause, resolved, conditions, params);
		if (issue) return { ok: false, error: issue };
	}

	if (options.ownerSub) {
		conditions.push('"owner" = ?');
		params.push(options.ownerSub);
	}

	const orderParts: string[] = [];
	const orderExprs: string[] = [];
	for (const order of query.orderBy ?? []) {
		const resolved = resolveField(order.field, byName);
		if (typeof resolved === 'string') return { ok: false, error: resolved };
		orderExprs.push(resolved.sql);
		orderParts.push(`${resolved.sql} ${order.direction === 'desc' ? 'DESC' : 'ASC'}`);
	}
	orderParts.push('"id" ASC');

	if (options.cursor) {
		compileCursor(query, options.cursor, orderExprs, conditions, params);
	}

	return {
		ok: true,
		compiled: {
			whereSql: conditions.length ? conditions.join(' AND ') : '1=1',
			params,
			orderSql: orderParts.join(', '),
			limit: query.limit ?? DEFAULT_QUERY_LIMIT,
		},
	};
}

function compileClause(
	clause: WhereClause,
	resolved: ResolvedField,
	conditions: string[],
	params: unknown[],
): string | null {
	const expr = resolved.sql;

	switch (clause.op) {
		case '==':
			if (clause.value === null) {
				conditions.push(`${expr} IS NULL`);
			} else {
				conditions.push(`${expr} = ?`);
				params.push(bind(clause.value));
			}
			return null;
		case '!=':
			if (clause.value === null) {
				conditions.push(`${expr} IS NOT NULL`);
			} else {
				// Firestore semantics: a row with the field null does not match.
				conditions.push(`${expr} IS NOT NULL AND ${expr} != ?`);
				params.push(bind(clause.value));
			}
			return null;
		case '<':
		case '<=':
		case '>':
		case '>=':
			conditions.push(`${expr} ${clause.op} ?`);
			params.push(bind(clause.value));
			return null;
		case 'in': {
			const values = clause.value as unknown[];
			conditions.push(`${expr} IN (${values.map(() => '?').join(', ')})`);
			params.push(...values.map(bind));
			return null;
		}
		case 'array-contains': {
			// Only a json column (or a path into one) can hold an array; on any
			// other type the clause is a schema error, not a no-match.
			if (resolved.column.type !== 'json') {
				return `"${clause.field}": array-contains needs a json column`;
			}
			const target = quoteIdent(resolved.column.name);
			const typeExpr = resolved.jsonPath
				? `json_type(${target}, ${resolved.jsonPath})`
				: `json_type(${target})`;
			const eachArgs = resolved.jsonPath ? `${target}, ${resolved.jsonPath}` : target;
			conditions.push(
				`${typeExpr} = 'array' AND EXISTS ` +
					`(SELECT 1 FROM json_each(${eachArgs}) WHERE json_each.value = ?)`,
			);
			params.push(bind(clause.value));
			return null;
		}
	}
}

export interface CompiledTableAggregate {
	/** Full SELECT over the physical table; aliases agg_0.. in order. */
	sql: string;
	params: unknown[];
	aliases: string[];
}

export type TableAggregateResult =
	{ ok: true; compiled: CompiledTableAggregate } | { ok: false; error: string };

/**
 * count/sum/avg over typed columns - the document aggregate's twin. Typed
 * numeric columns sum directly; json paths keep the json_type gate (only
 * genuine JSON numbers count, Firestore-style); sum/avg over non-numeric
 * typed columns are compile-time refusals rather than silent zeros.
 */
export function compileTableAggregate(
	table: string,
	request: AggregateRequest,
	columns: TableColumn[],
	options: { ownerSub?: string | null } = {},
): TableAggregateResult {
	const base = compileTableQuery({ where: request.where }, columns, {
		ownerSub: options.ownerSub,
	});
	if (!base.ok) return base;

	const byName = new Map(columns.map((column) => [column.name, column]));
	const aliases = Object.keys(request.aggregates);
	const expressions: string[] = [];

	for (const [index, alias] of aliases.entries()) {
		const spec = request.aggregates[alias];
		if (spec.op === 'count') {
			expressions.push(`COUNT(*) AS agg_${index}`);
			continue;
		}
		const resolved = resolveField(spec.field ?? '', byName);
		if (typeof resolved === 'string') return { ok: false, error: resolved };
		let numeric: string;
		if (resolved.column.type === 'integer' || resolved.column.type === 'real') {
			numeric = resolved.sql;
		} else if (resolved.column.type === 'json') {
			const target = quoteIdent(resolved.column.name);
			const typeExpr = resolved.jsonPath
				? `json_type(${target}, ${resolved.jsonPath})`
				: `json_type(${target})`;
			numeric = `CASE WHEN ${typeExpr} IN ('integer', 'real') THEN ${resolved.sql} END`;
		} else {
			return {
				ok: false,
				error: `"${spec.field}" is a ${resolved.column.type} column - sum/avg need integer, real, or json`,
			};
		}
		expressions.push(
			spec.op === 'sum'
				? `COALESCE(SUM(${numeric}), 0) AS agg_${index}`
				: `AVG(${numeric}) AS agg_${index}`,
		);
	}

	return {
		ok: true,
		compiled: {
			sql: `SELECT ${expressions.join(', ')} FROM ${quoteIdent(table)} WHERE ${base.compiled.whereSql}`,
			params: base.compiled.params,
			aliases,
		},
	};
}

/**
 * Keyset continuation, structurally identical to the document compiler's:
 * strictly after the cursor row in query order, with the id tiebreak on the
 * real primary key. `orderExprs` are the already-resolved order expressions,
 * index-aligned with query.orderBy.
 */
function compileCursor(
	query: Query,
	cursor: DecodedCursor,
	orderExprs: string[],
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
			equalities.push(`${orderExprs[j]} = ?`);
			equalityParams.push(bind(cursor.values[j]));
		}
		if (i < orders.length) {
			const op = orders[i].direction === 'desc' ? '<' : '>';
			branches.push([...equalities, `${orderExprs[i]} ${op} ?`].join(' AND '));
			branchParams.push(...equalityParams, bind(cursor.values[i]));
		} else {
			branches.push([...equalities, '"id" > ?'].join(' AND '));
			branchParams.push(...equalityParams, cursor.id);
		}
	}

	conditions.push(`(${branches.map((branch) => `(${branch})`).join(' OR ')})`);
	params.push(...branchParams);
}
