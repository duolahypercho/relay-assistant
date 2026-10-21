// SPDX-License-Identifier: MIT
class RelayVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const value of samples) {
        this.buffer[this.offset++] = value;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor('relay-voice-capture', RelayVoiceCapture);
