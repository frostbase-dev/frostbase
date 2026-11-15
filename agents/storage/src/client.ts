import { SIGNED_URL_MAX_TTL_SECONDS, type SignedMethod } from './signing.js';

/**
 * Thin isomorphic client for the storage agent (browsers and Node >= 22). No
 * Workers imports, no dependencies.
 *
 * The vocabulary is Supabase Storage's on purpose - `from(bucket).upload()`,
 * `.download()`, `.list()`, `.remove()`, `.createSignedUrl()` - because that
 * is what people moving to this already have in their fingers, and a storage
 * API is not the place to be original. Where the semantics differ from
 * Supabase's, the METHOD NAMES still match and the difference is documented on
 * the method; silently reusing a name for different behaviour would be worse
 * than a new name.
 *
 * This is the END-USER client: it speaks the public object paths with a
 * project JWT, so every call is subject to the bucket's access modes, owner
 * scoping, and permission keys. The server-side counterpart is
 * `@frostbase-dev/storage/admin`, which bypasses modes over a service key and
 * REFUSES to construct in a browser.
 *
 * Bytes go straight to the agent, never through a JSON proxy: uploads and
 * downloads stream, and `upload()` sets `Content-Length` from the body because
 * the agent refuses a chunked body (411) rather than buffer 100 MB into a
 * shared isolate.
 */

export interface StorageClientOptions {
	/**
	 * The agent base for your project -
	 * `https://<your-console>/agents/storage-agent/<projectId>`.
	 *
	 * The console proxy base (`.../api/projects/<projectId>/storage`) is
	 * accepted and rewritten, because it is the natural guess and the public
	 * object paths do not exist there: only the operator mirror is proxied, so
	 * the guess would 404 in a way that looks like a broken install.
	 */
	baseUrl: string;
	/**
	 * The dedicated object-serving origin, when your deployment routes one at
	 * the storage worker (`https://cdn.example.com`). Only `getPublicUrl()`
	 * uses it - every request this client makes still goes to `baseUrl`,
	 * because the serving domain is GET/HEAD only.
	 *
	 * Passed rather than discovered: `getPublicUrl` builds a string and makes
	 * no request, so there is nowhere to learn this without turning a sync call
	 * into an async one. The console's Integration tab prints the value your
	 * deployment actually has.
	 */
	publicBaseUrl?: string;
	/** Called per request; return null for public buckets. */
	getToken?: () => Promise<string | null> | string | null;
}

export class StorageError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'StorageError';
	}
}

export interface StorageObject {
	key: string;
	size: number;
	etag: string;
	contentType: string;
	owner: string;
	createdAt: string;
	updatedAt: string;
}

export interface StorageFolder {
	/** The prefix INCLUDING its trailing `/`. */
	prefix: string;
	/** Objects beneath it at any depth. */
	objectCount: number;
}

export interface ListOptions {
	/** Restrict to keys starting with this. With `folders`, it is the folder
	 * you are looking inside - pass the trailing `/`. */
	prefix?: string;
	/**
	 * Collapse into a folder view: only DIRECT children come back as objects,
	 * everything deeper as `folders`. Off by default, which lists the whole
	 * subtree flat - the difference between a file browser and a key dump.
	 */
	folders?: boolean;
	/** Page size, 1-200 (default 50). */
	limit?: number;
	/** Continuation from a previous page's `cursor`. */
	cursor?: string;
}

export interface ListResult {
	objects: StorageObject[];
	/** Matching objects at this level, for a `range of total` readout. */
	total: number;
	/** Pass back as `cursor`; null on the last page. */
	cursor: string | null;
	/** Only for a folder listing. */
	folders?: StorageFolder[];
	/** More folders exist than were returned. Never silently dropped. */
	foldersTruncated?: boolean;
}

export interface UploadOptions {
	/**
	 * Defaults to the `type` of a File/Blob body, else
	 * `application/octet-stream`. Buckets may enforce a write-time allowlist,
	 * and it is what decides inline-vs-download at serve time.
	 */
	contentType?: string;
	/** Called after each part of a multipart upload. Never called for a
	 * single-shot PUT, which has nothing to report between 0 and done. */
	onProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void;
}

/** The single-PUT ceiling. Above it `upload()` escalates to multipart on its
 * own - the developer never picks a transport, which is the whole point. */
export const SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024;

