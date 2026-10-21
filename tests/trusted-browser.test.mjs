// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { BrowserVault } from '../server/browser-vault.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { createApp } from '../server/app.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function vaultFixture(t) {
  const store = new Store(':memory:', { sample: false }),
    key = randomBytes(32);
  const vault = new BrowserVault(store, key);
  t.after(() => store.close());
  return { store, key, vault };
}
test('remembered private inputs persist encrypted and reject cross-origin plaintext, form, JSON, percent and base64 representations', (t) => {
  const { store, key, vault } = vaultFixture(t),
    origin = 'https://account.example';
  const password = 'p\u00e4ss word&42';
  vault.rememberPrivate(origin, password);
  assert(!store.secret('trusted-browser-vault').includes(password));
  assert(!JSON.stringify(store.read()).includes(password));
  const restored = new BrowserVault(store, key);
  const variants = [
    password,
    encodeURIComponent(password),
    Buffer.from(password).toString('base64'),
    'p\\u00e4ss word&42',
    '%70%C3%A4ss%20word%2642',
  ];
  for (const text of variants) {
    const input = {
      url: 'https://other.example/submit',
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(text),
    };
    assert.throws(() => restored.request(input), /destination/);
    assert.deepEqual(
      restored.request({ ...input, url: `${origin}/submit` }).body,
      Buffer.from(text),
    );
  }
  restored.rememberPrivate(origin, 'password');
  assert.throws(
    () => restored.request({ url: 'https://other.example/?secret=pa%73sword', headers: {} }),
    /destination/,
  );
  assert.equal(
    restored.redact('https://account.example/?secret=pa%73sword'),
    'https://account.example/?secret=[private]',
  );
  assert.equal(restored.redact('value=p\\u00e4ss%20word%2642'), 'value=[private]');
  restored.clear();
  assert.equal(restored.read().privateInputs.length, 0);
});

test('private-input limits are bounded, duplicate values do not grow storage, and unsafe origins are rejected', (t) => {
  const { vault } = vaultFixture(t),
    origin = 'https://account.example';
  vault.rememberPrivate(origin, 'one');
  vault.rememberPrivate(origin, 'one');
  assert.equal(vault.read().privateInputs.length, 1);
  assert.throws(() => vault.rememberPrivate('http://account.example', 'secret'), /HTTPS/);
  assert.throws(() => vault.rememberPrivate(origin, 'x'.repeat(4097)), /limit/);
  for (let i = 1; i < 100; i++) vault.rememberPrivate(origin, `private-${i}`);
  assert.throws(() => vault.rememberPrivate(origin, 'overflow'), /full/);
});

test('browser runtime fails closed without control authority or explicit enablement', async (t) => {
  const { store, key } = vaultFixture(t);
  assert.throws(() => new TrustedBrowser(store, { key }), /authority/);
  const control = {
    controller: 'owner',
    epoch: 0,
    assertControl(actor) {
      if (actor !== this.controller) throw Error('Wrong controller');
    },
  };
  const browser = new TrustedBrowser(store, { key, control });
  try {
    await assert.rejects(
      browser.begin(
        { operationId: 'disabled', action: 'open', url: 'https://account.example' },
        'owner',
      ),
      /unavailable/,
    );
    await assert.rejects(browser.observe('owner'), /unavailable/);
    assert.equal(browser.browser, undefined);
    assert.equal(browser.requests.active.size, 0);
  } finally {
    await browser.close();
  }
});

test('durable browser receipts cannot be changed, cross-owned or resumed after interruption', async (t) => {
  const { store, key } = vaultFixture(t);
  const control = {
    controller: 'agent',
    epoch: 0,
    assertControl(actor) {
      if (actor !== this.controller) throw Error('Wrong controller');
    },
  };
  const browser = new TrustedBrowser(store, { key, control, enabled: true });
  try {
    for (const input of [
      { operationId: 'eval', action: 'evaluate', script: 'document.cookie' },
      { operationId: 'file', action: 'open', url: 'file:///etc/passwd' },
      { operationId: 'url-creds', action: 'open', url: 'https://user:pass@account.example' },
      { operationId: 'key', action: 'key', target: 'unknown', key: 'Meta+L' },
      { operationId: 'big', action: 'type', target: 'unknown', text: 'x'.repeat(4097) },
    ])
      await assert.rejects(browser.begin(input, 'agent'));
    assert.equal(browser.browser, undefined);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM trusted_browser_actions').get().n, 0);
    store.db
      .prepare('INSERT INTO trusted_browser_actions VALUES (?,?,?,?,?,?)')
      .run(
        'interrupted',
        'digest',
        'agent',
        'running',
        'old-private-input',
        new Date().toISOString(),
      );
    await browser.close();
    const next = new TrustedBrowser(store, { key, control, enabled: true });
    try {
      assert.equal(next.action('interrupted').phase, 'interrupted');
      assert.equal(
        store.db.prepare('SELECT input FROM trusted_browser_actions WHERE id=?').get('interrupted')
          .input,
        '',
      );
      await assert.rejects(
        next.begin(
          { operationId: 'interrupted', action: 'open', url: 'https://account.example' },
          'agent',
        ),
        /different/,
      );
      await assert.rejects(next.observe('owner'), /controller/);
      assert.equal(next.browser, undefined);
    } finally {
      await next.close();
    }
  } finally {
    await browser.close();
  }
});

