// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { IdeasService, parseIdeas } from '../server/ideas.mjs';
import { command } from '../shared/domain.mjs';
import { ideaSources, visibleIdeas, ideaState } from '../shared/ideas.mjs';
import { learnMemory } from '../shared/memory.mjs';
import { attachQuestion } from '../shared/questions.mjs';

const raw = (extra = {}) => ({
  topic: 'walking-plan',
  title: 'Make room for a walk',
  description: 'A short walk could fit your plan.',
  prompt: 'Help me plan a short walk.',
  whyNow: 'You have an open walking goal.',
  importance: 'useful',
  notify: false,
  sources: [{ ref: 'goal:walk', quote: 'Walk outdoors' }],
  ...extra,
});
const reply = (ideas) => ({ text: JSON.stringify({ ideas }), toolCalls: [] });
function seed(store) {
  store.mutate((s) => {
    s.goals.push({
      id: 'walk',
      title: 'Walk outdoors',
      description: 'Find a short route',
      current: 0,
      target: 4,
      unit: 'walks',
    });
  });
}
function fixture({ path = ':memory:', provider, clock } = {}) {
  const store = new Store(path, { sample: false });
  seed(store);
  const requests = [];
  provider ||= {
    configured: true,
    complete: async (...args) => {
      requests.push(args);
      return reply([raw()]);
    },
  };
  const service = new IdeasService(store, provider, { clock });
  const act = (action, p) => store.mutate((s) => command(s, action, p));
  return { store, provider, service, act, requests };
}
async function until(check) {
  const end = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await delay(10);
  }
}

