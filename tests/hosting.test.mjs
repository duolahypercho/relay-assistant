// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, readdir, symlink, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentSecret } from '../server/deployment-secret.mjs';
import { initializeHostingSecrets } from '../server/hosting-setup.mjs';
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-hosting-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('deployment secrets retain local environment support and reject ambiguous configuration', () => {
  assert.equal(deploymentSecret('KEY', {}), '');
  assert.equal(deploymentSecret('KEY', { KEY: 'direct' }), 'direct');
  assert.throws(() => deploymentSecret('KEY', { KEY: 'secret', KEY_FILE: '/secret' }), /not both/);
  assert.throws(() => deploymentSecret('KEY', { KEY_FILE: '../secret' }), /absolute/);
});
test('mounted secrets accept a single trailing newline and projected secret symlinks', async (t) => {
  const root = await directory(t),
    file = join(root, 'secret'),
    link = join(root, 'projected');
  await symlink(file, link);
  for (const suffix of ['', '\n', '\r\n']) {
    await writeFile(file, 'keep-this-secret' + suffix);
    assert.equal(deploymentSecret('KEY', { KEY_FILE: file }), 'keep-this-secret');
    assert.equal(deploymentSecret('KEY', { KEY_FILE: link }), 'keep-this-secret');
  }
});
test('mounted secrets reject invalid or unbounded content without printing secrets or private paths', async (t) => {
  const root = await directory(t),
    file = join(root, 'private-secret-path');
  for (const bytes of [
    '',
    '\n',
    'secret\nsecond-line',
    'secret\0value',
    'secret\tvalue',
    'a'.repeat(8193),
    Buffer.from([0xff]),
  ]) {
    await writeFile(file, bytes);
    assert.throws(
      () => deploymentSecret('KEY', { KEY_FILE: file }),
      (error) => {
        assert.equal(error.message, 'KEY_FILE could not be read as a bounded, single-line secret.');
        assert.ok(!error.message.includes(file));
        return true;
      },
    );
  }
  await writeFile(file, 'a'.repeat(8192));
  assert.equal(deploymentSecret('KEY', { KEY_FILE: file }).length, 8192);
  for (const path of [root, join(root, 'missing')])
    assert.throws(() => deploymentSecret('KEY', { KEY_FILE: path }), /bounded, single-line/);
});
test(
  'a mistakenly mounted FIFO fails immediately instead of hanging startup',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await directory(t),
      fifo = join(root, 'fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.throws(() => deploymentSecret('KEY', { KEY_FILE: fifo }), /bounded, single-line/);
  },
);
test('hosting setup creates a private durable pair, then preserves both keys on every restart', async (t) => {
  const root = join(await directory(t), 'keys');
  const first = await initializeHostingSecrets(root);
  const files = ['access-key', 'token-key'].map((name) => join(root, 'current', name));
  const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  assert.equal(first.created, true);
  assert.match(first.accessKey, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(before[1].trim(), 'base64').length, 32);
  for (const file of files) assert.equal((await stat(file)).mode & 0o777, 0o400);
  for (const path of [root, join(root, 'current')])
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.deepEqual(await initializeHostingSecrets(root), {
    created: false,
    accessKey: first.accessKey,
  });
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), before);
  assert.deepEqual(await readdir(root), ['current']);
});
test('concurrent setup processes converge on one complete pair and remove their temporary keys', async (t) => {
  const root = join(await directory(t), 'keys');
  const results = await Promise.all(
    Array.from({ length: 12 }, () => initializeHostingSecrets(root)),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.accessKey)).size, 1);
  assert.deepEqual(await readdir(root), ['current']);
});
test('damaged existing keys fail closed without replacing an owner key', async (t) => {
  const root = join(await directory(t), 'keys');
  await initializeHostingSecrets(root);
  const access = join(root, 'current/access-key'),
    token = join(root, 'current/token-key');
  const before = await readFile(access);
  await chmod(token, 0o600);
  await writeFile(token, 'broken');
  await assert.rejects(initializeHostingSecrets(root), /Invalid hosting keys/);
  assert.deepEqual(await readFile(access), before);
  assert.equal(await readFile(token, 'utf8'), 'broken');
  await rm(token);
  await assert.rejects(initializeHostingSecrets(root));
  assert.deepEqual(await readFile(access), before);
});
test('setup refuses symlinked directories and key files', async (t) => {
  const base = await directory(t),
    root = join(base, 'keys'),
    alias = join(base, 'alias');
  await initializeHostingSecrets(root);
  await symlink(root, alias);
  await assert.rejects(initializeHostingSecrets(alias), /real directory/);
  const token = join(root, 'current/token-key'),
    saved = join(base, 'saved-key');
  await writeFile(saved, await readFile(token));
  await rm(token);
  await symlink(saved, token);
  await assert.rejects(initializeHostingSecrets(root), /Invalid hosting keys/);
});
