// SPDX-License-Identifier: MIT
// Capacitor's legacy reply path can outlive the document during a WebView reload.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const legacyReplyPrefix =
  "if (window.Capacitor && typeof window.Capacitor.fromNative === 'function') window.Capacitor.fromNative(";
const original = 'final String runScript = "window.Capacitor.fromNative(" + data.toString() + ")";';
const guarded = `final String runScript = "${legacyReplyPrefix}" + data.toString() + ")";`;

export function patchLegacyReply(source, version) {
  if (version !== '8.5.3')
    throw Error('Review Relay’s Android bridge compatibility patch for this Capacitor version.');
  if (source.split(guarded).length === 2 && !source.includes(original)) return source;
  if (source.split(original).length !== 2 || source.includes(guarded))
    throw Error('Unexpected Capacitor reply implementation; review before building Android.');
  return source.replace(original, guarded);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = new URL('../node_modules/@capacitor/android/', import.meta.url);
  const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const file = new URL('capacitor/src/main/java/com/getcapacitor/MessageHandler.java', root);
  const before = await readFile(file, 'utf8');
  const after = patchLegacyReply(before, version);
  if (after !== before) await writeFile(file, after);
  console.log('Android bridge reload guard ready.');
}
