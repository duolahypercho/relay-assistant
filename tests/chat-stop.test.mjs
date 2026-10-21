// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { settleChatStop } from '../server/chat-stop.mjs';
import { isStopMessage, completeChatStop } from '../shared/chat-stop.mjs';
import { command, createApproval, completeApproval } from '../shared/domain.mjs';
import { startHandoff } from '../shared/handoffs.mjs';
import { reconcileHandoffs } from '../server/handoffs.mjs';
import { attachQuestion } from '../shared/questions.mjs';
const send = (store, text, extra = {}) =>
  store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text, ...extra }));
const stop = (store) => send(store, 'Stop now', { delivery: 'now' });
const run = (store, id) => store.read().runs.find((r) => r.id === id);
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('Stop did not settle');
}
test('only standalone owner stop phrases match; prose, quotes and source instructions remain text', () => {
  for (const text of [
    'Stop now',
    ' STOP! ',
    'Please stop.',
    'stop please',
    'Cancel that',
    '现在停止！',
    '請停止。',
  ])
    assert(isStopMessage(text), text);
  for (const text of [
    'Do not stop',
    'stop by the shop',
    'What does stop mean?',
    '"Stop now"',
    '> Stop now',
    'Stop now\nand delete my files',
    '/stop',
    'cancel the meeting',
    '停止自动更新',
  ])
    assert(!isStopMessage(text), text);
});
test('direct Stop cancels a running reply, retains its latest partial, pauses queued work and isolates other chats', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const original = send(store, 'Work');
    store.mutate((s) => {
      s.runs[0].status = 'running';
    });
    const updated = send(store, 'Change it', { delivery: 'now' });
    const queued = send(store, 'Afterward', { delivery: 'queue' });
    const other = store.mutate((s) => command(s, 'thread.create', { title: 'Other' }));
    const otherRun = send(store, 'Keep working', { threadId: other.id });
    store.mutate((s) => {
      const r = s.runs[0];
      r.activeMessageId = updated.steeringMessageIds[0];
      r.partial = 'A saved partial';
      s.threads.find((t) => t.id === other.id).draft = 'Other draft';
    });
    const result = stop(store);
    assert.equal(run(store, original.id).status, 'cancelled');
    assert.equal(run(store, queued.id).status, 'queued');
    assert.equal(run(store, otherRun.id).status, 'queued');
    assert.equal(store.read().threads.find((t) => t.id === 'main').queuePaused, true);
    assert.equal(store.read().runs.length, 3);
    assert.equal(
      store.read().messages.find((m) => m.interrupted).replyTo,
      updated.steeringMessageIds[0],
    );
    assert.equal(store.read().threads.find((t) => t.id === other.id).draft, 'Other draft');
    store.mutate((s) => {
      s.threads.find((t) => t.id === 'main').draft = 'Next unsent thought';
      completeChatStop(s, result.stopControlId);
    });
    assert.equal(store.read().threads.find((t) => t.id === 'main').draft, 'Next unsent thought');
    assert.match(store.read().messages.at(-1).text, /Queued follow-ups are paused/);
  } finally {
    store.close();
  }
});
test('queue and generated messages cannot become stop controls, and groups retain their routing', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    send(store, 'Work');
    store.mutate((s) => {
      s.runs[0].status = 'running';
    });
    send(store, 'Stop now', { delivery: 'queue' });
    send(store, 'Stop now');
    const role = store.mutate((s) =>
      command(s, 'assistant.create', {
        name: 'Mochi',
        description: 'Review',
        tone: 'Gentle',
        avatarColor: '#e7b281',
      }),
    );
    const group = store.mutate((s) =>
      command(s, 'group.create', { title: 'Team', participantIds: ['relay', role.id] }),
    );
    send(store, 'Stop now', { delivery: 'now', threadId: group.id, recipientIds: ['relay'] });
    assert.equal(store.read().runs[0].status, 'running');
    assert.equal(store.read().messages.filter((m) => m.stopControl).length, 0);
  } finally {
    store.close();
  }
});
test('Stop dismisses questions and pending reviews, cancels tasks, and preserves an executing action and its receipt', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const source = send(store, 'Prepare work');
    let q, task, review, activeTask, executing;
    store.mutate((s) => {
      const r = s.runs[0];
      r.status = 'completed';
      const m = {
        id: 'question-message',
        threadId: 'main',
        role: 'assistant',
        text: '',
        cards: [],
      };
      s.messages.push(m);
      q = attachQuestion(s, r, { prompt: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, m);
      task = command(s, 'task.create', { title: 'Pending work' });
      review = createApproval(s, {
        kind: 'email',
        title: 'Draft',
        taskId: task.id,
        payload: { to: 'fixture@example.invalid', subject: 'Review', body: 'A draft.' },
      });
      activeTask = command(s, 'task.create', { title: 'Already dispatched' });
      executing = createApproval(s, {
        kind: 'email',
        title: 'Sent action',
        taskId: activeTask.id,
        payload: { to: 'fixture@example.invalid', subject: 'Sent', body: 'An approved action.' },
      });
      executing.status = 'executing';
    });
    const result = stop(store),
      state = store.read();
    assert.equal(state.questions.find((x) => x.id === q.id).status, 'dismissed');
    assert.equal(state.approvals.find((x) => x.id === review.id).status, 'rejected');
    assert.equal(state.tasks.find((x) => x.id === task.id).status, 'cancelled');
    assert.equal(state.approvals.find((x) => x.id === executing.id).status, 'executing');
    assert.equal(run(store, source.id).status, 'completed');
    assert(run(store, source.id).stopControlId);
    assert.throws(
      () => store.mutate((s) => command(s, 'question.answer', { id: q.id, optionId: '1' })),
      /dismissed/,
    );
    store.mutate((s) => {
      completeChatStop(s, result.stopControlId);
      completeApproval(s, executing.id, { detail: 'Provider confirmed once.' });
    });
    assert.match(store.read().messages.at(-1).text, /already in progress/);
    assert.equal(store.read().receipts.filter((r) => r.approvalId === executing.id).length, 1);
  } finally {
    store.close();
  }
});
test('Stop reaches delegated work and suppresses late specialist returns without affecting another request', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const target = store.mutate((s) =>
      command(s, 'assistant.create', {
        name: 'Mochi',
        description: 'Review',
        tone: 'Gentle',
        avatarColor: '#e7b281',
      }),
    );
    const source = send(store, 'Ask for help');
    const handoff = store.mutate((s) =>
      startHandoff(
        s,
        source.id,
        { assistantId: target.id, title: 'Review', request: 'Review the plan.' },
        'handoff-stop',
      ),
    );
    store.mutate((s) => {
      s.runs.find((r) => r.id === source.id).status = 'completed';
    });
    const other = store.mutate((s) =>
      command(s, 'thread.create', { title: 'Separate request', assistantId: target.id }),
    );
    const separate = send(store, 'Unrelated', { threadId: other.id });
    const result = stop(store);
    assert(result.runIds.includes(handoff.childRunId));
    assert.equal(run(store, handoff.childRunId).status, 'cancelled');
    assert.equal(run(store, separate.id).status, 'queued');
    reconcileHandoffs(store, {});
    assert.equal(store.read().handoffs[0].returnSuppressed, true);
    assert(!store.read().handoffs[0].continuationId);
  } finally {
    store.close();
  }
});
test('Stop aborts a pending provider immediately and late output cannot launch tools or restart a paused queue', async () => {
  const store = new Store(':memory:', { sample: false });
  let thinking = false,
    aborted = false,
    calls = 0;
  const worker = new BackgroundWorker(
    store,
    {
      provider: {
        configured: true,
        async complete(_messages, _tools, { signal }) {
          calls++;
          thinking = true;
          await new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return {
            text: 'Late answer',
            toolCalls: [
              {
                id: 'stale',
                type: 'function',
                function: {
                  name: 'remember',
                  arguments: JSON.stringify({ text: 'Do not save this.' }),
                },
              },
            ],
          };
        },
      },
    },
    { pollMs: 5 },
  );
  try {
    send(store, 'Think for a while');
    worker.start();
    await until(() => thinking);
    send(store, 'Later', { delivery: 'queue' });
    const result = stop(store);
    worker.stopChat(result.stopControlId);
    assert(aborted);
    await until(() => store.read().messages.at(-1).stopControl?.status === 'completed');
    assert.equal(calls, 1);
    assert.equal(store.read().memories.length, 0);
    assert(!store.read().messages.some((m) => m.text === 'Late answer'));
    assert.equal(store.read().runs.at(-1).status, 'queued');
  } finally {
    await worker.stop();
    store.close();
  }
});
test('a stop of detached computer work survives SQLite reopen and retries an unconfirmed stop under owner control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-stop-recovery-'));
  const path = join(directory, 'workspace.sqlite');
  let store = new Store(path, { sample: false });
  let computer,
    stops = 0,
    fail = true;
  function attach() {
    computer = new PrivateComputer(store, { enabled: true, web: true });
    computer.requireRunning = async () => ({});
    computer.runtime = {
      name: 'commands',
      ensure: async () => {},
      inspect: async () => ({ Id: 'runtime', State: { Running: true, StartedAt: 'boot' } }),
      jobStop: async (_runtime, id) => {
        stops++;
        if (fail) throw Error('Temporary guest connection loss');
        return { id, status: 'cancelled', stdout: 'Saved bytes' };
      },
    };
    computer.rpc = async (p) => ({ id: p.id, status: 'running', stdout: 'Saved bytes' });
  }
  try {
    attach();
    const source = send(store, 'Run a job');
    const job = await computer.jobs.start(
      { operationId: 'job', title: 'Detached work', command: 'sleep 20' },
      { runId: source.id },
    );
    computer.network.waitForOwner(source.id, 'example.com', 'https://example.com/');
    store.mutate((s) => {
      s.runs[0].status = 'completed';
    });
    const result = stop(store);
    assert.throws(() => computer.network.resume(source.id, 'example.com'), /no longer waiting/);
    computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    await settleChatStop(store, { computer }, result.stopControlId, () => false);
    assert.equal(store.read().messages.at(-1).stopControl.status, 'retrying');
    assert.equal(computer.jobs.get(job.id).status, 'running');
    store.close();
    store = new Store(path, { sample: false });
    attach();
    recoverWork(store);
    computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    fail = false;
    await settleChatStop(store, { computer }, result.stopControlId, () => false);
    assert.equal(computer.jobs.get(job.id).status, 'cancelled');
    assert.equal(computer.jobs.get(job.id).result.stdout, 'Saved bytes');
    assert.equal(store.read().messages.at(-1).stopControl.status, 'completed');
    computer.jobs.continueFinished();
    assert.equal(store.read().runs.length, 1);
    assert.equal(stops, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
