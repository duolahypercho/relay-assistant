import { isMemoryReview, emptyMemoryReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { learnMemory } from '../shared/memory.mjs';
import { agentReply, executeTool, systemPrompt } from '../server/agent.mjs';
function fixture(path = ':memory:') {
  const store = new Store(path, { sample: false });
  const act = (action, p) => store.mutate((s) => command(s, action, p));
  const send = (text, threadId = 'main') => act('chat.send', { text, threadId });
  const learn = (run, p = {}, version = store.read().profile.memoryControlVersion || 0) =>
    store.mutate((s) =>
      learnMemory(
        s,
        {
          key: 'preference.hotel',
          text: 'Prefers quiet hotels.',
          evidence: 'I prefer quiet hotels',
          ...p,
        },
        {
          runId: run.id,
          sourceMessageId: run.messageId,
          threadId: run.threadId,
          controlVersion: version,
        },
      ),
    );
  return { store, act, send, learn };
}
test('learning creates a sourced note once, shares context across chats and updates the same topic from newer evidence', () => {
  const f = fixture();
  try {
    const first = f.send('I prefer quiet hotels. Can you help plan a weekend?');
    const saved = f.learn(first);
    assert.equal(saved.status, 'saved');
    assert.equal(f.learn(first).status, 'unchanged');
    assert.equal(f.store.read().memories.length, 1);
    const memory = f.store.read().memories[0];
    assert.equal(memory.sourceMessageId, first.messageId);
    assert.equal(memory.evidence, 'I prefer quiet hotels');
    assert.equal(memory.updatedAt, undefined);
    const thread = f.act('thread.create', { title: 'Travel' });
    const newer = f.send('I now prefer lively hotels near music venues.', thread.id);
    const updated = f.learn(newer, {
      memoryId: saved.id,
      text: 'Prefers lively hotels near music venues.',
      evidence: 'I now prefer lively hotels near music venues',
    });
    assert.equal(updated.id, saved.id);
    assert.equal(updated.status, 'updated');
    assert.match(systemPrompt(f.store.read()), /lively hotels/);
    assert.doesNotMatch(systemPrompt(f.store.read()), /Prefers quiet hotels/);
    assert.throws(() => f.learn(first), /newer or identical/);
    assert.throws(
      () =>
        f.learn(newer, {
          key: 'another.key',
          memoryId: saved.id,
          evidence: 'I now prefer lively hotels near music venues',
        }),
      /topic key/,
    );
  } finally {
    f.store.close();
  }
});
test('learning requires exact owner evidence and an active owning run, never a forged source or routine', async () => {
  const f = fixture();
  try {
    const run = f.send('I prefer quiet hotels.');
    assert.throws(() => f.learn(run, { evidence: 'I prefer large cities' }), /exactly/);
    assert.throws(() => f.learn(run, { key: 'Invalid key' }), /lowercase/);
    assert.throws(() => f.learn(run, { text: 'x'.repeat(501) }), /500/);
    assert.throws(() => f.learn({ ...run, threadId: 'another' }), /active conversation/);
    const source = f.store.read().messages[0];
    f.store.mutate((s) => {
      s.runs[0].routineId = 'routine';
    });
    assert.throws(() => f.learn(run), /active conversation/);
    await assert.rejects(
      executeTool(f.store, 'learn_memory', {}, { routineRun: true }),
      /routine cannot/,
    );
    f.store.mutate((s) => {
      delete s.runs[0].routineId;
      s.messages[0].role = 'assistant';
    });
    assert.throws(() => f.learn(run), /active conversation/);
    f.store.mutate((s) => {
      s.messages[0] = source;
      s.runs[0].status = 'cancelled';
    });
    assert.throws(() => f.learn(run), /active conversation/);
    assert.equal(f.store.read().memories.length, 0);
  } finally {
    f.store.close();
  }
});
test('manual notes and edits are protected; a proposed update is inactive until accepted with the current proposal identity', () => {
  const f = fixture();
  try {
    const memory = f.act('memory.add', { text: 'Prefers quiet hotels.' });
    const run = f.send('I now prefer lively hotels.');
    const proposed = f.learn(run, {
      memoryId: memory.id,
      text: 'Prefers lively hotels.',
      evidence: 'I now prefer lively hotels',
    });
    assert.equal(proposed.status, 'proposed');
    assert.equal(f.store.read().memories[0].text, memory.text);
    assert.doesNotMatch(systemPrompt(f.store.read()), /Prefers lively hotels/);
    const proposal = f.store.read().memories[0].proposal;
    assert.equal(
      f.learn(run, { text: 'Prefers lively hotels.', evidence: 'I now prefer lively hotels' }).id,
      memory.id,
    );
    assert.equal(f.store.read().memories[0].proposal.id, proposal.id);
    assert.equal(f.store.read().memories.length, 1);
    assert.throws(
      () => f.act('memory.resolve', { id: memory.id, proposalId: 'stale', use: true }),
      /changed/,
    );
    const accepted = f.act('memory.resolve', { id: memory.id, proposalId: proposal.id, use: true });
    assert.equal(accepted.text, 'Prefers lively hotels.');
    assert.equal(accepted.origin, 'manual');
    assert.equal(accepted.sourceMessageId, run.messageId);
    assert.equal(accepted.proposal, undefined);
    assert.throws(
      () => f.act('memory.resolve', { id: memory.id, proposalId: proposal.id, use: true }),
      /changed/,
    );
  } finally {
    f.store.close();
  }
});
test('keeping edited wording and forgetting prevent old or inflight extraction from restoring discarded memories', () => {
  const f = fixture();
  try {
    const first = f.send('I prefer quiet hotels.');
    const saved = f.learn(first);
    f.act('memory.update', { id: saved.id, text: 'Prefer quiet hotels with a garden.' });
    assert.throws(() => f.learn(first), /predates/);
    const next = f.send('I prefer lively hotels.');
    f.learn(next, {
      memoryId: saved.id,
      text: 'Prefers lively hotels.',
      evidence: 'I prefer lively hotels',
    });
    const p = f.store.read().memories[0].proposal;
    f.act('memory.resolve', { id: saved.id, proposalId: p.id, use: false });
    assert.equal(f.store.read().memories[0].text, 'Prefer quiet hotels with a garden.');
    const oldVersion = f.store.read().profile.memoryControlVersion;
    f.act('memory.delete', { id: saved.id });
    assert.throws(() => f.learn(next, {}, oldVersion), /controls changed/);
    assert.throws(() => f.learn(next), /predates/);
    assert.equal(f.store.read().memories.length, 0);
    assert.doesNotMatch(systemPrompt(f.store.read()), /quiet hotels with a garden/);
    const fresh = f.send('I prefer quiet hotels.');
    assert.equal(f.learn(fresh).status, 'saved');
  } finally {
    f.store.close();
  }
});
test('turning learning off preserves notes, blocks automatic writes and keeps explicit remember available', async () => {
  const f = fixture();
  try {
    const run = f.send('I prefer quiet hotels.');
    const memory = f.learn(run);
    f.act('profile.update', { memoryLearning: false });
    assert.throws(() => f.learn(run), /turned off/);
    assert.equal(f.store.read().memories[0].id, memory.id);
    const explicitRun = f.send('Remember that Friday is for reading.');
    const explicit = await executeTool(
      f.store,
      'remember',
      { text: 'Friday is for reading.' },
      { sourceMessageId: explicitRun.messageId, threadId: 'main' },
    );
    assert.ok(explicit.card);
    assert.equal(f.store.read().memories.length, 2);
    f.act('profile.update', { memoryLearning: true });
    assert.throws(() => f.learn(run), /predates/);
    assert.throws(() => f.act('profile.update', { memoryLearning: 'false' }), /whether/);
  } finally {
    f.store.close();
  }
});
test('learning is bounded and an explicit repeated remember promotes a learned note to protected wording', () => {
  const f = fixture();
  try {
    const run = f.send('I prefer quiet hotels.');
    const m = f.learn(run);
    f.learn(run, { key: 'second', text: 'Second preference.' });
    f.learn(run, { key: 'third', text: 'Third preference.' });
    assert.throws(
      () => f.learn(run, { key: 'fourth', text: 'Fourth preference.' }),
      /at most three/,
    );
    f.act('memory.add', { text: 'Prefers quiet hotels.' });
    assert.equal(f.store.read().memories.find((x) => x.id === m.id).origin, 'manual');
    const newer = f.send('I prefer lively hotels.');
    assert.equal(
      f.learn(newer, {
        memoryId: m.id,
        text: 'Prefers lively hotels.',
        evidence: 'I prefer lively hotels',
      }).status,
      'proposed',
    );
  } finally {
    f.store.close();
  }
});
test('a learning tool call racing with an owner edit is discarded and the next model call sees current context', async () => {
  const f = fixture();
  try {
    const old = f.act('memory.add', { text: 'Prefers quiet hotels.' });
    const run = f.send('I prefer lively hotels. Help me plan.');
    let calls = 0;
    const provider = {
      complete: async (messages, tools) => {
        if (isMemoryReview(messages)) return emptyMemoryReply();
        calls++;
        if (calls === 1) {
          assert.ok(tools.some((t) => t.name === 'learn_memory'));
          f.act('memory.update', { id: old.id, text: 'Only choose quiet hotels.' });
          return {
            text: '',
            toolCalls: [
              {
                id: 'learn',
                function: {
                  name: 'learn_memory',
                  arguments: JSON.stringify({
                    key: 'preference.hotel',
                    memoryId: old.id,
                    text: 'Prefers lively hotels.',
                    evidence: 'I prefer lively hotels',
                  }),
                },
              },
            ],
          };
        }
        assert.match(messages[0].content, /Only choose quiet hotels/);
        assert.doesNotMatch(messages[0].content, /Prefers quiet hotels/);
        assert.match(messages.at(-1).content, /controls changed/);
        return { text: 'I will use your saved preference.', toolCalls: [] };
      },
    };
    const answer = await agentReply(f.store, provider, run, {});
    assert.equal(answer.cards.length, 0);
    assert.equal(f.store.read().memories[0].proposal, undefined);
    assert.equal(calls, 2);
  } finally {
    f.store.close();
  }
});
test('model learning returns one inspectable card and later requests receive the learned context after SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-memory-'));
  let f = fixture(join(directory, 'state.sqlite'));
  try {
    const run = f.send('I prefer quiet hotels. Help me plan.');
    let calls = 0;
    const provider = {
      complete: async (messages) => {
        if (isMemoryReview(messages)) return emptyMemoryReply();
        if (++calls === 1)
          return {
            text: '',
            toolCalls: [
              {
                id: 'learn',
                function: {
                  name: 'learn_memory',
                  arguments: JSON.stringify({
                    key: 'preference.hotel',
                    text: 'Prefers quiet hotels.',
                    evidence: 'I prefer quiet hotels',
                  }),
                },
              },
            ],
          };
        assert.match(messages[0].content, /Prefers quiet hotels/);
        return { text: 'Let’s plan around a quieter place.', toolCalls: [] };
      },
    };
    const answer = await agentReply(f.store, provider, run, {});
    assert.equal(answer.cards.length, 1);
    assert.equal(answer.cards[0].kind, 'memory');
    f.store.close();
    f = fixture(join(directory, 'state.sqlite'));
    const next = f.send('What should you consider for my hotel?');
    await agentReply(
      f.store,
      {
        complete: async (messages) => {
          if (isMemoryReview(messages)) return emptyMemoryReply();
          assert.match(messages[0].content, /Prefers quiet hotels/);
          return { text: 'A quieter setting.', toolCalls: [] };
        },
      },
      next,
      {},
    );
    assert.equal(f.store.read().memories.length, 1);
  } finally {
    f.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
