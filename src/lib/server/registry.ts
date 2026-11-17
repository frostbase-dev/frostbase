import * as Sentry from '@sentry/sveltekit';
import {
	CONSOLE_PROJECT_ID,
	demoRootId,
	isDemoProjectId,
	RESERVED_PROJECT_IDS
} from '$lib/console';
import { AGENT_REGISTRY, type AppAgentEntry } from '$lib/agent-registry';
import type { RegistryProject } from '$lib/agents';
import type { ProjectScope } from './project-scope';
import { getDb } from '$lib/server/db';
import { project, projectAgent } from '$lib/server/db/schema';
import { deleteProjectServiceKeys } from '$lib/server/service-keys';
import { requireAgent } from '$lib/server/agents';
import { projectIdSchema } from '$lib/schemas/auth';
import type { Cookies } from '@sveltejs/kit';
import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The project registry: which projects this installation owns.
 *
 * It lives in D1 on the dashboard Worker rather than inside an agent, because
 * it is a control-plane concern. A project will eventually have a db agent and
 * a storage agent as well as auth, so any agent owning the list would make
 * every other agent depend on that one - and deleting a project has to reach
 * all of them, which is why the fan-out below belongs here and not in the auth
 * worker.
 */

export const createProjectSchema = z.object({
	id: projectIdSchema
		.refine((value) => !RESERVED_PROJECT_IDS.has(value), 'that project id is reserved')
		// `--` is the branch separator: keeping it out
		// of NEW user-chosen ids is what makes `<root>--<branch>` unambiguous.
		// Rows that predate this rule stay valid - the registry's parent_id
		// column decides what is a branch, never the string shape.
		.refine((value) => !value.includes('--'), 'project ids may not contain "--"'),
	name: z.string().trim().min(1, 'name is required').max(64)
});

/** Branch names: short, id-charset, no `--` (it is the separator), and the
 * combined `<root>--<branch>` must still satisfy projectIdSchema's 48-char
 * ceiling - checked at create where the root id is known. */
export const branchNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,15}$/, 'Use lowercase letters, numbers, and hyphens only.')
	.refine((value) => !value.includes('--'), 'branch names may not contain "--"');

export const createBranchSchema = z.object({ branch: branchNameSchema });

/** Ceiling on one installation, to keep an accidental loop from filling D1.
 * A backstop, not a product limit - per-tenant fairness is the org ceiling. */
const MAX_PROJECTS = 1000;

/**
 * Per-tenant ceilings: root projects per owning org and branches per root.
 * Env-overridable (`MAX_PROJECTS_PER_ORG` / `MAX_BRANCHES_PER_ROOT`) so the
 * e2e stack and generous self-hosted installs can raise them. Unowned rows
 * (org_id NULL - legacy/pre-org installs) answer only to MAX_PROJECTS: with
 * no org to attribute them to, a per-tenant count would lump every legacy
 * operator into one bucket.
 */
const DEFAULT_MAX_PROJECTS_PER_ORG = 5;
const DEFAULT_MAX_BRANCHES_PER_ROOT = 5;

