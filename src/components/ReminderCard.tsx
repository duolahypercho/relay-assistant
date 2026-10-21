import { useId, useRef, useState } from 'react';
import { Bell, Pause, Play } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { tr, uiLocale } from '../i18n';
import { scheduleLabel } from '../../shared/routines.mjs';
import './reminder-card.css';

export default function ReminderCard({ id }: { id: string }) {
  const { s, go } = useWorkspace();
  const label = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const reminder = s.routines.find((r) => r.id === id);
  if (!reminder) return <p className="form-note">{tr('This reminder is no longer available.')}</p>;
  const once = reminder.schedule.kind === 'once';
  const pending = s.runs.some(
    (r) => r.routineId === id && ['queued', 'running'].includes(r.status),
  );
  const delivered =
    once &&
    reminder.nextRunAt === null &&
    s.runs.some(
      (r) =>
        r.routineId === id &&
        r.routineVersion === reminder.version &&
        r.trigger === 'schedule' &&
        r.status === 'completed',
    );
  const expired = once && reminder.schedule.at <= Date.now();
  const needsTime = !delivered && !pending && reminder.paused && expired;
  const status = reminder.archived
    ? 'Cancelled'
    : delivered
      ? 'Delivered'
      : needsTime
        ? 'Choose a new time'
        : pending
          ? 'Due now'
          : reminder.paused
            ? 'Paused'
            : expired
              ? 'Due now'
              : 'Scheduled';
  const canPause = !reminder.archived && !delivered && (!reminder.paused || pending);
  const canResume = !reminder.archived && !delivered && !pending && reminder.paused && !expired;
  const zone = reminder.schedule.timeZone;
  let when: string;
  if (once) {
    when = new Intl.DateTimeFormat(uiLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(reminder.reminderRelative ? {} : { timeZone: zone }),
    }).format(new Date(reminder.schedule.at));
    if (!reminder.reminderRelative) when += ` · ${zone}`;
  } else if (reminder.schedule.kind === 'daily') {
    when = tr('Every day at {time} · {zone}', { time: reminder.schedule.time, zone });
  } else if (reminder.schedule.kind === 'weekly') {
    const days = reminder.schedule.days
      .map((day: number) =>
        new Intl.DateTimeFormat(uiLocale(), {
          weekday: 'short',
          timeZone: 'UTC',
        }).format(new Date(Date.UTC(2024, 0, 7 + day))),
      )
      .join(', ');
    when = tr('{days} at {time} · {zone}', { days, time: reminder.schedule.time, zone });
  } else if (reminder.schedule.kind === 'interval') {
    when = tr('Every {minutes} minutes', { minutes: reminder.schedule.minutes });
  } else {
    when = scheduleLabel(reminder.schedule);
  }
  async function toggle() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.act(canPause ? 'routine.pause' : 'routine.resume', { id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="reminder-chat-card" aria-labelledby={label} aria-busy={busy}>
      <div className="reminder-chat-heading">
        <strong id={label}>
          <Bell size={18} aria-hidden="true" />
          {tr(reminder.execution === 'reminder' ? 'Reminder' : 'Routine')}
        </strong>
        <span role="status">{tr(status)}</span>
      </div>
      <p className="reminder-chat-text">{reminder.instructions}</p>
      <p className="reminder-chat-time">{when}</p>
      <div className="reminder-chat-actions">
        {(canPause || canResume) && (
          <button className="secondary-button" disabled={busy} onClick={() => void toggle()}>
            {canPause ? (
              <Pause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
            {tr(canPause ? 'Pause' : 'Resume')}
          </button>
        )}
        <button className="text-button" onClick={() => go('routines')}>
          {tr('Details')}
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {tr(error)}
        </p>
      )}
    </article>
  );
}
