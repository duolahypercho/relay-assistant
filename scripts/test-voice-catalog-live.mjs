// SPDX-License-Identifier: MIT
// Real inference with voice or local Quick typed discovery; no audio capture.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import JSZip from 'jszip';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { fileBytes } from '../shared/pdf.mjs';

const model = process.env.RELAY_VOICE_TEST_MODEL,
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const replyMode = process.env.RELAY_VOICE_TEST_REPLY_MODE || 'quick';
assert(['quick', 'default'].includes(replyMode), 'Choose quick or default local reasoning.');
assert(model && modelsDirectory, 'Choose an installed model and independent acceptance cache.');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/voice-catalog-capabilities',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-voice-catalog-live-'));
const marker = 'FERN-' + randomInt(10000, 99999),
  mac = process.argv.includes('--mac'),
  typed = process.argv.includes('--typed');
assert(!typed || replyMode === 'quick', 'Typed catalog acceptance uses local Quick mode.');
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  typed,
  marker,
  scope:
    'Actual local-model tool discovery in voice-mode requests, real document files/routine/review state and renderer. Synthetic text requests represent recognized speech; no recognition, microphone, speech generation, owner accounts or sending.',
  checks: [],
  requests: [],
};
if (typed)
  report.scope =
    'Actual local Quick typed requests through the composer, model, worker and renderer; exact Word creation/revision, paused reminder, unsent email review and deferred skill saving. No speech, owner accounts or sending.';
