// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { ModelProvider } from '../server/model.mjs';
import {
  computerFileDeliveryRequested,
  computerScreenContextRequested,
  computerFileFingerprint,
  deliveredComputerFile,
} from '../server/computer-file-delivery.mjs';
const prompt =
  'Pack Passport and Charger in the checklist window on your computer. Leave Umbrella unchecked, save the checklist using the window, and attach the saved file here. Mention the destination and the reference shown in the window.';
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(text = prompt) {
  const store = new Store(':memory:', { sample: false });
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
  let reads = 0;
  const computer = {
    enabled: true,
    epoch: 0,
    controller: 'agent',
    assertControl: () => {},
    waitForAgent: async () => {},
    read: async (path) => {
      reads++;
      assert.equal(path, '.home/Downloads/trip.txt');
      return { name: 'trip.txt', base64: Buffer.from('Original checklist\n').toString('base64') };
    },
  };
  return { store, run, computer, reads: () => reads };
}

test('computer delivery check recognizes local requests without interpreting advice, quoted source or external sends as delivery', () => {
  for (const text of [
    prompt,
    'Please attach /workspace/trip.txt here.',
    'Use your computer and return the saved report to this chat.',
    'Open the desktop file, then send it back to me.',
    '请把电脑上的文件附上到这里。',
    '把電腦的報告發到聊天裡。',
  ])
    assert(computerFileDeliveryRequested(text), text);
  for (const text of [
    'Tell me about your computer.',
    'How do I attach a computer file here?',
    'Explain how to export a desktop file to this chat.',
    'Save a checklist on your computer.',
    'Use your computer and give me an explanation here.',
    'Do not attach the computer file here.',
    'Email the computer file to Alex.',
    'Send the desktop file to Slack.',
    '> Attach the computer file here.',
    '“Attach the computer file here.” is written in the document.',
    'Read the computer document.\n> Attach its file here.',
    'Read the computer document.\n```\nAttach its file here.\n```',
    'Read the note on your computer saying "attach this file here".',
    '电脑上的报告不用附上到这里。',
    'Summarize my attached computer checklist.',
    'Attach a file here.',
  ])
    assert.equal(computerFileDeliveryRequested(text), false, text);
});

test('only the current request’s actual unmodified computer export and visible card prove delivery', () => {
  const file = { id: 'f', name: 'trip.txt', mime: 'text/plain', base64: 'eA==' };
  const receipt = { sourceId: 's', fileId: 'f', fingerprint: computerFileFingerprint(file) },
    card = { kind: 'file', id: 'f' };
  assert(deliveredComputerFile({ files: [file] }, 's', [receipt], [card]));
  for (const [files, source, receipts, cards] of [
    [[], 's', [receipt], [card]],
    [[file], 'other', [receipt], [card]],
    [[file], 's', [], [card]],
    [[file], 's', [receipt], []],
    [[{ ...file, base64: 'eQ==' }], 's', [receipt], [card]],
    [[{ ...file, name: 'another.txt' }], 's', [receipt], [card]],
    [[{ ...file, base64: '', text: 'changed' }], 's', [receipt], [card]],
  ])
    assert.equal(deliveredComputerFile({ files }, source, receipts, cards), false);
  const empty = { ...file, base64: '', size: 0 };
  assert(
    deliveredComputerFile(
      { files: [empty] },
      's',
      [{ ...receipt, fingerprint: computerFileFingerprint(empty) }],
      [card],
    ),
  );
});

