import { selectList } from './table-schema.js';
import type { TableColumn } from './schemas.js';

/**
 * The raw-SQL gate for the D1-shaped table endpoint (T2). Pure module,
 * unit-tested against bypass attempts.
 *
 * The physical table is named after the declared table with plain system
 * columns, so ORM-generated SQL runs unmodified - the gate's job is not to
 * parse SQL, but to refuse what must never run:
 *
 * - anything but a single SELECT/INSERT/UPDATE/DELETE statement (DDL is the
 *   column DSL's monopoly; transactions are the batch endpoint's);
 * - any reference to the shard's INTERNAL tables (subscriptions carries
 *   token metadata, changelog carries every row image - a raw SELECT over
 *   either would bypass access modes entirely) or sqlite_* internals;
 * - user-supplied RETURNING (the endpoint appends its own, which is how DML
 *   feeds the change log and the live engine).
 *
 * The internal-name scan is deliberately dumb: a case-insensitive word match
 * over the WHOLE statement, string literals included. A literal containing
 * "changelog" is refused with a clear error - bind it as a parameter, which
 * is what an ORM does anyway. False positives are the cost of no parser;
 * false negatives are the thing this module exists to prevent.
 */

export type SqlKind = 'select' | 'insert' | 'update' | 'delete';

export type PreparedSql = { ok: true; kind: SqlKind; sql: string } | { ok: false; error: string };

/**
 * Internal storage no raw statement may name, whatever the casing. Every
 * table the shard's migrations create, plus drizzle's own - the shard applies
 * the whole schema even where it uses only part of it, so a name absent from
 * this list is a name raw SQL can read.
 */
const INTERNAL_NAMES = [
	'collections',
	'documents',
	'subscriptions',
	'restore_points',
	'collection_meta',
	'changelog',
	'replicas',
	'replica_meta',
	'gateways',
	'gateway_subs',
	'view_sources',
	'__drizzle_migrations',
];

const KIND_PATTERN = /^\s*(select|insert|update|delete|with)\b/i;

/**
 * The refusals both entry points share: one statement, a recognised leading
 * keyword, no internal storage, no sqlite internals, no DDL/PRAGMA/
 * transactions. Returns the trimmed statement and its kind.
 */
function gateStatement(rawSql: string, selectOnly: boolean): PreparedSql {
	let sql = rawSql.trim();
	// One trailing semicolon is tolerated (ORMs emit it); any other semicolon
	// means a second statement - refused, string literals included (bind
	// values as parameters instead).
	if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
	if (sql.includes(';')) {
		return { ok: false, error: 'one statement per call - batch for more' };
	}

	const kindMatch = KIND_PATTERN.exec(sql);
	if (!kindMatch) {
		return {
			ok: false,
			error: selectOnly
				? 'a view is read-only - only SELECT runs here'
				: 'only SELECT, INSERT, UPDATE, and DELETE run here - schema changes go through the column DSL',
		};
	}
	let kind: SqlKind;
	if (kindMatch[1].toLowerCase() === 'with') {
		// A CTE may only front a SELECT: DML behind WITH would dodge the
		// target-table shape checks below.
		if (/\b(insert|update|delete)\b/i.test(sql)) {
			return { ok: false, error: 'CTEs are supported for SELECT only' };
		}
		kind = 'select';
	} else {
		kind = kindMatch[1].toLowerCase() as SqlKind;
	}
	if (selectOnly && kind !== 'select') {
		return {
			ok: false,
			error: 'a view is read-only - write to the member table instead',
		};
	}

	const lowered = sql.toLowerCase();
	for (const name of INTERNAL_NAMES) {
		// No `name === table` escape. A table CANNOT be declared with one of
		// these names any more (RESERVED_SHARD_TABLES), and for a row
		// grandfathered in before that rule, "the user's table shadows internal
		// storage" is precisely the case where raw SQL must stay refused - the
		// physical table it would reach IS the internal one.
		if (new RegExp(`\\b${name}\\b`).test(lowered)) {
			return {
				ok: false,
				error: `"${name}" is internal storage - if you meant the literal string, bind it as a parameter`,
			};
		}
	}
	if (/\bsqlite_\w+/.test(lowered)) {
		return { ok: false, error: 'sqlite internals are not queryable here' };
	}
	// `pragma\w*` also catches the function forms (pragma_table_info & co).
	if (
		/\b(pragma\w*|attach|detach|vacuum|reindex|alter|create|drop|begin|commit|rollback|savepoint)\b/.test(
			lowered,
		)
	) {
		return {
			ok: false,
			error: selectOnly
				? 'only plain SELECT statements run here'
				: 'only plain SELECT/INSERT/UPDATE/DELETE statements run here',
		};
	}
	return { ok: true, kind, sql };
}

