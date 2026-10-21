import { useEffect, useRef, useState } from 'react';
import { GraduationCap, Pause, Play, Stop, Camera, X, ArrowUpRight } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Field } from './ui';
import { tr } from '../i18n';
import './computer-teaching.css';

export default function ComputerTeaching({
  onChanged,
  onReview,
}: {
  onChanged: () => Promise<void>;
  onReview: (review: boolean) => void;
}) {
  const { s: workspace, threadId, selectThread, go } = useWorkspace();
  const routeValue = () =>
    /^#computer\/teaching\/([a-zA-Z0-9-]+)(?:\?|$)/.exec(location.hash)?.[1] || '';
  const routeId = () => (routeValue() === 'new' ? '' : routeValue());
  const [open, setOpen] = useState(() => !!routeValue()),
    [data, setData] = useState<any>({ sessions: [] }),
    [id, setId] = useState(routeId),
    [fresh, setFresh] = useState(() => routeValue() === 'new'),
    [goal, setGoal] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [frameId, setFrameId] = useState(''),
    [testInput, setTestInput] = useState('');
  const originThread = new URLSearchParams(location.hash.split('?')[1]).get('chat') || threadId;
  const current = id ? data.sessions.find((s: any) => s.id === id) : data.sessions[0];
  const recording = current?.status === 'recording',
    editing = ['review', 'draft', 'queued', 'generating', 'saved'].includes(current?.status),
    showSession = current && !fresh;
  const lock = useRef(false),
    recordingId = useRef(''),
    alive = useRef(true);
  recordingId.current = recording ? current.id : '';
  useEffect(() => {
    const navigate = () => {
      const next = routeId();
      if (routeValue()) {
        setId(next);
        setOpen(true);
        setFresh(routeValue() === 'new');
      }
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  async function refresh() {
    const next = await api.request('/teaching');
    if (alive.current) {
      setData(next);
      const active = next.sessions.find((s: any) => ['recording', 'paused'].includes(s.status));
      if (active && !routeId()) {
        setId(active.id);
        setFresh(false);
      }
    }
    return next;
  }
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const pause = () => {
      const id = recordingId.current;
      if (id)
        void api
          .request(`/teaching/${id}/pause`, { method: 'POST', body: '{}', keepalive: true })
          .catch(() => {});
    };
    const visibility = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', visibility);
    async function poll() {
      if (stopped) return;
      try {
        if (!document.hidden) {
          if (recordingId.current)
            await api.request(`/teaching/${recordingId.current}/heartbeat`, {
              method: 'POST',
              body: '{}',
            });
          await refresh();
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      pause();
    };
  }, []);
  useEffect(() => {
    onReview(!!(open && showSession && editing));
    return () => onReview(false);
  }, [open, showSession?.id, fresh, editing, onReview]);
  async function perform(action: string, payload: any = {}, target = current?.id) {
    if (lock.current) return;
    lock.current = true;
    setBusy(action);
    setError('');
    try {
      const result = await api.request(
        action === 'start' ? '/teaching/start' : `/teaching/${target}/${action}`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      if (action === 'discard') setId('');
      if (action === 'start') {
        setId(result.id);
        setFresh(false);
        history.replaceState(null, '', `#computer/teaching/${result.id}`);
      }
      // The test already owns a durable run. Return to its chat immediately;
      // taking another screenshot here can wait behind the agent's first actions.
      if (action === 'test') return result;
      await refresh();
      if (['start', 'pause', 'resume', 'finish'].includes(action)) await onChanged();
      return result;
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  const frame = current?.frames.find((f: any) => f.id === frameId) || current?.frames.at(-1);
  const close = () => {
    if (recording) void perform('pause');
    setOpen(false);
  };
  return (
    <section className="computer-teaching" aria-label="Teach a task">
      <div className="teaching-heading">
        <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <GraduationCap size={19} />
          {recording
            ? 'Recording your demonstration'
            : current?.status === 'draft'
              ? 'Your skill draft is ready'
              : 'Teach a task'}
        </button>
        {open && (
          <button className="icon-button" aria-label="Close teaching" onClick={close}>
            <X size={18} />
          </button>
        )}
      </div>
      {open && (
        <div className="teaching-body">
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {id && !current && (
            <p className="form-note">
              This recording is unavailable. A saved skill can still be used after its recording is
              discarded.
            </p>
          )}
          {!showSession ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await perform('start', { goal, threadId: originThread });
              }}
            >
              <Field label="What are you showing Relay?">
                <input
                  autoFocus
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  required
                  maxLength={500}
                  enterKeyHint="go"
                  placeholder="How I create a weekly report"
                />
              </Field>
              <button className="primary-button" disabled={!!busy || !goal.trim()}>
                <Play size={16} />
                {busy === 'start' ? 'Getting ready…' : 'Take control & record'}
              </button>
              <p className="form-note">
                Record this computer’s screen and interactions for up to 10 minutes or 30
                screenshots. No microphone audio. Pause before passwords or private steps. You
                review the screenshots before sharing them with your model.
              </p>
              {current && (
                <button type="button" className="text-button" onClick={() => setFresh(false)}>
                  Back to recording
                </button>
              )}
            </form>
          ) : (
            <>
              <div className="teaching-title">
                <strong>{current.goal}</strong>
                <span className={recording ? 'teaching-recording' : ''} role="status">
                  {recording
                    ? 'Recording'
                    : current.status === 'paused'
                      ? 'Paused'
                      : current.status === 'generating' || current.status === 'queued'
                        ? 'Creating a draft…'
                        : current.status === 'saved'
                          ? 'Skill saved'
                          : current.status === 'draft'
                            ? 'Draft ready'
                            : 'Ready to review'}{' '}
                  · {current.frames.length} screenshots
                </span>
              </div>
              <p className="form-note">
                {tr('For {chat}', {
                  chat:
                    workspace.threads.find((t) => t.id === (current.threadId || 'main'))?.title ||
                    tr('Main chat'),
                })}
              </p>
              {current.reason && <p className="form-note">{current.reason}</p>}
              {current.error && (
                <p className="inline-error" role="alert">
                  {current.error}
                </p>
              )}
              {['recording', 'paused'].includes(current.status) ? (
                <div className="teaching-controls">
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() => void perform(recording ? 'pause' : 'resume')}
                  >
                    {recording ? <Pause size={16} /> : <Play size={16} />}{' '}
                    {recording ? 'Pause recording' : 'Resume recording'}
                  </button>
                  {recording && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => void perform('capture')}
                    >
                      <Camera size={16} />
                      Capture this step
                    </button>
                  )}
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() => void perform('finish')}
                  >
                    <Stop size={16} />
                    Stop & review
                  </button>
                  <p className="form-note">
                    {recording
                      ? 'Only this virtual computer is recorded. Pause before private input.'
                      : 'New screens and interactions are not being added.'}
                  </p>
                </div>
              ) : (
                <>
                  {current.status !== 'saved' && (
                    <>
                      <p className="form-note">
                        Review the screenshots below. Remove anything private before creating a
                        draft. The remaining screenshots go to your selected model, which must
                        support images.
                      </p>
                      <div className="teaching-frames" aria-label="Recorded screenshots">
                        {current.frames.map((f: any, i: number) => (
                          <button
                            key={f.id}
                            className={frame?.id === f.id ? 'is-selected' : ''}
                            aria-label={`Inspect step ${i + 1}`}
                            aria-pressed={frame?.id === f.id}
                            onClick={() => setFrameId(f.id)}
                          >
                            <img
                              loading="lazy"
                              src={`/api/teaching/${current.id}/frames/${f.id}`}
                              alt=""
                            />
                            <span>
                              {i + 1} · {f.label}
                            </span>
                          </button>
                        ))}
                      </div>
                      {frame && (
                        <details className="teaching-inspect">
                          <summary>See selected screenshot · {frame.label}</summary>
                          <img
                            src={`/api/teaching/${current.id}/frames/${frame.id}`}
                            alt={`Recorded step: ${frame.label}`}
                          />
                        </details>
                      )}
                      {frame && ['review', 'draft'].includes(current.status) && (
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => void perform('removeFrame', { frameId: frame.id })}
                        >
                          Remove selected screenshot
                        </button>
                      )}
                    </>
                  )}
                  {current.status === 'review' && (
                    <div className="teaching-controls">
                      <button
                        className="primary-button"
                        disabled={!!busy || !current.frames.length || !data.modelConfigured}
                        onClick={() => void perform('generate', { version: current.version })}
                      >
                        Create skill draft
                      </button>
                      {!data.modelConfigured && (
                        <button className="text-button" onClick={() => go('settings', 'models')}>
                          Connect an image-capable model
                        </button>
                      )}
                    </div>
                  )}
                  {current.status === 'draft' && (
                    <TeachingEditor
                      key={current.id + ':' + current.epoch}
                      draft={current.draft}
                      busy={!!busy}
                      save={(values) => perform('save', { ...values, version: current.version })}
                    />
                  )}
                  {current.status === 'saved' && (
                    <div className="teaching-saved">
                      <p>The method is in Skills. Test it on an example before scheduling it.</p>
                      {current.testRunId ? (
                        <button
                          className="secondary-button"
                          onClick={() => selectThread(current.threadId || 'main')}
                        >
                          Open test conversation
                          <ArrowUpRight size={16} />
                        </button>
                      ) : (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const r = await perform('test', { input: testInput });
                            if (r) selectThread(r.threadId);
                          }}
                        >
                          <Field label="Example for the test">
                            <textarea
                              value={testInput}
                              onChange={(e) => setTestInput(e.target.value)}
                              rows={2}
                              maxLength={10000}
                              placeholder="Use a safe example and check the result."
                            />
                          </Field>
                          <p className="form-note">
                            Testing gives computer control back to Relay and performs real work.
                            External actions still need their normal review.
                          </p>
                          <button className="primary-button" disabled={!!busy}>
                            {busy === 'test' ? 'Starting…' : 'Give back & test skill'}
                          </button>
                        </form>
                      )}
                      <button className="text-button" onClick={() => go('skills')}>
                        Open Skills
                      </button>
                    </div>
                  )}
                </>
              )}
              {!['recording', 'paused', 'generating', 'queued'].includes(current.status) && (
                <div className="teaching-footer">
                  <button
                    className="text-button"
                    onClick={() => {
                      setFresh(true);
                      setGoal('');
                      history.replaceState(
                        null,
                        '',
                        `#computer/teaching/new?chat=${encodeURIComponent(current.threadId || 'main')}`,
                      );
                    }}
                  >
                    Teach another task
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => void perform('discard')}
                  >
                    Discard recording{current.status === 'saved' ? ' · keep skill' : ''}
                  </button>
                </div>
              )}
              {['recording', 'paused', 'generating', 'queued'].includes(current.status) && (
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void perform('discard')}
                >
                  Discard recording
                </button>
              )}
              {data.sessions.length > 1 && !recording && (
                <Field label="Saved recordings">
                  <select
                    value={current.id}
                    onChange={(e) => {
                      setId(e.target.value);
                      setFrameId('');
                      history.replaceState(null, '', `#computer/teaching/${e.target.value}`);
                    }}
                  >
                    {data.sessions.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.goal}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
function TeachingEditor({
  draft,
  busy,
  save,
}: {
  draft: any;
  busy: boolean;
  save: (values: any) => Promise<any>;
}) {
  const [values, setValues] = useState(draft);
  const field = (name: string) => (e: any) => setValues({ ...values, [name]: e.target.value });
  return (
    <form
      className="teaching-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save(values);
      }}
    >
      {!!draft.uncertainties.length && (
        <p className="form-note">Needs a check: {draft.uncertainties.join(' ')}</p>
      )}
      <div className="teaching-name">
        <Field label="Skill name">
          <input required maxLength={100} value={values.title} onChange={field('title')} />
        </Field>
        <Field label="Shortcut">
          <input
            required
            maxLength={40}
            value={values.slug}
            onChange={field('slug')}
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
      </div>
      <Field label="When to use it">
        <input maxLength={500} value={values.description} onChange={field('description')} />
      </Field>
      <Field label="Review the method">
        <textarea
          required
          rows={10}
          maxLength={12000}
          value={values.instructions}
          onChange={field('instructions')}
        />
      </Field>
      <button className="primary-button" disabled={busy}>
        {busy ? 'Saving…' : 'Save reviewed skill'}
      </button>
    </form>
  );
}
