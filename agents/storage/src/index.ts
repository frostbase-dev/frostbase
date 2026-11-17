import * as Sentry from '@sentry/cloudflare';
import { getAgentByName, routeAgentRequest } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { checkAccess, corsHeadersFor, drainUnusedBody, withCors } from './access.js';
import { StorageAgent as StorageAgentBase, type BucketAccessAnswer } from './agent.js';
import { StorageBucket as StorageBucketBase, type BucketIdentity } from './bucket.js';
import { parseObjectKey, r2ObjectKey } from './keys.js';
import {
	DEMO_BUCKET,
	demoBucketSummary,
	demoList,
	demoObject,
	demoOverview,
	demoRefusal,
	type DemoObjectSummary,
} from './demo.js';
import { contentDisposition } from './inline.js';
import { gateOperatorRoutes } from './route-access.js';
import {
	DEMO_PROJECT_PATTERN,
	bucketNameSchema,
	objectCursorSchema,
	projectIdSchema,
	signedUrlRequestSchema,
	completeUploadRequestSchema,
	createUploadRequestSchema,
} from './schemas.js';
import {
	SIGNED_PARAM_EXPIRES,
	SIGNED_PARAM_SIGNATURE,
	SIGNED_PARAM_VERSION,
	hasSignedParams,
	mayRefetchForVersion,
	parseSignedParams,
	resolveTtlSeconds,
	signSubject,
	verifySignature,
	agentObjectUrl,
	publicServeOrigin,
	serveObjectPath,
	MAX_MULTIPART_BYTES,
	UPLOAD_TTL_SECONDS,
	openUpload,
	partCount,
	resolvePartSize,
	sealUpload,
	type SignedMethod,
	type UploadEnvelope,
} from './signing.js';

/**
 * storage-agent worker - the BYTE PATH lives here, not in a Durable Object.
 *
 * A Durable Object is 128 MB of memory and one thread; bytes never enter
 * one. This stateless worker streams request bodies straight to R2 and dials
 * the `StorageBucket` index only for small metadata RPCs. Everything else
 * (overview, bucket admin, state sync) goes through `routeAgentRequest` to
 * `StorageAgent`.
 *
 * Enforcement on the object paths (all of it here, because presigned/CDN
 * variants share this code and must share the policy):
 *
 * - the R2 key is ALWAYS `p/<projectId>/<bucket>/<key>` composed from
 *   schema-validated parts (keys.ts) - the only tenant boundary inside the
 *   shared bucket,
 * - per-bucket access modes + JWT + permission keys (access.ts), read from a
 *   short per-isolate cache of the parent's answer - zero DO hops on cache
 *   hits, restrictive flips converge within the TTL,
 * - every object response carries `X-Content-Type-Options: nosniff`, and
 *   inline rendering is an ALLOWLIST (raster images, video, audio,
 *   text/plain, PDF) - everything else, HTML/SVG/XML above all, goes out
 *   `Content-Disposition: attachment`. On the managed service the agent path
 *   shares the console's origin, so an attacker-uploaded HTML file rendered
 *   inline would be stored XSS against every operator session.
 *
 * `STORAGE_SERVE_DOMAIN` (e.g. cdn.frostbase.dev) optionally serves
 * GET/HEAD at `/<projectId>/<bucket>/<key>` on a dedicated hostname - a
 * WORKER route with identical enforcement. The R2 bucket itself must NEVER
 * carry r2.dev or a custom domain: that serves every tenant's keys raw.
 */

const sentryOptions = (env: Env) => ({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENV,
	tracesSampleRate: 0.1,
	enableRpcTracePropagation: true,
});

/** Workers request bodies cap at 100 MB on Free/Pro - also the single-PUT
 * ceiling. Larger objects arrive with multipart in S2. */
const MAX_SINGLE_PUT_BYTES = 100 * 1024 * 1024;
/** How long an isolate trusts a bucket's access answer. */
const ACCESS_CACHE_TTL_MS = 30_000;
/** Misses and erasing answers re-ask sooner: a bucket created a moment ago
 * must not read as missing for half a minute. */
const NEGATIVE_CACHE_TTL_MS = 5_000;
const ACCESS_CACHE_MAX = 5_000;
const DEFAULT_PUBLIC_CACHE_CONTROL = 'public, max-age=60';

interface AccessCacheEntry {
	answer: BucketAccessAnswer;
	expires: number;
	/** When a version mismatch last forced this entry to be re-read. Absent on
	 * an ordinary fetch on purpose - see `mayRefetchForVersion`. */
	forcedAt?: number;
}

const accessCache = new Map<string, AccessCacheEntry>();

function notConfigured(): Response {
	return Response.json(
		{
			error:
				'storage is not configured - this install needs an R2 bucket (enable R2 on the Cloudflare account, then add the BUCKET binding in wrangler.jsonc)',
		},
		{ status: 503 },
	);
}

function erasingResponse(): Response {
	return Response.json({ error: 'this project is being erased' }, { status: 503 });
}

interface ObjectRouteTarget {
	projectId: string;
	bucket: string;
	/** null = the listing endpoint (`GET .../objects`). */
	key: string | null;
	/** Operator surface: access modes bypassed, console-guard gated. */
	admin: boolean;
}

