import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import {
  chatQuestionCandidates,
  chatQuestionContext,
  answerQuestionFromChat,
  requestedInputQuestion,
} from '../shared/chat-question-answers.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { agentReply } from '../server/agent.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';

const request =
  'Draft an email for my review. Subject: "Workshop". Body: "See you at 14:00.\nBring a notebook." Ask me for the recipient. Do not send.';
const recipient = 'friend@example.test';
const call = (name, p) => ({
  id: 'call-' + name,
  type: 'function',
  function: { name, arguments: JSON.stringify(p) },
});
const response = (name, p) => ({ text: '', toolCalls: [call(name, p)] });
function ask(s, extra = {}, threadId = 'main') {
  const run = command(s, 'chat.send', { threadId, text: request });
  Object.assign(run, extra);
  appendAssistant(
    s,
    threadId,
    {
      text: '',
      cards: [],
      question: { prompt: 'What is the recipient email address?', options: [] },
    },
    { replyTo: run.messageId },
    run,
  );
  run.status = 'completed';
  return s.questions.at(-1);
}
function answer(s, text = recipient, extra = {}) {
  const run = command(s, 'chat.send', { threadId: 'main', text });
  Object.assign(run, extra);
  return run;
}
function prepare() {
  return response('prepare_email', {
    to: recipient,
    subject: 'Workshop',
    body: 'See you at 14:00. Bring a notebook.',
    attachmentIds: [],
  });
}

test('group broadcasts and automatic routing cannot claim a question; a single explicit recipient can', () => {
  const s = createWorkspace({ sample: false });
  const q = ask(s),
    run = answer(s);
  const message = s.messages.find((m) => m.id === run.messageId);
  s.threads[0].participantIds = ['relay', 'other'];
  for (const recipients of [undefined, [], ['relay', 'other'], ['other']]) {
    message.recipientIds = recipients;
    message.routedTo = ['relay'];
    assert.deepEqual(chatQuestionCandidates(s, run), []);
    assert.throws(() => answerQuestionFromChat(s, run.id, q.id, message.id), /no longer pending/);
  }
  message.recipientIds = ['relay'];
  assert.equal(chatQuestionCandidates(s, run)[0].id, q.id);
});

test('explicit ask-before prose recovery excludes examples, quoted instructions, approvals and generated work', () => {
  const s = createWorkspace({ sample: false });
  const instruction =
    'Create a text file. First ask me what to name it, then wait for my answer before saving it.';
  const run = answer(s, instruction),
    source = s.messages.find((m) => m.id === run.messageId);
  const prompt = 'What would you like to name this .txt file?';
  assert.deepEqual(requestedInputQuestion(s, run, prompt), { prompt, options: [] });
  const withHint =
    'What would you like to name this file? (Please provide the filename without the .txt extension.)';
  assert.deepEqual(requestedInputQuestion(s, run, withHint), {
    prompt: 'What would you like to name this file?',
    options: [],
  });
  assert.deepEqual(
    requestedInputQuestion(
      s,
      run,
      'What would you like to name the file? Please include a `.txt` extension (e.g., `meeting-notes.txt`).',
    ),
    { prompt: 'What would you like to name the file?', options: [] },
  );
  for (const text of [
    'What would you like to name the file? (It will be saved with a `.txt` extension.)',
    'What would you like to name the file? The document would be created after you answer.',
  ])
    assert.deepEqual(requestedInputQuestion(s, run, text), {
      prompt: 'What would you like to name the file?',
      options: [],
    });
  for (const text of [
    'Ask me a trivia question.',
    'Write a question for an interview.',
    'Explain how to create a file. First ask me what to name it, then wait for my answer.',
    'Create a text file containing "First ask me what to name it, then wait for my answer".',
    "Create a text file containing 'First ask me what to name it, then wait for my answer'.",
    'Create a text file.\n> First ask me what to name it, then wait for my answer.',
    'Create a text file. `First ask me what to name it, then wait for my answer.`',
    'Create a text file. Do not ask me what to name it before saving it.',
  ]) {
    source.text = text;
    assert.equal(requestedInputQuestion(s, run, prompt), null, text);
  }
  source.text = instruction;
  for (const text of [
    'What is your password?',
    'What action do you approve?',
    'Which file was saved?',
    'What name? Or should I pick one?',
    'Your file is ready. What else?',
    'What filename? It was saved with a .txt extension.',
    'What filename? It will be saved later; a copy was already created.',
    'Which file will be saved?',
  ]) {
    assert.equal(requestedInputQuestion(s, run, text), null, text);
  }
  for (const extra of [
    { routineId: 'daily' },
    { skill: { id: 'a' } },
    { questionContext: { origin: {} } },
  ])
    assert.equal(requestedInputQuestion(s, { ...run, ...extra }, prompt), null);
});