test('private browser endpoints require owner authentication, same-origin writes, enablement and actual computer control', async (t) => {
  const { store, key } = vaultFixture(t);
  const control = {
    controller: 'agent',
    epoch: 0,
    assertControl(actor) {
      if (actor !== this.controller)
        throw Object.assign(Error('Wrong controller'), { status: 409 });
    },
  };
  const browser = new TrustedBrowser(store, { key, control });
  const accessKey = 'fixture-owner-key-with-at-least-24-characters';
  const services = {
    mode: 'sample',
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
    privateBrowser: browser,
  };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['', '/view', '/screen', '/accessibility', '/actions/unknown'])
      assert.equal((await fetch(`${root}/api/private-browser${path}`)).status, 401);
    const login = await fetch(`${root}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: accessKey }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (path, body, extra = {}) =>
      fetch(`${root}/api/private-browser${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await call('')).status, 503);
    browser.enabled = true;
    assert.equal((await call('')).status, 200);
    assert.equal((await call('/clear', {}, { origin: 'https://other.example' })).status, 403);
    assert.equal((await call('/clear', {})).status, 409);
    assert.equal(
      (
        await call('/actions', {
          operationId: 'forged-actor',
          action: 'open',
          url: 'https://account.example',
          actor: 'agent',
        })
      ).status,
      409,
    );
    assert.equal((await call('/accessibility')).status, 409);
    assert.equal(
      (await call('/requests/unknown', { fingerprint: 'unknown', allow: 'true' })).status,
      409,
    );
    assert.equal(browser.browser, undefined);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM trusted_browser_actions').get().n, 0);
    control.controller = 'owner';
    control.epoch++;
    assert.equal((await call('/clear', {})).status, 200);
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    await browser.close();
  }
});

test('the production server opt-in connects the browser API to the real computer authority without starting a browser or guest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-private-browser-entry-'));
  const accessKey = 'entry-fixture-owner-key-with-at-least-24-characters';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      RELAY_DESKTOP_ENV: '',
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '0',
      RELAY_PUBLIC_URL: '',
      RELAY_DATA_DIR: directory,
      RELAY_MODE: 'live',
      RELAY_ACCESS_KEY: accessKey,
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_DESKTOP_ENABLED: 'true',
      RELAY_DESKTOP_WEB_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_TRUSTED_BROWSER_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    root;
  child.stdout.on('data', (part) => {
    output += part;
    root = output.match(/Relay is ready at (http:\/\/[^\s]+)/)?.[1];
  });
  child.stderr.on('data', (part) => {
    output += part;
  });
  const exited = once(child, 'exit');
  try {
    const until = Date.now() + 15000;
    while (!root && child.exitCode === null && Date.now() < until) await delay(25);
    assert(root, `Production server did not start: ${output}`);
    const login = await fetch(`${root}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: accessKey }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(`${root}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.connections.runtime.privateBrowser, true);
    assert.equal(state.connections.runtime.desktop, true);
    const browser = await (
      await fetch(`${root}/api/private-browser`, { headers: { cookie } })
    ).json();
    assert.equal(browser.connected, false);
    assert.equal(browser.controller, 'agent');
    assert.deepEqual(browser.requests, []);
    const action = await fetch(`${root}/api/private-browser/actions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'entry-owner-control',
        action: 'open',
        url: 'https://example.com',
        actor: 'agent',
      }),
    });
    assert.equal(action.status, 409);
    assert.match((await action.json()).error, /Take control/);
    const after = await (
      await fetch(`${root}/api/private-browser`, { headers: { cookie } })
    ).json();
    assert.equal(after.connected, false);
  } finally {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    const [code, signal] = await exited;
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
    assert.equal(signal, null, `Server did not exit cleanly: ${output}`);
    assert.equal(code, 0, `Server exit failure: ${output}`);
  }
});