function envLimit(
	platform: App.Platform | undefined,
	name: 'MAX_PROJECTS_PER_ORG' | 'MAX_BRANCHES_PER_ROOT',
	fallback: number
): number {
	const parsed = Number.parseInt(platform?.env?.[name] ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toDto(row: {
	id: string;
	name: string;
	parentId: string | null;
	branchName: string | null;
	orgId: string | null;
	createdAt: Date;
}): RegistryProject {
	return {
		id: row.id,
		name: row.name,
		parentId: row.parentId,
		branchName: row.branchName,
		orgId: row.orgId,
		createdAt: row.createdAt.toISOString()
	};
}

export { mayReachUnownedProjects, operatorProjectScope, type ProjectScope } from './project-scope';

/**
 * Lists the installation's projects, oldest first. Returns an empty list
 * rather than throwing when the database cannot be reached, so a first-run
 * console renders its empty state instead of an error page.
 *
 * `scope` limits the list to rows the given organizations own, plus unowned
 * (org_id NULL) rows when `includeUnowned` is set - see `operatorProjectScope`
 * for who gets them. Omitting `scope` returns everything, and only callers
 * that genuinely need the whole registry may do that (the erase fan-out,
 * tests) - never an operator-facing list.
 */
export async function listProjects(
	platform: App.Platform | undefined,
	scope?: ProjectScope
): Promise<RegistryProject[]> {
	try {
		let where: SQL | undefined;
		if (scope) {
			const parts: SQL[] = [];
			if (scope.orgIds.length) parts.push(inArray(project.orgId, scope.orgIds));
			if (scope.includeUnowned) parts.push(isNull(project.orgId));
			if (!parts.length) return [];
			where = or(...parts);
		}
		const db = await getDb(platform);
		const rows = await db.select().from(project).where(where).orderBy(asc(project.createdAt));
		return rows.map(toDto);
	} catch (cause) {
		// Degrading to "no projects" is right for a first run but wrong to do
		// silently: on a real installation it means the control plane is
		// unreachable, and the console looks empty rather than broken.
		console.error('listing projects failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'list-projects' }
		});
		return [];
	}
}

export interface ProjectOwnership {
	/** Whether a registry row governs this id. */
	registered: boolean;
	/** The owning org; null on unowned rows (visible to any operator). */
	orgId: string | null;
	/**
	 * The control plane could not answer. Distinct from `registered: false`,
	 * and the guard depends on the difference: an unregistered id is nobody's
	 * project and is refused, so a D1 blip reported as "unregistered" would
	 * lock every operator out of every project instead of asking for a retry.
	 */
	unavailable?: boolean;
}

/**
 * The guard's per-request ownership lookup. `registered: false` means the id
 * is nobody's project, which the guard refuses - so an outage must NOT answer
 * that way. It answers `unavailable` instead, and the guard asks for a retry
 * rather than telling every operator their projects are gone.
 */
export async function getProjectOwnership(
	platform: App.Platform | undefined,
	projectId: string
): Promise<ProjectOwnership> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { registered: false, orgId: null };
	}
	try {
		const db = await getDb(platform);
		const [row] = await db
			.select({ orgId: project.orgId })
			.from(project)
			.where(eq(project.id, projectId))
			.limit(1);
		if (row) return { registered: true, orgId: row.orgId };
		return { registered: false, orgId: null };
	} catch (cause) {
		console.error('project ownership lookup failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'project-ownership', projectId }
		});
		return { registered: false, orgId: null, unavailable: true };
	}
}

/**
 * Isolate-local memo of project ids known to EXIST. Positives only: a project
 * is created once and then exists forever, so a stale `true` is impossible
 * (deletion is rare and costs at most one TTL of a 404 the agent answers
 * anyway), while caching `false` would give a project created seconds ago a
 * window where its own API denies it.
 */
const existsCache = new Map<string, number>();
const EXISTS_TTL_MS = 60_000;
const EXISTS_CACHE_MAX = 5_000;

/**
 * Whether a project id is one this installation actually knows.
 *
 * The PUBLIC product API needs this as much as the operator surfaces do, and
 * for a different reason: the agents provision a Durable Object on first
 * touch, so `POST /api/projects/<anything>/auth/sign-up/email` - a route that
 * is public by design, because a customer's app calls it without an operator -
 * created a fresh Durable Object with its own SQLite database for any id an
 * anonymous caller invented. Unbounded, unowned, unerasable by anyone, and
 * billable. Existence is the cheapest fact that stops it.
 *
 * Answers `null` when the control plane cannot be reached, so the caller can
 * decide: the operator paths fail closed, the product API fails OPEN (a D1
 * blip must not take every customer's app down with it).
 */
export async function projectExists(
	platform: App.Platform | undefined,
	projectId: string
): Promise<boolean | null> {
	if (!projectIdSchema.safeParse(projectId).success) return false;

	const cached = existsCache.get(projectId);
	if (cached !== undefined && Date.now() - cached < EXISTS_TTL_MS) return true;

	const ownership = await getProjectOwnership(platform, projectId);
	if (ownership.unavailable) return null;
	if (!ownership.registered) return false;

	// Cheap bound rather than an LRU: the working set is one entry per live
	// project per isolate, and a full clear costs one D1 read per project.
	if (existsCache.size >= EXISTS_CACHE_MAX) existsCache.clear();
	existsCache.set(projectId, Date.now());
	return true;
}

