// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { linuxListeningBundle } from '../server/local-listening-bundle.mjs';
import { listeningLinuxSource, listeningRelease } from '../server/local-listening-artifacts.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, arch = 'arm64') {
  const directory = await mkdtemp(join(tmpdir(), 'relay-listening-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(100);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  const manifest = {
    version: listeningLinuxSource.version,
    platform: 'linux',
    arch,
    sourceSha256: listeningLinuxSource.sha256,
    helperBytes: bytes.length,
    helperSha256: hash(bytes),
  };
  await writeFile(join(directory, 'transcribe'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, bytes, manifest, options: { directory, arch } };
}
test('Linux runtime availability requires the pinned source, bounded manifest and matching ELF architecture', async (t) => {
  for (const arch of ['arm64', 'x64']) {
    const f = await fixture(t, arch),
      bundle = linuxListeningBundle(f.options);
    assert.ok(bundle);
    assert.equal(bundle.artifact.embedded, true);
    assert.deepEqual(bundle.artifact.artifacts, [listeningRelease.artifacts[1]]);
    assert.match(bundle.artifact.version, new RegExp('linux-' + arch));
    assert.deepEqual(bundle.helper(), f.bytes);
    assert.equal(
      linuxListeningBundle({ ...f.options, arch: arch === 'arm64' ? 'x64' : 'arm64' }),
      null,
    );
    for (const [key, value] of [
      ['version', 'future'],
      ['sourceSha256', '0'.repeat(64)],
      ['helperBytes', 101],
      ['helperSha256', '0'.repeat(64)],
      ['platform', 'darwin'],
    ]) {
      await writeFile(
        join(f.directory, 'manifest.json'),
        JSON.stringify({ ...f.manifest, [key]: value }),
      );
      assert.equal(linuxListeningBundle(f.options), null, key);
    }
    await writeFile(join(f.directory, 'manifest.json'), ' '.repeat(2049));
    assert.equal(linuxListeningBundle(f.options), null);
  }
});
test('missing, corrupted, symlinked and non-ELF bundles stay unavailable without startup errors', async (t) => {
  const f = await fixture(t);
  assert.equal(linuxListeningBundle({ ...f.options, arch: 'riscv64' }), null);
  const file = join(f.directory, 'transcribe');
  await writeFile(file, Buffer.alloc(f.bytes.length));
  assert.equal(linuxListeningBundle(f.options), null);
  await rm(file);
  assert.equal(linuxListeningBundle(f.options), null);
  const target = join(f.directory, 'other');
  await writeFile(target, f.bytes);
  await symlink(target, file);
  assert.equal(linuxListeningBundle(f.options), null);
  await rm(file);
  await writeFile(file, f.bytes);
  const manifest = join(f.directory, 'manifest.json'),
    saved = join(f.directory, 'other-manifest');
  await writeFile(saved, await readFile(manifest));
  await rm(manifest);
  await symlink(saved, manifest);
  assert.equal(linuxListeningBundle(f.options), null);
});
