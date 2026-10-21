// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { pdfFormDocument, pdfFormValues } from './pdf-form-document.mjs';
export const pdfFormRequest =
  'Fill the attached Saturday form for Jamie Example, contact 555-0100. Travel by Train, bring a packed lunch, choose Apple for snack and Book and Water for supplies. Notes: "Meet by the river.\nLeave the afternoon open." Keep the existing reference. Save a filled copy here.';
export async function attachPdfForm(store) {
  const bytes = await pdfFormDocument();
  const file = store.mutate((s) =>
    command(s, 'file.add', {
      name: 'Riverbank.pdf',
      mime: 'application/pdf',
      base64: bytes.toString('base64'),
    }),
  );
  store.mutate((s) => command(s, 'thread.update', { id: 'main', draftFileIds: [file.id] }));
  return { file, bytes };
}
export async function pdfFormsFixture(directory, options = {}) {
  let source;
  const errors = [];
  const f = await assistantsFixture(directory, {
    ...options,
    configure: async (store) => {
      source = await attachPdfForm(store);
    },
    respond: async (body) => {
      try {
        const last = body.messages.findLast((m) => m.role === 'tool');
        const value = last && JSON.parse(last.content);
        assert(!value?.error, value?.error);
        const call = (name, args) => ({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        });
        if (!last) return call('read_file', { id: source.file.id });
        if (last.tool_call_id === 'read_file') {
          assert.equal(
            value.result.fields.find((f) => f.name === 'reference').value,
            'SOURCE-KEEP-42',
          );
          return call('fill_pdf_form', {
            id: source.file.id,
            contentHash: value.result.contentHash,
            fields: pdfFormValues,
          });
        }
        assert.equal(value.result.preservedOriginal, true);
        assert.deepEqual(value.result.remainingRequired, []);
        return {
          role: 'assistant',
          content: 'Your filled form is ready. I kept the original and its reference.',
        };
      } catch (error) {
        errors.push(error.message);
        return { role: 'assistant', content: 'Form acceptance failed.' };
      }
    },
  });
  return { ...f, ...source, errors };
}
