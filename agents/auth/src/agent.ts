import { Agent, type AgentContext } from 'agents';
import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as Sentry from '@sentry/cloudflare';
import migrations from './migrations.js';
import {
	createProjectAuth,
	ensureConsoleAdmin,
	ensurePersonalOrg,
	type AuthDatabase,
	type AuthEmailMessage,
	type ProjectAuth,
} from './auth.js';
import * as schema from './db/schema.js';
import {
	analyticsApiResponseSchema,
	authPolicySchema,
	chatRequestSchema,
	createUserRequestSchema,
	DEMO_PROJECT_PATTERN,
	demoTtlHoursSchema,
	localResetPasswordSchema,
	projectIdSchema,
	resourceIdSchema,
	roleRequestSchema,
	rolesRequestSchema,
	sessionActivityResponseSchema,
	setPasswordRequestSchema,
	settingsRequestSchema,
	socialCredentialsSchema,
	timeZoneSchema,
	updateUserRequestSchema,
	workersAiResponseSchema,
	type AuthPolicy,
	type ProviderUpdates,
	type SocialCredentials,
} from './schemas.js';

const MAX_EVENTS = 50;
/**
 * Users and sessions page KEYSET-style over `(createdAt, id)` in descending
 * order, never by offset: sign-ups and sign-ins land while an operator is
 * paging, and an offset would silently skip or repeat rows. The cursor is
 * opaque on the wire so the ordering can change without a client change.
 */
const LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 200;

/** `(createdAt, id)` of the last row on a page, base64url so it survives a
 * query string untouched. */
