// SPDX-License-Identifier: MIT
// A file can be read repeatedly during one run, including after it is produced.
// Keep one link and preserve the full result card whenever there is a delivery.
export function uniqueFileCards(cards = []) {
  const files = new Map();
  const result = [];
  for (const card of cards) {
    if (card.kind !== 'file') {
      result.push(card);
      continue;
    }
    const index = files.get(card.id);
    if (index === undefined) {
      files.set(card.id, result.length);
      result.push(card);
    } else if (result[index].purpose === 'source' && card.purpose !== 'source') {
      result[index] = card;
    }
  }
  return result;
}
