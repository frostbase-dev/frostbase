<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { canAdministerOrg, CONSOLE_AUTH_BASE } from '$lib/console';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Mail, UsersRound } from '@lucide/svelte';
	import { onMount } from 'svelte';

	let { data } = $props();

	// Better Auth refuses invite/cancel/rename for a plain member on its own
	// endpoints, so this is not the security boundary - it is honesty. A form
	// that only ever answers "you cannot do that" should not be a form.
	const canAdminister = $derived(canAdministerOrg(data.org.role));

	interface MemberRow {
		id: string;
		role: string;
		user: { email: string; name: string };
	}
	interface InvitationRow {
		id: string;
		email: string;
		role: string | null;
		status: string;
		expiresAt: string;
	}

	// Members and pending invitations come straight from the console auth
	// instance's Better Auth organization endpoints, via the same-origin proxy
	// (session-authorized, so no server plumbing is needed here).
	let members = $state<MemberRow[]>([]);
	let invitations = $state<InvitationRow[]>([]);
	let listsLoading = $state(true);

	async function orgGet(endpoint: string): Promise<unknown> {
		const response = await fetch(
			`${CONSOLE_AUTH_BASE}/organization/${endpoint}?organizationId=${encodeURIComponent(data.org.id)}`
		);
		if (!response.ok) return null;
		return response.json().catch(() => null);
	}

	async function refreshLists() {
		const [memberBody, inviteBody] = await Promise.all([
			orgGet('list-members'),
			orgGet('list-invitations')
		]);
		const memberList = (memberBody as { members?: unknown[] } | null)?.members;
		members = (Array.isArray(memberList) ? memberList : []).flatMap((entry) => {
			const row = entry as Partial<MemberRow> & { user?: { email?: string; name?: string } };
			return row.id && row.user?.email
				? [
						{
							id: row.id,
							role: row.role ?? 'member',
							user: { email: row.user.email, name: row.user.name ?? row.user.email }
						}
					]
				: [];
		});
		invitations = (Array.isArray(inviteBody) ? inviteBody : []).flatMap((entry) => {
			const row = entry as Partial<InvitationRow>;
			return row.id && row.email && row.status === 'pending'
				? [
						{
							id: row.id,
							email: row.email,
							role: row.role ?? null,
							status: row.status,
							expiresAt: row.expiresAt ?? ''
						}
					]
				: [];
		});
		listsLoading = false;
	}

	onMount(() => {
		void refreshLists();
	});

	// Initial-value capture on purpose; renaming re-syncs via invalidateAll.
	// svelte-ignore state_referenced_locally
	let orgName = $state(data.org.name);
	let renameBusy = $state(false);
	let renameError = $state<string | null>(null);

	async function rename(event: SubmitEvent) {
		event.preventDefault();
		renameBusy = true;
		renameError = null;
		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/organization/update`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ organizationId: data.org.id, data: { name: orgName.trim() } })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				renameError = body?.message ?? 'Could not rename the organization.';
				return;
			}
			await invalidateAll();
		} catch {
			renameError = 'Could not reach the auth agent.';
		} finally {
			renameBusy = false;
		}
	}

	let inviteEmail = $state('');
	let inviteBusy = $state(false);
	let inviteError = $state<string | null>(null);
	let inviteSent = $state(false);

	async function invite(event: SubmitEvent) {
		event.preventDefault();
		inviteBusy = true;
		inviteError = null;
		inviteSent = false;
		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/organization/invite-member`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: inviteEmail.trim(),
					role: 'member',
					organizationId: data.org.id
				})
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				inviteError = body?.message ?? 'Could not send the invitation.';
				return;
			}
			inviteEmail = '';
			inviteSent = true;
			await refreshLists();
		} catch {
			inviteError = 'Could not reach the auth agent.';
		} finally {
			inviteBusy = false;
		}
	}

	// The invite link is what accepts an invitation - the console shows an
	// account whose address is unverified only the invitation it holds the link
	// to - so the inviter hands it over directly whenever mail cannot.
	let copiedInvitation = $state<string | null>(null);

	async function copyInviteLink(invitationId: string) {
		const link = new URL('/dashboard', location.origin);
		link.searchParams.set('invitation', invitationId);
		await navigator.clipboard.writeText(link.toString());
		copiedInvitation = invitationId;
		setTimeout(() => {
			if (copiedInvitation === invitationId) copiedInvitation = null;
		}, 2000);
	}

	let cancelBusy = $state<string | null>(null);

	async function cancelInvitation(invitationId: string) {
		if (cancelBusy) return;
		cancelBusy = invitationId;
		try {
			await fetch(`${CONSOLE_AUTH_BASE}/organization/cancel-invitation`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ invitationId })
			});
			await refreshLists();
		} finally {
			cancelBusy = null;
		}
	}
