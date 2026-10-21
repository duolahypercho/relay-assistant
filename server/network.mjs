// SPDX-License-Identifier: MIT
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  const prohibited = [
    a === 0,
    a === 10,
    a === 127,
    a >= 224,
    a === 169 && b === 254,
    a === 172 && b >= 16 && b <= 31,
    a === 192 && b === 168,
    a === 100 && b >= 64 && b <= 127,
    a === 198 && b >= 18 && b <= 19,
    a === 198 && b === 51 && c === 100,
    a === 203 && b === 0 && c === 113,
    a === 192 && b === 0,
  ];
  return !prohibited.some(Boolean);
}
export async function resolveDestination(value, resolve = lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete public URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new Error('Only public HTTP(S) URLs on standard ports are supported.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (/(?:^|\.)(localhost|local|internal|lan|home)$/.test(hostname))
    throw new Error('Private network destinations are blocked.');
  const records = await resolve(hostname, { all: true, family: 4 });
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new Error('Private or reserved network destinations are blocked.');
  return { url, address: records[0].address };
}
export async function safeFetch(
  value,
  { maxBytes = 2_000_000, signal, redirects = 5, headers = {} } = {},
) {
  const { url, address } = await resolveDestination(value);
  const result = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'RelayAssistant/0.1 (+public-page-reader)',
          Accept: 'text/html,text/plain,application/pdf',
          ...headers,
          'Accept-Encoding': 'identity',
        },
        lookup: (_host, opts, cb) =>
          opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4),
        signal,
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy(new Error('The page exceeds the size limit.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
            url: url.href,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The page took too long to respond.')));
    req.on('error', reject);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    if (!redirects || !result.headers.location)
      throw new Error('The page redirected too many times.');
    return safeFetch(new URL(result.headers.location, url).href, {
      maxBytes,
      signal,
      redirects: redirects - 1,
      headers: {},
    });
  }
  if (result.status < 200 || result.status >= 300)
    throw new Error(`The page returned HTTP ${result.status}.`);
  return result;
}
export function readableHtml(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Public page';
  const decode = (t) =>
    t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
  return { title: decode(title).trim(), text: text.slice(0, 16000) };
}
export async function readPage(url, signal) {
  const response = await safeFetch(url, { signal });
  if (!String(response.headers['content-type'] || '').match(/html|text/))
    throw new Error('Use a public HTML or text page for this tracker.');
  return { url: response.url, ...readableHtml(response.bytes.toString('utf8')) };
}
