// SPDX-License-Identifier: MIT
import { ModelUnavailableError } from './model-failover.mjs';
async function* chunks(body) {
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      let step;
      try {
        step = await iterator.next();
      } catch (error) {
        if (['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
        throw new ModelUnavailableError(
          'The model connection ended before the response finished. Retry the request.',
          'interrupted',
        );
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await iterator.return?.().catch(() => {});
  }
}
export async function* sseFrames(body, { onDone = () => {} } = {}) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of chunks(body)) {
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('The provider stream exceeded the limit.');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) {
        const value = line.slice(5).trim();
        if (value === '[DONE]') onDone();
        if (value && value !== '[DONE]') yield modelParse(value);
      }
    }
  }
  const line = buffer.trim();
  if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') onDone();
  if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    yield modelParse(line.slice(5));
}
export function modelParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('The model endpoint returned an invalid response. Check its API format.');
  }
}
export async function modelJSON(response, limit = 2_000_000) {
  const buffers = [];
  let bytes = 0;
  for await (const chunk of chunks(response.body)) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('The model response exceeded the limit.');
    buffers.push(chunk);
  }
  return modelParse(Buffer.concat(buffers).toString('utf8'));
}