function encodeListCursor(createdAt: Date, id: string): string {
	const raw = JSON.stringify([createdAt.getTime(), id]);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Undecodable cursors are treated as absent - a mangled continuation should
 * restart the list, never 500 an operator surface. */
function decodeListCursor(raw: string | null): { createdAt: Date; id: string } | null {
	if (!raw) return null;
	try {
		const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
		const parsed: unknown = JSON.parse(atob(padded));
		if (!Array.isArray(parsed)) return null;
		const [at, id] = parsed as unknown[];
		if (typeof at !== 'number' || !Number.isFinite(at) || typeof id !== 'string') return null;
		return { createdAt: new Date(at), id };
	} catch {
		return null;
	}
}

function listPageSize(url: URL): number {
	const raw = Number(url.searchParams.get('limit'));
	if (!Number.isFinite(raw) || raw < 1) return LIST_PAGE_SIZE;
	return Math.min(Math.floor(raw), MAX_LIST_PAGE_SIZE);
}

/**
 * Escapes text interpolated into outbound mail. Organization names, inviter
 * addresses, and reset URLs all end up inside an HTML body sent from the
 * deployment's verified sender to an address the requester chose - markup
 * that survives is a phishing link wearing our envelope. Attribute-safe as
 * well as text-safe, since the URL lands in an `href`.
 */
function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/**
 * Collapses the line breaks a header injection needs. The Email Service
 * takes structured fields rather than raw headers, so this is a second lock
 * on a door that should already be shut.
 */
function headerSafe(value: string): string {
	return value.replaceAll(/[\r\n]+/g, ' ').trim();
}

/**
 * Reserved project id for the dashboard's own operator auth - Frostbase
 * authenticating its console with the same stack it sells. Mirrored in the
 * app's src/lib/server/console.ts; keep both in sync.
 */
const CONSOLE_PROJECT_ID = 'console';

/**
 * Ceilings that apply only to throwaway demo projects on the public
 * deployment. They exist because the demo is an open, unauthenticated door:
 * without them it is a free anonymous auth backend and a free Workers AI
 * proxy, both billed to whoever runs the demo. Self-hosted installs never see
 * them - DEMO_MODE is unset by default.
 */
const DEMO_MAX_USERS = 50;
const DEMO_MAX_CHAT_PER_DAY = 50;
// Analytics Engine ingestion is asynchronous. Keep this short so a query that
// races a new write is retried quickly instead of holding stale graph data.
const ANALYTICS_CACHE_MS = 5_000;

/** Env vars are strings; anything that is not a whole positive number means
 * "not configured" rather than a hard error, so a typo falls back safely. */
function parsePositiveInt(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function applySocialCredentials(
	value: ProviderUpdates,
	existing: SocialCredentials,
): SocialCredentials {
	const credentials: SocialCredentials = {};
	for (const provider of ['google', 'github'] as const) {
		const entry = value[provider];
		if (!entry) continue;
		if ('preserve' in entry) {
			if (!existing[provider]) continue;
			credentials[provider] = existing[provider];
			continue;
		}
		credentials[provider] = entry;
	}
	return credentials;
}

export interface AuthActivityEvent {
	id: string;
	type:
		| 'project.provisioned'
		| 'user.created'
		| 'user.deleted'
		| 'user.role-changed'
		| 'session.created'
		| 'session.revoked';
	message: string;
	at: string;
}

/** An assignable RBAC role and the permission keys it grants. */
export interface RoleDefinition {
	name: string;
	permissions: string[];
}

/** Synced in realtime to every dashboard connected to this agent. */
export interface AuthAgentState {
	projectId: string;
	provisionedAt: string | null;
	/** Role registry; always contains the built-in `user` and `admin`. */
	roles: RoleDefinition[];
	allowedOrigins: string[];
	enabledSocialProviders: string[];
	/** EFFECTIVE per-project auth policy - what the agent will actually do,
	 * not what was stored (verification needs a configured sender). */
	authPolicy: AuthPolicy;
	users: number;
	activeSessions: number;
	totalEvents: number;
	lastEventAt: string | null;
	events: AuthActivityEvent[];
}

export interface OverviewUser {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	isAnonymous: boolean;
	role: string;
	providers: string[];
	createdAt: string;
}

export interface OverviewSession {
	id: string;
	userId: string;
	email: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	country: string | null;
	createdAt: string;
	expiresAt: string;
}

export interface AuthOverview {
	projectId: string;
	users: OverviewUser[];
	/** Continuation for `GET /admin/users`; absent when this is the last page. */
	usersNextCursor?: string;
	sessions: OverviewSession[];
	/** Continuation for `GET /admin/sessions`; absent on the last page. */
	sessionsNextCursor?: string;
	state: AuthAgentState;
}

/** One org the console user belongs to, with their role in it. */
export interface ConsoleOrgMembership {
	id: string;
	name: string;
	slug: string;
	role: string;
}

export interface ConsolePendingInvitation {
	id: string;
	organizationId: string;
	organizationName: string;
	role: string | null;
	inviterEmail: string | null;
	expiresAt: string;
}

/**
 * GET /console/me - the console guard's one-round-trip identity: session plus
 * org memberships, joined locally in the DO so the dashboard never pays two
 * RPCs per request. Console instance only. Mirrored in the app's
 * src/lib/console.ts; keep both in sync.
 */
export interface ConsoleMe {
	user: {
		id: string;
		email: string;
		name: string;
		role: string;
		emailVerified: boolean;
		image: string | null;
	};
	session: { activeOrganizationId: string | null };
	organizations: ConsoleOrgMembership[];
	pendingInvitations: ConsolePendingInvitation[];
}

export interface UserPage {
	users: OverviewUser[];
	nextCursor?: string;
}

export interface SessionPage {
	sessions: OverviewSession[];
	nextCursor?: string;
}

export interface AuthAnalytics {
	projectId: string;
	dau: number;
	wau: number;
	mau: number;
	totalUsers: number;
	registeredUsers: number;
	anonymousUsers: number;
	gmailUsers: number;
	activeSessions: number;
	providers: { provider: string; users: number }[];
	countries: { country: string; sessions: number }[];
	activityByDay: { day: string; signups: number; signins: number }[];
	/** Workers Analytics Engine metrics pipeline. */
	engine: {
		dataset: string;
		enabled: boolean;
		status: 'connected' | 'local' | 'write-only' | 'error';
		error?: string;
	};
	/** Event counts from the Analytics Engine SQL API - only when enabled. */
	eventsLast24h?: { eventType: string; count: number }[];
}

export interface AgentChatReply {
	question: string;
	topic: 'ai-analysis';
	answer: string;
	mode: 'workers-ai';
	model: string;
	userMessage: AgentChatMessage;
	agentMessage: AgentChatMessage;
}

export interface AgentChatMessage {
	id: string;
	role: 'user' | 'agent';
	content: string;
	createdAt: string;
}

interface BehavioralAnalytics {
	dau: number;
	wau: number;
	mau: number;
	gmailUsers: number;
	providers: { provider: string; users: number }[];
	countries: { country: string; sessions: number }[];
	activityByDay: { day: string; signups: number; signins: number }[];
	eventsLast24h?: { eventType: string; count: number }[];
}

const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * One AuthAgent per Frostbase project. The agent is a SQLite-backed
 * Durable Object that runs a full Better Auth stack for the project - users,
 * sessions, accounts and verifications all live in the agent's own database
 * (via Drizzle ORM) - pushes live auth activity to connected dashboards
 * through the Agents SDK state sync, and answers analytics questions about
 * its own data (/analytics, /chat).
 *
 * Addressed as /agents/auth-agent/<projectId>/...
 */
/** The role the console's own surfaces are gated on (src/hooks.server.ts). */
const ADMIN_ROLE = 'admin';

const DEFAULT_ROLES: RoleDefinition[] = [
	{ name: 'user', permissions: [] },
	{ name: ADMIN_ROLE, permissions: ['*'] },
];

export class AuthAgent extends Agent<Env, AuthAgentState> {
	initialState: AuthAgentState = {
		projectId: '',
		provisionedAt: null,
		roles: DEFAULT_ROLES,
		allowedOrigins: [],
		enabledSocialProviders: [],
		authPolicy: { allowAnonymous: true, requireEmailVerification: false },
		users: 0,
		activeSessions: 0,
		totalEvents: 0,
		lastEventAt: null,
		events: [],
	};

	db: AuthDatabase;
	private _auth: ProjectAuth | null = null;
	private behavioralCache: {
		expiresAt: number;
		timeZone: string;
		data: BehavioralAnalytics;
	} | null = null;
	/** Country Cloudflare resolved for the request currently being handled. */
	private requestCountry: string | null = null;
	/** Resolved in onStart: the env secret, or one generated for this project. */
	private signingSecret: string | null = null;
	private socialCredentials: SocialCredentials = {};
	/** Per-project auth policy; defaults preserve pre-policy behaviour. */
	private authPolicy: AuthPolicy = authPolicySchema.parse({});

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	private get auth(): ProjectAuth {
		const secret = this.signingSecret;
		if (!secret) {
			throw new Error('the signing secret is unavailable - onStart() has not run');
		}
		this._auth ??= createProjectAuth({
			projectId: this.name,
			db: this.db,
			secret,
			trustedOrigins: this.trustedOrigins,
			disableRateLimit: this.env.DISABLE_RATE_LIMIT === 'true',
			getRequestCountry: () => this.requestCountry,
			getRolePermissions: (role) =>
				(this.state.roles ?? DEFAULT_ROLES).find((entry) => entry.name === role)?.permissions ?? [],
			google: this.socialCredentials.google ?? this.envSocialCredentials('GOOGLE'),
			github: this.socialCredentials.github ?? this.envSocialCredentials('GITHUB'),
			// Demo projects never send mail: the addresses are strangers' and the
			// sending domain's reputation is not worth a throwaway signup flow.
			sendEmail:
				this.mailConfigured && !this.isEphemeral
					? (message) => this.sendAuthEmail(message)
					: undefined,
			// Open console sign-ups are only real with a sender that can reach
			// arbitrary addresses; the console gets the cookie cache and personal
			// orgs so operator polling and ownership work out of the box.
			// DISABLE_EMAIL_VERIFICATION is the env.local escape: wrangler dev
			// writes mail to .eml files, so requiring verification would dead-end
			// every local sign-up behind a file hunt.
			// A project's own policy decides for every other instance (Firebase
			// and Supabase both let a developer require a verified address; this
			// agent had no switch at all, so a stranger's address was always good
			// enough for an authenticated token). Effective, not raw: without a
			// sender that can reach arbitrary addresses, requiring verification
			// would lock every new user out of an app that cannot mail them.
			requireEmailVerification:
				this.name === CONSOLE_PROJECT_ID
					? this.consoleSignups === 'open' && this.env.DISABLE_EMAIL_VERIFICATION !== 'true'
					: this.emailVerificationRequired,
			cookieCache: this.name === CONSOLE_PROJECT_ID,
			// Operators live in this console for weeks at a time; a 7-day idle
			// expiry made them re-authenticate constantly for no security gain.
			sessionDays: this.name === CONSOLE_PROJECT_ID ? 30 : undefined,
			autoPersonalOrg: this.name === CONSOLE_PROJECT_ID,
			// Org creation is capped per user (memberships count, personal org
			// included) so one account cannot mint teams without bound - the
			// console's per-org project ceiling would otherwise multiply freely.
			orgLimit: parsePositiveInt(this.env.MAX_ORGS_PER_USER) ?? 5,
			// Console registration policy, enforced where every path converges -
			// user creation - because social sign-in creates users implicitly on
			// the OAuth callback. Without this, configuring Google credentials
			// would quietly reopen console registration to anyone with a Google
			// account. CONSOLE_SIGNUPS=open lifts the veto entirely (managed
			// mode); claimed mode admits the first-run owner and, since Phase A,
			// anyone whose email holds a pending org invitation - teams without
			// open registration.
			denyUserCreation:
				this.name === CONSOLE_PROJECT_ID
					? async (user) => {
							if (this.consoleSignups === 'open') return null;
							if (this.env.CONSOLE_SIGNUPS === 'open') {
								// Configured open but no usable sender: a loud config error
								// beats silently registering users who can never verify.
								return 'CONSOLE_SIGNUPS=open requires outbound mail - configure the EMAIL binding and EMAIL_FROM';
							}
							if (user.email && (await this.hasPendingInvitation(user.email))) return null;
							if (this.env.DEMO_MODE === 'true') {
								return 'this deployment does not have console operators';
							}
							const [row] = await this.db.select({ value: count() }).from(schema.user);
							return (row?.value ?? 0) > 0 ? 'this console already has an owner' : null;
						}
					: undefined,
			onUserCreated: async (user) => {
				// The account that claims a deployment IS its administrator, and it
				// becomes one HERE rather than on its first console request: the
				// role gates the console's own surfaces, so leaving it to a later
				// heal means a first operator who is briefly not an admin of the
				// install they just claimed. Still a no-op once one exists.
				if (this.name === CONSOLE_PROJECT_ID) await ensureConsoleAdmin(this.db);
				this.writeAuthEvent('user.created', {
					provider: user.isAnonymous ? 'anonymous' : 'credential',
					subjectId: user.id,
					emailDomain: user.email.split('@')[1]?.toLowerCase() ?? 'none',
				});
				await this.recordEvent(
					'user.created',
					user.isAnonymous ? 'guest user created' : 'registered user created',
				);
			},
			onSessionActivity: async (session, kind) => {
				await this.trackSessionActivity(session.userId, session.id, `session.${kind}`);
				if (kind === 'created') {
					await this.recordEvent('session.created', 'new session started');
				}
			},
		});
		return this._auth;
	}

	/**
	 * Where this project's Better Auth is mounted: the public proxy path,
	 * mirrored in createProjectAuth's basePath. Ingress still dispatches on the
	 * agent-internal /api/auth prefix and is rewritten to this base before the
	 * handler runs, so the URLs Better Auth derives from it (email links, OAuth
	 * redirect URIs) point at routes the dashboard serves unauthenticated.
	 */
	private get authBasePath(): string {
		return `/api/projects/${this.name}/auth`;
	}

	/**
	 * Whether this project is a throwaway demo instance. Both halves matter: a
	 * self-hosted install must never expire a project just because someone
	 * named it `demo-...`, and the public deployment must never expire a named
	 * one.
	 */
	private get isEphemeral(): boolean {
		return this.env.DEMO_MODE === 'true' && DEMO_PROJECT_PATTERN.test(this.name);
	}

	/** Cloudflare Email Service: the EMAIL binding delivers transactional mail
	 * to arbitrary recipients from the configured sender. */
	private get mailConfigured(): boolean {
		return !!(this.env.EMAIL && this.env.EMAIL_FROM);
	}

	/**
	 * Console registration policy. `open` only
	 * counts when the mail sender is configured - without one, verification
	 * mail cannot leave, so the console stays effectively claimed and the
	 * sign-up paths answer a loud config error instead of registering users
	 * who could never verify.
	 */
	private get consoleSignups(): 'claimed' | 'open' {
		return this.env.CONSOLE_SIGNUPS === 'open' && this.mailConfigured ? 'open' : 'claimed';
	}

	/**
	 * EFFECTIVE email-verification requirement for a project instance. Asking
	 * for it without a sender that can reach arbitrary addresses would lock
	 * every new user out of an app that cannot mail them, so the stored
	 * preference only counts while mail is configured - the same
	 * effective-not-raw rule `consoleSignups` follows, and `/config` reports
	 * this value rather than the stored one.
	 */
	private get emailVerificationRequired(): boolean {
		return this.authPolicy.requireEmailVerification && this.mailConfigured;
	}

	/**
	 * Whether this project issues guest sessions. Demo projects always do -
	 * the public demo IS anonymous - and the console never does.
	 */
	private get anonymousAllowed(): boolean {
		if (this.name === CONSOLE_PROJECT_ID) return false;
		if (this.isEphemeral) return true;
		return this.authPolicy.allowAnonymous;
	}

	/** The policy as it will actually behave - what state and /config report. */
	private get effectiveAuthPolicy(): AuthPolicy {
		return {
			allowAnonymous: this.anonymousAllowed,
			requireEmailVerification: this.emailVerificationRequired,
		};
	}

	/** A pending, unexpired org invitation for this email - the authorization
	 * that lets a sign-up through a claimed console. */
	private async hasPendingInvitation(email: string): Promise<boolean> {
		const [row] = await this.db
			.select({ id: schema.invitation.id })
			.from(schema.invitation)
			.where(
				and(
					eq(sql`lower(${schema.invitation.email})`, email.toLowerCase()),
					eq(schema.invitation.status, 'pending'),
					gt(schema.invitation.expiresAt, new Date()),
				),
			)
			.limit(1);
		return !!row;
	}

	private get trustedOrigins(): string[] {
		return [
			...(this.env.TRUSTED_ORIGINS ?? '')
				.split(',')
				.map((origin) => origin.trim())
				.filter(Boolean),
			...(this.state.allowedOrigins ?? []),
		];
	}

	private corsHeaders(request: Request): Headers | null {
		const origin = request.headers.get('origin');
		// Same-origin is always acceptable - it matches the trust rule in
		// auth.ts, where a deployment trusts its own origin automatically.
		const sameOrigin = origin === new URL(request.url).origin;
		if (!origin || (!sameOrigin && !this.trustedOrigins.includes(origin))) return null;
		return new Headers({
			'access-control-allow-origin': origin,
			'access-control-allow-credentials': 'true',
			'access-control-allow-methods': 'GET, POST, OPTIONS',
			'access-control-allow-headers': 'authorization, content-type',
			'access-control-expose-headers': 'set-auth-token',
			vary: 'Origin',
		});
	}

	/**
	 * Resolves the secret Better Auth signs sessions and tokens with.
	 *
	 * BETTER_AUTH_SECRET wins when set, so an operator can supply and rotate
	 * one deliberately. Otherwise the project generates its own on first start
	 * and keeps it in its Durable Object storage, next to the password hashes
	 * it already holds - which means a fresh install needs no secret set by
	 * hand before it works, and each project ends up signing with a key no
	 * other project shares.
	 *
	 * Losing it invalidates that project's sessions and nothing else. Erasing
	 * the project drops it along with everything else it was protecting.
	 */
	private async resolveSigningSecret(): Promise<string> {
		const configured = this.env.BETTER_AUTH_SECRET?.trim();
		if (configured) return configured;

		const stored = await this.ctx.storage.get<string>('signing-secret');
		if (stored) return stored;

		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const generated = btoa(String.fromCharCode(...bytes));
		await this.ctx.storage.put('signing-secret', generated);
		return generated;
	}

	async onStart(): Promise<void> {
		this.signingSecret = await this.resolveSigningSecret();

		// Idempotent - drizzle tracks applied migrations in its own table.
		await migrate(this.db, migrations);
		if (this.env.LOCAL_ANALYTICS) {
			await this.env.LOCAL_ANALYTICS.batch([
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, timestamp INTEGER NOT NULL, event_type TEXT NOT NULL, country TEXT NOT NULL, provider TEXT NOT NULL, subject_id TEXT NOT NULL, session_id TEXT NOT NULL, email_domain TEXT NOT NULL)`,
				),
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE INDEX IF NOT EXISTS auth_events_project_time ON auth_events(project_id, timestamp)`,
				),
			]);
		}
		this.socialCredentials = socialCredentialsSchema.parse(
			await this.ctx.storage.get('social-provider-credentials'),
		);
		// A stored policy that no longer parses degrades to the defaults rather
		// than failing the wake - the defaults are what the project had before
		// the policy existed, so a bad row is never a lockout.
		this.authPolicy = authPolicySchema
			.catch(authPolicySchema.parse({}))
			.parse((await this.ctx.storage.get('auth-policy')) ?? {});

		const rolesValid =
			Array.isArray(this.state.roles) &&
			this.state.roles.every(
				(entry) => entry && typeof entry === 'object' && typeof entry.name === 'string',
			);
		if (!this.state.projectId) {
			this.setState({
				...this.state,
				projectId: this.name,
				provisionedAt: new Date().toISOString(),
				roles: DEFAULT_ROLES,
				allowedOrigins: [],
				enabledSocialProviders: this.configuredSocialProviders,
				authPolicy: this.effectiveAuthPolicy,
			});
			this.writeAuthEvent('project.provisioned');
			await this.recordEvent('project.provisioned', `auth provisioned for project "${this.name}"`);
		} else if (
			!Array.isArray(this.state.allowedOrigins) ||
			!Array.isArray(this.state.enabledSocialProviders) ||
			!this.state.authPolicy ||
			!rolesValid
		) {
			// State schema upgrade for agents provisioned before origin/role settings.
			this.setState({
				...this.state,
				roles: rolesValid ? this.state.roles : DEFAULT_ROLES,
				allowedOrigins: this.state.allowedOrigins ?? [],
				enabledSocialProviders: this.configuredSocialProviders,
				authPolicy: this.effectiveAuthPolicy,
			});
		}

		if (this.isEphemeral) {
			// idempotent so repeated wakes reuse the existing row instead of
			// stacking new ones - which also means the deadline runs from first
			// provision rather than from the visitor's last page load.
			const hours = demoTtlHoursSchema.parse(this.env.DEMO_TTL_HOURS);
			await this.schedule(hours * 3600, 'expireDemoProject', undefined, { idempotent: true });
		}
	}

	/**
	 * Scheduled callback that erases an expired demo project. Without it every
	 * visitor to the public demo would leave behind a Durable Object that lives
	 * forever, so a launch-day traffic spike becomes a permanent bill.
	 *
	 * Re-checks isEphemeral because the schedule outlives config: if DEMO_MODE
	 * is ever turned off, pending timers must not delete real projects.
	 */
	async expireDemoProject(): Promise<void> {
		if (!this.isEphemeral) return;
		await this.destroy();
	}

	/**
	 * Environment OAuth credentials configure the CONSOLE's social sign-in and
	 * nothing else. They are deployment-level secrets, and the redirect URI
	 * Better Auth derives is per project - one registered OAuth app can only
	 * ever answer one project's callback, so spreading the env credentials
	 * across every project (demos included) would advertise sign-in buttons
	 * whose callbacks the provider refuses. Customer projects configure their
	 * own apps per project via PUT /admin/settings.
	 */
	private envSocialCredentials(
		provider: 'GOOGLE' | 'GITHUB',
	): { clientId: string; clientSecret: string } | undefined {
		if (this.name !== CONSOLE_PROJECT_ID) return undefined;
		const clientId = this.env[`${provider}_CLIENT_ID`];
		const clientSecret = this.env[`${provider}_CLIENT_SECRET`];
		return clientId && clientSecret ? { clientId, clientSecret } : undefined;
	}

	private get configuredSocialProviders(): string[] {
		return [
			...(this.socialCredentials.google || this.envSocialCredentials('GOOGLE') ? ['google'] : []),
			...(this.socialCredentials.github || this.envSocialCredentials('GITHUB') ? ['github'] : []),
		];
	}

	/**
	 * Streams one data point per auth event to Workers Analytics Engine.
	 * Indexed by project id (fair per-project sampling); blob order is part of
	 * the dataset schema - keep it stable and documented below.
	 * Writes are fire-and-forget and must never break auth.
	 */
	private writeAuthEvent(
		eventType: string,
		fields: {
			country?: string | null;
			provider?: string | null;
			subjectId?: string | null;
			sessionId?: string | null;
			emailDomain?: string | null;
		} = {},
	): void {
		// A new event can change every behavioral card. Avoid serving a stale
		// country/provider snapshot after an authentication mutation.
		this.behavioralCache = null;
		try {
			this.env.AUTH_EVENTS?.writeDataPoint({
				indexes: [this.name],
				// Schema: event, country, provider, subject, session, email domain.
				blobs: [
					eventType,
					fields.country ?? 'unknown',
					fields.provider ?? 'none',
					fields.subjectId ?? 'none',
					fields.sessionId ?? 'none',
					fields.emailDomain ?? 'none',
				],
				doubles: [1],
			});
		} catch {
			// metrics failure is never allowed to fail the auth request
		}
		if (!this.waeConfig && this.env.LOCAL_ANALYTICS) {
			this.ctx.waitUntil(
				this.env.LOCAL_ANALYTICS.prepare(
					`INSERT INTO auth_events (project_id, timestamp, event_type, country, provider, subject_id, session_id, email_domain) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
					.bind(
						this.name,
						Date.now(),
						eventType,
						fields.country ?? 'unknown',
						fields.provider ?? 'none',
						fields.subjectId ?? 'none',
						fields.sessionId ?? 'none',
						fields.emailDomain ?? 'none',
					)
					.run(),
			);
		}
	}

	private get waeConfig(): { accountId: string; token: string; dataset: string } | null {
		const accountId = this.env.CF_ACCOUNT_ID;
		const token = this.env.CF_ANALYTICS_API_TOKEN;
		const dataset = this.env.WAE_DATASET;
		return accountId && token && dataset ? { accountId, token, dataset } : null;
	}

	private async sendAuthEmail(message: AuthEmailMessage): Promise<void> {
		const action =
			message.type === 'password-reset'
				? 'Reset your password'
				: message.type === 'email-change'
					? 'Approve your new email'
					: message.type === 'invitation'
						? `Join ${message.invitation?.organization ?? 'an organization'}`
						: 'Verify your email';
		const intro =
			message.type === 'invitation'
				? `${message.invitation?.inviter ?? 'A team member'} invited you to "${message.invitation?.organization ?? 'their organization'}" on Frostbase. Open the link, then sign in - or create an account with this email address - to accept. The link is what accepts the invitation, so do not forward it.`
				: 'Continue securely with the button below.';
		const text = `${action}: ${message.url}\n\n${intro}\n\nIf you did not request this, you can ignore this email.`;
		// EVERY interpolation is escaped, not just the URL. An organization name
		// is free text its creator chose, it reaches `action` (the heading AND
		// the subject) and `intro`, and invitations go to any address the
		// inviter types - so an unescaped name is an anchor of the attacker's
		// choosing inside a mail our own verified sender delivers. The plain
		// text part needs no escaping; the subject is stripped of the line
		// breaks a header injection would need.
		const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto"><h1 style="font-size:22px">${escapeHtml(action)}</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(message.url)}" style="display:inline-block;background:#2f8fe0;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">${escapeHtml(action)}</a></p><p style="color:#666;font-size:13px">If you did not request this, you can ignore this email.</p></div>`;

		try {
			await this.deliverEmail(message.to, headerSafe(`${action} · Frostbase`), text, html);
		} catch (error) {
			// Verification mail is best-effort by design: the user row already
			// exists when the send runs, so failing the sign-up here would tell
			// the visitor "error" about an account that was in fact created. A
			// failed unverified sign-in re-sends the link. Resets and invitations
			// stay loud - their callers surface the failure to someone who can
			// retry.
			Sentry.captureException(error, {
				level: 'error',
				tags: { projectId: this.name, operation: 'send-auth-email', emailType: message.type },
			});
			if (message.type !== 'email-verification') throw error;
		}
	}

	/** Outbound transport: Cloudflare Email Service via the EMAIL binding. */
	private async deliverEmail(
		to: string,
		subject: string,
		text: string,
		html: string,
	): Promise<void> {
		if (this.env.EMAIL && this.env.EMAIL_FROM) {
			await this.env.EMAIL.send({
				to,
				from: { email: this.env.EMAIL_FROM, name: 'Frostbase Auth' },
				subject,
				text,
				html,
			});
			this.writeAuthEvent('email.sent', { provider: 'cloudflare-email-service' });
			return;
		}
		throw new Error('no outbound mail transport is configured');
	}

	private async trackSessionActivity(
		userId: string,
		sessionId: string,
		sessionEvent?: string,
	): Promise<void> {
		const [account] = await this.db
			.select({ provider: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, userId))
			.limit(1);
		const dimensions = {
			country: this.requestCountry,
			provider: account?.provider ?? 'anonymous',
			subjectId: userId,
			sessionId,
		};
		if (sessionEvent) this.writeAuthEvent(sessionEvent, dimensions);
		this.writeAuthEvent('user.active', dimensions);
	}

	/** Current user count, used for the demo ceiling. */
	private async userCount(): Promise<number> {
		const [row] = await this.db.select({ value: count() }).from(schema.user);
		return row?.value ?? 0;
	}

	/**
	 * Caps identity creation on demo projects. Anonymous sign-in is the cheapest
	 * way to fill someone else's database, so it counts against the same
	 * ceiling as registration.
	 */
	private async denyDemoAuthRoute(subPath: string): Promise<Response | null> {
		if (!/\/sign-up\/email$|\/sign-in\/anonymous$/.test(subPath)) return null;

		if ((await this.userCount()) >= DEMO_MAX_USERS) {
			return Response.json(
				{
					error: `this demo project is limited to ${DEMO_MAX_USERS} users - deploy your own instance for unlimited projects`,
				},
				{ status: 429 },
			);
		}

		return null;
	}

	/**
	 * Daily ceiling on demo inference. /chat is the only route that spends
	 * Workers AI neurons, it needs no authentication, and neurons are an
	 * account-level quota - so one demo visitor could otherwise starve every
	 * other project on the deployment.
	 */
	private async denyDemoChat(): Promise<Response | null> {
		const today = new Date().toISOString().slice(0, 10);
		const usage = (await this.ctx.storage.get<{ day: string; count: number }>(
			'demo-chat-usage',
		)) ?? {
			day: today,
			count: 0,
		};
		const count = usage.day === today ? usage.count : 0;

		if (count >= DEMO_MAX_CHAT_PER_DAY) {
			return Response.json(
				{ error: 'this demo project has reached its daily AI limit - it resets tomorrow' },
				{ status: 429 },
			);
		}

		await this.ctx.storage.put('demo-chat-usage', { day: today, count: count + 1 });
		return null;
	}

	/**
	 * Extra rules that apply only to the console's own auth instance. Returns a
	 * rejection response, or null when the route is permitted. The
	 * denyUserCreation database hook enforces the same policy where every
	 * user-creating path converges; this route check exists to answer the
	 * login page with precise errors before Better Auth runs.
	 */
	private async denyConsoleAuthRoute(subPath: string, request: Request): Promise<Response | null> {
		if (/\/sign-in\/anonymous$/.test(subPath)) {
			return Response.json({ error: 'guest sign-in is disabled for the console' }, { status: 403 });
		}

		if (/\/sign-up\/email$/.test(subPath)) {
			if (this.consoleSignups === 'open') return null;

			if (this.env.CONSOLE_SIGNUPS === 'open') {
				// Open was configured but no arbitrary-recipient sender exists.
				// Refusing loudly here is what turns a silent failure into a
				// config error at deploy time (the worker's 5xx net reports it).
				return Response.json(
					{
						error:
							'CONSOLE_SIGNUPS=open requires outbound mail - configure the EMAIL binding and EMAIL_FROM',
					},
					{ status: 503 },
				);
			}

			// Claimed mode. A pending org invitation authorizes a sign-up even
			// while the console is otherwise closed - teams without opening
			// registration. Checked before the demo refusal on purpose: a
			// claimed-but-DEMO_MODE deployment (frostbase.dev today) can
			// invite teammates.
			const email = await this.signUpEmail(request);
			if (email && (await this.hasPendingInvitation(email))) return null;

			// A demo deployment has no operators. Every visitor is anonymous with
			// a throwaway project, and named projects - the only thing an operator
			// session unlocks - are not part of it. Leaving the claim open would
			// just let a stranger take ownership of a console nobody is meant to
			// use, since the claim is otherwise first-come and the endpoint has to
			// stay public for the login page to reach it.
			if (this.env.DEMO_MODE === 'true') {
				return Response.json(
					{ error: 'this deployment does not have console operators' },
					{ status: 403 },
				);
			}

			const [row] = await this.db.select({ value: count() }).from(schema.user);
			if ((row?.value ?? 0) > 0) {
				return Response.json({ error: 'this console already has an owner' }, { status: 403 });
			}
		}

		return null;
	}

	/** The email a sign-up request is registering, from a clone so Better Auth
	 * still gets the body. Unparsable bodies fall through to Better Auth's own
	 * validation. */
	private async signUpEmail(request: Request): Promise<string | null> {
		const body = (await request
			.clone()
			.json()
			.catch(() => null)) as { email?: unknown } | null;
		return typeof body?.email === 'string' && body.email ? body.email : null;
	}

	async onRequest(request: Request): Promise<Response> {
		try {
			return await this.routeRequest(request);
		} catch (error) {
			// The Agents SDK's own _tryCatch converts handler exceptions into a
			// bare 500 BEFORE Sentry's DO instrumentation (which only sees
			// uncaught errors) gets a look - capture the real stack first, then
			// let the SDK answer. A no-op without a DSN, so consumers unaffected.
			Sentry.captureException(error);
			throw error;
		}
	}

	private async routeRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!projectIdSchema.safeParse(this.name).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400 });
		}
		// Requests arrive with the full /agents/auth-agent/<name>/... path.
		const subPath = url.pathname.match(/\/agents\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? '/';

		if (subPath === '/overview') {
			return Response.json(await this.getOverview());
		}

		if (subPath === '/analytics') {
			const requestedTimeZone = url.searchParams.get('timeZone') ?? 'Etc/UTC';
			const timeZone = timeZoneSchema.safeParse(requestedTimeZone);
			if (!timeZone.success) {
				return Response.json({ error: 'invalid timeZone' }, { status: 400 });
			}
			return Response.json(await this.getAnalytics(timeZone.data));
		}

		if (subPath === '/config' && request.method === 'GET') {
			return Response.json({
				projectId: this.name,
				providers: [
					'email-password',
					...(this.anonymousAllowed ? (['anonymous'] as const) : []),
					...this.configuredSocialProviders,
				],
				// EFFECTIVE policy, so a client is never told a project requires
				// verification it cannot actually send (see the getters).
				authPolicy: this.effectiveAuthPolicy,
				availableSocialProviders: ['google', 'github'],
				bearerTokens: true,
				emailDeliveryConfigured: this.mailConfigured,
				// Local dev only (DISABLE_EMAIL_VERIFICATION): the login page offers
				// the direct reset form instead of the emailed-token flow, because
				// the reset mail only lands in wrangler's .eml files locally.
				localPasswordReset: this.env.DISABLE_EMAIL_VERIFICATION === 'true',
				// The console instance reports its registration policy so /login
				// can render sign-up affordances honestly. Effective, not raw:
				// a misconfigured `open` reports claimed rather than offering a
				// doomed form.
				...(this.name === CONSOLE_PROJECT_ID ? { consoleSignups: this.consoleSignups } : {}),
			});
		}

		if (subPath === '/console/me' && request.method === 'GET' && this.name === CONSOLE_PROJECT_ID) {
			return this.getConsoleMe(request);
		}

		if (subPath === '/chat' && request.method === 'GET') {
			const clientKey = await this.chatClientKey(request);
			return Response.json({ messages: await this.getChatMessages(clientKey) });
		}

		if (subPath === '/chat' && request.method === 'POST') {
			const body = chatRequestSchema.safeParse(await request.json().catch(() => null));
			if (!body.success) {
				return Response.json({ error: 'question is required' }, { status: 400 });
			}
			if (this.isEphemeral) {
				const denied = await this.denyDemoChat();
				if (denied) return denied;
			}
			const clientKey = await this.chatClientKey(request);
			try {
				return Response.json(await this.answerQuestion(body.data.question, clientKey));
			} catch (error) {
				console.error('AuthAgent AI request failed', error);
				return Response.json(
					{ error: 'Workers AI could not answer this request' },
					{ status: 502 },
				);
			}
		}

		if (subPath === '/admin/users' && request.method === 'GET') {
			return Response.json(await this.listUsers(url.searchParams.get('cursor'), listPageSize(url)));
		}

		if (subPath === '/admin/sessions' && request.method === 'GET') {
			return Response.json(
				await this.listSessions(url.searchParams.get('cursor'), listPageSize(url)),
			);
		}

		// Admin user management. Until this landed
		// the surface could list, re-role, and delete - never create, read one,
		// or update one - so seeding accounts, migrating from another provider,
		// and provisioning a service account were all impossible from a server.
		if (subPath === '/admin/users' && request.method === 'POST') {
			return this.createUserAsAdmin(request);
		}

		const roleUpdate = subPath.match(/^\/admin\/users\/([^/]+)\/role$/);
		if (roleUpdate && request.method === 'PUT') {
			return this.setUserRole(this.decodeResourceId(roleUpdate[1]), request);
		}

		const passwordSet = subPath.match(/^\/admin\/users\/([^/]+)\/password$/);
		if (passwordSet && request.method === 'PUT') {
			return this.setUserPassword(this.decodeResourceId(passwordSet[1]), request);
		}

		const userRoute = subPath.match(/^\/admin\/users\/([^/]+)$/);
		if (userRoute) {
			const userId = this.decodeResourceId(userRoute[1]);
			if (request.method === 'GET') return this.getUserById(userId);
			if (request.method === 'PATCH') return this.updateUserAsAdmin(userId, request);
			if (request.method === 'DELETE') return this.deleteUser(userId);
		}

		const sessionDelete = subPath.match(/^\/admin\/sessions\/([^/]+)$/);
		if (sessionDelete && request.method === 'DELETE') {
			return this.revokeSession(this.decodeResourceId(sessionDelete[1]));
		}

		if (subPath === '/admin/roles' && request.method === 'PUT') {
			return this.updateRoles(request);
		}

		if (subPath === '/admin/settings' && request.method === 'PUT') {
			return this.updateSettings(request);
		}

		// Local-dev escape hatch: with DISABLE_EMAIL_VERIFICATION=true (env.local
		// only) a password resets directly by email, no token round trip - the
		// reset MAIL only lands in wrangler's .eml files locally, the same file
		// hunt the flag exists to spare. Gated hard: everywhere else this route
		// does not exist, because a token-less reset is account takeover.
		if (subPath === '/api/auth/local-reset-password' && request.method === 'POST') {
			if (this.env.DISABLE_EMAIL_VERIFICATION !== 'true') {
				return Response.json({ error: 'not found' }, { status: 404 });
			}
			const body = localResetPasswordSchema.safeParse(await request.json().catch(() => null));
			if (!body.success) {
				return Response.json(
					{ error: 'email and newPassword (8-128 characters) are required' },
					{ status: 400 },
				);
			}
			const ctx = await this.auth.$context;
			const found = await ctx.internalAdapter.findUserByEmail(body.data.email.toLowerCase());
			if (found) {
				// Shared with the operator route and admin creation - including the
				// social-only case, where the account GAINS a credential.
				await this.writePassword(found.user.id, body.data.newPassword, {
					revokeSessions: true,
				});
			}
			// Uniform answer - even local dev keeps account existence unguessable.
			return Response.json({ status: true });
		}

		// Better Auth's own list of "invitations addressed to my email" hands out
		// the ids that accept them to anyone holding the session's address -
		// unproven in claimed mode, where console sign-up skips verification.
		// The console never calls it; /console/me gates the same list on a
		// verified address or the invite link.
		if (
			this.name === CONSOLE_PROJECT_ID &&
			subPath === '/api/auth/organization/list-user-invitations'
		) {
			return Response.json({ error: 'not found' }, { status: 404 });
		}

		if (subPath === '/api/auth' || subPath.startsWith('/api/auth/')) {
			if (!this.signingSecret) {
				return Response.json({ error: 'auth agent failed to start' }, { status: 500 });
			}
			// The console's instance is not a customer project: it never hands out
			// guest sessions, and it accepts exactly one sign-up - the first-run
			// owner claim. Enforced here because /api/auth/* is deliberately public,
			// so the dashboard's console guard never sees these requests.
			if (this.name === CONSOLE_PROJECT_ID) {
				const denied = await this.denyConsoleAuthRoute(subPath, request);
				if (denied) return denied;
			}

			if (this.isEphemeral) {
				const denied = await this.denyDemoAuthRoute(subPath);
				if (denied) return denied;
			}

			// Guest sign-in is a PUBLIC route and a guest token satisfies the
			// `auth` access mode - the default for every new collection and
			// table. A project that never wanted guests therefore had its
			// signed-in-users-only data readable by anyone willing to ask for a
			// token first. Refused at the route rather than by dropping the
			// plugin, so the switch is reversible and `user.isAnonymous` keeps
			// its meaning for guests created while it was on.
			if (!this.anonymousAllowed && /\/sign-in\/anonymous$/.test(subPath)) {
				return Response.json(
					{ error: 'guest sign-in is disabled for this project' },
					{ status: 403 },
				);
			}

			const cors = this.corsHeaders(request);
			if (request.method === 'OPTIONS') {
				return cors
					? new Response(null, { status: 204, headers: cors })
					: Response.json({ error: 'origin is not trusted' }, { status: 403 });
			}
			this.requestCountry =
				(request.cf?.country as string | undefined) ?? request.headers.get('cf-ipcountry');
			// Better Auth sees the request at its basePath - the project's PUBLIC
			// proxy path - on the caller's origin, so cookies, redirect URLs, and
			// every absolute URL it generates (verification links, OAuth redirect
			// URIs) resolve to routes a browser can actually reach.
			const signingOut = /\/sign-out$/.test(subPath);
			const currentSession = signingOut
				? await this.auth.api.getSession({ headers: request.headers }).catch(() => null)
				: null;
			const authRequest = new Request(
				`${url.origin}${this.authBasePath}${subPath.slice('/api/auth'.length)}${url.search}`,
				request,
			);
			const response = await this.auth.handler(authRequest);

			// Sign-out deletes the session row without a database hook - refresh
			// counters after any mutation so connected dashboards stay accurate.
			if (response.ok && signingOut) {
				this.writeAuthEvent('session.revoked', {
					country: this.requestCountry,
					subjectId: currentSession?.user.id,
					sessionId: currentSession?.session.id,
				});
				await this.recordEvent('session.revoked', 'user signed out');
			} else if (response.ok && request.method === 'GET' && /\/get-session$/.test(subPath)) {
				const session = sessionActivityResponseSchema.safeParse(
					await response
						.clone()
						.json()
						.catch(() => null),
				);
				if (session.success && session.data) {
					await this.trackSessionActivity(session.data.user.id, session.data.session.id);
				}
			} else if (request.method !== 'GET') {
				await this.syncCounters();
			}
			if (!cors) return response;
			const headers = new Headers(response.headers);
			cors.forEach((value, key) => headers.set(key, value));
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private decodeResourceId(encoded: string): string {
		try {
			const parsed = resourceIdSchema.safeParse(decodeURIComponent(encoded));
			return parsed.success ? parsed.data : '';
		} catch {
			return '';
		}
	}

	/**
	 * One user in exactly the shape `listUsers` pages, so an admin READ and the
	 * admin LIST can never describe the same account differently.
	 */
	private async userDto(userId: string): Promise<OverviewUser | null> {
		const [row] = await this.db
			.select({
				id: schema.user.id,
				name: schema.user.name,
				email: schema.user.email,
				emailVerified: schema.user.emailVerified,
				isAnonymous: schema.user.isAnonymous,
				role: schema.user.role,
				createdAt: schema.user.createdAt,
			})
			.from(schema.user)
			.where(eq(schema.user.id, userId))
			.limit(1);
		if (!row) return null;

		const accounts = await this.db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, userId));
		return {
			...row,
			isAnonymous: !!row.isAnonymous,
			providers: accounts.length
				? accounts.map((account) => account.providerId)
				: row.isAnonymous
					? ['anonymous']
					: [],
			createdAt: row.createdAt.toISOString(),
		};
	}

	/**
	 * `POST /admin/users` - an account with no sign-up flow.
	 *
	 * Deliberately bypasses the project's sign-up MODE and email verification.
	 * That is the Admin-SDK contract (Firebase's createUser has the same shape,
	 * down to the explicit emailVerified flag), and it is what seeding, an
	 * invite-first product, and a migration off another provider all need - none
	 * of which the end-user sign-up route can serve, since it obeys the mode and
	 * starts a verification mail.
	 *
	 * What it does NOT bypass is the user-creation DATABASE hook, because that
	 * is where demo caps and the console's registration refusal live. Those are
	 * not sign-up policy - they are what keeps a throwaway project throwaway and
	 * an operator console closed - so they still apply, and the hook's own
	 * message is the useful answer.
	 */
	private async createUserAsAdmin(request: Request): Promise<Response> {
		const body = createUserRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid user', issues: body.error.issues }, { status: 400 });
		}

		const email = body.data.email.toLowerCase();
		const ctx = await this.auth.$context;
		if (await ctx.internalAdapter.findUserByEmail(email)) {
			return Response.json({ error: 'a user with that email already exists' }, { status: 409 });
		}

		let created: { id: string };
		try {
			created = await ctx.internalAdapter.createUser({
				email,
				name: body.data.name ?? email.split('@')[0],
				emailVerified: body.data.emailVerified,
			});
		} catch (error) {
			// The create.before hook vetoes with an APIError; anything else is a
			// real failure and must not be flattened into a 403.
			const status = (error as { statusCode?: number; status?: unknown })?.statusCode;
			if (status === undefined) throw error;
			return Response.json(
				{ error: error instanceof Error ? error.message : 'user creation refused' },
				{ status: 403 },
			);
		}

		if (body.data.password) {
			await this.writePassword(created.id, body.data.password, { revokeSessions: false });
		}

		this.writeAuthEvent('user.created', {
			subjectId: created.id,
			provider: body.data.password ? 'credential' : 'none',
			emailDomain: email.split('@')[1] ?? null,
		});
		await this.recordEvent('user.created', 'user created by project administrator');
		return Response.json(await this.userDto(created.id), { status: 201 });
	}

	/** `GET /admin/users/:id`. 404 rather than an empty body - an id that is
	 * not there is not a user with no fields. */
	private async getUserById(userId: string): Promise<Response> {
		if (!userId || userId.length > 128) {
			return Response.json({ error: 'invalid user id' }, { status: 400 });
		}
		const user = await this.userDto(userId);
		if (!user) return Response.json({ error: 'user not found' }, { status: 404 });
		return Response.json(user);
	}

	/**
	 * `PATCH /admin/users/:id` - name, email, verified flag.
	 *
	 * `role` is NOT accepted here on purpose: `PUT /admin/users/:id/role` stays
	 * the only writer, so the console's self-lockout guards cannot be walked
	 * around with a general-purpose update.
	 */
	private async updateUserAsAdmin(userId: string, request: Request): Promise<Response> {
		if (!userId || userId.length > 128) {
			return Response.json({ error: 'invalid user id' }, { status: 400 });
		}
		const body = updateUserRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid update', issues: body.error.issues }, { status: 400 });
		}
		if (!(await this.userDto(userId))) {
			return Response.json({ error: 'user not found' }, { status: 404 });
		}

		const email = body.data.email?.toLowerCase();
		if (email) {
			const clash = await this.auth.$context.then((ctx) =>
				ctx.internalAdapter.findUserByEmail(email),
			);
			// Email is the identity here; letting two accounts share one is how a
			// sign-in silently resolves to the wrong person.
			if (clash && clash.user.id !== userId) {
				return Response.json({ error: 'a user with that email already exists' }, { status: 409 });
			}
		}

		await this.db
			.update(schema.user)
			.set({
				...(body.data.name !== undefined ? { name: body.data.name } : {}),
				...(email !== undefined ? { email } : {}),
				...(body.data.emailVerified !== undefined
					? { emailVerified: body.data.emailVerified }
					: {}),
				updatedAt: new Date(),
			})
			.where(eq(schema.user.id, userId));

		return Response.json(await this.userDto(userId));
	}

	/** `PUT /admin/users/:id/password` - the credential a server can reset
	 * without an emailed token, for migrations and support flows. */
	private async setUserPassword(userId: string, request: Request): Promise<Response> {
		if (!userId || userId.length > 128) {
			return Response.json({ error: 'invalid user id' }, { status: 400 });
		}
		const body = setPasswordRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'newPassword must be 8-128 characters', issues: body.error.issues },
				{ status: 400 },
			);
		}
		if (!(await this.userDto(userId))) {
			return Response.json({ error: 'user not found' }, { status: 404 });
		}

		await this.writePassword(userId, body.data.newPassword, {
			revokeSessions: body.data.revokeSessions,
		});
		return Response.json({ status: true });
	}

	/**
	 * Set or replace an account's password.
	 *
	 * Shared by the operator route, admin creation, and the local-dev reset
	 * hatch so the three cannot drift on the social-only case: an account with
	 * no credential GAINS one, mirroring Better Auth's own reset-password
	 * behaviour rather than failing on a user who signed up with Google.
	 */
	private async writePassword(
		userId: string,
		newPassword: string,
		options: { revokeSessions: boolean },
	): Promise<void> {
		const ctx = await this.auth.$context;
		const hash = await ctx.password.hash(newPassword);
		const [credential] = await this.db
			.select({ id: schema.account.id })
			.from(schema.account)
			.where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')))
			.limit(1);

		if (credential) {
			await ctx.internalAdapter.updatePassword(userId, hash);
		} else {
			await ctx.internalAdapter.linkAccount({
				userId,
				providerId: 'credential',
				accountId: userId,
				password: hash,
			});
		}
		if (options.revokeSessions) await ctx.internalAdapter.deleteSessions([userId]);
	}

	private async deleteUser(userId: string): Promise<Response> {
		if (!userId || userId.length > 128) {
			return Response.json({ error: 'invalid user id' }, { status: 400 });
		}
		const [existing] = await this.db
			.select({ id: schema.user.id, role: schema.user.role })
			.from(schema.user)
			.where(eq(schema.user.id, userId))
			.limit(1);
		if (!existing) return Response.json({ error: 'user not found' }, { status: 404 });

		// The other door to the same lockout: deleting the account that holds
		// the only admin role. `ensureConsoleAdmin` would hand the role to the
		// oldest surviving operator, which is a repair, not a policy - on a
		// console with no other account it repairs nothing at all.
		if (this.name === CONSOLE_PROJECT_ID && existing.role === ADMIN_ROLE) {
			const [{ admins }] = await this.db
				.select({ admins: count() })
				.from(schema.user)
				.where(eq(schema.user.role, ADMIN_ROLE));
			if (admins <= 1) {
				return Response.json(
					{ error: 'the console must keep at least one admin - promote another operator first' },
					{ status: 409 },
				);
			}
		}

		await this.db.delete(schema.user).where(eq(schema.user.id, userId));
		this.writeAuthEvent('user.deleted', { subjectId: userId });
		await this.recordEvent('user.deleted', 'user deleted by project administrator');
		return Response.json({ ok: true });
	}

	/** Replaces the assignable-role registry; built-in roles always remain. */
	private async updateRoles(request: Request): Promise<Response> {
		const body = rolesRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid roles - use 1-32 lowercase letters, digits or dashes' },
				{ status: 400 },
			);
		}
		this.setState({ ...this.state, roles: body.data.roles });
		return Response.json({ roles: body.data.roles });
	}

	private async setUserRole(userId: string, request: Request): Promise<Response> {
		if (!userId) {
			return Response.json({ error: 'invalid user id' }, { status: 400 });
		}
		const body = roleRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid role - use 1-32 lowercase letters, digits or dashes' },
				{ status: 400 },
			);
		}
		const knownRoles = this.state.roles ?? DEFAULT_ROLES;
		if (!knownRoles.some((entry) => entry.name === body.data.role)) {
			return Response.json(
				{ error: `unknown role "${body.data.role}" - define it in the Roles tab first` },
				{ status: 400 },
			);
		}
		const [existing] = await this.db
			.select({ id: schema.user.id, role: schema.user.role })
			.from(schema.user)
			.where(eq(schema.user.id, userId))
			.limit(1);
		if (!existing) return Response.json({ error: 'user not found' }, { status: 404 });

		// The console can never be allowed to lock itself out. Its own surfaces
		// - this route included - are gated on the admin role, and `role` is
		// input:false everywhere else, so the key to the box lives inside the
		// box: a console with no admin can never gain one back through the
		// product. Two refusals, both console-only (a customer project's roles
		// are application RBAC, administered from here, and cannot strand
		// anyone).
		if (
			this.name === CONSOLE_PROJECT_ID &&
			existing.role === ADMIN_ROLE &&
			body.data.role !== ADMIN_ROLE
		) {
			// Demoting YOURSELF is the door that was actually walked through: it
			// reads as an ordinary edit in a list of operators, and the operator
			// who makes the change is the one who loses the page they made it on.
			const caller = await this.sessionUserId(request);
			if (caller === userId) {
				return Response.json(
					{ error: 'you cannot remove your own admin role - ask another admin to do it' },
					{ status: 409 },
				);
			}
			const [{ admins }] = await this.db
				.select({ admins: count() })
				.from(schema.user)
				.where(eq(schema.user.role, ADMIN_ROLE));
			if (admins <= 1) {
				return Response.json(
					{ error: 'the console must keep at least one admin - promote another operator first' },
					{ status: 409 },
				);
			}
		}

		if (existing.role !== body.data.role) {
			await this.db
				.update(schema.user)
				.set({ role: body.data.role, updatedAt: new Date() })
				.where(eq(schema.user.id, userId));
			await this.recordEvent('user.role-changed', `role "${body.data.role}" assigned`);
		}
		return Response.json({ id: userId, role: body.data.role });
	}

	private async revokeSession(sessionId: string): Promise<Response> {
		if (!sessionId || sessionId.length > 128) {
			return Response.json({ error: 'invalid session id' }, { status: 400 });
		}
		const [existing] = await this.db
			.select({ id: schema.session.id, userId: schema.session.userId })
			.from(schema.session)
			.where(eq(schema.session.id, sessionId))
			.limit(1);
		if (!existing) return Response.json({ error: 'session not found' }, { status: 404 });
		await this.db.delete(schema.session).where(eq(schema.session.id, sessionId));
		this.writeAuthEvent('session.revoked', {
			subjectId: existing.userId,
			sessionId: existing.id,
		});
		await this.recordEvent('session.revoked', 'session revoked by project administrator');
		return Response.json({ ok: true });
	}

	private async updateSettings(request: Request): Promise<Response> {
		const body = settingsRequestSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid settings', issues: body.error.flatten().fieldErrors },
				{ status: 400 },
			);
		}
		if (body.data.socialProviders !== undefined) {
			this.socialCredentials = applySocialCredentials(
				body.data.socialProviders,
				this.socialCredentials,
			);
			await this.ctx.storage.put('social-provider-credentials', this.socialCredentials);
		}
		if (body.data.authPolicy !== undefined) {
			// Merge, never replace: a settings save that carries only origins
			// must not silently reset a policy configured earlier.
			this.authPolicy = authPolicySchema.parse({ ...this.authPolicy, ...body.data.authPolicy });
			await this.ctx.storage.put('auth-policy', this.authPolicy);
		}
		const enabledSocialProviders = this.configuredSocialProviders;
		this.setState({
			...this.state,
			allowedOrigins: body.data.allowedOrigins,
			enabledSocialProviders,
			authPolicy: this.effectiveAuthPolicy,
		});
		// Drop the memoized instance: requireEmailVerification is baked into it.
		this._auth = null;
		return Response.json({
			allowedOrigins: body.data.allowedOrigins,
			enabledSocialProviders,
			authPolicy: this.effectiveAuthPolicy,
		});
	}

	/**
	 * Who is making this request, from the cookies/bearer the console proxy
	 * forwards. Null when there is no session OR the lookup failed - callers
	 * using it for the self-demotion refusal are backstopped by the
	 * last-admin count, which never depends on identity.
	 */
	private async sessionUserId(request: Request): Promise<string | null> {
		// The same handler-not-api resolution as getConsoleMe below, for the
		// same reason: only the handler runs the bearer plugin, and a present
		// Authorization header must decide alone.
		const origin = new URL(request.url).origin;
		const sessionHeaders = new Headers(request.headers);
		if (sessionHeaders.get('authorization')) sessionHeaders.delete('cookie');
		const sessionResponse = await this.auth
			.handler(
				new Request(`${origin}${this.authBasePath}/get-session`, {
					method: 'GET',
					headers: sessionHeaders,
				}),
			)
			.catch(() => null);
		if (!sessionResponse?.ok) return null;
		const resolved = (await sessionResponse.json().catch(() => null)) as {
			user?: { id?: string };
		} | null;
		return resolved?.user?.id ?? null;
	}

	/**
	 * The console guard's identity lookup: session + org memberships +
	 * pending invitations in ONE agent round trip (the guard runs per
	 * dashboard request, so it must never pay two). Also the healing point
	 * for accounts that predate organizations: a registered user with no
	 * membership gets their personal org here, which is how the first-run
	 * owner from before Phase A acquires one without a migration.
	 */
	private async getConsoleMe(request: Request): Promise<Response> {
		// Resolved through the real Better Auth HANDLER, not auth.api.getSession:
		// only the handler runs the bearer plugin's header-to-cookie conversion.
		// The pinned precedence is that an Authorization bearer is AUTHORITATIVE:
		// an invalid bearer is refused even when a valid cookie rides along (the
		// CLI contract). The bearer plugin used to guarantee that by overwriting
		// the session cookie, but the cookieCache's session_data cookie is
		// consulted before the token - so when a bearer is present, cookies are
		// dropped from the lookup entirely and the token decides alone.
		const origin = new URL(request.url).origin;
		const sessionHeaders = new Headers(request.headers);
		if (sessionHeaders.get('authorization')) sessionHeaders.delete('cookie');
		const sessionResponse = await this.auth
			.handler(
				new Request(`${origin}${this.authBasePath}/get-session`, {
					method: 'GET',
					headers: sessionHeaders,
				}),
			)
			.catch((cause: unknown) => {
				// The swallowed shape here is what made a five-day escalation read
				// as one constant 503 in Sentry - the INNER failure must be named.
				Sentry.captureException(cause, {
					level: 'error',
					tags: { operation: 'console-me', projectId: this.name },
				});
				return null;
			});
		// "Signed out" and "could not verify" are DIFFERENT answers and must not
		// collapse into one. Better Auth answers a signed-out lookup with 200 and
		// a null body (401/403 is the other ordinary form); a 429 from the rate
		// limiter or a 5xx means the session was never checked. Reporting that as
		// "no session" signs a valid operator out and sends them to a /login that
		// resolves the session exactly the same way - a loop nobody can escape by
		// signing in again. Say unavailable and let the caller fail loudly.
		if (!sessionResponse) return this.consoleMeUnavailable();
		if (!sessionResponse.ok) {
			if (sessionResponse.status !== 401 && sessionResponse.status !== 403) {
				// Same reason as the catch above: the outer 503 is constant, so the
				// inner status and body are the only place the real cause survives.
				const body = await sessionResponse
					.clone()
					.text()
					.then((value) => value.slice(0, 512))
					.catch(() => '<unavailable>');
				Sentry.captureMessage(`console/me inner get-session responded ${sessionResponse.status}`, {
					level: 'error',
					tags: {
						operation: 'console-me',
						innerStatus: String(sessionResponse.status),
						projectId: this.name,
					},
					contexts: { response: { body } },
				});
				return this.consoleMeUnavailable();
			}
			return Response.json(null);
		}
		const resolved = (await sessionResponse.json().catch(() => null)) as {
			user?: {
				id?: string;
				email?: string;
				name?: string;
				emailVerified?: boolean;
				isAnonymous?: boolean | null;
				role?: string;
				image?: string | null;
			};
			session?: { activeOrganizationId?: string | null };
		} | null;
		if (!resolved?.user?.id || !resolved.user.email) return Response.json(null);
		const user = {
			id: resolved.user.id,
			email: resolved.user.email,
			name: resolved.user.name ?? '',
			emailVerified: !!resolved.user.emailVerified,
			isAnonymous: resolved.user.isAnonymous ?? null,
			role: resolved.user.role,
		};
		const session: { activeOrganizationId?: string | null } = resolved.session ?? {};

		if (!user.isAnonymous) {
			await ensurePersonalOrg(this.db, user);
		}
		// Console-instance only (the route guarantees it): the deployment's
		// administrator, healed into place if the role has never been assigned.
		await ensureConsoleAdmin(this.db);

		// The role is read from the TABLE, not from the session payload. The
		// console runs a 60s signed cookie cache, and this role now gates the
		// console's own project surfaces - a demotion that stays unenforced for
		// a minute is a minute of administrator access nobody granted. It also
		// makes the heal above take effect on the request that performs it.
		const [current] = await this.db
			.select({ role: schema.user.role })
			.from(schema.user)
			.where(eq(schema.user.id, user.id))
			.limit(1);
		const role = current?.role ?? user.role ?? 'user';

		const memberships = await this.db
			.select({
				id: schema.organization.id,
				name: schema.organization.name,
				slug: schema.organization.slug,
				role: schema.member.role,
			})
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
			.where(eq(schema.member.userId, user.id))
			.orderBy(asc(schema.member.createdAt));

		// An invitation's id is the credential that accepts it, so it is handed
		// out only to someone who has PROVED the invited inbox: a verified
		// address, or a caller who already holds the id because it arrived by
		// the invite link (?invitation=). Listing by a mere email match used to
		// let anyone who registered an invited address first - verification is
		// off in claimed mode - read the id and join the org.
		const linkedId = new URL(request.url).searchParams.get('invitation');
		const scope = user.emailVerified
			? undefined
			: linkedId
				? eq(schema.invitation.id, linkedId)
				: null;
		const invitations =
			scope === null
				? []
				: await this.db
						.select({
							id: schema.invitation.id,
							organizationId: schema.invitation.organizationId,
							organizationName: schema.organization.name,
							role: schema.invitation.role,
							inviterEmail: schema.user.email,
							expiresAt: schema.invitation.expiresAt,
						})
						.from(schema.invitation)
						.innerJoin(
							schema.organization,
							eq(schema.organization.id, schema.invitation.organizationId),
						)
						.leftJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
						.where(
							and(
								eq(sql`lower(${schema.invitation.email})`, user.email.toLowerCase()),
								eq(schema.invitation.status, 'pending'),
								gt(schema.invitation.expiresAt, new Date()),
								scope,
							),
						);

		return Response.json({
			user: {
				id: user.id,
				email: user.email,
				name: user.name || user.email,
				role,
				emailVerified: !!user.emailVerified,
				image: resolved.user.image ?? null,
			},
			session: { activeOrganizationId: session.activeOrganizationId ?? null },
			organizations: memberships,
			pendingInvitations: invitations.map((row) => ({
				...row,
				expiresAt: row.expiresAt.toISOString(),
			})),
		} satisfies ConsoleMe);
	}

	/**
	 * The console guard's "I could not check" answer. A 503 (not a 200 null)
	 * because the difference decides whether the dashboard signs someone out,
	 * and because the worker's 5xx net reports it - the shape of failure that
	 * used to be invisible was exactly this one, answered 200.
	 */
	private consoleMeUnavailable(): Response {
		return Response.json(
			{ error: 'session could not be verified' },
			{ status: 503, headers: { 'retry-after': '5' } },
		);
	}

	/** Snapshot used by the dashboard's initial server-side load and polling.
	 * Carries the FIRST page of each list plus its continuation; subsequent
	 * pages come from `/admin/users` and `/admin/sessions`. */
	async getOverview(): Promise<AuthOverview> {
		const [users, sessions] = await Promise.all([
			this.listUsers(null, LIST_PAGE_SIZE),
			this.listSessions(null, LIST_PAGE_SIZE),
		]);

		return {
			projectId: this.name,
			users: users.users,
			usersNextCursor: users.nextCursor,
			sessions: sessions.sessions,
			sessionsNextCursor: sessions.nextCursor,
			state: this.state,
		};
	}

	/**
	 * One page of users, newest first. Fetches limit+1 rows so "is there a next
	 * page" needs no COUNT: the extra row is dropped and only proves the cursor
	 * is worth handing back.
	 */
	async listUsers(cursorRaw: string | null, limit: number): Promise<UserPage> {
		const cursor = decodeListCursor(cursorRaw);
		const rows = await this.db
			.select({
				id: schema.user.id,
				name: schema.user.name,
				email: schema.user.email,
				emailVerified: schema.user.emailVerified,
				isAnonymous: schema.user.isAnonymous,
				role: schema.user.role,
				createdAt: schema.user.createdAt,
			})
			.from(schema.user)
			.where(
				cursor
					? or(
							lt(schema.user.createdAt, cursor.createdAt),
							and(eq(schema.user.createdAt, cursor.createdAt), lt(schema.user.id, cursor.id)),
						)
					: undefined,
			)
			.orderBy(desc(schema.user.createdAt), desc(schema.user.id))
			.limit(limit + 1);

		const page = rows.slice(0, limit);
		// One provider lookup per page, SCOPED to the page's ids - unscoped,
		// this read the whole account table (which grows with every real
		// user) into memory on every dashboard poll. Keep the narrow column
		// projection: account.password holds credential hashes.
		const ids = page.map((row) => row.id);
		const accounts = ids.length
			? await this.db
					.select({ userId: schema.account.userId, providerId: schema.account.providerId })
					.from(schema.account)
					.where(inArray(schema.account.userId, ids))
			: [];
		const providersByUser = new Map<string, string[]>();
		for (const row of accounts) {
			providersByUser.set(row.userId, [...(providersByUser.get(row.userId) ?? []), row.providerId]);
		}

		const last = page.at(-1);
		return {
			users: page.map((u) => ({
				...u,
				isAnonymous: !!u.isAnonymous,
				providers: providersByUser.get(u.id) ?? (u.isAnonymous ? ['anonymous'] : []),
				createdAt: u.createdAt.toISOString(),
			})),
			nextCursor:
				rows.length > limit && last ? encodeListCursor(last.createdAt, last.id) : undefined,
		};
	}

	/** One page of LIVE sessions, newest first. Expired rows are filtered in
	 * SQL, so a page is always `limit` live sessions rather than `limit` rows
	 * that happen to include dead ones. */
	async listSessions(cursorRaw: string | null, limit: number): Promise<SessionPage> {
		const cursor = decodeListCursor(cursorRaw);
		const live = gt(schema.session.expiresAt, new Date());
		const rows = await this.db
			.select({
				id: schema.session.id,
				userId: schema.session.userId,
				email: schema.user.email,
				ipAddress: schema.session.ipAddress,
				userAgent: schema.session.userAgent,
				country: schema.session.country,
				createdAt: schema.session.createdAt,
				expiresAt: schema.session.expiresAt,
			})
			.from(schema.session)
			.leftJoin(schema.user, eq(schema.user.id, schema.session.userId))
			.where(
				cursor
					? and(
							live,
							or(
								lt(schema.session.createdAt, cursor.createdAt),
								and(
									eq(schema.session.createdAt, cursor.createdAt),
									lt(schema.session.id, cursor.id),
								),
							),
						)
					: live,
			)
			.orderBy(desc(schema.session.createdAt), desc(schema.session.id))
			.limit(limit + 1);

		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return {
			sessions: page.map((s) => ({
				...s,
				createdAt: s.createdAt.toISOString(),
				expiresAt: s.expiresAt.toISOString(),
			})),
			nextCursor:
				rows.length > limit && last ? encodeListCursor(last.createdAt, last.id) : undefined,
		};
	}

	/** Operational totals from SQLite plus behavioral analytics from Analytics Engine. */
	async getAnalytics(timeZone = 'Etc/UTC'): Promise<AuthAnalytics> {
		const [totalUsers] = await this.db.select({ n: count() }).from(schema.user);
		const [anonymousUsers] = await this.db
			.select({ n: count() })
			.from(schema.user)
			.where(eq(schema.user.isAnonymous, true));
		const [activeSessions] = await this.db
			.select({ n: count() })
			.from(schema.session)
			.where(gt(schema.session.expiresAt, new Date()));

		let analyticsError: string | undefined;
		let behavioral: BehavioralAnalytics;
		try {
			behavioral = await this.queryBehavioralAnalytics(timeZone);
		} catch (error) {
			// The route still answers 200 with zeroed charts, so the worker's
			// 5xx net never fires: without this, a broken analytics token or a
			// WAE SQL change shows up as "all charts read zero" forever.
			analyticsError = error instanceof Error ? error.message : 'Analytics Engine query failed';
			console.error(analyticsError);
			Sentry.captureException(error, {
				level: 'error',
				tags: { projectId: this.name, operation: 'analytics-query' },
			});
			behavioral = this.emptyBehavioralAnalytics();
		}

		const total = totalUsers?.n ?? 0;
		const anonymous = anonymousUsers?.n ?? 0;
		return {
			projectId: this.name,
			dau: behavioral.dau,
			wau: behavioral.wau,
			mau: behavioral.mau,
			totalUsers: total,
			registeredUsers: total - anonymous,
			anonymousUsers: anonymous,
			gmailUsers: behavioral.gmailUsers,
			activeSessions: activeSessions?.n ?? 0,
			providers: behavioral.providers,
			countries: behavioral.countries,
			activityByDay: behavioral.activityByDay,
			engine: {
				dataset: this.env.WAE_DATASET ?? 'cloudflarebase_auth_events',
				enabled: this.waeConfig !== null || !!this.env.LOCAL_ANALYTICS,
				status: analyticsError
					? 'error'
					: this.waeConfig
						? 'connected'
						: this.env.LOCAL_ANALYTICS
							? 'local'
							: 'write-only',
				error: analyticsError,
			},
			eventsLast24h: behavioral.eventsLast24h,
		};
	}

	private emptyBehavioralAnalytics(): BehavioralAnalytics {
		return {
			dau: 0,
			wau: 0,
			mau: 0,
			gmailUsers: 0,
			providers: [],
			countries: [],
			activityByDay: [],
			eventsLast24h: undefined,
		};
	}

	private async analyticsSql<T>(query: string): Promise<T[]> {
		const config = this.waeConfig;
		if (!config) return [];
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${config.token}` },
				body: `${query} FORMAT JSON`,
			},
		);
		if (!response.ok) {
			throw new Error(`Analytics Engine query failed (${response.status})`);
		}
		const result = analyticsApiResponseSchema.parse(await response.json());
		return (result.data ?? []) as T[];
	}

	/** Behavioral analytics are exclusively sourced from Analytics Engine. */
	private async queryBehavioralAnalytics(timeZone: string): Promise<BehavioralAnalytics> {
		if (
			this.behavioralCache &&
			this.behavioralCache.timeZone === timeZone &&
			this.behavioralCache.expiresAt > Date.now()
		) {
			return this.behavioralCache.data;
		}
		const config = this.waeConfig;
		if (!config && this.env.LOCAL_ANALYTICS) return this.queryLocalBehavioralAnalytics(timeZone);
		const empty = this.emptyBehavioralAnalytics();
		if (!config) {
			this.behavioralCache = {
				expiresAt: Date.now() + ANALYTICS_CACHE_MS,
				timeZone,
				data: empty,
			};
			return empty;
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.dataset)) {
			throw new Error('WAE_DATASET must be a valid Analytics Engine identifier');
		}
		const project = this.name.replaceAll("'", "''");
		const from = `FROM ${config.dataset} WHERE index1 = '${project}'`;
		const activeUsers = (days: number) =>
			this.analyticsSql<{ users: number | string }>(
				`SELECT count(DISTINCT blob4) AS users ${from} AND blob1 = 'user.active' AND timestamp > NOW() - INTERVAL '${days}' DAY`,
			);
		// Day buckets in the viewer's timezone; the dashboard filters 7/30/90-day
		// windows client-side from this 90-day series.
		const dailyCounts = (eventType: string) =>
			this.analyticsSql<{ day: string; count: number | string }>(
				`SELECT formatDateTime(timestamp, '%Y-%m-%d', '${timeZone}') AS day, SUM(_sample_interval) AS count ${from} AND blob1 = '${eventType}' AND timestamp > NOW() - INTERVAL '90' DAY GROUP BY day ORDER BY day`,
			);
		const [dau, wau, mau, providers, countries, signups, signins, gmail, events] =
			await Promise.all([
				activeUsers(1),
				activeUsers(7),
				activeUsers(30),
				this.analyticsSql<{ provider: string; users: number | string }>(
					`SELECT blob3 AS provider, count(DISTINCT blob4) AS users ${from} AND blob1 = 'user.active' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY provider ORDER BY users DESC`,
				),
				this.analyticsSql<{ country: string; sessions: number | string }>(
					`SELECT blob2 AS country, SUM(_sample_interval) AS sessions ${from} AND blob1 = 'session.created' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY country ORDER BY sessions DESC LIMIT 10`,
				),
				dailyCounts('user.created'),
				dailyCounts('session.created'),
				this.analyticsSql<{ users: number | string }>(
					`SELECT count(DISTINCT blob4) AS users ${from} AND blob1 = 'user.created' AND blob6 = 'gmail.com'`,
				),
				this.analyticsSql<{ eventType: string; count: number | string }>(
					`SELECT blob1 AS eventType, SUM(_sample_interval) AS count ${from} AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY eventType ORDER BY count DESC`,
				),
			]);
		const activityByDay = new Map<string, { day: string; signups: number; signins: number }>();
		const dayEntry = (day: string) => {
			let entry = activityByDay.get(day);
			if (!entry) {
				entry = { day, signups: 0, signins: 0 };
				activityByDay.set(day, entry);
			}
			return entry;
		};
		for (const row of signups) dayEntry(row.day.slice(0, 10)).signups += Number(row.count);
		for (const row of signins) dayEntry(row.day.slice(0, 10)).signins += Number(row.count);
		const data: BehavioralAnalytics = {
			dau: Number(dau[0]?.users ?? 0),
			wau: Number(wau[0]?.users ?? 0),
			mau: Number(mau[0]?.users ?? 0),
			gmailUsers: Number(gmail[0]?.users ?? 0),
			providers: providers.map((row) => ({ ...row, users: Number(row.users) })),
			countries: countries.map((row) => ({ ...row, sessions: Number(row.sessions) })),
			activityByDay: [...activityByDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
			eventsLast24h: events.map((row) => ({ ...row, count: Number(row.count) })),
		};
		this.behavioralCache = { expiresAt: Date.now() + ANALYTICS_CACHE_MS, timeZone, data };
		return data;
	}

	private async queryLocalBehavioralAnalytics(timeZone: string): Promise<BehavioralAnalytics> {
		const db = this.env.LOCAL_ANALYTICS!;
		const since = (days: number) => Date.now() - days * 86_400_000;
		const bind = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(this.name, ...values);
		const [dau, wau, mau, providers, countries, activity, gmail, events] = await db.batch([
			bind(
				`SELECT COUNT(DISTINCT subject_id) users FROM auth_events WHERE project_id=? AND event_type='user.active' AND timestamp>?`,
				since(1),
			),
			bind(
				`SELECT COUNT(DISTINCT subject_id) users FROM auth_events WHERE project_id=? AND event_type='user.active' AND timestamp>?`,
				since(7),
			),
			bind(
				`SELECT COUNT(DISTINCT subject_id) users FROM auth_events WHERE project_id=? AND event_type='user.active' AND timestamp>?`,
				since(30),
			),
			bind(
				`SELECT provider, COUNT(DISTINCT subject_id) users FROM auth_events WHERE project_id=? AND event_type='user.active' AND timestamp>? GROUP BY provider ORDER BY users DESC`,
				since(30),
			),
			bind(
				`SELECT country, COUNT(DISTINCT session_id) sessions FROM auth_events WHERE project_id=? AND event_type='session.created' AND timestamp>? GROUP BY country ORDER BY sessions DESC LIMIT 10`,
				since(30),
			),
			bind(
				`SELECT timestamp, event_type FROM auth_events WHERE project_id=? AND event_type IN ('user.created','session.created') AND timestamp>?`,
				since(90),
			),
			bind(
				`SELECT COUNT(DISTINCT subject_id) users FROM auth_events WHERE project_id=? AND event_type='user.created' AND email_domain='gmail.com'`,
			),
			bind(
				`SELECT event_type eventType, COUNT(*) count FROM auth_events WHERE project_id=? AND timestamp>? GROUP BY event_type ORDER BY count DESC`,
				since(1),
			),
		]);
		const rows = <T>(result: D1Result<unknown>) => (result.results ?? []) as T[];
		const scalar = (result: D1Result) => Number(rows<{ users: number }>(result)[0]?.users ?? 0);
		// D1's SQLite cannot group by an IANA-timezone day, so bucket activity
		// timestamps here in the viewer's timezone, matching the remote
		// formatDateTime(timestamp, '%Y-%m-%d', timeZone) queries.
		const dayFormatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		const activityByDay = new Map<string, { day: string; signups: number; signins: number }>();
		for (const row of rows<{ timestamp: number; event_type: string }>(activity)) {
			const day = dayFormatter.format(row.timestamp);
			let entry = activityByDay.get(day);
			if (!entry) {
				entry = { day, signups: 0, signins: 0 };
				activityByDay.set(day, entry);
			}
			if (row.event_type === 'user.created') entry.signups += 1;
			else entry.signins += 1;
		}
		return {
			dau: scalar(dau),
			wau: scalar(wau),
			mau: scalar(mau),
			gmailUsers: scalar(gmail),
			providers: rows(providers),
			countries: rows(countries),
			activityByDay: [...activityByDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
			eventsLast24h: rows(events),
		};
	}

	/**
	 * Answers a natural-language question about this project's auth data.
	 * Workers AI is mandatory: failures are surfaced to the caller and are
	 * never replaced with a response that only looks model-generated.
	 */
	private async chatClientKey(request: Request): Promise<string> {
		const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
		const address =
			request.headers.get('cf-connecting-ip') ??
			request.headers.get('x-real-ip') ??
			forwarded ??
			'local';
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`${this.name}:${address}`),
		);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
			'',
		);
	}

	private async getChatMessages(clientKey: string, limit = 50): Promise<AgentChatMessage[]> {
		const rows = await this.db
			.select()
			.from(schema.chatMessage)
			.where(eq(schema.chatMessage.clientKey, clientKey))
			.orderBy(desc(schema.chatMessage.createdAt))
			.limit(limit);
		return rows.reverse().map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			createdAt: message.createdAt.toISOString(),
		}));
	}

	private async saveChatMessage(
		clientKey: string,
		role: AgentChatMessage['role'],
		content: string,
		createdAt: Date,
	): Promise<AgentChatMessage> {
		const message = { id: crypto.randomUUID(), clientKey, role, content, createdAt };
		await this.db.insert(schema.chatMessage).values(message);
		return { id: message.id, role, content, createdAt: createdAt.toISOString() };
	}

	async answerQuestion(question: string, clientKey: string): Promise<AgentChatReply> {
		const a = await this.getAnalytics();
		if (!this.env.AI) {
			throw new Error('Workers AI binding is required for the AuthAgent');
		}

		const history = await this.getChatMessages(clientKey, 20);
		const model = this.env.CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
		const result = workersAiResponseSchema.parse(
			await this.env.AI.run(model as keyof AiModels, {
				messages: [
					{
						role: 'system',
						content:
							`You are the Frostbase auth analytics agent for project "${this.name}". ` +
							'Answer only from the aggregated JSON supplied by the user. Never invent metrics. ' +
							'Be concise, explain useful ratios or trends when the data supports them, and say when there is not enough data. ' +
							'Do not claim you can modify users, sessions, or configuration.',
					},
					...history.map((message) => ({
						role: message.role === 'agent' ? ('assistant' as const) : ('user' as const),
						content: message.content,
					})),
					{
						role: 'user',
						content: `Question: ${question}\n\nAggregated auth analytics:\n${JSON.stringify(a)}`,
					},
				],
				max_tokens: 350,
				temperature: 0.2,
			}),
		);

		const answer = result.response?.trim();
		if (!answer) throw new Error('Workers AI returned an empty response');
		const createdAt = Date.now();
		const userMessage = await this.saveChatMessage(
			clientKey,
			'user',
			question,
			new Date(createdAt),
		);
		const agentMessage = await this.saveChatMessage(
			clientKey,
			'agent',
			answer,
			new Date(createdAt + 1),
		);
		return {
			question,
			topic: 'ai-analysis',
			answer,
			mode: 'workers-ai',
			model,
			userMessage,
			agentMessage,
		};
	}

	/**
	 * Erases this project: every user, session, account, and setting. Called
	 * over RPC when the registry deletes a project, and by the demo reaper when
	 * an ephemeral project expires.
	 *
	 * deleteAll() drops the Durable Object's whole SQLite database - SQL tables
	 * and key-value entries alike - so the abort() that follows is what makes
	 * the next request start clean: it restarts the object, and onStart() then
	 * re-applies the Drizzle migrations against an empty database rather than
	 * leaving this isolate holding freed handles and stale agent state.
	 *
	 * The abort is deferred by a tick because it resets the object immediately,
	 * which would destroy this RPC's own response before the caller received
	 * it - every successful delete would surface as a failure.
	 */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		// deleteAll() leaves the Durable Object's alarm armed. An orphaned alarm
		// wakes the erased object later, where the SDK's alarm handler dies
		// querying its dropped cf_agents_schedules table - and a demo shell
		// revived that way would even schedule itself a fresh expiry.
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	private async counters(): Promise<Pick<AuthAgentState, 'users' | 'activeSessions'>> {
		const [users] = await this.db.select({ n: count() }).from(schema.user);
		const [activeSessions] = await this.db
			.select({ n: count() })
			.from(schema.session)
			.where(gt(schema.session.expiresAt, new Date()));
		return { users: users?.n ?? 0, activeSessions: activeSessions?.n ?? 0 };
	}

	private async syncCounters(): Promise<void> {
		const counters = await this.counters();
		if (
			counters.users !== this.state.users ||
			counters.activeSessions !== this.state.activeSessions
		) {
			this.setState({ ...this.state, ...counters });
		}
	}

	private async recordEvent(type: AuthActivityEvent['type'], message: string): Promise<void> {
		const at = new Date().toISOString();
		const event: AuthActivityEvent = { id: crypto.randomUUID(), type, message, at };
		this.setState({
			...this.state,
			...(await this.counters()),
			events: [event, ...this.state.events].slice(0, MAX_EVENTS),
			totalEvents: this.state.totalEvents + 1,
			lastEventAt: at,
		});
	}
}
