import { writeSkillPackage } from '../shared/skill-archive.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillDocument, writeSkillDocument } from '../shared/skill-document.mjs';
import { skillFiles, skillBytes, skillBase64, skillFileText } from '../shared/skill-package.mjs';
import { readSkillPackage, prepareComputerSkill } from '../server/skill-package.mjs';
import { command } from '../shared/domain.mjs';
import { createWorkspace } from '../shared/seed.mjs';
import { skillSnapshot } from '../shared/skills.mjs';
import { prepareTemplate, importTemplate } from '../shared/assistant-templates.mjs';
import { Store } from '../server/store.mjs';
import { executeTool } from '../server/agent.mjs';
import { createApp } from '../server/app.mjs';
import { once } from 'node:events';
const source =
  '---\nname: count-items\ndescription: Count items from the included list.\nlicense: MIT\n---\n\nRead references/guide.md, then run scripts/count.py using the supplied asset.\n';
const file = (path, value) => ({ path, base64: Buffer.from(value).toString('base64') });
const method = {
  ...readSkillDocument(source),
  files: [
    file('references/guide.md', 'Count every row, including café and 茶.'),
    file('scripts/count.py', 'print(3)\n'),
    file('assets/input.bin', [0, 255, 80, 0]),
  ],
};
const zipBytes = async (entries) => {
  const zip = new JSZip();
  for (const [path, bytes, options] of entries) zip.file(path, bytes, options);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
};
test('skill ZIP round-trips exact binary and UTF-8 files with interoperable stored and deflated archives', async () => {
  const output = writeSkillPackage(method);
  const external = await JSZip.loadAsync(output, { checkCRC32: true });
  assert.deepEqual(
    await external.file('count-items/assets/input.bin').async('nodebuffer'),
    Buffer.from([0, 255, 80, 0]),
  );
  const restored = await readSkillPackage(Buffer.from(output));
  assert.deepEqual(restored.files, skillFiles(method.files));
  assert.equal(readSkillDocument(restored.document).documentMeta.license, 'MIT');
  const compressed = await zipBytes([
    ['SKILL.md', source],
    ...method.files.map((f) => [f.path, skillBytes(f.base64)]),
  ]);
  assert.deepEqual((await readSkillPackage(compressed)).files, skillFiles(method.files));
  assert.equal(skillFileText(method.files[2]), null);
  assert.match(skillFileText(method.files[0]), /茶/);
  assert.deepEqual(
    skillBytes(skillBase64(new Uint8Array([0, 255, 1]))),
    new Uint8Array([0, 255, 1]),
  );
});
test('package validation rejects traversal, colliding paths, special files, malformed bytes and expansion limits', async () => {
  for (const path of [
    '../x',
    '/x',
    'a/../../x',
    'a\\x',
    'a//b',
    'C:x',
    'a/NUL.txt',
    'a.',
    'a/./b',
    'a/\u0000b',
  ])
    assert.throws(() => skillFiles([file(path, 'x')]));
  for (const files of [
    [file('SKILL.md', 'x')],
    [file('A', '1'), file('a', '2')],
    [file('a', '1'), file('a/b', '2')],
    [file('a', Buffer.alloc(262145))],
    Array.from({ length: 65 }, (_, i) => file('a' + i, '')),
    Array.from({ length: 5 }, (_, i) => file('a' + i, Buffer.alloc(262144))),
  ])
    assert.throws(() => skillFiles(files));
  for (const b64 of ['a', 'Zg=', 'Zh==', '%%%%']) assert.throws(() => skillBytes(b64));
  for (const entries of [
    [['bad/SKILL.md', source]],
    [
      ['a/SKILL.md', source],
      ['b/SKILL.md', source],
    ],
    [['assets/a', 'x']],
    [
      ['SKILL.md', source],
      ['link', '/etc/passwd', { unixPermissions: 0o120777 }],
    ],
    [
      ['SKILL.md', source],
      ['pipe', '', { unixPermissions: 0o010600 }],
    ],
    [
      ['SKILL.md', source],
      ['large', Buffer.alloc(262145)],
    ],
    [
      ['count-items/SKILL.md', source],
      ['other.txt', 'outside'],
    ],
    [
      ['SKILL.md', source],
      ['a', 'x'],
      ['A', 'y'],
    ],
    [
      ['SKILL.md', source],
      ['a', 'x'],
      ['a/b', 'y'],
    ],
    [['SKILL.md', Buffer.from([255, 0])]],
  ])
    await assert.rejects(readSkillPackage(await zipBytes(entries)));
  const badCRC = Buffer.from(writeSkillPackage(method));
  badCRC[80] ^= 1;
  await assert.rejects(readSkillPackage(badCRC));
  await assert.rejects(readSkillPackage(Buffer.alloc(2097153)));
});
test('supporting files are atomic, frozen in chat/routine snapshots, and retained through assistant transfer', () => {
  const s = createWorkspace();
  const saved = command(s, 'skill.create', method);
  const run = command(s, 'skill.run', { id: saved.id, threadId: 'main' });
  const routine = command(s, 'routine.create', {
    title: 'Count later',
    threadId: 'main',
    instructions: '',
    skillId: saved.id,
    schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
  });
  const before = structuredClone(saved);
  assert.throws(() =>
    command(s, 'skill.update', { id: saved.id, title: 'bad', files: [file('../bad', 'x')] }),
  );
  assert.deepEqual(saved, before);
  command(s, 'skill.update', { id: saved.id, files: [file('new.txt', 'new')] });
  assert.deepEqual(run.skill.files, skillFiles(method.files));
  assert.deepEqual(routine.skill.files, skillFiles(method.files));
  const target = createWorkspace();
  importTemplate(target, prepareTemplate(s, 'relay').template);
  assert.deepEqual(target.skills.find((x) => x.slug === 'count-items').files, [
    file('new.txt', 'new'),
  ]);
  assert.deepEqual(
    target.routines.find((x) => x.title === 'Count later').skill.files,
    skillFiles(method.files),
  );
});
test('agent reads the pinned version on demand, paginates references and refuses mismatched or unavailable files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-package-test-'));
  const store = new Store(join(dir, 'state.sqlite'), { sample: false });
  try {
    const saved = store.mutate((s) =>
      command(s, 'skill.create', {
        ...method,
        files: [...method.files, file('long.txt', 'a'.repeat(25000))],
      }),
    );
    const run = store.mutate((s) => command(s, 'skill.run', { id: saved.id, threadId: 'main' }));
    store.mutate((s) => command(s, 'skill.update', { id: saved.id, files: [file('new', 'new')] }));
    const context = { threadId: 'main', runId: run.id, sourceMessageId: run.messageId };
    const args = { id: saved.id, version: 1, path: 'long.txt' };
    assert.equal(
      (await executeTool(store, 'read_skill_file', args, context)).result.text.length,
      12000,
    );
    assert.equal(
      (await executeTool(store, 'read_skill_file', { ...args, offset: 24000 }, context)).result
        .nextOffset,
      null,
    );
    assert.equal(
      (await executeTool(store, 'read_skill', { id: saved.id }, context)).result.version,
      1,
    );
    assert(
      !JSON.stringify(
        (await executeTool(store, 'read_skill', { id: saved.id }, context)).result,
      ).includes('base64'),
    );
    await assert.rejects(
      executeTool(store, 'read_skill_file', { ...args, version: 2 }, context),
      /version changed/,
    );
    await assert.rejects(
      executeTool(store, 'read_skill_file', { ...args, path: '../private' }, context),
      /not part/,
    );
    await assert.rejects(
      executeTool(store, 'read_skill_file', { ...args, offset: -1 }, context),
      /valid file offset/,
    );
    store.mutate((s) => command(s, 'skill.archive', { id: saved.id }));
    assert.equal(
      (await executeTool(store, 'read_skill_file', args, context)).result.nextOffset,
      12000,
    );
    await assert.rejects(
      executeTool(store, 'read_skill_file', args, { threadId: 'main' }),
      /available/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('computer preparation preserves bytes, uses confined exclusive paths, and checks cancellation between writes', async () => {
  const s = createWorkspace(),
    saved = command(s, 'skill.create', method),
    calls = [];
  const computer = {
    perform: async (p) => {
      calls.push(p);
    },
  };
  const result = await prepareComputerSkill(computer, skillSnapshot(s, saved.id), 'prepare', {
    scope: 'run',
  });
  assert.match(result.path, /^\/workspace\/skill-[a-f0-9]{24}$/);
  assert(calls.every((c) => c.kind === 'files' && !c.overwrite && c.path.startsWith(result.path)));
  assert.deepEqual(
    calls.filter((c) => c.action === 'write').map((c) => c.base64),
    [
      Buffer.from(writeSkillDocument(saved)).toString('base64'),
      ...skillFiles(method.files).map((f) => f.base64),
    ],
  );
  const ac = new AbortController();
  let count = 0;
  await assert.rejects(
    prepareComputerSkill(
      {
        perform: async () => {
          count++;
          ac.abort();
        },
      },
      saved,
      'abort',
      { scope: 'run', signal: ac.signal },
    ),
    /abort/i,
  );
  assert.equal(count, 1);
  await assert.rejects(
    prepareComputerSkill(computer, saved, 'bad/operation', { scope: 'run' }),
    /unique operation/,
  );
});
test('ZIP preview requires owner authentication, rejects cross-origin writes and leaves workspace state unchanged', async () => {
  const store = new Store(':memory:', { sample: false });
  const app = createApp(
    store,
    {
      mode: 'sample',
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: 'package-test-owner-key-24-characters' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`,
    base64 = Buffer.from(writeSkillPackage(method)).toString('base64');
  const request = (path, body, headers = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    const before = store.read();
    assert.equal((await request('/api/skills/package', { base64 })).status, 401);
    const login = await request('/api/login', { key: 'package-test-owner-key-24-characters' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (
        await request(
          '/api/skills/package',
          { base64 },
          { Cookie, Origin: 'https://other.example' },
        )
      ).status,
      403,
    );
    const response = await request('/api/skills/package', { base64 }, { Cookie });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).files, skillFiles(method.files));
    for (const data of ['%%%%', Buffer.from('bad').toString('base64'), 'A'.repeat(2800001)])
      assert.notEqual(
        (await request('/api/skills/package', { base64: data }, { Cookie })).status,
        200,
      );
    assert.deepEqual(store.read(), before);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
