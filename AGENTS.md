# Frostbase

The open-source Firebase alternative on Cloudflare. Every project gets its own
Durable Objects, so one tenant's data is physically separate from the next —
isolation by architecture, not by a `WHERE` clause.

This file is the map. Each agent carries its own `AGENTS.md` with the details
that only matter inside it. Read that one before changing an agent.

## Repository shape

Five separate npm projects, separate Wrangler configs, separate generated `Env`
types.

| Path             | Worker          | Durable Objects                                    |
| ---------------- | --------------- | -------------------------------------------------- |
| `/`              | `frostbase` | none — SvelteKit console + marketing, D1 registry   |
| `agents/auth`    | `auth-agent`    | `AuthAgent`                                          |
| `agents/db`      | `db-agent`      | `DbAgent` `DbCollection` `DbTable` `DbGateway` `DbView` |
| `agents/storage` | `storage-agent` | `StorageAgent` `StorageBucket`                       |
| `cli`            | none            | `@frostbase-dev/cli`, runs on a consumer's machine  |

**Never import runtime code or generated Worker types across those
boundaries.** Shared DTOs are deliberately copied — `src/lib/agents.ts` mirrors
the agents' exported types, and `agents/storage/src/access.ts` is a copy of the
db agent's gate. Change one side, change the other in the same commit.

The one exception is `frostbase.agent.json`: the app imports each manifest
**directly** from `agents/<name>/`, because the console guard is generated from
its `routes` block and a stale copy would silently open or close the wrong
surface. The CLI keeps its own schema copy and reads manifests from the
installed package instead.

Installation-wide state — the project registry — is D1 on the dashboard Worker
(`src/lib/server/db/schema.ts`), never an agent. Per-project state lives in that
project's Durable Objects.

## The agent contract

Each agent package ships a `frostbase.agent.json` declaring what it is and
what the platform must do to host it: worker name, DO classes and their scope,
bindings, secrets, vars, the route table, the console proxy prefix, permission
keys, and its sidebar pages.

That manifest is the **single declaration**. It drives four things at once:

1. the console guard's public/operator classification (`src/hooks.server.ts`),
2. the REST proxy and dispatch (`src/lib/agent-registry.ts`),
3. the sidebar and the delete fan-out,
4. the CLI's `add` command, which merges the wrangler fragment.

A new primitive is its own npm project shipping a manifest, plus one entry in
[src/lib/agent-registry.ts](src/lib/agent-registry.ts) and one in
[cli/src/lib/agents.ts](cli/src/lib/agents.ts).

**An agent is a package, not a product boundary.** A console page may name its
own sidebar `section`, so a feature can live where an operator looks for it
rather than under whichever agent happens to store it — Remote Config is served
by the db agent and sits in a section of its own.

## Access control is two layers, and both must hold

**Layer 1 — the console guard** (`src/hooks.server.ts`). Every external request
to an agent arrives through here: the agent workers have `workers_dev` and
`preview_urls` false and no route of their own. `classifyAccess` splits
project-scoped surfaces into public product API and operator console, asking
each manifest's route table. Undeclared routes and unknown agents fail closed to
operator.

**Layer 2 — the agent's own `src/route-access.ts`.** The published package gets
mounted on a consumer's *public* Worker, where no console guard exists. So each
agent re-enforces its own route table and closes the operator plane unless
`EXPOSE_OPERATOR_API=true`. `ROUTES` there mirrors the manifest and a unit test
fails if the two disagree.

Because both default to operator, drift can only ever close something that
should be open — a loud, testable failure — never open something that should be
closed. The refusal is the ordinary 404 byte for byte, so a closed surface is
not enumerable.

Service keys (`fsb_`, legacy `cfbs_`) are an **authentication** change, not an authorization
one: they are verified in the console guard and travel to the agent over a
service binding the console already authorized. No agent ever sees the bearer.

## Commands

```bash
npm run dev      # auth :8788, db :8789, storage :8791, web :5173
npm run check    # svelte-check
npm run lint     # prettier + eslint
npm test         # full Playwright suite against real workerd
```

All three checks run in CI and all three must pass. The e2e suite boots a
production-mirroring stack — the built SvelteKit worker on `:8797` plus the three
agents on `:8798`, `:8799` and `:8801`, real service bindings, real DO SQLite. It is the
check that actually catches things.

Each agent is its own TypeScript project with its own unit tests:

```bash
cd agents/db && npx tsc --noEmit && npm run test:unit
```

## Conventions

- **Validation is zod, everywhere.** Route inputs and anything crossing a
  service binding get parsed, not cast. The OpenAPI document is generated from
  those same schemas.
