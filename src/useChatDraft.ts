import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { api } from './api';
import type { Entity } from './types';

// Keep the last keystroke through reload AND native process termination while
// the debounced server save is pending. Origin + thread creation scope the copy.
// A thread's creation timestamp separates workspaces served at the same origin.
function pendingDraft(key: string) {
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const value = window[name].getItem(key);
      if (value !== null) return value;
    } catch {
      /* Fall back to the other store or the server snapshot. */
    }
  }
  return null;
}
function rememberDraft(key: string, value: string, clear = false) {
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = window[name];
      if (clear) {
        if (storage.getItem(key) === value) storage.removeItem(key);
      } else storage.setItem(key, value);
    } catch {
      /* The other store and regular workspace save remain available. */
    }
  }
}
export function useChatDraft(thread: Entity) {
  const connection = api.connection();
  const key = `relay:pending-draft:${api.mode()}:${thread.id}:${thread.createdAt}`;
  const [draft, setValue] = useState<string>(() => pendingDraft(key) ?? thread.draft ?? '');
  const current = useRef(draft);
  const dirty = useRef(pendingDraft(key) !== null);
  // An existing unfinished message belongs to this open editor. Another
  // device sending must not erase it, but it is not a pending server write.
  const locallyWritten = useRef(draft !== '');
  const edits = useRef(0);
  const saving = useRef(Promise.resolve());
  const mounted = useRef(true);
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      const next = typeof value === 'function' ? value(current.current) : value;
      if (next === current.current) return;
      current.current = next;
      dirty.current = true;
      locallyWritten.current = next !== '';
      edits.current++;
      rememberDraft(key, next);
      setValue(next);
    },
    [key],
  );
  const save = useCallback(
    (value: string, revision: number) => {
      // Serialize this editor's writes. A later keystroke supersedes a queued
      // save; a response to an earlier keystroke must not clear that backup.
      saving.current = saving.current.then(async () => {
        if (!dirty.current || edits.current !== revision) return;
        try {
          if (api.snapshot().threads.find((item) => item.id === thread.id)?.draft !== value)
            await api.act('thread.update', { id: thread.id, draft: value });
          if (edits.current !== revision) return;
          dirty.current = false;
          rememberDraft(key, value, true);
          const latest = locallyWritten.current
            ? value
            : (api.snapshot().threads.find((item) => item.id === thread.id)?.draft ?? value);
          current.current = latest;
          if (mounted.current) setValue(latest);
        } catch {
          /* Retain genuine local edits for reload/reconnection. */
        }
      });
    },
    [key, thread.id],
  );
  useEffect(() => {
    // An idle window follows the shared draft. Merely receiving another
    // device's edit must never schedule the idle window's old text as a write.
    const latest = thread.draft ?? '';
    // Acknowledged text can continue on another device. Keep unsaved edits,
    // and do not erase an open editor merely because another device sent.
    if (dirty.current || (locallyWritten.current && latest === '')) return;
    current.current = latest;
    setValue(latest);
    rememberDraft(key, latest, true);
  }, [key, thread.draft]);
  useEffect(() => {
    if (!dirty.current) return;
    const revision = edits.current;
    const timer = setTimeout(() => save(draft, revision), 450);
    return () => clearTimeout(timer);
  }, [draft, save, thread.draft, connection]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Switching chats unmounts this editor. Save without waiting for the debounce.
      if (dirty.current) save(current.current, edits.current);
    };
  }, [save]);
  return [draft, setDraft] as const;
}
