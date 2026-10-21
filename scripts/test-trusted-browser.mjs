// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
import { createApp } from '../server/app.mjs';
import { once } from 'node:events';

const fixture = await trustedBrowserFixture();
const key = randomBytes(32),
  store = new Store(join(fixture.directory, 'state.sqlite'), { sample: false });
const control = {
  controller: 'owner',
  epoch: 0,
  transitioning: false,
  assertControl(actor, epoch) {
    if (actor !== this.controller || (epoch !== undefined && epoch !== this.epoch))
      throw Error('Computer control changed');
  },
};
const options = {
  key,
  control,
  enabled: true,
  channel: 'chrome',
  resolver: fixture.resolver,
  transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: fixture.cert }),
};
let browser = new TrustedBrowser(store, options);
let apiServer;
const checks = [];
const networkEvents = [];
const check = (name) => {
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
};
async function until(condition) {
  for (let i = 0; i < 600; i++) {
    if (await condition()) return;
    await delay(50);
  }
  throw Error('Browser acceptance state did not arrive');
}
async function settle(action, { approve = false } = {}) {
  await until(async () => {
    if (approve)
      for (const request of browser.requests.list().filter((r) => r.phase === 'pending'))
        await browser.decide(request.id, request.fingerprint, true);
    return browser.action(action.id).phase !== 'running';
  });
  return browser.action(action.id);
}
async function run(action, actor = control.controller, settings) {
  const result = await settle(
    await browser.begin({ operationId: randomUUID(), ...action }, actor),
    settings,
  );
  assert.equal(result.phase, 'completed', `${action.action} did not complete`);
  return result;
}
const target = (page, name, role) => {
  const found = page.content.find((n) => n.name === name && (!role || n.role === role));
  assert(found?.target, `Missing target ${name}`);
  return found.target;
};
async function handoff(actor) {
  control.controller = actor;
  control.epoch++;
  browser.syncControl();
  await browser.resetting;
}

