import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { skillSnapshot } from '../shared/skills.mjs';
import { dispatchRoutines } from '../shared/routines.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';

const method = {
  title: 'Weekly review',
  slug: 'weekly-review',
  description: 'Prepare my week',
  instructions: 'Read my calendar. Prepare changes for review. Return a plan with sources.',
};
const routine = {
  title: 'Monday review',
  threadId: 'main',
  instructions: 'Focus on Monday',
  schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
};
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Skill run did not complete.');
    await delay(10);
  }
}
test('skill library migrates existing state, validates input, checks stale edits and restores archived methods', () => {
  const s = createWorkspace();
  delete s.skills;
  const skill = command(s, 'skill.create', method);
  assert.equal(skill.version, 1);
  assert.throws(
    () => command(s, 'skill.create', { ...method, slug: 'WEEKLY-REVIEW' }),
    /already belongs/,
  );
  assert.throws(
    () => command(s, 'skill.create', { ...method, slug: 'two words' }),
    /single hyphens/,
  );
  assert.throws(
    () => command(s, 'skill.create', { ...method, slug: 'test', instructions: '' }),
    /required/,
  );
  const before = skillSnapshot(s, skill.id);
  command(s, 'skill.update', {
    id: skill.id,
    version: 1,
    instructions: 'Ask about priorities first.',
  });
  assert.equal(skill.version, 2);
  assert.equal(before.instructions, method.instructions);
  assert.throws(
    () => command(s, 'skill.update', { id: skill.id, version: 1, title: 'Stale edit' }),
    /changed elsewhere/,
  );
  command(s, 'skill.archive', { id: skill.id });
  assert.throws(() => skillSnapshot(s, skill.id), /available/);
  assert.throws(() => command(s, 'skill.create', method), /archived skill/);
  command(s, 'skill.restore', { id: skill.id });
  assert.equal(skillSnapshot(s, skill.id).version, 2);
  assert.throws(
    () =>
      command(s, 'skill.create', { ...method, slug: 'missing-source', sourceMessageId: 'missing' }),
    /source message/,
  );
});
test('slash invocation snapshots instructions and inputs; unavailable skills cannot lose a draft or queue work', () => {
  const s = createWorkspace();
  const skill = command(s, 'skill.create', method);
  s.threads[0].draft = 'Keep this';
  const run = command(s, 'skill.run', {
    id: skill.id,
    threadId: 'main',
    input: 'Use next week\nKeep Friday free.',
  });
  assert.equal(s.threads[0].draft, 'Keep this');
  assert.equal(run.skillInput, 'Use next week\nKeep Friday free.');
  const message = s.messages.find((m) => m.id === run.messageId);
  assert.equal(message.text, '/weekly-review Use next week\nKeep Friday free.');
  command(s, 'skill.update', { id: skill.id, instructions: 'A new method' });
  command(s, 'skill.archive', { id: skill.id });
  assert.equal(run.skill.instructions, method.instructions);
  assert.equal(message.skill.version, 1);
  const count = s.messages.length;
  assert.throws(
    () => command(s, 'chat.send', { threadId: 'main', text: '/weekly-review now' }),
    /unavailable/,
  );
  assert.throws(
    () => command(s, 'chat.send', { threadId: 'main', text: '/unknown' }),
    /unavailable/,
  );
  assert.equal(s.messages.length, count);
  assert.equal(s.threads[0].draft, 'Keep this');
  command(s, 'skill.restore', { id: skill.id });
  assert.equal(
    command(s, 'chat.send', { threadId: 'main', text: '/WEEKLY-REVIEW' }).skill.version,
    2,
  );
});
test('routines pin skill versions, update only on explicit selection, and preserve queued snapshots', () => {
  const s = createWorkspace();
  const skill = command(s, 'skill.create', method);
  const r = command(s, 'routine.create', { ...routine, instructions: '', skillId: skill.id });
  command(s, 'skill.update', { id: skill.id, instructions: 'Version two' });
  command(s, 'routine.update', { id: r.id, title: 'Renamed schedule' });
  assert.equal(r.skill.version, 1);
  const first = command(s, 'routine.test', { id: r.id });
  first.status = 'completed';
  command(s, 'routine.update', { id: r.id, skillId: skill.id });
  assert.equal(r.skill.version, 2);
  assert.equal(first.skill.version, 1);
  command(s, 'skill.archive', { id: skill.id });
  command(s, 'routine.resume', { id: r.id });
  r.nextRunAt = Date.now() - 1;
  dispatchRoutines(s);
  assert.equal(s.runs.at(-1).skill.version, 2);
  assert.throws(() => command(s, 'routine.create', { ...routine, skillId: skill.id }), /available/);
  assert.throws(
    () => command(s, 'routine.update', { id: r.id, execution: 'reminder' }),
    /assistant routine/,
  );
  command(s, 'routine.update', { id: r.id, skillId: '', instructions: 'Plain routine' });
  assert.equal(r.skill, null);
});
test('a skill run survives SQLite reopen and reaches the model with its saved version, file IDs and input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-skill-'));
  const path = join(dir, 'workspace.sqlite');
  let store = new Store(path);
  const run = store.mutate((s) => {
    const skill = command(s, 'skill.create', method);
    const file = command(s, 'file.add', {
      name: 'priorities.md',
      mime: 'text/markdown',
      text: 'A real attachment',
      base64: '',
    });
    const run = command(s, 'chat.send', {
      threadId: 'main',
      text: '/weekly-review Keep Tuesday free',
      fileIds: [file.id],
    });
    command(s, 'skill.update', { id: skill.id, instructions: 'Do not use this changed method' });
    return run;
  });
  store.close();
  store = new Store(path);
  recoverWork(store);
  let seen = false;
  const worker = new BackgroundWorker(
    store,
    {
      provider: {
        configured: true,
        complete: async (messages) => {
          const request = messages.at(-1).content;
          assert.match(request, /version 1/);
          assert.match(request, /Keep Tuesday free/);
          assert.ok(request.includes(method.instructions));
          assert.match(request, /Attached workspace file IDs/);
          assert.ok(!request.includes('Do not use this changed method'));
          seen = true;
          return { text: 'Verified saved method input.', toolCalls: [] };
        },
      },
    },
    { pollMs: 10 },
  );
  worker.start();
  try {
    await until(() => store.read().runs.find((x) => x.id === run.id).status === 'completed');
    assert.ok(seen);
    assert.ok(
      store
        .read()
        .messages.some(
          (m) => m.replyTo === run.messageId && m.text === 'Verified saved method input.',
        ),
    );
  } finally {
    await worker.stop();
    store.close();
    await rm(dir, { recursive: true });
  }
});
test('model-created methods are inspectable and scheduled skill execution cannot rewrite methods or bypass reviews', async () => {
  const store = new Store(':memory:');
  try {
    const saved = await executeTool(store, 'save_skill', method, { threadId: 'main' });
    assert.equal(saved.card.page, 'skills');
    const read = await executeTool(store, 'read_skill', { id: saved.result.id }, {});
    assert.equal(read.result.instructions, method.instructions);
    const r = store.mutate((s) =>
      command(s, 'routine.create', { ...routine, skillId: saved.result.id }),
    );
    const run = store.mutate((s) => command(s, 'routine.test', { id: r.id }));
    let calls = 0;
    const provider = {
      complete: async (messages, tools) => {
        assert.ok(!tools.some((t) => ['save_skill', 'manage_skill'].includes(t.name)));
        assert.ok(messages.some((m) => m.content?.includes(method.instructions)));
        return ++calls === 1
          ? {
              text: '',
              toolCalls: [
                {
                  id: 'review',
                  function: {
                    name: 'prepare_email',
                    arguments: JSON.stringify({
                      to: 'owner@example.invalid',
                      subject: 'Weekly review',
                      body: 'For your review',
                    }),
                  },
                },
              ],
            }
          : { text: 'Please review this draft.', toolCalls: [] };
      },
    };
    const result = await agentReply(store, provider, run, {});
    assert.equal(result.cards[0].kind, 'review');
    assert.equal(store.read().approvals[0].status, 'pending');
    assert.equal(store.read().mail.filter((m) => m.folder === 'sent').length, 0);
    await assert.rejects(
      executeTool(store, 'save_skill', method, { routineRun: true }),
      /cannot create or change/,
    );
    await assert.rejects(
      executeTool(
        store,
        'manage_skill',
        { id: saved.result.id, action: 'archive' },
        { routineRun: true },
      ),
      /cannot create or change/,
    );
  } finally {
    store.close();
  }
});
