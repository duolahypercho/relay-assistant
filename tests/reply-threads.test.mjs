import { isMemoryReview, emptyMemoryReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { assistantSnapshot } from '../shared/assistant-scope.mjs';
import { replyContext } from '../shared/reply-threads.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { routeGroup, assertGroupComputerIdle } from '../server/groups.mjs';
import { recoverWork } from '../server/worker.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerNetwork } from '../server/computer-network.mjs';
import { assistantsFixture } from '../scripts/assistants-fixture.mjs';
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const waitFor = async (fn) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Reply-thread acceptance timed out');
};
function fixture(store = new Store(':memory:', { sample: false })) {
  const act = (a, p) => store.mutate((s) => command(s, a, p));
  const root = (threadId = 'main', text = 'A small plan.', assistantId = 'relay', cards = []) =>
    store.mutate((s) =>
      appendAssistant(
        s,
        threadId,
        { text, cards },
        {},
        {
          assistant: assistantSnapshot(
            s,
            assistantId === 'relay'
              ? 'main'
              : s.assistants.find((a) => a.id === assistantId).threadId,
          ),
        },
      ),
    );
  const finish = (run, response = { text: 'Done.', cards: [] }) =>
    store.mutate((s) => {
      const r = s.runs.find((x) => x.id === run.id);
      r.status = 'completed';
      return appendAssistant(s, r.threadId, response, { replyTo: r.messageId }, r);
    });
  const group = () => {
    const a = act('assistant.create', {
      name: 'Mochi',
      description: 'Review ideas.',
      tone: 'Gentle',
      avatarColor: '#a0c5ac',
    });
    const b = act('assistant.create', {
      name: 'Pip',
      description: 'Write clearly.',
      tone: 'Warm',
      avatarColor: '#c7a5d6',
    });
    const thread = act('group.create', { title: 'Little team', participantIds: [a.id, b.id] });
    return { a, b, thread };
  };
  return { store, act, root, finish, group };
}

