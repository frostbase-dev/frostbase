/**
 * Contract between the SvelteKit dashboard and the auth-agent worker.
 *
 * Kept as local copies (not imported from agents/auth) so the two workers stay
 * separate TypeScript projects with their own generated Env types. Keep in
 * sync with agents/auth/src/agent.ts.
 *
 * These are zod schemas rather than bare interfaces so one definition serves
 * three jobs: the exported types, runtime parsing of responses that cross the
 * service binding, and the OpenAPI document in $lib/openapi. `.meta({ id })`
 * names the component in that document; `.describe()` becomes its docs.
 */
import { z } from 'zod';

export const authActivityEventSchema = z
	.object({
		id: z.string(),
		type: z.enum([
			'project.provisioned',
			'user.created',
			'user.deleted',
			'user.role-changed',
			'session.created',
			'session.revoked'
		]),
		message: z.string(),
		at: z.iso.datetime()
	})
	.meta({ id: 'AuthActivityEvent' });

export const roleDefinitionSchema = z
	.object({
		name: z.string().describe('Lowercase role slug, e.g. "admin".'),
		permissions: z
			.array(z.string())
			.describe('Permission keys like "posts:write", or "*" for everything.')
	})
	.meta({ id: 'RoleDefinition', description: 'An assignable RBAC role and the keys it grants.' });

export const authAgentStateSchema = z
	.object({
		projectId: z.string(),
		provisionedAt: z.iso.datetime().nullable(),
		roles: z
			.array(roleDefinitionSchema)
			.describe('Role registry; always contains the built-in `user` and `admin`.'),
		allowedOrigins: z.array(z.string()),
		enabledSocialProviders: z.array(z.string()),
		// Tolerant: state persisted before the policy existed still parses, and
		// the defaults are exactly what those projects were already doing.
		authPolicy: z
			.object({
				allowAnonymous: z.boolean(),
				requireEmailVerification: z.boolean()
			})
			.catch({ allowAnonymous: true, requireEmailVerification: false }),
		users: z.number().int(),
		activeSessions: z.number().int(),
		totalEvents: z.number().int(),
		lastEventAt: z.iso.datetime().nullable(),
		events: z.array(authActivityEventSchema)
	})
	.meta({
		id: 'AuthAgentState',
		description: 'Synced in realtime from the AuthAgent via WebSocket state sync.'
	});

export const overviewUserSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		emailVerified: z.boolean(),
		isAnonymous: z.boolean(),
		role: z.string(),
		providers: z.array(z.string()),
		createdAt: z.iso.datetime()
	})
	.meta({ id: 'OverviewUser' });

export const overviewSessionSchema = z
	.object({
		id: z.string(),
		userId: z.string(),
		email: z.string().nullable(),
		ipAddress: z.string().nullable(),
		userAgent: z.string().nullable(),
		country: z.string().nullable(),
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime()
	})
	.meta({ id: 'OverviewSession' });

export const authOverviewSchema = z
	.object({
		projectId: z.string(),
		users: z.array(overviewUserSchema),
		/** Continuation for `/admin/users`; absent when this is the last page. */
		usersNextCursor: z.string().optional(),
		sessions: z.array(overviewSessionSchema),
		/** Continuation for `/admin/sessions`; absent on the last page. */
		sessionsNextCursor: z.string().optional(),
		state: authAgentStateSchema
	})
	.meta({ id: 'AuthOverview' });

/** Keyset pages: the cursor is opaque, so the agent's ordering can change
 * without a client change. */
export const userPageSchema = z
	.object({ users: z.array(overviewUserSchema), nextCursor: z.string().optional() })
	.meta({ id: 'UserPage' });

export const sessionPageSchema = z
	.object({ sessions: z.array(overviewSessionSchema), nextCursor: z.string().optional() })
	.meta({ id: 'SessionPage' });

