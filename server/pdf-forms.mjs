// SPDX-License-Identifier: MIT
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileBytes } from '../shared/pdf.mjs';
import { command } from '../shared/domain.mjs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
let active = 0;
function changesFor(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 100)
    throw Error('Supply between 1 and 100 named form fields.');
  const names = new Set();
  for (const f of fields) {
    if (!f || typeof f.name !== 'string' || !f.name || f.name.length > 500 || names.has(f.name))
      throw Error('Use each exact PDF field name once.');
    names.add(f.name);
    if (!(
      typeof f.value === 'boolean' ||
      (typeof f.value === 'string' && f.value.length <= 4000) ||
      (Array.isArray(f.value) &&
        f.value.length <= 50 &&
        f.value.every((v) => typeof v === 'string' && v.length <= 500))
    ))
      throw Error('Use text, a checkbox boolean, or a list of selected options for each field.');
    if (Object.keys(f).some((k) => !['name', 'value'].includes(k)))
      throw Error('Each field needs only name and value.');
  }
  if (JSON.stringify(fields).length > 20000) throw Error('Fill at most 20,000 characters at once.');
  return fields
    .map((f) => ({ name: f.name, value: f.value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function fill(bytes, changes, signal) {
  signal?.throwIfAborted();
  if (active >= 2) throw Error('Other forms are being filled. Try again in a moment.');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./pdf-form-worker.mjs', import.meta.url), {
        workerData: { bytes, changes },
        resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = async (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        await worker.terminate().catch(() => {});
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(new DOMException('Form filling cancelled.', 'AbortError'));
      const timer = setTimeout(
        () => finish(Error('This form took too long to fill. Use a smaller PDF.')),
        20000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (m) => finish(m.error ? Error(m.error) : null, m.result));
      worker.once('error', () => finish(Error('This form is damaged or too complex to fill.')));
      worker.once('exit', () => finish(Error('Form filling stopped before it finished.')));
      if (signal?.aborted) abort();
    });
  } finally {
    active--;
  }
}
export async function saveFilledPdf(
  store,
  input,
  { guard, signal, operationId, threadId = '', sourceMessageId = '' } = {},
) {
  guard?.();
  signal?.throwIfAborted();
  if (!input || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash || ''))
    throw Error('Read the PDF first, then supply its file ID and contentHash.');
  const changes = changesFor(input.fields);
  if (typeof operationId !== 'string' || !operationId || operationId.length > 200)
    throw Error('A form save operation ID is required.');
  const file = store.read().files.find((f) => f.id === input.id && f.mime === 'application/pdf');
  if (!file) throw Error('PDF file not found.');
  const source = Buffer.from(await fileBytes(file));
  if (!source.length || source.length > 8 * 1024 * 1024) throw Error('Choose a PDF of up to 8 MB.');
  if (digest(source) !== input.contentHash)
    throw Error('This PDF changed. Read its current fields before filling it.');
  const fingerprint = digest(JSON.stringify({ id: file.id, hash: input.contentHash, changes }));
  const response = (f) => ({
    id: f.id,
    name: f.name,
    sourceId: file.id,
    pageCount: f.pdfForm.pageCount,
    changed: f.pdfForm.changed,
    remainingRequired: f.pdfForm.remainingRequired,
    preservedOriginal: true,
  });
  const existing = (s) => {
    const sameOperation = s.files.find((f) => f.pdfForm?.operationId === operationId);
    if (sameOperation && sameOperation.pdfForm.fingerprint !== fingerprint)
      throw Error('This form save ID was already used for different values.');
    return sameOperation || s.files.find((f) => f.pdfForm?.fingerprint === fingerprint);
  };
  const previous = existing(store.read());
  if (previous) return response(previous);
  const filled = await fill(source, changes, signal);
  guard?.();
  signal?.throwIfAborted();
  if (filled.bytes.length > 8 * 1024 * 1024)
    throw Error('The filled PDF is larger than 8 MB. No copy was saved.');
  return store.mutate((s) => {
    guard?.();
    signal?.throwIfAborted();
    const current = s.files.find((f) => f.id === file.id);
    if (!current || ['base64', 'text', 'template', 'mime'].some((k) => current[k] !== file[k]))
      throw Error('The original PDF changed while filling it. Read it again.');
    const previous = existing(s);
    if (previous) return response(previous);
    const saved = command(s, 'file.add', {
      name: 'filled-' + file.name.replace(/^filled-/, '').slice(0, 170),
      mime: 'application/pdf',
      base64: Buffer.from(filled.bytes).toString('base64'),
    });
    saved.size = filled.bytes.length;
    saved.source = 'Filled form';
    saved.pdfForm = {
      sourceId: file.id,
      sourceHash: input.contentHash,
      fingerprint,
      operationId,
      threadId,
      sourceMessageId,
      pageCount: filled.pageCount,
      changed: filled.changed,
      remainingRequired: filled.remainingRequired,
    };
    return response(saved);
  });
}
