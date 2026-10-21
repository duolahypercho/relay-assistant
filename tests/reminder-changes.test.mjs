// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { routineCommand, dispatchRoutines } from '../shared/routines.mjs';
import { createReminder } from '../server/reminders.mjs';
import {
  changeReminder,
  reminderChangeToken,
  reminderChangeRequested,
  reminderChangeConfirmation,
  reminderView,
  reminderChoiceQuestion,
} from '../server/reminder-changes.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { BackgroundWorker } from '../server/worker.mjs';

function request(store, text, at = Date.now(), threadId = 'main') {
  const run = store.mutate((s) => {
    const r = command(s, 'chat.send', { text, threadId });
    s.messages.find((m) => m.id === r.messageId).createdAt = new Date(at).toISOString();
    return r;
  });
  return { run, threadId, sourceMessageId: run.messageId, runId: run.id, now: at + 1000 };
}
function fixture(t) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.profile.timeZone = 'Asia/Shanghai';
  });
  const c = request(store, 'Remind me in five minutes to drink water.');
  const r = store.mutate((s) => createReminder(s, { text: 'Drink water.', delayMinutes: 5 }, c));
  return { store, r, c };
}
const edit = (store, r, input, c) =>
  store.mutate((s) =>
    changeReminder(
      s,
      {
        id: r.id,
        changeToken: reminderChangeToken(s.routines.find((x) => x.id === r.id)),
        ...input,
      },
      c,
    ),
  );
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('a reminder edit preserves a quoted owner payload and the existing explicit pause', (t) => {
  const { store, r } = fixture(t);
  store.mutate((s) => {
    s.routines[0].paused = true;
  });
  const c = request(
    store,
    'Update the reminder. Its reminder text is "Drink water. Stretch!" Keep it paused.',
  );
  const changed = edit(
    store,
    r,
    { action: 'update', text: 'Send a reminder to drink water and stretch' },
    c,
  );
  assert.equal(changed.instructions, 'Drink water. Stretch!');
  assert.equal(changed.paused, true);
  assert.equal(changed.id, r.id);
});

test('reschedule preserves identity, unspecified fields and paused state, using the new owner request time', (t) => {
  const { store, r } = fixture(t);
  store.mutate((s) => routineCommand(s, 'routine.pause', { id: r.id }));
  const c = request(store, 'Move the water reminder to ten minutes from now.');
  const next = edit(store, r, { action: 'update', delayMinutes: 10 }, c);
  assert.equal(next.id, r.id);
  assert.equal(store.read().routines.length, 1);
  assert.equal(next.schedule.at, c.now - 1000 + 600000);
  assert.equal(next.instructions, r.instructions);
  assert.equal(next.title, r.title);
  assert.equal(next.paused, true);
  assert.equal(next.reminderRelative, true);
  const again = edit(
    store,
    r,
    { action: 'update', schedule: { kind: 'daily', time: '09:30' } },
    request(store, 'Change the water reminder to daily at 9:30.'),
  );
  assert.equal(again.schedule.timeZone, 'Asia/Shanghai');
  assert.equal(again.reminderRelative, false);
});

test('text-only changes preserve exact relative instants and trailing literal punctuation', (t) => {
  const { store, r } = fixture(t);
  const next = edit(
    store,
    r,
    { action: 'update', text: 'Take a break' },
    request(store, 'Change the water reminder. Use the reminder text exactly: Take a break.'),
  );
  assert.equal(next.schedule.at, r.schedule.at);
  assert.equal(next.instructions, 'Take a break.');
  assert.equal(next.reminderRelative, true);
});

test('stale tokens and invalid changes leave the reminder untouched', (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Change the water reminder.');
  const token = reminderChangeToken(r);
  store.mutate((s) => routineCommand(s, 'routine.pause', { id: r.id }));
  const before = store.read().routines;
  for (const input of [
    { action: 'update', delayMinutes: 10, changeToken: token },
    { action: 'update' },
    { action: 'cancel', text: 'extra' },
    { action: 'update', text: '' },
    { action: 'update', execution: 'assistant' },
    { action: 'update', delayMinutes: 0 },
    { action: 'update', delayMinutes: 5, schedule: {} },
    { action: 'update', schedule: { kind: 'daily', time: '25:00' } },
  ])
    assert.throws(() => edit(store, r, input, c));
  assert.deepEqual(store.read().routines, before);
});

