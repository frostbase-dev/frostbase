import * as Sentry from '@sentry/cloudflare';
import { z } from 'zod';
import { restoreRequestSchema, type BookmarkOutcome, type RestoreOutcome } from './schemas.js';

/**
 * Point-in-time recovery over the platform's DO SQLite bookmarks, shared by
 * DbCollection and DbTable - extracted (not copied) so the two engines cannot
 * drift on the restore sequence, the unsupported-environment detection, or
 * the undo contract. Everything here is storage-level and engine-agnostic;
 * the callers stay thin RPC wrappers that supply their own labels.
 */

/** Local dev keeps no durable change log; workerd phrases it several ways. */
export const UNSUPPORTED_PITR_PATTERN =
	/does not implement|not (yet )?(supported|implemented|available)/i;

/**
 * Restore the shard to a timestamp or an exact bookmark. The restore takes
 * effect at the START of the next session, so this closes every subscriber
 * (reconnects get fresh snapshots against the restored data) and aborts a
 * tick later; the returned undo bookmark reverses the whole thing via
 * another restore. Local development reports unsupported.
 */
export async function shardRestoreTo(
	ctx: DurableObjectState,
	input: unknown,
	shard: { label: string; closeReason: string },
): Promise<RestoreOutcome> {
	const parsed = restoreRequestSchema.parse(input);
	const storage = ctx.storage;
	if (
		typeof storage.getBookmarkForTime !== 'function' ||
		typeof storage.onNextSessionRestoreBookmark !== 'function'
	) {
		return { ok: false, code: 'unsupported' };
	}

	try {
		const bookmark =
			parsed.bookmark ?? (await storage.getBookmarkForTime(new Date(parsed.timestamp ?? 0)));
		const undoBookmark = await storage.onNextSessionRestoreBookmark(bookmark);
		for (const ws of ctx.getWebSockets()) {
			try {
				ws.close(1012, shard.closeReason);
			} catch {
				// a half-dead socket must not block the restore
			}
		}
		setTimeout(() => ctx.abort(), 0);
		return { ok: true, undoBookmark };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Miniflare implements the methods but rejects the calls - observed:
		// "This Durable Object's storage back-end does not implement
		// point-in-time recovery." A real platform failure (e.g. a bookmark
		// past the 30-day window) reports as failed with its message.
		if (UNSUPPORTED_PITR_PATTERN.test(message)) return { ok: false, code: 'unsupported' };
		// Restore is the last-resort recovery path; a genuine failure here
		// must not look like local dev's missing change log.
		try {
			Sentry.captureException(error, {
				level: 'error',
				tags: { shard: shard.label, operation: 'pitr-restore' },
			});
		} catch {
			// reporting must never replace the outcome
		}
		return { ok: false, code: 'failed', message: message.slice(0, 256) };
	}
}

/**
 * The bookmark for this exact moment - the parent persists these as named
 * restore points (manual checkpoints, before imports, before rollbacks)
 * and doubles this call as the PITR support probe. No side effects.
 *
 * The probe exercises getBookmarkForTime, not just getCurrentBookmark:
 * local workerd serves the latter while refusing the rest of the PITR API,
 * and "supported" must mean a restore would actually work. Only the
 * back-end's "does not implement" answer counts as unsupported - a young
 * DO can reject a specific timestamp (its change log may postdate it)
 * while PITR itself is fully available.
 */
export async function shardCurrentBookmark(
	ctx: DurableObjectState,
): Promise<{ ok: true; bookmark: string } | { ok: false }> {
	const storage = ctx.storage;
	if (
		typeof storage.getCurrentBookmark !== 'function' ||
		typeof storage.getBookmarkForTime !== 'function'
	) {
		return { ok: false };
	}
	try {
		const bookmark = await storage.getCurrentBookmark();
		try {
			await storage.getBookmarkForTime(new Date());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (UNSUPPORTED_PITR_PATTERN.test(message)) return { ok: false };
		}
		return { ok: true, bookmark };
	} catch {
		return { ok: false };
	}
}

/**
 * D1-restore-style resolution: a wall-clock time in, the closest available
 * bookmark out - shown to the operator BEFORE anything is restored. No
 * side effects.
 */
export async function shardBookmarkForTime(
	ctx: DurableObjectState,
	input: unknown,
): Promise<BookmarkOutcome> {
	const timestamp = z.iso.datetime().parse(input);
	const storage = ctx.storage;
	if (typeof storage.getBookmarkForTime !== 'function') {
		return { ok: false, code: 'unsupported' };
	}
	try {
		return { ok: true, bookmark: await storage.getBookmarkForTime(new Date(timestamp)) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return UNSUPPORTED_PITR_PATTERN.test(message)
			? { ok: false, code: 'unsupported' }
			: { ok: false, code: 'failed', message: message.slice(0, 256) };
	}
}
