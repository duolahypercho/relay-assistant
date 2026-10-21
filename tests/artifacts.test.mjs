import { isMemoryReview, emptyMemoryReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
import {
  renderArtifact,
  saveArtifact,
  artifactToolInput,
  artifactContentCheck,
} from '../server/artifacts.mjs';
import {
  artifactKinds,
  calculateSheet,
  normalizeArtifact,
  previewHtml,
} from '../shared/artifacts.mjs';
import { executeTool, agentReply } from '../server/agent.mjs';
import { artifactHtmlCheck } from '../server/artifact-html.mjs';
const document = {
  kind: 'document',
  title: 'Weekend plan',
  source:
    '# A thoughtful weekend\n\n**Walk** by the river. [Source](https://example.com/plan)\n\n- Tea\n- A book\n\n| Item | Cost |\n| --- | --- |\n| Train | 25 |\n\n```js\nconst calm = true;\n```',
};
const spreadsheet = {
  kind: 'spreadsheet',
  title: 'Weekend budget',
  source: JSON.stringify({
    sheets: [
      {
        name: 'Budget',
        rows: [
          ['Item', 'Cost'],
          ['Train', 25],
          ['Tea', 8],
          ['Total', { formula: 'SUM(B2:B3)' }],
          ['Tax', { formula: 'ROUND(B4*0.075,2)' }],
          ['Literal', '=HYPERLINK("https://example.com")'],
        ],
      },
    ],
  }),
};
const presentation = {
  kind: 'presentation',
  title: 'Weekend ideas',
  source: JSON.stringify({
    slides: [
      {
        title: 'Room to breathe',
        bullets: ['Take the train', 'Walk by the river'],
        notes: 'Book a return ticket.',
      },
      { title: 'Keep it simple', bullets: ['Tea and a book'], notes: 'Leave the afternoon free.' },
    ],
  }),
};
test('structured model sheets and slides retain the source contract and export real Office files', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    for (const input of [spreadsheet, presentation]) {
      const { source, ...rest } = input;
      const structured = { ...rest, ...JSON.parse(source) };
      const created = await executeTool(store, 'save_artifact', structured);
      const saved = store.read().artifacts.find((a) => a.id === created.result.id);
      assert.deepEqual(JSON.parse(saved.versions[0].source), JSON.parse(source));
      const file = store.read().files.find((f) => f.id === created.result.fileId);
      assert(file.name.endsWith(input.kind === 'spreadsheet' ? '.xlsx' : '.pptx'));
      const revision = await executeTool(store, 'save_artifact', {
        ...structured,
        id: saved.id,
        expectedVersion: 1,
        title: input.title + ' revised',
      });
      assert.equal(revision.result.version, 2);
      assert.equal(
        store.read().artifacts.find((a) => a.id === saved.id).versions[0].fileId,
        file.id,
      );
      assert.deepEqual(artifactToolInput(input), input, 'Existing string-source calls stay valid.');
    }
  } finally {
    store.close();
  }
});
test('exact model edits preserve untargeted source and original exports across result types', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  for (const [input, find, replace] of [
    [document, 'by the river', 'by the lake'],
    [spreadsheet, 'Train', 'Bus'],
    [presentation, 'Take the train', 'Take the bus'],
    [
      { kind: 'web', title: 'Counter', source: '<p>One</p>\n<script>let count = 1;</script>' },
      'count = 1',
      'count = 2',
    ],
  ]) {
    const created = await executeTool(store, 'save_artifact', input);
    const prior = store.read().artifacts.find((a) => a.id === created.result.id).versions[0];
    const bytes = store.read().files.find((f) => f.id === created.result.fileId).base64;
    const revised = await executeTool(store, 'save_artifact', {
      id: created.result.id,
      expectedVersion: 1,
      edits: [{ find, replace }],
    });
    const artifact = store.read().artifacts.find((a) => a.id === created.result.id);
    assert.equal(revised.result.version, 2);
    assert.equal(artifact.versions[1].source, prior.source.replace(find, replace));
    assert.deepEqual(artifact.versions[0], prior);
    assert.equal(store.read().files.find((f) => f.id === created.result.fileId).base64, bytes);
    assert.equal(revised.card.id, artifact.versions[1].fileId);
  }
});

