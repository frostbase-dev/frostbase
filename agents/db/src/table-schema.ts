import type { ColumnType, TableColumn } from './schemas.js';

/**
 * Pure table-schema module: row validation against declared columns, default
 * materialization, the additive DDL planner, and the row <-> SQL value
 * conversions. No Workers imports - the whole module runs under node:test.
 *
 * The physical SQLite table is named after the DECLARED table and the system
 * columns are plain `id` / `owner` / `created_at` / `updated_at` (reserved
 * from user columns) - deliberately, so ORM-generated SQL (drizzle, prisma)
 * reads and writes the real schema unmodified: `select "id", "title" from
 * "todos"` is exactly what is stored. The T2 SQL endpoint builds on this;
 * renaming later would be a data migration, so the naming lands in T1.
 *
 * Two platform facts shape the module:
 * - `pragma_table_info()` is blocked (SQLITE_AUTH), so the applied schema is
 *   OUR record (kept in the child's cached meta), never introspection. The
 *   planner diffs declared columns against that record.
 * - SQLite affinity is not a type system - it stores anything anywhere - so
 *   every write validates values against the declared type HERE, before
 *   binding. Any future write path (imports, the SQL endpoint, replication
 *   apply) must reuse this module rather than trusting the storage layer.
 */

export const SYSTEM_COLUMNS = ['id', 'owner', 'created_at', 'updated_at'] as const;

const SQL_TYPE: Record<ColumnType, string> = {
	text: 'TEXT',
	integer: 'INTEGER',
	real: 'REAL',
	boolean: 'INTEGER',
	json: 'TEXT',
};

/** `"name"` - identifiers are regex-validated, but quote them regardless. */
export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// Row validation and default materialization

/**
 * Validate a full row's data map against the declared columns. Unknown
 * columns are always rejected (tables are schema-first; there is no
 * `additionalFields: allow` for typed rows). Returns every issue; an empty
 * array means the row passes. Callers validate the MERGED result for PATCH,
 * exactly like document rules.
 *
 * `skipPolicy` is the operator-surface mode: bounds and enum (POLICY, the
 * rules-lite analog Firestore's Admin SDK bypasses) are skipped, but
 * STRUCTURE - unknown columns, types, NOT NULL - always holds, because the
 * schema is the storage, not a rule about it.
 */
export function validateRow(
	columns: TableColumn[],
	data: Record<string, unknown>,
	options: { skipPolicy?: boolean } = {},
): string[] {
	const issues: string[] = [];
	const byName = new Map(columns.map((column) => [column.name, column]));

	for (const key of Object.keys(data)) {
		if (data[key] === undefined) continue;
		if (!byName.has(key)) issues.push(`"${key}" is not a declared column`);
	}

	for (const column of columns) {
		const present = column.name in data && data[column.name] !== undefined;
		const value = present ? data[column.name] : undefined;

		if (!present || value === null) {
			// applyColumnDefaults runs first, so absence here means the column is
			// non-nullable with no default - i.e. genuinely required on write.
			if (!column.nullable && !present && column.default === undefined) {
				issues.push(`"${column.name}" is required`);
			} else if (!column.nullable && value === null) {
				issues.push(`"${column.name}" cannot be null`);
			}
			continue;
		}

		issues.push(...checkColumnValue(column, value, options.skipPolicy === true));
	}

	return issues;
}

