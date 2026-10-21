// SPDX-License-Identifier: MIT
// Real Whisper, local chat inference and Mac speech; synthetic spoken microphone,
// independently authored MCP documents, and a disposable workspace only.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { appContentFixture } from './app-content-fixture.mjs';
import { listeningMicrophoneScript } from './listening-microphone-fixture.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { LocalListeningInstallation } from '../server/local-listening-installation.mjs';
import { LocalTranscriptionService } from '../server/local-transcription.mjs';
import { SystemSpeechService } from '../server/system-speech.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { inspectVoiceResultOnAndroid } from './voice-result-android.mjs';

const model = process.env.RELAY_VOICE_TEST_MODEL;
const replyMode = process.env.RELAY_VOICE_TEST_REPLY_MODE || 'quick';
assert(['quick', 'default'].includes(replyMode), 'Choose quick or default local reasoning.');
const mac = process.argv.includes('--mac');
const withComputer = process.argv.includes('--computer');
const withWriteAttach = process.argv.includes('--write-attach');
const withBatchSources = process.argv.includes('--batch-sources');
if (withBatchSources)
  assert(!withComputer, 'Selected-source acceptance uses the two-turn document journey.');
if (withWriteAttach) assert(withComputer, 'Write-and-attach acceptance requires the computer.');
const withAndroid = process.argv.includes('--android');
if (withAndroid) assert(withComputer, 'Android delivery requires the computer journey.');
const dockerHost = process.env.RELAY_COMPUTER_TEST_DOCKER_HOST;
if (withComputer)
  assert(dockerHost?.startsWith('unix:///'), 'Choose a dedicated local test engine.');
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed model and independent acceptance cache.');
assert.equal(process.platform, 'darwin', 'This acceptance uses installed Mac speech.');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/voice-context-live');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-voice-context-live-'));
const cache = resolve('../../work/local-listening-research');
const code = String(randomInt(10000, 99999)),
  room = `Cedar ${randomInt(100, 999)}`;
const remote = await appContentFixture({
  resourceText: () => `Meet at noon. Bring a book. Meeting code: ${code}.`,
});
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  surface: mac ? 'packaged Mac renderer' : 'Chromium',
  code,
  room,
  turns: [],
  modelRequests: [],
  scope:
    'Real local Whisper Base, Qwen inference, MCP reads and Mac speech; synthetic spoken audio, no physical microphone, real accounts or private-computer execution.',
};
if (withComputer)
  report.scope =
    'Actual local speech recognition, model, app reads, private Linux computer and export; synthetic spoken input. The first completed file-write receipt is held until the spoken correction arrives to exercise deterministic in-flight steering. Phone-width renderer checks are always included; the optional Android receipt records native emulator delivery and desktop continuation. No physical audio or owner accounts.';
let f, browser, app, page, installation, transcription, computer, computerSetup;
let heldWrite = false,
  releaseWrite;
const writeGate = new Promise((resolve) => {
  releaseWrite = resolve;
});
const computerWork = { operations: [], initialText: '', finalText: '' };

const timings = [],
  speech = [],
  errors = [];
