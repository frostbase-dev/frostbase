<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { scrollY } from 'svelte/reactivity/window';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { Button } from '$lib/components/ui/button';
	import CodeExamples from '$lib/components/code-examples.svelte';
	import ModeToggle from '$lib/components/mode-toggle.svelte';
	import { buildDbIntegrationExamples, buildIntegrationExamples } from '$lib/integration-examples';
	import { WORLD_OUTLINE_PATH } from '$lib/world-outline';
	import PricingCalculator from '$lib/components/pricing-calculator.svelte';
	import { cn } from '$lib/utils';
	import {
		Menu,
		X,
		ArrowRight,
		Check,
		Copy,
		ChevronDown,
		Database,
		GitFork,
		KeyRound,
		Globe,
		Radio,
		Star,
		Boxes,
		HardDrive,
		Minus
	} from '@lucide/svelte';

	let { data } = $props();

	// Deliberately short: the header is not a table of contents. Everything
	// else stays reachable by scroll and the footer links.
	type MenuItem = { name: string; href: string };
	let menuItems: MenuItem[] = [
		{ name: 'Pricing', href: '#pricing' },
		{ name: 'Compare', href: '#compare' },
		{ name: 'API', href: '#api' },
		{ name: 'Architecture', href: '#architecture' },
		{ name: 'Primitives', href: '#roadmap' },
		{ name: 'FAQ', href: '#faq' }
	];

	let menuState = $state(false);
	let isScrolled = $derived.by(() => (scrollY.current ?? 0) > 50);

	const runtime = [
		'Workers',
		'Durable Objects',
		'Agents SDK',
		'Better Auth',
		'Drizzle ORM',
		'Workers AI',
		'Analytics Engine'
	];

	// The install section's two one-liners: the CLI command and its
	// agent-shaped twin, which points at /agents.md (static/agents.md) - the
	// setup instructions written for coding agents, throwaway demo path
	// included. Copy state is per box so one click never flips the other icon.
	const installCommand = 'npx @frostbase-dev/cli init my-backend';
	const agentPrompt = 'Read frostbase.dev/agents.md and set up Frostbase in this project';
	const agentNames = ['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'Cursor'];
	let copiedInstall = $state<'cli' | 'agent' | null>(null);
	let copyInstallTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyInstall(kind: 'cli' | 'agent', text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedInstall = kind;
			clearTimeout(copyInstallTimer);
			copyInstallTimer = setTimeout(() => (copiedInstall = null), 1500);
		} catch {
			// clipboard unavailable - the text stays selectable
		}
	}

	// The comparison matrix. Cells are a rating plus a short receipt - never a
	// bare checkmark. Competitor cells stay qualitative on purpose: exact
	// prices live once, with dated sources, on /pricing.
	type CompareCell = { mark: 'yes' | 'no' | 'partial'; note: string };
	type CompareRow = {
		capability: string;
		cfb: CompareCell;
		firebase: CompareCell;
		supabase: CompareCell;
	};
	const compareRows: CompareRow[] = [
		{
			capability: 'Authentication',
			cfb: { mark: 'yes', note: 'Better Auth in a per-project agent' },
			firebase: { mark: 'yes', note: 'Firebase Auth' },
			supabase: { mark: 'yes', note: 'Supabase Auth' }
		},
		{
			capability: 'Documents with live queries',
			cfb: { mark: 'yes', note: 'a Durable Object per collection' },
			firebase: { mark: 'yes', note: 'Firestore' },
			supabase: { mark: 'partial', note: 'JSONB columns + realtime channels' }
		},
		{
			capability: 'Typed SQL tables',
			cfb: { mark: 'yes', note: 'ORM-ready schema, gated raw SQL' },
			firebase: { mark: 'no', note: 'documents only' },
			supabase: { mark: 'yes', note: 'Postgres' }
		},
		{
			capability: 'Branching',
			cfb: { mark: 'yes', note: 'the whole backend - auth included - free' },
			firebase: { mark: 'no', note: 'clone the project by hand' },
			supabase: { mark: 'partial', note: 'database only, paid' }
		},
		{
			capability: 'Read replicas near users',
			cfb: { mark: 'yes', note: 'on by default, per collection' },
			firebase: { mark: 'partial', note: 'region fixed at create' },
			supabase: { mark: 'partial', note: 'paid add-on' }
		},
		{
			capability: 'Point-in-time restore',
			cfb: { mark: 'yes', note: '30 days, built in' },
			firebase: { mark: 'partial', note: 'paid, up to 7 days' },
			supabase: { mark: 'partial', note: 'paid add-on' }
		},
		{
			capability: 'Egress fees',
			cfb: { mark: 'yes', note: '$0 bandwidth' },
			firebase: { mark: 'no', note: 'metered per GB' },
			supabase: { mark: 'partial', note: 'metered past the cap' }
		},
		{
			capability: 'Compliance',
			cfb: { mark: 'yes', note: "your Cloudflare account's certs - no new data processor" },
			firebase: { mark: 'partial', note: "Google's certs, but another processor to review" },
			supabase: { mark: 'partial', note: 'SOC 2 gated to the paid Team plan, HIPAA an add-on' }
		},
		{
			capability: 'Open source + self-hosting',
			cfb: { mark: 'yes', note: 'Apache-2.0, deploys to your account' },
			firebase: { mark: 'no', note: 'proprietary' },
			supabase: { mark: 'yes', note: 'their cloud or yours' }
		}
	];

	// How a request actually flows through the system.
	const steps = [
		{
			icon: Globe,
			title: 'Enter at the edge',
			desc: "Requests hit Cloudflare's network and the same-origin gateway, which preserves your cookies, origin, and the edge-resolved country before routing over a service binding."
		},
		{
			icon: Boxes,
			title: 'One agent per primitive',
			desc: "Auth lives in your project's AuthAgent Durable Object; every database collection gets a Durable Object of its own - embedded SQLite, strongly consistent, no connection pool, no separate database to run."
		},
		{
			icon: Radio,
			title: 'Fan out in realtime',
			desc: 'State changes sync to connected dashboards over WebSockets, and auth events stream to Workers Analytics Engine for the charts.'
		}
	];

	// Every primitive here has shipped: Realtime is the db gateway. Nothing on this page is a promise -
	// an unbuilt card is a liability the moment someone signs up for it.
	const roadmap = [
		{ icon: KeyRound, name: 'Auth', live: true },
		{ icon: Database, name: 'Database', live: true },
		{ icon: HardDrive, name: 'Storage', live: true },
		{ icon: Radio, name: 'Realtime', live: true }
	];

	const faqs = [
		{
			q: 'How is the Auth primitive actually built?',
			a: 'It runs as a Cloudflare Agent on top of Better Auth. Each project maps to one Durable Object with embedded SQLite, giving identities and sessions a strongly consistent home while Workers provide global ingress. Drizzle handles the schema and migrations.'
		},
		{
			q: 'How does the Database primitive scale?',
			a: 'The API is Firestore-style - collections of JSON documents with onSnapshot-like live queries - but every collection is its own Durable Object. Think of it as every subreddit getting its own database: 10 GB of SQLite, its own compute, and its own pool of live-query subscribers, fully isolated from the rest. A project scales collection by collection instead of hitting one shared ceiling, and because there are no cross-collection queries, a hot collection never slows a quiet one.'
		},
		{
			q: 'Can I run it on my own Cloudflare account?',
			a: 'Yes - it is open source under Apache-2.0 at github.com/frostbase-dev/frostbase. It is four Workers deployed in order with one command (npm run deploy:all), and the README walks through it for your own account. No secrets are required: each project generates its own signing key.'
		},
		{
			q: 'Is this production-ready?',
			a: "It's an MVP under active development. Durable Object SQLite is the source of truth for users and sessions; Analytics Engine is sampled with a limited retention window, so it only powers charts. Treat it as a working preview, not a place for production identities yet."
		},
		{
			q: 'What does the AI copilot see?',
			a: "It answers through read-only tools over your project's own agents - auth overview and analytics, database collections and documents - so replies come from your real backend state, not guesses. Conversations are stored under a project-scoped hash of the connecting IP; raw IPs are never written. If inference fails you get a 502 on chat, and everything else keeps working."
		}
	];

	let openFaq = $state<number | null>(0);

	const authApiExamples = buildIntegrationExamples('/api/projects/PROJECT_ID/auth');
	const dbApiExamples = buildDbIntegrationExamples('/api/projects/PROJECT_ID/db');
	// Database leads the API section; ?api=auth deep-links the auth examples.
	let apiProduct = $state<'auth' | 'db'>(
		page.url.searchParams.get('api') === 'auth' ? 'auth' : 'db'
	);

	// Agent-topology visual: simulated traffic converging on one project agent,
	// drawn over the same vendored continent silhouettes as the dashboard's
	// Replication tab (equirectangular, 75N-60S). The primary sits in North
	// America; writers are nearby, subscribers spread across the continents.
	const mapW = 480;
	const mapH = 240;
	const agent = { x: 120, y: 72 };
	const dashboard = { x: 74, y: 195 };
	const clients = [
		{ x: 85, y: 95, dur: 2.8, begin: 0 },
		{ x: 150, y: 45, dur: 2.4, begin: 1.5 },
		{ x: 280, y: 40, dur: 3.1, begin: 0.6 },
		{ x: 440, y: 140, dur: 3.5, begin: 2.2 },
		{ x: 150, y: 205, dur: 2.6, begin: 1.1 }
	];
	// The db skin shows replication, because it is on by default: per-region
	// replica satellites fed by the primary over the arcs, each serving its
	// nearest subscribers. Writers keep hitting the primary - replicas forward
	// writes by design, so the geometry is honest about the data flow. Anchors
	// match the Replication tab's region points (sam / weur / apac).
	const replicas: { id: string; x: number; y: number; arc: string; note?: string }[] = [
		{ id: 'sam', x: 180, y: 172, arc: 'M120,72 Q150,101 180,172' },
		{ id: 'weur', x: 247, y: 55, arc: 'M120,72 Q183.5,40.5 247,55' },
		{ id: 'apac', x: 395, y: 98, arc: 'M120,72 Q257.5,57 395,98' },
		// The Australian replica serves the SQL-table side of the database -
		// typed rows replicate exactly like documents.
		{ id: 'oc', x: 445, y: 190, arc: 'M120,72 Q282.5,103 445,190', note: 'DbTable · todos' }
	];
	/** db skin: replica index serving each subscriber; null marks a writer. */
	const nearestReplica: (number | null)[] = [null, null, 1, 3, 0];

	type FeedEvent = { id: number; time: string; label: string; detail: string; sync: boolean };
	const authEventPool: Omit<FeedEvent, 'id' | 'time'>[] = [
		{ label: 'POST /auth/sign-up/email', detail: 'user created', sync: false },
		{ label: 'state sync', detail: '→ dashboard', sync: true },
		{ label: 'GET /auth/get-session', detail: 'bearer token', sync: false },
		{ label: 'event', detail: '→ analytics engine', sync: true },
		{ label: 'POST /auth/sign-in/anonymous', detail: 'guest session', sync: false },
		{ label: 'POST /auth/sign-in/social', detail: 'google', sync: false },
		{ label: 'state sync', detail: '→ 2 dashboards', sync: true },
		{ label: 'DELETE /admin/sessions/:id', detail: 'revoked', sync: false }
	];
	const dbEventPool: Omit<FeedEvent, 'id' | 'time'>[] = [
		{ label: 'POST /documents', detail: 'post submitted', sync: false },
		{ label: 'live query', detail: '→ 4 front pages', sync: true },
		{ label: 'PATCH /documents/:id', detail: 'votes: 128 → 129', sync: false },
		{ label: 'replicate · lsn 129', detail: '→ sam, weur, apac', sync: true },
		{ label: 'change · modified', detail: 'front page re-ranks', sync: true },
		{ label: 'POST /query', detail: 'orderBy votes desc', sync: false },
		{ label: 'subscribe', detail: 'nearest replica: apac', sync: true },
		{ label: 'POST /documents', detail: 'comment added', sync: false },
		{ label: 'sql · INSERT INTO todos', detail: 'DbTable row', sync: false },
		{ label: 'live query · todos', detail: 'table rows → oc', sync: true },
		{ label: 'live query', detail: '→ 5 subscribers', sync: true }
	];
	// The hero visual is one diagram with two skins: same map, same agent node,
	// opposite flow. Auth animates requests IN; db animates writes in from two
	// clients and live-query deltas fanning OUT to the other three.
	// Selections survive reloads via query params (?agent= and ?api=) - set
	// with replaceState so switching never scrolls or adds history entries.
	let heroTab = $state<'auth' | 'db'>(
		page.url.searchParams.get('agent') === 'auth' ? 'auth' : 'db'
	);
	/** The dashboard subscribes like any client: nearest replica on the db skin. */
	const dashboardSource = $derived(heroTab === 'db' ? replicas[0] : agent);

	function persistParam(key: string, value: string) {
		if (!browser) return;
		const url = new URL(window.location.href);
		url.searchParams.set(key, value);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same-page query param, not a route
		replaceState(url, {});
	}

	function setHeroTab(id: 'auth' | 'db') {
		heroTab = id;
		persistParam('agent', id);
	}

	function setApiProduct(id: 'auth' | 'db') {
		apiProduct = id;
		persistParam('api', id);
	}
	let feed = $state<FeedEvent[]>([]);
	let feedCursor = 0;
	let reduceMotion = $state(false);

	function stamp() {
		return new Date().toTimeString().slice(0, 8);
	}

	// Seeds on mount and reseeds on every tab switch, so the feed always shows
	// the active agent's vocabulary immediately instead of draining over.
	$effect(() => {
		const pool = heroTab === 'db' ? dbEventPool : authEventPool;
		feed = pool.slice(0, 5).map((event, index) => ({
			...event,
			id: feedCursor + index,
			time: stamp()
		}));
		feedCursor += 5;
	});

	onMount(() => {
		reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const sections = Array.from(document.querySelectorAll<HTMLElement>('main > section'));

		// Nothing is hidden up front. Adding `landing-reveal` to every section on
		// mount blanked whatever was ALREADY on screen: the page painted from SSR,
		// went transparent the moment hydration ran, then faded back in - which is
		// what drove Speed Index up without ever showing as a layout shift. The
		// observer's first callback reports each section's current state, so the
		// ones on screen are simply marked visible and never blank, and the ones
		// off screen are hidden there, where hiding costs no paint.
		let primed = false;
		const observer = reduceMotion
			? null
			: new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							const section = entry.target as HTMLElement;
							if (entry.isIntersecting) {
								section.classList.add('is-visible');
								observer?.unobserve(section);
							} else if (!primed) {
								section.classList.add('landing-reveal');
							}
						}
						primed = true;
					},
					{ threshold: 0.12, rootMargin: '0px 0px -7% 0px' }
				);

		if (observer) {
			sections.forEach((section, index) => {
				section.style.setProperty('--reveal-delay', `${Math.min(index * 35, 140)}ms`);
				observer.observe(section);
			});
		}

		// Seeding lives in the heroTab $effect; this only appends from whichever
		// pool the active tab reads.
		const interval = reduceMotion
			? null
			: setInterval(() => {
					const pool = heroTab === 'db' ? dbEventPool : authEventPool;
					feed = [
						{ ...pool[feedCursor % pool.length], id: feedCursor, time: stamp() },
						...feed
					].slice(0, 6);
					feedCursor += 1;
				}, 1700);

		return () => {
			observer?.disconnect();
			if (interval) clearInterval(interval);
		};
	});
