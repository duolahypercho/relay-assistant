import { useState } from 'react';
import {
  CalendarBlank,
  Plus,
  ArrowsClockwise,
  MapPin,
  PencilSimple,
  Trash,
  Clock,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { PageHeading, Modal, Field, Empty, dateTime, localDate } from '../components/ui';
import type { Entity } from '../types';
export default function Calendar() {
  const { s, act, run, go, toast } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [eventId, setEventId] = useState('');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(localDate(new Date(Date.now() + 3600000).toISOString()));
  const [end, setEnd] = useState(localDate(new Date(Date.now() + 7200000).toISOString()));
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [calendarId, setCalendarId] = useState(s.connections.google.calendarId || 'primary');
  const [range, setRange] = useState(30);
  const events = [...s.events].sort((a, b) => +new Date(a.start) - +new Date(b.start));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const deletable = s.events.find((e) => e.id === deleteId);
  function edit(event?: Entity) {
    setEventId(event?.id || '');
    setTitle(event?.title || '');
    setStart(
      event?.allDay
        ? event.start
        : localDate(event?.start || new Date(Date.now() + 3600000).toISOString()),
    );
    setEnd(
      event?.allDay
        ? event.end
        : localDate(event?.end || new Date(Date.now() + 7200000).toISOString()),
    );
    setAllDay(!!event?.allDay);
    setLocation(event?.location || '');
    setDescription(event?.description || '');
    setEditing(true);
  }
  async function sync() {
    setBusy(true);
    await run(async () => {
      const r = await api.request('/google/sync', {
        method: 'POST',
        body: JSON.stringify({
          calendarId,
          includeMail: false,
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + range * 86400000).toISOString(),
        }),
      });
      await api.refresh();
      toast(`Synced ${r.events} events${r.partial ? ' · Showing a limited window' : ''}.`);
    });
    setBusy(false);
  }
  return (
    <section>
      <PageHeading
        title="Make room for what matters"
        description={`${s.connections.google.connected ? 'Google Calendar' : 'Sample calendar'} · Times shown in ${timeZone}`}
      >
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            s.connections.google.connected ? void sync() : go('settings', 'connections')
          }
        >
          <ArrowsClockwise size={18} />
          {busy ? 'Syncing…' : s.connections.google.connected ? 'Sync Google' : 'Connect Google'}
        </button>
        <button className="primary-button" onClick={() => edit()}>
          <Plus size={18} />
          New event
        </button>
      </PageHeading>
      {s.connections.google.connected && (
        <div className="surface-toolbar">
          <Field label="Calendar">
            <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              {(
                s.connections.google.calendars || [{ id: 'primary', name: 'Primary calendar' }]
              ).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sync range">
            <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
              <option value={7}>Next 7 days</option>
              <option value={30}>Next 30 days</option>
            </select>
          </Field>
          <span className="muted">Sync to load the selected calendar.</span>
        </div>
      )}
      {events.length ? (
        <div className="calendar-agenda">
          {events.map((e, i) => {
            const day = e.allDay
              ? e.start
              : new Intl.DateTimeFormat(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                }).format(new Date(e.start));
            const prev = events[i - 1];
            const previousDay = prev
              ? prev.allDay
                ? prev.start
                : new Intl.DateTimeFormat(undefined, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  }).format(new Date(prev.start))
              : '';
            return (
              <div key={e.id}>
                {day !== previousDay && <h2 className="agenda-day">{day}</h2>}
                <article className="event-row">
                  <div className="event-time">
                    <Clock size={17} />
                    {e.allDay
                      ? 'All day'
                      : new Intl.DateTimeFormat(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        }).format(new Date(e.start))}
                  </div>
                  <div className="event-content">
                    <h3>{e.title}</h3>
                    <p>
                      {dateTime(e.start, e.allDay)} – {dateTime(e.end, e.allDay)}
                      {e.allDay ? ' (end date exclusive)' : ''}
                    </p>
                    {e.location && (
                      <span>
                        <MapPin size={14} />
                        {e.location}
                      </span>
                    )}
                    {e.description && <p className="event-description">{e.description}</p>}
                    {e.recurring && <small>Recurring · Manage in Google Calendar</small>}
                  </div>
                  <div className="event-actions">
                    <button
                      className="icon-button"
                      disabled={e.recurring}
                      aria-label={`Edit ${e.title}`}
                      onClick={() => edit(e)}
                    >
                      <PencilSimple size={19} />
                    </button>
                    <button
                      className="icon-button danger-text"
                      disabled={e.recurring}
                      aria-label={`Delete ${e.title}`}
                      onClick={() => setDeleteId(e.id)}
                    >
                      <Trash size={19} />
                    </button>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon={CalendarBlank} title="A little space in your day">
          Create an event, or connect Google and sync a bounded calendar range.
        </Empty>
      )}
      {editing && (
        <Modal
          title={eventId ? 'Prepare an event change' : 'Make time for something'}
          onClose={() => setEditing(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await act('calendar.prepare', {
                id: eventId || undefined,
                operation: eventId ? 'update' : 'create',
                title,
                start: allDay ? start : new Date(start).toISOString(),
                end: allDay ? end : new Date(end).toISOString(),
                location,
                description,
                allDay,
                calendarId,
              });
              if (result) {
                setEditing(false);
                toast('Your calendar change is ready for review.');
              }
            }}
          >
            <Field label="Event name">
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={180}
              />
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => {
                  setAllDay(e.target.checked);
                  if (e.target.checked) {
                    setStart(start.slice(0, 10));
                    setEnd(end.slice(0, 10));
                  } else {
                    setStart(`${start.slice(0, 10)}T09:00`);
                    setEnd(`${end.slice(0, 10)}T10:00`);
                  }
                }}
              />
              All day
            </label>
            <div className="form-grid">
              <Field label="Starts">
                <input
                  type={allDay ? 'date' : 'datetime-local'}
                  required
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              <Field label={allDay ? 'Ends (exclusive date)' : 'Ends'}>
                <input
                  type={allDay ? 'date' : 'datetime-local'}
                  required
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Location (optional)">
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={300}
              />
            </Field>
            <Field label="Details (optional)">
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
              />
            </Field>
            <p className="form-note">
              {allDay
                ? 'For a one-day event, choose the next day as the exclusive end date.'
                : `Timed events use your browser’s time zone: ${timeZone}.`}{' '}
              Review before the calendar changes.
            </p>
            <button type="submit" className="primary-button">
              Prepare for review
            </button>
          </form>
        </Modal>
      )}
      {deletable && (
        <Modal title="Review an event removal" onClose={() => setDeleteId('')}>
          <p>
            Prepare a review to remove “{deletable.title}” from your{' '}
            {s.connections.google.connected ? 'Google' : 'sample'} calendar.
          </p>
          <div className="modal-footer">
            <button className="secondary-button" onClick={() => setDeleteId('')}>
              Keep event
            </button>
            <button
              className="danger-button"
              onClick={async () => {
                const a = await act('calendar.prepare', { operation: 'delete', id: deletable.id });
                if (a) {
                  setDeleteId('');
                }
              }}
            >
              Prepare removal
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
