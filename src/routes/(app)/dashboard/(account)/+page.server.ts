import { activeOrg } from '$lib/console';
import { getConsoleIdentity } from '$lib/server/console';
import { isCrawler } from '$lib/server/crawler';
import { recordDemoProject } from '$lib/server/demo-log';
import { listProjects, operatorProjectScope } from '$lib/server/registry';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const COOKIE = 'cfb-demo-project';
// Roots only - the cookie remembers what this flow minted, never a branch.
// 12 hex now (17-char root), so `--production` still fits the 48-char
// project-id ceiling; 20-hex ids from before demo branches stay resumable.
const PROJECT_PATTERN = /^demo-[a-f0-9]{12,20}$/;

/**
 * The console entry point, which behaves differently for the two audiences
 * this deployment serves.
 *
 * On the public demo an anonymous visitor is handed their own throwaway
 * project, remembered in a cookie so a reload returns to the same one. For a
 * signed-in operator - the only case on a self-hosted install - it always
 * renders the overview: this page IS project and organization management
 * (org switcher, invitations, the Organization settings link, new-project),
 * so it never auto-forwards into a project. It used to skip the list when
 * exactly one project existed, which - once every account owned a personal
 * org - made "All projects" bounce straight back and left the org surfaces
 * unreachable.
 */
export const load: PageServerLoad = async ({ cookies, locals, platform, request, url }) => {
	if (locals.demoMode && !locals.consoleUser) {
		// A crawler is an anonymous visitor, so it used to be handed a real demo
		// project - one Durable Object and one all-time counter row per crawl,
		// for traffic that will never open it. Send it to the page that is
		// actually meant to be indexed instead; the console carries
		// X-Robots-Tag: noindex either way (hooks.server.ts).
		if (isCrawler(request.headers.get('user-agent'))) redirect(307, '/');

		let projectId = cookies.get(COOKIE);
		if (!projectId || !PROJECT_PATTERN.test(projectId)) {
			projectId = `demo-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
			// The all-time demo counter on /admin; recordDemoProject never rejects.
			platform?.ctx.waitUntil(recordDemoProject(platform, projectId));
			cookies.set(COOKIE, projectId, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: true,
				maxAge: 60 * 60 * 24 * 30
			});
		}
		redirect(307, `/dashboard/${projectId}`);
	}

	// The overview lists the ACTIVE org's projects, plus unowned rows for the
	// console admin. An account with no org gets no org rows - never the
	// unscoped registry, which on an open-signup console is every tenant's.
	// The sidebar's org data comes from the (account) layout load; this page
	// adds the active org's project list and the invitation banner.
	const identity = locals.consoleIdentity;
	const active = identity ? activeOrg(identity) : null;
	const projects = await listProjects(
		platform,
		operatorProjectScope(identity ?? null, active ? [active.id] : [])
	);

	// An invite link (?invitation=<id>) is how an account with an unverified
	// address - every account on a claimed console without mail - reaches its
	// invitation: the guard's identity lists invitations only for verified
	// addresses, because the id is what accepts one. Holding the link is the
	// proof, so resolve that one invitation for this session.
	let pendingInvitations = identity?.pendingInvitations ?? [];
	const linked = url.searchParams.get('invitation');
	if (identity && linked && !pendingInvitations.some((entry) => entry.id === linked)) {
		const withLinked = await getConsoleIdentity(
			platform,
			url.origin,
			request.headers.get('cookie'),
			request.headers.get('authorization'),
			request.headers.get('cf-connecting-ip'),
			linked
		);
		pendingInvitations = withLinked?.pendingInvitations ?? pendingInvitations;
	}

	return { projects, pendingInvitations };
};
