// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-steering-computer-'));
let computer,
  started = false,
  requests = 0;
const performed = [],
  errors = [];
const call = (id, command) => ({
  id,
  type: 'function',
  function: {
    name: 'computer_run',
    arguments: JSON.stringify({ command, cwd: '/workspace', seconds: 10, operationId: id }),
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
    const perform = computer.perform.bind(computer);
    computer.perform = async (p, ...args) => {
      performed.push(p.operationId);
      if (p.operationId === 'write-original') started = true;
      return perform(p, ...args);
    };
  },
  respond(body) {
    try {
      requests++;
      if (requests === 1)
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            call('write-original', "printf 'original\\n' >> /workspace/once.txt; sleep 2"),
            call('stale-plan', "printf 'wrong' > /workspace/stale.txt"),
          ],
        };
      const receipts = body.messages.filter((m) => m.role === 'tool');
      assert(
        receipts.some(
          (m) => m.tool_call_id === 'write-original' && JSON.parse(m.content).result.exitCode === 0,
        ),
      );
      assert.match(receipts.find((m) => m.tool_call_id === 'stale-plan').content, /Not executed/);
      assert(
        body.messages.some(
          (m) => m.role === 'user' && m.content === 'Keep the completed write. Add Sunday instead.',
        ),
      );
      if (requests === 2)
        return {
          role: 'assistant',
          content: null,
          tool_calls: [call('write-correction', "printf 'Sunday\\n' >> /workspace/once.txt")],
        };
      assert.equal(JSON.parse(receipts.at(-1).content).result.exitCode, 0);
      return { role: 'assistant', content: 'Kept the original write and added Sunday.' };
    } catch (error) {
      errors.push(error.message);
      return { role: 'assistant', content: 'Fixture failed' };
    }
  },
});
async function until(check) {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await delay(50);
  }
  throw Error('Computer steering timed out');
}
async function send(text) {
  const res = await fetch(f.url + '/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: f.url },
    body: JSON.stringify({
      action: 'chat.send',
      payload: { threadId: 'main', text, delivery: 'now' },
    }),
  });
  assert(res.ok, await res.clone().text());
  return res.json();
}
try {
  const first = await send('Write once, then make the next file.');
  await until(() => started);
  const update = await send('Keep the completed write. Add Sunday instead.');
  assert.equal(first.result.id, update.result.id);
  await until(() => f.store.read().runs[0].status === 'completed');
  assert.deepEqual(errors, []);
  const bytes = Buffer.from((await computer.read('/workspace/once.txt')).base64, 'base64');
  assert.equal(bytes.toString(), 'original\nSunday\n');
  await assert.rejects(() => computer.read('/workspace/stale.txt'));
  assert.deepEqual(performed, ['write-original', 'write-correction']);
  assert.equal(f.store.read().runs.length, 1);
  await writeFile(
    resolve('../relay-evidence/steering-real-computer.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        modelRequests: requests,
        performed,
        bytes: bytes.toString(),
        checks: [
          'actual isolated Linux command finishes once across owner steering',
          'remaining stale command never creates its file',
          'corrected command runs in the same request with prior receipt context',
        ],
        scope: 'Actual Docker/Colima runtime and HTTP worker; controlled model decisions.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: real computer preserves one completed write, skips stale plan, and applies correction',
  );
} finally {
  await f.worker.stop();
  await computer.stop();
  await computer.dockerRun(['volume', 'rm', computer.volume, computer.displayVolume]);
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
