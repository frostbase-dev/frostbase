import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentDisposition } from './inline.js';

/** The stored type is uploader-chosen and the agent path shares the console's
 * origin, so every refusal here is a stored-XSS vector closed. */

test('scriptable types never render inline', () => {
	for (const type of [
		'text/html',
		'TEXT/HTML',
		'application/xhtml+xml',
		'image/svg+xml',
		'text/xml',
		'application/xml',
		'text/css',
		'text/javascript',
		'application/javascript',
		'application/octet-stream',
	]) {
		assert.equal(contentDisposition(type), 'attachment', type);
	}
});

test('an +xml subtype under video/ or audio/ is not a media type', () => {
	// Browsers render ANY +xml subtype as an XML document, top-level type
	// regardless - the old video/* and audio/* patterns served these inline.
	for (const type of [
		'video/x+xml',
		'video/xhtml+xml',
		'audio/a+xml',
		'video/svg+xml',
		'audio/mpeg+xml',
	]) {
		assert.equal(contentDisposition(type), 'attachment', type);
	}
});

test('near-miss spellings download rather than render', () => {
	for (const type of [
		' image/png',
		'image/png; charset=utf-8',
		'image/png\n',
		'image/pngx',
		'video/',
		'video/mp4/x',
		'',
	]) {
		assert.equal(contentDisposition(type), 'attachment', JSON.stringify(type));
	}
});

test('ordinary media, text and PDF still render inline', () => {
	for (const type of [
		'image/png',
		'IMAGE/PNG',
		'image/jpeg',
		'image/webp',
		'video/mp4',
		'video/webm',
		'audio/mpeg',
		'audio/ogg',
		'text/plain',
		'application/pdf',
	]) {
		assert.equal(contentDisposition(type), 'inline', type);
	}
});
