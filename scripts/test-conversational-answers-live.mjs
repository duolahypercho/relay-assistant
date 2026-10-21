// SPDX-License-Identifier: MIT
// Actual local inference, recognition and speech in an isolated Mac workspace.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { listeningMicrophoneScript } from './listening-microphone-fixture.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { LocalListeningInstallation } from '../server/local-listening-installation.mjs';
import { LocalTranscriptionService } from '../server/local-transcription.mjs';
import { SystemSpeechService } from '../server/system-speech.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';

const model = process.env.RELAY_VOICE_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const voiceOnly = process.argv.includes('--voice-only');
assert(model && modelsDirectory, 'Choose an installed test model and independent model cache.');
assert.equal(process.platform, 'darwin');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/conversational-answers/live',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-conversational-answer-'));
const cache = resolve('../../work/local-listening-research');
const marker = 'COMET-' + randomInt(10000, 99999);
const spokenName = 'Meeting Notes';
const spokenPrompt = `Please name the file ${spokenName}.`;
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  voiceOnly,
  marker,
  scope:
    'Actual local model, Mac renderer, Whisper Base and system speech. One normal-composer answer after a topic change and one spoken answer resume saved requests. Synthetic microphone audio; no physical acoustics, owner accounts or email sending.',
  checks: [],
  requests: [],
  inference: [],
  recognition: [],
  modelErrors: [],
  speech: [],
};
if (voiceOnly)
  report.scope =
    'Focused real local model, Mac renderer, Whisper Base and system speech: a required filename question and spoken answer create the exact requested file once. Synthetic microphone; no email journey, physical acoustics or owner accounts.';
