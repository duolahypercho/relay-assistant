// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
try {
  const email = await PostalMime.parse(workerData.bytes, {
    attachmentEncoding: 'base64',
    rfc822Attachments: true,
    maxNestingDepth: 20,
    maxHeadersSize: 128000,
    maxPartCount: 200,
    maxRfc822NestingDepth: 0,
  });
  if (
    !email.headers.some((h) =>
      ['from', 'to', 'subject', 'date', 'mime-version', 'content-type', 'message-id'].includes(
        h.key,
      ),
    )
  )
    throw Error('This does not look like an email file. Download the original to inspect it.');
  const address = (a) =>
    a?.group
      ? `${a.name || 'Group'}: ${a.group.map(address).join(', ')}`
      : [a?.name, a?.address && `<${a.address}>`].filter(Boolean).join(' ');
  const clean = (value) =>
    String(value || '').replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
      '',
    );
  const header = (value) => clean(value).slice(0, 16000);
  const text =
    (email.text?.trim() ? email.text : undefined) ??
    (email.html
      ? convert(email.html, {
          wordwrap: false,
          limits: {
            maxInputLength: 8 * 1024 * 1024,
            maxDepth: 40,
            maxChildNodes: 10000,
            ellipsis: '[HTML preview limit reached; open the original email for omitted content.]',
          },
          selectors: [
            { selector: 'img', format: 'skip' },
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
          ],
        })
      : '');
  if (text.length > 2_000_000)
    throw Error('This email has too much text to preview. Download the original.');
  const attachments = email.attachments.map((a, index) => ({
    index,
    name:
      clean(a.filename || `attachment-${index + 1}${a.mimeType === 'message/rfc822' ? '.eml' : ''}`)
        .replace(/[\/\\]/g, '_')
        .slice(0, 180) || `attachment-${index + 1}`,
    mime: String(a.mimeType || 'application/octet-stream').slice(0, 120),
    size: Buffer.from(a.content, 'base64').length,
    base64: a.content,
    inline: a.disposition === 'inline' || !!a.related,
  }));
  parentPort.postMessage({
    result: {
      subject: header(email.subject) || '(No subject)',
      from: header(address(email.from)),
      to: header(email.to?.map(address).join(', ')),
      cc: header(email.cc?.map(address).join(', ')),
      bcc: header(email.bcc?.map(address).join(', ')),
      replyTo: header(email.replyTo?.map(address).join(', ')),
      date: header(email.date),
      text: clean(text),
      attachments,
      warnings: [
        'Saved email headers are unverified; they do not prove who sent the message.',
        'Text preview only. Remote images, active content and tracking are not loaded. Download the original for its layout and complete headers. Calendar attachments are decoded to normalized UTF-8 text.',
      ],
    },
  });
} catch (error) {
  parentPort.postMessage({ error: error.message || 'This email could not be read.' });
}