test('replayed owner operations cannot undo a later pause or archive, including reordered schedule fields', (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Change the water reminder to 9 AM daily.');
  edit(
    store,
    r,
    { action: 'update', schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } },
    c,
  );
  const version = store.read().routines[0].version;
  store.mutate((s) => routineCommand(s, 'routine.pause', { id: r.id }));
  const repeated = edit(
    store,
    r,
    { action: 'update', schedule: { timeZone: 'UTC', time: '09:00', kind: 'daily' } },
    c,
  );
  assert.equal(repeated.paused, true);
  assert.equal(repeated.version, version);
  const resume = request(store, 'Resume the water reminder.');
  edit(store, r, { action: 'resume' }, resume);
  store.mutate((s) => routineCommand(s, 'routine.archive', { id: r.id }));
  assert.equal(edit(store, r, { action: 'resume' }, resume).archived, true);
});

test('edits cancel pending old reminder deliveries but retain accepted assistant work', (t) => {
  const { store, r } = fixture(t);
  store.mutate((s) => dispatchRoutines(s, r.nextRunAt));
  const old = store.read().runs.find((run) => run.routineId === r.id);
  edit(
    store,
    r,
    { action: 'update', delayMinutes: 10 },
    request(store, 'Move the water reminder to ten minutes from now.'),
  );
  assert.equal(store.read().runs.find((run) => run.id === old.id).status, 'cancelled');
  const task = store.mutate((s) =>
    routineCommand(s, 'routine.create', {
      title: 'Brief',
      instructions: 'Prepare a brief',
      execution: 'assistant',
      threadId: 'main',
      schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    }),
  );
  const accepted = store.mutate((s) => routineCommand(s, 'routine.test', { id: task.id }));
  store.mutate((s) =>
    routineCommand(s, 'routine.update', { id: task.id, instructions: 'Revised brief' }),
  );
  assert.equal(store.read().runs.find((run) => run.id === accepted.id).status, 'queued');
});

test('an explicit owner pause after a due reminder is preserved when its time changes', (t) => {
  const { store, r } = fixture(t);
  store.mutate((s) => {
    dispatchRoutines(s, r.nextRunAt);
    assert.equal(s.routines[0].pausedBySchedule, true);
    routineCommand(s, 'routine.pause', { id: r.id });
  });
  const next = edit(
    store,
    r,
    { action: 'update', delayMinutes: 10 },
    request(store, 'Move the water reminder to ten minutes from now.'),
  );
  assert.equal(next.paused, true);
  assert.equal(next.pausedBySchedule, false);
});

