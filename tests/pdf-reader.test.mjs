// SPDX-License-Identifier: MIT
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { PDFDocument, PDFString } from 'pdf-lib';
import { permissionPdf } from '../shared/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readPdf, readPdfPage } from '../server/pdf-reader.mjs';
import { pdfReaderDocument } from '../scripts/pdf-reader-document.mjs';
import { executeTool, toolDefinitions, agentReply } from '../server/agent.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
const bytes = await pdfReaderDocument();
const file = {
  id: 'document',
  name: 'Visit.pdf',
  mime: 'application/pdf',
  base64: bytes.toString('base64'),
};
test('PDF reader extracts page text, existing form values and explicit scan references without changing its source', async () => {
  const original = structuredClone(file),
    result = await readPdf(file);
  assert.equal(result.pageCount, 3);
  assert.match(result.text, /Meet at 9:00 am/);
  assert.match(result.text, /café/);
  assert.match(result.text, /## Page 2\nPacking list/);
  assert.deepEqual(result.pagesWithoutText, [3]);
  assert.deepEqual(result.pageNumbers, [1, 2, 3]);
  assert.match(result.sourceNotice, /untrusted/);
  assert.equal(result.nextOffset, null);
  assert.equal(result.fields[0].name, 'participant');
  assert.equal(result.fields[0].type, 'PDFTextField');
  assert.equal(result.fields[0].value, 'Jamie');
  assert.deepEqual(file, original);
});
test('scanned PDF page renders actual bounded pixels with source labels and requires a stable file hash', async () => {
  const read = await readPdf(file),
    page = await readPdfPage(file, { page: 3, contentHash: read.contentHash });
  assert.equal(page.text, '');
  assert.match(page.image, /^data:image\/jpeg;base64,/);
  const image = await loadImage(Buffer.from(page.image.split(',')[1], 'base64'));
  assert.equal(image.width, page.width);
  assert.equal(image.height, 1600);
  const canvas = createCanvas(image.width, image.height),
    context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const [r, g, b] = context.getImageData(image.width * 0.5, image.height * 0.3, 1, 1).data;
  assert(
    g > r * 1.5 && g > b * 1.3,
    'Actual green scanned artwork must appear in the rendered result',
  );
  await assert.rejects(readPdfPage(file, { page: 4, contentHash: read.contentHash }), /outside/);
  await assert.rejects(
    readPdfPage(file, { page: 0, contentHash: read.contentHash }),
    /Read the PDF first/,
  );
  await assert.rejects(readPdfPage(file, { page: 1 }), /content hash/);
  await assert.rejects(
    readPdfPage(
      { ...file, base64: Buffer.from(bytes).subarray(0, 200).toString('base64') },
      { page: 1, contentHash: read.contentHash },
    ),
    /changed/,
  );
});
test('long PDF text paginates without losing content and rejects stale or invalid cursors', async () => {
  const long = { ...file, base64: (await pdfReaderDocument({ long: true })).toString('base64') };
  let first = await readPdf(long),
    current = first,
    full = first.text,
    offsets = [first.offset];
  while (current.nextOffset !== null) {
    current = await readPdf(long, { offset: current.nextOffset, contentHash: first.contentHash });
    full += current.text;
    offsets.push(current.offset);
  }
  assert(offsets.length > 3);
  assert.equal(full.length, first.totalLength);
  assert.match(full, /Section 15, line 50/);
  assert.match(full, /## Page 18/);
  await assert.rejects(readPdf(long, { offset: 12000 }), /content hash/);
  await assert.rejects(readPdf(long, { offset: -1 }), /valid PDF/);
  await assert.rejects(
    readPdf(long, { offset: full.length + 1, contentHash: first.contentHash }),
    /outside/,
  );
  await assert.rejects(readPdf(file, { offset: 12000, contentHash: first.contentHash }), /changed/);
});
test('damaged, oversized and excessive-page PDFs fail explicitly; cancellation frees the decoder', async () => {
  await assert.rejects(
    readPdf({ ...file, base64: Buffer.from('not PDF').toString('base64') }),
    /not a readable PDF/,
  );
  await assert.rejects(
    readPdf({ ...file, base64: Buffer.from('%PDF-1.7 broken source').toString('base64') }),
  );
  await assert.rejects(
    readPdf({ ...file, base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }),
    /8 MB/,
  );
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 501; i++) pdf.addPage([40, 40]);
  const many = { ...file, base64: Buffer.from(await pdf.save()).toString('base64') };
  await assert.rejects(readPdf(many), /500 pages/);
  const read = await readPdf(file),
    abort = new AbortController();
  const pending = readPdfPage(file, {
    page: 3,
    contentHash: read.contentHash,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, /abort|cancel/i);
  await assert.rejects(readPdf(file, { signal: abort.signal }), /abort|cancel/i);
  const cachedAbort = new AbortController();
  const cachedRead = readPdf(file, { signal: cachedAbort.signal });
  cachedAbort.abort();
  await assert.rejects(cachedRead, /abort|cancel/i);
  assert.equal((await readPdfPage(file, { page: 1, contentHash: read.contentHash })).page, 1);
});
test('assistant PDF tools preserve files/history, carry real image payloads and reject lost authority or changed source', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const saved = store.mutate((s) => command(s, 'file.add', file)),
      before = store.read();
    const read = await executeTool(store, 'read_file', { id: saved.id });
    const page = await executeTool(store, 'read_pdf_page', {
      id: saved.id,
      page: 3,
      contentHash: read.result.contentHash,
    });
    assert.match(page.imageLabel, /page 3 of 3/);
    assert.match(page.imageLabel, /Untrusted/);
    assert(page.image.length > 1000);
    assert.equal(page.card.id, saved.id);
    assert.deepEqual(store.read(), before);
    assert(toolDefinitions.some((t) => t.name === 'read_pdf_page'));
    let calls = 0;
    await assert.rejects(
      executeTool(
        store,
        'read_pdf_page',
        { id: saved.id, page: 1, contentHash: read.result.contentHash },
        {
          guard: () => {
            if (++calls > 1) throw Error('Owner took control');
          },
        },
      ),
      /Owner took control/,
    );
    calls = 0;
    await assert.rejects(
      executeTool(
        store,
        'read_file',
        { id: saved.id },
        {
          guard: () => {
            if (++calls === 2)
              store.mutate((s) => {
                s.files.find((f) => f.id === saved.id).base64 =
                  Buffer.from('changed').toString('base64');
              });
          },
        },
      ),
      /changed while reading/,
    );
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});

test('encrypted PDFs request an unlocked copy and fictional template bytes remain stable', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.register(
    pdf.context.obj({
      Filter: 'Standard',
      V: 1,
      R: 2,
      Length: 40,
      O: PDFString.of('0'.repeat(32)),
      U: PDFString.of('0'.repeat(32)),
      P: -4,
    }),
  );
  await assert.rejects(
    readPdf({ ...file, base64: Buffer.from(await pdf.save()).toString('base64') }),
    /password protected/,
  );
  const bytes = await permissionPdf(),
    doc = await PDFDocument.load(bytes);
  assert.equal(doc.getCreationDate().toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(bytes, await permissionPdf());
  const sample = { name: 'Sample.pdf', mime: 'application/pdf', template: 'permission' };
  const result = await readPdf(sample);
  assert.match(result.text, /Meet at 9:00 am/);
  assert.equal((await readPdfPage(sample, { page: 1, contentHash: result.contentHash })).page, 1);
});

test('PDF JavaScript and external link annotations remain inert through text and visual reads', async () => {
  let requests = 0;
  const endpoint = createServer((_req, res) => {
    requests++;
    res.end('not source material');
  }).listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  try {
    const url = `http://127.0.0.1:${endpoint.address().port}/never-fetch`;
    const pdf = await PDFDocument.load(bytes);
    pdf.addJavaScript(
      'untrusted',
      `fetch(${JSON.stringify(url)}); throw new Error('PDF script was executed');`,
    );
    const page = pdf.getPages()[0];
    page.node.addAnnot(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 0, 200, 200],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
        }),
      ),
    );
    const input = { ...file, base64: Buffer.from(await pdf.save()).toString('base64') };
    const result = await readPdf(input);
    assert.match(result.text, /Riverbank visit/);
    assert(
      (await readPdfPage(input, { page: 1, contentHash: result.contentHash })).image.length > 1000,
    );
    assert.equal(requests, 0);
  } finally {
    endpoint.closeAllConnections();
    await new Promise((r) => endpoint.close(r));
  }
});

