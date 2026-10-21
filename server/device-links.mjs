// SPDX-License-Identifier: MIT
import { createHash, randomBytes, randomUUID } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const validToken = /^[A-Za-z0-9_-]{43}$/;
const lifetime = 5 * 60000;
const sessionLifetime = 7 * 86400000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// A link grants one new owner session, not an account or a copy of the owner key.
// Tokens are returned once, kept only as hashes in SQLite and never put in state.
export class DeviceLinks {
  constructor(store, config, { now = Date.now } = {}) {
    this.db = store.db;
    this.now = now;
    this.origin = '';
    try {
      const url = new URL(config.publicUrl);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      )
        this.origin = url.origin;
    } catch {
      /* Public HTTPS must be explicitly configured. */
    }
    this.authority = config.accessKey ? hash(config.accessKey) : '';
    this.enabled = !!this.origin && !!this.authority;
    this.attempts = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS device_links (
      id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, origin TEXT NOT NULL, authority TEXT NOT NULL,
      expires INTEGER NOT NULL, created INTEGER NOT NULL, session_digest TEXT, issuer TEXT NOT NULL DEFAULT ''
    ); CREATE TABLE IF NOT EXISTS paired_devices (
      id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL
    );`);
    if (
      !this.db
        .prepare('PRAGMA table_info(device_links)')
        .all()
        .some((column) => column.name === 'issuer')
    )
      this.db.exec("ALTER TABLE device_links ADD COLUMN issuer TEXT NOT NULL DEFAULT ''");
  }
  issuerValid(cookie) {
    const session = this.db
      .prepare('SELECT expires FROM sessions WHERE digest=?')
      .get(hash(cookie || ''));
    return !!session && session.expires > this.now();
  }
  prune() {
    const now = this.now();
    this.db
      .prepare(
        'DELETE FROM paired_devices WHERE digest NOT IN (SELECT digest FROM sessions WHERE expires>?)',
      )
      .run(now);
    this.db
      .prepare(
        'DELETE FROM device_links WHERE (session_digest IS NULL AND (expires<=? OR issuer NOT IN (SELECT digest FROM sessions WHERE expires>?))) OR (session_digest IS NOT NULL AND session_digest NOT IN (SELECT digest FROM sessions WHERE expires>?))',
      )
      .run(now, now, now);
  }
  list(cookie = '') {
    this.prune();
    return {
      available: this.enabled,
      server: this.origin,
      pending:
        this.db
          .prepare(
            'SELECT id, expires FROM device_links WHERE session_digest IS NULL AND origin=? AND authority=?',
          )
          .get(this.origin, this.authority) || null,
      devices: this.db
        .prepare(
          'SELECT p.id,p.name,p.created,s.expires,p.digest FROM paired_devices p JOIN sessions s ON s.digest=p.digest ORDER BY p.created DESC',
        )
        .all()
        .map(({ digest, ...device }) => ({ ...device, current: digest === hash(cookie) })),
    };
  }
  create(cookie = '') {
    if (!this.enabled)
      throw fail(
        'Set a public HTTPS address and owner access key on your Relay server first.',
        409,
      );
    if (!this.issuerValid(cookie))
      throw fail('Sign in again before creating a connection link.', 401);
    this.prune();
    if (this.db.prepare('SELECT count(*) AS n FROM paired_devices').get().n >= 20)
      throw fail('Disconnect an older device before connecting another.', 409);
    const token = randomBytes(32).toString('base64url'),
      id = randomUUID(),
      now = this.now(),
      expires = now + lifetime;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM device_links WHERE session_digest IS NULL').run();
      this.db
        .prepare(
          'INSERT INTO device_links (id,digest,origin,authority,expires,created,session_digest,issuer) VALUES (?,?,?,?,?,?,NULL,?)',
        )
        .run(id, hash(token), this.origin, this.authority, expires, now, hash(cookie));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, expires, url: `${this.origin}/#connect=${token}` };
  }
  cancel(id) {
    this.db
      .prepare('DELETE FROM device_links WHERE id=? AND session_digest IS NULL')
      .run(String(id));
    return { ok: true };
  }
  redeem(token, name, cookie, ip) {
    const now = this.now(),
      prior = this.attempts.get(ip);
    if (prior?.until > now && prior.count >= 12)
      throw fail('Too many attempts. Try again in a minute.', 429);
    // Bound this unauthenticated limiter even with many independent addresses.
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    if (this.attempts.size >= 2000 && !this.attempts.has(ip))
      throw fail('Try again in a minute.', 429);
    const reject = () => {
      this.attempts.set(ip, {
        count: (prior?.until > now ? prior.count : 0) + 1,
        until: now + 60000,
      });
      throw fail(
        'This connection link is expired, cancelled or already used. Create a new link on your connected device.',
        400,
      );
    };
    if (!this.enabled || typeof token !== 'string' || !validToken.test(token)) return reject();
    const entry = this.db.prepare('SELECT * FROM device_links WHERE digest=?').get(hash(token));
    if (!entry || entry.origin !== this.origin || entry.authority !== this.authority)
      return reject();
    if (entry.session_digest) {
      const saved = this.db
        .prepare('SELECT expires FROM sessions WHERE digest=?')
        .get(entry.session_digest);
      if (cookie && hash(cookie) === entry.session_digest && saved?.expires > now)
        return { repeated: true };
      return reject();
    }
    const issuer = this.db.prepare('SELECT expires FROM sessions WHERE digest=?').get(entry.issuer);
    if (entry.expires <= now || !issuer || issuer.expires <= now) return reject();
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 60 || /[\x00-\x1f\x7f]/.test(label))
      throw fail('Choose a short name for this device.');
    const session = randomBytes(32).toString('base64url'),
      digest = hash(session),
      id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const used = this.db
        .prepare(
          'UPDATE device_links SET session_digest=? WHERE id=? AND session_digest IS NULL AND expires>?',
        )
        .run(digest, entry.id, now);
      if (used.changes !== 1)
        throw fail('This connection link was already used. Create a new link.', 409);
      if (cookie) this.db.prepare('DELETE FROM sessions WHERE digest=?').run(hash(cookie));
      this.db
        .prepare('INSERT INTO sessions (digest,expires) VALUES (?,?)')
        .run(digest, now + sessionLifetime);
      this.db.prepare('INSERT INTO paired_devices VALUES (?,?,?,?)').run(id, digest, label, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.attempts.delete(ip);
    return { session, maxAge: sessionLifetime };
  }
  disconnect(id) {
    const row = this.db.prepare('SELECT digest FROM paired_devices WHERE id=?').get(String(id));
    if (row) this.db.prepare('DELETE FROM sessions WHERE digest=?').run(row.digest);
    this.prune();
    return { ok: true };
  }
}

export function publicDeviceLinkRoutes(app, links, { cookie, changed }) {
  app.post('/api/device-links/redeem', (req, res, next) => {
    try {
      const result = links.redeem(req.body?.token, req.body?.name, cookie(req), req.ip);
      if (result.session)
        res.cookie('relay_session', result.session, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: result.maxAge,
          path: '/',
        });
      changed();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
}
export function ownerDeviceLinkRoutes(app, links, { cookie, changed }) {
  app.get('/api/device-links', (req, res) => res.json(links.list(cookie(req))));
  app.post('/api/device-links', (req, res, next) => {
    try {
      res.json(links.create(cookie(req)));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/device-links/:id/cancel', (req, res) => res.json(links.cancel(req.params.id)));
  app.post('/api/devices/:id/disconnect', (req, res) => {
    const result = links.disconnect(req.params.id);
    changed();
    res.json(result);
  });
}