class StorageService extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// The dedicated serving hostname, when one is routed at this worker.
		const cdn = this.serveDomainTarget(request, url);
		if (cdn) {
			const served = await cdn;
			await this.reportServerError(request, url, served);
			return served;
		}

		if (url.pathname === '/health') {
			return Response.json({ service: 'storage-agent', status: 'ok' });
		}

		// The object paths below are public by design and carry their own
		// per-bucket access modes and JWT gate. The operator plane (/overview,
		// /admin/*, state sync, /internal/*) carries none: the console guard is
		// its gate, and the package cannot assume one exists - the documented
		// consumer install mounts this handler on their own PUBLIC Worker.
		// Closed unless the deployment says otherwise (src/route-access.ts).
		const gated = gateOperatorRoutes(url, this.env);
		if (gated) return gated;

		// Demo projects answer entirely from this worker, BEFORE any stub is
		// dialled: S1 refused them inside StorageAgent.onRequest, which meant
		// addressing the route provisioned a Durable Object the request only
		// ever got a 403 from. A demo visit now costs storage nothing at all.
		const demo = await this.demoRoute(request, url);
		if (demo) return demo;

		const erase = url.pathname.match(/^\/internal\/projects\/([^/]+)$/);
		if (erase && request.method === 'DELETE') {
			const projectId = decodeURIComponent(erase[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, StorageAgentBase>(this.env.StorageAgent, projectId);
			await agent.destroy();
			// The isolate must not keep trusting configs for an erased project.
			for (const key of accessCache.keys()) {
				if (key.startsWith(`${projectId}:`)) accessCache.delete(key);
			}
			return Response.json({ erased: true });
		}

		// Operator-only: rebuild/repair one bucket's index from a walk of R2.
		const reconcile = url.pathname.match(
			/^\/agents\/[^/]+\/([^/]+)\/admin\/buckets\/([^/]+)\/reconcile$/,
		);
		if (reconcile && request.method === 'POST') {
			const projectId = decodeURIComponent(reconcile[1]);
			const bucket = decodeURIComponent(reconcile[2]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!bucketNameSchema.safeParse(bucket).success
			) {
				return Response.json({ error: 'invalid project or bucket name' }, { status: 400 });
			}
			const target: ObjectRouteTarget = { projectId, bucket, key: null, admin: true };
			const answer = await this.bucketAccess(projectId, bucket);
			if (answer.status === 'erasing') return erasingResponse();
			if (answer.status === 'missing') {
				return Response.json({ error: 'no such bucket' }, { status: 404 });
			}
			const result = await this.bucketStub(target).reconcile(this.identity(target));
			return Response.json(result);
		}

		// /agents/storage-agent/<pid>/buckets/<b>/uploads[/<id>[/parts/<n>|
		// /complete]] (+ admin mirror). The multipart control plane; part PUTs
		// carry bytes and are verified statelessly from the signed envelope.
		const uploadRoute = url.pathname.match(
			/^\/agents\/[^/]+\/([^/]+)\/(admin\/)?buckets\/([^/]+)\/uploads(\/.*)?$/,
		);
		if (uploadRoute) {
			const projectId = decodeURIComponent(uploadRoute[1]);
			const bucket = decodeURIComponent(uploadRoute[3]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!bucketNameSchema.safeParse(bucket).success
			) {
				return Response.json({ error: 'invalid project or bucket name' }, { status: 400 });
			}
			const response = await this.handleUploads(
				request,
				{ projectId, bucket, key: null, admin: uploadRoute[2] === 'admin/' },
				uploadRoute[4] ?? '',
			);
			await this.reportServerError(request, url, response);
			return response;
		}

		// /agents/storage-agent/<pid>/buckets/<b>/signed-urls (+ admin mirror).
		// Body-addressed, deliberately NOT objects/<key...>/signed-url: a suffix
		// route is ambiguous against an object whose key ENDS in `/signed-url`,
		// and route grammar must never be reachable from user data.
		const signedUrls = url.pathname.match(
			/^\/agents\/[^/]+\/([^/]+)\/(admin\/)?buckets\/([^/]+)\/signed-urls$/,
		);
		if (signedUrls) {
			const projectId = decodeURIComponent(signedUrls[1]);
			const bucket = decodeURIComponent(signedUrls[3]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!bucketNameSchema.safeParse(bucket).success
			) {
				return Response.json({ error: 'invalid project or bucket name' }, { status: 400 });
			}
			const response = await this.handleSignedUrls(request, url, {
				projectId,
				bucket,
				key: null,
				admin: signedUrls[2] === 'admin/',
			});
			await this.reportServerError(request, url, response);
			return response;
		}

		// /agents/storage-agent/<pid>/buckets/<b>/objects[/<key...>]
		// /agents/storage-agent/<pid>/admin/buckets/<b>/objects[/<key...>]
		const objects = url.pathname.match(
			/^\/agents\/[^/]+\/([^/]+)\/(admin\/)?buckets\/([^/]+)\/objects(\/.*)?$/,
		);
		if (objects) {
			const projectId = decodeURIComponent(objects[1]);
			const bucket = decodeURIComponent(objects[3]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!bucketNameSchema.safeParse(bucket).success
			) {
				return Response.json({ error: 'invalid project or bucket name' }, { status: 400 });
			}
			const rawKey = objects[4]?.replace(/^\//, '') ?? '';
			const target: ObjectRouteTarget = {
				projectId,
				bucket,
				key: rawKey ? decodePathKey(rawKey) : null,
				admin: objects[2] === 'admin/',
			};
			if (rawKey && target.key === null) {
				return Response.json({ error: 'invalid object key encoding' }, { status: 400 });
			}
			const response = await this.handleObjects(request, url, target);
			await this.reportServerError(request, url, response);
			return response;
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		await this.reportServerError(request, url, response);
		return response;
	}

	/**
	 * GET/HEAD serving on the dedicated hostname (`STORAGE_SERVE_DOMAIN`):
	 * `https://cdn.example.com/<projectId>/<bucket>/<key>`. Same pipeline,
	 * same enforcement - only the path shape differs. Read-only by design:
	 * writes stay on the agent surface where the console guard and CORS
	 * policy already apply.
	 */
	private serveDomainAliases(): string[] {
		return (this.env.STORAGE_SERVE_DOMAIN_ALIASES ?? '')
			.split(',')
			.map((alias) => alias.trim().toLowerCase())
			.filter(Boolean);
	}

	private serveDomainTarget(request: Request, url: URL): Promise<Response> | null {
		const domain = this.env.STORAGE_SERVE_DOMAIN;
		if (!domain) return null;
		let host = url.hostname;
		if (this.env.STORAGE_SERVE_HOST_HEADER === 'true') {
			// Test-only: local workerd is dialled by port, not hostname, so the
			// e2e stack stands the serving host in via a header. Ignored
			// everywhere else.
			const override = request.headers.get('x-frostbase-host');
			if (override) host = override.split(':')[0];
		}
		if (host !== domain && !this.serveDomainAliases().includes(host)) return null;
		if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
			return Promise.resolve(
				Response.json(
					{ error: 'method not allowed' },
					{ status: 405, headers: { allow: 'GET, HEAD' } },
				),
			);
		}
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/);
		const projectId = match ? decodeURIComponent(match[1]) : '';
		const bucket = match ? decodeURIComponent(match[2]) : '';
		const rawKey = match?.[3]?.replace(/^\//, '') ?? '';
		if (
			!match ||
			!rawKey ||
			!projectIdSchema.safeParse(projectId).success ||
			!bucketNameSchema.safeParse(bucket).success
		) {
			return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
		}
		const key = decodePathKey(rawKey);
		if (key === null) {
			return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
		}
		return this.handleObjects(request, url, { projectId, bucket, key, admin: false });
	}

	// -----------------------------------------------------------------
	// The object paths

	/**
	 * The whole demo answer: a read-only sample bucket served from the module
	 * bundle. Returns null for every non-demo request, so the cost to real
	 * projects is one regex.
	 */
	private async demoRoute(request: Request, url: URL): Promise<Response | null> {
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)(\/.*)?$/);
		if (!match) return null;
		const projectId = decodeURIComponent(match[1]);
		if (!DEMO_PROJECT_PATTERN.test(projectId)) return null;
		const subPath = match[2] ?? '/';

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		const answer = (response: Response) => withCors(response, cors);

		if (subPath === '/overview') return answer(Response.json(demoOverview(projectId)));
		if (subPath === '/admin/buckets') {
			return answer(Response.json({ buckets: [demoBucketSummary()] }));
		}

		const objects = subPath.match(/^\/(?:admin\/)?buckets\/([^/]+)\/objects(\/.*)?$/);
		if (objects) {
			if (decodeURIComponent(objects[1]) !== DEMO_BUCKET) {
				return answer(Response.json({ error: 'no such bucket' }, { status: 404 }));
			}
			const rawKey = objects[2]?.replace(/^\//, '') ?? '';
			// Reads only. Everything that would change something answers with the
			// upsell rather than a technical error.
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return answer(demoRefusal());
			}
			if (!rawKey) {
				const rawDelimiter = url.searchParams.get('delimiter');
				if (rawDelimiter !== null && rawDelimiter !== '/') {
					return answer(
						Response.json({ error: 'the only supported delimiter is /' }, { status: 400 }),
					);
				}
				return answer(
					Response.json(
						demoList({
							prefix: url.searchParams.get('prefix') ?? undefined,
							delimiter: rawDelimiter === '/' ? '/' : undefined,
							cursor: url.searchParams.get('cursor') ?? undefined,
							limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200),
						}),
						{ headers: { 'cache-control': 'private, no-store' } },
					),
				);
			}
			const key = decodePathKey(rawKey);
			const found = key === null ? null : demoObject(key);
			if (!found) return answer(Response.json({ error: 'no such object' }, { status: 404 }));
			return answer(this.demoBytes(request, found.summary, found.body));
		}

		// Bucket admin, signed URLs, uploads, reconcile - every remaining
		// surface is a mutation or a capability a demo must not mint.
		return answer(demoRefusal());
	}

	/** Module bytes through the SAME response policy real objects get: nosniff
	 * and the inline allowlist, so the demo exercises the real path. */
	private demoBytes(request: Request, summary: DemoObjectSummary, body: Uint8Array): Response {
		const headers = new Headers({
			'content-type': summary.contentType,
			etag: summary.etag,
			'accept-ranges': 'bytes',
			'x-content-type-options': 'nosniff',
			'content-disposition': contentDisposition(summary.contentType),
			'cache-control': DEFAULT_PUBLIC_CACHE_CONTROL,
			'content-length': String(summary.size),
		});
		if (request.headers.get('if-none-match') === summary.etag) {
			return new Response(null, { status: 304, headers });
		}
		if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
		return new Response(body as unknown as BodyInit, { status: 200, headers });
	}

	private async handleObjects(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
	): Promise<Response> {
		if (DEMO_PROJECT_PATTERN.test(target.projectId)) {
			// Unreachable through fetch() - demoRoute answers every demo-shaped id
			// first, serving the read-only sample bucket - but kept as the belt to
			// that braces: anonymous object WRITES on a real origin are a phishing
			// machine, and a dispatch reorder must not quietly reopen them.
			return demoRefusal();
		}

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}

		const answer = await this.bucketAccess(target.projectId, target.bucket);
		if (answer.status === 'erasing') return withCors(erasingResponse(), cors);
		if (answer.status === 'missing') {
			return withCors(Response.json({ error: 'no such bucket' }, { status: 404 }), cors);
		}

		const response = await this.routeObjectOp(request, url, target, answer);
		return withCors(response, cors);
	}

	/**
	 * The multipart control plane. A single `PUT` cannot carry more than the
	 * Workers body cap, so anything larger escalates to parts - and the SERVER
	 * decides the shape, because R2 requires every part but the last to be
	 * identically sized and a client that picks its own can produce an upload
	 * that cannot complete.
	 *
	 *   POST   uploads                 create - the only step that hits the DO
	 *   PUT    uploads/<id>/parts/<n>  one part; verified from the envelope
	 *   POST   uploads/<id>/complete   assemble, verify size, index
	 *   DELETE uploads/<id>            abort and refund the reservation
	 *
	 * Part PUTs pay ZERO Durable Object hops: everything needed to authorize
	 * one travels inside the signed envelope. That is what keeps a 5 GB upload
	 * from being 600 round trips to a single-threaded object.
	 */
	private async handleUploads(
		request: Request,
		target: ObjectRouteTarget,
		subPath: string,
	): Promise<Response> {
		if (DEMO_PROJECT_PATTERN.test(target.projectId)) {
			// Unreachable through fetch() - demoRoute answers demo ids first - but
			// kept so a dispatch reorder cannot quietly open demo uploads.
			return demoRefusal();
		}
		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (!this.env.BUCKET) return withCors(notConfigured(), cors);

		if (subPath === '' && request.method === 'POST') {
			return withCors(await this.createUpload(request, target), cors);
		}
		const part = subPath.match(/^\/([^/]+)\/parts\/(\d{1,5})$/);
		if (part && request.method === 'PUT') {
			return withCors(
				await this.uploadPart(request, target, decodeURIComponent(part[1]), Number(part[2])),
				cors,
			);
		}
		const complete = subPath.match(/^\/([^/]+)\/complete$/);
		if (complete && request.method === 'POST') {
			return withCors(
				await this.completeUpload(request, target, decodeURIComponent(complete[1])),
				cors,
			);
		}
		const abort = subPath.match(/^\/([^/]+)$/);
		if (abort && request.method === 'DELETE') {
			return withCors(await this.abortUpload(target, decodeURIComponent(abort[1])), cors);
		}
		return withCors(Response.json({ error: 'not found' }, { status: 404 }), cors);
	}

	/**
	 * Create. The one multipart step that talks to the Durable Object, because
	 * the quota reservation and the concurrency count are facts only the
	 * parent holds. Every write rule runs here against DECLARED values, so a
	 * refusal costs the client nothing but one round trip.
	 */
	private async createUpload(request: Request, target: ObjectRouteTarget): Promise<Response> {
		const bucketBinding = this.env.BUCKET!;
		const answer = await this.bucketAccess(target.projectId, target.bucket, true);
		if (answer.status === 'erasing') return erasingResponse();
		if (answer.status === 'missing') {
			return Response.json({ error: 'no such bucket' }, { status: 404 });
		}
		const { config } = answer;

		let owner = '';
		if (!target.admin) {
			const decision = await checkAccess(
				request,
				this.env,
				target.projectId,
				config.write,
				config.writePermission,
			);
			if (!decision.ok) return decision.response;
			owner = decision.subject ?? '';
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'invalid JSON body' }, { status: 400 });
		}
		const parsed = createUploadRequestSchema.safeParse(body);
		if (!parsed.success) {
			return Response.json(
				{ error: parsed.error.issues[0]?.message ?? 'invalid request body' },
				{ status: 400 },
			);
		}
		const parsedKey = parseObjectKey(parsed.data.key);
		if (!parsedKey.ok) return Response.json({ error: parsedKey.error }, { status: 400 });
		const key = parsedKey.key;
		const size = parsed.data.size;
		const contentType = parsed.data.contentType ?? 'application/octet-stream';

		if (size > MAX_MULTIPART_BYTES) {
			return Response.json(
				{ error: `multipart uploads are limited to ${MAX_MULTIPART_BYTES} bytes` },
				{ status: 413 },
			);
		}
		// A per-bucket ceiling above the single-PUT cap only becomes meaningful
		// here - this is the path that can actually exceed it.
		if (config.maxObjectBytes !== null && size > config.maxObjectBytes) {
			return Response.json(
				{ error: `objects on this bucket are limited to ${config.maxObjectBytes} bytes` },
				{ status: 413 },
			);
		}
		if (!target.admin && config.allowedContentTypes?.length) {
			if (!contentTypeAllowed(contentType, config.allowedContentTypes)) {
				return Response.json(
					{ error: 'this content type is not allowed on this bucket' },
					{ status: 415 },
				);
			}
		}
		if (answer.stats.objectCount >= answer.maxObjects) {
			return Response.json(
				{ error: `buckets are limited to ${answer.maxObjects} objects` },
				{ status: 409 },
			);
		}
		// Owner mode: the same no-stealing-a-key rule single PUTs enforce,
		// applied before any part is accepted rather than at completion.
		const r2Key = r2ObjectKey(target.projectId, target.bucket, key);
		if (!target.admin && config.write === 'owner') {
			const existing = await bucketBinding.head(r2Key);
			if (existing && (existing.customMetadata?.owner ?? '') !== owner) {
				return Response.json({ error: 'you do not own this key' }, { status: 403 });
			}
		}

		const partSize = resolvePartSize(size);
		const created = await bucketBinding.createMultipartUpload(r2Key, {
			httpMetadata: { contentType },
			customMetadata: { owner, project: target.projectId },
		});

		const id = crypto.randomUUID();
		const agent = await getAgentByName<Env, StorageAgentBase>(
			this.env.StorageAgent,
			target.projectId,
		);
		const reserved = await agent.createUpload({
			id,
			bucket: target.bucket,
			key,
			r2UploadId: created.uploadId,
			partSize,
			reservedBytes: size,
			contentType,
			owner,
		});
		if (!reserved.ok) {
			// Refused AFTER the R2 upload exists, so clean it up now rather than
			// leave parts billing until R2's own 7-day abort.
			await created.abort().catch(() => undefined);
			return Response.json({ error: reserved.error }, { status: reserved.status });
		}

		const uploadId = await sealUpload(answer.signing, {
			projectId: target.projectId,
			bucket: target.bucket,
			key,
			reservationId: id,
			r2UploadId: created.uploadId,
			partSize,
			size,
			contentType,
			owner,
			expires: Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS,
		});
		return Response.json(
			{
				uploadId,
				key,
				partSize,
				parts: partCount(size, partSize),
				// Always `proxy` today; the field ships now so presigned transport
				// never changes the client contract.
				mode: 'proxy',
			},
			{ status: 201, headers: { 'cache-control': 'private, no-store' } },
		);
	}

	/** Open an upload token, or the refusal to send. Shared by every step
	 * after create, so the envelope rules live in exactly one place. */
	private async openEnvelope(
		target: ObjectRouteTarget,
		token: string,
	): Promise<{ ok: true; envelope: UploadEnvelope } | { ok: false; response: Response }> {
		const answer = await this.bucketAccess(target.projectId, target.bucket);
		if (answer.status === 'erasing') return { ok: false, response: erasingResponse() };
		if (answer.status === 'missing') {
			return { ok: false, response: Response.json({ error: 'no such bucket' }, { status: 404 }) };
		}
		let verdict = await openUpload(answer.signing, token, Math.floor(Date.now() / 1000));
		if (!verdict.ok && verdict.reason === 'version') {
			const fresh = await this.refetchForVersion(
				target.projectId,
				target.bucket,
				verdict.version,
				verdict.held,
			);
			if (fresh?.status === 'ok') {
				verdict = await openUpload(fresh.signing, token, Math.floor(Date.now() / 1000));
			}
		}
		if (!verdict.ok) {
			const expired = verdict.reason === 'expired';
			return {
				ok: false,
				response: Response.json(
					{ error: expired ? 'this upload has expired' : 'invalid upload id' },
					{ status: expired ? 410 : 403 },
				),
			};
		}
		// The envelope is bound to one tenant and bucket; a token minted
		// elsewhere cannot be steered at this route.
		if (
			verdict.envelope.projectId !== target.projectId ||
			verdict.envelope.bucket !== target.bucket
		) {
			return {
				ok: false,
				response: Response.json({ error: 'invalid upload id' }, { status: 403 }),
			};
		}
		return { ok: true, envelope: verdict.envelope };
	}

	/**
	 * One part. No DO hop and no access re-check: the envelope IS the
	 * capability, and it was issued to someone who passed the write gate for
	 * this exact key. Sizes are enforced here rather than at completion so a
	 * malformed client fails on its first part instead of after uploading
	 * gigabytes.
	 */
	private async uploadPart(
		request: Request,
		target: ObjectRouteTarget,
		token: string,
		partNumber: number,
	): Promise<Response> {
		const opened = await this.openEnvelope(target, token);
		if (!opened.ok) return opened.response;
		const { envelope } = opened;

		const total = partCount(envelope.size, envelope.partSize);
		if (partNumber < 1 || partNumber > total) {
			return Response.json({ error: `this upload has ${total} parts` }, { status: 400 });
		}
		const declared = Number(request.headers.get('content-length'));
		if (request.headers.get('content-length') === null || !Number.isFinite(declared)) {
			return Response.json({ error: 'Content-Length is required' }, { status: 411 });
		}
		// Every part but the last must be exactly partSize - R2's rule, checked
		// here because R2 only reports it at completion, by which time the
		// client has spent the whole upload.
		const expected =
			partNumber === total ? envelope.size - envelope.partSize * (total - 1) : envelope.partSize;
		if (declared !== expected) {
			return Response.json(
				{ error: `part ${partNumber} must be exactly ${expected} bytes` },
				{ status: 400 },
			);
		}

		const uploaded = await this.env
			.BUCKET!.resumeMultipartUpload(
				r2ObjectKey(envelope.projectId, envelope.bucket, envelope.key),
				envelope.r2UploadId,
			)
			.uploadPart(partNumber, request.body as ReadableStream);
		return Response.json(
			{ partNumber: uploaded.partNumber, etag: uploaded.etag },
			{ headers: { 'cache-control': 'private, no-store' } },
		);
	}

	/**
	 * Assemble. The real size is verified against the reservation with a
	 * `head()` - an invariant check while every part came through us, and the
	 * actual enforcement once parts can go straight to R2.
	 */
	private async completeUpload(
		request: Request,
		target: ObjectRouteTarget,
		token: string,
	): Promise<Response> {
		const opened = await this.openEnvelope(target, token);
		if (!opened.ok) return opened.response;
		const { envelope } = opened;

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'invalid JSON body' }, { status: 400 });
		}
		const parsed = completeUploadRequestSchema.safeParse(body);
		if (!parsed.success) {
			return Response.json(
				{ error: parsed.error.issues[0]?.message ?? 'invalid request body' },
				{ status: 400 },
			);
		}

		const r2Key = r2ObjectKey(envelope.projectId, envelope.bucket, envelope.key);
		const agent = await getAgentByName<Env, StorageAgentBase>(
			this.env.StorageAgent,
			envelope.projectId,
		);
		let object: R2Object;
		try {
			object = await this.env
				.BUCKET!.resumeMultipartUpload(r2Key, envelope.r2UploadId)
				.complete(parsed.data.parts);
		} catch (error) {
			return Response.json(
				{
					error: `could not complete this upload: ${error instanceof Error ? error.message : 'unknown error'}`,
				},
				{ status: 400 },
			);
		}

		// Declared vs actual. Over the reservation, the object goes away: the
		// quota was granted for what was promised, and keeping the overage
		// would make the reservation decorative.
		if (object.size > envelope.size) {
			await this.env.BUCKET!.delete(r2Key);
			await agent.releaseUpload(envelope.reservationId);
			return Response.json(
				{ error: 'the completed object is larger than the size this upload reserved' },
				{ status: 413 },
			);
		}

		const stats = await this.bucketStub(target).recordPut(this.identity(target), {
			key: envelope.key,
			size: object.size,
			etag: object.etag,
			contentType: envelope.contentType,
			owner: envelope.owner,
		});
		this.refreshCachedStats(target, stats);
		await agent.settleUpload(envelope.reservationId, envelope.bucket, object.size);
		return Response.json({
			object: {
				key: envelope.key,
				size: object.size,
				etag: object.etag,
				contentType: envelope.contentType,
				owner: envelope.owner,
			},
		});
	}

	/** Abort and refund. Idempotent by construction: R2 forgets the upload and
	 * the reservation row is deleted by id. */
	private async abortUpload(target: ObjectRouteTarget, token: string): Promise<Response> {
		const opened = await this.openEnvelope(target, token);
		if (!opened.ok) return opened.response;
		const { envelope } = opened;
		await this.env
			.BUCKET!.resumeMultipartUpload(
				r2ObjectKey(envelope.projectId, envelope.bucket, envelope.key),
				envelope.r2UploadId,
			)
			.abort()
			.catch(() => undefined);
		const agent = await getAgentByName<Env, StorageAgentBase>(
			this.env.StorageAgent,
			envelope.projectId,
		);
		await agent.releaseUpload(envelope.reservationId);
		return Response.json({ aborted: true });
	}

	/**
	 * Mint signed download URLs - the thing an `<img src>` can hold for an
	 * object nobody can send an Authorization header for.
	 *
	 * Minting requires exactly what READING requires, because a signed URL
	 * bypasses the read mode at serve time; that equivalence is the whole
	 * safety argument. `owner` mode therefore resolves ownership AT MINT with
	 * one `head()` per key, and a key the caller does not own answers exactly
	 * like a key that is not there.
	 */
	private async handleSignedUrls(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
	): Promise<Response> {
		if (DEMO_PROJECT_PATTERN.test(target.projectId)) {
			// Unreachable through fetch() - demoRoute answers demo ids first - but
			// kept so a dispatch reorder cannot quietly mint demo capabilities.
			return demoRefusal();
		}

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
		}
		if (request.method !== 'POST') {
			return withCors(
				Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'POST' } }),
				cors,
			);
		}

		// Minting reads the parent DIRECTLY, bypassing the isolate cache. The
		// zero-hop rule is about VERIFYING - the hot path an `<img src>` rides -
		// and paying one hop per mint buys correctness the cache cannot: a
		// stale entry would sign with a RETIRED secret, so a URL minted for
		// seven days would quietly stop working within the cache TTL, as soon
		// as any isolate caught up with the rotation. A signature must never
		// outlive the secret that made it.
		const answer = await this.bucketAccess(target.projectId, target.bucket, true);
		if (answer.status === 'erasing') return withCors(erasingResponse(), cors);
		if (answer.status === 'missing') {
			return withCors(Response.json({ error: 'no such bucket' }, { status: 404 }), cors);
		}
		const { config } = answer;

		let subject: string | null = null;
		if (!target.admin) {
			const decision = await checkAccess(
				request,
				this.env,
				target.projectId,
				config.read,
				config.readPermission,
			);
			if (!decision.ok) return withCors(decision.response, cors);
			subject = decision.owner;
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return withCors(Response.json({ error: 'invalid JSON body' }, { status: 400 }), cors);
		}
		const parsedBody = signedUrlRequestSchema.safeParse(body);
		if (!parsedBody.success) {
			return withCors(
				Response.json(
					{ error: parsedBody.error.issues[0]?.message ?? 'invalid request body' },
					{ status: 400 },
				),
				cors,
			);
		}
		const input = parsedBody.data;
		const method: SignedMethod = input.method ?? 'GET';
		const expiresIn = resolveTtlSeconds(input.expiresIn);
		const expires = Math.floor(Date.now() / 1000) + expiresIn;
		const expiresAt = new Date(expires * 1000).toISOString();
		const requested = input.keys ?? [input.key as string];

		// `owner` mode needs the stored object to answer who owns it. Only that
		// mode pays the head() - public and auth buckets mint with no R2 call.
		const ownerScoped = !target.admin && config.read === 'owner' && subject !== null;
		const bucketBinding = this.env.BUCKET;
		if (ownerScoped && !bucketBinding) return withCors(notConfigured(), cors);

		const results: Array<Record<string, unknown>> = [];
		for (const raw of requested) {
			const parsed = parseObjectKey(raw);
			if (!parsed.ok) {
				results.push({ key: raw, signedUrl: null, error: parsed.error });
				continue;
			}
			if (ownerScoped) {
				const stored = await bucketBinding!.head(
					r2ObjectKey(target.projectId, target.bucket, parsed.key),
				);
				// Not-yours reads exactly like not-there: a distinct answer would
				// confirm the key exists for another owner.
				if (!stored || stored.customMetadata?.owner !== subject) {
					results.push({ key: parsed.key, signedUrl: null, error: 'no such object' });
					continue;
				}
			}
			const signature = await signSubject(answer.signing.secret, {
				projectId: target.projectId,
				bucket: target.bucket,
				key: parsed.key,
				method,
				expires,
			});
			results.push({
				key: parsed.key,
				signedUrl: this.signedUrlFor(url, target, parsed.key, {
					version: answer.signing.version,
					expires,
					signature,
				}),
				error: null,
			});
		}

		// Single-key calls answer in the singular, Supabase-style, so the common
		// case is `const { signedUrl } = await res.json()` with no unwrapping.
		if (input.key) {
			const [only] = results;
			if (only.error) {
				return withCors(Response.json({ error: only.error }, { status: 404 }), cors);
			}
			return withCors(
				Response.json(
					{ key: only.key, signedUrl: only.signedUrl, method, expiresAt, expiresIn },
					{ headers: { 'cache-control': 'private, no-store' } },
				),
				cors,
			);
		}
		return withCors(
			Response.json(
				{ signedUrls: results, method, expiresAt, expiresIn },
				{ headers: { 'cache-control': 'private, no-store' } },
			),
			cors,
		);
	}

	/**
	 * Where a signed URL points: the ORIGIN THE REQUEST ARRIVED ON, always.
	 *
	 * The plan had this build on `STORAGE_SERVE_DOMAIN` when one is
	 * configured, and that is wrong for a reason neither environment made
	 * obvious until a signed URL was actually fetched: a serve domain being
	 * SET does not mean it is ROUTED. Production carries
	 * `cdn.frostbase.dev` with its worker route still commented out
	 * pending DNS, and the e2e stack points at a host that resolves nowhere
	 * and is reached only through the `x-frostbase-host` stand-in. Minting on it
	 * would hand out URLs that resolve to nothing, in both.
	 *
	 * The request's own origin has no such failure mode - the caller just
	 * reached us on it. And because the signature covers project, bucket, key,
	 * method and expiry but NEVER the host, a deployment that has routed its
	 * serving domain can swap the hostname on the returned URL and the same
	 * query string still verifies. One mint, both spellings.
	 */
	private signedUrlFor(
		url: URL,
		target: ObjectRouteTarget,
		key: string,
		signed: { version: number; expires: number; signature: string },
	): string {
		// A ROUTED serving domain wins, for two reasons beyond tidiness: the
		// bytes leave the console's origin, so an object can no longer be
		// reached on the host that holds operator cookies, and the URL is one
		// a customer can put in front of their own cache rules. Falls back to
		// the request's origin, which is always reachable by definition - the
		// caller just arrived on it.
		const serveOrigin = publicServeOrigin(this.env);
		const signedUrl = new URL(
			serveOrigin
				? `${serveOrigin}${serveObjectPath(target.projectId, target.bucket, key)}`
				: agentObjectUrl(url.origin, target.projectId, target.bucket, key),
		);
		signedUrl.searchParams.set(SIGNED_PARAM_VERSION, String(signed.version));
		signedUrl.searchParams.set(SIGNED_PARAM_EXPIRES, String(signed.expires));
		signedUrl.searchParams.set(SIGNED_PARAM_SIGNATURE, signed.signature);
		return signedUrl.toString();
	}

	private async routeObjectOp(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
	): Promise<Response> {
		// Listing - served by the index, never by R2 (sorting and totals).
		if (target.key === null) {
			if (request.method !== 'GET') {
				return Response.json({ error: 'method not allowed' }, { status: 405 });
			}
			return this.listObjects(request, url, target, answer);
		}

		const parsed = parseObjectKey(target.key);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		const key = parsed.key;

		switch (request.method) {
			case 'GET':
			case 'HEAD':
				return this.serveObject(request, url, target, answer, key);
			case 'PUT':
				return this.putObject(request, url, target, answer, key);
			case 'DELETE':
				return this.deleteObject(request, url, target, answer, key);
			default:
				return Response.json({ error: 'method not allowed' }, { status: 405 });
		}
	}

	private async listObjects(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
	): Promise<Response> {
		let owner: string | undefined;
		if (!target.admin) {
			const { config } = answer;
			if (config.read === 'public') {
				// Enumeration is a separate grant: serving one known key to anyone
				// is not the same as listing every key.
				if (!config.publicListing) {
					return Response.json({ error: 'listing is not public on this bucket' }, { status: 403 });
				}
			} else {
				const decision = await checkAccess(
					request,
					this.env,
					target.projectId,
					config.read,
					config.readPermission,
				);
				if (!decision.ok) return decision.response;
				if (decision.owner !== null) owner = decision.owner;
			}
		}

		const prefix = url.searchParams.get('prefix') ?? undefined;
		if (prefix !== undefined && prefix.length > 1024) {
			return Response.json({ error: 'prefix too long' }, { status: 400 });
		}
		// Only `/` collapses folders. Keys use it as their one path separator
		// (keys.ts validates around it), so any other delimiter would describe
		// a hierarchy the rest of the agent does not believe in - refuse rather
		// than serve a second, inconsistent notion of a folder.
		const rawDelimiter = url.searchParams.get('delimiter');
		if (rawDelimiter !== null && rawDelimiter !== '/') {
			return Response.json({ error: 'the only supported delimiter is /' }, { status: 400 });
		}
		const delimiter = rawDelimiter === '/' ? '/' : undefined;
		const cursor = objectCursorSchema.parse(url.searchParams.get('cursor') ?? undefined);
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

		const result = await this.bucketStub(target).listObjects({
			prefix,
			cursor,
			limit,
			owner,
			delimiter,
		});
		return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
	}

	private async serveObject(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
		key: string,
	): Promise<Response> {
		const bucket = this.env.BUCKET;
		if (!bucket) return notConfigured();
		const { config } = answer;

		// A valid signature stands in for the read gate - that IS the point of
		// a signed URL. Checked before the mode so a signed request never needs
		// a token, and STRICTLY: a signature that is present must verify, even
		// on a public bucket, so a tampered or expired one can never appear to
		// work just because the bucket happens to be open.
		const signed = await this.checkSignature(url, target, answer, request.method, key);
		if (signed instanceof Response) return signed;

		let subject: string | null = null;
		if (!signed && !target.admin && config.read !== 'public') {
			const decision = await checkAccess(
				request,
				this.env,
				target.projectId,
				config.read,
				config.readPermission,
			);
			if (!decision.ok) return decision.response;
			subject = decision.subject;
		}

		// The shared cache serves only the plain public GET. Range and
		// conditional requests go to R2: the cache key is a bare URL, so a
		// match would answer a full 200 where the conditionals deserve 304/206.
		// A signed read is never cacheable and never `public`: the cache key is
		// path-only, so one cached signed response would serve every later
		// caller of that path, signature or not.
		const publicRead = target.admin || signed ? false : config.read === 'public';
		const cacheable =
			publicRead &&
			!signed &&
			request.method === 'GET' &&
			!request.headers.has('authorization') &&
			!request.headers.has('range') &&
			!request.headers.has('if-none-match') &&
			!request.headers.has('if-modified-since') &&
			!request.headers.has('if-match');
		const cacheKey = this.cacheKey(url);
		if (cacheable) {
			const hit = await caches.default.match(cacheKey);
			if (hit) return hit;
		}

		const r2Key = r2ObjectKey(target.projectId, target.bucket, key);
		// The range option is passed only when the request actually carries a
		// Range header: the local R2 simulator populates `object.range` on FULL
		// gets (production leaves it undefined), and a 206 is only ever a valid
		// answer to a request that asked for a range.
		const wantsRange = request.headers.has('range');
		let object: R2Object | R2ObjectBody | null;
		try {
			object =
				request.method === 'HEAD'
					? await bucket.head(r2Key)
					: await bucket.get(r2Key, {
							onlyIf: request.headers,
							range: wantsRange ? request.headers : undefined,
						});
		} catch (error) {
			if (/range/i.test(error instanceof Error ? error.message : '')) {
				return Response.json({ error: 'range not satisfiable' }, { status: 416 });
			}
			throw error;
		}
		if (!object) {
			// Phantom-row prune: the index thought it existed, R2 disagrees.
			this.ctx.waitUntil(
				this.bucketStub(target)
					.recordDelete(this.identity(target), key)
					.then(() => undefined)
					.catch(() => undefined),
			);
			return Response.json({ error: 'no such object' }, { status: 404 });
		}

		// Owner-mode reads authorize off custom metadata already in hand - one
		// R2 op, zero DO hops. Not-yours answers exactly like not-there.
		// Ownership was resolved AT MINT for a signed read, with a head() on this
		// same key - re-checking here would refuse it, because a signed request
		// carries no token and so has no subject to compare against.
		if (!signed && !target.admin && config.read === 'owner') {
			const owner = object.customMetadata?.owner ?? '';
			if (!owner || owner !== subject) {
				return Response.json({ error: 'no such object' }, { status: 404 });
			}
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('accept-ranges', 'bytes');
		headers.set('x-content-type-options', 'nosniff');
		const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
		headers.set('content-type', contentType);
		// Serve-time policy, not write-time: presigned writes (S2.5) bypass
		// write-time checks by design, so the serving layer decides what may
		// render inline - and HTML/SVG/XML never do.
		headers.set('content-disposition', contentDisposition(contentType));
		headers.set(
			'cache-control',
			publicRead ? (config.cacheControl ?? DEFAULT_PUBLIC_CACHE_CONTROL) : 'private, no-store',
		);

		if (request.method === 'HEAD') {
			headers.set('content-length', String(object.size));
			return new Response(null, { status: 200, headers });
		}

		if (!isR2ObjectBody(object)) {
			// R2 answered metadata-only: a conditional held. Distinguish the
			// not-modified read from the failed-precondition write shape.
			if (request.headers.has('if-none-match') || request.headers.has('if-modified-since')) {
				return new Response(null, { status: 304, headers });
			}
			return new Response(null, { status: 412, headers });
		}

		const body: ReadableStream = object.body;
		if (wantsRange && object.range) {
			// Test the VALUE, not the key: the local R2 simulator materializes
			// `suffix: undefined` beside offset/length, so `'suffix' in range`
			// lies and `size - undefined` is NaN.
			const range = object.range as { offset?: number; length?: number; suffix?: number };
			const offset =
				typeof range.suffix === 'number' ? object.size - range.suffix : (range.offset ?? 0);
			const length =
				typeof range.suffix === 'number' ? range.suffix : (range.length ?? object.size - offset);
			headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
			headers.set('content-length', String(length));
			return new Response(body, { status: 206, headers });
		}

		headers.set('content-length', String(object.size));
		const response = new Response(body, { status: 200, headers });
		if (cacheable) {
			this.ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
		}
		return response;
	}

	private async putObject(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
		key: string,
	): Promise<Response> {
		const bucket = this.env.BUCKET;
		if (!bucket) return notConfigured();
		const { config } = answer;

		let owner = '';
		if (!target.admin) {
			const decision = await checkAccess(
				request,
				this.env,
				target.projectId,
				config.write,
				config.writePermission,
			);
			if (!decision.ok) return decision.response;
			owner = decision.subject ?? '';
		}

		// A stream R2 can store needs a declared length; chunked bodies are
		// refused rather than buffered (a 100 MB buffer in a shared isolate is
		// a memory bomb).
		const declaredLength = Number(request.headers.get('content-length'));
		if (
			request.headers.get('content-length') === null ||
			!Number.isFinite(declaredLength) ||
			declaredLength < 0
		) {
			return Response.json({ error: 'Content-Length is required' }, { status: 411 });
		}
		const singlePutCap = Math.min(
			config.maxObjectBytes ?? MAX_SINGLE_PUT_BYTES,
			MAX_SINGLE_PUT_BYTES,
		);
		if (declaredLength > singlePutCap) {
			return Response.json(
				{ error: `objects on this bucket are limited to ${singlePutCap} bytes` },
				{ status: 413 },
			);
		}
		// Quota checks ride the cached parent answer - eventual by design,
		// bounded by the report debounce plus the cache TTL.
		if (answer.projectBytes + declaredLength > answer.maxProjectBytes) {
			return Response.json({ error: 'project storage quota exceeded' }, { status: 413 });
		}
		if (answer.stats.objectCount >= answer.maxObjects) {
			return Response.json(
				{ error: `buckets are limited to ${answer.maxObjects} objects` },
				{ status: 409 },
			);
		}

		const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
		if (!target.admin && config.allowedContentTypes && config.allowedContentTypes.length) {
			if (!contentTypeAllowed(contentType, config.allowedContentTypes)) {
				return Response.json(
					{ error: 'this content type is not allowed on this bucket' },
					{ status: 415 },
				);
			}
		}

		const r2Key = r2ObjectKey(target.projectId, target.bucket, key);

		// Owner mode: an existing key someone else wrote must not be
		// overwritable - one head() before the put, owner-mode only.
		if (!target.admin && config.write === 'owner') {
			const existing = await bucket.head(r2Key);
			if (existing && (existing.customMetadata?.owner ?? '') !== owner) {
				return Response.json({ error: 'you do not own this key' }, { status: 403 });
			}
		}

		let stored: R2Object;
		try {
			stored = await bucket.put(r2Key, request.body ?? new Uint8Array(0), {
				httpMetadata: { contentType },
				customMetadata: { owner, project: target.projectId },
			});
		} catch (error) {
			Sentry.captureException(error, {
				tags: { operation: 'storage-put', projectId: target.projectId },
			});
			return Response.json({ error: 'storing the object failed' }, { status: 502 });
		}

		// R2 first, index after: the row wants the put's REAL size and etag.
		// Awaited (not waitUntil) so an index failure is visible to the caller
		// - until the reconcile alarm exists (S2), a silent orphan would be
		// unfindable and billed forever.
		try {
			const stats = await this.bucketStub(target).recordPut(this.identity(target), {
				key,
				size: stored.size,
				etag: stored.etag,
				contentType,
				owner,
			});
			this.refreshCachedStats(target, stats);
		} catch (error) {
			Sentry.captureException(error, {
				tags: { operation: 'storage-index', projectId: target.projectId },
			});
			return Response.json(
				{ error: 'the object was stored but indexing failed - retry the upload' },
				{ status: 502 },
			);
		}

		// The write is visible everywhere once colo caches expire; delete our
		// own colo's copies BEFORE answering (cache.delete is per-colo by
		// platform) - awaited, not waitUntil, so the writer's own immediate
		// re-read never races the purge and same-colo read-your-writes holds.
		await this.purgeCaches(url, target, key);

		return Response.json(
			{
				object: {
					key,
					size: stored.size,
					etag: stored.etag,
					contentType,
					owner,
				},
			},
			{ status: 200 },
		);
	}

	private async deleteObject(
		request: Request,
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
		key: string,
	): Promise<Response> {
		const bucket = this.env.BUCKET;
		if (!bucket) return notConfigured();
		const { config } = answer;

		let subject: string | null = null;
		if (!target.admin) {
			const decision = await checkAccess(
				request,
				this.env,
				target.projectId,
				config.write,
				config.writePermission,
			);
			if (!decision.ok) return decision.response;
			subject = decision.subject;
		}

		const r2Key = r2ObjectKey(target.projectId, target.bucket, key);
		if (!target.admin && config.write === 'owner') {
			const existing = await bucket.head(r2Key);
			if (existing && (existing.customMetadata?.owner ?? '') !== subject) {
				return Response.json({ error: 'no such object' }, { status: 404 });
			}
		}

		// R2 FIRST, index after: a crash here leaves a benign phantom row (a
		// later GET prunes it), never an unindexed orphan.
		await bucket.delete(r2Key);
		const stats = await this.bucketStub(target)
			.recordDelete(this.identity(target), key)
			.catch(() => null);
		if (stats) this.refreshCachedStats(target, stats);
		// Awaited for the same reason as the put path: the deleter's own
		// immediate re-read must see the delete, not a cached 200.
		await this.purgeCaches(url, target, key);
		return Response.json({ deleted: true });
	}

	// -----------------------------------------------------------------
	// Plumbing

	private identity(target: ObjectRouteTarget): BucketIdentity {
		return { projectId: target.projectId, bucket: target.bucket };
	}

	private bucketStub(target: ObjectRouteTarget): StorageBucketBase {
		const namespace = this.env.StorageBucket as unknown as DurableObjectNamespace;
		return namespace.get(
			namespace.idFromName(`${target.projectId}:${target.bucket}`),
		) as unknown as StorageBucketBase;
	}

	/** The shared-cache key: path only, so a query string can never mint a
	 * fresh cache entry for the same object. */
	private cacheKey(url: URL): string {
		return `${url.origin}${url.pathname}`;
	}

	/** Purge this colo's cached copies of an object - the request URL and, when
	 * a serving domain is configured, its `/<pid>/<bucket>/<key>` spelling too
	 * (the same bytes are addressable both ways). */
	private async purgeCaches(url: URL, target: ObjectRouteTarget, key: string): Promise<void> {
		try {
			await caches.default.delete(this.cacheKey(url));
			const domain = this.env.STORAGE_SERVE_DOMAIN;
			if (domain) {
				// serveObjectPath, not a hand-built string: the purge spelling must
				// be byte-identical to the spelling serve requests are cached under,
				// or an overwrite keeps serving the old bytes until TTL.
				const objectPath = serveObjectPath(target.projectId, target.bucket, key);
				for (const host of [domain, ...this.serveDomainAliases()]) {
					await caches.default.delete(`https://${host}${objectPath}`);
				}
			}
		} catch {
			// purging is best-effort; the short default TTL is the backstop
		}
	}

	/**
	 * Verify a signed URL, if the request carries one.
	 *
	 * Returns `false` when there is no signature (carry on with the ordinary
	 * gate), `true` when one verified, or the refusal to send. Costs zero
	 * Durable Object hops: the secret arrives inside the access answer this
	 * request already paid for.
	 *
	 * The one exception is a VERSION mismatch, which MAY mean the secret moved
	 * since this isolate cached it. That is not necessarily a forgery, so it
	 * refetches and re-checks - which is what lets a URL minted from a rotated
	 * secret work immediately against an isolate still holding the old one.
	 * That refetch is throttled (`refetchForVersion`): the version is caller
	 * input on an unauthenticated path, and an unthrottled bypass of the cache
	 * is a lever on the single-threaded coordinator DO.
	 *
	 * Note the asymmetry, because it bounds revocation: this rescues NEW URLs
	 * against a stale cache, not old URLs against one. An already-issued URL
	 * names the version the stale isolate still holds, so it keeps verifying
	 * until that entry expires (ACCESS_CACHE_TTL_MS) or any request carrying
	 * the newer version pulls the isolate forward. Rotation is bounded-time
	 * revocation, the same bargain a restrictive access flip makes.
	 */
	private async checkSignature(
		url: URL,
		target: ObjectRouteTarget,
		answer: Extract<BucketAccessAnswer, { status: 'ok' }>,
		method: string,
		key: string,
	): Promise<boolean | Response> {
		if (!hasSignedParams(url)) return false;
		const refuse = (error: string) => Response.json({ error }, { status: 403 });

		const params = parseSignedParams(url);
		if (!params) return refuse('invalid signed URL');
		if (method !== 'GET' && method !== 'HEAD') {
			// Only reads are signable; a signature on a write is meaningless and
			// must never read as authorization for one.
			return refuse('signed URLs authorize GET and HEAD only');
		}

		const subject = {
			projectId: target.projectId,
			bucket: target.bucket,
			key,
			method: method as SignedMethod,
		};
		const now = Math.floor(Date.now() / 1000);
		let verdict = await verifySignature(answer.signing, params, subject, now);

		if (!verdict.ok && verdict.reason === 'version') {
			const fresh = await this.refetchForVersion(
				target.projectId,
				target.bucket,
				verdict.version,
				verdict.held,
			);
			if (fresh) {
				if (fresh.status !== 'ok') return refuse('invalid signed URL');
				verdict = await verifySignature(fresh.signing, params, subject, now);
			}
		}

		if (verdict.ok) return true;
		if (verdict.reason === 'expired') return refuse('this signed URL has expired');
		// A rotated-away version and a forgery are the same answer to the
		// caller: the URL is no longer good, and which it was is not their
		// business.
		return refuse('invalid signed URL');
	}

	private async bucketAccess(
		projectId: string,
		bucket: string,
		force = false,
	): Promise<BucketAccessAnswer> {
		const cacheId = `${projectId}:${bucket}`;
		const cached = accessCache.get(cacheId);
		if (!force && cached && cached.expires > Date.now()) return cached.answer;

		const agent = await getAgentByName<Env, StorageAgentBase>(this.env.StorageAgent, projectId);
		const answer = await agent.getBucketAccess(bucket);
		if (accessCache.size >= ACCESS_CACHE_MAX) accessCache.clear();
		accessCache.set(cacheId, {
			answer,
			expires: Date.now() + (answer.status === 'ok' ? ACCESS_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
		});
		return answer;
	}

	/**
	 * The throttled refetch a version mismatch may force (`mayRefetchForVersion`).
	 * The MINT paths still call `bucketAccess(..., true)` directly and stay
	 * unthrottled: they are gated surfaces, and signing off a stale entry would
	 * sign with a retired secret. Null = did not ask, so the caller keeps the
	 * verdict it already has.
	 */
	private async refetchForVersion(
		projectId: string,
		bucket: string,
		requested: number,
		held: number,
	): Promise<BucketAccessAnswer | null> {
		const cacheId = `${projectId}:${bucket}`;
		const now = Date.now();
		if (!mayRefetchForVersion(requested, held, accessCache.get(cacheId)?.forcedAt, now)) {
			return null;
		}
		const answer = await this.bucketAccess(projectId, bucket, true);
		// Stamp the entry the refetch just wrote, so the next mismatch in the
		// window is refused without a hop.
		const entry = accessCache.get(cacheId);
		if (entry) entry.forcedAt = now;
		return answer;
	}

	/** Keep the cached quota view roughly current between refreshes, so a
	 * burst inside one TTL cannot sail far past a ceiling. */
	private refreshCachedStats(
		target: ObjectRouteTarget,
		stats: { objectCount: number; totalBytes: number },
	): void {
		const cached = accessCache.get(`${target.projectId}:${target.bucket}`);
		if (!cached || cached.answer.status !== 'ok') return;
		const delta = stats.totalBytes - cached.answer.stats.totalBytes;
		cached.answer.stats = stats;
		cached.answer.projectBytes = Math.max(cached.answer.projectBytes + delta, 0);
	}

	/** Records any 5xx leaving this worker. Never replaces the response. */
	private async reportServerError(request: Request, url: URL, response: Response): Promise<void> {
		if (response.status < 500) return;
		try {
			const body = (await response.clone().text()).slice(0, 2048);
			Sentry.captureMessage(`Storage agent returned HTTP ${response.status}`, {
				level: 'error',
				tags: { 'http.method': request.method, 'http.status_code': response.status },
				contexts: {
					response: { body, contentType: response.headers.get('content-type') ?? '' },
				},
				extra: { pathname: url.pathname },
			});
		} catch {
			// reporting must never replace the response
		}
	}
}

function isR2ObjectBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
	return 'body' in object && Boolean((object as R2ObjectBody).body);
}

/**
 * Decodes a raw path-key: each segment individually, so an encoded slash
 * becomes part of the key rather than a new route segment - and the result
 * still passes through parseObjectKey, which refuses dot segments whatever
 * spelling they arrived in. Returns null on malformed percent-encoding.
 */
function decodePathKey(rawKey: string): string | null {
	try {
		return rawKey
			.split('/')
			.map((segment) => decodeURIComponent(segment))
			.join('/');
	} catch {
		return null;
	}
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
	const bare = contentType.split(';')[0].trim().toLowerCase();
	return allowed.some((entry) => {
		const rule = entry.toLowerCase();
		if (rule.endsWith('/*')) return bare.startsWith(rule.slice(0, -1));
		return bare === rule;
	});
}

export const StorageAgent = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	StorageAgentBase,
);
export const StorageBucket = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	StorageBucketBase,
);

export type { StorageAgentState, StorageBucketSummary } from './agent.js';
export type { ObjectSummary } from './bucket.js';
export type { AssertStorageAgentEnv, StorageAgentBindings } from './bindings.js';

export default Sentry.withSentry(sentryOptions, StorageService);