export const authAnalyticsSchema = z
	.object({
		projectId: z.string(),
		dau: z.number().int().describe('Daily active users.'),
		wau: z.number().int().describe('Weekly active users.'),
		mau: z.number().int().describe('Monthly active users.'),
		totalUsers: z.number().int(),
		registeredUsers: z.number().int(),
		anonymousUsers: z.number().int(),
		gmailUsers: z.number().int(),
		activeSessions: z.number().int(),
		providers: z.array(z.object({ provider: z.string(), users: z.number().int() })),
		countries: z.array(z.object({ country: z.string(), sessions: z.number().int() })),
		activityByDay: z.array(
			z.object({
				day: z.string(),
				signups: z.number().int(),
				signins: z.number().int()
			})
		),
		engine: z
			.object({
				dataset: z.string(),
				enabled: z.boolean(),
				status: z.enum(['connected', 'local', 'write-only', 'error']),
				error: z.string().optional()
			})
			.describe('Workers Analytics Engine metrics pipeline.'),
		eventsLast24h: z
			.array(z.object({ eventType: z.string(), count: z.number().int() }))
			.optional()
			.describe('Event counts from the Analytics Engine SQL API - only when enabled.')
	})
	.meta({ id: 'AuthAnalytics' });

export const agentChatMessageSchema = z
	.object({
		id: z.string(),
		role: z.enum(['user', 'agent']),
		content: z.string(),
		createdAt: z.iso.datetime()
	})
	.meta({ id: 'AgentChatMessage' });

export const agentChatReplySchema = z
	.object({
		question: z.string(),
		topic: z.literal('ai-analysis'),
		answer: z.string(),
		mode: z.literal('workers-ai'),
		model: z.string(),
		userMessage: agentChatMessageSchema,
		agentMessage: agentChatMessageSchema
	})
	.meta({ id: 'AgentChatReply' });

export const registryProjectSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		/** Root project this row branches from; null = a root project. */
		parentId: z.string().nullable(),
		/** The branch's short name (`staging`); null on roots (`main`). */
		branchName: z.string().nullable(),
		/** Owning organization (console AuthAgent org id); null = unowned
		 * legacy/self-hosted row, visible to any operator. */
		orgId: z.string().nullable(),
		createdAt: z.iso.datetime()
	})
	.meta({ id: 'RegistryProject', description: 'A project or branch this installation owns.' });

export const projectRegistryStateSchema = z
	.object({ projects: z.array(registryProjectSchema) })
	.meta({ id: 'ProjectRegistryState' });

export const projectBranchesSchema = z
	.object({ branches: z.array(registryProjectSchema) })
	.meta({ id: 'ProjectBranches', description: "A root project's branches, oldest first." });

// ---------------------------------------------------------------------------
// DB agent DTOs. Keep in sync with agents/db/src/schemas.ts and
// agents/db/src/agent.ts - deliberately copied, never imported (the agent is
// its own TypeScript project with its own generated Env).

/** `none` closes a side to the public API entirely - operator surfaces only.
 * A read-only collection is `writeAccess: 'none'`. */
export const dbAccessModeSchema = z.enum(['public', 'auth', 'owner', 'none']);

const dbFieldPath = z
	.string()
	.max(128)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/);
const dbScalar = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);

export const dbQuerySchema = z
	.object({
		where: z
			.array(
				z.object({
					field: dbFieldPath,
					op: z.enum(['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains']),
					value: z.union([dbScalar, z.array(dbScalar).min(1).max(20)])
				})
			)
			.max(10)
			.optional(),
		orderBy: z
			.array(z.object({ field: dbFieldPath, direction: z.enum(['asc', 'desc']) }))
			.max(2)
			.optional(),
		limit: z.number().int().min(1).max(200).optional(),
		cursor: z.string().optional()
	})
	.meta({
		id: 'DbQuery',
		description:
			'Filtered query: AND-combined where clauses over dotted JSON field paths, up to two orderBy fields (document id is always the final tiebreak), a page limit, and an opaque continuation cursor (REST only).'
	});

