/**
 * Which stored content types a browser may render INLINE from our origin.
 * Everything else goes out `Content-Disposition: attachment`.
 *
 * The stored type is whatever the uploader sent, and on the managed service
 * the object path shares the console's origin - so anything scriptable that
 * renders inline is stored XSS against every operator session. Absent by
 * design: text/html, image/svg+xml, text/css, javascript.
 *
 * This is a list of EXACT types, not a pattern over a top-level type. It used
 * to accept any `video/<subtype>` and `audio/<subtype>`, which admitted
 * `video/x+xml`: browsers treat every `+xml` subtype as an XML document, and
 * an XHTML body served that way runs its scripts.
 */
const INLINE_CONTENT_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp',
	'image/x-icon',
	'video/mp4',
	'video/webm',
	'video/ogg',
	'video/quicktime',
	'video/mpeg',
	'video/x-matroska',
	'video/3gpp',
	'video/3gpp2',
	'video/mp2t',
	'audio/mpeg',
	'audio/mp4',
	'audio/aac',
	'audio/ogg',
	'audio/opus',
	'audio/wav',
	'audio/x-wav',
	'audio/webm',
	'audio/flac',
	'audio/x-flac',
	'audio/x-m4a',
	'audio/3gpp',
	'audio/aiff',
	'audio/x-aiff',
	'text/plain',
	'application/pdf',
]);

/** True only for an exact allowlisted type - parameters, whitespace or any
 * other spelling download rather than render. */
export function rendersInline(contentType: string): boolean {
	return INLINE_CONTENT_TYPES.has(contentType.toLowerCase());
}

/** The serve-time disposition for a stored content type. */
export function contentDisposition(contentType: string): 'inline' | 'attachment' {
	return rendersInline(contentType) ? 'inline' : 'attachment';
}
