import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { TableSqlResponse, TableSqlResult } from './schemas.js';

/**
 * The official drizzle driver for Frostbase SQL tables - a thin shim
 * over the D1-shaped `/tables/<name>/sql` endpoint, exactly as designed
 * (db-table-design.md §10): the physical storage already matches what
 * drizzle emits, so the driver only moves statements and rows.
 *
 * Isomorphic like `./client` (browsers and Node >= 22); no Workers imports.
 * The endpoint requires a project JWT (public access modes never open raw
 * SQL), so `getToken` is effectively mandatory outside operator tooling.
 *
 * ```ts
 * import { drizzleTable } from '@frostbase-dev/db/drizzle';
 * import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
 *
 * const todos = sqliteTable('todos', {
 *   id: text('id').primaryKey(),
 *   title: text('title').notNull(),
 *   votes: integer('votes')
 * });
 *
 * const db = drizzleTable({ baseUrl, table: 'todos', getToken });
 * await db.insert(todos).values({ id: '1', title: 'ship it' });
 * const top = await db.select().from(todos).orderBy(desc(todos.votes)).limit(10);
 * ```
 *
 * Single-table by construction: statements referencing anything else are
 * refused by the endpoint's gate. `db.batch(...)` maps to the atomic batch
 * endpoint (one transaction). DDL never runs here - the column DSL owns the
 * schema; point drizzle-kit at nothing.
 */

export interface DrizzleTableOptions {
	/** Agent base (`.../agents/db-agent/<projectId>`) or console proxy base
	 * (`.../api/projects/<projectId>/db`) - same contract as the client SDK. */
	baseUrl: string;
	/** The declared table this database handle is scoped to. */
	table: string;
	/** Project JWT supplier; called per request. */
	getToken?: () => Promise<string | null> | string | null;
}

export class DbSqlError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'DbSqlError';
	}
}

export function drizzleTable<TSchema extends Record<string, unknown> = Record<string, never>>(
	options: DrizzleTableOptions,
	config?: { schema?: TSchema; logger?: boolean },
): SqliteRemoteDatabase<TSchema> {
	const base = options.baseUrl.replace(/\/$/, '');
	const url = `${base}/tables/${options.table}/sql`;

	const post = async (body: unknown): Promise<TableSqlResponse> => {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		const token = await options.getToken?.();
		if (token) headers.authorization = `Bearer ${token}`;
		const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
		const payload = (await response.json().catch(() => null)) as TableSqlResponse | null;
		if (!response.ok || !payload || payload.success === false) {
			const message =
				payload && 'error' in payload ? payload.error : `sql request failed (${response.status})`;
			throw new DbSqlError(response.status, message);
		}
		return payload;
	};

	const rowsFor = (result: TableSqlResult, method: string): { rows: unknown[] } =>
		method === 'get' ? { rows: result.raw[0] ?? [] } : { rows: result.raw };

	return drizzle<TSchema>(
		async (sql, params, method) => {
			const payload = await post({ sql, params });
			const result = 'result' in payload ? payload.result : undefined;
			if (!result) throw new DbSqlError(500, 'malformed sql response');
			return rowsFor(result, method);
		},
		async (queries) => {
			const payload = await post({
				batch: queries.map((query) => ({ sql: query.sql, params: query.params })),
			});
			const batch = 'batch' in payload ? payload.batch : undefined;
			if (!batch) throw new DbSqlError(500, 'malformed sql batch response');
			return batch.map((result, index) => rowsFor(result, queries[index].method));
		},
		config,
	);
}
