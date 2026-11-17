# @frostbase-dev/storage

Buckets of files on R2. The bytes live in R2, the *index* lives in Durable
Objects, and the data plane is the **worker** — bytes never enter a DO.

Read the root [AGENTS.md](../../AGENTS.md) first.

## Durable Object topology

| Class           | Instance name        | What it is                                   |
| --------------- | -------------------- | -------------------------------------------- |
| `StorageAgent`  | `<pid>`              | bucket registry, access config, quota, erase  |
| `StorageBucket` | `<pid>:<bucket>`     | the object index — one row per key            |

`StorageBucket` is a plain `DurableObject`, deliberately **not** an SDK Agent:
it is addressed by anonymous public traffic through the worker, and SDK
state-sync frames would leak operator data onto that path. Same reasoning as
`DbCollection`.

`src/index.ts` (1700 lines) is the data plane — routing, streaming, signing,
serving. `src/agent.ts` is control plane only.

## What only holds here

- **The R2 key is always `p/<projectId>/<bucket>/<key>`**, composed from
  schema-validated parts. That prefix is the *only* tenant boundary inside the
  shared bucket, so everything in `keys.ts` is a security check, not tidiness:
  no `.`/`..` segments, no empty segments, no leading/trailing slashes, no
  control characters, and the full key stays under R2's 1024-byte ceiling. Use
  the normalized key `parseObjectKey` returns — never the raw path.
- **Inline rendering is an allowlist of exact types** (`src/inline.ts`), not a
  denylist and not a pattern: raster images, common video and audio, `text/plain`,
  PDF. Everything else goes out `Content-Disposition: attachment`, and every
  object response carries `X-Content-Type-Options: nosniff`. HTML, SVG, and
  anything `+xml` are absent by design — on the managed service the agent path
  shares the console's origin, so an attacker-uploaded HTML file rendered inline
  is stored XSS against every operator session. Never widen it back to a
  `video/*`-style pattern: browsers render *any* `+xml` subtype as an XML
  document, so `video/x+xml` carrying XHTML runs script.
- **The R2 bucket must NEVER carry r2.dev or a custom domain.** That serves every
  tenant's keys raw, bypassing all of the above. `STORAGE_SERVE_DOMAIN` is a
  *worker* route with identical enforcement.
- **R2 owns the bytes; the index is derived.** Writes and deletes both hit R2
  **first** and record afterwards, so an interrupted request can only leave the
  benign shapes — a phantom row a later GET prunes, never an unindexed orphan
  that bills forever. `reconcile.ts` is the crash backstop, not the consistency
  mechanism: a streaming merge join of two key-ordered streams, one page deep
  whatever the bucket holds.
- **Signed URLs cost zero DO hops to verify.** The secret rides the same cached
  parent answer the access check already reads. The signature covers project,
  bucket, key, method, and expiry — **never the host** — so one URL verifies on
  the agent path and the serve domain alike. Rotation (`v`) is the revocation
  mechanism, and it converges within the access-cache TTL rather than instantly.
  GET and HEAD only.
- **Access answers are cached per isolate for 30s** (5s for misses and erasing
  answers). Enforcement of restrictive changes is therefore *eventual*, bounded
  by that window — the same bargain the db agent's counters make. Stated, not
  hidden.
- **Quota enforcement is eventual too.** Children report debounced absolute
  counters to the parent, and the fold into `getBucketAccess` is how single-shot
  writes check the project ceiling without a per-request parent hop.
- **The agent refuses a chunked body with 411** rather than buffer 100 MB into a
  shared isolate. The client sets `Content-Length` from the body; larger objects
  go multipart automatically.
- **Demo storage never touches R2 at all** (`demo.ts`): one read-only bucket,
  bytes inlined in the module, fixed timestamps. It answers in the worker
  *before* any DO stub is dialled — addressing the route must not provision an
  object a demo visitor only ever gets a 403 from. It also means a fresh
  self-hosted clone with no R2 subscription still sees the product.
- **`access.ts` is a copy of the db agent's gate, not an import** — the
  cross-project ban stands. If you change one, change the other.

## Routes

Public: `/buckets/*`. Operator: `/overview`, `/admin/*`, `/internal/*`.
Closed unless `EXPOSE_OPERATOR_API=true`, like every agent.

## Commands

```bash
npm run dev         # wrangler dev --env local, :8791
npm run typecheck
npm run test:unit   # route-access, keys, signing, reconcile
npm run migrations
```

`BUCKET` (R2) is optional — without it the agent degrades rather than fails, so
a self-hosted install without an R2 subscription still deploys.