try {
  f = await localModelStartFixture(directory, {
    modelsDirectory,
    isolatedPort: 41334,
    async configure(store, services) {
      if (withComputer) {
        computer = services.computer = new PrivateComputer(store, { deployment: directory });
        computerSetup = services.computerSetup = new ComputerSetup(computer, {
          root: resolve('.'),
          environment: { DOCKER_HOST: dockerHost },
        });
        report.computerResources = {
          name: computer.name,
          commandName: computer.runtime.name,
          volume: computer.volume,
          displayVolume: computer.displayVolume,
        };
        computerSetup.start();
        await computerSetup.pending;
        assert.equal(computerSetup.status().phase, 'ready', computerSetup.status().error);
        await computer.start();
        const perform = computer.perform.bind(computer);
        computer.perform = async (input, ...args) => {
          const result = await perform(input, ...args);
          const operation = {
            id: input.operationId,
            kind: input.kind,
            action: input.action,
            path: input.path,
            command: input.command,
            repeated: result.repeated || false,
          };
          computerWork.operations.push(operation);
          if (
            !heldWrite &&
            (input.kind === 'exec' || (input.kind === 'files' && input.action === 'write'))
          ) {
            const paths =
              input.kind === 'files'
                ? [input.path]
                : (await computer.list('/workspace')).entries
                    .filter((f) => f.kind === 'file' && /brief.*\.md$/i.test(f.name))
                    .map((f) => '/workspace/' + f.name);
            const path = paths.find((p) => /brief.*\.md$/i.test(p || ''));
            const file = path && (await computer.read(path).catch(() => null));
            if (file) {
              computerWork.path = path;
              computerWork.name = file.name;
              computerWork.initialText = Buffer.from(file.base64, 'base64').toString();
              heldWrite = true;
              console.log(
                'CHECKPOINT first actual brief write completed; holding its receipt for spoken correction',
              );
              await writeGate;
            }
          }
          return result;
        };
      }
      services.connectors = new Connectors(store, { key: modelVaultKey(directory) });
      const found = await services.connectors.discover({
        name: 'Little library',
        endpoint: remote.endpoint,
      });
      services.connectors.save({
        discoveryId: found.discoveryId,
        permissions: Object.fromEntries(
          found.connection.tools.map((tool) => [tool.name, tool.ownerChoice ? 'ask' : 'auto']),
        ),
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
      const original = transcription.transcribe.bind(transcription);
      transcription.transcribe = async (...args) => {
        const start = performance.now();
        const result = await original(...args);
        timings.push({ recognitionMs: Math.round(performance.now() - start), text: result.text });
        return result;
      };
      const system = new SystemSpeechService({ temporaryRoot: directory });
      const synthesize = system.synthesize.bind(system);
      system.synthesize = async (...args) => {
        const start = performance.now();
        let firstAudioMs;
        const onAudio = args[2];
        if (onAudio)
          args[2] = async (part) => {
            firstAudioMs ??= Math.round(performance.now() - start);
            await onAudio(part);
          };
        const bytes = await synthesize(...args);
        speech.push({
          text: args[0],
          ...(firstAudioMs !== undefined ? { firstAudioMs } : {}),
          milliseconds: Math.round(performance.now() - start),
          bytes: bytes.length,
        });
        await writeFile(join(evidence, `reply-${speech.length}.wav`), bytes);
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
    replyMode,
    apiKey: '',
    activate: true,
  });
  const fetcher = f.provider.fetcher;
  report.computerToolCalls = [];
  f.provider.fetcher = (url, init) => {
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      // forRun creates a bound provider; its HTTP history is the actual observed
      // tool trace. Finished worker checkpoints may already have been pruned.
      report.computerToolCalls = (body.messages || []).flatMap((m) =>
        (m.tool_calls || [])
          .filter((c) => c.function.name.startsWith('computer_'))
          .map((c) => {
            let parsed;
            try {
              parsed = JSON.parse(c.function.arguments);
            } catch {
              parsed = { malformed: c.function.arguments };
            }
            return { name: c.function.name, arguments: parsed };
          }),
      );
      report.modelRequests.push({
        startedAt: Date.now(),
        toolCount: body.tools?.length || 0,
        toolNames: (body.tools || []).map((tool) => tool.function?.name || tool.name),
        toolCharacters: JSON.stringify(body.tools || []).length,
        messageCharacters: JSON.stringify(body.messages || []).length,
        imageParts: (body.messages || [])
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((part) => part.type === 'image_url').length,
        reasoningEffort: body.reasoning_effort,
        systemHash: createHash('sha256')
          .update(body.messages?.[0]?.content || '')
          .digest('hex'),
        history: (body.messages || []).map((m) => ({
          role: m.role,
          toolCalls: m.tool_calls?.map((t) => t.function.name),
          toolArgumentCharacters: m.tool_calls?.map((t) => (t.function.arguments || '').length),
          ...(withBatchSources
            ? {
                selectedSourceCalls: (m.tool_calls || [])
                  .filter((t) => t.function.name === 'read_selected_sources')
                  .map((t) => JSON.parse(t.function.arguments)),
              }
            : {}),
          characters: JSON.stringify(m.content || '').length,
        })),
      });
    }
    return fetcher(url, init);
  };
  const synthesizer = new SystemSpeechService({ temporaryRoot: directory });
  const prompts = withComputer
    ? [
        'Read the weekend plan and budget file in Little library, and my attached note. On your computer, create a Markdown file called Meeting Brief with the meeting time, room, what to bring, meeting code, and total cost. Attach that file here.',
        'Actually, bring a sketchbook instead of a book. Keep the other meeting details. Update that same brief file on your computer and attach the corrected file here.',
      ]
    : [
        'Please read the weekend plan and budget file in Little library, and my attached note. Tell me the meeting time, room, what to bring, meeting code, and total cost. Keep it brief.',
        'Actually, I will bring a sketchbook instead of a book. Give me the corrected brief in two sentences.',
      ];
  const recordings = [];
  for (let i = 0; i < prompts.length; i++) {
    const bytes = await synthesizer.synthesize(prompts[i]);
    recordings.push(bytes.toString('base64'));
    await writeFile(join(evidence, `request-${i + 1}.wav`), bytes);
  }
  let context;
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
      BrowserWindow.getAllWindows().forEach((w) => w.showInactive()),
    );
    context = page.context();
    await page.setViewportSize({ width: 1280, height: 900 });
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    page = await context.newPage();
  }
  await context.addInitScript({ content: listeningMicrophoneScript(recordings[0]) });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(f.url + '/#chat');
  const composer = page.locator('.composer textarea');
  await expect(composer).toBeVisible();
  // Electron's initial page can predate context init scripts. Install and verify
  // the test input after navigation, before any gesture can ask for a real mic.
  if (mac) await page.evaluate(listeningMicrophoneScript(recordings[0]));
  assert(await page.evaluate(() => window.__listeningQA?.syntheticInstalled === true));
  await composer.fill('@Little');
  await page.getByRole('option', { name: 'Little library app', exact: true }).click();
  await page.locator('.composer input[type=file]').setInputFiles({
    name: 'Meeting room.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`Meeting room: ${room}.`),
  });
  await expect.poll(() => f.store.read().threads[0].draftFileIds?.length).toBe(1);
  await composer.fill('Keep my unfinished typed message.');
  await expect
    .poll(() => f.store.read().threads[0].draft)
    .toBe('Keep my unfinished typed message.');
  const dictate = await page
    .getByRole('button', { name: 'Start voice input', exact: true })
    .boundingBox();
  const talk = await page
    .getByRole('button', { name: 'Start voice chat', exact: true })
    .boundingBox();
  assert(dictate && talk && dictate.x + dictate.width <= talk.x, 'Voice controls overlap');
  await page.screenshot({ path: join(evidence, 'ready-to-talk.png') });
  const draftFileIds = f.store.read().threads[0].draftFileIds;
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  const call = page.getByRole('region', { name: 'Voice chat', exact: true });
  await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 15000 });
  await expect(call).toContainText('Using 1 file · Little library');
  if (withComputer) {
    const start = Date.now();
    await page.evaluate(() => window.__listeningQA.pulse());
    const deadline = Date.now() + 360000;
    while (!heldWrite) {
      const run = f.store.read().runs.at(-1);
      assert(
        !run || ['queued', 'running'].includes(run.status),
        `Work ended before the computer write: ${run?.error || run?.status}`,
      );
      assert(Date.now() < deadline, 'No actual computer file was created before the deadline');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(computerWork.initialText.includes(code) && computerWork.initialText.includes(room));
    assert.match(computerWork.initialText, /33/);
    assert.match(computerWork.initialText, /book/i);
    const first = f.store.read().voiceCalls.at(-1).turns[0];
    await page.evaluate(async (base64) => {
      const qa = window.__listeningQA;
      qa.nextBuffer = await qa.contexts[0].decodeAudioData(
        Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer,
      );
    }, recordings[1]);
    const correction = page.evaluate(() => window.__listeningQA.pulse());
    await expect
      .poll(() => f.store.read().voiceCalls.at(-1).listening, { timeout: 10000 })
      .toBe(true);
    await page.screenshot({ path: join(evidence, 'correcting-during-work.png') });
    await correction;
    await expect
      .poll(
        () =>
          f.store
            .read()
            .voiceCalls.at(-1)
            .turns.filter((t) => t.runId).length,
        { timeout: 70000 },
      )
      .toBe(2);
    const second = f.store.read().voiceCalls.at(-1).turns[1];
    assert.equal(second.runId, first.runId);
    assert.notEqual(second.messageId, first.messageId);
    const correctedAt = Date.now();
    releaseWrite();
    await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 360000 });
    const state = f.store.read(),
      run = state.runs.at(-1);
    assert.equal(run.status, 'completed');
    assert.equal(state.runs.length, 1);
    assert.equal(run.steeringApplied, 1);
    const answer = state.messages.findLast(
      (m) => m.replyTo === second.messageId && m.role === 'assistant',
    );
    assert(answer?.text);
    const file = state.files.find((f) => f.name === computerWork.name);
    assert(
      file && answer.cards.some((c) => c.kind === 'file' && c.id === file.id),
      'The corrected computer file must be attached to its reply',
    );
    const finalBytes = Buffer.from((await computer.read(computerWork.path)).base64, 'base64');
    const exported = file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.text);
    assert.deepEqual(exported, finalBytes);
    computerWork.finalText = finalBytes.toString();
    assert(computerWork.finalText.includes(code) && computerWork.finalText.includes(room));
    assert.match(computerWork.finalText, /noon|12(?::00)?/i);
    assert.match(computerWork.finalText, /33/);
    assert.match(computerWork.finalText, /sketchbook/i);
    assert(!computerWork.operations.some((x) => x.repeated));
    if (withWriteAttach) {
      const writes = report.computerToolCalls.filter(
        (c) => c.name === 'computer_files' && c.arguments.action === 'write',
      );
      assert.equal(writes.length, 2, 'Exactly the original and corrected writes are expected');
      assert(
        writes.every((c) => c.arguments.attach === true),
        'The model must choose combined verified delivery',
      );
      assert(
        !report.computerToolCalls.some((c) => c.name === 'computer_export'),
        'No separate export round trip',
      );
      assert.equal(
        state.files.filter((f) => f.source === 'Computer').length,
        1,
        'The superseded first write must not create an attachment',
      );
      report.verifiedWriteAttachment = true;
    }
    await writeFile(join(evidence, 'Brief.md'), finalBytes);
    computerWork.fileId = file.id;
    computerWork.sha256 = createHash('sha256').update(finalBytes).digest('hex');
    report.computer = computerWork;
    report.turns = [first, second].map((t, i) => ({
      prompt: prompts[i],
      transcript: state.messages.find((m) => m.id === t.messageId).text,
      runId: t.runId,
      messageId: t.messageId,
      status: i ? 'completed' : 'redirected',
      ...(i
        ? {
            answer: answer.text,
            correctionToAudioMs: Date.now() - correctedAt,
            totalJourneyMs: Date.now() - start,
          }
        : {}),
    }));
    await page.screenshot({ path: join(evidence, 'computer-result.png') });
    await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 120000 });
    console.log(
      'PASS spoken computer request: one run, two spoken turns, actual corrected file export',
    );
  }
  for (let i = 0; !withComputer && i < prompts.length; i++) {
    const requestCountBeforeTurn = report.modelRequests.length;
    if (i) {
      // Replace only the independently generated input buffer, not any app logic.
      await page.evaluate(async (base64) => {
        const qa = window.__listeningQA,
          audio = qa.contexts[0];
        const buffer = await audio.decodeAudioData(
          Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer,
        );
        qa.nextBuffer = buffer;
      }, recordings[i]);
    }
    const started = performance.now();
    await page.evaluate(() => window.__listeningQA.pulse());
    const utteranceEnded = performance.now();
    await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 240000 });
    const firstAudio = performance.now();
    const s = f.store.read(),
      run = s.runs.at(-1);
    const message = s.messages.find((m) => m.id === run.messageId);
    const answer = s.messages.findLast(
      (m) => m.replyTo === run.messageId && m.role === 'assistant',
    );
    const record = {
      prompt: prompts[i],
      transcript: message.text,
      answer: answer.text,
      recognition: timings.at(-1),
      utteranceToAudioMs: Math.round(firstAudio - started),
      endOfUtteranceToAudioMs: Math.round(firstAudio - utteranceEnded),
      status: run.status,
    };
    report.turns.push(record);
    assert.equal(run.status, 'completed');
    assert.equal(s.runs.length, i + 1, 'A spoken sentence became duplicate turns');
    assert.deepEqual(message.fileIds, draftFileIds);
    assert.equal(message.appContext[0].name, 'Little library');
    assert(answer.text.includes(code));
    assert(answer.text.includes(room));
    assert.match(answer.text, /noon|12(?::00)?/i);
    assert.match(answer.text, /33/);
    assert.match(answer.text, i ? /sketchbook/i : /book/i);
    if (withBatchSources) {
      if (i) {
        // This fixture uses short meeting details without abbreviations or
        // decimal amounts. Keep its explicit two-sentence instruction checked.
        record.sentenceCount = answer.text
          .replace(/[*_`]/g, '')
          .trim()
          .split(/(?<=[.!?])\s+/u).length;
        assert.equal(
          record.sentenceCount,
          2,
          'The correction must honor its requested two sentences',
        );
      }
      const requests = report.modelRequests.slice(requestCountBeforeTurn);
      assert.equal(
        requests.length,
        i ? 1 : 2,
        'Read selected context in one tool step, then reuse it for the correction',
      );
      if (!i) {
        const calls = requests.at(-1).history.flatMap((m) => m.selectedSourceCalls || []);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sources.length, 3);
        assert.equal(new Set(calls[0].sources).size, 3);
        assert.equal(
          answer.cards.filter((c) => c.kind === 'file' && c.purpose === 'source').length,
          2,
        );
        report.selectedSourceRead = { sources: calls[0].sources, modelRequests: requests.length };
      }
    }
    await page.screenshot({ path: join(evidence, `turn-${i + 1}.png`) });
    await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 120000 });
    console.log(`PASS spoken turn ${i + 1}: ${record.endOfUtteranceToAudioMs} ms after utterance`);
  }
  await call.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(composer).toHaveValue('Keep my unfinished typed message.');
  assert.deepEqual(f.store.read().threads[0].draftFileIds, draftFileIds);
  assert.equal(f.store.read().threads[0].draftApps.length, 1);
  assert(remote.calls.some((c) => c.params.uri === 'notebook://saved/weekend'));
  assert(remote.calls.some((c) => c.params.uri === 'file:///only-on-app/Budget.csv'));
  if (withBatchSources) assert.equal(remote.calls.length, 2, 'Each app document is read once');
  assert.equal(speech.length, withComputer ? 1 : 2);
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
  await expect(composer).toHaveValue('Keep my unfinished typed message.');
  if (withComputer)
    await expect(
      page.locator('.messages').getByRole('button').filter({ hasText: computerWork.name }),
    ).toBeVisible();
  else
    await expect(
      page.locator('.message.assistant .message-content').filter({ hasText: 'sketchbook' }).last(),
    ).toContainText('sketchbook');
  assert((await composer.boundingBox()).width > 300, 'Phone draft must retain a full text row');
  assert.equal(f.store.read().runs.length, withComputer ? 1 : 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'phone-result.png') });
  if (withComputer) {
    const messages = f.store.read().messages.length;
    await page
      .locator('.messages')
      .getByRole('button')
      .filter({ hasText: computerWork.name })
      .click();
    await expect(page.locator('.document-preview')).toContainText(/sketchbook/i);
    await expect(page.locator('.document-preview')).toContainText(code);
    let downloadedBytes;
    if (mac) {
      const destination = join(directory, 'verified-brief.md');
      await app.evaluate(({ BrowserWindow }, path) => {
        globalThis.__voiceDownload = { state: 'waiting' };
        BrowserWindow.getAllWindows()[0].webContents.session.once(
          'will-download',
          (_event, item) => {
            item.setSavePath(path);
            item.once('done', (_event, state) => {
              globalThis.__voiceDownload.state = state;
            });
          },
        );
      }, destination);
      await page.getByRole('link', { name: 'Download', exact: true }).click();
      await expect
        .poll(() => app.evaluate(() => globalThis.__voiceDownload.state), { timeout: 30000 })
        .toBe('completed');
      downloadedBytes = await readFile(destination);
    } else {
      const pending = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download', exact: true }).click();
      downloadedBytes = await readFile(await (await pending).path());
    }
    assert.equal(createHash('sha256').update(downloadedBytes).digest('hex'), computerWork.sha256);
    assert.equal(f.store.read().messages.length, messages);
    await page.screenshot({ path: join(evidence, 'phone-file.png') });
  }
  if (withAndroid) {
    const file = f.store.read().files.find((f) => f.id === computerWork.fileId);
    const draft = 'Which item is in the corrected brief? Answer in one sentence.';
    report.android = await inspectVoiceResultOnAndroid({
      url: f.url,
      file,
      bytes: Buffer.from(computerWork.finalText),
      evidence,
      draft,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(f.url + '/#chat');
    await expect(composer).toHaveValue(draft);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => f.store.read().runs.at(-1)?.status, { timeout: 180000 })
      .toBe('completed');
    assert.equal(f.store.read().runs.length, 2);
    const latest = f.store.read().messages.findLast((m) => m.role === 'assistant' && m.replyTo);
    assert.match(latest.text, /sketchbook/i);
    report.desktopContinuation = latest.text;
    await page.screenshot({ path: join(evidence, 'desktop-continuation.png') });
  }
  assert.deepEqual(errors, []);
  report.speech = speech;
  report.calls = remote.calls;
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  if (error.androidReport) report.android = error.androidReport;
  if (f) report.state = { runs: f.store.read().runs, messages: f.store.read().messages };
  if (withComputer) report.computer = computerWork;
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  releaseWrite();
  await f?.worker.stop();
  if (computer) {
    report.computerReceipts = computer.receipts();
    try {
      await computer.stop();
      if (await computer.inspect()) await computer.checked(['rm', '-f', computer.name]);
      for (const volume of [computer.volume, computer.displayVolume]) {
        if ((await computer.dockerRun(['volume', 'inspect', volume])).exitCode === 0)
          await computer.checked(['volume', 'rm', volume]);
        assert.notEqual((await computer.dockerRun(['volume', 'inspect', volume])).exitCode, 0);
      }
      const remaining = (await computer.checked(['ps', '-a', '--format', '{{.Names}}'])).split(
        '\n',
      );
      assert(!remaining.includes(computer.name) && !remaining.includes(computer.runtime.name));
    } catch (error) {
      report.cleanupError = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  await browser?.close();
  await app?.close();
  await installation?.close();
  await transcription?.close();
  report.recognition = timings;
  report.speech = speech;
  if (f)
    report.modelUsage = f.store.db
      .prepare(
        'SELECT purpose,status,started_at,finished_at,input_tokens,output_tokens,cached_tokens,reasoning_tokens FROM model_usage ORDER BY started_at',
      )
      .all();
  await f?.close();
  await remote.close();
  await rm(directory, { recursive: true, force: true });
  report.cleanedUp = !report.cleanupError;
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ passed: report.passed, evidence, error: report.error?.slice(0, 300) }),
  );
}
