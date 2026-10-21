// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { BrowserVault } from '../server/browser-vault.mjs';
import { BrowserDownloads, downloadName } from '../server/browser-downloads.mjs';
function fixture(t) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const vault = new BrowserVault(store, Buffer.alloc(32, 9));
  store.db.exec(
    "CREATE TABLE trusted_browser_actions (id TEXT PRIMARY KEY, phase TEXT); INSERT INTO trusted_browser_actions VALUES ('action','running'),('other','running')",
  );
  const downloads = new BrowserDownloads(store, vault);
  const input = {
    sourceId: 'source',
    actionId: 'action',
    guard() {},
    response: {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="report.csv"',
      },
      body: Buffer.from('Item,Amount\nTea,4\n'),
    },
  };
  return { store, vault, downloads, input };
}
test('download filenames decode UTF-8, discard paths/control characters and fall back without choosing a filesystem path', () => {
  assert.equal(
    downloadName('attachment; filename="fallback.csv"; filename*=UTF-8\'\'%E8%AE%B0%E5%BD%95.csv'),
    '记录.csv',
  );
  assert.equal(
    downloadName('attachment; filename="fallback.csv"; filename*=UTF-8\'\'%ZZ', 'hint.csv'),
    'fallback.csv',
  );
  assert.equal(downloadName('attachment; filename="/private/etc/report.csv"'), 'report.csv');
  assert.equal(downloadName('', '..\\evil\u202efile.txt\n'), 'evilfile.txt');
  assert.equal(downloadName('attachment; filename=".."'), 'download');
  assert.equal(downloadName('attachment', 'x'.repeat(300)).length, 180);
});
test('completed file bytes and receipt association commit together, repeat once, omit payload from metadata, and survive service recreation', (t) => {
  const { store, vault, downloads, input } = fixture(t);
  const id = downloads.save(input);
  assert.equal(downloads.save(input), id);
  const file = store.read().files[0];
  assert.equal(file.source, 'Private browser');
  assert.deepEqual(Buffer.from(file.base64, 'base64'), input.response.body);
  assert.equal(file.size, input.response.body.length);
  assert.equal(file.text, 'Item,Amount\nTea,4\n');
  assert.deepEqual(new BrowserDownloads(store, vault).list('action'), [
    { id, name: 'report.csv', mime: 'text/csv', size: file.size },
  ]);
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().messages.length, 0);
  store.mutate((state) => {
    state.files = [];
  });
  assert.deepEqual(downloads.list(), []);
  assert.equal(downloads.save(input), id);
  assert.equal(
    store.read().files.length,
    0,
    'deleting a file does not allow a stale action to resurrect it',
  );
});
test('download body limits, partial/error/encoded responses and ambiguous headers fail before adding a file', (t) => {
  const { store, downloads, input } = fixture(t);
  for (const response of [
    { ...input.response, status: 401 },
    { ...input.response, status: 204 },
    { ...input.response, status: 206 },
    { ...input.response, headers: { 'content-range': 'bytes 0-1/9' } },
    { ...input.response, headers: { 'content-encoding': 'gzip' } },
    { ...input.response, headers: { 'content-type': ['text/csv', 'text/plain'] } },
    { ...input.response, body: Buffer.alloc(8_000_001) },
    { ...input.response, body: 'wrong' },
  ])
    assert.throws(() => downloads.save({ ...input, response }));
  assert.equal(store.read().files.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM trusted_browser_downloads').get().n, 0);
});
test('takeover, terminal action and a failed association write leave no orphaned file', (t) => {
  const { store, downloads, input } = fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      downloads.save({
        ...input,
        guard() {
          if (++calls === 2) throw Error('control changed');
        },
      }),
    /control changed/,
  );
  store.db
    .prepare("UPDATE trusted_browser_actions SET phase='interrupted' WHERE id='action'")
    .run();
  assert.throws(() => downloads.save(input), /no longer running/);
  store.db.prepare("UPDATE trusted_browser_actions SET phase='running' WHERE id='action'").run();
  store.db.exec(
    "CREATE TRIGGER reject_download BEFORE INSERT ON trusted_browser_downloads BEGIN SELECT RAISE(ABORT, 'test storage failure'); END",
  );
  assert.throws(() => downloads.save(input), /test storage failure/);
  assert.equal(store.read().files.length, 0);
});
test('per-action download count and total bytes are bounded independently', (t) => {
  const { store, downloads, input } = fixture(t);
  for (let i = 0; i < 4; i++) downloads.save({ ...input, sourceId: `small-${i}` });
  assert.throws(() => downloads.save({ ...input, sourceId: 'fifth' }), /limit/);
  downloads.save({
    ...input,
    actionId: 'other',
    sourceId: 'big',
    response: { ...input.response, body: Buffer.alloc(7_999_999) },
  });
  assert.throws(() => downloads.save({ ...input, actionId: 'other', sourceId: 'extra' }), /limit/);
  assert.equal(store.read().files.length, 5);
});
test('known credential values in names, MIME or response bytes cannot escape into Files', (t) => {
  const { store, vault, downloads, input } = fixture(t);
  const secret = 'browser-password-private';
  vault.rememberPrivate('https://account.example', secret);
  for (const response of [
    { ...input.response, body: Buffer.from(secret) },
    { ...input.response, body: Buffer.from(Buffer.from(secret).toString('base64')) },
    {
      ...input.response,
      headers: { 'content-disposition': `attachment; filename="${secret}.txt"` },
    },
    { ...input.response, headers: { 'content-type': `application/${secret}` } },
  ])
    assert.throws(() => downloads.save({ ...input, response }), /private browser value/);
  assert.equal(store.read().files.length, 0);
});

test('reopening SQLite retains exact file bytes and the completed action association', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-download-restart-'));
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const key = Buffer.alloc(32, 7);
  try {
    store.db.exec(
      "CREATE TABLE trusted_browser_actions (id TEXT PRIMARY KEY, phase TEXT); INSERT INTO trusted_browser_actions VALUES ('action','running')",
    );
    let downloads = new BrowserDownloads(store, new BrowserVault(store, key));
    const id = downloads.save({
      sourceId: 'source',
      actionId: 'action',
      guard() {},
      response: {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="bytes.bin"' },
        body: Buffer.from([0, 255, 128]),
      },
    });
    store.db
      .prepare("UPDATE trusted_browser_actions SET phase='completed' WHERE id='action'")
      .run();
    store.close();
    store = new Store(join(directory, 'state.sqlite'));
    downloads = new BrowserDownloads(store, new BrowserVault(store, key));
    assert.equal(downloads.list('action')[0].id, id);
    assert.deepEqual(
      Buffer.from(store.read().files[0].base64, 'base64'),
      Buffer.from([0, 255, 128]),
    );
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