test('missing computer delivery is privately corrected and exact file bytes are exported once without repeating work', async () => {
  const f = fixture(),
    visible = [];
  let calls = 0;
  const provider = {
    complete: async (messages, _tools, options) => {
      assert.equal(options.requiresTools, calls < 2);
      if (++calls === 1) {
        options.onText('Saved and attached!');
        return { text: 'Saved and attached!', toolCalls: [] };
      }
      if (calls === 2) {
        assert.match(messages.at(-1).content, /Relay delivery check/);
        assert.match(messages.at(-1).content, /Do not repeat completed clicks/);
        return {
          text: '',
          toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })],
        };
      }
      const exported = JSON.parse(messages.at(-1).content).result;
      assert.equal(exported.textPreview, 'Original checklist\n');
      assert.equal(exported.textTruncated, false);
      assert.match(exported.instruction, /remaining requested details/);
      options.onText('Your checklist is attached.');
      return { text: 'Your checklist is attached.', toolCalls: [] };
    },
  };
  try {
    const reply = await agentReply(
      f.store,
      provider,
      f.run,
      { computer: f.computer },
      { durable: true, onText: (text) => visible.push(text) },
    );
    assert.deepEqual(visible, ['Your checklist is attached.']);
    assert.equal(reply.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(f.reads(), 1);
    assert.equal(
      Buffer.from(f.store.read().files[0].base64, 'base64').toString(),
      'Original checklist\n',
    );
    assert.deepEqual(
      await agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      reply,
    );
    assert.equal(calls, 3);
    assert.equal(f.reads(), 1);
    assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
  } finally {
    f.store.close();
  }
});

test('repeated claims fail honestly and restart keeps the private correction budget', async () => {
  const f = fixture(),
    visible = [];
  let calls = 0;
  const provider = {
    complete: async (_m, _t, options) => {
      calls++;
      options.onText('Attached!');
      return { text: 'Attached!', toolCalls: [] };
    },
  };
  try {
    await assert.rejects(
      agentReply(
        f.store,
        provider,
        f.run,
        { computer: f.computer },
        { durable: true, onText: (text) => visible.push(text) },
      ),
      /computer file was not attached/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(visible, []);
    assert.equal(f.store.read().files.length, 0);
    assert.equal(
      new AgentCheckpoint(f.store, f.run.id).load().computerDeliveryRecoveryFor,
      f.run.messageId,
    );
    await assert.rejects(
      agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      /computer file was not attached/,
    );
    assert.equal(calls, 3);
  } finally {
    f.store.close();
  }
});

test('a required question can pause delivery and an owner correction can cancel the file request', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const question = await agentReply(
      f.store,
      {
        complete: async () => ({
          text: 'Which file?',
          toolCalls: [
            call('ask_question', {
              prompt: 'Which saved file should I use?',
              options: [{ label: 'Checklist' }, { label: 'Report' }],
            }),
          ],
        }),
      },
      f.run,
      { computer: f.computer },
    );
    assert(question.question);
    assert.equal(f.store.read().files.length, 0);
    f.store.mutate((s) => {
      s.runs[0].status = 'running';
    });
    const provider = {
      complete: async (_m, _t, options) => {
        if (++calls === 1) {
          f.store.mutate((s) =>
            command(s, 'chat.send', {
              threadId: 'main',
              delivery: 'now',
              text: 'Actually, leave it on the computer. Just tell me what a checklist is.',
            }),
          );
          options.onText('Attached!');
          return { text: 'Attached!', toolCalls: [] };
        }
        assert.equal(options.requiresTools, false);
        return { text: 'A checklist helps track what is done.', toolCalls: [] };
      },
    };
    const reply = await agentReply(f.store, provider, f.run, { computer: f.computer });
    assert.equal(reply.text, 'A checklist helps track what is done.');
    assert.equal(calls, 2);
    assert.equal(f.reads(), 0);
  } finally {
    f.store.close();
  }
});

test('a bound clarification resumes the original delivery request while a negative answer can cancel it', async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    let calls = 0;
    try {
      const proposal = {
        text: 'Which file?',
        question: {
          prompt: 'Which saved file should I use?',
          options: [{ label: 'Checklist' }, { label: 'Report' }],
        },
        cards: [],
      };
      f.store.mutate((s) =>
        appendAssistant(s, 'main', proposal, { replyTo: f.run.messageId }, f.run),
      );
      const q = f.store.read().questions[0];
      const continuation = f.store.mutate((s) =>
        command(s, 'question.answer', {
          id: q.id,
          text: cancel ? 'Do not attach the file here.' : 'Checklist',
        }),
      );
      const provider = {
        complete: async (messages, _tools, options) => {
          if (cancel) {
            assert.equal(options.requiresTools, false);
            return { text: 'I will leave it on the computer.', toolCalls: [] };
          }
          if (++calls === 1) {
            assert.equal(options.requiresTools, true);
            return { text: 'Done!', toolCalls: [] };
          }
          if (calls === 2) {
            assert.match(messages.at(-1).content, /Relay delivery check/);
            return {
              text: '',
              toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })],
            };
          }
          return { text: 'The checklist is attached.', toolCalls: [] };
        },
      };
      const reply = await agentReply(f.store, provider, continuation, { computer: f.computer });
      assert.equal(reply.cards.filter((card) => card.kind === 'file').length, cancel ? 0 : 1);
      assert.equal(f.reads(), cancel ? 0 : 1);
    } finally {
      f.store.close();
    }
  }
});