function checkColumnValue(column: TableColumn, value: unknown, skipPolicy = false): string[] {
	switch (column.type) {
		case 'text':
			if (typeof value !== 'string') return [typeIssue(column, value)];
			if (!skipPolicy && column.maxLength !== undefined && value.length > column.maxLength) {
				return [`"${column.name}" is limited to ${column.maxLength} characters`];
			}
			break;
		case 'integer':
			if (typeof value !== 'number' || !Number.isInteger(value)) {
				return [typeIssue(column, value)];
			}
			break;
		case 'real':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return [typeIssue(column, value)];
			}
			break;
		case 'boolean':
			if (typeof value !== 'boolean') return [typeIssue(column, value)];
			break;
		case 'json':
			// Any JSON value; nesting depth/size is bounded by the row byte cap.
			break;
	}

	if (skipPolicy) return [];

	const issues: string[] = [];
	if (typeof value === 'number') {
		if (column.min !== undefined && value < column.min) {
			issues.push(`"${column.name}" must be at least ${column.min}`);
		}
		if (column.max !== undefined && value > column.max) {
			issues.push(`"${column.name}" must be at most ${column.max}`);
		}
	}
	if (column.enum !== undefined && !column.enum.some((allowed) => allowed === value)) {
		issues.push(
			`"${column.name}" must be one of: ${column.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
		);
	}
	return issues;
}

function typeIssue(column: TableColumn, value: unknown): string {
	const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	const wanted = column.type === 'integer' ? 'an integer' : `a ${column.type}`;
	return `"${column.name}" must be ${wanted}, got ${actual}`;
}

/**
 * Materialize a complete row: every declared column present, missing ones
 * filled with the declared default, else null. Defaults live HERE (the write
 * path), not in SQL - which is why changing a default later is metadata-only.
 * A missing non-nullable column WITHOUT a default is left absent so
 * validateRow reports it as required.
 */
export function applyColumnDefaults(
	columns: TableColumn[],
	data: Record<string, unknown>,
): Record<string, unknown> {
	const full: Record<string, unknown> = { ...data };
	for (const column of columns) {
		if (full[column.name] !== undefined) continue;
		if (column.default !== undefined) full[column.name] = column.default;
		else if (column.nullable) full[column.name] = null;
	}
	return full;
}

// ---------------------------------------------------------------------------
// DDL planning (applied record -> declared schema)

export type DdlPlan = { ok: true; statements: string[] } | { ok: false; reason: string };

/**
 * Plan the DDL taking `applied` (null = the table does not exist yet) to
 * `declared`. Additive only:
 *
 * - new column -> ADD COLUMN (refused for NOT NULL without default - SQLite
 *   must backfill existing rows)
 * - index/unique toggled on -> CREATE [UNIQUE] INDEX; toggled off -> DROP
 *   INDEX (dropping an index is always safe)
 * - default/bounds/enum changes -> metadata-only, no statements
 * - removed / retyped / nullability-changed columns -> refused (export ->
 *   recreate -> import territory)
 *
 * The child records the applied schema only after every statement succeeds;
 * on a retry after a partial failure the apply loop treats "duplicate column
 * name" as already-applied, which is what makes multi-statement DDL safe
 * without transactions (explicit BEGIN is SQLITE_AUTH).
 */
export function planDdl(
	table: string,
	applied: TableColumn[] | null,
	declared: TableColumn[],
): DdlPlan {
	if (!applied) {
		const defs = declared.map(columnDef);
		// The timestamp defaults are what let RAW SQL (ORMs) insert without
		// knowing about system columns - ms-epoch, computed by SQLite itself.
		// (Raw UPDATEs should set updated_at themselves; the typed API always
		// maintains it.)
		const nowMs = `(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;
		const statements = [
			`CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (` +
				`"id" TEXT PRIMARY KEY, "owner" TEXT, ` +
				`"created_at" INTEGER NOT NULL DEFAULT ${nowMs}, ` +
				`"updated_at" INTEGER NOT NULL DEFAULT ${nowMs}` +
				(defs.length ? `, ${defs.join(', ')}` : '') +
				`)`,
			...systemIndexStatements(table),
		];
		for (const column of declared) statements.push(...indexStatements(table, column));
		return { ok: true, statements };
	}

	const appliedByName = new Map(applied.map((column) => [column.name, column]));
	const declaredNames = new Set(declared.map((column) => column.name));

	for (const column of applied) {
		if (!declaredNames.has(column.name)) {
			return {
				ok: false,
				reason: `column "${column.name}" cannot be removed - export, recreate, and import instead`,
			};
		}
	}

	const statements: string[] = [];
	for (const column of declared) {
		const existing = appliedByName.get(column.name);
		if (!existing) {
			if (!column.nullable && column.default === undefined) {
				return {
					ok: false,
					reason:
						`column "${column.name}" cannot be added as NOT NULL without a default - ` +
						`SQLite must backfill existing rows`,
				};
			}
			statements.push(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnDef(column)}`);
			statements.push(...indexStatements(table, column));
			continue;
		}
		if (existing.type !== column.type) {
			return {
				ok: false,
				reason: `column "${column.name}" cannot change type (${existing.type} -> ${column.type})`,
			};
		}
		if (existing.nullable !== column.nullable) {
			return { ok: false, reason: `column "${column.name}" cannot change nullability` };
		}
		// default/maxLength/min/max/enum changes are metadata-only.
		const wasUnique = existing.unique;
		const wasIndexed = !existing.unique && existing.index;
		const isUnique = column.unique;
		const isIndexed = !column.unique && column.index;
		if (wasUnique !== isUnique) {
			statements.push(
				isUnique
					? `CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(table, column.name)} ` +
							`ON ${quoteIdent(table)} (${quoteIdent(column.name)})`
					: `DROP INDEX IF EXISTS ${uniqueIndexName(table, column.name)}`,
			);
		}
		if (wasIndexed !== isIndexed) {
			statements.push(
				isIndexed
					? `CREATE INDEX IF NOT EXISTS ${plainIndexName(table, column.name)} ` +
							`ON ${quoteIdent(table)} (${quoteIdent(column.name)})`
					: `DROP INDEX IF EXISTS ${plainIndexName(table, column.name)}`,
			);
		}
	}

	return { ok: true, statements };
}

function columnDef(column: TableColumn): string {
	let def = `${quoteIdent(column.name)} ${SQL_TYPE[column.type]}`;
	if (!column.nullable) {
		def += ' NOT NULL';
		// Only NOT NULL needs the SQL-level default (backfill); nullable
		// defaults are materialized by the write path instead.
		if (column.default !== undefined) def += ` DEFAULT ${defaultLiteral(column.default)}`;
	}
	return def;
}

function systemIndexStatements(table: string): string[] {
	return [
		`CREATE INDEX IF NOT EXISTS ${plainIndexName(table, 'owner')} ` +
			`ON ${quoteIdent(table)} ("owner")`,
		`CREATE INDEX IF NOT EXISTS ${plainIndexName(table, 'updated_at')} ` +
			`ON ${quoteIdent(table)} ("updated_at")`,
	];
}

function indexStatements(table: string, column: TableColumn): string[] {
	if (column.unique) {
		return [
			`CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(table, column.name)} ` +
				`ON ${quoteIdent(table)} (${quoteIdent(column.name)})`,
		];
	}
	if (column.index) {
		return [
			`CREATE INDEX IF NOT EXISTS ${plainIndexName(table, column.name)} ` +
				`ON ${quoteIdent(table)} (${quoteIdent(column.name)})`,
		];
	}
	return [];
}

function uniqueIndexName(table: string, column: string): string {
	return quoteIdent(`uniq_${table}_${column}`);
}

function plainIndexName(table: string, column: string): string {
	return quoteIdent(`idx_${table}_${column}`);
}

/** DDL cannot bind parameters; render the literal with SQL escaping. */
function defaultLiteral(value: string | number | boolean | null): string {
	if (value === null) return 'NULL';
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'number') return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}

/** The apply loop's "already there" detector for non-idempotent ADD COLUMN. */
export function isDuplicateColumnError(error: unknown): boolean {
	return /duplicate column name/i.test(error instanceof Error ? error.message : String(error));
}

/** SQLite phrases unique violations "UNIQUE constraint failed: <t>.<col>"
 * (workerd appends ": SQLITE_CONSTRAINT..."); the offending column, or null
 * when the error is something else. */
export function uniqueViolationColumn(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/UNIQUE constraint failed: [^.\s]+\.([A-Za-z0-9_]+)/i)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Row <-> SQL conversion

/** Ordered SELECT list: system columns first, then declared columns. */
export function selectList(columns: TableColumn[]): string {
	return [
		'"id"',
		'"owner"',
		'"created_at"',
		'"updated_at"',
		...columns.map((column) => quoteIdent(column.name)),
	].join(', ');
}

/** Bindable value for one column: booleans as 1/0, json as text. */
export function toSqlValue(column: TableColumn, value: unknown): string | number | null {
	if (value === null || value === undefined) return null;
	switch (column.type) {
		case 'boolean':
			return value ? 1 : 0;
		case 'json':
			return JSON.stringify(value);
		case 'text':
			return value as string;
		case 'integer':
		case 'real':
			return value as number;
	}
}

/** The data map from a raw SQL row: json parsed, booleans as true/false. */
export function rowDataFromSql(
	columns: TableColumn[],
	row: Record<string, unknown>,
): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const column of columns) {
		const raw = row[column.name];
		if (raw === null || raw === undefined) {
			data[column.name] = null;
			continue;
		}
		switch (column.type) {
			case 'boolean':
				data[column.name] = raw === 1;
				break;
			case 'json':
				try {
					data[column.name] = JSON.parse(raw as string);
				} catch {
					data[column.name] = null;
				}
				break;
			default:
				data[column.name] = raw;
		}
	}
	return data;
}
