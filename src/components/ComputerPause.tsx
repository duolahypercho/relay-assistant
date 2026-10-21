import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api';
import { tr } from '../i18n';

type Recovery = {
  available?: boolean;
  running?: boolean;
  canStart?: boolean;
  canContinueChat?: boolean;
  busy?: boolean;
  cancellable?: boolean;
  phase?: string;
  intent?: string;
  error?: string;
};
const progress: Record<string, string> = {
  checking: 'Checking your computer…',
  waking: 'Waking your computer…',
  opening: 'Opening your computer…',
  releasing: 'Resuming Relay…',
  cancelling: 'Keeping you in control…',
  stopping: 'Closing apps and jobs…',
  sleeping: 'Putting your computer to sleep…',
};

export type ComputerPauseControl = { continueChat: () => Promise<void> };
export default forwardRef<
  ComputerPauseControl,
  {
    name: string;
    hasMessage: boolean;
    hasWaitingWork: boolean;
    onSendReady: (ready: boolean) => void;
    onOpen: () => void;
    onResumed: () => void;
  }
>(function ComputerPause(
  { name, hasMessage, hasWaitingWork, onSendReady, onOpen, onResumed },
  ref,
) {
  const [engine, setEngine] = useState<Recovery | null>(null);
  const [computer, setComputer] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false),
    alive = useRef(true),
    revision = useRef(0);
  const callback = useRef(onResumed);
  callback.current = onResumed;
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const version = revision.current;
      try {
        const [recovery, status] = await Promise.all([
          api.request('/computer/engine').catch(() => ({ available: false })),
          api.request('/computer').catch(() => ({ state: '' })),
        ]);
        if (!alive.current || version !== revision.current) return;
        setEngine(recovery);
        setComputer(status.state);
        if (status.controller === 'agent') {
          await api.refresh();
          callback.current();
        }
      } catch {
        // Reconnect and retry the observation without inventing a completed handback.
      } finally {
        if (alive.current) timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
      revision.current++;
    };
  }, []);
  const waking = !!engine?.busy;
  const missing = computer === 'missing';
  const canWake =
    !!engine?.available && (!!engine.canStart || (engine.running && computer === 'stopped'));
  const canChat = missing || !!engine?.canContinueChat;
  const sendReady = canChat && !waking && !working;
  useEffect(() => {
    onSendReady(sendReady);
    return () => onSendReady(false);
  }, [sendReady, onSendReady]);
  useImperativeHandle(ref, () => ({
    continueChat: () => action(missing ? 'release' : 'continueChat'),
  }));
  async function action(kind: 'resume' | 'release' | 'cancel' | 'continueChat') {
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    setWorking(true);
    setError('');
    try {
      const result = await api.request(
        kind === 'release' ? '/computer/release' : `/computer/engine/${kind}`,
        { method: 'POST', body: '{}' },
      );
      if (!alive.current) return;
      if (kind === 'release') {
        await api.refresh();
        callback.current();
      } else setEngine(result);
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      // Ignore status polls that began while this mutation was in flight.
      revision.current++;
      pending.current = false;
      if (alive.current) setWorking(false);
    }
  }
  return (
    <div className="computer-pause-note" role="status">
      <span>
        {tr(
          waking
            ? progress[engine.phase || ''] || 'Opening your computer…'
            : missing
              ? 'Your saved computer could not be found. You can keep chatting.'
              : canChat
                ? hasMessage
                  ? 'Send to continue chatting. Your computer stays asleep.'
                  : 'Chat is paused. Your computer is asleep.'
                : canWake
                  ? 'Your computer is asleep. Start it to continue with {name}.'
                  : '{name} is paused while you control the computer.',
          { name },
        )}
      </span>
      {waking ? (
        engine.cancellable && (
          <button
            className="text-button computer-handback"
            disabled={working}
            onClick={() => void action('cancel')}
          >
            {tr(
              ['resume', 'chat'].includes(engine.intent || '') ? 'Cancel resume' : 'Cancel startup',
            )}
          </button>
        )
      ) : !(canChat && hasMessage && !hasWaitingWork) ? (
        <button
          className="text-button computer-handback"
          disabled={working || !engine}
          onClick={() =>
            void action(
              missing ? 'release' : canChat ? 'continueChat' : canWake ? 'resume' : 'release',
            )
          }
        >
          {tr(
            working
              ? 'Resuming Relay…'
              : canChat
                ? 'Continue chatting'
                : canWake
                  ? 'Start & resume'
                  : 'Give back to Relay',
          )}
        </button>
      ) : null}
      <button
        className="text-button"
        disabled={working}
        onClick={canChat && !missing && !waking ? () => void action('resume') : onOpen}
      >
        {tr(missing ? 'Recover computer' : canChat && !waking ? 'Start & resume' : 'Open computer')}
      </button>
      {(error || (['resume', 'chat'].includes(engine?.intent || '') && engine?.error)) && (
        <span className="computer-resume-error" role="alert">
          {error || engine?.error}
        </span>
      )}
      {['resume', 'chat'].includes(engine?.intent || '') && engine?.phase === 'cancelled' && (
        <span>{tr('Resume cancelled. You are still in control.')}</span>
      )}
    </div>
  );
});
