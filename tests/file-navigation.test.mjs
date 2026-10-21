import test from 'node:test';
import assert from 'node:assert/strict';
import { filePreviewHash, filePreviewRoute } from '../shared/file-navigation.mjs';
test('saved file links retain exact file and conversation identity without content', () => {
  for (const thread of ['main', 'side-17', 'reply_4']) {
    const hash = filePreviewHash('file-52', thread);
    assert.deepEqual(filePreviewRoute(hash), { id: 'file-52', threadId: thread });
  }
  assert.equal(filePreviewRoute('#files/result-5/2'), null);
  assert.equal(filePreviewRoute('#files/new'), null);
  assert.equal(filePreviewRoute('#files'), null);
});
test('malformed file and conversation links never navigate outside Relay', () => {
  for (const hash of [
    null,
    '#files/preview/',
    '#files/preview/a/2',
    '#files/preview/%2f',
    '#files/preview/' + 'x'.repeat(401),
  ])
    assert.equal(filePreviewRoute(hash), null);
  assert.deepEqual(filePreviewRoute('#files/preview/a?chat=https%3A%2F%2Fexample.com'), {
    id: 'a',
    threadId: 'main',
  });
  for (const id of ['', '../bad', 'file/other', 'https://example.com', 'x'.repeat(101)])
    assert.throws(() => filePreviewHash(id));
});
