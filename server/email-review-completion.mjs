// SPDX-License-Identifier: MIT
import { runAssistantId } from '../shared/assistant-scope.mjs';

// A narrow result-presence check, never permission to send email. Ordinary
// writing requests may still be answered with text in the conversation.
export function emailReviewRequested(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const request = text
    .trim()
    .replace(
      /^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+)+/i,
      '',
    );
  if (/^[>"'“‘`]/.test(request)) return false;
  const direct = request.replace(
    /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*(?:`|$)|"(?:[^"\\\n]|\\[^\n])*(?:"|$)|(?<!\w)'(?:[^'\n]|(?<=\w)'(?=\w))*(?:'(?!\w)|$)|“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)|「[^」\n]*(?:」|$)|^[ \t]*>.*$/gm,
    ' ',
  );
  if (
    /\b(?:don't|do not|never)\s+(?:draft|prepare|compose|create)\b|\b(?:in chat only|inline only|without (?:a )?review|an example|a sample|email template|email outline)\b|(?:不要|不用|别|別)(?:起草|准备|準備|创建|建立)/i.test(
      direct,
    )
  )
    return false;
  return (
    (/^(?:draft|prepare|compose)\s+(?:(?:me|us|a|an|the|my|our|new)\s+)*(?:e-?mail)\b/i.test(
      direct,
    ) &&
      /\b(?:for (?:my|our) review|let (?:me|us) review|review before (?:sending|you send))\b/i.test(
        direct,
      )) ||
    (/^(?:请|請)?(?:帮我|幫我)?(?:起草|准备|準備)(?:一封)?(?:电子邮件|電子郵件|邮件|郵件)/.test(
      direct,
    ) &&
      /(?:让我|讓我)(?:审核|審核|审阅|審閱|确认|確認)|(?:供我|给我|給我)(?:审核|審核|审阅|審閱|确认|確認)/.test(
        direct,
      ))
  );
}

export function deliveredEmailReview(state, run, cards = []) {
  const sourceId = run.activeMessageId || run.messageId;
  const identity = (item) => {
    try {
      return runAssistantId(state, item);
    } catch {
      return null;
    }
  };
  const assistantId = identity(run);
  if (!assistantId) return false;
  const related = new Set(
    (state.runs || [])
      .filter(
        (r) =>
          r.threadId === run.threadId &&
          (r.activeMessageId || r.messageId) === sourceId &&
          identity(r) === assistantId,
      )
      .map((r) => r.id),
  );
  return (state.approvals || []).some(
    (review) =>
      review.kind === 'email' &&
      review.creation?.sourceMessageId === sourceId &&
      review.creation?.threadId === run.threadId &&
      review.creation?.assistantId === assistantId &&
      related.has(review.creation?.runId) &&
      cards.some((c) => c.kind === 'review' && c.id === review.id),
  );
}

export function emailReviewRequired(run, currentText) {
  if (emailReviewRequested(currentText)) return true;
  // Clarification answers inherit their request, but a later correction does
  // not. An explicit cancellation answer must not trigger the repair prompt.
  if ((run.activeMessageId || run.messageId) !== run.messageId) return false;
  if (
    /^(?:(?:actually|please)[,\s]+)*(?:cancel\b|stop\b|never\s?mind\b|forget (?:it|that)\b|(?:don't|do not) (?:draft|prepare|compose|create)\b|(?:请|請)?(?:取消|停止|算了|不要|不用|别|別))/i.test(
      String(currentText || '').trim(),
    )
  )
    return false;
  return emailReviewRequested(run.questionContext?.origin?.request);
}

// Some tool-capable models ask a valid missing-recipient question in prose.
// Preserve that pause as the same durable input card rather than treating it
// as a false completion and pressuring the model to invent a recipient.
export function emailRecipientQuestion(run, currentText, responseText) {
  if (!emailReviewRequired(run, currentText)) return null;
  const supplied = [
    currentText,
    run.questionContext?.origin?.request,
    ...(run.questionContext?.answers || []).map((a) => a.answer),
  ]
    .filter(Boolean)
    .join('\n');
  if (/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/.test(supplied)) return null;
  const prompt = String(responseText || '').trim();
  if (
    !prompt ||
    prompt.length > 600 ||
    !/[?？]$/.test(prompt) ||
    /^[>"'“‘`]/.test(prompt) ||
    /[@`<>]/.test(prompt)
  )
    return null;
  if (!/\brecipient\b|\be-?mail address\b|收件人/.test(prompt.toLowerCase())) return null;
  if (
    /\b(?:ready|saved|created|prepared|sent)\b|\b(?:approve|approval|password|secret|token|credential)\b|(?:已|已经|已經)(?:创建|建立|准备|準備|发送|發送|保存)|(?:密码|密碼|令牌|凭证|憑證)/i.test(
      prompt,
    )
  )
    return null;
  return { prompt, options: [] };
}

// Preserve owner-authored literal fields, not an LLM's transcription of them.
// This never creates a review or chooses its recipient/attachments. Unsupported
// or ambiguous wording stays with normal drafting and the visible exact review.
export function exactEmailReviewFields(state, run, sourceMessageId) {
  if (!run || (run.activeMessageId || run.messageId) !== sourceMessageId) return {};
  const message = state.messages.find(
    (m) => m.id === sourceMessageId && m.threadId === run.threadId && m.role === 'user',
  );
  if (!message || !emailReviewRequired(run, message.text)) return {};
  let request = message.text;
  if (!emailReviewRequested(request)) {
    // A bare recipient answer leaves the original literal fields intact. More
    // complex answers may revise those fields, so do not reuse old wording.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.trim())) return {};
    request = run.questionContext?.origin?.request;
  }
  const direct = request.replace(
    /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*(?:`|$)|^[ \t]*>.*$/gm,
    (value) => ' '.repeat(value.length),
  );
  const closes = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
  const fields = { subject: [], body: [] };
  let start = 0;
  for (let i = 0; i < direct.length; i++) {
    const close = closes[direct[i]];
    if (!close || (direct[i] === "'" && /[\p{L}\p{N}]/u.test(direct[i - 1] || ''))) continue;
    let end = i + 1;
    for (; end < direct.length; end++) {
      if (direct[end] === '\\') {
        end++;
        continue;
      }
      if (direct[end] === close && !(close === "'" && /[\p{L}\p{N}]/u.test(direct[end + 1] || '')))
        break;
    }
    if (end >= direct.length) return {};
    const prefix = direct.slice(start, i);
    const label =
      /\b(subject|body)\s*(?:(?:must be|must read|must say|is|exactly)\s*)?[:：]?\s*$/i.exec(
        prefix,
      ) || /(主题|主題|正文)\s*(?:必须是|必須是|是)?\s*[:：]?\s*$/.exec(prefix);
    const clause = prefix.split(/[.;!?。；！？\n]/).at(-1);
    if (
      label &&
      !/\b(?:not|don't|never|example|sample|template)\b|(?:不要|不用|别|別|示例|例子)/i.test(clause)
    ) {
      const key = /^(?:subject|主题|主題)$/i.test(label[1]) ? 'subject' : 'body';
      const value = request.slice(i + 1, end);
      // Escaped delimiters have several plausible literal meanings. Let the
      // ordinary draft path handle them; never decode or reinterpret here.
      fields[key].push(value.includes('\\') ? null : value);
    }
    start = end + 1;
    i = end;
  }
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, values]) => values.length === 1 && values[0] !== null)
      .map(([key, values]) => [key, values[0]]),
  );
}

export const emailReviewRecoveryMessage =
  'Relay result check: this owner requested an email prepared for review, but no email review card exists for the current request. Text in chat and navigation to Inbox do not create that draft. Use prepare_email with the requested recipient, subject, body and attachments. Preserve explicitly supplied wording. It only creates an exact review; it never sends mail. Do not claim the draft is ready until its actual review card exists. If a required detail is missing, use ask_question. Never send or approve the email, and never recreate a review the owner has already acted on.';

export const pendingEmailReviewContext =
  '\nCurrent requested result: an email saved for review is still missing. Continue with a tool call, not a final text draft or success claim. If the recipient or another required detail is missing, call ask_question with prompt only to pause for a text answer; asking in prose alone does not pause the request. Once the owner has answered, use that answer and the original requested wording to call prepare_email. If necessary, read the requested sources first. Never invent an address or reuse one the owner says is different. Preparation creates a review card without sending, and needs no account connection. The actual saved card is the completion evidence.';
