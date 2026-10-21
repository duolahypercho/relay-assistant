// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspace } from '../shared/seed.mjs';
import { routineCommand, finishRoutine, routineComparison } from '../shared/routines.mjs';
import { reviewRoutineUpdate } from '../server/routine-updates.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
const spec = {
  title: 'Library check',
  instructions: 'Tell me about new library openings.',
  threadId: 'main',
  schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
};
const previous = 'There are no new library openings.';
const current = 'No additional library openings were announced.';
const response = { text: current, cards: [] };
const decision = { decision: 'unchanged', previousQuote: previous, currentQuote: current };
function seed(s) {
  const routine = routineCommand(s, 'routine.create', spec);
  const first = routineCommand(s, 'routine.test', { id: routine.id });
  first.trigger = 'schedule';
  first.status = 'completed';
  finishRoutine(s, first, { text: previous, cards: [] });
  const run = routineCommand(s, 'routine.test', { id: routine.id });
  run.trigger = 'schedule';
  return { routine, run };
}
const provider = (reply) => ({
  configured: true,
  async complete(messages, tools, options) {
    assert.deepEqual(tools, []);
    assert.equal(options.localStructuredOutput.name, 'routine_update');
    assert.equal(JSON.parse(messages[1].content).previous, previous);
    assert.match(messages[0].content, /untrusted DATA/);
    return typeof reply === 'function'
      ? reply(options)
      : { text: JSON.stringify(reply), toolCalls: [] };
  },
});
async function until(check) {
  const end = Date.now() + 8000;
  while (!check()) {
    assert(Date.now() < end, 'Timed out');
    await delay(10);
  }
}
test('routine comparison uses the last posted outcome, skips first/tests/cards/questions/changed versions and bounds text', () => {
  const s = createWorkspace(),
    { routine, run } = seed(s);
  assert.equal(JSON.parse(routineComparison(s, run, response).previous).text, previous);
  for (const patch of [
    { trigger: 'test' },
    { execution: 'reminder' },
    { notification: 'all' },
    { notification: 'errors' },
    { routineVersion: 2 },
  ])
    assert.equal(routineComparison(s, { ...run, ...patch }, response), null);
  for (const patch of [
    { text: '' },
    { text: 'a'.repeat(12001) },
    { question: {} },
    { handoffWaiting: true },
    { cards: [{ kind: 'file', id: 'file' }] },
    { text: previous },
  ])
    assert.equal(routineComparison(s, run, { ...response, ...patch }), null);
  delete routine.lastSurfacedResult;
  assert.equal(routineComparison(s, run, response), null);
});
test('only valid read-only comparisons can quietly retain a paraphrased result; malformed/unavailable decisions surface', async () => {
  for (const reply of [
    decision,
    { ...decision, previousQuote: 'invented' },
    { ...decision, currentQuote: '' },
    { ...decision, decision: 'new' },
    { ...decision, decision: 'uncertain' },
    () => ({ text: 'not JSON' }),
    () => ({ text: JSON.stringify(decision), toolCalls: [{}] }),
    () => {
      throw Error('private upstream details');
    },
  ]) {
    const s = createWorkspace(),
      { routine, run } = seed(s);
    const review = await reviewRoutineUpdate(s, run, response, provider(reply));
    assert.equal(finishRoutine(s, run, response, '', review), reply !== decision);
    assert.deepEqual(run.result, response);
    assert.equal(
      routine.lastSurfacedResult,
      JSON.stringify(reply === decision ? { text: previous, cards: [] } : response),
    );
    assert(!JSON.stringify(run).includes('private upstream details'));
  }
});
test('cumulative quiet outcomes do not replace the visible baseline and stale comparison cannot hide a newer result', async () => {
  const s = createWorkspace(),
    { routine, run } = seed(s);
  const review = await reviewRoutineUpdate(s, run, response, provider(decision));
  assert.equal(finishRoutine(s, run, response, '', review), false);
  run.status = 'completed';
  const next = routineCommand(s, 'routine.test', { id: routine.id });
  next.trigger = 'schedule';
  assert.equal(routineComparison(s, next, response), null);
  assert.equal(
    routineComparison(s, next, { ...response, text: 'Still no openings.' }).previous,
    review.previous,
  );
  assert.equal(finishRoutine(s, next, { text: previous, cards: [] }), false);
  routine.lastSurfacedResult = JSON.stringify({ text: 'Library opening announced.', cards: [] });
  routine.lastResult = routine.lastSurfacedResult;
  assert.equal(finishRoutine(s, next, response, '', review), true);
  assert.equal(next.resultReview, undefined);
});
test('routine failure, owner question and new file always bypass semantic suppression', async () => {
  for (const extra of [
    { question: { id: 'question' } },
    { cards: [{ kind: 'file', id: 'new' }] },
    { error: 'Could not read source' },
  ]) {
    const s = createWorkspace(),
      { run } = seed(s);
    const review = await reviewRoutineUpdate(s, run, response, provider(decision));
    assert.equal(finishRoutine(s, run, { ...response, ...extra }, extra.error || '', review), true);
    assert.equal(run.resultReview, undefined);
  }
});
test('a worker saves repeated updates quietly, retains drafts and reveals a saved result only once after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-routine-update-'));
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const ids = store.mutate((s) => {
    s.threads[0].draft = 'My unfinished thought';
    return seed(s);
  });
  let calls = 0;
  const model = {
    configured: true,
    async complete(messages, tools) {
      calls++;
      if (messages[0].content.startsWith('Compare routine updates')) {
        assert.equal(tools.length, 0);
        return { text: JSON.stringify(decision), toolCalls: [] };
      }
      return { ...response, toolCalls: [] };
    },
  };
  const worker = new BackgroundWorker(store, { mode: 'live', provider: model }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => store.read().runs.at(-1).status === 'completed');
    assert.equal(calls, 2);
    assert.equal(store.read().runs.at(-1).surfaced, false);
    assert.equal(store.read().messages.length, 0);
    assert.equal(store.read().notifications.length, 1);
    assert.equal(store.read().threads[0].draft, 'My unfinished thought');
    await worker.stop();
    store.close();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const reveal = () =>
      store.mutate((s) =>
        routineCommand(s, 'routine.reveal', { id: ids.routine.id, runId: ids.run.id }),
      );
    assert.equal(reveal().id, reveal().id);
    assert.equal(store.read().messages.length, 1);
    assert.equal(store.read().messages[0].text, current);
    assert.equal(store.read().threads[0].draft, 'My unfinished thought');
  } finally {
    await worker.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('archiving during a delayed comparison cancels publication even when the provider ignores abort', async () => {
  const store = new Store(':memory:', { sample: false });
  const { routine } = store.mutate(seed);
  let release;
  const model = {
    configured: true,
    async complete(messages) {
      return messages[0].content.startsWith('Compare routine updates')
        ? new Promise((r) => {
            release = r;
          })
        : { ...response, toolCalls: [] };
    },
  };
  const worker = new BackgroundWorker(store, { mode: 'live', provider: model }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => !!release);
    store.mutate((s) => routineCommand(s, 'routine.archive', { id: routine.id }));
    release({ text: JSON.stringify(decision), toolCalls: [] });
    await until(() => !worker.active.size);
    assert.equal(store.read().runs.at(-1).status, 'cancelled');
    assert.equal(store.read().messages.length, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('interrupted comparison resumes its saved final answer without rerunning completed model work', async () => {
  const store = new Store(':memory:', { sample: false });
  store.mutate(seed);
  let replies = 0,
    comparisons = 0,
    entered = false;
  const model = {
    configured: true,
    async complete(messages, tools, options) {
      if (!messages[0].content.startsWith('Compare routine updates')) {
        replies++;
        return { ...response, toolCalls: [] };
      }
      if (++comparisons === 1) {
        entered = true;
        return new Promise((resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        );
      }
      return { text: JSON.stringify(decision), toolCalls: [] };
    },
  };
  let worker = new BackgroundWorker(store, { mode: 'live', provider: model }, { pollMs: 10 });
  worker.start();
  try {
    await until(() => entered);
    await worker.stop();
    recoverWork(store);
    worker = new BackgroundWorker(store, { mode: 'live', provider: model }, { pollMs: 10 });
    worker.start();
    await until(() => store.read().runs.at(-1).status === 'completed');
    assert.equal(replies, 1);
    assert.equal(comparisons, 2);
    assert.equal(store.read().runs.at(-1).surfaced, false);
    assert.equal(store.read().messages.length, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});