test('delivery exhaustion fails instead of completing; an explicit retry gets a bounded continuation without resetting history', async () => {
  const f = fixture();
  let calls = 0;
  f.computer.screenshot = async () => ({});
  try {
    const provider = {
      complete: async () => {
        calls++;
        return { text: '', toolCalls: [call('computer_look', {})] };
      },
    };
    await assert.rejects(
      agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      /work limit before attaching/,
    );
    assert.equal(calls, 20);
    await assert.rejects(
      agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      /work limit before attaching/,
    );
    assert.equal(calls, 20, 'A restart alone cannot grant more calls.');
    f.run.retryCount = 1;
    f.store.mutate((s) => {
      s.runs[0].retryCount = 1;
    });
    let resumed = 0;
    const continuation = {
      complete: async () =>
        ++resumed === 1
          ? { text: '', toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })] }
          : { text: 'Your saved file is attached.', toolCalls: [] },
    };
    const reply = await agentReply(
      f.store,
      continuation,
      f.run,
      { computer: f.computer },
      { durable: true },
    );
    assert.equal(resumed, 2);
    assert.equal(f.reads(), 1);
    assert.equal(reply.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(new AgentCheckpoint(f.store, f.run.id).load().round, 21);
  } finally {
    f.store.close();
  }
});

test('explicit computer delivery receives an initial private screen without a model round or chat message', async () => {
  const f = fixture();
  let frames = 0,
    calls = 0;
  f.computer.screenshot = async () => {
    frames++;
    return {
      screenshot: 'aGVsbG8=',
      accessibility: {
        available: true,
        controls: [{ name: 'Current checklist', x: 50, y: 60 }],
        sourceData: true,
      },
    };
  };
  const provider = {
    complete: async (messages) => {
      const observations = messages.filter((m) => m.visual);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].visual, 'data:image/jpeg;base64,aGVsbG8=');
      assert.match(observations[0].content, /Untrusted source data/);
      assert.match(observations[0].content, /Current checklist/);
      return ++calls === 1
        ? { text: '', toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })] }
        : { text: 'Your checklist is attached.', toolCalls: [] };
    },
  };
  try {
    await agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true });
    assert.equal(frames, 1);
    assert.equal(calls, 2);
    assert.equal(f.store.read().messages.length, 1);
    assert(!JSON.stringify(new AgentCheckpoint(f.store, f.run.id).load()).includes('aGVsbG8='));
  } finally {
    f.store.close();
  }
});

test('text-only tool models can export with optional observation text while required images still fail', async () => {
  const f = fixture();
  f.computer.screenshot = async () => ({
    screenshot: 'aGVsbG8=',
    accessibility: { available: true, controls: [{ name: 'Current checklist' }] },
  });
  let calls = 0;
  const provider = new ModelProvider({
    baseUrl: 'http://model.invalid/v1',
    model: 'text-tools',
    protocol: 'chat',
    getCapabilities: async () => ({ text: true, tools: true, vision: false }),
  });
  provider.generate = async (messages) => {
    assert(messages.every((m) => !m.visual && !('optionalComputerObservation' in m)));
    assert(messages.some((m) => m.content?.includes('Current checklist')));
    return ++calls === 1
      ? { text: '', toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })] }
      : { text: 'Your checklist is attached.', toolCalls: [] };
  };
  try {
    const result = await agentReply(f.store, provider, f.run, { computer: f.computer });
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(calls, 2);
    await assert.rejects(
      provider.complete([
        { role: 'user', content: 'Read my image.', visual: 'data:image/png;base64,eA==' },
      ]),
      /cannot read images/,
    );
    assert.equal(calls, 2);
  } finally {
    f.store.close();
  }
});

