import QuestionCard from './QuestionCard';
import { useState } from 'react';
import { ArrowRight, StopCircle } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { AssistantAvatar } from './Assistant';
import './handoffs.css';
const labels: Record<string, string> = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  needs_input: 'Needs your input',
  paused: 'Paused',
  completed: 'Ready',
  failed: 'Could not finish',
  cancelled: 'Stopped',
};
export default function HandoffCard({ id }: { id: string }) {
  const { s, act, selectThread, openFile, threadId } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const h = s.handoffs?.find((h) => h.id === id);
  if (!h) return null;
  const here = h.groupId === threadId;
  const resultMessage = h.result?.messageId || h.messageId;
  const active = !['completed', 'failed', 'cancelled'].includes(h.status);
  async function stop() {
    setBusy(true);
    setError('');
    try {
      await act('handoff.cancel', { id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`handoff-card ${here ? 'group-handoff-card' : ''}`}
      role="group"
      aria-label={`Request to ${h.targetName}`}
    >
      <div className="handoff-heading">
        <AssistantAvatar assistantId={h.targetId} />
        <div>
          <strong>{h.targetName}</strong>
          <span role="status">{h.reason || labels[h.status]}</span>
        </div>
      </div>
      <p>{h.title}</p>
      {h.error && <p className="handoff-error">{h.error}</p>}
      {!here && (
        <details>
          <summary>Request details</summary>
          <p>{h.request}</p>
          {h.result?.text && (
            <div>
              <strong>Returned result</strong>
              <p>{h.result.text}</p>
            </div>
          )}
        </details>
      )}
      {!here && !!h.result?.fileIds?.length && (
        <div className="handoff-files">
          {h.result.fileIds.map((fileId: string) => (
            <button key={fileId} className="attachment-button" onClick={() => openFile(fileId)}>
              {s.files.find((f) => f.id === fileId)?.name || 'Open result'}
            </button>
          ))}
        </div>
      )}
      {active &&
        !here &&
        (s.questions || [])
          .filter(
            (q) =>
              (h.groupId ? q.handoffId === h.id : q.threadId === h.threadId) &&
              q.status === 'pending',
          )
          .map((q) => <QuestionCard key={q.id} id={q.id} />)}
      <div className="handoff-actions">
        <button
          className="text-button"
          onClick={() => selectThread(h.threadId, h.groupId ? resultMessage : '')}
        >
          {here
            ? h.result?.messageId
              ? 'View reply'
              : 'View request'
            : h.groupId
              ? s.threads.find((t) => t.id === h.threadId)?.replyTo
                ? 'Open thread'
                : 'Open group'
              : 'Open conversation'}{' '}
          <ArrowRight size={16} />
        </button>
        {active && (
          <button className="text-button" disabled={busy} onClick={() => void stop()}>
            <StopCircle size={16} />
            {busy ? 'Stopping…' : 'Stop request'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="handoff-error">
          {error}
        </p>
      )}
    </section>
  );
}