/** One registry row, or null for unregistered ids and an unreachable control
 * plane - callers degrade (the settings page explains) instead of erroring. */
export async function getProject(
	platform: App.Platform | undefined,
	projectId: string
): Promise<RegistryProject | null> {
	if (!projectIdSchema.safeParse(projectId).success) return null;
	try {
		const db = await getDb(platform);
		const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
		return row ? toDto(row) : null;
	} catch (cause) {
		console.error('loading project failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'get-project', projectId }
		});
		return null;
	}
}

export type RenameProjectResult =
	{ ok: true; project: RegistryProject } | { ok: false; status: number; error: string };

/** Renames a project's display NAME. The id is the Durable Object name in
 * every agent and is immutable by construction - names are the only
 * user-editable identity, and they stay non-unique on purpose. */
export async function renameProject(
	platform: App.Platform | undefined,
	projectId: string,
	input: unknown
): Promise<RenameProjectResult> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}
	const parsed = createProjectSchema.pick({ name: true }).safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid name' };
	}

	const db = await getDb(platform);
	const [updated] = await db
		.update(project)
		.set({ name: parsed.data.name })
		.where(eq(project.id, projectId))
		.returning();
	if (!updated) return { ok: false, status: 404, error: 'no such project' };
	return { ok: true, project: toDto(updated) };
}

export type CreateProjectResult =
	{ ok: true; project: RegistryProject } | { ok: false; status: number; error: string };

export async function createProject(
	platform: App.Platform | undefined,
	input: unknown,
	orgId: string | null = null
): Promise<CreateProjectResult> {
	const parsed = createProjectSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid project' };
	}
	if (isDemoProjectId(parsed.data.id)) {
		// Demo-shaped ids are never registry rows: demos are throwaway 30-day
		// instances whose agents cap and self-erase them by id shape, and the
		// guard grants them anonymous access on the same shape. A registered
		// row would contradict both.
		return { ok: false, status: 400, error: 'demo ids are reserved for throwaway demos' };
	}

	const db = await getDb(platform);

	const [existing] = await db.select().from(project).where(eq(project.id, parsed.data.id)).limit(1);
	if (existing) {
		return { ok: false, status: 409, error: 'that project id is already taken' };
	}

	const rows = await db.select({ id: project.id }).from(project);
	if (rows.length >= MAX_PROJECTS) {
		return {
			ok: false,
			status: 409,
			error: `this installation is limited to ${MAX_PROJECTS} projects`
		};
	}

	if (orgId) {
		// Roots only: branches have their own per-root ceiling, so one tenant
		// tops out at maxRoots × (1 + maxBranches) registry rows.
		const limit = envLimit(platform, 'MAX_PROJECTS_PER_ORG', DEFAULT_MAX_PROJECTS_PER_ORG);
		const owned = await db
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.orgId, orgId), isNull(project.parentId)));
		if (owned.length >= limit) {
			return {
				ok: false,
				status: 409,
				error: `your organization is limited to ${limit} projects for now - delete one to make room`
			};
		}
	}

	const [created] = await db
		.insert(project)
		.values({ id: parsed.data.id, name: parsed.data.name, orgId, createdAt: new Date() })
		.returning();

	await enableRegistryAgents(db, created.id);

	return { ok: true, project: toDto(created) };
}

/** Every registry agent is enabled by default. Deletion never reads these
 * rows (erase always fans out to every agent), so this is bookkeeping the
 * console can build on, not a gate user data depends on. */
async function enableRegistryAgents(
	db: Awaited<ReturnType<typeof getDb>>,
	projectId: string
): Promise<void> {
	await db
		.insert(projectAgent)
		.values(
			Object.values(AGENT_REGISTRY).map(({ manifest }) => ({
				projectId,
				agent: manifest.name,
				enabledAt: new Date()
			}))
		)
		.onConflictDoNothing();
}

export type CreateBranchResult =
	{ ok: true; project: RegistryProject } | { ok: false; status: number; error: string };

/**
 * Mints a branch of a root project: a full registry row whose id is
 * `<rootId>--<branch>`. The derived id IS the
 * isolation - every agent keys on project id, so the branch gets its own
 * Durable Objects, JWKS keypair, replicas, and analytics with zero agent
 * involvement. v1 branches start empty, like a fresh project.
 */
