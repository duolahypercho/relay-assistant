// Synthetic tone for automated audio transport and playback checks; not speech.
export function audioFixture(seconds = 10) {
  const rate = 24000,
    samples = Math.floor(rate * seconds);
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVE', 8);
  audio.write('fmt ', 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24);
  audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    audio.writeInt16LE(
      Math.round(
        Math.sin((i / rate) * 440 * Math.PI * 2) * 2400 * Math.min(1, i / 240, (samples - i) / 240),
      ),
      44 + i * 2,
    );
  return audio;
}