test('an explicitly requested prose question pauses durably and a normal answer saves the original file once', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const run = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return answer(
        s,
        'Create a text file containing "Keep these exact bytes". First ask me what to name it, then wait for my answer before saving it.',
      );
    });
    let steps = 0;
    const worker = new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(messages) {
          steps++;
          if (steps === 1)
            return {
              text: 'What would you like to name the file? (It will be saved with a `.txt` extension.)',
              toolCalls: [],
            };
          if (steps === 2) return response('answer_question', { id: store.read().questions[0].id });
          if (steps === 3) {
            assert(
              messages.some((m) =>
                m.content?.includes('Original request: Create a text file containing'),
              ),
            );
            return response('write_note', {
              name: 'Blue Comet.txt',
              text: 'Keep these exact bytes',
            });
          }
          return { text: 'Here is Blue Comet.', toolCalls: [] };
        },
      },
    });
    await worker.reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'pending');
    assert.equal(store.read().files.length, 0);
    const resumed = store.mutate((s) => answer(s, 'Call it Blue Comet.'));
    await worker.reply(resumed.id, new AbortController().signal);
    const state = store.read();
    assert.equal(state.questions[0].status, 'answered');
    assert.equal(state.questions[0].answerRunId, resumed.id);
    assert.equal(state.runs.length, 2);
    assert.equal(state.files.length, 1);
    assert.equal(Buffer.from(state.files[0].base64, 'base64').toString(), 'Keep these exact bytes');
    assert.equal(state.files[0].name, 'Blue Comet.txt');
  } finally {
    store.close();
  }
});

test('prose recovery cannot conceal work already done before the requested pause', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const run = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return answer(
        s,
        'Create a text file. First ask me what to name it, then wait for my answer.',
      );
    });
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete() {
          return ++steps === 1
            ? response('write_note', { name: 'Already saved.txt', text: 'Keep the actual receipt' })
            : { text: 'What would you like to name the file?', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions.length, 0);
    assert.equal(store.read().files.length, 1);
    assert(
      store
        .read()
        .messages.at(-1)
        .cards.some((c) => c.kind === 'file' && c.id === store.read().files[0].id),
    );
  } finally {
    store.close();
  }
});

test('a chat answer consumes the actual owner text and reuses its message/run with complete original context', () => {
  const s = createWorkspace({ sample: false });
  const q = ask(s, {
    skill: { id: 'method', title: 'Original method' },
    skillInput: 'Original input',
    appContext: [{ id: 'chosen-app' }],
  });
  q.origin.fileIds = ['original-file'];
  q.origin.steering = [{ text: 'Preserve my correction' }];
  const run = answer(s),
    count = { messages: s.messages.length, runs: s.runs.length };
  s.threads[0].draft = 'Keep my unrelated typed thought';
  assert.deepEqual(
    chatQuestionCandidates(s, run).map((q) => q.id),
    [q.id],
  );
  assert.match(chatQuestionContext(s, run), /answer_question FIRST/);
  const resolved = answerQuestionFromChat(s, run.id, q.id, run.messageId);
  assert.equal(resolved.alreadyAnswered, false);
  assert.equal(q.answer, recipient);
  assert.equal(q.answerRunId, run.id);
  assert.equal(q.answerMessageId, run.messageId);
  assert.equal(q.answeredInChat, true);
  assert.deepEqual(run.questionContext.origin, q.origin);
  assert.equal(run.questionContext.answers.at(-1).answer, recipient);
  assert.equal(s.messages.length, count.messages);
  assert.equal(s.runs.length, count.runs);
  assert.equal(s.threads[0].draft, 'Keep my unrelated typed thought');
  assert.equal(answerQuestionFromChat(s, run.id, q.id, run.messageId).alreadyAnswered, true);
  assert.deepEqual(chatQuestionCandidates(s, run), []);
  assert.equal(s.approvals.length, 0);
});

