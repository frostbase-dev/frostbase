/**
 * Redirect targets the console builds from request input. Pure, so a unit
 * test can pin every spelling that used to escape.
 */

const PROBE_ORIGIN = 'https://same-origin.invalid';

/**
 * A `?next=` value as a same-origin path, or the fallback.
 *
 * Checking the string's prefix is not enough: browsers treat `\` as `/` in
 * http(s) URLs, so `/\evil.example` passed a "starts with `/`, not `//`" test
 * and landed on evil.example. Resolve it the way a browser will, against a
 * placeholder origin, and keep it only if it stayed there.
 */
export function safeNext(value: string | null, fallback = '/dashboard'): string {
	if (!value || !value.startsWith('/')) return fallback;
	// Backslashes and control characters have no business in a path we hand
	// out, and each is a parser disagreement waiting for the next browser.
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
	let resolved: URL;
	try {
		resolved = new URL(value, PROBE_ORIGIN);
	} catch {
		return fallback;
	}
	if (resolved.origin !== PROBE_ORIGIN) return fallback;
	return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * The `Location` for a request on a moved hostname: the same path on the
 * canonical origin.
 *
 * Resolving the raw pathname as a URL reference made `//evil.example/x` a
 * network-path reference to evil.example. The canonical origin is fixed here
 * and the path is only ever appended to it.
 */
export function movedLocation(pathname: string, search: string, canonicalOrigin: string): string {
	const origin = new URL(canonicalOrigin).origin;
	const path = `/${pathname.replace(/^[/\\]+/, '')}`;
	return `${origin}${path}${search}`;
}
