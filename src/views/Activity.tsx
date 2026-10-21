import { useEffect, useState } from 'react';
import './apps.css';
import {
  Stack,
  CheckCircle,
  Clock,
  Pause,
  Play,
  X,
  ArrowsClockwise,
  FileText,
  Envelope,
  ShieldCheck,
  Terminal,
  CalendarBlank,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { PageHeading, Modal, Field, Status, dateTime } from '../components/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileDialog } from './Files';
import PromptReviewEditor from '../components/PromptReviewEditor';
export function Review({ id }: { id: string }) {
  const { s, act } = useWorkspace();
  const [attachment, setAttachment] = useState<any>(null);
  const a = s.approvals.find((a) => a.id === id);
  useEffect(() => {
    if (!a || a.status === 'pending') return;
    try {
      localStorage.removeItem(`relay-prompt-review:${id}`);
    } catch {}
  }, [id, a?.status]);
  if (!a) return null;
  const p = a.payload;
  const editablePrompt =
    a.kind === 'connector' && p.contentKind === 'prompt' && a.status === 'pending';
  const live = a.connectionGeneration !== null;
  return (
    <div className="approval-detail">
      <div className="review-heading">
        <ShieldCheck size={25} />
        <div>
          <h2>{a.kind === 'connector' && p.contentKind ? p.toolTitle : a.title}</h2>
          <span>
            {a.kind === 'connector'
              ? p.name
              : a.kind === 'terminal'
                ? 'Isolated workspace'
                : live
                  ? a.accountEmail
                  : 'Sample workspace'}
          </span>
        </div>
        <Status status={a.status} />
      </div>
      {a.kind === 'connector' ? (
        <>
          {editablePrompt && <PromptReviewEditor key={id} approval={a} />}
          {!editablePrompt && ['pending', 'approved', 'executing'].includes(a.status) && (
            <div className="connector-values" role="group" aria-label="Exact app arguments">
              {Object.entries(p.arguments).map(([key, value]) => (
                <div key={key}>
                  <span>{key.replace(/[_-]/g, ' ')}</span>
                  {value !== null && typeof value === 'object' ? (
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  ) : (
                    <p>{value === null ? 'null' : String(value)}</p>
                  )}
                </div>
              ))}
              {Object.keys(p.arguments).length === 0 && <p>No extra information will be sent.</p>}
            </div>
          )}
          {!editablePrompt && (
            <details className="connector-action-details">
              <summary>Action details</summary>
              <dl className="review-fields">
                <dt>Address</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>{p.endpoint}</dd>
                <dt>Tool</dt>
                <dd>
                  <code>{p.toolName}</code>
                </dd>
              </dl>
              <pre className="connector-arguments" aria-label="Raw app arguments">
                {JSON.stringify(p.arguments, null, 2)}
              </pre>
            </details>
          )}
          {a.connectorResult && (
            <div className="connector-review-result">
              <details>
                <summary>View app result</summary>
                <pre className="connector-output">{JSON.stringify(a.connectorResult, null, 2)}</pre>
              </details>
              {(a.connectorResult.fileIds || []).map((id: string) => {
                const file = s.files.find((f) => f.id === id);
                return file ? (
                  <button
                    className="attachment-button"
                    key={id}
                    onClick={() => setAttachment(file)}
                  >
                    <FileText size={18} />
                    {file.name}
                  </button>
                ) : null;
              })}
            </div>
          )}
        </>
      ) : a.kind === 'email' ? (
        <>
          <dl className="review-fields">
            <dt>To</dt>
            <dd>{p.to}</dd>
            <dt>Subject</dt>
            <dd>{p.subject}</dd>
          </dl>
          <div className="review-body">{p.body}</div>
          {(a.attachments || []).map((f: any) => (
            <button
              className="attachment-button"
              key={f.id}
              onClick={() =>
                setAttachment({ ...f, source: 'Reviewed attachment', createdAt: a.createdAt })
              }
            >
              <FileText size={18} />
              {f.name}
            </button>
          ))}
        </>
      ) : a.kind === 'calendar' ? (
        <>
          <dl className="review-fields">
            <dt>Action</dt>
            <dd>{p.operation}</dd>
            <dt>Event</dt>
            <dd>{p.event.title}</dd>
            <dt>Start</dt>
            <dd>{dateTime(p.event.start, p.event.allDay)}</dd>
            <dt>End</dt>
            <dd>
              {dateTime(p.event.end, p.event.allDay)}
              {p.event.allDay ? ' (exclusive)' : ''}
            </dd>
            <dt>Location</dt>
            <dd>{p.event.location || 'Not specified'}</dd>
          </dl>
          {p.event.description && <div className="review-body">{p.event.description}</div>}
        </>
      ) : (
        <pre className="terminal-code">{p.command}</pre>
      )}
      {a.status === 'pending' && !editablePrompt && (
        <>
          <p className="review-note">
            {a.kind === 'connector'
              ? p.contentKind === 'prompt'
                ? 'Use this template with the details above. Any actions it proposes will follow your existing app permissions.'
                : p.contentKind
                  ? 'Read this document from the connected app using the details above.'
                  : 'Only this tool and these exact arguments will be sent to the connected app. Review any recipients, content and amounts before approving.'
              : a.kind === 'terminal'
                ? 'This command runs inside your isolated workspace.'
                : live
                  ? 'This action uses your connected Google account.'
                  : 'This changes the sample workspace on this device.'}
          </p>
          <div className="review-actions">
            <button
              className="secondary-button"
              onClick={() => void act('approval.decide', { id, decision: 'reject' })}
            >
              Decline
            </button>
            <button
              className="primary-button"
              onClick={() => void act('approval.decide', { id, decision: 'approve' })}
            >
              {a.kind === 'connector'
                ? p.contentKind === 'prompt'
                  ? 'Use template'
                  : p.contentKind
                    ? 'Read document'
                    : 'Approve app action'
                : a.kind === 'email'
                  ? live
                    ? 'Approve and send'
                    : 'Approve sample reply'
                  : a.kind === 'calendar'
                    ? 'Approve calendar change'
                    : 'Approve command'}
            </button>
          </div>
        </>
      )}
      {a.error && (
        <p className="inline-error" role="alert">
          {a.error}
        </p>
      )}
      {attachment && (
        <FileDialog id={attachment.id} snapshot={attachment} onClose={() => setAttachment(null)} />
      )}
    </div>
  );
}
export function TaskContent({ id }: { id: string }) {
  const { s, act, openFile } = useWorkspace();
  const t = s.tasks.find((t) => t.id === id);
  const [values, setValues] = useState<Record<string, string>>({});
  if (!t) return null;
  return (
    <div className="inline-task-detail">
      <div className="task-detail-meta">
        <Status status={t.status} />
      </div>
      <details className="task-history">
        <summary>View steps and details</summary>
        <p className="task-description">{t.description}</p>
        <small className="muted">Created {dateTime(t.createdAt)}</small>
        <ol className="plan-list">
          {t.plan.map((step: string, i: number) => (
            <li key={i} className={i < t.step ? 'done' : i === t.step ? 'current' : ''}>
              <span className="plan-number">
                {i < t.step ? <CheckCircle size={19} weight="fill" /> : i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </details>
      {t.status === 'needs_input' && (
        <form
          className="input-request"
          onSubmit={async (e) => {
            e.preventDefault();
            await act('task.input', { id, values });
          }}
        >
          <h3>{t.input.title}</h3>
          <p>Use the details you want in the document.</p>
          {t.input.fields.map((f: any) => (
            <Field key={f.name} label={f.label || f.name}>
              {f.type === 'PDFCheckBox' ? (
                <select
                  required={f.required}
                  value={values[f.name] || ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  <option value="">Choose…</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              ) : Array.isArray(f.options) && f.options.length ? (
                <select
                  required={f.required}
                  value={values[f.name] || ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {f.options.map((option: string) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  required={f.required}
                  maxLength={500}
                  value={values[f.name] || ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </Field>
          ))}
          <button className="primary-button" type="submit">
            Continue with these details
          </button>
        </form>
      )}
      {t.filledFileId && (
        <button className="file-result-button" onClick={() => openFile(t.filledFileId)}>
          <FileText size={22} />
          <span>Open the filled PDF</span>
        </button>
      )}
      {t.approvalId && <Review id={t.approvalId} />}
      {t.error && (
        <p className="inline-error" role="alert">
          {t.error}
        </p>
      )}
      {t.status === 'completed' && (
        <div className="task-result">
          <div className="section-line">
            <h3>Your saved result</h3>
            {t.resultFileId && (
              <button className="secondary-button" onClick={() => openFile(t.resultFileId)}>
                <FileText size={17} />
                Open file
              </button>
            )}
          </div>
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ alt }) => <span>Image: {alt}</span>,
                a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              }}
            >
              {t.result || 'The reviewed action is complete.'}
            </ReactMarkdown>
          </div>
        </div>
      )}
      {t.status !== 'completed' && (
        <div className="modal-footer">
          <div>
            {['queued', 'running'].includes(t.status) && (
              <button
                className="secondary-button"
                onClick={() => void act('task.action', { id, action: 'pause' })}
              >
                <Pause size={17} />
                Pause task
              </button>
            )}
            {t.status === 'paused' && (
              <button
                className="primary-button"
                onClick={() => void act('task.action', { id, action: 'resume' })}
              >
                <Play size={17} />
                Resume task
              </button>
            )}
            {['failed', 'cancelled'].includes(t.status) && (
              <button
                className="primary-button"
                onClick={() => void act('task.action', { id, action: 'retry' })}
              >
                <ArrowsClockwise size={17} />
                Retry task
              </button>
            )}
          </div>
          {!['completed', 'cancelled', 'failed'].includes(t.status) && (
            <button
              className="text-button danger-text"
              onClick={() => void act('task.action', { id, action: 'cancel' })}
            >
              <X size={17} />
              Cancel task
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export function TaskDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { s } = useWorkspace();
  const task = s.tasks.find((t) => t.id === id);
  return task ? (
    <Modal title={task.title} onClose={onClose} wide>
      <TaskContent id={id} />
    </Modal>
  ) : null;
}
export default function Activity() {
  const { s, act, openTask, threadId } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState('general');
  const [review, setReview] = useState('');
  const pending = s.approvals.filter((a) =>
    ['pending', 'approved', 'executing'].includes(a.status),
  );
  const tasks = s.tasks.filter(
    (t) =>
      filter === 'all' ||
      (filter === 'active' && !['completed', 'cancelled', 'failed'].includes(t.status)) ||
      (filter === 'completed' && t.status === 'completed'),
  );
  return (
    <section>
      <PageHeading
        title="Work, in the open"
        description="Tell me the outcome. I’ll keep the steps and results here."
      />
      <form
        className="inline-task-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (starting) return;
          setStarting(true);
          const t = await act('task.create', { title, description, kind, threadId });
          setStarting(false);
          if (t) {
            setTitle('');
            setDescription('');
            openTask(t.id);
          }
        }}
      >
        <div className="task-start-row">
          <Field label="What needs to get done?">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Plan a quiet afternoon…"
              maxLength={180}
            />
          </Field>
          <button className="primary-button" type="submit" disabled={starting || !title.trim()}>
            {starting ? 'Starting…' : 'Start task'}
          </button>
        </div>
        <details>
          <summary>Add context or choose the kind of work</summary>
          <Field label="A little context">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What would a good result look like?"
              maxLength={4000}
            />
          </Field>
          <Field label="Kind of work">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="general">Plan or write</option>
              <option value="research">Research public sources</option>
              <option value="document">Fill a PDF form</option>
              <option value="finance">Review imported spending</option>
            </select>
          </Field>
        </details>
      </form>
      {pending.length > 0 && (
        <div className="review-list">
          <div className="section-line">
            <h2>Waiting for your decision</h2>
            <span>
              {pending.length} action{pending.length === 1 ? '' : 's'}
            </span>
          </div>
          {pending.map((a) => (
            <div key={a.id}>
              <button
                className="review-entry"
                aria-expanded={review === a.id}
                onClick={() => setReview(review === a.id ? '' : a.id)}
              >
                <span className="review-entry-icon">
                  {a.kind === 'connector' ? (
                    <Stack size={24} />
                  ) : a.kind === 'email' ? (
                    <Envelope size={24} />
                  ) : a.kind === 'calendar' ? (
                    <CalendarBlank size={24} />
                  ) : (
                    <Terminal size={24} />
                  )}
                </span>
                <div>
                  <strong>{a.title}</strong>
                  <span>
                    {a.kind === 'connector'
                      ? `${a.payload.name} · ${a.payload.toolTitle}`
                      : a.kind === 'email'
                        ? `To ${a.payload.to}`
                        : a.kind === 'calendar'
                          ? dateTime(a.payload.event.start)
                          : a.payload.command}
                  </span>
                </div>
                <Status status={a.status} />
              </button>
              {review === a.id && <Review id={a.id} />}
            </div>
          ))}
        </div>
      )}
      {s.tasks.length > 0 && (
        <div className="surface-toolbar">
          <div className="tabs" aria-label="Filter tasks">
            {[
              ['all', 'All work'],
              ['active', 'In progress'],
              ['completed', 'Completed'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'selected' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="muted">
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      {tasks.length ? (
        <div className="task-list">
          {tasks.map((t) => (
            <button className="task-row" key={t.id} onClick={() => openTask(t.id)}>
              <span className={`task-icon ${t.status === 'completed' ? 'complete' : ''}`}>
                {t.status === 'completed' ? <CheckCircle size={24} /> : <Stack size={24} />}
              </span>
              <div>
                <strong>{t.title}</strong>
                <span>
                  {t.status === 'needs_input'
                    ? 'A few details are needed to continue.'
                    : t.status === 'needs_approval'
                      ? 'An action is ready for your review.'
                      : t.plan[Math.min(t.step, t.plan.length - 1)] || t.description}
                </span>
                <small>{dateTime(t.createdAt)}</small>
              </div>
              <Status status={t.status} />
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">
          {s.tasks.length
            ? 'No tasks in this view.'
            : 'Your tasks and their results will appear here.'}
        </p>
      )}
      {s.receipts.length > 0 && (
        <div className="receipts-section">
          <h2>Saved receipts</h2>
          {s.receipts.slice(0, 12).map((r) => (
            <div className="receipt-row" key={r.id}>
              <CheckCircle size={19} />
              <div>
                <strong>{r.title}</strong>
                <span>{r.detail}</span>
              </div>
              <small>{dateTime(r.createdAt)}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
