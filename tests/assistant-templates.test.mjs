// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
import {
  prepareTemplate,
  validateTemplate,
  importTemplate,
  templateWarnings,
} from '../shared/assistant-templates.mjs';
import { AssistantTemplates, templateReview } from '../server/assistant-templates.mjs';
function fixture(path = ':memory:') {
  const store = new Store(path, { sample: false }),
    act = (a, p) => store.mutate((s) => command(s, a, p));
  const assistant = act('assistant.create', {
    name: 'Aster',
    description: 'Plan thoughtful trips.',
    tone: 'Brief',
    avatarColor: '#decfa0',
  });
  const method = act('skill.create', {
    title: 'Trip method',
    slug: 'trip-method',
    description: 'Prepare a trip',
    instructions: 'Read available dates and propose a plan.',
  });
  act('routine.create', {
    title: 'Trip check',
    instructions: 'Check current conditions',
    threadId: assistant.threadId,
    skillId: method.id,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
  });
  const manager = new AssistantTemplates(store);
  return {
    store,
    act,
    assistant,
    method,
    manager,
    template: () => prepareTemplate(store.read(), assistant.id).template,
  };
}
test('template extraction includes selected configuration only and removes obvious secrets/private links', () => {
  const f = fixture();
  try {
    f.act('chat.send', { threadId: f.assistant.threadId, text: 'Private conversation' });
    f.act('memory.add', { assistantId: f.assistant.id, text: 'Private memory' });
    f.store.secret('private-token', 'never-export-this');
    f.store.mutate((s) => {
      s.assistants[0].description =
        'Use sk-abcdefghijklmnop123456 and https://127.0.0.1/private and https://public.example/guide';
      Object.assign(s.routines[0], {
        lastRunId: 'private-run',
        lastResult: 'private-result',
        lastMailId: 'private-email',
      });
      s.skills[0].sourceMessageId = 'private-source';
    });
    const { template, removed } = prepareTemplate(f.store.read(), f.assistant.id);
    assert.ok(removed.includes('profile.description'));
    const encoded = JSON.stringify(template);
    assert.doesNotMatch(
      encoded,
      /Private conversation|Private memory|never-export-this|private-run|private-result|private-email|private-source|sk-abcdefghijklmnop|127\.0\.0\.1/,
    );
    assert.match(encoded, /https:\/\/public.example\/guide/);
    assert.equal(template.skills.length, 1);
    assert.equal(template.routines[0].skill.title, 'Trip method');
    assert.deepEqual(templateWarnings(template), []);
    f.act('assistant.update', { ...f.assistant, enabledSkillIds: [] });
    assert.equal(f.template().skills.length, 0);
  } finally {
    f.store.close();
  }
});
test('templates reject unsupported state, prototypes, malformed methods, sensitive text and excessive UTF-8 payloads', () => {
  const f = fixture();
  try {
    const t = f.template();
    for (const extra of [
      { memories: [] },
      { files: [] },
      { credentials: {} },
      { threads: [] },
      { version: 99 },
    ])
      assert.throws(() => validateTemplate({ ...t, ...extra }));
    assert.throws(
      () =>
        validateTemplate(
          JSON.parse(JSON.stringify(t).slice(0, -1) + ',"__proto__":{"polluted":true}}'),
        ),
      /unsupported/,
    );
    assert.throws(
      () => validateTemplate({ ...t, skills: [{ ...t.skills[0], sourceMessageId: 'private' }] }),
      /unsupported/,
    );
    assert.throws(
      () => validateTemplate({ ...t, skills: [{ ...t.skills[0], slug: 'bad slug' }] }),
      /shortcut/,
    );
    const large = {
      ...t,
      skills: Array.from({ length: 8 }, (_, i) => ({
        ...t.skills[0],
        slug: `large-${i}`,
        instructions: '界'.repeat(12000),
      })),
    };
    assert.throws(() => validateTemplate(large), /256 KB/);
    for (const description of [
      'password=private12345',
      'Bearer secret-secret-token',
      'https://person:secret@example.com/x',
      'https://db.internal/accounts',
      'https://2130706433/private',
      'https://example.com/?access_token=abc',
    ]) {
      const bad = { ...t, profile: { ...t.profile, description } };
      assert.ok(templateWarnings(bad).length);
      assert.throws(() => templateReview(bad, 'public'), /possible credentials/);
      assert.throws(() => importTemplate(f.store.read(), bad), /possible credentials/);
    }
    assert.equal({}.polluted, undefined);
  } finally {
    f.store.close();
  }
});
test('import is atomic, gives independent skill IDs and shortcuts, and starts only empty chats with paused routines', () => {
  const f = fixture();
  try {
    const before = f.store.read(),
      t = f.template();
    const imported = f.act('template.import', { template: t }),
      s = f.store.read();
    assert.equal(s.messages.length, 0);
    assert.equal(s.memories.length, 0);
    assert.equal(s.runs.length, 0);
    assert.equal(s.tasks.length, 0);
    const newSkill = s.skills.find((x) => x.id === imported.enabledSkillIds[0]);
    assert.notEqual(newSkill.id, f.method.id);
    assert.equal(newSkill.slug, 'trip-method-2');
    const r = s.routines.find((x) => x.threadId === imported.threadId);
    assert.equal(r.paused, true);
    assert.equal(r.nextRunAt, null);
    assert.notEqual(r.skill.id, f.method.id);
    assert.equal(r.skill.sourceMessageId, undefined);
    assert.deepEqual(
      s.threads.find((x) => x.id === 'main'),
      before.threads.find((x) => x.id === 'main'),
    );
    const full = structuredClone(s);
    full.assistants = Array(30).fill(full.assistants[0]);
    const snapshot = structuredClone(full);
    assert.throws(() => importTemplate(full, t), /30 specialist/);
    assert.deepEqual(full, snapshot);
    assert.throws(() =>
      f.act('template.import', {
        template: { ...t, routines: [{ ...t.routines[0], schedule: { kind: 'unexpected' } }] },
      }),
    );
    assert.deepEqual(f.store.read(), s);
  } finally {
    f.store.close();
  }
});
test('imported email filters are replaced; expired one-off schedules remain paused until rescheduled', () => {
  const f = fixture();
  try {
    f.act('routine.create', {
      title: 'Inbox check',
      instructions: 'Read matching mail',
      threadId: f.assistant.threadId,
      schedule: { kind: 'email', sender: 'private-person@example.com', subject: 'Trip' },
    });
    const { template, removed } = prepareTemplate(f.store.read(), f.assistant.id);
    assert.ok(removed.some((x) => x.endsWith('.schedule.sender')));
    assert.doesNotMatch(JSON.stringify(template), /private-person/);
    template.routines.push({
      title: 'Old one-off',
      instructions: 'Reminder',
      execution: 'reminder',
      notification: 'all',
      skill: null,
      schedule: { kind: 'once', date: '2020-01-01', time: '09:00', timeZone: 'UTC' },
    });
    const copy = f.act('template.import', { template });
    const r = f.store
      .read()
      .routines.find((r) => r.threadId === copy.threadId && r.title === 'Old one-off');
    assert.equal(r.paused, true);
    assert.throws(() => f.act('routine.resume', { id: r.id }), /future time/);
  } finally {
    f.store.close();
  }
});
test('share links use exactly reviewed configuration, reject stale edits, persist across restart and stay revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-template-links-'));
  let f = fixture(join(dir, 'store.sqlite'));
  try {
    const t = f.template(),
      review = templateReview(t, 'public');
    const link = f.manager.save({
      assistantId: f.assistant.id,
      template: t,
      access: 'public',
      reviewedDigest: review.digest,
    });
    f.act('assistant.update', { ...f.assistant, description: 'Private new role' });
    assert.equal(f.manager.read(link.token).template.profile.description, 'Plan thoughtful trips.');
    assert.throws(
      () =>
        f.manager.save({
          assistantId: f.assistant.id,
          template: t,
          access: 'workspace',
          reviewedDigest: review.digest,
        }),
      /changed/,
    );
    const next = { ...t, profile: { ...t.profile, description: 'Reviewed update' } };
    const checked = templateReview(next, 'public');
    const updated = f.manager.save({
      assistantId: f.assistant.id,
      token: link.token,
      revision: 1,
      template: next,
      access: 'public',
      reviewedDigest: checked.digest,
    });
    assert.equal(updated.revision, 2);
    assert.throws(
      () =>
        f.manager.save({
          assistantId: f.assistant.id,
          token: link.token,
          revision: 1,
          template: next,
          access: 'public',
          reviewedDigest: checked.digest,
        }),
      /changed/,
    );
    const a = f.assistant;
    f.store.close();
    const store = new Store(join(dir, 'store.sqlite'));
    f = { store, manager: new AssistantTemplates(store), assistant: a };
    assert.equal(f.manager.read(link.token).revision, 2);
    const revoked = f.manager.revoke(link.token, 2);
    assert.equal(revoked.revoked, true);
    assert.throws(
      () =>
        f.manager.save({
          assistantId: a.id,
          token: link.token,
          revision: revoked.revision,
          template: next,
          access: 'public',
          reviewedDigest: checked.digest,
        }),
      /revoked/,
    );
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
async function httpFixture(accessKey = 'owner-key-for-templates-123456789') {
  const f = fixture();
  const app = createApp(
    f.store,
    {
      mode: 'sample',
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  const call = (path, p, headers = {}) =>
    fetch(url + path, {
      method: p ? 'POST' : 'GET',
      headers: { Cookie: cookie, ...(p ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(p ? { body: JSON.stringify(p) } : {}),
    });
  return {
    ...f,
    url,
    call,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      f.store.close();
    },
  };
}
test('public template HTTP routes expose only reviewed data while owner and workspace links require authentication', async () => {
  const f = await httpFixture();
  try {
    assert.equal(
      (await fetch(f.url + '/api/assistant-templates?assistantId=' + f.assistant.id)).status,
      401,
    );
    const t = f.template(),
      review = await (
        await f.call('/api/assistant-templates/review', { template: t, access: 'public' })
      ).json();
    assert.equal(
      (
        await f.call(
          '/api/assistant-templates',
          {
            assistantId: f.assistant.id,
            template: t,
            access: 'public',
            reviewedDigest: review.digest,
          },
          { Origin: 'https://untrusted.example' },
        )
      ).status,
      403,
    );
    const { link } = await (
      await f.call('/api/assistant-templates', {
        assistantId: f.assistant.id,
        template: t,
        access: 'public',
        reviewedDigest: review.digest,
      })
    ).json();
    const response = await fetch(f.url + '/api/shared-assistants/' + link.token, {
      headers: { Origin: 'https://recipient.example' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { template: t, revision: 1 });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(f.assistant.id));
    const download = await fetch(f.url + '/api/shared-assistants/' + link.token + '/download');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await download.json(), t);
    const privateReview = templateReview(t, 'workspace');
    const { link: priv } = await (
      await f.call('/api/assistant-templates', {
        assistantId: f.assistant.id,
        template: t,
        access: 'workspace',
        reviewedDigest: privateReview.digest,
      })
    ).json();
    assert.equal((await fetch(priv.url)).status, 404);
    assert.equal((await fetch(f.url + '/api/shared-assistants/' + priv.token)).status, 404);
    const owned = await f.call('/api/shared-assistants/' + priv.token);
    assert.equal(owned.status, 200);
    assert.equal(owned.headers.get('access-control-allow-origin'), null);
    await f.call('/api/assistant-templates/' + link.token + '/revoke', { revision: 1 });
    assert.equal((await fetch(link.url)).status, 404);
    assert.equal((await fetch(f.url + '/api/shared-assistants/' + link.token)).status, 404);
    assert.equal((await fetch(f.url + '/api/state')).status, 401);
  } finally {
    await f.close();
  }
});
test('public preview escapes supplied HTML and uses a restrictive script policy; unauthenticated servers cannot claim private links', async () => {
  const f = await httpFixture('');
  try {
    const t = f.template();
    t.profile.name = '<img src=x onerror=alert(1)>';
    t.profile.description = '</script><script>window.pwned=true</script>';
    const review = templateReview(t, 'public');
    const { link } = await (
      await f.call('/api/assistant-templates', {
        assistantId: f.assistant.id,
        template: t,
        access: 'public',
        reviewedDigest: review.digest,
      })
    ).json();
    const response = await fetch(link.url),
      html = await response.text();
    assert.doesNotMatch(html, /<img src=x|<script>window.pwned/);
    assert.match(html, /&lt;img/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'.*nonce-/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(
      (
        await f.call('/api/assistant-templates', {
          assistantId: f.assistant.id,
          template: t,
          access: 'workspace',
          reviewedDigest: templateReview(t, 'workspace').digest,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
