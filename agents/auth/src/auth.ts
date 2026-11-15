import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, bearer, jwt, organization } from 'better-auth/plugins';
import { and, asc, eq, ne, or, isNull } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { resolveEmailCallback } from './email-callback.js';
import * as schema from './db/schema.js';

/** Providers whose sign-in attests a verified email. Shared between the
 * accountLinking trust list and the credential-supersession hook so the two
 * halves of that policy can never disagree. */
const TRUSTED_SOCIAL_PROVIDERS: string[] = ['google', 'github'];

export type AuthDatabase = DrizzleSqliteDODatabase<typeof schema>;

export interface AuthHookUser {
	id: string;
	email: string;
	name: string;
	isAnonymous?: boolean | null;
}

export interface AuthEmailMessage {
	type: 'email-verification' | 'password-reset' | 'invitation' | 'email-change';
	to: string;
	url: string;
	/** Extra copy for invitation mail: who invited, into which organization. */
	invitation?: { organization: string; inviter: string };
}

/**
 * Creates the user's personal organization if they belong to none - every
 * account lands with one org it owns, so "personal project" is just an org
 * with a single member and ownership never needs a user-or-org union type.
 * Called from the user-creation hook when `autoPersonalOrg` is on, and again
 * lazily from the console's /console/me so accounts that predate organizations
 * (the first-run owner) heal on their next visit. Anonymous users never get
 * one. Safe to call repeatedly: Durable Object input gates serialize the
 * check-then-insert, so no duplicate personal org can be minted.
 */
