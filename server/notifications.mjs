// SPDX-License-Identifier: MIT
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { encrypt, decrypt } from './google.mjs';
import {
  attentionEvents,
  attentionAllowed,
  attentionTarget,
  attentionCommand,
} from '../shared/attention.mjs';
import { PushProviders } from './push-providers.mjs';
const lifetime = 30 * 86400000;
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicDevice = ({ token, key, ...d }) => ({ ...d, hasToken: !!token });
const bounded = (v, n) =>
  typeof v === 'string' && v.length > 0 && v.length <= n && !/[\x00-\x1f]/.test(v);
export class Notifications {
  constructor(store, { key, providers = new PushProviders(), clock = Date.now } = {}) {
    this.store = store;
    this.key = key;
    this.providers = providers;
    this.clock = clock;
    this.active = new Map();
    this.working = false;
    this.workspaceId = store.secret('notification-workspace-id');
    if (!this.workspaceId) {
      this.workspaceId = randomUUID();
      store.secret('notification-workspace-id', this.workspaceId);
    }
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS attention_outbox (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', UNIQUE(device_id,event_id))",
    );
    this.read();
  }
  read() {
    const v = this.store.secret('notification-devices');
    return v ? decrypt(v, this.key) : [];
  }
  write(rows) {
    this.store.secret('notification-devices', encrypt(rows, this.key));
  }
  recover() {
    this.store.db
      .prepare(
        "UPDATE attention_outbox SET status='unknown',error='Delivery was interrupted. This notification will not be repeated.' WHERE status='sending'",
      )
      .run();
  }
  status() {
    return {
      workspaceId: this.workspaceId,
      providers: this.providers.status(),
      devices: this.read().map(publicDevice),
    };
  }
  device(input) {
    const d = this.read().find((d) => d.id === input.id);
    if (!d || !same(d.key, input.key)) throw Error('Enable notifications on this device again.');
    return d;
  }
  enroll(p) {
    if (p.workspaceId !== this.workspaceId)
      throw Error('The workspace changed. Reopen notification settings.');
    if (
      !/^[a-zA-Z0-9-]{16,80}$/.test(p.id) ||
      !/^[a-f0-9]{64}$/.test(p.key) ||
      !bounded(p.name, 80) ||
      !['desktop', 'ios', 'android'].includes(p.platform) ||
      typeof p.preview !== 'boolean'
    )
      throw Error('Choose valid device notification settings.');
    if (!this.providers.status()[p.platform])
      throw Error('Push notifications need server setup for this device.');
    const rows = this.read(),
      old = rows.find((d) => d.id === p.id);
    if (old && (!same(old.key, p.key) || old.platform !== p.platform))
      throw Error('This device registration changed. Enable it again.');
    if (!old && rows.length >= 20) throw Error('Remove an old device before connecting another.');
    const token = p.token === undefined ? old?.token : p.token;
    if (p.platform === 'ios' && (!bounded(token, 512) || !/^[a-f0-9]{32,512}$/i.test(token)))
      throw Error('Apple did not return a valid device token.');
    if (p.platform === 'android' && (!bounded(token, 4096) || !/^[a-zA-Z0-9_:.-]+$/.test(token)))
      throw Error('Firebase did not return a valid device token.');
    const now = this.clock();
    const d = {
      id: p.id,
      generation: (old?.generation || 0) + 1,
      key: p.key,
      name: p.name.trim(),
      platform: p.platform,
      token: p.platform === 'desktop' ? '' : token,
      preview: p.preview,
      enabled: true,
      enrolledAt: old?.enabled ? old.enrolledAt : now,
      expiresAt: now + lifetime,
      lastSeenAt: now,
      focused: true,
      presenceAt: now,
      lastError: '',
      lastAcceptedAt: old?.lastAcceptedAt || null,
    };
    if (old) this.cancel(old.id);
    // A token identifies one native installation; replacing its registration never doubles delivery.
    this.write([
      ...rows.filter(
        (x) =>
          x.id !== d.id &&
          (d.platform === 'desktop' || x.platform !== d.platform || x.token !== d.token),
      ),
      d,
    ]);
    return { device: publicDevice(d), workspaceId: this.workspaceId };
  }
  update(p) {
    const old = this.device(p);
    if (
      (p.preview !== undefined && typeof p.preview !== 'boolean') ||
      (p.enabled !== undefined && typeof p.enabled !== 'boolean')
    )
      throw Error('Choose notification settings.');
    if (p.enabled === true && !this.providers.status()[old.platform])
      throw Error('Push notifications need server setup for this device.');
    const d = {
      ...old,
      generation: (old.generation || 0) + 1,
      ...(p.preview === undefined ? {} : { preview: p.preview }),
      ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
      ...(p.enabled === true && !old.enabled
        ? { enrolledAt: this.clock(), expiresAt: this.clock() + lifetime }
        : {}),
      lastError: '',
    };
    this.write(this.read().map((x) => (x.id === d.id ? d : x)));
    this.cancel(d.id);
    if (!d.enabled) {
      this.cancel(d.id);
      this.store.db
        .prepare(
          "UPDATE attention_outbox SET status='suppressed' WHERE device_id=? AND status='pending'",
        )
        .run(d.id);
    }
    return { device: publicDevice(d) };
  }
  forget(id) {
    if (!this.read().some((d) => d.id === id)) throw Error('This device is already disconnected.');
    this.write(this.read().filter((d) => d.id !== id));
    this.cancel(id);
    this.store.db.prepare('DELETE FROM attention_outbox WHERE device_id=?').run(id);
    return this.status();
  }
  presence(p) {
    const old = this.device(p);
    if (typeof p.focused !== 'boolean') throw Error('Choose a device presence state.');
    const now = this.clock();
    this.write(
      this.read().map((d) =>
        d.id === old.id
          ? {
              ...d,
              focused: p.focused,
              presenceAt: now,
              lastSeenAt: now,
              expiresAt: now + lifetime,
            }
          : d,
      ),
    );
    return { ok: true };
  }
  cancel(deviceId) {
    for (const a of this.active.values()) if (a.deviceId === deviceId) a.controller.abort();
  }
  queue() {
    const now = this.clock(),
      s = this.store.read(),
      events = attentionEvents(s);
    const insert = this.store.db.prepare(
      'INSERT OR IGNORE INTO attention_outbox (id,device_id,event_id,status,next_at,updated_at) VALUES (?,?,?,?,?,?)',
    );
    for (const d of this.read().filter((d) => d.enabled && d.expiresAt > now))
      for (const e of events) {
        if (Date.parse(e.createdAt) < d.enrolledAt || Date.parse(e.createdAt) < now - 3600000)
          continue;
        const suppressed =
          e.read || !attentionAllowed(s, e) || (d.focused && now - d.presenceAt < 45000);
        insert.run(randomUUID(), d.id, e.id, suppressed ? 'suppressed' : 'pending', now, now);
      }
    this.store.db
      .prepare(
        "UPDATE attention_outbox SET status='unknown',error='Delivery was interrupted. This notification will not be repeated.' WHERE status='sending' AND updated_at<?",
      )
      .run(now - 120000);
    this.store.db
      .prepare("DELETE FROM attention_outbox WHERE updated_at<? AND status!='sending'")
      .run(now - 7 * 86400000);
  }
  eligible(row) {
    const now = this.clock(),
      d = this.read().find((d) => d.id === row.device_id),
      s = this.store.read(),
      event = attentionEvents(s).find((e) => e.id === row.event_id);
    if (
      !d?.enabled ||
      d.expiresAt < now ||
      !event ||
      event.read ||
      !attentionAllowed(s, event) ||
      Date.parse(event.createdAt) < now - 3600000 ||
      (d.focused && now - d.presenceAt < 45000)
    ) {
      this.store.db
        .prepare(
          "UPDATE attention_outbox SET status='suppressed',updated_at=? WHERE id=? AND status='pending'",
        )
        .run(now, row.id);
      return null;
    }
    return { device: d, event };
  }
  claim(row) {
    return (
      this.store.db
        .prepare(
          "UPDATE attention_outbox SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(this.clock(), row.id).changes === 1
    );
  }
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      this.queue();
      const nativeIds = this.read()
        .filter((d) => d.platform !== 'desktop' && d.enabled)
        .map((d) => d.id);
      const rows = nativeIds.length
        ? this.store.db
            .prepare(
              `SELECT * FROM attention_outbox WHERE status='pending' AND next_at<=? AND device_id IN (${nativeIds.map(() => '?').join(',')}) ORDER BY next_at LIMIT 10`,
            )
            .all(this.clock(), ...nativeIds)
        : [];
      for (const row of rows) {
        const value = this.eligible(row);
        if (!value || value.device.platform === 'desktop' || !this.claim(row)) continue;
        const controller = new AbortController();
        this.active.set(row.id, { deviceId: value.device.id, controller });
        try {
          await this.providers.send(value.device, value.event, {
            id: row.id,
            workspaceId: this.workspaceId,
            signal: controller.signal,
          });
          this.store.db
            .prepare(
              "UPDATE attention_outbox SET status='accepted',updated_at=?,error='' WHERE id=?",
            )
            .run(this.clock(), row.id);
          this.write(
            this.read().map((d) =>
              d.id === value.device.id && d.generation === value.device.generation
                ? { ...d, lastAcceptedAt: this.clock(), lastError: '' }
                : d,
            ),
          );
        } catch (e) {
          const status = e.uncertain
            ? 'unknown'
            : e.retryable && row.attempts < 2
              ? 'pending'
              : 'failed';
          const message = e.uncertain
            ? 'Delivery was not confirmed. This notification will not be repeated.'
            : e.pushFailure
              ? e.message
              : 'Notification delivery failed.';
          this.store.db
            .prepare(
              'UPDATE attention_outbox SET status=?,next_at=?,updated_at=?,error=? WHERE id=?',
            )
            .run(
              status,
              this.clock() + Math.pow(2, row.attempts) * 15000,
              this.clock(),
              message,
              row.id,
            );
          this.write(
            this.read().map((d) =>
              d.id === value.device.id && d.generation === value.device.generation
                ? { ...d, ...(e.invalidDevice ? { enabled: false } : {}), lastError: message }
                : d,
            ),
          );
        } finally {
          this.active.delete(row.id);
        }
      }
    } finally {
      this.working = false;
    }
  }
  desktopPoll(p) {
    const d = this.device(p);
    if (d.platform !== 'desktop') throw Error('Use a desktop registration.');
    this.presence(p);
    this.queue();
    const result = [];
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM attention_outbox WHERE device_id=? AND status='pending' ORDER BY next_at LIMIT 3",
      )
      .all(d.id)) {
      const current = this.eligible(row);
      if (!current || !this.claim(row)) continue;
      result.push({
        receiptId: row.id,
        workspaceId: this.workspaceId,
        noticeId: row.event_id,
        title: d.preview ? current.event.title : 'Relay',
        body: d.preview ? current.event.body : 'You have an update. Open Relay to see it.',
      });
    }
    return { events: result };
  }
  desktopAck(p) {
    this.device(p);
    if (!['shown', 'suppressed', 'failed'].includes(p.status))
      throw Error('Choose a notification result.');
    const changed = this.store.db
      .prepare(
        "UPDATE attention_outbox SET status=?,updated_at=? WHERE id=? AND device_id=? AND status='sending'",
      )
      .run(p.status, this.clock(), p.receiptId, p.id).changes;
    if (changed && p.status !== 'suppressed')
      this.write(
        this.read().map((d) =>
          d.id !== p.id
            ? d
            : {
                ...d,
                lastError:
                  p.status === 'failed'
                    ? 'Your desktop could not show an alert. Check system notification settings and use a signed app build.'
                    : '',
              },
        ),
      );
    return { ok: true };
  }
  open(p) {
    if (p.workspaceId !== this.workspaceId)
      throw Error(
        'This update belongs to another Relay workspace. Reconnect to that workspace to open it.',
      );
    return this.store.mutate((s) => {
      const target = attentionTarget(s, p.noticeId);
      attentionCommand(s, { id: p.noticeId });
      return target;
    });
  }
  start() {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1500);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const a of this.active.values()) a.controller.abort();
    while (this.working) await new Promise((r) => setTimeout(r, 10));
  }
}
export function notificationRoutes(app, service) {
  const use = () => {
    if (!service) throw Error('Connect to a Relay server for device notifications.');
    return service;
  };
  app.get('/api/attention', (_req, res, next) => {
    try {
      res.json(use().status());
    } catch (e) {
      next(e);
    }
  });
  for (const action of [
    'enroll',
    'update',
    'presence',
    'desktopPoll',
    'desktopAck',
    'open',
    'forget',
  ])
    app.post(`/api/attention/${action}`, (req, res, next) => {
      try {
        res.json(use()[action](action === 'forget' ? req.body.id : req.body));
      } catch (e) {
        next(e);
      }
    });
}
