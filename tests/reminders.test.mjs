// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import {
  createReminder,
  reminderRequested,
  reminderConfirmation,
  exactReminderText,
  exactReminderTitle,
} from '../server/reminders.mjs';
import { command } from '../shared/domain.mjs';
import { routineCommand, dispatchRoutines } from '../shared/routines.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
const at = Date.parse('2026-10-18T00:00:23.456Z');
function request(store, text = 'Remind me to drink water in five minutes.', requestedAt = at) {
  return store.mutate((s) => {
    s.profile.memoryLearning = false;
    const run = command(s, 'chat.send', { threadId: 'main', text });
    s.messages.find((m) => m.id === run.messageId).createdAt = new Date(requestedAt).toISOString();
    return {
      threadId: 'main',
      sourceMessageId: run.messageId,
      runId: run.id,
      now: requestedAt + 30000,
    };
  });
}
function fixture(t) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  return store;
}
const save = (store, input, context) => store.mutate((s) => createReminder(s, input, context));

test('one explicit reminder name retains its quoted or fully timed boundary', () => {
  for (const [request, name] of [
    [
      'Create a daily reminder called Water the fern at 09:00 in Asia/Shanghai. Its reminder text is "Water."',
      'Water the fern',
    ],
    [
      'Please set up a weekly reminder named Lunch at the park at 12:30 in America/New_York.',
      'Lunch at the park',
    ],
    ['Save a reminder titled "Water at 09:00" at 10:00.', 'Water at 09:00'],
    ['Create a reminder named “喝水 🌱”. Start it paused.', '喝水 🌱'],
    ["Schedule a reminder called 'Break time'", 'Break time'],
  ])
    assert.equal(exactReminderTitle(request), name, request);
});

test('ambiguous, quoted, negated and multiple reminder names are not inferred', () => {
  for (const request of [
    '',
    null,
    'Create a reminder called Lunch at the park.',
    'Create a reminder named Water at 09:00.',
    'Create a reminder named Water at 25:00 in UTC.',
    'Create a reminder named Water at 09:00 in Mars/Olympus.',
    'Do not create a reminder named Water at 09:00 in UTC.',
    'Explain how to create a reminder named Water at 09:00 in UTC.',
    '"Create a reminder named Water at 09:00 in UTC."',
    'Create a reminder named "Water" and another reminder named "Stretch".',
    'Create a reminder named Water at 09:00 in UTC. Create another reminder at 10:00.',
    'Create a reminder named "Water" or "Stretch".',
    'Create a reminder named "Line one\nLine two".',
  ])
    assert.equal(exactReminderTitle(request), null, String(request));
});

test('literal reminder declarations preserve quoted text or a clearly separate pause sentence', () => {
  for (const [request, expected] of [
    [
      'Create a daily reminder. Its reminder text is FERN-123: water the fern. Start it paused so I can enable it later.',
      'FERN-123: water the fern',
    ],
    [
      'Create a reminder. The reminder text is Call Dr. Lee at 3.5 hours. Keep this reminder paused for now.',
      'Call Dr. Lee at 3.5 hours',
    ],
    [
      'Its reminder text is Visit https://example.test/a?day=1. Leave it paused.',
      'Visit https://example.test/a?day=1',
    ],
    ['The reminder text is "Water the fern."', 'Water the fern.'],
    ["Its reminder text is 'Water the fern!'. Start it paused.", 'Water the fern!'],
    ['Create tomorrow’s reminder. Its reminder text is ‘Drink water.’', 'Drink water.'],
    [
      'The reminder text is “Start it paused. Then say hello!” Start it paused.',
      'Start it paused. Then say hello!',
    ],
    ['Create a reminder. Its reminder text is 「下午喝水。🌱」. Keep it paused.', '下午喝水。🌱'],
    [
      'Its reminder text is "Its reminder text is a literal phrase.". Start it paused.',
      'Its reminder text is a literal phrase.',
    ],
    [
      'Use the reminder text exactly: Water the fern. Start it paused.',
      'Water the fern. Start it paused.',
    ],
    ['Use the reminder text exactly: "Water the fern."', '"Water the fern."'],
    ['提醒內容請只寫：該喝水了。', '該喝水了。'],
  ])
    assert.equal(exactReminderText(request), expected, request);
});