test('ambiguous, missing, conflicting, malformed and stale exact edits never save partial work', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const created = await executeTool(store, 'save_artifact', {
    ...document,
    source: '# Plan\n\nTea and tea.\n\nTea again.',
  });
  const target = { id: created.result.id, expectedVersion: 1 };
  const edit = { find: 'Tea and tea.', replace: 'Coffee.' };
  const before = store.read();
  for (const bad of [
    { edits: [edit] },
    { ...target, expectedVersion: 0, edits: [edit] },
    { ...target, edits: [] },
    { ...target, edits: Array(21).fill(edit) },
    { ...target, edits: [{ find: '', replace: 'x' }] },
    { ...target, edits: [{ find: 'Tea', replace: 'x' }] },
    { ...target, edits: [{ find: 'Missing', replace: 'x' }] },
    { ...target, edits: [{ find: '# Plan', replace: '# Plan' }] },
    { ...target, edits: [{ find: '# Plan', replace: {} }] },
    { ...target, edits: [{ find: '# Plan', replace: 'x'.repeat(200001) }] },
    { ...target, edits: [edit, { find: 'Missing', replace: 'x' }] },
    { ...target, edits: [edit], source: '# Competing content' },
    { ...target, edits: [edit], sheets: [] },
    { ...target, edits: [edit], title: 'Changed title' },
    { ...target, edits: [edit], kind: 'web' },
  ]) {
    await assert.rejects(executeTool(store, 'save_artifact', bad));
    assert.deepEqual(store.read(), before);
  }
  await executeTool(store, 'save_artifact', { ...target, edits: [edit] });
  const revised = store.read();
  await assert.rejects(
    executeTool(store, 'save_artifact', {
      ...target,
      edits: [{ find: '# Plan', replace: '# Revised' }],
    }),
    /newer version/,
  );
  assert.deepEqual(store.read(), revised);
  const sheet = await executeTool(store, 'save_artifact', spreadsheet);
  const withSheet = store.read();
  await assert.rejects(
    executeTool(store, 'save_artifact', {
      id: sheet.result.id,
      expectedVersion: 1,
      edits: [{ find: '"Train"', replace: 'invalid JSON' }],
    }),
    /JSON/,
  );
  assert.deepEqual(store.read(), withSheet);
});

test('Main and side-chat follow-ups retain their own saved result IDs without exposing other conversations', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const side = store.mutate((s) => command(s, 'thread.create', { title: 'Side' }));
  for (const threadId of ['main', side.id]) {
    const prior = store.mutate((s) =>
      command(s, 'chat.send', { threadId, text: 'Save my result.' }),
    );
    store.mutate((s) =>
      s.messages.push({
        id: `result-${threadId}`,
        threadId,
        role: 'assistant',
        replyTo: prior.messageId,
        text: 'Saved.',
        cards: [
          { kind: 'file', id: `saved-file-${threadId}` },
          { kind: 'workspace', id: 'files' },
        ],
      }),
    );
  }
  for (const threadId of ['main', side.id]) {
    const run = store.mutate((s) =>
      command(s, 'chat.send', { threadId, text: 'Update the result we made.' }),
    );
    let history;
    await agentReply(
      store,
      {
        complete: async (messages) => {
          if (isMemoryReview(messages)) return emptyMemoryReply();
          history = JSON.stringify(messages);
          assert(
            messages.some(
              (m) =>
                m.role === 'user' && m.content.includes('Relay context for the preceding message'),
            ),
          );
          assert(
            messages
              .filter((m) => m.role === 'assistant')
              .every((m) => !m.content.includes('saved-file-')),
          );
          assert.equal(
            messages.at(-1).content,
            `[Relay timestamp: ${store.read().messages.find((m) => m.id === run.messageId).createdAt}]\nUpdate the result we made.`,
          );
          return { text: 'Ready.', toolCalls: [] };
        },
      },
      run,
      {},
    );
    assert(history.includes(`saved-file-${threadId}`));
    assert(!history.includes(`saved-file-${threadId === 'main' ? side.id : 'main'}`));
    assert(!history.includes('"kind":"workspace"'));
  }
});

