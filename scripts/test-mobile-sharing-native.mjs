// SPDX-License-Identifier: MIT
// Real iOS system Share sheet + extension + Capacitor inbox + Relay HTTP server.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
const device = process.env.RELAY_SHARE_TEST_DEVICE;
if (!device)
  throw Error('Set RELAY_SHARE_TEST_DEVICE to an isolated, available iPhone Simulator ID.');
const directory = await mkdtemp(join(tmpdir(), 'relay-native-share-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await assistantsFixture(directory, {
  respond: async () => ({ role: 'assistant', content: 'Your native share arrived.' }),
});
const stamp = Date.now(),
  bundle = resolve(`../../work/shares-native-${stamp}.xcresult`),
  log = resolve(`../../work/shares-native-${stamp}.log`);
console.log(JSON.stringify({ bundle, log, server: f.url }));
try {
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ShareAcceptance',
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-test-timeouts-enabled',
      'YES',
      '-default-test-execution-time-allowance',
      '120',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
      `RELAY_SHARE_TEST_SERVER=${f.url}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = createWriteStream(log);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `Native share acceptance failed; inspect ${log}`);
  const state = f.store.read(),
    messages = state.messages.filter((m) => m.role === 'user');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'Keep my native draft');
  assert(
    messages[0].sharedTexts.some(
      (t) =>
        t.includes('A real iOS shared note') && t.includes('https://example.invalid/native-share'),
    ),
  );
  assert.equal(state.shareImports.length, 1);
  assert.equal(messages[0].fileIds.length, 2);
  const file = state.files.find((f) => f.name === 'native-share.txt');
  assert.equal(Buffer.from(file.base64, 'base64').toString(), 'Actual iOS shared file bytes.');
  assert(state.files.some((f) => f.mime.startsWith('image/')));
  assert.deepEqual(state.threads.find((t) => t.id === 'main').draftShareIds, []);
  await writeFile(
    join(evidence, 'incoming-share-ios-native-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        passed: true,
        source:
          'Debug-only deterministic source surface invokes the real iOS system Share sheet and installed Relay extension. No native bridge is mocked.',
        checks: [
          'system picker opens Relay extension',
          'native Main chat selection and Attach',
          'real text, URL, file and image item providers',
          'app-group inbox import into a real Relay server',
          'draft and attachment persistence through app termination/relaunch',
          'explicit Send posts exactly one owner message with original file bytes',
        ],
        limits:
          'iPhone Simulator. Not a physical device, Safari/Photos integration, App Store signing or Android runtime claim.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS native iOS share sheet: text, link, file, image, retained draft, relaunch and one explicit send',
  );
} finally {
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
