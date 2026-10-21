// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { agentReply } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';

const tool = (name, input = {}, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(input) },
});
const calls = (...items) => ({ text: '', toolCalls: items });
const answer = (text) => ({ text, toolCalls: [] });
function fixture(t, { path = ':memory:', text = 'Read my saved repair-review method.' } = {}) {
  const f = { store: new Store(path, { sample: false }) };
  t.after(() => f.store.close());
  f.run = f.store.mutate((s) => {
    s.profile.memoryLearning = false;
    f.skillId = command(s, 'skill.create', {
      title: 'Repair review',
      slug: 'repair-review',
      instructions: 'Review repair notes.',
    }).id;
    s.files.push({ id: 'note', name: 'Note.txt', mime: 'text/plain', text: 'Meet at noon.' });
    const run = command(s, 'chat.send', { threadId: 'main', text });
    run.voiceCallId = 'discovery-completion';
    return run;
  });
  return f;
}

for (const explicit of [true, false])
  test(`${explicit ? 'explicit' : 'implicit'} discovery cannot publish an unexecuted lookup as a result`, async (t) => {
    const f = fixture(t),
      streamed = [];
    let count = 0;
    const result = await agentReply(
      f.store,
      {
        complete: async (messages, tools, options) => {
          if (++count === 1)
            return calls(
              explicit
                ? tool('load_tools', { names: ['read_skill'] })
                : tool('read_skill', { id: f.skillId }),
            );
          assert(tools.some((t) => t.name === 'read_skill'));
          if (count === 2) {
            options.onText('You have no saved method.');
            return answer('You have no saved method.');
          }
          if (count === 3) {
            assert.match(messages.at(-1).content, /did not read any data/);
            return calls(tool('read_skill', { id: f.skillId }, 'actual-read'));
          }
          const read = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
          assert.equal(read.result.instructions, 'Review repair notes.');
          options.onText('The repair method reviews repair notes.');
          return answer('The repair method reviews repair notes.');
        },
      },
      f.run,
      {},
      { durable: true, onText: (text) => streamed.push(text) },
    );
    assert.equal(count, 4);
    assert.equal(result.text, 'The repair method reviews repair notes.');
    assert.deepEqual(streamed, ['The repair method reviews repair notes.']);
    assert.equal(f.store.read().approvals.length, 0);
    assert.deepEqual(
      await agentReply(
        f.store,
        { complete: () => assert.fail('Completed work was replayed') },
        f.run,
        {},
        { durable: true },
      ),
      result,
    );
  });

test('reloading instructions cannot reset the bounded continuation or leak a repeated false answer', async (t) => {
  const f = fixture(t),
    streamed = [];
  let count = 0;
  await assert.rejects(
    agentReply(
      f.store,
      {
        complete: async (_messages, _tools, options) => {
          if (++count % 2)
            return calls(tool('load_tools', { names: ['read_skill'] }, `load-${count}`));
          options.onText('There are no method.');
          return answer('There are no method.');
        },
      },
      f.run,
      {},
      { durable: true, onText: (text) => streamed.push(text) },
    ),
    /stopped before using/,
  );
  assert.equal(count, 4);
  assert.deepEqual(streamed, []);
});

test('the unused-instruction boundary and spent retry survive SQLite reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-discovery-check-'));
  const path = join(directory, 'workspace.sqlite');
  const f = fixture(t, { path });
  t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0;
  await assert.rejects(
    agentReply(
      f.store,
      {
        complete: async () => {
          if (++count === 1) return calls(tool('load_tools', { names: ['read_skill'] }));
          if (count === 2) return answer('No saved method.');
          throw Error('Synthetic model connection stopped after continuation.');
        },
      },
      f.run,
      {},
      { durable: true },
    ),
    /Synthetic model/,
  );
  f.store.close();
  f.store = new Store(path, { sample: false });
  f.run = f.store.read().runs.find((r) => r.id === f.run.id);
  const streamed = [];
  let resumed = 0;
  await assert.rejects(
    agentReply(
      f.store,
      {
        complete: async (_messages, _tools, options) => {
          resumed++;
          options.onText('No saved method.');
          return answer('No saved method.');
        },
      },
      f.run,
      {},
      { durable: true, onText: (text) => streamed.push(text) },
    ),
    /stopped before using/,
  );
  assert.equal(resumed, 1);
  assert.deepEqual(streamed, []);
});

