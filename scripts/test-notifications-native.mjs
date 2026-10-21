// SPDX-License-Identifier: MIT
// Real iOS Simulator push delivery, system tap, Capacitor event and HTTP workspace routing.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { Notifications } from '../server/notifications.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
const device = process.env.RELAY_NOTIFICATION_TEST_DEVICE;
if (!device)
  throw Error('Choose an isolated iPhone Simulator using RELAY_NOTIFICATION_TEST_DEVICE.');
const directory = await mkdtemp(join(tmpdir(), 'relay-native-push-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await assistantsFixture(directory, {
  configure(store, services) {
    services.notifications = new Notifications(store, {
      key: modelVaultKey(directory),
      providers: {
        status: () => ({ ios: true, desktop: true }),
        send: async () => {
          throw Error('Simulator-only fixture does not send to APNs.');
        },
      },
    });
  },
});
const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Our weekend' }));
let delivered = 0;
const control = createServer(async (req, res) => {
  if (req.url !== '/ready') {
    res.writeHead(404).end();
    return;
  }
  try {
    const m = f.store.mutate((s) =>
      appendAssistant(s, side.id, { text: 'Your Sunday plan is ready.', cards: [] }),
    );
    const payload = {
      aps: { alert: { title: 'Relay', body: 'Your Sunday plan is ready.' }, sound: 'default' },
      relayWorkspace: f.services.notifications.workspaceId,
      relayNotice: `message:${m.id}`,
    };
    const file = join(directory, 'notification.apns');
    await writeFile(file, JSON.stringify(payload));
    await promisify(execFile)('xcrun', ['simctl', 'push', device, 'org.relay.assistant', file]);
    delivered++;
    res.writeHead(200).end('ok');
  } catch (e) {
    console.error(e.message);
    res.writeHead(500).end('Push failed.');
  }
});
control.listen(0, '127.0.0.1');
await once(control, 'listening');
const stamp = Date.now(),
  bundle = resolve(`../../work/notifications-native-${stamp}.xcresult`),
  log = resolve(`../../work/notifications-native-${stamp}.log`);
console.log(JSON.stringify({ bundle, log, server: f.url }));
try {
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'NotificationsAcceptance',
      '-only-testing:RelayShareUITests/NotificationsUITests',
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
      `RELAY_NOTIFICATION_TEST_SERVER=${f.url}`,
      `RELAY_NOTIFICATION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
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
  assert.equal(code, 0, `Inspect native push test log: ${log}`);
  assert.equal(delivered, 2);
  assert.equal(
    f.store.read().threads.find((t) => t.id === 'main').draft,
    'Keep my native notification draft',
  );
  assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 0);
  await writeFile(
    join(evidence, 'notifications-ios-native-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        passed: true,
        checks: [
          'actual iOS permission and Simulator notification',
          'system taps open exact side chat through Capacitor from background and full termination',
          'Main draft retained after routing and process restart',
          'no incidental messages',
        ],
        limits:
          'Simulator injection via simctl. No physical-device, APNs provider delivery, App Store signing or Android runtime claim.',
      },
      null,
      2,
    ),
  );
  console.log('PASS native iOS notification tap and saved draft');
} finally {
  control.closeAllConnections();
  await new Promise((r) => control.close(r));
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