export async function createBranch(
	platform: App.Platform | undefined,
	rootId: string,
	input: unknown
): Promise<CreateBranchResult> {
	if (!projectIdSchema.safeParse(rootId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}
	if (isDemoProjectId(rootId)) {
		// A demo project IS an ephemeral branch already; it never gets its own.
		return { ok: false, status: 400, error: 'demo projects cannot have branches' };
	}
	const parsed = createBranchSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid branch' };
	}
	if (parsed.data.branch === 'main') {
		return { ok: false, status: 400, error: '"main" is the root project itself' };
	}

	const db = await getDb(platform);
	const [root] = await db.select().from(project).where(eq(project.id, rootId)).limit(1);
	if (!root) return { ok: false, status: 404, error: 'no such project' };
	if (root.parentId) {
		return { ok: false, status: 400, error: 'branches cannot have branches - branch the root' };
	}

	const branchId = `${rootId}--${parsed.data.branch}`;
	if (!projectIdSchema.safeParse(branchId).success) {
		return {
			ok: false,
			status: 400,
			error: 'the combined id exceeds 48 characters - use a shorter branch name'
		};
	}
	const [existing] = await db.select().from(project).where(eq(project.id, branchId)).limit(1);
	if (existing) {
		return { ok: false, status: 409, error: 'that branch already exists' };
	}
	const rows = await db.select({ id: project.id }).from(project);
	if (rows.length >= MAX_PROJECTS) {
		return {
			ok: false,
			status: 409,
			error: `this installation is limited to ${MAX_PROJECTS} projects`
		};
	}
	const limit = envLimit(platform, 'MAX_BRANCHES_PER_ROOT', DEFAULT_MAX_BRANCHES_PER_ROOT);
	const siblings = await db
		.select({ id: project.id })
		.from(project)
		.where(eq(project.parentId, rootId));
	if (siblings.length >= limit) {
		return {
			ok: false,
			status: 409,
			error: `each project is limited to ${limit} branches for now - delete one to make room`
		};
	}

	const [created] = await db
		.insert(project)
		.values({
			id: branchId,
			name: `${root.name} (${parsed.data.branch})`,
			parentId: rootId,
			branchName: parsed.data.branch,
			// A branch belongs to whoever owns its root - ownership follows the
			// family, never the individual row.
			orgId: root.orgId,
			createdAt: new Date()
		})
		.returning();

	await enableRegistryAgents(db, created.id);

	return { ok: true, project: toDto(created) };
}

export interface BranchContext {
	/** The root project id (the current project itself when it is not a branch). */
	rootId: string;
	/** Branch name of the CURRENT project; null when it is the root (`main`). */
	current: string | null;
	/** The root's branches, oldest first. */
	branches: RegistryProject[];
	/** Synthesized demo context: branches are id-derived, never registry rows,
	 * and creation is client-side navigation instead of POST /branches. */
	demo?: boolean;
}

/** Demo branches a visitor has minted, so they survive navigating away. */
const DEMO_BRANCH_COOKIE = 'cfbase-demo-branches';
const MAX_REMEMBERED_DEMO_BRANCHES = 8;

/**
 * Reads - and updates - the visitor's remembered demo branches.
 *
 * Demo branches are never registry rows, so without this the branch a visitor
 * just created would vanish from the switcher the moment they navigated to
 * another one: the context is derived from the id, and the id is gone. The
 * cookie is the smallest thing that can remember them, describes exactly ONE
 * demo family (a new demo starts over), and expires with the demo itself.
 */
export function rememberDemoBranch(cookies: Cookies, projectId: string): string[] {
	if (!isDemoProjectId(projectId)) return [];
	const rootId = demoRootId(projectId);
	const current = projectId === rootId ? null : projectId.slice(rootId.length + 2);

	const [storedRoot, stored = ''] = (cookies.get(DEMO_BRANCH_COOKIE) ?? '').split('|');
	const known = storedRoot === rootId ? stored.split(',') : [];
	const names = known.filter((name) => branchNameSchema.safeParse(name).success);
	if (current && !names.includes(current)) names.push(current);
	const kept = names.slice(-MAX_REMEMBERED_DEMO_BRANCHES);

	const value = `${rootId}|${kept.join(',')}`;
	if (value !== `${storedRoot}|${stored}`) {
		cookies.set(DEMO_BRANCH_COOKIE, value, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24
		});
	}
	return kept;
}

