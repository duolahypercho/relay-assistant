// SPDX-License-Identifier: MIT
import https from 'node:https';
import { randomUUID, createHmac } from 'node:crypto';
import { encrypt, decrypt } from './google.mjs';
import { resolveDestination } from './network.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const hash = (value, key) => createHmac('sha256', key).update(value).digest('hex');
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const pageResourceTypes = new Set(['Image', 'Stylesheet', 'Font', 'Script']);
const pageLoadLimits = { requests: 64, milliseconds: 30000 };
function assertAuthority(guard) {
  const result = guard();
  if (result !== undefined && result !== true) {
    if (typeof result?.catch === 'function') result.catch(() => {});
    throw fail('Browser control is no longer authorized.');
  }
}
function waitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      reject(signal.reason);
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Copy before the first await: a review must never authorize mutable caller data. */
function snapshot(input) {
  if (!input || !methods.has(input.method)) throw fail('This website protocol is unsupported.');
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw fail('Enter a complete HTTPS website address.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw fail('Private browser requests require HTTPS without credentials in the address.');
  url.hash = '';
  if (url.href.length > 8192) throw fail('The website address exceeds the browser limit.', 413);
  if (input.body != null && !(input.body instanceof Uint8Array))
    throw fail('The website request body must contain bytes.');
  if ((input.body?.byteLength || 0) > 8_000_000)
    throw fail('The website request exceeds the browser limit.', 413);
  const headers = Object.create(null);
  let headerBytes = 0;
  for (const [name, value] of Object.entries(input.headers || {})) {
    const lower = name.toLowerCase();
    if (
      !headerName.test(name) ||
      typeof value !== 'string' ||
      /[^\t\x20-\x7e\x80-\xff]/.test(value) ||
      Object.hasOwn(headers, lower)
    )
      throw fail('This website request has invalid headers.');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 64000) throw fail('The website request exceeds the browser limit.', 413);
    headers[lower] = value;
  }
  // A client must not choose connection framing or smuggle a second authority.
  const connectionFields = (headers.connection || '').split(',').map((s) => s.trim().toLowerCase());
  for (const name of Object.keys(headers)) {
    if (
      connectionFields.includes(name) ||
      /^(?:host|connection|content-length|accept-encoding|proxy-.*|referer|upgrade|te|trailer|transfer-encoding|keep-alive)$/i.test(
        name,
      )
    )
      delete headers[name];
  }
  return {
    url: url.href,
    method: input.method,
    headers,
    body: input.body ? Buffer.from(input.body) : undefined,
  };
}

/** One concrete HTTP request, with DNS pinned for that connection. No implicit
 * redirect or retry: each redirect becomes another browser request/policy decision.
 */
export async function pinnedBrowserRequest(
  input,
  {
    resolver = resolveDestination,
    signal,
    ca,
    maxBytes = 8_000_000,
    timeoutMs = 20000,
    beforeSend = () => {},
  } = {},
) {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(fail('The website took too long to respond.', 504)),
    timeoutMs,
  );
  signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    const { url, address } = await waitWithSignal(resolver(input.url), signal);
    signal?.throwIfAborted();
    if (url.href !== input.url) throw fail('The resolved browser destination changed.');
    if (url.protocol !== 'https:') throw fail('Private browser requests require HTTPS.');
    // No await between the final control check/durable claim and socket creation.
    beforeSend();
    return await new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: input.method,
          headers: { ...input.headers, 'accept-encoding': 'identity' },
          ca,
          signal,
          // No connection pool can reuse a socket resolved under an old decision.
          agent: false,
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
        },
        (res) => {
          let size = 0;
          const parts = [];
          res.on('data', (part) => {
            size += part.length;
            if (size > maxBytes)
              res.destroy(fail('The website response exceeds the browser limit.', 413));
            else parts.push(part);
          });
          res.on('error', reject);
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }),
          );
        },
      );
      req.on('error', reject);
      req.end(input.body);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Independent request authority. Model-originated requests cannot grant
 * themselves permission, including GET requests which can have side effects.
 * Pending requests are encrypted and tied to their live browser generation.
 */
