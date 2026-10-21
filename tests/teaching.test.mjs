// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { TeachingService, teachingDraft, teachingAction } from '../server/teaching.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
import { assistantProfile } from '../shared/assistant-scope.mjs';
import { ModelProvider } from '../server/model.mjs';
import Ajv from 'ajv';
const jpeg = (n = 1) => Buffer.from([255, 216, n, 255, 217]);
const draft = (frames) => ({
  title: 'Make a report',
  slug: 'make-report',
  description: 'When a short report is needed',
  inputs: ['Report title'],
  steps: [
    { instruction: 'Open the report form and enter the supplied title.', sources: [frames[0].id] },
  ],
  validation: ['Check the saved result matches the title.'],
  output: 'The saved report',
  boundaries: ['Ask before sending it.'],
  uncertainties: ['The example did not show sending.'],
});
const reply = (d) => ({ text: JSON.stringify(d), toolCalls: [] });
function fixture({ path = ':memory:', clock = Date.now } = {}) {
  const store = new Store(path, { sample: false }),
    requests = [];
  const computer = {
    enabled: true,
    controller: 'agent',
    epoch: 0,
    n: 1,
    async takeControl() {
      this.controller = 'owner';
      this.epoch++;
    },
    async start() {},
    async screenshot() {
      return {
        state: 'running',
        screenshot: jpeg(this.n).toString('base64'),
        controller: this.controller,
      };
    },
    async release() {
      this.controller = 'agent';
      this.epoch++;
    },
    async status() {
      return { enabled: true, controller: this.controller, state: 'running' };
    },
    receipts() {
      return [];
    },
  };
  let service;
  const provider = {
    configured: true,
    complete: async (messages, tools, options) => {
      requests.push({ messages, tools, options });
      return reply(draft(service.all()[0].frames));
    },
  };
  service = new TeachingService(store, computer, provider, { clock });
  return { store, computer, provider, service, requests };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await delay(10);
  }
}
async function savedDemo(f, threadId) {
  const session = await f.service.start('Show a report', threadId);
  f.service.finish(session.id);
  f.service.generate(session.id, f.service.get(session.id).version);
  await f.service.poll();
  const current = f.service.get(session.id);
  const saved = f.service.saveSkill(session.id, { ...current.draft, version: current.version });
  return { ...session, ...saved };
}

test('a learned skill retains its original assistant and complete side-chat draft across SQLite reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-teaching-origin-'));
  const path = join(dir, 'state.sqlite');
  let f = fixture({ path });
  try {
    let assistant, side, draftBefore, mainBefore, shareBefore;
    f.store.mutate((state) => {
      assistant = command(state, 'assistant.create', {
        name: 'Reports',
        description: 'Make careful reports.',
        enabledSkillIds: [],
      });
      side = command(state, 'thread.create', {
        title: 'Report lessons',
        assistantId: assistant.id,
      });
      const file = command(state, 'file.add', {
        name: 'unfinished.txt',
        mime: 'text/plain',
        text: 'Private unfinished attachment',
        base64: '',
      });
      command(state, 'thread.update', {
        id: side.id,
        draft: 'Keep my private thought',
        draftFileIds: [file.id],
      });
      // A pending app selection and native share are unrelated to the explicit test.
      side.draftApps = [{ connectorId: 'pending-app' }];
      command(state, 'share.attach', {
        id: 'teaching-pending-share',
        threadId: side.id,
        text: 'Private shared text',
        files: [],
      });
      draftBefore = structuredClone(side);
      mainBefore = structuredClone(state.threads.find((t) => t.id === 'main'));
      shareBefore = structuredClone(state.shareImports);
    });
    const session = await savedDemo(f, side.id);
    assert.equal(f.service.get(session.id).assistantId, assistant.id);
    const profile = assistantProfile(f.store.read(), assistant.id);
    assert.deepEqual(profile.enabledSkillIds, [session.skillId]);
    assert.equal(profile.revision, assistant.revision + 1);
    f.store.close();
    f = fixture({ path });
    const result = await f.service.test(session.id, 'Example report');
    assert.deepEqual(await f.service.test(session.id), result);
    assert.equal(result.threadId, side.id);
    const state = f.store.read(),
      run = state.runs[0],
      message = state.messages[0];
    assert.equal(state.runs.length, 1);
    assert.equal(state.messages.length, 1);
    assert.equal(run.assistant.id, assistant.id);
    assert.equal(run.threadId, side.id);
    assert.equal(run.skill.id, session.skillId);
    assert.deepEqual(message.fileIds, []);
    assert.equal(message.sharedTexts, undefined);
    assert.equal(message.appContext, undefined);
    assert.deepEqual(
      state.threads.find((t) => t.id === side.id),
      draftBefore,
    );
    assert.deepEqual(
      state.threads.find((t) => t.id === 'main'),
      mainBefore,
    );
    assert.deepEqual(state.shareImports, shareBefore);
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid teaching origins never take computer control or silently fall back to Main', async () => {
  const f = fixture();
  try {
    const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Archived' }));
    f.store.mutate((s) => {
      s.threads.find((t) => t.id === side.id).archived = true;
    });
    for (const id of ['missing-chat', side.id])
      await assert.rejects(f.service.start('Demo', id), /active conversation/);
    f.store.mutate((s) => {
      s.threads.find((t) => t.id === side.id).archived = false;
      s.threads.find((t) => t.id === side.id).participantIds = ['relay'];
    });
    await assert.rejects(f.service.start('Demo', side.id), /one-to-one/);
    assert.equal(f.computer.epoch, 0);
    assert.equal(f.service.all().length, 0);
  } finally {
    f.store.close();
  }
});

