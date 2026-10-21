// SPDX-License-Identifier: MIT
// A local return destination, never a URL or an instruction to send a message.
const chatId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[^a-zA-Z0-9_-]/.test(id);

export function modelSetupHash(id) {
  return `#settings?section=models&fromChat=${chatId(id) ? id : 'main'}`;
}

export function modelSetupChat(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#settings?')) return null;
  const query = new URLSearchParams(hash.slice('#settings?'.length));
  const id = query.get('fromChat');
  return query.getAll('section').length === 1 &&
    query.get('section') === 'models' &&
    query.getAll('fromChat').length === 1 &&
    id &&
    chatId(id)
    ? id
    : null;
}
