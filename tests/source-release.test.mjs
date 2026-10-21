// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  utimes,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as yauzl from 'yauzl';
import {
  packageSourceRelease,
  collectSourceFiles,
  validateSourceFiles,
} from '../scripts/source-release.mjs';
const required = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'source-files.json'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-source-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'relay-assistant', version: '0.1.0', type: 'module' }),
  );
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, 'LICENSE'), 'Original fixture license\n');
  await writeFile(join(root, 'README.md'), 'Original release fixture\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'main.ts'), 'export const greeting = "Hello";\n');
  await writeFile(join(root, 'src', 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const files = [...required, 'src/main.ts', 'src/run.sh'];
  const list = async (values) =>
    writeFile(join(root, 'source-files.json'), JSON.stringify({ version: 1, files: values }));
  await list(files);
  return { root, files, list, output: join(root, 'release', 'source') };
}
async function inspect(path) {
  const zip = await yauzl.fromBufferPromise(await readFile(path), {
    lazyEntries: true,
    strictFileNames: true,
  });
  const entries = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const stream = await zip.openReadStreamPromise(entry),
        chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      entries.push({
        name: entry.fileName,
        bytes: Buffer.concat(chunks),
        mode: (entry.externalFileAttributes >>> 16) & 0o777,
      });
    }
  } finally {
    zip.close();
  }
  return entries;
}

test('a source archive includes only reviewed files, complete hashes and executable modes', async (t) => {
  const f = await fixture(t);
  for (const name of ['data', '.git', 'work']) await mkdir(join(f.root, name));
  await writeFile(join(f.root, '.env'), 'PRIVATE_OWNER_SENTINEL');
  await writeFile(join(f.root, 'data', 'relay.sqlite'), 'PRIVATE_WORKSPACE_SENTINEL');
  await writeFile(join(f.root, 'src', 'unreviewed.ts'), 'UNREVIEWED_SENTINEL');
  const release = await packageSourceRelease(f.root, f.output);
  const entries = await inspect(release.archive);
  assert.equal(entries.length, f.files.length + 1);
  const manifest = JSON.parse(entries.find((e) => e.name.endsWith('/SOURCE-MANIFEST.json')).bytes);
  for (const file of manifest.files) {
    const entry = entries.find((e) => e.name === release.folder + '/' + file.path);
    assert.equal(digest(entry.bytes), file.sha256);
    assert.equal(entry.bytes.length, file.bytes);
    assert.equal(entry.mode, file.mode);
    assert.doesNotMatch(
      entry.bytes.toString(),
      /PRIVATE_OWNER_SENTINEL|PRIVATE_WORKSPACE_SENTINEL|UNREVIEWED_SENTINEL/,
    );
  }
  assert.equal(manifest.files.find((f) => f.path === 'src/run.sh').mode, 0o755);
  assert.equal(release.sha256, digest(await readFile(release.archive)));
  assert.equal((await readFile(release.checksum, 'utf8')).split('  ')[0], release.sha256);
});

test('repeated packaging ignores wall clock and mtimes, retains previous releases, and never overwrites conflicting output', async (t) => {
  const f = await fixture(t);
  const first = await packageSourceRelease(f.root, f.output);
  for (const file of f.files) await utimes(join(f.root, file), new Date(), new Date());
  const second = await packageSourceRelease(f.root, f.output);
  assert.equal(first.archive, second.archive);
  assert.equal(first.sha256, second.sha256);
  await writeFile(join(f.root, 'src/main.ts'), 'export const greeting = "Changed";');
  const changed = await packageSourceRelease(f.root, f.output);
  assert.notEqual(changed.archive, first.archive);
  assert.equal(digest(await readFile(first.archive)), first.sha256);
  await writeFile(changed.archive, 'Existing output must remain untouched.');
  await assert.rejects(packageSourceRelease(f.root, f.output), /different bytes/);
  assert.equal(await readFile(changed.archive, 'utf8'), 'Existing output must remain untouched.');
  assert.equal(
    (await readdir(f.output)).some((name) => name.startsWith('.source-')),
    false,
  );
});

test('source lists reject traversal, private/generated paths, missing requirements and platform-ambiguous duplicates', () => {
  for (const path of [
    '../private',
    '/etc/passwd',
    'src/../README.md',
    'src\\secret',
    'data/relay.sqlite',
    '.git/config',
    'src/secret.pem',
    'src/private.relaybackup',
    'src/server.env',
    'native/mobile/android/local.properties',
    'src/GoogleService-Info.plist',
    'native/mobile/ios/App/App/public/index.html',
    'native/mobile/android/app/src/main/assets/capacitor.config.json',
  ])
    assert.throws(() => validateSourceFiles({ version: 1, files: [...required, path] }));
  assert.throws(
    () => validateSourceFiles({ version: 1, files: [...required, 'src/App.ts', 'src/app.ts'] }),
    /Duplicate/,
  );
  assert.throws(() => validateSourceFiles({ version: 1, files: ['README.md'] }), /missing/);
  assert.throws(() => validateSourceFiles({ version: 2, files: required }), /version 1/);
});

test('missing files, linked files/parents and private-key material stop a source release', async (t) => {
  const f = await fixture(t);
  await f.list([...f.files, 'src/missing.ts']);
  await assert.rejects(collectSourceFiles(f.root), /ENOENT/);
  await f.list([...f.files, 'src/link.ts']);
  await symlink(join(f.root, 'README.md'), join(f.root, 'src/link.ts'));
  await assert.rejects(collectSourceFiles(f.root), /regular file/);
  await f.list([...f.files, 'docs/main.ts']);
  await symlink(join(f.root, 'src'), join(f.root, 'docs'));
  await assert.rejects(collectSourceFiles(f.root), /regular file/);
  await f.list(f.files);
  await writeFile(
    join(f.root, 'src/main.ts'),
    '-----BEGIN PRIVATE KEY-----\nSynthetic private material\n-----END PRIVATE KEY-----\n',
  );
  await assert.rejects(collectSourceFiles(f.root), /Private-key material/);
  await chmod(join(f.root, 'src/run.sh'), 0o644);
});

test('the reviewed source includes every script entrypoint advertised by package commands', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../source-files.json', import.meta.url), 'utf8'),
  );
  const files = new Set(validateSourceFiles(manifest));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const [entry] of command.matchAll(/\bscripts\/[A-Za-z0-9_.-]+\.mjs\b/g)) {
      assert(files.has(entry), `Package command ${name} references unshipped ${entry}`);
      checked++;
    }
  }
  assert(checked > 0, 'No advertised source entrypoints were checked');
});