test('ambiguous declarations, quoted examples and code never replace model-supplied reminder text', () => {
  for (const request of [
    null,
    '',
    'Remind me about its reminder text is important.',
    'Its reminder text is Call Dr. Lee. Then send me a different message.',
    'Its reminder text is Water the fern.',
    'Its reminder text is Water. Start it paused until next week.',
    'Its reminder text is "Water." Actually use a different text.',
    'Its reminder text is "First." Its reminder text is "Second."',
    'Its reminder text is "Line one\nLine two".',
    'Its reminder text is "Say \\"hello\\"".',
    'Its reminder text is "".',
    'Example: "Use the reminder text exactly: wrong"',
    "Example: 'Use the reminder text exactly: wrong'",
    "Example: 'The sender's note says Use the reminder text exactly: wrong'",
    'Example: "The note says \\"Use the reminder text exactly: wrong\\""',
    'Example: ‘Use the reminder text exactly: wrong’',
    '> Use the reminder text exactly: wrong',
    '```\nUse the reminder text exactly: wrong\n```',
    'Example only:\n```\nIts reminder text is "Wrong."',
    'Example only:\n```\nUse the reminder text exactly: wrong',
    '`Its reminder text is Water. Start it paused.`',
    '“Its reminder text is Water. Start it paused.”',
  ])
    assert.equal(exactReminderText(request), null, String(request));
});

test('both reminder creation tools preserve the declared payload without adding delivery instructions', async (t) => {
  const store = fixture(t);
  for (const tool of ['create_reminder', 'create_routine']) {
    const c = request(
      store,
      'Create a daily reminder called Water the fern at 09:00 in Asia/Shanghai. Its reminder text is FERN-123: water the fern. Start it paused so I can enable it later.',
    );
    const schedule = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
    const result = await executeTool(
      store,
      tool,
      {
        title: 'FERN-123: water the fern at 09:00',
        schedule,
        ...(tool === 'create_reminder'
          ? { text: 'Send a reminder message: FERN-123: water the fern', paused: true }
          : {
              instructions: 'Send a reminder message: FERN-123: water the fern',
              execution: 'reminder',
            }),
      },
      c,
    );
    assert.equal(result.result.instructions, 'FERN-123: water the fern');
    assert.equal(result.result.title, 'Water the fern');
    assert.equal(result.result.paused, true);
    assert.deepEqual(result.card, { kind: 'reminder', id: result.result.id });
  }
});

test('an assistant routine retains work instructions even when its request contains a reminder literal', async (t) => {
  const store = fixture(t),
    c = request(
      store,
      'Create a routine that checks my calendar. The reminder text is "Time for a break."',
    );
  const instructions = 'Read the calendar and prepare a summary.';
  const result = await executeTool(
    store,
    'create_routine',
    {
      title: 'Calendar brief',
      instructions,
      execution: 'assistant',
      schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    },
    c,
  );
  assert.equal(result.result.instructions, instructions);
  assert.equal(result.result.execution, 'assistant');
});

test('the same explicitly named reminder is not duplicated when a retry changes model-generated labels', (t) => {
  const store = fixture(t),
    c = request(
      store,
      'Create a daily reminder called Water at 09:00 in UTC. Its reminder text is "Water the fern."',
    );
  const input = {
    title: 'Water at 09:00',
    text: 'Send a reminder to water',
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    paused: true,
  };
  const first = save(store, input, c);
  const retry = save(
    store,
    { ...input, title: 'Water the fern', text: 'Please send the reminder' },
    c,
  );
  assert.equal(retry.id, first.id);
  assert.equal(retry.title, 'Water');
  assert.equal(retry.instructions, 'Water the fern.');
  assert.equal(store.read().routines.length, 1);
});

