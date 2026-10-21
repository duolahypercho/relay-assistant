import { mediaKind } from '../../shared/media-files.mjs';
import AttachmentList, { isPhoto } from './AttachmentList';
import HandoffCard from './HandoffCard';
import ReminderCard from './ReminderCard';
import { useEffect, useState } from 'react';
import {
  Stack,
  Lightbulb,
  FileText,
  Envelope,
  Target,
  CalendarBlank,
  Globe,
  ArrowRight,
  CheckCircle,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { Status, money, dateTime } from './ui';
import { Review, TaskContent } from '../views/Activity';
import WorkspaceCard from './WorkspaceCard';
import VoiceMemo from './VoiceMemo';
import QuestionCard from './QuestionCard';
import { WebsitePermission } from './ComputerWebsites';
import { ComputerJobCard } from './ComputerJobs';
import { visibleIdeas } from '../../shared/ideas.mjs';
import { artifactKinds } from '../../shared/artifacts.mjs';
import { uniqueFileCards } from '../../shared/message-cards.mjs';
import { tr } from '../i18n';

export function MessageCards({ cards, messageId }: { cards: any[]; messageId: string }) {
  const { s, openFile } = useWorkspace();
  const unique = uniqueFileCards(cards);
  const sources = unique
    .filter((card) => card.kind === 'file' && card.purpose === 'source')
    .flatMap((card) => s.files.filter((file) => file.id === card.id));
  return (
    <>
      {unique
        .filter((card) => card.kind !== 'file' || card.purpose !== 'source')
        .map((card, i) => (
          <RichCard key={i} card={card} messageId={messageId} />
        ))}
      {sources.length > 0 && (
        <div className="message-sources" role="group" aria-label={tr('Sources')}>
          <span className="message-sources-label">{tr('Sources')}</span>
          {sources.map((file) => (
            <button key={file.id} onClick={() => openFile(file.id)}>
              <FileText size={15} aria-hidden="true" />
              <span>{file.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export default function RichCard({ card, messageId = '' }: { card: any; messageId?: string }) {
  const { s, go, openFile, openMemories, focusMessageId } = useWorkspace();
  const task = ['task', 'task-detail'].includes(card.kind)
    ? s.tasks.find((t) => t.id === card.id)
    : null;
  const [expanded, setExpanded] = useState(
    card.kind === 'task-detail' || task?.status === 'needs_input',
  );
  useEffect(() => {
    if (task?.status === 'needs_input' || (messageId && focusMessageId === messageId))
      setExpanded(true);
  }, [task?.status, focusMessageId, messageId]);
  if (card.kind === 'handoff') return <HandoffCard id={card.id} />;
  if (card.kind === 'reminder') {
    const source = s.messages.find((m) => m.id === messageId);
    const latest =
      source &&
      s.messages.findLast(
        (m) =>
          m.threadId === source.threadId &&
          m.cards?.some((c: any) => c.kind === 'reminder' && c.id === card.id),
      );
    if (latest && latest.id !== messageId) return null;
    return <ReminderCard id={card.id} />;
  }
  if (card.kind === 'idea') {
    const idea = visibleIdeas(s).find((item: any) => item.id === card.id);
    return (
      <button className="rich-card" onClick={() => go('ideas')}>
        <span className="rich-icon">
          <Lightbulb size={23} />
        </span>
        <div>
          <strong>{idea?.title || 'This suggestion is no longer current'}</strong>
          <span>{idea?.description || 'Open Ideas to see what is useful now.'}</span>
        </div>
        <ArrowRight size={18} />
      </button>
    );
  }
  if (card.kind === 'computer-job') return <ComputerJobCard id={card.id} title={card.title} />;
  if (card.kind === 'question') return <QuestionCard id={card.id} />;
  if (card.kind === 'computer-access')
    return <WebsitePermission host={card.host} runId={card.runId} />;
  if (card.kind === 'workspace') return <WorkspaceCard page={card.page} messageId={messageId} />;
  if (card.kind === 'voice') {
    const message = s.messages.find((m) => m.id === messageId);
    const replyTo = message?.replyTo;
    // The call owns playback until it ends. Show the saved memo controls afterward.
    if (
      replyTo &&
      s.voiceCalls?.some(
        (c) => c.status === 'active' && c.turns.some((t: any) => t.messageId === replyTo),
      )
    )
      return null;
    return (
      <VoiceMemo
        card={card}
        messageId={messageId}
        compact={
          message?.role === 'assistant' && !!message.text && message.text === card.transcript
        }
      />
    );
  }
  if (card.kind === 'voice-call')
    return (
      <div className="voice-call-summary" role="group" aria-label="Voice chat ended">
        <strong>Voice chat</strong>
        <span>
          {Math.floor(card.seconds / 60)}:{String(card.seconds % 60).padStart(2, '0')} ·{' '}
          {card.turns} spoken {card.turns === 1 ? 'turn' : 'turns'} · {card.reason}
        </span>
      </div>
    );
  if (card.kind === 'task-detail')
    return task ? (
      <section className="chat-task-card task-details-card" aria-label={task.title}>
        <h2 className="task-card-heading">{task.title}</h2>
        <TaskContent id={task.id} />
      </section>
    ) : null;
  if (card.kind === 'task') {
    const t = s.tasks.find((t) => t.id === card.id);
    return t ? (
      <div className="chat-task-card">
        <button
          className="rich-card"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="rich-icon">
            <Stack size={23} />
          </span>
          <div>
            <strong>{t.title}</strong>
            <span>
              <Status status={t.status} />
            </span>
            <small>
              {t.status === 'completed'
                ? 'Your result is saved'
                : t.plan[Math.min(t.step, t.plan.length - 1)] || 'Saved result'}
            </small>
          </div>
          <ArrowRight size={18} />
        </button>
        {t.status === 'needs_input' && !expanded && (
          <button className="secondary-button" onClick={() => setExpanded(true)}>
            Add the missing details
          </button>
        )}
        {expanded && <TaskContent id={t.id} />}
        {t.approvalId && !expanded && (
          <div className="chat-review">
            <Review id={t.approvalId} />
          </div>
        )}
        {!expanded && (t.resultFileId || t.filledFileId) && (
          <button
            className="attachment-button"
            onClick={() => openFile(t.resultFileId || t.filledFileId)}
          >
            <FileText size={17} />
            {s.files.find((f) => f.id === (t.resultFileId || t.filledFileId))?.name ||
              'Open saved result'}
          </button>
        )}
      </div>
    ) : null;
  }
  if (card.kind === 'email') {
    const m = s.mail.find((m) => m.id === card.id);
    return m ? (
      <button className="rich-card" onClick={() => go('inbox')}>
        <span className="rich-icon">
          <Envelope size={23} />
        </span>
        <div>
          <small>{m.from}</small>
          <strong>{m.subject}</strong>
          <span>{m.body.slice(0, 140)}</span>
        </div>
        <ArrowRight size={18} />
      </button>
    ) : null;
  }
  if (card.kind === 'file') {
    const f = s.files.find((f) => f.id === card.id);
    if (isPhoto(f) || mediaKind(f)) return <AttachmentList ids={[f!.id]} />;
    return f ? (
      <button className="rich-card" onClick={() => openFile(f.id)}>
        <span className="rich-icon">
          <FileText size={23} />
        </span>
        <div>
          <strong>{f.name}</strong>
          <span>
            {f.artifactId
              ? `${artifactKinds[s.artifacts?.find((a) => a.id === f.artifactId)?.kind as keyof typeof artifactKinds]?.label || 'Result'} · Version ${f.artifactVersion} · Open & edit`
              : 'Saved to your files'}
          </span>
        </div>
        <ArrowRight size={18} />
      </button>
    ) : null;
  }
  if (card.kind === 'review') {
    const a = s.approvals.find((a) => a.id === card.id);
    return a ? (
      <div className="chat-review">
        <Review id={a.id} />
      </div>
    ) : null;
  }
  if (card.kind === 'goal') {
    const g = s.goals.find((g) => g.id === card.id);
    return g ? (
      <button className="rich-card" onClick={() => go('goals')}>
        <span className="rich-icon">
          <Target size={23} />
        </span>
        <div>
          <strong>{g.title}</strong>
          <span>
            {g.current} of {g.target} {g.unit}
          </span>
        </div>
        <ArrowRight size={18} />
      </button>
    ) : null;
  }
  if (card.kind === 'finance')
    return (
      <button className="rich-card finance-rich" onClick={() => go('finance')}>
        <div>
          <strong>Your spending, at a glance</strong>
          <div className="inline-metrics">
            <span>
              <small>Income</small>
              {money(card.summary.income)}
            </span>
            <span>
              <small>Spending</small>
              {money(card.summary.expenses)}
            </span>
            <span>
              <small>Remaining</small>
              {money(card.summary.net)}
            </span>
          </div>
          <span>{card.summary.count} imported transactions · USD</span>
        </div>
      </button>
    );
  if (card.kind === 'calendar')
    return (
      <button className="rich-card" onClick={() => go('calendar')}>
        <span className="rich-icon">
          <CalendarBlank size={23} />
        </span>
        <div>
          <strong>Your calendar</strong>
          <span>
            {card.events.length
              ? card.events
                  .slice(0, 3)
                  .map((e: any) => `${e.title} · ${dateTime(e.start, e.allDay)}`)
                  .join('\n')
              : 'No events in this range.'}
          </span>
        </div>
        <ArrowRight size={18} />
      </button>
    );
  if (card.kind === 'browser')
    return (
      <div className="rich-card browser-rich">
        <div>
          <div className="card-title-line">
            <Globe size={20} />
            <strong>{card.title || 'Browser result'}</strong>
          </div>
          <a href={card.url} target="_blank" rel="noreferrer">
            {card.url}
          </a>
          {card.screenshot && (
            <img
              alt={`Browser screenshot of ${card.title}`}
              src={`data:image/jpeg;base64,${card.screenshot}`}
            />
          )}
          <p>{card.text}</p>
          <button className="secondary-button" onClick={() => go('computer')}>
            Take control
          </button>
        </div>
      </div>
    );
  if (card.kind === 'sources')
    return (
      <div className="source-card">
        <strong>Sources to explore</strong>
        {card.results.map((r: any) => (
          <a href={r.url} key={r.url} target="_blank" rel="noreferrer">
            <Globe size={17} />
            <span>
              {r.title}
              <small>{new URL(r.url).hostname}</small>
            </span>
            <ArrowRight size={16} />
          </a>
        ))}
      </div>
    );
  if (card.kind === 'navigation')
    return (
      <button className="inline-link" onClick={() => go(card.page)}>
        {card.title}
        <ArrowRight size={17} />
      </button>
    );
  if (card.kind === 'memory')
    return (
      <button className="inline-link memory-link" onClick={openMemories}>
        {card.action === 'review' ? <ArrowRight size={16} /> : <CheckCircle size={16} />}
        {card.action === 'review'
          ? 'My memories'
          : s.memories.find((m) => m.id === card.id)?.proposal
            ? 'Review memory update'
            : s.memories.some((m) => m.id === card.id)
              ? 'Memory saved'
              : 'Memory forgotten'}
      </button>
    );
  return null;
}
