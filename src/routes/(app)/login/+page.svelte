<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ConsoleShell from '$lib/components/console-shell.svelte';
	import GithubLogo from '$lib/components/github-logo.svelte';
	import GoogleLogo from '$lib/components/google-logo.svelte';
	import { CONSOLE_AUTH_BASE } from '$lib/console';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { Component } from 'svelte';

	let { data } = $props();

	// First run: no owner yet, so the page claims the console instead of
	// signing in. Open mode has no claim step - the first account is just the
	// first sign-up - so claiming only ever renders in claimed mode.
	const claiming = $derived(!data.ownerExists && data.consoleSignups !== 'open');
	const open = $derived(data.consoleSignups === 'open');

	// A demo deployment has no operators at all - the agent refuses the claim,
	// so offering the form would only collect a doomed submission. The web and
	// agent DEMO_MODE flags only diverge in the e2e harness, which never
	// renders this page.
	const demoWithoutConsole = $derived(claiming && data.demoMode);

	// The first-run claim hands over the whole deployment, so it needs proof
	// the claimer controls it - a fresh deploy, or the setup token
	// (src/lib/server/console-setup.ts). Without one there is no form to offer:
	// submitting it would only be refused by the guard.
	const setupLocked = $derived(claiming && !data.demoMode && !data.setup.unlocked);
	let setupToken = $state('');
	let unlocking = $state(false);
	let unlockError = $state<string | null>(null);

	async function submitUnlock(event: SubmitEvent) {
		event.preventDefault();
		unlocking = true;
		unlockError = null;
		try {
			const response = await fetch('/api/console/setup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: setupToken })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				unlockError = body?.error ?? 'Could not unlock setup.';
				return;
			}
			setupToken = '';
			// Staying on the page - the load re-runs and the claim form replaces
			// this one. No goto, so none of the redirect races apply.
			await invalidateAll();
		} catch {
			unlockError = 'Could not reach the console.';
		} finally {
			unlocking = false;
		}
	}

	const socialLabels: Record<string, string> = {
		google: 'Google',
		github: 'GitHub'
	};
	const socialLogos: Record<string, Component<{ class?: string }>> = {
		google: GoogleLogo,
		github: GithubLogo
	};
	// Two known providers sit side by side with short labels; a lone or unknown
	// provider gets a full-width "Continue with …" button instead.
	const socialTwoUp = $derived(data.socialProviders.length > 1);

	// OAuth callback failures bounce back here with ?error=<code> - the
	// errorCallbackURL passed to sign-in/social - instead of Better Auth's
	// bare error page.
	const oauthErrors: Record<string, string> = {
		account_not_linked: 'This email signed up with a password - use it to sign in.',
		unable_to_create_user: 'Sign-up was refused. A claimed console admits invited emails only.',
		setup_locked: 'Console setup is locked - unlock it before claiming ownership.'
	};
	const oauthError = page.url.searchParams.get('error');

	// What the form submits. Open mode offers sign-in and sign-up; claimed mode
	// keeps sign-up behind the "invited?" link (the agent admits only emails
	// holding a pending invitation). ?signup=1 (the landing nav's Sign up
	// button) starts on the registration form; ?token= is the emailed
	// password-reset link landing back here to set the new password.
	const resetToken = page.url.searchParams.get('token');
	let mode = $state<'sign-in' | 'sign-up' | 'forgot' | 'reset'>(
		resetToken ? 'reset' : page.url.searchParams.has('signup') ? 'sign-up' : 'sign-in'
	);
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(
		oauthError
			? oauthError === 'INVALID_TOKEN'
				? 'That reset link is invalid or expired - request a new one.'
				: (oauthErrors[oauthError] ?? 'Social sign-in failed - try again.')
			: null
	);
	let submitting = $state(false);
	// Open-mode sign-up ends here: no session until the email is verified.
	let verifyNotice = $state(false);
	// Post-action confirmations that render above the sign-in form.
	let flowNotice = $state<string | null>(null);

	const signingUp = $derived(claiming || mode === 'sign-up');

	/**
	 * Forgot password. On a mail-configured deployment this is Better Auth's
	 * emailed-token flow: request-password-reset sends a link whose redirectTo
	 * lands back on /login?token=..., where the reset form completes it. In
	 * local dev (the agent reports localPasswordReset - its reset mail only
	 * lands in wrangler's .eml files) the flag-gated direct route resets the
	 * password in one step instead.
	 */
	async function submitForgot(event: SubmitEvent) {
		event.preventDefault();
		submitting = true;
		error = null;
		try {
			if (data.localPasswordReset) {
				const response = await fetch(`${CONSOLE_AUTH_BASE}/local-reset-password`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email, newPassword: password })
				});
				if (!response.ok) {
					const body = (await response.json().catch(() => null)) as { error?: string } | null;
					error = body?.error ?? 'Could not reset the password.';
					return;
				}
				flowNotice = 'Password updated - sign in with it below.';
				password = '';
				mode = 'sign-in';
				return;
			}

			const response = await fetch(`${CONSOLE_AUTH_BASE}/request-password-reset`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, redirectTo: '/login' })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				error = body?.message ?? 'Could not send the reset email.';
				return;
			}
			flowNotice = `If an account exists for ${email}, a reset link is on its way.`;
			mode = 'sign-in';
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}

	/** The emailed link's destination: exchange the token for a new password. */
	async function submitReset(event: SubmitEvent) {
		event.preventDefault();
		submitting = true;
		error = null;
		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/reset-password`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ newPassword: password, token: resetToken })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				error = body?.message ?? 'That reset link is invalid or expired - request a new one.';
				return;
			}
			flowNotice = 'Password updated - sign in with it below.';
			password = '';
			mode = 'sign-in';
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		submitting = true;
		error = null;

		try {
			const response = await fetch(
				`${CONSOLE_AUTH_BASE}/${signingUp ? 'sign-up' : 'sign-in'}/email`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					// callbackURL is where the emailed verification link lands after
					// verifying - the login page, not `/` (the marketing page on a
					// demo deployment). A failed unverified sign-in re-sends the
					// mail with the same destination.
					body: JSON.stringify(
						signingUp
							? { name, email, password, callbackURL: '/login' }
							: { email, password, callbackURL: '/login' }
					)
				}
			);

			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				error =
					body?.message ??
					(signingUp
						? 'Could not create the account.'
						: 'Incorrect email or password, or the email is not verified yet.');
				return;
			}

			// Open sign-ups require email verification, so there is usually no
			// session to land in yet - tell the visitor what happens next. A null
			// token is how Better Auth says "no session": a deployment that
			// disables verification (local dev) returns a real one, and that
			// sign-up falls through to the dashboard like a sign-in.
			if (signingUp && open) {
				const body = (await response.json().catch(() => null)) as { token?: string | null } | null;
				if (!body?.token) {
					verifyNotice = true;
					return;
				}
			}

			// ONE navigation, not invalidateAll-then-goto: invalidating while still
			// on /login re-runs this page's load, whose signed-in redirect races
			// the pending goto - the stale data read mid-unmount sent the browser
			// to /undefined.
			await goto(data.next, { invalidateAll: true });
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}

	/**
	 * Better Auth's social flow: the POST returns the provider's authorization
	 * URL and the browser navigates there; the OAuth callback lands the session
	 * cookie and redirects to callbackURL. In claimed mode unknown accounts
	 * bounce (the console refuses to create users beyond the owner and invited
	 * emails); open mode registers them implicitly. On the first-run claim the
	 * provider account simply becomes the owner.
	 */
	async function signInWithProvider(provider: string) {
		submitting = true;
		error = null;

		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/sign-in/social`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					provider,
					callbackURL: data.next,
					// Callback failures return here (?error=<code>) instead of
					// stranding the visitor on Better Auth's error page.
					errorCallbackURL: `/login?next=${encodeURIComponent(data.next)}`
				})
			});
			const body = (await response.json().catch(() => null)) as { url?: string } | null;

			if (!response.ok || !body?.url) {
				error = `Could not start ${socialLabels[provider] ?? provider} sign-in.`;
				return;
			}
			window.location.href = body.url;
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title
		>{demoWithoutConsole
			? 'Demo deployment'
			: setupLocked
				? 'Setup locked'
				: claiming
					? 'Set up your console'
					: 'Sign in'} · Frostbase</title
	>
	<meta name="robots" content="noindex" />
