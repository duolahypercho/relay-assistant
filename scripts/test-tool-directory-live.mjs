// SPDX-License-Identifier: MIT
// Real inference and durable tool execution in fictional, isolated workspaces.
// Requests stand in for recognized speech; this does not test physical audio.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { command } from '../shared/domain.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';

const model = process.env.RELAY_VOICE_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose installed weights and an independent model cache.');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/tool-directory-live');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-tool-directory-'));
assert(
  !process.argv.includes('--previous-directory'),
  'The previous directory comparison belongs to its archived source version.',
);
const marker = process.env.RELAY_DIRECTORY_TEST_MARKER || String(randomInt(10000, 99999));
assert(/^\d{5}$/.test(marker), 'Use a five-digit fictional fixture marker.');
const seed = Number(marker);
const skillTitle = `Paperkite ${marker}`;
const assistantName = `Mira ${marker}`;
const location = `Cedar ${100 + (seed % 800)}`;
const pickup = `PEBBLE-${marker}`;
const reminder = `Water the blue fern ${marker}`;
const firstCents = 1000 + (seed % 900);
const secondCents = 2000 + ((seed * 3) % 900);
const total = ((firstCents + secondCents) / 100).toFixed(2);
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode: 'quick',
  directory: 'common lookups immediate; remaining capabilities grouped',
  marker,
  checks: [],
  requests: [],
  scope:
    'Real local inference, immediate common lookup schemas and durable read tools. Fictional saved skills, transactions, calendar, assistants, mail and reminders. Synthetic recognized text; no microphone, owner data, external accounts or sends.',
};
let f;
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
    command(s, 'skill.create', {
      title: skillTitle,
      slug: 'paperkite',
      description: 'A weekly review method.',
      instructions: 'Review the calendar and report the upcoming commitments.',
    });
    command(s, 'assistant.create', {
      name: assistantName,
      description: 'Review hardware repair notes.',
      tone: 'Clear and friendly',
      avatarColor: '#e9ad71',
    });
    command(s, 'routine.create', {
      title: reminder,
      instructions: reminder,
      execution: 'reminder',
      threadId: 'main',
      schedule: {
        kind: 'once',
        date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        time: '09:00',
        timeZone: 'UTC',
      },
    });
    s.transactions = [
      {
        id: 'train',
        date: '2026-11-01',
        description: 'Train',
        category: 'Travel',
        cents: -firstCents,
      },
      { id: 'tea', date: '2026-11-01', description: 'Tea', category: 'Food', cents: -secondCents },
      { id: 'income', date: '2026-11-01', description: 'Salary', category: 'Income', cents: 10000 },
    ];
    s.events = [
      {
        id: 'meeting',
        title: `Design review ${marker}`,
        start: '2026-11-01T10:00:00.000Z',
        end: '2026-11-01T10:30:00.000Z',
        description: 'Bring the revised sketches.',
        location,
        version: 1,
      },
    ];
    s.mail = [
      {
        id: 'receipt',
        from: 'Fictional travel desk',
        email: 'desk@example.invalid',
        to: 'owner@example.invalid',
        subject: `Travel receipt ${marker}`,
        body: `Your pickup word is ${pickup}.`,
        date: '2026-10-20T10:00:00.000Z',
        read: true,
      },
    ];
  });
  const protectedState = () => {
    const s = f.store.read();
    return Object.fromEntries(
      [
        'files',
        'tasks',
        'approvals',
        'memories',
        'goals',
        'skills',
        'routines',
        'transactions',
        'events',
        'mail',
        'assistants',
      ].map((key) => [key, s[key]]),
    );
  };
  const before = protectedState();
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
  const fetcher = f.provider.fetcher;
  f.provider.fetcher = (url, init) => {
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      report.requests.push({
        toolCharacters: JSON.stringify(body.tools || []).length,
        toolNames: (body.tools || []).map((t) => t.function.name),
        results: (body.messages || [])
          .filter((m) => m.role === 'tool')
          .map((m) => ({ id: m.tool_call_id, value: JSON.parse(m.content) })),
        calls: (body.messages || []).flatMap((m) =>
          (m.tool_calls || []).map((t) => ({
            id: t.id,
            name: t.function.name,
            arguments: JSON.parse(t.function.arguments),
          })),
        ),
      });
    }
    return fetcher(url, init);
  };
  const scenarios = [
    {
      name: 'saved methods',
      prompt: 'What reusable methods have I saved? Give their names.',
      tools: ['list_skills'],
      facts: [skillTitle],
    },
    {
      name: 'imported spending',
      prompt:
        'What is my total spending in dollars from all imported transactions, excluding income?',
      tools: ['summarize_finance'],
      facts: [],
      dollars: Number(total),
    },
    {
      name: 'calendar',
      prompt: 'Which appointments do I have on November 1, 2026, in UTC, and where are they?',
      tools: ['list_calendar'],
      facts: ['Design review', location],
    },
    {
      name: 'specialists',
      prompt: 'Which specialist assistants have I saved, and what does each handle?',
      tools: ['list_assistants'],
      facts: [assistantName, 'repair'],
    },
    {
      name: 'synced mail',
      prompt: 'Find my travel receipt in synced mail and tell me the pickup word from its message.',
      tools: ['search_mail', 'read_mail'],
      facts: [pickup],
    },
    {
      name: 'saved reminders',
      prompt: 'What reminders have I already saved? Tell me their names.',
      tools: ['list_routines'],
      facts: [reminder],
    },
  ];
  for (const scenario of scenarios) {
    const start = performance.now(),
      requestIndex = report.requests.length;
    const run = f.store.mutate((s) => {
      const thread = command(s, 'thread.create', { title: scenario.name });
      const r = command(s, 'chat.send', { threadId: thread.id, text: scenario.prompt });
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
    const requests = report.requests.slice(requestIndex);
    const calls = [...new Map(requests.flatMap((r) => r.calls).map((c) => [c.id, c])).values()];
    const results = [
      ...new Map(requests.flatMap((r) => r.results).map((r) => [r.id, r.value])).entries(),
    ];
    const check = {
      name: scenario.name,
      passed: false,
      elapsedMs: Math.round(performance.now() - start),
      status: finished.status,
      answer: answer?.text || '',
      expectedFacts: scenario.facts,
      requests: requests.length,
      calls,
      ...(scenario.dollars !== undefined ? { expectedDollars: scenario.dollars } : {}),
    };
    report.checks.push(check);
    try {
      assert.equal(finished.status, 'completed', JSON.stringify(finished));
      for (const tool of scenario.tools) {
        assert(requests[0].toolNames.includes(tool), `${tool} must be immediately available`);
        assert(
          requests.some((r) => r.toolNames.includes(tool)) &&
            results.some(
              ([id, value]) =>
                calls.some((c) => c.id === id && c.name === tool) &&
                value.result !== undefined &&
                !value.result?.error &&
                value.result?.code !== 'tool_instructions_loaded',
            ),
          `Missing execution of ${tool}`,
        );
      }
      for (const fact of scenario.facts)
        assert(check.answer.toLowerCase().includes(fact.toLowerCase()), `Missing fact: ${fact}`);
      if (scenario.dollars !== undefined) {
        // A sentence-ending period is punctuation, but another decimal digit
        // must still prevent accepting a prefix of a more precise amount.
        const amounts = [...check.answer.matchAll(/(?<![\d.])\d+(?:\.\d{1,2})?(?!\d|\.\d)/g)].map(
          (m) => Number(m[0]),
        );
        assert(
          amounts.includes(scenario.dollars),
          'Spending must be stated in dollars, not unlabelled cents',
        );
      }
      assert.deepEqual(protectedState(), before, 'A read-only question must not modify saved work');
      check.passed = true;
      console.log(`PASS ${scenario.name}: ${requests.length} model requests`);
    } catch (error) {
      check.error = error.stack;
      console.log(`FAIL ${scenario.name}: ${finished.error || error.message.slice(0, 200)}`);
      // Independent read scenarios can continue after a bad answer; stop if a
      // model actually changed the protected fixture data.
      assert.deepEqual(protectedState(), before, 'A failed lookup changed saved work');
    }
  }
  report.passed = report.checks.every((check) => check.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (f)
    report.usage = f.store.db
      .prepare(
        'SELECT purpose,status,started_at,finished_at,input_tokens,output_tokens,cached_tokens FROM model_usage ORDER BY started_at',
      )
      .all();
  await f?.close();
  await rm(directory, { recursive: true, force: true });
  report.cleanedUp = true;
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ passed: report.passed, evidence, error: report.error?.slice(0, 400) }),
  );
}