test('suggestions require bounded JSON, exact distinct source quotes and no model tool calls', () => {
  const f = fixture();
  try {
    const sources = ideaSources(f.store.read());
    assert.equal(parseIdeas(reply([raw()]), sources)[0].sources[0].ref, 'goal:walk');
    for (const invalid of [
      reply([raw({ sources: [{ ref: 'goal:missing', quote: 'Walk outdoors' }] })]),
      reply([raw({ sources: [{ ref: 'goal:walk', quote: 'Invented fact' }] })]),
      reply([raw({ sources: [raw().sources[0], raw().sources[0]] })]),
      reply([raw({ importance: 'critical' })]),
      reply([raw({ title: 'x'.repeat(101) })]),
      reply([raw(), raw(), raw(), raw()]),
      { text: 'null' },
      { text: 'not JSON' },
      { ...reply([raw()]), toolCalls: [{ function: { name: 'send_email' } }] },
    ])
      assert.throws(() => parseIdeas(invalid, sources));
    assert.deepEqual(parseIdeas(reply([]), sources), []);
  } finally {
    f.store.close();
  }
});
test('structured suggestions remain source-validated and an empty result succeeds without chat noise', async () => {
  let invalid = true;
  const f = fixture({
    provider: {
      configured: true,
      async complete(messages, tools, options) {
        assert.deepEqual(tools, []);
        const sources = JSON.parse(messages[1].content).context.sources;
        const schema = options.localStructuredOutput.schema;
        assert.deepEqual(
          schema.properties.ideas.items.properties.sources.items.properties.ref.enum,
          sources.map((source) => source.ref),
        );
        assert.equal(schema.properties.ideas.maxItems, 3);
        assert.equal(schema.properties.ideas.items.properties.sources.maxItems, sources.length);
        return {
          ...reply(
            invalid
              ? [raw({ sources: [{ ref: 'goal:walk', quote: 'A fabricated deadline' }] })]
              : [],
          ),
          structuredOutput: true,
        };
      },
    },
  });
  try {
    f.service.request();
    await f.service.poll();
    assert.match(f.store.read().ideas.error, /could not finish/);
    assert.equal(visibleIdeas(f.store.read()).length, 0);
    invalid = false;
    f.service.request();
    await f.service.poll();
    assert.equal(f.store.read().ideas.error, '');
    assert.equal(f.store.read().ideas.reason, 'none');
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(f.store.read().notifications.length, 0);
    assert.equal(f.store.read().runs.length, 0);
  } finally {
    f.store.close();
  }
});
test('manual checks use model context, make no chat noise, dedupe and keep drafts when accepted once', async () => {
  const f = fixture();
  try {
    f.store.mutate((s) => {
      s.threads[0].draft = 'An unfinished thought';
      s.files.push({ id: 'secretfile', name: 'private.pdf', base64: 'DO_NOT_INCLUDE_FILE_BYTES' });
    });
    const first = f.service.request();
    assert.equal(f.service.request().id, first.id);
    await f.service.poll();
    let state = f.store.read();
    assert.equal(state.messages.length, 0);
    assert.equal(state.notifications.length, 0);
    assert.equal(visibleIdeas(state).length, 1);
    assert.equal(f.requests[0][1].length, 0);
    assert.doesNotMatch(JSON.stringify(f.requests), /DO_NOT_INCLUDE_FILE_BYTES/);
    const idea = state.ideas.items[0];
    f.service.request();
    await f.service.poll();
    assert.equal(f.store.read().ideas.items.length, 1);
    const accepted = f.act('idea.accept', { id: idea.id, text: 'Plan a 15-minute walk for me.' });
    assert.deepEqual(
      f.act('idea.accept', { id: idea.id, text: 'Plan a 15-minute walk for me.' }),
      accepted,
    );
    state = f.store.read();
    assert.equal(state.runs.length, 1);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].text, 'Plan a 15-minute walk for me.');
    assert.equal(state.threads[0].draft, 'An unfinished thought');
    assert.equal(state.runs[0].ideaId, idea.id);
    assert.equal(
      ideaSources(state).some((s) => s.type === 'message'),
      false,
    );
    f.service.request();
    await f.service.poll();
    assert.equal(f.store.read().ideas.items.length, 0);
    assert.equal(JSON.parse(f.requests.at(-1)[0][1].content).previous[0].accepted, true);
  } finally {
    f.store.close();
  }
});
test('generated idea requests and follow-up choices cannot become learned owner memories', async () => {
  const f = fixture();
  try {
    f.service.request();
    await f.service.poll();
    const idea = f.store.read().ideas.items[0];
    const chosen = f.act('idea.accept', { id: idea.id, text: 'I prefer long walks. Plan one.' });
    const learn = (run) =>
      f.store.mutate((s) =>
        learnMemory(
          s,
          { key: 'preference.walk', text: 'Prefers long walks.', evidence: 'I prefer long walks' },
          {
            runId: run.id,
            sourceMessageId: run.messageId,
            threadId: run.threadId,
            controlVersion: 0,
          },
        ),
      );
    const run = f.store.read().runs.find((r) => r.id === chosen.runId);
    assert.throws(() => learn(run), /active conversation/);
    const q = f.store.mutate((s) => {
      const m = { id: 'question-msg', threadId: 'main', role: 'assistant', cards: [], text: '' };
      s.messages.push(m);
      return attachQuestion(
        s,
        run,
        { prompt: 'When?', options: [{ label: 'Morning' }, { label: 'Evening' }] },
        m,
      );
    });
    const follow = f.act('question.answer', { id: q.id, text: 'I prefer long walks' });
    assert.ok(follow.questionContext.origin.ideaContext);
    assert.throws(() => learn(follow), /active conversation/);
    assert.equal(f.store.read().memories.length, 0);
  } finally {
    f.store.close();
  }
});
test('changing or forgetting context invalidates quotes, and stale suggestions cannot start', async () => {
  const f = fixture();
  try {
    f.service.request();
    await f.service.poll();
    const idea = f.store.read().ideas.items[0];
    f.store.mutate((s) => {
      s.goals[0].description = 'Stay indoors';
    });
    assert.equal(f.store.read().ideas.items.length, 0);
    assert.throws(() => f.act('idea.accept', { id: idea.id, text: 'Go' }), /changed or expired/);
    f.service.request();
    await f.service.poll();
    f.act('idea.dismiss', { id: idea.id });
    assert.equal(f.store.read().ideas.dismissed.length, 1);
    f.store.mutate((s) => {
      s.goals = [];
    });
    assert.equal(f.store.read().ideas.dismissed.length, 0);
    assert.doesNotMatch(JSON.stringify(f.store.read().ideas), /Walk outdoors/);
  } finally {
    f.store.close();
  }
});
test('dismissals persist through repeated checks and can be restored without a chat message', async () => {
  const f = fixture();
  try {
    f.service.request();
    await f.service.poll();
    const id = f.store.read().ideas.items[0].id;
    f.act('idea.dismiss', { id });
    f.service.request();
    await f.service.poll();
    assert.equal(visibleIdeas(f.store.read()).length, 0);
    f.act('idea.restore', { id });
    f.service.request();
    await f.service.poll();
    assert.equal(visibleIdeas(f.store.read()).length, 1);
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    f.store.close();
  }
});
test('in-flight source changes, dismissals and opt-out cannot publish stale suggestions', async () => {
  let release;
  const provider = { configured: true, complete: () => new Promise((r) => (release = r)) };
  const f = fixture({ provider });
  try {
    f.service.request();
    let pending = f.service.poll();
    f.store.mutate((s) => {
      s.goals[0].title = 'Changed goal';
    });
    release(reply([raw()]));
    await pending;
    assert.equal(f.store.read().ideas.items.length, 0);
    assert.equal(f.store.read().ideas.reason, 'changed');
    f.store.mutate((s) => {
      s.goals[0].title = 'Walk outdoors';
    });
    f.service.request();
    pending = f.service.poll();
    release(reply([raw()]));
    await pending;
    const id = f.store.read().ideas.items[0].id;
    f.service.request();
    pending = f.service.poll();
    f.act('idea.dismiss', { id });
    release(reply([raw()]));
    await pending;
    assert.equal(f.store.read().ideas.items.length, 0);
    f.act('idea.restore', { id });
    f.act('idea.settings', { mode: 'regular' });
    pending = f.service.poll();
    f.act('idea.settings', { mode: 'off' });
    release(reply([raw({ importance: 'urgent', notify: true })]));
    await pending;
    assert.equal(f.store.read().ideas.items.length, 0);
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(f.service.due(), false);
  } finally {
    f.store.close();
  }
});
test('background checks skip unchanged context and throttle evidence-backed notices', async (t) => {
  // Both the service and storage expiry checks must use the same clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-11T08:00:00Z') });
  let n = 0;
  const provider = {
    configured: true,
    complete: async () =>
      reply([
        raw({ topic: `walk-${++n}`, importance: n === 1 ? 'important' : 'urgent', notify: true }),
      ]),
  };
  const f = fixture({ provider });
  try {
    f.store.mutate((s) => {
      s.profile.notifications = true;
    });
    f.act('idea.settings', { mode: 'quiet' });
    await f.service.poll();
    assert.equal(n, 1);
    assert.equal(f.store.read().messages.length, 0);
    t.mock.timers.tick(6 * 3600000);
    await f.service.poll(); // May cross a UTC date; use current fingerprint as baseline.
    const calls = n;
    f.store.mutate((s) => {
      s.ideas.nextCheck = 0;
    });
    await f.service.poll();
    assert.equal(n, calls);
    f.store.mutate((s) => {
      s.goals[0].description = 'A fresh plan';
      s.ideas.nextCheck = 0;
    });
    await f.service.poll();
    assert.equal(f.store.read().messages.length, 1);
    assert.equal(f.store.read().notifications.length, 1);
    f.store.mutate((s) => {
      s.goals[0].description = 'Another fresh plan';
      s.ideas.nextCheck = 0;
    });
    await f.service.poll();
    assert.equal(f.store.read().messages.length, 1);
    t.mock.timers.tick(24 * 3600000);
    await f.service.poll();
    assert.equal(f.store.read().messages.length, 2);
    assert.deepEqual(
      f.store.read().messages.map((m) => m.text),
      ['A new idea might be worth your attention.', 'A new idea might be worth your attention.'],
    );
  } finally {
    f.store.close();
  }
});
test('provider failures preserve valid ideas, redact details and use background backoff', async () => {
  const f = fixture();
  try {
    f.service.request();
    await f.service.poll();
    f.provider.complete = async () => {
      throw new Error('secret credentials never shown');
    };
    f.service.request();
    await f.service.poll();
    const s = f.store.read();
    assert.equal(s.ideas.items.length, 1);
    assert.match(s.ideas.error, /could not finish/);
    assert.doesNotMatch(JSON.stringify(s), /secret credentials/);
    assert.ok(s.ideas.nextCheck > Date.now());
    f.provider.configured = false;
    assert.throws(() => f.service.request(), /Connect a model/);
    assert.equal(f.service.due(), false);
  } finally {
    f.store.close();
  }
});
test('worker runs without a browser, pauses owner takeover, and resumes a durable manual check after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-ideas-'));
  let release;
  const requests = [];
  const provider = {
    configured: true,
    complete: async (_messages, _tools, { signal }) => {
      requests.push(1);
      return new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  seed(store);
  let services = { mode: 'live', provider, computer: { enabled: true, controller: 'owner' } };
  let worker = new BackgroundWorker(store, services, { pollMs: 15 });
  try {
    services.ideas.request();
    worker.start();
    await delay(50);
    assert.equal(requests.length, 0);
    services.computer.controller = 'agent';
    await until(() => requests.length === 1);
    services.computer.controller = 'owner';
    await until(() => !worker.active.has('ideas-poll'));
    assert.equal(store.read().ideas.requested, true);
    await worker.stop();
    store.close();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    services = { mode: 'live', provider };
    worker = new BackgroundWorker(store, services, { pollMs: 15 });
    worker.start();
    await until(() => requests.length === 2);
    release(reply([raw()]));
    await until(() => store.read().ideas.items.length === 1);
    assert.equal(store.read().messages.length, 0);
  } finally {
    await worker.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('expired leases can recover, while concurrent checks and generated context remain bounded', async () => {
  const f = fixture();
  try {
    f.store.mutate((s) => {
      const state = ideaState(s);
      Object.assign(state, {
        status: 'running',
        requested: true,
        leaseUntil: Date.now() - 1,
        runId: 'crashed',
      });
      for (let n = 0; n < 40; n++)
        s.memories.push({ id: `m${n}`, type: 'note', text: 'x'.repeat(1000) });
    });
    await Promise.all([f.service.poll(), f.service.poll()]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.read().ideas.items.length, 1);
    const sources = ideaSources(f.store.read());
    assert.equal(sources.filter((s) => s.type === 'memory').length, 30);
    assert.equal(sources.find((s) => s.type === 'memory').text.length, 500);
  } finally {
    f.store.close();
  }
});

test('reusing service options for a new workspace never attaches its worker to a closed store', async () => {
  const services = { mode: 'sample', provider: { configured: false } };
  const old = new Store(':memory:', { sample: false });
  const first = new BackgroundWorker(old, services);
  await first.stop();
  old.close();
  const store = new Store(':memory:', { sample: false });
  const next = new BackgroundWorker(store, services, { pollMs: 10 });
  try {
    assert.equal(services.ideas.store, store);
    const owned = new BackgroundWorker(store, {
      ...services,
      computer: { enabled: true, controller: 'owner' },
    });
    assert.equal(owned.services.ideas.canRun(), false);
    await owned.stop();
    services.ideas.canRun = () => !next.pausedForOwner;
    next.start();
    await delay(30);
    assert.equal(services.ideas.due(), false);
  } finally {
    await next.stop();
    store.close();
  }
});

test('forgetting a saved preference removes its unsent quote and pending notice', async () => {
  const f = fixture();
  try {
    const note = f.act('memory.add', { text: 'I enjoy riverside walks.' });
    f.provider.complete = async () =>
      reply([raw({ sources: [{ ref: `memory:${note.id}`, quote: 'I enjoy riverside walks.' }] })]);
    f.service.request();
    await f.service.poll();
    const id = f.store.read().ideas.items[0].id;
    f.store.mutate((s) => s.notifications.push({ id: 'notice', ideaId: id }));
    f.act('memory.delete', { id: note.id });
    assert.equal(f.store.read().ideas.items.length, 0);
    assert.equal(f.store.read().notifications.length, 0);
    assert.doesNotMatch(JSON.stringify(f.store.read()), /riverside walks/);
  } finally {
    f.store.close();
  }
});

test('idea refresh requires an authenticated owner and rejects cross-origin requests', async () => {
  const { createApp } = await import('../server/app.mjs');
  const { once } = await import('node:events');
  const f = fixture(),
    accessKey = 'ideas-test-owner-access-key';
  const app = createApp(
    f.store,
    {
      mode: 'live',
      provider: f.provider,
      ideas: f.service,
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/api/ideas/refresh', { method: 'POST' })).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: accessKey }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (
        await fetch(url + '/api/ideas/refresh', {
          method: 'POST',
          headers: { cookie, origin: 'https://untrusted.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.read().ideas, undefined);
    assert.equal(
      (await fetch(url + '/api/ideas/refresh', { method: 'POST', headers: { cookie } })).status,
      200,
    );
    await f.service.poll();
    assert.equal(f.store.read().ideas.items.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});