test('relative reminders start enabled, preserve seconds and use request time rather than model completion', (t) => {
  const store = fixture(t),
    context = request(store);
  const r = save(store, { text: 'Drink water', delayMinutes: 5 }, context);
  assert.equal(r.execution, 'reminder');
  assert.equal(r.paused, false);
  assert.equal(r.nextRunAt, at + 300000);
  assert.equal(r.schedule.at, r.nextRunAt);
  assert.equal(r.instructions, 'Drink water');
  assert.equal(r.reminderRelative, true);
  assert.deepEqual(r.creation, { runId: context.runId, sourceMessageId: context.sourceMessageId });
  const late = request(store, 'Remind me in one minute to stretch.', at);
  const overdue = save(store, { text: 'Stretch', delayMinutes: 1 }, { ...late, now: at + 90000 });
  assert.equal(overdue.nextRunAt, at + 60000);
  const exact = request(
    store,
    'Remind me in five minutes. Use the reminder text exactly: Water the fern.',
  );
  assert.equal(
    save(store, { text: 'Water the fern', delayMinutes: 5 }, exact).instructions,
    'Water the fern.',
  );
  const chinese = request(store, '五分钟后提醒我喝水。提醒内容请只写：该喝水了。');
  assert.equal(save(store, { text: '喝水', delayMinutes: 5 }, chinese).instructions, '该喝水了。');
});

test('relative instants preserve the second DST fold and explicit schedules use the saved timezone', (t) => {
  const store = fixture(t);
  store.mutate((s) => {
    s.profile.timeZone = 'America/New_York';
  });
  const stamp = Date.parse('2026-11-01T06:00:30.123Z');
  const c = request(store, 'Remind me to stretch in 30 minutes.', stamp);
  const r = save(store, { text: 'Stretch', delayMinutes: 30 }, c);
  assert.equal(r.schedule.at, Date.parse('2026-11-01T06:30:30.123Z'));
  assert.equal(r.schedule.time, '01:30');
  const daily = save(
    store,
    { text: 'Water the fern', schedule: { kind: 'daily', time: '09:00' } },
    c,
  );
  assert.equal(daily.schedule.timeZone, 'America/New_York');
  assert.equal(daily.paused, false);
  const paused = save(
    store,
    { text: 'Paused draft', schedule: { kind: 'daily', time: '09:00' }, paused: true },
    c,
  );
  assert.equal(paused.paused, true);
});

test('repeated scheduling is idempotent and cannot undo a later owner pause or archive', (t) => {
  const store = fixture(t),
    c = request(store),
    input = { text: 'Water', delayMinutes: 5 };
  const first = save(store, input, c);
  store.mutate((s) => routineCommand(s, 'routine.pause', { id: first.id }, c.now));
  const second = save(store, input, { ...c, now: c.now + 20000 });
  assert.equal(second.id, first.id);
  assert.equal(second.paused, true);
  store.mutate((s) => {
    s.profile.timeZone = 'Asia/Shanghai';
  });
  assert.equal(save(store, input, c).id, first.id);
  store.mutate((s) => routineCommand(s, 'routine.archive', { id: first.id }, c.now));
  assert.equal(save(store, input, c).archived, true);
  assert.equal(store.read().routines.length, 1);
});

test('editing a relative reminder adopts the explicit timezone and exact instants cannot override public schedules', (t) => {
  const store = fixture(t),
    c = request(store);
  const r = save(store, { text: 'Water', delayMinutes: 5 }, c);
  store.mutate((s) =>
    routineCommand(
      s,
      'routine.update',
      {
        id: r.id,
        schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      },
      at,
    ),
  );
  assert.equal(store.read().routines[0].reminderRelative, false);
  const date = new Date(Date.now() + 172800000).toISOString().slice(0, 10);
  const payload = {
    title: 'Mismatch',
    instructions: 'Water',
    execution: 'reminder',
    threadId: 'main',
    schedule: { kind: 'once', date, time: '09:00', timeZone: 'UTC' },
  };
  assert.throws(
    () => store.mutate((s) => routineCommand(s, 'routine.create', payload, at, { reminderAt: at })),
    /displayed time/,
  );
  const publicReminder = store.mutate((s) =>
    command(s, 'routine.create', { ...payload, reminderAt: at }),
  );
  assert.equal(publicReminder.schedule.at, Date.parse(`${date}T09:00:00Z`));
});