</svelte:head>

<ConsoleShell>
	{#if demoWithoutConsole}
		<div data-testid="console-demo-notice" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">This is a demo deployment</h1>
				<p class="text-sm text-muted-foreground">
					There is no console to set up here. Demo deployments have no operators: every visitor gets
					an anonymous, self-erasing project instead of an account.
				</p>
			</div>

			<div class="space-y-3">
				<Button href={resolve('/dashboard')} class="w-full">Try the demo</Button>
				<p class="text-xs text-muted-foreground">
					Running this deployment yourself? To get a private console with real projects, deploy
					without <code class="font-mono">DEMO_MODE</code>.
				</p>
			</div>
		</div>
	{:else if setupLocked}
		<div data-testid="console-setup-locked" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">Setup is locked</h1>
				<p class="text-sm text-muted-foreground">
					Nobody owns this console yet, and claiming it needs proof you deployed it - knowing the
					URL is not enough. Set a setup token from a terminal with access to this Cloudflare
					account:
				</p>
			</div>

			<code class="block rounded-md border bg-muted/50 p-2 font-mono text-xs"
				>npx wrangler secret put CONSOLE_SETUP_TOKEN</code
			>
			<p class="text-xs text-muted-foreground">
				At least 24 characters. It applies immediately - no redeploy - and you enter it once, here,
				to create the owner account.
			</p>

			<form class="space-y-4" onsubmit={submitUnlock} data-testid="console-setup-form">
				<div class="space-y-1.5">
					<Label for="setup-token">Setup token</Label>
					<Input
						id="setup-token"
						type="password"
						bind:value={setupToken}
						required
						autocomplete="off"
						data-testid="console-setup-token"
					/>
				</div>
				{#if data.setup.tokenTooShort}
					<p class="text-sm text-destructive">
						CONSOLE_SETUP_TOKEN is set but too short to be a credential - use at least 24
						characters.
					</p>
				{/if}
				{#if unlockError}
					<p class="text-sm text-destructive" data-testid="console-setup-error">{unlockError}</p>
				{/if}
				<Button
					type="submit"
					class="w-full"
					disabled={unlocking}
					data-testid="console-setup-submit"
				>
					{unlocking ? 'Working…' : 'Unlock setup'}
				</Button>
			</form>
		</div>
	{:else if verifyNotice}
		<div data-testid="console-verify-notice" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">Check your inbox</h1>
				<p class="text-sm text-muted-foreground">
					We sent a verification link to <span class="font-medium">{email}</span>. Follow it, then
					sign in - accounts only activate once their email is verified.
				</p>
			</div>
			<Button
				variant="outline"
				class="w-full"
				onclick={() => {
					verifyNotice = false;
					mode = 'sign-in';
				}}
			>
				Back to sign in
			</Button>
		</div>
	{:else}
		<div data-testid="console-login" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">
					{mode === 'forgot'
						? 'Reset your password'
						: mode === 'reset'
							? 'Set a new password'
							: claiming
								? 'Set up your console'
								: signingUp
									? 'Create your account'
									: 'Sign in'}
				</h1>
				<p class="text-sm text-muted-foreground">
					{#if mode === 'forgot'}
						{data.localPasswordReset
							? 'Local dev: set a new password for your account directly.'
							: 'Enter your account email and we will send a reset link.'}
					{:else if mode === 'reset'}
						Choose a new password for your account.
					{:else if claiming}
						No owner yet. Create the first account - sign-up closes as soon as it exists.
					{:else if signingUp && open}
						Your projects, your data, on Cloudflare's edge. Verification email included.
					{:else if signingUp}
						Invited to an organization? Register with the invited email address, then open your
						invite link to accept.
					{:else}
						Sign in to manage your projects.
					{/if}
				</p>
			</div>

			{#if flowNotice && mode === 'sign-in'}
				<p
					class="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
					data-testid="console-flow-notice"
				>
					{flowNotice}
				</p>
			{/if}

			{#if mode === 'forgot'}
				<form class="space-y-4" onsubmit={submitForgot} data-testid="console-forgot-form">
					<div class="space-y-1.5">
						<Label for="email">Email</Label>
						<Input id="email" type="email" bind:value={email} required autocomplete="email" />
					</div>
					{#if data.localPasswordReset}
						<div class="space-y-1.5">
							<Label for="password">New password</Label>
							<Input
								id="password"
								type="password"
								bind:value={password}
								required
								minlength={8}
								autocomplete="new-password"
							/>
						</div>
					{/if}
					{#if error}
						<p class="text-sm text-destructive" data-testid="console-login-error">{error}</p>
					{/if}
					<Button type="submit" class="w-full" disabled={submitting} data-testid="console-submit">
						{submitting
							? 'Working…'
							: data.localPasswordReset
								? 'Reset password'
								: 'Email me a reset link'}
					</Button>
				</form>
				<p class="text-center text-xs text-muted-foreground">
					Remembered it?
					<button
						type="button"
						class="underline"
						data-testid="console-mode-signin"
						onclick={() => {
							mode = 'sign-in';
							error = null;
						}}
					>
						Sign in
					</button>
				</p>
			{:else if mode === 'reset'}
				<form class="space-y-4" onsubmit={submitReset} data-testid="console-reset-form">
					<div class="space-y-1.5">
						<Label for="password">New password</Label>
						<Input
							id="password"
							type="password"
							bind:value={password}
							required
							minlength={8}
							autocomplete="new-password"
						/>
					</div>
					{#if error}
						<p class="text-sm text-destructive" data-testid="console-login-error">{error}</p>
					{/if}
					<Button type="submit" class="w-full" disabled={submitting} data-testid="console-submit">
						{submitting ? 'Working…' : 'Set new password'}
					</Button>
				</form>
				<p class="text-center text-xs text-muted-foreground">
					Link not working?
					<button
						type="button"
						class="underline"
						onclick={() => {
							mode = 'forgot';
							error = null;
						}}
					>
						Request a new one
					</button>
				</p>
			{:else}
				<!-- Also offered on the first-run claim: the agent admits the first
			     account on every path, so the owner can be a Google/GitHub identity. -->
				{#if data.socialProviders.length > 0}
					<div
						class="grid gap-2 {socialTwoUp ? 'grid-cols-2' : ''}"
						data-testid="console-social-providers"
					>
						{#each data.socialProviders as provider (provider)}
							{@const Logo = socialLogos[provider]}
							<Button
								type="button"
								variant="outline"
								class="w-full"
								disabled={submitting}
								aria-label="Continue with {socialLabels[provider] ?? provider}"
								onclick={() => signInWithProvider(provider)}
							>
								{#if Logo}<Logo class="size-4" />{/if}
								{socialTwoUp
									? (socialLabels[provider] ?? provider)
									: `Continue with ${socialLabels[provider] ?? provider}`}
							</Button>
						{/each}
					</div>

					<div class="flex items-center gap-3 text-xs text-muted-foreground">
						<span class="h-px flex-1 bg-border"></span>
						or continue with email
						<span class="h-px flex-1 bg-border"></span>
					</div>
				{/if}

				<form class="space-y-4" onsubmit={submit}>
					{#if signingUp}
						<div class="space-y-1.5">
							<Label for="name">Name</Label>
							<Input id="name" bind:value={name} required autocomplete="name" />
						</div>
					{/if}

					<div class="space-y-1.5">
						<Label for="email">Email</Label>
						<Input id="email" type="email" bind:value={email} required autocomplete="email" />
					</div>

					<div class="space-y-1.5">
						<div class="flex items-center justify-between">
							<Label for="password">Password</Label>
							{#if !signingUp}
								<button
									type="button"
									class="text-xs text-muted-foreground underline-offset-2 hover:underline"
									data-testid="console-forgot-link"
									onclick={() => {
										mode = 'forgot';
										error = null;
										flowNotice = null;
									}}
								>
									Forgot password?
								</button>
							{/if}
						</div>
						<Input
							id="password"
							type="password"
							bind:value={password}
							required
							minlength={signingUp ? 8 : undefined}
							autocomplete={signingUp ? 'new-password' : 'current-password'}
						/>
					</div>

					{#if error}
						<p class="text-sm text-destructive" data-testid="console-login-error">{error}</p>
					{/if}

					<Button
						type="submit"
						class="w-full bg-linear-to-b from-[oklch(0.67_0.148_246)] to-[oklch(0.6_0.152_251)] shadow-[0_1px_2px_oklch(0.45_0.14_252/35%),0_4px_18px_-6px_oklch(0.6341_0.1498_248.54/50%),inset_0_1px_0_oklch(1_0_0/22%)] transition-[filter] hover:brightness-105"
						disabled={submitting}
						data-testid="console-submit"
					>
						{submitting
							? 'Working…'
							: claiming
								? 'Create owner account'
								: signingUp
									? 'Create account'
									: 'Sign in'}
					</Button>
				</form>

				{#if !claiming}
					<p class="text-center text-xs text-muted-foreground">
						{#if signingUp}
							Already have an account?
							<button
								type="button"
								class="underline"
								data-testid="console-mode-signin"
								onclick={() => {
									mode = 'sign-in';
									error = null;
								}}
							>
								Sign in
							</button>
						{:else if open}
							New here?
							<button
								type="button"
								class="underline"
								data-testid="console-mode-signup"
								onclick={() => {
									mode = 'sign-up';
									error = null;
								}}
							>
								Create an account
							</button>
						{:else}
							<!-- Claimed consoles admit invited emails - teams without open
						     registration. -->
							Invited to an organization?
							<button
								type="button"
								class="underline"
								data-testid="console-mode-signup"
								onclick={() => {
									mode = 'sign-up';
									error = null;
								}}
							>
								Create your account
							</button>
						{/if}
					</p>
				{/if}
			{/if}
		</div>
	{/if}
</ConsoleShell>