- **A new route is not done until it is in the OpenAPI document.** Add the path
  to `src/lib/openapi/<agent>.ts` and register every schema it references in
  that module's `schemas` array — the registry throws at import on a schema
  without `.meta({ id })`, but nothing at all fails for a route that simply is
  not there. The document is the public contract and the API reference page
  renders straight from it, so a missing entry is an endpoint nobody can
  discover.
- **Schema changes need a migration.** Edit the agent's `src/db/schema.ts`, then
  `npm run migrations` in that agent — it generates the SQL and inlines it into
  `src/migrations.ts`. Never hand-edit either; the inlining is what lets agents
  ship as plain npm dependencies with no Text-module rule in the consumer's
  config.
- **Agent relative imports carry `.js`** (`from './schemas.js'`). The
  `client`/`admin` entrypoints run in plain Node with no bundler, so the agents
  build with `nodenext`, which rejects an extensionless import at typecheck.
- **After changing bindings**, regenerate types: `npm run cf-typegen` at the
  root, `npx wrangler types` in the agent. Never hand-edit
  `worker-configuration.d.ts`.
- **Errors that are caught must still be reported.** Sentry's `handleError` hook
  and the DO instrumentation only see errors that *escape*. Anything you catch
  and turn into an error response needs an explicit `Sentry.captureException`,
  or the failure is invisible in production. On the server use
  `serverError()` from `$lib/server/agents` rather than SvelteKit's `error()` —
  a bare `error()` never reaches `handleError`.
- **UI tests need `data-testid`.** Dashboard tests go through `gotoAuthPage()` /
  `gotoDbPage()`, which wait for hydration; clicking an SSR-rendered tab before
  Svelte attaches its handler silently loses the event.
- **Security-sensitive paths deserve a test that attacks them.** See
  `e2e/console-guard.api.spec.ts`, which asserts endpoints reject anonymous
  callers rather than asserting they work when authenticated.

## Platform gotchas

These are expensive to rediscover.

- **`cloudflarebase` survives in names that hold state, on purpose.** The
  project was Cloudflarebase until October 2026. D1 database names
  (`cloudflarebase-control-plane*`), Analytics Engine datasets
  (`cloudflarebase_*_events`) and the JWT issuer
  (`cloudflarebase:<project>`) keep the old spelling,
  because renaming them orphans data or invalidates live tokens. Legacy
  inputs are still accepted: `cfbs_` service keys, `CLOUDFLAREBASE_*` env
  vars, `cloudflarebase.json`, `~/.cloudflarebase`. cloudflarebase.com stays
  attached to the console: pages 301 to frostbase.dev, the API keeps
  answering.
- **Durable Object SQLite refuses `pragma_table_info()`** (SQLITE_AUTH) and
  explicit transactions. The applied schema is *our* record, never
  introspection.
- **Never pass `cors: true` to `routeAgentRequest`.** The agents own their
  per-project CORS policy; the SDK's blanket policy would override it.
- **Miniflare service bindings need `binding.fetch(url, init)`, not a
  `Request`.** The dev binding is a proxy that cannot consume Requests from the
  Node realm. Every proxy route in `src/routes/api/` carries this note.
- **A Durable Object that aborts after replying makes a completed operation look
  like a failure.** The deferred `abort()` can outrace the RPC reply, so erase
  paths match `/abort\(\) to reset|durable object reset/i` and swallow it.
- **Answering a body-bearing request without consuming the body wedges the
  worker** ("Can't read from request stream after response has been sent").
  Every entrypoint drains with `drainUnusedBody`.
- **`npm run check` after `npm run build`** scans `.svelte-kit/cloudflare/` and
  reports thousands of errors in generated code. Delete that directory first. CI
  is unaffected — it checks before building.

## Releasing

Releases ride CI, not hands. Bump the changed packages' `package.json`
versions in the release commit — the release workflow treats the npm registry
as the ledger and publishes any package whose local version is not on it; an
unbumped version merges to main and publishes nothing. Workers deploy through
Workers Builds on push: `preview` builds the preview stack, `main` builds
production.

Push `preview`, verify against the preview stack, then merge to `main`.

Secrets never gate a deploy: wrangler's `secrets.required` only drives
typegen and local-dev warnings, and every agent degrades without its optional
secrets. But a capability gated on a secret stays off until someone runs
`wrangler secret put` on the target worker - CI cannot mint secrets - so set
them around the release, not inside it.

## Commits

Explain why the change is needed, not just what it does. If you fixed a bug, say
what was broken and how it showed up. No `Co-Authored-By` trailers.
