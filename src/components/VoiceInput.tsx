import { useEffect, useRef, useState } from 'react';
import { Microphone, Check, X } from '@phosphor-icons/react';
import './voice-input.css';
import { listeningWav } from '../voice-recording';

type Phase = 'ready' | 'permission' | 'recording' | 'stopping' | 'review' | 'transcribing';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 120;
export default function VoiceInput({
  configured,
  destination,
  inputFormat,
  onInsert,
  onClose,
}: {
  configured: boolean;
  destination: string;
  inputFormat?: string;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [preview, setPreview] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const insert = useRef(onInsert);
  insert.current = onInsert;
  const audio = useRef<HTMLAudioElement>(null);
  const supported = !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  function stopTracks() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }
  const submitOnStop = useRef(false);
  function stopRecording(submit = false) {
    submitOnStop.current = submit;
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      if (mounted.current) setPhase('stopping');
    }
    stopTracks();
  }
  function close() {
    mounted.current = false;
    generation.current++;
    request.current?.abort();
    stopRecording();
    onClose();
  }
  useEffect(() => {
    mounted.current = true;
    const background = () => {
      if (document.visibilityState !== 'hidden') return;
      if (stream.current) stopRecording();
      else {
        // Ignore a late OS permission response after the app moved to the background.
        generation.current++;
        setPhase((old) => (old === 'permission' ? 'ready' : old));
      }
    };
    const begin = setTimeout(() => void start(), 0);
    document.addEventListener('visibilitychange', background);
    return () => {
      clearTimeout(begin);
      mounted.current = false;
      generation.current++;
      request.current?.abort();
      stopRecording();
      document.removeEventListener('visibilitychange', background);
    };
  }, []);
  useEffect(() => {
    if (!recording) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(recording);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);
  async function start() {
    if (
      !supported ||
      !configured ||
      ['permission', 'recording', 'stopping', 'transcribing'].includes(phase)
    )
      return;
    const ticket = ++generation.current;
    setError('');
    setRecording(null);
    setSeconds(0);
    setPhase('permission');
    try {
      const capture = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mounted.current || ticket !== generation.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
        (mime) => MediaRecorder.isTypeSupported(mime),
      );
      if (!mimeType) throw new Error('unsupported');
      const next = new MediaRecorder(capture, { mimeType, audioBitsPerSecond: 64000 });
      recorder.current = next;
      const chunks: Blob[] = [];
      let size = 0;
      let failed = false;
      const started = performance.now();
      next.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
        }
        if (size > MAX_BYTES) {
          failed = true;
          if (mounted.current) setError('This recording is too large. Try a shorter message.');
          stopRecording();
        }
      };
      next.onerror = () => {
        failed = true;
        if (mounted.current) setError('Recording was interrupted. Please try again.');
        stopRecording();
      };
      next.onstop = () => {
        stopTracks();
        if (!mounted.current || ticket !== generation.current) return;
        recorder.current = null;
        if (failed || size < 12) {
          setPhase('ready');
          if (!failed) setError('No audio was recorded. Please try again.');
          return;
        }
        const clip = new Blob(chunks, { type: next.mimeType || mimeType });
        setRecording(clip);
        setPhase('review');
        if (submitOnStop.current) void transcribe(clip);
      };
      capture
        .getAudioTracks()
        .forEach((track) => track.addEventListener('ended', () => stopRecording(), { once: true }));
      next.start(250);
      setPhase('recording');
      timer.current = setInterval(() => {
        const elapsed = Math.floor((performance.now() - started) / 1000);
        setSeconds(Math.min(elapsed, MAX_SECONDS));
        if (elapsed >= MAX_SECONDS) stopRecording();
      }, 250);
    } catch (cause) {
      if (!mounted.current || ticket !== generation.current) return;
      stopTracks();
      const name = cause instanceof Error ? cause.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access was not allowed. Enable it for Relay in your browser or device settings, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Connect one and try again.'
            : 'The microphone could not start. Check that it is available and try again.',
      );
      setPhase('ready');
    }
  }
  async function transcribe(clip = recording) {
    if (!clip || phase === 'transcribing' || request.current) return;
    audio.current?.pause();
    const controller = new AbortController();
    request.current = controller;
    setPhase('transcribing');
    setError('');
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]);
      const recording = inputFormat === 'wav' ? await listeningWav(clip, signal) : clip;
      signal.throwIfAborted();
      const result = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': recording.type },
        body: recording,
        signal,
      });
      const body = await result.json();
      if (!result.ok) throw new Error(body.error || 'Transcription failed. Try again.');
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000)
        throw new Error('No usable transcript was returned. Try recording again.');
      if (mounted.current && !controller.signal.aborted) insert.current(body.text.trim());
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(
        cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError'
          ? cause.message
          : 'The connection was interrupted or timed out. Your recording is still here; try again.',
      );
      setPhase('review');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  const active = phase === 'recording';
  return (
    <section
      className="voice-input"
      aria-label="Voice input"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className={`voice-recording-status ${active ? 'is-recording' : ''}`}>
        <Microphone size={20} weight={active ? 'fill' : 'regular'} />
        <span role="status">
          {!configured
            ? 'Voice input needs setup'
            : !supported
              ? 'Microphone unavailable'
              : active
                ? 'Listening…'
                : phase === 'permission'
                  ? 'Waiting for microphone…'
                  : phase === 'stopping'
                    ? 'Finishing…'
                    : phase === 'transcribing'
                      ? 'Transcribing…'
                      : recording
                        ? 'Recording saved for retry'
                        : 'Ready to try again'}
        </span>
        {configured && supported && (
          <time aria-label={`${seconds} seconds recorded`}>
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </time>
        )}
        {active && (
          <button
            className="voice-done"
            onClick={() => stopRecording(true)}
            aria-label="Done recording"
            title="Stop and transcribe into your draft"
          >
            <Check size={17} weight="bold" /> Done
          </button>
        )}
        <button
          className="icon-button"
          aria-label={phase === 'transcribing' ? 'Cancel transcription' : 'Cancel voice input'}
          onClick={close}
        >
          <X size={19} />
        </button>
      </div>
      {!configured ? (
        <p>
          Set up listening in Settings. Your typed draft stays here.{' '}
          <a href="#settings?section=voice" onClick={close}>
            Open settings
          </a>
        </p>
      ) : !supported ? (
        <p>Open Relay over HTTPS or use the installed app to use your microphone.</p>
      ) : (
        <>
          {preview && phase === 'review' && (
            <audio
              ref={audio}
              controls
              preload="metadata"
              src={preview}
              aria-label="Listen to your recording"
            />
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {['ready', 'review'].includes(phase) && (
            <div className="voice-input-actions">
              <button className="text-button" onClick={() => void start()}>
                {recording ? 'Record again' : 'Try microphone again'}
              </button>
              {recording && (
                <button className="voice-done" onClick={() => void transcribe()}>
                  Retry transcription
                </button>
              )}
            </div>
          )}
          <p className="voice-privacy">
            Done sends audio to {destination || 'your speech service'} and adds text to your draft.
            You choose when to send.
          </p>
        </>
      )}
    </section>
  );
}
