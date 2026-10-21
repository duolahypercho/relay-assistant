import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, Pause, SpeakerHigh, X } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import './voice-memo.css';
import FileDownload from './FileDownload';
const clock = (value: number) =>
  Number.isFinite(value)
    ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
    : '0:00';
export default function VoiceMemo({
  card,
  messageId,
  compact = false,
}: {
  card: { id: string; transcript: string };
  messageId?: string;
  compact?: boolean;
}) {
  const { focusMessageId, page } = useWorkspace();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const url = `/api/voice-memos/${encodeURIComponent(card.id)}/audio`;
  useEffect(() => {
    const el = audio.current!;
    const stopOther = (event: Event) => {
      if (event.target !== el && event.target instanceof HTMLMediaElement) el.pause();
    };
    const background = () => {
      if (document.visibilityState === 'hidden') el.pause();
    };
    document.addEventListener('play', stopOther, true);
    document.addEventListener('visibilitychange', background);
    return () => {
      el.pause();
      document.removeEventListener('play', stopOther, true);
      document.removeEventListener('visibilitychange', background);
    };
  }, []);
  useLayoutEffect(() => {
    const el = audio.current;
    if (page !== 'chat') el?.pause();
    // Suspense can hide chat before the destination page commits. Layout
    // cleanup also runs in that case, so hidden recordings stop immediately.
    return () => el?.pause();
  }, [page]);
  async function toggle() {
    const el = audio.current!;
    if (!el.paused) {
      el.pause();
      return;
    }
    setError('');
    try {
      await el.play();
    } catch {
      setError('This recording could not play. Check your connection, then reload the audio.');
    }
  }
  return (
    <div
      className={`voice-memo${compact ? ' voice-memo-inline' : ''}`}
      role="group"
      aria-label="Voice memo"
    >
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setElapsed(audio.current?.currentTime || 0)}
        onDurationChange={() => setDuration(audio.current?.duration || 0)}
        onError={() =>
          setError(
            compact
              ? 'This recording is unavailable. The reply is still saved above.'
              : 'This recording is unavailable. Its transcript is still saved below.',
          )
        }
      />
      {!compact && (
        <div className="voice-memo-heading">
          <strong>Voice memo</strong>
          <small>AI-generated voice</small>
        </div>
      )}
      <div className="voice-memo-controls">
        <button
          className="voice-memo-play"
          aria-label={playing ? 'Pause voice memo' : 'Play voice memo'}
          onClick={() => void toggle()}
        >
          {playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}
        </button>
        {compact && <small className="voice-memo-label">AI voice</small>}
        <input
          aria-label="Voice memo position"
          type="range"
          min="0"
          max={Number.isFinite(duration) && duration > 0 ? duration : 1}
          step="0.1"
          value={Math.min(elapsed, Number.isFinite(duration) && duration > 0 ? duration : 1)}
          disabled={!Number.isFinite(duration) || duration <= 0}
          onChange={(e) => {
            if (audio.current) audio.current.currentTime = Number(e.target.value);
            setElapsed(Number(e.target.value));
          }}
        />
        <span className="voice-memo-time">
          {clock(elapsed)} / {clock(duration)}
        </span>
        <FileDownload
          className="icon-button"
          href={`${url}?download=1`}
          name="relay-voice.wav"
          mime="audio/wav"
          label="Download voice memo"
        >
          {null}
        </FileDownload>
      </div>
      {error && (
        <div className="voice-memo-error">
          <p role="alert">{error}</p>
          <button
            className="text-button"
            onClick={() => {
              setError('');
              audio.current?.load();
            }}
          >
            Reload audio
          </button>
        </div>
      )}
      {!compact && (
        <details open={messageId && focusMessageId === messageId ? true : undefined}>
          <summary>Transcript</summary>
          <p>{card.transcript}</p>
        </details>
      )}
    </div>
  );
}
export function VoiceMemoAction({ messageId }: { messageId: string }) {
  const { s } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const config = s.connections.runtime?.speech;
  if (api.mode() !== 'server' || !config?.configured) return null;
  async function create() {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError('');
    try {
      await api.request(`/messages/${encodeURIComponent(messageId)}/voice`, {
        method: 'POST',
        signal: AbortSignal.any([pending.signal, AbortSignal.timeout(70000)]),
      });
      if (alive.current && !pending.signal.aborted) await api.refresh();
    } catch (cause) {
      if (alive.current && !pending.signal.aborted)
        setError(
          cause instanceof Error && cause.name !== 'TypeError' && cause.name !== 'TimeoutError'
            ? cause.message
            : 'Voice creation was interrupted. Try again.',
        );
    } finally {
      if (controller.current === pending) {
        controller.current = null;
        if (alive.current) setBusy(false);
      }
    }
  }
  return (
    <span className="voice-memo-action">
      {busy ? (
        <>
          <span role="status">Creating voice…</span>
          <button
            className="icon-button"
            aria-label="Cancel voice creation"
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setBusy(false);
            }}
          >
            <X size={15} />
          </button>
        </>
      ) : (
        <button
          className="icon-button"
          aria-label="Create voice memo"
          title={`Create voice memo · sends this reply to ${config.destination}`}
          onClick={() => void create()}
        >
          <SpeakerHigh size={16} />
        </button>
      )}
      {error && (
        <span className="voice-memo-action-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
