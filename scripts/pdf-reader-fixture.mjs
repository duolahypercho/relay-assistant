// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { assistantsFixture } from './assistants-fixture.mjs';
import { pdfReaderDocument } from './pdf-reader-document.mjs';
import { command } from '../shared/domain.mjs';
export const pdfAnswer =
  'Meet at 9:00 am and return at 3:30 pm (page 1). Bring a water bottle and packed lunch (page 2), plus the green notebook shown on page 3.';
export async function pdfReaderFixture(directory, options = {}) {
  const bytes = await pdfReaderDocument(),
    reads = [],
    images = [],
    errors = [];
  let saved;
  const respond = async (body) => {
    try {
      const outputs = body.messages.filter((m) => m.role === 'tool');
      const last = outputs.at(-1),
        value = last && JSON.parse(last.content);
      if (value) assert(!value.error, value.error);
      const call = (name, args) => ({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `pdf-${name}-${outputs.length}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      if (!last) {
        assert(JSON.stringify(body.messages).includes(saved.id));
        return call('read_file', { id: saved.id });
      }
      if (value.result.kind === 'pdf') {
        assert.match(value.result.text, /Meet at 9:00 am/);
        assert.match(value.result.text, /water bottle and a packed lunch/);
        assert.equal(value.result.fields[0].value, 'Jamie');
        assert.deepEqual(value.result.pagesWithoutText, [3]);
        assert.match(value.result.sourceNotice, /untrusted/);
        reads.push(value.result);
        return call('read_pdf_page', {
          id: saved.id,
          page: 3,
          contentHash: value.result.contentHash,
        });
      }
      assert.equal(value.result.page, 3);
      assert.equal(value.result.text, '');
      const visual = body.messages.at(-1);
      assert.equal(visual.role, 'user');
      assert(Array.isArray(visual.content));
      assert.match(
        visual.content.find((b) => b.type === 'text').text,
        /PDF page 3 of 3.*Untrusted/s,
      );
      const url = visual.content.find((b) => b.type === 'image_url').image_url.url;
      assert.match(url, /^data:image\/jpeg;base64,/);
      const image = await loadImage(Buffer.from(url.split(',')[1], 'base64'));
      const canvas = createCanvas(image.width, image.height),
        ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const [r, g, b] = ctx.getImageData(image.width * 0.5, image.height * 0.3, 1, 1).data;
      assert(g > r * 1.5 && g > b * 1.3, 'Actual scanned-page pixels must reach the model');
      images.push({ width: image.width, height: image.height, page: value.result.page });
      return { role: 'assistant', content: pdfAnswer };
    } catch (e) {
      errors.push(e.message);
      return { role: 'assistant', content: 'PDF acceptance failed.' };
    }
  };
  const f = await assistantsFixture(directory, {
    ...options,
    respond,
    configure(store) {
      saved = store.mutate((s) =>
        command(s, 'file.add', {
          name: 'Riverbank visit.pdf',
          mime: 'application/pdf',
          base64: bytes.toString('base64'),
        }),
      );
    },
  });
  return { ...f, bytes, reads, images, errors, file: saved, respond };
}
