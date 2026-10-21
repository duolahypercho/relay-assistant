// Keep this window's position, with a device-local fallback after a full app restart.
export type ReadingPosition = {
  anchor: string | null;
  offset: number;
  top: number;
  follow: boolean;
};
const storageKey = 'relay:chat-reading-positions';
const positions = new Map<string, ReadingPosition>();
let loaded = false;
function valid(value: ReadingPosition) {
  return (
    value &&
    typeof value.follow === 'boolean' &&
    (value.anchor === null || (typeof value.anchor === 'string' && value.anchor.length <= 280)) &&
    [value.offset, value.top].every((n) => Number.isFinite(n) && Math.abs(n) <= 10000000)
  );
}
export function readPosition(key: string) {
  if (!loaded) {
    loaded = true;
    try {
      const raw = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
      const saved = raw && raw.length <= 64000 ? JSON.parse(raw) : [];
      if (Array.isArray(saved))
        for (const entry of saved.slice(-80))
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            entry[0].length <= 400 &&
            valid(entry[1])
          )
            positions.set(entry[0], entry[1]);
    } catch {
      /* Memory-only recovery still works when storage is unavailable. */
    }
  }
  return positions.get(key);
}
export function savePosition(key: string, position: ReadingPosition) {
  if (!valid(position)) return;
  positions.delete(key);
  positions.set(key, position);
  while (positions.size > 80) positions.delete(positions.keys().next().value!);
  for (const storage of ['sessionStorage', 'localStorage'] as const)
    try {
      window[storage].setItem(storageKey, JSON.stringify([...positions]));
    } catch {
      /* Keep the in-memory copy. */
    }
}
export function capturePosition(element: HTMLElement, follow: boolean): ReadingPosition {
  const bounds = element.getBoundingClientRect();
  const anchor = [...element.querySelectorAll<HTMLElement>('.message[id]')].find((message) => {
    const rect = message.getBoundingClientRect();
    return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom;
  });
  return {
    anchor: anchor?.id || null,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
    top: element.scrollTop,
    follow,
  };
}
export function restorePosition(element: HTMLElement, position: ReadingPosition) {
  const anchor = position.anchor ? document.getElementById(position.anchor) : null;
  element.scrollTop =
    anchor && element.contains(anchor)
      ? element.scrollTop +
        anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        position.offset
      : position.top;
}