export const dbDocumentSchema = z
	.object({
		id: z.string(),
		data: z.record(z.string(), z.unknown()),
		owner: z.string().nullable(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime()
	})
	.meta({ id: 'DbDocument', description: 'A document: metadata outside data, no collisions.' });

export const dbWriteAckSchema = z.object({ id: z.string() }).meta({
	id: 'DbWriteAck',
	description:
		"The write landed, but the caller may not read the record back (readAccess `none`, or another owner's record under `owner` reads), so only its id is returned."
});

export const dbWriteResultSchema = z.union([dbDocumentSchema, dbWriteAckSchema]).meta({
	id: 'DbWriteResult',
	description:
		'An update answers with the full record when the caller may read it, otherwise only its id - the merged record is a read the write gate never authorized.'
});

export const dbQueryResultSchema = z
	.object({ docs: z.array(dbDocumentSchema), nextCursor: z.string().optional() })
	.meta({ id: 'DbQueryResult' });

export const dbCreateRequestSchema = z
	.object({ id: z.string().optional(), data: z.record(z.string(), z.unknown()) })
	.meta({ id: 'DbCreateRequest' });

export const dbWriteRequestSchema = z
	.record(z.string(), z.unknown())
	.meta({ id: 'DbWriteRequest', description: 'The document data (PUT replaces, PATCH merges).' });

/** The auth agent's permission-key grammar: `resource:action` or `*`. */
export const dbPermissionKeySchema = z
	.string()
	.trim()
	.max(64)
	.regex(/^(\*|[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*)$/);

export const dbFieldRuleSchema = z
	.object({
		type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'any']).default('any'),
		required: z.boolean().default(false),
		maxLength: z.number().int().min(0).max(131072).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		enum: z.array(dbScalar).min(1).max(20).optional()
	})
	.meta({
		id: 'DbFieldRule',
		description:
			'One field rule: a JSON type, required flag, maxLength for strings/arrays, min/max for numbers, and an allowed-values enum.'
	});

export const dbValidatorSchema = z
	.object({
		fields: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), dbFieldRuleSchema),
		additionalFields: z.enum(['allow', 'reject']).default('allow')
	})
	.refine(
		(validator) => {
			const count = Object.keys(validator.fields).length;
			return count >= 1 && count <= 20;
		},
		{ message: 'a validator declares 1 to 20 top-level fields' }
	)
	.meta({
		id: 'DbValidator',
		description:
			'Rules-lite document validation over top-level fields, enforced on the public write path (operator surfaces bypass it, like the Firestore Admin SDK bypasses security rules).'
	});

export const dbReplicationModeSchema = z.enum(['off', 'auto']);

export const dbCollectionConfigSchema = z
	.object({
		readAccess: dbAccessModeSchema,
		writeAccess: dbAccessModeSchema,
		readPermission: dbPermissionKeySchema.nullable().optional(),
		writePermission: dbPermissionKeySchema.nullable().optional(),
		validator: dbValidatorSchema.nullable().optional(),
		replication: dbReplicationModeSchema.optional()
	})
	.meta({
		id: 'DbCollectionConfig',
		description:
			'Access modes: public (anyone), auth (any valid project JWT), owner (results and writes scoped to the token subject). Optional permission keys additionally require that claim on the JWT (auth/owner modes; `*` in the claim always passes); an optional validator enforces document rules on public writes. Replication defaults to auto (reads served from per-region replicas); `off` opts a single-region shard out. Omitted fields stay unchanged, explicit null clears.'
	});

export const dbCollectionSummarySchema = z
	.object({
		name: z.string(),
		readAccess: dbAccessModeSchema,
		writeAccess: dbAccessModeSchema,
		// Tolerant on purpose: agent STATE is persisted, so a project
		// provisioned before these fields existed still broadcasts the old
		// summary shape until its next sync - a strict parse would 502 the
		// whole db page for exactly the projects that already have data.
		readPermission: z.string().nullable().catch(null),
		writePermission: z.string().nullable().catch(null),
		validator: dbValidatorSchema.nullable().catch(null),
		replication: z.enum(['off', 'auto']).catch('off'),
		docs: z.number()
	})
	.meta({ id: 'DbCollectionSummary' });

export const dbActivityEventSchema = z
	.object({
		id: z.string(),
		type: z.enum([
			'project.provisioned',
			'collection.created',
			'collection.deleted',
			'collection.configured',
			'collection.restored',
			'documents.changed',
			'documents.imported',
			'table.created',
			'table.configured',
			'table.deleted',
			'table.restored',
			'rows.changed',
			'rows.imported',
			'view.created',
			'view.configured',
			'view.deleted',
			'remote-config.changed'
		]),
		message: z.string(),
		at: z.iso.datetime()
	})
	.meta({ id: 'DbActivityEvent' });

// --- Tables (phase T1) ---

export const dbColumnTypeSchema = z.enum(['text', 'integer', 'real', 'boolean', 'json']);

