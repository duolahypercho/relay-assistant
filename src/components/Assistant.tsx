import { useState, useEffect } from 'react';
import { CharacterSprite } from './CharacterLook';
export { CharacterSprite } from './CharacterLook';
import {
  ArrowRight,
  Brain,
  CheckCircle,
  Clock,
  Desktop,
  PencilSimple,
  ShieldCheck,
  Trash,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import type { Workspace, Entity } from '../types';
import { api } from '../api';
import {
  assistantForThread,
  assistantProfile,
  assistantMemories,
  threadAssistantId,
} from '../../shared/assistant-scope.mjs';
import { Field, Modal, Status, dateTime } from './ui';

export type CharacterState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';

export function useAssistantMotion(working = false, assistantId?: string): CharacterState {
  const { s: workspace, threadId } = useWorkspace();
  const s = assistantActivity(workspace, assistantId || threadAssistantId(workspace, threadId));
  const [, refresh] = useState(0);
  const latestTime = Math.max(
    0,
    ...s.tasks
      .filter((t) => ['completed', 'failed'].includes(t.status))
      .map((t) => Date.parse(t.updatedAt || t.createdAt) || 0),
    ...s.approvals
      .filter((a) => a.status === 'completed')
      .map((a) => Date.parse(a.completedAt || a.createdAt) || 0),
    ...s.messages
      .filter((m) => m.role === 'assistant' && m.id !== 'welcome')
      .map((m) => Date.parse(m.createdAt) || 0),
  );
  useEffect(() => {
    const remaining = latestTime + 4500 - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => refresh((value) => value + 1), remaining);
    return () => clearTimeout(timer);
  }, [latestTime]);
  const waiting =
    s.approvals.some((a) => a.status === 'pending') ||
    s.tasks.some((t) => ['needs_input', 'needs_approval'].includes(t.status));
  const active = working || s.tasks.some((t) => t.status === 'running');
  const thinking = s.runs.some((r) => ['running', 'queued'].includes(r.status));
  const recent = latestTime > Date.now() - 4500;
  const failed =
    recent &&
    s.tasks.some(
      (t) => t.status === 'failed' && Date.parse(t.updatedAt || t.createdAt) === latestTime,
    );
  return s.connections.runtime?.assistantPaused
    ? 'idle'
    : waiting
      ? 'waiting'
      : active
        ? 'working'
        : thinking
          ? 'thinking'
          : failed
            ? 'blocked'
            : recent
              ? 'done'
              : 'idle';
}

