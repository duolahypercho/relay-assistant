// SPDX-License-Identifier: MIT
// Preview links contain only local entity IDs, never file content or external URLs.
const entity = /^[a-zA-Z0-9_-]{1,100}$/;
export function filePreviewRoute(hash) {
  if (typeof hash !== 'string' || hash.length > 400) return null;
  const match = /^#files\/preview\/([a-zA-Z0-9_-]{1,100})(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  const query = new URLSearchParams(match[2] || '');
  const chat = query.get('chat') || 'main';
  return { id: match[1], threadId: entity.test(chat) ? chat : 'main' };
}
export function filePreviewHash(id, threadId = 'main') {
  if (!entity.test(id) || !entity.test(threadId)) throw Error('This file link is unavailable.');
  return `#files/preview/${id}${threadId === 'main' ? '' : `?chat=${threadId}`}`;
}
