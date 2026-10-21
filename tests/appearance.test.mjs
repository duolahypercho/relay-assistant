// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { avatarPNG, validateAppearance } from '../shared/appearance.mjs';
import { avatarData, avatarFixture, pngChunk } from './fixtures/avatar.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import {
  assistantProfile,
  assistantWorkspace,
  assistantSnapshot,
} from '../shared/assistant-scope.mjs';
import {
  prepareTemplate,
  validateTemplate,
  importTemplate,
} from '../shared/assistant-templates.mjs';
import { AssistantTemplates, templateReview } from '../server/assistant-templates.mjs';
import { createApp } from '../server/app.mjs';
import { systemPrompt } from '../server/agent.mjs';
const role = {
  name: 'Pip',
  description: 'Keep a gentle pace.',
  tone: 'Warm',
  avatarColor: '#a0c5ac',
};
const image = () => ({ kind: 'image', data: avatarData() });
test('appearance validates character choices and removes picture metadata without changing pixels', () => {
  assert.deepEqual(validateAppearance(), { kind: 'sprout' });
  for (const shape of ['pebble', 'puff', 'star'])
    assert.deepEqual(validateAppearance({ kind: 'shape', shape }), { kind: 'shape', shape });
  for (const value of [
    { kind: 'shape', shape: '<script>' },
    { kind: 'sprout', url: 'https://tracker.invalid' },
    { kind: 'image', data: 'data:image/svg+xml,<svg/>' },
    { kind: 'image', data: 'https://image.invalid' },
    JSON.parse('{"kind":"sprout","__proto__":{}}'),
  ])
    assert.throws(() => validateAppearance(value));
  const before = avatarFixture(),
    clean = Buffer.from(avatarPNG(avatarData()).slice(22), 'base64');
  assert.equal(before.includes(Buffer.from('private camera metadata')), true);
  assert.equal(clean.includes(Buffer.from('private camera metadata')), false);
  assert.equal(avatarPNG(avatarData()), avatarData({ metadata: false }));
});
test('PNG bounds, checksums, scanlines, zlib errors, bombs and trailing data are rejected', () => {
  const corrupt = avatarFixture();
  corrupt[30] ^= 1;
  const trailing = Buffer.concat([avatarFixture(), Buffer.from('private trailing bytes')]);
  const unknown = avatarFixture({ metadata: false });
  const extra = Buffer.concat([unknown.subarray(0, 33), pngChunk('ZZZZ'), unknown.subarray(33)]);
  const cases = [
    corrupt,
    trailing,
    extra,
    avatarFixture({ width: 257 }),
    avatarFixture({ pixels: Buffer.from('not pixels') }),
    avatarFixture({ width: 1, height: 1, raw: Buffer.from([5, 0, 0, 0, 255]) }),
    avatarFixture({ width: 1, height: 1, raw: Buffer.alloc(2_000_000) }),
    avatarFixture({
      pixels: Buffer.concat([deflateSync(Buffer.alloc(80 * 481)), Buffer.from('hidden')]),
    }),
    avatarFixture({ width: 1, height: 1, raw: Buffer.from([0, 0, 0, 0]) }),
  ];
  for (const raw of cases)
    assert.throws(() => avatarPNG('data:image/png;base64,' + raw.toString('base64')));
  assert.throws(() => avatarPNG('data:image/png;base64,' + 'A'.repeat(180000)));
});
test('appearance persists for Main and specialists, copies independently and stale writes do not replace it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-look-')),
    path = join(directory, 'state.sqlite');
  let store = new Store(path, { sample: false });
  const act = (a, p) => store.mutate((s) => command(s, a, p));
  try {
    const a = act('assistant.create', { ...role, appearance: image() });
    const saved = validateAppearance(image());
    assert.deepEqual(a.appearance, saved);
    const main = assistantProfile(store.read());
    act('assistant.update', { ...main, appearance: { kind: 'shape', shape: 'puff' } });
    assert.throws(() => act('assistant.update', { ...main, appearance: image() }), /changed/);
    const copy = act('assistant.duplicate', { id: a.id });
    assert.deepEqual(copy.appearance, saved);
    act('assistant.update', { ...a, appearance: { kind: 'shape', shape: 'star' } });
    assert.deepEqual(assistantProfile(store.read(), copy.id).appearance, saved);
    const before = store.read();
    assert.throws(() =>
      act('assistant.update', {
        ...assistantProfile(before, a.id),
        appearance: { kind: 'image', data: 'bad' },
      }),
    );
    assert.deepEqual(store.read(), before);
    store.close();
    store = new Store(path);
    assert.equal(assistantProfile(store.read()).appearance.shape, 'puff');
    assert.equal(assistantProfile(store.read(), a.id).appearance.shape, 'star');
    assert.deepEqual(assistantProfile(store.read(), copy.id).appearance, saved);
    const state = store.read();
    act('assistant.update', { ...assistantProfile(state), appearance: image() });
    const context = assistantWorkspace(store.read());
    assert.equal(context.profile.assistantAppearance, undefined);
    assert.doesNotMatch(systemPrompt(context), /data:image|private camera/);
    assert.equal(assistantSnapshot(store.read()).appearance, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('template appearance is optional for older files, portable, reviewed and independently editable', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const a = store.mutate((s) => command(s, 'assistant.create', { ...role, appearance: image() }));
    const t = prepareTemplate(store.read(), a.id).template;
    assert.deepEqual(t.profile.appearance, validateAppearance(image()));
    const copy = store.mutate((s) => importTemplate(s, t));
    assert.deepEqual(copy.appearance, t.profile.appearance);
    assert.equal(store.read().messages.length, 0);
    const legacy = structuredClone(t);
    delete legacy.profile.appearance;
    legacy.version = 1;
    assert.equal(validateTemplate(legacy).profile.appearance, undefined);
    const manager = new AssistantTemplates(store);
    const review = templateReview(t, 'public');
    const changed = structuredClone(t);
    changed.profile.appearance = { kind: 'shape', shape: 'puff' };
    assert.throws(
      () =>
        manager.save({
          assistantId: a.id,
          template: changed,
          access: 'public',
          reviewedDigest: review.digest,
        }),
      /Review/,
    );
  } finally {
    store.close();
  }
});
test('shared avatar pixels follow link access, revision and revocation without inline image bytes or remote fetches', async () => {
  const store = new Store(':memory:', { sample: false });
  const a = store.mutate((s) => command(s, 'assistant.create', { ...role, appearance: image() }));
  const manager = new AssistantTemplates(store);
  const services = {
    mode: 'sample',
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const server = createApp(store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey: 'owner-avatar-fixture-key',
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const template = prepareTemplate(store.read(), a.id).template;
    const save = (access) =>
      manager.save({
        assistantId: a.id,
        template,
        access,
        reviewedDigest: templateReview(template, access).digest,
      });
    const publicLink = save('public'),
      privateLink = save('workspace');
    const path = (token) => url + '/api/shared-assistants/' + token + '/avatar';
    const response = await fetch(path(publicLink.token));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/png/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(template.profile.appearance.data.slice(22), 'base64'),
    );
    assert.equal((await fetch(path(privateLink.token))).status, 404);
    const html = await fetch(url + '/share/assistant/' + publicLink.token);
    assert.match(html.headers.get('content-security-policy'), /img-src 'self'/);
    const source = await html.text();
    assert.match(source, /\/avatar/);
    assert.doesNotMatch(source, /data:image|private camera metadata/);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'owner-avatar-fixture-key' }),
    });
    assert.equal(
      (
        await fetch(path(privateLink.token), {
          headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
        })
      ).status,
      200,
    );
    manager.revoke(publicLink.token, 1);
    assert.equal((await fetch(path(publicLink.token))).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