export function AssistantAvatar({
  assistantId,
  working = false,
  large = false,
  animated = false,
}: {
  assistantId?: string;
  working?: boolean;
  large?: boolean;
  animated?: boolean;
}) {
  const { s, threadId } = useWorkspace();
  const identity = assistantProfile(s, assistantId || threadAssistantId(s, threadId));
  const state = useAssistantMotion(working, identity.id);
  const moving = animated || large || working;
  const pose =
    state === 'working'
      ? 'walk'
      : state === 'thinking' || state === 'blocked'
        ? 'think'
        : state === 'done'
          ? 'wave'
          : 'idle';
  return (
    <span
      className={`assistant-avatar sprout-avatar ${large ? 'large' : ''} ${moving ? 'is-animated' : ''}`}
      data-state={state}
      style={{
        background: identity.avatarColor
          ? `color-mix(in srgb, ${identity.avatarColor} 18%, transparent)`
          : undefined,
      }}
      aria-hidden="true"
    >
      <CharacterSprite
        appearance={identity.appearance}
        color={identity.avatarColor}
        pose={moving ? pose : 'idle'}
        animated={moving}
      />
      {identity.id !== 'relay' &&
        (!identity.appearance || identity.appearance.kind === 'sprout') && (
          <span
            className="assistant-initial"
            style={{ backgroundColor: `color-mix(in srgb, ${identity.avatarColor} 25%, white)` }}
          >
            {identity.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      <span className="presence-dot" />
    </span>
  );
}

export function assistantActivity(s: Workspace, id = 'relay'): Workspace {
  return {
    ...s,
    tasks: s.tasks.filter((t: any) => (t.assistantId || threadAssistantId(s, t.threadId)) === id),
    runs: s.runs.filter((r: any) => threadAssistantId(s, r.threadId) === id),
    messages: s.messages.filter((m: any) => threadAssistantId(s, m.threadId) === id),
    approvals: s.approvals.filter(
      (a: any) =>
        (a.assistantId || s.tasks.find((t: any) => t.id === a.taskId)?.assistantId || 'relay') ===
        id,
    ),
    watches: id === 'relay' ? s.watches : [],
  };
}
export function assistantStatus(workspace: any, id = 'relay') {
  const s = assistantActivity(workspace, id);
  if (s.connections.runtime?.assistantPaused) return 'Chat paused';
  const attention =
    s.approvals.filter((a: any) => a.status === 'pending').length +
    s.tasks.filter((t: any) => t.status === 'needs_input').length;
  if (attention)
    return `${attention} ${attention === 1 ? 'thing needs' : 'things need'} your input`;
  const task = s.tasks.find((t: any) => t.status === 'running');
  if (task) return task.plan[Math.min(task.step, task.plan.length - 1)] || 'Working on your task';
  if (s.runs.some((r: any) => r.status === 'running')) return 'Working on your message';
  const tracking = s.watches.filter((w: any) => !w.paused).length;
  return tracking
    ? `Keeping an eye on ${tracking} ${tracking === 1 ? 'thing' : 'things'}`
    : 'Here when you need me';
}

export function MemoryList({ assistantId }: { assistantId?: string } = {}) {
  const { s, act, toast, selectThread, threadId } = useWorkspace();
  const identity = assistantProfile(s, assistantId || threadAssistantId(s, threadId));
  const memories: Entity[] = assistantMemories(s, identity.id);
  const [newMemory, setNewMemory] = useState('');
  const [editing, setEditing] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="memory-manager">
      <div className="settings-row memory-learning">
        <div>
          <h3>Learn from our chats</h3>
          <p>Keep useful preferences as we talk. Turn this off to save only what you ask.</p>
        </div>
        <button
          className={`switch ${identity.memoryLearning !== false ? 'on' : ''}`}
          role="switch"
          aria-checked={identity.memoryLearning !== false}
          aria-label="Learn from our chats"
          onClick={() =>
            void act('assistant.learning', {
              id: identity.id,
              enabled: identity.memoryLearning === false,
            })
          }
        >
          <span />
        </button>
      </div>
      {!s.connections.model?.configured && (
        <p className="form-note">
          Automatic learning needs a connected model. You can still ask to remember something.
        </p>
      )}
      <p className="form-note">
        Used by {identity.name} across its chats. Other assistants keep their own memories. Edit or
        forget any note; its original message stays in history.
      </p>
      <div className="memory-list">
        {memories.length ? (
          memories.map((m) => (
            <article className="memory-entry" key={m.id}>
              {editing === m.id ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    if (await act('memory.update', { id: m.id, text })) {
                      setEditing('');
                      toast('Memory updated.');
                    }
                    setBusy(false);
                  }}
                >
                  <Field label="Edit memory">
                    <textarea
                      required
                      maxLength={500}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </Field>
                  <div className="memory-actions">
                    <button type="submit" className="primary-button" disabled={busy}>
                      Save memory
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setEditing('')}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p>{m.type === 'dismissed-idea' ? `Dismissed suggestion: ${m.text}` : m.text}</p>
                  <div className="memory-provenance">
                    {m.origin === 'learned' && <span>Learned from our chat</span>}
                    <span>
                      {m.updatedAt ? (m.origin === 'learned' ? 'Updated' : 'Edited') : 'Saved'}{' '}
                      {dateTime(m.updatedAt || m.createdAt)}
                    </span>
                    {m.sourceMessageId && (
                      <button
                        className="text-button"
                        onClick={() => selectThread(m.sourceThreadId, m.sourceMessageId)}
                      >
                        From your message <ArrowRight size={13} />
                      </button>
                    )}
                  </div>
                  {m.evidence && (
                    <details className="memory-evidence">
                      <summary>Source quote</summary>
                      <blockquote>{m.evidence}</blockquote>
                    </details>
                  )}
                  {m.proposal && (
                    <section className="memory-proposal" aria-label="Possible memory update">
                      <strong>Possible update</strong>
                      <p>{m.proposal.text}</p>
                      <p className="form-note">Your saved wording stays in use until you choose.</p>
                      <button
                        className="text-button"
                        onClick={() =>
                          selectThread(m.proposal.sourceThreadId, m.proposal.sourceMessageId)
                        }
                      >
                        From your latest message <ArrowRight size={13} />
                      </button>
                      <div className="memory-actions">
                        <button
                          className="secondary-button"
                          onClick={() =>
                            void act('memory.resolve', {
                              id: m.id,
                              proposalId: m.proposal.id,
                              use: true,
                            })
                          }
                        >
                          Use update
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void act('memory.resolve', {
                              id: m.id,
                              proposalId: m.proposal.id,
                              use: false,
                            })
                          }
                        >
                          Keep mine
                        </button>
                      </div>
                    </section>
                  )}
                  <div className="memory-actions">
                    {m.type === 'note' && (
                      <button
                        className="text-button"
                        aria-label={`Edit memory ${m.text}`}
                        onClick={() => {
                          setEditing(m.id);
                          setText(m.text);
                        }}
                      >
                        <PencilSimple size={15} />
                        Edit
                      </button>
                    )}
                    <button
                      className="text-button danger-text"
                      aria-label={`Remove memory ${m.text}`}
                      onClick={async () => {
                        if (await act('memory.delete', { id: m.id })) toast('Memory forgotten.');
                      }}
                    >
                      <Trash size={15} />
                      Forget
                    </button>
                  </div>
                </>
              )}
            </article>
          ))
        ) : (
          <div className="memory-empty">
            <Brain size={26} />
            <p>Tell me what you’d like me to remember.</p>
            <small>A preference, an interest, or how you like things done.</small>
          </div>
        )}
      </div>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          if (await act('memory.add', { text: newMemory, assistantId: identity.id })) {
            setNewMemory('');
            toast('Memory saved.');
          }
          setBusy(false);
        }}
      >
        <input
          aria-label="New memory"
          required
          maxLength={500}
          value={newMemory}
          onChange={(e) => setNewMemory(e.target.value)}
          placeholder="For example, keep Friday afternoons free"
        />
        <button className="secondary-button" type="submit" disabled={busy}>
          Add memory
        </button>
      </form>
    </div>
  );
}

