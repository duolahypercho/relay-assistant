// SPDX-License-Identifier: MIT
// Build the reviewed source archive, unpack only its verified files, and rebuild in isolation.
import { mkdtemp, mkdir, readFile, writeFile, rm, open, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as yauzl from 'yauzl';
import { packageSourceRelease, collectSourceFiles } from './source-release.mjs';

async function smokeServer(work, env, logs) {
  const started = Date.now();
  const logPath = join(logs, 'server.log');
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: work,
    env: {
      ...env,
      RELAY_PORT: '0',
      RELAY_HOST: '127.0.0.1',
      RELAY_DATA_DIR: join(work, '.smoke-data'),
      RELAY_MODE: 'sample',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_TRUSTED_BROWSER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', log.fd],
  });
  let ended = false;
  const exit = new Promise((accept) => {
    child.once('error', (error) => {
      ended = true;
      accept({ error: error.message });
    });
    child.once('exit', (code, signal) => {
      ended = true;
      accept({ code, signal });
    });
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  try {
    const deadline = Date.now() + 20000;
    while (!/Relay is ready at http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      assert(!ended, `Rebuilt server exited before readiness; inspect ${logPath}`);
      assert(Date.now() < deadline, 'Rebuilt server did not become ready in 20 seconds');
      await new Promise((accept) => setTimeout(accept, 50));
    }
    const url = output.match(/Relay is ready at (http:\/\/127\.0\.0\.1:\d+)/)[1];
    const get = async (path) => {
      const res = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 200, path);
      return res;
    };
    assert.deepEqual(await (await get('/api/health')).json(), {
      ok: true,
      name: 'Relay',
      version: '0.1.0',
      mode: 'sample',
    });
    const state = await (await get('/api/state')).json();
    assert(state.threads.some((thread) => thread.id === 'main'));
    assert.deepEqual(
      state.messages.map((message) => message.id),
      ['welcome'],
    );
    assert.equal(state.connections.model.configured, false);
    const html = await (await get('/')).text();
    assert.match(html, /<div id="root"><\/div>/);
    const assets = [
      ...new Set(
        [...html.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_.\/-]+)"/g)].map((m) => m[1]),
      ),
    ];
    assert(assets.some((path) => path.endsWith('.js')));
    assert(assets.some((path) => path.endsWith('.css')));
    for (const path of assets) {
      assert(!path.includes('..'));
      const bytes = Buffer.from(await (await get(path)).arrayBuffer());
      assert(bytes.equals(await readFile(join(work, 'dist', path.slice(1)))), path);
    }
    const after = await (await get('/api/state')).json();
    assert.deepEqual(after.messages, state.messages);
    return {
      name: 'rebuilt server health, fresh main chat and exact web assets',
      passed: true,
      assets: assets.length,
      elapsedMs: Date.now() - started,
      log: logPath,
    };
  } finally {
    if (!ended) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!ended) child.kill('SIGKILL');
    }, 10000);
    try {
      const result = await exit;
      await log.write(output);
      assert.equal(result.code, 0, 'Rebuilt server did not shut down cleanly');
    } finally {
      clearTimeout(timer);
      await log.close();
    }
  }
}

const root = resolve('.');
const source = await collectSourceFiles(root);
const release = await packageSourceRelease(root, resolve('release/source'));
const work = await mkdtemp(join(tmpdir(), 'relay-source-check-'));
const logs = resolve('release/source', `verification-${release.treeHash.slice(0, 16)}`);
await mkdir(logs, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  passed: false,
  release,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  steps: [],
};
try {
  const files = new Map(source.entries.map((e) => [e.path, e]));
  files.set('SOURCE-MANIFEST.json', { bytes: source.manifestBytes, mode: 0o644 });
  const zip = await yauzl.fromBufferPromise(await readFile(release.archive), {
    lazyEntries: true,
    strictFileNames: true,
  });
  const seen = new Set();
  try {
    for await (const entry of zip.eachEntry()) {
      assert(entry.fileName.startsWith(release.folder + '/'));
      const relative = entry.fileName.slice(release.folder.length + 1);
      const expected = files.get(relative);
      assert(expected && !seen.has(relative), 'Unexpected or duplicated archived source file');
      seen.add(relative);
      assert.equal(entry.uncompressedSize, expected.bytes.length);
      assert.equal((entry.externalFileAttributes >>> 16) & 0o777, expected.mode);
      const stream = await zip.openReadStreamPromise(entry),
        chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        assert(size <= expected.bytes.length);
        chunks.push(chunk);
      }
      assert(Buffer.concat(chunks).equals(expected.bytes), relative);
      const path = join(work, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected.bytes, { flag: 'wx', mode: expected.mode });
      await chmod(path, expected.mode);
    }
  } finally {
    zip.close();
  }
  assert.equal(seen.size, files.size);
  report.steps.push({
    name: 'archive entries, exact bytes and executable modes',
    passed: true,
    files: seen.size,
  });
  const userNpmrc = join(work, '.isolated-user-npmrc');
  const globalNpmrc = join(work, '.isolated-global-npmrc');
  await writeFile(userNpmrc, '');
  await writeFile(globalNpmrc, '');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE', 'COMSPEC'].includes(key),
    ),
  );
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: userNpmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  });
  for (const [name, args] of [
    ['install', ['ci']],
    ['format', ['run', 'format:check']],
    ['tests', ['test']],
    ['build', ['run', 'build']],
    ['source', ['run', '--silent', 'release:source']],
  ]) {
    const started = Date.now();
    const logPath = join(logs, name + '.log');
    const log = await open(logPath, 'w');
    console.log(`Clean source ${name}…`);
    let result;
    try {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: work,
        env,
        stdio: ['ignore', log.fd, log.fd],
      });
      result = await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => accept({ code, signal }));
      });
    } finally {
      await log.close();
    }
    report.steps.push({ name, ...result, elapsedMs: Date.now() - started, log: logPath });
    assert.equal(result.code, 0, `Clean source ${name} failed; inspect ${logPath}`);
    if (name === 'build') {
      console.log('Clean source server…');
      report.steps.push(await smokeServer(work, env, logs));
    }
  }
  const rebuilt = JSON.parse(await readFile(join(logs, 'source.log'), 'utf8'));
  assert.equal(
    createHash('sha256')
      .update(await readFile(rebuilt.archive))
      .digest('hex'),
    release.sha256,
  );
  assert.equal(
    rebuilt.sha256,
    release.sha256,
    'Rebuilding from extracted source changed the archive',
  );
  report.steps.push({
    name: 'byte-identical archive rebuilt after clean install, tests and web build',
    passed: true,
    sha256: rebuilt.sha256,
  });
  report.passed = true;
  console.log(
    'PASS: clean source install, formatting, tests, build, server, and identical source archive',
  );
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await rm(work, { recursive: true, force: true });
  report.temporaryCheckoutRemoved = true;
  await writeFile(join(logs, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: join(logs, 'result.json') }));
}
