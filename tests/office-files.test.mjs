// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { once } from 'node:events';
import { renderArtifact } from '../server/artifacts.mjs';
import { parseOffice } from '../server/office-parser.mjs';
import { readOffice } from '../server/office-files.mjs';
import { executeTool } from '../server/agent.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { createApp } from '../server/app.mjs';
import { officeMime } from '../shared/office-files.mjs';
const file = (name, bytes) => ({
  name,
  mime: officeMime(name),
  base64: Buffer.from(bytes).toString('base64'),
});
const doc = (
  source = '# Native Word source\n\nTea costs **8**.\n\n| Item | Amount |\n| --- | --- |\n| Train | 25 |',
) => renderArtifact({ kind: 'document', title: 'Source', source });
async function alter(bytes, change) {
  const zip = await JSZip.loadAsync(bytes);
  await change(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
test('Word extraction reads paragraphs, table cells, non-ASCII and hyperlink destinations without following them', async () => {
  const { bytes } = await doc(
    '# 你好 🌱\n\nTea & books.\n\n[Source](https://example.invalid/no-fetch)\n\n| Item | Amount |\n| --- | --- |\n| Train | 25 |',
  );
  const result = await readOffice(file('Plan.docx', bytes));
  assert.match(result.text, /你好 🌱/);
  assert.match(result.text, /Tea & books/);
  assert.match(result.text, /Train\t25/);
  assert.match(result.text, /https:\/\/example.invalid\/no-fetch/);
  assert.equal(result.kind, 'document');
  assert.equal(result.nextOffset, null);
  assert.match(result.sourceNotice, /untrusted/);
});
test('Word main part follows relationships, includes headers and omits tracked deleted text', async () => {
  const { bytes } = await doc('Included words');
  const moved = await alter(bytes, async (z) => {
    const old = await z.file('word/document.xml').async('string');
    z.file(
      'custom/body.xml',
      old.replace(
        '</w:body>',
        '<w:del><w:r><w:delText>Deleted secret</w:delText></w:r></w:del></w:body>',
      ),
    );
    z.file(
      '_rels/.rels',
      (await z.file('_rels/.rels').async('string')).replace('word/document.xml', 'custom/body.xml'),
    );
    z.file(
      'custom/_rels/body.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header.xml"/></Relationships>',
    );
    z.file(
      'custom/header.xml',
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header content</w:t></w:r></w:p></w:hdr>',
    );
    z.remove('word/document.xml');
  });
  const result = await parseOffice(moved, 'document');
  assert.match(JSON.stringify(result.sections), /Included words/);
  assert.match(JSON.stringify(result.sections), /Header content/);
  assert.doesNotMatch(JSON.stringify(result.sections), /Deleted secret/);
  assert.match(result.warnings.join(' '), /Tracked deletions/);
});
test('Excel extraction preserves sheet order, cell addresses, shared strings, raw values, cached formulas and hidden-sheet labels', async () => {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('Plans');
  const b = wb.addWorksheet('Private notes', { state: 'hidden' });
  a.addRows([
    ['Item', 'Cost'],
    ['Tea 你好', 8],
    ['Train', 25],
    ['Total', { formula: 'SUM(B2:B3)', result: 33 }],
    ['Literal', '=HYPERLINK("https://example.invalid")'],
    ['Date', new Date('2026-10-11T00:00:00Z')],
  ]);
  b.addRow(['Hidden does not mean encrypted']);
  a.getCell('B6').numFmt = 'yyyy-mm-dd';
  const bytes = await alter(await wb.xlsx.writeBuffer(), async (zip) => {
    const xml = await zip.file('xl/sharedStrings.xml').async('string');
    zip.file(
      'xl/sharedStrings.xml',
      xml.replace(
        '<t>Tea 你好</t>',
        '<t>Tea 你好</t><rPh sb="0" eb="2"><t>phonetic annotation</t></rPh>',
      ),
    );
  });
  const result = await readOffice(file('Budget.xlsx', bytes));
  assert.doesNotMatch(result.text, /phonetic annotation/);
  assert.match(result.text, /Sheet: Plans/);
  assert.match(result.text, /A2: "Tea 你好" \| B2: 8/);
  assert.match(result.text, /B4: Formula: =SUM\(B2:B3\); saved result: 33/);
  assert.match(result.text, /B5: "=HYPERLINK/);
  assert.match(result.text, /format yyyy-mm-dd/);
  assert.match(result.text, /Private notes \(hidden\)/);
  assert.match(result.warnings.join(' '), /without execution/);
});
test('PowerPoint follows presentation order and distinguishes speaker notes from slide content', async () => {
  const { bytes } = await renderArtifact({
    kind: 'presentation',
    title: 'Briefing',
    source: JSON.stringify({
      slides: [
        { title: 'First topic', bullets: ['Train 25'], notes: 'Ask about the time.' },
        { title: 'Second topic', bullets: ['Tea 8'], notes: 'Keep this spoken.' },
      ],
    }),
  });
  const swapped = await alter(bytes, async (z) => {
    const p = await z.file('ppt/presentation.xml').async('string');
    const matches = [...p.matchAll(/<p:sldId [^>]+\/>/g)].map((m) => m[0]);
    assert.equal(matches.length, 2);
    z.file(
      'ppt/presentation.xml',
      p.replace(matches[0], 'SWAP').replace(matches[1], matches[0]).replace('SWAP', matches[1]),
    );
  });
  const result = await readOffice(file('Briefing.pptx', swapped));
  assert.match(result.text, /## Slide 1\nBriefing\nSecond topic\nTea 8/);
  assert.match(result.text, /## Slide 1 · Speaker notes\nKeep this spoken/);
  assert.match(result.text, /## Slide 2\nBriefing\nFirst topic/);
  assert.match(result.text, /Ask about the time/);
});
test('Office pagination requires an unchanged content hash and cancellation never returns partial content', async () => {
  const { bytes } = await doc('Many paragraphs 你好 🌱.\n\n'.repeat(1200));
  const original = file('Long.docx', bytes);
  let page = await readOffice(original);
  assert.equal(page.text.length, 12000);
  let all = page.text;
  await assert.rejects(readOffice(original, { offset: page.nextOffset }), /changed/);
  while (page.nextOffset !== null) {
    page = await readOffice(original, { offset: page.nextOffset, contentHash: page.contentHash });
    all += page.text;
  }
  assert.equal(all.length, page.totalLength);
  assert.equal(all.match(/Many paragraphs/g).length, 1200);
  const changed = file('Long.docx', (await doc('Different content')).bytes);
  await assert.rejects(readOffice(changed, { contentHash: page.contentHash }), /changed/);
  await assert.rejects(readOffice(original, { offset: -1 }), /offset/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readOffice(original, { signal: controller.signal }), { name: 'AbortError' });
});
test('malformed, encrypted/legacy and format-spoofed Office files fail instead of becoming binary text', async () => {
  for (const bytes of [
    Buffer.from('not a zip'),
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
    Buffer.alloc(0),
  ])
    await assert.rejects(readOffice(file('Broken.docx', bytes)), /not a readable/);
  const { bytes } = await doc();
  await assert.rejects(parseOffice(bytes, 'spreadsheet'), /does not match/);
  const noMain = await alter(bytes, (z) => z.remove('_rels/.rels'));
  await assert.rejects(parseOffice(noMain, 'document'), /entry point/);
  const dtd = await alter(bytes, async (z) =>
    z.file(
      'word/document.xml',
      '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>&x;</w:body></w:document>',
    ),
  );
  await assert.rejects(parseOffice(dtd, 'document'), /document type/);
  const traversal = await alter(bytes, async (z) =>
    z.file(
      '_rels/.rels',
      (await z.file('_rels/.rels').async('string')).replace('word/document.xml', '../outside.xml'),
    ),
  );
  await assert.rejects(parseOffice(traversal, 'document'), /outside/);
});
test('archive and expanded text limits reject compressed payloads before preview', async () => {
  const { bytes } = await doc();
  const expanded = await alter(bytes, (z) =>
    z.file('word/large.xml', ' '.repeat(17 * 1024 * 1024)),
  );
  assert.ok(expanded.length < 8 * 1024 * 1024);
  await assert.rejects(parseOffice(expanded, 'document'), /expands beyond/);
  const long = (await doc('x'.repeat(180000))).bytes;
  const oversized = await alter(long, async (z) =>
    z.file(
      'word/document.xml',
      (await z.file('word/document.xml').async('string')).replace(
        'x'.repeat(180000),
        'x'.repeat(500001),
      ),
    ),
  );
  await assert.rejects(parseOffice(oversized, 'document'), /text preview limit/);
});
test('agent reads real Office content, creates a revised result and keeps the source byte-for-byte', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const original = file('Source.docx', (await doc('Train 25 and Tea 8')).bytes);
    const saved = store.mutate((s) => command(s, 'file.add', original));
    const read = await executeTool(store, 'read_file', { id: saved.id });
    assert.match(read.result.text, /Train 25 and Tea 8/);
    const revised = await executeTool(store, 'save_artifact', {
      kind: 'document',
      title: 'Revised plan',
      source: '# Revised plan\n\nTrain 25 and Tea 9.',
      operationId: 'office-revision',
    });
    assert.ok(revised.result.fileId);
    assert.equal(store.read().files.find((f) => f.id === saved.id).base64, original.base64);
    const output = store.read().files.find((f) => f.id === revised.result.fileId);
    assert.match((await readOffice(output)).text, /Tea 9/);
    const binary = store.mutate((s) =>
      command(s, 'file.add', {
        name: 'packed.zip',
        mime: 'application/zip',
        base64: original.base64,
      }),
    );
    await assert.rejects(
      executeTool(store, 'read_file', { id: binary.id }),
      /not readable as text/,
    );
  } finally {
    store.close();
  }
});
test('Office HTTP preview requires the owner, disables caching and never changes workspace history', async () => {
  const store = new Store(':memory:', { sample: false });
  const source = file('Private.docx', (await doc('Private source text')).bytes);
  const f = store.mutate((s) => command(s, 'file.add', source));
  const before = store.read();
  const app = createApp(
    store,
    { mode: 'sample', provider: { configured: false }, google: { configured: false } },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-test-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const path = `${url}/api/files/${f.id}/office`;
    assert.equal((await fetch(path)).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'owner-test-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match((await response.json()).text, /Private source text/);
    assert.equal((await fetch(path + '?offset=-1', { headers: { Cookie: cookie } })).status, 400);
    assert.deepEqual(store.read().messages, before.messages);
    assert.deepEqual(store.read().files, before.files);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
test('Office workers stop on active cancellation, and later previews still work', async () => {
  const source = file('Cancel.docx', (await doc('Cancelable content. '.repeat(6000))).bytes);
  const controller = new AbortController();
  const pending = readOffice(source, { signal: controller.signal });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(pending, { name: 'AbortError' });
  const next = await readOffice(
    file('Next.docx', (await doc('Still readable after cancellation.')).bytes),
  );
  assert.match(next.text, /Still readable/);
});
test('Office readers reject bad XML, mismatched CRC and duplicated ZIP names', async () => {
  const { bytes } = await doc('Original text');
  const badXml = await alter(bytes, (z) => z.file('word/document.xml', '<w:document>'));
  await assert.rejects(parseOffice(badXml, 'document'));
  const storeZip = await alter(bytes, (z) => {
    z.file('sameA.xml', '<x>one</x>');
    z.file('sameB.xml', '<x>two</x>');
  });
  const duplicate = Buffer.from(storeZip);
  for (let pos = 0; (pos = duplicate.indexOf('sameB.xml', pos)) !== -1; pos += 9)
    duplicate.write('sameA.xml', pos);
  await assert.rejects(parseOffice(duplicate, 'document'), /duplicate parts/);
  const originalZip = await JSZip.loadAsync(bytes);
  const stored = await originalZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const corrupted = Buffer.from(stored);
  const text = corrupted.indexOf('Original text');
  assert.ok(text > 0);
  corrupted[text] = 'X'.charCodeAt(0);
  await assert.rejects(parseOffice(corrupted, 'document'), /damaged content/);
});
test('Generic text uploads still reach the assistant while binary archives do not', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const f = store.mutate((s) =>
      command(s, 'file.add', {
        name: 'note.txt',
        mime: 'application/octet-stream',
        base64: Buffer.from('A plain note').toString('base64'),
      }),
    );
    assert.equal((await executeTool(store, 'read_file', { id: f.id })).result.text, 'A plain note');
  } finally {
    store.close();
  }
});
