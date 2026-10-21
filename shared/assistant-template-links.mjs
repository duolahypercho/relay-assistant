// SPDX-License-Identifier: MIT
import { assertWebPort } from './web-ports.mjs';
export function templateSourceUrl(value, { allowLoopback = true } = {}) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value))
    throw Error('Use a valid Relay template link.');
  const url = new URL(value);
  assertWebPort(url);
  if (
    !/^https?:\/\/[^/?#]+\/share\/assistant\/[A-Za-z0-9_-]{43}$/i.test(value) ||
    !/^\/share\/assistant\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (allowLoopback &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('Use a Relay template link with HTTPS, or a loopback development link.');
  return url.href;
}
export function templateAppLink(source) {
  return 'relay-assistant://template?url=' + encodeURIComponent(templateSourceUrl(source));
}
export function parseTemplateAppLink(value, options) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value))
    throw Error('This Relay app link is invalid.');
  const link = new URL(value);
  if (
    link.protocol !== 'relay-assistant:' ||
    link.host !== 'template' ||
    !['', '/'].includes(link.pathname) ||
    link.username ||
    link.password ||
    link.hash ||
    [...link.searchParams.keys()].length !== 1 ||
    !link.searchParams.has('url')
  )
    throw Error('This Relay app link is invalid.');
  return templateSourceUrl(link.searchParams.get('url'), options);
}
