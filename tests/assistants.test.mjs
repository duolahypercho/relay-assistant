// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { learnMemory } from '../shared/memory.mjs';
import {
  assistantWorkspace,
  assistantMemories,
  assistantMemoryControls,
} from '../shared/assistant-scope.mjs';
import { agentReply, executeTool, systemPrompt } from '../server/agent.mjs';
import { calculateStep } from '../shared/task-step.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
const role = {
  name: 'Aster',
  description: 'Protect quiet mornings.',
  tone: 'Brief and thoughtful',
  avatarColor: '#e9ad71',
};
const schedule = { kind: 'daily', time: '09:00', timeZone: 'UTC' };
function fixture(path = ':memory:') {
  const store = new Store(path, { sample: false });
  const act = (action, payload = {}) => store.mutate((s) => command(s, action, payload));
  const create = (p = {}) => act('assistant.create', { ...role, ...p });
  const send = (a, text = 'I prefer quiet hotels.') =>
    act('chat.send', { threadId: a.threadId, text });
  const learn = (run, p = {}, version) =>
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
          controlVersion:
            version ?? assistantMemoryControls(s, run.assistant.id).memoryControlVersion ?? 0,
        },
      ),
    );
  return { store, act, create, send, learn };
}
test('assistant profiles persist without polluting Main; concurrent edits and invalid scopes reject atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-assistants-'));
  let f = fixture(join(dir, 'workspace.sqlite'));
  try {
    const a = f.create();
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(f.store.read().threads.find((t) => t.id === 'main').title, 'Main chat');
    const side = f.act('thread.create', { assistantId: a.id, title: 'A weekend away' });
    assert.equal(side.assistantId, a.id);
    const edited = f.act('assistant.update', { ...a, name: 'Aster planner' });
    assert.equal(edited.revision, 2);
    assert.throws(
      () => f.act('assistant.update', { ...a, name: 'Stale edit' }),
      /changed in another/,
    );
    assert.throws(() => f.act('thread.create', { assistantId: 'missing' }), /no longer exists/);
    assert.throws(
      () => f.act('thread.update', { id: a.threadId, archived: true }),
      /main|home|available/i,
    );
    assert.throws(() => f.create({ name: 'x'.repeat(41) }), /40/);
    assert.throws(() => f.create({ enabledSkillIds: ['missing'] }), /saved skills/);
    f.act('assistant.pin', { id: a.id, value: true });
    f.act('assistant.hide', { id: a.id, value: true });
    f.store.close();
    f = fixture(join(dir, 'workspace.sqlite'));
    const saved = f.store.read().assistants[0];
    assert.equal(saved.hidden, true);
    assert.equal(saved.pinned, true);
    assert.equal(saved.name, 'Aster planner');
    assert.equal(f.store.read().threads.find((t) => t.id === a.threadId).title, saved.name);
    assert.equal(f.store.read().assistants.length, 1);
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('learned and manual memory stays with its assistant across side chats; owner controls do not invalidate another role', async () => {
  const f = fixture();
  try {
    const a = f.create(),
      b = f.create({ name: 'Mika' });
    const ra = f.send(a),
      rb = f.send(b),
      ma = f.learn(ra),
      mb = f.learn(rb);
    assert.notEqual(ma.id, mb.id);
    assert.equal(assistantMemories(f.store.read(), 'relay').length, 0);
    f.act('memory.update', { id: ma.id, text: 'Quiet hotels with a garden.' });
    assert.equal(f.learn(rb).status, 'unchanged');
    assert.throws(() => f.learn(rb, { memoryId: ma.id }), /no longer exists/);
    assert.throws(
      () =>
        f.act('memory.add', {
          assistantId: b.id,
          sourceMessageId: ra.messageId,
          text: 'Wrong source',
        }),
      /source message from this assistant/,
    );
    await assert.rejects(
      executeTool(f.store, 'forget_memory', { id: ma.id }, { threadId: b.threadId }),
      /different assistant/,
    );
    await executeTool(
      f.store,
      'remember',
      { assistantId: a.id, text: 'Mika-specific note' },
      { threadId: b.threadId, sourceMessageId: rb.messageId },
    );
    assert.equal(assistantMemories(f.store.read(), b.id).length, 2);
    assert.equal(assistantMemories(f.store.read(), a.id).length, 1);
    const side = f.act('thread.create', { assistantId: a.id });
    const prompt = systemPrompt(assistantWorkspace(f.store.read(), a.id));
    assert.match(prompt, /Quiet hotels with a garden/);
    assert.doesNotMatch(prompt, /Mika-specific/);
    const next = f.send({ ...a, threadId: side.id }, 'I prefer quiet hotels near a park.');
    assert.equal(
      f.learn(next, {
        memoryId: ma.id,
        text: 'Quiet hotels near a park.',
        evidence: 'I prefer quiet hotels near a park',
      }).status,
      'proposed',
    );
    f.act('assistant.learning', { id: b.id, enabled: false });
    assert.throws(() => f.learn(f.send(b)), /turned off/);
    assert.equal(assistantMemoryControls(f.store.read(), a.id).memoryLearning, true);
  } finally {
    f.store.close();
  }
});
test('queued chat keeps its role after an edit, excludes other histories and memories, and refreshes its own notes', async () => {
  const f = fixture();
  try {
    const a = f.create(),
      b = f.create({ name: 'Mika', description: 'A private other role' });
    f.send(b, 'Mika-only conversation');
    f.act('memory.add', { assistantId: b.id, text: 'Mika-only memory' });
    const run = f.send(a, 'Plan my weekend');
    f.act('assistant.update', { ...a, description: 'A new role for future messages' });
    f.act('memory.add', { assistantId: a.id, text: 'Aster owns quiet travel' });
    const prompts = [];
    const provider = {
      complete: async (messages) => {
        prompts.push(structuredClone(messages));
        return prompts.length === 1
          ? {
              text: '',
              toolCalls: [
                {
                  id: 'list',
                  type: 'function',
                  function: { name: 'list_routines', arguments: '{}' },
                },
              ],
            }
          : { text: 'Ready.', toolCalls: [] };
      },
    };
    const result = await agentReply(f.store, provider, run, {});
    assert.equal(result.text, 'Ready.');
    assert.equal(prompts.length, 2);
    for (const messages of prompts) {
      assert.match(messages[0].content, /You are Aster/);
      assert.match(messages[0].content, /Protect quiet mornings/);
      assert.match(messages[0].content, /Aster owns quiet travel/);
      assert.doesNotMatch(JSON.stringify(messages), /Mika-only|A private other role|A new role/);
    }
  } finally {
    f.store.close();
  }
});
test('model routine and skill tools enforce role scope; hidden assistants retain their schedules', async () => {
  const f = fixture();
  try {
    const skill = f.act('skill.create', {
      title: 'Daily review',
      slug: 'daily-review',
      description: 'Review calendar',
      instructions: 'Read the calendar and summarize.',
    });
    const a = f.create({ enabledSkillIds: [skill.id] }),
      b = f.create({ name: 'Mika', enabledSkillIds: [] });
    const r = f.act('routine.create', {
      title: 'Review',
      instructions: 'Check my day',
      schedule,
      threadId: a.threadId,
      skillId: skill.id,
    });
    f.act('routine.resume', { id: r.id });
    f.act('assistant.hide', { id: a.id, value: true });
    assert.equal(f.store.read().routines[0].paused, false);
    assert.equal(
      (await executeTool(f.store, 'list_routines', {}, { threadId: b.threadId })).result.length,
      0,
    );
    await assert.rejects(
      executeTool(
        f.store,
        'manage_routine',
        { id: r.id, action: 'pause' },
        { threadId: b.threadId },
      ),
      /different assistant/,
    );
    for (const name of ['read_skill', 'manage_skill', 'save_skill'])
      await assert.rejects(
        executeTool(f.store, name, { id: skill.id, action: 'archive' }, { threadId: b.threadId }),
        /not enabled/,
      );
    assert.throws(
      () =>
        f.act('routine.create', {
          title: 'Wrong role',
          instructions: 'Review',
          schedule,
          threadId: b.threadId,
          skillId: skill.id,
        }),
      /Enable this skill/,
    );
    assert.equal(
      (await executeTool(f.store, 'list_skills', {}, { threadId: b.threadId })).result.length,
      0,
    );
    assert.equal(
      (await executeTool(f.store, 'list_skills', {}, { threadId: a.threadId })).result.length,
      1,
    );
    const run = f.act('routine.test', { id: r.id });
    assert.equal(run.assistant.id, a.id);
    f.act('assistant.update', { ...a, description: 'Future role' });
    assert.equal(
      f.store.read().runs.find((x) => x.id === run.id).assistant.description,
      role.description,
    );
  } finally {
    f.store.close();
  }
});
test('duplication copies configuration only, with independent skills and paused routines', () => {
  const f = fixture();
  try {
    const a = f.create({ enabledSkillIds: [] });
    f.send(a, 'Private conversation');
    f.act('memory.add', { assistantId: a.id, text: 'Private memory' });
    f.act('routine.create', {
      title: 'Morning check',
      instructions: 'Check calendar',
      threadId: a.threadId,
      schedule,
    });
    f.store.mutate((s) => {
      Object.assign(s.routines[0], {
        lastResult: 'Private result',
        lastRunId: 'secret-run',
        emailCursor: 'cursor',
        lastMailId: 'secret-email',
        skill: { id: 'old', title: 'Method', sourceMessageId: 'private-message' },
      });
    });
    const copy = f.act('assistant.duplicate', { id: a.id });
    assert.equal(copy.name, 'Aster copy');
    assert.equal(copy.description, role.description);
    assert.equal(assistantMemories(f.store.read(), copy.id).length, 0);
    assert.equal(f.store.read().messages.filter((m) => m.threadId === copy.threadId).length, 0);
    const copied = f.store.read().routines.find((r) => r.threadId === copy.threadId);
    assert.equal(copied.paused, true);
    assert.equal(copied.nextRunAt, null);
    assert.doesNotMatch(
      JSON.stringify(copied),
      /Private result|secret-run|cursor|secret-email|private-message/,
    );
    f.act('assistant.update', { ...copy, description: 'Independent role' });
    assert.equal(
      f.store.read().assistants.find((x) => x.id === a.id).description,
      role.description,
    );
    assert.equal(f.store.read().tasks.length, 0);
  } finally {
    f.store.close();
  }
});
test('delegated work and clarification keep the initiating assistant and frozen role', async () => {
  const f = fixture();
  try {
    const a = f.create();
    const run = f.send(a, 'Please research my plan');
    f.act('memory.add', { text: 'Main-only memory' });
    f.act('memory.add', { assistantId: a.id, text: 'Aster-specific context' });
    f.act('assistant.update', { ...a, description: 'Future instructions' });
    const task = (
      await executeTool(
        f.store,
        'delegate_task',
        { title: 'Plan', description: 'Plan a weekend', kind: 'general', threadId: 'main' },
        { threadId: a.threadId, runId: run.id },
      )
    ).result;
    assert.equal(task.assistantId, a.id);
    assert.equal(task.assistant.description, role.description);
    await calculateStep(
      f.store.read(),
      { ...task, step: task.plan.length - 1 },
      {
        reason: async (_text, state) => {
          assert.match(systemPrompt(state), /Protect quiet mornings/);
          assert.match(systemPrompt(state), /Aster-specific context/);
          assert.doesNotMatch(systemPrompt(state), /Main-only memory|Future instructions/);
          return 'Research complete';
        },
      },
    );
    f.store.mutate((s) =>
      appendAssistant(
        s,
        a.threadId,
        {
          text: 'One detail.',
          cards: [],
          question: { prompt: 'Choose a pace', options: [{ label: 'Gentle' }, { label: 'Busy' }] },
        },
        { replyTo: run.messageId },
        run,
      ),
    );
    const question = f.store.read().questions.at(-1);
    const continuation = f.act('question.answer', { id: question.id, text: 'Gentle' });
    assert.deepEqual(continuation.assistant, run.assistant);
  } finally {
    f.store.close();
  }
});
