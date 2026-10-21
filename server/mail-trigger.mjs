// SPDX-License-Identifier: MIT
import { uid } from '../shared/seed.mjs';
import { activeMailRoutines, matchesMail } from '../shared/mail-triggers.mjs';
import { queueRoutine } from '../shared/routines.mjs';
import { parseGoogleMessage } from './google.mjs';

const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const historyId = (id) => {
  if (!/^\d+$/.test(String(id))) throw new Error('Google returned an invalid mailbox cursor.');
  return String(id);
};
const newer = (a, b) => BigInt(historyId(a)) > BigInt(historyId(b));
function notice(s, r, message, now) {
  r.paused = true;
  r.eventError = message;
  s.messages.push({
    id: uid('message'),
    threadId: r.threadId,
    role: 'assistant',
    text: `“${r.title}” is paused. ${message}`,
    cards: [{ kind: 'workspace', page: 'routines' }],
    createdAt: new Date(now).toISOString(),
  });
  if (s.profile.notifications)
    s.notifications.unshift({
      id: uid('notice'),
      title: `Email trigger needs attention: ${r.title}`,
      body: message,
      link: 'routines',
      read: false,
      createdAt: new Date(now).toISOString(),
    });
}
// Each history page and its accepted runs commit atomically. A restart retries the
// uncommitted page; per-rule high-water marks prevent replay of earlier pages.
export class MailTriggerPoller {
  constructor(store, google, { intervalMs = 60000, now = Date.now } = {}) {
    this.store = store;
    this.google = google;
    this.intervalMs = intervalMs;
    this.now = now;
    this.running = false;
  }
  due() {
    const s = this.store.read();
    return (
      !this.running &&
      s.connections.google.connected &&
      activeMailRoutines(s).length > 0 &&
      (s.connections.google.mailTrigger?.nextPollAt || 0) <= this.now()
    );
  }
  async poll(signal) {
    if (this.running) return;
    this.running = true;
    const initial = this.store.read();
    const generation = initial.connections.google.generation;
    const targets = activeMailRoutines(initial);
    const current = (s, saved) =>
      activeMailRoutines(s).find(
        (r) =>
          r.id === saved.id && r.version === saved.version && r.eventEpoch === saved.eventEpoch,
      );
    const connected = (s) =>
      s.connections.google.connected && s.connections.google.generation === generation;
    try {
      if (!connected(initial) || !targets.length) return;
      if (!this.google.configured)
        throw new Error('Restore the Google credentials in your Relay server configuration.');
      let cursor = initial.connections.google.mailTrigger || {};
      if (!cursor.historyId || targets.some((r) => !r.eventCursor)) {
        const profile = await this.google.request(`${gmail}/profile`);
        signal?.throwIfAborted();
        const baseline = historyId(profile.historyId);
        this.store.mutate((s) => {
          if (!connected(s)) return;
          for (const saved of targets) {
            const r = current(s, saved);
            if (r && !saved.eventCursor) r.eventCursor = baseline;
          }
          s.connections.google.mailTrigger ??= { historyId: baseline };
          s.connections.google.mailTrigger.historyId ||= baseline;
        });
        if (!connected(this.store.read())) return;
        cursor = this.store.read().connections.google.mailTrigger;
      }
      const query = new URLSearchParams({
        startHistoryId: cursor.historyId,
        historyTypes: 'messageAdded',
        maxResults: '100',
      });
      if (cursor.pageToken) query.set('pageToken', cursor.pageToken);
      let page;
      try {
        page = await this.google.request(`${gmail}/history?${query}`);
      } catch (error) {
        if (error.status !== 404) throw error;
        this.store.mutate((s) => {
          if (!connected(s)) return;
          for (const saved of targets) {
            const r = current(s, saved);
            if (r)
              notice(
                s,
                r,
                'Gmail’s history expired. Review your inbox for missed mail, then enable this trigger to start from new arrivals.',
                this.now(),
              );
          }
          delete s.connections.google.mailTrigger;
        });
        return;
      }
      signal?.throwIfAborted();
      const end = historyId(page.historyId);
      const records = (page.history || []).map((record) => ({
        ...record,
        id: historyId(record.id),
      }));
      const messages = new Map();
      for (const record of records)
        for (const added of record.messagesAdded || []) {
          const id = added.message?.id;
          if (!id || messages.has(id)) continue;
          signal?.throwIfAborted();
          try {
            const raw = await this.google.request(
              `${gmail}/messages/${encodeURIComponent(id)}?format=full`,
            );
            const labels = raw.labelIds || [];
            messages.set(
              id,
              labels.includes('INBOX') &&
                !labels.some((l) => ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(l))
                ? parseGoogleMessage(raw)
                : null,
            );
          } catch (error) {
            if (error.status !== 404) throw error; // Retry the entire uncommitted page on transient errors.
            messages.set(id, null); // Deleted before it could be read.
          }
        }
      signal?.throwIfAborted();
      this.store.mutate((s) => {
        if (!connected(s)) return;
        for (const saved of targets) {
          const r = current(s, saved);
          if (!r?.eventCursor) continue;
          for (const record of records) {
            if (!newer(record.id, r.eventCursor)) continue;
            for (const added of record.messagesAdded || []) {
              const mail = messages.get(added.message?.id);
              if (!mail || !matchesMail(r.schedule, mail) || r.eventSeen?.includes(mail.providerId))
                continue;
              if (
                s.runs.filter(
                  (run) => run.routineId === r.id && ['queued', 'running'].includes(run.status),
                ).length >= 20
              ) {
                notice(
                  s,
                  r,
                  'More than 20 matching emails arrived before the work finished. Accepted runs are saved; review your inbox for the remaining mail and narrow the filter before enabling again.',
                  this.now(),
                );
                break;
              }
              queueRoutine(s, r, 'email', this.now(), null, mail);
              r.eventSeen = [...(r.eventSeen || []), mail.providerId].slice(-500);
              const old = s.mail.find((m) => m.id === mail.id);
              if (old) Object.assign(old, mail, { attachmentIds: old.attachmentIds });
              else s.mail.unshift(mail);
            }
            r.eventCursor = record.id;
            if (r.paused) break;
          }
          if (!page.nextPageToken && newer(end, r.eventCursor)) r.eventCursor = end;
        }
        s.mail = s.mail.slice(0, 250);
        s.connections.google.mailTrigger = {
          historyId: page.nextPageToken ? cursor.historyId : end,
          pageToken: page.nextPageToken || '',
          nextPollAt: this.now() + (page.nextPageToken ? 1000 : this.intervalMs),
          lastCheckedAt: new Date(this.now()).toISOString(),
          error: '',
          failures: 0,
        };
      });
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.store.mutate((s) => {
        if (!connected(s)) return;
        const state = (s.connections.google.mailTrigger ||= {});
        state.failures = (state.failures || 0) + 1;
        state.error = error.message;
        state.nextPollAt =
          this.now() + Math.min(900000, this.intervalMs * 2 ** Math.min(state.failures - 1, 4));
        // Persistent failures must be visible in chat, rather than retrying silently forever.
        if (state.failures >= 3)
          for (const saved of targets) {
            const r = current(s, saved);
            if (r)
              notice(
                s,
                r,
                `Mail checks failed three times: ${error.message} Fix the connection, then enable this trigger again.`,
                this.now(),
              );
          }
      });
    } finally {
      this.running = false;
    }
  }
}
