// SPDX-License-Identifier: MIT
// Only these calls reproduce the original receipt identity without reading the
// guest, deriving new bytes, exporting a file, or mutating another service.
export function computerReceiptSupported(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return (
    name === 'computer_run' ||
    name === 'computer_use' ||
    (name === 'computer_files' &&
      ['write', 'mkdir'].includes(input.action) &&
      (input.attach === undefined || input.attach === false))
  );
}

export function computerReceiptCheckpoint(state) {
  if (state.computerReceiptVersion !== 1) return false;
  const call = state.response?.toolCalls?.[state.nextTool];
  try {
    return computerReceiptSupported(call?.function?.name, JSON.parse(call.function.arguments));
  } catch {
    return false;
  }
}