export interface SignedUrlOptions {
	/** Seconds. Default 3600, capped at 7 days by the agent. */
	expiresIn?: number;
	/** Default GET. Signed URLs authorize reads only. */
	method?: SignedMethod;
}

export interface SignedUrlResult {
	key: string;
	signedUrl: string;
	method: SignedMethod;
	expiresAt: string;
	expiresIn: number;
}

export interface BatchSignedUrl {
	key: string;
	signedUrl: string | null;
	/** Per-key failure (an invalid key, or one this caller does not own);
	 * the call itself still succeeds. */
	error: string | null;
}

type BodyInit_ = Blob | ArrayBuffer | ArrayBufferView | string;

/**
 * Accepts the agent base or the console proxy base and normalizes to the
 * former. `/api/projects/<pid>/storage` carries the project id in a position
 * we can read, which is what makes the rewrite possible at all.
 */
function normalizeBaseUrl(input: string): string {
	const trimmed = input.replace(/\/+$/, '');
	const proxy = trimmed.match(/^(.*)\/api\/projects\/([^/]+)\/storage$/);
	if (!proxy) return trimmed;
	return `${proxy[1]}/agents/storage-agent/${proxy[2]}`;
}

/** Percent-encode each segment while keeping `/` as a real separator. */
function encodeKey(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}

/** An explicit type wins; else a Blob/File already knows its own. */
function resolveContentType(body: BodyInit_, options: UploadOptions): string {
	if (options.contentType) return options.contentType;
	if (typeof Blob !== 'undefined' && body instanceof Blob && body.type) return body.type;
	return 'application/octet-stream';
}

/** Byte length of a body we are about to PUT. The agent requires an explicit
 * Content-Length (chunked is refused, not buffered), and `fetch` will not set
 * one for a stream - so anything without a knowable length is refused HERE,
 * with a reason, rather than as a 411 from the server. */
function byteLength(body: BodyInit_): number | null {
	if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
	return null;
}

