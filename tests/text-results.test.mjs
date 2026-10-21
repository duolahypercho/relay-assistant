import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { executeTool } from '../server/agent.mjs';
import { createApp } from '../server/app.mjs';

test('assistant text results preserve the requested plain-text name and exact downloadable Unicode bytes', async () => {
  const store = new Store(':memory:', { sample: false });
  const app = createApp(
    store,
    { mode: 'sample', provider: {}, google: {}, browser: {}, terminal: {} },
    { host: '127.0.0.1', port: 0 },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const text = 'Walk by the river\r\n带一本书 📖\nBring water\n';
    const written = await executeTool(store, 'write_note', { name: 'weekend-plan.txt', text });
    const file = store.read().files[0];
    assert.equal(file.name, 'weekend-plan.txt');
    assert.equal(file.mime, 'text/plain');
    assert.equal(file.text, text);
    assert.equal(file.size, Buffer.byteLength(text));
    assert.deepEqual(written.result, {
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/files/${file.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.match(response.headers.get('content-disposition'), /weekend-plan\.txt/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(text));
    assert.equal(store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('Office creation returns the actual exported name and type rather than leaving the assistant to infer them from a title', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const saved = await executeTool(store, 'save_artifact', {
      kind: 'document',
      title: 'weekend-plan.txt',
      source: 'Pack a book.',
    });
    const file = store.read().files.find((f) => f.id === saved.result.fileId);
    assert.equal(saved.result.name, file.name);
    assert.equal(saved.result.name, 'weekend-plan.txt.docx');
    assert.equal(saved.result.mime, file.mime);
    assert.match(saved.result.mime, /wordprocessingml/);
  } finally {
    store.close();
  }
});

test('Markdown result names stay compatible, HTML-like text never becomes executable, and oversized content is not silently saved', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    for (const [name, expected, mime] of [
      ['notes.md', 'notes.md', 'text/markdown'],
      ['notes', 'notes.md', 'text/markdown'],
      ['notes.html', 'notes.md', 'text/markdown'],
      ['NOTES.TXT', 'NOTES.TXT', 'text/plain'],
    ]) {
      await executeTool(store, 'write_note', { name, text: '<script>alert(1)</script>\n' });
      const file = store.read().files[0];
      assert.equal(file.name, expected);
      assert.equal(file.mime, mime);
    }
    const before = store.read();
    await assert.rejects(
      executeTool(store, 'write_note', { name: 'too-long.txt', text: 'x'.repeat(100001) }),
      /Split a longer file/,
    );
    assert.deepEqual(store.read(), before);
  } finally {
    store.close();
  }
});
