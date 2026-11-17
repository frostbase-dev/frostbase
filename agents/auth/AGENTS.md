# @frostbase-dev/auth

Better Auth on a Durable Object. One `AuthAgent` per project, addressed by
project id, each with its own embedded SQLite and its own signing keypair.

Read the root [AGENTS.md](../../AGENTS.md) first — the cross-project import ban,
the manifest contract, and the two-layer access model all apply here.

## Shape

```
src/index.ts        WorkerEntrypoint: /health, erase fan-in, routeAgentRequest
src/agent.ts        the AuthAgent DO — routing, admin surface, analytics, chat
src/auth.ts         the Better Auth instance and its hooks
src/email-callback.ts  emailed links redirect back to the app that asked
src/admin.ts        server-side admin client (targets the CONSOLE, not the agent)
src/route-access.ts layer-2 route gate; mirrors frostbase.agent.json
src/bindings.ts     AssertAuthAgentEnv — the compile-time binding contract
src/db/schema.ts    drizzle schema → `npm run migrations` → src/migrations.ts
```

## Routes

Public (the product API a customer's app calls):

- `/api/auth/*` — Better Auth, unmodified. Its client works as-is.
- `/config` — safe client config.

Everything else is the **operator plane** and authenticates nobody:
`/overview`, `/analytics`, `/chat`, `/admin/*`, the state-sync socket, and
`/internal/*`. It is designed to sit behind a console that has already checked
who is calling. On a consumer's Worker there is no such console, so those routes
answer 404 unless `EXPOSE_OPERATOR_API=true` — which is only safe on a Worker
with no public hostname. Reach them from your own code through the `AuthAgent`
namespace binding instead.

`PUT /admin/roles` is the reason this matters: granting `*` to the default role
turns every project JWT into an admin token.

## What only holds here

- **Every project generates its own signing key** on first start and keeps it in
  its own DO storage. `BETTER_AUTH_SECRET` is an *override* for the whole
  deployment, not a requirement — a fresh install needs no secret set by hand.
  The other agents verify those project JWTs via `/api/auth/jwks`.
- **`console` is a reserved project id** — the dashboard authenticating its own
  operators with the stack it sells. Mirrored in `src/lib/server/console.ts` at
  the repo root; keep both in sync.
- **Every account lands with a personal organization it owns**, so "personal
  project" is just an org with one member and ownership never needs a
  user-or-org union type. Safe to call repeatedly: DO input gates serialize the
  check-then-insert.
- **Analytics Engine is opt-in for a deploy-time reason.** It is an
  account-level toggle only the Cloudflare dashboard can grant — no API, no
  Wrangler flag — so declaring an `AUTH_EVENTS` dataset fails `wrangler deploy`
  with `no_access_to_analytics_engine` (code 10089) until it is enabled. Unset,
  every write is skipped and nothing else changes. Reading the events
  additionally needs `CF_ACCOUNT_ID` + `CF_ANALYTICS_API_TOKEN`.
- **Emailed links follow the requesting app home.** They land on the API
  origin — the dashboard, on a managed deployment — so the mail hooks rewrite
  a relative `callbackURL` against the caller's allowlisted Origin
  (`src/email-callback.ts`). Better Auth re-validates the absolute URL against
  the same allowlist at click time, so both halves must agree before anyone is
  redirected.
- **An invitation id is a credential** — it is what accepts the invitation,
  and Better Auth's accept only compares the session email to the invited one.
  A claimed console skips email verification, so registering an address proves
  nothing. The id therefore reaches an account only through a verified address
  or the invite link (`/dashboard?invitation=<id>`, mailed or copied from the
  org page); `/console/me` gates its list on that and the console refuses
  Better Auth's by-email `list-user-invitations`. Never list invitation ids by
  email match alone.
- **Outbound mail is attacker-influenced.** Org names, inviter addresses, and
  reset URLs all land inside an HTML body sent from the deployment's verified
  sender. Interpolate through `escapeHtml` / `headerSafe`, never raw.
- **`AuthAgent` is the only binding with no fallback.** Everything else degrades:
  `AI` only powers `/chat`, `EMAIL` only affects verification mail. That
  resilience is deliberate and is not an invitation to omit them.
- **A deployment trusts its own origin automatically.** `TRUSTED_ORIGINS` (the
  CSRF allowlist) is only for *extra* origins.
- **The published `template/wrangler-fragment.jsonc` is a fresh `v1`.** Never
  copy this repo's migration tag history into it — it carries a class rename
  that would try to delete a class the consumer never had.

## Commands

```bash
npm run dev         # wrangler dev --env local, :8788
npm run typecheck   # tsc --noEmit
npm run test:unit   # route-access parity + email-callback rewrite
npm run migrations  # drizzle-kit generate + inline into src/migrations.ts
npm run cf-typegen  # after any binding change
```

Requires `compatibility_flags: ["nodejs_compat", "nodejs_als"]` and
`new_sqlite_classes` for the Durable Object.
