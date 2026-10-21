import { ChatCircle, ArrowUpRight, CaretDown } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import { useWorkspace } from '../context';
import type { Entity } from '../types';
import './reply-threads.css';

export function ThreadReplies({ messageId }: { messageId: string }) {
  const { s, selectThread } = useWorkspace();
  const thread = s.threads.find((t) => t.replyTo?.message.id === messageId);
  if (!thread) return null;
  const count = s.messages.filter((m) => m.threadId === thread.id).length;
  const question =
    s.questions?.some((q) => q.threadId === thread.id && q.status === 'pending') ||
    s.handoffs?.some((h) => h.sourceThreadId === thread.id && h.status === 'needs_input');
  const active = s.runs.some(
    (r) => r.threadId === thread.id && ['queued', 'running'].includes(r.status),
  );
  const status = question
    ? 'Needs your reply'
    : active
      ? thread.queuePaused
        ? 'Paused'
        : 'Working'
      : thread.draft || thread.draftFileIds?.length || thread.draftShareIds?.length
        ? 'Draft'
        : '';
  const label = count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'Open thread';
  return (
    <button className="thread-replies" aria-label={label} onClick={() => selectThread(thread.id)}>
      <ChatCircle size={16} />
      <span>{label}</span>
      {status && <small>{status}</small>}
    </button>
  );
}

export function ThreadOriginal({ thread }: { thread: Entity }) {
  const { s, selectThread, openFile, act } = useWorkspace();
  const { message, threadId } = thread.replyTo;
  const files = [
    ...new Set<string>([
      ...(message.fileIds || []),
      ...message.cards.filter((c: Entity) => c.kind === 'file').map((c: Entity) => c.id),
    ]),
  ];
  return (
    <div className="thread-original">
      <details>
        <summary>
          <CaretDown className="thread-context-toggle" size={15} aria-hidden="true" />
          <span>
            Original message ·{' '}
            {message.role === 'user' ? 'You' : message.assistantName || 'Assistant'}
          </span>
          <strong>{message.text || 'A result in your conversation'}</strong>
        </summary>
        <div className="markdown">
          <ReactMarkdown components={{ img: ({ alt }) => <span>Image: {alt}</span> }}>
            {message.text}
          </ReactMarkdown>
        </div>
        {message.sharedTexts?.map((text: string, i: number) => (
          <blockquote className="shared-message-source" key={i}>
            {text}
          </blockquote>
        ))}
        {message.cards
          .filter((c: Entity) => ['question', 'review', 'task', 'task-detail'].includes(c.kind))
          .map((c: Entity) => {
            const record = (
              c.kind === 'question' ? s.questions : c.kind === 'review' ? s.approvals : s.tasks
            )?.find((x: Entity) => x.id === c.id);
            return (
              record && (
                <p key={`${c.kind}-${c.id}`}>
                  {record.prompt || record.title}{' '}
                  <small>· {record.status.replaceAll('_', ' ')}</small>
                </p>
              )
            );
          })}
        {files.map((id) => (
          <button key={id} className="text-button" onClick={() => openFile(id)}>
            {s.files.find((f) => f.id === id)?.name || 'Open attachment'}
          </button>
        ))}
        <button className="text-button" onClick={() => selectThread(threadId, message.id)}>
          View original message <ArrowUpRight size={15} />
        </button>
      </details>
      {thread.archived && (
        <p className="thread-archived">
          This conversation is archived.{' '}
          <button
            className="text-button"
            onClick={() => void act('thread.update', { id: threadId, archived: false })}
          >
            Restore conversation
          </button>
        </p>
      )}
    </div>
  );
}
