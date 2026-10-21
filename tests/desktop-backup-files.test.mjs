// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBackupFiles } from '../native/desktop/backup-files.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-backup-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = new DesktopBackupFiles(root),
    { id } = await stage.begin();
  const chunk = Buffer.alloc(1024 * 1024, 45);
  chunk.write('RELAY-COMPUTER-1');
  return { root, stage, id, chunk };
}
test('native backup saving streams beyond the old 8 MB limit and atomically writes exact bytes to the chosen path', async (t) => {
  const f = await fixture(t),
    path = join(f.root, 'chosen.relaybackup');
  for (let i = 0; i < 12; i++)
    await f.stage.append({
      id: f.id,
      offset: i * f.chunk.length,
      base64: f.chunk.toString('base64'),
    });
  await writeFile(path, 'previous explicitly chosen destination');
  assert.deepEqual(await f.stage.save({ id: f.id, size: 12 * f.chunk.length }, async () => path), {
    status: 'saved',
  });
  assert.deepEqual(await readFile(path), Buffer.concat(Array(12).fill(f.chunk)));
  assert.deepEqual(await readdir(f.root), ['chosen.relaybackup']);
});
test('wrong IDs, out-of-order chunks, invalid headers and incomplete saves cannot write a destination', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.stage.append({ id: 'other', offset: 0, base64: f.chunk.toString('base64') }),
    /expired/,
  );
  await assert.rejects(
    f.stage.append({ id: f.id, offset: 0, base64: Buffer.alloc(60).toString('base64') }),
    /complete/,
  );
  await f.stage.append({ id: f.id, offset: 0, base64: f.chunk.toString('base64') });
  await assert.rejects(
    f.stage.append({ id: f.id, offset: 0, base64: f.chunk.toString('base64') }),
    /order/,
  );
  await assert.rejects(
    f.stage.save({ id: f.id, size: 20 }, async () => assert.fail()),
    /complete/,
  );
  assert.deepEqual(await f.stage.save({ id: f.id, size: f.chunk.length }, async () => null), {
    status: 'cancelled',
  });
  assert.deepEqual(await readdir(f.root), []);
});
test('cancel and failed system destination clean encrypted temporary files', async (t) => {
  const f = await fixture(t);
  await f.stage.cancel({ id: f.id });
  assert.deepEqual(await readdir(f.root), []);
  const { id } = await f.stage.begin();
  await f.stage.append({ id, offset: 0, base64: f.chunk.toString('base64') });
  await assert.rejects(
    f.stage.save({ id, size: f.chunk.length }, async () => join(f.root, 'missing', 'file')),
    /ENOENT/,
  );
  assert.deepEqual(await readdir(f.root), []);
});
test('closing the desktop window abandons pending native save without writing a chosen destination', async (t) => {
  const f = await fixture(t);
  await f.stage.append({ id: f.id, offset: 0, base64: f.chunk.toString('base64') });
  let choose;
  const saving = f.stage.save(
    { id: f.id, size: f.chunk.length },
    () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
  );
  while (!choose) await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = f.stage.abandon();
  await assert.rejects(f.stage.begin(), /Finish/);
  choose(join(f.root, 'not-saved.relaybackup'));
  assert.deepEqual(await saving, { status: 'cancelled' });
  await closing;
  assert.deepEqual(await readdir(f.root), []);
});
