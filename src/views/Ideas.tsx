import { useState } from 'react';
import { Lightbulb, ArrowUpRight, ArrowClockwise, X } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { deriveIdeas } from '../../shared/seed.mjs';
import { visibleIdeas } from '../../shared/ideas.mjs';
import { api } from '../api';
import { PageHeading, Field, Empty, dateTime } from '../components/ui';
import './ideas.css';

export default function Ideas() {
  const { s, act, go, openTask, openMemories, selectThread } = useWorkspace();
  const connected = api.mode() === 'server' && s.connections.model?.configured;
  const sample =
    !connected && (api.mode() === 'sample' || s.connections.runtime?.mode === 'sample');
  const ideas = sample ? deriveIdeas(s) : visibleIdeas(s);
  const state = s.ideas;
  const [choice, setChoice] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const checking = connected && ['queued', 'running'].includes(state?.status);
  async function refresh() {
    setBusy('refresh');
    setError('');
    try {
      await api.request('/ideas/refresh', { method: 'POST' });
      await api.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  function source(source: any) {
    if (source.type === 'message') {
      const message = s.messages.find((m) => m.id === source.id);
      if (message) selectThread(message.threadId, message.id);
    } else if (source.type === 'task') openTask(source.id);
    else if (source.type === 'memory') openMemories();
    else go(source.type === 'goal' ? 'goals' : source.type === 'event' ? 'calendar' : 'inbox');
  }
  return (
    <section className="personal-ideas" aria-label="Personal ideas">
      <PageHeading
        eyebrow="A LITTLE HELP LOOKING AHEAD"
        title="Ideas for you"
        description={
          sample
            ? 'Sample ideas to try in this workspace.'
            : 'Small next steps from your goals and conversations. You choose what happens next.'
        }
      >
        {connected && (
          <button
            className="secondary-button"
            disabled={!!busy || checking}
            onClick={() => void refresh()}
          >
            <ArrowClockwise size={18} />
            {checking ? 'Checking…' : 'Check for ideas'}
          </button>
        )}
      </PageHeading>
      <div className="idea-check-status" role="status">
        {checking
          ? 'Looking for something useful in your current context…'
          : state?.checkedAt
            ? `Last checked ${dateTime(state.checkedAt)}${state.reason === 'unchanged' ? ' · no context changes' : ''}`
            : ''}
      </div>
      {(error || state?.error) && (
        <p role="alert" className="form-error">
          {error || state.error}
        </p>
      )}
      {!connected && !sample && (
        <Empty
          icon={Lightbulb}
          title="Connect your assistant first"
          action={
            <button className="secondary-button" onClick={() => go('settings', 'models')}>
              Choose a model
            </button>
          }
        >
          Connect a chat model in Settings, then Relay can look for useful next steps.
        </Empty>
      )}
      {ideas.length ? (
        <div className="personal-idea-list">
          {ideas.map((idea: any) => (
            <article className="personal-idea" aria-label={idea.title} key={idea.id}>
              <div className="personal-idea-top">
                <Lightbulb size={23} />
                <h2>{idea.title}</h2>
                <button
                  className="icon-button"
                  disabled={!!busy}
                  aria-label={`Dismiss ${idea.title}`}
                  onClick={() => void act('idea.dismiss', { id: idea.id })}
                >
                  <X size={18} />
                </button>
              </div>
              <p>{idea.description}</p>
              {!sample && <p className="idea-timing">{idea.whyNow}</p>}
              {sample ? (
                <p className="idea-timing">From {idea.source}</p>
              ) : (
                <details className="idea-evidence">
                  <summary>
                    Based on{' '}
                    {idea.sources.length === 1
                      ? idea.sources[0].title
                      : `${idea.sources.length} sources`}
                  </summary>
                  <ul>
                    {idea.sources.map((citation: any) => (
                      <li key={citation.ref}>
                        <button className="text-button" onClick={() => source(citation)}>
                          {citation.title}
                          <ArrowUpRight size={15} />
                        </button>
                        <blockquote>{citation.quote}</blockquote>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {choice === idea.id ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy) return;
                    setBusy(idea.id);
                    try {
                      if (sample) {
                        if (idea.kind === 'calendar') {
                          go('calendar');
                          return;
                        }
                        const task = await act('task.create', {
                          title: idea.title,
                          description,
                          kind: idea.kind,
                          sourceId: idea.sourceId,
                          fileId: s.mail
                            .find((m) => m.id === idea.sourceId)
                            ?.attachmentIds?.find(
                              (id: string) =>
                                s.files.find((f) => f.id === id)?.mime === 'application/pdf',
                            ),
                        });
                        if (task) openTask(task.id);
                      } else {
                        const result = await act('idea.accept', { id: idea.id, text: description });
                        if (result) selectThread(result.threadId);
                      }
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  <Field label="What would you like Relay to do?">
                    <textarea
                      autoFocus
                      rows={3}
                      maxLength={4000}
                      required
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </Field>
                  <div className="idea-actions">
                    <button className="primary-button" disabled={!!busy || !description.trim()}>
                      {sample
                        ? idea.kind === 'calendar'
                          ? 'Open calendar'
                          : 'Try this task'
                        : 'Send to Main chat'}
                      <ArrowUpRight size={17} />
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => setChoice('')}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  className="text-button idea-start"
                  onClick={() => {
                    setChoice(idea.id);
                    setDescription(sample ? idea.description : idea.prompt);
                  }}
                >
                  Make a little progress
                  <ArrowUpRight size={17} />
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        (connected || sample) &&
        !checking && (
          <Empty
            icon={Lightbulb}
            title={
              state?.checkedAt || sample
                ? 'A little breathing room'
                : 'Something useful, when it comes along'
            }
          >
            {state?.checkedAt || sample
              ? 'Nothing new needs your attention. Check again when your plans change.'
              : 'Ask Relay to look for connections in your goals, inbox, calendar, saved preferences and recent messages.'}
          </Empty>
        )
      )}
      {connected && (
        <div className="idea-preferences">
          <Field label="Background suggestions">
            <select
              value={state?.mode || 'off'}
              disabled={!!busy}
              onChange={async (e) => {
                setBusy('mode');
                await act('idea.settings', { mode: e.target.value });
                setBusy('');
              }}
            >
              <option value="off">Off · check when I ask</option>
              <option value="quiet">Quiet · urgent updates only</option>
              <option value="regular">Regular · important updates too</option>
            </select>
          </Field>
          <p>
            {state?.mode === 'quiet'
              ? 'Checks every 6 hours. At most one urgent nudge a day in Main chat.'
              : state?.mode === 'regular'
                ? 'Checks hourly. At most one important nudge every 6 hours in Main chat.'
                : 'Relay checks only when you ask. Results stay on this page.'}{' '}
            Enabled checks use your selected model while the server is running.
          </p>
        </div>
      )}
      {!!state?.dismissed?.length && (
        <details className="idea-hidden">
          <summary>Dismissed ideas ({state.dismissed.length})</summary>
          <p>Restoring makes an idea eligible for a future check.</p>
          {state.dismissed.map((idea: any) => (
            <div key={idea.id}>
              <span>{idea.title}</span>
              <button
                className="text-button"
                onClick={() => void act('idea.restore', { id: idea.id })}
                aria-label={`Restore ${idea.title}`}
              >
                Restore
              </button>
            </div>
          ))}
        </details>
      )}
      {!!ideas.length && (
        <p className="ideas-explanation">
          {sample
            ? 'These examples use sample context. Connect a model in Settings for personal suggestions.'
            : 'Suggestions disappear when their sources change. Starting one sends your edited request to Main chat; your existing draft stays saved.'}
        </p>
      )}
    </section>
  );
}