export const dbTableColumnSchema = z
	.object({
		name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
		type: dbColumnTypeSchema,
		nullable: z.boolean().optional(),
		default: dbScalar.optional(),
		unique: z.boolean().optional(),
		index: z.boolean().optional(),
		maxLength: z.number().int().min(0).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		enum: z.array(dbScalar).min(1).max(20).optional()
	})
	.meta({
		id: 'DbTableColumn',
		description:
			'One declared column. Types are enforced on write; `id`, `owner`, `created_at`, and `updated_at` are reserved system columns. NOT NULL without a default means required-on-write.'
	});

export const dbTableConfigSchema = z
	.object({
		readAccess: dbAccessModeSchema,
		writeAccess: dbAccessModeSchema,
		readPermission: dbPermissionKeySchema.nullable().optional(),
		writePermission: dbPermissionKeySchema.nullable().optional(),
		columns: z.array(dbTableColumnSchema).min(1).max(64),
		replication: dbReplicationModeSchema.optional()
	})
	.meta({
		id: 'DbTableConfig',
		description:
			'The full desired table schema plus access modes. Additive changes apply as DDL; destructive changes (drop/retype/renullability) are refused - export, recreate, and import instead. Replication defaults to auto; `off` opts out, omitted = unchanged.'
	});

export const dbTableSummarySchema = z
	.object({
		name: z.string(),
		readAccess: dbAccessModeSchema,
		writeAccess: dbAccessModeSchema,
		readPermission: z.string().nullable().catch(null),
		writePermission: z.string().nullable().catch(null),
		columns: z.array(dbTableColumnSchema).catch([]),
		replication: z.enum(['off', 'auto']).catch('off'),
		rows: z.number()
	})
	.meta({ id: 'DbTableSummary' });

// Mirrors RepStatus in agents/db/src/schemas.ts (GET /admin/replication/:name).
export const dbReplicaSchema = z
	.object({
		/** `r:<region>:<n>` - the instance-name suffix that makes it a replica. */
		id: z.string(),
		region: z.string(),
		appliedLsn: z.number(),
		lagLsn: z.number(),
		/** Holds live subscribers, so the primary RPC-pushes every write to it. */
		push: z.boolean(),
		/** Reported hibernatable-socket count; at the spawn threshold new
		 * subscribers route to the next sibling. Tolerant for pre-sibling
		 * agents that did not report it. */
		sockets: z.number().catch(0),
		lastSeenAt: z.iso.datetime()
	})
	.meta({ id: 'DbReplica' });

export const dbReplicationStatusSchema = z
	.object({
		enabled: z.boolean(),
		/** Parent-owned restore epoch; a bump forces replica re-bootstrap. */
		epoch: z.number(),
		lastLsn: z.number(),
		horizonLsn: z.number(),
		/** Empty when disabled - and often when enabled too: replicas materialize
		 * in a region the first time that region reads. */
		replicas: z.array(dbReplicaSchema),
		/** The primary's own location (/cdn-cgi/trace; nulls in local dev), so
		 * the replication map can place the hub where the DO really lives. */
		primary: z.object({ colo: z.string().nullable(), country: z.string().nullable() }).optional()
	})
	.meta({
		id: 'DbReplicationStatus',
		description:
			'Per-shard replication status: the primary change-log position and every durably registered region replica with its applied position and lag.'
	});

export const dbAggregateRequestSchema = z
	.object({
		where: dbQuerySchema.shape.where,
		aggregates: z.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/),
			z.object({
				op: z.enum(['count', 'sum', 'avg']),
				field: dbFieldPath.optional()
			})
		)
	})
	.meta({
		id: 'DbAggregateRequest',
		description:
			'count/sum/avg (1-5 per request, keyed by result alias) over the same where clauses as a query. count takes no field; sum/avg require one and skip non-numeric values.'
	});

export const dbAggregateResultSchema = z
	.object({ results: z.record(z.string(), z.number().nullable()) })
	.meta({
		id: 'DbAggregateResult',
		description: 'Aggregate values by alias. sum of nothing is 0; avg of nothing is null.'
	});

export const dbImportReportSchema = z
	.object({
		imported: z.number(),
		updated: z.number(),
		errors: z.array(z.object({ line: z.number(), error: z.string() }))
	})
	.meta({
		id: 'DbImportReport',
		description:
			'NDJSON import outcome: fresh documents, replaced documents, and per-line failures (1-based line numbers).'
	});

