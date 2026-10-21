// SPDX-License-Identifier: MIT
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { fileBytes } from '../shared/pdf.mjs';
import { iso } from '../shared/seed.mjs';
import { disconnectMailRoutines } from '../shared/mail-triggers.mjs';
import { readableHtml } from './network.mjs';
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const calendar = 'https://www.googleapis.com/calendar/v3';
export class UncertainActionError extends Error {
  constructor() {
    super(
      'The provider may have completed this action. Check the provider before preparing another review.',
    );
    this.name = 'UncertainActionError';
  }
}
export function encrypt(value, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
export function decrypt(value, key) {
  const data = Buffer.from(value, 'base64');
  const c = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  c.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([c.update(data.subarray(28)), c.final()]).toString());
}
function decode(value = '') {
  return Buffer.from(value, 'base64url').toString('utf8');
}
function parts(part) {
  return [part, ...(part.parts || []).flatMap(parts)];
}
export function parseGoogleMessage(m) {
  const headers = Object.fromEntries(
    (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  const all = parts(m.payload || {});
  const plain = all
    .filter((p) => p.mimeType === 'text/plain' && !p.filename)
    .map((p) => decode(p.body?.data))
    .join('\n');
  const html = all
    .filter((p) => p.mimeType === 'text/html' && !p.filename)
    .map((p) => decode(p.body?.data))
    .join('\n');
  const from = headers.from || '';
  const email = from.match(/<([^>]+)>/)?.[1] || from;
  return {
    id: `google-mail-${m.id}`,
    providerId: m.id,
    threadId: m.threadId,
    from:
      from
        .replace(/<[^>]*>/, '')
        .replaceAll('"', '')
        .trim() || email,
    email,
    to: headers.to || '',
    subject: headers.subject || '(No subject)',
    body: (plain || readableHtml(html).text || m.snippet || '').slice(0, 25000),
    date: new Date(Number(m.internalDate) || Date.now()).toISOString(),
    read: !(m.labelIds || []).includes('UNREAD'),
    folder: (m.labelIds || []).includes('SENT') ? 'sent' : 'inbox',
    messageHeaderId: headers['message-id'] || '',
    attachmentIds: [],
    attachments: all
      .filter((p) => p.filename && p.body?.attachmentId)
      .map((p) => ({
        name: p.filename,
        mime: p.mimeType,
        attachmentId: p.body.attachmentId,
        size: p.body.size || 0,
      })),
  };
}
export function parseGoogleEvent(e, calendarId = 'primary') {
  return {
    id: `google-event-${e.id}`,
    providerId: e.id,
    calendarId,
    title: e.summary || '(Untitled event)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !!e.start?.date,
    timeZone: e.start?.timeZone || '',
    description: e.description || '',
    location: e.location || '',
    version: 1,
    etag: e.etag,
    recurring: !!e.recurringEventId || !!e.recurrence,
  };
}
const encodedHeader = (text) => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
export async function emailMime(payload, files, from, { messageHeaderId } = {}) {
  if (/[\r\n]/.test(payload.to) || /[\r\n]/.test(from)) throw new Error('Invalid email header.');
  const boundary = `relay_${randomBytes(16).toString('hex')}`;
  const messageId = `<${randomBytes(18).toString('hex')}@relay.local>`;
  const lines = [
    `From: ${from}`,
    `To: ${payload.to}`,
    `Subject: ${encodedHeader(payload.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  if (messageHeaderId && !/[\r\n]/.test(messageHeaderId))
    lines.push(`In-Reply-To: ${messageHeaderId}`, `References: ${messageHeaderId}`);
  lines.push(
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(payload.body)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') || '',
  );
  for (const file of files) {
    const name = file.name.replace(/["\r\n\\]/g, '_');
    const data = Buffer.from(await fileBytes(file)).toString('base64');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${file.mime.replace(/[\r\n]/g, '')}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      data.match(/.{1,76}/g)?.join('\r\n') || '',
    );
  }
  lines.push(`--${boundary}--`, '');
  return { raw: Buffer.from(lines.join('\r\n')).toString('base64url'), messageId };
}
export class GoogleConnection {
  constructor(store, config, fetcher = fetch) {
    this.store = store;
    this.config = config;
    this.fetcher = fetcher;
    this.key = config.encryptionKey ? Buffer.from(config.encryptionKey, 'base64') : null;
    if (this.key?.length !== 32) this.key = null;
    this.refreshing = null;
  }
  get configured() {
    return !!(this.config.clientId && this.config.clientSecret && this.key);
  }
  tokens() {
    const value = this.store.secret('google-tokens');
    if (!value || !this.key) return null;
    return decrypt(value, this.key);
  }
  saveTokens(tokens) {
    if (!this.key) throw new Error('Configure a 32-byte token encryption key.');
    this.store.secret('google-tokens', encrypt(tokens, this.key));
  }
  authorization(write = false) {
    if (!this.configured)
      throw new Error(
        'Google OAuth is not configured. Add the Google client and encryption key to the server environment.',
      );
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.store.secret(`oauth-${state}`, JSON.stringify({ verifier, expires: Date.now() + 600000 }));
    const scopes = [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];
    if (write)
      scopes.push(
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/calendar.events',
      );
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.href, state };
  }
  async callback(code, state) {
    const raw = this.store.secret(`oauth-${state}`);
    if (!raw) throw new Error('The connection request is no longer valid.');
    const request = JSON.parse(raw);
    this.store.secret(`oauth-${state}`, null);
    if (request.expires < Date.now()) throw new Error('The connection request expired.');
    const res = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        code,
        code_verifier: request.verifier,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const tokens = await res.json();
    if (!res.ok || !tokens.access_token) throw new Error('Google did not grant access.');
    const infoRes = await this.fetcher('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!infoRes.ok) throw new Error('The connected account could not be verified.');
    const info = await infoRes.json();
    if (!info.email || typeof info.email !== 'string')
      throw new Error('Google did not return a verified account address.');
    this.saveTokens({ ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 });
    this.store.mutate((s) => {
      disconnectMailRoutines(s);
      s.connections.google = {
        connected: true,
        email: info.email,
        generation: s.connections.google.generation + 1,
        write:
          (tokens.scope || '').includes('gmail.send') &&
          (tokens.scope || '').includes('calendar.events'),
      };
      s.mail = [];
      s.events = [];
      for (const a of s.approvals.filter((a) => a.status === 'pending')) a.status = 'rejected';
    });
    return info;
  }
  async accessToken() {
    const t = this.tokens();
    if (!t) throw new Error('Connect your Google account first.');
    if (t.expiresAt > Date.now() + 60000) return t.access_token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!t.refresh_token) throw new Error('Reconnect Google to refresh access.');
      const res = await this.fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: t.refresh_token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(15000),
      });
      const next = await res.json();
      if (!res.ok) throw new Error('Google access expired. Reconnect your account.');
      this.saveTokens({ ...t, ...next, expiresAt: Date.now() + next.expires_in * 1000 });
      return next.access_token;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
  async request(url, options = {}, write = false) {
    const token = await this.accessToken();
    let res;
    try {
      res = await this.fetcher(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (write) throw new UncertainActionError();
      throw e;
    }
    if (!res.ok) {
      if (write && res.status >= 500) throw new UncertainActionError();
      const error = new Error(
        `Google returned HTTP ${res.status}. ${res.status === 403 ? 'Check granted permissions.' : res.status === 412 ? 'The event changed. Prepare a new review.' : ''}`,
      );
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? {} : res.json();
  }
  async sync({
    query = 'in:inbox',
    timeMin = new Date().toISOString(),
    timeMax = new Date(Date.now() + 30 * 86400000).toISOString(),
    calendarId = 'primary',
    includeMail = true,
    includeCalendar = true,
  } = {}) {
    const start = new Date(timeMin),
      end = new Date(timeMax);
    if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start || end - start > 366 * 86400000)
      throw new Error('Sync a date range of up to 366 days.');
    if (
      typeof query !== 'string' ||
      query.length > 1000 ||
      typeof calendarId !== 'string' ||
      calendarId.length > 250
    )
      throw new Error('Invalid Google sync filter.');
    const generation = this.store.read().connections.google.generation;
    const mailList = includeMail
      ? await this.request(`${gmail}/messages?maxResults=25&q=${encodeURIComponent(query)}`)
      : {};
    const messages = [];
    for (const m of mailList.messages || [])
      messages.push(
        parseGoogleMessage(await this.request(`${gmail}/messages/${m.id}?format=full`)),
      );
    const calendars = includeCalendar
      ? await this.request(`${calendar}/users/me/calendarList`)
      : {};
    const events = includeCalendar
      ? await this.request(
          `${calendar}/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&maxResults=100&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&orderBy=startTime`,
        )
      : {};
    this.store.mutate((s) => {
      if (s.connections.google.generation !== generation || !s.connections.google.connected) return;
      if (includeMail) {
        s.mail = [
          ...messages.map((m) => ({
            ...m,
            attachmentIds: s.mail.find((old) => old.id === m.id)?.attachmentIds || [],
          })),
          ...s.mail.filter((m) => !messages.some((next) => next.id === m.id)),
        ].slice(0, 250);
      }
      if (includeCalendar) {
        s.events = (events.items || []).map((e) => {
          const parsed = parseGoogleEvent(e, calendarId);
          const old = s.events.find((x) => x.id === parsed.id);
          if (old) parsed.version = old.version + (old.etag === parsed.etag ? 0 : 1);
          return parsed;
        });
        s.connections.google.calendars = (calendars.items || []).map((c) => ({
          id: c.id,
          name: c.summary,
          timeZone: c.timeZone,
        }));
        s.connections.google.calendarId = calendarId;
      }
      s.connections.google.lastSync = iso();
      s.connections.google.partial = !!mailList.nextPageToken || !!events.nextPageToken;
    });
    return {
      messages: messages.length,
      mailIds: messages.map((m) => m.id),
      events: (events.items || []).length,
      partial: !!mailList.nextPageToken || !!events.nextPageToken,
    };
  }
  async readThread(id) {
    const mail = this.store.read().mail.find((m) => m.id === id);
    if (!mail?.threadId) throw new Error('This is not a Google thread.');
    const t = await this.request(
      `${gmail}/threads/${encodeURIComponent(mail.threadId)}?format=full`,
    );
    return (t.messages || []).map(parseGoogleMessage);
  }
  async importAttachment(id, attachmentId) {
    const m = this.store.read().mail.find((m) => m.id === id);
    const a = m?.attachments.find((a) => a.attachmentId === attachmentId);
    if (!a || a.size > 8000000) throw new Error('Use an attachment smaller than 8 MB.');
    const data = await this.request(
      `${gmail}/messages/${encodeURIComponent(m.providerId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return {
      name: a.name,
      mime: a.mime,
      base64: Buffer.from(data.data, 'base64url').toString('base64'),
    };
  }
  async execute(approval) {
    const s = this.store.read();
    if (
      !s.connections.google.connected ||
      approval.connectionGeneration !== s.connections.google.generation
    )
      throw new Error('The connected account changed. Prepare a new review.');
    if (!s.connections.google.write)
      throw new Error('Grant reviewed write access in Settings before approving this action.');
    if (approval.kind === 'email') {
      const p = approval.payload;
      if (p.to.endsWith('.invalid'))
        throw new Error('Sample email addresses cannot be sent through a live account.');
      const files = approval.attachments || [];
      const reply = s.mail.find((m) => m.id === p.replyTo);
      const mime = await emailMime(p, files, s.connections.google.email, reply);
      const r = await this.request(
        `${gmail}/messages/send`,
        {
          method: 'POST',
          body: JSON.stringify({
            raw: mime.raw,
            ...(reply?.threadId ? { threadId: reply.threadId } : {}),
          }),
        },
        true,
      );
      return { messageId: `google-mail-${r.id}`, detail: 'Google accepted the reviewed email.' };
    }
    if (approval.kind === 'calendar') {
      const { operation, event } = approval.payload;
      if (event.recurring) throw new Error('Change recurring events directly in Google Calendar.');
      if (operation !== 'create' && !event.providerId)
        throw new Error('Sync this event from Google before changing it.');
      const cal = event.calendarId || s.connections.google.calendarId || 'primary';
      const path = `${calendar}/calendars/${encodeURIComponent(cal)}/events${operation === 'create' ? '' : `/${encodeURIComponent(event.providerId)}`}`;
      const body = {
        summary: event.title,
        description: event.description,
        location: event.location,
        start: event.allDay ? { date: event.start } : { dateTime: event.start },
        end: event.allDay ? { date: event.end } : { dateTime: event.end },
      };
      const result = await this.request(
        path,
        {
          method: operation === 'delete' ? 'DELETE' : operation === 'create' ? 'POST' : 'PATCH',
          ...(operation !== 'delete' ? { body: JSON.stringify(body) } : {}),
          headers: event.etag ? { 'If-Match': event.etag } : {},
        },
        true,
      );
      return {
        detail: 'Google accepted the reviewed calendar change.',
        ...(operation === 'delete' ? {} : { event: parseGoogleEvent(result, cal) }),
      };
    }
    throw new Error('Unsupported Google action.');
  }
  async disconnect() {
    const t = this.tokens();
    this.store.secret('google-tokens', null);
    this.store.mutate((s) => {
      disconnectMailRoutines(s);
      s.connections.google = {
        connected: false,
        email: '',
        generation: s.connections.google.generation + 1,
      };
      for (const a of s.approvals.filter(
        (a) => a.status === 'pending' && a.connectionGeneration !== null,
      ))
        a.status = 'rejected';
      s.mail = [];
      s.events = [];
    });
    if (t)
      try {
        await this.fetcher('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        /* Local access is already removed. */
      }
  }
}
