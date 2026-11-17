import {
	dbAggregateRequestSchema,
	dbAggregateResultSchema,
	dbBookmarkResolutionSchema,
	dbCollectionConfigSchema,
	dbCreateRequestSchema,
	dbDocumentSchema,
	dbWriteAckSchema,
	dbWriteResultSchema,
	dbFieldRuleSchema,
	dbImportReportSchema,
	dbOverviewSchema,
	dbQueryResultSchema,
	dbQuerySchema,
	dbReplicaSchema,
	dbReplicationStatusSchema,
	dbRemoteConfigConditionSchema,
	dbRemoteConfigParameterInputSchema,
	dbRemoteConfigParameterSchema,
	dbRemoteConfigResolvedSchema,
	dbRemoteConfigSchema,
	dbRestorePointSchema,
	dbRestorePointsSchema,
	dbRestoreRequestSchema,
	dbRestoreResultSchema,
	dbServerFrameSchema,
	dbSubscribeFrameSchema,
	dbTableColumnSchema,
	dbTableConfigSchema,
	dbValidatorSchema,
	dbWriteRequestSchema
} from '$lib/agents';
import {
	jsonBody,
	jsonResponse,
	OPERATOR_SECURITY,
	UNAUTHORIZED,
	type AgentOpenApiModule
} from './shared';

/** The db agent's contribution to the per-project OpenAPI document. */

const DB_TAG = 'Database';

const collectionParam = {
	name: 'collection',
	in: 'path',
	required: true,
	schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
	description:
		'Collection name. Unknown collections auto-create with `auth`/`auth` modes on first use.'
};
const tableParam = {
	name: 'table',
	in: 'path',
	required: true,
	schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
	description:
		'Table name. Tables are schema-first: declare columns via the admin surface before writing.'
};
const viewParam = {
	name: 'view',
	in: 'path',
	required: true,
	schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
	description:
		'View name. Views are declared through the admin surface over 2-5 member tables; none of them may be owner-scoped.'
};
const docIdParam = { name: 'docId', in: 'path', required: true, schema: { type: 'string' } };
const rowIdParam = { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } };
const PUBLIC_SECURITY = [{ bearerAuth: [] }];

