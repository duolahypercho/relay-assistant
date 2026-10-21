// SPDX-License-Identifier: MIT
import http from 'node:http';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { encrypt } from './google.mjs';
import { BrowserVault } from './browser-vault.mjs';
import { BrowserRequests } from './browser-requests.mjs';
import { BrowserDownloads } from './browser-downloads.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionable = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'spinbutton',
  'slider',
  'tab',
  'menuitem',
  'switch',
]);
const editable = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const keys = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);
const attributes = (node) =>
  Object.fromEntries(
    (node.attributes || []).reduce(
      (a, value, index, all) => (index % 2 ? a : [...a, [value, all[index + 1]]]),
      [],
    ),
  );
const privateField = (attrs) =>
  attrs.type === 'password' ||
  /(?:^|\s)(?:username|current-password|new-password|one-time-code|cc-[\w-]+)(?:\s|$)/i.test(
    attrs.autocomplete || '',
  );
const signature = (node) =>
  hash({
    role: node.role?.value,
    name: node.name?.value,
    state: (node.properties || []).filter((p) =>
      ['checked', 'disabled', 'readonly'].includes(p.name),
    ),
  });

/** Server-owned browser, never mounted into the agent's desktop or exposed through
 * a CDP TCP port. Only this trusted process sees Playwright/CDP objects. Product
 * APIs must expose the narrow methods below, never browser/context/session data.
 * Experimental until the remaining isolation and UX gates are verified.
 */
