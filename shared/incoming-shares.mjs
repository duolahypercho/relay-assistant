// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
const maxBytes = 8 * 1024 * 1024;
export function sharedDrafts(s, thread) {
  return (thread.draftShareIds || [])
    .map((id) => (s.shareImports || []).find((x) => x.id === id))
    .filter(Boolean);
}
export function stageShare(s, p) {
  if (typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(p.id))
    throw new Error('This share has no valid receipt.');
  const previous = (s.shareImports || []).find((x) => x.id === p.id);
  if (previous) {
    if (previous.threadId !== p.threadId)
      throw new Error('This share was already attached to another conversation.');
    return previous; // A lost acknowledgement never reattaches an edited or sent draft.
  }
  const thread = s.threads.find((t) => t.id === p.threadId && !t.archived);
  if (!thread) throw new Error('Choose an active conversation for this share.');
  const text = p.text ?? '';
  if (
    typeof text !== 'string' ||
    text.length > 12000 ||
    !Array.isArray(p.files) ||
    p.files.length > 8
  )
    throw new Error('Share up to eight files and 12,000 characters.');
  if (!text.trim() && !p.files.length) throw new Error('This share is empty.');
  if ((thread.draftShareIds || []).length >= 8)
    throw new Error('Send or remove the shared items already in this composer first.');
  if ((s.shareImports || []).length >= 10000)
    throw new Error(
      'This workspace has reached its incoming-share receipt limit. Export your work before starting a fresh workspace.',
    );
  let total = 0;
  const files = p.files.map((f) => {
    if (
      typeof f.name !== 'string' ||
      !f.name ||
      f.name.length > 240 ||
      /[\\/\x00-\x1f\x7f]/.test(f.name) ||
      ['.', '..'].includes(f.name)
    )
      throw new Error('This shared file has an invalid name.');
    if (typeof f.mime !== 'string' || f.mime.length > 120 || !/^[\w.+-]+\/[\w.+-]+$/.test(f.mime))
      throw new Error('This shared file has an invalid type.');
    if (
      typeof f.base64 !== 'string' ||
      f.base64.length > 11184812 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64)
    )
      throw new Error('This shared file could not be read.');
    const size =
      (f.base64.length * 3) / 4 - (f.base64.endsWith('==') ? 2 : f.base64.endsWith('=') ? 1 : 0);
    total += size;
    return {
      id: uid('file'),
      name: f.name,
      mime: f.mime,
      base64: f.base64,
      size,
      source: 'Shared to Relay',
      createdAt: iso(),
    };
  });
  if (total > maxBytes) throw new Error('Share up to 8 MB at a time.');
  const pendingFiles = sharedDrafts(s, thread).flatMap((x) => x.fileIds);
  if (new Set([...(thread.draftFileIds || []), ...pendingFiles]).size + files.length > 8)
    throw new Error('This composer can hold up to eight attachments. Remove an attachment first.');
  const result = {
    id: p.id,
    threadId: thread.id,
    text,
    fileIds: files.map((f) => f.id),
    createdAt: iso(),
  };
  s.files.unshift(...files);
  (s.shareImports ||= []).push(result);
  (thread.draftShareIds ||= []).push(result.id);
  s.revision++;
  return result;
}
export function removeShare(s, p) {
  const thread = s.threads.find((t) => t.id === p.threadId);
  if (!thread) throw new Error('This conversation was not found.');
  thread.draftShareIds = (thread.draftShareIds || []).filter((id) => id !== p.id);
  s.revision++;
  return true;
}
export function selectedShares(s, thread, ids = []) {
  if (
    !Array.isArray(ids) ||
    ids.length > 8 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !thread.draftShareIds?.includes(id))
  )
    throw new Error('Choose shared items in this composer.');
  return sharedDrafts(s, thread).filter((x) => ids.includes(x.id));
}