export const dbOpenApi: AgentOpenApiModule = {
	tags: [
		{
			name: DB_TAG,
			description: [
				'Two data models, one database: Firestore-style JSON documents AND SQL tables with typed',
				'columns - each collection or table its own isolated Durable Object, both with live queries.',
				'',
				'Access is per collection/table: `public` needs nothing, `auth` needs a project JWT from',
				'`/auth/token`, `owner` additionally scopes every read and write to the token subject. Both can',
				'also require a permission key on the JWT (granted via auth roles); collections can enforce',
				'document rules (`DbValidator`) on public writes, tables enforce their declared column schema.',
				'',
				'**Live queries**: open a WebSocket to `/agents/db-agent/{projectId}/collections/{collection}/subscribe`',
				'(or `/tables/{table}/subscribe`) and send a `DbSubscribeFrame`; the server answers with a',
				'`DbServerFrame` snapshot in query order, then pushes added/modified/removed deltas as writes happen.',
				'',
				'**Tables are schema-first**: declare typed columns (`DbTableConfig`) before writing; rows share',
				'the document envelope with `data` as the column map. The physical storage uses real columns',
				'(`id`, `owner`, `created_at`, `updated_at` + yours), so ORM-generated SQL matches it.',
				'',
				'**Aggregations**: `POST /collections/{collection}/aggregate` computes count/sum/avg server-side.',
				'',
				'**Backup**: `GET /collections/{collection}/export` and `GET /tables/{table}/export` stream',
				'NDJSON; operators can also export, import, and roll either kind back to any point in the past',
				'30 days from the admin surface.'
			].join('\n')
		}
	],
	schemas: [
		dbQuerySchema,
		dbDocumentSchema,
		dbWriteAckSchema,
		dbWriteResultSchema,
		dbQueryResultSchema,
		dbCreateRequestSchema,
		dbWriteRequestSchema,
		dbFieldRuleSchema,
		dbValidatorSchema,
		dbCollectionConfigSchema,
		dbTableColumnSchema,
		dbTableConfigSchema,
		dbAggregateRequestSchema,
		dbAggregateResultSchema,
		dbImportReportSchema,
		dbRestoreRequestSchema,
		dbRestoreResultSchema,
		dbRestorePointSchema,
		dbRestorePointsSchema,
		dbRemoteConfigConditionSchema,
		dbRemoteConfigParameterInputSchema,
		dbRemoteConfigParameterSchema,
		dbRemoteConfigResolvedSchema,
		dbRemoteConfigSchema,
		dbReplicaSchema,
		dbReplicationStatusSchema,
		dbBookmarkResolutionSchema,
		dbOverviewSchema,
		dbSubscribeFrameSchema,
		dbServerFrameSchema
	],
	paths: {
		'/db/collections/{collection}/documents': {
			post: {
				tags: [DB_TAG],
				summary: 'Create a document',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbCreateRequestSchema, 'Document data with an optional id.'),
				responses: {
					'201': jsonResponse(dbDocumentSchema, 'The created document.'),
					'401': { description: 'The collection requires a project token.' },
					'409': { description: 'A document with that id already exists.' },
					'413': { description: 'Document data over the size cap.' },
					'429': { description: 'A demo collection reached its document ceiling.' }
				}
			}
		},
		'/db/collections/{collection}/documents/{docId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Read a document',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The document.'),
					'404': { description: 'No such document (or not yours, in owner mode).' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Replace document data',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'The full replacement data.'),
				responses: {
					'200': jsonResponse(
						dbWriteResultSchema,
						'The updated document, or only its id when the caller may not read it back.'
					),
					'404': { description: 'No such document.' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Merge into document data',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'Fields to shallow-merge.'),
				responses: {
					'200': jsonResponse(
						dbWriteResultSchema,
						'The updated document, or only its id when the caller may not read it back.'
					),
					'404': { description: 'No such document.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a document',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'Deleted.' },
					'404': { description: 'No such document.' }
				}
			}
		},
		'/db/collections/{collection}/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Run a filtered query',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbQuerySchema, 'The query.'),
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching documents in query order.'),
					'400': { description: 'Invalid query.' }
				}
			}
		},
		'/db/collections/{collection}/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'Compute count/sum/avg server-side',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbAggregateRequestSchema, 'Aggregates keyed by result alias.'),
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
					'400': { description: 'Invalid aggregate request.' },
					'401': { description: 'The collection requires a project token.' }
				}
			}
		},
		'/db/collections/{collection}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Export documents as NDJSON',
				description:
					'Streams every readable document (owner mode: only yours) in id order, one JSON document per line.',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'An application/x-ndjson stream of DbDocument lines.' },
					'401': { description: 'The collection requires a project token.' }
				}
			}
		},
		'/db/tables/{table}/rows': {
			post: {
				tags: [DB_TAG],
				summary: 'Insert a row',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(
					dbCreateRequestSchema,
					'Row data (the column map) with an optional id. Missing columns take their defaults.'
				),
				responses: {
					'201': jsonResponse(dbDocumentSchema, 'The inserted row (data = column map).'),
					'400': { description: 'The row failed the declared schema (issues array).' },
					'401': { description: 'The table requires a project token.' },
					'404': { description: 'No such table - tables are schema-first.' },
					'409': { description: 'Duplicate id or unique-column value.' },
					'429': { description: 'A demo table reached its row ceiling.' }
				}
			}
		},
		'/db/tables/{table}/rows/{rowId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Read a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The row.'),
					'404': { description: 'No such row (or not yours, in owner mode).' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Replace a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'The full replacement column map.'),
				responses: {
					'200': jsonResponse(
						dbWriteResultSchema,
						'The updated row, or only its id when the caller may not read it back.'
					),
					'400': { description: 'The row failed the declared schema.' },
					'404': { description: 'No such row.' },
					'409': { description: 'Unique-column conflict.' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Update columns of a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'Columns to set; the rest keep their values.'),
				responses: {
					'200': jsonResponse(
						dbWriteResultSchema,
						'The updated row, or only its id when the caller may not read it back.'
					),
					'400': { description: 'The merged row failed the declared schema.' },
					'404': { description: 'No such row.' },
					'409': { description: 'Unique-column conflict.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'Deleted.' },
					'404': { description: 'No such row.' }
				}
			}
		},
		'/db/tables/{table}/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Run a filtered query over typed columns',
				description:
					'The same query DSL as collections, compiled against declared columns. Dotted field paths reach into `json` columns.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbQuerySchema, 'The query.'),
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching rows in query order.'),
					'400': { description: 'Invalid query, unknown column, or illegal dotted path.' }
				}
			}
		},
		'/db/tables/{table}/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'count/sum/avg over typed columns',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbAggregateRequestSchema, 'Aggregates keyed by result alias.'),
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
					'400': { description: 'Unknown column or non-numeric sum/avg target.' },
					'401': { description: 'The table requires a project token.' }
				}
			}
		},
		'/db/tables/{table}/sql': {
			post: {
				tags: [DB_TAG],
				summary: 'Run single-table SQL (ORM-grade, D1-shaped)',
				description:
					'One SELECT/INSERT/UPDATE/DELETE (or an atomic `batch`) over this table alone - what `@frostbase-dev/db/drizzle` drives. DML gains automatic RETURNING and feeds the change log and live queries; on a table whose read mode the caller does not pass (`none`, `owner`, or a missing read permission) writes still land but return no rows. ALWAYS requires a project JWT (public modes never open raw SQL); owner-scoped tables refuse it. Results carry objects plus `raw` value arrays with `columns` order for drivers. SELECTs serve from region replicas when replication is on.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: {
					description: '`{ sql, params? }` or `{ batch: [{ sql, params? }, ...] }`.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									sql: { type: 'string' },
									params: { type: 'array', items: {} },
									batch: {
										type: 'array',
										items: {
											type: 'object',
											required: ['sql'],
											properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }
										}
									}
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description:
							'`{ success, result }` (or `batch: [...]`), each with `results`, `columns`, `raw`, and D1-style `meta`.'
					},
					'400': {
						description: 'Statement refused by the gate, or a SQL error (batches roll back whole).'
					},
					'401': { description: 'Raw SQL requires a project token.' },
					'403': { description: 'Owner-scoped table, or missing permission key.' }
				}
			}
		},
		'/db/tables/{table}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Export rows as NDJSON',
				description:
					'Streams every readable row (owner mode: only yours) in id order, one JSON row per line.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'An application/x-ndjson stream of row lines.' },
					'401': { description: 'The table requires a project token.' }
				}
			}
		},
		'/db/views/{view}/sql': {
			post: {
				tags: [DB_TAG],
				summary: 'Query a join view (SELECT across tables)',
				description:
					'A view is a read-only Durable Object that follows several tables’ change logs into one SQLite, so a plain SELECT can JOIN them - what single-table SQL cannot express. SELECT only (or a `batch` of them): there is no write surface, and writes go to the member table. ALWAYS requires a project JWT, and the token must additionally carry every member table’s read permission - a view can never launder access to a table you could not read directly. Reads are eventually consistent: a view may be up to ~3s behind its members, so two members read at different instants can show a join that was never a committed state. Use views for reporting reads, not for invariants.',
				parameters: [viewParam],
				security: PUBLIC_SECURITY,
				requestBody: {
					description: '`{ sql, params? }` or `{ batch: [{ sql, params? }, ...] }`.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									sql: { type: 'string' },
									params: { type: 'array', items: {} },
									batch: {
										type: 'array',
										items: {
											type: 'object',
											required: ['sql'],
											properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }
										}
									}
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description:
							'`{ success, result }` (or `batch: [...]`), each with `results`, `columns`, `raw`, and D1-style `meta`.'
					},
					'400': {
						description: 'Statement refused by the gate (anything that writes), or a SQL error.'
					},
					'401': { description: 'A view requires a project token.' },
					'403': {
						description:
							'Missing the view’s permission key, or a member table’s - including a member that has become owner-scoped.'
					},
					'404': { description: 'No such view - views are declared, never auto-created.' },
					'503': {
						description: 'A member has not finished replicating into the view yet; retry shortly.'
					}
				}
			}
		},
		'/db/overview': {
			get: {
				tags: [DB_TAG],
				summary: 'Collections, counts, and live state',
				security: OPERATOR_SECURITY,
				responses: {
					'200': jsonResponse(dbOverviewSchema, 'The project database overview.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/db/admin/collections/{name}': {
			put: {
				tags: [DB_TAG],
				summary: 'Create or configure a collection',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(
					dbCollectionConfigSchema,
					'Access modes, permission requirements, and document rules.'
				),
				responses: {
					'200': { description: 'Collection configured.' },
					'401': UNAUTHORIZED,
					'429': { description: 'Collection cap reached.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a collection and every document in it',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Collection erased.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/collections/{name}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON export',
				description: 'Streams every document regardless of access modes.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'An application/x-ndjson stream of DbDocument lines.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/collections/{name}/import': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON import',
				description:
					'Upserts one document per NDJSON line (up to 1000 per request); exported lines round-trip with id, owner, and timestamps preserved. Validator rules do not apply - this is an operator surface.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'application/x-ndjson document lines.',
					required: true,
					content: { 'application/x-ndjson': { schema: { type: 'string' } } }
				},
				responses: {
					'200': jsonResponse(dbImportReportSchema, 'What landed and what failed, per line.'),
					'400': { description: 'No lines, or over the per-request document cap.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'413': { description: 'Import body over the byte cap.' }
				}
			}
		},
		'/db/admin/collections/{name}/restore': {
			post: {
				tags: [DB_TAG],
				summary: 'Roll the collection back in time',
				description:
					'Point-in-time recovery over Durable Object SQLite bookmarks (30-day window). Live subscribers are disconnected and reconnect against the restored data; the response carries the bookmark that undoes the rollback. Unavailable in local development (501).',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbRestoreRequestSchema, 'A timestamp or an exact bookmark.'),
				responses: {
					'200': jsonResponse(dbRestoreResultSchema, 'Restored; keep the undo bookmark.'),
					'400': { description: 'Invalid request, or the platform refused the restore.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/remote-config': {
			get: {
				tags: [DB_TAG],
				summary: 'Fetch evaluated Remote Config',
				description: [
					'The values THIS caller resolves to, with targeting applied server-side.',
					'',
					'No authentication required, by design: config has to resolve on a logged-out first',
					'run, which is the moment it exists for. A project JWT is READ when present -',
					'`role` and `permission` rules match on its claims - but never demanded, and an',
					'invalid one makes the caller anonymous rather than an error.',
					'',
					'The response is resolved values ONLY. Which cohorts exist, what the rollout',
					'percentages are, and which flags are aimed at internal roles never leave the',
					'server - that is why evaluation happens here instead of in the client.',
					'',
					'Country comes from the edge and cannot be supplied by the caller. Send `uid` for',
					'stable percentage rollouts (the signed-in subject is used when there is a token)',
					'and `appVersion` to match version rules. Honour the `ETag`: repeat fetches with',
					'`If-None-Match` answer 304.'
				].join('\n'),
				security: PUBLIC_SECURITY,
				parameters: [
					{
						name: 'uid',
						in: 'query',
						required: false,
						schema: { type: 'string' },
						description:
							'Stable per-install id for percentage rollouts. Ignored when a token is sent (the subject wins). Advisory - a rollout is not an entitlement.'
					},
					{
						name: 'appVersion',
						in: 'query',
						required: false,
						schema: { type: 'string', example: '2.1.0' },
						description: 'Client build version, for appVersion rules.'
					}
				],
				responses: {
					'200': jsonResponse(dbRemoteConfigResolvedSchema, 'The values for this caller.'),
					'304': { description: 'Unchanged since the ETag you sent.' }
				}
			}
		},
		'/db/admin/remote-config': {
			get: {
				tags: [DB_TAG],
				summary: 'List Remote Config parameters',
				description:
					'Server-controlled values an app reads at startup - feature flags, kill switches, tuning values. Editing is a DRAFT: `draftValue` is what the console shows, `publishedValue` is what clients are being served, and `pending` marks the difference. The parameter table is provisioned on the first call, so a project that never uses Remote Config never pays for one.',
				security: OPERATOR_SECURITY,
				responses: {
					'200': jsonResponse(dbRemoteConfigSchema, 'Parameters, sorted by key.'),
					'401': UNAUTHORIZED
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Remove Remote Config entirely',
				description:
					'Drops the parameter table and everything in it. The way back out: the `cfb_` prefix reserves the table from the generic routes, so the feature that owns it owns removing it. It is recreated empty on the next read.',
				security: OPERATOR_SECURITY,
				responses: {
					'200': { description: 'Removed, or nothing to remove.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/db/admin/remote-config/{key}': {
			put: {
				tags: [DB_TAG],
				summary: 'Add or edit a parameter (draft)',
				description:
					'Writes the DRAFT only. Nothing reaches clients until publish, which is what lets several parameters move together instead of leaking half a config change.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(
					dbRemoteConfigParameterInputSchema,
					'The parameter to store as a draft.'
				),
				responses: {
					'200': jsonResponse(dbRemoteConfigParameterSchema, 'The stored draft.'),
					'400': { description: 'Bad key, or a value that does not match its declared type.' },
					'401': UNAUTHORIZED,
					'409': { description: 'The per-project parameter ceiling is reached.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Remove a parameter (draft)',
				description:
					'A parameter clients have never seen goes immediately; a live one is MARKED and keeps being served until the next publish - otherwise removal would be the one edit that takes effect before you publish it.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: '`deleted` and `pendingPublish` say which of the two happened.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such parameter.' }
				}
			}
		},
		'/db/admin/remote-config/publish': {
			post: {
				tags: [DB_TAG],
				summary: 'Publish draft changes',
				description:
					'Drafts become what clients get, in one step, and a named restore point records the result - so a version IS a point you can put the config back to.',
				security: OPERATOR_SECURITY,
				requestBody: {
					description: 'Optional reason label, shown in the change history.',
					required: false,
					content: {
						'application/json': {
							schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 80 } } }
						}
					}
				},
				responses: {
					'200': { description: 'How many parameters changed and how many were removed.' },
					'401': UNAUTHORIZED,
					'409': { description: 'Nothing to publish.' }
				}
			}
		},
		'/db/admin/remote-config/discard': {
			post: {
				tags: [DB_TAG],
				summary: 'Discard draft changes',
				description:
					'Every unpublished edit goes back to what clients are being served; parameters added but never published are removed.',
				security: OPERATOR_SECURITY,
				responses: {
					'200': { description: 'How many parameters were reverted.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/db/admin/remote-config/versions': {
			get: {
				tags: [DB_TAG],
				summary: 'Remote Config change history',
				description:
					"The parameter table's own restore points - one per publish. Local development has no point-in-time recovery, which `supported: false` reports rather than failing.",
				security: OPERATOR_SECURITY,
				responses: {
					'200': jsonResponse(dbRestorePointsSchema, 'Support flag and captured versions.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/db/admin/remote-config/restore': {
			post: {
				tags: [DB_TAG],
				summary: 'Roll back to a version',
				description:
					'Puts every parameter back to how it was at that point, drafts included. The rollback itself returns the bookmark that reverses it.',
				security: OPERATOR_SECURITY,
				requestBody: jsonBody(dbRestoreRequestSchema, 'Exactly one of `bookmark` or `timestamp`.'),
				responses: {
					'200': jsonResponse(dbRestoreResultSchema, 'The bookmark that undoes this rollback.'),
					'400': { description: 'Invalid request, or a timestamp outside the 30-day window.' },
					'401': UNAUTHORIZED,
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/replication/{name}': {
			get: {
				tags: [DB_TAG],
				summary: 'Replication status for one shard',
				description:
					'Replication defaults to auto: reads route to per-region replicas, writes answer with a `cfb-lsn` session bookmark, and sending it back as `cfb-min-lsn` guarantees read-your-writes. Replicas materialize in a region the first time it reads, so an empty list on an enabled shard just means no region has read yet.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbReplicationStatusSchema, 'Change-log head and replica map.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or table.' }
				}
			}
		},
		'/db/admin/collections/{name}/restore-points': {
			get: {
				tags: [DB_TAG],
				summary: 'List captured restore points',
				description:
					'Named PITR markers plus whether this environment supports recovery at all. Markers are conveniences - restore-by-timestamp reaches any moment in the 30-day window.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbRestorePointsSchema, 'Support flag and captured points.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/collections/{name}/checkpoint': {
			post: {
				tags: [DB_TAG],
				summary: 'Capture a restore point now',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'Optional reason label.',
					required: false,
					content: {
						'application/json': {
							schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 80 } } }
						}
					}
				},
				responses: {
					'200': jsonResponse(dbRestorePointSchema, 'The captured point.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/collections/{name}/bookmark': {
			get: {
				tags: [DB_TAG],
				summary: 'Resolve a time to its closest bookmark',
				description: 'D1-restore-style: pass ?at=<ISO time> within the past 30 days.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{
						name: 'at',
						in: 'query',
						required: true,
						schema: { type: 'string', format: 'date-time' }
					}
				],
				responses: {
					'200': jsonResponse(dbBookmarkResolutionSchema, 'The closest available bookmark.'),
					'400': { description: 'Missing/invalid ?at, or outside the 30-day window.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/tables/{name}': {
			put: {
				tags: [DB_TAG],
				summary: 'Declare or alter a table',
				description:
					'The full desired schema in. Additive changes (new columns, index toggles) apply as DDL; destructive changes are refused with 400. Uniquifying a column holding duplicate data fails with 409.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbTableConfigSchema, 'Access modes and the declared columns.'),
				responses: {
					'200': { description: 'Table declared or altered.' },
					'400': { description: 'Invalid or destructive schema change.' },
					'401': UNAUTHORIZED,
					'409': { description: 'Name in use by a collection, or the DDL failed.' },
					'429': { description: 'Shard cap reached (collections + tables share the pool).' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a table and every row in it',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Table erased.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/collections/{name}/documents/{docId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator document read',
				description:
					'Reads one document regardless of access modes. `/db/admin/query` cannot stand in for this: ' +
					'its `where.field` clauses compile to JSON paths into the document body, and `id` is a system ' +
					'column no query can reach.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The document.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or document.' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Operator document upsert',
				description:
					'Replaces the document, bypassing access modes and validators (the Admin-SDK contract). ' +
					'`?ifAbsent=1` refuses taken ids with 409.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(dbWriteRequestSchema, 'The document data, wrapped as { data }.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The written document.'),
					'400': { description: 'Invalid document body.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'409': { description: 'That id already exists (with ?ifAbsent=1).' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Operator document merge',
				description:
					'Shallow-merges into the document body. Never CREATES - PUT is the upsert, and a PATCH that ' +
					'invented a document from a partial body would write one missing every field the caller ' +
					'assumed was already there.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(dbWriteRequestSchema, 'The fields to merge, wrapped as { data }.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The merged document.'),
					'400': { description: 'Invalid document body.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or document.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Operator document delete',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or document.' }
				}
			}
		},
		'/db/admin/tables/{name}/sql': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator single-table SQL',
				description:
					'The operator mirror of `/db/tables/{table}/sql`, and the one meaningful difference is the ' +
					'credential: this one takes NO project JWT, so a service key reaches it where the public ' +
					'route would refuse. Same statement gate - one SELECT/INSERT/UPDATE/DELETE or an atomic ' +
					'`batch`, this table only, no DDL, no transactions - and owner-mode indifference.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: '`{ sql, params? }` or `{ batch: [{ sql, params? }, ...] }`.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									sql: { type: 'string' },
									params: { type: 'array', items: {} },
									batch: {
										type: 'array',
										items: {
											type: 'object',
											required: ['sql'],
											properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }
										}
									}
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Statement results, with `columns` order and `raw` value arrays.' },
					'400': { description: 'The statement gate refused it.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/rows/{rowId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator row read',
				description:
					'The collection twin. Reachable through admin SQL too, but raw SQL is not an API for a ' +
					'single-row read, and both kinds should need the same idiom.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The row.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such table or row.' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Operator row merge',
				description:
					'Shallow-merges the named columns. Structure always validates (the schema IS the storage); ' +
					'policy bounds are bypassed like document validators. Never creates.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(dbWriteRequestSchema, 'The columns to merge, wrapped as { data }.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The merged row.'),
					'400': { description: 'The row failed the declared schema.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table or row.' },
					'409': { description: 'Unique-column conflict.' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Operator row upsert',
				description:
					'Structure (types, NOT NULL) always validates; policy rules (bounds, enum) are bypassed like document validators. `?ifAbsent=1` refuses taken ids with 409.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(dbWriteRequestSchema, 'The row data, wrapped as { data }.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The written row.'),
					'400': { description: 'The row failed the declared schema.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'409': { description: 'Id or unique-column conflict.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Operator row delete',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table or row.' }
				}
			}
		},
		'/db/admin/tables/{name}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON export (table)',
				description: 'Streams every row regardless of access modes.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'An application/x-ndjson stream of row lines.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/import': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON import (table)',
				description:
					'Upserts one row per NDJSON line (up to 1000 per request); exported lines round-trip with id, owner, and timestamps preserved. Structure (types, NOT NULL) always validates; policy bounds do not apply - this is an operator surface.',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'application/x-ndjson row lines.',
					required: true,
					content: { 'application/x-ndjson': { schema: { type: 'string' } } }
				},
				responses: {
					'200': jsonResponse(dbImportReportSchema, 'What landed and what failed, per line.'),
					'400': { description: 'No lines, or over the per-request row cap.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'413': { description: 'Import body over the byte cap.' }
				}
			}
		},
		'/db/admin/tables/{name}/restore': {
			post: {
				tags: [DB_TAG],
				summary: 'Roll the table back in time',
				description:
					'Point-in-time recovery over Durable Object SQLite bookmarks (30-day window) - the collection contract on tables. Unavailable in local development (501).',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbRestoreRequestSchema, 'A timestamp or an exact bookmark.'),
				responses: {
					'200': jsonResponse(dbRestoreResultSchema, 'Restored; keep the undo bookmark.'),
					'400': { description: 'Invalid request, or the platform refused the restore.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/tables/{name}/restore-points': {
			get: {
				tags: [DB_TAG],
				summary: 'List captured restore points (table)',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbRestorePointsSchema, 'Support flag and captured points.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/checkpoint': {
			post: {
				tags: [DB_TAG],
				summary: 'Capture a restore point now (table)',
				security: OPERATOR_SECURITY,
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'Optional reason label.',
					required: false,
					content: {
						'application/json': {
							schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 80 } } }
						}
					}
				},
				responses: {
					'200': jsonResponse(dbRestorePointSchema, 'The captured point.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/tables/{name}/bookmark': {
			get: {
				tags: [DB_TAG],
				summary: 'Resolve a time to its closest bookmark (table)',
				description: 'D1-restore-style: pass ?at=<ISO time> within the past 30 days.',
				security: OPERATOR_SECURITY,
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{
						name: 'at',
						in: 'query',
						required: true,
						schema: { type: 'string', format: 'date-time' }
					}
				],
				responses: {
					'200': jsonResponse(dbBookmarkResolutionSchema, 'The closest available bookmark.'),
					'400': { description: 'Missing/invalid ?at, or outside the 30-day window.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator aggregate over any collection',
				description: 'count/sum/avg regardless of access modes.',
				security: OPERATOR_SECURITY,
				requestBody: {
					description: 'The collection and aggregate request.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['collection', 'aggregate'],
								properties: {
									collection: { type: 'string' },
									aggregate: { $ref: '#/components/schemas/DbAggregateRequest' }
								}
							}
						}
					}
				},
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator query over any collection or table',
				description:
					'Drives the dashboard browser; bypasses access modes. Name exactly one of `collection` or `table`.',
				security: OPERATOR_SECURITY,
				requestBody: {
					description: 'The collection or table, and the query.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									collection: { type: 'string' },
									table: { type: 'string' },
									query: { $ref: '#/components/schemas/DbQuery' }
								}
							}
						}
					}
				},
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching documents or rows.'),
					'400': { description: 'Neither or both names, or a table compile refusal.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or table.' }
				}
			}
		}
	}
};
