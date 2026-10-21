// SPDX-License-Identifier: MIT
import { inspectPdf, fileBytes, fillPdf, toBase64 } from './pdf.mjs';
import { taskReport } from './assistant.mjs';
import { iso, uid } from './seed.mjs';
import { assistantWorkspace } from './assistant-scope.mjs';
import { createApproval, receipt } from './domain.mjs';
// Calculates a step from a snapshot; commitStep applies it only under the current lease.
export async function calculateStep(s, t, services = {}) {
  s = assistantWorkspace(s, t.assistantId || 'relay', t.assistant || null);
  if (t.kind === 'document') {
    const f =
      s.files.find((f) => f.id === t.fileId) || s.files.find((f) => f.mime === 'application/pdf');
    if (!f) throw new Error('Upload a PDF before starting this task.');
    if (!t.inputValues) {
      const info = await inspectPdf(await fileBytes(f));
      if (!info.fields.length) throw new Error('This PDF has no editable fields.');
      return {
        type: 'input',
        fileId: f.id,
        input: {
          title: 'A few details for the form',
          fields: info.fields.map((field) => ({
            ...field,
            label: f.fields?.find((x) => x.name === field.name)?.label || field.label,
            required: !['access', 'notes'].includes(field.name),
          })),
        },
      };
    }
    const bytes = await fillPdf(f, t.inputValues);
    return {
      type: 'review',
      file: {
        id: uid('file'),
        name: `filled-${f.name}`,
        mime: 'application/pdf',
        base64: toBase64(bytes),
        size: bytes.length,
        createdAt: iso(),
        source: t.title,
      },
    };
  }
  if (t.step < t.plan.length - 1) return { type: 'progress' };
  let text = taskReport(s, t),
    cards = [];
  const urls = t.description.match(/https?:\/\/[^\s<>()]+/g) || [];
  if (t.kind === 'research' && urls.length && services.readPage) {
    const pages = [];
    for (const url of urls.slice(0, 3)) {
      const page = await services.readPage(url);
      pages.push(page);
      cards.push({ kind: 'browser', ...page });
    }
    text = `# ${t.title}\n\n${pages.map((p) => `## ${p.title}\n\nSource: ${p.url}\n\n${p.text.slice(0, 2500)}`).join('\n\n')}\n\nRetrieved ${iso()}. These are page excerpts, not an independent verification of their claims.`;
  }
  if (services.reason && t.kind !== 'finance') text = await services.reason(t.description, s, text);
  return {
    type: 'result',
    text,
    cards,
    file: {
      id: uid('file'),
      name: `${t.kind === 'finance' ? 'spending-note' : 'working-result'}-${iso().slice(0, 10)}.md`,
      mime: 'text/markdown',
      text,
      size: new TextEncoder().encode(text).length,
      createdAt: iso(),
      source: t.title,
    },
  };
}
export function commitStep(s, id, step) {
  const t = s.tasks.find((t) => t.id === id);
  if (!t || t.status !== 'running') return;
  if (step.type === 'progress') {
    t.step++;
    t.leaseUntil = 0;
    t.leaseOwner = null;
    t.status = 'queued';
  } else if (step.type === 'input') {
    t.fileId = step.fileId;
    t.step = 1;
    t.status = 'needs_input';
    t.input = step.input;
  } else if (step.type === 'review') {
    s.files.unshift(step.file);
    t.filledFileId = step.file.id;
    t.step = 3;
    const mail = s.mail.find((m) => m.id === t.sourceId);
    if (!mail) {
      t.status = 'completed';
      t.result = 'The filled copy is ready in Files.';
      t.resultFileId = step.file.id;
      receipt(s, 'document', t.title, t.result, t.sourceId, { fileId: step.file.id, taskId: t.id });
    } else
      createApproval(s, {
        kind: 'email',
        title: 'Send the completed permission form',
        payload: {
          to: mail.email,
          subject: `Re: ${mail.subject}`,
          body: 'Hello,\n\nHere is the completed permission form. Please let me know if you need any other information.\n\nThank you!',
          attachmentIds: [step.file.id],
          replyTo: mail.id,
        },
        taskId: id,
        sourceId: t.sourceId,
        connectionGeneration: s.connections.google.connected
          ? s.connections.google.generation
          : null,
      });
  } else if (step.type === 'result') {
    s.files.unshift(step.file);
    t.status = 'completed';
    t.step = t.plan.length;
    t.result = step.text;
    t.resultFileId = step.file.id;
    t.cards = step.cards;
    receipt(s, t.kind, t.title, 'Result saved to your files.', t.sourceId, {
      fileId: step.file.id,
      taskId: t.id,
    });
  }
  if (t.status === 'completed' && s.profile.notifications)
    s.notifications.unshift({
      id: uid('notice'),
      title: 'Your task is ready',
      body: t.title,
      link: 'activity',
      read: false,
      createdAt: iso(),
    });
  t.updatedAt = iso();
  s.revision++;
}