</script>

<svelte:head>
	<title>{data.org.name} · Organization · Frostbase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="space-y-8" data-testid="organization-page">
	<div class="space-y-1.5">
		<h1 class="text-2xl font-semibold tracking-tight" data-testid="org-name">
			{data.org.name}
		</h1>
		<p class="font-mono text-xs text-muted-foreground">{data.org.slug}</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2 text-base">
				<UsersRound class="h-4 w-4 text-muted-foreground" /> Members
			</Card.Title>
			<Card.Description>
				Members see and manage every project this organization owns.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if listsLoading}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{:else}
				<div class="divide-y overflow-hidden rounded-lg border" data-testid="member-list">
					{#each members as member (member.id)}
						<div class="flex items-center gap-3 px-4 py-3">
							<div
								class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary uppercase"
								aria-hidden="true"
							>
								{member.user.name.slice(0, 1)}
							</div>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{member.user.name}</p>
								<p class="truncate text-xs text-muted-foreground">{member.user.email}</p>
							</div>
							<Badge variant="outline" class="shrink-0 text-xs capitalize">{member.role}</Badge>
						</div>
					{/each}
				</div>
			{/if}

			{#if canAdminister}
				<form class="flex flex-wrap items-end gap-3" onsubmit={invite}>
					<div class="min-w-56 flex-1 space-y-1.5">
						<Label for="invite-email">Invite by email</Label>
						<Input
							id="invite-email"
							type="email"
							bind:value={inviteEmail}
							placeholder="teammate@example.com"
							required
						/>
					</div>
					<Button type="submit" disabled={inviteBusy} data-testid="invite-member">
						{inviteBusy ? 'Inviting…' : 'Send invitation'}
					</Button>
				</form>
			{:else}
				<p class="text-sm text-muted-foreground" data-testid="org-member-notice">
					Only owners and admins can invite people or rename this organization.
				</p>
			{/if}
			{#if inviteError}
				<p class="text-sm text-destructive" data-testid="invite-error">{inviteError}</p>
			{:else if inviteSent}
				<p class="text-sm text-muted-foreground" data-testid="invite-sent">
					Invitation created. Send the invitee its link - copy it below; an invitation email, when
					this console can send mail, carries the same link. They open it, then sign up (or in) with
					that email to accept.
				</p>
			{/if}

			{#if invitations.length}
				<div class="grid gap-2" data-testid="invitation-list">
					{#each invitations as invitation (invitation.id)}
						<div class="flex items-center gap-3 rounded-lg border border-dashed bg-card p-3">
							<Mail class="h-4 w-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm">{invitation.email}</p>
								<p class="text-xs text-muted-foreground">Pending invitation</p>
							</div>
							{#if canAdminister}
								<Button
									size="sm"
									variant="outline"
									data-testid="copy-invite-link"
									onclick={() => copyInviteLink(invitation.id)}
								>
									{copiedInvitation === invitation.id ? 'Copied' : 'Copy link'}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={cancelBusy === invitation.id}
									onclick={() => cancelInvitation(invitation.id)}
								>
									Cancel
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if canAdminister}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-base">Rename organization</Card.Title>
				<Card.Description>
					The name is display-only; project ids and data are untouched.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="flex flex-wrap items-end gap-3" onsubmit={rename}>
					<div class="min-w-56 flex-1 space-y-1.5">
						<Label for="org-name">Name</Label>
						<Input id="org-name" bind:value={orgName} required maxlength={64} />
					</div>
					<Button type="submit" variant="outline" disabled={renameBusy} data-testid="rename-org">
						{renameBusy ? 'Saving…' : 'Save'}
					</Button>
				</form>
				{#if renameError}
					<p class="mt-2 text-sm text-destructive">{renameError}</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
