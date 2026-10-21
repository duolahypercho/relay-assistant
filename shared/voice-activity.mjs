// SPDX-License-Identifier: MIT
// Energy-based speech segmentation. Audio remains in memory until a complete utterance.
export function* voiceActivityFrames(samples, rate) {
  // Capture callbacks vary across devices and between Worklet and fallback
  // paths. Counting an entire large callback as voiced can turn a short noise
  // into a spoken turn. Bound the detector's timing resolution to 20 ms.
  const size = Math.max(1, Math.round(rate * 0.02));
  for (let offset = 0; offset < samples.length; offset += size)
    yield samples.subarray(offset, Math.min(offset + size, samples.length));
}

export class VoiceSegmenter {
  constructor(rate, { silence = 0.9, maximum = 45 } = {}) {
    this.rate = rate;
    this.silence = silence;
    this.maximum = maximum;
    this.reset();
  }
  reset() {
    this.active = false;
    this.ring = [];
    this.chunks = [];
    this.onset = 0;
    this.quiet = 0;
    this.voiced = 0;
    this.duration = 0;
    this.noise = 0.002;
  }
  push(samples) {
    const block = new Float32Array(samples),
      seconds = block.length / this.rate;
    const rms = Math.sqrt(block.reduce((sum, v) => sum + v * v, 0) / Math.max(1, block.length));
    const loud = rms > Math.max(0.012, Math.min(0.035, this.noise * 3.5));
    if (!loud && !this.active) this.noise = this.noise * 0.97 + rms * 0.03;
    let started = false;
    if (!this.active) {
      this.ring.push(block);
      while (this.ring.length > 1 && this.ring.reduce((n, b) => n + b.length, 0) > this.rate * 0.3)
        this.ring.shift();
      this.onset = loud ? this.onset + seconds : 0;
      if (this.onset < 0.12) return { rms };
      this.active = true;
      started = true;
      this.chunks = this.ring;
      this.ring = [];
      this.voiced = this.onset;
      this.duration = this.chunks.reduce((n, b) => n + b.length, 0) / this.rate;
    } else {
      this.chunks.push(block);
      this.duration += seconds;
      if (loud) this.voiced += seconds;
    }
    this.quiet = loud ? 0 : this.quiet + seconds;
    if (this.quiet >= this.silence || this.duration >= this.maximum) {
      const chunks = this.voiced >= 0.25 ? this.chunks : null;
      this.reset();
      return { rms, started, finished: true, chunks };
    }
    return { rms, started };
  }
}
export function speechWav(chunks, rate) {
  const length = chunks.reduce((n, b) => n + b.length, 0),
    input = new Float32Array(length);
  let offset = 0;
  for (const b of chunks) {
    input.set(b, offset);
    offset += b.length;
  }
  const target = 16000,
    count = Math.floor((length * target) / rate);
  const bytes = new ArrayBuffer(44 + count * 2),
    view = new DataView(bytes);
  const label = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  label(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * rate) / target),
      to = Math.min(length, Math.max(from + 1, Math.floor(((i + 1) * rate) / target)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    view.setInt16(
      44 + i * 2,
      Math.max(-32768, Math.min(32767, Math.round((sum / (to - from)) * 32767))),
      true,
    );
  }
  return bytes;
}
