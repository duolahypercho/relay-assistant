// SPDX-License-Identifier: MIT
// Queue continuous PCM on the existing user-activated AudioContext. Every source
// remains owned by the call until it ends, including already scheduled audio.
export class VoicePlayback {
  constructor(context) {
    this.context = context;
    this.nodes = new Set();
    this.until = 0;
    this.closed = false;
    this.received = 0;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  enqueue(buffer) {
    if (this.closed) return;
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);
    this.nodes.add(node);
    node.onended = () => {
      node.disconnect();
      this.nodes.delete(node);
      if (this.closed && !this.nodes.size) this.resolve();
    };
    const start = Math.max(this.context.currentTime + 0.06, this.until);
    node.start(start);
    this.until = start + buffer.duration;
  }
  pcm(part) {
    if (
      part.encoding !== 'pcm16' ||
      part.sampleRate !== 22050 ||
      part.channels !== 1 ||
      typeof part.audio !== 'string' ||
      part.audio.length > 90000
    )
      throw Error('The spoken reply returned an unsupported audio format.');
    const bytes = Uint8Array.from(atob(part.audio), (char) => char.charCodeAt(0));
    this.received += bytes.length;
    if (!bytes.length || bytes.length % 2 || this.received > 8 * 1024 * 1024)
      throw Error('The spoken reply returned an invalid recording.');
    const buffer = this.context.createBuffer(1, bytes.length / 2, part.sampleRate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    this.enqueue(buffer);
  }
  finish() {
    this.closed = true;
    if (!this.nodes.size) this.resolve();
    return this.done;
  }
  stop() {
    this.closed = true;
    for (const node of this.nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
    this.nodes.clear();
    this.resolve();
  }
}

export async function* voiceReplyFrames(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(body.error || 'The spoken reply could not load. Its text is saved in chat.');
  }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body)
    throw Error('The spoken reply connection returned an invalid response.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = '',
    size = 0,
    completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 12 * 1024 * 1024) throw Error('The spoken reply exceeded its audio limit.');
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        if (newline > 100000) throw Error('The spoken reply returned an oversized audio frame.');
        const frame = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (completed) throw Error('The spoken reply continued after it finished.');
        if (frame.type === 'error') throw Error(frame.error || 'Voice creation failed.');
        if (frame.type !== 'audio' && frame.type !== 'done')
          throw Error('The spoken reply returned an invalid audio frame.');
        if (frame.type === 'done') {
          if (!frame.card?.id) throw Error('The spoken reply was not saved.');
          completed = true;
        }
        yield frame;
      }
      if (pending.length > 100000)
        throw Error('The spoken reply returned an oversized audio frame.');
    }
    if (pending.trim() || !completed)
      throw Error(
        'The voice connection ended before the reply finished. Its text is saved in chat.',
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
