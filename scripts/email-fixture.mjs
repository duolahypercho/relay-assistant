// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
export const enclosedBytes = Buffer.from('Item,Cost\r\nTrain,25\r\nTea,8\r\n');
export function emailBytes({ html = false, long = false } = {}) {
  const body = html
    ? '<p>Meet at noon &amp; bring a book.</p><img src="https://tracking.invalid/pixel"><script>window.emailRan=true</script><a href="https://example.invalid/notes">Notes</a>'
    : `Meet at noon and bring a book. 你好 🌱\n${long ? 'Long note. '.repeat(1400) + 'END OF EMAIL' : ''}`;
  return Buffer.from(
    [
      'From: =?UTF-8?B?Q2Fmw6kgVGVhbQ==?= <team@example.invalid>',
      'To: Owner <owner@example.invalid>',
      'Reply-To: Replies <reply@example.invalid>',
      'Subject: =?UTF-8?Q?Weekend_=E2=80=94_plan?=',
      'Date: Mon, 12 Oct 2026 12:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="relay-email-boundary"',
      '',
      '--relay-email-boundary',
      `Content-Type: text/${html ? 'html' : 'plain'}; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64'),
      '--relay-email-boundary',
      'Content-Type: text/csv; name="Budget.csv"',
      'Content-Disposition: attachment; filename="Budget.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      enclosedBytes.toString('base64'),
      '--relay-email-boundary--',
      '',
    ].join('\r\n'),
  );
}
export async function emailFixture(directory, options = {}) {
  const source = emailBytes({ html: true }),
    reads = [],
    errors = [];
  const call = (name, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `email-${name}-${reads.length}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store) {
      if (options.seed)
        store.mutate((s) => {
          const file = command(s, 'file.add', {
            name: 'Weekend.eml',
            mime: 'message/rfc822',
            base64: source.toString('base64'),
          });
          s.messages.push({
            id: 'email-fixture-message',
            role: 'user',
            threadId: 'main',
            text: 'Keep this email here.',
            fileIds: [file.id],
            createdAt: new Date().toISOString(),
          });
        });
    },
    respond(body) {
      try {
        const file = f.store.read().files.find((x) => x.name === 'Weekend.eml');
        const last = body.messages.at(-1);
        if (last.role !== 'tool') return call('read_file', { id: file.id });
        const value = JSON.parse(last.content);
        assert(!value.error, value.error);
        reads.push(value.result);
        if (value.result.kind === 'email') {
          assert.match(value.result.text, /Meet at noon/);
          assert.match(value.result.from, /Café Team/);
          assert.match(value.result.sourceNotice, /untrusted/);
          assert.equal(value.result.attachments.length, 1);
          assert(!JSON.stringify(value).includes('base64'));
          return call('import_email_attachment', {
            id: file.id,
            index: 0,
            contentHash: value.result.contentHash,
          });
        }
        if (value.result.id) return call('read_file', { id: value.result.id });
        assert.match(value.result.text, /Train,25/);
        return {
          role: 'assistant',
          content: 'The email says noon. The attached budget lists train 25 and tea 8.',
        };
      } catch (error) {
        errors.push(error.message);
        throw error;
      }
    },
  });
  return { ...f, source, reads, errors };
}