test('instruction-only exhaustion fails without an unusable retry and preserves earlier result cards', async (t) => {
  const f = fixture(t);
  // Persist a compact typed run, so the normal typed retry path is exercised.
  f.store.mutate((s) => {
    delete s.runs[0].voiceCallId;
  });
  f.run = f.store.read().runs[0];
  const cards = [{ kind: 'file', fileId: 'note' }];
  new AgentCheckpoint(f.store, f.run.id).save('ready', {
    compactTools: true,
    messages: [],
    cards,
    round: 0,
    nextTool: 0,
  });
  let count = 0;
  const worker = new BackgroundWorker(f.store, {
    mode: 'live',
    provider: {
      configured: true,
      complete: async () => calls(tool('load_tools', { names: ['read_skill'] }, `load-${++count}`)),
    },
  });
  t.after(() => worker.stop());
  await worker.reply(f.run.id, new AbortController().signal);
  const run = f.store.read().runs[0],
    failure = f.store.read().messages.at(-1);
  assert.equal(count, 8);
  assert.equal(run.status, 'failed');
  assert.equal(run.retryable, false);
  assert.equal(run.retryMessageId, undefined);
  assert.equal(failure.error, true);
  assert.match(failure.text, /work limit while loading tool instructions/);
  assert.deepEqual(failure.cards, cards);
  assert.equal(new AgentCheckpoint(f.store, f.run.id).load(), null);
});

for (const loadFirst of [true, false])
  test(`an actual read ${loadFirst ? 'after' : 'before'} loading optional instructions permits completion`, async (t) => {
    const f = fixture(t, { text: 'Read Note.txt and tell me the meeting time.' });
    let count = 0;
    const result = await agentReply(
      f.store,
      {
        complete: async () => {
          if (++count === 1) {
            const plan = [
              tool('load_tools', { names: ['read_skill'] }),
              tool('read_file', { id: 'note' }),
            ];
            return calls(...(loadFirst ? plan : plan.reverse()));
          }
          return answer('Meet at noon.');
        },
      },
      f.run,
      {},
      { durable: true },
    );
    assert.equal(result.text, 'Meet at noon.');
    assert.equal(count, 2, 'Optional loaded tools must not be forced to execute');
  });

test('a real tool failure permits an honest error response without a discovery loop', async (t) => {
  const f = fixture(t, { text: 'Read the saved method called Missing.' });
  let count = 0;
  const result = await agentReply(
    f.store,
    {
      complete: async () => {
        if (++count === 1) return calls(tool('load_tools', { names: ['read_skill'] }));
        if (count === 2) return calls(tool('read_skill', { id: 'missing' }));
        return answer('I could not read that saved method.');
      },
    },
    f.run,
    {},
    { durable: true },
  );
  assert.equal(count, 3);
  assert.equal(result.text, 'I could not read that saved method.');
});

test('cancellation during the withheld answer prevents execution and publication', async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    streamed = [];
  let count = 0;
  await assert.rejects(
    agentReply(
      f.store,
      {
        complete: async (_messages, _tools, options) => {
          if (++count === 1) return calls(tool('load_tools', { names: ['read_skill'] }));
          controller.abort();
          options.onText('No saved method.');
          return answer('No saved method.');
        },
      },
      f.run,
      {},
      { durable: true, signal: controller.signal, onText: (text) => streamed.push(text) },
    ),
    { name: 'AbortError' },
  );
  assert.equal(count, 2);
  assert.deepEqual(streamed, []);
});

test('a new owner instruction releases the old lookup boundary without executing it', async (t) => {
  const f = fixture(t),
    streamed = [];
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === f.run.id).status = 'running';
    s.voiceCalls = [{ id: f.run.voiceCallId, threadId: 'main', status: 'active' }];
  });
  f.run.status = 'running';
  let count = 0;
  const result = await agentReply(
    f.store,
    {
      complete: async (_messages, _tools, options) => {
        if (++count === 1) return calls(tool('load_tools', { names: ['read_skill'] }));
        if (count === 2) {
          const redirected = f.store.mutate((s) =>
            command(
              s,
              'chat.send',
              {
                threadId: 'main',
                text: 'Actually, just say hello.',
                delivery: 'now',
              },
              false,
              undefined,
              { voiceCallId: f.run.voiceCallId },
            ),
          );
          assert.equal(redirected.id, f.run.id);
          return answer('No saved method.');
        }
        options.onText('Hello.');
        return answer('Hello.');
      },
    },
    f.run,
    {},
    { durable: true, onText: (text) => streamed.push(text) },
  );
  assert.equal(count, 3);
  assert.equal(result.text, 'Hello.');
  assert.deepEqual(streamed, ['Hello.']);
});