test('invalid reminder arguments, missing zones and unrelated requests cannot create work', async (t) => {
  const store = fixture(t),
    c = request(store);
  for (const input of [
    { text: 'Water' },
    { text: '', delayMinutes: 1 },
    { text: 'Water', delayMinutes: 0 },
    { text: 'Water', delayMinutes: 1.5 },
    { text: 'Water', delayMinutes: 525601 },
    { text: 'Water', delayMinutes: 1, schedule: {} },
    { text: 'Water', delayMinutes: 1, paused: 'false' },
    { text: 'Water', schedule: { kind: 'daily', time: '09:00' } },
    { text: 'Water', schedule: { kind: 'email', timeZone: 'UTC' } },
    { text: 'Water', delayMinutes: 1, execution: 'assistant' },
  ])
    assert.throws(() => save(store, input, c));
  assert.throws(
    () => save(store, { text: 'Water', delayMinutes: 1 }, { ...c, runId: 'unrelated' }),
    /owner request/,
  );
  assert.equal(store.read().routines.length, 0);
  await assert.rejects(
    executeTool(
      store,
      'create_reminder',
      { text: 'Water', delayMinutes: 1 },
      { ...c, routineRun: true },
    ),
    /routine cannot create/,
  );
});

test('legacy paused reminder creation also preserves exact owner text and returns inline controls', async (t) => {
  const store = fixture(t),
    c = request(
      store,
      'Remind me daily at 9 AM UTC, paused. Use the reminder text exactly: Water the fern.',
    );
  const result = await executeTool(
    store,
    'create_routine',
    {
      title: 'Water',
      instructions: 'Water the fern',
      execution: 'reminder',
      schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    },
    c,
  );
  assert.equal(result.result.instructions, 'Water the fern.');
  assert.equal(result.result.paused, true);
  assert.deepEqual(result.card, { kind: 'reminder', id: result.result.id });
  const run = store.read().runs.find((r) => r.id === c.runId);
  assert.equal(
    reminderConfirmation(store.read(), run, [result.card], ['create_routine']),
    'Reminder saved and paused.',
  );
});

test('a paused reminder cancels queued delivery while ordinary paused tasks retain their existing work', (t) => {
  const store = fixture(t),
    c = request(store);
  const r = save(store, { text: 'Water', delayMinutes: 1 }, c);
  store.mutate((s) => {
    dispatchRoutines(s, at + 60000);
    routineCommand(s, 'routine.pause', { id: r.id }, at + 60000);
  });
  assert.equal(store.read().runs.find((run) => run.routineId === r.id).status, 'cancelled');
  assert.equal(store.read().messages.filter((m) => m.routineId === r.id).length, 0);
  store.mutate((s) => {
    const task = routineCommand(
      s,
      'routine.create',
      {
        title: 'Prepare a brief',
        instructions: 'Prepare a brief',
        threadId: 'main',
        execution: 'assistant',
        schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
      },
      at,
    );
    const run = routineCommand(s, 'routine.test', { id: task.id }, at);
    routineCommand(s, 'routine.pause', { id: task.id }, at);
    assert.equal(run.status, 'queued');
  });
});