export function createStorageClient(options: StorageClientOptions) {
	const baseUrl = normalizeBaseUrl(options.baseUrl);

	async function authHeaders(): Promise<Record<string, string>> {
		const token = await options.getToken?.();
		return token ? { authorization: `Bearer ${token}` } : {};
	}

	async function failure(response: Response, fallback: string): Promise<never> {
		const payload = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new StorageError(response.status, payload?.error ?? fallback);
	}

	function bucketUrl(bucket: string, subPath: string): string {
		return `${baseUrl}/buckets/${encodeURIComponent(bucket)}${subPath}`;
	}

	return {
		/** A handle on one bucket. Cheap - it holds no state and opens nothing. */
		from(bucket: string) {
			const objectUrl = (key: string) => bucketUrl(bucket, `/objects/${encodeKey(key)}`);

			// A named handle, not `this`: `upload` escalates to `uploadMultipart`
			// through it, and `this` would break the moment a caller destructures
			// the method - a size-dependent crash, since only bodies over the
			// single-PUT ceiling take the escalation path.
			const handle = {
				/**
				 * Store an object, creating or REPLACING it.
				 *
				 * ONE call for every size: above the single-PUT ceiling this
				 * escalates to multipart by itself. The developer never picks a
				 * transport and the loop never branches on one - the server
				 * decides the part size, because R2 requires every part but the
				 * last to be identical and a client that guesses can produce an
				 * upload that cannot complete.
				 *
				 * Unlike Supabase there is no `upsert` flag: a put always
				 * overwrites, because R2 has no cheap create-if-absent and a flag
				 * would be a lie with a race inside it. On an `owner`-mode bucket
				 * you cannot overwrite someone else's key (403) - the real guard.
				 */
				async upload(
					key: string,
					body: BodyInit_,
					uploadOptions: UploadOptions = {},
				): Promise<StorageObject> {
					const length = byteLength(body);
					if (length === null) {
						throw new StorageError(
							0,
							'upload() needs a body whose length is known (string, Blob/File, ArrayBuffer, or a view). ' +
								'The agent refuses a chunked body rather than buffer it, so a stream cannot be sent this way.',
						);
					}
					if (length > SINGLE_PUT_MAX_BYTES) {
						return handle.uploadMultipart(key, body, uploadOptions);
					}
					const response = await fetch(objectUrl(key), {
						method: 'PUT',
						headers: {
							...(await authHeaders()),
							'content-type': resolveContentType(body, uploadOptions),
							'content-length': String(length),
						},
						body: body as BodyInit,
					});
					if (!response.ok) await failure(response, `upload failed (${response.status})`);
					return ((await response.json()) as { object: StorageObject }).object;
				},

				/**
				 * Force the multipart protocol whatever the size. `upload()` calls
				 * this for you above the ceiling; reach for it directly when you
				 * want per-part progress on a smaller file, or to keep memory flat
				 * by slicing a File you never materialize.
				 *
				 * Parts go up sequentially. Concurrency would be faster and is a
				 * later change - doing it now would mean picking a window size
				 * with no evidence, and a stalled part would be harder to
				 * attribute.
				 */
				async uploadMultipart(
					key: string,
					body: BodyInit_,
					uploadOptions: UploadOptions = {},
				): Promise<StorageObject> {
					const length = byteLength(body);
					if (length === null) {
						throw new StorageError(0, 'uploadMultipart() needs a body whose length is known.');
					}
					const contentType = resolveContentType(body, uploadOptions);
					// Slicing is what keeps memory flat, and only a Blob can slice -
					// so a non-Blob body is wrapped once rather than copied per part.
					const blob =
						typeof Blob !== 'undefined' && body instanceof Blob
							? body
							: new Blob([body as unknown as ArrayBuffer], { type: contentType });

					const created = await fetch(bucketUrl(bucket, '/uploads'), {
						method: 'POST',
						headers: { ...(await authHeaders()), 'content-type': 'application/json' },
						body: JSON.stringify({ key, size: length, contentType }),
					});
					if (!created.ok) await failure(created, `upload could not start (${created.status})`);
					const session = (await created.json()) as {
						uploadId: string;
						partSize: number;
						parts: number;
					};

					const uploaded: { partNumber: number; etag: string }[] = [];
					try {
						for (let index = 0; index < session.parts; index += 1) {
							const start = index * session.partSize;
							const chunk = blob.slice(start, Math.min(start + session.partSize, length));
							const partNumber = index + 1;
							const response = await fetch(
								bucketUrl(
									bucket,
									`/uploads/${encodeURIComponent(session.uploadId)}/parts/${partNumber}`,
								),
								{
									method: 'PUT',
									headers: { ...(await authHeaders()), 'content-length': String(chunk.size) },
									body: chunk,
								},
							);
							if (!response.ok) await failure(response, `part ${partNumber} failed`);
							uploaded.push((await response.json()) as { partNumber: number; etag: string });
							uploadOptions.onProgress?.({
								uploadedBytes: Math.min(start + session.partSize, length),
								totalBytes: length,
							});
						}
					} catch (error) {
						// Abandoning without aborting would leave parts billing until
						// the agent's 24h sweep. Best effort: the sweep is the backstop,
						// not the plan.
						await fetch(bucketUrl(bucket, `/uploads/${encodeURIComponent(session.uploadId)}`), {
							method: 'DELETE',
							headers: await authHeaders(),
						}).catch(() => undefined);
						throw error;
					}

					const completed = await fetch(
						bucketUrl(bucket, `/uploads/${encodeURIComponent(session.uploadId)}/complete`),
						{
							method: 'POST',
							headers: { ...(await authHeaders()), 'content-type': 'application/json' },
							body: JSON.stringify({ parts: uploaded }),
						},
					);
					if (!completed.ok) await failure(completed, `upload could not complete`);
					return ((await completed.json()) as { object: StorageObject }).object;
				},

				/** Fetch an object's bytes. Returns the raw `Response` so callers
				 * choose how to consume it - `.blob()`, `.text()`, or the stream -
				 * and so a large download never has to be materialized. */
				async download(key: string): Promise<Response> {
					const response = await fetch(objectUrl(key), { headers: await authHeaders() });
					if (!response.ok) await failure(response, `download failed (${response.status})`);
					return response;
				},

				/** Metadata without the bytes. */
				async info(key: string): Promise<{ size: number; contentType: string; etag: string }> {
					const response = await fetch(objectUrl(key), {
						method: 'HEAD',
						headers: await authHeaders(),
					});
					if (!response.ok) await failure(response, `not found (${response.status})`);
					return {
						size: Number(response.headers.get('content-length') ?? 0),
						contentType: response.headers.get('content-type') ?? 'application/octet-stream',
						etag: response.headers.get('etag') ?? '',
					};
				},

				/**
				 * List objects. Flat by default; pass `folders: true` for the
				 * file-browser view. Enumeration is a separate grant from reading
				 * on public buckets, so this can 403 where `download()` succeeds.
				 */
				async list(listOptions: ListOptions = {}): Promise<ListResult> {
					const query = new URLSearchParams();
					if (listOptions.prefix) query.set('prefix', listOptions.prefix);
					if (listOptions.folders) query.set('delimiter', '/');
					if (listOptions.limit !== undefined) query.set('limit', String(listOptions.limit));
					if (listOptions.cursor) query.set('cursor', listOptions.cursor);
					const search = query.toString();
					const response = await fetch(bucketUrl(bucket, `/objects${search ? `?${search}` : ''}`), {
						headers: await authHeaders(),
					});
					if (!response.ok) await failure(response, `list failed (${response.status})`);
					return (await response.json()) as ListResult;
				},

				/** Delete objects. Sequential rather than one batch call: the agent
				 * has no batch delete, and inventing one client-side that reports a
				 * single verdict for many keys would hide partial failure. */
				async remove(keys: string[]): Promise<{ key: string; error: string | null }[]> {
					const results: { key: string; error: string | null }[] = [];
					for (const key of keys) {
						const response = await fetch(objectUrl(key), {
							method: 'DELETE',
							headers: await authHeaders(),
						});
						if (response.ok) {
							results.push({ key, error: null });
							continue;
						}
						const payload = (await response.json().catch(() => null)) as { error?: string } | null;
						results.push({ key, error: payload?.error ?? `delete failed (${response.status})` });
					}
					return results;
				},

				/**
				 * A URL that reads this object with NO credential attached - for an
				 * `<img src>`, a download link, or anywhere a header cannot travel.
				 * Minting needs whatever reading needs, since the URL bypasses the
				 * read mode once issued.
				 */
				async createSignedUrl(
					key: string,
					signedOptions: SignedUrlOptions = {},
				): Promise<SignedUrlResult> {
					if (
						signedOptions.expiresIn !== undefined &&
						signedOptions.expiresIn > SIGNED_URL_MAX_TTL_SECONDS
					) {
						// Clamped server-side anyway; saying so here beats silently
						// handing back a URL that dies sooner than asked.
						throw new StorageError(
							0,
							`expiresIn is capped at ${SIGNED_URL_MAX_TTL_SECONDS} seconds (7 days)`,
						);
					}
					const response = await fetch(bucketUrl(bucket, '/signed-urls'), {
						method: 'POST',
						headers: { ...(await authHeaders()), 'content-type': 'application/json' },
						body: JSON.stringify({ key, ...signedOptions }),
					});
					if (!response.ok) await failure(response, `signing failed (${response.status})`);
					return (await response.json()) as SignedUrlResult;
				},

				/** The batch form. Reports per-key failures instead of failing the
				 * whole call, so one unreadable key does not cost you the rest. */
				async createSignedUrls(
					keys: string[],
					signedOptions: SignedUrlOptions = {},
				): Promise<BatchSignedUrl[]> {
					const response = await fetch(bucketUrl(bucket, '/signed-urls'), {
						method: 'POST',
						headers: { ...(await authHeaders()), 'content-type': 'application/json' },
						body: JSON.stringify({ keys, ...signedOptions }),
					});
					if (!response.ok) await failure(response, `signing failed (${response.status})`);
					return ((await response.json()) as { signedUrls: BatchSignedUrl[] }).signedUrls;
				},

				/**
				 * The plain URL for an object on a `read: public` bucket - on
				 * `publicBaseUrl` when you configured one, else the agent base.
				 * String building only: it makes no request and CANNOT tell you
				 * whether the bucket is actually public, so on a private bucket the
				 * URL is real but answers 401. Use `createSignedUrl` when in doubt.
				 */
				getPublicUrl(key: string): string {
					const serveOrigin = options.publicBaseUrl?.replace(/\/$/, '');
					if (!serveOrigin) return objectUrl(key);
					// The serving domain's own path shape - `/<projectId>/<bucket>/<key>`,
					// no agent prefix. The projectId comes off the base URL, which
					// always ends in it.
					const projectId = baseUrl.slice(baseUrl.lastIndexOf('/') + 1);
					return `${serveOrigin}/${projectId}/${encodeURIComponent(bucket)}/${encodeKey(key)}`;
				},
			};
			return handle;
		},
	};
}

export type StorageClient = ReturnType<typeof createStorageClient>;
export type BucketHandle = ReturnType<StorageClient['from']>;
