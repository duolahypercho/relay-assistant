// SPDX-License-Identifier: MIT
// App references are explicit composer selections, never parsed from message text.
export function appReferences(value = []) {
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (a) =>
        !a ||
        typeof a.id !== 'string' ||
        !a.id ||
        a.id.length > 120 ||
        !Number.isSafeInteger(a.revision) ||
        a.revision < 1 ||
        typeof a.name !== 'string' ||
        !a.name.trim() ||
        a.name.length > 80,
    ) ||
    new Set(value.map((a) => a.id)).size !== value.length
  )
    throw new Error('Choose up to eight different connected apps.');
  return value.map(({ id, revision, name }) => ({ id, revision, name }));
}

export function availableChatApps(catalog, assistantIds) {
  return (catalog || []).filter(
    (a) =>
      a.enabled &&
      !a.signInNeeded &&
      a.toolCount > 0 &&
      (!a.assistantIds || assistantIds.every((id) => a.assistantIds.includes(id))),
  );
}

export function resolveChatApps(value, catalog, assistantIds) {
  const available = availableChatApps(catalog, assistantIds);
  return appReferences(value).map((selected) => {
    const current = available.find((a) => a.id === selected.id && a.revision === selected.revision);
    if (!current)
      throw new Error(
        'A selected app changed or is unavailable to this conversation. Remove it and choose the app again.',
      );
    return { id: current.id, revision: current.revision, name: current.name };
  });
}

export function runAppContext(run) {
  return run?.appContext || run?.questionContext?.origin?.appContext || [];
}

export function assertSelectedApp(run, connectionId, revision) {
  const selected = runAppContext(run);
  if (selected.length && !selected.some((a) => a.id === connectionId && a.revision === revision))
    throw new Error(
      'Use an app selected for this request at its saved revision. Ask the owner to choose again if it changed.',
    );
}

export function mentionAtCursor(text, cursor = text.length) {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match) return null;
  return { query: match[1], start: before.lastIndexOf('@'), end: cursor };
}