report.runtimeSources = await Promise.all(
  [
    'server/agent.mjs',
    'server/agent-checkpoint.mjs',
    'server/voice-tool-catalog.mjs',
    'server/text-file-completion.mjs',
    'server/skill-completion.mjs',
    'server/model.mjs',
    'server/model-failover.mjs',
    'shared/model-catalog.mjs',
    'shared/questions.mjs',
    'shared/chat-question-answers.mjs',
  ].map(async (path) => ({
    path,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  })),
);
let f, app, page, installation, transcription;
const errors = [];
let cleaningUp = false;
async function record(check) {
  report.checks.push(check);
  await writeFile(join(evidence, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('CHECKPOINT ' + check.name + ': ' + (check.passed ? 'passed' : 'failed'));
}
try {
  f = await localModelStartFixture(directory, {
    modelsDirectory,
    isolatedPort: 41334,
    async configure(store, services) {
      store.mutate((s) => {
        s.profile.memoryLearning = false;
      });
      installation = new LocalListeningInstallation(store, directory, {
        fetcher: async (url) => {
          const bytes = await readFile(
            join(cache, url.includes('github.com') ? 'whisper.zip' : 'ggml-base.bin'),
          );
          return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
        },
      });
      transcription = new LocalTranscriptionService(installation, { temporaryRoot: directory });
      const transcribe = transcription.transcribe.bind(transcription);
      transcription.transcribe = async (...args) => {
        const start = performance.now();
        const result = await transcribe(...args);
        report.recognition.push({
          text: result.text,
          milliseconds: Math.round(performance.now() - start),
        });
        return result;
      };
      const system = new SystemSpeechService({ temporaryRoot: directory });
      const synthesize = system.synthesize.bind(system);
      system.synthesize = async (...args) => {
        const start = performance.now(),
          bytes = await synthesize(...args);
        report.speech.push({
          text: args[0],
          bytes: bytes.length,
          milliseconds: Math.round(performance.now() - start),
        });
        await writeFile(join(evidence, `reply-${report.speech.length}.wav`), bytes);
        return bytes;
      };
      const voice = (services.voiceConnections = new VoiceConnections(store, {
        key: modelVaultKey(directory),
        localTranscription: transcription,
        systemSpeech: system,
      }));
      installation.voice = voice;
      services.localListeningInstallation = installation;
      services.transcription = voice.transcription;
      services.speech = voice.speech;
      installation.start({ id: randomUUID(), revision: 0, speechRevision: 0 });
      await installation.pending;
      assert(
        voice.transcription.configured && voice.speech.configured,
        JSON.stringify(installation.status()),
      );
    },
  });
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    replyMode: 'quick',
    apiKey: '',
    activate: true,
  });
  const makeProvider = f.provider.provider.bind(f.provider);
  f.provider.provider = (...args) => {
    const provider = makeProvider(...args);
    const complete = provider.complete.bind(provider);
    provider.complete = async (messages, tools, options) => {
      const timing = {
        model: provider.model,
        toolCount: tools.length,
        toolCharacters: JSON.stringify(tools).length,
        messageCharacters: JSON.stringify(messages).length,
        systemCharacters: messages
          .filter((m) => m.role === 'system')
          .reduce((n, m) => n + String(m.content || '').length, 0),
      };
      report.inference.push(timing);
      const start = performance.now();
      try {
        const result = await complete(messages, tools, options);
        timing.toolCalls = result.toolCalls.map((c) => c.function.name);
        timing.usage = result.usage;
        timing.completed = true;
        return result;
      } catch (error) {
        timing.error = error.message;
        throw error;
      } finally {
        timing.elapsedMs = Math.round(performance.now() - start);
      }
    };
    return provider;
  };
  const fetcher = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
    const result = await fetcher(url, init);
    if (!result.ok && url.endsWith('/chat/completions'))
      report.modelErrors.push({
        status: result.status,
        body: (await result.clone().text()).slice(0, 8192),
      });
    return result;
  };
  const recording = await new SystemSpeechService({ temporaryRoot: directory }).synthesize(
    spokenPrompt,
  );
  await writeFile(join(evidence, 'spoken-answer.wav'), recording);
  report.inputSpeech = {
    text: spokenPrompt,
    requestedName: spokenName,
    sha256: createHash('sha256').update(recording).digest('hex'),
  };
  const data = join(directory, 'desktop');
  await mkdir(data);
  await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${data}`],
  });
  app.process().stderr?.on('data', (bytes) => {
    report.desktopStderr = ((report.desktopStderr || '') + bytes.toString()).slice(-8000);
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('crash', () => {
    report.rendererCrashed = true;
  });
  page.on('close', () => {
    if (!cleaningUp) report.pageClosedUnexpectedly = true;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(f.url + '/#chat');
  await page.evaluate(listeningMicrophoneScript(recording.toString('base64')));
  assert(await page.evaluate(() => window.__listeningQA?.syntheticInstalled === true));
  const composer = page.getByLabel('Message Relay', { exact: true });
  async function finish(run) {
    await expect
      .poll(() => f.store.read().runs.find((r) => r.id === run.id)?.status, {
        timeout: 300000,
        intervals: [250, 1000],
      })
      .toMatch(/^(completed|failed|waiting)$/);
    const state = f.store.read(),
      finished = state.runs.find((r) => r.id === run.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    const reply = state.messages.findLast(
      (m) => m.role === 'assistant' && m.replyTo === run.messageId,
    );
    assert(reply);
    await expect(page.locator(`[id="message-${reply.id}"]`)).toBeVisible({ timeout: 15000 });
    return { finished, reply };
  }
  async function send(text) {
    const count = f.store.read().runs.length;
    const start = performance.now();
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => f.store.read().runs.length).toBe(count + 1);
    const run = f.store.read().runs.at(-1);
    return { ...(await finish(run)), elapsedMs: Math.round(performance.now() - start) };
  }
  let attachmentId = null;
  const priorRuns = voiceOnly ? 0 : 3;
  if (!voiceOnly) {
    const attachmentBytes = Buffer.from(`Workshop checklist ${marker}\nNotebook\n`);
    await page.locator('.composer input[type=file]').setInputFiles({
      name: `Checklist-${marker}.txt`,
      mimeType: 'text/plain',
      buffer: attachmentBytes,
    });
    await expect.poll(() => f.store.read().threads[0].draftFileIds?.length).toBe(1);
    attachmentId = f.store.read().threads[0].draftFileIds[0];
    const first = await send(
      `Draft an email for my review. Subject: "Workshop ${marker}". Body: "See you at 14:00.\nBring a notebook." Attach my uploaded checklist. I have not given the recipient address: ask me for it. Do not send.`,
    );
    const question = f.store
      .read()
      .questions.find((q) => q.sourceRunId === first.finished.id && q.status === 'pending');
    assert(question, 'The missing recipient must be a saved question.');
    assert.equal(f.store.read().approvals.length, 0);
    await page.screenshot({ path: join(evidence, 'recipient-question.png'), timeout: 60000 });
    await record({
      name: 'recipient-question',
      passed: true,
      elapsedMs: first.elapsedMs,
      question,
    });
    const topic = await send(
      'Before that, what is 17 plus 25? Answer in one short sentence. Leave the email unfinished.',
    );
    assert.match(topic.reply.text, /42/);
    assert.equal(f.store.read().questions.find((q) => q.id === question.id).status, 'pending');
    assert.equal(f.store.read().approvals.length, 0);
    assert(!topic.finished.questionContext);
    await record({
      name: 'new-topic-keeps-question',
      passed: true,
      elapsedMs: topic.elapsedMs,
      answer: topic.reply.text,
    });
    const typed = await send('friend@example.test');
    const answered = f.store.read().questions.find((q) => q.id === question.id);
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answerRunId, typed.finished.id);
    assert.equal(answered.answerMessageId, typed.finished.messageId);
    assert.equal(answered.answeredInChat, true);
    assert.equal(f.store.read().runs.length, 3);
    assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 3);
    assert.equal(
      f.store.read().files.length,
      1,
      'The email review must reuse the original attachment without creating unsolicited files.',
    );
    const reviews = f.store.read().approvals;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].status, 'pending');
    assert.equal(reviews[0].kind, 'email');
    for (const [key, value] of Object.entries({
      to: 'friend@example.test',
      subject: `Workshop ${marker}`,
      body: 'See you at 14:00.\nBring a notebook.',
      attachmentIds: [attachmentId],
    }))
      assert.deepEqual(reviews[0].payload[key], value, key);
    assert.equal(
      Buffer.from(f.store.read().files.find((f) => f.id === attachmentId).base64, 'base64').compare(
        attachmentBytes,
      ),
      0,
    );
    assert(typed.reply.cards.some((c) => c.kind === 'review' && c.id === reviews[0].id));
    await page.screenshot({ path: join(evidence, 'typed-answer-review.png'), timeout: 60000 });
    await record({
      name: 'normal-composer-resumes-exact-review',
      passed: true,
      elapsedMs: typed.elapsedMs,
      review: reviews[0],
      attachmentSha256: createHash('sha256').update(attachmentBytes).digest('hex'),
    });
  }
  const text = `Meeting reference ${marker}. Bring a sketchbook.`;
  const note = await send(
    `Create a downloadable plain text file containing exactly "${text}". First ask me what to name the file, then wait for my answer before saving it. Use a .txt extension.`,
  );
  const nameQuestion = f.store
    .read()
    .questions.find((q) => q.sourceRunId === note.finished.id && q.status === 'pending');
  assert(nameQuestion, 'The filename must be a saved question.');
  assert.equal(f.store.read().files.length, voiceOnly ? 0 : 1);
  await record({
    name: 'filename-question',
    passed: true,
    elapsedMs: note.elapsedMs,
    question: nameQuestion,
  });
  await composer.fill('Keep my next typed thought');
  await expect.poll(() => f.store.read().threads[0].draft).toBe('Keep my next typed thought');
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  const call = page.getByRole('region', { name: 'Voice chat', exact: true });
  await expect(call.getByRole('status')).toHaveText('Listening');
  const start = performance.now();
  await page.evaluate(() => window.__listeningQA.pulse());
  const utteranceEnded = performance.now();
  await expect
    .poll(
      async () =>
        f.store.read().runs.length === priorRuns + 2 ||
        (await call.getByRole('button', { name: 'Retry this turn', exact: true }).isVisible()),
      { timeout: 70000 },
    )
    .toBe(true);
  if (f.store.read().runs.length === priorRuns + 1) {
    const reason = await call.innerText();
    assert.match(reason, /Local listening took too long/);
    report.voiceRetry = { reason, elapsedMs: Math.round(performance.now() - start) };
    await page.screenshot({ path: join(evidence, 'voice-retry.png'), timeout: 60000 });
    await call.getByRole('button', { name: 'Retry this turn', exact: true }).click();
  }
  await expect.poll(() => f.store.read().runs.length, { timeout: 70000 }).toBe(priorRuns + 2);
  const spokenRun = f.store.read().runs.at(-1);
  const spoken = await finish(spokenRun);
  // Observe actual audio start rather than racing a brief Speaking label.
  // The first start is the synthetic microphone, the second is Relay playback.
  await expect
    .poll(() => page.evaluate(() => window.__listeningQA.playback), { timeout: 30000 })
    .toBe(2);
  report.playbackStarts = 2;
  const firstAudio = performance.now();
  const spokenQuestion = f.store.read().questions.find((q) => q.id === nameQuestion.id);
  assert.equal(spokenQuestion.status, 'answered');
  assert.equal(spokenQuestion.answerRunId, spokenRun.id);
  assert.equal(spokenQuestion.answerMessageId, spokenRun.messageId);
  assert.equal(spokenQuestion.answeredInChat, true);
  assert(
    spokenQuestion.answer.toLowerCase().includes(spokenName.toLowerCase()),
    spokenQuestion.answer,
  );
  assert.equal(report.recognition.length, 1);
  assert.equal(spokenQuestion.answer, report.recognition[0].text.trim());
  assert.equal(report.speech.length, 1);
  assert(spoken.finished.voiceCallId);
  const files = f.store.read().files.filter((f) => f.id !== attachmentId);
  assert.equal(files.length, 1);
  assert.equal(
    files[0].name.replace(/[_-]/g, ' ').toLowerCase(),
    `${spokenName}.txt`.toLowerCase(),
  );
  assert.equal(Buffer.from(files[0].base64, 'base64').toString(), text);
  assert(spoken.reply.cards.some((c) => c.kind === 'file' && c.id === files[0].id));
  assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, priorRuns + 2);
  assert.equal(f.store.read().approvals.length, voiceOnly ? 0 : 1);
  assert.equal(f.store.read().connections.google.connected, false);
  await page.screenshot({ path: join(evidence, 'spoken-answer-file.png'), timeout: 60000 });
  await record({
    name: 'spoken-answer-continues-once',
    passed: true,
    transcript: spokenQuestion.answer,
    answer: spoken.reply.text,
    file: {
      id: files[0].id,
      name: files[0].name,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
    utteranceToAudioMs: Math.round(firstAudio - start),
    endOfUtteranceToAudioMs: Math.round(firstAudio - utteranceEnded),
  });
  await call.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(composer).toHaveValue('Keep my next typed thought');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__listeningQA.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
    )
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(composer).toHaveValue('Keep my next typed thought');
  await expect(page.locator('.messages')).toContainText(files[0].name);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(f.store.read().runs.length, priorRuns + 2);
  await page.screenshot({ path: join(evidence, 'phone-result.png'), timeout: 60000 });
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  if (f)
    report.state = {
      runs: f.store.read().runs,
      messages: f.store.read().messages,
      questions: f.store.read().questions,
      voiceCalls: f.store.read().voiceCalls,
    };
  await page?.screenshot({ path: join(evidence, 'failure.png'), timeout: 60000 }).catch(() => {});
} finally {
  cleaningUp = true;
  report.rendererErrors = errors;
  report.cleanupErrors = [];
  for (const [name, close] of [
    ['app', () => app?.close()],
    ['worker', () => f?.worker.stop()],
    ['transcription', () => transcription?.close()],
    ['installation', () => installation?.close()],
    ['fixture', () => f?.close()],
    ['scratch', () => rm(directory, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch (error) {
      report.cleanupErrors.push({ name, error: error.message });
    }
  }
  report.cleanedUp = report.cleanupErrors.length === 0;
  if (!report.cleanedUp) {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        evidence,
        checks: report.checks.map((c) => ({ name: c.name, passed: c.passed })),
        error: report.error,
        cleanedUp: report.cleanedUp,
      },
      null,
      2,
    ),
  );
}
