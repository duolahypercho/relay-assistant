// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { legacyReplyPrefix, patchLegacyReply } from '../scripts/patch-android-bridge.mjs';

test('a late native reply is discarded after its document bridge has gone away', () => {
  for (const window of [{}, { Capacitor: null }, { Capacitor: {} }])
    assert.doesNotThrow(() =>
      runInNewContext(`${legacyReplyPrefix}{"callbackId":"old"})`, { window }),
    );
});

test('a live document still receives exactly the native callback payload', () => {
  const received = [];
  const data = { callbackId: 'current', success: true, data: { text: 'water "quoted" 原文' } };
  runInNewContext(`${legacyReplyPrefix}${JSON.stringify(data)})`, {
    window: {
      Capacitor: { fromNative: (value) => received.push(JSON.parse(JSON.stringify(value))) },
    },
  });
  assert.deepEqual(received, [data]);
});

test('the versioned native source patch changes only its exact reply and is idempotent', () => {
  const line = 'final String runScript = "window.Capacitor.fromNative(" + data.toString() + ")";';
  const source = `// before\n${line}\n// after`;
  const patched = patchLegacyReply(source, '8.5.3');
  assert.equal(
    patched,
    `// before\nfinal String runScript = "${legacyReplyPrefix}" + data.toString() + ")";\n// after`,
  );
  assert.equal(patchLegacyReply(patched, '8.5.3'), patched);
  assert.throws(() => patchLegacyReply(source, '8.6.0'), /Review/);
  assert.throws(() => patchLegacyReply(source + line, '8.5.3'), /Unexpected/);
  assert.throws(() => patchLegacyReply('different implementation', '8.5.3'), /Unexpected/);
});