export const dbRestoreRequestSchema = z
	.object({
		timestamp: z.iso.datetime().optional(),
		bookmark: z.string().optional()
	})
	.meta({
		id: 'DbRestoreRequest',
		description:
			'Roll the collection back to a wall-clock time within the past 30 days, or to an exact bookmark (the undo path). Exactly one of the two.'
	});

export const dbRestoreResultSchema = z
	.object({ restored: z.boolean(), undoBookmark: z.string() })
	.meta({
		id: 'DbRestoreResult',
		description: 'Restoring to undoBookmark reverses the rollback.'
	});

export const dbRestorePointSchema = z
	.object({ bookmark: z.string(), reason: z.string(), capturedAt: z.iso.datetime() })
	.meta({
		id: 'DbRestorePoint',
		description:
			'A named PITR marker (manual checkpoint, before import, before rollback). Markers are conveniences - restore-by-timestamp reaches any moment in the 30-day window.'
	});

export const dbRestorePointsSchema = z
	.object({ supported: z.boolean(), points: z.array(dbRestorePointSchema) })
	.meta({
		id: 'DbRestorePoints',
		description:
			'Captured restore points plus whether this environment supports point-in-time recovery at all (local development does not).'
	});

export const dbBookmarkResolutionSchema = z
	.object({ bookmark: z.string(), at: z.iso.datetime() })
	.meta({
		id: 'DbBookmarkResolution',
		description: 'The closest available bookmark for a wall-clock time, D1-restore-style.'
	});

// --- Remote Config (RC1) ---

/**
 * Server-controlled parameters an app reads at startup - feature flags, kill
 * switches, tuning values - stored in a platform-owned DbTable that is closed
 * on both sides, so publish is a PITR checkpoint and rollback is a restore.
 *
 * Mirrors agents/db/src/schemas.ts; keep the two in sync.
 */
export const dbRemoteConfigValueTypeSchema = z.enum(['string', 'number', 'boolean', 'json']);

/** Editing is a draft; publishing is what reaches clients. */
export const dbRemoteConfigStateSchema = z.enum(['draft', 'published', 'deleting']);

/**
 * One targeting rule. Every field present must match; a field listing values
 * matches if any do. Conditions are an ordered list and the FIRST match wins -
 * there is no priority field and no else.
 *
 * `country` is resolved at the edge and cannot be claimed by a caller; `role`
 * and `permission` come from a verified project JWT; `appVersion` is
 * client-reported; `rollout` buckets by uid and is advisory, not an
 * entitlement. Mirrors agents/db/src/schemas.ts.
 */
export const dbRemoteConfigConditionSchema = z
	.object({
		label: z.string().max(60).optional(),
		when: z.object({
			country: z.array(z.string()).optional(),
			role: z.array(z.string()).optional(),
			permission: z.string().optional(),
			appVersion: z.object({ gte: z.string().optional(), lt: z.string().optional() }).optional(),
			rollout: z.object({ percent: z.number().int(), salt: z.string() }).optional()
		}),
		value: z.unknown()
	})
	.meta({
		id: 'DbRemoteConfigCondition',
		description: 'An ordered override. First match wins; no match yields the default.'
	});

export const dbRemoteConfigParameterSchema = z
	.object({
		key: z.string(),
		valueType: dbRemoteConfigValueTypeSchema,
		/** Typed by `valueType`, not by the schema: the type is data. */
		draftValue: z.unknown(),
		/** What clients get right now; null until first published. */
		publishedValue: z.unknown(),
		/** Targeting, drafted and published in step with the values. */
		draftConditions: z.array(dbRemoteConfigConditionSchema).nullable().catch(null),
		publishedConditions: z.array(dbRemoteConfigConditionSchema).nullable().catch(null),
		state: dbRemoteConfigStateSchema.catch('published'),
		/** Differs from what clients are being served. */
		pending: z.boolean(),
		description: z.string().nullable().catch(null),
		updatedBy: z.string().nullable().catch(null),
		updatedAt: z.iso.datetime()
	})
	.meta({ id: 'DbRemoteConfigParameter', description: 'One Remote Config parameter.' });

/** The `PUT /db/admin/remote-config/{key}` body. `defaultValue` is deliberately
 * untyped here: it is checked against `valueType` by the agent, which can say
 * "checkoutV2 is a boolean" where a zod union could only say "invalid". */
