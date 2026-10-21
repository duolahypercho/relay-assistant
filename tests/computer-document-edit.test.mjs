// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun, Footer } from 'docx';
import { readComputerFile } from '../server/computer-file-reading.mjs';
import { editComputerDocx } from '../server/computer-document-edit.mjs';
import { executeTool } from '../server/agent.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { Store } from '../server/store.mjs';
async function fixture(text = '09:00') {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          footers: { default: new Footer({ children: [new Paragraph('Keep this footer.')] }) },
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Meeting time: ', bold: true }), new TextRun(text)],
            }),
          ],
        },
      ],
    }),
  );
  const file = { name: 'Meeting.docx', base64: bytes.toString('base64') };
  return { file, bytes, ...(await readComputerFile(file)) };
}
test('precise Word edit changes only its target text bytes and preserves every other ZIP part', async () => {
  const f = await fixture();
  const result = await editComputerDocx(f.file, {
    contentHash: f.contentHash,
    edits: [{ find: '09:00', replace: '10:30' }],
  });
  const original = await JSZip.loadAsync(f.bytes),
    edited = await JSZip.loadAsync(Buffer.from(result.base64, 'base64'));
  assert.deepEqual(Object.keys(edited.files), Object.keys(original.files));
  for (const name of Object.keys(original.files)) {
    const before = await original.file(name)?.async('nodebuffer'),
      after = await edited.file(name)?.async('nodebuffer');
    if (name === 'word/document.xml') {
      assert.equal(after.toString(), before.toString().replace('09:00', '10:30'));
      assert.match(after.toString(), /<w:b[ />]/);
    } else assert.deepEqual(after, before, name);
  }
  assert.equal(result.changes, 1);
  assert.equal(f.file.base64, f.bytes.toString('base64'));
});
test('Word edits handle Unicode, escaped XML and multiple unique changes without injecting markup', async () => {
  const f = await fixture('Tea & coffee <3. 你好 🌱');
  const result = await editComputerDocx(f.file, {
    contentHash: f.contentHash,
    edits: [
      { find: 'Tea & coffee', replace: 'Bread <cake> & tea' },
      { find: '你好 🌱', replace: '早安 🍵' },
    ],
  });
  const read = await readComputerFile({ name: 'Updated.docx', base64: result.base64 });
  assert.match(read.text, /Bread <cake> & tea <3. 早安 🍵/);
});
test('ambiguous, absent, split-run and invalid edits fail instead of rewriting a paragraph', async () => {
  const f = await fixture('09:00 and 09:00');
  await assert.rejects(
    editComputerDocx(f.file, {
      contentHash: f.contentHash,
      edits: [{ find: '09:00', replace: '10:30' }],
    }),
    /more than once/,
  );
  const single = await fixture();
  await assert.rejects(
    editComputerDocx(single.file, {
      contentHash: single.contentHash,
      edits: [{ find: 'Meeting time: 09:00', replace: 'Different' }],
    }),
    /single Word text run/,
  );
  await assert.rejects(
    editComputerDocx(single.file, {
      contentHash: single.contentHash,
      edits: [
        { find: '09:00', replace: '10:30' },
        { find: 'absent', replace: 'new' },
      ],
    }),
    /not found/,
  );
  for (const edits of [
    [],
    [{ find: '', replace: 'x' }],
    [{ find: '09:00', replace: '\0' }],
    [{ find: '09:00', replace: '\ud800' }],
  ])
    await assert.rejects(
      editComputerDocx(single.file, { contentHash: single.contentHash, edits }),
      /plain-text/,
    );
});
test('stale hashes, signed packages and cancellation cannot produce an edited result', async () => {
  const f = await fixture();
  const edits = [{ find: '09:00', replace: '10:30' }];
  await assert.rejects(editComputerDocx(f.file, { edits }), /contentHash/);
  await assert.rejects(editComputerDocx(f.file, { edits, contentHash: '0'.repeat(64) }), /changed/);
  const zip = await JSZip.loadAsync(f.bytes);
  zip.file('_xmlsignatures/origin.sigs', 'signed');
  const signed = { name: 'Signed.docx', base64: await zip.generateAsync({ type: 'base64' }) };
  const parsed = await readComputerFile(signed);
  await assert.rejects(
    editComputerDocx(signed, { edits, contentHash: parsed.contentHash }),
    /signed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    editComputerDocx(f.file, { edits, contentHash: f.contentHash, signal: controller.signal }),
    { name: 'AbortError' },
  );
});
test('the agent saves only a new computer copy with a durable operation ID and no library mutation', async () => {
  const store = new Store(':memory:', { sample: false }),
    computer = new PrivateComputer(store, { enabled: true });
  try {
    const f = await fixture();
    let written;
    computer.read = async () => f.file;
    computer.perform = async (request) => {
      written = request;
      return { path: request.path };
    };
    const p = {
      path: 'Meeting.docx',
      outputPath: 'Updated.docx',
      contentHash: f.contentHash,
      edits: [{ find: '09:00', replace: '10:30' }],
      operationId: 'edit-once',
    };
    const before = structuredClone(store.read());
    const { result } = await executeTool(store, 'computer_edit_docx', p, { computer });
    assert.equal(result.changes, 1);
    assert.equal(written.overwrite, false);
    assert.equal(written.operationId, 'edit-once');
    assert.match(
      (await readComputerFile({ name: 'Updated.docx', base64: written.base64 })).text,
      /10:30/,
    );
    assert.deepEqual(store.read(), before);
    written = undefined;
    await assert.rejects(
      executeTool(store, 'computer_edit_docx', { ...p, contentHash: '0'.repeat(64) }, { computer }),
      /changed/,
    );
    assert.equal(written, undefined);
  } finally {
    store.close();
  }
});

