import { expect, test } from '@playwright/test';

test.describe('landing page (frontend)', () => {
	// The landing page and the demo hand-off are the ANONYMOUS surface. With
	// an operator session, /dashboard lists real projects instead of minting
	// a demo, so these tests must not carry the console storage state.
	test.use({ storageState: { cookies: [], origins: [] } });
	test('renders the hero and the primitives', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { level: 1 })).toContainText(
			'The open-source Firebase for Cloudflare'
		);
		await expect(
			page.getByRole('heading', { name: 'Every Firebase primitive. All of them shipped.' })
		).toBeVisible();

		// Nothing on this page may advertise something unbuilt: an unshipped
		// card is a signup someone regrets. Every primitive listed is live.
		const primitives = page.locator('#roadmap');
		await expect(primitives.getByText('Planned')).toHaveCount(0);
		await expect(primitives.getByText('Live')).toHaveCount(4);
		await expect(primitives).toContainText('Storage');

		// The hero visual opens on the db agent and the tabs are real controls.
		const heroTabs = page.getByRole('tablist', { name: 'Agent' });
		await expect(heroTabs.getByRole('tab', { name: 'db-agent' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await heroTabs.getByRole('tab', { name: 'auth-agent' }).click();
		await expect(page.getByText('AuthAgent · DO SQLite')).toBeVisible();
	});

	test('the install section offers the CLI command and the agent prompt', async ({
		page,
		request
	}) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Or let your agent do it' })).toBeVisible();
		await expect(page.getByTestId('install-command')).toContainText(
			'npx @frostbase-dev/cli init my-backend'
		);
		await expect(page.getByTestId('agent-prompt')).toContainText(
			'Read frostbase.dev/agents.md and set up Frostbase in this project'
		);

		// The prompt is only honest if the file it points at is actually served.
		const response = await request.get('/agents.md');
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('# Set up Frostbase');
	});

	test('the pricing story and comparison table state the trade-offs', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: /Our price/ })).toBeVisible();
		// The real calculator is embedded on the landing page, not linked away.
		await expect(page.getByTestId('pricing-total-cf')).toContainText('$');
		await expect(
			page.getByRole('heading', { name: 'Same primitives. Different physics.' })
		).toBeVisible();

		const table = page.getByTestId('comparison-table');
		for (const name of ['Frostbase', 'Firebase', 'Supabase']) {
			await expect(table.getByRole('columnheader', { name })).toBeVisible();
		}
		// The branching row is the pitch in one line.
		const branching = table.getByRole('row', { name: /Branching/ });
		await expect(branching).toContainText('the whole backend');
		await expect(branching).toContainText('database only, paid');
	});

	test('"Open the live demo" leads to the demo project dashboard', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('link', { name: 'Open the live demo' }).first().click();

		await expect(page).toHaveURL(/\/dashboard\/demo-[a-f0-9]{12}$/);
		await expect(page.getByRole('heading', { name: 'Project Overview' })).toBeVisible();
		const projectId = (await page.getByTestId('project-badge').textContent())!;
		expect(projectId).toMatch(/^demo-[a-f0-9]{12}$/);
		await expect(page.getByTestId('project-copilot')).toBeVisible();

		// Demos are throwaway: the header funnel offers a REAL project through
		// sign-up/sign-in, never a claim of this one.
		await expect(page.getByTestId('demo-signup-cta')).toHaveAttribute('href', /\/login\?signup=1$/);

		// The Firebase-style sidebar navigates into Authentication.
		await page.getByTestId('nav-auth').click();
		await expect(page).toHaveURL(new RegExp(`/dashboard/${projectId}/auth$`));
		await expect(page.getByRole('heading', { name: 'Authentication' })).toBeVisible();
	});

	test('the browser resumes its isolated demo project', async ({ page }) => {
		await page.goto('/dashboard');
		const first = page.url();
		await page.goto('/');
		await page.goto('/dashboard');
		expect(page.url()).toBe(first);
	});
});

test.describe('landing page (signed in)', () => {
	// Default storage state: the console owner's session. An operator is past
	// the demo - every CTA routes to their console instead of pitching it.
	test('the hero and nav route an operator to the console, not the demo', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByTestId('nav-dashboard')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Open your dashboard' }).first()).toBeVisible();
		await expect(page.getByRole('link', { name: 'Open the live demo' })).toHaveCount(0);
	});

	test('/login bounces a signed-in operator to their destination', async ({ page }) => {
		// /login is an open route the guard never resolves a session for; the
		// loader must do it itself, or the demo funnel's ?signup=1 link would
		// offer a sign-in form to someone who already has a session.
		await page.goto('/login?signup=1');
		await expect(page).toHaveURL(/\/dashboard$/);

		await page.goto('/login?next=%2Fdashboard%2Forganization');
		await expect(page).toHaveURL(/\/dashboard\/organization$/);
	});
});