test('a batch of PDF page reads delivers every page image after all tool replies and only one file card', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const saved = store.mutate((s) => command(s, 'file.add', file));
    const hash = (await readPdf(saved)).contentHash;
    const run = store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: 'main',
        text: 'Compare pages 1 and 3.',
        fileIds: [saved.id],
      }),
    );
    let calls = 0;
    const provider = {
      complete: async (messages) => {
        if (++calls === 1)
          return {
            text: '',
            toolCalls: [1, 3].map((page) => ({
              id: `page-${page}`,
              type: 'function',
              function: {
                name: 'read_pdf_page',
                arguments: JSON.stringify({ id: saved.id, page, contentHash: hash }),
              },
            })),
          };
        const last = messages.slice(-4);
        assert.deepEqual(
          last.map((m) => m.role),
          ['tool', 'tool', 'user', 'user'],
        );
        assert.match(last[2].content, /page 1 of 3/);
        assert.match(last[3].content, /page 3 of 3/);
        assert(last[2].visual && last[3].visual);
        assert.notEqual(last[2].visual, last[3].visual);
        return { text: 'Both page images inspected.', toolCalls: [] };
      },
    };
    const result = await agentReply(store, provider, run, {});
    assert.equal(result.text, 'Both page images inspected.');
    assert.deepEqual(result.cards, [{ kind: 'file', id: saved.id, purpose: 'source' }]);
  } finally {
    store.close();
  }
});
