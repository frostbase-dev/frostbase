import { consoleAuthConfig, consoleOwnerExists, getConsoleIdentity } from '$lib/server/console';
import { CONSOLE_SETUP_COOKIE, consoleSetupState } from '$lib/server/console-setup';
import { safeNext } from '$lib/safe-redirect';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The console sign-in page. Sign-in, first-run owner claim, and - when the
 * console reports open sign-ups - registration all POST from the browser to
 * the same-origin proxy at /api/projects/console/auth/*, which relays Better
 * Auth's Set-Cookie headers back unchanged - so this loader only decides
 * which forms to offer, from the console's own /config.
 */
export const load: PageServerLoad = async ({ cookies, locals, platform, request, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	// /login is an open route, so the guard never resolves a session for it
	// (locals.consoleUser is always null here) - resolved ourselves instead,
	// like the landing page does, so a signed-in operator bounces straight to
	// their destination instead of being offered a sign-in form again.
	// getConsoleIdentity no-ops without cookies, keeping anonymous visits free
	// of the agent round trip.
	const identity =
		locals.consoleIdentity ??
		(await getConsoleIdentity(
			platform,
			url.origin,
			request.headers.get('cookie'),
			null,
			request.headers.get('cf-connecting-ip')
		).catch(() => null));
	if (identity) redirect(303, next);

	const [ownerExists, authConfig, setup] = await Promise.all([
		consoleOwnerExists(platform, url.origin),
		consoleAuthConfig(platform, url.origin),
		// Only meaningful on the first run, but resolved unconditionally: it
		// reads env plus one HMAC, and branching here would just make the page
		// depend on the order two independent facts arrive in.
		consoleSetupState(platform, cookies.get(CONSOLE_SETUP_COOKIE), url.hostname)
	]);

	// An unlock is spent by the registration it was for. Once an owner exists
	// the claim is finished, so a grant still sitting in the browser is only a
	// leftover key to the reset - dropped here rather than left to expire.
	if (ownerExists && cookies.get(CONSOLE_SETUP_COOKIE)) {
		cookies.delete(CONSOLE_SETUP_COOKIE, { path: '/' });
	}

	return {
		next,
		ownerExists,
		socialProviders: authConfig.socialProviders,
		consoleSignups: authConfig.consoleSignups,
		localPasswordReset: authConfig.localPasswordReset,
		demoMode: locals.demoMode,
		// What the claim needs before it will be accepted (console-setup.ts).
		// Never the token itself - only whether one is configured.
		setup: {
			unlocked: setup.unlocked,
			tokenConfigured: setup.tokenConfigured,
			tokenTooShort: setup.tokenTooShort
		}
	};
};