test('precise edits preserve UTF-16 XML and namespace aliases, and refuse whitespace requiring new formatting', async () => {
  const f = await fixture();
  const zip = await JSZip.loadAsync(f.bytes);
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replaceAll('w:', 'q:').replace('xmlns:w=', 'xmlns:q=').replace('UTF-8', 'UTF-16');
  zip.file(
    'word/document.xml',
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]),
  );
  const file = { name: 'Unicode.docx', base64: await zip.generateAsync({ type: 'base64' }) };
  const { contentHash } = await readComputerFile(file);
  const edited = await editComputerDocx(file, {
    contentHash,
    edits: [{ find: '09:00', replace: '10:30' }],
  });
  const output = await JSZip.loadAsync(Buffer.from(edited.base64, 'base64'));
  const part = await output.file('word/document.xml').async('nodebuffer');
  assert.deepEqual(part.subarray(0, 2), Buffer.from([255, 254]));
  assert.equal(part.subarray(2).toString('utf16le'), xml.replace('09:00', '10:30'));
  const plain = await JSZip.loadAsync(f.bytes);
  plain.file(
    'word/document.xml',
    (await plain.file('word/document.xml').async('string')).replaceAll(' xml:space="preserve"', ''),
  );
  const source = { name: 'Plain.docx', base64: await plain.generateAsync({ type: 'base64' }) };
  const read = await readComputerFile(source);
  await assert.rejects(
    editComputerDocx(source, {
      contentHash: read.contentHash,
      edits: [{ find: '09:00', replace: ' 10:30' }],
    }),
    /whitespace/,
  );
});

test('owner takeover during a precise edit prevents any computer write', async () => {
  const store = new Store(':memory:', { sample: false }),
    computer = new PrivateComputer(store, { enabled: true });
  computer.inspect = async () => null;
  computer.runtime.pause = async () => {};
  try {
    const f = await fixture('09:00 plus some unique pending content.');
    let written = false,
      finish;
    const takeover = new Promise((resolve) => {
      finish = resolve;
    });
    computer.read = async () => {
      setTimeout(() => computer.takeControl().then(finish), 0);
      return f.file;
    };
    computer.perform = async () => {
      written = true;
    };
    await assert.rejects(
      executeTool(
        store,
        'computer_edit_docx',
        {
          path: 'Meeting.docx',
          outputPath: 'Copy.docx',
          contentHash: f.contentHash,
          edits: [{ find: '09:00', replace: '10:30' }],
          operationId: 'takeover',
        },
        { computer },
      ),
      /control changed/,
    );
    await takeover;
    assert.equal(written, false);
  } finally {
    store.close();
  }
});
