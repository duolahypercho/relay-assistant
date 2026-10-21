// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from '../scripts/assistants-fixture.mjs';
import { SkillRepository, githubSkillLink } from '../server/skill-repository.mjs';
import {
  repositoryFixture,
  commit,
  rootTree,
  folderTree,
  document,
  documents,
} from '../scripts/skill-repository-fixture.mjs';
const link = 'https://github.com/relay-tests/methods/tree/main/calm-plan';

test('repository loading is an authenticated same-origin read and never installs or starts work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-skill-repository-routes-'));
  const github = repositoryFixture();
  let fixture;
  try {
    fixture = await assistantsFixture(directory, {
      accessKey: 'repository-fixture-owner-key',
      configure(_store, services) {
        services.skillRepository = new SkillRepository({ fetch: github.fetch });
      },
    });
    const post = (path, body, headers = {}) =>
      fetch(fixture.url + '/api' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post('/skills/repository', { url: link })).status, 401);
    assert.equal(github.calls.length, 0);
    const login = await post('/login', { key: 'repository-fixture-owner-key' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (await post('/skills/repository', { url: link }, { cookie, origin: 'https://other.invalid' }))
        .status,
      403,
    );
    assert.equal(github.calls.length, 0);
    const before = fixture.store.read();
    const response = await post(
      '/skills/repository',
      { url: link },
      { cookie, origin: fixture.url },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).files.length, 4);
    const after = fixture.store.read();
    for (const key of ['skills', 'messages', 'runs', 'files', 'routines'])
      assert.deepEqual(after[key], before[key]);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub import freezes a public folder to a commit and preserves exact supporting bytes without execution', async () => {
  const f = repositoryFixture(),
    reader = new SkillRepository({ fetch: f.fetch });
  const result = await reader.read(link);
  assert.equal(result.document, document);
  assert.equal(result.source.commit, commit);
  assert.equal(
    result.source.url,
    `https://github.com/relay-tests/methods/tree/${commit}/calm-plan`,
  );
  for (const file of result.files)
    assert.deepEqual(Buffer.from(file.base64, 'base64'), documents.get(file.path));
  assert.equal(result.files.length, 4);
  assert.equal(reader.active, 0);
  for (const { url, options } of f.calls) {
    assert(['api.github.com', 'raw.githubusercontent.com'].includes(new URL(url).hostname));
    assert.equal(options.redirects, 0);
    assert(!options.headers.Authorization);
    assert(!options.headers.Cookie);
  }
  assert(
    f.calls
      .filter((c) => c.url.includes('raw.githubusercontent.com'))
      .every((c) => c.url.includes('/' + commit + '/')),
  );
});

test('GitHub links accept SKILL.md permalinks and a repository containing one root skill', async () => {
  const f = repositoryFixture(),
    reader = new SkillRepository({ fetch: f.fetch });
  assert.equal(
    (await reader.read(`https://github.com/relay-tests/methods/blob/${commit}/calm-plan/SKILL.md`))
      .document,
    document,
  );
  f.responses.set(f.api + '/git/trees/' + rootTree + '?recursive=1', {
    sha: rootTree,
    truncated: false,
    tree: f.entries,
  });
  for (const [path, bytes] of documents)
    f.responses.set(
      `https://raw.githubusercontent.com/relay-tests/methods/${commit}/${path}`,
      bytes,
    );
  assert.equal((await reader.read('https://github.com/relay-tests/methods')).document, document);
});

test('slash-named branches use the longest actual ref and annotated tags pin their commit', async () => {
  const f = repositoryFixture(),
    reader = new SkillRepository({ fetch: f.fetch });
  f.responses.set(f.api + '/git/matching-refs/heads/work', [
    { ref: 'refs/heads/work', object: { type: 'commit', sha: '4'.repeat(40) } },
    { ref: 'refs/heads/work/next', object: { type: 'commit', sha: commit } },
  ]);
  f.responses.set(f.api + '/git/matching-refs/tags/work', []);
  assert.equal(
    (await reader.read('https://github.com/relay-tests/methods/tree/work/next/calm-plan')).source
      .commit,
    commit,
  );
  f.responses.set(f.api + '/git/matching-refs/heads/not-a-file', [
    { ref: 'refs/heads/not-a-file/SKILL.md', object: { type: 'commit', sha: commit } },
  ]);
  f.responses.set(f.api + '/git/matching-refs/tags/not-a-file', []);
  await assert.rejects(
    reader.read('https://github.com/relay-tests/methods/blob/not-a-file/SKILL.md'),
    /public GitHub/,
  );
  f.responses.set(f.api + '/git/matching-refs/heads/v1', []);
  f.responses.set(f.api + '/git/matching-refs/tags/v1', [
    { ref: 'refs/tags/v1', object: { type: 'tag', sha: '5'.repeat(40) } },
  ]);
  f.responses.set(f.api + '/git/tags/' + '5'.repeat(40), {
    sha: '5'.repeat(40),
    object: { type: 'commit', sha: commit },
  });
  assert.equal(
    (await reader.read('https://github.com/relay-tests/methods/tree/v1/calm-plan')).source.commit,
    commit,
  );
  f.responses.set(f.api + '/git/matching-refs/heads/v1', [
    { ref: 'refs/heads/v1', object: { type: 'commit', sha: '6'.repeat(40) } },
  ]);
  await assert.rejects(
    reader.read('https://github.com/relay-tests/methods/tree/v1/calm-plan'),
    /different versions/,
  );
});