export default function AssistantDetails({
  onClose,
  initialTab = 'activity',
}: {
  onClose: () => void;
  initialTab?: 'activity' | 'memory' | 'access';
}) {
  const { s: workspace, go, openTask, openFile, threadId } = useWorkspace();
  const identity = assistantForThread(workspace, threadId);
  const s = assistantActivity(workspace, identity.id);
  const [tab, setTab] = useState(initialTab);
  const open = (page: any) => {
    onClose();
    go(page);
  };
  const tasks = s.tasks.slice(0, 8);
  const reviews = s.approvals.filter((a) => a.status === 'pending');
  return (
    <Modal title="Your assistant" onClose={onClose}>
      <div className="tabs assistant-tabs">
        <button className={tab === 'activity' ? 'selected' : ''} onClick={() => setTab('activity')}>
          <Clock size={17} />
          Activity
        </button>
        <button className={tab === 'memory' ? 'selected' : ''} onClick={() => setTab('memory')}>
          <Brain size={17} />
          My memories
        </button>
        <button className={tab === 'access' ? 'selected' : ''} onClick={() => setTab('access')}>
          <ShieldCheck size={17} />
          Access
        </button>
      </div>
      {tab === 'activity' && (
        <div className="assistant-profile">
          <AssistantAvatar
            large
            working={
              s.tasks.some((t) => t.status === 'running') ||
              s.runs.some((r) => r.status === 'running')
            }
          />
          <h3>{identity.name}</h3>
          <p>{assistantStatus(workspace, identity.id)}</p>
          <button
            className="text-button"
            onClick={() => {
              onClose();
              location.hash = `assistants?edit=${encodeURIComponent(identity.id)}`;
            }}
          >
            Personalize <PencilSimple size={15} />
          </button>
        </div>
      )}
      {tab === 'memory' && <MemoryList />}
      {tab === 'activity' && (
        <div className="assistant-activity">
          {reviews.length > 0 && (
            <button className="attention-summary" onClick={() => open('activity')}>
              <ShieldCheck size={21} />
              <span>
                <strong>
                  {reviews.length} action{reviews.length === 1 ? '' : 's'} waiting for your review
                </strong>
                <small>You decide before anything is sent or changed.</small>
              </span>
              <ArrowRight size={17} />
            </button>
          )}
          {tasks.length ? (
            tasks.map((t) => (
              <button
                className="assistant-task"
                key={t.id}
                onClick={() => {
                  onClose();
                  openTask(t.id);
                }}
              >
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {t.status === 'completed'
                      ? 'Your result is saved'
                      : t.plan[Math.min(t.step, t.plan.length - 1)]}
                  </small>
                </span>
                <Status status={t.status} />
              </button>
            ))
          ) : (
            <p className="form-note">No tasks yet. Send me something to do in the chat.</p>
          )}
          {s.files
            .filter((f) => f.generated)
            .slice(0, 3)
            .map((f) => (
              <button
                className="assistant-task"
                key={f.id}
                onClick={() => {
                  onClose();
                  openFile(f.id);
                }}
              >
                <span>
                  <strong>{f.name}</strong>
                  <small>Saved result</small>
                </span>
                <CheckCircle size={19} />
              </button>
            ))}
          <button className="text-button" onClick={() => open('routines')}>
            My routines <ArrowRight size={16} />
          </button>
          <button className="text-button" onClick={() => open('skills')}>
            My skills <ArrowRight size={16} />
          </button>
          <button className="text-button" onClick={() => open('activity')}>
            See all activity <ArrowRight size={16} />
          </button>
        </div>
      )}
      {tab === 'access' && (
        <div className="assistant-access">
          <article>
            <h3>Mail & calendar</h3>
            <p>
              {s.connections.google.connected
                ? `${s.connections.google.email} · ${s.connections.google.write ? 'Read and reviewed writes' : 'Read only'}`
                : 'No account connected. Sample messages stay in this workspace.'}
            </p>
          </article>
          <article>
            <h3>Your model</h3>
            <p>
              {s.connections.model.configured
                ? `Connected · ${s.connections.runtime?.model || 'Your configured model'}. Conversation context is sent to that provider.`
                : 'Sample mode uses local scripted workflows. Connect your own model for open-ended conversation.'}
            </p>
          </article>
          <article>
            <h3>Computer</h3>
            <p>
              {api.mode() === 'server'
                ? 'A separate browser profile and an optional Docker workspace. Access is limited to the tools enabled on your server.'
                : 'The preview uses sample data. The supplied server provides the separate browser and optional Docker workspace.'}
            </p>
            <button className="text-button" onClick={() => open('computer')}>
              <Desktop size={16} />
              Open computer
            </button>
          </article>
          <button className="secondary-button" onClick={() => open('apps')}>
            Manage connections
          </button>
        </div>
      )}
    </Modal>
  );
}
