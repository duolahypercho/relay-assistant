import { useState } from 'react';
import {
  Plus,
  Target,
  Check,
  Eye,
  Pause,
  Play,
  ArrowsClockwise,
  Trash,
  Globe,
  ChartLineUp,
  Archive,
  Flag,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { PageHeading, Modal, Field, Empty, Status, dateTime } from '../components/ui';
export default function Goals() {
  const { s, act } = useWorkspace();
  const [tab, setTab] = useState('goals');
  const [adding, setAdding] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [unit, setUnit] = useState('milestones');
  const [due, setDue] = useState('');
  const [goalId, setGoalId] = useState('');
  const [current, setCurrent] = useState('');
  const [milestone, setMilestone] = useState('');
  const [archived, setArchived] = useState(false);
  const [watchTitle, setWatchTitle] = useState('Studio workshop availability');
  const [url, setUrl] = useState('relay://workshop');
  const [kind, setKind] = useState('text');
  const [expected, setExpected] = useState('available now');
  const [threshold, setThreshold] = useState('70');
  const [interval, setInterval] = useState('60');
  const goals = s.goals.filter((g) => g.archived === archived);
  const goal = s.goals.find((g) => g.id === goalId);
  return (
    <section>
      <PageHeading
        title="A little closer, every day"
        description="Keep the big picture in view, and the next step within reach."
      >
        <button className="secondary-button" onClick={() => setTracking(true)}>
          <Eye size={18} />
          Track something
        </button>
        <button className="primary-button" onClick={() => setAdding(true)}>
          <Plus size={18} />
          New goal
        </button>
      </PageHeading>
      <div className="surface-toolbar">
        <div className="tabs">
          <button className={tab === 'goals' ? 'selected' : ''} onClick={() => setTab('goals')}>
            Your goals
          </button>
          <button
            className={tab === 'tracking' ? 'selected' : ''}
            onClick={() => setTab('tracking')}
          >
            Tracking <span className="count-label">{s.watches.length}</span>
          </button>
        </div>
        {tab === 'goals' && (
          <button className="text-button" onClick={() => setArchived(!archived)}>
            <Archive size={17} />
            {archived ? 'Show active goals' : 'Archived goals'}
          </button>
        )}
      </div>
      {tab === 'goals' ? (
        goals.length ? (
          <div className="goal-grid">
            {goals.map((g) => {
              const progress = g.target
                ? Math.min(100, (g.current / g.target) * 100)
                : g.milestones.length
                  ? (g.milestones.filter((m: any) => m.done).length / g.milestones.length) * 100
                  : 0;
              return (
                <article className="goal-card" key={g.id}>
                  <div className="goal-card-top">
                    <span className="goal-card-icon">
                      <Target size={25} />
                    </span>
                    <span className="goal-percent">{Math.round(progress)}%</span>
                  </div>
                  <h2>{g.title}</h2>
                  <p>{g.description}</p>
                  <div className="goal-progress-track">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <div className="goal-numbers">
                    <strong>
                      {g.unit === 'USD' ? '$' : ''}
                      {g.current.toLocaleString()} <span>{g.unit === 'USD' ? '' : g.unit}</span>
                    </strong>
                    <span>
                      of {g.unit === 'USD' ? '$' : ''}
                      {g.target.toLocaleString()}
                    </span>
                  </div>
                  <div className="milestone-list">
                    {g.milestones.slice(0, 4).map((m: any) => (
                      <button
                        className={m.done ? 'checked' : ''}
                        key={m.id}
                        onClick={() => void act('goal.update', { id: g.id, milestoneId: m.id })}
                        aria-pressed={m.done}
                      >
                        <span>{m.done && <Check size={12} weight="bold" />}</span>
                        {m.title}
                      </button>
                    ))}
                  </div>
                  <div className="goal-card-bottom">
                    <button
                      className="text-button"
                      onClick={() => {
                        setGoalId(g.id);
                        setCurrent(String(g.current));
                      }}
                    >
                      Update your progress
                    </button>
                    {g.due && (
                      <small>
                        <Flag size={13} />
                        {g.due}
                      </small>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={Target}
            title={archived ? 'No archived goals' : 'Choose something that matters'}
          >
            Start with a clear goal and a few small milestones.
          </Empty>
        )
      ) : (
        <div className="tracking-workspace">
          <div className="tracking-explanation">
            <Globe size={23} />
            <p>
              {api.mode() === 'server'
                ? 'Your server checks public pages on a schedule, even when this app is closed.'
                : 'Sample tracking runs while this app is open. Public pages and background checks need the self-hosted server.'}
            </p>
          </div>
          {s.watches.length ? (
            <div className="watch-list">
              {s.watches.map((w) => (
                <article className="watch-row" key={w.id}>
                  <div className="watch-title">
                    <Eye size={23} />
                    <div>
                      <h3>{w.title}</h3>
                      <span>{w.url === 'relay://workshop' ? 'Workshop test page' : w.url}</span>
                    </div>
                    <Status status={w.paused ? 'paused' : w.status} />
                  </div>
                  <p>
                    {w.kind === 'text'
                      ? `Watching for “${w.expected}”`
                      : w.kind === 'price'
                        ? `Watching for a price at or below $${w.threshold}`
                        : 'Watching for page text changes'}
                  </p>
                  {w.lastChecked && (
                    <small>
                      Last checked {dateTime(w.lastChecked)} · Every {w.intervalMinutes} min
                    </small>
                  )}
                  {w.error && <p className="inline-error">{w.error}</p>}
                  {w.lastValue !== '' && (
                    <div className="observation">
                      {typeof w.lastValue === 'number'
                        ? `Latest price: $${w.lastValue.toFixed(2)}`
                        : w.lastValue}
                    </div>
                  )}
                  <div className="watch-actions">
                    <button
                      className="secondary-button"
                      onClick={() => void act('watch.update', { id: w.id, paused: !w.paused })}
                    >
                      {w.paused ? <Play size={16} /> : <Pause size={16} />}{' '}
                      {w.paused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={w.paused}
                      onClick={() => void act('watch.update', { id: w.id, checkNow: true })}
                    >
                      <ArrowsClockwise size={16} />
                      Check now
                    </button>
                    <button
                      className="icon-button danger-text"
                      aria-label={`Remove ${w.title}`}
                      onClick={() => void act('watch.delete', { id: w.id })}
                    >
                      <Trash size={18} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty icon={Eye} title="Let a page come back to you">
              Track text changes, availability, or a USD price threshold.
            </Empty>
          )}
          <div className="fixture-panel">
            <div>
              <h3>Try the workshop test page</h3>
              <p>Change this sample page to test an availability alert.</p>
              <span className="fixture-value">{s.fixture.text}</span>
            </div>
            <button
              className="secondary-button"
              onClick={async () => {
                await act('fixture.update', {
                  available: !s.fixture.available,
                  price: s.fixture.price,
                });
                for (const w of s.watches.filter((w) => w.url === 'relay://workshop'))
                  await act('watch.update', { id: w.id, checkNow: true });
              }}
            >
              {s.fixture.available ? 'Mark as sold out' : 'Make tickets available'}
            </button>
          </div>
        </div>
      )}
      {adding && (
        <Modal title="Give your goal a place" onClose={() => setAdding(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const g = await act('goal.create', {
                title,
                description,
                target: Number(target || 0),
                unit,
                due,
                milestones: ['Choose the next small step'],
              });
              if (g) {
                setAdding(false);
                setTitle('');
                setDescription('');
                setTab('goals');
              }
            }}
          >
            <Field label="Your goal">
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={140}
                placeholder="What would you like to make room for?"
              />
            </Field>
            <Field label="Why it matters">
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
              />
            </Field>
            <div className="form-grid">
              <Field label="Target">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="For example, 6"
                />
              </Field>
              <Field label="Measured in">
                <input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  maxLength={30}
                  placeholder="books, hours, USD…"
                />
              </Field>
            </div>
            <Field label="Target date (optional)">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <button className="primary-button" type="submit">
              Create goal
            </button>
          </form>
        </Modal>
      )}
      {goal && (
        <Modal title={goal.title} onClose={() => setGoalId('')}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act('goal.update', { id: goal.id, current: Number(current) }))
                setGoalId('');
            }}
          >
            <Field label={`Progress so far (${goal.unit})`}>
              <input
                type="number"
                min="0"
                step="any"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </Field>
            <button type="submit" className="primary-button">
              Save progress
            </button>
          </form>
          <div className="divider" />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act('goal.update', { id: goal.id, addMilestone: milestone }))
                setMilestone('');
            }}
          >
            <Field label="Add a small step">
              <input
                value={milestone}
                onChange={(e) => setMilestone(e.target.value)}
                maxLength={180}
                required
              />
            </Field>
            <button className="secondary-button" type="submit">
              <Plus size={17} />
              Add milestone
            </button>
          </form>
          <div className="modal-footer">
            <button
              className="text-button"
              onClick={async () => {
                await act('goal.update', { id: goal.id, archived: !goal.archived });
                setGoalId('');
              }}
            >
              <Archive size={17} />
              {goal.archived ? 'Restore goal' : 'Archive goal'}
            </button>
          </div>
        </Modal>
      )}
      {tracking && (
        <Modal title="Keep an eye on something" onClose={() => setTracking(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const w = await act('watch.create', {
                title: watchTitle,
                url,
                kind,
                expected,
                threshold: Number(threshold),
                intervalMinutes: Number(interval),
              });
              if (w) {
                setTracking(false);
                setTab('tracking');
              }
            }}
          >
            <Field label="Tracker name">
              <input
                value={watchTitle}
                onChange={(e) => setWatchTitle(e.target.value)}
                maxLength={140}
                required
              />
            </Field>
            <Field label="Page address" hint="Use relay://workshop for the built-in test page.">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://example.com/workshop"
              />
            </Field>
            <Field label="What should I look for?">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="text">Specific text or availability</option>
                <option value="change">A change in page text</option>
                <option value="price">A USD price threshold</option>
              </select>
            </Field>
            {kind === 'text' && (
              <Field label="Text to look for">
                <input
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  required
                  maxLength={300}
                />
              </Field>
            )}
            {kind === 'price' && (
              <Field label="Notify at or below (USD)">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  required
                />
              </Field>
            )}
            <Field label="Check every (minutes)">
              <input
                type="number"
                min="1"
                max="10080"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                required
              />
            </Field>
            <button className="primary-button" type="submit">
              Start tracking
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
