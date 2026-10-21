// SPDX-License-Identifier: MIT
// Keep unrelated deterministic acceptance models focused on their scenario.
// Real memory selection and lifecycle are covered by memory-review.test and
// test-memory-live; this fixture never enters production code.
export const isMemoryReview = (input) =>
  JSON.stringify(input).includes("Review the current owner's message for personal memory.");
export const emptyMemoryReply = () => ({ text: '{"memories":[]}', toolCalls: [] });
export const emptyMemoryWireReply = () => {
  const text = emptyMemoryReply().text;
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  };
};
export const ignoreMemoryReviews =
  (complete) =>
  (...args) =>
    isMemoryReview(args[0]) ? Promise.resolve(emptyMemoryReply()) : complete(...args);
