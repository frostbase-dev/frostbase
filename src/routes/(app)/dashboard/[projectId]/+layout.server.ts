import { isDemoProjectId } from '$lib/server/console';
import {
	demoBranchContext,
	getBranchContext,
	listProjects,
	operatorProjectScope,
	rememberDemoBranch
} from '$lib/server/registry';
import type { LayoutServerLoad } from './$types';

// The agent pane's open state and split sizes persist in a cookie (written by
// the dashboard layout on resize/toggle) so SSR renders the saved layout
// directly - restoring a resized pane never flashes the default widths.
// Format: "open:70:30" | "closed:70:30".
export const load: LayoutServerLoad = async ({ cookies, params, platform, locals }) => {
	const [state, ...rest] = (cookies.get('cfbase-copilot') ?? '').split(':');
	const sizes = rest.map(Number);
	const layout =
		sizes.length === 2 && sizes.every((size) => Number.isFinite(size) && size >= 15 && size <= 85)
			? sizes
			: null;
	const [branches, projects] = await Promise.all([
		// Null hides the branch controls (unregistered projects, unreachable
		// control plane). Demo families get a SYNTHESIZED context instead -
		// production/preview plus every branch this visitor minted (remembered
		// in a cookie, since demo branches are ids and not registry rows), so
		// demo visitors experience branching without touching the registry.
		// Re-runs only when the project param changes, so subpage navigation
		// costs no registry reads.
		locals.demoMode && isDemoProjectId(params.projectId)
			? Promise.resolve(
					demoBranchContext(params.projectId, rememberDemoBranch(cookies, params.projectId))
				)
			: getBranchContext(platform, params.projectId),
		// The breadcrumb project switcher's list - operators only, scoped to
		// their org memberships. Demo mode serves this layout to anonymous
		// visitors, and the installation's project registry must never appear
		// in their page data.
		locals.consoleUser
			? listProjects(platform, operatorProjectScope(locals.consoleIdentity ?? null))
			: Promise.resolve(null)
	]);

	// The header's account controls (avatar + editor). Null for anonymous demo
	// visitors - the guard never resolves a session on demo routes.
	const identity = locals.consoleIdentity;

	return {
		copilot: {
			open: state !== 'closed',
			layout
		},
		branches,
		projects,
		accountUser: identity
			? { name: identity.user.name, email: identity.user.email, image: identity.user.image }
			: null
	};
};
