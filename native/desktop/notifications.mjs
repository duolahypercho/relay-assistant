// SPDX-License-Identifier: MIT
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const validIdentity = (p) =>
  p &&
  /^[a-zA-Z0-9-]{16,80}$/.test(p.id) &&
  /^[a-f0-9]{64}$/.test(p.key) &&
  /^[a-zA-Z0-9-]{16,80}$/.test(p.workspaceId);
export class DesktopNotifications {
  constructor({ url, path, fetcher, isFocused, show, open, supported = () => true }) {
    this.url = new URL(url).origin;
    this.path = path;
    this.fetcher = fetcher;
    this.isFocused = isFocused;
    this.show = show;
    this.open = open;
    this.supported = supported;
    this.version = 0;
    this.busy = false;
    this.lastError = '';
    this.stopped = false;
  }
  async start() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.origin === this.url && validIdentity(saved.identity))
        this.identity = saved.identity;
    } catch {}
    this.timer = setInterval(() => void this.poll(), 2000);
    this.timer.unref();
  }
  status() {
    return { supported: this.supported(), configured: !!this.identity, error: this.lastError };
  }
  async configure(identity) {
    if (identity !== null && !validIdentity(identity))
      throw Error('Use the notification settings in Relay.');
    const version = ++this.version;
    this.controller?.abort();
    // Apply immediately so a pending poll cannot display a revoked notification.
    this.identity = identity ? { ...identity } : null;
    const snapshot = this.identity;
    // Serialize disk writes; the last settings change must also survive restart.
    this.writing = (this.writing || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, JSON.stringify({ origin: this.url, identity: snapshot }), {
          mode: 0o600,
        });
      });
    await this.writing;
    if (this.version === version) {
      this.lastError = '';
      void this.poll();
    }
    return this.status();
  }
  async request(path, body, signal) {
    const r = await this.fetcher(`${this.url}/api/attention/${path}`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok)
      throw Error(
        r.status === 401
          ? 'Sign in to Relay to receive notifications.'
          : 'Device notifications could not connect. Reopen their settings.',
      );
    const text = await r.text();
    if (text.length > 12000) throw Error('Invalid notification response.');
    return JSON.parse(text);
  }
  async poll() {
    if (this.busy || this.stopped || !this.identity || !this.supported()) return;
    this.busy = true;
    const identity = { ...this.identity },
      version = this.version;
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller.abort(), 12000);
    let displayError = '';
    try {
      const data = await this.request(
        'desktopPoll',
        { ...identity, focused: this.isFocused() },
        this.controller.signal,
      );
      if (!Array.isArray(data.events) || data.events.length > 3)
        throw Error('Invalid notification response.');
      for (const event of data.events) {
        if (
          event.workspaceId !== identity.workspaceId ||
          typeof event.noticeId !== 'string' ||
          event.noticeId.length > 180 ||
          typeof event.receiptId !== 'string' ||
          typeof event.title !== 'string' ||
          event.title.length > 160 ||
          typeof event.body !== 'string' ||
          event.body.length > 500
        )
          throw Error('Invalid notification response.');
        let status = 'suppressed';
        if (
          this.identity?.id === identity.id &&
          this.version === version &&
          !this.stopped &&
          !this.isFocused()
        ) {
          const shown = await this.show({
            title: event.title,
            body: event.body,
            onClick: () => {
              if (this.identity?.workspaceId === event.workspaceId)
                this.open({ workspaceId: event.workspaceId, noticeId: event.noticeId });
            },
          });
          status = shown ? 'shown' : 'failed';
          if (!shown)
            displayError =
              'Your desktop could not show an alert. Check system notification settings and use a signed app build.';
        }
        await this.request(
          'desktopAck',
          { ...identity, receiptId: event.receiptId, status },
          this.controller.signal,
        );
      }
      if (data.events.length) this.lastError = displayError;
    } catch (e) {
      if (!this.stopped)
        this.lastError =
          e.message === 'Sign in to Relay to receive notifications.'
            ? e.message
            : 'Notifications could not connect. Reopen Relay to check your server.';
    } finally {
      clearTimeout(timeout);
      this.busy = false;
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
    while (this.busy) await new Promise((r) => setTimeout(r, 10));
    await this.writing?.catch(() => {});
  }
}
