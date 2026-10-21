// SPDX-License-Identifier: MIT
// Exercise the documented archive workflow against a kept hosting acceptance.
import assert from 'node:assert/strict';
import { readFile, writeFile, open } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, request } from 'node:https';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile),
  p = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { project, override, directory, url, key, cookie, caPath, credentialProbe } = p;
assert.match(project, /^relay-hosting-[a-f0-9]{8}$/);
const restored = project + '-restore',
  docker = process.env.RELAY_TEST_DOCKER || 'docker';
const env = { ...process.env, RELAY_DOMAIN: '127.0.0.1' };
const args = (project, ...rest) => [
  'compose',
  '-p',
  project,
  '-f',
  'deploy/compose.yaml',
  '-f',
  override,
  ...rest,
];
const d = async (...a) =>
  (await exec(docker, a, { env, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const c = (project, ...a) => d(...args(project, ...a));
let agent = new Agent({ ca: await readFile(caPath) });
function call(path, body) {
  return new Promise((resolve, reject) => {
    const r = request(
      url + path,
      {
        agent,
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: cookie,
          ...(body ? { Origin: url, 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const b = [];
        res.on('data', (v) => b.push(v));
        res.on('end', () => {
          const text = Buffer.concat(b).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
async function transfer(project, mode, file) {
  const child = spawn(
    docker,
    args(project, 'run', '--rm', '--no-deps', '-T', 'maintenance', mode),
    {
      env,
      stdio: [
        mode === 'restore' ? file.fd : 'ignore',
        mode === 'backup' ? file.fd : 'ignore',
        'pipe',
      ],
    },
  );
  let errors = '';
  child.stderr.on('data', (b) => {
    errors += b;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  return { code, errors };
}
let originalStopped = false;
const report = { checkedAt: new Date().toISOString(), checks: [] };
try {
  const added = await call('/api/command', {
    action: 'file.add',
    payload: {
      name: 'hosting-backup.txt',
      mime: 'text/plain',
      text: 'Original hosting backup bytes. Keep this file through restore.',
    },
  });
  assert.equal(added.status, 200);
  const fileId = added.json.result.id;
  const before = (await call('/api/state')).json;
  assert.ok(before.profile);
  const archive = join(directory, 'workspace-backup.tar.gz');
  await c(project, 'stop', 'app');
  originalStopped = true;
  const out = await open(archive, 'wx', 0o600);
  try {
    const result = await transfer(project, 'backup', out);
    assert.equal(result.code, 0, result.errors);
  } finally {
    await out.close();
  }
  report.archiveSha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await c(project, 'start', 'app');
  originalStopped = false;
  report.checks.push('Stopped app produces a private archive containing both data and keys');
  // Reusing a populated workspace must fail before consuming or extracting bytes.
  const rejected = await open(archive, 'r');
  try {
    const result = await transfer(project, 'restore', rejected);
    assert.notEqual(result.code, 0);
    assert.match(result.errors, /requires empty/);
  } finally {
    await rejected.close();
  }
  report.checks.push('Restore refuses populated volumes without changing the existing workspace');
  const input = await open(archive, 'r');
  try {
    const result = await transfer(restored, 'restore', input);
    assert.equal(result.code, 0, result.errors);
  } finally {
    await input.close();
  }
  await c(project, 'stop', 'https');
  await c(restored, 'up', '-d', '--wait', '--wait-timeout', '180');
  const httpsId = await c(restored, 'ps', '-q', 'https'),
    restoredCa = join(directory, 'restore-ca.crt');
  await d('cp', `${httpsId}:/data/caddy/pki/authorities/local/root.crt`, restoredCa);
  agent.destroy();
  agent = new Agent({ ca: await readFile(restoredCa) });
  const response = await call('/api/state');
  assert.equal(response.status, 200);
  const after = response.json;
  for (const field of ['profile', 'messages', 'files', 'threads', 'routines'])
    assert.deepEqual(after[field], before[field], `Restored ${field}`);
  const file = await call(`/api/files/${fileId}`);
  assert.equal(file.status, 200);
  assert.equal(file.text, 'Original hosting backup bytes. Keep this file through restore.');
  assert.equal(
    (await c(restored, 'run', '--rm', '--no-deps', '-T', 'setup', '--show-access-key')).trim(),
    key,
  );
  const appId = await c(restored, 'ps', '-q', 'app');
  assert.equal(
    await d('exec', appId, 'node', '--input-type=module', '-e', credentialProbe),
    await readFile(join(directory, 'expected-credential'), 'utf8'),
  );
  report.checks.push(
    'Fresh Linux volumes restore the identical profile, messages, threads, routines and file bytes',
  );
  report.checks.push(
    'Original HTTPS session and owner key still work; restored vault decrypts the saved model credential',
  );
  report.passed = true;
  console.log('PASS full Linux backup and fresh-volume restore');
} finally {
  agent.destroy();
  await c(restored, 'down', '--volumes', '--remove-orphans').catch(() => {});
  if (originalStopped) await c(project, 'start', 'app');
  await c(project, 'start', 'https');
  await writeFile(
    resolve('../relay-evidence/hosting-restore-acceptance.json'),
    JSON.stringify(report, null, 2),
  );
}