test('natural reminder requests preload the direct schema and require actual saved work before confirmation', async (t) => {
  const store = fixture(t),
    c = request(store, 'Remind me in five minutes to drink water.', Date.now());
  const run = store.read().runs.find((r) => r.id === c.runId);
  run.voiceCallId = 'voice-test';
  let rounds = 0;
  const spoken = [];
  const provider = {
    complete: async (messages, tools, options) => {
      rounds++;
      assert(tools.some((tool) => tool.name === 'create_reminder'));
      if (rounds === 1) {
        options.onText('Scheduled.');
        return { text: 'Scheduled.', toolCalls: [] };
      }
      if (rounds === 2 || rounds === 3)
        return {
          text: '',
          toolCalls: [
            {
              id: `remind-${rounds}`,
              type: 'function',
              function: {
                name: 'create_reminder',
                arguments: JSON.stringify({ text: 'Drink water', delayMinutes: 5 }),
              },
            },
          ],
        };
      assert.equal(options.requiresTools, false);
      options.onText('I will remind you in five minutes.');
      return { text: 'I will remind you in five minutes.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    { durable: true, onText: (s) => spoken.push(s) },
  );
  assert.equal(store.read().routines[0].paused, false);
  assert.deepEqual(spoken, ['Reminder scheduled.']);
  assert.equal(result.cards.filter((card) => card.kind === 'reminder').length, 1);
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(store.read().routines.length, 1);
  for (const text of [
    'Remind me what I said yesterday.',
    'Remind me in which city we met.',
    'Remind me on what day the party is.',
    '> Remind me to drink water.',
    'Do not remind me to drink water.',
    '提醒我之前说过什么',
    'Explain reminders.',
  ])
    assert.equal(reminderRequested(text), false, text);
  for (const text of ['Remind me tomorrow to call home.', '提醒我喝水', '十分钟后提醒我喝水'])
    assert(reminderRequested(text), text);
});

test('reminder-only confirmations use live delivery state instead of stale model timing', (t) => {
  const store = fixture(t),
    c = request(store);
  const r = save(store, { text: 'Water', delayMinutes: 1 }, { ...c, now: at + 90000 });
  const run = store.read().runs.find((r) => r.id === c.runId),
    cards = [{ kind: 'reminder', id: r.id }];
  const receipt = () =>
    reminderConfirmation(store.read(), run, cards, ['create_reminder'], at + 90000);
  assert.equal(receipt(), 'Your reminder is due now and waiting to be delivered.');
  store.mutate((s) => {
    dispatchRoutines(s, at + 90000);
    s.runs.find((run) => run.routineId === r.id).status = 'completed';
  });
  assert.equal(receipt(), 'Scheduling took too long; your reminder arrived late.');
  assert.equal(
    reminderConfirmation(store.read(), run, cards, ['web_search', 'create_reminder']),
    null,
  );
  assert.equal(
    reminderConfirmation(
      store.read(),
      run,
      [...cards, { kind: 'file', id: 'file' }],
      ['create_reminder'],
    ),
    null,
  );
  store.mutate((s) => {
    const reminder = s.routines.find((item) => item.id === r.id);
    reminder.version++;
    s.runs.push({
      id: 'redelivery',
      routineId: r.id,
      routineVersion: reminder.version,
      trigger: 'schedule',
      status: 'queued',
    });
  });
  assert.equal(receipt(), 'Your reminder is due now and waiting to be delivered.');
  store.mutate((s) => routineCommand(s, 'routine.archive', { id: r.id }, at));
  assert.equal(receipt(), 'Reminder cancelled.');
});

test('a reminder survives restart and delivers exactly once without an AI provider or open browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-direct-reminder-')),
    path = join(dir, 'workspace.sqlite');
  let store = new Store(path, { sample: false }),
    worker;
  try {
    const c = request(
      store,
      'Remind me in one minute. Its reminder text is "Time for water."',
      Date.now() - 120000,
    );
    const r = save(
      store,
      { text: 'Send a reminder message: Time for water.', delayMinutes: 1 },
      { ...c, now: Date.now() },
    );
    store.mutate((s) => {
      s.runs.find((run) => run.id === c.runId).status = 'completed';
      s.threads[0].draft = 'Keep this draft';
    });
    store.close();
    store = new Store(path);
    recoverWork(store);
    const services = {
      mode: 'sample',
      provider: {
        configured: false,
        complete: () => {
          throw new Error('A fixed reminder must not call AI');
        },
      },
    };
    worker = new BackgroundWorker(store, services, { pollMs: 10 });
    worker.start();
    const until = async (check) => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        assert(Date.now() < deadline, 'Reminder did not arrive');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(() =>
      store.read().runs.some((run) => run.routineId === r.id && run.status === 'completed'),
    );
    await worker.stop();
    worker = null;
    assert.equal(store.read().messages.filter((m) => m.routineId === r.id).length, 1);
    assert.equal(store.read().messages.find((m) => m.routineId === r.id).text, 'Time for water.');
    assert.equal(store.read().threads[0].draft, 'Keep this draft');
    store.close();
    store = new Store(path);
    recoverWork(store);
    worker = new BackgroundWorker(store, services, { pollMs: 10 });
    worker.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(store.read().messages.filter((m) => m.routineId === r.id).length, 1);
  } finally {
    await worker?.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
