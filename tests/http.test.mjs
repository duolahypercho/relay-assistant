import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
const accessKey = 'test-owner-key-with-more-than-24-characters';
// An explicit override accommodates shared native/browser hosts without changing
// assertions or treating a killed process as a successful startup.
const startupBudget = (fallback) =>
  Math.max(fallback, Number(process.env.RELAY_TEST_START_TIMEOUT_MS) || fallback);
test('a busy server port reports the listen failure and exits without announcing readiness', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'relay-busy-port-'));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      RELAY_PORT: String(listener.address().port),
      RELAY_HOST: '127.0.0.1',
      RELAY_DATA_DIR: directory,
      RELAY_MODE: 'sample',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    output += b;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), startupBudget(15000));
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `Unexpected exit (${child.signalCode || 'no signal'}): ${output}`);
    assert.match(output, /EADDRINUSE/);
    assert.doesNotMatch(output, /Relay is ready|TypeError/);
  } finally {
    clearTimeout(timeout);
    listener.close();
    await rm(directory, { recursive: true, force: true });
  }
});
const rawStatus = (url, headers) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
async function harness() {
  const store = new Store(':memory:');
  const services = {
    mode: 'sample',
    provider: { configured: false, model: 'test' },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(url + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    store,
    server,
    url,
    services,
    call,
    async login() {
      const r = await call('/api/login', { method: 'POST', body: { key: accessKey } });
      cookie = r.headers.get('set-cookie').split(';')[0];
      return r;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
test('API requires a session, protects cross-origin writes and rejects DNS-rebinding hosts', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/api/state')).status, 401);
    const login = await h.login();
    assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(login.headers.get('set-cookie').includes('SameSite=Lax'));
    assert.equal((await h.call('/api/state')).status, 200);
    assert.equal(
      (
        await h.call('/api/command', {
          method: 'POST',
          body: { action: 'profile.update', payload: { name: 'Blocked' } },
          headers: { Origin: 'https://untrusted.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(h.store.read().profile.name, '');
    assert.equal(await rawStatus(h.url + '/api/state', { Host: 'untrusted.invalid' }), 403);
    const state = await (await h.call('/api/state')).json();
    assert.equal(state.connections.runtime.storage, 'SQLite');
    assert.ok(!JSON.stringify(state).includes(accessKey));
    await h.call('/api/logout', { method: 'POST' });
    assert.equal((await h.call('/api/state')).status, 401);
  } finally {
    await h.close();
  }
});
test('computer screen and input use the same authenticated, same-origin owner boundary', async () => {
  const h = await harness();
  let calls = 0;
  h.services.computer = {
    enabled: true,
    screenshot: async () => ({ screenshot: 'private' }),
    receipts: () => [],
    perform: async (_p, options) => {
      assert.equal(options.actor, 'owner');
      calls++;
      return { ok: true };
    },
  };
  try {
    assert.equal((await h.call('/api/computer/screen')).status, 401);
    assert.equal(
      (
        await h.call('/api/computer/action', {
          method: 'POST',
          body: { kind: 'desktop', action: 'click' },
        })
      ).status,
      401,
    );
    await h.login();
    assert.equal((await h.call('/api/computer/screen')).status, 200);
    assert.equal(
      (
        await h.call('/api/computer/action', {
          method: 'POST',
          headers: { Origin: 'https://untrusted.invalid' },
          body: { kind: 'desktop', action: 'click' },
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await h.call('/api/computer/action', {
          method: 'POST',
          body: { kind: 'desktop', action: 'click' },
        })
      ).status,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await h.close();
  }
});
test('website permission and continuation can only be granted by an authenticated same-origin owner', async () => {
  const h = await harness();
  let grants = 0;
  h.services.computer = {
    enabled: true,
    network: { status: () => ({ enabled: true, sites: [] }) },
    decideWebsite: async (host, decision, runId) => {
      assert.equal(host, 'example.com');
      assert.equal(decision, 'allow');
      assert.equal(runId, 'original-run');
      grants++;
      return { ok: true };
    },
  };
  const body = { host: 'example.com', decision: 'allow', runId: 'original-run' };
  try {
    assert.equal((await h.call('/api/computer/websites')).status, 401);
    assert.equal(
      (await h.call('/api/computer/websites/decide', { method: 'POST', body })).status,
      401,
    );
    await h.login();
    assert.equal(
      (
        await h.call('/api/computer/websites/decide', {
          method: 'POST',
          body,
          headers: { Origin: 'https://untrusted.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(grants, 0);
    assert.equal(
      (await h.call('/api/computer/websites/decide', { method: 'POST', body })).status,
      200,
    );
    assert.equal(grants, 1);
  } finally {
    await h.close();
  }
});
test('API commands are atomic, malformed requests fail intentionally, and files have safe download headers', async () => {
  const h = await harness();
  try {
    await h.login();
    const before = h.store.read().profile;
    const bad = await h.call('/api/command', {
      method: 'POST',
      body: { action: 'profile.update', payload: { name: 'Do not save', avatarColor: 'wrong' } },
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(h.store.read().profile, before);
    assert.equal(
      (await h.call('/api/command', { method: 'POST', body: { action: 'unknown' } })).status,
      400,
    );
    const response = await h.call('/api/command', {
      method: 'POST',
      body: {
        action: 'file.add',
        payload: { name: 'test.html', mime: 'text/html', text: '<script>bad()</script>' },
      },
    });
    assert.equal(response.status, 200);
    const f = (await response.json()).result;
    const download = await h.call(`/api/files/${f.id}`);
    assert.ok(download.headers.get('content-type').startsWith('text/plain'));
    assert.ok(download.headers.get('content-disposition').startsWith('attachment'));
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await download.text(), '<script>bad()</script>');
    assert.equal((await h.call('/api/files/not-owned')).status, 404);
    const exported = await h.call('/api/export');
    assert.ok(exported.headers.get('content-disposition').includes('relay-workspace.json'));
    assert.equal((await exported.json()).schema, 1);
  } finally {
    await h.close();
  }
});
test('OAuth callback is bound to the initiating browser cookie and state', async () => {
  const h = await harness();
  let count = 0;
  h.services.google.callback = async () => count++;
  try {
    const response = await h.call('/api/google/callback?state=abc&code=test');
    assert.equal(response.status, 400);
    assert.equal(count, 0);
    const matched = await fetch(`${h.url}/api/google/callback?state=abc&code=test`, {
      headers: { Cookie: 'relay_oauth=abc' },
      redirect: 'manual',
    });
    assert.equal(matched.status, 302);
    assert.equal(matched.headers.get('location'), '/?connected=google');
    assert.equal(count, 1);
  } finally {
    await h.close();
  }
});
test('login throttling blocks repeated guesses; state cannot be read with a fabricated cookie', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await h.call('/api/login', { method: 'POST', body: { key: 'wrong' } })).status,
        401,
      );
    assert.equal(
      (await h.call('/api/login', { method: 'POST', body: { key: 'wrong' } })).status,
      429,
    );
    assert.equal(
      (await h.call('/api/state', { headers: { Cookie: 'relay_session=forged' } })).status,
      401,
    );
  } finally {
    await h.close();
  }
});
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function startServer(dir, port) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_HOST: '127.0.0.1',
      RELAY_PUBLIC_URL: `http://127.0.0.1:${port}`,
      RELAY_MODE: 'sample',
      RELAY_DATA_DIR: dir,
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      RELAY_TRANSCRIPTION_BASE_URL: '',
      RELAY_TRANSCRIPTION_MODEL: '',
      RELAY_TRANSCRIPTION_API_KEY: '',
      RELAY_SPEECH_BASE_URL: '',
      RELAY_SPEECH_MODEL: '',
      RELAY_SPEECH_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
      BRAVE_SEARCH_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (b) => (logs += b));
  child.stderr.on('data', (b) => (logs += b));
  // This spawns a real Node process; leave room for a busy native/browser test host.
  const end = Date.now() + startupBudget(30000);
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child;
    } catch {}
    await delay(30);
  }
  child.kill('SIGKILL');
  throw new Error(`Server did not become ready: ${logs}`);
}
async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const stopped = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
  await stopped;
  clearTimeout(timeout);
}
test('real server restart retains owner data, resumes background work without a client, and preserves paused tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-restart-'));
  const port = await freePort();
  let child;
  const url = `http://127.0.0.1:${port}`;
  const command = async (action, payload) => {
    const r = await fetch(url + '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    assert.equal(r.status, 200);
    return (await r.json()).result;
  };
  try {
    child = await startServer(dir, port);
    await command('profile.update', { name: 'Persisted owner' });
    await command('thread.update', { id: 'main', draft: 'Retained draft' });
    const paused = await command('task.create', { title: 'Leave this paused', kind: 'general' });
    await command('task.action', { id: paused.id, action: 'pause' });
    const working = await command('task.create', {
      title: 'Headless finance note',
      kind: 'finance',
    });
    await stopServer(child);
    child = await startServer(dir, port);
    await delay(2800);
    const s = await (await fetch(url + '/api/state')).json();
    assert.equal(s.profile.name, 'Persisted owner');
    assert.equal(s.threads[0].draft, 'Retained draft');
    assert.equal(s.tasks.find((t) => t.id === paused.id).status, 'paused');
    assert.equal(s.tasks.find((t) => t.id === working.id).status, 'completed');
    assert.ok(s.files.some((f) => f.source === 'Headless finance note'));
  } finally {
    if (child) await stopServer(child);
    await rm(dir, { recursive: true });
  }
});

test('terminal input endpoint requires owner authentication and same-origin writes', async () => {
  const h = await harness();
  try {
    const requests = [];
    h.services.computer = {
      enabled: true,
      jobs: {
        input: async (p) => {
          requests.push(p);
          return { accepted: true };
        },
      },
    };
    const payload = { data: 'hello\n', operationId: 'one', id: 'forged', actor: 'agent' };
    assert.equal(
      (await h.call('/api/computer/jobs/actual/input', { method: 'POST', body: payload })).status,
      401,
    );
    await h.login();
    assert.equal(
      (
        await h.call('/api/computer/jobs/actual/input', {
          method: 'POST',
          body: payload,
          headers: { Origin: 'https://untrusted.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await h.call('/api/computer/jobs/actual/input', { method: 'POST', body: payload })).status,
      200,
    );
    assert.deepEqual(requests, [{ id: 'actual', data: 'hello\n', operationId: 'one' }]);
  } finally {
    await h.close();
  }
});
