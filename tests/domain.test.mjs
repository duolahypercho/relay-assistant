import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, deriveIdeas } from '../shared/seed.mjs';
import { command, completeApproval, recordObservation, publicUrl } from '../shared/domain.mjs';
import { sampleRespond } from '../shared/assistant.mjs';
import {
  parseCsv,
  importTransactions,
  summarizeTransactions,
  exampleCsv,
} from '../shared/finance.mjs';
import {
  permissionPdf,
  inspectPdf,
  fillPdf,
  fromBase64,
  fileBytes,
  toBase64,
} from '../shared/pdf.mjs';
import { calculateStep, commitStep } from '../shared/task-step.mjs';
import { PDFDocument } from 'pdf-lib';

test('uploaded text is indexed from exact bytes without a second copy; binary and explicit text stay intact', async () => {
  const s = createWorkspace({ sample: false });
  const text = 'A note in 日本語 and 中文. 🌱';
  const file = command(s, 'file.add', {
    name: 'notes.txt',
    mime: 'text/plain',
    base64: Buffer.from(text).toString('base64'),
  });
  assert.equal(file.text, text);
  assert.equal(Buffer.from(await fileBytes(file)).toString(), text);
  const large = Buffer.from('x'.repeat(7_500_000));
  const big = command(s, 'file.add', {
    name: 'large.txt',
    mime: 'text/plain',
    base64: large.toString('base64'),
  });
  assert.equal(big.text.length, 2_000_000);
  assert.equal(big.textTruncated, true);
  const originalBytes = Buffer.from(await fileBytes(big));
  assert.equal(originalBytes.length, large.length);
  assert.ok(originalBytes.equals(large));
  const binary = command(s, 'file.add', {
    name: 'binary.dat',
    mime: 'application/octet-stream',
    base64: Buffer.from([0, 255, 1]).toString('base64'),
  });
  assert.equal(binary.text, undefined);
  assert.deepEqual(Buffer.from(await fileBytes(binary)), Buffer.from([0, 255, 1]));
  const edited = command(s, 'file.add', {
    name: 'edited.txt',
    mime: 'text/plain',
    base64: Buffer.from(text).toString('base64'),
    text: 'Explicit text',
  });
  assert.equal(edited.text, 'Explicit text');
  assert.equal(Buffer.from(await fileBytes(edited)).toString(), text);
  command(s, 'file.edit', { id: edited.id, text: 'Edited by owner' });
  assert.equal(Buffer.from(await fileBytes(edited)).toString(), 'Edited by owner');
});

