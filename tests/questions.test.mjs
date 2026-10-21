import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant, sampleRunReply } from '../shared/assistant.mjs';
import { questionProposal } from '../shared/questions.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { agentReply } from '../server/agent.mjs';

const proposal = {
  prompt: 'Which pace works for you?',
  options: [{ label: 'Gentle' }, { label: 'Focused' }],
};
const call = (name, args) => ({
  id: 'call-' + name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const ask = () => ({ text: '', toolCalls: [call('ask_question', proposal)] });
function pending(s, extra = {}) {
  const run = command(s, 'chat.send', { threadId: 'main', text: 'Plan my afternoon' });
  Object.assign(run, extra);
  appendAssistant(
    s,
    run.threadId,
    { text: 'One detail.', cards: [], question: proposal },
    { replyTo: run.messageId },
    run,
  );
  run.status = 'completed';
  return s.questions.at(-1);
}
test('question choices validate; literal custom answers preserve drafts and commit once', () => {
  for (const bad of [
    { ...proposal, prompt: '' },
    { ...proposal, prompt: 'a'.repeat(601) },
    { ...proposal, options: null },
    { ...proposal, options: [{ label: 'Only one' }] },
    { ...proposal, options: Array(6).fill({ label: 'A' }) },
    { ...proposal, options: [{ label: 'Same' }, { label: 'same' }] },
  ])
    assert.throws(() => questionProposal(bad));
  const s = createWorkspace();
  delete s.questions; // Existing saved workspaces migrate on first question.
  const q = pending(s);
  s.threads[0].draft = 'Keep this separate thought';
  for (const bad of [
    { text: '' },
    { text: 'a'.repeat(4001) },
    { optionId: 'missing' },
    { optionId: '1', text: 'Both' },
  ])
    assert.throws(() => command(s, 'question.answer', { id: q.id, ...bad }));
  const run = command(s, 'question.answer', { id: q.id, text: '/not-a-skill' });
  assert.equal(s.messages.at(-1).text, '/not-a-skill');
  assert.equal(run.skill, undefined);
  assert.equal(s.threads[0].draft, 'Keep this separate thought');
  assert.equal(command(s, 'question.answer', { id: q.id, text: '/not-a-skill' }).id, run.id);
  assert.equal(s.runs.filter((r) => r.messageId === q.answerMessageId).length, 1);
  assert.throws(
    () => command(s, 'question.answer', { id: q.id, optionId: '1' }),
    /already been answered/,
  );
  assert.throws(() => command(s, 'question.dismiss', { id: q.id }), /already been answered/);
  assert.equal(s.approvals.length, 0);
});
test('dismissal never queues work; archived chats and changed accounts reject continuation', () => {
  const s = createWorkspace();
  const q = pending(s);
  s.threads[0].archived = true;
  assert.throws(() => command(s, 'question.answer', { id: q.id, optionId: '1' }), /Restore/);
  s.threads[0].archived = false;
  const count = s.runs.length;
  command(s, 'question.dismiss', { id: q.id });
  command(s, 'question.dismiss', { id: q.id });
  assert.equal(s.runs.length, count);
  assert.throws(() => command(s, 'question.answer', { id: q.id, optionId: '1' }), /dismissed/);
  const live = pending(s, { connectionGeneration: 1 });
  s.connections.google = { connected: true, generation: 2 };
  assert.throws(
    () => command(s, 'question.answer', { id: live.id, optionId: '1' }),
    /account changed/,
  );
  assert.equal(live.status, 'pending');
});
test('a free-text question pauses work and resumes the original request exactly once', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const run = store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: 'main',
        text: 'Prepare the itinerary after I provide its destination.',
      }),
    );
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        complete: async () => ({
          text: '',
          toolCalls: [
            call('ask_question', { prompt: 'Where are you travelling?' }),
            call('write_note', { title: 'Premature', text: 'Do not create' }),
          ],
        }),
      },
    }).reply(run.id, new AbortController().signal);
    const question = store.read().questions[0];
    assert.deepEqual(question.options, []);
    assert.equal(store.read().files.length, 0);
    const answer = store.mutate((s) => {
      s.threads[0].draft = 'Keep my other thought';
      assert.throws(
        () => command(s, 'question.answer', { id: question.id, optionId: '1' }),
        /available answers/,
      );
      return command(s, 'question.answer', { id: question.id, text: 'Kyoto' });
    });
    assert.equal(
      store.mutate((s) => command(s, 'question.answer', { id: question.id, text: 'Kyoto' })).id,
      answer.id,
    );
    assert.equal(store.read().threads[0].draft, 'Keep my other thought');
    assert.match(answer.questionContext.origin.request, /itinerary/);
    assert.equal(answer.questionContext.answers.at(-1).answer, 'Kyoto');
    assert.deepEqual(questionProposal({ prompt: 'Where?', options: [] }), {
      prompt: 'Where?',
      options: [],
    });
  } finally {
    store.close();
  }
});
test('model questions stop the tool batch; durable answers resume after SQLite restart with the original context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-question-'));
  const path = join(dir, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const run = store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: 'main',
        text: 'Plan around my attached notes',
        fileIds: ['file-notes'],
      }),
    );
    const provider = {
      configured: true,
      complete: async () => ({
        text: '',
        toolCalls: [
          call('ask_question', proposal),
          call('remember', { text: 'This must not run after the question' }),
        ],
      }),
    };
    await new BackgroundWorker(store, { provider }).reply(run.id, new AbortController().signal);
    const state = store.read();
    assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.questions.length, 1);
    assert.equal(state.memories.length, 0);
    assert.ok(state.messages.at(-1).cards.some((c) => c.id === state.questions[0].id));
    store.close();
    store = new Store(path);
    const next = store.mutate((s) => {
      s.threads[0].draft = 'Unsaved idea';
      return command(s, 'question.answer', { id: s.questions[0].id, optionId: '1' });
    });
    store.close();
    store = new Store(path);
    recoverWork(store);
    let seen = false;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        complete: async (messages) => {
          const prompt = messages.at(-1).content;
          assert.match(prompt, /Plan around my attached notes/);
          assert.match(prompt, /file-notes/);
          assert.match(prompt, /Which pace works for you/);
          assert.match(prompt, /Gentle/);
          seen = true;
          return { text: 'A gentle plan using your notes.', toolCalls: [] };
        },
      },
    }).reply(next.id, new AbortController().signal);
    assert.ok(seen);
    assert.equal(store.read().threads[0].draft, 'Unsaved idea');
    assert.equal(store.read().messages.at(-1).text, 'A gentle plan using your notes.');
    assert.equal(store.read().questions[0].status, 'answered');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('stopped model work cannot leave an orphan question or continue later calls', async () => {
  const store = new Store(':memory:');
  try {
    const run = store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'A request' }),
    );
    const messageCount = store.read().messages.length;
    let finish;
    let started;
    const providerStarted = new Promise((resolve) => {
      started = resolve;
    });
    const worker = new BackgroundWorker(store, {
      provider: {
        configured: true,
        complete: () =>
          new Promise((resolve) => {
            finish = resolve;
            started();
          }),
      },
    });
    const work = worker.reply(run.id, new AbortController().signal);
    await providerStarted;
    store.mutate((s) => command(s, 'chat.stop', { id: run.id }));
    finish(ask()); // Deliberately ignores AbortSignal to exercise the worker's commit guard.
    await work;
    assert.equal(store.read().questions.length, 0);
    assert.equal(store.read().messages.length, messageCount);
    assert.equal(store.read().runs[0].status, 'cancelled');
  } finally {
    store.close();
  }
});
test('routine questions surface even with quiet notifications and keep restrictions and email provenance on continuation', async () => {
  const store = new Store(':memory:');
  try {
    const run = store.mutate((s) => {
      const routine = command(s, 'routine.create', {
        title: 'Prepare my week',
        threadId: 'main',
        instructions: 'Plan from my notes',
        schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
        notification: 'errors',
      });
      const r = command(s, 'routine.test', { id: routine.id });
      r.trigger = 'schedule';
      r.mailSource = { subject: 'Source snapshot', body: 'Untrusted original body' };
      return r;
    });
    await new BackgroundWorker(store, {
      provider: { configured: true, complete: async () => ask() },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions.length, 1);
    assert.equal(store.read().runs[0].surfaced, true);
    const next = store.mutate((s) =>
      command(s, 'question.answer', { id: s.questions[0].id, optionId: '2' }),
    );
    let attempt = 0;
    await agentReply(
      store,
      {
        complete: async (messages, tools) => {
          assert.ok(!tools.some((t) => ['create_routine', 'save_skill'].includes(t.name)));
          const full = messages.map((m) => m.content).join('\n');
          assert.match(full, /Plan from my notes/);
          assert.match(full, /Untrusted triggering email snapshot/);
          assert.match(full, /Source snapshot/);
          if (attempt++ === 0)
            return {
              text: '',
              toolCalls: [
                call('save_skill', { title: 'Unwanted', slug: 'unwanted', instructions: 'No' }),
              ],
            };
          assert.match(messages.at(-1).content, /cannot create or change/);
          return { text: 'Continued with the saved context.', toolCalls: [] };
        },
      },
      next,
      {},
      {},
    );
    assert.equal(store.read().skills.length, 0);
  } finally {
    store.close();
  }
});
test('sample clarification is honest and uses the selected answer in a real saved task', () => {
  const s = createWorkspace();
  const run = command(s, 'chat.send', { threadId: 'main', text: 'Help me plan my week' });
  const response = sampleRunReply(s, run);
  assert.match(response.text, /sample plan/);
  appendAssistant(s, 'main', response, { replyTo: run.messageId }, run);
  const next = command(s, 'question.answer', { id: s.questions[0].id, optionId: '2' });
  const reply = sampleRunReply(s, next);
  assert.equal(reply.cards[0].kind, 'task');
  assert.match(s.tasks[0].description, /Make time to rest/);
});
