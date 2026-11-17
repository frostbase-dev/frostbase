import { expect, test } from '@playwright/test';
import { configPath, consoleAuthPath, overviewPath, uniqueEmail } from './helpers';

/**
 * Phase A of the managed service: accounts,
 * organizations, and ownership on the console instance.
 *
 * The e2e stack runs the CLAIMED mode (CONSOLE_SIGNUPS unset), so this file
 * pins that mode's contract: strangers stay locked out, invited emails get
 * in, and org membership is what scopes project access. Open mode needs a
 * differently-configured agent worker and is not exercised here.
 */

test.describe('organizations and ownership', () => {
	test('the console reports its registration policy', async ({ request }) => {
		const config = await request.get(configPath('console'));
		expect(config.ok()).toBeTruthy();
		expect((await config.json()).consoleSignups).toBe('claimed');
	});

	test('the operator identity carries a personal organization', async ({ request }) => {
		const me = await request.get('/api/console/me');
		expect(me.ok(), await me.text()).toBeTruthy();
		const identity = await me.json();
		expect(identity.user.email).toBeTruthy();
		// Lazy heal: the owner predates organizations, and the first identity
		// lookup mints their personal org - so by now it must exist.
		expect(identity.organizations.length).toBeGreaterThanOrEqual(1);
		expect(identity.organizations[0].role).toBe('owner');
	});

	test('a stranger cannot register through the claimed console', async ({ request }) => {
		const signUp = await request.post(consoleAuthPath('sign-up/email'), {
			data: { name: 'Stranger', email: uniqueEmail('stranger'), password: 'stranger-pass-1' }
		});
		expect(signUp.status(), await signUp.text()).toBe(403);
	});

	test('an invited email registers, owns its org, and is scoped by it', async ({
		baseURL,
		playwright,
		request
	}) => {
		const me = await (await request.get('/api/console/me')).json();
		const operatorOrgId: string = me.organizations[0].id;

		// The invitation is the authorization that lets a sign-up through the
		// otherwise-closed console.
		const email = uniqueEmail('invitee');
		const invite = await request.post(consoleAuthPath('organization/invite-member'), {
			data: { email, role: 'member', organizationId: operatorOrgId }
		});
		expect(invite.ok(), await invite.text()).toBeTruthy();
		const invitation = await invite.json();
		expect(invitation.id).toBeTruthy();

		// A separate, cookie-less context: the invitee authenticates by bearer
		// token only, so the operator session can never leak into their calls.
		// The empty storageState is LOAD-BEARING: inside the test runner every
		// new context inherits the project's `use` options, operator session
		// included, unless overridden.
		const anon = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { origin: baseURL! },
			storageState: { cookies: [], origins: [] }
		});
		try {
			const signUp = await anon.post(consoleAuthPath('sign-up/email'), {
				data: { name: 'Invitee', email, password: 'invitee-pass-12' }
			});
			expect(signUp.ok(), await signUp.text()).toBeTruthy();
			const token = signUp.headers()['set-auth-token'];
			expect(token, 'the console issues bearer tokens like any project').toBeTruthy();
			const asInvitee = { authorization: `Bearer ${token}` };

			// The invitee's identity: their own personal org - and NOT the
			// invitation. Registering an address proves nothing here (claimed
			// consoles skip verification), and the id is what accepts the
			// invitation, so anyone who registered an invited address first used
			// to read it from this list and join the org. Only a verified
			// address, or the invite link, reveals it.
			const inviteeMe = await anon.get('/api/console/me', { headers: asInvitee });
			expect(inviteeMe.ok(), await inviteeMe.text()).toBeTruthy();
			const inviteeIdentity = await inviteeMe.json();
			expect(inviteeIdentity.user.emailVerified).toBe(false);
			expect(inviteeIdentity.organizations.length).toBeGreaterThanOrEqual(1);
			expect(inviteeIdentity.pendingInvitations).toEqual([]);

			// Nor through Better Auth's own by-email listing.
			const listed = await anon.get(consoleAuthPath('organization/list-user-invitations'), {
				headers: asInvitee
			});
			expect(listed.status()).toBe(404);

			// The invite link carries the id; holding it is the proof, and the
			// projects page then offers exactly that invitation.
			const viaLink = await anon.get(`/dashboard?invitation=${encodeURIComponent(invitation.id)}`, {
				headers: asInvitee
			});
			expect(viaLink.ok(), `${viaLink.status()}`).toBeTruthy();
			expect(await viaLink.text()).toContain('data-testid="accept-invitation"');
			const withoutLink = await anon.get('/dashboard', { headers: asInvitee });
			expect(await withoutLink.text()).not.toContain('data-testid="accept-invitation"');
			const inviteeOrgId: string = inviteeIdentity.organizations[0].id;
			expect(inviteeOrgId).not.toBe(operatorOrgId);

			// A project created by the invitee lands under THEIR org...
			const projectId = `org-scope-${Date.now().toString(36)}`;
			const created = await anon.post('/api/registry/projects', {
				headers: asInvitee,
				data: { id: projectId, name: 'Invitee project' }
			});
			expect(created.status(), await created.text()).toBe(201);
			expect((await created.json()).project.orgId).toBe(inviteeOrgId);

			try {
				// ...so the operator - not a member of it - is refused, and never
				// sees it listed. 404, the same answer an unminted id gets: a 403
				// here would confirm the id exists, which is an enumeration oracle
				// for other tenants' projects.
				const denied = await request.get(overviewPath(projectId));
				expect(denied.status(), await denied.text()).toBe(404);
				const operatorList = await (await request.get('/api/registry/projects')).json();
				expect(operatorList.projects.map((entry: { id: string }) => entry.id)).not.toContain(
					projectId
				);

				// The owner reads it fine through the same surface.
				const allowed = await anon.get(overviewPath(projectId), { headers: asInvitee });
				expect(allowed.ok(), await allowed.text()).toBeTruthy();

				// An ordinary operator is not an administrator. The console's own
				// instance - every operator account on this deployment, this
				// account included - answers to the admin role alone, and a
				// non-admin gets the same "no such project" as a stranger. Any
				// registered account used to reach it, delete operators from it,
				// and reassign their roles.
				for (const path of [
					overviewPath('console'),
					'/agents/auth-agent/console/admin/users',
					'/agents/auth-agent/console/overview'
				]) {
					const refused = await anon.get(path, { headers: asInvitee });
					expect(refused.status(), `${path} is admin-only`).toBe(404);
				}
				const consolePage = await anon.get('/dashboard/console', {
					headers: asInvitee,
					maxRedirects: 0
				});
				expect(consolePage.status()).toBe(303);

				// Accepting the invitation joins the operator's org.
				const accept = await anon.post(consoleAuthPath('organization/accept-invitation'), {
					headers: asInvitee,
					data: { invitationId: invitation.id }
				});
				expect(accept.ok(), await accept.text()).toBeTruthy();
				const after = await (await anon.get('/api/console/me', { headers: asInvitee })).json();
				expect(after.organizations.map((entry: { id: string }) => entry.id)).toContain(
					operatorOrgId
				);
				expect(
					after.organizations.find((entry: { id: string }) => entry.id === operatorOrgId).role
				).toBe('member');

				// ...as a MEMBER, which is permission to USE the org's projects and
				// nothing more. Membership is not consent to destroy: an erase fans
				// out across every agent and has no undo, so a teammate invited to
				// work on a project must not be able to take it, and everything the
				// rest of the org built on it, away.
				const orgProject = `org-member-${Date.now().toString(36)}`;
				const madeByOwner = await request.post('/api/registry/projects', {
					data: { id: orgProject, name: 'Owner project' }
				});
				expect(madeByOwner.status(), await madeByOwner.text()).toBe(201);
				try {
					const denied = await anon.delete(`/api/registry/projects/${orgProject}`, {
						headers: asInvitee
					});
					expect(denied.status(), 'a member may not delete the org’s project').toBe(403);

					// The member still reaches it - this is authorization, not
					// visibility. Taking the project away from them would be a
					// different (and wrong) answer.
					const readable = await anon.get(overviewPath(orgProject), { headers: asInvitee });
					expect(readable.ok(), 'a member still uses the project').toBeTruthy();

					// Nor may they rename the organization or invite into it. Better
					// Auth's own default roles enforce this; pinned here because the
					// console's UI and its project-delete rule are built on it.
					const renamed = await anon.post(consoleAuthPath('organization/update'), {
						headers: asInvitee,
						data: { organizationId: operatorOrgId, data: { name: 'Taken Over' } }
					});
					expect(renamed.ok(), 'a member may not rename the org').toBeFalsy();

					const reinvite = await anon.post(consoleAuthPath('organization/invite-member'), {
						headers: asInvitee,
						data: {
							email: uniqueEmail('member-invited'),
							role: 'member',
							organizationId: operatorOrgId
						}
					});
					expect(reinvite.ok(), 'a member may not invite into the org').toBeFalsy();
				} finally {
					// The OWNER can, which is the other half of the rule.
					const byOwner = await request.delete(`/api/registry/projects/${orgProject}`);
					expect(byOwner.ok(), await byOwner.text()).toBeTruthy();
				}
			} finally {
				// Reused local stacks cap at MAX_PROJECTS - leave nothing behind.
				const del = await anon.delete(`/api/registry/projects/${projectId}`, {
					headers: asInvitee
				});
				expect(del.ok(), await del.text()).toBeTruthy();
			}
		} finally {
			await anon.dispose();
		}
	});
});