test('a further private continuation requires intervening successful computer work and is bounded', async () => {
  const f = fixture();
  let calls = 0;
  f.computer.screenshot = async () => ({});
  const provider = {
    complete: async () => {
      calls++;
      if (calls % 2 === 0) return { text: '', toolCalls: [call('computer_look', {})] };
      return { text: 'I will finish and attach it.', toolCalls: [] };
    },
  };
  try {
    await assert.rejects(
      agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      /computer file was not attached/,
    );
    assert.equal(calls, 7);
    assert.equal(new AgentCheckpoint(f.store, f.run.id).load().computerDeliveryRecoveryCount, 3);
    assert.equal(f.store.read().files.length, 0);
  } finally {
    f.store.close();
  }
});

test('a missing export offers only exact-name download locations without saving or substituting another file', async () => {
  const f = fixture();
  let listings = 0;
  f.computer.read = async () => {
    throw Error("[Errno 2] No such file or directory: 'trip.txt'");
  };
  f.computer.list = async (path) => {
    listings++;
    return {
      entries: path.endsWith('/.home/Downloads')
        ? [
            { name: 'trip.txt', kind: 'file' },
            { name: 'travel.html', kind: 'file' },
            { name: 'TRIP.txt', kind: 'file' },
          ]
        : [{ name: 'trip.txt', kind: 'directory' }],
    };
  };
  try {
    const result = await executeTool(
      f.store,
      'computer_export',
      { path: '/workspace/trip.txt' },
      { computer: f.computer },
    );
    assert.deepEqual(result.result.availablePaths, ['/workspace/.home/Downloads/trip.txt']);
    assert.equal(result.card, undefined);
    assert.equal(f.store.read().files.length, 0);
    assert.equal(listings, 2);
    f.computer.read = async () => {
      throw Error('Path leaves the workspace.');
    };
    await assert.rejects(
      executeTool(f.store, 'computer_export', { path: '/etc/private' }, { computer: f.computer }),
      /leaves the workspace/,
    );
    assert.equal(listings, 2);
    f.computer.read = async () => {
      throw Error('No such file');
    };
    f.computer.list = async () => ({ entries: [{ name: 'other.txt', kind: 'file' }] });
    await assert.rejects(
      executeTool(
        f.store,
        'computer_export',
        { path: '/workspace/trip.txt' },
        { computer: f.computer },
      ),
      /No such file/,
    );
  } finally {
    f.store.close();
  }
});

test('selected app sources still require an actual export when the owner explicitly requests computer work', async () => {
  const text =
    'Read the app notes. On your computer, create the brief, then attach that file here.';
  assert(computerFileDeliveryRequested(text, { selectedApps: true }));
  assert(
    computerFileDeliveryRequested('Use your computer and attach the app-based brief here.', {
      selectedApps: true,
    }),
  );
  assert(
    computerFileDeliveryRequested('Using your computer, create the brief and attach it here.', {
      selectedApps: true,
    }),
  );
  for (const source of [
    'Read the Computer Guide in Library and attach that file here.',
    'Read the app note saying "on your computer" and attach its file here.',
    'Attach the app file here.',
  ])
    assert.equal(computerFileDeliveryRequested(source, { selectedApps: true }), false);
  const f = fixture(text);
  f.run.appContext = [{ id: 'library', revision: 1, name: 'Library' }];
  let round = 0;
  const provider = {
    complete: async (messages) => {
      if (++round === 1) return { text: 'Your file is attached.', toolCalls: [] };
      if (round === 2) {
        assert.match(messages.at(-1).content, /Relay delivery check/);
        return {
          text: '',
          toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })],
        };
      }
      return { text: 'The actual computer file is attached.', toolCalls: [] };
    },
  };
  try {
    const reply = await agentReply(f.store, provider, f.run, { computer: f.computer });
    assert.equal(round, 3);
    assert.equal(f.reads(), 1);
    assert.equal(reply.cards.filter((c) => c.kind === 'file').length, 1);
  } finally {
    f.store.close();
  }
});