report.runtimeSources = await Promise.all(
  [
    'server/agent.mjs',
    'server/model.mjs',
    'server/model-failover.mjs',
    'server/voice-tool-catalog.mjs',
    'server/text-file-completion.mjs',
    'server/skill-completion.mjs',
    'shared/model-catalog.mjs',
  ].map(async (path) => ({
    path,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  })),
);
let f, browser, app, page, originalDocumentXml;
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
  });
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    replyMode,
    apiKey: '',
    activate: true,
  });
  const fetcher = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
    return fetcher(url, init);
  };
  if (mac) {
    const data = join(directory, 'desktop');
    await mkdir(data);
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
    app = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${data}`],
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.hide()),
    );
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  }
  page.setDefaultTimeout(15000);
  await page.goto(f.url + '/#chat');
  async function send(name, text, status = 'completed') {
    const started = performance.now(),
      requestIndex = report.requests.length;
    let run;
    if (typed) {
      const count = f.store.read().runs.length;
      await page.getByLabel('Message Relay', { exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs.length).toBe(count + 1);
      run = f.store.read().runs.at(-1);
      assert(!run.voiceCallId);
    } else
      run = f.store.mutate((s) => {
        const r = command(s, 'chat.send', { threadId: 'main', text });
        r.voiceCallId = 'synthetic-recognized-speech';
        return r;
      });
    await expect
      .poll(() => f.store.read().runs.find((r) => r.id === run.id)?.status, {
        timeout: 240000,
        intervals: [250, 1000],
      })
      .toMatch(/^(completed|failed|waiting)$/);
    const state = f.store.read(),
      finished = state.runs.find((r) => r.id === run.id);
    const answer = state.messages.findLast(
      (m) => m.role === 'assistant' && m.replyTo === run.messageId,
    );
    const check = {
      name,
      status: finished.status,
      elapsedMs: Math.round(performance.now() - started),
      answer: answer?.text || '',
      requestIndex,
      passed: false,
    };
    report.checks.push(check);
    await page.reload();
    await expect(page.locator('.message.assistant').last()).toBeVisible();
    assert.equal(finished.status, status, JSON.stringify(finished));
    return check;
  }
  async function capture(check) {
    // A busy window server can stall a native capture after the task has finished.
    // Keep semantic checks recorded first; this changes no model or service deadline.
    await page.screenshot({ path: join(evidence, check.name + '.png'), timeout: 60000 });
    console.log(`CHECKPOINT ${check.name}: verified actual result and captured renderer`);
  }
  async function inspectDocument(version) {
    const state = f.store.read(),
      artifact = state.artifacts.find((a) => a.kind === 'document');
    assert(artifact, 'A real Word artifact is required.');
    assert.equal(artifact.versions.length, version);
    const v = artifact.versions.at(-1),
      file = state.files.find((f) => f.id === v.fileId);
    assert.equal(v.title, 'Packing Checklist');
    assert(file);
    const bytes = await fileBytes(file),
      zip = await JSZip.loadAsync(bytes),
      xml = await zip.file('word/document.xml').async('string');
    for (const text of [marker, '10:30', 'Notebook', 'Blue folder'])
      assert(xml.includes(text), text);
    if (version === 1) {
      assert(xml.includes('Charging cable'));
      originalDocumentXml = xml;
    } else {
      assert(xml.includes('USB-C charger'));
      assert(!xml.includes('Charging cable'));
      assert.equal(xml, originalDocumentXml.replace('Charging cable', 'USB-C charger'));
    }
    const path = join(evidence, `packing-v${version}.docx`);
    await writeFile(path, bytes);
    return {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fileId: file.id,
      version,
      ...(version === 2 ? { exactDocumentXmlReplacement: true } : {}),
    };
  }
  const first = await send(
    'word-document',
    `Create a Word document titled Packing Checklist. Include trip reference ${marker}, departure time 10:30, and three bullet entries: Notebook, Charging cable, Blue folder. Attach the Word file and give a short${typed ? '' : ' spoken'} confirmation.`,
  );
  first.document = await inspectDocument(1);
  first.passed = true;
  await capture(first);
  const second = await send(
    'word-revision',
    'Update that same Word document: replace Charging cable with USB-C charger. Keep its title, trip reference, departure time and all other content exactly. Attach the updated Word file.',
  );
  second.document = await inspectDocument(2);
  second.passed = true;
  await capture(second);
  const third = await send(
    'paused-routine',
    `Create a daily reminder called Water the fern at 09:00 in Asia/Shanghai. Its reminder text is ${marker}: water the fern. Start it paused so I can enable it later.`,
  );
  const routines = f.store.read().routines;
  assert.equal(routines.length, 1);
  assert.equal(routines[0].paused, true);
  assert.equal(routines[0].title, 'Water the fern');
  assert.equal(routines[0].execution, 'reminder');
  assert.equal(routines[0].schedule.time, '09:00');
  assert.equal(routines[0].schedule.timeZone, 'Asia/Shanghai');
  assert.equal(routines[0].instructions, `${marker}: water the fern`);
  third.routine = routines[0];
  third.passed = true;
  await capture(third);
  const fourth = await send(
    'email-review',
    `Draft an email to colleague@example.test with subject Trip ${marker} and body The departure time is 10:30. Prepare it for my review; do not send it.`,
    'completed',
  );
  const approvals = f.store.read().approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'email');
  assert.equal(approvals[0].status, 'pending');
  assert.equal(approvals[0].payload.to, 'colleague@example.test');
  assert.equal(approvals[0].payload.subject, `Trip ${marker}`);
  assert.equal(approvals[0].payload.body, 'The departure time is 10:30.');
  fourth.review = approvals[0];
  fourth.passed = true;
  await capture(fourth);
  const allNames = new Set(
    report.requests.flatMap((r) => (r.tools || []).map((t) => t.function?.name || t.name)),
  );
  for (const name of ['load_tools', 'save_artifact', 'create_routine', 'prepare_email'])
    assert(allNames.has(name), name);
  const initial = report.requests[0].tools.map((t) => t.function?.name || t.name);
  assert(
    initial.includes('save_artifact'),
    'An explicit document request gets its complete creation schema immediately',
  );
  // These explicit requests now preload their definitions. Require the actual
  // schemas at each request, not an unnecessary load_tools round trip. Deferred
  // discovery remains available and has separate durable-catalog unit coverage.
  for (const [name, required] of [
    ['word-document', ['save_artifact']],
    ['word-revision', ['save_artifact', 'read_artifact']],
    ['paused-routine', ['create_routine']],
    ['email-review', ['prepare_email']],
  ]) {
    const check = report.checks.find((c) => c.name === name);
    const definitions = report.requests[check.requestIndex].tools.map((t) => t.function || t);
    for (const tool of ['load_tools', ...required])
      assert(
        definitions.some((definition) => definition.name === tool && definition.parameters),
        `${name} must expose the full ${tool} schema before inference`,
      );
  }
  if (typed) {
    const instructions = `Inputs: a packing list.\nSteps: read the list and check Notebook, USB-C charger and Blue folder.\nValidation: report missing items without inventing completion.\nReference: ${marker}.`;
    const fifth = await send(
      'saved-skill',
      `Save a reusable skill titled Packing review, with slug packing-review. Save exactly the text between these markers as its instructions:\n<instructions>\n${instructions}\n</instructions>\nDo not run it now.`,
    );
    const state = f.store.read();
    assert.equal(state.skills.length, 1);
    const skill = state.skills[0];
    assert.equal(skill.title, 'Packing review');
    assert.equal(skill.slug, 'packing-review');
    assert.equal(skill.instructions, instructions);
    assert.equal(state.files.length, 2);
    assert.equal(state.routines.length, 1);
    assert.equal(state.approvals.length, 1);
    assert.equal(state.messages.filter((m) => m.role === 'user').length, 5);
    const initialTools = report.requests[fifth.requestIndex].tools.map((t) => t.function || t);
    assert(!initialTools.some((t) => t.name === 'save_skill'));
    assert(
      report.requests
        .slice(fifth.requestIndex + 1)
        .some((r) => r.tools.some((t) => (t.function || t).name === 'save_skill')),
    );
    fifth.skill = {
      id: skill.id,
      title: skill.title,
      slug: skill.slug,
      instructions: skill.instructions,
    };
    fifth.passed = true;
    await capture(fifth);
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  await page?.screenshot({ path: join(evidence, 'failure.png'), timeout: 60000 }).catch(() => {});
} finally {
  if (f)
    report.modelUsage = f.store.db
      .prepare(
        'SELECT status,started_at,finished_at,input_tokens,output_tokens,cached_tokens FROM model_usage ORDER BY started_at',
      )
      .all();
  await app?.close();
  await browser?.close();
  await f?.close();
  await rm(directory, { recursive: true, force: true });
  report.cleanedUp = true;
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      checks: report.checks.map((c) => ({
        name: c.name,
        passed: c.passed,
        elapsedMs: c.elapsedMs,
      })),
      error: report.error,
    }),
  );
}
