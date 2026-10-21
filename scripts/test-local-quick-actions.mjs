// SPDX-License-Identifier: MIT
// Actual tool-capable local inference using an explicit existing test cache.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../shared/domain.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const model = process.env.RELAY_HISTORY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed test model and isolated weight directory.');
const directory = await mkdtemp(join(tmpdir(), 'relay-quick-actions-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
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
  assert.equal(f.provider.current.replyMode, 'quick');
  const requests = [],
    transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    return transport(url, init);
  };
  const marker = 'ORCHARD-' + randomInt(1000, 9999);
  const started = performance.now();
  const run = f.store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: `Create a plain text file called quick-reply-proof.txt containing exactly ${marker}. Use write_note to save it, then tell me it was saved.`,
    }),
  );
  const deadline = Date.now() + 180000;
  while (
    ['queued', 'running'].includes(f.store.read().runs.find((r) => r.id === run.id)?.status) &&
    Date.now() < deadline
  )
    await delay(100);
  const result = f.store.read().runs.find((r) => r.id === run.id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const file = f.store.read().files.find((f) => f.name === 'quick-reply-proof.txt');
  assert(file, 'A real saved file is required, not an assistant claim.');
  assert.equal(Buffer.from(file.base64, 'base64').toString('utf8'), marker);
  assert.equal(f.store.read().files.length, 1);
  assert(requests.length >= 2);
  assert(requests.every((r) => r.reasoning_effort === 'none'));
  assert(requests[0].tools.some((t) => t.function.name === 'write_note'));
  assert(
    requests.some((r) =>
      r.messages.some((m) => m.tool_calls?.some((t) => t.function.name === 'write_note')),
    ),
  );
  assert(
    f.store
      .read()
      .messages.findLast((m) => m.role === 'assistant')
      .cards.some((c) => c.kind === 'file' && c.id === file.id),
  );
  const receipt = {
    checkedAt: new Date().toISOString(),
    passed: true,
    model,
    replyMode: 'quick',
    elapsedMs: Math.round(performance.now() - started),
    requests: requests.length,
    file: { name: file.name, bytes: file.size, content: marker },
    checks: [
      'Advertised quick reasoning control',
      'Real model tool selection and arguments',
      'Exact file bytes and visible result card',
      'Tool result followed by real final response',
    ],
    scope:
      'Actual local model and ordinary worker/tool loop. No external service, native computer action or general model-quality certification.',
  };
  await writeFile(
    join(evidence, 'quick-replies-actions-live.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log('PASS actual quick assistant action', JSON.stringify(receipt));
} finally {
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