export class BrowserRequests {
  constructor(
    store,
    { key, vault, resolver = resolveDestination, transport = pinnedBrowserRequest },
  ) {
    this.store = store;
    this.key = key;
    this.vault = vault;
    this.resolver = resolver;
    this.transport = transport;
    this.active = new Map();
    this.pageLoads = new Map();
    this.preparing = 0;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS trusted_browser_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, actor TEXT NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL, outcome TEXT)',
    );
    if (
      !store.db
        .prepare('PRAGMA table_info(trusted_browser_requests)')
        .all()
        .some((c) => c.name === 'decision')
    )
      store.db.exec('ALTER TABLE trusted_browser_requests ADD COLUMN decision TEXT');
    store.db
      .prepare(
        "UPDATE trusted_browser_requests SET phase='interrupted',outcome=? WHERE phase IN ('pending','executing')",
      )
      .run('Server restarted. Inspect the site before repeating this action.');
    this.prune();
  }
  row(id) {
    return this.store.db.prepare('SELECT * FROM trusted_browser_requests WHERE id=?').get(id);
  }
  preview(input) {
    const type = String(input.headers['content-type'] || '');
    const text = /json|text|x-www-form-urlencoded/.test(type)
      ? this.vault.redact(Buffer.from(input.body || '', 'base64').toString('utf8'))
      : undefined;
    return {
      url: this.vault.redact(input.url),
      destination: new URL(input.url).origin,
      bodyBytes: input.body ? Buffer.byteLength(input.body, 'base64') : 0,
      body: text?.slice(0, 12000),
      bodyTruncated: (text?.length || 0) > 12000,
      headers: Object.fromEntries(
        Object.entries(input.headers).map(([name, value]) => [
          name,
          /^(?:authorization|cookie|.*token.*|.*key.*|.*secret.*)$/i.test(name)
            ? '[private]'
            : this.vault.redact(value),
        ]),
      ),
      contentType: this.vault.redact(type).slice(0, 120),
    };
  }
  public(row) {
    if (!row) throw fail('That website request is unavailable.', 404);
    const input = decrypt(row.payload, this.key);
    // Keep the original masking even after a login is rotated or the vault is
    // cleared. Legacy receipts expose only their origin, never an unmasked body.
    const preview = input.preview || {
      url: new URL(input.url).origin,
      destination: new URL(input.url).origin,
      headers: {},
      bodyBytes: input.body ? Buffer.byteLength(input.body, 'base64') : 0,
    };
    return {
      ...preview,
      url: this.vault.redact(preview.url),
      body: preview.body === undefined ? undefined : this.vault.redact(preview.body),
      headers: Object.fromEntries(
        Object.entries(preview.headers).map(([name, value]) => [name, this.vault.redact(value)]),
      ),
      id: row.id,
      fingerprint: row.fingerprint,
      phase: row.phase,
      actor: row.actor,
      method: input.method,
      createdAt: row.created,
      outcome: row.outcome,
      pageLoad: input.pageLoad,
      authorization: row.decision || input.authorization || 'exact-request',
      reviewRequired:
        row.actor === 'agent' && row.phase === 'pending' && !this.active.get(row.id)?.dispatching,
    };
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT * FROM trusted_browser_requests ORDER BY CASE WHEN phase IN ('pending','executing') THEN 0 ELSE 1 END, created DESC, rowid DESC LIMIT 70",
      )
      .all()
      .map((row) => this.public(row));
  }
  prune(keepId = '') {
    const rows = this.store.db
      .prepare(
        "SELECT id,length(payload) AS bytes FROM trusted_browser_requests WHERE phase NOT IN ('pending','executing') ORDER BY (id=?) DESC, created DESC, rowid DESC",
      )
      .all(keepId);
    let bytes = 0,
      count = 0;
    const remove = this.store.db.prepare('DELETE FROM trusted_browser_requests WHERE id=?');
    for (const row of rows) {
      if (count >= 40 || bytes + row.bytes > 16_000_000) remove.run(row.id);
      else {
        count++;
        bytes += row.bytes;
      }
    }
  }
  async submit(input, { actor, guard, signal, page }) {
    if (!['owner', 'agent'].includes(actor) || typeof guard !== 'function')
      throw fail('A browser authority is required.');
    assertAuthority(guard);
    signal?.throwIfAborted();
    if (this.active.size + this.preparing >= 30)
      throw fail('Review or cancel the waiting website requests first.');
    this.preparing++;
    try {
      input = snapshot(input);
      // This context is supplied by the host CDP broker, never request/model data.
      const pageContext =
        page &&
        typeof page.current === 'function' &&
        typeof page.id === 'string' &&
        page.id.length <= 128 &&
        typeof page.resourceType === 'string'
          ? {
              id: page.id,
              resourceType: page.resourceType,
              mainDocument: page.mainDocument === true,
            }
          : undefined;
      const pageCurrent = pageContext ? page.current : undefined;
      const vaultGeneration = this.vault.generation();
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(fail('The website address took too long to resolve.', 504)),
        20000,
      );
      try {
        await waitWithSignal(
          this.resolver(input.url),
          signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
        );
      } finally {
        clearTimeout(timer);
      }
      assertAuthority(guard);
      signal?.throwIfAborted();
      if (vaultGeneration !== this.vault.generation())
        throw fail('The browser credentials changed.');
      // Check surrogate scope before presenting a misleading request for approval.
      this.vault.request(input);
      if (this.active.size >= 30)
        throw fail('Review or cancel the waiting website requests first.');
      const saved = {
        ...input,
        vaultGeneration,
        headers: input.headers || {},
        body: input.body ? Buffer.from(input.body).toString('base64') : undefined,
        ...(pageContext ? { page: pageContext } : {}),
      };
      saved.preview = this.preview(saved);
      if (actor === 'agent' && pageContext?.mainDocument && saved.method === 'GET' && !saved.body)
        saved.pageLoad = { origin: new URL(saved.url).origin, ...pageLoadLimits };
      const pageLoad = actor === 'agent' ? this.claimPageLoad(saved, pageCurrent) : undefined;
      if (pageLoad) saved.authorization = 'page-load';
      const fingerprint = hash(JSON.stringify(saved), this.key),
        id = randomUUID();
      this.store.db
        .prepare(
          'INSERT INTO trusted_browser_requests (id,fingerprint,actor,phase,payload,created,outcome) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          id,
          fingerprint,
          actor,
          'pending',
          encrypt(saved, this.key),
          new Date().toISOString(),
          null,
        );
      const promise = new Promise((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => this.cancel(id, 'Browser control or request was cancelled.');
        this.active.set(id, {
          actor,
          guard,
          resolve,
          reject,
          controller,
          signal,
          abort,
          dispatching: false,
          vaultGeneration,
          pageCurrent,
          pageLoad,
        });
        signal?.addEventListener('abort', abort, { once: true });
      });
      // Attach a handler immediately: a browser can close before its caller awaits.
      promise.catch(() => {});
      if (actor === 'owner' || pageLoad) void this.execute(id).catch(() => {});
      return promise;
    } finally {
      this.preparing--;
    }
  }
  claimPageLoad(saved, current) {
    const grant = this.pageLoads.get(saved.page?.id);
    if (
      !grant ||
      Date.now() >= grant.expires ||
      grant.used >= pageLoadLimits.requests ||
      saved.page.mainDocument ||
      saved.method !== 'GET' ||
      saved.body ||
      new URL(saved.url).origin !== grant.origin ||
      typeof current !== 'function' ||
      current() !== true
    )
      return;
    const url = new URL(saved.url);
    const icon =
      saved.page.resourceType === 'Other' && url.pathname === '/favicon.ico' && !url.search;
    if (!pageResourceTypes.has(saved.page.resourceType) && !icon) return;
    grant.used++;
    return grant;
  }
  revokePageLoads() {
    this.pageLoads.clear();
    for (const [id, active] of this.active) {
      if (active.pageLoad) this.cancel(id, 'The page-load permission ended.');
    }
  }
  async decide(id, fingerprint, allow, includePageResources = false) {
    if (typeof allow !== 'boolean') throw fail('Choose whether to allow this website request.');
    if (typeof includePageResources !== 'boolean')
      throw fail('Choose whether to load page resources.');
    const row = this.row(id);
    if (!row || row.actor !== 'agent' || row.fingerprint !== fingerprint)
      throw fail('This review no longer matches the website request.');
    if (row.phase !== 'pending' || !this.active.has(id))
      throw fail('This request has ended. Inspect the site before repeating an action.');
    if (this.active.get(id).dispatching)
      throw fail('This website request has already been handled.');
    if (includePageResources) {
      const saved = decrypt(row.payload, this.key),
        active = this.active.get(id);
      if (hash(JSON.stringify(saved), this.key) !== row.fingerprint)
        throw fail('This review no longer matches the website request.');
      if (
        !allow ||
        !saved.page?.mainDocument ||
        saved.method !== 'GET' ||
        saved.body ||
        typeof active.pageCurrent !== 'function' ||
        active.pageCurrent() !== true
      )
        throw fail('Page loading is no longer available for this request.');
      assertAuthority(active.guard);
      active.signal?.throwIfAborted();
      if (active.vaultGeneration !== this.vault.generation())
        throw fail('The browser credentials changed.');
      this.revokePageLoads();
      this.pageLoads.set(saved.page.id, {
        id: saved.page.id,
        origin: new URL(saved.url).origin,
        expires: Date.now() + pageLoadLimits.milliseconds,
        used: 0,
      });
      this.store.db
        .prepare('UPDATE trusted_browser_requests SET decision=? WHERE id=?')
        .run('page-load-root', id);
    }
    if (!allow) {
      this.cancel(id, 'You declined this website request.', 'declined');
      return this.public(this.row(id));
    }
    await this.execute(id);
    return this.public(this.row(id));
  }
  finish(id, error, response) {
    const active = this.active.get(id);
    if (!active) return;
    active.signal?.removeEventListener('abort', active.abort);
    this.active.delete(id);
    this.prune(id);
    if (error) active.reject(error);
    else active.resolve(response);
  }
  cancel(id, reason = 'The browser session changed.', phase = 'cancelled') {
    const active = this.active.get(id);
    if (!active) return;
    const row = this.row(id);
    this.store.db
      .prepare('UPDATE trusted_browser_requests SET phase=?,outcome=? WHERE id=?')
      .run(row.phase === 'executing' ? 'uncertain' : phase, reason, id);
    active.controller.abort();
    this.finish(id, fail(reason));
  }
  cancelAll() {
    this.pageLoads.clear();
    for (const id of this.active.keys()) this.cancel(id);
  }
  async execute(id) {
    const active = this.active.get(id);
    const row = this.row(id);
    if (!active || row.phase !== 'pending' || active.dispatching)
      throw fail('This website request has already been handled.');
    active.dispatching = true;
    const check = () => {
      if (this.active.get(id) !== active) throw fail('The browser session changed.');
      assertAuthority(active.guard);
      if (active.vaultGeneration !== this.vault.generation())
        throw fail('The browser credentials changed.');
      active.controller.signal.throwIfAborted();
      active.signal?.throwIfAborted();
      if (
        active.pageLoad &&
        (this.pageLoads.get(active.pageLoad.id) !== active.pageLoad ||
          Date.now() >= active.pageLoad.expires ||
          active.pageCurrent?.() !== true)
      )
        throw fail('The page-load permission ended.');
    };
    try {
      check();
      const saved = decrypt(row.payload, this.key);
      if (hash(JSON.stringify(saved), this.key) !== row.fingerprint)
        throw fail('This review no longer matches the website request.');
      const input = this.vault.request({
        ...saved,
        body: saved.body ? Buffer.from(saved.body, 'base64') : undefined,
      });
      let claimed = false;
      const response = await this.transport(input, {
        resolver: this.resolver,
        signal: active.controller.signal,
        beforeSend: () => {
          check();
          if (claimed) throw fail('This website request has already been handled.');
          const claim = this.store.db
            .prepare(
              "UPDATE trusted_browser_requests SET phase='executing' WHERE id=? AND phase='pending'",
            )
            .run(id);
          if (!claim.changes) throw fail('This website request has already been handled.');
          claimed = true;
        },
      });
      if (!claimed) throw fail('The browser transport did not authorize its request.');
      check();
      const headers = { ...response.headers };
      const cookies = this.vault.sealCookies(input.url, headers['set-cookie'] || []);
      if (cookies.length) headers['set-cookie'] = cookies;
      else delete headers['set-cookie'];
      this.store.db
        .prepare(
          "UPDATE trusted_browser_requests SET phase='completed',outcome=? WHERE id=? AND phase='executing'",
        )
        .run(`Website returned HTTP ${response.status}.`, id);
      this.finish(id, null, { ...response, headers });
    } catch (error) {
      if (this.active.has(id)) {
        const executing = this.row(id)?.phase === 'executing';
        const message = executing
          ? 'The website outcome is uncertain. Inspect the site before repeating this action.'
          : 'This request could not be authorized. Inspect the site and try again.';
        this.store.db
          .prepare('UPDATE trusted_browser_requests SET phase=?,outcome=? WHERE id=?')
          .run(executing ? 'uncertain' : 'cancelled', message, id);
        this.finish(id, fail(message));
      }
      // Transport failures can contain real credential-bearing URLs or bodies.
      throw fail('The website request ended. Inspect its saved status before continuing.');
    }
  }
}
