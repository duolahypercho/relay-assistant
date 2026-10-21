// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-priority-computer-'));
let computer,
  releaseOwner,
  backgroundCalls = 0;
const owner = new Promise((r) => {
  releaseOwner = r;
});
const call = (id, cmd) => ({
  id,
  type: 'function',
  function: {
    name: 'computer_run',
    arguments: JSON.stringify({ operationId: id, command: cmd, cwd: '/workspace', seconds: 20 }),
  },
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
  async respond(body) {
    if (body.messages.some((m) => m.role === 'user' && m.content === 'Answer me first.')) {
      await owner;
      return { role: 'assistant', content: 'Here is your direct reply.' };
    }
    backgroundCalls++;
    if (backgroundCalls === 1)
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          call('kept', "printf 'saved before pause\\n' > /workspace/kept.txt; sleep 2"),
          call('old-plan', "printf 'stale' > /workspace/stale.txt"),
        ],
      };
    if (backgroundCalls === 2) {
      assert.match(
        body.messages.find((m) => m.tool_call_id === 'old-plan').content,
        /Not executed/,
      );
      assert(
        body.messages.some((m) => m.content?.includes('Previous screen observations are stale')),
      );
      assert(body.messages.some((m) => m.tool_call_id === 'kept'));
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          call(
            'resumed',
            "cat /workspace/kept.txt; printf 'continued once\\n' >> /workspace/kept.txt",
          ),
        ],
      };
    }
    assert.equal(backgroundCalls, 3);
    return { role: 'assistant', content: 'Finished from the saved work.' };
  },
});
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw Error('Computer priority state did not settle');
}
let result;
try {
  const background = f.store.mutate((s) => {
    const thread = command(s, 'thread.create', { title: 'Background work' });
    return command(s, 'chat.send', {
      threadId: thread.id,
      text: 'Prepare a note on the computer.',
      delivery: 'queue',
    });
  });
  await until(
    async () =>
      (await computer.dockerRun(['exec', computer.name, 'test', '-f', '/workspace/kept.txt']))
        .exitCode === 0,
  );
  const sentAt = Date.now();
  const direct = f.store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Answer me first.', delivery: 'now' }),
  );
  await until(() => f.requests.length === 2);
  const foregroundMilliseconds = Date.now() - sentAt;
  assert(foregroundMilliseconds < 1500);
  await until(() => f.store.read().runs.find((r) => r.id === background.id).waitingForReply);
  assert.equal(backgroundCalls, 1);
  assert.equal(
    (await computer.dockerRun(['exec', computer.name, 'test', '-f', '/workspace/stale.txt']))
      .exitCode,
    1,
  );
  releaseOwner();
  await until(() => f.store.read().runs.every((r) => r.status === 'completed'));
  const bytes = Buffer.from(
    (await computer.read('/workspace/kept.txt')).base64,
    'base64',
  ).toString();
  assert.equal(bytes, 'saved before pause\ncontinued once\n');
  await assert.rejects(() => computer.read('/workspace/stale.txt'));
  const receipts = computer.receipts();
  assert.equal(receipts.length, 2);
  assert(receipts.every((r) => r.status === 'completed' && r.actor === 'agent'));
  assert.equal(f.requests.length, 4);
  assert.equal(
    f.store.read().messages.find((m) => m.replyTo === direct.messageId).text,
    'Here is your direct reply.',
  );
  result = {
    checkedAt: new Date().toISOString(),
    passed: true,
    foregroundMilliseconds,
    modelCalls: f.requests.length,
    savedBytes: bytes,
    computer: computer.name,
    checks: [
      'direct reply model starts during a real running background shell',
      'current shell finishes and its durable result is retained',
      'next stale computer action waits and is discarded after the pause',
      'replanned work resumes once from the saved bytes',
    ],
    scope: 'Actual isolated Docker/Colima processes with controlled HTTP model decisions.',
  };
} finally {
  releaseOwner();
  await f.worker.stop();
  await computer.stop();
  await computer.checked(['rm', computer.name]);
  await computer.checked(['volume', 'rm', computer.volume, computer.displayVolume]);
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
result.fixtureContainerAndVolumesRemoved = true;
await writeFile(
  resolve('../relay-evidence/work-priority-real-computer.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  `PASS: direct model started in ${result.foregroundMilliseconds} ms; actual computer work resumed once`,
);