test('CSV parses quoted descriptions, escaped quotes, BOM and CRLF; totals use cents', () => {
  const text =
    '\ufeffdate,description,amount,category\r\n2026-10-01,"A, B and ""C""",-10.10,Other\r\n2026-10-02,Income,20.30,Income';
  assert.equal(parseCsv(text)[1][1], 'A, B and "C"');
  const rows = importTransactions(text);
  const sums = summarizeTransactions(rows);
  assert.equal(sums.income, 2030);
  assert.equal(sums.expenses, 1010);
  assert.equal(sums.net, 1020);
  assert.equal(sums.categories[0].percent, 100);
});
test('invalid CSV never replaces the current import', () => {
  const s = createWorkspace();
  const before = structuredClone(s.transactions);
  for (const csv of [
    'date,description,amount\n2026-02-30,Test,-3',
    'date,description,amount\n2026-10-01,Test,nope',
    'date,description,amount\n2026-10-01,Test,1.001',
    'wrong,headers\nx,y',
  ])
    assert.throws(() => command(s, 'finance.import', { csv }), /date|amount|column/i);
  assert.deepEqual(s.transactions, before);
  assert.equal(importTransactions(exampleCsv).length, 14);
});
test('chat drafts, rename, archive and restore validate ownership', () => {
  const s = createWorkspace();
  const t = command(s, 'thread.create');
  command(s, 'thread.update', { id: t.id, draft: 'Unsent text', title: 'A real thread' });
  assert.equal(t.draft, 'Unsent text');
  command(s, 'thread.update', { id: t.id, archived: true });
  assert.throws(() => command(s, 'chat.send', { threadId: t.id, text: 'Hi' }), /Restore/);
  command(s, 'thread.update', { id: t.id, archived: false });
  command(s, 'chat.send', { threadId: t.id, text: 'Hi' });
  assert.equal(t.draft, '');
  assert.throws(() => command(s, 'thread.update', { id: 'main', archived: true }), /main/);
  assert.throws(() => command(s, 'chat.send', { threadId: 'missing', text: 'x' }), /not found/);
});
test('attachment-only messages validate files before queuing and clear the sent draft', () => {
  const s = createWorkspace();
  const thread = s.threads.find((t) => t.id === 'main');
  const file = s.files[0];
  assert.ok(file);
  const before = s.messages.length;
  thread.draftFileIds = [file.id];
  assert.throws(
    () => command(s, 'chat.send', { threadId: 'main', text: '  ' }),
    /Message is required/,
  );
  assert.throws(
    () => command(s, 'chat.send', { threadId: 'main', fileIds: ['missing'] }),
    /Attachment was not found/,
  );
  assert.equal(s.messages.length, before);
  assert.deepEqual(thread.draftFileIds, [file.id]);
  const run = command(s, 'chat.send', {
    threadId: 'main',
    text: '  ',
    fileIds: [file.id, file.id],
  });
  const message = s.messages.find((m) => m.id === run.messageId);
  assert.equal(run.status, 'queued');
  assert.equal(message.text, 'Shared with you.');
  assert.deepEqual(message.fileIds, [file.id]);
  assert.deepEqual(thread.draftFileIds, []);
  assert.equal(s.messages.length, before + 1);
});
test('stopping an active reply preserves partial output and an unsent draft, pauses follow-ups', () => {
  const s = createWorkspace();
  const first = command(s, 'chat.send', { threadId: 'main', text: 'First' });
  first.status = 'running';
  first.partial = 'Partial answer';
  const next = command(s, 'chat.send', { threadId: 'main', text: 'Next' });
  command(s, 'thread.update', { id: 'main', draft: 'Keep this' });
  command(s, 'chat.stop', { id: first.id });
  assert.equal(first.status, 'cancelled');
  assert.equal(next.status, 'queued');
  assert.equal(s.threads[0].draft, 'Keep this');
  assert.equal(s.threads[0].queuePaused, true);
  assert.equal(s.messages.at(-1).text, 'Partial answer');
  assert.equal(s.messages.at(-1).interrupted, true);
});
test('task cancellation invalidates its review; retry does not reuse form details', () => {
  const s = createWorkspace();
  const t = command(s, 'task.create', {
    title: 'Fill a form',
    kind: 'document',
    fileId: 'file-permission',
  });
  t.inputValues = { participant: 'Old name' };
  t.status = 'needs_input';
  command(s, 'task.action', { id: t.id, action: 'cancel' });
  command(s, 'task.action', { id: t.id, action: 'retry' });
  assert.equal(t.status, 'queued');
  assert.equal(t.inputValues, null);
  assert.equal(t.attempt, 1);
  assert.throws(() => command(s, 'task.action', { id: t.id, action: 'resume' }), /Cannot/);
  assert.throws(
    () =>
      command(s, 'task.create', { title: 'Wrong file', kind: 'document', fileId: 'file-notes' }),
    /PDF/,
  );
});
test('approved email payload and attachment bytes are immutable snapshots; decision is one-shot', () => {
  const s = createWorkspace();
  const f = command(s, 'file.add', {
    name: 'note.txt',
    mime: 'text/plain',
    text: 'First revision',
  });
  const a = command(s, 'mail.prepare', {
    to: 'test@example.invalid',
    subject: 'Review me',
    body: 'Original body',
    attachmentIds: [f.id],
  });
  command(s, 'file.edit', { id: f.id, text: 'Changed afterward' });
  assert.equal(a.attachments[0].text, 'First revision');
  assert.equal(a.payload.body, 'Original body');
  command(s, 'approval.decide', { id: a.id, decision: 'approve' });
  assert.throws(() => command(s, 'approval.decide', { id: a.id, decision: 'approve' }), /already/);
  completeApproval(s, a.id);
  assert.equal(s.mail[0].folder, 'sent');
  assert.equal(s.receipts.length, 1);
  assert.throws(() => completeApproval(s, a.id), /not approved/);
  assert.throws(
    () =>
      command(s, 'mail.prepare', {
        to: 'test@example.invalid\nBcc: bad@example.invalid',
        subject: 'Bad',
        body: 'x',
      }),
    /valid/,
  );
});
test('expired reviews and account changes prevent approving a live action', () => {
  const s = createWorkspace();
  s.connections.google = { connected: true, email: 'a@example.com', generation: 1 };
  const a = command(s, 'mail.prepare', { to: 'b@example.com', subject: 'Live', body: 'x' });
  s.connections.google.generation = 2;
  assert.throws(
    () => command(s, 'approval.decide', { id: a.id, decision: 'approve' }),
    /account changed/,
  );
  s.connections.google.generation = 1;
  a.expiresAt = 0;
  assert.throws(() => command(s, 'approval.decide', { id: a.id, decision: 'approve' }), /expired/);
});
test('calendar writes require review, preserve provider identity, and reject stale edits', () => {
  const s = createWorkspace();
  const event = s.events[0];
  event.providerId = 'provider-123';
  event.etag = 'etag1';
  const input = {
    operation: 'update',
    id: event.id,
    title: 'A changed event',
    start: '2026-10-08T09:00:00Z',
    end: '2026-10-08T10:00:00Z',
  };
  const a = command(s, 'calendar.prepare', input);
  const b = command(s, 'calendar.prepare', { ...input, title: 'Conflicting change' });
  assert.equal(event.title, 'A little time to focus');
  assert.equal(a.payload.event.providerId, 'provider-123');
  assert.equal(a.payload.event.etag, 'etag1');
  command(s, 'approval.decide', { id: a.id, decision: 'approve' });
  completeApproval(s, a.id);
  assert.equal(event.title, 'A changed event');
  assert.throws(
    () => command(s, 'approval.decide', { id: b.id, decision: 'approve' }),
    /event changed/,
  );
  assert.throws(
    () =>
      command(s, 'calendar.prepare', {
        operation: 'create',
        title: 'Bad',
        start: '2026-10-01',
        end: '2026-10-01',
      }),
    /after/,
  );
});
test('tracking establishes a change baseline, deduplicates matches, rearms, pauses, and backs off', () => {
  const s = createWorkspace();
  const w = command(s, 'watch.create', {
    title: 'Tickets',
    url: 'relay://workshop',
    kind: 'text',
    expected: 'available now',
    intervalMinutes: 1,
  });
  recordObservation(s, w.id, 'Sold out');
  assert.equal(s.notifications.length, 0);
  recordObservation(s, w.id, 'Available now!');
  assert.equal(s.notifications.length, 1);
  recordObservation(s, w.id, 'Available now!');
  assert.equal(s.notifications.length, 1);
  recordObservation(s, w.id, 'Sold out');
  recordObservation(s, w.id, 'Available now!');
  assert.equal(s.notifications.length, 2);
  command(s, 'watch.update', { id: w.id, paused: true });
  recordObservation(s, w.id, 'stale result');
  assert.equal(w.lastValue, 'Available now!');
  command(s, 'watch.update', { id: w.id, paused: false });
  recordObservation(s, w.id, '', 'Network failed');
  assert.equal(w.failures, 1);
  assert.ok(w.nextCheck > Date.now() + 110000);
  recordObservation(s, w.id, 'Available now!');
  assert.equal(w.failures, 0);
  const change = command(s, 'watch.create', {
    title: 'Page',
    url: 'relay://workshop',
    kind: 'change',
  });
  const count = s.notifications.length;
  recordObservation(s, change.id, 'A');
  assert.equal(s.notifications.length, count);
  recordObservation(s, change.id, 'B');
  assert.equal(s.notifications.length, count + 1);
});
test('price tracking requires USD and fires only on a threshold edge', () => {
  const s = createWorkspace();
  const w = command(s, 'watch.create', {
    title: 'Price',
    url: 'relay://workshop',
    kind: 'price',
    threshold: 75,
  });
  recordObservation(s, w.id, 'Price $89.00');
  assert.equal(s.notifications.length, 0);
  recordObservation(s, w.id, 'Price $70.00');
  assert.equal(s.notifications.length, 1);
  recordObservation(s, w.id, 'Price $69.00');
  assert.equal(s.notifications.length, 1);
  recordObservation(s, w.id, 'EUR 60');
  assert.equal(w.status, 'error');
});
test('ideas cite workspace sources and retire after dismissal, acceptance or receipt', () => {
  const s = createWorkspace();
  assert.equal(deriveIdeas(s).length, 3);
  command(s, 'idea.dismiss', { id: 'idea-mail-field-trip' });
  assert.equal(deriveIdeas(s).length, 2);
  command(s, 'task.create', { title: 'Review', kind: 'finance', sourceId: 'finance-review' });
  assert.equal(deriveIdeas(s).length, 1);
  assert.ok(deriveIdeas(s)[0].source.includes('Ellis'));
  s.receipts.push({ id: 'receipt', sourceId: 'mail-review', status: 'completed' });
  assert.equal(deriveIdeas(s).length, 0);
});
test('PDF workflow creates actual editable and filled bytes, then an immutable email review', async () => {
  const s = createWorkspace();
  const answer = sampleRespond(s, 'Complete the form');
  const t = s.tasks.find((t) => t.id === answer.cards[0].id);
  t.status = 'running';
  commitStep(s, t.id, await calculateStep(s, t));
  assert.equal(t.status, 'needs_input');
  assert.equal(t.input.fields[0].label, 'Participant name');
  assert.throws(() => command(s, 'task.input', { id: t.id, values: {} }), /required/);
  command(s, 'task.input', {
    id: t.id,
    values: { participant: 'Jamie Example', contact: '555-0100', access: 'None' },
  });
  t.status = 'running';
  commitStep(s, t.id, await calculateStep(s, t));
  assert.equal(t.status, 'needs_approval');
  const f = s.files.find((f) => f.id === t.filledFileId);
  const bytes = fromBase64(f.base64);
  assert.ok(bytes.length > 1500);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getForm().getTextField('participant').getText(), 'Jamie Example');
  assert.equal(pdf.getForm().getTextField('contact').getText(), '555-0100');
  const a = s.approvals.find((a) => a.id === t.approvalId);
  assert.equal(a.attachments[0].base64, f.base64);
  command(s, 'approval.decide', { id: a.id, decision: 'approve' });
  completeApproval(s, a.id);
  assert.equal(t.status, 'completed');
  assert.equal(s.mail[0].to, 'mira@example.invalid');
});
test('PDF selection uses the attached file, supports checkbox/dropdown, rejects scanned forms', async () => {
  const s = createWorkspace();
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.getForm().createTextField('name');
  const box = pdf.getForm().createCheckBox('agree');
  box.addToPage(pdf.getPages()[0], { x: 10, y: 10, width: 20, height: 20 });
  const dropdown = pdf.getForm().createDropdown('choice');
  dropdown.addOptions(['A', 'B']);
  const bytes = await pdf.save();
  const f = command(s, 'file.add', {
    name: 'custom.pdf',
    mime: 'application/pdf',
    base64: toBase64(bytes),
  });
  const answer = sampleRespond(s, 'Fill this PDF', 'main', [f.id]);
  assert.equal(s.tasks.find((t) => t.id === answer.cards[0].id).fileId, f.id);
  const filled = await fillPdf(f, { name: 'Hello', agree: 'yes', choice: 'B' });
  const read = await PDFDocument.load(filled);
  assert.equal(read.getForm().getCheckBox('agree').isChecked(), true);
  assert.deepEqual(read.getForm().getDropdown('choice').getSelected(), ['B']);
  const scanned = await PDFDocument.create();
  scanned.addPage();
  const scanBytes = await scanned.save();
  await assert.rejects(() => fillPdf({ base64: toBase64(scanBytes) }, {}), /no editable fields/);
});
test('preferences, file constraints, notifications and URL validation fail intentionally', async () => {
  const s = createWorkspace();
  command(s, 'profile.update', {
    assistantName: 'Orbit',
    avatarColor: '#167b63',
    theme: 'dark',
    notifications: false,
  });
  assert.equal(s.profile.assistantName, 'Orbit');
  assert.throws(() => command(s, 'profile.update', { avatarColor: 'url(bad)' }), /hex/);
  assert.throws(() => command(s, 'file.add', { name: 'x', base64: '%%%' }), /valid file/);
  const f = command(s, 'file.add', { name: '../test.txt', mime: 'text/plain', text: 'Note' });
  assert.equal(f.name, '.._test.txt');
  assert.equal(new TextDecoder().decode(await fileBytes(f)), 'Note');
  for (const value of [
    'file:///etc/passwd',
    'http://127.0.0.1',
    'http://10.0.0.1',
    'http://[::1]',
    'https://u:p@example.com',
  ])
    assert.throws(() => publicUrl(value));
});

