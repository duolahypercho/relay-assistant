// SPDX-License-Identifier: MIT
// Test-only microphone: original synthetic spoken sentence, real browser encoder.
export function listeningMicrophoneScript(wavBase64) {
  return `(${install.toString()})(${JSON.stringify(wavBase64)});`;
}
function install(base64) {
  const qa = (window.__listeningQA = {
    streams: [],
    contexts: [],
    deny: false,
    playing: false,
    done: 0,
    playback: 0,
  });
  const Context = window.AudioContext;
  const original = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    qa.playback++;
    return original.apply(this, args);
  };
  const syntheticCapture = async () => {
    if (qa.deny) throw new DOMException('Synthetic microphone denial', 'NotAllowedError');
    const context = new Context(),
      destination = context.createMediaStreamDestination();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    await context.resume();
    qa.pulse = async () => {
      const source = context.createBufferSource();
      source.buffer = qa.nextBuffer || buffer;
      source.connect(destination);
      qa.playing = true;
      await new Promise((resolve) => {
        source.onended = resolve;
        source.start();
      });
      qa.playing = false;
      qa.done++;
    };
    qa.streams.push(destination.stream);
    qa.contexts.push(context);
    return destination.stream;
  };
  Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
    configurable: true,
    writable: true,
    value: syntheticCapture,
  });
  qa.syntheticInstalled = navigator.mediaDevices.getUserMedia === syntheticCapture;
  const timer = setInterval(() => {
    qa.streams.forEach((stream, index) => {
      if (
        stream.getTracks().every((track) => track.readyState === 'ended') &&
        qa.contexts[index].state !== 'closed'
      )
        void qa.contexts[index].close();
    });
  }, 100);
  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(timer);
      qa.contexts.forEach((c) => void c.close().catch(() => {}));
    },
    { once: true },
  );
}
