// SPDX-License-Identifier: MIT
export function validateMailTrigger(value) {
  const sender = String(value.sender || '')
    .trim()
    .toLowerCase();
  const subject = String(value.subject || '').trim();
  if (sender && (!/^[^\s<>@*]+@[^\s<>@*]+\.[^\s<>@*]+$/.test(sender) || sender.length > 254))
    throw new Error('Enter one complete sender email address.');
  if (subject.length > 200) throw new Error('Keep the subject filter under 200 characters.');
  if (!sender && subject.length < 3)
    throw new Error('Choose a sender or at least three characters from the subject.');
  return { kind: 'email', sender, subject };
}
export function matchesMail(trigger, mail) {
  return (
    mail?.folder === 'inbox' &&
    (!trigger.sender || mail.email?.toLowerCase() === trigger.sender) &&
    (!trigger.subject || mail.subject?.toLowerCase().includes(trigger.subject.toLowerCase()))
  );
}
export function mailSnapshot(mail) {
  return Object.fromEntries(
    ['id', 'providerId', 'threadId', 'from', 'email', 'to', 'subject', 'date', 'body'].map(
      (key) => [key, String(mail[key] || '').slice(0, key === 'body' ? 25000 : 1000)],
    ),
  );
}
export function activeMailRoutines(s) {
  return (s.routines || []).filter(
    (r) =>
      r.schedule.kind === 'email' &&
      !r.paused &&
      !r.archived &&
      s.threads.some((t) => t.id === r.threadId && !t.archived),
  );
}
export function resetMailTrigger(routine) {
  routine.eventEpoch = (routine.eventEpoch || 0) + 1;
  routine.eventCursor = null;
  routine.eventSeen = [];
  routine.eventError = '';
}
// A reconnect must never silently move an enabled rule to another mailbox.
export function disconnectMailRoutines(s) {
  for (const r of s.routines || []) {
    if (r.schedule.kind !== 'email' || r.archived) continue;
    r.paused = true;
    resetMailTrigger(r);
    r.eventError = 'The Google account changed. Check the account, then enable this trigger again.';
  }
  for (const run of s.runs) {
    if (
      run.mailSource &&
      run.connectionGeneration != null &&
      ['queued', 'running'].includes(run.status)
    ) {
      Object.assign(run, {
        status: 'cancelled',
        partial: '',
        leaseUntil: 0,
        finishedAt: new Date().toISOString(),
        error: 'The Google account changed.',
      });
    }
  }
}