test('memory corrections retain their source, repeated notes deduplicate, and forgetting clears model context', () => {
  const s = createWorkspace();
  const sent = command(s, 'chat.send', {
    threadId: 'main',
    text: 'Remember Friday afternoons are for reading',
  });
  const message = s.messages.find((m) => m.role === 'user');
  const memory = command(s, 'memory.add', {
    text: 'Friday afternoons are for reading',
    sourceMessageId: message.id,
  });
  assert.equal(
    command(s, 'memory.add', { text: 'friday afternoons are for reading' }).id,
    memory.id,
  );
  assert.equal(s.memories.length, 1);
  command(s, 'memory.update', { id: memory.id, text: 'Friday afternoons are for family' });
  assert.equal(memory.sourceMessageId, message.id);
  assert.equal(memory.sourceThreadId, 'main');
  assert.ok(memory.updatedAt);
  const answer = sampleRespond(s, 'Forget Friday afternoons are for family');
  assert.match(answer.text, /removed/);
  assert.equal(s.memories.length, 0);
  assert.ok(s.messages.some((m) => m.id === message.id));
  assert.throws(
    () => command(s, 'memory.update', { id: memory.id, text: 'Missing' }),
    /not found|no longer available/i,
  );
});

test('all-day calendar actions reject normalized impossible dates before staging a review', () => {
  const s = createWorkspace();
  assert.throws(
    () =>
      command(s, 'calendar.prepare', {
        operation: 'create',
        title: 'Impossible date',
        start: '2026-02-30',
        end: '2026-03-05',
        allDay: true,
      }),
    /valid date-only/,
  );
  assert.equal(s.approvals.length, 0);
  const a = command(s, 'calendar.prepare', {
    operation: 'create',
    title: 'Leap day',
    start: '2028-02-29',
    end: '2028-03-01',
    allDay: true,
  });
  assert.equal(a.payload.event.start, '2028-02-29');
});

