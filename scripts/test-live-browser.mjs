// SPDX-License-Identifier: MIT
// Optional real-network smoke test. Uses its own temporary browser profile, never the user's.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserComputer } from '../server/browser.mjs';
import { readPage } from '../server/network.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'relay-browser-smoke-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const browser = new BrowserComputer(directory, {
  channel:
    process.env.RELAY_BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined),
});
const report = {
  checkedAt: new Date().toISOString(),
  url: 'https://example.com',
  passed: false,
  checks: [],
};
try {
  const page = await readPage(report.url);
  assert.match(page.title, /Example Domain/i);
  assert.match(page.text, /documentation examples/i);
  report.checks.push('Real public web reader retrieved Example Domain.');
  const snapshot = await browser.navigate(report.url);
  assert.equal(snapshot.connected, true);
  assert.match(snapshot.title, /Example Domain/i);
  assert.match(snapshot.text, /documentation examples/i);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    resolve(evidence, 'live-browser.jpg'),
    Buffer.from(snapshot.screenshot, 'base64'),
  );
  report.checks.push(
    'Owned Chromium profile navigated, extracted text and captured actual page pixels.',
  );
  await browser.control({ action: 'scroll', direction: 'down' });
  await browser.control({ action: 'key', key: 'Escape' });
  await assert.rejects(browser.navigate('http://127.0.0.1'), /public|private|not allowed/i);
  await assert.rejects(browser.navigate('file:///etc/passwd'), /http|public|valid/i);
  report.checks.push('Owner controls accepted; local/private and file navigation were rejected.');
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await browser.stop();
  await rm(directory, { recursive: true, force: true });
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'live-browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