test('questions are scoped to the current assistant, chat, owner turn cutoff and quoted target', () => {
  const s = createWorkspace();
  const q = ask(s),
    run = answer(s);
  const future = ask(s);
  const foreign = structuredClone(q);
  foreign.id = 'foreign';
  foreign.origin.assistant.id = 'other';
  s.questions.push(foreign);
  const otherChat = structuredClone(q);
  otherChat.id = 'other-chat';
  otherChat.threadId = 'elsewhere';
  s.questions.push(otherChat);
  assert.deepEqual(
    chatQuestionCandidates(s, run).map((q) => q.id),
    [q.id],
  );
  for (const id of [future.id, foreign.id, otherChat.id])
    assert.throws(() => answerQuestionFromChat(s, run.id, id, run.messageId), /no longer pending/);
  assert.throws(() => answerQuestionFromChat(s, run.id, q.id, q.messageId), /owner message/);
  const message = s.messages.find((m) => m.id === run.messageId);
  message.quoted = { id: 'some-other-message' };
  assert.deepEqual(chatQuestionCandidates(s, run), []);
  message.quoted.id = q.messageId;
  assert.equal(chatQuestionCandidates(s, run)[0].id, q.id);
});

test('dismissed, archived, changed-account and already answered questions cannot be consumed by a later message', () => {
  for (const invalid of ['dismissed', 'archived', 'account', 'answered']) {
    const s = createWorkspace();
    const q = ask(s, invalid === 'account' ? { connectionGeneration: 1 } : {});
    const run = answer(s);
    if (invalid === 'dismissed') command(s, 'question.dismiss', { id: q.id });
    if (invalid === 'archived') s.threads[0].archived = true;
    if (invalid === 'account') s.connections.google = { connected: true, generation: 2 };
    if (invalid === 'answered')
      command(s, 'question.answer', { id: q.id, text: 'someone-else@example.test' });
    assert.deepEqual(chatQuestionCandidates(s, run), []);
    assert.throws(
      () => answerQuestionFromChat(s, run.id, q.id, run.messageId),
      /no longer pending/,
    );
    assert.equal(s.messages.find((m) => m.id === run.messageId).questionId, undefined);
  }
});

test('generated work, active steering, selected skills, stop controls and oversized messages are not question answers', () => {
  for (const extra of [
    { routineId: 'routine' },
    { handoffId: 'handoff' },
    { templateContext: {} },
    { jobContext: {} },
    { skill: {} },
    { activeMessageId: 'other' },
    { steeringMessageIds: ['other'] },
    { status: 'completed' },
  ]) {
    const s = createWorkspace();
    const q = ask(s),
      run = answer(s, recipient, extra);
    assert.deepEqual(chatQuestionCandidates(s, run), []);
    assert.throws(() => answerQuestionFromChat(s, run.id, q.id, run.messageId));
  }
  for (const text of ['stop', '停止', 'a'.repeat(4001)]) {
    const s = createWorkspace();
    ask(s);
    assert.deepEqual(chatQuestionCandidates(s, answer(s, text)), []);
  }
});

test('typed and voice answers resume once, preserve exact fields and do not approve or send mail', async () => {
  for (const voice of [false, true]) {
    const store = new Store(':memory:', { sample: false });
    try {
      const q = store.mutate((s) => {
        s.profile.memoryLearning = false;
        return ask(s);
      });
      const run = store.mutate((s) =>
        answer(s, recipient, voice ? { voiceCallId: 'voice-fixture' } : {}),
      );
      let steps = 0;
      await new BackgroundWorker(store, {
        provider: {
          configured: true,
          async complete(messages, tools) {
            steps++;
            if (steps === 1) {
              assert(tools.some((t) => t.name === 'answer_question'));
              assert.match(messages[0].content, new RegExp(q.id));
              return response('answer_question', { id: q.id });
            }
            assert(!tools.some((t) => t.name === 'answer_question'));
            assert(messages.some((m) => m.content?.includes('Original request: ' + request)));
            if (steps === 2) {
              assert(tools.some((t) => t.name === 'prepare_email'));
              return prepare();
            }
            return { text: 'Your email is ready for review.', toolCalls: [] };
          },
        },
      }).reply(run.id, new AbortController().signal);
      const s = store.read();
      assert.equal(s.runs.length, 2);
      assert.equal(s.messages.filter((m) => m.role === 'user').length, 2);
      assert.equal(s.runs.at(-1).status, 'completed');
      assert.equal(s.questions[0].answerRunId, run.id);
      assert.equal(steps, 3);
      assert.equal(s.approvals.length, 1);
      assert.equal(s.approvals[0].status, 'pending');
      assert.equal(s.approvals[0].payload.body, 'See you at 14:00.\nBring a notebook.');
      assert.equal(s.connections.google.connected, false);
      assert.equal(s.messages.at(-1).cards[0].kind, 'review');
    } finally {
      store.close();
    }
  }
});