test('unapproved hosts, credentials, non-skill file URLs and encoded paths fail before any request', async () => {
  const f = repositoryFixture(),
    reader = new SkillRepository({ fetch: f.fetch });
  for (const value of [
    'http://github.com/a/b',
    'https://github.com.evil.test/a/b',
    'https://user:secret@github.com/a/b',
    'file:///tmp/SKILL.md',
    'https://127.0.0.1/a/b',
    'https://github.com/a/b?token=private',
    'https://github.com/a/b/blob/main/other.md',
    'https://github.com/a/b/tree/main/path%2Fescape',
    'https://github.com/a/b/tree/main/path%00bad',
    null,
    {},
  ])
    await assert.rejects(reader.read(value), /public GitHub/);
  assert.equal(f.calls.length, 0);
  assert.equal(reader.active, 0);
  assert.equal(githubSkillLink(link).repository, 'methods');
});

test('repository import rejects incomplete, linked, conflicting, oversized and multi-skill trees before file download', async () => {
  for (const transform of [
    (tree) => ({ ...tree, truncated: true }),
    (tree) => ({
      ...tree,
      tree: [
        ...tree.tree,
        { path: 'link', type: 'blob', mode: '120000', sha: '6'.repeat(40), size: 8 },
      ],
    }),
    (tree) => ({
      ...tree,
      tree: [...tree.tree, { path: 'module', type: 'commit', mode: '160000', sha: '6'.repeat(40) }],
    }),
    (tree) => ({ ...tree, tree: [...tree.tree, { ...tree.tree[0], path: 'other/SKILL.md' }] }),
    (tree) => ({ ...tree, tree: [...tree.tree, { ...tree.tree[0], path: 'skill.MD' }] }),
    (tree) => ({ ...tree, tree: tree.tree.map((e, i) => (i === 0 ? { ...e, size: 64001 } : e)) }),
    (tree) => ({ ...tree, tree: [...tree.tree, { ...tree.tree[0], path: '../escape' }] }),
    (tree) => ({
      ...tree,
      tree: Array.from({ length: 131 }, (_, i) => ({ ...tree.tree[0], path: `file-${i}` })),
    }),
  ]) {
    const f = repositoryFixture(),
      reader = new SkillRepository({ fetch: f.fetch }),
      key = f.api + '/git/trees/' + folderTree + '?recursive=1';
    f.responses.set(key, transform(f.responses.get(key)));
    await assert.rejects(reader.read(link));
    assert.equal(reader.active, 0);
    assert(f.calls.every((c) => !c.url.includes('raw.githubusercontent.com')));
  }
});

test('repository bytes must match Git object hashes, including scripts and binary assets', async () => {
  const f = repositoryFixture(),
    reader = new SkillRepository({ fetch: f.fetch });
  const key = `https://raw.githubusercontent.com/relay-tests/methods/${commit}/calm-plan/assets/dot.bin`;
  f.responses.set(key, Buffer.from([0, 255, 8, 13, 45, 128]));
  await assert.rejects(reader.read(link), /did not match/);
  assert.equal(reader.active, 0);
});

test('repository cancellation, deadline and concurrent-load limits release capacity without waiting for DNS', async () => {
  const calls = [],
    reader = new SkillRepository({
      fetch: async (_url, options) => {
        calls.push(options);
        return new Promise(() => {});
      },
      timeout: 1000,
    });
  const first = new AbortController(),
    second = new AbortController();
  const a = reader.read(link, { signal: first.signal }),
    b = reader.read(link, { signal: second.signal });
  await assert.rejects(reader.read(link), /already loading/);
  first.abort();
  second.abort();
  await assert.rejects(a, /cancelled/);
  await assert.rejects(b, /cancelled/);
  assert.equal(reader.active, 0);
  assert(calls.every((c) => c.signal.aborted));
  const timer = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      new SkillRepository({ fetch: () => new Promise(() => {}), timeout: 10 }).read(link),
      /took too long/,
    );
  } finally {
    clearTimeout(timer);
  }
});

test('GitHub unavailable/rate-limited responses and redirects expose bounded guidance without payloads', async () => {
  for (const [failure, message] of [
    ['The page returned HTTP 403.', 'limiting downloads'],
    ['The page returned HTTP 404.', 'could not be found'],
    ['secret response body', 'could not be downloaded'],
  ]) {
    await assert.rejects(
      new SkillRepository({
        fetch: async () => {
          throw Error(failure);
        },
      }).read(link),
      new RegExp(message),
    );
  }
  const f = repositoryFixture();
  await assert.rejects(
    new SkillRepository({
      fetch: async (url, options) => ({
        ...(await f.fetch(url, options)),
        url: 'https://evil.test/',
      }),
    }).read(link),
    /unexpected download/,
  );
});