</script>

<svelte:head>
	<title>Frostbase - The open-source Firebase for Cloudflare</title>
	<meta
		name="description"
		content="The open-source Firebase for Cloudflare: auth, realtime database, and SQL tables with an AI copilot over your backend - globally replicated, no egress fees, self-hosted in your own Cloudflare account."
	/>
	<meta property="og:title" content="Frostbase - The open-source Firebase for Cloudflare" />
	<meta
		property="og:description"
		content="The open-source Firebase for Cloudflare - auth, realtime data, and SQL with replication by default, whole-backend branching, and an AI copilot. Yours to keep."
	/>
	<meta name="twitter:title" content="Frostbase - The open-source Firebase for Cloudflare" />
	<meta
		name="twitter:description"
		content="The open-source Firebase for Cloudflare - auth, realtime data, and SQL with replication by default, whole-backend branching, and an AI copilot. Yours to keep."
	/>
</svelte:head>

<div class="bg-background text-foreground">
	{@render heroheader()}

	<main class="overflow-hidden">
		<div class="absolute inset-0 isolate hidden opacity-65 contain-strict lg:block">
			<div
				class="absolute top-0 left-0 h-320 w-140 -translate-y-87.5 -rotate-45 rounded-full bg-[radial-gradient(68.54%_68.72%_at_55.02%_31.46%,hsla(0,0%,85%,.08)_0,hsla(0,0%,55%,.02)_50%,hsla(0,0%,45%,0)_80%)]"
			></div>
			<div
				class="absolute top-0 left-0 h-320 w-60 [translate:5%_-50%] -rotate-45 rounded-full bg-[radial-gradient(50%_50%_at_50%_50%,hsla(0,0%,85%,.06)_0,hsla(0,0%,45%,.02)_80%,transparent_100%)]"
			></div>
			<div
				class="absolute top-0 left-0 h-320 w-60 -translate-y-87.5 -rotate-45 bg-[radial-gradient(50%_50%_at_50%_50%,hsla(0,0%,85%,.04)_0,hsla(0,0%,45%,.02)_80%,transparent_100%)]"
			></div>
		</div>

		<!-- HERO -->
		<section>
			<div class="relative pt-24 md:pt-36">
				<div
					class="absolute inset-0 -z-10 size-full [background:radial-gradient(125%_125%_at_50%_100%,transparent_0%,var(--color-background)_75%)]"
				></div>
				<div class="mx-auto max-w-7xl px-4 sm:px-6">
					<div class="hero-stagger text-center sm:mx-auto lg:mt-0 lg:mr-auto">
						<div>
							<a
								href="https://github.com/frostbase-dev/frostbase"
								target="_blank"
								rel="noreferrer"
								class="mx-auto flex w-fit items-center gap-4 rounded-full border bg-muted p-1 pl-4 shadow-md shadow-zinc-950/5 transition-colors hover:bg-muted/70 dark:border-t-white/5 dark:shadow-zinc-950"
							>
								<span class="text-sm text-foreground"
									>Auth + Database are live · open source on GitHub</span
								>
								<span
									class="block h-4 w-0.5 border-l bg-background dark:border-background dark:bg-zinc-700"
								></span>
								<div class="size-6 overflow-hidden rounded-full bg-background">
									<span class="flex size-6"><ArrowRight class="m-auto size-3" /></span>
								</div>
							</a>
						</div>

						<h1
							class="mt-8 text-4xl leading-[1.05] text-balance sm:text-6xl md:text-7xl lg:mt-16 xl:text-[5.25rem]"
						>
							The open-source Firebase for Cloudflare.
						</h1>
						<p
							class="mx-auto mt-6 max-w-2xl text-base text-balance text-muted-foreground sm:mt-8 sm:text-lg"
						>
							Ship auth, realtime data, and SQL from your own Cloudflare account - global by
							default, zero servers to run, no egress bill. Open source, and yours to keep.
						</p>

						<div class="mt-12 flex flex-col items-center justify-center gap-2 md:flex-row">
							<div
								class="border bg-foreground/10 p-0.5"
								style="border-radius: calc(0.5rem + 0.125rem + 4px);"
							>
								<!-- A signed-in operator is past the demo: the same click goes
								     to their real console (the /dashboard entry branches on the
								     session), so only the promise changes. -->
								<Button href="/dashboard" size="lg" class="rounded-xl px-5 text-base"
									>{data.signedIn ? 'Open your dashboard' : 'Open the live demo'}</Button
								>
							</div>
							<Button
								size="lg"
								variant="ghost"
								class="rounded-xl px-5"
								href="https://github.com/frostbase-dev/frostbase"
								target="_blank"
								rel="noreferrer"
							>
								{@render githubMark('h-4 w-4')}
								Star on GitHub
							</Button>
						</div>
						<div
							class="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 font-mono text-xs text-muted-foreground/70"
						>
							<span class="flex items-center gap-1.5">
								<Star class="h-3.5 w-3.5 text-primary" /> 233 stars on GitHub
							</span>
							<span class="flex items-center gap-1.5">
								<GitFork class="h-3.5 w-3.5" /> 17 forks
							</span>
							<span class="flex items-center gap-1.5">
								<Boxes class="h-3.5 w-3.5" /> 900+ demo backends created
							</span>
						</div>
						<p class="mt-3 font-mono text-xs text-muted-foreground/70">
							POST /db/collections/posts/documents · GET /auth/token · it's just HTTP
						</p>
					</div>
				</div>

				<!-- Signature visual: one agent per project -->
				<div class="hero-visual relative mt-8 overflow-hidden px-2 sm:mt-12 md:mt-20">
					<!-- pointer-events-none: this fade sits over the card, and without it
					     the hero tabs underneath are unclickable. The fade starts low
					     (80%) so the chart legend stays readable; only the card's bottom
					     edge blends into the page. -->
					<div
						class="pointer-events-none absolute inset-0 z-10 bg-linear-to-b from-transparent from-80% to-background"
					></div>
					<div
						class="relative mx-auto max-w-6xl overflow-hidden rounded-2xl border bg-background p-4 shadow-lg inset-shadow-2xs shadow-zinc-950/15 ring-background dark:inset-shadow-white/20"
					>
						<div class="overflow-hidden rounded-xl border border-border bg-card">
							<div
								class="flex items-center justify-between border-b border-border px-5 py-3.5 font-mono text-xs text-muted-foreground"
							>
								<span class="flex min-w-0 items-center gap-2.5 truncate">
									<span class="flex gap-1.5">
										<span class="h-2 w-2 rounded-full bg-border"></span>
										<span class="h-2 w-2 rounded-full bg-border"></span>
										<span class="h-2 w-2 rounded-full bg-border"></span>
									</span>
									<span
										class="flex items-center gap-1 rounded-full border border-border bg-background/60 p-0.5"
										role="tablist"
										aria-label="Agent"
									>
										{#each [['db', 'db-agent'], ['auth', 'auth-agent']] as const as [id, label] (id)}
											<button
												type="button"
												role="tab"
												aria-selected={heroTab === id}
												class={cn(
													'cursor-pointer rounded-full px-3 py-1 transition-colors',
													heroTab === id
														? 'border border-primary/40 bg-primary/15 font-semibold text-foreground shadow-sm'
														: 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
												)}
												onclick={() => setHeroTab(id)}>{label}</button
											>
										{/each}
									</span>
									<span class="hidden truncate md:inline"
										>· {heroTab === 'db' ? 'collection: posts' : 'project: demo'}</span
									>
								</span>
								<span class="hidden shrink-0 sm:inline">simulated traffic</span>
							</div>
							<div class="grid grid-cols-1 md:grid-cols-[1fr_280px]">
								<div class="border-b border-border p-6 md:border-r md:border-b-0">
									{#key heroTab}
										<svg viewBox="0 0 {mapW} {mapH}" class="w-full">
											<path
												d={WORLD_OUTLINE_PATH}
												class="fill-primary/10 stroke-primary/20"
												stroke-width="0.5"
												stroke-linejoin="round"
											/>

											{#each clients as c, clientIndex (clientIndex)}
												{@const replicaIndex =
													heroTab === 'db' ? nearestReplica[clientIndex] : null}
												{@const target = replicaIndex == null ? agent : replicas[replicaIndex]}
												{@const outbound = replicaIndex != null}
												<line
													x1={c.x}
													y1={c.y}
													x2={target.x}
													y2={target.y}
													class="stroke-muted-foreground"
													stroke-width="1"
													stroke-dasharray="3 3"
													opacity="0.3"
												/>
												<circle cx={c.x} cy={c.y} r="3" class="fill-foreground" />
												{#if !reduceMotion}
													<!-- Auth: requests flow in. DB: two clients write into the
												     primary; the subscribers receive live-query deltas from
												     their NEAREST replica. -->
													<circle r="2.2" class={outbound ? 'fill-chart-3' : 'fill-primary'}>
														<animateMotion
															dur="{c.dur}s"
															begin="{c.begin}s"
															repeatCount="indefinite"
															calcMode="spline"
															keyPoints="0;1"
															keyTimes="0;1"
															keySplines="0.42 0 1 1"
															path={outbound
																? `M${target.x},${target.y} L${c.x},${c.y}`
																: `M${c.x},${c.y} L${target.x},${target.y}`}
														/>
													</circle>
												{/if}
											{/each}

											{#if heroTab === 'db'}
												<!-- Per-region replicas: the primary feeds each over its arc
												     (row images + config), and subscribers above land on the
												     nearest one. Replication is on by default - the demo IS
												     the pitch. -->
												{#each replicas as replica, replicaIndex (replica.id)}
													<path
														d={replica.arc}
														class="fill-none stroke-chart-2"
														stroke-width="1"
														stroke-dasharray="3 3"
														opacity="0.4"
													/>
													<circle cx={replica.x} cy={replica.y} r="8" class="fill-chart-2/15" />
													<circle cx={replica.x} cy={replica.y} r="3.5" class="fill-chart-2" />
													<text
														x={replica.x}
														y={replica.y - 7}
														text-anchor="middle"
														class="fill-muted-foreground font-mono"
														font-size="7">{replica.id}</text
													>
													{#if replica.note}
														<text
															x={replica.x - 12}
															y={replica.y + 4}
															text-anchor="end"
															class="fill-muted-foreground font-mono"
															font-size="8">{replica.note}</text
														>
													{/if}
													{#if !reduceMotion}
														<circle r="1.8" class="fill-chart-2">
															<animateMotion
																dur="2.2s"
																begin="{0.3 + replicaIndex * 0.55}s"
																repeatCount="indefinite"
																path={replica.arc}
															/>
														</circle>
													{/if}
												{/each}
											{/if}

											<line
												x1={dashboardSource.x}
												y1={dashboardSource.y}
												x2={dashboard.x}
												y2={dashboard.y}
												class="stroke-chart-3"
												stroke-width="1"
												stroke-dasharray="3 3"
												opacity="0.45"
											/>
											<rect
												x={dashboard.x - 5}
												y={dashboard.y - 4}
												width="10"
												height="8"
												rx="1.5"
												class="fill-chart-3"
											/>
											{#if !reduceMotion}
												<circle r="2.2" class="fill-chart-3">
													<animateMotion
														dur="1.8s"
														begin="0.4s"
														repeatCount="indefinite"
														path="M{dashboardSource.x},{dashboardSource.y} L{dashboard.x},{dashboard.y}"
													/>
												</circle>
											{/if}

											<circle cx={agent.x} cy={agent.y} r="14" class="fill-primary/15" />
											<circle cx={agent.x} cy={agent.y} r="6" class="fill-primary" />
											{#if !reduceMotion}
												{#each [0, 1.2] as ringDelay (ringDelay)}
													<circle
														cx={agent.x}
														cy={agent.y}
														r="10"
														opacity="0"
														class="fill-none stroke-primary"
														stroke-width="1"
													>
														<animate
															attributeName="r"
															values="10;26"
															dur="2.4s"
															begin="{ringDelay}s"
															repeatCount="indefinite"
														/>
														<animate
															attributeName="opacity"
															values="0.5;0"
															dur="2.4s"
															begin="{ringDelay}s"
															repeatCount="indefinite"
														/>
													</circle>
												{/each}
											{/if}

											<text
												x={agent.x}
												y={agent.y + 40}
												text-anchor="middle"
												class="fill-muted-foreground font-mono text-[9px]"
												>{heroTab === 'db' ? 'DbCollection · posts' : 'AuthAgent · DO SQLite'}</text
											>
											<text
												x={dashboard.x}
												y={dashboard.y + 18}
												text-anchor="middle"
												class="fill-muted-foreground font-mono text-[9px]">dashboard</text
											>
										</svg>
									{/key}
									<div
										class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-muted-foreground/70"
									>
										<span class="flex items-center gap-1.5">
											<span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
											{heroTab === 'db' ? 'document writes' : 'auth requests'}
										</span>
										{#if heroTab === 'db'}
											<span class="flex items-center gap-1.5">
												<span class="h-1.5 w-1.5 rounded-full bg-chart-2"></span>
												replication feed, on by default
											</span>
										{/if}
										<span class="flex items-center gap-1.5">
											<span class="h-1.5 w-1.5 rounded-full bg-chart-3"></span>
											{heroTab === 'db'
												? 'live-query deltas from the nearest replica'
												: 'WebSocket state sync'}
										</span>
										<span
											>{heroTab === 'db'
												? 'one Durable Object per collection or table'
												: 'one Durable Object per project'}</span
										>
									</div>
								</div>
								<div class="min-h-[220px] p-5">
									<div
										class="mb-3 font-mono text-[11px] tracking-wide text-muted-foreground/70 uppercase"
									>
										Agent activity
									</div>
									<div class="space-y-2.5 font-mono text-[11px]">
										{#each feed as event (event.id)}
											<div
												class="flex items-baseline gap-2"
												in:fly={{ y: -8, duration: reduceMotion ? 0 : 300 }}
												animate:flip={{ duration: reduceMotion ? 0 : 300 }}
											>
												<span
													class={cn(
														'h-1.5 w-1.5 flex-shrink-0 translate-y-px rounded-full',
														event.sync ? 'bg-chart-3' : 'bg-primary'
													)}
												></span>
												<span class="text-muted-foreground/60">{event.time}</span>
												<span class="min-w-0 truncate text-foreground">{event.label}</span>
												<span class="ml-auto flex-shrink-0 text-muted-foreground/70"
													>{event.detail}</span
												>
											</div>
										{/each}
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<!-- Runtime strip -->
		<section class="bg-background pt-16 pb-16 md:pb-28">
			<div class="relative m-auto max-w-5xl px-6">
				<p class="text-center text-sm text-muted-foreground">
					Built natively on the Cloudflare Developer Platform
				</p>
				<div
					class="relative mt-8 overflow-hidden mask-[linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]"
				>
					<div class="marquee-track flex">
						{#each [false, true] as duplicate (duplicate)}
							<div
								class="flex items-center gap-3 pr-3"
								aria-hidden={duplicate}
								data-duplicate={duplicate ? '' : undefined}
							>
								{#each runtime as name (name)}
									<span
										class="rounded-full border border-border px-4 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground"
										>{name}</span
									>
								{/each}
							</div>
						{/each}
					</div>
				</div>
			</div>
		</section>

		<!-- INSTALL: the CLI one-liner and its agent-shaped twin, Deno-style.
		     The boxes stay zinc-950 in both themes, matching every other
		     terminal block on this page. This is the card band that heads the
		     card/white alternation; every band below flips accordingly. -->
		<section id="install" class="border-y border-border bg-card px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto max-w-3xl">
				<div class="text-center">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>Get started</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">A backend in one command.</h2>
					<p class="mx-auto mt-3 max-w-xl text-muted-foreground">
						Scaffold a Worker with auth installed, add the database, deploy to your own Cloudflare
						account.
					</p>
				</div>

				<div
					class="relative mt-8 flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-zinc-950 px-5 py-4"
				>
					<code
						class="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-zinc-100"
						data-testid="install-command"><span class="text-primary">$</span> {installCommand}</code
					>
					<Button
						variant="ghost"
						size="icon"
						class="h-8 w-8 flex-shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Copy install command"
						data-testid="copy-install-command"
						onclick={() => copyInstall('cli', installCommand)}
					>
						{#if copiedInstall === 'cli'}<Check class="h-3.5 w-3.5" />{:else}<Copy
								class="h-3.5 w-3.5"
							/>{/if}
					</Button>
				</div>

				<div class="mt-14 text-center">
					<h3 class="text-2xl font-bold md:text-3xl">Or let your agent do it</h3>
					<p class="mt-2 text-sm text-muted-foreground">Paste this into any coding agent.</p>
				</div>

				<div class="mt-6 overflow-hidden rounded-xl border border-border">
					<div
						class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-background/60 px-5 py-2.5 font-mono text-xs text-muted-foreground"
					>
						{#each agentNames as name (name)}
							<span>{name}</span>
							<span class="text-muted-foreground/40" aria-hidden="true">·</span>
						{/each}
						<span class="text-muted-foreground/60">&lt;your agent&gt;</span>
					</div>
					<div class="relative flex items-center gap-3 bg-zinc-950 px-5 py-4">
						<code class="min-w-0 flex-1 font-mono text-sm text-zinc-100" data-testid="agent-prompt"
							><span class="text-primary">&gt;</span> {agentPrompt}</code
						>
						<Button
							variant="ghost"
							size="icon"
							class="h-8 w-8 flex-shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
							aria-label="Copy agent prompt"
							data-testid="copy-agent-prompt"
							onclick={() => copyInstall('agent', agentPrompt)}
						>
							{#if copiedInstall === 'agent'}<Check class="h-3.5 w-3.5" />{:else}<Copy
									class="h-3.5 w-3.5"
								/>{/if}
						</Button>
					</div>
				</div>
				<p class="mt-3 text-center text-xs text-muted-foreground/70">
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- static asset, not a route -->
					<a href="/agents.md" class="underline underline-offset-2 hover:text-foreground"
						>agents.md</a
					>
					includes a zero-account path: the agent builds on a throwaway demo project and hands you the
					live dashboard.
				</p>
			</div>
		</section>

		<!-- PRICING: the real /pricing calculator, embedded - straight above
		     the API section on purpose, with /pricing's own hero copy.
		     White band, now that the install card band sits above it. -->
		<section id="pricing" class="px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto max-w-6xl">
				<div class="mb-10 max-w-3xl">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>Pricing</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">
						Our price: <span class="text-primary">$0</span>
					</h2>
					<p class="mt-3 text-muted-foreground">
						Frostbase is open source and runs on your own Cloudflare account - there is no middleman
						bill, and Durable Objects sit on the
						<a
							class="underline underline-offset-2 hover:text-foreground"
							href="https://developers.cloudflare.com/durable-objects/platform/pricing/"
							>Workers free tier</a
						>, so small projects run at $0. This estimates what a workload costs on your account,
						next to the same app on Firebase and Supabase.
					</p>
				</div>
				<PricingCalculator />
			</div>
		</section>

		<!-- COMPARE (card band) -->
		<section id="compare" class="border-y border-border bg-card px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto max-w-6xl">
				<div class="mb-10 max-w-xl">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>Compare</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">Same primitives. Different physics.</h2>
					<p class="mt-3 text-muted-foreground">
						Firebase's DX, Supabase's openness, Cloudflare's network. Every row is a reason this
						exists.
					</p>
				</div>
				<div class="overflow-x-auto rounded-2xl border border-border">
					<table
						class="w-full min-w-[720px] border-collapse bg-card text-left text-sm"
						data-testid="comparison-table"
					>
						<thead>
							<tr class="border-b border-border">
								<th class="p-4 font-medium text-muted-foreground">Capability</th>
								<th class="bg-primary/[0.06] p-4">
									<span class="flex items-center gap-2 font-semibold">
										<img src="/brand/mark.svg" alt="" class="h-4 w-4" /> Frostbase
									</span>
								</th>
								<th class="p-4 font-medium text-muted-foreground">Firebase</th>
								<th class="p-4 font-medium text-muted-foreground">Supabase</th>
							</tr>
						</thead>
						<tbody>
							{#each compareRows as row (row.capability)}
								<tr class="border-b border-border last:border-0">
									<th scope="row" class="p-4 align-top font-medium">{row.capability}</th>
									{#each [row.cfb, row.firebase, row.supabase] as cell, i (i)}
										<td class={cn('p-4 align-top', i === 0 && 'bg-primary/[0.06]')}>
											<span class="flex items-start gap-2">
												{#if cell.mark === 'yes'}
													<Check class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
												{:else if cell.mark === 'partial'}
													<Minus class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" />
												{:else}
													<X class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
												{/if}
												<span
													class={cn(
														'text-xs leading-relaxed',
														i === 0 ? 'text-foreground' : 'text-muted-foreground'
													)}>{cell.note}</span
												>
											</span>
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="mt-3 text-xs text-muted-foreground/70">
					Competitor capabilities as publicly documented; exact prices with dated sources live on
					the
					<a href={resolve('/(marketing)/pricing')} class="underline hover:text-foreground"
						>pricing page</a
					>.
				</p>
			</div>
		</section>

		<!-- API (white band) -->
		<section id="api" class="px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 md:grid-cols-[2fr_3fr]">
				<div>
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>API</span
					>
					<h2 class="mt-4 text-3xl leading-tight font-bold md:text-4xl">
						It's just HTTP. SDKs optional.
					</h2>
					<p class="mt-4 text-muted-foreground">
						Point <code class="font-mono">fetch</code> at your project's endpoint and you're
						integrated - this is the exact API the demo dashboard uses. When you want types, the
						Better Auth client and <code class="font-mono">@frostbase-dev/db/client</code> wrap the same
						routes.
					</p>
					<ul class="mt-6 space-y-3 text-sm">
						<li class="flex gap-2.5">
							<Check class="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
							Cookie sessions for same-origin browser apps
						</li>
						<li class="flex gap-2.5">
							<Check class="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
							<span
								>Bearer tokens via the <code class="font-mono">set-auth-token</code> header for external
								and non-browser clients</span
							>
						</li>
						<li class="flex gap-2.5">
							<Check class="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
							Per-project trusted origins - add yours under Authentication → Settings
						</li>
						<li class="flex gap-2.5">
							<Check class="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
							<span
								>Public config endpoint: <code class="font-mono"
									>GET /api/projects/:projectId/config</code
								></span
							>
						</li>
					</ul>
				</div>
				<div class="overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
					<div class="flex items-center justify-between border-b border-border px-4 py-2.5">
						<div class="flex items-center gap-1.5">
							<span class="h-2.5 w-2.5 rounded-full bg-border"></span>
							<span class="h-2.5 w-2.5 rounded-full bg-border"></span>
							<span class="h-2.5 w-2.5 rounded-full bg-border"></span>
						</div>
						<div
							class="flex items-center gap-1 rounded-full border border-border bg-background/60 p-0.5 font-mono text-xs"
							role="tablist"
							aria-label="Product"
						>
							{#each [['db', 'db'], ['auth', 'auth']] as const as [id, label] (id)}
								<button
									type="button"
									role="tab"
									aria-selected={apiProduct === id}
									class={cn(
										'cursor-pointer rounded-full px-3 py-1 transition-colors',
										apiProduct === id
											? 'border border-primary/40 bg-primary/15 font-semibold text-foreground'
											: 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
									)}
									onclick={() => setApiProduct(id)}>{label}</button
								>
							{/each}
						</div>
					</div>
					{#key apiProduct}
						<!-- Fixed geometry: the pill row reserves two lines and the code
						     block scrolls inside a constant height, so switching between
						     short and tall examples never shifts the page below. -->
						<CodeExamples
							examples={apiProduct === 'db' ? dbApiExamples : authApiExamples}
							class="p-4 [&_pre]:h-[23rem] [&_pre]:overflow-y-auto"
						/>
					{/key}
				</div>
			</div>
		</section>

		<!-- ARCHITECTURE (card band: keeps the backgrounds alternating
		     card/white now that the install band heads the rotation) -->
		<section id="architecture" class="border-y border-border bg-card px-4 py-14 sm:px-8 sm:py-20">
			<div class="mx-auto max-w-6xl">
				<div class="mb-10 max-w-xl">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>Architecture</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">
						Three Workers. A Durable Object per primitive.
					</h2>
					<p class="mt-3 text-muted-foreground">
						That's the whole diagram. No origin fleet, no connection pools - your backend state
						lives with the compute that serves it.
					</p>
				</div>
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each steps as s, i (s.title)}
						<div
							class="relative rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/40"
						>
							<div class="flex items-center gap-3">
								<div
									class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"
								>
									<s.icon class="h-4.5 w-4.5" strokeWidth={1.8} />
								</div>
								<span class="font-mono text-xs text-muted-foreground/60">0{i + 1}</span>
								<h3 class="font-semibold">{s.title}</h3>
							</div>
							<p class="mt-3 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
						</div>
					{/each}
				</div>
			</div>
		</section>

		<!-- ROADMAP (white band) -->
		<section id="roadmap" class="px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto max-w-6xl">
				<div class="mb-14 max-w-xl">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>Primitives</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">
						Every Firebase primitive. All of them shipped.
					</h2>
					<p class="mt-3 text-muted-foreground">
						We shipped them one at a time, and every one landed the same way: its own agent, one
						Durable Object per client project, and a same-origin dashboard proxy.
					</p>
				</div>
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
					{#each roadmap as item (item.name)}
						<div
							class={cn(
								'rounded-2xl border p-5',
								item.live
									? 'border-primary bg-gradient-to-b from-primary/[0.06] to-card'
									: 'border-dashed border-border bg-card/50'
							)}
						>
							<div
								class={cn(
									'flex h-9 w-9 items-center justify-center rounded-lg',
									item.live ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/60'
								)}
							>
								<item.icon class="h-[18px] w-[18px]" strokeWidth={1.8} />
							</div>
							<h3 class={cn('mt-3 text-sm font-semibold', !item.live && 'text-muted-foreground')}>
								{item.name}
							</h3>
							<span
								class={cn(
									'mt-1.5 inline-block rounded-full px-2 py-0.5 font-mono text-[10px] uppercase',
									item.live ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/60'
								)}>{item.live ? 'Live' : 'Planned'}</span
							>
						</div>
					{/each}
				</div>
			</div>
		</section>

		<!-- FAQ (card band) -->
		<section id="faq" class="border-y border-border bg-card px-4 py-16 sm:px-8 sm:py-24">
			<div class="mx-auto max-w-3xl">
				<div class="mb-12 text-center">
					<span
						class="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
						>FAQ</span
					>
					<h2 class="mt-4 text-3xl font-bold md:text-4xl">Questions, answered plainly.</h2>
				</div>
				<div class="divide-y divide-border rounded-xl border border-border bg-card">
					{#each faqs as item, i (item.q)}
						<div>
							<button
								onclick={() => (openFaq = openFaq === i ? null : i)}
								class="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
							>
								<span class="font-medium">{item.q}</span>
								<ChevronDown
									class={cn(
										'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
										openFaq === i && 'rotate-180'
									)}
								/>
							</button>
							{#if openFaq === i}
								<div class="px-6 pb-5 text-sm leading-relaxed text-muted-foreground">{item.a}</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</section>

		<!-- CTA BAND (white band: closes out the alternation after the card FAQ,
		     whose own bottom border already draws the separation) -->
		<section class="px-4 py-20 text-center sm:px-8 sm:py-28">
			<span
				class="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-wide text-primary uppercase"
			>
				<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"></span>
				Nothing to sign up for
			</span>
			<h2 class="mx-auto mt-5 max-w-2xl text-3xl font-bold sm:text-4xl md:text-5xl">
				Spin up a real Durable Object in one click.
			</h2>
			<p class="mx-auto mt-4 max-w-xl text-muted-foreground">
				Opening the dashboard creates an isolated demo project for your browser. Poke the API, watch
				the state sync live, ask the copilot about it.
			</p>
			<div class="mt-8 flex flex-wrap justify-center gap-3">
				<Button href="/dashboard" size="lg"
					>{data.signedIn ? 'Open your dashboard' : 'Open the live demo'}</Button
				>
				<Button
					size="lg"
					variant="outline"
					href="https://github.com/frostbase-dev/frostbase"
					target="_blank"
					rel="noreferrer"
				>
					{@render githubMark('h-4 w-4')}
					View on GitHub
				</Button>
			</div>
		</section>
	</main>

	<!-- FOOTER -->
	<footer class="border-t border-border px-4 pt-12 pb-8 sm:px-8">
		<div class="mx-auto max-w-6xl">
			<div class="mb-11 flex flex-wrap justify-between gap-10">
				<div>
					<div class="flex items-center gap-2 text-lg font-bold">
						<img src="/brand/mark.svg" alt="" class="h-5 w-5" />
						Frostbase
					</div>
					<p class="mt-2.5 max-w-[240px] text-sm text-muted-foreground/70">
						The product layer for Cloudflare's developer platform. Open source, shipped one
						primitive at a time.
					</p>
				</div>
				<div class="flex w-full flex-wrap gap-10 sm:w-auto sm:gap-16">
					<div>
						<h4 class="mb-3.5 font-mono text-xs tracking-wide text-muted-foreground/70 uppercase">
							Product
						</h4>
						<a
							href="#pricing"
							class="mb-2.5 block text-sm text-muted-foreground hover:text-foreground">Pricing</a
						>
						<a href="#api" class="mb-2.5 block text-sm text-muted-foreground hover:text-foreground"
							>API</a
						>
						<a
							href="#roadmap"
							class="mb-2.5 block text-sm text-muted-foreground hover:text-foreground">Primitives</a
						>
					</div>
					<div>
						<h4 class="mb-3.5 font-mono text-xs tracking-wide text-muted-foreground/70 uppercase">
							Resources
						</h4>
						<a
							href="https://github.com/frostbase-dev/frostbase"
							target="_blank"
							rel="noreferrer"
							class="mb-2.5 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
						>
							{@render githubMark('h-3.5 w-3.5')}
							GitHub
						</a>
						<a href="#faq" class="mb-2.5 block text-sm text-muted-foreground hover:text-foreground"
							>FAQ</a
						>
					</div>
				</div>
			</div>
			<div
				class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-6 text-xs text-muted-foreground/70"
			>
				<span>© 2026 Frostbase</span>
				<div class="flex gap-4">
					<a href={resolve('/pricing')} class="hover:text-foreground">Pricing</a>
					<a href={resolve('/privacy')} class="hover:text-foreground">Privacy</a>
					<a href={resolve('/terms')} class="hover:text-foreground">Terms</a>
				</div>
			</div>
			<p class="mt-4 text-xs text-muted-foreground/70">
				Built on the Cloudflare Developer Platform. Frostbase is an independent open-source project
				and is not affiliated with, endorsed by, or sponsored by Cloudflare, Inc.
			</p>
		</div>
	</footer>
</div>

{#snippet githubMark(classes: string)}
	<svg viewBox="0 0 24 24" fill="currentColor" class={classes} aria-hidden="true">
		<path
			d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
		/>
	</svg>
{/snippet}

{#snippet heroheader()}
	<header>
		<nav class="fixed z-20 w-full px-2">
			<div
				class={[
					'mx-auto mt-2 max-w-6xl rounded-2xl px-6 transition-all duration-300 lg:px-12',
					isScrolled && 'max-w-4xl rounded-2xl border bg-background/50 backdrop-blur-lg lg:px-5'
				]}
			>
				<div
					class="relative flex flex-wrap items-center justify-between gap-6 py-3 lg:gap-0 lg:py-4"
				>
					<div class="flex w-full justify-between lg:w-auto">
						<a
							href={resolve('/')}
							aria-label="home"
							class="flex items-center gap-2 text-lg font-bold"
						>
							<img src="/brand/mark.svg" alt="" class="h-[22px] w-[22px]" />
							Frostbase
						</a>

						<div class="flex items-center gap-1 lg:hidden">
							<ModeToggle variant="ghost" class="h-9 w-9" />
							<button
								onclick={() => (menuState = !menuState)}
								aria-label={menuState == true ? 'Close Menu' : 'Open Menu'}
								class="relative z-20 -m-2.5 -mr-4 block cursor-pointer p-2.5"
							>
								<Menu
									class={[
										'm-auto size-6 duration-200',
										menuState && 'scale-0 rotate-180 opacity-0'
									]}
								/>
								<X
									class={[
										'absolute inset-0 m-auto size-6 scale-0 -rotate-180 opacity-0 duration-200',
										menuState && 'scale-100 rotate-0 opacity-100'
									]}
								/>
							</button>
						</div>
					</div>

					<div class="absolute inset-0 m-auto hidden size-fit lg:block">
						<ul class="flex gap-8 text-sm">
							{#each menuItems as item (item.href)}
								<li>
									<!-- eslint-disable svelte/no-navigation-without-resolve -- same-page hash link -->
									<a
										href={item.href}
										class="block text-muted-foreground duration-150 hover:text-accent-foreground"
									>
										<span>{item.name}</span>
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</li>
							{/each}
						</ul>
					</div>

					<div
						class={[
							'mb-4 w-full flex-wrap items-center justify-end space-y-5 rounded-2xl border bg-background p-5 shadow-2xl shadow-zinc-300/20 md:flex-nowrap lg:m-0 lg:flex lg:w-fit lg:gap-6 lg:space-y-0 lg:rounded-3xl lg:border-transparent lg:bg-transparent lg:p-0 lg:shadow-none dark:shadow-none dark:lg:bg-transparent',
							menuState ? 'block lg:flex' : 'hidden lg:flex'
						]}
					>
						<ModeToggle
							variant="ghost"
							class="hidden h-9 w-9 lg:inline-flex"
							testId="landing-theme-toggle"
						/>
						<div class="lg:hidden">
							<ul class="space-y-4 text-base">
								{#each menuItems as item (item.href)}
									<li>
										<!-- eslint-disable svelte/no-navigation-without-resolve -- same-page hash link -->
										<a
											href={item.href}
											onclick={() => (menuState = false)}
											class="block text-muted-foreground duration-150 hover:text-accent-foreground"
										>
											<span>{item.name}</span>
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									</li>
								{/each}
							</ul>
						</div>
						<!-- Account corner, Supabase-style: signed-in operators get their
						     console; everyone else gets Log in / Sign up. The demo CTA
						     lives in the hero - it is the pitch, not the account. -->
						<div class="flex w-full flex-col space-y-3 sm:flex-row sm:gap-3 sm:space-y-0 md:w-fit">
							{#if data.signedIn}
								<Button
									href="/dashboard"
									size="sm"
									class="w-full rounded-lg shadow-sm"
									data-testid="nav-dashboard">Dashboard</Button
								>
							{:else}
								<Button href="/login" size="sm" variant="ghost" data-testid="nav-login"
									>Log in</Button
								>
								<Button href="/login?signup=1" size="sm" data-testid="nav-signup" class="shadow-sm"
									>Sign up</Button
								>
							{/if}
						</div>
					</div>
				</div>
			</div>
		</nav>
	</header>
{/snippet}

<!-- Hero and marquee motion lives in src/routes/layout.css: a component <style>
	 block here becomes its own render-blocking stylesheet, so the page paid an
	 extra round trip on the critical path for ~1 KB of animation rules. -->