test('a new topic leaves the question pending and does not recreate its requested output', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      s.profile.memoryLearning = false;
      ask(s);
    });
    const run = store.mutate((s) => answer(s, 'What is 2 plus 2?'));
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(messages) {
          assert.match(messages[0].content, /new topic/);
          return response('start_new_request', { reply: '4.' });
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'pending');
    assert.equal(store.read().approvals.length, 0);
    assert.equal(store.read().messages.at(-1).text, '4.');
  } finally {
    store.close();
  }
});

test('a combined question/work batch performs nothing until the model resolves the question alone', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const q = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return ask(s);
    });
    const run = store.mutate((s) => answer(s));
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete() {
          steps++;
          if (steps === 1)
            return {
              text: '',
              toolCalls: [call('answer_question', { id: q.id }), ...prepare().toolCalls],
            };
          if (steps === 2) {
            assert.equal(store.read().approvals.length, 0);
            assert.equal(store.read().questions[0].status, 'pending');
            return response('answer_question', { id: q.id });
          }
          if (steps === 3) return prepare();
          return { text: 'Ready for review.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'answered');
    assert.equal(store.read().questions[0].answerRunId, run.id);
    assert.equal(store.read().approvals.length, 1);
    assert.equal(store.read().runs.at(-1).status, 'completed');
    assert.equal(steps, 4);
  } finally {
    store.close();
  }
});

test('model-supplied answer text and resolution after ordinary work cannot replace the owner turn', async () => {
  for (const priorWork of [false, true]) {
    const store = new Store(':memory:', { sample: false });
    try {
      const q = store.mutate((s) => {
        s.profile.memoryLearning = false;
        return ask(s);
      });
      const run = store.mutate((s) => answer(s));
      let steps = 0;
      await new BackgroundWorker(store, {
        provider: {
          configured: true,
          async complete(_messages, tools) {
            steps++;
            if (priorWork && steps === 1) return response('start_new_request', {});
            if (priorWork && steps === 2)
              return response('write_note', { name: 'Existing work.txt', text: 'Preserve this' });
            if (steps === (priorWork ? 3 : 1)) {
              if (priorWork) assert(!tools.some((t) => t.name === 'answer_question'));
              return response('answer_question', {
                id: q.id,
                ...(priorWork ? {} : { text: 'invented@example.test' }),
              });
            }
            return { text: 'Please use the pending question to continue.', toolCalls: [] };
          },
        },
      }).reply(run.id, new AbortController().signal);
      assert.equal(store.read().questions[0].status, 'pending');
      assert.equal(store.read().approvals.length, 0);
      if (priorWork) {
        const file = store.read().files.find((f) => f.name === 'Existing work.txt');
        assert(file);
        assert.equal(Buffer.from(file.base64, 'base64').toString(), 'Preserve this');
      }
    } finally {
      store.close();
    }
  }
});

test('a crash after answer binding resumes the same run with context and no repeated question decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-chat-answer-')),
    path = join(dir, 'state.sqlite');
  let store = new Store(path, { sample: false });
  try {
    const q = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return ask(s);
    });
    const run = store.mutate((s) => answer(s));
    const crash = (s) => {
      if (s.questions[0].status === 'answered')
        throw new DOMException('Simulated process loss after commit', 'AbortError');
    };
    store.on('change', crash);
    await assert.rejects(
      agentReply(
        store,
        { configured: true, complete: async () => response('answer_question', { id: q.id }) },
        run,
        {},
        { durable: true },
      ),
      /Simulated process loss/,
    );
    store.off('change', crash);
    assert.equal(new AgentCheckpoint(store, run.id).load(), null);
    store.close();
    store = new Store(path);
    recoverWork(store);
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(messages, tools) {
          steps++;
          assert(!tools.some((t) => t.name === 'answer_question'));
          assert(messages.some((m) => m.content?.includes('Original request: ' + request)));
          return steps === 1 ? prepare() : { text: 'Ready for review.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().runs.at(-1).status, 'completed');
    assert.equal(store.read().approvals.length, 1);
    assert.equal(store.read().runs.length, 2);
    assert.equal(steps, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted answer decision replays safely before binding and preserves routine restrictions', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const q = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return ask(s, {
        routineId: 'original-routine',
        instructions: 'Read the morning report',
        routineTitle: 'Morning',
      });
    });
    const run = store.mutate((s) => answer(s));
    const planned = response('answer_question', { id: q.id });
    new AgentCheckpoint(store, run.id).save('acting', {
      messages: [
        { role: 'system', content: 'Test' },
        { role: 'assistant', content: null, tool_calls: planned.toolCalls },
      ],
      cards: [],
      prefix: '',
      round: 0,
      response: planned,
      nextTool: 0,
      timestampedHistory: true,
    });
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(_messages, tools) {
          steps++;
          assert(
            !tools.some((t) =>
              [
                'answer_question',
                'create_routine',
                'create_reminder',
                'change_reminder',
                'save_skill',
                'learn_memory',
              ].includes(t.name),
            ),
          );
          return { text: 'The original restrictions are retained.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'answered');
    assert.equal(store.read().runs.at(-1).status, 'completed');
    assert.equal(store.read().runs.at(-1).questionContext.origin.restrictedRoutine, true);
    assert.equal(steps, 1);
  } finally {
    store.close();
  }
});

