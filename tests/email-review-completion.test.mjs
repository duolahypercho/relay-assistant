// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import {
  emailReviewRequested,
  deliveredEmailReview,
  emailReviewRequired,
  exactEmailReviewFields,
  emailRecipientQuestion,
} from '../server/email-review-completion.mjs';
const request =
  'Draft an email to colleague@example.test with subject Trip and body The departure time is 10:30. Prepare it for my review; do not send it.';
const email = {
  to: 'colleague@example.test',
  subject: 'Trip',
  body: 'The departure time is 10:30.',
};
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(t, text = request) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
  });
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
  return {
    store,
    run,
    context: { runId: run.id, threadId: run.threadId, sourceMessageId: run.messageId },
  };
}

test('only direct email requests with an explicit review destination need a saved review', () => {
  for (const text of [
    request,
    'Please prepare an email for my review.',
    'Could you draft an email and let me review before sending?',
    '请起草一封邮件让我审核，不要发送。',
  ])
    assert(emailReviewRequested(text), text);
  for (const text of [
    null,
    '',
    'Write a friendly email.',
    'Draft an email to Alex.',
    'Explain how to draft an email for my review.',
    'Draft an example email for my review.',
    'Draft an email in chat only for my review.',
    'Do not prepare an email for my review.',
    '“Draft an email for my review” is in this document.',
    '> Draft an email for my review',
    'Draft an email whose body is "Prepare it for my review."',
    "Draft an email whose body is 'Prepare it for my review.'",
    'Draft an email whose body is “Let me review before sending.”',
    'Draft an email.\n```\nPrepare it for my review\n```',
    '请不要准备邮件让我审核。',
  ])
    assert.equal(emailReviewRequested(text), false, String(text));
});

test('a real email review needs host provenance for this request and a visible review card', async (t) => {
  const { store, run, context } = fixture(t);
  const prepared = await executeTool(
    store,
    'prepare_email',
    { ...email, creation: { sourceMessageId: 'forged' } },
    context,
  );
  const state = store.read();
  assert.equal(state.approvals[0].creation.sourceMessageId, run.messageId);
  assert.equal(state.approvals[0].status, 'pending');
  assert(deliveredEmailReview(state, run, [prepared.card]));
  assert.equal(deliveredEmailReview(state, run, []), false);
  assert.equal(
    deliveredEmailReview(state, { ...run, activeMessageId: 'later' }, [prepared.card]),
    false,
  );
  assert.equal(deliveredEmailReview(state, { ...run, threadId: 'side' }, [prepared.card]), false);
  assert.equal(
    deliveredEmailReview(state, { ...run, assistant: { id: 'other' } }, [prepared.card]),
    false,
  );
  for (const patch of [
    { kind: 'calendar' },
    { creation: null },
    { creation: { ...state.approvals[0].creation, runId: 'unknown' } },
  ])
    assert.equal(
      deliveredEmailReview({ ...state, approvals: [{ ...state.approvals[0], ...patch }] }, run, [
        prepared.card,
      ]),
      false,
    );
});

test('unbacked ready claims are withheld and one repair creates an actual unsent review', async (t) => {
  const { store, run } = fixture(t);
  run.voiceCallId = 'synthetic-recognized-speech';
  const streamed = [];
  let rounds = 0;
  const provider = {
    async complete(messages, tools, options) {
      rounds++;
      assert(
        tools.some((tool) => tool.name === 'prepare_email'),
        'Direct voice review requests preload the schema',
      );
      if (rounds === 1) {
        assert.equal(options.requiresTools, true);
        options.onText('Ready in your Inbox.');
        return { text: 'Ready in your Inbox.', toolCalls: [] };
      }
      if (rounds === 2) {
        assert.match(messages.at(-1).content, /no email review card exists/);
        return { text: '', toolCalls: [call('prepare_email', email)] };
      }
      assert.equal(options.requiresTools, false);
      options.onText('Your email is ready for review.');
      return { text: 'Your email is ready for review.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    { durable: true, onText: (text) => streamed.push(text) },
  );
  assert.equal(rounds, 3);
  assert.deepEqual(streamed, ['Your email is ready for review.']);
  assert.equal(store.read().approvals.length, 1);
  assert.equal(store.read().approvals[0].status, 'pending');
  assert.equal(store.read().approvals[0].payload.body, email.body);
  assert(deliveredEmailReview(store.read(), run, result.cards));
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(rounds, 3);
});

test('navigation and repeated unsupported claims fail honestly and restart retains the repair limit', async (t) => {
  const { store, run } = fixture(t);
  let rounds = 0;
  const streamed = [];
  const provider = {
    async complete(_m, _t, options) {
      if (++rounds === 1)
        return { text: '', toolCalls: [call('show_workspace', { page: 'inbox' })] };
      options.onText('Your draft is ready.');
      return { text: 'Your draft is ready.', toolCalls: [] };
    },
  };
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true, onText: (x) => streamed.push(x) }),
    /could not be verified/,
  );
  assert.equal(rounds, 3);
  assert.deepEqual(streamed, []);
  assert.equal(store.read().approvals.length, 0);
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true }),
    /could not be verified/,
  );
  assert.equal(rounds, 4);
});