test('structured artifact input rejects ambiguity and malformed source without saving', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    for (const input of [
      { ...spreadsheet, sheets: [] },
      { ...document, sheets: [] },
      { kind: 'presentation', title: 'Slides', slides: [], sheets: [] },
      { kind: 'spreadsheet', title: 'Sheet', sheets: 'encoded' },
      {
        kind: 'spreadsheet',
        title: 'Sheet',
        sheets: [
          { name: 'Bad', rows: [['Cost'], [{ formula: 'WEBSERVICE("https://example.com")' }]] },
        ],
      },
      {
        kind: 'presentation',
        title: 'Slides',
        slides: [{ title: 'Too many bullets', bullets: Array(7).fill('x') }],
      },
      { kind: 'document', title: 'Empty' },
    ])
      await assert.rejects(executeTool(store, 'save_artifact', input));
    assert.equal(store.read().files.length, 0);
    assert.equal(store.read().artifacts?.length || 0, 0);
    assert.throws(
      () => artifactToolInput({ ...spreadsheet, source: '{bad JSON' }),
      /Correct the arguments and retry/,
    );
  } finally {
    store.close();
  }
});
test('model CSV shortcut exports formulas, quoted text and exact identifiers without a terminal', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const result = await executeTool(
      store,
      'save_artifact',
      {
        kind: 'spreadsheet',
        title: 'CSV shortcut',
        sheetName: 'Budget',
        csv: 'Item,Amount\r\n"Tea, lunch",25\r\nTax,"=ROUND(B2*0.08,2)"\r\nTotal,=SUM(B2:B3)\r\nCode,00123\r\nLong ID,12345678901234567\r\nLiteral,\'=SUM(B2:B3)\r\nText number,\'25\r\n"Two\nlines","A ""quote"""',
      },
      { terminal: { enabled: false } },
    );
    const file = store.read().files.find((f) => f.id === result.result.fileId);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(file.base64, 'base64'));
    const sheet = workbook.getWorksheet('Budget');
    assert.equal(sheet.getCell('A2').value, 'Tea, lunch');
    assert.equal(sheet.getCell('B2').value, 25);
    assert.equal(sheet.getCell('B3').result, 2);
    assert.equal(sheet.getCell('B4').formula, 'SUM(B2:B3)');
    assert.equal(sheet.getCell('B4').result, 27);
    assert.equal(sheet.getCell('B5').value, '00123');
    assert.equal(sheet.getCell('B6').value, '12345678901234567');
    assert.equal(sheet.getCell('B7').value, '=SUM(B2:B3)');
    assert.equal(sheet.getCell('B8').value, '25');
    assert.equal(sheet.getCell('A9').value, 'Two\nlines');
    assert.equal(sheet.getCell('B9').value, 'A "quote"');
    assert.equal(store.read().approvals.length, 0);
    for (const input of [
      { csv: 'x,y', sheets: [] },
      { csv: 'x,y', source: '{}' },
      { csv: 'x,y', kind: 'document' },
      { sheetName: 'Missing CSV' },
      { csv: 'x,"open' },
      { csv: 'x,y\nValue,=1/0' },
      { csv: 'x,y\nValue,=WEBSERVICE(A1)' },
      { csv: 'x'.repeat(200001) },
    ])
      await assert.rejects(
        executeTool(store, 'save_artifact', { kind: 'spreadsheet', title: 'Invalid', ...input }),
      );
    assert.equal(store.read().files.length, 1);
  } finally {
    store.close();
  }
});
test('DOCX contains headings, styled runs, working links, lists and a table; no image fetches', async () => {
  const result = await renderArtifact(document);
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Heading1/);
  assert.match(xml, /w:b/);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /Train/);
  assert.match(xml, /w:numPr/);
  const rel = await zip.file('word/_rels/document.xml.rels').async('string');
  assert.match(rel, /https:\/\/example.com\/plan/);
  assert.doesNotMatch(rel, /file:\/|javascript:/);
});
test('XLSX reopens with computed formula caches, literal strings and frozen header', async () => {
  const result = await renderArtifact(spreadsheet);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.bytes);
  const sheet = wb.getWorksheet('Budget');
  assert.equal(sheet.getCell('B4').formula, 'SUM(B2:B3)');
  assert.equal(sheet.getCell('B4').result, 33);
  assert.equal(sheet.getCell('B5').result, 2.48);
  assert.equal(sheet.getCell('B6').value, '=HYPERLINK("https://example.com")');
  assert.equal(sheet.views[0].ySplit, 1);
});
test('PPTX retains two distinct slides and actual speaker notes', async () => {
  const result = await renderArtifact(presentation);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /Room to breathe/);
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /Keep it simple/);
  assert.match(
    await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'),
    /Book a return ticket/,
  );
  assert.match(
    await zip.file('ppt/notesSlides/notesSlide2.xml').async('string'),
    /Leave the afternoon free/,
  );
});
test('spreadsheet calculation handles precedence, ranges, dependency chains and absolute references', () => {
  const formulas = [
    'SUM(A1:A3)',
    'AVERAGE(A1:A3)',
    'MIN(A1:A3)',
    'MAX(A1:A3)',
    'COUNT(A1:A3)',
    'ROUND(-2.55,1)',
    '($A$1+2)*3',
    '2^3^2',
    '-2^2',
    'A4+1',
  ];
  const rows = [[2], [4], [6], ...formulas.map((formula) => [{ formula }])];
  assert.deepEqual(calculateSheet(rows).slice(3).flat(), [12, 4, 2, 6, 3, -2.6, 12, 64, 4, 13]);
});
test('formulas reject cycles, external access, unsupported calls, ranges and costly expressions', () => {
  for (const formula of [
    'A1',
    '1/0',
    'WEBSERVICE("https://example.com")',
    'Sheet2!A1',
    'SUM(AX201)',
    'SUM(B3:B1)',
    'SUM(A1:A2)',
    '1+'.repeat(201) + '1',
    'ROUND(2,999)',
    '1e309',
    '1;process.exit()',
  ])
    assert.throws(() => calculateSheet([[{ formula }]]));
  assert.throws(() => calculateSheet([[{ formula: 'B1' }, { formula: 'A1' }]]), /circular/);
  assert.throws(() => calculateSheet([['hello', { formula: 'A1+1' }]]), /finite numbers/);
});
test('all result types validate limits and reject malformed structured content', () => {
  for (const input of [
    { ...document, kind: 'other' },
    { ...document, title: '' },
    { ...document, source: 'a'.repeat(200001) },
    { ...spreadsheet, source: '{' },
    { ...spreadsheet, source: '{"sheets":[]}' },
    { ...presentation, source: '{"slides":[]}' },
    {
      ...presentation,
      source: JSON.stringify({ slides: [{ title: 'a', bullets: Array(7).fill('x') }] }),
    },
  ])
    assert.throws(() => normalizeArtifact(input));
  assert.throws(
    () =>
      normalizeArtifact({
        ...spreadsheet,
        source: JSON.stringify({
          sheets: [
            { name: 'same', rows: [[1]] },
            { name: 'SAME', rows: [[2]] },
          ],
        }),
      }),
    /unique/,
  );
  assert.throws(
    () =>
      normalizeArtifact({
        ...spreadsheet,
        source: JSON.stringify({ sheets: [{ name: 'A', rows: [[{ formula: 'HYPERLINK(A2)' }]] }] }),
      }),
    /Unsupported/,
  );
});
test('versioned saves are idempotent across restarts, preserve originals, and reject stale edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-artifacts-'));
  let store = new Store(join(dir, 'db'), { sample: false });
  try {
    const first = await saveArtifact(store, { ...document, operationId: 'create' });
    const original = store.read().files[0].base64;
    store.close();
    store = new Store(join(dir, 'db'), { sample: false });
    assert.deepEqual(await saveArtifact(store, { ...document, operationId: 'create' }), first);
    await assert.rejects(
      saveArtifact(store, { ...document, title: 'Different', operationId: 'create' }),
      /different content/,
    );
    const edit = {
      ...document,
      id: first.id,
      expectedVersion: 1,
      source: '# Revised\n\nStill quiet.',
      operationId: 'edit',
    };
    const second = await saveArtifact(store, edit);
    assert.equal(second.version, 2);
    assert.deepEqual(await saveArtifact(store, edit), second);
    assert.equal(store.read().files.find((f) => f.id === first.fileId).base64, original);
    assert.equal(store.read().artifacts[0].versions[0].source, document.source);
    await assert.rejects(saveArtifact(store, { ...edit, operationId: 'stale' }), /newer version/);
    await assert.rejects(
      saveArtifact(store, {
        ...spreadsheet,
        id: first.id,
        expectedVersion: 2,
        operationId: 'change-kind',
      }),
      /same result type/,
    );
    assert.throws(
      () => store.mutate((s) => command(s, 'file.edit', { id: first.fileId, text: 'replace' })),
      /new version/,
    );
    assert.throws(
      () => store.mutate((s) => command(s, 'file.delete', { id: first.fileId })),
      /kept/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('concurrent saves cannot overwrite a newer version or duplicate the same operation', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const inputs = { ...document, operationId: 'same' };
    const results = await Promise.all([saveArtifact(store, inputs), saveArtifact(store, inputs)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(store.read().files.length, 1);
    const update = { ...document, id: results[0].id, expectedVersion: 1, source: '# Version two' };
    const edits = await Promise.allSettled([
      saveArtifact(store, { ...update, operationId: 'a' }),
      saveArtifact(store, { ...update, operationId: 'b' }),
    ]);
    assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(store.read().artifacts[0].versions.length, 2);
  } finally {
    store.close();
  }
});
test('a stopped run cannot commit its async export', async () => {
  const store = new Store(':memory:', { sample: false });
  let checks = 0;
  try {
    await assert.rejects(
      saveArtifact(
        store,
        { ...document, operationId: 'stopped' },
        {
          guard: () => {
            if (++checks >= 2) throw new Error('Stopped');
          },
        },
      ),
      /Stopped/,
    );
    assert.equal(store.read().files.length, 0);
  } finally {
    store.close();
  }
});
test('tools return result cards, list latest files and expose readable source for revisions', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const created = await executeTool(store, 'save_artifact', document, {
      operationId: 'tool',
      threadId: 'main',
    });
    assert.deepEqual(created.card, { kind: 'file', id: created.result.fileId });
    const read = await executeTool(store, 'read_file', { id: created.result.fileId });
    assert.equal(read.result.source, document.source);
    assert.deepEqual(read.result.revisionTarget, {
      id: created.result.id,
      expectedVersion: 1,
      kind: 'document',
      title: document.title,
    });
    await assert.rejects(
      executeTool(store, 'save_artifact', {
        ...document,
        id: created.result.id,
        expectedVersion: 2,
      }),
      /current version is 1.*not the next version/,
    );
    const next = await executeTool(
      store,
      'save_artifact',
      { ...document, id: created.result.id, expectedVersion: 1, source: '# Another' },
      { operationId: 'tool2' },
    );
    const files = await executeTool(store, 'list_files', {});
    assert.equal(files.result.length, 1);
    assert.equal(files.result[0].id, next.result.fileId);
    const old = await executeTool(store, 'read_artifact', { id: created.result.id, version: 1 });
    assert.equal(old.result.source, document.source);
    assert.equal(old.result.latestVersion, 2);
    assert.equal(
      old.result.revisionTarget.expectedVersion,
      1,
      'Revision target is pinned to the source actually read.',
    );
    const byFile = await executeTool(store, 'read_artifact', { id: created.result.fileId });
    assert.deepEqual(byFile.result, old.result, 'A result card reads its exact saved version');
    const current = await executeTool(store, 'read_artifact', { id: next.result.fileId });
    assert.equal(current.result.source, '# Another');
    assert.equal(current.result.revisionTarget.expectedVersion, 2);
    await assert.rejects(
      executeTool(store, 'read_artifact', { id: created.result.fileId, version: 2 }),
      /different version/,
    );
    await assert.rejects(
      executeTool(store, 'save_artifact', {
        ...byFile.result.revisionTarget,
        source: '# Stale replacement',
      }),
      /newer version \(2\)/,
    );
    assert.equal(store.read().artifacts[0].versions.length, 2);
    await assert.rejects(
      executeTool(store, 'read_artifact', { id: 'file-not-a-saved-result' }),
      /could not be found/,
    );
    store.mutate((s) => {
      s.files.find((f) => f.id === created.result.fileId).artifactVersion = 2;
    });
    await assert.rejects(
      executeTool(store, 'read_artifact', { id: created.result.fileId }),
      /does not match/,
    );
  } finally {
    store.close();
  }
});
test('the actual agent loop uses generated results and keeps the output card', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const run = store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'Make a weekend budget spreadsheet.' }),
    );
    let calls = 0;
    const provider = {
      complete: async (messages) => {
        if (isMemoryReview(messages)) return emptyMemoryReply();
        calls++;
        if (calls === 1)
          return {
            text: '',
            toolCalls: [
              {
                id: 'sheet',
                type: 'function',
                function: { name: 'save_artifact', arguments: JSON.stringify(spreadsheet) },
              },
            ],
          };
        const result = JSON.parse(messages.at(-1).content);
        assert.ok(result.result.fileId);
        return { text: 'Your editable budget is ready.', toolCalls: [] };
      },
    };
    const reply = await agentReply(store, provider, run, {});
    assert.equal(calls, 2);
    assert.equal(reply.cards[0].kind, 'file');
    assert.equal(store.read().artifacts[0].kind, 'spreadsheet');
  } finally {
    store.close();
  }
});
test('empty model completion without a result is a retryable failure; saved result-only replies remain valid', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const run = store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'Create a document.' }),
    );
    let called = false;
    await assert.rejects(
      agentReply(
        store,
        {
          complete: async (messages) => {
            if (isMemoryReview(messages)) return emptyMemoryReply();
            if (!called) {
              called = true;
              return {
                text: 'I will check your files.',
                toolCalls: [
                  {
                    id: 'list',
                    type: 'function',
                    function: { name: 'list_files', arguments: '{}' },
                  },
                ],
              };
            }
            return { text: ' ', toolCalls: [] };
          },
        },
        run,
        {},
      ),
      /stopped without returning a reply or result/,
    );
    assert.equal(store.read().files.length, 0);
    let calls = 0;
    const reply = await agentReply(
      store,
      {
        complete: async () =>
          ++calls === 1
            ? {
                text: '',
                toolCalls: [
                  {
                    id: 'create',
                    type: 'function',
                    function: { name: 'save_artifact', arguments: JSON.stringify(document) },
                  },
                ],
              }
            : { text: '', toolCalls: [] },
      },
      run,
      {},
    );
    assert.equal(reply.cards[0].kind, 'file');
    assert.equal(store.read().files.length, 1);
  } finally {
    store.close();
  }
});
test('unavailable command terminals are not offered and cannot create dead-end reviews', async () => {
  for (const terminal of [undefined, { enabled: false }, { enabled: true }]) {
    const store = new Store(':memory:', { sample: false });
    try {
      const run = store.mutate((s) =>
        command(s, 'chat.send', { threadId: 'main', text: 'Make a Word document.' }),
      );
      let calls = 0;
      const provider = {
        complete: async (_messages, tools) => {
          if (isMemoryReview(_messages)) return emptyMemoryReply();
          assert.equal(
            tools.some((t) => t.name === 'prepare_command'),
            !!terminal?.enabled,
          );
          assert(tools.some((t) => t.name === 'save_artifact'));
          return ++calls === 1
            ? {
                text: '',
                toolCalls: [
                  {
                    id: 'save',
                    type: 'function',
                    function: { name: 'save_artifact', arguments: JSON.stringify(document) },
                  },
                ],
              }
            : { text: 'Ready.', toolCalls: [] };
        },
      };
      await agentReply(store, provider, run, { terminal });
      if (terminal?.enabled) {
        const result = await executeTool(
          store,
          'prepare_command',
          { command: 'pwd' },
          { terminal },
        );
        assert.equal(result.card.kind, 'review');
        assert.equal(store.read().approvals.length, 1);
        assert.equal(store.read().approvals[0].status, 'pending');
      } else {
        await assert.rejects(
          executeTool(store, 'prepare_command', { command: 'docx --title Example' }, { terminal }),
          /not configured.*save_artifact/,
        );
        assert.equal(store.read().approvals.length, 0);
      }
    } finally {
      store.close();
    }
  }
});
test('saved result feedback exposes computed values and alignment warnings without changing cells', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const rows = [['Item', 'Cost'], ['Train', 25], [{ formula: 'SUM(B2:B2)' }]];
    const result = await executeTool(store, 'save_artifact', {
      kind: 'spreadsheet',
      title: 'Misaligned table',
      sheets: [{ name: 'Budget', rows }],
    });
    const check = result.result.contentCheck.sheets[0];
    assert.deepEqual(check.preview, [['Item', 'Cost'], ['Train', 25], [25]]);
    assert.equal(check.previewTruncated, false);
    assert.match(check.warning, /Rows 3 .*alignment/);
    const saved = store.read().artifacts[0].versions[0];
    assert.deepEqual(
      JSON.parse(saved.source).sheets[0].rows,
      rows,
      'Warnings do not silently rewrite model content.',
    );
    assert.match(result.result.nextStep, /before reporting completion/);
    assert.equal(artifactContentCheck('document', 'x'.repeat(1300)).excerpt.length, 1200);
    assert.equal(artifactContentCheck('document', 'x'.repeat(1300)).truncated, true);
    assert.equal(artifactContentCheck('presentation', presentation.source).slideCount, 2);
    assert(
      artifactContentCheck('presentation', presentation.source).slides.every((s) => s.hasNotes),
    );
    const large = JSON.stringify({
      sheets: [
        { name: 'Large', rows: Array.from({ length: 12 }, () => Array(12).fill('x'.repeat(200))) },
      ],
    });
    const preview = artifactContentCheck('spreadsheet', large).sheets[0];
    assert(preview.previewTruncated);
    assert.equal(preview.preview.length, 8);
    assert.equal(preview.preview[0].length, 8);
    assert.equal(preview.preview[0][0].length, 96);
    const many = JSON.stringify({
      sheets: Array.from({ length: 10 }, (_, i) => ({
        name: 'Sheet' + i,
        rows: Array.from({ length: 8 }, () => Array(8).fill('"'.repeat(200))),
      })),
    });
    const bounded = artifactContentCheck('spreadsheet', many);
    assert.equal(bounded.omittedSheets, 7);
    assert.equal(bounded.sheets.length, 3);
    assert(JSON.stringify(bounded).length < 40000);
  } finally {
    store.close();
  }
});
test('spreadsheet review distinguishes editable formulas from literal text without rewriting cells', () => {
  const rows = [
    ['Item', 'Amount'],
    ['Train', 27],
    ['Tea', 8],
    ['Lunch', 19],
    ['Calculated', { formula: 'SUM(B2:B4)' }],
    ['Example text', '=SUM(B2:B4)'],
  ];
  const source = JSON.stringify({ sheets: [{ name: 'Budget', rows }] });
  const review = artifactContentCheck('spreadsheet', source).sheets[0];
  assert.equal(review.formulaCount, 1);
  assert.deepEqual(review.formulas, [{ cell: 'B5', formula: 'SUM(B2:B4)', value: 54 }]);
  assert.equal(review.literalFormulaCount, 1);
  assert.equal(review.preview[5][1], '=SUM(B2:B4)');
  assert.match(review.warning, /B6.*text.*not executable formulas/);
  assert.equal(review.omittedFormulas, 0);
  const large = JSON.stringify({
    sheets: [
      { name: 'Many', rows: Array.from({ length: 200 }, () => [{ formula: '1+1' }, '=1+1']) },
    ],
  });
  const bounded = artifactContentCheck('spreadsheet', large).sheets[0];
  assert.equal(bounded.formulaCount, 200);
  assert.equal(bounded.formulas.length, 8);
  assert.equal(bounded.omittedFormulas, 192);
  assert.equal(bounded.literalFormulaCount, 200);
  assert.doesNotMatch(bounded.warning, /B21/);
  const empty = artifactContentCheck(
    'spreadsheet',
    JSON.stringify({ sheets: [{ name: 'Plain', rows: [['Text', 4]] }] }),
  ).sheets[0];
  assert.equal(empty.formulaCount, 0);
  assert.equal(empty.literalFormulaCount, 0);
  assert.equal(empty.warning, undefined);
});
test('interactive syntax checking compiles scripts and decoded handlers without executing them', () => {
  const marker = '__relayArtifactMustNotRun';
  assert.equal(globalThis[marker], undefined);
  const result = artifactHtmlCheck(
    `<script>globalThis.${marker}=true; throw Error('Never execute'); while(true){}</script><button onclick="if (1 &lt; 2) return false;">Done</button>`,
  );
  assert.equal(globalThis[marker], undefined);
  assert.equal(result.classicScripts, 1);
  assert.equal(result.eventHandlers, 1);
  assert.equal(result.uncheckedModuleScripts, 0);
  assert.match(result.scope, /without execution/);
  assert.throws(
    () => artifactHtmlCheck('<button onclick="return (">Broken</button>'),
    /syntax error.*onclick/,
  );
});
test('interactive syntax checks identify their limits and ignore data and non-running script bodies', () => {
  const result = artifactHtmlCheck(
    `<!-- <script>broken {</script> --><textarea><script>broken {</script></textarea><script type="application/ld+json">{"value":5}</script><script type="module">export const value=5</script><script src="https://example.invalid/external.js">broken {</script><script nomodule>broken {</script><script type="text/javascript">const value=5</script>`,
  );
  assert.equal(result.classicScripts, 1);
  assert.equal(result.uncheckedModuleScripts, 1);
  assert.throws(() => artifactHtmlCheck('x'.repeat(200001)), /200,000/);
  assert.throws(() => artifactHtmlCheck('<script>1</script>'.repeat(257)), /256/);
});
test('malformed interactive scripts cannot create a file or damage an existing version', async () => {
  const store = new Store(':memory:', { sample: false });
  const valid = {
    kind: 'web',
    title: 'Counter',
    source:
      '<button onclick="add()">Add one</button><script>let count=0;function add(){count++}</script>',
  };
  const invalid = { ...valid, source: '<script>function reset(){count=0;</script>' };
  try {
    await assert.rejects(
      saveArtifact(store, { ...invalid, operationId: 'bad-create' }),
      /syntax error.*not saved/,
    );
    assert.equal(store.read().files.length, 0);
    assert.equal((store.read().artifacts || []).length, 0);
    const first = await saveArtifact(store, { ...valid, operationId: 'valid-create' });
    const original = store.read().files[0].base64;
    await assert.rejects(
      saveArtifact(store, {
        ...invalid,
        id: first.id,
        expectedVersion: 1,
        operationId: 'bad-revision',
      }),
      /syntax error.*not saved/,
    );
    assert.equal(store.read().files.length, 1);
    assert.equal(store.read().artifacts[0].versions.length, 1);
    const corrected = await saveArtifact(store, {
      ...valid,
      id: first.id,
      expectedVersion: 1,
      source: valid.source.replace('count++', 'count+=2'),
      operationId: 'corrected-revision',
    });
    assert.equal(corrected.version, 2);
    assert.equal(store.read().files.find((f) => f.id === first.fileId).base64, original);
  } finally {
    store.close();
  }
});
test('web content review includes script-sized source and the actual preview limits', () => {
  const source =
    '<!doctype html>' +
    ' '.repeat(1400) +
    '<button onclick="add()">Add one</button><script>let count=0;function add(){count++}</script>';
  const review = artifactContentCheck('web', source);
  assert.equal(review.excerpt, source);
  assert.equal(review.truncated, false);
  assert.match(review.previewEnvironment, /opaque-origin sandbox/);
  assert.match(review.previewEnvironment, /persistent browser storage unavailable/);
  assert.match(review.previewEnvironment, /does not prove/);
  const legacy = artifactContentCheck('web', '<script>function missingBrace(){</script>');
  assert.equal(legacy.syntaxCheck.status, 'failed');
  assert.match(legacy.syntaxCheck.error, /syntax error/);
  assert.doesNotMatch(legacy.syntaxCheck.error, /not saved/);
  const long = artifactContentCheck('web', 'x'.repeat(14000));
  assert.equal(long.excerpt.length, 12000);
  assert.equal(long.truncated, true);
});
test('saved content reviews pair only the bound owner request and keep long requests bounded', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      s.messages.push(
        {
          id: 'owner-facts',
          threadId: 'main',
          role: 'user',
          text: 'Keep the workshop at 10:30 AM.',
        },
        { id: 'other-chat', threadId: 'other', role: 'user', text: 'Private unrelated request.' },
        { id: 'model-claim', threadId: 'main', role: 'assistant', text: 'Change it to 03:30 AM.' },
        { id: 'long-request', threadId: 'main', role: 'user', text: 'x'.repeat(7000) },
      );
    });
    for (const [sourceMessageId, expected] of [
      ['owner-facts', 'Keep the workshop at 10:30 AM.'],
      ['other-chat', undefined],
      ['model-claim', undefined],
      ['missing', undefined],
      ['long-request', 'x'.repeat(6000)],
    ]) {
      const saved = await executeTool(
        store,
        'save_artifact',
        { kind: 'document', title: sourceMessageId, source: '# Workshop\n\n03:30 AM' },
        { threadId: 'main', sourceMessageId },
      );
      const check = saved.result.contentCheck;
      assert.equal(check.request, expected);
      assert.equal(
        check.requestTruncated,
        expected === undefined ? undefined : sourceMessageId === 'long-request',
      );
      assert.equal(check.excerpt, '# Workshop\n\n03:30 AM');
      assert.equal(
        store.read().artifacts.at(-1).versions[0].source,
        check.excerpt,
        'The review exposes a mismatch; it must not silently replace model content or claim semantic validation.',
      );
    }
  } finally {
    store.close();
  }
});
test('model saves reject disconnected same-title copies atomically and preserve explicit revision/retry paths', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const first = await executeTool(store, 'save_artifact', document, {
      operationId: 'same-title-first',
    });
    const replay = await executeTool(store, 'save_artifact', document, {
      operationId: 'same-title-first',
    });
    assert.equal(replay.result.id, first.result.id);
    await assert.rejects(
      executeTool(store, 'save_artifact', { ...document, title: document.title.toUpperCase() }),
      /read_artifact id=.*expectedVersion=1/,
    );
    assert.equal(store.read().artifacts.length, 1);
    const revised = await executeTool(store, 'save_artifact', {
      ...document,
      id: first.result.id,
      expectedVersion: 1,
      source: '# Revised',
    });
    assert.equal(revised.result.id, first.result.id);
    assert.equal(revised.result.version, 2);
    const competing = await Promise.allSettled(
      ['a', 'b'].map((operationId) =>
        saveArtifact(
          store,
          { ...document, title: 'Concurrent' },
          { operationId, requireUniqueTitle: true },
        ),
      ),
    );
    assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(competing.find((r) => r.status === 'rejected').reason.message, /already exists/);
    await executeTool(store, 'save_artifact', { ...document, title: 'Explicit separate copy' });
    assert.equal(store.read().artifacts.length, 3);
    // The direct owner editor retains its existing explicit New result behavior.
    await saveArtifact(store, document, { operationId: 'owner-create' });
    assert.equal(store.read().artifacts.length, 4);
  } finally {
    store.close();
  }
});
test('artifact HTTP creation and downloads require the owner session and block cross-origin writes', async () => {
  const store = new Store(':memory:', { sample: false });
  const services = {
    mode: 'sample',
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey: 'owner-test-key',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ ...presentation, operationId: 'http' });
    assert.equal(
      (
        await fetch(url + '/api/artifacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
      401,
    );
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'owner-test-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    assert.equal(
      (
        await fetch(url + '/api/artifacts', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.invalid' },
          body,
        })
      ).status,
      403,
    );
    const saved = await (
      await fetch(url + '/api/artifacts', { method: 'POST', headers, body })
    ).json();
    assert.ok(saved.result.fileId);
    assert.equal((await fetch(url + `/api/files/${saved.result.fileId}`)).status, 401);
    const download = await fetch(url + `/api/files/${saved.result.fileId}`, { headers });
    assert.equal(download.headers.get('content-type'), artifactKinds.presentation.mime);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.match(download.headers.get('content-security-policy'), /frame-src 'self'/);
    const zip = await JSZip.loadAsync(await download.arrayBuffer());
    assert.ok(zip.file('ppt/presentation.xml'));
    assert.equal(store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
test('interactive exports put a restrictive policy before all generated markup', async () => {
  const source = '<script>document.body.dataset.ready="yes"</script>';
  const rendered = await renderArtifact({ kind: 'web', title: 'Counter', source });
  assert.equal(rendered.bytes.toString(), previewHtml(source));
  const html = rendered.bytes.toString();
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>'));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
});
test('large sources are readable in complete version-pinned pages', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const source = '<p>' + 'A thoughtful paragraph. '.repeat(2300) + '</p>';
    const saved = await saveArtifact(store, {
      kind: 'web',
      title: 'Long source',
      source,
      operationId: 'long',
    });
    let result = '',
      offset = 0;
    do {
      const read = await executeTool(store, 'read_artifact', { id: saved.id, version: 1, offset });
      assert.ok(read.result.source.length <= 12000);
      result += read.result.source;
      offset = read.result.nextOffset;
    } while (offset !== null);
    assert.equal(result, source);
    await assert.rejects(
      executeTool(store, 'read_artifact', { id: saved.id, offset: -1 }),
      /offset/,
    );
  } finally {
    store.close();
  }
});
test('removal preserves attachment reviews, blocks active tasks, and prevents a recent replay', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const saved = await saveArtifact(store, { ...document, operationId: 'removed' });
    const task = store.mutate((s) =>
      command(s, 'task.create', { title: 'Read result', fileId: saved.fileId }),
    );
    assert.throws(
      () => store.mutate((s) => command(s, 'artifact.delete', { id: saved.id })),
      /unfinished task/,
    );
    store.mutate((s) => {
      s.tasks.find((t) => t.id === task.id).status = 'completed';
    });
    const approval = store.mutate((s) =>
      command(s, 'mail.prepare', {
        to: 'owner@example.com',
        subject: 'Review',
        body: 'A plan.',
        attachmentIds: [saved.fileId],
      }),
    );
    const original = store.read().files[0].base64;
    store.mutate((s) => command(s, 'artifact.delete', { id: saved.id }));
    assert.equal(store.read().files.length, 0);
    assert.equal((store.read().artifacts || []).length, 0);
    assert.equal(
      store.read().approvals.find((a) => a.id === approval.id).attachments[0].base64,
      original,
    );
    await assert.rejects(saveArtifact(store, { ...document, operationId: 'removed' }), /removed/);
  } finally {
    store.close();
  }
});
