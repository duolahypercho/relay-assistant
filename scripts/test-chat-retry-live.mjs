// SPDX-License-Identifier: MIT
// Actual local model/tool inference, with exactly one injected transport outage.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const expect = baseExpect.configure({ timeout: 180000 });
const model = process.env.RELAY_RETRY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed test model and isolated weight directory.');
const directory = await mkdtemp(join(tmpdir(), 'relay-retry-live-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
let browser;
const requests = [],
  responses = [];
let injected = false;
try {
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
    activate: true,
  });
  const transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return transport(url, init);
    const body = JSON.parse(init.body);
    requests.push(body);
    if (
      !injected &&
      f.store.read().files.length === 1 &&
      body.messages.some((m) => m.role === 'tool')
    ) {
      injected = true;
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const response = await transport(url, init);
    // Only synthetic acceptance data is captured; no account or owner context.
    const bytes = await response.arrayBuffer();
    responses.push({ status: response.status, body: new TextDecoder().decode(bytes) });
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(f.url);
  const marker = 'RIVER-' + randomInt(100000, 999999),
    started = performance.now();
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill(
    `Please save a plain text file named retry-proof.txt containing exactly ${marker}. Tell me when it is ready.`,
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  await expect(retry).toBeVisible();
  assert(injected, 'The real model must save the file before the injected outage.');
  const before = f.store.read();
  assert.equal(before.files.length, 1);
  assert.equal(before.files[0].name, 'retry-proof.txt');
  assert.equal(Buffer.from(before.files[0].base64, 'base64').toString(), marker);
  await composer.fill('Keep my next thought');
  await page.screenshot({ path: join(evidence, 'chat-retry-live-failed.png') });
  await retry.click();
  await expect.poll(() => f.store.read().runs[0].status).toBe('completed');
  const after = f.store.read(),
    reply = after.messages.findLast((m) => m.role === 'assistant');
  assert(reply.text.trim() && !reply.error);
  assert.equal(after.messages.filter((m) => m.role === 'user').length, 1);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.runs[0].retryCount, 1);
  const bubble = page.locator(`#message-${reply.id} .markdown`);
  await expect(bubble).toBeVisible();
  await expect(bubble).not.toBeEmpty();
  await expect(composer).toHaveValue('Keep my next thought');
  await page.screenshot({ path: join(evidence, 'chat-retry-live-recovered.png') });
  const receipt = {
    checkedAt: new Date().toISOString(),
    passed: true,
    model,
    replyMode: f.provider.current.replyMode,
    elapsedMs: Math.round(performance.now() - started),
    requests: requests.length,
    injectedOutages: 1,
    file: { name: before.files[0].name, text: marker, bytes: before.files[0].size },
    reply: reply.text,
    checks: [
      'Natural-language request chooses real file tool and writes exact random content',
      'One transport outage after completed write offers inline retry',
      'Click resumes actual model with completed tool receipt',
      'File and request are not duplicated; next draft survives',
    ],
    scope:
      'One bounded actual local model scenario with an injected HTTP 503; no general model-quality or external-action guarantee.',
  };
  await writeFile(join(evidence, 'chat-retry-live.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} catch (error) {
  await writeFile(
    join(evidence, 'chat-retry-live-failure.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        model,
        error: error.stack,
        state: f.store.read(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await writeFile(
    join(evidence, 'chat-retry-live-transport.json'),
    JSON.stringify({ injected, requests, responses }, null, 2),
  );
  await browser?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