test('opening a reply thread is atomic and idempotent, snapshots one message, and adds no messages or work', () => {
  const f = fixture();
  try {
    const root = f.root('main', 'Original result');
    const before = f.store.read();
    const child = f.act('reply.open', { messageId: root.id });
    assert.equal(f.act('reply.open', { messageId: root.id }).id, child.id);
    assert.deepEqual(f.store.read().messages, before.messages);
    assert.deepEqual(f.store.read().runs, before.runs);
    assert.equal(child.replyTo.threadId, 'main');
    assert.equal(child.replyTo.message.text, 'Original result');
    f.store.mutate((s) => {
      s.messages.find((m) => m.id === root.id).text = 'Changed later';
    });
    assert.equal(
      f.store.read().threads.find((t) => t.id === child.id).replyTo.message.text,
      'Original result',
    );
    const run = f.act('chat.send', { threadId: child.id, text: 'A follow-up' });
    const nested = f.finish(run);
    assert.equal(f.act('reply.open', { messageId: nested.id }).id, child.id);
    assert.equal(f.store.read().threads.filter((t) => t.replyTo).length, 1);
    const snapshot = f.store.read();
    assert.throws(() => f.act('reply.open', { messageId: 'missing' }), /not found/);
    assert.deepEqual(f.store.read(), snapshot);
  } finally {
    f.store.close();
  }
});
test('reply text, attachment drafts and queue state are independent from the parent and other threads', () => {
  const f = fixture();
  try {
    const root = f.root(),
      otherRoot = f.root('main', 'Other result'),
      child = f.act('reply.open', { messageId: root.id }),
      other = f.act('reply.open', { messageId: otherRoot.id });
    const file = f.act('file.add', {
      name: 'draft.txt',
      mime: 'text/plain',
      text: 'Original attachment',
    });
    for (const id of ['main', child.id, other.id])
      f.act('thread.update', { id, draft: `Draft ${id}`, draftFileIds: [file.id] });
    const before = f.store.read();
    assert.throws(() => f.act('thread.update', { id: child.id, draftFileIds: ['missing'] }));
    assert.deepEqual(f.store.read(), before);
    const run = f.act('chat.send', { threadId: child.id, text: 'Review this', fileIds: [file.id] });
    const state = f.store.read();
    assert.equal(state.threads.find((t) => t.id === 'main').draft, 'Draft main');
    assert.deepEqual(state.threads.find((t) => t.id === 'main').draftFileIds, [file.id]);
    assert.equal(state.threads.find((t) => t.id === other.id).draft, `Draft ${other.id}`);
    assert.deepEqual(state.threads.find((t) => t.id === child.id).draftFileIds, []);
    assert.throws(
      () =>
        f.act('chat.send', { threadId: child.id, text: 'Wrong quote', replyToMessageId: root.id }),
      /this conversation/,
    );
    assert.equal(state.messages.find((m) => m.id === run.messageId).threadId, child.id);
  } finally {
    f.store.close();
  }
});
test('archive and restore follow the parent; reply threads cannot be independently renamed or nested', () => {
  const f = fixture();
  try {
    const parent = f.act('thread.create', { title: 'Project' }),
      root = f.root(parent.id, 'New conversation'),
      child = f.act('reply.open', { messageId: root.id });
    f.act('chat.send', { threadId: child.id, text: 'A different title' });
    assert.equal(f.store.read().threads.find((t) => t.id === child.id).title, 'New conversation');
    for (const p of [{ title: 'Changed' }, { archived: true }])
      assert.throws(() => f.act('thread.update', { id: child.id, ...p }), /original conversation/);
    f.act('thread.update', { id: parent.id, archived: true });
    assert.equal(f.store.read().threads.find((t) => t.id === child.id).archived, true);
    assert.throws(() => f.act('reply.open', { messageId: root.id }), /Restore/);
    assert.throws(() => f.act('chat.send', { threadId: child.id, text: 'No' }), /Restore/);
    f.act('thread.update', { id: parent.id, archived: false });
    assert.equal(f.store.read().threads.find((t) => t.id === child.id).archived, false);
    assert.equal(f.act('reply.open', { messageId: root.id }).id, child.id);
  } finally {
    f.store.close();
  }
});
test('a group thread targets the original author by default and permits explicit participants', async () => {
  const f = fixture();
  try {
    const { a, b, thread } = f.group(),
      root = f.root(thread.id, 'Pip’s plan', b.id),
      child = f.act('reply.open', { messageId: root.id });
    const auto = f.act('chat.send', { threadId: child.id, text: 'Make it shorter.' });
    assert.equal(auto.assistant.id, b.id);
    const explicit = f.act('chat.send', {
      threadId: child.id,
      text: 'Check it.',
      recipientIds: [a.id],
    });
    assert.equal(explicit.assistant.id, a.id);
    const groups = await executeTool(
      f.store,
      'list_groups',
      {},
      { threadId: child.id, runId: auto.id },
    );
    assert.equal(groups.result.length, 1);
    assert.equal(groups.result[0].id, thread.id);
    assert.throws(
      () => f.act('group.update', { id: child.id, participantIds: [a.id, 'relay'] }),
      /original group/,
    );
    assert.throws(
      () => f.act('group.update', { id: thread.id, participantIds: [a.id, 'relay'] }),
      /current work/,
    );
    f.finish(auto);
    f.finish(explicit);
    f.act('group.update', { id: thread.id, participantIds: [a.id, 'relay'] });
    const state = f.store.read();
    assert.deepEqual(state.threads.find((t) => t.id === child.id).participantIds, [a.id, 'relay']);
    assert.equal(
      f.act('chat.send', { threadId: child.id, text: 'Who can help now?' }).groupRouting,
      true,
    );
  } finally {
    f.store.close();
  }
});
test('thread model history receives only its frozen original and its own discussion, with live review status as context', async () => {
  const f = fixture();
  try {
    const approval = f.act('terminal.prepare', { command: 'pwd' });
    const root = f.root('main', 'Review this proposed command.', 'relay', [
      { kind: 'review', id: approval.id },
    ]);
    f.root('main', 'Unrelated parent secret');
    const child = f.act('reply.open', { messageId: root.id }),
      otherRoot = f.root('main', 'Another result'),
      other = f.act('reply.open', { messageId: otherRoot.id });
    f.act('chat.send', { threadId: other.id, text: 'Unrelated branch secret' });
    const run = f.act('chat.send', { threadId: child.id, text: 'Explain its scope.' });
    let sent;
    const result = await agentReply(
      f.store,
      {
        complete: async (messages) => {
          if (isMemoryReview(messages)) return emptyMemoryReply();
          sent = structuredClone(messages);
          return { text: 'This only reads the working directory.', toolCalls: [] };
        },
      },
      run,
      {},
    );
    const text = JSON.stringify(sent);
    assert(text.includes('Review this proposed command.'));
    assert(text.includes('pwd'));
    assert(text.includes('untrusted context'));
    assert(!text.includes('Unrelated parent secret'));
    assert(!text.includes('Unrelated branch secret'));
    assert.equal(result.text, 'This only reads the working directory.');
    assert.equal(f.store.read().approvals[0].status, 'pending');
    f.store.mutate((s) => {
      s.approvals[0].status = 'rejected';
    });
    assert.equal(replyContext(f.store.read(), child.id).results[0].status, 'rejected');
  } finally {
    f.store.close();
  }
});
test('group routing sees the original message without treating a reply thread as a discoverable group', async () => {
  const f = fixture();
  try {
    const { a, thread } = f.group();
    const root = f.act('chat.send', { threadId: thread.id, text: 'Owner source for routing.' });
    const child = f.act('reply.open', { messageId: root.messageId });
    const run = f.act('chat.send', { threadId: child.id, text: 'Which role can refine it?' });
    assert(run.groupRouting);
    let request;
    const ids = await routeGroup(
      f.store,
      {
        configured: true,
        complete: async (messages) => {
          if (isMemoryReview(messages)) return emptyMemoryReply();
          request = JSON.parse(messages[1].content);
          return {
            toolCalls: [
              {
                function: {
                  name: 'select_participants',
                  arguments: JSON.stringify({ participantIds: [a.id] }),
                },
              },
            ],
          };
        },
      },
      run,
    );
    assert.deepEqual(ids, [a.id]);
    assert.equal(request.originalMessage.text, 'Owner source for routing.');
    assert.equal(request.conversation.length, 0);
  } finally {
    f.store.close();
  }
});
test('inline answers retain thread, assistant and model and never clear either composer draft', async () => {
  const f = fixture();
  try {
    const { b, thread } = f.group(),
      root = f.root(thread.id, 'Choose a style.', b.id),
      child = f.act('reply.open', { messageId: root.id });
    f.act('thread.update', { id: thread.id, draft: 'Parent draft' });
    f.act('thread.update', { id: child.id, draft: 'Thread draft' });
    const run = f.act('chat.send', { threadId: child.id, text: 'Help me refine it.' });
    f.store.mutate((s) => {
      s.runs.find((r) => r.id === run.id).modelConnection = { id: 'pinned', revision: 3 };
    });
    f.finish(run, {
      text: 'One detail.',
      cards: [],
      question: { prompt: 'Which tone?', options: [{ label: 'Warm' }, { label: 'Formal' }] },
    });
    f.act('thread.update', { id: child.id, draft: 'Keep this thought' });
    const q = f.store.read().questions[0];
    const answer = f.act('question.answer', { id: q.id, optionId: '1' });
    assert.equal(answer.threadId, child.id);
    assert.equal(answer.assistant.id, b.id);
    assert.deepEqual(answer.modelConnection, { id: 'pinned', revision: 3 });
    assert.equal(f.act('question.answer', { id: q.id, optionId: '1' }).id, answer.id);
    const s = f.store.read();
    assert.equal(s.threads.find((t) => t.id === thread.id).draft, 'Parent draft');
    assert.equal(s.threads.find((t) => t.id === child.id).draft, 'Keep this thought');
  } finally {
    f.store.close();
  }
});
test('quoted original text cannot become a learned owner preference', async () => {
  const f = fixture();
  try {
    const root = f.root('main', 'I prefer quiet hotels.'),
      child = f.act('reply.open', { messageId: root.id }),
      run = f.act('chat.send', { threadId: child.id, text: 'Make this result shorter.' });
    await assert.rejects(
      () =>
        executeTool(
          f.store,
          'learn_memory',
          {
            key: 'preference.hotels',
            text: 'Prefers quiet hotels.',
            evidence: 'I prefer quiet hotels.',
          },
          { threadId: child.id, runId: run.id, sourceMessageId: run.messageId },
        ),
      /evidence|current|message/i,
    );
    assert.equal(f.store.read().memories.length, 0);
  } finally {
    f.store.close();
  }
});
test('computer jobs and website continuations remain in the reply thread; group membership checks include them', async () => {
  const f = fixture();
  const computer = new PrivateComputer(f.store, { enabled: true });
  computer.network = new ComputerNetwork(computer);
  computer.network.resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  try {
    const { b, thread } = f.group(),
      root = f.root(thread.id, 'Pip’s result', b.id),
      child = f.act('reply.open', { messageId: root.id });
    const run = f.act('chat.send', { threadId: child.id, text: 'Check this on your computer.' });
    assert.equal(computer.jobs.origin(run.id).threadId, child.id);
    await computer.network.request('https://example.com', 'Check the original result.');
    computer.network.waitForOwner(run.id, 'example.com', 'https://example.com');
    f.finish(run);
    assert.throws(() => assertGroupComputerIdle(f.store, computer, thread.id), /computer work/);
    const continuation = computer.network.continuation(run.id, 'example.com');
    assert.equal(continuation.context.threadId, child.id);
    assert.equal(continuation.context.assistant.id, b.id);
  } finally {
    f.store.close();
  }
});
test('reply relationship, drafts and an unanswered question survive SQLite reopen without duplicate work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-reply-restart-'));
  let f = fixture(new Store(join(dir, 'state.sqlite'), { sample: false }));
  try {
    const root = f.root(),
      child = f.act('reply.open', { messageId: root.id });
    const run = f.act('chat.send', { threadId: child.id, text: 'Refine this.' });
    f.finish(run, {
      text: 'Which?',
      cards: [],
      question: { prompt: 'Choose a tone', options: [{ label: 'Warm' }, { label: 'Formal' }] },
    });
    f.act('thread.update', { id: child.id, draft: 'Keep draft' });
    const q = f.store.read().questions[0];
    f.store.close();
    f = fixture(new Store(join(dir, 'state.sqlite'), { sample: false }));
    recoverWork(f.store);
    assert.equal(f.act('reply.open', { messageId: root.id }).id, child.id);
    assert.equal(f.store.read().threads.find((t) => t.id === child.id).draft, 'Keep draft');
    const answer = f.act('question.answer', { id: q.id, optionId: '1' });
    assert.equal(answer.threadId, child.id);
    assert.equal(f.act('question.answer', { id: q.id, optionId: '1' }).id, answer.id);
    assert.equal(f.store.read().threads.filter((t) => t.replyTo).length, 1);
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('workspace image reads provide image bytes to the model with an attachment label instead of binary text', async () => {
  const f = fixture();
  try {
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=';
    const file = f.act('file.add', { name: 'one-pixel.png', mime: 'image/png', base64 });
    const root = f.root('main', 'Review this picture.', 'relay', [{ kind: 'file', id: file.id }]);
    const child = f.act('reply.open', { messageId: root.id });
    const run = f.act('chat.send', { threadId: child.id, text: 'Inspect the attached image.' });
    let rounds = 0;
    const result = await agentReply(
      f.store,
      {
        complete: async (messages) => {
          if (isMemoryReview(messages)) return emptyMemoryReply();
          if (rounds++ === 0)
            return {
              text: '',
              toolCalls: [
                {
                  id: 'read-image',
                  function: { name: 'read_file', arguments: JSON.stringify({ id: file.id }) },
                },
              ],
            };
          const image = messages.find((m) => m.visual);
          assert.equal(image.visual, `data:image/png;base64,${base64}`);
          assert.match(image.content, /Attached workspace image/);
          assert(!image.content.includes('computer screen'));
          return { text: 'The image was provided to the model.', toolCalls: [] };
        },
      },
      run,
      {},
    );
    assert.equal(result.cards[0].id, file.id);
  } finally {
    f.store.close();
  }
});
test('the HTTP worker completes questions and nested handoffs entirely inside a group reply thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-reply-worker-'));
  let b;
  const server = await assistantsFixture(dir, {
    respond: ({ messages }) => {
      const all = JSON.stringify(messages),
        system = messages[0].content;
      if (system.startsWith('You are Pip,')) {
        if (!all.includes('Saved questions and my answers:'))
          return tool('ask_question', {
            prompt: 'Which tone?',
            options: [{ label: 'Warm' }, { label: 'Formal' }],
          });
        if (messages.at(-1).role !== 'tool')
          return tool('write_note', {
            name: 'thread-plan.md',
            text: '# Refined plan\n\nOne small step.',
          });
        return { role: 'assistant', content: 'Pip refined the plan in this thread.' };
      }
      if (all.includes('Continue the original request using this specialist result.'))
        return { role: 'assistant', content: 'Mochi reviewed the threaded result.' };
      return tool('ask_assistant', {
        assistantId: b.id,
        title: 'Refine the plan',
        request: 'Refine this plan. Ask which tone to use.',
      });
    },
  });
  try {
    const f = fixture(server.store),
      g = f.group();
    b = g.b;
    const root = f.root(g.thread.id, 'Original plan', g.a.id),
      parentBefore = f.store.read().messages.filter((m) => m.threadId === g.thread.id);
    const child = f.act('reply.open', { messageId: root.id });
    f.act('chat.send', {
      threadId: child.id,
      text: 'Ask Pip to refine this plan, then review it.',
    });
    const q = await waitFor(() => f.store.read().questions.find((q) => q.status === 'pending'));
    assert.equal(q.threadId, child.id);
    f.act('question.answer', { id: q.id, optionId: '1' });
    await waitFor(() =>
      f.store.read().messages.some((m) => m.text === 'Mochi reviewed the threaded result.'),
    );
    const s = f.store.read();
    assert.deepEqual(
      s.messages.filter((m) => m.threadId === g.thread.id),
      parentBefore,
    );
    assert(s.handoffs.every((h) => h.threadId === child.id && h.status === 'completed'));
    assert(s.runs.every((r) => r.threadId === child.id && r.status === 'completed'));
    assert.equal(
      s.files.find((f) => f.name === 'thread-plan.md').text,
      '# Refined plan\n\nOne small step.',
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('a held reply thread does not block Main, and stopping it pauses only its own queued follow-up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-reply-queues-'));
  let held = false,
    release;
  const server = await assistantsFixture(dir, {
    respond: async ({ messages }) => {
      const wire = messages.findLast((m) => m.role === 'user')?.content;
      assert.match(wire, /^\[Relay timestamp: \d{4}-\d{2}-\d{2}T[\d:.]+Z\]\n/);
      const last = wire.slice(wire.indexOf('\n') + 1);
      if (last === 'Hold this thread.') {
        held = true;
        await new Promise((r) => {
          release = r;
        });
        return { role: 'assistant', content: 'Late result to discard' };
      }
      return {
        role: 'assistant',
        content:
          last === 'Main can continue.'
            ? 'Main is still responsive.'
            : 'The queued follow-up is ready.',
      };
    },
  });
  try {
    const f = fixture(server.store),
      root = f.root(),
      child = f.act('reply.open', { messageId: root.id });
    const active = f.act('chat.send', { threadId: child.id, text: 'Hold this thread.' });
    await waitFor(() => held);
    const queued = f.act('chat.send', { threadId: child.id, text: 'A queued follow-up' });
    f.act('chat.send', { threadId: 'main', text: 'Main can continue.' });
    await waitFor(() =>
      f.store.read().messages.some((m) => m.text === 'Main is still responsive.'),
    );
    f.act('chat.stop', { id: active.id });
    server.worker.abort(active.id);
    release();
    await waitFor(() => !server.worker.active.has(active.id));
    assert.equal(f.store.read().threads.find((t) => t.id === child.id).queuePaused, true);
    assert(!f.store.read().threads.find((t) => t.id === 'main').queuePaused);
    assert.equal(f.store.read().runs.find((r) => r.id === queued.id).status, 'queued');
    assert(!f.store.read().messages.some((m) => m.text === 'Late result to discard'));
    f.act('thread.update', { id: child.id, queuePaused: false });
    await waitFor(() => f.store.read().runs.find((r) => r.id === queued.id).status === 'completed');
  } finally {
    release?.();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
