import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { api } from './api';
import type { Entity } from './types';
import { appReferences } from '../shared/app-mentions.mjs';
export type AppReference = { id: string; revision: number; name: string };

export function useChatApps(thread: Entity) {
  const connection = api.connection();
  const key = `relay:pending-apps:${api.mode()}:${thread.id}:${thread.createdAt}`;
  const [ids, update] = useState<AppReference[]>(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
      return appReferences(Array.isArray(pending) ? pending : thread.draftApps || []);
    } catch {
      return thread.draftApps || [];
    }
  });
  const current = useRef(ids);
  const dirty = useRef(JSON.stringify(ids) !== JSON.stringify(thread.draftApps || []));
  const mounted = useRef(true);
  const saveAfterLeaving = useRef<(value: AppReference[]) => Promise<void>>(async () => {});
  const setIds = useCallback(
    (value: SetStateAction<AppReference[]>) => {
      const next = typeof value === 'function' ? value(current.current) : value;
      current.current = next;
      dirty.current = true;
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Server save still works. */
      }
      update(next);
      // Requests can finish after switching conversations. Persist to
      // their original thread as well as this device's recovery copy.
      if (!mounted.current) void saveAfterLeaving.current(next).catch(() => {});
    },
    [key],
  );
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const save = useCallback(
    (value: AppReference[]) => {
      const saving = pendingSave.current
        .catch(() => {})
        .then(async () => {
          const serialized = JSON.stringify(value);
          if (
            JSON.stringify(
              api.snapshot().threads.find((t) => t.id === thread.id)?.draftApps || [],
            ) !== serialized
          )
            await api.act('thread.update', { id: thread.id, draftApps: value });
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
    const remote = thread.draftApps || [];
    if (!dirty.current && JSON.stringify(current.current) !== JSON.stringify(remote)) {
      current.current = remote;
      update(remote);
    }
  }, [thread.draftApps]);
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
