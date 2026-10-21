// SPDX-License-Identifier: MIT
import { assertWebPort } from './web-ports.mjs';
// Keep the access grant in a URL fragment: never an HTTP path/query or saved server address.
export function connectionInput(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== 'string' || value.length > 2400)
    throw Error('Enter a Relay server address or connection link.');
  const url = new URL(value.trim());
  assertWebPort(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(allowLoopbackHttp && local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== '/'
  )
    throw Error('Use your server’s HTTPS address or its connection link.');
  const match = /^#connect=([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (url.hash && (!match || url.protocol !== 'https:'))
    throw Error('This connection link is not valid.');
  return { server: url.origin, token: match?.[1] || '' };
}