export class TrustedBrowser {
  constructor(
    store,
    { key, control, enabled = false, channel, resolver, transport, runtime } = {},
  ) {
    if (!control || typeof control.assertControl !== 'function')
      throw fail('A computer control authority is required.');
    this.store = store;
    this.key = key;
    this.control = control;
    this.enabled = enabled;
    this.channel = channel;
    this.runtime = runtime;
    this.vault = new BrowserVault(store, key);
    this.downloads = new BrowserDownloads(store, this.vault);
    this.requests = new BrowserRequests(store, { key, vault: this.vault, resolver, transport });
    this.generation = 0;
    this.controlEpoch = control.epoch;
    this.controlActor = control.controller;
    this.targets = new Map();
    this.resetting = Promise.resolve();
    this.routes = new Set();
    this.jobs = new Set();
    this.viewWaiters = new Set();
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS trusted_browser_actions (id TEXT PRIMARY KEY, digest TEXT NOT NULL, actor TEXT NOT NULL, phase TEXT NOT NULL, input TEXT NOT NULL, created TEXT NOT NULL)',
    );
    store.db
      .prepare(
        "UPDATE trusted_browser_actions SET phase='interrupted',input='' WHERE phase='running'",
      )
      .run();
    this.watcher = setInterval(() => this.syncControl(), 50);
    this.watcher.unref();
  }
  syncControl() {
    if (this.controlEpoch === this.control.epoch && this.controlActor === this.control.controller)
      return;
    this.controlEpoch = this.control.epoch;
    this.controlActor = this.control.controller;
    this.invalidate();
  }
  assert(actor, session) {
    if (!this.enabled || this.closed) throw fail('The private browser is unavailable.', 503);
    if (!['owner', 'agent'].includes(actor)) throw fail('A browser actor is required.');
    this.syncControl();
    if (this.control.transitioning) throw fail('Computer control is switching.');
    this.control.assertControl(actor, session?.controlEpoch);
    if (
      session &&
      (session !== this.session || session.actor !== actor || session.controller.signal.aborted)
    )
      throw fail('Browser control changed. Inspect the page again.');
  }
  invalidate({ preserve = true } = {}) {
    const old = this.session;
    this.session = null;
    this.generation++;
    this.targets.clear();
    old?.controller.abort();
    this.requests.cancelAll();
    if (this.active)
      this.store.db
        .prepare(
          "UPDATE trusted_browser_actions SET phase='interrupted',input='' WHERE id=? AND phase='running'",
        )
        .run(this.active.id);
    this.active = null;
    for (const wake of this.viewWaiters) wake();
    const vaultGeneration = this.vault.generation();
    this.resetting = this.resetting.then(async () => {
      if (!old) return;
      try {
        if (preserve && vaultGeneration === this.vault.generation()) {
          const state = await old.context.storageState();
          if (vaultGeneration === this.vault.generation()) this.vault.saveStorage(state);
        }
      } catch {
        /* Closing a crashed browser cannot restore a session. */
      }
      await old.context.close().catch(() => {});
    });
  }
  async launch() {
    if (this.browser) return;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      if (this.runtime) {
        this.browser = await this.runtime.launch();
        const launched = this.browser;
        launched.once('disconnected', () => {
          if (this.browser !== launched) return;
          this.browser = null;
          this.invalidate();
        });
        return;
      }
      // Independent protocol/UI fixtures may explicitly omit a container runtime.
      // The production server always supplies BrowserContainer and has no host fallback.
      const proxy = http.createServer((_req, res) => {
        res.writeHead(403);
        res.end();
      });
      proxy.on('connect', (_req, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', resolve);
      });
      this.proxy = proxy;
      try {
        this.browser = await chromium.launch({
          channel: this.channel,
          headless: true,
          chromiumSandbox: true,
          proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
          args: [
            '--proxy-bypass-list=<-loopback>',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-quic',
          ],
        });
      } catch (error) {
        await new Promise((r) => proxy.close(r));
        this.proxy = null;
        throw error;
      }
    })();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }
  async ensure(actor) {
    this.assert(actor);
    await this.resetting;
    await this.launch();
    this.assert(actor);
    if (this.session) {
      this.assert(actor, this.session);
      return this.session;
    }
    if (this.opening) {
      await this.opening;
      this.assert(actor, this.session);
      return this.session;
    }
    this.opening = (async () => {
      const generation = this.generation,
        controlEpoch = this.control.epoch;
      const context = await this.browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
        storageState: this.vault.storage(),
      });
      const session = {
        context,
        actor,
        controlEpoch,
        controller: new AbortController(),
        page: null,
        document: 0,
      };
      try {
        this.assert(actor);
        if (generation !== this.generation) throw fail('Browser control changed.');
        this.session = session;
        await context.routeWebSocket('**/*', (socket) => socket.close());
        context.on('page', (page) => {
          if (session.page && session.page !== page) void page.close().catch(() => {});
        });
        session.page = await context.newPage();
        session.page.setDefaultTimeout(10000);
        session.page.on('framenavigated', () => {
          session.document++;
          this.targets.clear();
        });
        session.page.on('download', (download) => void download.cancel().catch(() => {}));
        session.page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
        session.cdp = await context.newCDPSession(session.page);
        session.networkRequests = new Map();
        session.networkWaiters = new Map();
        session.cdp.on('Network.requestWillBeSent', (event) => {
          const metadata = {
            loaderId: event.loaderId,
            frameId: event.frameId,
          };
          this.recordRequestMetadata(session, event.requestId, metadata);
        });
        await session.cdp.send('Network.enable');
        const { frameTree } = await session.cdp.send('Page.getFrameTree');
        session.mainFrame = frameTree.frame.id;
        await session.cdp.send('Accessibility.enable');
        session.cdp.on('Fetch.requestPaused', (event) => void this.route(session, event));
        await session.cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
        this.assert(actor, session);
        return session;
      } catch (error) {
        if (this.session === session) this.session = null;
        await context.close().catch(() => {});
        throw error;
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }
  async route(session, event) {
    const ticket = randomUUID();
    const action = this.active?.session === session ? this.active : null;
    let downloadAttempt = false;
    this.routes.add(ticket);
    try {
      if (this.routes.size > 30) throw fail('Too many browser requests are waiting.');
      this.assert(session.actor, session);
      const req = event.request;
      downloadAttempt = !!action?.downloadURLs?.has(req.url);
      const network = await this.requestMetadata(session, event.networkId);
      this.assert(session.actor, session);
      const mainDocument = event.resourceType === 'Document' && event.frameId === session.mainFrame;
      if (mainDocument) {
        this.requests.revokePageLoads();
        session.pageLoad = { id: randomUUID(), loaderId: network?.loaderId };
      }
      const pageLoad = session.pageLoad;
      let resourceType = event.resourceType;
      // Chromium labels favicons "Other". Identify only declared icon URLs through
      // broker-owned DOM metadata; never treat arbitrary Other/Fetch traffic as an image.
      if (
        action &&
        pageLoad &&
        event.frameId === session.mainFrame &&
        resourceType === 'Other' &&
        (await this.declaredIcon(session, req.url))
      )
        resourceType = 'Image';
      if (new URL(req.url).protocol !== 'https:')
        throw fail('This browser destination is unsupported.');
      const entries = req.postDataEntries;
      let body;
      if (
        (entries || []).reduce((bytes, entry) => bytes + (entry.bytes?.length || 0), 0) >
          10_666_672 ||
        Buffer.byteLength(req.postData || '', 'utf8') > 8_000_000
      )
        throw fail('The browser upload exceeds its limit.');
      if (entries?.length && entries.every((entry) => typeof entry.bytes === 'string'))
        body = Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes, 'base64')));
      else if (
        typeof req.postData === 'string' &&
        /json|text|x-www-form-urlencoded/i.test(
          Object.entries(req.headers).find(
            ([name]) => name.toLowerCase() === 'content-type',
          )?.[1] || '',
        )
      )
        body = Buffer.from(req.postData, 'utf8');
      else if (req.hasPostData) throw fail('This browser upload format is unsupported.');
      const response = await this.requests.submit(
        {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body,
        },
        {
          actor: session.actor,
          signal: session.controller.signal,
          guard: () => this.assert(session.actor, session),
          page:
            action &&
            pageLoad?.loaderId &&
            network?.loaderId === pageLoad.loaderId &&
            network.frameId === session.mainFrame &&
            event.frameId === session.mainFrame
              ? {
                  id: pageLoad.id,
                  resourceType,
                  mainDocument,
                  current: () =>
                    this.active === action &&
                    this.session === session &&
                    session.pageLoad === pageLoad &&
                    !session.controller.signal.aborted,
                }
              : undefined,
        },
      );
      if (
        action &&
        response.status >= 400 &&
        (event.resourceType === 'Document' || !['GET', 'HEAD'].includes(req.method))
      )
        action.failed = true;
      this.assert(session.actor, session);
      const expectedDownload = action?.downloadURLs?.has(req.url);
      if (
        expectedDownload &&
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.location
      )
        action.downloadURLs.add(new URL(response.headers.location, req.url).href);
      const attachment = /^\s*attachment(?:\s*;|\s*$)/i.test(
        String(response.headers['content-disposition'] || ''),
      );
      if (
        (attachment && mainDocument) ||
        (expectedDownload && response.status >= 200 && response.status < 300)
      ) {
        downloadAttempt = true;
        if (!action || action !== this.active) throw fail('No active action owns this download.');
        this.downloads.save({
          sourceId: `${action.id}:${event.requestId}`,
          actionId: action.id,
          response,
          hint: action.downloadName,
          guard: () => {
            this.assert(session.actor, session);
            if (this.active !== action) throw fail('The download action changed.');
          },
        });
        action.downloadCommitted = true;
        // 204 keeps the current page visible and prevents a second browser/OS download.
        await session.cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 204,
          responseHeaders: [],
          body: '',
        });
        return;
      }
      const headers = Object.entries(response.headers)
        .filter(([name]) => !['content-length', 'transfer-encoding', 'connection'].includes(name))
        .flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((value) => ({ name, value: String(value) })),
        );
      await session.cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: response.status,
        responseHeaders: headers,
        body: response.body?.toString('base64') || '',
      });
    } catch {
      if (action) action.failed = true;
      await session.cdp
        .send(
          downloadAttempt ? 'Fetch.fulfillRequest' : 'Fetch.failRequest',
          downloadAttempt
            ? { requestId: event.requestId, responseCode: 204, responseHeaders: [], body: '' }
            : { requestId: event.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(() => {});
    } finally {
      this.routes.delete(ticket);
    }
  }
  action(id) {
    const row = this.store.db
      .prepare('SELECT id,actor,phase,created FROM trusted_browser_actions WHERE id=?')
      .get(id);
    if (!row) throw fail('That browser action is unavailable.', 404);
    const files = this.downloads.list(id);
    return { ...row, ...(files.length ? { files } : {}) };
  }
  recordRequestMetadata(session, id, metadata) {
    const waiting = session.networkWaiters.get(id);
    if (waiting) waiting(metadata);
    else {
      session.networkRequests.set(id, metadata);
      if (session.networkRequests.size > 512)
        session.networkRequests.delete(session.networkRequests.keys().next().value);
    }
  }
  requestMetadata(session, id) {
    if (!id || session.controller.signal.aborted) return Promise.resolve(undefined);
    const ready = session.networkRequests.get(id);
    if (ready) {
      session.networkRequests.delete(id);
      return Promise.resolve(ready);
    }
    // Fetch and Network events may be delivered in either order. Missing metadata
    // falls back to exact review; no frame/loader is inferred from a URL.
    return new Promise((resolve) => {
      const finish = (metadata) => {
        clearTimeout(timer);
        session.networkWaiters.delete(id);
        session.controller.signal.removeEventListener('abort', abort);
        resolve(metadata);
      };
      const abort = () => finish(undefined);
      const timer = setTimeout(abort, 1500);
      session.networkWaiters.set(id, finish);
      session.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  async declaredIcon(session, url) {
    try {
      const { root } = await session.cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = await session.cdp.send('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: 'link[rel~="icon"][href]',
      });
      for (const nodeId of nodeIds.slice(0, 16)) {
        const { node } = await session.cdp.send('DOM.describeNode', { nodeId });
        if (new URL(attributes(node).href, session.page.url()).href === url) return true;
      }
    } catch {
      /* An unknown icon remains an exact request. */
    }
    return false;
  }
  status(actor = 'agent') {
    this.syncControl();
    if (actor === 'agent' && (this.control.controller !== 'agent' || this.control.transitioning))
      return { paused: true, connected: false };
    return {
      connected: !!this.session,
      paused: false,
      controller: this.control.controller,
      action: this.active ? this.action(this.active.id) : undefined,
      waiting: [...this.requests.active.keys()].length,
      generation: this.generation,
      downloads: this.downloads.list(),
    };
  }
  async describe(session, backendNodeId) {
    const { node } = await session.cdp.send('DOM.describeNode', { backendNodeId });
    return { ...attributes(node), _tag: (node.localName || node.nodeName || '').toLowerCase() };
  }
  async observe(actor = 'agent') {
    this.assert(actor);
    const session = await this.ensure(actor),
      document = session.document;
    const { nodes } = await session.cdp.send('Accessibility.getFullAXTree');
    const result = [],
      targets = new Map();
    let characters = 0;
    for (const node of nodes) {
      if (node.ignored || node.role?.value === 'InlineTextBox') continue;
      const role = node.role?.value || '',
        name = this.vault.redact(node.name?.value || '').slice(0, 1000);
      if (!name && !actionable.has(role)) continue;
      let attrs = {};
      if (node.backendDOMNodeId && actionable.has(role))
        attrs = await this.describe(session, node.backendDOMNodeId).catch(() => ({
          type: 'password',
        }));
      const secret = privateField(attrs),
        properties = Object.fromEntries(
          (node.properties || []).map((p) => [p.name, p.value?.value]),
        );
      const item = {
        role,
        name: secret && actor === 'agent' ? 'Private field' : name,
        ...(secret
          ? { private: true }
          : { value: this.vault.redact(node.value?.value ?? '').slice(0, 1000) }),
      };
      if (properties.disabled) item.disabled = true;
      if (properties.checked !== undefined) item.checked = properties.checked;
      if (
        actionable.has(role) &&
        node.backendDOMNodeId &&
        !properties.disabled &&
        (actor === 'owner' || !secret)
      ) {
        // Owner screen refreshes must not invalidate a field being edited.
        const previous = [...this.targets].find(
          ([, t]) =>
            t.session === session &&
            t.document === document &&
            t.actor === actor &&
            t.backendNodeId === node.backendDOMNodeId &&
            t.signature === signature(node),
        );
        item.target = previous?.[0] || randomUUID();
        if (actor === 'owner') {
          item.concealed = attrs.type === 'password';
          item.editable =
            editable.has(role) &&
            ['input', 'textarea'].includes(attrs._tag) &&
            !['checkbox', 'radio', 'file', 'range', 'color', 'date', 'datetime-local'].includes(
              attrs.type,
            ) &&
            attrs.readonly === undefined;
          try {
            const { quads } = await session.cdp.send('DOM.getContentQuads', {
              backendNodeId: node.backendDOMNodeId,
            });
            const q = quads?.[0];
            if (q) {
              const xs = [q[0], q[2], q[4], q[6]],
                ys = [q[1], q[3], q[5], q[7]];
              const x = Math.max(0, Math.min(...xs)),
                y = Math.max(0, Math.min(...ys));
              const width = Math.min(1280, Math.max(...xs)) - x,
                height = Math.min(800, Math.max(...ys)) - y;
              if (width > 0 && height > 0) item.bounds = { x, y, width, height };
            }
          } catch {
            /* Offscreen/invisible controls have no pointer overlay. */
          }
        }
        targets.set(item.target, {
          session,
          document,
          backendNodeId: node.backendDOMNodeId,
          role,
          actor,
          private: secret,
          signature: signature(node),
        });
      }
      characters += JSON.stringify(item).length;
      if (result.length >= 300 || characters > 16000) break;
      result.push(item);
    }
    this.assert(actor, session);
    if (session.document !== document) throw fail('The page changed. Look again.');
    this.targets = targets;
    return {
      ...this.status(actor),
      url: this.vault.redact(session.page.url()),
      content: result,
      untrusted: true,
      truncated: result.length >= 300 || characters > 16000,
    };
  }
  async ownerScreen() {
    this.syncControl();
    const session = this.session;
    if (!session) return this.status('owner');
    const generation = this.generation;
    const screenshot = await session.page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 });
    if (generation !== this.generation || session !== this.session)
      throw fail('The browser changed. Refresh the screen.');
    return {
      ...this.status('owner'),
      url: this.vault.redact(session.page.url()),
      width: 1280,
      height: 800,
      screenshot: screenshot.toString('base64'),
    };
  }
  async ownerView() {
    this.syncControl();
    // A navigation waiting for review may not have a screenshot yet. Reviews
    // must never depend on that navigation finishing.
    if (!this.session || this.active)
      return { ...this.status('owner'), requests: this.requests.list() };
    const session = this.session,
      generation = this.generation;
    let wake;
    const changed = new Promise((resolve) => {
      wake = () => resolve(null);
    });
    this.viewWaiters.add(wake);
    try {
      const preview = (async () => {
        const observation =
          this.control.controller === 'owner' && !this.active ? await this.observe('owner') : null;
        const screen = await this.ownerScreen();
        return {
          ...screen,
          controls: observation?.content.filter((n) => n.target && n.bounds) || [],
        };
      })();
      // An action can begin after the initial check, while screenshot waits on navigation.
      // Wake that HTTP poll immediately; its pending review must not wait on its own page load.
      const view = await Promise.race([preview, changed]);
      if (!view || this.active || session !== this.session || generation !== this.generation)
        return { ...this.status('owner'), requests: this.requests.list() };
      return { ...view, requests: this.requests.list() };
    } finally {
      this.viewWaiters.delete(wake);
    }
  }
  cancelAction(id) {
    const receipt = this.action(id);
    if (receipt.phase !== 'running') return receipt;
    if (this.active?.id !== id) throw fail('This browser action is no longer active.');
    this.invalidate();
    return this.action(id);
  }
  async waitForAction(id, { signal, guard } = {}) {
    try {
      for (;;) {
        signal?.throwIfAborted();
        guard?.();
        const receipt = this.action(id);
        if (receipt.phase !== 'running') return receipt;
        await delay(50, undefined, { signal });
      }
    } catch (error) {
      // A stopped run cannot leave a website action waiting or sending in the background.
      if (this.active?.id === id) this.invalidate();
      throw error;
    }
  }
  validate(input) {
    if (
      !input ||
      typeof input.operationId !== 'string' ||
      !/^[\w:-]{1,160}$/.test(input.operationId)
    )
      throw fail('A browser operation ID is required.');
    const action = input.action;
    if (!['open', 'click', 'type', 'key', 'scroll'].includes(action))
      throw fail('Choose a supported browser action.');
    const saved = { operationId: input.operationId, action };
    if (action === 'open') {
      let url;
      try {
        url = new URL(input.url);
      } catch {
        throw fail('Enter a complete HTTPS address.');
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192)
        throw fail('Use a complete HTTPS address without embedded credentials.');
      saved.url = url.href;
    } else if (action === 'scroll') {
      if (!['up', 'down'].includes(input.direction)) throw fail('Choose up or down.');
      saved.direction = input.direction;
    } else {
      if (typeof input.target !== 'string') throw fail('Look at the page to choose a target.');
      saved.target = input.target;
      if (action === 'type') {
        if (typeof input.text !== 'string' || input.text.length > 4096)
          throw fail('Enter up to 4096 characters.');
        saved.text = input.text;
      }
      if (action === 'key') {
        if (!keys.has(input.key)) throw fail('This key is unavailable.');
        saved.key = input.key;
      }
    }
    return saved;
  }
  async begin(input, actor = 'agent') {
    this.assert(actor);
    const saved = this.validate(input),
      digest = createHmac('sha256', this.key)
        .update(JSON.stringify({ actor, ...saved }))
        .digest('hex');
    const previous = this.store.db
      .prepare('SELECT * FROM trusted_browser_actions WHERE id=?')
      .get(saved.operationId);
    if (previous) {
      if (previous.digest !== digest || previous.actor !== actor)
        throw fail('This browser operation ID belongs to a different action.');
      return { ...this.action(previous.id), repeated: true };
    }
    const session = await this.ensure(actor);
    this.assert(actor, session);
    if (this.active || this.requests.active.size)
      throw fail('Finish or cancel the current browser action first.');
    const target = saved.target ? this.targets.get(saved.target) : undefined;
    if (
      saved.target &&
      (!target ||
        target.session !== session ||
        target.document !== session.document ||
        target.actor !== actor)
    )
      throw fail('That target is stale. Look at the page again.');
    this.store.db
      .prepare('INSERT INTO trusted_browser_actions VALUES (?,?,?,?,?,?)')
      .run(
        saved.operationId,
        digest,
        actor,
        'running',
        encrypt(saved, this.key),
        new Date().toISOString(),
      );
    const active = { id: saved.operationId, session };
    this.active = active;
    for (const wake of this.viewWaiters) wake();
    active.done = this.run(session, saved, target)
      .then(async () => {
        this.assert(actor, session);
        if (active.failed)
          throw fail('A website request did not complete. Inspect the page before trying again.');
        const generation = this.vault.generation();
        const state = await session.context.storageState();
        this.assert(actor, session);
        if (generation !== this.vault.generation()) throw fail('The browser credentials changed.');
        this.vault.saveStorage(state);
        this.store.db
          .prepare(
            "UPDATE trusted_browser_actions SET phase='completed',input='' WHERE id=? AND phase='running'",
          )
          .run(active.id);
      })
      .catch(() => {
        this.store.db
          .prepare(
            "UPDATE trusted_browser_actions SET phase='uncertain',input='' WHERE id=? AND phase='running'",
          )
          .run(active.id);
      })
      .finally(() => {
        if (this.active === active) this.active = null;
        this.jobs.delete(active.done);
      });
    this.jobs.add(active.done);
    return this.action(active.id);
  }
  async run(session, input, target) {
    this.requests.revokePageLoads();
    const deadline = setTimeout(() => {
      if (this.session === session) this.invalidate();
    }, 300000);
    try {
      if (input.action === 'open') {
        try {
          await session.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 0 });
        } catch (error) {
          if (!this.active?.downloadCommitted) throw error;
        }
      } else if (input.action === 'scroll') {
        await session.page.mouse.wheel(0, input.direction === 'up' ? -500 : 500);
      } else {
        const attrs = await this.describe(session, target.backendNodeId);
        const current = await session.cdp.send('Accessibility.getPartialAXTree', {
          backendNodeId: target.backendNodeId,
          fetchRelatives: false,
        });
        const node = current.nodes.find(
          (n) => n.backendDOMNodeId === target.backendNodeId && !n.ignored,
        );
        this.assert(session.actor, session);
        if (!node || signature(node) !== target.signature)
          throw fail('That target changed. Look at the page again.');
        if (privateField(attrs) && session.actor === 'agent')
          throw fail('Take control to fill private fields.');
        if (input.action === 'click') {
          if (attrs._tag === 'a' && attrs.download !== undefined && attrs.href) {
            const url = new URL(attrs.href, session.page.url());
            if (url.protocol === 'https:' && this.active?.session === session) {
              this.active.downloadURLs = new Set([url.href]);
              this.active.downloadName = attrs.download;
            }
          }
          await session.cdp.send('DOM.scrollIntoViewIfNeeded', {
            backendNodeId: target.backendNodeId,
          });
          const { model } = await session.cdp.send('DOM.getBoxModel', {
            backendNodeId: target.backendNodeId,
          });
          this.assert(session.actor, session);
          const quad = model.content;
          await session.page.mouse.click(
            (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
            (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
          );
        } else {
          if (
            !editable.has(target.role) ||
            attrs.readonly !== undefined ||
            attrs.disabled !== undefined
          )
            throw fail('This target is not an editable field.');
          if (
            input.action === 'type' &&
            !['input', 'textarea'].includes(attrs._tag) &&
            !['', 'true', 'plaintext-only'].includes(attrs.contenteditable)
          )
            throw fail('Use keyboard selection for this control.');
          if (input.action === 'type' && privateField(attrs) && input.text)
            this.vault.rememberPrivate(session.page.url(), input.text);
          await session.cdp.send('DOM.focus', { backendNodeId: target.backendNodeId });
          this.assert(session.actor, session);
          if (input.action === 'type') {
            await session.page.keyboard.press(
              process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
            );
            this.assert(session.actor, session);
            await session.page.keyboard.insertText(input.text);
          } else await session.page.keyboard.press(input.key);
        }
      }
      let quiet = Date.now();
      while (Date.now() - quiet < 300) {
        this.assert(session.actor, session);
        if (this.routes.size || this.requests.active.size) quiet = Date.now();
        await delay(30, undefined, { signal: session.controller.signal });
      }
      this.assert(session.actor, session);
    } finally {
      clearTimeout(deadline);
      this.requests.revokePageLoads();
    }
  }
  async decide(id, fingerprint, allow, includePageResources = false) {
    return this.requests.decide(id, fingerprint, allow, includePageResources);
  }
  async clear() {
    this.invalidate({ preserve: false });
    this.vault.clear();
    await this.resetting;
    // Login bodies may also exist in encrypted request receipts. Forget those
    // copies while retaining input-free action tombstones that prevent replay.
    this.store.db.prepare('DELETE FROM trusted_browser_requests').run();
  }
  async sleep() {
    if (!this.closed && !this.control.engineStopping)
      throw fail('Stop the private computer before resting its browser.');
    this.invalidate();
    await this.opening?.catch(() => {});
    await this.resetting;
    await Promise.allSettled([...this.jobs]);
    await this.launching?.catch(() => {});
    await this.browser?.close();
    if (this.closed) await this.runtime?.close();
    else await this.runtime?.dispose();
    if (this.proxy)
      await new Promise((r) => {
        this.proxy.close(r);
        this.proxy.closeAllConnections();
      });
    this.browser = null;
    this.proxy = null;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watcher);
    await this.sleep();
  }
}