export async function ensurePersonalOrg(
	db: AuthDatabase,
	user: Pick<AuthHookUser, 'id' | 'email' | 'name' | 'isAnonymous'>,
): Promise<void> {
	if (user.isAnonymous) return;
	const [existing] = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(eq(schema.member.userId, user.id))
		.limit(1);
	if (existing) return;

	const now = new Date();
	const orgId = crypto.randomUUID();
	const owner = (user.name || user.email.split('@')[0] || 'Personal').trim();
	await db.insert(schema.organization).values({
		id: orgId,
		name: `${owner}'s organization`.slice(0, 64),
		// Random suffix, not derived from the name: slugs are unique and the
		// personal org is addressed by id everywhere that matters.
		slug: `personal-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
		createdAt: now,
	});
	await db.insert(schema.member).values({
		id: crypto.randomUUID(),
		organizationId: orgId,
		userId: user.id,
		role: 'owner',
		createdAt: now,
	});
}

/**
 * Guarantees the console instance has an administrator.
 *
 * The console's own project surfaces (its user list, session revocation, role
 * assignment - every operator account on the deployment) answer to the `admin`
 * role and nothing else. But `role` defaults to `user` and its only writer is
 * the admin route itself, so a console with no admin can never gain one: the
 * key is locked inside the box.
 *
 * The earliest account is the one that claimed the deployment, so it is the
 * administrator. Runs only while NO admin exists, which makes it a one-time
 * heal on consoles that predate this - and a standing repair for a console
 * whose last admin demoted or deleted themselves, which would otherwise be
 * unadministrable forever.
 */
export async function ensureConsoleAdmin(db: AuthDatabase): Promise<void> {
	const [admin] = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.role, 'admin'))
		.limit(1);
	if (admin) return;

	const [first] = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		// Guests are excluded on principle. The console refuses anonymous
		// sign-in outright, so this should select nothing - but "should" is not
		// what you want between a guest session and the operator account list.
		.where(or(isNull(schema.user.isAnonymous), ne(schema.user.isAnonymous, true)))
		.orderBy(asc(schema.user.createdAt))
		.limit(1);
	if (!first) return;

	await db.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, first.id));
}

export interface ProjectAuthConfig {
	/** Frostbase project id - one AuthAgent (and one auth database) per project. */
	projectId: string;
	/** Drizzle handle over the Durable Object's embedded SQLite database. */
	db: AuthDatabase;
	secret: string;
	/** Origins allowed to call this project's auth endpoints (CSRF protection). */
	trustedOrigins: string[];
	/** Disable throttling only in an isolated automated-test environment. */
	disableRateLimit?: boolean;
	/** Country of the request currently being handled (from request.cf). */
	getRequestCountry?: () => string | null;
	/** Resolves a role name to its granted permission keys (from agent state). */
	getRolePermissions?: (role: string) => string[];
	/** Optional Google OAuth credentials (per-project social sign-in). */
	google?: { clientId: string; clientSecret: string };
	github?: { clientId: string; clientSecret: string };
	sendEmail?: (message: AuthEmailMessage) => Promise<void>;
	/**
	 * Refuse sign-in until the email is verified (managed open sign-ups).
	 * Only meaningful with a configured sendEmail transport.
	 */
	requireEmailVerification?: boolean;
	/**
	 * Better Auth's signed cookie cache: session reads become local signature
	 * checks for 60 seconds, so a polling dashboard does not hammer the
	 * session table on every request. Enabled for the console instance.
	 */
	cookieCache?: boolean;
	/**
	 * How long a session survives, in days. Sliding: Better Auth extends it
	 * once per day of use, so this is idle time, not a hard deadline.
	 * Defaults to Better Auth's 7. The console runs longer - an operator
	 * console that signs you out weekly is a nuisance, not a security
	 * control, and the control that matters (session revocation) is
	 * immediate either way.
	 */
	sessionDays?: number;
	/**
	 * Create a personal organization for every new registered user (see
	 * ensurePersonalOrg). On for the console instance; consumers can enable
	 * the same hook for their own products.
	 */
	autoPersonalOrg?: boolean;
	/**
	 * Ceiling on organizations one user can CREATE - Better Auth refuses the
	 * create route once the user already belongs to this many, so memberships
	 * (personal orgs included) count toward it. Undefined means unlimited.
	 * ensurePersonalOrg is unaffected: it inserts through Drizzle directly.
	 */
	orgLimit?: number;
	/**
	 * Veto over user creation, consulted at the database layer with the user
	 * being created. Returning a reason string rejects the creation with 403.
	 * Route-level checks cannot cover every path that creates a user - social
	 * sign-in creates one implicitly on the OAuth callback without touching
	 * any sign-up route - so an instance that must not grow (the console)
	 * enforces it here.
	 */
	denyUserCreation?: (user: Pick<AuthHookUser, 'email' | 'isAnonymous'>) => Promise<string | null>;
	onUserCreated?: (user: AuthHookUser) => void | Promise<void>;
	onSessionActivity?: (
		session: { id: string; userId: string },
		kind: 'created' | 'refreshed',
	) => void | Promise<void>;
}

/**
 * Builds the Better Auth instance for a single project. All auth tables
 * (user, session, account, verification) live inside the project's Durable
 * Object SQLite database, so every project gets a fully isolated auth stack.
 */
export function createProjectAuth(config: ProjectAuthConfig) {
	return betterAuth({
		appName: `cloudflarebase:${config.projectId}`,
		// The PUBLIC path of this project's auth endpoints on a dashboard
		// deployment, not the agent-internal /api/auth the DO dispatches on
		// (agent.ts rewrites ingress to this base). Better Auth derives every
		// absolute URL it hands out - email verification/reset links, OAuth
		// redirect URIs - from request origin + basePath, so mounting it at the
		// internal path sent visitors to a route the console guard 401s.
		basePath: `/api/projects/${config.projectId}/auth`,
		secret: config.secret,
		// A deployment trusts its own origin automatically: a browser only sends
		// an Origin equal to the URL it is actually on, so same-origin requests
		// are never CSRF. The configured list is for anything else - custom
		// domains, external apps - and a fresh install needs no configuration
		// before sign-in works.
		trustedOrigins: (request) => [
			...config.trustedOrigins,
			request ? new URL(request.url).origin : null,
		],
		database: drizzleAdapter(config.db, {
			provider: 'sqlite',
			schema,
			// DO SQLite exposes only sync transactions; run operations sequentially.
			transaction: false,
		}),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
			maxPasswordLength: 128,
			revokeSessionsOnPasswordReset: true,
			// Open console sign-ups: nobody signs in until their address is
			// proven. A failed unverified sign-in re-sends the verification mail,
			// which is also how an owner from before verification existed gets
			// their link when a deployment turns this on later.
			requireEmailVerification: config.requireEmailVerification,
			sendResetPassword: config.sendEmail
				? async ({ user, url }, request) =>
						config.sendEmail?.({
							type: 'password-reset',
							to: user.email,
							url: resolveEmailCallback(url, request, config.trustedOrigins),
						})
				: undefined,
		},
		emailVerification: config.sendEmail
			? {
					sendOnSignUp: true,
					sendVerificationEmail: async ({ user, url }, request) =>
						config.sendEmail?.({
							type: 'email-verification',
							to: user.email,
							url: resolveEmailCallback(url, request, config.trustedOrigins),
						}),
				}
			: undefined,
		rateLimit: {
			enabled: !config.disableRateLimit,
			window: 60,
			max: 100,
			customRules: {
				'/sign-in/email': { window: 60, max: 10 },
				'/sign-up/email': { window: 60, max: 10 },
				'/sign-in/anonymous': { window: 60, max: 20 },
				// Reading a session is not a guessing surface - the caller already
				// holds the cookie - and it is the single hottest path here: the
				// console guard resolves an identity on EVERY operator request
				// while every dashboard page polls on a 5s timer. Under the
				// default 100/60s that runs out within a minute of ordinary use,
				// and a 429 is indistinguishable from "no session" to the caller,
				// so a signed-in operator gets bounced to /login - which resolves
				// the session the same way and bounces them back. Sized above any
				// dashboard's poll rate; still a per-IP ceiling, because
				// /api/auth/* is publicly reachable through /agents/*.
				'/get-session': { window: 60, max: 2000 },
			},
		},
		// Guest sign-in (POST /sign-in/anonymous) - adds user.isAnonymous.
		plugins: [
			anonymous(),
			bearer(),
			// Teams for every project (and the console is the first user of its
			// own feature: frostbase orgs are rows in the console instance).
			organization({
				// Guests can hold sessions but never own teams.
				allowUserToCreateOrganization: (user) =>
					!(user as { isAnonymous?: boolean | null }).isAnonymous,
				organizationLimit: config.orgLimit,
				sendInvitationEmail: config.sendEmail
					? async (data, request) => {
							// The console surfaces pending invitations after sign-in, so
							// the link only needs to land the invitee on the login page
							// of the deployment the invite was minted from.
							const origin = request ? new URL(request.url).origin : config.trustedOrigins[0];
							await config.sendEmail?.({
								type: 'invitation',
								to: data.email,
								url: origin ? `${origin}/login` : '',
								invitation: {
									organization: data.organization.name,
									inviter: data.inviter.user.email,
								},
							});
						}
					: undefined,
			}),
			// GET /token issues a project-signed JWT (public keys on GET /jwks)
			// carrying the user's role so external services can authorize offline.
			jwt({
				jwt: {
					issuer: `cloudflarebase:${config.projectId}`,
					audience: config.projectId,
					definePayload: ({ user }) => {
						const role = (user as { role?: string }).role ?? 'user';
						return {
							email: user.email,
							role,
							permissions: config.getRolePermissions?.(role) ?? [],
						};
					},
				},
			}),
		],
		socialProviders: {
			...(config.google ? { google: config.google } : {}),
			...(config.github ? { github: config.github } : {}),
		},
		account: {
			accountLinking: {
				// Both providers attest verified emails, so "Continue with Google"
				// must also work for an address that signed up with a password and
				// never verified - Firebase's one-account-per-email behaviour. The
				// provider just proved the visitor owns the email, which outranks a
				// password whose holder never did: requireLocalEmailVerified is off,
				// and the account-creation hook below closes the takeover window
				// that gate existed for by dropping the never-verified credential
				// the moment a trusted provider supersedes it. Trust additionally
				// allows EXPLICIT /link-social from a live session.
				trustedProviders: TRUSTED_SOCIAL_PROVIDERS,
				requireLocalEmailVerified: false,
			},
		},
		user: {
			additionalFields: {
				// Simple RBAC. input: false blocks self-assignment at sign-up; the
				// dashboard's admin route is the only writer.
				role: { type: 'string', required: false, defaultValue: 'user', input: false },
			},
			changeEmail: {
				enabled: true,
				// A VERIFIED account approves the change from its current address;
				// unverified accounts (local dev with verification disabled) change
				// immediately - Better Auth's own rule. Without a mail transport the
				// verified path cannot complete, which is the honest failure.
				sendChangeEmailVerification: config.sendEmail
					? async ({ user, url }: { user: { email: string }; url: string }, request?: Request) =>
							config.sendEmail?.({
								type: 'email-change',
								to: user.email,
								url: resolveEmailCallback(url, request, config.trustedOrigins),
							})
					: undefined,
			},
		},
		session: {
			// Sliding expiry: Better Auth extends the session once per day of
			// use, so this bounds IDLE time. Revocation stays immediate.
			expiresIn: (config.sessionDays ?? 7) * 24 * 60 * 60,
			updateAge: 24 * 60 * 60,
			additionalFields: {
				country: { type: 'string', required: false, input: false },
			},
			// Signed cookie cache: for its lifetime a get-session is a local
			// signature check instead of a session-table read, so dashboard
			// polling stops being bounded by the one console instance's SQLite.
			// Revocations take up to maxAge to bite - keep it short.
			cookieCache: config.cookieCache ? { enabled: true, maxAge: 60 } : undefined,
		},
		advanced: {
			// Scope cookies per project so multiple project dashboards on the
			// same origin don't clobber each other's sessions.
			cookiePrefix: `cfb-${config.projectId}`,
			// Cloudflare resolves the client address at the edge and overwrites
			// any inbound attempt to spoof it. Without this, rate limiting
			// cannot see an IP and falls back to one shared per-path bucket,
			// where a single noisy client exhausts sign-in for everyone.
			ipAddress: {
				ipAddressHeaders: ['cf-connecting-ip'],
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const denied = await config.denyUserCreation?.(
							user as Pick<AuthHookUser, 'email' | 'isAnonymous'>,
						);
						if (denied) {
							throw new APIError('FORBIDDEN', { message: denied });
						}
						return { data: user };
					},
					after: async (user) => {
						if (config.autoPersonalOrg) {
							await ensurePersonalOrg(config.db, user as AuthHookUser);
						}
						await config.onUserCreated?.(user as AuthHookUser);
					},
				},
			},
			session: {
				create: {
					// Stamp the session with the country Cloudflare resolved for
					// the request that created it.
					before: async (session) => ({
						data: { ...session, country: config.getRequestCountry?.() ?? null },
					}),
					after: async (session) => {
						await config.onSessionActivity?.(session, 'created');
					},
				},
				update: {
					after: async (session) => {
						await config.onSessionActivity?.(session, 'refreshed');
					},
				},
			},
			account: {
				create: {
					// The other half of requireLocalEmailVerified: false above. This
					// hook runs before Better Auth flips emailVerified on the linked
					// user, so "trusted provider linked onto a STILL-unverified user"
					// means whoever set the local password never proved they own the
					// address - the provider sign-in just did. Drop that credential
					// and every pre-existing session so a pre-registered password
					// cannot linger as a backdoor into the linked account; the
					// provider becomes the way in, and the real owner re-adds a
					// password via reset if they want one. The session for this very
					// sign-in is created after the hook and survives.
					after: async (account) => {
						if (!TRUSTED_SOCIAL_PROVIDERS.includes(account.providerId)) return;
						const [owner] = await config.db
							.select({ emailVerified: schema.user.emailVerified })
							.from(schema.user)
							.where(eq(schema.user.id, account.userId))
							.limit(1);
						if (!owner || owner.emailVerified) return;
						const dropped = await config.db
							.delete(schema.account)
							.where(
								and(
									eq(schema.account.userId, account.userId),
									eq(schema.account.providerId, 'credential'),
								),
							)
							.returning({ id: schema.account.id });
						if (dropped.length > 0) {
							await config.db
								.delete(schema.session)
								.where(eq(schema.session.userId, account.userId));
						}
					},
				},
			},
		},
	});
}

export type ProjectAuth = ReturnType<typeof createProjectAuth>;
