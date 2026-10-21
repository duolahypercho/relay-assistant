import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SpeakerHigh, SpeakerSlash, ArrowClockwise } from '@phosphor-icons/react';
import { fileBytes } from '../../shared/pdf.mjs';
import { mediaKind, mediaMime } from '../../shared/media-files.mjs';
import type { Entity } from '../types';
import { useWorkspace } from '../context';
import './media-preview.css';
const clock = (value: number) =>
  Number.isFinite(value)
    ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
    : '0:00';
export default function MediaPreview({ file }: { file: Entity }) {
  const { page } = useWorkspace();
  const el = useRef<HTMLMediaElement | null>(null);
  const generation = useRef(0);
  const [source, setSource] = useState(''),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [duration, setDuration] = useState(0),
    [muted, setMuted] = useState(false),
    [retry, setRetry] = useState(0);
  const kind = mediaKind(file),
    mime = mediaMime(file),
    video = kind === 'video';
  useEffect(() => {
    generation.current++;
    let alive = true,
      object = '';
    const player = el.current;
    setSource('');
    setError('');
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    if (!player?.canPlayType(mime)) {
      setError('This format cannot play on this device. Open the file to save the original.');
      return;
    }
    void fileBytes(file)
      .then((bytes) => {
        if (!alive) return;
        if (!bytes.length) throw Error('empty');
        object = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        setSource(object);
      })
      .catch(() => {
        if (alive)
          setError('This recording could not be opened. The original file is still available.');
      });
    const stopOther = (event: Event) => {
      if (event.target !== player && event.target instanceof HTMLMediaElement) player.pause();
    };
    const background = () => {
      if (document.visibilityState === 'hidden') player.pause();
    };
    const preview = () => player.pause();
    document.addEventListener('play', stopOther, true);
    document.addEventListener('visibilitychange', background);
    document.addEventListener('relay:preview-file', preview);
    return () => {
      alive = false;
      generation.current++;
      player.pause();
      player.removeAttribute('src');
      player.load();
      if (object) URL.revokeObjectURL(object);
      document.removeEventListener('play', stopOther, true);
      document.removeEventListener('visibilitychange', background);
      document.removeEventListener('relay:preview-file', preview);
    };
  }, [file.id, file.updatedAt, file.base64, mime, retry]);
  useEffect(() => {
    generation.current++;
    el.current?.pause();
  }, [page]);
  async function toggle() {
    const player = el.current;
    const ticket = generation.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    try {
      await player.play();
      if (generation.current !== ticket) player.pause();
    } catch {
      if (generation.current === ticket)
        setError('Playback could not start. Try again, or open the file to save it.');
    }
  }
  const props = {
    src: source || undefined,
    preload: 'metadata',
    onLoadedMetadata: () => {
      setDuration(el.current?.duration || 0);
      setReady(true);
    },
    onDurationChange: () => setDuration(el.current?.duration || 0),
    onTimeUpdate: () => setTime(el.current?.currentTime || 0),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onError: () => {
      if (source)
        setError(
          'This recording cannot play on this device. The original file is still available.',
        );
    },
  };
  return (
    <div
      className={`media-preview ${video ? 'media-video' : 'media-audio'}`}
      role="group"
      aria-label={`${video ? 'Video' : 'Audio'} preview: ${file.name}`}
    >
      {video ? (
        <video
          {...props}
          ref={(node) => {
            el.current = node;
          }}
          playsInline
          aria-label={file.name}
        />
      ) : (
        <audio
          {...props}
          ref={(node) => {
            el.current = node;
          }}
          aria-label={file.name}
        />
      )}
      {error ? (
        <div className="media-failure">
          <p role="alert">{error}</p>
          <button className="text-button" onClick={() => setRetry((x) => x + 1)}>
            <ArrowClockwise size={16} />
            Try playback again
          </button>
        </div>
      ) : (
        <div className="media-controls">
          <button
            type="button"
            className="media-toggle"
            disabled={!source}
            onClick={() => void toggle()}
            aria-label={`${playing ? 'Pause' : 'Play'} ${file.name}`}
          >
            {playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}
          </button>
          <input
            type="range"
            aria-label={`${file.name} position`}
            min="0"
            max={Number.isFinite(duration) && duration > 0 ? duration : 1}
            step="0.1"
            value={Math.min(time, Number.isFinite(duration) && duration > 0 ? duration : 1)}
            disabled={!ready || !Number.isFinite(duration) || duration <= 0}
            onChange={(e) => {
              if (el.current) {
                el.current.currentTime = Number(e.target.value);
                setTime(Number(e.target.value));
              }
            }}
          />
          <span className="media-time">
            {clock(time)} / {clock(duration)}
          </span>
          <button
            type="button"
            className="media-mute"
            aria-label={`${muted ? 'Unmute' : 'Mute'} ${file.name}`}
            onClick={() => {
              if (el.current) {
                el.current.muted = !muted;
                setMuted(!muted);
              }
            }}
          >
            {muted ? <SpeakerSlash size={18} /> : <SpeakerHigh size={18} />}
          </button>
        </div>
      )}
    </div>
  );
}
