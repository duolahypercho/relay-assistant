import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export type ListeningSetup = {
  supported: boolean;
  installed: boolean;
  bytes: number;
  name: string;
  details: string;
  modelDetails: string;
  installation: null | {
    id: string;
    phase: 'running' | 'ready' | 'cancelled' | 'interrupted' | 'error';
    stage: string;
    completed: number;
    total: number;
    error: string;
    speechRevision?: number;
    connected?: boolean;
  };
};

export default function LocalListeningSetup({
  initial,
  revision,
  active,
  disabled,
  onChanged,
  onSelect,
  speechRevision,
  chatConfigured = true,
}: {
  initial: ListeningSetup;
  revision: number;
  active: boolean;
  disabled: boolean;
  onChanged: () => Promise<void>;
  onSelect: () => void;
  speechRevision?: number;
  chatConfigured?: boolean;
}) {
  const combined = speechRevision !== undefined;
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(onChanged);
  current.current = onChanged;
  const previous = useRef(initial.installation?.phase);
  const mounted = useRef(true);
  useEffect(() => {
    setState(initial);
  }, [initial]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next: ListeningSetup = await api.request('/voice-connections/local', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState(next);
        const changed = previous.current !== next.installation?.phase;
        if (changed && next.installation?.phase !== 'running') await current.current();
        previous.current = next.installation?.phase;
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not check listening setup.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  async function act(action: 'start' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      const next = await api.request(`/voice-connections/local/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'start'
            ? { id: crypto.randomUUID(), revision, ...(combined ? { speechRevision } : {}) }
            : { id: state.installation?.id },
        ),
      });
      if (mounted.current) {
        setState(next);
        if (next.installation?.phase === 'ready') await current.current();
        previous.current = next.installation?.phase;
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Listening setup could not finish.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!state.supported) return null;
  const running = state.installation?.phase === 'running';
  const progress = state.installation;
  return (
    <div
      className="system-voice-choice local-listening-choice"
      aria-label={combined ? 'Local voice setup' : 'Local listening setup'}
    >
      <p>
        {combined
          ? active
            ? 'Voice is ready.'
            : 'Listen and speak with your Relay Mac.'
          : active
            ? 'Your speech is transcribed on your Relay computer.'
            : 'Listen on your Relay computer.'}
      </p>
      {combined && (
        <p className="form-note">
          {active
            ? chatConfigured
              ? 'Dictate a message or start a voice chat. Connected phones use the same Mac.'
              : 'Dictation is ready. Connect an AI model for voice chats.'
            : 'Uses local listening and the installed Mac voice. Your chat model stays the same.'}
        </p>
      )}
      {!state.installed && !running && (
        <p className="form-note">
          {Math.ceil(state.bytes / 1000000)} MB download · No account needed
        </p>
      )}
      {running ? (
        <>
          <p role="status">{progress?.stage}</p>
          <progress
            aria-label="Listening setup download"
            value={progress?.completed || 0}
            max={progress?.total || 1}
          />
          <p className="form-note">You can leave this page while setup continues.</p>
          <button className="text-button" disabled={busy} onClick={() => void act('cancel')}>
            {combined ? 'Cancel voice setup' : 'Cancel listening setup'}
          </button>
        </>
      ) : (
        !active && (
          <button
            className="primary-button"
            disabled={busy || disabled}
            onClick={() => (state.installed && !combined ? onSelect() : void act('start'))}
          >
            {busy
              ? 'Starting…'
              : combined
                ? state.installed
                  ? 'Use local voice'
                  : progress
                    ? 'Continue voice setup'
                    : 'Set up voice'
                : state.installed
                  ? 'Use local listening'
                  : progress
                    ? 'Continue listening setup'
                    : 'Set up local listening'}
          </button>
        )
      )}
      {(error || (!active && progress?.error)) && (
        <p className="inline-error" role="alert">
          {error || progress?.error}
        </p>
      )}
      <details>
        <summary>{combined ? 'About local voice' : 'About local listening'}</summary>
        <p className="form-note">
          Uses{' '}
          <a href={state.details} target="_blank" rel="noreferrer">
            whisper.cpp
          </a>{' '}
          and the{' '}
          <a href={state.modelDetails} target="_blank" rel="noreferrer">
            Whisper Base model
          </a>
          . Connected phones use the same Relay computer. Audio stays on that computer and is
          deleted after transcription. The first recording may take longer while the model warms up.
        </p>
      </details>
    </div>
  );
}
