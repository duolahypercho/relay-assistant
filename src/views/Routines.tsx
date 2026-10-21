import {
  assistantForThread,
  threadAssistantId,
  assistantSkills,
} from '../../shared/assistant-scope.mjs';
import { useState } from 'react';
import {
  Plus,
  ClockCounterClockwise,
  Play,
  Pause,
  Archive,
  PencilSimple,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { Field, Empty, Modal, Status } from '../components/ui';
import { nextOccurrence, scheduleLabel, validateSchedule } from '../../shared/routines.mjs';
import { matchesMail } from '../../shared/mail-triggers.mjs';
import type { Entity } from '../types';

function stamp(value: number | string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
export default function Routines() {
  const { s, threadId, act, selectThread } = useWorkspace();
  const [edit, setEdit] = useState<Entity | 'new' | null>(null);
  const [archived, setArchived] = useState(false);
  const [testEmail, setTestEmail] = useState<Entity | null>(null);
  const identity = assistantForThread(s, threadId);
  const routines = (s.routines || []).filter(
    (r) => !!r.archived === archived && threadAssistantId(s, r.threadId) === identity.id,
  );
  return (
    <section className="routines-view">
      <div className="routine-heading">
        <div>
          <h2>A little help, on repeat</h2>
          <p>Tell me what to do, on a schedule or when an email arrives.</p>
        </div>
        <button className="primary-button" onClick={() => setEdit('new')}>
          <Plus size={17} /> New routine
        </button>
      </div>
      <p className="form-note">
        {api.mode() === 'sample'
          ? 'This device sample runs only while Relay is open. Connect to your Relay server to run while the app is closed.'
          : 'Routines run while your Relay server is running, even with this app closed.'}{' '}
        External actions still come back for your review.
      </p>
      <button className="text-button routine-archive-toggle" onClick={() => setArchived(!archived)}>
        <Archive size={16} />
        {archived ? 'Show current routines' : 'Archived routines'}
      </button>
      {!routines.length && (
        <Empty
          icon={ClockCounterClockwise}
          title={archived ? 'No archived routines' : 'Make room for the things you enjoy'}
        >
          A morning briefing, a weekly spending review, or a one-time reminder.
        </Empty>
      )}
      <div className="routine-list">
        {routines.map((r) => {
          const history = s.runs
            .filter((run) => run.routineId === r.id)
            .slice(-20)
            .reverse();
          const busy = history.find((run) => ['queued', 'running'].includes(run.status));
          return (
            <article className="routine-card" key={r.id} aria-label={r.title}>
              <div className="routine-heading">
                <h3>{r.title}</h3>
                <span className="routine-state">
                  {r.archived ? 'Archived' : r.paused ? 'Paused' : 'On'}
                </span>
              </div>
              <p className="routine-schedule">{scheduleLabel(r.schedule)}</p>
              {r.schedule.kind === 'email' && (
                <p className={r.eventError ? 'inline-error' : 'form-note'}>
                  {r.eventError ||
                    (!s.connections.google.connected
                      ? 'Connect Google to enable this trigger.'
                      : r.paused
                        ? 'Starts watching after the first successful mail check. Existing inbox mail is skipped.'
                        : s.connections.google.mailTrigger?.error
                          ? `Mail check delayed: ${s.connections.google.mailTrigger.error}`
                          : !r.eventCursor
                            ? 'Starting the mail trigger…'
                            : `Checking about once a minute${s.connections.google.mailTrigger?.lastCheckedAt ? ` · Last checked ${stamp(s.connections.google.mailTrigger.lastCheckedAt, s.profile.timeZone || 'UTC')}` : ''}.`)}
                </p>
              )}
              {r.skill && (
                <p className="routine-skill">
                  Skill: {r.skill.title} · version {r.skill.version}
                </p>
              )}
              <p className="routine-instructions">{r.instructions}</p>
              <small>
                Posts in {s.threads.find((t) => t.id === r.threadId)?.title || 'Unavailable chat'} ·{' '}
                {r.notification === 'all'
                  ? 'Every result'
                  : r.notification === 'errors'
                    ? 'Failures only'
                    : 'New or changed results'}
              </small>
              {!r.paused && r.nextRunAt && (
                <p className="routine-next">Next: {stamp(r.nextRunAt, r.schedule.timeZone)}</p>
              )}
              <div className="routine-controls">
                {r.archived ? (
                  <button
                    className="secondary-button"
                    onClick={() => void act('routine.restore', { id: r.id })}
                  >
                    Restore routine
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary-button"
                      disabled={!!busy}
                      onClick={() =>
                        r.schedule.kind === 'email'
                          ? setTestEmail(r)
                          : void act('routine.test', { id: r.id })
                      }
                    >
                      <Play size={15} /> Test run
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void act(r.paused ? 'routine.resume' : 'routine.pause', { id: r.id })
                      }
                    >
                      {r.paused ? <Play size={15} /> : <Pause size={15} />}
                      {r.paused
                        ? `Enable ${r.schedule.kind === 'email' ? 'trigger' : 'schedule'}`
                        : `Pause ${r.schedule.kind === 'email' ? 'email trigger' : 'schedule'}`}
                    </button>
                    <button className="text-button" onClick={() => setEdit(r)}>
                      <PencilSimple size={15} /> Edit routine
                    </button>
                    <button
                      className="text-button"
                      onClick={() => void act('routine.archive', { id: r.id })}
                    >
                      <Archive size={15} /> Archive routine
                    </button>
                  </>
                )}
              </div>
              {busy && (
                <p className="routine-running" role="status">
                  <Status status={busy.status} />
                  <button
                    className="text-button"
                    onClick={() => void act('chat.stop', { id: busy.id })}
                  >
                    Stop this run
                  </button>
                </p>
              )}
              <details className="routine-history">
                <summary>Recent runs ({history.length})</summary>
                {!history.length && (
                  <p className="form-note">
                    Try a test run to check the result before enabling the schedule.
                  </p>
                )}
                {history.map((run) => {
                  const message = s.messages.find((m) => m.routineRunId === run.id);
                  return (
                    <div key={run.id} className="routine-run">
                      <div>
                        <Status status={run.status} />
                        <small>
                          {run.trigger === 'test'
                            ? 'Test'
                            : run.trigger === 'email'
                              ? 'Incoming email'
                              : 'Scheduled'}{' '}
                          ·{' '}
                          {stamp(run.createdAt, r.schedule.timeZone || s.profile.timeZone || 'UTC')}{' '}
                          · version {run.routineVersion}
                          {run.skill && ` · ${run.skill.title} v${run.skill.version}`}
                        </small>
                      </div>
                      {run.error && <p className="inline-error">{run.error}</p>}
                      {run.mailSource && (
                        <details className="routine-email-source">
                          <summary>Triggering email: {run.mailSource.subject}</summary>
                          <p>
                            {run.mailSource.from} · {run.mailSource.email}
                          </p>
                          <p>{run.mailSource.body}</p>
                        </details>
                      )}
                      {run.result && (
                        <p>
                          {run.result.text.slice(0, 600)}
                          {run.result.text.length > 600 ? '…' : ''}
                        </p>
                      )}
                      {run.status === 'completed' && !run.surfaced && (
                        <small>
                          {run.resultReview?.decision === 'unchanged'
                            ? 'Saved quietly · no meaningful change'
                            : 'Saved quietly · notification preference'}
                        </small>
                      )}
                      {run.resultReview?.decision === 'unchanged' && (
                        <details>
                          <summary>Why this stayed quiet</summary>
                          <p>The model found the same outcome as the last posted result.</p>
                          <p>Previously: {run.resultReview.previousQuote}</p>
                          <p>This time: {run.resultReview.currentQuote}</p>
                        </details>
                      )}
                      {message && (
                        <button
                          className="text-button"
                          onClick={() => selectThread(run.threadId, message.id)}
                        >
                          View result in chat
                        </button>
                      )}
                      {!message && run.result && (
                        <button
                          className="text-button"
                          onClick={async () => {
                            const result = await act('routine.reveal', { id: r.id, runId: run.id });
                            if (result) selectThread(result.threadId, result.id);
                          }}
                        >
                          Show saved result in chat
                        </button>
                      )}
                    </div>
                  );
                })}
              </details>
            </article>
          );
        })}
      </div>
      {edit && (
        <RoutineEditor
          key={edit === 'new' ? 'new' : edit.id}
          initial={edit === 'new' ? undefined : edit}
          threadId={threadId}
          onClose={() => setEdit(null)}
        />
      )}
      {testEmail && <EmailTest routine={testEmail} onClose={() => setTestEmail(null)} />}
    </section>
  );
}
function RoutineEditor({
  initial,
  threadId,
  onClose,
}: {
  initial?: Entity;
  threadId: string;
  onClose: () => void;
}) {
  const { s } = useWorkspace();
  const [title, setTitle] = useState(initial?.title || '');
  const [instructions, setInstructions] = useState(initial?.instructions || '');
  const [execution, setExecution] = useState(initial?.execution || 'assistant');
  const [skillId, setSkillId] = useState(initial?.skill?.id || '');
  const [refreshSkill, setRefreshSkill] = useState(false);
  const availableSkills = assistantSkills(
    s,
    threadAssistantId(s, initial?.threadId || threadId),
  ) as Entity[];
  const currentSkill = availableSkills.find((x) => x.id === skillId && !x.archived);
  const [chat, setChat] = useState(initial?.threadId || threadId);
  const [kind, setKind] = useState(initial?.schedule.kind || 'daily');
  const [sender, setSender] = useState(initial?.schedule.sender || '');
  const [subject, setSubject] = useState(initial?.schedule.subject || '');
  const [time, setTime] = useState(initial?.schedule.time || '09:00');
  const [date, setDate] = useState(
    initial?.schedule.date || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  );
  const [zone, setZone] = useState(
    initial?.schedule.timeZone ||
      s.profile.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [days, setDays] = useState<number[]>(initial?.schedule.days || [1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState(initial?.schedule.minutes || 60);
  const [notification, setNotification] = useState(initial?.notification || 'changed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const schedule = {
    kind,
    time,
    date,
    timeZone: zone,
    days,
    minutes: Number(minutes),
    sender,
    subject,
  };
  let preview = '';
  try {
    const next = nextOccurrence(validateSchedule(schedule), Date.now());
    preview =
      kind === 'email'
        ? 'All filters must match. Sender is an exact address; subject is a phrase, ignoring letter case.'
        : next
          ? `Next: ${stamp(next, zone)} · ${zone}`
          : 'Choose a future time.';
  } catch {
    /* Inline validation on save. */
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.act(initial ? 'routine.update' : 'routine.create', {
        id: initial?.id,
        title,
        instructions,
        execution,
        threadId: chat,
        schedule,
        notification,
        ...(skillId !== (initial?.skill?.id || '') || refreshSkill ? { skillId } : {}),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={initial ? 'Edit routine' : 'New routine'} onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        <Field label="Routine name">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={100}
            placeholder="My morning briefing"
            autoFocus
          />
        </Field>
        <Field label="Routine type">
          <select
            value={execution}
            onChange={(e) => {
              setExecution(e.target.value);
              if (e.target.value === 'reminder') setSkillId('');
              if (e.target.value === 'reminder' && kind === 'email') setKind('daily');
            }}
          >
            <option value="assistant">Ask my assistant to do something</option>
            <option value="reminder">Send me a reminder</option>
          </select>
        </Field>
        {execution === 'assistant' && (
          <>
            <Field
              label="Saved skill"
              hint="Optional. The routine keeps this version until you choose to update it."
            >
              <select
                value={skillId}
                onChange={(e) => {
                  setSkillId(e.target.value);
                  setRefreshSkill(false);
                }}
              >
                <option value="">Use the instructions below</option>
                {initial?.skill && !currentSkill && skillId === initial.skill.id && (
                  <option value={initial.skill.id}>
                    {initial.skill.title} · saved v{initial.skill.version}
                  </option>
                )}
                {availableSkills
                  .filter((x) => !x.archived)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title} · v
                      {initial?.skill?.id === x.id && !refreshSkill
                        ? initial?.skill?.version
                        : x.version}
                    </option>
                  ))}
              </select>
            </Field>
            {initial &&
              currentSkill &&
              initial.skill?.id === skillId &&
              currentSkill.version > initial.skill.version && (
                <button
                  type="button"
                  className="text-button skill-refresh"
                  onClick={() => setRefreshSkill(!refreshSkill)}
                >
                  {refreshSkill
                    ? `Keep saved version ${initial.skill.version}`
                    : `Use latest skill version ${currentSkill.version}`}
                </button>
              )}
          </>
        )}
        <Field
          label={skillId ? 'Details for this routine' : 'What should I do?'}
          hint="Include the sources to use, the result you want, and what to do if information is missing."
        >
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            required={!skillId}
            maxLength={6000}
            rows={4}
            placeholder="Review my calendar for today and the latest unread mail. Tell me what needs attention."
          />
        </Field>
        <Field label="Repeat">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekly">On selected days</option>
            <option value="interval">Every few minutes or hours</option>
            <option value="once">Just once</option>
            {execution === 'assistant' && (
              <option value="email">When a matching email arrives</option>
            )}
          </select>
        </Field>
        {kind === 'email' ? (
          <>
            <Field
              label="From this email address"
              hint="Optional when you provide a subject filter."
            >
              <input
                type="email"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                maxLength={254}
                placeholder="school@example.com"
              />
            </Field>
            <Field
              label="Subject contains"
              hint="Optional when you provide a sender. Otherwise use at least three characters."
            >
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="Field trip"
              />
            </Field>
            <p className="form-note">
              Requires a connected Google account. Checks new inbox arrivals about once a minute
              while your Relay server runs. Existing mail, sent mail, spam and trash do not trigger
              runs.
            </p>
          </>
        ) : kind === 'interval' ? (
          <Field label="Minutes between runs">
            <input
              type="number"
              min={5}
              max={525600}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              required
            />
          </Field>
        ) : (
          <>
            {kind === 'once' && (
              <Field label="Date">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </Field>
            )}
            <Field label="Time">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </Field>
          </>
        )}
        {kind === 'weekly' && (
          <fieldset className="routine-days">
            <legend>Days of the week</legend>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
              (day, i) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={days.includes(i)}
                    onChange={(e) =>
                      setDays(e.target.checked ? [...days, i] : days.filter((d) => d !== i))
                    }
                  />
                  {day}
                </label>
              ),
            )}
          </fieldset>
        )}
        {kind !== 'email' && (
          <Field
            label="Time zone"
            hint="Local times follow this zone’s clock changes. A skipped clock-change hour is skipped; a repeated hour runs once."
          >
            <input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              required
              placeholder="Asia/Shanghai"
            />
          </Field>
        )}
        <Field label="Post results in">
          <select value={chat} onChange={(e) => setChat(e.target.value)}>
            {s.threads
              .filter(
                (t) =>
                  !t.archived &&
                  threadAssistantId(s, t.id) ===
                    threadAssistantId(s, initial?.threadId || threadId),
              )
              .map((t) => (
                <option value={t.id} key={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </Field>
        {execution === 'reminder' ? (
          <p className="form-note">
            Each reminder is posted in chat as written. It does not need a model provider.
          </p>
        ) : (
          <Field label="When should I hear from you?">
            <select value={notification} onChange={(e) => setNotification(e.target.value)}>
              <option value="changed">When results change or something fails</option>
              <option value="all">After every run</option>
              <option value="errors">Only when something fails</option>
            </select>
          </Field>
        )}
        {preview && <p className="form-note">{preview}</p>}
        <p className="form-note">
          {initial
            ? 'Changes apply to future runs. A run already in progress uses its saved instructions.'
            : 'Saved paused, so you can test it before enabling.'}{' '}
          A test run does real work; external actions still require review.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save routine'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmailTest({ routine, onClose }: { routine: Entity; onClose: () => void }) {
  const { s } = useWorkspace();
  const matching = s.mail.filter((m) => matchesMail(routine.schedule, m));
  const [mailId, setMailId] = useState(matching[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mail = matching.find((m) => m.id === mailId);
  return (
    <Modal title="Test an email trigger" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.act('routine.test', { id: routine.id, mailId });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-note">{scheduleLabel(routine.schedule)}</p>
        {matching.length ? (
          <>
            <Field label="Matching inbox email">
              <select value={mailId} onChange={(e) => setMailId(e.target.value)}>
                {matching.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.subject} · {m.email}
                  </option>
                ))}
              </select>
            </Field>
            {mail && <p className="routine-email-preview">{mail.body.slice(0, 1200)}</p>}
          </>
        ) : (
          <p className="form-note">
            No synced inbox emails match yet. Sync your mail or edit the filter, then try again.
          </p>
        )}
        <p className="form-note">
          This runs the saved instructions with a copy of the selected email. External actions still
          require your review. Testing does not change whether the trigger is enabled.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !mail}>
            {busy ? 'Starting…' : 'Test with this email'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