test('saved change receipts survive SQLite reopening and reject replay over later owner edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reminder-change-'));
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  try {
    const first = request(store, 'Remind me in five minutes to drink water.');
    const r = store.mutate((s) => createReminder(s, { text: 'Water.', delayMinutes: 5 }, first));
    const c = request(store, 'Move the water reminder to ten minutes from now.');
    const changed = edit(store, r, { action: 'update', delayMinutes: 10 }, c);
    store.mutate((s) => routineCommand(s, 'routine.archive', { id: r.id }));
    store.close();
    store = new Store(join(directory, 'state.sqlite'));
    const replay = edit(store, r, { action: 'update', delayMinutes: 10 }, c);
    assert.equal(replay.archived, true);
    assert.equal(replay.version, changed.version);
    assert.equal(store.read().routines.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rescheduled reminder delivers only its new text and cancellation prevents delivery', async (t) => {
  const { store, r } = fixture(t);
  store.mutate((s) => {
    dispatchRoutines(s, r.nextRunAt);
    for (const run of s.runs) if (!run.routineId) run.status = 'completed';
  });
  const c = request(
    store,
    'Change the water reminder to one minute from now. Use the reminder text exactly: Revised water.',
  );
  const next = edit(store, r, { action: 'update', text: 'Revised water', delayMinutes: 1 }, c);
  store.mutate((s) => {
    s.runs.find((run) => run.id === c.runId).status = 'completed';
    dispatchRoutines(s, next.nextRunAt);
  });
  const worker = new BackgroundWorker(
    store,
    {
      mode: 'sample',
      provider: {
        configured: false,
        complete() {
          throw Error('Must not use AI');
        },
      },
    },
    { pollMs: 10 },
  );
  worker.start();
  try {
    const until = Date.now() + 3000;
    while (!store.read().messages.some((m) => m.routineId === r.id)) {
      assert(Date.now() < until, JSON.stringify(store.read().runs));
      await new Promise((done) => setTimeout(done, 10));
    }
  } finally {
    await worker.stop();
  }
  assert.deepEqual(
    store
      .read()
      .messages.filter((m) => m.routineId === r.id)
      .map((m) => m.text),
    ['Revised water.'],
  );
  const cancel = request(store, 'Cancel the water reminder.');
  edit(store, r, { action: 'cancel' }, cancel);
  store.mutate((s) => dispatchRoutines(s, next.nextRunAt + 86400000));
  assert.equal(
    store.read().runs.filter((run) => run.routineId === r.id && run.status === 'queued').length,
    0,
  );
});

test('tools enforce assistant ownership, owner provenance and restricted routine boundaries', async (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Cancel the water reminder.');
  const input = { id: r.id, changeToken: reminderChangeToken(r), action: 'cancel' };
  await assert.rejects(
    executeTool(store, 'change_reminder', input, { ...c, routineRun: true }),
    /routine cannot/,
  );
  await assert.rejects(
    executeTool(store, 'change_reminder', input, { ...c, sourceMessageId: 'unknown' }),
    /owner request/,
  );
  const other = store.mutate((s) =>
    command(s, 'assistant.create', { name: 'Mika', description: 'Another assistant' }),
  );
  await assert.rejects(
    executeTool(store, 'change_reminder', input, { ...c, threadId: other.threadId }),
    /different assistant/,
  );
  assert.equal(store.read().routines[0].archived, false);
  const result = await executeTool(store, 'manage_routine', { id: r.id, action: 'archive' }, c);
  assert.deepEqual(result.card, { kind: 'reminder', id: r.id });
  assert.equal(result.result.archived, true);
  assert.equal(result.result.reminderChanges, undefined);
});

