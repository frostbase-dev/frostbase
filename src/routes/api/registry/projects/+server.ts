import { activeOrg } from '$lib/console';
import {
	createProject,
	listProjects,
	mayReachUnownedProjects,
	operatorProjectScope
} from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * Project registry for this installation. Operator-only: the console guard in
 * hooks.server.ts rejects everything under /api that is not explicitly public,
 * so these handlers never run without a session - and locals.consoleIdentity
 * is already resolved.
 */

export const GET: RequestHandler = async ({ locals, platform }) => {
	// Scoped to the operator's memberships; unowned rows only for the console
	// admin (see mayReachUnownedProjects).
	return Response.json({
		projects: await listProjects(platform, operatorProjectScope(locals.consoleIdentity))
	});
};

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	// New projects belong to the creator's active org. Accounts without one
	// (agents from before organizations) keep minting unowned rows - exactly
	// the legacy visibility they already have.
	const org = locals.consoleIdentity ? activeOrg(locals.consoleIdentity) : null;
	// An unowned row is reachable by the console admin alone, so anyone else
	// minting one would create a project they could never open again.
	if (!org && !mayReachUnownedProjects(locals.consoleIdentity)) {
		return Response.json(
			{ error: 'create or join an organization before creating a project' },
			{ status: 409 }
		);
	}
	const result = await createProject(
		platform,
		await request.json().catch(() => null),
		org?.id ?? null
	);

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ project: result.project }, { status: 201 });
};