export const dbRemoteConfigParameterInputSchema = z
	.object({
		valueType: dbRemoteConfigValueTypeSchema,
		defaultValue: z.unknown(),
		description: z.string().max(200).nullable().optional(),
		/** Omitted leaves the drafted rules alone; null clears them. */
		conditions: z.array(dbRemoteConfigConditionSchema).nullable().optional()
	})
	.meta({
		id: 'DbRemoteConfigParameterInput',
		description: 'A parameter to store as a draft. Nothing reaches clients until publish.'
	});

/** The PUBLIC endpoint's answer: resolved values, and nothing else. */
export const dbRemoteConfigResolvedSchema = z
	.object({
		params: z.record(z.string(), z.unknown()),
		fetchedAt: z.iso.datetime()
	})
	.meta({
		id: 'DbRemoteConfigResolved',
		description:
			'Evaluated Remote Config for the calling app. Values only - the rules that produced them never leave the server.'
	});

export const dbRemoteConfigSchema = z
	.object({
		parameters: z.array(dbRemoteConfigParameterSchema),
		/** How many parameters are not yet what clients are being served. */
		pendingChanges: z.number().int().catch(0),
		everPublished: z.boolean().catch(false),
		limit: z.number().int()
	})
	.meta({
		id: 'DbRemoteConfig',
		description: "A project's Remote Config parameters, sorted by key."
	});

// --- Join views (JOIN1) ---

/** A read-only view over several member tables: one Durable Object that
 * follows each member's change log into one SQLite, so a SELECT can join
 * them. Read-only and eventually consistent by construction. */
export const dbViewSummarySchema = z
	.object({
		name: z.string(),
		members: z.array(z.string()),
		readPermission: z.string().nullable().catch(null)
	})
	.meta({ id: 'DbViewSummary' });

export const dbViewSourceStatusSchema = z
	.object({
		table: z.string(),
		appliedLsn: z.number(),
		/** Null when that member's primary could not be reached. */
		lagLsn: z.number().nullable(),
		epoch: z.number(),
		pulledAt: z.iso.datetime().nullable(),
		bootstrapped: z.boolean()
	})
	.meta({ id: 'DbViewSourceStatus' });

export const dbViewStatusSchema = z
	.object({
		view: z.string(),
		members: z.array(dbViewSourceStatusSchema),
		/** The oldest member pull - what the freshness window is judged on. */
		stalestPulledAt: z.iso.datetime().nullable()
	})
	.meta({ id: 'DbViewStatus' });

export const dbAgentStateSchema = z
	.object({
		projectId: z.string(),
		provisionedAt: z.iso.datetime().nullable(),
		allowedOrigins: z.array(z.string()),
		collections: z.array(dbCollectionSummarySchema),
		// Tolerant like the summary fields: state persisted before tables
		// existed still parses (the agent re-syncs on its next wake).
		tables: z.array(dbTableSummarySchema).catch([]),
		// Same tolerance, same reason: state persisted before join views
		// existed has no `views` key at all.
		views: z.array(dbViewSummarySchema).catch([]),
		totalDocs: z.number(),
		totalRows: z.number().catch(0),
		rev: z.number(),
		totalEvents: z.number(),
		lastEventAt: z.iso.datetime().nullable(),
		// `.catch([])` because the event-type enum is the one place a NEW agent
		// feature widens this state: Remote Config's first event 502'd the whole
		// db page until this mirror learned the type. An unknown event must cost
		// the activity feed, never the page.
		events: z.array(dbActivityEventSchema).catch([])
	})
	.meta({
		id: 'DbAgentState',
		description: 'Live coordinator state synced to dashboards; rev bumps drive refetches.'
	});

export const dbOverviewSchema = z
	.object({
		projectId: z.string(),
		collections: z.array(dbCollectionSummarySchema),
		tables: z.array(dbTableSummarySchema).catch([]),
		/** Where the coordinator DO runs. Places the Replication map's hub
		 * before any shard exists to report its own colo; `.catch` because an
		 * agent deployed before this field existed simply omits it. */
		location: z
			.object({ colo: z.string().nullable(), country: z.string().nullable() })
			.catch({ colo: null, country: null }),
		state: dbAgentStateSchema
	})
	.meta({ id: 'DbOverview' });

