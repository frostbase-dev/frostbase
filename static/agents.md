# Set up Frostbase

You are a coding agent setting up Frostbase for a user. Frostbase is an
open-source Firebase alternative that runs on Cloudflare: auth (Better Auth),
a realtime document database plus typed SQL tables, object storage, and remote
config. Every project gets its own Durable Objects, so tenants are isolated by
architecture.

Pick ONE path, then run the Verify step for it.

- **Path A — throwaway demo.** No account, no deploy, ready in seconds.
  Best for prototypes, hackathons, and trying the API.
- **Path B — the user's own Cloudflare account.** A real, self-hosted backend.
  Best for production.
- **Path C — a managed console project.** The user already has an account on
  frostbase.dev or a self-hosted console.

## Path A — throwaway demo (no account)

Mint a project id: `demo-` + 12 random lowercase hex characters, generated
with a CSPRNG — the id is the only credential, so it must be unguessable.

```bash
node -e "console.log('demo-'+require('crypto').randomBytes(6).toString('hex'))"
```

The project exists the moment you touch it — there is no create call. Your
base URLs (replace `<id>`):

```
Auth     https://frostbase.dev/api/projects/<id>/auth
Database https://frostbase.dev/api/projects/<id>/db
Storage  https://frostbase.dev/agents/storage-agent/<id>
OpenAPI  https://frostbase.dev/api/projects/<id>/openapi.json
Console  https://frostbase.dev/dashboard/<id>
```

Fetch the OpenAPI document first — it is public and describes every endpoint
for this exact project. Point the user at the Console URL: it is a full
dashboard for their demo project and updates live as your code writes data.

Demo limits, tell the user these: data is capped, erased after ~30 days, and
reachable by anyone who knows the id. Never put real user data in a demo
project; graduate to Path B or C instead.

### Verify (Path A)

Collections default to authenticated access, so mint a project token, create
the collection explicitly, then write — anonymous sign-in counts as signing
in:

```bash
BASE=https://frostbase.dev/api/projects/<id>
# 1. Anonymous session; the bearer arrives in the set-auth-token header
SESSION=$(curl -si -X POST $BASE/auth/sign-in/anonymous -H 'content-type: application/json' -d '{}' \
  | grep -i '^set-auth-token:' | cut -d' ' -f2 | tr -d '\r')
# 2. Trade it for a project JWT
JWT=$(curl -s $BASE/auth/token -H "authorization: Bearer $SESSION" | sed 's/.*"token":"\([^"]*\)".*/\1/')
# 3. Create the collection (defaults: readAccess/writeAccess "auth")
curl -s -X PUT $BASE/db/admin/collections/posts -H 'content-type: application/json' -d '{}'
# 4. Write a document
curl -s -X POST $BASE/db/collections/posts/documents \
  -H 'content-type: application/json' -H "authorization: Bearer $JWT" \
  -d '{"data":{"title":"hello from an agent","votes":1}}'
```

Step 4 answers `201` with the document, now visible in the Console URL above.
Create every collection explicitly, as in step 3 — writes also auto-create on
first touch, but explicit creation is deterministic and is where access modes
are set. If a write ever answers `503 {"error":"collection is unavailable"}`,
create the collection explicitly and retry the write.

## Path B — the user's own Cloudflare account

Requires Node 20+ and a Cloudflare account (the free tier is enough).
`npx wrangler login` opens a browser — have the user run it, or let them set
`CLOUDFLARE_API_TOKEN`. Ask before deploying; it creates resources on their
account.

New backend:

```bash
npm install -g @frostbase-dev/cli
frostbase init my-backend        # scaffolds a Worker, installs the auth agent
cd my-backend
frostbase add db                 # optional: documents, SQL tables, live queries
frostbase add storage            # optional: object storage on R2
npx wrangler login               # first time only
frostbase deploy                 # prints the deployed URL
```

Existing Worker project: run `frostbase add <agent>` inside it instead of
`init`. It npm-installs the package, merges the agent's config fragment into
`wrangler.jsonc`, wires the entrypoint, and reruns `wrangler types`. It is
idempotent and never overwrites values the user set. `wrangler.toml` projects
are declined — convert to `wrangler.jsonc` first.

The deployed Worker serves every project id under these bases — pick one id
(for example the app's name) and use it everywhere; the first request
provisions it:

```
Auth     https://<worker>.workers.dev/agents/auth-agent/<project>/api/auth
Database https://<worker>.workers.dev/agents/db-agent/<project>
Storage  https://<worker>.workers.dev/agents/storage-agent/<project>
```

No secrets are required: each project generates its own signing key. Sign-in
works immediately — the deployment trusts its own origin. Only add
`TRUSTED_ORIGINS` (in `wrangler.jsonc` vars) for *extra* origins, like a
separate domain serving the UI.

### Verify (Path B)

```bash
curl -s https://<worker>.workers.dev/agents/auth-agent/<project>/config
```

JSON config comes back. Operator routes (`/admin/*`, `/overview`) answer 404
on this Worker by design — they are reachable from server code through the
Durable Object binding, never over public HTTP. Do not set
`EXPOSE_OPERATOR_API` on a Worker with a public hostname.

## Path C — a managed console project

```bash
npm install -g @frostbase-dev/cli
frostbase login https://frostbase.dev   # browser approval; or a self-hosted console URL
frostbase init                          # bare init: pick or create a project, writes frostbase.json
frostbase key create                    # server-side service key, shown once
```

Base URLs are the console's, same shapes as Path A with the real project id.
Service keys (`fsb_…`) are admin-grade and server-only: the API refuses any
request carrying an `Origin` header, so a key leaked into frontend code fails
at the desk, not in production. Put the key in an env var
(`FROSTBASE_SERVICE_KEY`), never in the bundle or the repo.

## Integrate the app

Auth — the stock Better Auth client works as-is:

```ts
import { createAuthClient } from 'better-auth/client'; // or /react, /svelte
const auth = createAuthClient({ baseURL: '<Auth base URL>' });
await auth.signUp.email({ name, email, password });
```

Database — documents, typed tables, and live queries:

```ts
import { createDbClient } from '@frostbase-dev/db/client';
const db = createDbClient({
  baseUrl: '<Database base URL>',
  // New collections default to authenticated access, so wire getToken from
  // day one. Same-origin or trusted-origin browser apps ride the session
  // cookie; elsewhere add the Better Auth session bearer to this fetch.
  getToken: async () => (await (await fetch('<Auth base URL>/token')).json()).token
});
const posts = db.collection('posts');
await posts.create({ title: 'hello', votes: 1 });
posts.subscribe({ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 },
  { onSnapshot: (docs) => render(docs) });
```

Storage — `createStorageClient` from `@frostbase-dev/storage/client`, same
`baseUrl`/`getToken` pattern; `upload()` handles multipart above 100 MB.

Everything is also plain HTTP — no SDK is required. The per-project OpenAPI
document is the complete, machine-readable contract; prefer it over guessing
routes.

## Rules

- Ask the user before deploying, logging in, or creating anything on their
  Cloudflare account.
- Never hand-edit `worker-configuration.d.ts`; rerun `npx wrangler types`.
- Rerunning `frostbase add` is safe; running it with no argument lists the
  installable agents (`auth`, `db`, `storage`).
- Pin an agent version with `FROSTBASE_DB_SPEC=@frostbase-dev/db@x.y.z
  frostbase add db` (same pattern for auth and storage).
- Demo projects are throwaway: unguessable-id access, capped, erased in ~30
  days. Say so in your handoff to the user.

Source: https://github.com/frostbase-dev/frostbase · Site: https://frostbase.dev
