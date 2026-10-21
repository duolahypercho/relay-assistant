// SPDX-License-Identifier: MIT
// Real Linux/Caddy/Whisper acceptance. Only the microphone, chat provider and
// speech-output transport are controlled. The app and recognizer are unmodified.
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Agent, request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  root = resolve(import.meta.dirname, '..');
export async function linuxListeningFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-linux-listening-acceptance-'));
  const project = 'relay-listening-' + randomUUID().slice(0, 8),
    image = project + '-fixture:local';
  const docker = process.env.RELAY_TEST_DOCKER || 'docker';
  const env = { ...process.env, RELAY_DOMAIN: '127.0.0.1' };
  const override = join(directory, 'override.yaml');
  const d = async (...args) =>
    (await exec(docker, args, { cwd: root, env, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  const compose = (...args) =>
    d('compose', '-p', project, '-f', 'deploy/compose.yaml', '-f', override, ...args);
  const freePort = async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    return port;
  };
  const port = await freePort(),
    httpPort = await freePort(),
    url = `https://127.0.0.1:${port}`;
  let agent,
    cookie = '';
  const until = async (fn, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    let last;
    do {
      try {
        const value = await fn();
        if (value) return value;
      } catch (error) {
        last = error;
      }
      await delay(200);
    } while (Date.now() < end);
    throw Error(label + ': ' + (last?.message || 'timed out'));
  };
  const call = (path, { method = 'GET', body, bytes, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        url + path,
        {
          agent,
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            Origin: url,
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let json;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(90000, () => req.destroy(Error('HTTPS request timed out')));
      req.end(bytes || (body ? JSON.stringify(body) : undefined));
    });
  const json = async (path, options) => {
    const r = await call(path, options);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    return r.json;
  };
  async function close() {
    agent?.destroy();
    await compose('down', '--volumes', '--remove-orphans');
    await d('image', 'rm', image);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const context = join(directory, 'fixture');
    await mkdir(context);
    await copyFile(
      process.env.RELAY_LISTENING_TEST_WAV ||
        resolve(root, '../../work/local-listening-research/probe.wav'),
      join(context, 'speech.wav'),
    );
    await copyFile(
      join(root, 'scripts/listening-microphone-fixture.mjs'),
      join(context, 'microphone.mjs'),
    );
    await writeFile(
      join(context, 'Dockerfile'),
      'FROM relay-server:local\nCOPY . /fixture/\nENTRYPOINT ["node", "/fixture/provider.mjs"]\nHEALTHCHECK NONE\n',
    );
    await writeFile(
      join(context, 'provider.mjs'),
      `import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {listeningMicrophoneScript} from './microphone.mjs';
const speech=await readFile('/fixture/speech.wav');
let pulse=0, report={}, chats=0, spoken=0, transcriptions=0;
const instrument=listeningMicrophoneScript(speech.toString('base64'))+\`
let lastPulse=null;
async function reportMicrophone(){try{const state=await(await fetch('/__linux/state')).json();const q=window.__listeningQA;if(lastPulse===null)lastPulse=state.pulse;else if(state.pulse>lastPulse&&q.pulse){lastPulse=state.pulse;void q.pulse();}await fetch('/__linux/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulse:lastPulse,done:q.done,playing:q.playing,streams:q.streams.map(s=>s.getTracks().map(t=>t.readyState)),at:Date.now()})});}catch{}setTimeout(reportMicrophone,100);}reportMicrophone();\`;
const html=(await readFile('/app/dist/index.html','utf8')).replace('<head>','<head><script>'+instrument+'</script>');
http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;let body;try{body=JSON.parse(raw);}catch{}
const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
if(req.url==='/'||req.url==='/index.html'){res.setHeader('Content-Type','text/html');return res.end(html);}
if(req.url==='/__linux/state')return json({pulse,report,chats,spoken,transcriptions});
if(req.url==='/__linux/pulse'){pulse++;return json({pulse});}
if(req.url==='/__linux/report'){report=body||{};return json({ok:true});}
if(req.url==='/v1/models')return json({data:[{id:'listening-chat-fixture'}]});
if(req.url==='/v1/chat/completions'){chats++;return json({id:'linux-voice-chat',object:'chat.completion',model:'listening-chat-fixture',choices:[{message:{role:'assistant',content:'I have your message.'},finish_reason:'stop'}]});}
if(req.url==='/v1/audio/speech'){spoken++;res.setHeader('Content-Type','audio/wav');return res.end(speech);}
if(req.url==='/v1/audio/transcriptions')transcriptions++;
res.writeHead(404);res.end('No fixture route');}).listen(39901,'0.0.0.0');
`,
    );
    await d('build', '-t', image, context);
    const caddy =
      '{\n admin off\n skip_install_trust\n default_sni 127.0.0.1\n}\n127.0.0.1 {\n @fixture path / /index.html /__linux/*\n handle @fixture {\n reverse_proxy app:39901\n }\n handle {\n reverse_proxy app:4173\n }\n}\n';
    let yaml = stringify({
      services: {
        app: {
          environment: {
            RELAY_PUBLIC_URL: url,
            RELAY_MODEL_BASE_URL: 'http://127.0.0.1:39901/v1',
            RELAY_MODEL_ID: 'listening-chat-fixture',
            RELAY_MODEL_PROTOCOL: 'chat',
            RELAY_SPEECH_BASE_URL: 'http://127.0.0.1:39901/v1',
            RELAY_SPEECH_MODEL: 'controlled-speech',
          },
          healthcheck: { interval: '2s', timeout: '5s', retries: 30, start_period: '5s' },
        },
        https: {
          entrypoint: [
            '/bin/sh',
            '-c',
            'printf "%s" "$RELAY_TEST_CADDYFILE" | caddy run --config /dev/stdin --adapter caddyfile',
          ],
          environment: { RELAY_TEST_CADDYFILE: caddy },
          ports: [`127.0.0.1:${httpPort}:80`, `127.0.0.1:${port}:443`],
        },
        provider: {
          image,
          network_mode: 'service:app',
          read_only: true,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
        },
      },
    });
    yaml = yaml
      .replace('    ports:', '    ports: !override')
      .replace('$RELAY_TEST_CADDYFILE', () => '$$RELAY_TEST_CADDYFILE');
    await writeFile(override, yaml);
    await compose('up', '-d', '--wait', '--wait-timeout', '180');
    const httpsId = await compose('ps', '-q', 'https'),
      caPath = join(directory, 'root.crt');
    await until(async () => {
      try {
        await d('cp', `${httpsId}:/data/caddy/pki/authorities/local/root.crt`, caPath);
        return true;
      } catch {
        return false;
      }
    }, 'Caddy root');
    agent = new Agent({ ca: await readFile(caPath) });
    await until(async () => (await call('/api/health')).status === 200, 'TLS health');
    const key = (
      await compose('run', '--rm', '--no-deps', '-T', 'setup', '--show-access-key')
    ).trim();
    assert.match(key, /^[a-f0-9]{64}$/);
    const login = await call('/api/login', { method: 'POST', body: { key } });
    assert.equal(login.status, 200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
    await json('/api/state');
    await json('/__linux/state');
    const initial = await json('/api/voice-connections/local');
    assert.equal(
      initial.supported,
      true,
      'The actual Linux image must supply a verified recognition bundle',
    );
    assert.equal(initial.installed, false);
    assert.equal(initial.bytes, 147951465);
    return {
      url,
      directory,
      project,
      key,
      caPath,
      json,
      call,
      compose,
      d,
      until,
      state: () => json('/api/state'),
      async pulse() {
        await until(
          async () =>
            (await json('/__linux/state')).report.streams?.some((s) => s.includes('live')),
          'Microphone did not start',
        );
        const before = await json('/__linux/state');
        const next = await json('/__linux/pulse', { method: 'POST', body: {} });
        await until(async () => {
          const state = await json('/__linux/state');
          return (
            state.report.pulse === next.pulse &&
            state.report.done > (before.report.done || 0) &&
            !state.report.playing
          );
        }, 'Speech not delivered');
      },
      async restart() {
        await compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'app');
        await compose('up', '-d', '--force-recreate', '--no-deps', 'provider');
        await until(async () => (await call('/api/health')).status === 200, 'Restart TLS');
      },
      async logs() {
        return await compose('logs', '--no-color', '--tail=80', 'app', 'https');
      },
      close,
    };
  } catch (error) {
    await writeFile(
      resolve(root, '../relay-evidence/linux-listening-fixture-failure.log'),
      await compose('logs', '--no-color', '--tail=80', 'app', 'https', 'provider').catch(() =>
        String(error),
      ),
    );
    await close().catch(() => {});
    throw error;
  }
}
