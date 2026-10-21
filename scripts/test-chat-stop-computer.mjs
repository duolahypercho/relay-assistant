// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-chat-stop-computer-'));
let computer;
const call = (name, id, arguments_) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(arguments_) },
});
const f = await assistantsFixture(directory, {
  async configure(store, services) {
    computer = services.computer = new PrivateComputer(store, {
      enabled: true,
      deployment: directory,
      dockerHost: process.env.DOCKER_HOST || `unix://${homedir()}/.colima/relay/docker.sock`,
    });
    await computer.start();
    console.log(JSON.stringify({ fixtureComputer: computer.name, fixtureOwner: computer.owner }));
  },
  respond(body) {
    const text = body.messages.findLast((m) => m.role === 'user')?.content;
    if (text === 'Start background work.')
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          call('computer_job_start', 'detached', {
            operationId: 'detached',
            title: 'Background work',
            command:
              "printf 'background ready\\n'; sleep 90; printf 'late' > /workspace/background-late.txt",
            cwd: '/workspace',
            seconds: 120,
          }),
        ],
      };
    if (text === 'Run foreground work too.')
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          call('computer_run', 'foreground', {
            operationId: 'foreground',
            command:
              "printf 'saved before stop\\n' > /workspace/kept.txt; sleep 45; printf 'late' > /workspace/foreground-late.txt",
            cwd: '/workspace',
            seconds: 60,
          }),
          call('remember', 'stale-memory', { text: 'Do not save this stopped plan.' }),
        ],
      };
    throw Error('Stop or unrelated work reached the fixture model.');
  },
});
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw Error('Computer stop did not finish');
}
async function send(text) {
  const response = await fetch(f.url + '/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: f.url },
    body: JSON.stringify({
      action: 'chat.send',
      payload: { threadId: 'main', text, delivery: 'now' },
    }),
  });
  assert(response.ok, await response.clone().text());
  return response.json();
}
try {
  await send('Start background work.');
  await until(() => f.store.read().runs[0]?.status === 'completed');
  const targetJob = computer.jobs.rows().find((j) => j.threadId === 'main');
  assert(targetJob);
  const unrelated = f.store.mutate((s) => {
    const thread = command(s, 'thread.create', { title: 'Separate work' });
    thread.queuePaused = true;
    return command(s, 'chat.send', { threadId: thread.id, text: 'An unrelated background task.' });
  });
  const otherJob = await computer.jobs.start(
    { operationId: 'other', title: 'Unrelated work', command: 'sleep 90', seconds: 120 },
    { runId: unrelated.id },
  );
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === unrelated.id).status = 'completed';
  });
  await send('Run foreground work too.');
  // Observe the independent fixture volume while the normal computer RPC is busy.
  await until(async () => {
    try {
      const result = await computer.dockerRun([
        'exec',
        computer.name,
        'test',
        '-f',
        '/workspace/kept.txt',
      ]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  });
  const started = Date.now(),
    stopped = await send('Stop now');
  await until(
    () =>
      f.store.read().messages.find((m) => m.id === stopped.result.stopControlId)?.stopControl
        .status === 'completed',
  );
  const elapsed = Date.now() - started;
  assert(elapsed < 12000, `Stop took ${elapsed} ms`);
  await computer.jobs.poll(new AbortController().signal);
  assert.equal(computer.jobs.get(targetJob.id).status, 'cancelled');
  assert.equal(computer.jobs.get(otherJob.id).status, 'running');
  assert.equal(f.requests.length, 2);
  assert.equal(f.store.read().memories.length, 0);
  assert.equal(
    f.store.read().runs.filter((r) => r.threadId === 'main' && r.status === 'cancelled').length,
    1,
  );
  const kept = Buffer.from(
    (await computer.read('/workspace/kept.txt')).base64,
    'base64',
  ).toString();
  assert.equal(kept, 'saved before stop\n');
  await assert.rejects(() => computer.read('/workspace/foreground-late.txt'));
  await assert.rejects(() => computer.read('/workspace/background-late.txt'));
  assert(computer.receipts().some((r) => r.status === 'interrupted'));
  await writeFile(
    resolve('../relay-evidence/chat-stop-real-computer.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        stopMilliseconds: elapsed,
        modelCalls: f.requests.length,
        keptBytes: kept,
        targetJobStatus: computer.jobs.get(targetJob.id).status,
        unrelatedJobStatus: computer.jobs.get(otherJob.id).status,
        checks: [
          'actual foreground shell interrupted before its late write',
          'actual detached job stopped without relaunch or continuation',
          'unrelated conversation job stays running',
          'partial files retained and stale next tool never executes',
        ],
        scope: 'Actual isolated Docker/Colima processes with controlled HTTP model decisions.',
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: foreground and detached job stopped in ${elapsed} ms; unrelated job and saved bytes retained`,
  );
} finally {
  await f.worker.stop();
  await computer.stop();
  await computer.checked(['rm', computer.name]);
  await computer.checked(['volume', 'rm', computer.volume, computer.displayVolume]);
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
