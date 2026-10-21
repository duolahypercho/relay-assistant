// SPDX-License-Identifier: MIT
// Disposable Linux deployment acceptance. Requires Docker Compose and built server images.
// Uses new volumes, a loopback-only HTTPS port, and a controlled model transport.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { request, Agent } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stringify } from 'yaml';
const exec = promisify(execFile),
  docker = process.env.RELAY_TEST_DOCKER || 'docker';
const root = resolve(import.meta.dirname, '..'),
  evidence = resolve(root, '../relay-evidence');
const directory = await mkdtemp(join(tmpdir(), 'relay-hosting-acceptance-'));
const project = 'relay-hosting-' + randomUUID().slice(0, 8);
const override = join(directory, 'override.yaml');
let browser,
  agent,
  cookie = '',
  key,
  url,
  port,
  httpPort,
  keep = false;
const report = {
  startedAt: new Date().toISOString(),
  model: 'controlled HTTP transport; not model-quality acceptance',
  project,
  checks: [],
};
const d = async (...args) =>
  (await exec(docker, args, { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const compose = (...args) =>
  d('compose', '-p', project, '-f', 'deploy/compose.yaml', '-f', override, ...args);
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(500);
  } while (Date.now() < end);
  throw Error(label + ': ' + (last?.message || 'timed out'));
}
function call(path, { method = 'GET', body, origin = url, auth = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      url + path,
      {
        agent,
        method,
        headers: {
          ...(auth && cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(Error('HTTPS request timed out')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function command(action, payload) {
  const r = await call('/api/command', { method: 'POST', body: { action, payload } });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  return r.json;
}
async function state() {
  const r = await call('/api/state');
  assert.equal(r.status, 200);
  return r.json;
}
async function check(name, fn) {
  await fn();
  report.checks.push(name);
  console.log('PASS', name);
}
const providerSource = `import http from 'node:http'; http.createServer(async (req,res)=>{let body=''; for await(const b of req) body+=b; if(req.url==='/v1/models'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'hosting-transport'}]}));} if(req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();} res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'hosting-test',object:'chat.completion',model:'hosting-transport',choices:[{message:{role:'assistant',content:'Your hosted Relay is here. Your message and saved work are available across devices.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:16,total_tokens:26}}));}).listen(39901,'0.0.0.0');`;
try {
  await mkdir(evidence, { recursive: true });
  port = await freePort();
  httpPort = await freePort();
  url = `https://127.0.0.1:${port}`;
  process.env.RELAY_DOMAIN = '127.0.0.1';
  let yaml = stringify({
    services: {
      app: {
        environment: {
          RELAY_PUBLIC_URL: url,
          RELAY_MODEL_BASE_URL: 'http://provider:39901/v1',
          RELAY_MODEL_ID: 'hosting-transport',
          RELAY_MODEL_PROTOCOL: 'chat',
        },
        healthcheck: { interval: '2s', timeout: '5s', retries: 30, start_period: '5s' },
      },
      https: { ports: [`127.0.0.1:${httpPort}:80`, `127.0.0.1:${port}:443`] },
      provider: {
        image: 'relay-server:local',
        healthcheck: { disable: true },
        entrypoint: ['node', '--input-type=module', '-e', providerSource],
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
      },
    },
  });
  yaml = yaml.replace('    ports:', '    ports: !override');
  await writeFile(override, yaml);
  await compose('up', '-d', '--wait', '--wait-timeout', '180');
  const cid = await compose('ps', '-q', 'https');
  const caPath = join(directory, 'root.crt');
  await until(async () => {
    try {
      await d('cp', `${cid}:/data/caddy/pki/authorities/local/root.crt`, caPath);
      return true;
    } catch {
      return false;
    }
  }, 'Caddy internal CA');
  agent = new Agent({ ca: await readFile(caPath), keepAlive: false });
  await until(async () => (await call('/api/health')).status === 200, 'Trusted HTTPS startup');
  await check(
    'certificate trusted explicitly; HTTPS health, access gate and origin protection',
    async () => {
      assert.equal((await call('/api/health')).status, 200);
      assert.equal((await call('/api/state')).status, 401);
      assert.equal(
        (await call('/api/login', { method: 'POST', body: { key: 'incorrect-key' } })).status,
        401,
      );
      key = (await compose('run', '--rm', '--no-deps', '-T', 'setup', '--show-access-key')).trim();
      assert.match(key, /^[a-f0-9]{64}$/);
      const r = await call('/api/login', { method: 'POST', body: { key } });
      assert.equal(r.status, 200);
      const header = r.headers['set-cookie'][0];
      for (const value of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(header.includes(value));
      cookie = header.split(';')[0];
      assert.equal(
        (
          await call('/api/command', {
            method: 'POST',
            origin: 'https://untrusted.invalid',
            body: { action: 'profile.update', payload: { name: 'Blocked' } },
          })
        ).status,
        403,
      );
      assert.ok(!JSON.stringify(await state()).includes(key));
    },
  );
  await check(
    'unprivileged, read-only app; no host mounts, Docker socket or public app port',
    async () => {
      const id = await compose('ps', '-q', 'app'),
        [info] = JSON.parse(await d('inspect', id));
      assert.equal(info.Config.User, 'node');
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
      assert.ok(Object.values(info.NetworkSettings.Ports || {}).every((ports) => ports === null));
      assert.ok(info.Mounts.every((m) => m.Type !== 'bind'));
      assert.ok(!JSON.stringify(info).includes(key));
      report.linux = await d(
        'exec',
        id,
        'node',
        '-p',
        'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,uid:process.getuid()})',
      );
      assert.equal(JSON.parse(report.linux).platform, 'linux');
      assert.notEqual(JSON.parse(report.linux).uid, 0);
    },
  );
  await command('profile.update', { name: 'Hosting acceptance' });
  await check(
    'real server worker receives a chat and writes the controlled model reply',
    async () => {
      await command('chat.send', { threadId: 'main', text: 'Hello from the hosted workspace.' });
      await until(
        async () =>
          (await state()).messages.some(
            (m) => m.role === 'assistant' && m.text.includes('Your hosted Relay'),
          ),
        'assistant reply',
      );
      assert.equal((await state()).messages.filter((m) => m.role === 'user').length, 1);
    },
  );
  await check('encrypted model credential survives process and container recreation', async () => {
    const secret = randomUUID();
    const saved = await call('/api/models/save', {
      method: 'POST',
      body: {
        preset: 'custom',
        name: 'Saved hosting connection',
        baseUrl: 'https://model.example.test/v1',
        protocol: 'chat',
        model: 'restore-test',
        apiKey: secret,
      },
    });
    assert.equal(saved.status, 200, saved.text);
    report.savedModelId = saved.json.id;
    const id = await compose('ps', '-q', 'app');
    const probe = `import {Store} from './server/store.mjs';import {ModelConnections,modelVaultKey} from './server/model-connections.mjs';const s=new Store('/app/data/relay.sqlite');const p=new ModelConnections(s,{key:modelVaultKey('/app/data')});process.stdout.write(p.record(${JSON.stringify(report.savedModelId)}).apiKey);s.close();`;
    assert.equal(await d('exec', id, 'node', '--input-type=module', '-e', probe), secret);
    report.credentialProbe = probe; // Contains only an ID, never the credential.
    // Keep the credential solely in this private test directory for optional restore acceptance.
    await writeFile(join(directory, 'expected-credential'), secret, { mode: 0o600 });
    await compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'app');
    assert.equal((await state()).profile.name, 'Hosting acceptance');
    assert.equal(
      await d('exec', await compose('ps', '-q', 'app'), 'node', '--input-type=module', '-e', probe),
      secret,
    );
    assert.equal(
      (await compose('run', '--rm', '--no-deps', '-T', 'setup', '--show-access-key')).trim(),
      key,
    );
  });
  await check('scheduled task completes after downtime without an open browser', async () => {
    const at = new Date(Math.ceil((Date.now() + 12000) / 60000) * 60000);
    const result = await command('routine.create', {
      title: 'Hosted background check',
      instructions: 'Say that the background check completed.',
      threadId: 'main',
      schedule: {
        kind: 'once',
        date: at.toISOString().slice(0, 10),
        time: at.toISOString().slice(11, 16),
        timeZone: 'UTC',
      },
    });
    const routine = (await state()).routines.find((r) => r.title === 'Hosted background check');
    assert.ok(routine);
    await command('routine.resume', { id: routine.id });
    await compose('stop', 'app');
    while (Date.now() < at.getTime() + 1000)
      await delay(Math.min(1000, at.getTime() + 1000 - Date.now()));
    await compose('up', '-d', '--no-deps', '--wait', 'app');
    await until(
      async () =>
        (await state()).runs.some((r) => r.routineId === routine.id && r.status === 'completed'),
      'background routine',
    );
    const runs = (await state()).runs.filter((r) => r.routineId === routine.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'schedule');
  });
  await check(
    'headless Linux browser can read a public page and blocks private network targets',
    async () => {
      const r = await call('/api/browser/navigate', {
        method: 'POST',
        body: { url: 'https://example.com' },
      });
      assert.equal(r.status, 200, r.text.slice(0, 400));
      assert.match(r.json.title, /Example Domain/);
      assert.ok(r.json.screenshot.length > 1000);
      await writeFile(
        join(evidence, 'hosting-linux-browser.jpg'),
        Buffer.from(r.json.screenshot, 'base64'),
      );
      assert.notEqual(
        (
          await call('/api/browser/navigate', {
            method: 'POST',
            body: { url: 'http://127.0.0.1:4173' },
          })
        ).status,
        200,
      );
      await call('/api/browser/stop', { method: 'POST', body: {} });
    },
  );
  browser = await chromium.launch();
  await check(
    'desktop and phone layouts sign in, synchronize messages, and keep navigation out of history',
    async () => {
      const desktop = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        ignoreHTTPSErrors: true,
      });
      const pages = [await desktop.newPage(), await mobile.newPage()];
      for (const page of pages) {
        await page.goto(url + '/#chat');
        await page.getByLabel('Server access key', { exact: true }).fill(key);
        await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
        await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
        assert.ok(await page.evaluate(() => isSecureContext));
      }
      const text = 'This message came from my phone.';
      await pages[1].getByLabel('Message Relay', { exact: true }).fill(text);
      await pages[1].getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        pages[0].locator('.message.user .markdown').filter({ hasText: text }),
      ).toBeVisible();
      await until(
        async () => !(await state()).runs.some((r) => ['queued', 'running'].includes(r.status)),
        'chat worker idle',
      );
      const count = (await state()).messages.length;
      for (const [i, page] of pages.entries()) {
        await page.goto(url + '/#files');
        await page.goto(url + '/#chat');
        await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
        await expect(
          page.locator('.message.user .markdown').filter({ hasText: text }),
        ).toBeVisible();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
          [],
        );
        await page.screenshot({ path: join(evidence, `hosting-${i ? 'phone' : 'desktop'}.png`) });
      }
      assert.equal((await state()).messages.length, count);
      await desktop.close();
      await mobile.close();
    },
  );
  if (process.env.RELAY_HOSTING_KEEP === 'true') {
    keep = true;
    await writeFile(
      join(directory, 'private-state.json'),
      JSON.stringify({
        project,
        directory,
        override,
        url,
        port,
        httpPort,
        key,
        cookie,
        caPath,
        credentialProbe: report.credentialProbe,
      }),
      { mode: 0o600 },
    );
    console.log('Private continuation state:', join(directory, 'private-state.json'));
  }
  report.passed = true;
} finally {
  if (!report.passed)
    await writeFile(
      join(evidence, 'hosting-failure.log'),
      await compose('logs', '--no-color', '--tail=60', 'app', 'https').catch(
        () => 'Logs unavailable',
      ),
    );
  delete report.credentialProbe;
  await browser?.close();
  agent?.destroy();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'hosting-acceptance.json'), JSON.stringify(report, null, 2));
  if (!keep) {
    await compose('down', '--volumes', '--remove-orphans').catch((error) =>
      console.error('Test cleanup needs attention:', error.message),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
