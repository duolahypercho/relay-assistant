import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Entity } from './types';
export function useGroupRecipients(thread: Entity) {
  const connection = api.connection();
  const key = `relay:group-recipients:${thread.id}:${thread.createdAt}`;
  const [ids, update] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      return (Array.isArray(saved) ? saved : thread.draftRecipientIds || []).filter((id: string) =>
        thread.participantIds?.includes(id),
      );
    } catch {
      return thread.draftRecipientIds || [];
    }
  });
  const current = useRef(ids);
  const setIds = (next: string[]) => {
    current.current = next;
    update(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Regular save still works. */
    }
  };
  useEffect(() => {
    const valid = current.current.filter((id) => thread.participantIds?.includes(id));
    if (JSON.stringify(valid) !== JSON.stringify(current.current)) setIds(valid);
  }, [JSON.stringify(thread.participantIds)]);
  useEffect(() => {
    if (!thread.participantIds) return;
    const timer = setTimeout(() => {
      void api.act('thread.update', { id: thread.id, draftRecipientIds: ids }).catch(() => {});
    }, 450);
    return () => clearTimeout(timer);
  }, [ids, thread.id, connection]);
  useEffect(
    () => () => {
      if (thread.participantIds)
        void api
          .act('thread.update', { id: thread.id, draftRecipientIds: current.current })
          .catch(() => {});
    },
    [thread.id],
  );
  return [ids, setIds] as const;
}
