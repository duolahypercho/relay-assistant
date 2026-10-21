// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { inspectPdf, pdfFieldValue } from '../shared/pdf.mjs';
import { saveFilledPdf } from '../server/pdf-forms.mjs';
import { readPdf } from '../server/pdf-reader.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { pdfFormDocument, pdfFormValues } from '../scripts/pdf-form-document.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t, alter) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  let bytes = await pdfFormDocument();
  if (alter) {
    const doc = await PDFDocument.load(bytes);
    await alter(doc);
    bytes = Buffer.from(await doc.save({ updateFieldAppearances: false }));
  }
  const file = store.mutate((s) =>
    command(s, 'file.add', {
      name: 'Saturday.pdf',
      mime: 'application/pdf',
      base64: bytes.toString('base64'),
    }),
  );
  const input = { id: file.id, contentHash: hash(bytes), fields: pdfFormValues };
  return {
    store,
    file,
    bytes,
    input,
    save: (inputOverride = {}, options = {}) =>
      saveFilledPdf(
        store,
        { ...input, ...inputOverride },
        { operationId: 'form-test', ...options },
      ),
  };
}
test('a filled PDF copy has exact canonical values on both pages, unchanged source/reference and visible appearances', async (t) => {
  const f = await fixture(t),
    result = await f.save();
  const saved = f.store.read().files.find((x) => x.id === result.id);
  const doc = await PDFDocument.load(Buffer.from(saved.base64, 'base64'));
  assert.equal(doc.getPageCount(), 2);
  assert.equal(result.pageCount, 2);
  for (const change of pdfFormValues)
    assert.deepEqual(
      pdfFieldValue(doc.getForm().getField(change.name)),
      change.name === 'snack' ? [change.value] : change.value,
    );
  assert.equal(doc.getForm().getTextField('reference').getText(), 'SOURCE-KEEP-42');
  assert.equal(
    f.store.read().files.find((x) => x.id === f.file.id).base64,
    f.bytes.toString('base64'),
  );
  assert.deepEqual(result.remainingRequired, []);
  const info = await inspectPdf(Buffer.from(saved.base64, 'base64'));
  assert.deepEqual(info.fields.find((x) => x.name === 'travel').options, ['Train', 'Bus']);
  assert.equal(info.fields.find((x) => x.name === 'participant').maxLength, 80);
  assert(info.fields.find((x) => x.name === 'supplies').multiselect);
});
test('partial fills preserve unmentioned fields and disclose required blanks', async (t) => {
  const f = await fixture(t),
    result = await f.save({ fields: [{ name: 'notes', value: 'Bring tea.' }] });
  assert.deepEqual(result.remainingRequired, ['participant', 'contact']);
  assert.equal(f.store.read().files.length, 2);
});
test('unknown fields, wrong types/options, length overflow and unsupported font characters save no partial file', async (t) => {
  const f = await fixture(t);
  for (const fields of [
    [],
    [{ name: 'missing', value: 'A' }],
    [{ name: 'participant', value: 'A'.repeat(81) }],
    [{ name: 'packed_lunch', value: 'yes' }],
    [{ name: 'snack', value: 'Cake' }],
    [{ name: 'travel', value: ['Train'] }],
    [{ name: 'participant', value: '两位' }],
    [{ name: 'participant', value: 'A\nB' }],
    [{ name: 'snack', value: ['Apple', 'None'] }],
    [
      { name: 'notes', value: 'A' },
      { name: 'notes', value: 'B' },
    ],
  ]) {
    await assert.rejects(f.save({ fields }));
    assert.equal(f.store.read().files.length, 1);
  }
});
test('read-only, password, ambiguous widgets, signed and XFA forms are never silently modified', async (t) => {
  for (const alter of [
    (d) => d.getForm().getTextField('participant').enableReadOnly(),
    (d) => {
      const field = d.getForm().getTextField('participant');
      field.setText('PRIVATE-PASSWORD');
      field.enablePassword();
    },
    (d) => {
      const field = d.getForm().getTextField('contact');
      field.acroField.setPartialName('participant');
    },
    (d) =>
      d.getPages()[0].node.addAnnot(
        d.context.register(
          d.context.obj({
            Type: 'Annot',
            Subtype: 'Widget',
            FT: 'Tx',
            T: PDFString.of('orphan'),
            Rect: [20, 20, 50, 50],
          }),
        ),
      ),
    (d) => {
      const sig = d.context.register(
        d.context.obj({
          FT: 'Sig',
          T: PDFString.of('signature'),
          V: d.context.obj({ Type: 'Sig' }),
        }),
      );
      d.getForm().acroForm.addField(sig);
    },
    (d) =>
      d.getForm().acroForm.dict.set(PDFName.of('XFA'), PDFString.of('Unsupported dynamic form')),
  ]) {
    const f = await fixture(t, alter);
    await assert.rejects(f.save());
    assert.equal(f.store.read().files.length, 1);
    if ((await inspectPdf(f.bytes)).fields.some((x) => x.protected))
      assert(!JSON.stringify(await inspectPdf(f.bytes)).includes('PRIVATE-PASSWORD'));
  }
});
test('same values and concurrent requests reuse one copy; operation IDs cannot change intent', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.save(), f.save()]);
  assert.equal(a.id, b.id);
  assert.equal(f.store.read().files.length, 2);
  assert.equal((await f.save({}, { operationId: 'other-retry' })).id, a.id);
  await assert.rejects(
    f.save({ fields: [{ name: 'participant', value: 'Another name' }] }),
    /different values/,
  );
});
test('stale source, changed source during parsing and cancellation prevent publication', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.save({ contentHash: 'f'.repeat(64) }), /changed/);
  const control = new AbortController();
  const pending = f.save({}, { signal: control.signal });
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.store.read().files.length, 1);
  let guards = 0;
  await assert.rejects(
    f.save(
      {},
      {
        guard: () => {
          if (++guards === 2)
            f.store.mutate((s) => {
              s.files[0].base64 = '';
            });
        },
      },
    ),
    /changed/,
  );
  assert.equal(f.store.read().files.length, 1);
});
test('the actual worker can read and fill from a chat request without a task or repeated input form', async (t) => {
  const f = await fixture(t);
  let round = 0;
  const tool = (name, args) => ({
    text: '',
    toolCalls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }],
  });
  const services = {
    mode: 'live',
    provider: {
      configured: true,
      complete: async (messages) => {
        round++;
        if (round === 1) return tool('read_file', { id: f.file.id });
        if (round === 2) {
          const { result } = JSON.parse(messages.at(-1).content);
          assert.equal(result.contentHash, f.input.contentHash);
          return tool('fill_pdf_form', f.input);
        }
        return { text: 'Your filled copy is ready.', toolCalls: [] };
      },
    },
    google: {},
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(f.store, services);
  t.after(() => worker.stop());
  const run = f.store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: 'Fill this for Jamie Example. The details are in my message.',
      fileIds: [f.file.id],
    }),
  );
  await worker.reply(run.id, new AbortController().signal);
  const state = f.store.read();
  assert.equal(state.runs[0].status, 'completed', state.runs[0].error);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.files.length, 2);
  assert(state.messages.at(-1).cards.some((c) => c.id !== f.file.id));
  assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
  const filled = state.files.find((x) => x.id !== f.file.id);
  const read = await readPdf(filled);
  assert.equal(read.fields.find((x) => x.name === 'participant').value, 'Jamie Example');
});
