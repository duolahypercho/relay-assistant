// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { remoteComputerFixture } from './remote-computer-fixture.mjs';
import {
  freezeProbe,
  checkRemoteTLS,
  checkRemoteFeatures,
  checkRemoteStdio,
} from './remote-computer-checks.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let f;
const report = { startedAt: new Date().toISOString(), checks: [] };
try {
  f = await remoteComputerFixture();
  await checkRemoteTLS(f, report);
  const initial = await f.json('/api/state');
  assert.equal(initial.messages.length, 0);
  assert.equal((await f.json('/api/computer')).state, 'stopped');
  const start = Date.now();
  await f.json('/api/computer/start', { method: 'POST', body: {} });
  assert.equal((await f.json('/api/computer')).state, 'running');
  report.startMs = Date.now() - start;
  const screen = await f.json('/api/computer/screen');
  const pixels = Buffer.from(screen.screenshot, 'base64');
  assert.ok(pixels.length > 8000);
  assert.equal(pixels.subarray(0, 2).toString('hex'), 'ffd8');
  await writeFile(resolve(evidence, 'remote-computer-live-frame.jpg'), pixels);
  const appNames = await f.d('app', ['ps', '-a', '--format', '{{.Names}}']);
  const guestNames = await f.d('guest', ['ps', '-a', '--format', '{{.Names}}']);
  assert.ok(!appNames.includes(f.computerName));
  assert.ok(guestNames.includes(f.computerName));
  const appId = await f.compose('ps', '-q', 'app');
  const app = JSON.parse(await f.d('app', ['inspect', appId]))[0];
  assert.ok(app.Mounts.every((m) => m.Type === 'volume'));
  assert.ok(!app.Mounts.some((m) => /docker\.sock|\/workspace/.test(m.Destination)));
  const computer = JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0];
  assert.equal(computer.HostConfig.NetworkMode, 'none');
  assert.equal(computer.Config.User, '1000:1000');
  assert.equal(computer.HostConfig.ReadonlyRootfs, true);
  assert.equal(computer.HostConfig.Privileged, false);
  assert.ok(computer.Mounts.every((m) => m.Type === 'volume'));
  assert.ok(!computer.Config.Env.some((v) => /CERT|SECRET|PRIVATE_KEY|RELAY_MODEL/.test(v)));
  report.checks.push(
    'Actual Linux app and computer run on different engines; screenshot crosses mutual TLS, with no application-host socket or guest host bind',
  );
  await f.json('/api/computer/takeControl', { method: 'POST', body: {} });
  const action = {
    kind: 'exec',
    operationId: 'remote-owner-file',
    command: "printf 'Owner note' > /workspace/owner-note.txt",
    seconds: 10,
  };
  assert.equal(
    (await f.json('/api/computer/action', { method: 'POST', body: action })).exitCode,
    0,
  );
  assert.equal(
    (await f.json('/api/computer/action', { method: 'POST', body: action })).repeated,
    true,
  );
  await f.json('/api/computer/action', {
    method: 'POST',
    body: {
      kind: 'files',
      action: 'write',
      path: 'freeze-probe.py',
      base64: Buffer.from(freezeProbe).toString('base64'),
      operationId: 'freeze-probe-source',
    },
  });
  await f.json('/api/computer/release', { method: 'POST', body: {} });
  await f.json('/api/command', {
    method: 'POST',
    body: {
      action: 'chat.send',
      payload: {
        threadId: 'main',
        text: 'Make a file on your separate computer and give it to me.',
        delivery: 'now',
      },
    },
  });
  await f.until(
    async () => {
      const s = await f.json('/api/state');
      return s.runs.length && s.runs.every((r) => !['queued', 'running'].includes(r.status));
    },
    'Remote assistant work',
    90000,
  );
  const state = await f.json('/api/state');
  assert.equal(state.messages.at(-1).text, 'I made the file on my separate computer.');
  const file = state.files.find((v) => v.name === 'remote-result.txt');
  assert.ok(file);
  const download = await f.call('/api/files/' + file.id);
  assert.equal(download.status, 200);
  assert.equal(download.text, 'Made on the separate computer.\n');
  assert.equal(state.files.filter((v) => v.name === 'remote-result.txt').length, 1);
  report.checks.push(
    'Owner command receipt executes once; the agent receives the real remote screen, runs a guest command and exports actual file bytes through chat',
  );

  await f.json('/api/computer/takeControl', { method: 'POST', body: {} });
  await checkRemoteFeatures(f, report);
  const oldId = JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id;
  await f.json('/api/command', {
    method: 'POST',
    body: {
      action: 'thread.update',
      payload: { id: 'main', draft: 'Keep my remote computer draft.' },
    },
  });
  await f.restart();
  assert.equal((await f.json('/api/computer')).controller, 'owner');
  assert.equal(JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id, oldId);
  const after = await f.json('/api/state');
  assert.equal(after.threads[0].draft, 'Keep my remote computer draft.');
  assert.deepEqual(after.messages, state.messages);
  assert.ok(!JSON.stringify(await f.json('/api/export')).includes('BEGIN PRIVATE KEY'));
  report.checks.push(
    'Actual app-container replacement preserves remote desktop identity, owner control, messages and unsent draft; export excludes client keys',
  );
  await checkRemoteStdio(f, report);
  report.passed = true;
  console.log('PASS two-VM remote computer runtime, TLS, agent file export and app replacement');
} catch (error) {
  report.error = error.stack;
  if (f)
    await writeFile(
      resolve(evidence, 'remote-computer-runtime-failure.log'),
      await f.compose('logs', '--no-color', '--tail=80', 'app', 'provider').catch(() => ''),
    );
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(evidence, 'remote-computer-runtime-acceptance.json'),
    JSON.stringify(report, null, 2),
  );
  await f?.close();
}