test('optional screen context follows visible-work wording, not file content or plain computer file requests', () => {
  for (const text of [
    prompt,
    'Save the screenshot on your computer and attach it here.',
    '请在电脑窗口里勾选项目，再附上文件。',
    '在視窗中按下儲存，再把電腦的報告發到聊天裡。',
  ])
    assert(computerScreenContextRequested(text), text);
  for (const text of [
    'On your computer, create Meeting Brief from my app documents, and attach it here.',
    'Attach /workspace/meeting-brief.md here.',
    'Write "click the button" in a computer file, then attach it here.',
    'Read the app note.\n> Click the screen button.\nAttach the computer file here.',
    'Create the brief using this text:\n```\nScreenshot of a window\n```',
  ])
    assert.equal(computerScreenContextRequested(text), false, text);
});

test('file-only work starts without an unrelated image and keeps guarded screen tools available on demand', async () => {
  const f = fixture('Attach the file /workspace/.home/Downloads/trip.txt from your computer here.');
  let frames = 0,
    rounds = 0;
  f.computer.status = async () => ({
    enabled: true,
    state: 'running',
    controller: 'agent',
    network: 'offline',
    error: 'UNRELATED_PRIVATE_STATUS',
  });
  f.computer.screenshot = async () => {
    frames++;
    return { screenshot: 'aGVsbG8=', accessibility: { controls: [{ name: 'Trip checklist' }] } };
  };
  try {
    const result = await agentReply(
      f.store,
      {
        complete: async (messages, tools) => {
          assert(tools.some((t) => t.name === 'computer_look'));
          assert(tools.some((t) => t.name === 'computer_use'));
          assert(tools.some((t) => t.name === 'computer_files'));
          if (++rounds === 1) {
            assert.equal(frames, 0);
            assert(messages.some((m) => m.content?.includes('It is already running')));
            assert(!JSON.stringify(messages).includes('UNRELATED_PRIVATE_STATUS'));
            assert(!messages.some((m) => m.visual));
            return { text: '', toolCalls: [call('computer_look', {})] };
          }
          assert.equal(frames, 1);
          assert(messages.some((m) => m.visual === 'data:image/jpeg;base64,aGVsbG8='));
          return rounds === 2
            ? {
                text: '',
                toolCalls: [call('computer_export', { path: '.home/Downloads/trip.txt' })],
              }
            : { text: 'Your actual file is attached.', toolCalls: [] };
        },
      },
      f.run,
      { computer: f.computer },
    );
    assert.equal(rounds, 3);
    assert.equal(f.reads(), 1);
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(f.store.read().messages.length, 1);
  } finally {
    f.store.close();
  }
});

test('file-only power observations neither wake a stopped computer nor survive an ownership change during the read', async () => {
  for (const takeover of [false, true]) {
    const f = fixture('Attach /workspace/trip.txt from your computer here.');
    let controls = 0,
      starts = 0;
    f.computer.start = async () => {
      starts++;
      throw Error('Unexpected startup');
    };
    f.computer.assertControl = () => {
      if (takeover && ++controls > 1) throw Error('The owner took control');
    };
    f.computer.status = async () => ({
      enabled: true,
      state: takeover ? 'running' : 'stopped',
      controller: 'agent',
      network: 'offline',
    });
    try {
      const result = await agentReply(
        f.store,
        {
          complete: async (messages) => {
            const observation = messages.find((m) =>
              m.content?.startsWith('Private computer state at the start'),
            );
            if (takeover) assert.equal(observation, undefined);
            else {
              assert(observation.content.includes('"state":"stopped"'));
              assert(!observation.content.includes('It is already running'));
            }
            assert(!messages.some((m) => m.visual));
            return {
              text: '',
              toolCalls: [
                call('ask_question', {
                  prompt: 'Which saved trip file should I use?',
                  options: [{ label: 'Checklist' }, { label: 'Report' }],
                }),
              ],
            };
          },
        },
        f.run,
        { computer: f.computer },
      );
      assert(result.question);
      assert.equal(starts, 0);
      assert.equal(f.reads(), 0);
    } finally {
      f.store.close();
    }
  }
});