/**
 * Branch context for a DEMO project family - synthesized, never stored.
 * Every demo gets production and preview branches (plus the ones this visitor
 * minted, remembered in a cookie), derived purely from the id: the broadened
 * demo pattern gives each branch instance the same caps and TTL erasure as its
 * root, so nothing needs registering for ids that erase themselves.
 */
export function demoBranchContext(
	projectId: string,
	remembered: string[] = []
): BranchContext | null {
	if (!isDemoProjectId(projectId)) return null;
	const rootId = demoRootId(projectId);
	// The bare root IS production - demos have no `main`, so the default
	// branch the visitor lands on already carries the production name.
	const current = projectId === rootId ? 'production' : projectId.slice(rootId.length + 2);
	const names = ['production', 'preview'];
	for (const name of [...remembered, current]) {
		if (!names.includes(name)) names.push(name);
	}
	const branches = names
		.map((branchName) => ({
			id: branchName === 'production' ? rootId : `${rootId}--${branchName}`,
			name: `Demo (${branchName})`,
			parentId: rootId,
			branchName,
			orgId: null,
			createdAt: new Date(0).toISOString()
		}))
		.filter((branch) => projectIdSchema.safeParse(branch.id).success);
	if (branches.length === 0) return null;
	return { demo: true, rootId, current, branches };
}

/**
 * The header branch switcher's data: the current project's root and that
 * root's branches. Null for demo ids, unregistered projects, and an
 * unreachable control plane - the dashboard hides the control instead of
 * failing the layout, and a capture keeps the degraded case visible.
 */
export async function getBranchContext(
	platform: App.Platform | undefined,
	projectId: string
): Promise<BranchContext | null> {
	// Demo-shaped ids are never registry rows; they miss the row lookup and
	// return null like any other unregistered id.
	if (!projectIdSchema.safeParse(projectId).success) return null;
	try {
		const db = await getDb(platform);
		const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
		if (!row) return null;
		const rootId = row.parentId ?? row.id;
		const rows = await db
			.select()
			.from(project)
			.where(eq(project.parentId, rootId))
			.orderBy(asc(project.createdAt));
		return { rootId, current: row.branchName, branches: rows.map(toDto) };
	} catch (cause) {
		console.error('loading branch context failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'branch-context', projectId }
		});
		return null;
	}
}

/** A root project's branches, oldest first (the switcher's data). */
export async function listBranches(
	platform: App.Platform | undefined,
	rootId: string
): Promise<RegistryProject[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(project)
		.where(eq(project.parentId, rootId))
		.orderBy(asc(project.createdAt));
	return rows.map(toDto);
}

export type DeleteProjectResult =
	{ ok: true; warning?: string } | { ok: false; status: number; error: string };

/**
 * Removes a project's registration and erases its data in every agent.
 *
 * Both halves matter: dropping only the row would strand Durable Objects still
 * holding real user records with nothing left that could reach or delete them.
 * The fan-out lives here because the console is the only component that knows
 * which agents exist - today that is the auth agent, and each new agent adds a
 * call rather than a dependency between agents.
 */
export async function deleteProject(
	platform: App.Platform | undefined,
	projectId: string
): Promise<DeleteProjectResult> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}

	const db = await getDb(platform);

	// Deleting a ROOT deletes its branches first - the db registry's
	// child-first invariant one level up: no branch row may outlive the root
	// it hangs off, and each branch is a full project erase of its own.
	const branches = await db
		.select({ id: project.id })
		.from(project)
		.where(eq(project.parentId, projectId));
	const failures: string[] = [];
	for (const branch of branches) {
		await db.delete(project).where(eq(project.id, branch.id));
		for (const failure of await eraseProjectData(platform, branch.id)) {
			failures.push(`${failure} (${branch.id})`);
		}
	}

	const deleted = await db.delete(project).where(eq(project.id, projectId)).returning();
	if (!deleted.length) {
		return { ok: false, status: 404, error: 'no such project' };
	}

	const family = [projectId, ...branches.map((branch) => branch.id)];
	// Service keys die with their project - per member of the family, since a
	// key is scoped to exactly one registry row rather than to a root.
	for (const member of family) await deleteProjectServiceKeys(platform, member);

	failures.push(...(await eraseProjectData(platform, projectId)));
	if (failures.length) {
		return { ok: true, warning: `data could not be erased in: ${failures.join(', ')}` };
	}
	return { ok: true };
}

