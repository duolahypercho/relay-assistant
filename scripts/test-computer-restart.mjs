// SPDX-License-Identifier: MIT
// Actual server-process restart, isolated Docker desktop and owner GUI buffer.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const directory = await mkdtemp(join(tmpdir(), 'relay-service-restart-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const name = 'relay-desktop-' + createHash('sha256').update(directory).digest('hex').slice(0, 16);
const commands = name + '-commands';
const docker = '/opt/homebrew/bin/docker';
const run = promisify(execFile);
const dockerRun = async (...args) =>
  (await run(docker, args, { timeout: 30000, maxBuffer: 2_000_000 })).stdout;
const inspect = async (target) => JSON.parse(await dockerRun('inspect', target))[0];
const checks = [],
  logs = [];
let child, url;
const check = (label) => {
  checks.push(label);
  console.log('PASS', label);
};
async function until(fn, message) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error(message);
}
async function launch() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('RELAY_') || key.startsWith('GOOGLE_') || key === 'BRAVE_SEARCH_API_KEY')
      delete env[key];
  Object.assign(env, {
    RELAY_DATA_DIR: directory,
    RELAY_PORT: '0',
    RELAY_HOST: '127.0.0.1',
    RELAY_MODE: 'live',
    RELAY_DESKTOP_ENABLED: 'true',
    RELAY_DESKTOP_WEB_ENABLED: 'true',
    RELAY_BROWSER_ENABLED: 'false',
  });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (part) => {
    output += part;
    logs.push(String(part));
  });
  child.stderr.on('data', (part) => logs.push(String(part)));
  await until(() => {
    if (child.exitCode !== null) throw Error('Isolated Relay server exited during startup');
    const found = output.match(/Relay is ready at (http:\/\/[^ ]+)/);
    if (found) {
      url = found[1];
      return true;
    }
  }, 'Server startup did not finish');
}
async function stopServer() {
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await Promise.race([
    ended,
    delay(20000).then(() => {
      throw Error('Server has not exited');
    }),
  ]);
  assert.equal(code, 0, 'Server must exit cleanly');
  assert.equal(signal, null);
}
async function api(path, body) {
  const response = await fetch(url + '/api' + path, {
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { Origin: url, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  assert.equal(response.ok, true, result.error || path);
  return result;
}
const action = (input) => api('/computer/action', { ...input, operationId: randomUUID() });
const size = async () =>
  Number((await dockerRun('exec', name, 'stat', '-c', '%s', '/workspace/restart-ticks')).trim());
try {
  await launch();
  await api('/computer/start', {});
  const original = await inspect(name),
    runtime = await inspect(commands);
  await dockerRun(
    'exec',
    '-d',
    commands,
    'python3',
    '-u',
    '-c',
    "import time\nf=open('/workspace/restart-ticks','ab',buffering=0)\nwhile True:\n f.write(b'tick\\n'); time.sleep(.05)",
  );
  await until(async () => {
    try {
      return (await size()) > 0;
    } catch {
      return false;
    }
  }, 'Detached probe did not start');
  const beforeStop = await size();
  await stopServer();
  assert.equal((await inspect(name)).Id, original.Id);
  assert.equal((await inspect(name)).State.Running, true);
  assert.equal((await inspect(commands)).Id, runtime.Id);
  await until(
    async () => (await size()) > beforeStop,
    'Offline work stopped during service downtime',
  );
  check(
    'SIGTERM preserves the same desktop and command container with no registered jobs; offline work continues',
  );
  await launch();
  assert.equal((await api('/computer')).state, 'running');
  await api('/computer/takeControl', {});
  assert.equal((await inspect(commands)).State.Paused, true);
  const frozen = await size();
  await action({
    kind: 'exec',
    command: 'mousepad /workspace/restart-note.txt >/tmp/restart-editor.log 2>&1 &',
  });
  await until(async () => {
    const result = await dockerRun('exec', name, 'sh', '-c', 'pgrep -x mousepad || true');
    return !!result.trim();
  }, 'Owner editor did not open');
  await delay(1000);
  await action({
    kind: 'desktop',
    action: 'type',
    text: 'An unsaved thought survives the Relay update.',
  });
  const editorPid = (await dockerRun('exec', name, 'pgrep', '-x', 'mousepad')).trim();
  const absent = await dockerRun(
    'exec',
    name,
    'sh',
    '-c',
    'if test -f /workspace/restart-note.txt; then echo saved; else echo unsaved; fi',
  );
  assert.equal(absent.trim(), 'unsaved');
  const picture = await api('/computer/screen');
  await writeFile(
    join(evidence, 'computer-restart-before.jpg'),
    Buffer.from(picture.screenshot, 'base64'),
  );
  await api('/computer/websites/request', { url: 'https://example.com' });
  await api('/computer/websites/decide', { host: 'example.com', decision: 'allow' });
  assert.ok((await api('/computer/websites')).sites.some((s) => s.status === 'allowed'));
  await stopServer();
  assert.equal((await inspect(commands)).State.Paused, true);
  await delay(200);
  assert.equal(await size(), frozen);
  assert.equal((await dockerRun('exec', name, 'pgrep', '-x', 'mousepad')).trim(), editorPid);
  check('Owner shutdown keeps the unsaved editor process open and command descendants frozen');
  await launch();
  const recovered = await api('/computer');
  assert.equal(recovered.state, 'running');
  assert.equal(recovered.controller, 'owner');
  assert.equal((await inspect(name)).Id, original.Id);
  assert.equal((await inspect(commands)).Id, runtime.Id);
  assert.equal((await inspect(commands)).State.Paused, true);
  assert.ok(!(await api('/computer/websites')).sites.some((s) => s.status === 'allowed'));
  await action({ kind: 'desktop', action: 'key', key: 'ctrl+s' });
  await until(async () => {
    try {
      return (await dockerRun('exec', name, 'cat', '/workspace/restart-note.txt')).includes(
        'An unsaved thought survives the Relay update.',
      );
    } catch {
      return false;
    }
  }, 'The unsaved GUI text did not survive server restart');
  const after = await api('/computer/screen');
  await writeFile(
    join(evidence, 'computer-restart-after.jpg'),
    Buffer.from(after.screenshot, 'base64'),
  );
  assert.equal(await size(), frozen);
  check(
    'A new server reconnects to the same owner desktop, saves its pre-restart buffer and leaves old network grants expired',
  );
  await api('/computer/release', {});
  await until(
    async () => (await size()) > frozen,
    'Handback failed to resume the original process',
  );
  assert.equal((await inspect(commands)).Id, runtime.Id);
  check('Explicit handback resumes the original command container without relaunching work');
  await api('/computer/stop', {});
  assert.equal((await inspect(name)).State.Running, false);
  assert.equal(
    (
      await dockerRun(
        'container',
        'ls',
        '-a',
        '--filter',
        `name=^/${commands}$`,
        '--format',
        '{{.Names}}',
      )
    ).trim(),
    '',
  );
  await api('/computer/start', {});
  assert.equal(
    (await dockerRun('exec', name, 'cat', '/workspace/restart-note.txt')).trim(),
    'An unsaved thought survives the Relay update.',
  );
  assert.equal((await dockerRun('exec', name, 'sh', '-c', 'pgrep -x mousepad || true')).trim(), '');
  check('Explicit Stop closes apps and command work; starting again retains saved files');
  await api('/computer/stop', {});
  await stopServer();
  await writeFile(
    join(evidence, 'computer-service-restart-acceptance.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        checks,
        runtime:
          'Real isolated Docker/Colima desktop, real server SIGTERM and process restart, real mousepad unsaved buffer',
        preservedContainerId: original.Id,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(15000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await writeFile(join(evidence, 'computer-service-restart-server.log'), logs.join(''));
  await dockerRun('rm', '-f', commands, name).catch(() => {});
  await dockerRun('volume', 'rm', name + '-display', name + '-files').catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
