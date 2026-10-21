// SPDX-License-Identifier: MIT
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { safeFetch, resolveDestination } from './network.mjs';
export class BrowserComputer {
  constructor(dataDir, { enabled = true, channel } = {}) {
    this.path = resolve(dataDir, 'browser-profile');
    this.enabled = enabled;
    this.channel = channel;
    this.queue = Promise.resolve();
  }
  async start() {
    if (!this.enabled) throw new Error('The browser is disabled on this server.');
    if (this.context) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(this.path, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.path, {
        headless: true,
        channel: this.channel,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        serviceWorkers: 'block',
      });
      await this.context.route('**/*', async (route) => {
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) {
          await route.abort();
          return;
        }
        if (request.url().startsWith('data:')) return route.continue();
        try {
          const h = await request.allHeaders();
          delete h.host;
          delete h['content-length'];
          delete h.connection;
          delete h['accept-encoding'];
          const response = await safeFetch(request.url(), { maxBytes: 8_000_000, headers: h });
          const headers = Object.fromEntries(
            Object.entries(response.headers).filter(
              ([k, v]) =>
                !['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie'].includes(
                  k,
                ) && typeof v === 'string',
            ),
          );
          await route.fulfill({ status: response.status, headers, body: response.bytes });
        } catch {
          await route.abort();
        }
      });
      this.page = this.context.pages()[0] || (await this.context.newPage());
      this.context.on('page', (p) => {
        this.page = p;
      });
      this.context.on('close', () => {
        this.context = null;
        this.page = null;
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }
  serial(fn) {
    const promise = this.queue.then(fn);
    this.queue = promise.catch(() => {});
    return promise;
  }
  async navigate(url) {
    return this.serial(async () => {
      await resolveDestination(url);
      await this.start();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return this.snapshot();
    });
  }
  async snapshot() {
    if (!this.page) return { connected: false };
    return {
      connected: true,
      title: await this.page.title(),
      url: this.page.url(),
      width: 1280,
      height: 800,
      screenshot: (await this.page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
      text: (await this.page.locator('body').innerText()).slice(0, 14000),
    };
  }
  async control(p) {
    return this.serial(async () => {
      if (!this.page) throw new Error('Open a browser page first.');
      if (p.action === 'click') {
        if (
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x > 1280 ||
          p.y > 800
        )
          throw new Error('Click coordinates are outside the browser.');
        await this.page.mouse.click(p.x, p.y);
      } else if (p.action === 'type')
        await this.page.keyboard.insertText(String(p.text || '').slice(0, 2000));
      else if (p.action === 'key') {
        if (
          ![
            'Enter',
            'Tab',
            'Backspace',
            'Escape',
            'ArrowDown',
            'ArrowUp',
            'Control+A',
            'Meta+A',
          ].includes(p.key)
        )
          throw new Error('That key is unavailable.');
        await this.page.keyboard.press(p.key);
      } else if (p.action === 'scroll')
        await this.page.mouse.wheel(0, p.direction === 'up' ? -500 : 500);
      else if (p.action === 'back') await this.page.goBack({ waitUntil: 'domcontentloaded' });
      else if (p.action === 'refresh') await this.page.reload({ waitUntil: 'domcontentloaded' });
      else throw new Error('Choose a supported browser action.');
      return this.snapshot();
    });
  }
  async stop() {
    await this.context?.close();
  }
}
