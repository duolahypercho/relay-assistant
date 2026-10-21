// SPDX-License-Identifier: MIT
// Controlled acceptance of the experimental request/vault core. This harness is
// not a production browser broker and deliberately exposes no Relay API routes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { Store } from '../server/store.mjs';
import { BrowserVault } from '../server/browser-vault.mjs';
import { BrowserRequests, pinnedBrowserRequest } from '../server/browser-requests.mjs';

const directory = await mkdtemp(join(tmpdir(), 'relay-private-browser-proof-'));
const evidence = resolve('../relay-evidence/browser-authority-acceptance.json');
const checks = [],
  incoming = [];
const password = `password_${randomBytes(18).toString('hex')}`;
const session = `session_${randomBytes(18).toString('hex')}`;
const csrf = `csrf_${randomBytes(18).toString('hex')}`;
let browser, store, broker, remote, blockedProxy;
let mode = 'owner',
  epoch = 0;
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const close = (server) =>
  server &&
  new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
const check = (name) => {
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
};
try {
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'key.pem'),
    '-out',
    join(directory, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=relay-browser.test',
    '-addext',
    'subjectAltName=DNS:relay-browser.test,DNS:other-browser.test',
  ]);
  const cert = await readFile(join(directory, 'cert.pem'));
  const workspace =
    '<title>Private notebook</title><h1>Private notebook</h1><form action="/save" method="post"><label>Note <input name="note"></label><button>Save note</button></form>';
  remote = https.createServer(
    { key: await readFile(join(directory, 'key.pem')), cert },
    async (req, res) => {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks).toString();
      incoming.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie,
        body,
      });
      res.setHeader('content-type', 'text/html');
      if (req.url === '/signin' && req.method === 'GET') {
        res.end(
          '<title>Sign in</title><h1>Sign in</h1><form action="/signin" method="post"><label>Username <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
        );
        return;
      }
      if (req.url === '/signin' && req.method === 'POST') {
        const data = new URLSearchParams(body);
        if (data.get('password') !== password) {
          res.writeHead(401);
          res.end('Wrong password');
          return;
        }
        res.writeHead(303, {
          location: '/workspace',
          'set-cookie': [
            `session=${session}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
            `csrf=${csrf}; Secure; SameSite=Lax; Path=/; Max-Age=3600`,
          ],
        });
        res.end();
        return;
      }
      if (!req.headers.cookie?.includes(`session=${session}`)) {
        res.writeHead(401);
        res.end('Sign in first');
        return;
      }
      if (req.url === '/workspace') {
        res.end(workspace);
        return;
      }
      if (req.url === '/save' && req.method === 'POST') {
        res.end('<title>Saved</title><h1>Note saved</h1>');
        return;
      }
      res.writeHead(404);
      res.end('No such page');
    },
  );
  await listen(remote);
  const port = remote.address().port;
  const origin = `https://relay-browser.test:${port}`,
    other = `https://other-browser.test:${port}`;
  // Test-only loopback resolver; production uses resolveDestination and rejects
  // these addresses/ports. Never add a loopback escape flag to the product.
  const resolver = async (value) => {
    const url = new URL(value);
    if (![origin, other].includes(url.origin)) throw Error('Destination outside fixture');
    return { url, address: '127.0.0.1' };
  };
  const key = randomBytes(32);
  store = new Store(join(directory, 'workspace.sqlite'), { sample: false });
  const vault = new BrowserVault(store, key);
  vault.saveLogin(origin, { username: 'fixture-owner', password });
  broker = new BrowserRequests(store, {
    key,
    vault,
    resolver,
    transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: cert }),
  });
  // All uncaught networking is denied, never continued to a default proxy.
  blockedProxy = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  blockedProxy.on('connect', (_req, socket) => socket.destroy());
  await listen(blockedProxy);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    proxy: { server: `http://127.0.0.1:${blockedProxy.address().port}` },
    args: [
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  async function context(storageState) {
    const ctx = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      storageState,
    });
    await ctx.routeWebSocket('**/*', (socket) => socket.close());
    await ctx.route('**/*', async (route) => {
      const req = route.request(),
        capturedEpoch = epoch,
        capturedMode = mode;
      if (new URL(req.url()).pathname === '/favicon.ico') {
        await route.abort();
        return;
      }
      try {
        const response = await broker.submit(
          {
            url: req.url(),
            method: req.method(),
            headers: await req.allHeaders(),
            body: req.postDataBuffer(),
          },
          {
            actor: capturedMode,
            guard() {
              if (capturedEpoch !== epoch || capturedMode !== mode) throw Error('Control changed');
            },
          },
        );
        const headers = Object.fromEntries(
          Object.entries(response.headers)
            .filter(
              ([name]) => !['content-length', 'transfer-encoding', 'connection'].includes(name),
            )
            .map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join('\n') : String(value),
            ]),
        );
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    return ctx;
  }
  let ctx = await context(),
    page = await ctx.newPage();
  await page.goto(`${origin}/signin`);
  await page.getByLabel('Username').fill('fixture-owner');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private notebook' })).toBeVisible();
  const cookies = await ctx.cookies();
  assert.equal(cookies.length, 2);
  assert(cookies.every((cookie) => /^relay_cookie_[a-f0-9]{48}$/.test(cookie.value)));
  assert(incoming.find((r) => r.url === '/workspace').cookie.includes(session));
  assert(incoming.find((r) => r.url === '/workspace').cookie.includes(csrf));
  const documentCookies = await page.evaluate(() => document.cookie);
  assert(documentCookies.includes('relay_cookie_'));
  assert(!documentCookies.includes(session) && !documentCookies.includes(csrf));
  check(
    'real browser signs in through HTTPS while its cookie jar and page scripts receive only surrogate cookies',
  );

  const saved = await ctx.storageState();
  vault.saveStorage(saved);
  await ctx.close();
  ctx = await context(new BrowserVault(store, key).storage());
  page = await ctx.newPage();
  await page.goto(`${origin}/workspace`);
  await expect(page.getByRole('heading', { name: 'Private notebook' })).toBeVisible();
  check('encrypted session storage restores authenticated Chromium state in a fresh context');

  const csrfAlias = cookies.find((c) => c.name === 'csrf').value;
  const beforeLeak = incoming.length;
  const leaked = await page.evaluate(
    async ({ destination, alias }) => {
      try {
        await fetch(`${destination}/leak?token=${alias}`, { mode: 'no-cors' });
        return true;
      } catch {
        return false;
      }
    },
    { destination: other, alias: csrfAlias },
  );
  assert.equal(leaked, false);
  assert.equal(incoming.length, beforeLeak);
  check('a page script cannot send a credential surrogate to a second HTTPS origin');

  mode = 'agent';
  epoch++;
  await page.getByLabel('Note', { exact: true }).fill('Save exactly this note');
  const click = page
    .getByRole('button', { name: 'Save note', exact: true })
    .click({ noWaitAfter: true });
  await expect.poll(() => broker.list().filter((r) => r.phase === 'pending').length).toBe(1);
  const review = broker.list().find((r) => r.phase === 'pending');
  assert.equal(review.method, 'POST');
  assert.equal(review.body, 'note=Save+exactly+this+note');
  assert.equal(incoming.filter((r) => r.url === '/save').length, 0);
  await broker.decide(review.id, review.fingerprint, true);
  await click;
  await expect(page.getByRole('heading', { name: 'Note saved' })).toBeVisible();
  assert.equal(incoming.filter((r) => r.url === '/save').length, 1);
  assert.equal(incoming.find((r) => r.url === '/save').body, 'note=Save+exactly+this+note');
  check('a browser form waits for one exact request review and sends its frozen bytes once');

  const pendingNavigation = page.goto(`${origin}/workspace`).catch(() => null);
  await expect.poll(() => broker.list().filter((r) => r.phase === 'pending').length).toBe(1);
  const old = broker.list().find((r) => r.phase === 'pending');
  const beforeTakeover = incoming.length;
  mode = 'owner';
  epoch++;
  broker.cancelAll();
  await pendingNavigation;
  await assert.rejects(broker.decide(old.id, old.fingerprint, true), /ended/);
  assert.equal(incoming.length, beforeTakeover);
  // Chromium renders its own error page after a denied document request. Use a
  // fresh owner tab so that delayed internal navigation cannot cancel our GET.
  await page.close();
  page = await ctx.newPage();
  await page.goto(`${origin}/workspace`);
  await expect(page.getByRole('heading', { name: 'Private notebook' })).toBeVisible();
  check(
    'takeover invalidates a waiting request; a fresh owner tab resumes the session without another review',
  );

  for (const secret of [password, session, csrf]) {
    assert(!JSON.stringify(store.read()).includes(secret));
    assert(!store.secret('trusted-browser-vault').includes(secret));
    assert(!JSON.stringify(broker.list()).includes(secret));
    assert(
      !JSON.stringify(store.db.prepare('SELECT * FROM trusted_browser_requests').all()).includes(
        secret,
      ),
    );
  }
  assert(broker.list().every((r) => !['pending', 'executing'].includes(r.phase)));
  check(
    'workspace state, review summaries and encrypted SQLite records contain no plaintext fixture credentials',
  );
  await mkdir(resolve('../relay-evidence'), { recursive: true });
  await writeFile(
    evidence,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        scope:
          'Experimental authority/vault core with a test-only Chromium routing harness and independent local HTTPS service',
        productEnabled: false,
        realAccountTested: false,
        browser: await browser.version(),
        checks,
        limits: [
          'No production broker/API/agent tools or UI wiring',
          'No AX observation sanitizer, OS process isolation or full network escape audit',
          'No non-cookie tokens, generic SSO, classifiers/taint tracking or payments',
          'Every agent HTTP request requires a review; product interaction design remains open',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Evidence: ${evidence}`);
} finally {
  broker?.cancelAll();
  await browser?.close();
  store?.close();
  await close(remote);
  await close(blockedProxy);
  await rm(directory, { recursive: true, force: true });
}
