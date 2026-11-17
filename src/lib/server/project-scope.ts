/**
 * Who may see which registry rows - pure, so a unit test can pin it without
 * a database or a Worker.
 */
import type { ConsoleIdentity } from '../console';

/** Which registry rows an operator-facing list may show. */
export interface ProjectScope {
	orgIds: string[];
	includeUnowned: boolean;
}

/**
 * Whether an operator may reach an unowned (org_id NULL) registry row.
 *
 * Those rows predate organizations, or were released by a console reset, and
 * used to be open to ANY operator - "the self-hosted contract, where every
 * operator is the same person". That premise fails the moment sign-ups are
 * open: every stranger who registers is an operator. Both legitimate holders
 * of such rows are the console admin (a single-operator install's first
 * account is made admin automatically, and so is the owner reclaiming a reset
 * console), so the admin role is the key, whatever the sign-up mode.
 */
export function mayReachUnownedProjects(identity: ConsoleIdentity | null): boolean {
	return identity?.user.role === 'admin';
}

/** The project-list scope for an operator: their orgs' rows, plus unowned
 * rows for the console admin only. */
export function operatorProjectScope(
	identity: ConsoleIdentity | null,
	orgIds: string[] = identity?.organizations.map((org) => org.id) ?? []
): ProjectScope {
	return { orgIds, includeUnowned: mayReachUnownedProjects(identity) };
}