test('ordinary actions cannot bypass a pending answer decision; the next model step has only routing choices', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const q = store.mutate((s) => {
      s.profile.memoryLearning = false;
      return ask(s);
    });
    const run = store.mutate((s) => answer(s));
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(messages, tools) {
          steps++;
          if (steps === 1) return prepare();
          if (steps === 2) {
            assert.equal(store.read().approvals.length, 0);
            assert.equal(store.read().questions[0].status, 'pending');
            assert.deepEqual(tools.map((t) => t.name).sort(), [
              'answer_question',
              'start_new_request',
            ]);
            assert(
              messages.some(
                (m) =>
                  m.role === 'tool' && m.content.includes('No tools in this batch were executed'),
              ),
            );
            return response('answer_question', { id: q.id });
          }
          if (steps === 3) return prepare();
          return { text: 'Your review is ready.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'answered');
    assert.equal(store.read().approvals.length, 1);
    assert.equal(store.read().runs.at(-1).status, 'completed');
    assert.equal(steps, 4);
  } finally {
    store.close();
  }
});

test('a separate-task decision preserves the old question and cannot be combined with actions', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      s.profile.memoryLearning = false;
      ask(s);
    });
    const run = store.mutate((s) =>
      answer(s, 'Separately, save a text file named New task.txt containing Separate work.'),
    );
    let steps = 0;
    const write = () => response('write_note', { name: 'New task.txt', text: 'Separate work' });
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete() {
          steps++;
          if (steps === 1)
            return { text: '', toolCalls: [call('start_new_request', {}), ...write().toolCalls] };
          if (steps === 2) {
            assert.equal(store.read().files.length, 0);
            return response('start_new_request', {});
          }
          if (steps === 3) return write();
          return { text: 'Here is the separate file.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'pending');
    assert.equal(store.read().files.length, 1);
    assert.equal(store.read().approvals.length, 0);
    assert.equal(store.read().runs.at(-1).questionContext, undefined);
    assert.equal(steps, 4);
  } finally {
    store.close();
  }
});

test('a completion claim after bypassing the required answer decision fails without performing work', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      s.profile.memoryLearning = false;
      ask(s);
    });
    const run = store.mutate((s) => answer(s));
    let steps = 0;
    await new BackgroundWorker(store, {
      provider: {
        configured: true,
        async complete(_messages, _tools, options) {
          options.onText?.('Your draft is ready.');
          return ++steps === 1 ? prepare() : { text: 'Your draft is ready.', toolCalls: [] };
        },
      },
    }).reply(run.id, new AbortController().signal);
    assert.equal(store.read().questions[0].status, 'pending');
    assert.equal(store.read().approvals.length, 0);
    assert.equal(store.read().runs.at(-1).status, 'failed');
    assert.equal(store.read().runs.at(-1).partial, '');
    assert.match(store.read().runs.at(-1).error, /could not connect your reply/);
  } finally {
    store.close();
  }
});

