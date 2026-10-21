// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readlink, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const modulePath = resolve('server/computer-backup-guest.py');
const script = `import importlib.util,sys,json
spec=importlib.util.spec_from_file_location('backup',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
if sys.argv[2]=='pack':m.pack(sys.argv[3],sys.stdout.buffer)
else:print(json.dumps(m.unpack(sys.argv[3],sys.stdin.buffer)))`;
function run(kind, root, input) {
  return spawnSync('python3', ['-B', '-c', script, modulePath, kind, root], {
    input,
    maxBuffer: 3 * 1024 ** 2,
  });
}
function record(entry, bytes = Buffer.alloc(0)) {
  const data = Buffer.from(JSON.stringify(entry)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data, bytes]);
}
test('workspace format preserves saved binary files, Unicode paths, executable mode, directories and links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-backup-format-'));
  try {
    const source = join(root, 'source'),
      target = join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await mkdir(join(source, '空 folder'));
    await writeFile(join(source, '空 folder', 'line\nname'), Buffer.from([0, 255, 1, 2]));
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o751 });
    await symlink('空 folder/line\nname', join(source, 'link'));
    await symlink('/outside', join(source, 'external'));
    const packed = run('pack', source);
    assert.equal(packed.status, 0, packed.stderr.toString());
    const restored = run('unpack', target, packed.stdout);
    assert.equal(restored.status, 0, restored.stderr.toString());
    assert.deepEqual(
      await readFile(join(target, '空 folder', 'line\nname')),
      Buffer.from([0, 255, 1, 2]),
    );
    assert.equal((await stat(join(target, 'run.sh'))).mode & 0o777, 0o751);
    assert.equal(await readlink(join(target, 'external')), '/outside');
    assert.notEqual(run('unpack', target, packed.stdout).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('malicious paths, link traversal, duplicate records, special entries, oversized files and trailing bytes are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-backup-malformed-'));
  const file = (path) => ({ path, kind: 'file', mode: 0o600, size: 1 });
  const end = record({ end: true, files: 1, bytes: 1 });
  const cases = [
    ...['../escape', '/absolute', 'a/../escape', './escape', 'a//b'].map((path) =>
      Buffer.concat([record(file(path), Buffer.from('x')), end]),
    ),
    Buffer.concat([
      record({ path: 'link', kind: 'link', mode: 0o777, target: root }),
      record(file('link/escape'), Buffer.from('x')),
    ]),
    Buffer.concat([
      record(file('duplicate'), Buffer.from('x')),
      record(file('duplicate'), Buffer.from('x')),
    ]),
    record({ path: 'device', kind: 'device', mode: 0o600 }),
    record({ ...file('huge'), size: 8589934593 }),
    Buffer.concat([record(file('okay'), Buffer.from('x')), end, Buffer.from('extra')]),
    record({ ...file('privileged'), mode: 0o4755 }),
    record(file('short')),
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      const target = join(root, String(i));
      await mkdir(target);
      assert.notEqual(run('unpack', target, cases[i]).status, 0, `case ${i}`);
    }
    await assert.rejects(readFile(join(root, 'escape')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