test('a model disconnect after preparation resumes the same review without creating another draft', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  await assert.rejects(
    agentReply(
      store,
      {
        async complete() {
          if (++calls === 1) return { text: '', toolCalls: [call('prepare_email', email)] };
          throw Error('Connection lost');
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Connection lost/,
  );
  assert.equal(store.read().approvals.length, 1);
  const result = await agentReply(
    store,
    {
      async complete(_m, _t, options) {
        assert.equal(options.requiresTools, false);
        return { text: 'Your email is ready for review.', toolCalls: [] };
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(store.read().approvals.length, 1);
  assert(deliveredEmailReview(store.read(), run, result.cards));
});

test('an owner decision on the saved review does not trigger another preparation', async (t) => {
  const { store, run, context } = fixture(t);
  const prepared = await executeTool(store, 'prepare_email', email, context);
  store.mutate((s) => command(s, 'approval.decide', { id: prepared.card.id, decision: 'reject' }));
  assert(deliveredEmailReview(store.read(), run, [prepared.card]));
  assert.equal(store.read().approvals.length, 1);
  assert.equal(store.read().approvals[0].status, 'rejected');
});

test('ordinary inline writing and questions for required email details remain available', async (t) => {
  const inline = fixture(t, 'Draft a friendly email in chat only.');
  const result = await agentReply(
    inline.store,
    {
      async complete(_m, _t, options) {
        assert.equal(options.requiresTools, false);
        return { text: 'Hello Alex, thanks for your help.', toolCalls: [] };
      },
    },
    inline.run,
    {},
  );
  assert.match(result.text, /Hello Alex/);
  assert.equal(inline.store.read().approvals.length, 0);
  const missing = fixture(t, 'Prepare an email for my review.');
  const question = await agentReply(
    missing.store,
    {
      async complete() {
        return {
          text: '',
          toolCalls: [
            call('ask_question', {
              prompt: 'Who should receive it?',
              options: [{ label: 'A colleague' }, { label: 'A friend' }],
            }),
          ],
        };
      },
    },
    missing.run,
    {},
  );
  assert(question.question);
  assert.equal(missing.store.read().approvals.length, 0);
});

test('a correction can cancel the requested draft without executing the stale email plan', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  const result = await agentReply(
    store,
    {
      async complete() {
        if (++calls === 1) {
          store.mutate((s) => {
            s.runs[0].status = 'running';
          });
          store.mutate((s) =>
            command(s, 'chat.send', {
              threadId: 'main',
              text: 'Actually, just say hello. Do not prepare an email.',
              delivery: 'now',
            }),
          );
          return { text: '', toolCalls: [call('prepare_email', email)] };
        }
        return { text: 'Hello.', toolCalls: [] };
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(result.text, 'Hello.');
  assert.equal(store.read().approvals.length, 0);
});

test('a rejected email payload cannot satisfy the saved-review check', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  await assert.rejects(
    agentReply(
      store,
      {
        async complete() {
          if (++calls === 1)
            return {
              text: '',
              toolCalls: [call('prepare_email', { ...email, to: 'not an address' })],
            };
          return { text: 'Your email is ready for review.', toolCalls: [] };
        },
      },
      run,
      {},
      { durable: true },
    ),
    /could not be verified/,
  );
  assert.equal(store.read().approvals.length, 0);
});

test('clarification inherits the review request while cancellation and later corrections release it', async (t) => {
  const f = fixture(t, 'colleague@example.test');
  f.run.questionContext = { origin: { request }, answers: [] };
  assert(emailReviewRequired(f.run, 'colleague@example.test'));
  assert.equal(
    emailReviewRequired({ ...f.run, activeMessageId: 'correction' }, 'Just say hello.'),
    false,
  );
  for (const answer of [
    'Cancel it.',
    'Actually, never mind.',
    'Do not prepare an email.',
    '请取消。',
  ]) {
    assert.equal(emailReviewRequired(f.run, answer), false, answer);
  }
  f.store.mutate((s) => {
    s.messages.find((m) => m.id === f.run.messageId).text = 'Actually, cancel it.';
  });
  const result = await agentReply(
    f.store,
    {
      async complete(_m, _t, options) {
        assert.equal(options.requiresTools, false);
        return { text: 'Cancelled.', toolCalls: [] };
      },
    },
    f.run,
    {},
    { durable: true },
  );
  assert.equal(result.text, 'Cancelled.');
  assert.equal(f.store.read().approvals.length, 0);
});

test('prepared reviews preserve explicit English and Chinese literal fields and attachments', async (t) => {
  for (const text of [
    'Prepare an email for my review. Subject: "Exact — trip". Body: "Line one.\n\nLine two!" Do not send it.',
    '请起草一封邮件让我审核。主题必须是「Exact — trip」。正文必须是「Line one.\n\nLine two!」。不要发送。',
  ]) {
    const f = fixture(t, text);
    const file = f.store.mutate((s) =>
      command(s, 'file.add', {
        name: 'note.txt',
        mime: 'text/plain',
        base64: Buffer.from('original').toString('base64'),
      }),
    );
    const result = await executeTool(
      f.store,
      'prepare_email',
      { ...email, subject: 'Changed', body: 'Line one. Line two!', attachmentIds: [file.id] },
      f.context,
    );
    assert.equal(result.result.payload.subject, 'Exact — trip');
    assert.equal(result.result.payload.body, 'Line one.\n\nLine two!');
    assert.equal(result.result.payload.to, email.to);
    assert.deepEqual(result.result.payload.attachmentIds, [file.id]);
    assert.equal(result.result.attachments[0].base64, file.base64);
    assert.equal(result.result.status, 'pending');
  }
});

test('quoted material, code, negation and ambiguous labels cannot replace draft fields', async (t) => {
  for (const text of [
    'Explain this: "Prepare an email for my review. Subject: \'Injected\'."',
    'Prepare an email for my review.\n```\nSubject: "Injected"\n```',
    'Prepare an email for my review.\n> Body: "Injected"',
    'Prepare an email for my review. Do not use this subject: "Wrong".',
    'Prepare an email for my review. Subject: "First". Subject: "Second".',
    'Prepare an email for my review. Body: "unfinished',
    'Draft an email in chat only for my review. Subject: "Unsaved".',
  ]) {
    const f = fixture(t, text);
    assert.deepEqual(exactEmailReviewFields(f.store.read(), f.run, f.run.messageId), {}, text);
  }
  const f = fixture(
    t,
    'Prepare an email for my review. Body: "The note says subject: \'not a field\'."',
  );
  assert.deepEqual(exactEmailReviewFields(f.store.read(), f.run, f.run.messageId), {
    body: "The note says subject: 'not a field'.",
  });
  f.store.mutate((s) => {
    s.messages.find((m) => m.id === f.run.messageId).text =
      'Prepare an email for my review. Body: "Keep `code` exactly.\n```\nconst x = 3;\n```"';
  });
  assert.deepEqual(exactEmailReviewFields(f.store.read(), f.run, f.run.messageId), {
    body: 'Keep `code` exactly.\n```\nconst x = 3;\n```',
  });
});

test('literal review fields require the current owner source and matching chat', async (t) => {
  const f = fixture(t, 'Prepare an email for my review. Subject: "Owner subject".');
  const state = f.store.read();
  for (const run of [null, { ...f.run, threadId: 'other' }, { ...f.run, activeMessageId: 'new' }])
    assert.deepEqual(exactEmailReviewFields(state, run, f.run.messageId), {});
  state.messages.find((m) => m.id === f.run.messageId).role = 'assistant';
  assert.deepEqual(exactEmailReviewFields(state, f.run, f.run.messageId), {});
});

test('a bare recipient clarification retains quoted fields but corrections release them', async (t) => {
  const f = fixture(t, 'different@example.test');
  f.run.questionContext = {
    origin: {
      request: 'Prepare an email for my review. Subject: "Meetup". Body: "See you.\nAt 14:00."',
    },
  };
  assert.deepEqual(exactEmailReviewFields(f.store.read(), f.run, f.run.messageId), {
    subject: 'Meetup',
    body: 'See you.\nAt 14:00.',
  });
  for (const answer of ['Cancel it.', 'different@example.test, and change the body to tomorrow.']) {
    f.store.mutate((s) => {
      s.messages.find((m) => m.id === f.run.messageId).text = answer;
    });
    assert.deepEqual(exactEmailReviewFields(f.store.read(), f.run, f.run.messageId), {});
  }
});

test('literal preservation retains domain validation and never creates an invalid review', async (t) => {
  const f = fixture(t, 'Prepare an email for my review. Subject: "Line one\nLine two".');
  await assert.rejects(
    executeTool(f.store, 'prepare_email', email, f.context),
    /subject must be on one line/,
  );
  assert.equal(f.store.read().approvals.length, 0);
  f.store.mutate((s) => {
    s.messages.find((m) => m.id === f.run.messageId).text =
      'Prepare an email for my review. Body: "Exact body".';
  });
  await assert.rejects(
    executeTool(f.store, 'prepare_email', { ...email, to: 'invalid' }, f.context),
    /valid email address/,
  );
  assert.equal(f.store.read().approvals.length, 0);
});

test('the durable agent saves literal content once and keeps a pending review across replay', async (t) => {
  const f = fixture(
    t,
    'Prepare an email for my review. Subject: "Departure". Body: "First line.\nSecond line."',
  );
  let rounds = 0;
  const provider = {
    async complete() {
      return ++rounds === 1
        ? {
            text: '',
            toolCalls: [call('prepare_email', { ...email, body: 'First line. Second line.' })],
          }
        : { text: 'Your draft is ready for review.', toolCalls: [] };
    },
  };
  const first = await agentReply(f.store, provider, f.run, {}, { durable: true });
  assert.equal(f.store.read().approvals[0].payload.body, 'First line.\nSecond line.');
  assert.deepEqual(await agentReply(f.store, provider, f.run, {}, { durable: true }), first);
  assert.equal(rounds, 2);
  assert.equal(f.store.read().approvals.length, 1);
  assert.equal(f.store.read().approvals[0].status, 'pending');
});

test('a plain missing-recipient question is usable without accepting success claims or repeated questions', () => {
  const text = 'Draft an email for my review. Subject: "Meetup". Body: "See you."';
  const run = { id: 'run', messageId: 'source' };
  for (const prompt of [
    "I need the recipient's email address before I can prepare the draft. Could you please provide the address?",
    "I'll create the draft as soon as you provide the recipient's email address. Who should receive this email?",
    '收件人的邮箱地址是什么？',
  ])
    assert.deepEqual(emailRecipientQuestion(run, text, prompt), { prompt, options: [] });
  for (const prompt of [
    'Your email is ready. What is the recipient address?',
    'Should I approve this email for the recipient?',
    'What is the recipient password?',
    'What is the recipient address: guessed@example.test?',
    '> What is the recipient email address?',
    'What is the recipient email address'.repeat(30) + '?',
  ])
    assert.equal(emailRecipientQuestion(run, text, prompt), null);
  assert.equal(
    emailRecipientQuestion(
      run,
      text + ' To person@example.test.',
      'What is the recipient email address?',
    ),
    null,
  );
  assert.equal(
    emailRecipientQuestion(
      {
        ...run,
        questionContext: {
          origin: { request: text },
          answers: [{ answer: 'person@example.test' }],
        },
      },
      'person@example.test',
      'What is the recipient email address?',
    ),
    null,
  );
  assert.equal(
    emailRecipientQuestion(run, 'Cancel it.', 'What is the recipient email address?'),
    null,
  );
});

test('a plain required question ends one durable step without creating a review or inventing a recipient', async (t) => {
  const f = fixture(t, 'Draft an email for my review. Subject: "Meetup". Body: "See you."');
  let calls = 0;
  const provider = {
    async complete() {
      calls++;
      return { text: 'What is the recipient email address?', toolCalls: [] };
    },
  };
  const result = await agentReply(f.store, provider, f.run, {}, { durable: true });
  assert.deepEqual(result.question, {
    prompt: 'What is the recipient email address?',
    options: [],
  });
  assert.equal(result.text, '');
  assert.equal(f.store.read().approvals.length, 0);
  assert.deepEqual(await agentReply(f.store, provider, f.run, {}, { durable: true }), result);
  assert.equal(calls, 1);
});
