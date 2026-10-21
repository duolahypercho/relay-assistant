// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { routineCommand, validateSchedule } from '../shared/routines.mjs';
import { routineCreationRequested } from './routine-completion.mjs';

export function reminderRequested(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const request = text.trim().replace(/^(?:please\s+|(?:can|could|would) you\s+)+/i, '');
  if (/\b(?:example|in chat only|do not|don't)\b/i.test(request)) return false;
  if (/^remind me (?:in|at|on|to)\s+(?:what|which|whom|whose|where|whether)\b/i.test(request))
    return false;
  return (
    /^remind me (?:to\b|in\b|at\b|on\b|tomorrow\b|every\b|daily\b|weekly\b)/i.test(request) ||
    /^(?:请|請)?(?:(?:[一二三四五六七八九十\d]+(?:分钟|分鐘|小时|小時|天)(?:后|後))|明天|每天|每周|每週)?提醒我(?!之前|刚才|剛才|上次|曾经|曾經|当时|當時|说过|說過|什么是|什麼是)/.test(
      request,
    )
  );
}

export function uniqueReminderCards(cards) {
  const seen = new Set();
  return cards.filter((card) => {
    if (card.kind !== 'reminder') return true;
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
}

// The model can take longer than the requested delay. A reminder-only result
// uses current saved state rather than repeating a stale relative-time promise.
export function reminderConfirmation(s, run, cards, calls, now = Date.now()) {
  if (cards.length !== 1 || cards[0].kind !== 'reminder') return null;
  if (
    calls.some(
      (name) =>
        !['create_reminder', 'create_routine', 'list_routines', 'load_tools'].includes(name),
    )
  )
    return null;
  const sourceId = run.activeMessageId || run.messageId;
  const source = s.messages.find((m) => m.id === sourceId && m.role === 'user');
  if (!reminderRequested(source?.text) && !routineCreationRequested(source?.text)) return null;
  const r = s.routines.find(
    (r) =>
      r.id === cards[0].id &&
      r.creation?.sourceMessageId === sourceId &&
      r.threadId === run.threadId,
  );
  if (!r || r.execution !== 'reminder') return null;
  const chinese = /[\u3400-\u9fff]/.test(source.text);
  if (r.archived) return chinese ? '提醒已取消。' : 'Reminder cancelled.';
  const completed =
    r.schedule.kind === 'once' &&
    r.nextRunAt === null &&
    s.runs.some(
      (run) =>
        run.routineId === r.id &&
        run.routineVersion === r.version &&
        run.trigger === 'schedule' &&
        run.status === 'completed',
    );
  const late = r.schedule.kind === 'once' && Date.parse(r.createdAt) > r.schedule.at;
  if (completed)
    return chinese
      ? late
        ? '安排提醒花了太久，提醒已延迟送达。'
        : '提醒已送达。'
      : late
        ? 'Scheduling took too long; your reminder arrived late.'
        : 'Your reminder has arrived.';
  const pending = s.runs.some(
    (run) => run.routineId === r.id && ['queued', 'running'].includes(run.status),
  );
  if (r.paused && !pending)
    return chinese ? '提醒已保存，目前已暂停。' : 'Reminder saved and paused.';
  if (r.schedule.kind === 'once' && r.schedule.at <= now)
    return chinese
      ? '提醒时间已到，正在等待送达。'
      : 'Your reminder is due now and waiting to be delivered.';
  return chinese ? '提醒已安排。' : 'Reminder scheduled.';
}

function localStamp(at, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function reminderDeclarations(request) {
  // Locate declarations outside quoted examples and code. Keep character
  // offsets so the actual literal is always read from the original request.
  return request.replace(
    /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*(?:`|$)|"(?:[^"\\\n]|\\[^\n])*(?:"|$)|(?<!\w)'(?:[^'\n]|(?<=\w)'(?=\w))*(?:'(?!\w)|$)|“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)|「[^」\n]*(?:」|$)|『[^』\n]*(?:』|$)|^[ \t]*>.*$/gm,
    (value) => ' '.repeat(value.length),
  );
}

export function exactReminderTitle(request) {
  if (typeof request !== 'string') return null;
  const declarations = reminderDeclarations(request);
  if (
    [...declarations.matchAll(/\breminder (?:called|named|titled)\b/gi)].length !== 1 ||
    /\b(?:another|second|third) reminder\b/i.test(declarations)
  )
    return null;
  const prefix = request
    .trim()
    .match(
      /^(?:(?:please|can you|could you|would you)\s+)*(?:create|save|set up|schedule) (?:a |an )?(?:(?:new|daily|weekly|recurring|one-time) )?reminder (?:called|named|titled)\s+/i,
    );
  if (!prefix) return null;
  const rest = request.trim().slice(prefix[0].length);
  const quote = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' }[rest[0]];
  if (quote) {
    const end = rest.indexOf(quote, 1);
    if (end <= 1 || /[\\\r\n]/.test(rest.slice(1, end))) return null;
    return /^(?:\s+at\b|[.!?](?:\s|$)|$)/i.test(rest.slice(end + 1)) ? rest.slice(1, end) : null;
  }
  // An unquoted name needs an explicit clock time and IANA zone to establish
  // its boundary. Never split an ordinary name at an arbitrary word "at".
  const scheduled = rest.match(
    /^(.*?) at (\d{1,2}):(\d{2}) in ([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)(?:[.!?](?:\s|$)|$)/i,
  );
  if (!scheduled || !scheduled[1].trim() || +scheduled[2] > 23 || +scheduled[3] > 59) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: scheduled[4] }).format();
  } catch {
    return null;
  }
  return scheduled[1].trim();
}

export function exactReminderText(request) {
  if (typeof request !== 'string') return null;
  const declarations = reminderDeclarations(request);
  const clauses = [
    ...declarations.matchAll(
      /(?:use (?:the )?reminder text exactly|提醒内容请只写|提醒內容請只寫)\s*[:：]/gi,
    ),
  ];
  const natural = [
    ...declarations.matchAll(/(?:^|[.!?;]\s+|\n\s*)(?:its|the) reminder text is\b/gi),
  ];
  if (clauses.length ? clauses.length !== 1 : natural.length !== 1) return null;
  const match = clauses[0] || natural[0];
  const text = request.slice(match.index + match[0].length).trim();
  if (!text || /[\r\n]/.test(text)) return null;
  // The explicit trailing form retains every supplied punctuation mark.
  if (clauses.length) return text;

  // A quoted literal has an exact boundary. For an unquoted declaration we
  // recognize only the separate pause-control sentence, never split at an
  // arbitrary period (which could occur in names, URLs or decimal numbers).
  const pause =
    /^(?:start|keep|leave) (?:it|this reminder) paused(?: (?:so I can enable it later|for now))?\.?$/i;
  const quoted = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' }[text[0]];
  if (quoted) {
    const end = text.indexOf(quoted, 1);
    if (end <= 1 || text.slice(1, end).includes('\\')) return null;
    const after = text
      .slice(end + 1)
      .trim()
      .replace(/^\.\s*/, '');
    return !after || pause.test(after) ? text.slice(1, end) : null;
  }
  const boundaries = [
    ...text.matchAll(/\.\s+(?=(?:start|keep|leave) (?:it|this reminder) paused\b)/gi),
  ];
  if (boundaries.length !== 1) return null;
  const boundary = boundaries[0];
  const literal = text.slice(0, boundary.index).trim();
  return literal && pause.test(text.slice(boundary.index + boundary[0].length)) ? literal : null;
}

export function reminderSchedule(s, input, source) {
  const relative = input.delayMinutes !== undefined;
  if (relative === (input.schedule !== undefined))
    throw new Error('Choose delayMinutes or a schedule, not both.');
  if (relative) {
    if (
      !Number.isInteger(input.delayMinutes) ||
      input.delayMinutes < 1 ||
      input.delayMinutes > 525600
    )
      throw new Error('Choose a delay from 1 minute to one year.');
    const requestedAt = Date.parse(source.createdAt);
    if (!Number.isFinite(requestedAt))
      throw new Error('The request time is unavailable. Choose an explicit date and time.');
    const reminderAt = requestedAt + input.delayMinutes * 60000;
    const timeZone = s.profile.timeZone || 'UTC';
    return {
      reminderAt,
      schedule: { kind: 'once', ...localStamp(reminderAt, timeZone), timeZone },
    };
  }
  if (!input.schedule || !['once', 'daily', 'weekly'].includes(input.schedule.kind))
    throw new Error('Use a one-time, daily or weekly reminder schedule.');
  return {
    schedule: validateSchedule({
      ...input.schedule,
      timeZone: input.schedule.timeZone || s.profile.timeZone,
    }),
  };
}

// Runs inside one Store mutation. No model call, external account or delivery
// permission is required to store an owner-requested fixed-text reminder.
export function createReminder(s, input, { threadId, sourceMessageId, runId, now = Date.now() }) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['title', 'text', 'delayMinutes', 'schedule', 'paused'].includes(key),
    )
  )
    throw new Error('Use reminder text and either delayMinutes or a schedule.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 6000)
    throw new Error('Reminder text must contain 1–6000 characters.');
  if (input.paused !== undefined && typeof input.paused !== 'boolean')
    throw new Error('Paused must be true or false.');
  const source = s.messages.find(
    (m) => m.id === sourceMessageId && m.threadId === threadId && m.role === 'user',
  );
  const run = s.runs.find(
    (r) =>
      r.id === runId &&
      r.threadId === threadId &&
      (r.activeMessageId || r.messageId) === sourceMessageId,
  );
  if (!source || !run) throw new Error('A reminder needs an owner request in this conversation.');
  const text = exactReminderText(source.text || '') ?? input.text.trim();
  if (text.length > 6000) throw new Error('Reminder text must contain 1–6000 characters.');
  const relative = input.delayMinutes !== undefined;
  const { schedule, reminderAt } = reminderSchedule(s, input, source);
  const title = exactReminderTitle(source.text || '') ?? input.title ?? text.slice(0, 80);
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        title,
        text,
        schedule: relative
          ? { delayMinutes: input.delayMinutes }
          : { ...schedule, at: undefined, timeZone: input.schedule.timeZone || 'profile' },
        reminderAt,
        paused: input.paused === true,
      }),
    )
    .digest('hex');
  const existing = (s.routines || []).find(
    (r) =>
      r.creation?.sourceMessageId === sourceMessageId &&
      r.threadId === threadId &&
      r.reminderSignature === signature,
  );
  // A retry never re-enables a reminder the owner has since paused or archived.
  if (existing) return existing;
  const routine = routineCommand(
    s,
    'routine.create',
    {
      title,
      instructions: text,
      execution: 'reminder',
      schedule,
      threadId,
    },
    now,
    { reminderAt },
  );
  routine.paused = input.paused === true;
  routine.creation = { runId, sourceMessageId };
  routine.reminderSignature = signature;
  routine.reminderRelative = relative;
  return routine;
}