test('changed skills, disabled methods and changed or archived chats cannot release control or run', async () => {
  for (const change of ['disabled', 'version', 'archived', 'assistant']) {
    const f = fixture();
    try {
      const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Lesson' }));
      const session = await savedDemo(f, side.id);
      f.store.mutate((s) => {
        if (change === 'disabled') s.profile.assistantSkillIds = [];
        if (change === 'version')
          command(s, 'skill.update', { id: session.skillId, instructions: 'Changed method' });
        if (change === 'archived') s.threads.find((t) => t.id === side.id).archived = true;
        if (change === 'assistant') {
          const other = command(s, 'assistant.create', { name: 'Another helper' });
          s.threads.find((t) => t.id === side.id).assistantId = other.id;
        }
      });
      await assert.rejects(
        f.service.test(session.id),
        /Enable this skill|skill changed|active conversation|assistant.*changed/,
      );
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.store.read().runs.length, 0);
      assert.equal(f.store.read().messages.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('legacy recordings test in Main and saving respects selected-skill limits atomically', async () => {
  const f = fixture();
  try {
    const session = await savedDemo(f);
    f.service.edit(session.id, (s) => {
      delete s.threadId;
      delete s.assistantId;
    });
    assert.equal((await f.service.test(session.id)).threadId, 'main');
    const next = await f.service.start('Another report');
    f.service.finish(next.id);
    f.service.generate(next.id, f.service.get(next.id).version);
    await f.service.poll();
    f.store.mutate((s) => {
      s.profile.assistantSkillIds = Array(100).fill(session.skillId);
    });
    const current = f.service.get(next.id),
      before = f.store.read().skills.length;
    assert.throws(
      () =>
        f.service.saveSkill(next.id, {
          ...current.draft,
          slug: 'second-report',
          version: current.version,
        }),
      /100 selected skills/,
    );
    assert.equal(f.store.read().skills.length, before);
    assert.equal(f.service.get(next.id).status, 'draft');
  } finally {
    f.store.close();
  }
});

test('recording is explicit, preserves owner control and stores images outside workspace/model context', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.ticket(), null);
    const s = await f.service.start('Create a short report');
    assert.equal(f.computer.controller, 'owner');
    assert.equal(s.frames.length, 1);
    assert.equal(f.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(f.store.read()), /report|screenshot|teaching/);
    assert.deepEqual(f.service.frame(s.id, s.frames[0].id), jpeg(1));
    assert.equal(f.service.state().sessions[0].frames[0].id, s.frames[0].id);
    assert.ok(!JSON.stringify(f.service.state()).includes(jpeg(1).toString('base64')));
    await assert.rejects(f.service.start('Second recording'), /current recording/);
  } finally {
    f.store.close();
  }
});
test('pause/resume and control changes reject late screenshots and never log literal inputs', async () => {
  const f = fixture();
  try {
    let s = await f.service.start('Show a form');
    const ticket = f.service.ticket();
    f.service.note(ticket, { kind: 'desktop', action: 'type', text: 'SECRET_TYPED_TEXT' });
    const beforePause = f.service.ticket();
    f.service.pause(s.id);
    f.computer.n = 2;
    f.service.capture(beforePause, await f.computer.screenshot());
    assert.equal(f.service.get(s.id).frames.length, 1);
    s = await f.service.resume(s.id);
    assert.equal(s.frames.length, 2);
    f.service.capture(beforePause, { state: 'running', screenshot: jpeg(3).toString('base64') });
    assert.equal(f.service.get(s.id).frames.length, 2);
    f.service.note(f.service.ticket(), { kind: 'exec', command: 'SECRET_COMMAND' });
    const beforeControl = f.service.ticket();
    f.computer.epoch++;
    f.computer.n = 4;
    f.service.capture(beforeControl, await f.computer.screenshot());
    assert.equal(f.service.get(s.id).frames.length, 2);
    assert.doesNotMatch(JSON.stringify(f.service.state()), /SECRET_TYPED_TEXT|SECRET_COMMAND/);
    assert.equal(
      teachingAction({ kind: 'desktop', action: 'key', key: 'private-token' }),
      'Keyboard shortcut',
    );
    f.computer.controller = 'agent';
    f.service.sweep();
    assert.equal(f.service.get(s.id).status, 'paused');
  } finally {
    f.store.close();
  }
});
test('unobserved recording pauses and the ten-minute wall-clock limit cannot be bypassed', async () => {
  let now = Date.now();
  const f = fixture({ clock: () => now });
  try {
    const s = await f.service.start('Demo');
    now += 15000;
    f.service.heartbeat(s.id);
    now += 19000;
    assert.equal(f.service.state().sessions[0].status, 'recording');
    now += 2000;
    assert.equal(f.service.state().sessions[0].status, 'paused');
    await f.service.resume(s.id);
    now = s.deadline + 1;
    assert.equal(f.service.state().sessions[0].status, 'review');
    await assert.rejects(f.service.resume(s.id), /cannot be resumed/);
  } finally {
    f.store.close();
  }
});
test('image limits stop capture visibly; invalid images and duplicate screens are not stored', async () => {
  const f = fixture();
  try {
    const s = await f.service.start('Demo');
    await f.service.captureNow(s.id);
    assert.equal(f.service.get(s.id).frames.length, 1);
    f.service.note(f.service.ticket(), { kind: 'desktop', action: 'click', x: 1, y: 2 });
    f.service.capture(f.service.ticket(), {
      state: 'running',
      screenshot: Buffer.from('not jpeg').toString('base64'),
    });
    assert.equal(f.service.get(s.id).frames.length, 1);
    for (let n = 2; n <= 31; n++) {
      f.computer.n = n;
      await f.service.captureNow(s.id);
    }
    assert.equal(f.service.get(s.id).frames.length, 30);
    assert.equal(f.service.get(s.id).status, 'review');
    assert.match(f.service.get(s.id).reason, /limit/);
  } finally {
    f.store.close();
  }
});
test('removing a screenshot before generation removes its bytes; generation sends retained frames with no tools', async () => {
  const f = fixture();
  try {
    const s = await f.service.start('Demo');
    f.computer.n = 2;
    await f.service.captureNow(s.id);
    f.service.finish(s.id);
    f.service.removeFrame(s.id, s.frames[0].id);
    assert.throws(() => f.service.frame(s.id, s.frames[0].id), /not found/);
    let current = f.service.get(s.id);
    assert.throws(() => f.service.generate(s.id, s.version), /changed/);
    f.service.generate(s.id, current.version);
    await f.service.poll();
    current = f.service.get(s.id);
    assert.equal(current.status, 'draft');
    const images = f.requests[0].messages.filter((m) => m.visual);
    assert.equal(images.length, 1);
    assert.equal(images[0].visual, `data:image/jpeg;base64,${jpeg(2).toString('base64')}`);
    assert.deepEqual(f.requests[0].tools, []);
    assert.equal(f.store.read().skills.length, 0);
    assert.equal(f.store.read().messages.length, 0);
    assert.match(current.draft.instructions, /never grants permission/);
  } finally {
    f.store.close();
  }
});
test('skill draft requires real recorded frame references and rejects tools or malformed method', () => {
  const frames = [{ id: 'frame1' }],
    valid = draft(frames);
  assert.equal(teachingDraft(reply(valid), frames).title, valid.title);
  for (const bad of [
    reply({ ...valid, steps: [{ instruction: 'Invented step', sources: ['missing'] }] }),
    reply({ ...valid, slug: 'BAD slug' }),
    reply({ ...valid, steps: [] }),
    { text: 'broken' },
    { ...reply(valid), toolCalls: [{ name: 'execute' }] },
  ])
    assert.throws(() => teachingDraft(bad, frames));
});
test('teaching constrains supported local drafts with retained frame IDs, preserves images and still validates responses', async () => {
  for (const mode of ['local-quick', 'local-default', 'hosted']) {
    const f = fixture(),
      requests = [];
    let invalid = false;
    try {
      const session = await f.service.start('Make a report');
      f.service.finish(session.id);
      const frames = f.service.get(session.id).frames;
      f.service.provider = new ModelProvider({
        baseUrl: mode === 'hosted' ? 'https://provider.example/v1' : 'http://127.0.0.1:11434/v1',
        protocol: 'chat',
        model: 'qwen3.5:27b',
        replyMode: mode === 'local-default' ? 'default' : 'quick',
        getCapabilities: async () => ({
          source: 'ollama',
          vision: true,
          tools: true,
          thinking: { values: [false, true], default: true },
        }),
        fetcher: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          const value = draft(invalid ? [{ id: 'not-retained' }] : frames);
          return Response.json({
            choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
          });
        },
      });
      f.service.generate(session.id, f.service.get(session.id).version);
      await f.service.poll();
      assert.equal(f.service.get(session.id).status, 'draft');
      const request = requests[0];
      assert.equal(request.tools, undefined);
      assert.equal(request.messages.filter((m) => Array.isArray(m.content)).length, frames.length);
      if (mode === 'local-quick') {
        const contract = request.response_format.json_schema;
        assert.equal(contract.strict, true);
        const valid = new Ajv().compile(contract.schema);
        assert(valid(draft(frames)), JSON.stringify(valid.errors));
        assert(!valid(draft([{ id: 'not-retained' }])));
        assert(!valid({ ...draft(frames), steps: [{ instruction: 'Missing sources' }] }));
        assert(!valid({ ...draft(frames), steps: [] }));
      } else assert.equal(request.response_format, undefined);
      invalid = true;
      f.service.generate(session.id, f.service.get(session.id).version);
      await f.service.poll();
      assert.equal(f.service.get(session.id).status, 'review');
      assert.equal(f.service.get(session.id).frames.length, frames.length);
      assert.equal(f.store.read().skills.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('a draft is editable, saves once, and its explicit test retains the draft and runs once', async () => {
  const f = fixture();
  try {
    const s = await f.service.start('Demo');
    f.service.finish(s.id);
    f.service.generate(s.id, f.service.get(s.id).version);
    await f.service.poll();
    const current = f.service.get(s.id);
    f.store.mutate((s) => (s.threads[0].draft = 'Keep my thought'));
    const saved = f.service.saveSkill(s.id, {
      ...current.draft,
      title: 'My edited report',
      instructions: 'Use my edited method. Verify the saved report.',
      version: current.version,
    });
    assert.deepEqual(f.service.saveSkill(s.id, {}), saved);
    assert.equal(f.store.read().skills.length, 1);
    assert.equal(f.store.read().skills[0].title, 'My edited report');
    const run = await f.service.test(s.id, 'Use Example Report');
    assert.deepEqual(await f.service.test(s.id, 'Use Example Report'), run);
    assert.equal(f.computer.controller, 'agent');
    const state = f.store.read();
    assert.equal(state.runs.length, 1);
    assert.equal(state.threads[0].draft, 'Keep my thought');
    assert.equal(
      state.runs[0].skill.instructions,
      'Use my edited method. Verify the saved report.',
    );
    assert.equal(state.runs[0].skillInput, 'Use Example Report');
    f.service.discard(s.id);
    assert.equal(f.service.all().length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM teaching_frames').get().n, 0);
    assert.equal(f.store.read().skills.length, 1);
  } finally {
    f.store.close();
  }
});
test('discarding an in-flight generation aborts the response and cannot recreate a deleted recording or skill', async () => {
  const f = fixture();
  try {
    const s = await f.service.start('Demo');
    f.service.finish(s.id);
    let complete, signal;
    f.provider.complete = (_m, _t, o) => {
      signal = o.signal;
      return new Promise((r) => (complete = r));
    };
    f.service.generate(s.id, f.service.get(s.id).version);
    const pending = f.service.poll();
    f.service.discard(s.id);
    assert.equal(signal.aborted, true);
    complete(reply(draft(s.frames)));
    await pending;
    assert.equal(f.service.all().length, 0);
    assert.equal(f.store.read().skills.length, 0);
  } finally {
    f.store.close();
  }
});
test('failed models keep the recording and expose a retry without leaking provider details', async () => {
  const f = fixture();
  try {
    const s = await f.service.start('Demo');
    f.service.finish(s.id);
    f.provider.complete = async () => {
      throw new Error('PRIVATE API TOKEN');
    };
    f.service.generate(s.id, f.service.get(s.id).version);
    await f.service.poll();
    const current = f.service.get(s.id);
    assert.equal(current.status, 'review');
    assert.equal(current.frames.length, 1);
    assert.match(current.error, /supports images/);
    assert.doesNotMatch(current.error, /PRIVATE/);
    f.provider.configured = false;
    assert.throws(() => f.service.generate(s.id, current.version), /Connect a model/);
  } finally {
    f.store.close();
  }
});
test('server recovery pauses capture and preserves private frames and draft review state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-teaching-'));
  let f = fixture({ path: join(dir, 's.sqlite') });
  try {
    const s = await f.service.start('Demo');
    f.store.close();
    f = fixture({ path: join(dir, 's.sqlite') });
    assert.equal(f.service.get(s.id).status, 'paused');
    assert.deepEqual(f.service.frame(s.id, s.frames[0].id), jpeg(1));
    f.service.finish(s.id);
    f.service.generate(s.id, f.service.get(s.id).version);
    await f.service.poll();
    f.store.close();
    f = fixture({ path: join(dir, 's.sqlite') });
    assert.equal(f.service.get(s.id).status, 'draft');
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('the owner may generate from explicitly shared stopped frames while live agent work remains paused', async () => {
  const f = fixture();
  let worker;
  try {
    const services = {
      mode: 'live',
      provider: f.provider,
      computer: f.computer,
      teaching: f.service,
    };
    worker = new BackgroundWorker(f.store, services, { pollMs: 10 });
    const s = await f.service.start('Demo');
    const waiting = f.store.mutate((state) =>
      command(state, 'chat.send', {
        threadId: 'main',
        text: 'Wait until I give the computer back.',
      }),
    );
    f.service.finish(s.id);
    f.service.generate(s.id, f.service.get(s.id).version);
    worker.start();
    await until(() => f.service.get(s.id).status === 'draft');
    assert.equal(f.computer.controller, 'owner');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].tools.length, 0);
    assert.equal(worker.pausedForOwner, true);
    assert.equal(f.store.read().runs.find((r) => r.id === waiting.id).status, 'queued');
  } finally {
    await worker?.stop();
    f.store.close();
  }
});
test('recording routes and pixels require the owner session and forbid cross-origin changes', async () => {
  const f = fixture();
  const app = createApp(
    f.store,
    {
      mode: 'live',
      provider: f.provider,
      computer: f.computer,
      teaching: f.service,
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: 'teaching-owner-access-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await f.service.start('Demo');
    const path = `/api/teaching/${s.id}/frames/${s.frames[0].id}`;
    assert.equal((await fetch(url + path)).status, 401);
    assert.equal((await fetch(url + '/api/teaching')).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'teaching-owner-access-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const frame = await fetch(url + path, { headers: { cookie } });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), jpeg(1));
    assert.equal(
      (
        await fetch(url + `/api/teaching/${s.id}/discard`, {
          method: 'POST',
          headers: { cookie, origin: 'https://untrusted.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(f.service.get(s.id).status, 'recording');
    assert.doesNotMatch(
      await (await fetch(url + '/api/state', { headers: { cookie } })).text(),
      /screenshot|teaching/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});