/**
 * The join-view gate (JOIN1): SELECT only, over the view's own SQLite.
 *
 * Joins need no allowlist of member names. The only user tables that exist in
 * a view's storage ARE its members, so a reference to anything else fails at
 * SQLite with `no such table` - the same property that makes the single-table
 * gate safe, applied to a set instead of one name. And with no DML to police,
 * the target-table checks and the automatic RETURNING simply do not exist
 * here: what survives is the part that earns its keep.
 */
export function prepareViewSql(rawSql: string): PreparedSql {
	return gateStatement(rawSql, true);
}

export function prepareTableSql(
	rawSql: string,
	table: string,
	columns: TableColumn[],
): PreparedSql {
	const gated = gateStatement(rawSql, false);
	if (!gated.ok) return gated;
	const { kind } = gated;
	let sql = gated.sql;

	const lowered = sql.toLowerCase();
	if (kind !== 'select' && /\breturning\b/.test(lowered)) {
		return {
			ok: false,
			error: 'RETURNING is added automatically - the full row always comes back',
		};
	}

	// DML must target THIS table by its unquoted or quoted name.
	//
	// The quote group is NAMED, and the trailing guard is a lookahead rather
	// than `\b`. Both spellings were wrong, in opposite directions:
	//
	// - `("?)…\1` numbered the group, but the insert and update patterns carry
	//   an earlier `(or\s+\w+\s+)?` group - so `\1` referenced THAT one, and an
	//   unmatched group backreferences the empty string in JS. Quotes went
	//   unbalanced: `INSERT INTO "todos` passed. Delete has no earlier group,
	//   so there `\1` really was the quote, and then...
	// - `\b` after a closing `"` can never match (a quote is not a word
	//   character and neither is the space or end-of-input that follows it), so
	//   `DELETE FROM "todos"` - what every ORM emits, drizzle included - was
	//   refused with "deletes must target". Every existing test wrote the name
	//   unquoted, which is why nothing caught it.
	//
	// The lookahead also refuses `todos-archive` for table `todos`: a hyphen IS
	// a word boundary, and hyphens are legal in table names.
	const t = `(?<q>"?)${escapeRegExp(table)}\\k<q>(?![\\w"-])`;
	if (kind === 'insert' && !new RegExp(`^insert\\s+(or\\s+\\w+\\s+)?into\\s+${t}`, 'i').test(sql)) {
		return { ok: false, error: `inserts must target "${table}"` };
	}
	if (kind === 'update' && !new RegExp(`^update\\s+(or\\s+\\w+\\s+)?${t}`, 'i').test(sql)) {
		return { ok: false, error: `updates must target "${table}"` };
	}
	if (kind === 'delete' && !new RegExp(`^delete\\s+from\\s+${t}`, 'i').test(sql)) {
		return { ok: false, error: `deletes must target "${table}"` };
	}

	// DML answers with the full row: the change log and the live engine are
	// fed from exactly what the statement touched.
	//
	// The appended clause has to survive comments, or a statement ending in
	// one swallows it - and a DML write with no RETURNING notifies nobody:
	// no live-query delta, and no changelog entry, which is the replication
	// feed. Replicas would then diverge from the primary permanently, silently.
	// `--` runs to end of line, so RETURNING goes on its own line; `/*` with no
	// `*/` runs to end of INPUT, which nothing can outrun, so it is refused.
	if (kind !== 'select') {
		if (unterminatedBlockComment(sql)) {
			return { ok: false, error: 'unterminated block comment' };
		}
		sql = `${sql}\nRETURNING ${selectList(columns)}`;
	}

	return { ok: true, kind, sql };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a `/*` is left open at the end of the statement. SQLite accepts an
 * unterminated block comment and runs it to the end of the input, so anything
 * appended after one is silently discarded. Scanned outside string literals,
 * where `/*` is just two characters.
 */
function unterminatedBlockComment(sql: string): boolean {
	let quote: string | null = null;
	for (let index = 0; index < sql.length; index += 1) {
		const char = sql[index];
		if (quote) {
			// Doubled quotes are SQL's escape; closing and reopening here has
			// the same effect, so they need no special case.
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			quote = char;
			continue;
		}
		// A line comment hides everything to the newline - `/*` included, so it
		// must be skipped rather than scanned.
		if (char === '-' && sql[index + 1] === '-') {
			const newline = sql.indexOf('\n', index + 2);
			if (newline === -1) return false;
			index = newline;
			continue;
		}
		if (char === '/' && sql[index + 1] === '*') {
			const close = sql.indexOf('*/', index + 2);
			// Keep scanning PAST a closed comment: the open one may be the
			// second, and a quote inside a comment is not a string.
			if (close === -1) return true;
			index = close + 1;
		}
	}
	return false;
}
