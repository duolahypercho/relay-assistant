// SPDX-License-Identifier: MIT
// Original public-repository protocol fixture; never included in product execution.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
export const commit = '1'.repeat(40),
  rootTree = '2'.repeat(40),
  folderTree = '3'.repeat(40);
export const document =
  '---\nname: calm-plan\ndescription: Make a calm plan from the included notes.\nlicense: MIT\nmetadata:\n  author: Relay acceptance\n---\n\nRead references/notes.md. Ask which day to plan, then suggest one activity.\n';
export const documents = new Map([
  ['SKILL.md', Buffer.from(document)],
  [
    'references/notes.md',
    Buffer.from('Choose tea, a walk or a café. Preserve the owner’s words. 茶\n'),
  ],
  ['scripts/check.py', Buffer.from('raise RuntimeError("Import must never run this script")\n')],
  ['assets/dot.bin', Buffer.from([0, 255, 8, 13, 44, 128])],
  ['LICENSE', Buffer.from('SPDX-License-Identifier: MIT\nOriginal Relay test fixture.\n')],
]);
const api = 'https://api.github.com/repos/relay-tests/methods';
export function repositoryFixture() {
  const entries = [...documents].map(([path, bytes]) => ({
    path,
    type: 'blob',
    mode: '100644',
    size: bytes.length,
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  }));
  const responses = new Map([
    [api, { default_branch: 'main' }],
    [api + '/git/ref/heads/main', { object: { type: 'commit', sha: commit } }],
    [
      api + '/git/matching-refs/heads/main',
      [{ ref: 'refs/heads/main', object: { type: 'commit', sha: commit } }],
    ],
    [api + '/git/matching-refs/tags/main', []],
    [api + '/git/commits/' + commit, { sha: commit, tree: { sha: rootTree } }],
    [
      api + '/git/trees/' + rootTree,
      {
        sha: rootTree,
        truncated: false,
        tree: [{ path: 'calm-plan', type: 'tree', mode: '040000', sha: folderTree }],
      },
    ],
    [
      api + '/git/trees/' + folderTree + '?recursive=1',
      { sha: folderTree, truncated: false, tree: entries },
    ],
  ]);
  for (const [path, bytes] of documents)
    responses.set(
      `https://raw.githubusercontent.com/relay-tests/methods/${commit}/calm-plan/${path}`,
      bytes,
    );
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    options.signal?.throwIfAborted();
    if (!responses.has(url)) throw Error('The page returned HTTP 404.');
    const value = responses.get(url);
    if (value instanceof Error) throw value;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (bytes.length > options.maxBytes) throw Error('The page exceeds the size limit.');
    return { status: 200, headers: {}, bytes, url };
  };
  return { responses, calls, fetch, api, entries };
}
export async function repositoryHttpFixture() {
  const f = repositoryFixture();
  let delay = 0,
    aborted = 0;
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.slice(1));
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted++;
        controller.abort();
      }
    });
    try {
      if (delay)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      const result = await f.fetch(url, { maxBytes: 2 * 1024 * 1024, signal: controller.signal });
      res.writeHead(200);
      res.end(result.bytes);
    } catch (error) {
      if (!controller.signal.aborted) {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    ...f,
    setDelay(value) {
      delay = value;
    },
    get aborted() {
      return aborted;
    },
    async fetch(url, options) {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.address().port}/${encodeURIComponent(url)}`,
        { signal: options.signal },
      );
      if (response.status !== 200) throw Error(`The page returned HTTP ${response.status}.`);
      return { status: 200, headers: {}, url, bytes: Buffer.from(await response.arrayBuffer()) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
