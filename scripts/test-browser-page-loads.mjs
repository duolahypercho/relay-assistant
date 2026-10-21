// SPDX-License-Identifier: MIT
// Actual host Chromium/CDP with an independent HTTPS page and hostile-scope cases.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
const site = await trustedBrowserFixture(),
  store = new Store(':memory:', { sample: false });
const control = {
  controller: 'agent',
  epoch: 0,
  assertControl(actor) {
    if (actor !== this.controller) throw Error('Browser control changed');
  },
};
const browser = new TrustedBrowser(store, {
  key: randomBytes(32),
  control,
  enabled: true,
  channel: 'chrome',
  resolver: site.resolver,
  transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: site.cert }),
});
const checks = [];
const pass = (label) => {
  checks.push(label);
  console.log('PASS', label);
};
async function waitFor(fn) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await delay(50);
  }
  throw Error(
    'Expected actual browser state; ' +
      JSON.stringify(browser.requests.list().map(({ url, phase }) => ({ url, phase }))),
  );
}
const pending = () => browser.requests.list().filter((r) => r.phase === 'pending');
async function start(action) {
  const id = randomUUID();
  await browser.begin({ operationId: id, ...action }, 'agent');
  return id;
}
async function approveAll(id) {
  for (let i = 0; i < 200; i++) {
    if (browser.action(id).phase !== 'running') break;
    for (const r of pending()) await browser.decide(r.id, r.fingerprint, true);
    await delay(50);
  }
  assert.equal(browser.action(id).phase, 'completed');
}
try {
  const id = await start({ action: 'open', url: `${site.origin}/resource-boundaries` });
  await waitFor(() => pending().some((r) => r.url.endsWith('/resource-boundaries')));
  const root = pending().find((r) => r.url.endsWith('/resource-boundaries'));
  assert.equal(root.pageLoad.origin, site.origin);
  assert.equal(site.calls.length, 0);
  await browser.decide(root.id, root.fingerprint, true, true);
  await waitFor(() =>
    ['/cross-origin.svg', '/frame-document', '/page-api'].every((url) =>
      pending().some((r) => r.url.endsWith(url)),
    ),
  );
  await waitFor(
    () =>
      browser.requests
        .list()
        .filter((r) => r.authorization === 'page-load' && r.phase === 'completed').length >= 3,
  );
  for (const path of ['/page-assets/style.css', '/page-assets/script.js', '/page-assets/hero.svg'])
    assert.equal(site.calls.filter((c) => c.url === path).length, 1);
  pass(
    'One page decision loads the same-origin script, style and image with explicit page-load receipts',
  );
  for (const path of ['/cross-origin.svg', '/frame-document', '/page-api']) {
    const r = pending().find((r) => r.url.endsWith(path));
    assert.equal(r.pageLoad, undefined);
    assert.equal(site.calls.filter((c) => c.url === path).length, 0);
  }
  pass(
    'Actual cross-origin image, child-frame document and Fetch requests remain blocked before exact review',
  );
  await approveAll(id);
  assert.equal(site.calls.filter((c) => c.url === '/page-assets/icon.svg').length, 1);
  assert.equal(
    browser.requests.list().find((r) => r.url.endsWith('/page-assets/icon.svg')).authorization,
    'page-load',
  );
  assert.equal(browser.requests.pageLoads.size, 0);
  let page = await browser.observe('agent');
  assert(page.content.some((n) => n.name === 'Page details loaded'));
  const later = await start({
    action: 'click',
    target: page.content.find((n) => n.name === 'Load another image' && n.target).target,
  });
  await waitFor(() => pending().some((r) => r.url.endsWith('/later-image.svg')));
  assert.equal(site.calls.filter((c) => c.url === '/later-image.svg').length, 0);
  await approveAll(later);
  pass(
    'Finishing the load revokes its grant; the next image-producing action requires a fresh review',
  );
  page = await browser.observe('agent');
  const form = await start({
    action: 'click',
    target: page.content.find((n) => n.name === 'Send form' && n.target).target,
  });
  await waitFor(() => pending().some((r) => r.url.endsWith('/resource-write')));
  const formRequest = pending().find((r) => r.url.endsWith('/resource-write'));
  assert.equal(formRequest.method, 'POST');
  assert.equal(formRequest.pageLoad, undefined);
  assert.equal(site.calls.filter((c) => c.url === '/resource-write').length, 0);
  await approveAll(form);
  assert.equal(site.calls.filter((c) => c.url === '/resource-write').length, 1);
  pass('A form still waits for exact review and reaches the service once');
  const redirect = await start({ action: 'open', url: `${site.origin}/resource-redirect` });
  await waitFor(() => pending().some((r) => r.url.endsWith('/resource-redirect')));
  const redirectRequest = pending().find((r) => r.url.endsWith('/resource-redirect'));
  const before = site.calls.filter((c) => c.url === '/resource-boundaries').length;
  await browser.decide(redirectRequest.id, redirectRequest.fingerprint, true, true);
  await waitFor(() => pending().some((r) => r.url.endsWith('/resource-boundaries')));
  assert.equal(browser.requests.pageLoads.size, 0);
  assert.equal(site.calls.filter((c) => c.url === '/resource-boundaries').length, before);
  const next = pending().find((r) => r.url.endsWith('/resource-boundaries'));
  await browser.decide(next.id, next.fingerprint, true, true);
  await approveAll(redirect);
  pass('A document redirect revokes the original scope and waits for its own owner decision');
  const exact = await start({ action: 'open', url: `${site.origin}/resource-boundaries` });
  await waitFor(() => pending().some((r) => r.url.endsWith('/resource-boundaries')));
  const exactRequest = pending().find((r) => r.url.endsWith('/resource-boundaries'));
  const images = site.calls.filter((c) => c.url === '/page-assets/hero.svg').length;
  await browser.decide(exactRequest.id, exactRequest.fingerprint, true);
  await waitFor(() => pending().some((r) => r.url.endsWith('/page-assets/hero.svg')));
  assert.equal(site.calls.filter((c) => c.url === '/page-assets/hero.svg').length, images);
  assert.equal(browser.requests.pageLoads.size, 0);
  await approveAll(exact);
  pass('Only this request retains exact per-request review for subsequent resources');
  const evidence = resolve('../relay-evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    resolve(evidence, 'browser-page-load-runtime-acceptance.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          'Actual host Chromium and CDP resource/frame classifications, real HTTPS bytes, controlled computer authority; no owner data',
        limits: {
          requests: 64,
          milliseconds: 30000,
          scope: 'same-origin rendering resources in one action and main frame',
        },
        limitations: [
          'No complete taint classifier or browser/host egress proof',
          'A resource GET can still cause same-site effects; this is an explicit bounded grant',
          'No public account, physical-device or Android certification',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  store.close();
  await site.close();
}