test('opening a workspace in chat retains the draft and history without starting a model run', () => {
  const s = createWorkspace();
  const thread = command(s, 'thread.create', { title: 'A continuing conversation' });
  command(s, 'thread.update', { id: thread.id, draft: 'An unfinished thought' });
  const opened = command(s, 'chat.present', { threadId: thread.id, page: 'files' });
  assert.equal(thread.draft, 'An unfinished thought');
  assert.equal(s.runs.length, 0);
  assert.equal(opened.cards[0].kind, 'workspace');
  assert.equal(opened.cards[0].page, 'files');
  assert.equal(s.messages.find((m) => m.id === opened.replyTo).threadId, thread.id);
  const count = s.messages.length;
  assert.equal(command(s, 'chat.present', { threadId: thread.id, page: 'files' }).id, opened.id);
  assert.equal(s.messages.length, count);
  assert.throws(
    () => command(s, 'chat.present', { threadId: thread.id, page: '__proto__' }),
    /supported/,
  );
  command(s, 'thread.update', { id: thread.id, archived: true });
  assert.throws(
    () => command(s, 'chat.present', { threadId: thread.id, page: 'files' }),
    /Restore/,
  );
});

test('showing workspace objects does not create an unrelated task, and existing task cards are reused', () => {
  const s = createWorkspace();
  for (const [request, page] of [
    ['Show my files', 'files'],
    ['Show my tasks', 'activity'],
    ['Show my calendar', 'calendar'],
    ['Open my computer', 'computer'],
  ]) {
    const answer = sampleRespond(s, request);
    assert.equal(answer.cards[0].kind, 'workspace');
    assert.equal(answer.cards[0].page, page);
  }
  assert.equal(s.tasks.length, 0);
  const task = command(s, 'task.create', {
    title: 'A real task',
    kind: 'general',
    threadId: 'main',
  });
  const shown = command(s, 'chat.present', { threadId: 'main', taskId: task.id });
  assert.equal(shown.cards[0].id, task.id);
  assert.equal(command(s, 'chat.present', { threadId: 'main', taskId: task.id }).id, shown.id);
});
