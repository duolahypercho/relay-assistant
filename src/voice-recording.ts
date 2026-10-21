import { speechWav } from '../shared/voice-activity.mjs';

// MediaRecorder uses different containers on desktop and iOS. Normalize locally
// for the optional on-computer recognizer; never alter the retry recording.
export async function listeningWav(clip: Blob, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (clip.size > 8 * 1024 * 1024)
    throw new Error('This recording is too large. Try a shorter message.');
  const context = new AudioContext();
  try {
    const bytes = await clip.arrayBuffer();
    signal.throwIfAborted();
    const audio = await context.decodeAudioData(bytes);
    signal.throwIfAborted();
    if (
      !Number.isFinite(audio.duration) ||
      audio.duration < 0.1 ||
      audio.duration > 120.1 ||
      audio.numberOfChannels > 2
    )
      throw new Error('Try a recording between a tenth of a second and two minutes.');
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const values = audio.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] += values[i] / audio.numberOfChannels;
    }
    return new Blob([speechWav([mono], audio.sampleRate)], { type: 'audio/wav' });
  } finally {
    await context.close().catch(() => {});
  }
}
