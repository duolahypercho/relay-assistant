import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { api } from './api';
import type { Entity } from './types';

export function useChatAttachments(thread: Entity) {
  const connection = api.connection();
  const key = `relay:pending-attachments:${api.mode()}:${thread.id}:${thread.createdAt}`;
  const [ids, update] = useState<string[]>(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
      return (Array.isArray(pending) ? pending : thread.draftFileIds || []).filter((id: string) =>
        api.snapshot().files.some((f) => f.id === id),
      );
    } catch {
      return thread.draftFileIds || [];
    }
  });
  const current = useRef(ids);
  const dirty = useRef(JSON.stringify(ids) !== JSON.stringify(thread.draftFileIds || []));
  const mounted = useRef(true);
  const saveAfterLeaving = useRef<(value: string[]) => Promise<void>>(async () => {});
  const setIds = useCallback(
    (value: SetStateAction<string[]>) => {
      const next = typeof value === 'function' ? value(current.current) : value;
      current.current = next;
      dirty.current = true;
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Server save still works. */
      }
      update(next);
      // File reads/requests can finish after switching conversations. Persist to
      // their original thread as well as this device's recovery copy.
      if (!mounted.current) void saveAfterLeaving.current(next).catch(() => {});
    },
    [key],
  );
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const save = useCallback(
    (value: string[]) => {
      const saving = pendingSave.current
        .catch(() => {})
        .then(async () => {
          const serialized = JSON.stringify(value);
          if (
            JSON.stringify(
              api.snapshot().threads.find((t) => t.id === thread.id)?.draftFileIds || [],
            ) !== serialized
          )
            await api.act('thread.update', { id: thread.id, draftFileIds: value });
          try {
            if (sessionStorage.getItem(key) === serialized) sessionStorage.removeItem(key);
          } catch {
            /* Storage may be disabled. */
          }
          if (JSON.stringify(current.current) === serialized) dirty.current = false;
        });
      pendingSave.current = saving;
      return saving;
    },
    [thread.id, key],
  );
  saveAfterLeaving.current = save;
  useEffect(() => {
    const remote = thread.draftFileIds || [];
    if (!dirty.current && JSON.stringify(current.current) !== JSON.stringify(remote)) {
      current.current = remote;
      update(remote);
    }
  }, [thread.draftFileIds]);
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void save(ids).catch(() => {}), 450);
    return () => clearTimeout(timer);
  }, [ids, save, connection]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (dirty.current) void save(current.current).catch(() => {});
    };
  }, [save]);
  return [ids, setIds] as const;
}