/**
 * Erases every operator account on the deployment, to reclaim a console whose
 * owner is not you (src/lib/server/console-setup.ts). Only ever reached with a
 * setup token, which needs Cloudflare account credentials to set.
 *
 * NOT the usual fan-out. The console is not a project, so most agents have no
 * instance under that id - and asking them anyway made a reset that had ALREADY
 * destroyed the accounts answer 502 because an unrelated agent was unreachable.
 * A destructive call must not report failure for work it did.
 *
 * Two agents do hold console state, and both are wiped: AUTH carries the
 * operator accounts, and DB carries the copilot transcripts those operators
 * wrote (`$lib/server/copilot-store`). Leaving the transcripts behind would
 * hand the next owner of a reclaimed console the previous one's conversations.
 * The auth erase is the one whose failure aborts the reset - accounts are what
 * "reset" means; the transcript wipe is best-effort behind it, because a
 * console that could not be reclaimed is worse than one whose chat history
 * outlived a hiccup.
 *
 * The org release is the other half of the recovery, not a side effect: every
 * account in the console dies with the instance, so registry rows stamped with
 * one of their orgs would be owned by an org that no longer exists and the
 * guard would refuse them to everyone, forever. A null org is the legacy
 * self-hosted contract - visible to any operator - which is exactly what a
 * reclaimed single-operator install wants. It runs only after the erase
 * succeeds, so a failed reset changes nothing at all.
 */
export async function resetConsoleOperators(
	platform: App.Platform | undefined
): Promise<{ erased: boolean; projectsReleased: number }> {
	if (!(await eraseAgentProject(platform, AGENT_REGISTRY.auth, CONSOLE_PROJECT_ID))) {
		return { erased: false, projectsReleased: 0 };
	}
	// Best-effort, and deliberately not allowed to fail the reset: see above.
	await eraseAgentProject(platform, AGENT_REGISTRY.db, CONSOLE_PROJECT_ID);

	const released = await (
		await getDb(platform)
	)
		.update(project)
		.set({ orgId: null })
		.where(isNotNull(project.orgId))
		.returning({ id: project.id });
	return { erased: true, projectsReleased: released.length };
}

/** One agent's erase. False means it could not be reached or refused. */
async function eraseAgentProject(
	platform: App.Platform | undefined,
	entry: AppAgentEntry,
	projectId: string
): Promise<boolean> {
	const { manifest } = entry;
	try {
		const agent = requireAgent(platform, entry);
		// Synthetic host: the erase route sits outside /agents/* on purpose,
		// reachable only over the service binding.
		const path = manifest.erase.path.replace(':projectId', encodeURIComponent(projectId));
		const response = await agent.fetch(`https://${manifest.worker}${path}`, {
			method: manifest.erase.method
		});
		if (!response.ok) throw new Error(`${manifest.name} agent responded ${response.status}`);
		return true;
	} catch (cause) {
		// A failed erase leaves a project's data behind after the operator
		// deleted it - a retention problem, not a cosmetic one. Callers only
		// surface a warning string, so capture it or nobody finds out.
		console.error(`failed to erase project "${projectId}" in the ${manifest.name} agent`, cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { projectId, agent: manifest.name, operation: 'erase-project' }
		});
		return false;
	}
}

/** Fan-out erase. Returns the names of agents that could not be reached. */
async function eraseProjectData(
	platform: App.Platform | undefined,
	projectId: string
): Promise<string[]> {
	const failures: string[] = [];

	for (const entry of Object.values(AGENT_REGISTRY)) {
		if (!(await eraseAgentProject(platform, entry, projectId))) {
			failures.push(entry.manifest.name);
		}
	}

	return failures;
}
