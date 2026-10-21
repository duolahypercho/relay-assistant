import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { audioFixture as tone } from './audio-fixture.mjs';
// Local deterministic speech service for browser tests; no external audio request.
const audioFixture = createServer(async (req, res) => {
  try {
    if (req.url === '/v1/audio/speech') {
      const body = await new Request('http://localhost', {
        method: 'POST',
        headers: req.headers,
        body: req,
        duplex: 'half',
      }).json();
      if (typeof body.input !== 'string' || !body.input || body.response_format !== 'wav')
        throw new Error('Invalid speech input');
      res.setHeader('Content-Type', 'audio/wav');
      res.end(tone());
      return;
    }
    const form = await new Request('http://localhost', {
      method: 'POST',
      headers: req.headers,
      body: req,
      duplex: 'half',
    }).formData();
    const recording = form.get('file');
    if (!recording || recording.size < 12 || !recording.type.startsWith('audio/'))
      throw new Error('Missing audio');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'Please plan a quiet morning.' }));
  } catch {
    res.writeHead(400);
    res.end();
  }
}).listen(0, '127.0.0.1');
await once(audioFixture, 'listening');
audioFixture.unref();
const directory = mkdtempSync(join(tmpdir(), 'relay-browser-tests-'));
const port = process.env.RELAY_TEST_SERVER_PORT || '5181';
Object.assign(process.env, {
  RELAY_DATA_DIR: directory,
  RELAY_PORT: port,
  RELAY_HOST: '127.0.0.1',
  RELAY_PUBLIC_URL: `http://127.0.0.1:${port}`,
  RELAY_MODE: 'sample',
  RELAY_ACCESS_KEY: '',
  RELAY_MODEL_BASE_URL: '',
  RELAY_MODEL_ID: '',
  RELAY_MODEL_API_KEY: '',
  RELAY_TRANSCRIPTION_BASE_URL: `http://127.0.0.1:${audioFixture.address().port}/v1`,
  RELAY_TRANSCRIPTION_MODEL: 'controlled-audio-fixture',
  RELAY_TRANSCRIPTION_API_KEY: '',
  RELAY_SPEECH_BASE_URL: `http://127.0.0.1:${audioFixture.address().port}/v1`,
  RELAY_SPEECH_MODEL: 'controlled-speech-fixture',
  RELAY_SPEECH_API_KEY: '',
  RELAY_SPEECH_VOICE: 'coral',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  BRAVE_SEARCH_API_KEY: '',
  RELAY_COMPUTER_ENABLED: 'false',
  RELAY_DESKTOP_ENABLED: 'false',
  RELAY_BROWSER_ENABLED: 'false',
});
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
await import('../server/index.mjs');
