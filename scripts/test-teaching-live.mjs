// SPDX-License-Identifier: MIT
// Actual vision draft and learned-skill execution; all screens, files and models are isolated.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ensureTeaching } from '../server/teaching.mjs';
import { command } from '../shared/domain.mjs';
const model = process.env.RELAY_COMPUTER_TEST_MODEL,
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS,
  dockerHost = process.env.RELAY_COMPUTER_TEST_DOCKER_HOST;
assert(model && modelsDirectory, 'Choose existing dedicated acceptance weights.');
assert(dockerHost?.includes('relay-live-acceptance'), 'Use the dedicated acceptance engine.');
const expect = baseExpect.configure({ timeout: 25000 }),
  mac = process.argv.includes('--mac'),
  evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/teaching-live'),
  directory = await mkdtemp(join(tmpdir(), 'relay-teaching-live-'));
await mkdir(evidence, { recursive: true });
let f, computer, browser, page, teaching;
const requests = [],
  responses = [],
  captures = [],
  checks = [];
const report = { passed: false, model, surface: mac ? 'mac' : 'desktop-browser', checks };
const check = (text) => {
  checks.push(text);
  console.log('PASS', text);
};
const stamp = `RECEIPT-${randomInt(10000, 99999)}`;
const title = `Planning ${randomInt(10000, 99999)}`;
const recipient = 'Sam';
const message = 'Bring the updated drawings on Tuesday.';
const filename = `handoff-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Handoff notes</title>
<style>[hidden]{display:none!important}body{font:22px system-ui;background:#f5f2e8;color:#234337;padding:32px 60px}h1{font-size:34px}form{display:grid;gap:12px;max-width:700px}label{display:grid;gap:5px}input,button{font:inherit;padding:12px}button{background:#356b50;color:white;border:0}pre{font:20px system-ui;white-space:pre-wrap}</style>
<h1>Handoff notes</h1><form id="entry"><label>Handoff title<input name="title" autofocus required></label><label>Recipient<input name="recipient" required></label><label>Message<input name="message" required></label><button>Review note</button></form>
<section id="review" hidden><h2>Review your handoff</h2><pre></pre><button id="download">Download note</button><p role="status" id="result"></p></section>
<script>let note;entry.onsubmit=e=>{e.preventDefault();note=Object.fromEntries(new FormData(entry));entry.hidden=true;review.hidden=false;document.querySelector('pre').textContent='Title: '+note.title+'\\nFor: '+note.recipient+'\\nMessage: '+note.message;download.focus()};download.onclick=()=>{let a=document.createElement('a');a.download='handoff-'+note.title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.txt';a.href=URL.createObjectURL(new Blob(['Title: '+note.title+'\\nFor: '+note.recipient+'\\nMessage: '+note.message+'\\nReceipt: ${stamp}\\n'],{type:'text/plain'}));a.click();result.textContent='Saved handoff: '+note.title};</script></html>`;
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  computer = new PrivateComputer(f.store, {
    enabled: true,
    deployment: directory,
    dockerHost,
    image: process.env.RELAY_TEST_COMPUTER_IMAGE || 'relay-desktop:setup-9b5d3f3833f38098',
  });
  f.worker.services.computer = computer;
  teaching = ensureTeaching(f.store, f.worker.services);
  const originalTransport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    const completion = url.endsWith('/chat/completions'),
      index = requests.length;
    if (completion) {
      requests.push(JSON.parse(init.body));
      console.log('MODEL REQUEST', index + 1, requests[index].messages.length, 'messages');
      await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests));
    }
    const result = await originalTransport(url, init);
    if (completion)
      captures.push(
        result
          .clone()
          .text()
          .then(async (body) => {
            responses[index] = { status: result.status, body };
            await writeFile(join(evidence, 'responses.json'), JSON.stringify(responses));
          })
          .catch((error) => {
            responses[index] = { error: String(error) };
          }),
      );
    return result;
  };
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
    replyMode: 'quick',
  });
  f.store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  await computer.start('owner');
  await computer.takeControl();
  const owner = (payload) =>
    computer.perform({ ...payload, operationId: randomUUID() }, { actor: 'owner' });
  await owner({
    kind: 'files',
    action: 'write',
    path: 'handoff-notes.html',
    base64: Buffer.from(html).toString('base64'),
  });
  await owner({
    kind: 'exec',
    command:
      'chromium --no-sandbox --user-data-dir="$HOME/chromium" --new-window file:///workspace/handoff-notes.html >/tmp/teaching-live-browser.log 2>&1 &',
  });
  await expect
    .poll(async () =>
      (
        await owner({ kind: 'exec', command: 'xdotool getwindowfocus getwindowname' })
      ).stdout.trim(),
    )
    .toContain('Handoff notes');
  report.image = computer.image;
  const inspected = await computer.inspect();
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert(inspected.Mounts.every((m) => m.Type === 'volume'));
  assert.equal(inspected.Config.User, '1000:1000');
  if (mac) {
    await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
    browser = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${directory}`],
    });
    page = await browser.firstWindow();
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1365, height: 1050 } });
    await page.goto(f.url);
  }
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.fill('Keep my next thought about the weekend.');
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Teach a task', exact: true }).click();
  const region = page.getByRole('region', { name: 'Teach a task', exact: true });
  await region
    .getByLabel('What are you showing Relay?')
    .fill(
      'Create a handoff note in the open Handoff notes app from a title, recipient and message, and return the downloaded text file. Use the demonstrated app workflow, not a custom-created substitute file.',
    );
  assert.equal(teaching.all().length, 0);
  assert.equal(requests.length, 0);
  await region.getByRole('button', { name: 'Take control & record', exact: true }).click();
  await expect(region.getByRole('button', { name: 'Stop & review', exact: true })).toBeVisible();
  const sessionId = teaching.all()[0].id;
  const action = async (payload) => {
    const res = await fetch(f.url + '/api/computer/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: f.url },
      body: JSON.stringify({ kind: 'desktop', operationId: randomUUID(), ...payload }),
    });
    assert.equal(res.status, 200, await res.text());
  };
  const captureStep = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/teaching/${sessionId}/capture`) && r.request().method() === 'POST',
    );
    await region.getByRole('button', { name: 'Capture this step', exact: true }).click();
    assert.equal((await response).status(), 200);
    await expect(
      region.getByRole('button', { name: 'Capture this step', exact: true }),
    ).toBeEnabled();
  };
  await action({ action: 'type', text: 'River review' });
  await action({ action: 'key', key: 'Tab' });
  await action({ action: 'type', text: 'Morgan' });
  await action({ action: 'key', key: 'Tab' });
  await action({ action: 'type', text: 'Collect the route notes on Friday.' });
  await captureStep();
  await action({ action: 'key', key: 'Return' });
  await captureStep();
  await action({ action: 'key', key: 'Return' });
  await captureStep();
  await region.getByRole('button', { name: 'Stop & review', exact: true }).click();
  const downloads = await owner({ kind: 'files', action: 'list', path: '.home/Downloads' });
  assert(downloads.entries.some((entry) => entry.name === 'handoff-river-review.txt'));
  report.demonstratedDownloadFolder = '/workspace/.home/Downloads';
  const recorded = teaching.get(sessionId);
  assert(recorded.frames.length >= 4);
  report.recordedFrames = recorded.frames.length;
  for (const [index, frame] of recorded.frames.entries())
    await writeFile(
      join(evidence, `recorded-${index + 1}.jpg`),
      teaching.frame(sessionId, frame.id),
    );
  await writeFile(join(evidence, 'recording.json'), JSON.stringify(recorded, null, 2));
  check(
    'Owner demonstrated a real three-field app and download; entry and recording add no chat history or model requests',
  );
  assert.equal(f.store.read().messages.length, 0);
  assert.equal(requests.length, 0);
  await expect(
    region.getByRole('button', { name: 'Create skill draft', exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      region
        .locator('.teaching-frames img')
        .evaluateAll(
          (images) =>
            images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.screenshot({ path: join(evidence, 'review.png') });
  const draftStart = Date.now();
  await region.getByRole('button', { name: 'Create skill draft', exact: true }).click();
  await expect.poll(() => requests.length, { timeout: 20000 }).toBeGreaterThan(0);
  await expect
    .poll(() => teaching.get(sessionId).status, { timeout: 140000 })
    .not.toMatch(/^(queued|generating)$/);
  let session = teaching.get(sessionId);
  report.draftElapsedMs = Date.now() - draftStart;
  assert.equal(session.status, 'draft', session.error);
  report.draft = session.draft;
  await writeFile(join(evidence, 'draft.json'), JSON.stringify(session.draft, null, 2));
  const observedMethod = session.draft.steps.map((step) => step.instruction).join('\n');
  assert.match(observedMethod, /review|preview/i);
  assert.match(observedMethod, /Download note/i);
  assert.doesNotMatch(
    session.draft.instructions,
    /River review|Morgan|Collect the route notes on Friday/,
  );
  const draftRequest = requests.find((r) =>
    r.messages[0]?.content.startsWith('Turn an owner-recorded'),
  );
  assert(draftRequest);
  assert.equal(draftRequest.tools?.length || 0, 0);
  assert.equal(
    draftRequest.messages.filter((m) => Array.isArray(m.content)).length,
    recorded.frames.length,
  );
  check(
    'Actual vision model creates a cited, parameterized method with the observed review/download steps',
  );
  await expect(region.getByLabel('Review the method', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'draft.png') });
  await region.getByRole('button', { name: 'Save reviewed skill', exact: true }).click();
  await expect(
    region.getByRole('button', { name: 'Give back & test skill', exact: true }),
  ).toBeVisible();
  await owner({ kind: 'desktop', action: 'key', key: 'ctrl+r' });
  const priorRequests = requests.length,
    runStart = Date.now();
  await region
    .getByLabel('Example for the test')
    .fill(
      `Create the handoff with title "${title}", recipient "${recipient}", and message "${message}". Attach the downloaded file here.`,
    );
  await region.getByRole('button', { name: 'Give back & test skill', exact: true }).click();
  await expect(composer).toHaveValue('Keep my next thought about the weekend.');
  await expect
    .poll(
      () => {
        const id = teaching.get(sessionId).testRunId;
        return f.store.read().runs.find((r) => r.id === id)?.status || '';
      },
      { timeout: 600000 },
    )
    .toMatch(/^(completed|failed|cancelled|waiting)$/);
  session = teaching.get(sessionId);
  const state = f.store.read(),
    run = state.runs.find((r) => r.id === session.testRunId);
  report.run = run;
  report.testElapsedMs = Date.now() - runStart;
  report.reply = state.messages.findLast((m) => m.role === 'assistant')?.text;
  console.log(
    JSON.stringify({ status: run.status, elapsedMs: report.testElapsedMs, reply: report.reply }),
  );
  assert.equal(run.status, 'completed');
  const file = state.files.find((file) => file.name === filename);
  assert(file, `The demonstrated app must deliver ${filename}.`);
  const expected = `Title: ${title}\nFor: ${recipient}\nMessage: ${message}\nReceipt: ${stamp}\n`;
  assert.equal(Buffer.from(file.base64, 'base64').toString(), expected);
  const tools = requests
    .slice(priorRequests)
    .flatMap((r) =>
      r.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls || []),
    );
  assert(tools.some((t) => ['computer_look', 'computer_start'].includes(t.function.name)));
  assert(
    requests
      .slice(priorRequests)
      .some((r) =>
        r.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
        ),
      ),
  );
  assert(tools.some((t) => t.function.name === 'computer_use'));
  assert(tools.some((t) => t.function.name === 'computer_export'));
  assert(state.messages.filter((m) => m.role === 'user').length === 1);
  assert.equal(
    state.threads.find((t) => t.id === 'main').draft,
    'Keep my next thought about the weekend.',
  );
  report.delivered = {
    name: file.name,
    sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
  };
  await writeFile(join(evidence, filename), Buffer.from(file.base64, 'base64'));
  await page.screenshot({ path: join(evidence, 'result.png') });
  check(
    'Saved learned skill runs with new values through actual computer vision/actions and returns exact app-generated bytes',
  );
  await page.reload();
  await expect(composer).toHaveValue('Keep my next thought about the weekend.');
  assert.equal(teaching.get(sessionId).testRunId, run.id);
  assert.deepEqual(pageErrors, []);
  check('Reload preserves the reviewed skill, original test receipt and unfinished chat draft');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await f?.worker.stop();
  await Promise.allSettled(captures);
  report.checkedAt = new Date().toISOString();
  if (f) {
    report.messages = f.store.read().messages;
    report.sessions = teaching?.all();
    report.receipts = computer?.receipts();
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, 'transport.json'), JSON.stringify({ requests, responses }));
  await browser?.close();
  if (computer) {
    await computer.stop();
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]);
    for (const volume of [computer.volume, computer.displayVolume]) {
      const listed = await computer.checked([
        'volume',
        'ls',
        '--filter',
        `name=^${volume}$`,
        '--format',
        '{{.Name}}',
      ]);
      if (listed.trim() === volume) {
        await computer.verifyVolume(volume);
        await computer.checked(['volume', 'rm', volume]);
      }
    }
  }
  await f?.close();
  await rm(directory, { recursive: true, force: true });
}
