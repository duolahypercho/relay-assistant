import { assistantForThread } from '../../shared/assistant-scope.mjs';
import { useEffect, useRef, useState } from 'react';
import {
  Microphone,
  MicrophoneSlash,
  PhoneDisconnect,
  Waveform,
  Hand,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { VoiceSegmenter, speechWav, voiceActivityFrames } from '../../shared/voice-activity.mjs';
import { VoicePlayback, voiceReplyFrames } from '../../shared/voice-playback.mjs';
import './voice-call.css';
type Phase =
  | 'connecting'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error';
export default function VoiceCall({
  threadId,
  onClose,
  initialAudio,
  fileIds = [],
  apps = [],
}: {
  threadId: string;
  onClose: () => void;
  initialAudio: AudioContext | null;
  fileIds?: string[];
  apps?: { id: string; revision: number; name: string }[];
}) {
  const { s, go } = useWorkspace();
  const callContext = useRef({ fileIds: [...fileIds], apps: apps.map((app) => ({ ...app })) });
  const [phase, setPhase] = useState<Phase>('connecting'),
    [error, setError] = useState(''),
    [muted, setMuted] = useState(false),
    [seconds, setSeconds] = useState(0);
  const state = useRef({
    phase: 'connecting' as Phase,
    muted: false,
    alive: true,
    ticket: 0,
    id: crypto.randomUUID(),
    started: false,
    requesting: false,
    runId: '',
    observed: '',
    beginning: Date.now(),
  });
  const audio = useRef<AudioContext | null>(null),
    media = useRef<MediaStream | null>(null),
    processor = useRef<AudioNode | null>(null),
    speaker = useRef<VoicePlayback | null>(null),
    segmenter = useRef<any>(null),
    pending = useRef<AbortController | null>(null),
    interrupting = useRef<Promise<any>>(Promise.resolve()),
    retry = useRef<{ blob: Blob; id: string } | null>(null);
  const config = s.connections.runtime;
  const configured =
    api.mode() === 'server' &&
    s.connections.model?.configured &&
    config?.transcription?.configured &&
    config?.speech?.configured;
  const supported = !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
  function update(next: Phase) {
    state.current.phase = next;
    if (state.current.alive) setPhase(next);
  }
  function stopSound() {
    if (speaker.current) {
      speaker.current.stop();
      speaker.current = null;
    }
  }
  function stopCapture() {
    processor.current?.disconnect();
    processor.current = null;
    media.current?.getTracks().forEach((t) => t.stop());
    media.current = null;
    void audio.current?.close().catch(() => {});
    audio.current = null;
  }
  function end(notify = true) {
    if (!state.current.alive) return;
    state.current.alive = false;
    state.current.ticket++;
    pending.current?.abort();
    stopSound();
    stopCapture();
    if (state.current.started || state.current.requesting)
      void api
        .request(`/voice-calls/${state.current.id}/end`, { method: 'POST', keepalive: true })
        .catch(() => {});
    if (notify) onClose();
  }
  function fail(cause: unknown) {
    if (!state.current.alive) return;
    segmenter.current?.reset();
    update('error');
    setError(
      cause instanceof Error && !['TypeError', 'TimeoutError'].includes(cause.name)
        ? cause.message
        : 'The voice connection was interrupted. Your saved conversation is still here.',
    );
  }
  async function interrupt(preserveWork = false) {
    state.current.ticket++;
    pending.current?.abort();
    pending.current = null;
    stopSound();
    if (!preserveWork) state.current.runId = '';
    retry.current = null;
    return api.request(
      `/voice-calls/${state.current.id}/${preserveWork ? 'listen' : 'interrupt'}`,
      { method: 'POST' },
    );
  }
  async function resumeWork() {
    const ticket = state.current.ticket;
    try {
      await interrupting.current;
      if (!state.current.alive || ticket !== state.current.ticket) return;
      await api.request(`/voice-calls/${state.current.id}/resume`, { method: 'POST' });
      if (state.current.alive && ticket === state.current.ticket) {
        // A rejected short onset or failed speech request can leave the run
        // complete but unheard. Observe that same saved reply again; this does
        // not send another owner message or repeat the assistant's work.
        state.current.observed = '';
        update(state.current.runId ? 'thinking' : 'listening');
      }
    } catch (cause) {
      if (ticket === state.current.ticket) fail(cause);
    }
  }
  async function submit(blob: Blob, id: string = crypto.randomUUID()) {
    const ticket = ++state.current.ticket,
      controller = new AbortController();
    pending.current = controller;
    retry.current = { blob, id };
    update('transcribing');
    try {
      await interrupting.current;
      if (!state.current.alive || state.current.ticket !== ticket) return;
      const result = await api.request(`/voice-calls/${state.current.id}/turn?turn=${id}`, {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'audio/wav' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]),
      });
      if (!state.current.alive || state.current.ticket !== ticket) return;
      retry.current = null;
      state.current.runId = result.turn.runId || '';
      update(result.turn.status === 'stopped' ? 'listening' : 'thinking');
      await api.refresh();
    } catch (cause) {
      if (!controller.signal.aborted && ticket === state.current.ticket) fail(cause);
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  async function speak(message: any) {
    const ticket = state.current.ticket,
      controller = new AbortController();
    pending.current = controller;
    try {
      if (!message?.text?.trim()) {
        update('paused');
        setError('The result is ready in chat. Review it, then keep talking.');
        return;
      }
      const response = await api.fetch(`/voice-calls/${state.current.id}/reply-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]),
      });
      if (!state.current.alive || ticket !== state.current.ticket || !audio.current) return;
      const playback = new VoicePlayback(audio.current);
      speaker.current = playback;
      let card;
      for await (const frame of voiceReplyFrames(response)) {
        if (!state.current.alive || ticket !== state.current.ticket) return;
        if (frame.type === 'audio') {
          playback.pcm(frame);
          update('speaking');
        } else card = frame.card;
      }
      if (!playback.received) {
        // Cached recordings and providers without incremental PCM keep the same
        // complete WAV path. No extra synthesis or model request is necessary.
        const recording = await api.fetch(`/voice-memos/${encodeURIComponent(card.id)}/audio`, {
          signal: controller.signal,
        });
        if (!recording.ok)
          throw new Error('The spoken reply could not load. Its text is saved in chat.');
        const bytes = await recording.arrayBuffer();
        if (!state.current.alive || ticket !== state.current.ticket || !audio.current) return;
        const buffer = await audio.current.decodeAudioData(bytes);
        if (!state.current.alive || ticket !== state.current.ticket) return;
        playback.enqueue(buffer);
        update('speaking');
      }
      void api.refresh();
      await playback.finish();
      if (!state.current.alive || ticket !== state.current.ticket || !audio.current) return;
      speaker.current = null;
      state.current.runId = '';
      segmenter.current?.reset();
      const review = (message.cards || []).some((c: any) =>
        ['question', 'approval', 'computer-access'].includes(c.kind),
      );
      update(review ? 'paused' : 'listening');
      if (review) setError('A decision is waiting in chat. Review it before continuing.');
    } catch (cause) {
      if (!controller.signal.aborted && ticket === state.current.ticket) {
        stopSound();
        fail(cause);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  useEffect(() => {
    const current = state.current;
    if (!current.alive || !current.runId || current.phase !== 'thinking') return;
    const run = s.runs.find((r) => r.id === current.runId);
    if (!run || ['queued', 'running'].includes(run.status) || current.observed === run.id) return;
    current.observed = run.id;
    if (run.status !== 'completed') {
      current.runId = '';
      fail(new Error(run.error || 'The reply stopped. You can keep talking or end the call.'));
      return;
    }
    const message = s.messages.findLast(
      (m) => m.replyTo === (run.activeMessageId || run.messageId) && m.role === 'assistant',
    );
    void speak(message);
  }, [s.revision, phase]);
  useEffect(() => {
    state.current.alive = true;
    async function start() {
      if (!configured || !supported) {
        update('error');
        return;
      }
      try {
        const context = initialAudio || new AudioContext();
        audio.current = context;
        await context.resume();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        if (!state.current.alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        media.current = stream;
        state.current.requesting = true;
        const result = await api.request('/voice-calls', {
          method: 'POST',
          body: JSON.stringify({ id: state.current.id, threadId, context: callContext.current }),
        });
        if (!state.current.alive) {
          void api
            .request(`/voice-calls/${state.current.id}/end`, { method: 'POST' })
            .catch(() => {});
          return;
        }
        if (result.call.status !== 'active') throw new Error('This call has ended. Start another.');
        state.current.started = true;
        segmenter.current = new VoiceSegmenter(context.sampleRate);
        const receiveFrame = (samples: Float32Array) => {
          const current = state.current;
          if (
            !current.alive ||
            current.muted ||
            !['listening', 'hearing', 'thinking', 'speaking'].includes(current.phase)
          )
            return;
          const event = segmenter.current.push(samples);
          if (event.started) {
            if (['thinking', 'speaking'].includes(current.phase)) {
              interrupting.current = interrupt(current.phase === 'thinking');
              void interrupting.current.catch(fail);
            }
            update('hearing');
          }
          if (event.finished) {
            if (event.chunks)
              void submit(
                new Blob([speechWav(event.chunks, context.sampleRate)], { type: 'audio/wav' }),
              );
            else void resumeWork();
          }
        };
        const receive = (samples: Float32Array) => {
          for (const frame of voiceActivityFrames(samples, context.sampleRate)) receiveFrame(frame);
        };
        const source = context.createMediaStreamSource(stream),
          silent = context.createGain();
        silent.gain.value = 0;
        if (context.audioWorklet) {
          await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-capture.js`);
          if (!state.current.alive) return;
          const node = new AudioWorkletNode(context, 'relay-voice-capture');
          node.port.onmessage = (e) => receive(e.data);
          processor.current = node;
        } else {
          const node = context.createScriptProcessor(2048, 1, 1);
          node.onaudioprocess = (e) => receive(e.inputBuffer.getChannelData(0));
          processor.current = node;
        }
        source.connect(processor.current!);
        processor.current!.connect(silent);
        silent.connect(context.destination);
        stream.getAudioTracks().forEach((t) =>
          t.addEventListener(
            'ended',
            () => {
              fail(new Error('Your microphone disconnected. End the call and reconnect it.'));
              stopCapture();
            },
            { once: true },
          ),
        );
        document.querySelectorAll('audio,video').forEach((el) => (el as HTMLMediaElement).pause());
        update('listening');
      } catch (cause) {
        stopCapture();
        if (cause instanceof DOMException && cause.name === 'NotAllowedError')
          fail(
            new Error(
              'Microphone access was not allowed. Enable it in your device settings, then start another call.',
            ),
          );
        else fail(cause);
      }
    }
    const begin = setTimeout(() => void start(), 0);
    let heartbeatBusy = false;
    const timer = setInterval(() => {
      if (!state.current.alive) return;
      setSeconds(Math.floor((Date.now() - state.current.beginning) / 1000));
      if (!state.current.started || heartbeatBusy) return;
      heartbeatBusy = true;
      void api
        .request(`/voice-calls/${state.current.id}/heartbeat`, {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
        })
        .catch(() => {
          if (state.current.alive) end();
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 5000);
    const background = () => {
      if (document.visibilityState === 'hidden') end();
    };
    const unload = () => end();
    const otherPlayback = (event: Event) => {
      if (
        !(event.target instanceof HTMLMediaElement) ||
        !state.current.started ||
        !state.current.alive
      )
        return;
      interrupting.current = interrupt();
      void interrupting.current.catch(fail);
      segmenter.current?.reset();
      update('paused');
      setError(
        'Voice chat is paused while you play audio. Choose Keep talking when you are ready.',
      );
    };
    document.addEventListener('play', otherPlayback, true);
    document.addEventListener('visibilitychange', background);
    window.addEventListener('pagehide', unload);
    return () => {
      clearTimeout(begin);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('pagehide', unload);
      document.removeEventListener('play', otherPlayback, true);
      end(false);
      queueMicrotask(() => {
        if (!state.current.alive) void initialAudio?.close().catch(() => {});
      });
    };
  }, []);
  const labels: Record<Phase, string> = {
    connecting: 'Connecting…',
    listening: muted ? 'Microphone muted' : 'Listening',
    hearing: 'I’m listening…',
    transcribing: 'Understanding…',
    thinking: 'Thinking…',
    speaking: `${assistantForThread(s, threadId).name} is speaking`,
    paused: 'Voice chat paused',
    error: 'Voice chat paused',
  };
  return (
    <section
      className={`voice-call ${error || !configured ? 'needs-attention' : ''}`}
      aria-label="Voice chat"
    >
      <div className="voice-call-heading">
        <p role="status">
          {!configured
            ? 'Voice chat needs setup'
            : !supported
              ? 'Microphone unavailable'
              : labels[phase]}
        </p>
        <span className="voice-call-meta">
          <Waveform size={14} aria-hidden="true" /> AI voice
          <time>
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </time>
        </span>
        {!!(callContext.current.fileIds.length || callContext.current.apps.length) && (
          <p className="voice-call-context">
            Using{' '}
            {[
              ...(callContext.current.fileIds.length
                ? [
                    `${callContext.current.fileIds.length} ${callContext.current.fileIds.length === 1 ? 'file' : 'files'}`,
                  ]
                : []),
              ...callContext.current.apps.map((app) => app.name),
            ].join(' · ')}
          </p>
        )}
      </div>
      <div className="voice-call-controls">
        {state.current.started && (
          <button
            className="secondary-button"
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={muted}
            title={muted ? 'Unmute microphone' : 'Mute microphone'}
            onClick={() => {
              state.current.muted = !state.current.muted;
              setMuted(state.current.muted);
              segmenter.current?.reset();
              media.current?.getAudioTracks().forEach((t) => {
                t.enabled = !state.current.muted;
              });
              if (state.current.phase === 'hearing') void resumeWork();
            }}
          >
            {muted ? <MicrophoneSlash size={18} /> : <Microphone size={18} />}
            <span className="voice-call-control-label">{muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
        {['thinking', 'speaking'].includes(phase) && (
          <button
            className="secondary-button"
            aria-label="Interrupt"
            title="Interrupt"
            onClick={() => {
              interrupting.current = interrupt();
              void interrupting.current
                .then(() => {
                  segmenter.current?.reset();
                  update('listening');
                })
                .catch(fail);
            }}
          >
            <Hand size={18} />
            <span className="voice-call-control-label">Interrupt</span>
          </button>
        )}
        {['error', 'paused'].includes(phase) && state.current.started && audio.current && (
          <button
            className="secondary-button"
            onClick={() => {
              setError('');
              document
                .querySelectorAll('audio,video')
                .forEach((el) => (el as HTMLMediaElement).pause());
              if (retry.current) void submit(retry.current.blob, retry.current.id);
              else {
                segmenter.current?.reset();
                void resumeWork();
              }
            }}
          >
            {retry.current ? 'Retry this turn' : 'Keep talking'}
          </button>
        )}
        <button className="voice-call-end" onClick={() => end()}>
          <PhoneDisconnect size={20} />
          End call
        </button>
      </div>
      {!configured && (
        <p className="voice-call-note">
          Set up listening and speaking to start a call.{' '}
          <button
            className="text-button"
            onClick={() => go('settings', s.connections.model.configured ? 'voice' : 'models')}
          >
            Open settings
          </button>
        </p>
      )}
      {error && (
        <p className="voice-call-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