test('voice changes preload read/write tools, suppress invented success and survive durable replay', async (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Move the water reminder to ten minutes from now.');
  c.run.voiceCallId = 'recognized-text';
  let rounds = 0;
  const spoken = [];
  const provider = {
    complete: async (messages, tools, options) => {
      rounds++;
      assert(tools.some((tool) => tool.name === 'change_reminder'));
      assert(tools.some((tool) => tool.name === 'list_routines'));
      if (rounds === 1) {
        options.onText('Moved.');
        return { text: 'Moved.', toolCalls: [] };
      }
      if (rounds === 2) return { text: '', toolCalls: [call('list_routines', {})] };
      if (rounds === 3) {
        const found = JSON.parse(messages.at(-1).content).result[0];
        return {
          text: '',
          toolCalls: [
            call('change_reminder', {
              id: found.id,
              changeToken: found.changeToken,
              action: 'update',
              delayMinutes: 10,
            }),
          ],
        };
      }
      assert.equal(options.requiresTools, false);
      options.onText('In ten minutes exactly.');
      return { text: 'In ten minutes exactly.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    c.run,
    {},
    { durable: true, onText: (text) => spoken.push(text) },
  );
  assert.deepEqual(spoken, ['Reminder updated.']);
  assert.deepEqual(result.cards, [{ kind: 'reminder', id: r.id }]);
  assert.deepEqual(await agentReply(store, provider, c.run, {}, { durable: true }), result);
  assert.equal(rounds, 4);
  assert.equal(store.read().routines.length, 1);
});

test('ambiguous changes can ask one question without modifying reminders; navigation alone cannot attest success', async (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Cancel the reminder.');
  const before = store.read().routines;
  const result = await agentReply(
    store,
    {
      complete: async () => ({
        text: '',
        toolCalls: [
          call('ask_question', {
            prompt: 'Which reminder do you mean?',
            options: [{ label: 'Water' }, { label: 'Stretch' }],
          }),
        ],
      }),
    },
    c.run,
    {},
  );
  assert(result.question);
  assert.deepEqual(store.read().routines, before);
  const next = request(store, 'Cancel the water reminder.');
  await assert.rejects(
    agentReply(
      store,
      { complete: async () => ({ text: 'Cancelled.', toolCalls: [] }) },
      next.run,
      {},
    ),
    /change was not saved/,
  );
  assert.equal(store.read().routines.find((x) => x.id === r.id).archived, false);
});

test('a plain model clarification becomes a grounded native choice without saving a change', async (t) => {
  const { store } = fixture(t);
  store.mutate((s) =>
    routineCommand(s, 'routine.create', {
      title: 'Stretch',
      instructions: 'Stretch.',
      execution: 'reminder',
      threadId: 'main',
      schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    }),
  );
  const c = request(store, 'Move my reminder to 10 AM.');
  let rounds = 0;
  const spoken = [];
  const provider = {
    complete: async (_messages, _tools, options) => {
      if (++rounds === 1) return { text: '', toolCalls: [call('list_routines', {})] };
      const text = 'Which reminder should I move: Drink water. or Stretch?';
      options.onText(text);
      return { text, toolCalls: [] };
    },
  };
  const before = store.read().routines;
  const result = await agentReply(
    store,
    provider,
    c.run,
    {},
    { onText: (text) => spoken.push(text) },
  );
  assert(result.question);
  assert.deepEqual(result.question.options.map((o) => o.label).sort(), ['Drink water.', 'Stretch']);
  assert.deepEqual(store.read().routines, before);
  assert.deepEqual(spoken, []);
  assert.equal(rounds, 2);
  const answer = request(store, 'Drink water.');
  answer.run.questionContext = {
    origin: { request: 'Move my reminder to 10 AM.', assistant: answer.run.assistant },
    answers: [{ prompt: result.question.prompt, answer: 'Drink water.' }],
  };
  await assert.rejects(
    agentReply(
      store,
      { complete: async () => ({ text: 'Moved.', toolCalls: [] }) },
      answer.run,
      {},
    ),
    /change was not saved/,
  );
  assert.deepEqual(store.read().routines, before);
  for (const [text, calls] of [
    ['Which reminder: Drink water. or Stretch?', []],
    ['Changed Drink water. and Stretch.', ['list_routines']],
    ['Which one: unknown or nonexistent?', ['list_routines']],
  ])
    assert.equal(reminderChoiceQuestion(store.read(), text, calls), null);
});

test('current change confirmations report later owner state and recognition excludes advice/quotes/negation', (t) => {
  const { store, r } = fixture(t),
    c = request(store, 'Pause the water reminder.');
  edit(store, r, { action: 'pause' }, c);
  const reply = () =>
    reminderChangeConfirmation(
      store.read(),
      c.run,
      [{ kind: 'reminder', id: r.id }],
      ['change_reminder'],
    );
  assert.equal(reply(), 'Your reminder is paused.');
  store.mutate((s) => routineCommand(s, 'routine.archive', { id: r.id }));
  assert.equal(reply(), 'Reminder cancelled.');
  for (const text of [
    'Cancel the water reminder.',
    'Please move my reminder to 9 AM.',
    '取消喝水提醒',
    '请修改明天的提醒',
  ])
    assert(reminderChangeRequested(text));
  for (const text of [
    'How do I cancel a reminder?',
    'Do not cancel the reminder.',
    '> Cancel the reminder.',
    'Cancel an email.',
    'Explain reminder changes.',
    '取消提醒的示例是什么？',
  ])
    assert.equal(reminderChangeRequested(text), false, text);
  const view = reminderView(store.read().routines[0]);
  assert(view.changeToken);
  assert.equal(view.reminderChanges, undefined);
});
