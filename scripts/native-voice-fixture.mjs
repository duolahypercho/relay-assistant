// Isolated QA only: synthetic microphone samples, real WebView audio processing and HTTP audio services.
// Never serves from production or accesses a hardware microphone.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { audioFixture } from './audio-fixture.mjs';
import { SpeechService } from '../server/speech.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const voiceFixtureScript = `(() => {
  const OriginalContext = window.AudioContext;
  const contexts = [], streams = [], sources = [];
  const sourceEntries = new WeakMap();
  let microphoneContext, gain, lastPulse = 0, completedPulse = 0, pendingPulse;
  window.AudioContext = new Proxy(OriginalContext, { construct(target, args) {
    const context = Reflect.construct(target, args); contexts.push(context); return context;
  }});
  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) {
    const entry = { ended: false, stopped: false, context: this.context }; sources.push(entry);
    sourceEntries.set(this, entry);
    this.addEventListener('ended', () => { entry.ended = true; }, { once: true });
    return originalStart.apply(this, args);
  };
  // Closing an Android AudioContext can prevent a final ended event from being
  // dispatched. Record the actual stop call and context state as well.
  const originalStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function(...args) {
    const result = originalStop.apply(this, args);
    const entry = sourceEntries.get(this); if (entry) entry.stopped = true;
    return result;
  };
  const syntheticCapture = async () => {
    const mode = await (await fetch('/__voice-test/state')).json();
    if (mode.deny) throw new DOMException('Controlled permission denial', 'NotAllowedError');
    microphoneContext = new OriginalContext();
    const tone = microphoneContext.createOscillator(), destination = microphoneContext.createMediaStreamDestination();
    gain = microphoneContext.createGain(); gain.gain.value = 0; tone.frequency.value = 330;
    tone.connect(gain); gain.connect(destination); tone.start(); await microphoneContext.resume();
    streams.push(destination.stream); return destination.stream;
  };
  Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', { configurable: true, writable: true, value: syntheticCapture });
  async function poll() {
    try {
      const mode = await (await fetch('/__voice-test/state')).json();
      if (mode.pulse?.id > lastPulse) {
        lastPulse = mode.pulse.id;
        const currentGain = gain, id = lastPulse;
        if (currentGain) {
          const start = currentGain.context.currentTime + 0.03, end = start + mode.pulse.ms / 1000;
          currentGain.gain.cancelScheduledValues(0);
          currentGain.gain.setValueAtTime(0, currentGain.context.currentTime);
          currentGain.gain.setValueAtTime(0.15, start);
          currentGain.gain.setValueAtTime(0, end);
          pendingPulse = { id, context: currentGain.context, end };
        }
      }
      if (pendingPulse && pendingPulse.context.currentTime >= pendingPulse.end) {
        completedPulse = pendingPulse.id; pendingPulse = null;
      }
      const tracks = streams.flatMap(s => s.getTracks().map(t => ({ state: t.readyState, enabled: t.enabled })));
      if (tracks.length && tracks.every(t => t.state === 'ended') && microphoneContext?.state !== 'closed') await microphoneContext.close();
      const memos = [...document.querySelectorAll('.voice-memo')].map(el => {
        const audio = el.querySelector('audio');
        return { compact: el.classList.contains('voice-memo-inline'), transcript: !!el.querySelector('details'), playing: !!audio && !audio.paused, time: audio?.currentTime || 0, height: el.getBoundingClientRect().height };
      });
      await fetch('/__voice-test/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ syntheticInstalled: navigator.mediaDevices.getUserMedia === syntheticCapture, tracks, contexts: contexts.map(c => c.state), captureRates: contexts.map(c => c.sampleRate), microphoneRate: microphoneContext?.sampleRate, playbackStarts: sources.length, playbackActive: sources.filter(s => !s.ended && !s.stopped && s.context.state === 'running').length, playbackStops: sources.filter(s => s.stopped).length, completedPulse, memos, at: Date.now() }) });
    } catch {}
    setTimeout(poll, 120);
  }
  poll();
})();`;

export async function nativeVoiceFixture(directory, options = {}) {
  let holdNextModel = false,
    releaseModel,
    holdNextSpeech = false,
    releaseSpeech,
    speechCancellations = 0,
    failNextSpeech = false,
    holdWorkspacePage = false;
  const pendingPages = [];
  const recordings = [],
    speaking = [],
    errors = [];
  let failTranscript = false,
    report = {},
    mode = { deny: false, pulse: null },
    modelReplies = 0;
  const audio = createServer(async (req, res) => {
    try {
      if (req.url === '/v1/audio/transcriptions') {
        const form = await new Request('http://localhost', {
          method: 'POST',
          headers: req.headers,
          body: req,
          duplex: 'half',
        }).formData();
        const wav = Buffer.from(await form.get('file').arrayBuffer());
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.readUInt32LE(24), 16000);
        assert(wav.length > 32000);
        assert(wav.subarray(1000).some((b) => b > 5 && b < 240));
        recordings.push(wav);
        if (failTranscript) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Controlled listening failure' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ text: `Native voice request ${recordings.length}: make a quiet plan.` }),
        );
      } else if (req.url === '/v1/audio/speech') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        speaking.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (holdNextSpeech) {
          holdNextSpeech = false;
          await new Promise((resolve) => {
            const cancelled = () => {
              speechCancellations++;
              releaseSpeech = null;
              resolve();
            };
            res.once('close', cancelled);
            releaseSpeech = () => {
              res.off('close', cancelled);
              releaseSpeech = null;
              resolve();
            };
          });
          if (res.destroyed) return;
        }
        if (failNextSpeech) {
          failNextSpeech = false;
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Controlled speaking failure' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(audioFixture(12));
      } else res.writeHead(404).end();
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500).end('Fixture failed');
    }
  }).listen(0, '127.0.0.1');
  await once(audio, 'listening');
  const html = (await readFile(resolve('dist/index.html'), 'utf8')).replace(
    '<head>',
    '<head><script src="/__voice-test.js"></script>',
  );
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store, services) {
      let systemSpeech = options.systemSpeech;
      if (options.streamAudio) {
        systemSpeech = new SpeechService({
          baseUrl: `http://127.0.0.1:${audio.address().port}/v1`,
          model: 'native-streamed-speech',
          voice: 'calm',
        });
        const synthesize = systemSpeech.synthesize.bind(systemSpeech);
        systemSpeech.synthesize = async (text, signal, onAudio) => {
          const bytes = await synthesize(text, signal);
          bytes.writeUInt32LE(22050, 24);
          bytes.writeUInt32LE(44100, 28);
          for (let offset = 44; onAudio && offset < bytes.length; offset += 65536) {
            signal?.throwIfAborted();
            await onAudio({
              encoding: 'pcm16',
              sampleRate: 22050,
              channels: 1,
              audio: bytes.subarray(offset, Math.min(offset + 65536, bytes.length)),
            });
            await delay(10, undefined, { signal });
          }
          return bytes;
        };
      }
      const connections = new VoiceConnections(store, {
        key: modelVaultKey(directory),
        ...(systemSpeech ? { systemSpeech } : {}),
      });
      for (const kind of ['transcription', 'speech'])
        connections.update(kind, {
          revision: 0,
          action: 'save',
          baseUrl: `http://127.0.0.1:${audio.address().port}/v1`,
          model: `native-${kind}`,
          voice: 'calm',
          apiKey: '',
        });
      if (systemSpeech)
        connections.update('speech', { revision: 1, action: 'select', mode: 'system' });
      services.voiceConnections = connections;
      services.transcription = connections.transcription;
      services.speech = connections.speech;
    },
    async respond(body) {
      if (holdNextModel) {
        holdNextModel = false;
        await new Promise((resolve) => {
          releaseModel = resolve;
        });
        releaseModel = null;
      }
      assert.match(body.messages[0].content, /live voice conversation/);
      return {
        role: 'assistant',
        content:
          options.voiceReplyText ||
          `Native spoken reply ${++modelReplies}. Your quiet plan is saved in this chat.`,
      };
    },
    middleware(req, res, next) {
      if (holdWorkspacePage && /^\/assets\/WorkspacePage-[^/]+\.js$/.test(req.path)) {
        pendingPages.push(next);
        return;
      }
      if (req.path === '/__voice-test.js')
        return res
          .set('Cache-Control', 'no-store')
          .type('application/javascript')
          .send(voiceFixtureScript);
      if (req.path === '/__voice-test/state')
        return res.set('Cache-Control', 'no-store').json(mode);
      if (req.path === '/__voice-test/report' && req.method === 'POST') {
        let body = '';
        req.on('data', (b) => {
          body += b;
          if (body.length > 32000) req.destroy();
        });
        req.on('end', () => {
          try {
            report = JSON.parse(body);
            res.end('ok');
          } catch {
            res.status(400).end();
          }
        });
        return;
      }
      if (['/', '/index.html'].includes(req.path) && req.method === 'GET')
        return res.type('html').send(html);
      next();
    },
  });
  return {
    ...f,
    recordings,
    speaking,
    errors,
    holdWorkspacePage() {
      holdWorkspacePage = true;
    },
    get workspacePageHeld() {
      return pendingPages.length > 0;
    },
    releaseWorkspacePage() {
      holdWorkspacePage = false;
      for (const next of pendingPages.splice(0)) next();
    },
    holdModel() {
      holdNextModel = true;
    },
    get modelHeld() {
      return !!releaseModel;
    },
    releaseModel() {
      releaseModel?.();
    },
    holdSpeech() {
      holdNextSpeech = true;
    },
    get speechHeld() {
      return !!releaseSpeech;
    },
    get speechCancellations() {
      return speechCancellations;
    },
    failSpeech() {
      failNextSpeech = true;
    },
    get report() {
      return report;
    },
    deny(value) {
      mode.deny = value;
    },
    fail(value) {
      failTranscript = value;
    },
    pulse(ms = 1500) {
      assert([180, 1500].includes(ms), 'Choose the short-noise or spoken-turn fixture.');
      const id = (mode.pulse?.id || 0) + 1;
      mode.pulse = { id, ms };
      return id;
    },
    async close() {
      holdWorkspacePage = false;
      for (const next of pendingPages.splice(0)) next();
      releaseModel?.();
      releaseSpeech?.();
      await f.close();
      audio.closeAllConnections();
      await new Promise((r) => audio.close(r));
    },
  };
}
