// SPDX-License-Identifier: MIT
import { assertWebPort } from '../../shared/web-ports.mjs';
export function serverURL(value) {
  const url = new URL(String(value).trim());
  assertWebPort(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('Use an HTTPS server address. HTTP is allowed only for local development.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use the server address without credentials, a path, query, or fragment.');
  return url.origin;
}
export function navigationKind(value, workspace) {
  try {
    const url = new URL(value);
    if (url.origin === new URL(workspace).origin) return 'workspace';
    if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') return 'google';
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? 'external' : 'blocked';
  } catch {
    return 'blocked';
  }
}

export function clipboardText(value, frameUrl, workspace) {
  if (navigationKind(frameUrl, workspace) !== 'workspace' || new URL(frameUrl).pathname !== '/')
    throw new Error('Copy text from the main Relay workspace.');
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 1000000)
    throw new Error('Copy up to 1 MB of plain text.');
  return value;
}

export function appSignInURL(value, frameUrl, workspace) {
  const url = new URL(value),
    root = new URL(serverURL(workspace));
  if (
    new URL(frameUrl).origin !== root.origin ||
    new URL(frameUrl).pathname !== '/' ||
    url.origin !== root.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !['/api/connectors/oauth/open', '/api/models/oauth/open'].includes(url.pathname) ||
    !/^[a-f0-9-]{36}$/.test(url.searchParams.get('id') || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('ticket') || '') ||
    [...url.searchParams.keys()].length !== 2
  )
    throw Error('Open app sign-in from the Relay workspace.');
  return url.href;
}
