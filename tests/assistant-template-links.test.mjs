// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  templateSourceUrl,
  templateAppLink,
  parseTemplateAppLink,
} from '../shared/assistant-template-links.mjs';
import { DesktopTemplateLinks } from '../native/desktop/template-links.mjs';
import { prepareTemplate } from '../shared/assistant-templates.mjs';
import { command } from '../shared/domain.mjs';
import { Store } from '../server/store.mjs';
const source = 'https://publisher.example/share/assistant/' + 'a'.repeat(43);
test('template app links accept only a single bounded Relay source and supported transport', () => {
  assert.equal(parseTemplateAppLink(templateAppLink(source)), source);
  const local = source.replace('https://publisher.example', 'http://127.0.0.1:4310');
  assert.equal(parseTemplateAppLink(templateAppLink(local)), local);
  assert.throws(() => parseTemplateAppLink(templateAppLink(local), { allowLoopback: false }));
  for (const invalid of [
    source + '?token=secret',
    source.replace('/share/', '/x/../share/'),
    source + '#x',
    source + '/extra',
    source.replace('https:', 'file:'),
    source.replace('https:', 'http:'),
    source.replace('publisher.example', 'person:secret@publisher.example'),
    source.replace('publisher.example', 'publisher.example:22'),
    source.replace('assistant/', 'assistant/%61'),
    source + ' ',
    source.replace('/share/', '\\share/'),
    'https://publisher.example/' + 'x'.repeat(2100),
  ])
    assert.throws(() => templateSourceUrl(invalid), invalid);
  for (const invalid of [
    templateAppLink(source) + '&url=' + encodeURIComponent(source),
    templateAppLink(source) + '&extra=1',
    templateAppLink(source) + '#x',
    templateAppLink(source).replace('template?', 'template/other?'),
    templateAppLink(source).replace('template?', 'user@template?'),
    templateAppLink(source).replace('template?', 'template:443?'),
    templateAppLink(source).replace('relay-assistant:', 'https:'),
    '\n' + templateAppLink(source),
  ])
    assert.throws(() => parseTemplateAppLink(invalid), invalid);
});
test('desktop template inbox survives restart, remains scoped, and rejects invalid links without losing review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-link-inbox-'));
  try {
    const queue = new DesktopTemplateLinks(directory);
    const pending = await queue.receive(templateAppLink(source), 'https://recipient.example/');
    assert.equal((await stat(queue.path)).mode & 0o777, 0o600);
    const restored = new DesktopTemplateLinks(directory);
    assert.equal(await restored.peek('https://other.example/'), null);
    assert.deepEqual(await restored.peek('https://recipient.example/'), {
      id: pending.id,
      url: source,
    });
    assert.throws(() =>
      restored.receive(
        'relay-assistant://template?url=https://evil.example',
        'https://recipient.example/',
      ),
    );
    await restored.acknowledge(pending.id, 'https://other.example/');
    assert.equal((await restored.peek('https://recipient.example/')).id, pending.id);
    await restored.acknowledge(pending.id, 'https://recipient.example/');
    assert.equal(await restored.peek('https://recipient.example/'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('stale acknowledgements cannot remove a newer incoming template and corrupt disk data is ignored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-link-race-'));
  try {
    const q = new DesktopTemplateLinks(directory);
    const first = await q.receive(templateAppLink(source), 'local');
    const next = q.receive(
      templateAppLink(source.replace('a'.repeat(43), 'b'.repeat(43))),
      'local',
    );
    const ack = q.acknowledge(first.id, 'local');
    const [newer] = await Promise.all([next, ack]);
    assert.equal((await q.peek('local')).id, newer.id);
    await writeFile(q.path, '{bad json');
    assert.equal(await q.peek('local'), null);
    await q.receive(templateAppLink(source), 'local');
    assert.equal((await q.peek('local')).url, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('template import receipts survive SQLite restart and prevent response-loss replay or overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-template-receipt-'));
  let store;
  try {
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const act = (a, p) => store.mutate((s) => command(s, a, p));
    const original = act('assistant.create', {
      name: 'Aster',
      description: 'Plan quiet trips.',
      tone: 'Brief',
      avatarColor: '#decfa0',
    });
    act('routine.create', {
      title: 'Check weather',
      instructions: 'Check travel weather.',
      threadId: original.threadId,
      schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    });
    const template = prepareTemplate(store.read(), original.id).template;
    const requestId = 'receipt-test-123456789';
    const added = act('template.import', { template, requestId });
    store.close();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const before = store.read();
    const replay = act('template.import', {
      template: { ...template, profile: { ...template.profile, name: 'Changed publisher' } },
      requestId,
    });
    assert.equal(replay.id, added.id);
    assert.equal(replay.name, 'Aster');
    assert.equal(replay.alreadyImported, true);
    assert.deepEqual(store.read().assistants, before.assistants);
    assert.deepEqual(store.read().routines, before.routines);
    assert.equal(store.read().routines.find((r) => r.threadId === added.threadId).paused, true);
    assert.equal(store.read().messages.length, 0);
    assert.equal(store.read().runs.length, 0);
    assert.throws(() => act('template.import', { template, requestId: 'bad' }), /receipt/);
    store.mutate((s) => {
      s.assistants = s.assistants.filter((a) => a.id !== added.id);
    });
    assert.throws(() => act('template.import', { template, requestId }), /no longer available/);
    store.mutate((s) => {
      s.templateImports = Array.from({ length: 10000 }, (_, i) => ({ id: `older-${i}` }));
    });
    assert.throws(
      () => act('template.import', { template, requestId: 'another-receipt-123456' }),
      /receipt limit/,
    );
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
