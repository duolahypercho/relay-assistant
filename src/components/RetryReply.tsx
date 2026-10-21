import { useRef, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { replyRetryReason } from '../../shared/chat-retry.mjs';
import { useWorkspace } from '../context';
import { tr } from '../i18n';
import type { Entity } from '../types';

export default function RetryReply({ message }: { message: Entity }) {
  const { s, act } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = s.runs.find((r) => r.id === message.runId);
  if (!message.error || !run || run.retryMessageId !== message.id) return null;
  if (run.retryFromMessageId === message.id && ['queued', 'running'].includes(run.status))
    return (
      <span className="message-meta" role="status">
        {tr('Trying again…')}
      </span>
    );
  if (replyRetryReason(s, run)) return null;
  return (
    <button
      className="text-button message-retry"
      disabled={busy}
      onClick={async () => {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        try {
          await act('chat.retry', { id: run.id, messageId: message.id });
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <ArrowClockwise size={16} />
      {tr(busy ? 'Trying again…' : 'Try again')}
    </button>
  );
}