try {
  await run({ action: 'open', url: `${fixture.origin}/signin` });
  browser.session.page.on('request', (request) =>
    networkEvents.push({
      url: browser.vault.redact(request.url()),
      from: request.redirectedFrom()?.url(),
      kind: 'request',
    }),
  );
  browser.session.page.on('requestfailed', (request) =>
    networkEvents.push({
      url: browser.vault.redact(request.url()),
      failure: request.failure(),
      kind: 'failed',
    }),
  );
  let page = await browser.observe('owner');
  await run({ action: 'type', target: target(page, 'Username'), text: 'fixture-owner' });
  page = await browser.observe('owner');
  await run({ action: 'type', target: target(page, 'Password'), text: fixture.password });
  await assert.rejects(browser.observe('agent'), /control/);
  const screen = await browser.ownerScreen();
  assert(screen.screenshot.length > 1000);
  page = await browser.observe('owner');
  assert(!JSON.stringify(page).includes(fixture.password));
  await run({ action: 'click', target: target(page, 'Sign in', 'button') });
  assert(fixture.calls.find((r) => r.url === '/workspace').cookie.includes(fixture.session));
  assert(browser.vault.storage().cookies.every((c) => c.value.startsWith('relay_cookie_')));
  check(
    'owner fills a real HTTPS login using bounded targets; agent observations pause; saved cookies are surrogate values',
  );

  await handoff('agent');
  assert.equal(browser.status().connected, false);
  assert.equal(browser.targets.size, 0);
  const opened = await browser.begin(
    { operationId: randomUUID(), action: 'open', url: `${fixture.origin}/workspace` },
    'agent',
  );
  await until(() => browser.requests.list().some((r) => r.phase === 'pending'));
  const beforeApproval = fixture.calls.filter((r) => r.url === '/workspace').length;
  await delay(100);
  assert.equal(fixture.calls.filter((r) => r.url === '/workspace').length, beforeApproval);
  assert.equal((await settle(opened, { approve: true })).phase, 'completed');
  page = await browser.observe('agent');
  assert(page.content.some((n) => n.name === 'Private notebook'));
  assert(!JSON.stringify(page).includes(fixture.password));
  assert(!JSON.stringify(page).includes(fixture.session));
  assert(!JSON.stringify(page).includes('server_supplied_private_value'));
  assert(page.content.some((n) => n.name.includes('[private]')));
  assert.equal(page.content.find((n) => n.name === 'Private field').target, undefined);
  for (const field of ['screenshot', 'html', 'cookies', 'storageState', 'backendDOMNodeId', 'cdp'])
    assert(!Object.hasOwn(page, field));
  check(
    'handback creates a fresh session and exposes redacted accessibility content with opaque targets, without private field values',
  );

  const redirect = await browser.begin(
    { operationId: randomUUID(), action: 'open', url: `${fixture.origin}/redirect` },
    'agent',
  );
  for (const path of ['/redirect', '/redirect-again', '/workspace']) {
    await until(() =>
      browser.requests
        .list()
        .some((r) => r.phase === 'pending' && r.url === `${fixture.origin}${path}`),
    );
    const request = browser.requests
      .list()
      .find((r) => r.phase === 'pending' && r.url === `${fixture.origin}${path}`);
    const before = fixture.calls.filter((r) => r.url === path).length;
    await delay(75);
    assert.equal(fixture.calls.filter((r) => r.url === path).length, before);
    await browser.decide(request.id, request.fingerprint, true);
  }
  assert.equal((await settle(redirect, { approve: true })).phase, 'completed');
  page = await browser.observe('agent');
  check(
    'each redirect hop is intercepted and independently reviewed before any request to that destination',
  );

  const oldSave = target(page, 'Save note', 'button');
  await run({ action: 'click', target: target(page, 'Rename button', 'button') });
  const callsBefore = fixture.calls.length;
  const changed = await settle(
    await browser.begin({ operationId: randomUUID(), action: 'click', target: oldSave }, 'agent'),
  );
  assert.equal(changed.phase, 'uncertain');
  assert.equal(fixture.calls.length, callsBefore);
  page = await browser.observe('agent');
  await assert.rejects(
    browser.begin({ operationId: randomUUID(), action: 'click', target: oldSave }, 'agent'),
    /stale/,
  );
  check('renamed or expired targets cannot silently turn an earlier click into a different action');

  await run({ action: 'open', url: `${fixture.origin}/workspace` }, 'agent', { approve: true });
  page = await browser.observe('agent');
  const upload = await browser.begin(
    { operationId: randomUUID(), action: 'click', target: target(page, 'Upload bytes', 'button') },
    'agent',
  );
  await until(() =>
    browser.requests.list().some((r) => r.phase === 'pending' && r.url.endsWith('/bytes')),
  );
  const uploadReview = browser.requests
    .list()
    .find((r) => r.phase === 'pending' && r.url.endsWith('/bytes'));
  assert.equal(uploadReview.bodyBytes, 4);
  assert.equal(fixture.calls.filter((r) => r.url === '/bytes').length, 0);
  await browser.decide(uploadReview.id, uploadReview.fingerprint, true);
  assert.equal((await settle(upload)).phase, 'completed');
  assert.equal(fixture.calls.find((r) => r.url === '/bytes').bodyHex, '00ff8001');
  check(
    'a binary browser upload retains its exact bytes through interception and a reviewed request',
  );
  page = await browser.observe('agent');
  await run({
    action: 'type',
    target: target(page, 'Note', 'textbox'),
    text: 'Keep exactly this note',
  });
  page = await browser.observe('agent');
  const saveInput = {
    operationId: randomUUID(),
    action: 'click',
    target: target(page, 'Save note', 'button'),
  };
  const save = await browser.begin(saveInput, 'agent');
  await until(() =>
    browser.requests.list().some((r) => r.phase === 'pending' && r.method === 'POST'),
  );
  const review = browser.requests.list().find((r) => r.phase === 'pending' && r.method === 'POST');
  assert.equal(review.body, 'note=Keep+exactly+this+note');
  assert.equal(fixture.calls.filter((r) => r.url === '/save').length, 0);
  assert.equal((await browser.begin(saveInput, 'agent')).repeated, true);
  await assert.rejects(browser.begin({ ...saveInput, target: 'changed' }, 'agent'), /different/);
  await browser.decide(review.id, review.fingerprint, true);
  assert.equal((await settle(save, { approve: true })).phase, 'completed');
  assert.equal(fixture.calls.filter((r) => r.url === '/save').length, 1);
  assert.equal((await browser.begin(saveInput, 'agent')).repeated, true);
  assert.equal(fixture.calls.filter((r) => r.url === '/save').length, 1);
  check('a form sends its exact reviewed bytes once; repeated action IDs do not click again');

  await run({ action: 'open', url: `${fixture.origin}/keyboard` }, 'agent', { approve: true });
  page = await browser.observe('agent');
  const category = target(page, 'Category', 'combobox');
  const wrongType = await settle(
    await browser.begin(
      {
        operationId: randomUUID(),
        action: 'type',
        target: category,
        text: 'not a selectable value',
      },
      'agent',
    ),
  );
  assert.equal(wrongType.phase, 'uncertain');
  const viewportBefore = (await browser.session.cdp.send('Page.getLayoutMetrics')).cssVisualViewport
    .pageY;
  await run({ action: 'scroll', direction: 'down' });
  const viewportAfter = (await browser.session.cdp.send('Page.getLayoutMetrics')).cssVisualViewport
    .pageY;
  assert(viewportAfter > viewportBefore);
  await run({ action: 'scroll', direction: 'up' });
  page = await browser.observe('agent');
  await run({
    action: 'type',
    target: target(page, 'Keyboard note', 'textbox'),
    text: 'Sent through Enter',
  });
  page = await browser.observe('agent');
  await run(
    { action: 'key', target: target(page, 'Keyboard note', 'textbox'), key: 'Enter' },
    'agent',
    { approve: true },
  );
  const keySave = fixture.calls.find((r) => r.url === '/key-save');
  assert(keySave);
  assert.equal(new URLSearchParams(keySave.body).get('note'), 'Sent through Enter');
  assert.equal(new URLSearchParams(keySave.body).get('category'), 'one');
  check(
    'keyboard submission and scrolling work; text insertion into a native select is rejected without changing its value',
  );

  await run({ action: 'open', url: `${fixture.origin}/workspace` }, 'agent', { approve: true });
  page = await browser.observe('agent');
  const exfil = await settle(
    await browser.begin(
      {
        operationId: randomUUID(),
        action: 'click',
        target: target(page, 'Try cross-origin request', 'button'),
      },
      'agent',
    ),
  );
  assert.equal(exfil.phase, 'uncertain');
  assert.equal(fixture.calls.filter((r) => r.host === new URL(fixture.other).host).length, 0);
  check(
    'page-script attempts to send a known private input to another origin are rejected before dispatch',
  );

  page = await browser.observe('agent');
  await run({ action: 'click', target: target(page, 'Schedule background request', 'button') });
  const staleTarget = target(page, 'Note', 'textbox');
  const waiting = await browser.begin(
    { operationId: randomUUID(), action: 'open', url: `${fixture.origin}/workspace` },
    'agent',
  );
  await until(() => browser.requests.list().some((r) => r.phase === 'pending'));
  const pending = browser.requests.list().find((r) => r.phase === 'pending');
  await handoff('owner');
  assert.equal(browser.action(waiting.id).phase, 'interrupted');
  await assert.rejects(browser.decide(pending.id, pending.fingerprint, true), /ended/);
  await assert.rejects(browser.observe('agent'), /control/);
  assert.deepEqual(browser.status('agent'), { paused: true, connected: false });
  assert.equal(browser.status('owner').connected, false);
  await delay(2200);
  assert.equal(fixture.calls.filter((r) => r.url === '/background').length, 0);
  await run({ action: 'open', url: `${fixture.origin}/workspace` }, 'owner');
  await assert.rejects(
    browser.begin(
      { operationId: randomUUID(), action: 'type', target: staleTarget, text: 'stale' },
      'owner',
    ),
    /stale/,
  );
  check(
    'takeover cancels pending approvals, closes the old script context, invalidates targets and preserves owner access',
  );

  await assert.rejects(
    browser.begin(
      { operationId: randomUUID(), action: 'evaluate', script: 'document.cookie' },
      'owner',
    ),
    /supported/,
  );
  await assert.rejects(
    browser.begin(
      { operationId: randomUUID(), action: 'open', url: 'file:///etc/passwd' },
      'owner',
    ),
    /HTTPS/,
  );
  await assert.rejects(
    browser.begin(
      { operationId: randomUUID(), action: 'open', url: 'https://owner:secret@account.example' },
      'owner',
    ),
    /credentials/,
  );
  assert.equal(browser.status('owner').waiting, 0);
  check(
    'the runtime action interface rejects script evaluation, file URLs and embedded URL credentials',
  );

  const oldBrowser = browser;
  await oldBrowser.close();
  browser = new TrustedBrowser(store, options);
  await run({ action: 'open', url: `${fixture.origin}/workspace` }, 'owner');
  page = await browser.observe('owner');
  assert(page.content.some((n) => n.name === 'Private notebook'));
  await handoff('agent');
  assert.equal((await browser.begin(saveInput, 'agent')).phase, 'completed');
  assert.equal(browser.status('agent').connected, false);
  assert.equal(fixture.calls.filter((r) => r.url === '/save').length, 1);
  check(
    'a service object restart restores the encrypted session and keeps durable action receipts without replay',
  );

  for (const secret of [fixture.password, fixture.session]) {
    assert(!JSON.stringify(store.read()).includes(secret));
    assert(!store.secret('trusted-browser-vault').includes(secret));
    assert(!JSON.stringify(browser.requests.list()).includes(secret));
    assert(
      !JSON.stringify(store.db.prepare('SELECT * FROM trusted_browser_actions').all()).includes(
        secret,
      ),
    );
  }
  assert(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM trusted_browser_actions WHERE phase != 'running' AND input != ''",
      )
      .get().n === 0,
  );
  const accessKey = 'runtime-fixture-owner-key-longer-than-24-characters';
  const app = createApp(
    store,
    {
      mode: 'sample',
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
      privateBrowser: browser,
    },
    { host: '127.0.0.1', port: 0, accessKey },
  );
  apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const apiRoot = `http://127.0.0.1:${apiServer.address().port}`;
  assert.equal((await fetch(`${apiRoot}/api/private-browser/screen`)).status, 401);
  const login = await fetch(`${apiRoot}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: accessKey }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body) =>
    fetch(`${apiRoot}/api/private-browser${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  await handoff('owner');
  const apiOpen = await call('/actions', {
    operationId: randomUUID(),
    action: 'open',
    url: `${fixture.origin}/workspace`,
    actor: 'agent',
  });
  assert.equal(apiOpen.status, 200);
  const apiAction = await apiOpen.json();
  assert.equal(apiAction.actor, 'owner');
  await until(
    async () => (await (await call(`/actions/${apiAction.id}`)).json()).phase !== 'running',
  );
  assert.equal((await (await call(`/actions/${apiAction.id}`)).json()).phase, 'completed');
  const observed = await call('/accessibility');
  assert.equal(observed.headers.get('cache-control'), 'no-store');
  assert((await observed.json()).content.some((n) => n.name === 'Private notebook'));
  assert((await (await call('/screen')).json()).screenshot.length > 1000);
  check(
    'authenticated owner HTTP endpoints operate and observe the real browser; a client actor field cannot change authority',
  );

  await handoff('agent');
  const apiWait = await browser.begin(
    { operationId: randomUUID(), action: 'open', url: `${fixture.origin}/workspace` },
    'agent',
  );
  await until(() => browser.requests.list().some((r) => r.phase === 'pending'));
  const apiReview = (await (await call('')).json()).requests.find((r) => r.phase === 'pending');
  const beforeDecline = fixture.calls.length;
  assert.equal(
    (await call(`/requests/${apiReview.id}`, { fingerprint: apiReview.fingerprint, allow: 'true' }))
      .status,
    409,
  );
  const declined = await call(`/requests/${apiReview.id}`, {
    fingerprint: apiReview.fingerprint,
    allow: false,
  });
  assert.equal(declined.status, 200);
  assert.equal((await declined.json()).phase, 'declined');
  assert.equal((await settle(apiWait)).phase, 'uncertain');
  assert.equal(fixture.calls.length, beforeDecline);
  check(
    'the owner can decline a pending agent request through the authenticated HTTP API before any website bytes are sent',
  );

  await handoff('owner');
  assert.equal((await call('/clear', {})).status, 200);
  assert.equal(browser.vault.storage(), undefined);
  const clearedHistory = await (await call('')).json();
  assert.equal(clearedHistory.requests.length, 0);
  assert(!JSON.stringify(clearedHistory).includes(fixture.password));
  assert(!JSON.stringify(clearedHistory).includes(fixture.session));
  check(
    'completed actions discard private input payloads; workspace exports omit secrets; clearing removes saved browser state',
  );

  const evidence = resolve('../relay-evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'trusted-browser-runtime-acceptance.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        checks,
        productEnabled: false,
        scope:
          'Real host Chromium through the TrustedBrowser runtime and an independent local HTTPS service; bounded accessibility actions and a controlled computer-ownership contract',
        limitations: [
          'Computer UI and assistant-tool acceptance is recorded separately; this harness exercises runtime and HTTP boundaries',
          'Ownership contract tested here; Docker command-freezer integration not exercised',
          'Page context resets during takeover; unfinished form state is not preserved',
          'No OS egress audit or proof against arbitrary browser exploits',
          'No broad SSO, non-cookie token protection, taint classifier, payments or live-account acceptance',
          'Native clients not tested against this new browser runtime',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  console.error(
    'Observed requests:',
    fixture.calls.map(({ method, url }) => ({ method, url })),
  );
  console.error(
    'Authority outcomes:',
    browser.requests
      .list()
      .map(({ method, url, phase, outcome }) => ({ method, url, phase, outcome })),
  );
  console.error('Browser network:', networkEvents);
  console.error(
    'Browser observation:',
    await browser.observe(control.controller).catch(() => ({ unavailable: true })),
  );
  const screen = await browser.ownerScreen().catch(() => null);
  if (screen?.screenshot)
    await writeFile(
      resolve('../../work/trusted-browser-debug.png'),
      Buffer.from(screen.screenshot, 'base64'),
    );
  throw error;
} finally {
  if (apiServer)
    await new Promise((r) => {
      apiServer.close(r);
      apiServer.closeAllConnections();
    });
  await browser.close();
  store.close();
  await fixture.close();
}