export const dbSubscribeFrameSchema = z
	.object({
		type: z.literal('subscribe'),
		id: z.string(),
		query: dbQuerySchema,
		token: z.string().optional()
	})
	.meta({
		id: 'DbSubscribeFrame',
		description:
			'Client frame on the live-query WebSocket (GET /collections/{name}/subscribe). The token is the project JWT for auth/owner collections.'
	});

export const dbServerFrameSchema = z
	.union([
		z.object({ type: z.literal('snapshot'), id: z.string(), docs: z.array(dbDocumentSchema) }),
		z.object({
			type: z.literal('change'),
			id: z.string(),
			kind: z.enum(['added', 'modified', 'removed']),
			doc: dbDocumentSchema
		}),
		z.object({ type: z.literal('unsubscribed'), id: z.string() }),
		z.object({
			type: z.literal('error'),
			id: z.string().optional(),
			code: z.string(),
			message: z.string()
		})
	])
	.meta({
		id: 'DbServerFrame',
		description:
			'Server frames on the live-query WebSocket: an initial snapshot in query order, then added/modified/removed deltas as writes happen.'
	});

// --- Storage agent (mirrors agents/storage/src/{agent,bucket,schemas}.ts) ---

/** `none` closes a side to the public API entirely - operator surfaces only.
 * A read-only bucket is `write: 'none'`. */
export const storageAccessModeSchema = z.enum(['public', 'auth', 'owner', 'none']);

export const storageBucketSummarySchema = z
	.object({
		name: z.string(),
		read: storageAccessModeSchema,
		write: storageAccessModeSchema,
		publicListing: z
			.boolean()
			.describe(
				'Whether anonymous callers may LIST a public bucket - separate from reading a known key.'
			),
		objectCount: z.number().int(),
		totalBytes: z.number().int(),
		createdAt: z.iso.datetime()
	})
	.meta({ id: 'StorageBucketSummary' });

export const storageBucketSchema = storageBucketSummarySchema
	.extend({
		readPermission: z.string().nullable(),
		writePermission: z.string().nullable(),
		maxObjectBytes: z.number().int().nullable(),
		allowedContentTypes: z.array(z.string()).nullable(),
		cacheControl: z.string().nullable(),
		configVersion: z.number().int()
	})
	.meta({
		id: 'StorageBucket',
		description:
			'One bucket: a named namespace of objects with its own access modes. New buckets default to `auth` on both read and write.'
	});

export const storageBucketConfigInputSchema = z
	.object({
		read: storageAccessModeSchema.optional(),
		write: storageAccessModeSchema.optional(),
		readPermission: z.string().nullable().optional(),
		writePermission: z.string().nullable().optional(),
		publicListing: z.boolean().optional(),
		maxObjectBytes: z.number().int().nullable().optional(),
		allowedContentTypes: z.array(z.string()).nullable().optional(),
		cacheControl: z.string().nullable().optional()
	})
	.meta({
		id: 'StorageBucketConfigInput',
		description: 'Omitted fields keep their stored value; explicit null clears.'
	});

export const storageObjectSchema = z
	.object({
		key: z.string(),
		size: z.number().int(),
		etag: z.string(),
		contentType: z.string(),
		owner: z
			.string()
			.describe('JWT subject that wrote the object; empty for public/operator writes.'),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime()
	})
	.meta({ id: 'StorageObject' });

export const storageFolderSchema = z
	.object({
		prefix: z.string().describe('The folder prefix, INCLUDING its trailing slash.'),
		objectCount: z.number().int().describe('Objects beneath it at any depth.')
	})
	.meta({ id: 'StorageFolder' });

export const storageObjectPageSchema = z
	.object({
		objects: z.array(storageObjectSchema),
		total: z.number().int(),
		cursor: z
			.string()
			.nullable()
			.describe('Keyset cursor for the next page; null on the last one.'),
		folders: z
			.array(storageFolderSchema)
			.optional()
			.describe('Only present for a delimited (folder-view) listing.'),
		foldersTruncated: z
			.boolean()
			.optional()
			.describe('More folders exist than were returned - never silently dropped.')
	})
	.meta({ id: 'StorageObjectPage' });