test('a plain completion claim cannot bypass a pending clarification without any tool call', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    ask(s);
  });
  const run = store.mutate((s) => answer(s));
  await new BackgroundWorker(store, {
    provider: {
      configured: true,
      async complete(_messages, _tools, options) {
        options.onText?.('I created your email draft.');
        return { text: 'I created your email draft.', toolCalls: [] };
      },
    },
  }).reply(run.id, new AbortController().signal);
  const state = store.read();
  assert.equal(state.runs.at(-1).status, 'failed');
  assert.equal(state.runs.at(-1).partial, '');
  assert.match(state.runs.at(-1).error, /could not connect your reply/);
  assert.equal(state.questions[0].status, 'pending');
  assert.equal(state.approvals.length, 0);
  assert.equal(state.files.length, 0);
  assert(
    !state.messages.some(
      (m) => m.role === 'assistant' && m.text.includes('I created your email draft.'),
    ),
  );
});

test('a separate conversational answer is bounded, standalone and uses the same turn', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    ask(s);
  });
  const run = store.mutate((s) => answer(s, 'What is 2 plus 2?'));
  let steps = 0;
  await new BackgroundWorker(store, {
    provider: {
      configured: true,
      async complete(_messages, tools) {
        assert.deepEqual(
          tools.map((t) => t.name),
          ['answer_question', 'start_new_request'],
        );
        steps++;
        if (steps === 1) return response('start_new_request', { reply: 4 });
        if (steps === 2) return response('start_new_request', { reply: 'x'.repeat(12001) });
        if (steps === 3)
          return {
            text: '',
            toolCalls: [
              call('start_new_request', { reply: '4.' }),
              call('write_note', { name: 'Unrequested', text: '4' }),
            ],
          };
        return response('start_new_request', { reply: '4.' });
      },
    },
  }).reply(run.id, new AbortController().signal);
  const state = store.read();
  assert.equal(steps, 4);
  assert.equal(state.runs.at(-1).status, 'completed');
  assert.equal(state.messages.at(-1).text, '4.');
  assert.equal(state.messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(state.questions[0].status, 'pending');
  assert.equal(state.files.length, 0);
  assert.equal(state.approvals.length, 0);
});

test('a new-request conversational reply cannot replace a required saved result', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    ask(s);
  });
  const run = store.mutate((s) =>
    answer(s, 'Create a Word document named Separate with the text Other.'),
  );
  let steps = 0;
  await new BackgroundWorker(store, {
    provider: {
      configured: true,
      async complete(messages) {
        steps++;
        if (steps === 1)
          return response('start_new_request', { reply: 'Created your Word document.' });
        if (steps === 2) {
          assert.equal(store.read().files.length, 0);
          assert(
            messages.some(
              (m) => m.role === 'tool' && String(m.content).includes('requires saved work'),
            ),
          );
          return response('start_new_request', {});
        }
        if (steps === 3)
          return response('save_artifact', {
            kind: 'document',
            title: 'Separate',
            source: 'Other',
          });
        return { text: 'Here is your document.', toolCalls: [] };
      },
    },
  }).reply(run.id, new AbortController().signal);
  const state = store.read();
  assert.equal(steps, 4);
  assert.equal(state.runs.at(-1).status, 'completed');
  assert.equal(state.questions[0].status, 'pending');
  assert.equal(state.files.length, 1);
  assert.equal(state.artifacts[0].versions[0].source, 'Other');
});

test('one internal retry recovers a prose topic answer without repeating the owner message', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    ask(s);
  });
  const run = store.mutate((s) => answer(s, 'What is 2 plus 2?'));
  let steps = 0;
  const streamed = [];
  const result = await agentReply(
    store,
    {
      async complete(messages, tools, options) {
        assert.equal(options.requiresTools, true);
        assert.deepEqual(
          tools.map((t) => t.name),
          ['answer_question', 'start_new_request'],
        );
        if (++steps === 1) {
          options.onText('4.');
          return { text: '4.', toolCalls: [] };
        }
        assert.match(messages.at(-1).content, /continuation check/);
        assert.match(messages[0].content, /Actual owner message to handle/);
        assert(
          messages[0].content.includes(
            JSON.stringify({ id: run.messageId, text: 'What is 2 plus 2?' }),
          ),
        );
        assert.doesNotMatch(messages[0].content, /Answer ordinary questions.*directly in chat/);
        return response('start_new_request', { reply: '4.' });
      },
    },
    run,
    {},
    { durable: true, onText: (x) => streamed.push(x) },
  );
  assert.equal(steps, 2);
  assert.equal(result.text, '4.');
  assert.deepEqual(streamed, []);
  assert.equal(store.read().questions[0].status, 'pending');
  assert.equal(store.read().messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(store.read().files.length, 0);
});
