// SPDX-License-Identifier: MIT
// Two disposable engines: app containers and computer containers never share
// a daemon. A raw TCP forward preserves native dockerd mutual TLS end to end.
import assert from 'node:assert/strict';
import { request, Agent } from 'node:https';
import { createServer as netServer, connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedProcess } from '../server/terminal.mjs';
import { readRemoteComputer } from '../server/remote-computer.mjs';
const root = resolve(import.meta.dirname, '..');
export async function remoteComputerFixture() {
  const appHost = process.env.DOCKER_HOST,
    guestHost = process.env.RELAY_TEST_GUEST_DOCKER_HOST;
  assert.ok(
    appHost?.startsWith('unix:///') && guestHost?.startsWith('unix:///') && appHost !== guestHost,
    'Use two distinct disposable test engines.',
  );
  const docker = process.env.RELAY_TEST_DOCKER || 'docker';
  const directory = await mkdtemp(join(tmpdir(), 'relay-remote-acceptance-'));
  const project = 'relay-remote-' + randomUUID().slice(0, 8),
    secretVolume = project + '-connection';
  const override = join(directory, 'override.yaml'),
    providerImage = project + '-provider';
  const d = async (role, args, options = {}) => {
    const result = await boundedProcess(docker, args, {
      timeout: 180000,
      maxOutput: 8 * 1024 * 1024,
      ...options,
      env: {
        DOCKER_HOST: role === 'guest' ? guestHost : appHost,
        DOCKER_CONTEXT: '',
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        RELAY_DOMAIN: '127.0.0.1',
      },
    });
    assert.equal(result.exitCode, 0, result.stderr.slice(-2500));
    return result.stdout.trim();
  };
  const compose = (...args) =>
    d('app', [
      'compose',
      '-p',
      project,
      '-f',
      join(root, 'deploy/compose.yaml'),
      '-f',
      override,
      ...args,
    ]);
  const until = async (check, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    let last;
    do {
      try {
        const result = await check();
        if (result) return result;
      } catch (error) {
        last = error;
      }
      await delay(200);
    } while (Date.now() < end);
    throw Error(label + ': ' + (last?.message || 'timed out'));
  };
  const port = async () => {
    const s = netServer();
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const value = s.address().port;
    await new Promise((r) => s.close(r));
    return value;
  };
  let bridge,
    agent,
    cookie = '',
    bundle,
    computerName;
  const connections = new Set();
  async function close() {
    agent?.destroy();
    await compose('down', '--volumes', '--remove-orphans').catch(() => {});
    await d('app', ['volume', 'rm', secretVolume]).catch(() => {});
    await d('app', ['image', 'rm', providerImage]).catch(() => {});
    for (const s of connections) s.destroy();
    if (bridge) await new Promise((r) => bridge.close(r));
    if (computerName) {
      const owner = computerName.replace('relay-desktop-', '');
      const ids = (await d('guest', ['ps', '-aq', '--filter', 'label=org.relay.owner=' + owner]))
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) await d('guest', ['rm', '-f', ...ids]);
      const volumes = (
        await d('guest', ['volume', 'ls', '-q', '--filter', 'label=org.relay.owner=' + owner])
      )
        .split(/\s+/)
        .filter(Boolean);
      if (volumes.length) await d('guest', ['volume', 'rm', ...volumes]);
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const nativeDirectory = process.env.RELAY_TEST_NATIVE_COMPUTER_DIR;
    const nativePort = Number(process.env.RELAY_TEST_NATIVE_COMPUTER_PORT);
    assert.ok(
      nativeDirectory && Number.isInteger(nativePort) && nativePort > 0 && nativePort <= 65535,
      'Prepare native mutual TLS on the disposable computer VM first.',
    );
    const native = readRemoteComputer(join(nativeDirectory, 'connection.json'));
    const keys = { ca: native.ca, certificate: native.certificate, privateKey: native.privateKey };
    // Colima forwards the guest's TLS listener to loopback. This raw tunnel
    // makes that same listener reachable to the separate application VM.
    // TLS terminates only in dockerd, never in this test process.
    bridge = netServer({ allowHalfOpen: true }, (socket) => {
      const peer = connect({ host: '127.0.0.1', port: nativePort, allowHalfOpen: true });
      for (const connection of [socket, peer]) {
        connections.add(connection);
        connection.on('close', () => connections.delete(connection));
      }
      socket.pipe(peer);
      peer.pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
      socket.on('close', () => peer.destroy());
      peer.on('close', () => socket.destroy());
    });
    bridge.listen(0, '0.0.0.0');
    await once(bridge, 'listening');
    const image = await d('guest', [
      'image',
      'inspect',
      'relay-desktop:remote-acceptance',
      '--format',
      '{{.Id}}',
    ]);
    assert.equal(image, native.image);
    bundle = {
      kind: 'relay-computer',
      version: 1,
      workspaceId: randomBytes(16).toString('hex'),
      endpoint: `tcp://host.lima.internal:${bridge.address().port}`,
      image,
      ...keys,
    };
    const { createHash } = await import('node:crypto');
    computerName =
      'relay-desktop-' +
      createHash('sha256')
        .update('remote:' + bundle.workspaceId)
        .digest('hex')
        .slice(0, 16);
    await d('app', ['volume', 'create', secretVolume]);
    await d(
      'app',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--user',
        '0',
        '--mount',
        `type=volume,source=${secretVolume},target=/remote`,
        '--entrypoint',
        'node',
        'relay-server:local',
        '-e',
        "const fs=require('node:fs');fs.writeFileSync('/remote/connection.json',fs.readFileSync(0),{mode:0o600});fs.chownSync('/remote/connection.json',1000,1000);",
      ],
      { input: JSON.stringify(bundle) },
    );
    const fixtureDir = join(directory, 'provider');
    await mkdir(fixtureDir);
    await writeFile(
      join(fixtureDir, 'Dockerfile'),
      'FROM relay-server:local\nCOPY provider.mjs /provider.mjs\nENTRYPOINT ["node", "/provider.mjs"]\n',
    );
    await writeFile(
      join(fixtureDir, 'provider.mjs'),
      `import {createServer} from 'node:http';
let calls=0, images=0;
const tool=(name,p)=>({id:'remote-'+name+'-'+calls,type:'function',function:{name,arguments:JSON.stringify(p)}});
createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};res.setHeader('Content-Type','application/json');
if(req.url==='/state')return res.end(JSON.stringify({calls,images}));
if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'remote-computer-fixture'}]}));
calls++;const results=body.messages.filter(m=>m.role==='tool');images+=body.messages.filter(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')).length;
let message;if(!results.length)message={role:'assistant',content:null,tool_calls:[tool('computer_look',{})]};
else if(!results.some(m=>m.content.includes('remote-result')))message={role:'assistant',content:null,tool_calls:[tool('computer_run',{operationId:'remote-write-once',command:"if [ -f /workspace/freeze-probe.py ]; then python3 /workspace/freeze-probe.py >/tmp/probe.log 2>&1; fi; printf 'Made on the separate computer.\\\\n' > /workspace/remote-result.txt; printf remote-result",seconds:10})]};
else if(!results.some(m=>m.content.includes('saved')))message={role:'assistant',content:null,tool_calls:[tool('computer_export',{path:'remote-result.txt'})]};
else message={role:'assistant',content:'I made the file on my separate computer.'};
res.end(JSON.stringify({id:'remote-'+calls,choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));}).listen(39901,'0.0.0.0');`,
    );
    await d('app', ['build', '-t', providerImage, fixtureDir]);
    const tlsPort = await port(),
      httpPort = await port(),
      url = `https://127.0.0.1:${tlsPort}`;
    const caddy = `{\n admin off\n default_sni 127.0.0.1\n}\nhttps://127.0.0.1 {\n tls internal\n reverse_proxy app:4173\n}\n`;
    await writeFile(
      override,
      stringify({
        services: {
          app: {
            environment: {
              RELAY_PUBLIC_URL: url,
              RELAY_DESKTOP_ENABLED: 'true',
              RELAY_REMOTE_COMPUTER_FILE: '/run/relay-computer/connection.json',
              RELAY_TRUSTED_BROWSER_ENABLED: 'true',
              RELAY_MODEL_BASE_URL: 'http://127.0.0.1:39901/v1',
              RELAY_MODEL_ID: 'remote-computer-fixture',
              RELAY_MODEL_PROTOCOL: 'chat',
            },
            volumes: ['remote-connection:/run/relay-computer:ro'],
          },
          provider: {
            image: providerImage,
            network_mode: 'service:app',
            healthcheck: { disable: true },
          },
          https: {
            ports: [`127.0.0.1:${httpPort}:80`, `127.0.0.1:${tlsPort}:443`],
            environment: { RELAY_TEST_CADDYFILE: caddy },
            entrypoint: [
              'sh',
              '-c',
              'printf "%s" "$$RELAY_TEST_CADDYFILE" | caddy run --config /dev/stdin --adapter caddyfile',
            ],
          },
        },
        volumes: { 'remote-connection': { external: true, name: secretVolume } },
      }).replace('ports:', 'ports: !override'),
    );
    await compose('up', '-d', '--wait', 'app', 'https', 'provider');
    const appId = await compose('ps', '-q', 'app');
    await d('app', [
      'exec',
      appId,
      'node',
      '--input-type=module',
      '-e',
      "import {remoteComputerFromEnvironment} from './server/remote-computer.mjs'; import {boundedProcess} from './server/terminal.mjs'; const r=await remoteComputerFromEnvironment(); try {const p=await boundedProcess('docker',['--host',r.endpoint,'info','--format','{{.Name}}'],{timeout:15000,env:{...r.environment,DOCKER_CONTEXT:'',DOCKER_HOST:''}}); if(p.exitCode||p.timedOut)throw Error(JSON.stringify(p)); console.log('Connected to dedicated test engine: '+p.stdout.trim());}finally{await r.close();}",
    ]);
    const caPath = join(directory, 'https-root.crt');
    const httpsId = await compose('ps', '-q', 'https');
    await until(async () => {
      await d('app', ['cp', `${httpsId}:/data/caddy/pki/authorities/local/root.crt`, caPath]);
      return true;
    }, 'Caddy certificate');
    agent = new Agent({ ca: await readFile(caPath) });
    const call = (path, { method = 'GET', body, auth = true } = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          url + path,
          {
            agent,
            method,
            headers: {
              Origin: url,
              ...(auth && cookie ? { Cookie: cookie } : {}),
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (b) => chunks.push(b));
            res.on('end', () => {
              const bytes = Buffer.concat(chunks),
                text = bytes.toString();
              let json;
              try {
                json = JSON.parse(text);
              } catch {}
              resolve({ status: res.statusCode, headers: res.headers, bytes, text, json });
            });
          },
        );
        req.on('error', reject);
        req.setTimeout(120000, () => req.destroy(Error('Request timed out')));
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const json = async (path, options) => {
      const response = await call(path, options);
      assert.equal(response.status, 200, response.text.slice(0, 500));
      return response.json;
    };
    const key = (
      await compose('run', '--rm', '--no-deps', '-T', 'setup', '--show-access-key')
    ).trim();
    const login = await call('/api/login', { method: 'POST', body: { key } });
    assert.equal(login.status, 200, login.text);
    cookie = login.headers['set-cookie'][0].split(';')[0];
    await json('/api/state');
    return {
      url,
      key,
      call,
      json,
      caPath,
      directory,
      computerName,
      bundle,
      bridge,
      d,
      compose,
      until,
      async restart() {
        await compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'app');
        await compose('up', '-d', '--force-recreate', '--no-deps', 'provider');
        await until(async () => (await call('/api/health')).status === 200, 'App replacement');
      },
      close,
    };
  } catch (error) {
    await writeFile(
      resolve(root, '../relay-evidence/remote-computer-fixture-failure.log'),
      await compose('logs', '--no-color', '--tail=60', 'app', 'https', 'provider').catch(() =>
        String(error),
      ),
    );
    await close();
    throw error;
  }
}
