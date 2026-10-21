// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readComputerFile } from '../server/computer-file-reading.mjs';
import { renderArtifact } from '../server/artifacts.mjs';
import { executeTool } from '../server/agent.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { Store } from '../server/store.mjs';

const file = (name, bytes) => ({ name, base64: Buffer.from(bytes).toString('base64') });
test('private computer reads actual Office and PDF content without importing it into the library', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Cedar room at 10:30', { font });
    const sources = [
      [
        'Meeting.docx',
        await renderArtifact({
          kind: 'document',
          title: 'Meeting',
          source: 'Cedar room at **10:30**. 你好 🌱',
        }),
        /Cedar room at 10:30.*你好 🌱/,
      ],
      [
        'Costs.xlsx',
        await renderArtifact({
          kind: 'spreadsheet',
          title: 'Costs',
          source: JSON.stringify({
            sheets: [
              {
                name: 'Costs',
                rows: [
                  ['Item', 'Cost'],
                  ['Tea', 8],
                ],
              },
            ],
          }),
        }),
        /Tea.*8/,
      ],
      [
        'Brief.pptx',
        await renderArtifact({
          kind: 'presentation',
          title: 'Brief',
          source: JSON.stringify({
            slides: [{ title: 'Cedar room', bullets: ['Meet at 10:30'], notes: 'Bring an agenda' }],
          }),
        }),
        /Bring an agenda/,
      ],
      ['Visit.PDF', { bytes: await pdf.save() }, /Cedar room at 10:30/],
    ];
    const before = structuredClone(store.read());
    for (const [name, rendered, expected] of sources) {
      computer.read = async () => file(name, rendered.bytes);
      const { result } = await executeTool(
        store,
        'computer_files',
        { action: 'read', path: '/workspace/' + name },
        { computer },
      );
      assert.match(result.text, expected);
      assert.equal(result.location, 'private_computer');
      assert.equal(result.path, '/workspace/' + name);
      assert.match(result.sourceNotice, /untrusted source data/);
      assert.equal(result.base64, undefined);
      assert.equal(result.nextOffset, null);
      assert.equal(result.truncated, false);
    }
    assert.deepEqual(
      store.read(),
      before,
      'Reading must not create library files or chat messages.',
    );
  } finally {
    store.close();
  }
});

test('computer text pages preserve Unicode boundaries and reject a changed or missing continuation hash', async () => {
  const text = 'a'.repeat(31999) + '🌱你好' + 'b'.repeat(40000);
  const source = file('Notes.txt', text);
  let result = await readComputerFile(source);
  assert.equal(result.nextOffset, 31999);
  assert.equal(result.truncated, true);
  await assert.rejects(readComputerFile(source, { offset: result.nextOffset }), /changed/);
  await assert.rejects(
    readComputerFile(file('Notes.txt', text + '!'), {
      offset: result.nextOffset,
      contentHash: result.contentHash,
    }),
    /changed/,
  );
  let joined = result.text;
  while (result.nextOffset !== null) {
    result = await readComputerFile(source, {
      offset: result.nextOffset,
      contentHash: result.contentHash,
    });
    joined += result.text;
  }
  assert.equal(joined, text);
  assert.equal(result.totalLength, text.length);
  assert.equal(result.truncated, false);
  for (const offset of [-1, 1.5, text.length + 1])
    await assert.rejects(
      readComputerFile(source, { offset, contentHash: result.contentHash }),
      /offset/,
    );
});

test('computer Office pages retain the parser hash contract across the tool boundary', async () => {
  const { bytes } = await renderArtifact({
    kind: 'document',
    title: 'Long plan',
    source: 'Meeting at 10:30. 你好 🌱\n\n'.repeat(1400),
  });
  const source = file('Long.docx', bytes);
  let page = await readComputerFile(source);
  assert.ok(page.nextOffset);
  await assert.rejects(readComputerFile(source, { offset: page.nextOffset }), /changed/);
  let text = page.text;
  while (page.nextOffset !== null) {
    page = await readComputerFile(source, {
      offset: page.nextOffset,
      contentHash: page.contentHash,
    });
    text += page.text;
  }
  assert.equal(text.match(/Meeting at 10:30/g).length, 1400);
});

test('unknown binaries never leak raw bytes as text, and damaged documents fail explicitly', async () => {
  for (const bytes of [Buffer.from([255, 254, 80, 75]), Buffer.from('header\0body')]) {
    const result = await readComputerFile(file('Unknown.bin', bytes));
    assert.equal(result.kind, 'binary');
    assert.equal(result.text, undefined);
    assert.equal(result.base64, undefined);
    assert.equal(result.size, bytes.length);
    assert.match(result.instruction, /suitable program/);
    await assert.rejects(
      readComputerFile(file('Unknown.bin', bytes), { offset: 1, contentHash: result.contentHash }),
      /binary file/,
    );
  }
  for (const name of ['Broken.docx', 'Broken.xlsx', 'Broken.pptx', 'Broken.pdf'])
    await assert.rejects(readComputerFile(file(name, 'not a document')));
  await assert.rejects(readComputerFile(file('Large.txt', Buffer.alloc(8_000_001))), /8 MB/);
});

test('cancelling an active computer document parse returns no partial file content', async () => {
  const controller = new AbortController();
  const { bytes } = await renderArtifact({
    kind: 'document',
    title: 'Cancelled',
    source: 'Cancel this pending file reader.\n\n'.repeat(1000),
  });
  const pending = readComputerFile(file('Cancelled.docx', bytes), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(
    readComputerFile(file('Note.txt', 'secret'), { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('taking control while a document parser is running discards its result', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.inspect = async () => null;
  computer.runtime.pause = async () => {};
  try {
    const { bytes } = await renderArtifact({
      kind: 'document',
      title: 'Private after takeover',
      source: 'Do not return this pending content.\n\n'.repeat(1100),
    });
    let take;
    const takeover = new Promise((resolve, reject) => {
      take = () => computer.takeControl().then(resolve, reject);
    });
    computer.read = async () => {
      setTimeout(take, 0);
      return file('Private.docx', bytes);
    };
    await assert.rejects(
      executeTool(store, 'computer_files', { action: 'read', path: 'Private.docx' }, { computer }),
      /control changed/,
    );
    await takeover;
    assert.equal(store.read().files.length, 0);
  } finally {
    store.close();
  }
});
