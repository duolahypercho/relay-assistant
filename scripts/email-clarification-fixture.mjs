// SPDX-License-Identifier: MIT
// Original controlled HTTP model; real agent, question commands and durable review.
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';

export const clarification = {
  prompt: 'What is the recipient email address?',
  subject: 'Tomorrow at the workshop',
  body: 'See you at 14:00.\nPlease bring your notebook.',
  recipient: 'friend@example.test',
  partial: 'friend@',
  draft: 'Keep my next thought',
};
export async function emailClarificationFixture(directory, options = {}) {
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store) {
      store.mutate((s) => {
        s.profile.memoryLearning = false;
      });
    },
    respond({ messages }) {
      const last = messages.at(-1);
      if (last.role === 'tool')
        return { role: 'assistant', content: 'Your email is ready for review.' };
      if (
        messages.some(
          (m) => m.role === 'user' && m.content.endsWith('\n' + clarification.recipient),
        )
      )
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'email-review',
              type: 'function',
              function: {
                name: 'prepare_email',
                arguments: JSON.stringify({
                  to: clarification.recipient,
                  subject: clarification.subject,
                  body: clarification.body.replace('\n', ' '),
                  attachmentIds: [],
                }),
              },
            },
          ],
        };
      // Exercise the bounded prose-question recovery, not an injected question card.
      return { role: 'assistant', content: clarification.prompt };
    },
  });
  let original;
  return Object.assign(f, {
    start() {
      assert(!original);
      original = f.store.mutate((s) =>
        command(s, 'chat.send', {
          threadId: 'main',
          text: `Draft an email for my review. Subject: "${clarification.subject}". Body: "${clarification.body}". I have not supplied the recipient yet. Ask me for their address. Do not send it.`,
        }),
      );
      return original;
    },
    pending() {
      const s = f.store.read();
      assert.equal(s.questions.length, 1);
      const q = s.questions[0];
      assert.equal(q.status, 'pending');
      assert.equal(q.sourceRunId, original.id);
      assert.equal(q.prompt, clarification.prompt);
      assert.deepEqual(q.options, []);
      assert.equal(s.approvals.length, 0);
      assert.equal(s.runs.length, 1);
      assert.equal(s.messages.filter((m) => m.role === 'user').length, 1);
      assert.equal(f.requests.length, 1);
      return q;
    },
    verify() {
      const s = f.store.read(),
        q = s.questions[0];
      assert.equal(s.questions.length, 1);
      assert.equal(q.status, 'answered');
      assert.equal(q.answer, clarification.recipient);
      assert.equal(s.runs.length, 2);
      assert(s.runs.every((r) => r.status === 'completed'));
      assert.equal(s.messages.filter((m) => m.role === 'user').length, 2);
      assert.equal(s.messages.filter((m) => m.questionId === q.id).length, 1);
      assert.equal(s.approvals.length, 1);
      const review = s.approvals[0];
      assert.equal(review.kind, 'email');
      assert.equal(review.status, 'pending');
      assert.equal(review.creation.runId, q.answerRunId);
      assert.equal(review.payload.to, clarification.recipient);
      assert.equal(review.payload.subject, clarification.subject);
      assert.equal(review.payload.body, clarification.body);
      assert.deepEqual(review.payload.attachmentIds, []);
      assert.equal(s.threads.find((t) => t.id === 'main').draft, clarification.draft);
      assert.equal(s.connections.google.connected, false);
      assert.equal(f.requests.length, 3);
      return {
        question: q,
        review,
        runs: s.runs.length,
        modelRequests: f.requests.length,
        composerDraft: clarification.draft,
        noSendAccount: true,
      };
    },
  });
}