export const storageOverviewSchema = z
	.object({
		projectId: z.string(),
		provisionedAt: z.iso.datetime().nullable(),
		buckets: z.array(storageBucketSummarySchema),
		totalObjects: z.number().int(),
		totalBytes: z.number().int(),
		configured: z.boolean().describe('Whether this install can store bytes (the R2 binding).'),
		serveOrigin: z
			.string()
			.nullable()
			.optional()
			.describe(
				'The dedicated object-serving origin, when one is routed at the storage worker. Null when objects are only reachable on this console origin. Optional so a pre-2026-08-18 agent still parses.'
			),
		erasing: z.boolean(),
		demo: z
			.boolean()
			.optional()
			.describe(
				'The synthetic read-only sample bucket, not a provisioned project. Every mutating surface answers 403, so the console renders no affordance that would.'
			),
		caps: z.object({
			maxBuckets: z.number().int(),
			maxObjectsPerBucket: z.number().int(),
			maxProjectBytes: z.number().int()
		})
	})
	.meta({ id: 'StorageOverview' });

export type AuthActivityEvent = z.infer<typeof authActivityEventSchema>;
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;
export type AuthAgentState = z.infer<typeof authAgentStateSchema>;
export type OverviewUser = z.infer<typeof overviewUserSchema>;
export type OverviewSession = z.infer<typeof overviewSessionSchema>;
export type AuthOverview = z.infer<typeof authOverviewSchema>;
export type UserPage = z.infer<typeof userPageSchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;
export type AuthAnalytics = z.infer<typeof authAnalyticsSchema>;
export type AgentChatMessage = z.infer<typeof agentChatMessageSchema>;
export type AgentChatReply = z.infer<typeof agentChatReplySchema>;
export type RegistryProject = z.infer<typeof registryProjectSchema>;
export type ProjectRegistryState = z.infer<typeof projectRegistryStateSchema>;
export type ProjectBranches = z.infer<typeof projectBranchesSchema>;
export type DbAccessMode = z.infer<typeof dbAccessModeSchema>;
export type DbQuery = z.infer<typeof dbQuerySchema>;
export type DbDocument = z.infer<typeof dbDocumentSchema>;
export type DbQueryResult = z.infer<typeof dbQueryResultSchema>;
export type DbFieldRule = z.infer<typeof dbFieldRuleSchema>;
export type DbValidator = z.infer<typeof dbValidatorSchema>;
export type DbCollectionSummary = z.infer<typeof dbCollectionSummarySchema>;
export type DbColumnType = z.infer<typeof dbColumnTypeSchema>;
export type DbTableColumn = z.infer<typeof dbTableColumnSchema>;
export type DbTableConfig = z.infer<typeof dbTableConfigSchema>;
export type DbTableSummary = z.infer<typeof dbTableSummarySchema>;
export type DbActivityEvent = z.infer<typeof dbActivityEventSchema>;
export type DbAgentState = z.infer<typeof dbAgentStateSchema>;
export type DbOverview = z.infer<typeof dbOverviewSchema>;
export type DbAggregateRequest = z.infer<typeof dbAggregateRequestSchema>;
export type DbImportReport = z.infer<typeof dbImportReportSchema>;
export type DbRestoreResult = z.infer<typeof dbRestoreResultSchema>;
export type DbRestorePoint = z.infer<typeof dbRestorePointSchema>;
export type DbRemoteConfigParameter = z.infer<typeof dbRemoteConfigParameterSchema>;
export type DbRemoteConfig = z.infer<typeof dbRemoteConfigSchema>;
export type DbRemoteConfigCondition = z.infer<typeof dbRemoteConfigConditionSchema>;
export type DbRestorePoints = z.infer<typeof dbRestorePointsSchema>;
export type DbReplicationMode = z.infer<typeof dbReplicationModeSchema>;
export type DbReplica = z.infer<typeof dbReplicaSchema>;
export type DbReplicationStatus = z.infer<typeof dbReplicationStatusSchema>;
export type StorageAccessMode = z.infer<typeof storageAccessModeSchema>;
export type StorageBucketSummary = z.infer<typeof storageBucketSummarySchema>;
export type StorageBucketInfo = z.infer<typeof storageBucketSchema>;
export type StorageObjectInfo = z.infer<typeof storageObjectSchema>;
export type StorageObjectPage = z.infer<typeof storageObjectPageSchema>;
export type StorageOverview = z.infer<typeof storageOverviewSchema>;
