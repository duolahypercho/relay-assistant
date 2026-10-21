// SPDX-License-Identifier: MIT
// Actual Chromium context drain/restore, independent of the separately tested VM transport.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
const store = new Store(':memory:', { sample: false });
const control = {
  epoch: 0,
  controller: 'owner',
  engineStopping: false,
  assertControl(actor) {
    if (this.engineStopping || actor !== this.controller) throw Error('Computer unavailable');
  },
};
let launched,
  opens = 0,
  disposes = 0,
  closes = 0;
const runtime = {
  async launch() {
    opens++;
    launched = await chromium.launch({ channel: 'chrome', headless: true });
    return launched;
  },
  async dispose() {
    disposes++;
    await launched?.close();
  },
  async close() {
    closes++;
    await launched?.close();
  },
};
const service = new TrustedBrowser(store, {
  enabled: true,
  key: Buffer.alloc(32, 3),
  control,
  runtime,
});
try {
  const first = await service.ensure('owner');
  await first.context.addCookies([
    {
      name: 'relay_test_cookie',
      value: 'fake-retained-session',
      domain: 'example.test',
      path: '/',
      secure: true,
      httpOnly: true,
    },
  ]);
  control.engineStopping = true;
  control.epoch++;
  await service.sleep();
  assert.equal(launched.isConnected(), false);
  assert.equal(disposes, 1);
  assert.equal(closes, 0);
  assert(first.controller.signal.aborted);
  assert.equal(service.session, null);
  assert.equal(service.browser, null);
  await assert.rejects(service.ensure('owner'), /unavailable/);
  control.engineStopping = false;
  const second = await service.ensure('owner');
  assert.notEqual(second, first);
  assert.equal(opens, 2);
  assert.equal(
    (await second.context.cookies()).find((c) => c.name === 'relay_test_cookie')?.value,
    'fake-retained-session',
  );
  assert(!store.secret('trusted-browser-vault').includes('fake-retained-session'));
  await service.close();
  assert.equal(closes, 1);
  assert.equal(launched.isConnected(), false);
  await writeFile(
    resolve('../relay-evidence/computer-sleep-browser-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        actualChromium: true,
        opens,
        disposes,
        closes,
        checks: [
          'Sleep drains real context/browser, rejects input while stopping and leaves service restartable',
          'Fresh browser context restores retained encrypted test cookie',
          'Final close drains the runtime permanently',
        ],
        limit:
          'Chromium lifecycle verified directly; container/VM transport is covered by separate runtime tests.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: real Chromium private-browser sleep and restoration');
} finally {
  await service.close();
  await launched?.close();
  store.close();
}
