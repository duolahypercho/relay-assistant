// SPDX-License-Identifier: MIT
import { uid } from './seed.mjs';
import { assistantSnapshot, assistantSkills, threadAssistantId } from './assistant-scope.mjs';
import { skillSnapshot } from './skills.mjs';
import {
  validateMailTrigger,
  matchesMail,
  mailSnapshot,
  resetMailTrigger,
} from './mail-triggers.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    f.format(0); // Reject invalid IANA zones before storing a schedule.
    if (formatters.size > 100) formatters.clear();
    formatters.set(zone, f);
  }
  return formatters.get(zone);
}
function parts(at, zone) {
  return Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
}
function wallNumber(p) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);
}
// A repeated wall-clock time runs once, at its first occurrence. A missing
// daylight-saving time is skipped, rather than silently moved to another hour.
export function wallTime(date, time, zone) {
  formatter(zone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error('Choose a valid date and time.');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(naive).toISOString().slice(0, 10) !== date) throw new Error('Choose a valid date.');
  const offsets = new Set(
    [-86400000, 0, 86400000].map((delta) => {
      const at = naive + delta;
      return wallNumber(parts(at, zone)) - at;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((at) => wallNumber(parts(at, zone)) === naive);
  return candidates.length ? Math.min(...candidates) : null;
}
export function validateSchedule(value) {
  if (!value || typeof value !== 'object') throw new Error('Choose a schedule.');
  if (value.kind === 'email') return validateMailTrigger(value);
  const zone = String(value.timeZone || '');
  try {
    formatter(zone);
  } catch {
    throw new Error('Enter a valid IANA time zone, such as Asia/Shanghai.');
  }
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.minutes) || value.minutes < 5 || value.minutes > 525600)
      throw new Error('Repeat intervals must be between 5 minutes and one year.');
    return { kind: 'interval', minutes: value.minutes, timeZone: zone };
  }
  if (value.kind === 'once') {
    const at = wallTime(String(value.date), String(value.time), zone);
    if (at === null)
      throw new Error(
        'That local time does not exist because the clocks change. Choose another time.',
      );
    return { kind: 'once', date: value.date, time: value.time, timeZone: zone, at };
  }
  if (!['daily', 'weekly'].includes(value.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))
    throw new Error('Choose a daily or weekly time.');
  const days =
    value.kind === 'weekly' ? [...new Set(value.days || [])].sort() : [0, 1, 2, 3, 4, 5, 6];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    throw new Error('Choose at least one day of the week.');
  return { kind: value.kind, time: value.time, days, timeZone: zone };
}
export function nextOccurrence(schedule, after) {
  if (schedule.kind === 'email') return null;
  if (schedule.kind === 'interval') return after + schedule.minutes * 60000;
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null;
  const today = parts(after, schedule.timeZone);
  const midnight = Date.UTC(today.year, today.month - 1, today.day);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(midnight + day * 86400000);
    if (!schedule.days.includes(date.getUTCDay())) continue;
    const at = wallTime(date.toISOString().slice(0, 10), schedule.time, schedule.timeZone);
    if (at !== null && at > after) return at;
  }
  throw new Error('No next run could be calculated.');
}
export function scheduleLabel(s) {
  if (s.kind === 'email')
    return `New inbox mail${s.sender ? ` from ${s.sender}` : ''}${s.subject ? ` · subject contains “${s.subject}”` : ''}`;
  if (s.kind === 'interval') return `Every ${s.minutes} minutes`;
  if (s.kind === 'once') return `${s.date} at ${s.time} · ${s.timeZone}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${s.kind === 'daily' ? 'Every day' : s.days.map((d) => days[d]).join(', ')} at ${s.time} · ${s.timeZone}`;
}
export function routineState(s) {
  s.routines ??= [];
  return s;
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function queueRoutine(s, routine, trigger, now, scheduledFor = null, mail = null) {
  if (
    trigger !== 'email' &&
    s.runs.some((r) => r.routineId === routine.id && !terminal.has(r.status))
  )
    throw new Error('This routine already has a run in progress.');
  const run = {
    id: uid('run'),
    threadId: routine.threadId,
    assistant: assistantSnapshot(s, routine.threadId),
    messageId: null,
    routineId: routine.id,
    routineTitle: routine.title,
    instructions: routine.instructions,
    ...(routine.skill ? { skill: structuredClone(routine.skill) } : {}),
    execution: routine.execution || 'assistant',
    routineVersion: routine.version,
    notification: routine.notification,
    trigger,
    scheduledFor,
    ...(mail
      ? {
          mailSource: mailSnapshot(mail),
          connectionGeneration: mail.providerId ? s.connections.google.generation : null,
        }
      : {}),
    status: 'queued',
    createdAt: new Date(now).toISOString(),
    partial: '',
    leaseUntil: 0,
  };
  s.runs.push(run);
  routine.lastRunId = run.id;
  const old = s.runs
    .filter((r) => r.routineId === routine.id && terminal.has(r.status))
    .slice(0, -19);
  const oldIds = new Set(old.map((r) => r.id));
  s.runs = s.runs.filter((r) => !oldIds.has(r.id));
  return run;
}
export function routineCommand(s, action, p, now = Date.now(), { reminderAt } = {}) {
  routineState(s);
  const existing = action === 'routine.create' ? undefined : s.routines.find((r) => r.id === p.id);
  if (action !== 'routine.create' && !existing) throw new Error('Routine was not found.');
  if (action === 'routine.create' || action === 'routine.update') {
    if (existing?.archived) throw new Error('Restore this routine before editing it.');
    if (!existing && s.routines.filter((r) => !r.archived).length >= 50)
      throw new Error('Pause or archive an existing routine before adding more than 50.');
    const values = { ...existing, ...p };
    const title = text(values.title, 'Routine title', 100);
    const skill =
      p.skillId !== undefined
        ? p.skillId
          ? skillSnapshot(s, p.skillId)
          : null
        : existing?.skill || null;
    const instructions =
      skill && !values.instructions?.trim() ? '' : text(values.instructions, 'Instructions', 6000);
    const execution = values.execution || 'assistant';
    if (!['assistant', 'reminder'].includes(execution))
      throw new Error('Choose assistant work or a reminder.');
    if (skill && execution === 'reminder') throw new Error('Skills need an assistant routine.');
    const thread = s.threads.find((t) => t.id === values.threadId && !t.archived);
    if (!thread) throw new Error('Choose an available conversation.');
    if (thread.participantIds)
      throw new Error('Choose one assistant’s conversation for this routine.');
    if (
      p.skillId &&
      !assistantSkills(s, threadAssistantId(s, thread.id)).some((skill) => skill.id === p.skillId)
    )
      throw new Error(
        'Enable this skill in the assistant profile before using it in a new routine.',
      );
    const schedule = validateSchedule(values.schedule);
    // Only the host's relative-reminder path supplies this exact instant. It
    // preserves seconds and the second occurrence of a daylight-saving fold.
    if (reminderAt !== undefined) {
      if (
        execution !== 'reminder' ||
        schedule.kind !== 'once' ||
        !Number.isSafeInteger(reminderAt) ||
        Math.abs(reminderAt) > 8.64e15
      )
        throw new Error('Choose a valid reminder instant.');
      const local = parts(reminderAt, schedule.timeZone);
      const date = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
      const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
      if (date !== schedule.date || time !== schedule.time)
        throw new Error('The reminder instant does not match its displayed time.');
      schedule.at = reminderAt;
    }
    if (schedule.kind === 'email' && execution === 'reminder')
      throw new Error('Use an assistant routine for incoming email.');
    const next = reminderAt ?? nextOccurrence(schedule, now);
    if (schedule.kind === 'once' && next === null) throw new Error('Choose a future time.');
    if (!['changed', 'all', 'errors'].includes(values.notification || 'changed'))
      throw new Error('Choose a supported notification setting.');
    const routine = existing || {
      id: uid('routine'),
      createdAt: new Date(now).toISOString(),
      paused: true,
      archived: false,
    };
    Object.assign(routine, {
      title,
      instructions,
      skill,
      threadId: thread.id,
      schedule,
      execution,
      notification: execution === 'reminder' ? 'all' : values.notification || 'changed',
      version: (existing?.version || 0) + 1,
      updatedAt: new Date(now).toISOString(),
      nextRunAt: next,
    });
    // Finishing a one-time reminder stops its old schedule automatically.
    // Moving that reminder to a new time re-enables it; an owner pause is kept.
    if (existing?.pausedBySchedule && execution === 'reminder') routine.paused = false;
    routine.pausedBySchedule = false;
    if (existing && routine.reminderRelative) routine.reminderRelative = false;
    // A pending fixed-text delivery must not outlive an edit. Ordinary
    // assistant work retains its accepted snapshot and continues normally.
    if (existing)
      for (const run of s.runs.filter(
        (r) => r.routineId === routine.id && r.execution === 'reminder' && !terminal.has(r.status),
      ))
        Object.assign(run, {
          status: 'cancelled',
          finishedAt: new Date(now).toISOString(),
          partial: '',
        });
    // Editing an email rule establishes a fresh baseline; already accepted runs keep their snapshots.
    if (schedule.kind === 'email') resetMailTrigger(routine);
    if (!existing) s.routines.unshift(routine);
    return routine;
  }
  if (action === 'routine.test') {
    if (existing.archived || !s.threads.some((t) => t.id === existing.threadId && !t.archived))
      throw new Error('Restore the routine and its conversation before running it.');
    const mail = existing.schedule.kind === 'email' ? s.mail.find((m) => m.id === p.mailId) : null;
    if (existing.schedule.kind === 'email' && !matchesMail(existing.schedule, mail))
      throw new Error('Choose an inbox email that matches this trigger.');
    return queueRoutine(s, existing, 'test', now, null, mail);
  }
  if (action === 'routine.reveal') {
    const run = s.runs.find((r) => r.id === p.runId && r.routineId === existing.id);
    if (!run?.result) throw new Error('This run has no saved result.');
    const old = s.messages.find((m) => m.routineRunId === run.id);
    if (old) return old;
    const message = {
      id: uid('message'),
      threadId: run.threadId,
      role: 'assistant',
      ...structuredClone(run.result),
      routineId: existing.id,
      routineTitle: run.routineTitle,
      routineRunId: run.id,
      createdAt: new Date(now).toISOString(),
    };
    s.messages.push(message);
    return message;
  }
  if (action === 'routine.pause') {
    existing.paused = true;
    existing.pausedBySchedule = false;
    if (existing.execution === 'reminder') {
      for (const run of s.runs.filter(
        (r) => r.routineId === existing.id && !terminal.has(r.status),
      ))
        Object.assign(run, {
          status: 'cancelled',
          finishedAt: new Date(now).toISOString(),
          partial: '',
        });
    }
    return existing;
  }
  if (action === 'routine.resume') {
    if (existing.archived || !s.threads.some((t) => t.id === existing.threadId && !t.archived))
      throw new Error('Restore the routine and its conversation before enabling it.');
    if (existing.schedule.kind === 'email') {
      if (!s.connections.google.connected)
        throw new Error('Connect Google in Settings before enabling an email trigger.');
      resetMailTrigger(existing);
      existing.paused = false;
      if (s.connections.google.mailTrigger) {
        s.connections.google.mailTrigger.nextPollAt = 0;
        s.connections.google.mailTrigger.failures = 0;
        s.connections.google.mailTrigger.error = '';
      }
      return existing;
    }
    const next = nextOccurrence(existing.schedule, now);
    if (next === null) throw new Error('Choose a new future time before enabling this routine.');
    existing.nextRunAt = next;
    existing.paused = false;
    existing.pausedBySchedule = false;
    return existing;
  }
  if (action === 'routine.archive') {
    existing.archived = true;
    existing.paused = true;
    existing.pausedBySchedule = false;
    for (const run of s.runs.filter((r) => r.routineId === existing.id && !terminal.has(r.status)))
      Object.assign(run, {
        status: 'cancelled',
        finishedAt: new Date(now).toISOString(),
        partial: '',
      });
    return existing;
  }
  if (action === 'routine.restore') {
    if (s.routines.filter((r) => !r.archived).length >= 50)
      throw new Error('Archive another routine first.');
    existing.archived = false;
    existing.paused = true;
    return existing;
  }
  throw new Error('Unknown routine action.');
}
export function hasDueRoutines(s, now = Date.now()) {
  return (s.routines || []).some(
    (r) =>
      !r.paused &&
      !r.archived &&
      r.nextRunAt !== null &&
      r.nextRunAt <= now &&
      !s.runs.some((run) => run.routineId === r.id && !terminal.has(run.status)),
  );
}
export function dispatchRoutines(s, now = Date.now()) {
  for (const r of s.routines || []) {
    if (r.paused || r.archived || r.nextRunAt === null || r.nextRunAt > now) continue;
    if (!s.threads.some((t) => t.id === r.threadId && !t.archived)) {
      r.paused = true;
      continue;
    }
    if (s.runs.some((run) => run.routineId === r.id && !terminal.has(run.status))) continue;
    queueRoutine(s, r, 'schedule', now, r.nextRunAt);
    // One catch-up run, even after a long outage. Never replay a burst of missed runs.
    r.nextRunAt = nextOccurrence(r.schedule, now);
    if (r.nextRunAt === null) {
      r.paused = true;
      r.pausedBySchedule = true;
    }
  }
}
export function routineComparison(s, run, response) {
  if (
    !run.routineId ||
    run.trigger === 'test' ||
    run.execution === 'reminder' ||
    run.notification !== 'changed' ||
    response.question ||
    response.handoffWaiting ||
    response.cards?.length ||
    typeof response.text !== 'string' ||
    !response.text.trim() ||
    response.text.length > 12000
  )
    return null;
  const routine = (s.routines || []).find((r) => r.id === run.routineId);
  if (
    !routine ||
    routine.version !== run.routineVersion ||
    routine.lastSurfacedVersion !== run.routineVersion ||
    !routine.lastSurfacedResult
  )
    return null;
  let previous;
  try {
    previous = JSON.parse(routine.lastSurfacedResult);
  } catch {
    return null;
  }
  if (
    typeof previous.text !== 'string' ||
    !previous.text.trim() ||
    previous.text.length > 12000 ||
    previous.cards?.length
  )
    return null;
  const current = JSON.stringify({ text: response.text, cards: response.cards || [] });
  if (current === routine.lastSurfacedResult || current === routine.lastResult) return null;
  return { previous: routine.lastSurfacedResult, current, version: run.routineVersion };
}
export function finishRoutine(s, run, response, error = '', review = null) {
  run.finishedAt = new Date().toISOString();
  run.result = { text: response.text, cards: response.cards || [] };
  const routine = (s.routines || []).find((r) => r.id === run.routineId);
  const signature = JSON.stringify(run.result);
  const changed =
    (signature !== routine?.lastResult ||
      (routine?.lastResultVersion != null && routine.lastResultVersion !== run.routineVersion)) &&
    !(
      routine?.lastSurfacedVersion === run.routineVersion &&
      signature === routine?.lastSurfacedResult
    );
  const comparison = !error && routineComparison(s, run, response);
  const checked =
    comparison &&
    review &&
    ['previous', 'current', 'version'].every((key) => comparison[key] === review[key]);
  if (checked) run.resultReview = review;
  const repeated = checked && review.decision === 'unchanged';
  run.surfaced =
    !!response.question ||
    !!error ||
    run.trigger === 'test' ||
    run.notification === 'all' ||
    (run.notification === 'changed' && changed && !repeated);
  if (routine && !error) {
    routine.lastResult = signature;
    routine.lastResultVersion = run.routineVersion;
  }
  if (routine && !error && run.surfaced) {
    routine.lastSurfacedResult = signature;
    routine.lastSurfacedVersion = run.routineVersion;
  }
  if (run.surfaced && s.profile.notifications)
    s.notifications.unshift({
      id: uid('notice'),
      title: error ? `Routine needs attention: ${run.routineTitle}` : run.routineTitle,
      body: response.text.slice(0, 180),
      link: 'routines',
      runId: run.id,
      category: error ? 'error' : 'result',
      assistantId: run.assistant?.id || 'relay',
      read: false,
      createdAt: run.finishedAt,
    });
  return run.surfaced;
}
