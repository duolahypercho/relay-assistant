import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import {
  validateSchedule,
  nextOccurrence,
  wallTime,
  routineCommand,
  dispatchRoutines,
  finishRoutine,
} from '../shared/routines.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { executeTool } from '../server/agent.mjs';

const when = Date.parse('2026-10-09T00:00:00Z');
const spec = {
  title: 'Morning check',
  instructions: 'Review my calendar',
  threadId: 'main',
  schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
};
const services = { mode: 'sample', provider: { configured: false } };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for routine.');
    await delay(10);
  }
}
test('routine schedules use explicit zones, handle DST gaps/folds once, and reject invalid input', () => {
  const ny = validateSchedule({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' });
  assert.equal(
    new Date(nextOccurrence(ny, Date.parse('2026-03-08T05:00:00Z'))).toISOString(),
    '2026-03-09T06:30:00.000Z',
  );
  const fold = validateSchedule({ kind: 'daily', time: '01:30', timeZone: 'America/New_York' });
  assert.equal(
    new Date(nextOccurrence(fold, Date.parse('2026-11-01T04:00:00Z'))).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    new Date(nextOccurrence(fold, Date.parse('2026-11-01T05:30:00Z'))).toISOString(),
    '2026-11-02T06:30:00.000Z',
  );
  const weekdays = validateSchedule({
    kind: 'weekly',
    time: '08:00',
    timeZone: 'Asia/Kathmandu',
    days: [1, 2, 3, 4, 5],
  });
  assert.equal(
    new Date(nextOccurrence(weekdays, Date.parse('2026-10-09T04:00:00Z'))).toISOString(),
    '2026-10-12T02:15:00.000Z',
  );
  assert.throws(
    () => validateSchedule({ kind: 'interval', minutes: 1, timeZone: 'UTC' }),
    /5 minutes/,
  );
  assert.throws(() => validateSchedule({ ...ny, timeZone: 'Somewhere' }), /time zone/);
  assert.throws(() => validateSchedule({ ...weekdays, days: [] }), /at least one/);
  assert.throws(
    () =>
      validateSchedule({
        kind: 'once',
        date: '2026-03-08',
        time: '02:30',
        timeZone: 'America/New_York',
      }),
    /does not exist/,
  );
  assert.throws(() => wallTime('2026-02-30', '12:00', 'UTC'), /valid date/);
});
test('due dispatch is idempotent, catches up once, and snapshots edited instructions', () => {
  const s = createWorkspace();
  delete s.routines; // Existing workspaces upgrade lazily without losing their state.
  const r = routineCommand(s, 'routine.create', spec, when);
  assert.equal(r.paused, true);
  routineCommand(s, 'routine.resume', { id: r.id }, when);
  const later = when + 5 * 86400000;
  dispatchRoutines(s, later);
  dispatchRoutines(s, later);
  assert.equal(s.runs.length, 1);
  assert.ok(r.nextRunAt > later);
  assert.equal(s.runs[0].instructions, spec.instructions);
  routineCommand(s, 'routine.update', { id: r.id, instructions: 'New method' }, later);
  assert.equal(s.runs[0].instructions, spec.instructions);
  assert.equal(r.version, 2);
  routineCommand(s, 'routine.archive', { id: r.id }, later);
  assert.equal(s.runs[0].status, 'cancelled');
  routineCommand(s, 'routine.restore', { id: r.id }, later);
  assert.equal(r.paused, true);
  assert.throws(
    () =>
      routineCommand(
        s,
        'routine.update',
        {
          id: r.id,
          schedule: { kind: 'once', date: '2020-01-01', time: '12:00', timeZone: 'UTC' },
        },
        later,
      ),
    /future/,
  );
});
test('result policy suppresses unchanged scheduled output, preserves tests/failures and keeps twenty runs', () => {
  const s = createWorkspace();
  const r = routineCommand(s, 'routine.create', spec, when);
  for (let i = 0; i < 25; i++) {
    const run = routineCommand(s, 'routine.test', { id: r.id }, when + i);
    run.trigger = 'schedule';
    run.status = 'completed';
    assert.equal(finishRoutine(s, run, { text: 'Nothing new', cards: [] }), i === 0);
  }
  assert.equal(s.runs.filter((x) => x.routineId === r.id).length, 20);
  assert.equal(s.notifications.length, 1);
  const quietRun = s.runs.at(-1);
  const revealed = routineCommand(s, 'routine.reveal', { id: r.id, runId: quietRun.id });
  assert.equal(revealed.text, 'Nothing new');
  assert.equal(
    routineCommand(s, 'routine.reveal', { id: r.id, runId: quietRun.id }).id,
    revealed.id,
  );
  assert.equal(s.messages.filter((m) => m.routineRunId === quietRun.id).length, 1);
  const run = routineCommand(s, 'routine.test', { id: r.id }, when + 30);
  assert.equal(finishRoutine(s, run, { text: 'Nothing new', cards: [] }), true);
  run.trigger = 'schedule';
  run.notification = 'errors';
  assert.equal(finishRoutine(s, run, { text: 'Fresh output', cards: [] }), false);
  assert.equal(
    finishRoutine(s, run, { text: 'Missing source', cards: [] }, 'Missing source'),
    true,
  );
});
test('routine survives SQLite reopen and runs without a browser, preserving the user draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-routine-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  const routine = store.mutate((s) => {
    const r = command(s, 'routine.create', {
      ...spec,
      instructions: 'Remember my background check',
    });
    command(s, 'routine.resume', { id: r.id });
    s.threads[0].draft = 'Unsent thought';
    r.nextRunAt = Date.now() - 5000;
    return r;
  });
  store.close();
  store = new Store(path);
  recoverWork(store);
  const worker = new BackgroundWorker(store, services, { pollMs: 10 });
  worker.start();
  try {
    await until(() =>
      store.read().runs.some((r) => r.routineId === routine.id && r.status === 'completed'),
    );
    const s = store.read();
    assert.equal(s.runs.length, 1);
    assert.equal(s.threads[0].draft, 'Unsent thought');
    assert.ok(s.memories.some((m) => m.text === 'my background check'));
    assert.equal(s.messages.filter((m) => m.role === 'user').length, 0);
    assert.equal(s.messages.filter((m) => m.routineId === routine.id).length, 1);
    assert.ok(s.routines[0].nextRunAt > Date.now());
  } finally {
    await worker.stop();
    store.close();
    await rm(dir, { recursive: true });
  }
});
test('scheduled model tools stage a fresh review and cannot create recursive automations', async () => {
  const store = new Store(':memory:');
  const routine = store.mutate((s) =>
    command(s, 'routine.create', { ...spec, instructions: 'Prepare a briefing email' }),
  );
  store.mutate((s) => command(s, 'routine.test', { id: routine.id }));
  let calls = 0;
  const provider = {
    configured: true,
    complete: async (messages, tools) => {
      assert.ok(messages.some((m) => m.content?.includes('Prepare a briefing email')));
      assert.ok(!tools.some((t) => t.name === 'create_routine'));
      return ++calls === 1
        ? {
            text: '',
            toolCalls: [
              {
                id: 'email-call',
                function: {
                  name: 'prepare_email',
                  arguments: JSON.stringify({
                    to: 'reader@example.invalid',
                    subject: 'Briefing',
                    body: 'Prepared for review',
                  }),
                },
              },
            ],
          }
        : { text: 'Please review the briefing.', toolCalls: [] };
    },
  };
  const worker = new BackgroundWorker(store, { ...services, provider }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => store.read().runs[0].status === 'completed');
    assert.equal(store.read().approvals[0].status, 'pending');
    assert.equal(store.read().mail.filter((m) => m.folder === 'sent').length, 0);
    await assert.rejects(
      executeTool(store, 'create_routine', spec, { routineRun: true }),
      /cannot create/,
    );
  } finally {
    await worker.stop();
    store.close();
  }
});
test('routine provider failures are surfaced; cancellation rejects a late provider result', async () => {
  const store = new Store(':memory:');
  const r = store.mutate((s) => command(s, 'routine.create', { ...spec, notification: 'errors' }));
  store.mutate((s) => command(s, 'routine.test', { id: r.id }));
  let resolve;
  let calls = 0;
  const provider = {
    configured: true,
    complete: async () => {
      if (++calls === 1) throw new Error('Source unavailable');
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const worker = new BackgroundWorker(store, { ...services, provider }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => store.read().runs[0].status === 'failed');
    assert.match(store.read().notifications[0].body, /Source unavailable/);
    const run = store.mutate((s) => command(s, 'routine.test', { id: r.id }));
    await until(() => !!resolve);
    store.mutate((s) => command(s, 'routine.archive', { id: r.id }));
    resolve({ text: 'Must not be posted', toolCalls: [] });
    await until(() => !worker.active.has(run.id));
    assert.equal(store.read().runs.find((x) => x.id === run.id).status, 'cancelled');
    assert.ok(!store.read().messages.some((m) => m.text === 'Must not be posted'));
  } finally {
    await worker.stop();
    store.close();
  }
});

test('a one-time reminder posts exactly once without using a provider and does not repeat after restart', async () => {
  const store = new Store(':memory:');
  store.mutate((s) => {
    const r = command(s, 'routine.create', {
      ...spec,
      execution: 'reminder',
      instructions: 'Take a stretch break',
      schedule: {
        kind: 'once',
        date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        time: '12:00',
        timeZone: 'UTC',
      },
    });
    command(s, 'routine.resume', { id: r.id });
    r.schedule.at = Date.now() - 1000;
    r.nextRunAt = r.schedule.at;
  });
  const provider = {
    configured: true,
    complete: () => {
      throw new Error('Reminders must not call the model');
    },
  };
  let worker = new BackgroundWorker(store, { ...services, provider }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => store.read().runs[0]?.status === 'completed');
    await worker.stop();
    recoverWork(store);
    worker = new BackgroundWorker(store, { ...services, provider }, { pollMs: 10 });
    worker.start();
    await delay(60);
    const s = store.read();
    assert.equal(s.runs.length, 1);
    assert.equal(s.messages.filter((m) => m.text === 'Take a stretch break').length, 1);
    assert.equal(s.routines[0].paused, true);
    assert.equal(s.routines[0].nextRunAt, null);
  } finally {
    await worker.stop();
    store.close();
  }
});
