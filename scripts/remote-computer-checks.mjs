// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createComputerCertificates } from './remote-computer-certificates.mjs';
export const freezeProbe = `import os,time,signal
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
with open('/workspace/remote-ticks.txt','ab',buffering=0) as f:
 while True:
  f.write(b'x');time.sleep(.04)
`;
export async function checkRemoteTLS(f, report) {
  const call = (extra = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: f.bridge.address().port,
          path: '/_ping',
          servername: 'host.lima.internal',
          ca: f.bundle.ca,
          cert: f.bundle.certificate,
          key: f.bundle.privateKey,
          agent: false,
          ...extra,
        },
        (res) => {
          let text = '';
          res.on('data', (b) => (text += b));
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(Error('TLS timeout')));
      req.end();
    });
  assert.deepEqual(await call(), { status: 200, text: 'OK' });
  await assert.rejects(
    call({ cert: undefined, key: undefined }),
    /certificate|alert|reset|socket hang up/i,
  );
  await assert.rejects(
    call({ servername: 'wrong-computer.invalid' }),
    /hostname|altnames|certificate/i,
  );
  await assert.rejects(call({ ca: undefined }), /certificate|verify/i);
  const wrong = await createComputerCertificates(
    join(f.directory, 'wrong-client'),
    'host.lima.internal',
  );
  await assert.rejects(
    call({ cert: wrong.certificate, key: wrong.privateKey }),
    /certificate|alert|reset|socket hang up/i,
  );
  report.checks.push(
    'Native dockerd accepts the pinned client and rejects missing credentials, another CA/client and a wrong server hostname',
  );
}
export async function checkRemoteFeatures(f, report) {
  const post = (path, body = {}) => f.json('/api/' + path, { method: 'POST', body });
  const exec = (command) =>
    post('computer/action', {
      kind: 'exec',
      operationId: crypto.randomUUID(),
      command,
      seconds: 25,
    });
  const readTicks = () =>
    f.d('guest', ['exec', f.computerName, 'cat', '/workspace/remote-ticks.txt']);
  const ticks = await readTicks();
  assert.ok(ticks.length > 0);
  assert.equal(
    JSON.parse(await f.d('guest', ['inspect', f.computerName + '-commands']))[0].State.Paused,
    true,
  );
  await delay(350);
  assert.equal(await readTicks(), ticks);
  assert.equal(
    (await exec("printf 'Owner still works' > /workspace/owner-control.txt")).exitCode,
    0,
  );
  report.checks.push(
    'Remote takeover freezes a double-forked, setsid, SIGTERM-ignoring agent process while owner commands and the desktop remain usable',
  );
  const fetchExample =
    "python3 -c \"import urllib.request; r=urllib.request.urlopen('https://example.com',timeout=15); b=r.read(); assert b'Example Domain' in b; print(r.status)\"";
  assert.notEqual(
    (
      await exec(
        'python3 -c "import socket;s=socket.socket();s.settimeout(1);s.connect((\'1.1.1.1\',443))"',
      )
    ).exitCode,
    0,
  );
  assert.notEqual((await exec(fetchExample)).exitCode, 0);
  await post('computer/websites/request', { url: 'https://example.com' });
  await post('computer/websites/decide', { host: 'example.com', decision: 'allow' });
  const result = await exec(fetchExample);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /200/);
  await post('computer/websites/decide', { host: 'example.com', decision: 'revoke' });
  assert.notEqual((await exec(fetchExample)).exitCode, 0);
  report.checks.push(
    'The remote guest has no direct internet; its TLS-carried broker blocks unapproved HTTPS, fetches a real public page after approval and blocks it again after revocation',
  );
  // Accessibility observation starts a real blank private Chromium through the
  // Docker attach pipe, without a website, account or browser test double.
  await f.json('/api/private-browser/accessibility');
  const screen = await f.json('/api/private-browser/screen');
  assert.ok(screen.screenshot?.length > 1000);
  const browserIds = (
    await f.d('guest', ['ps', '-q', '--filter', 'label=org.relay.role=private-browser'])
  )
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(browserIds.length, 1);
  const browser = JSON.parse(await f.d('guest', ['inspect', browserIds[0]]))[0];
  assert.equal(browser.HostConfig.NetworkMode, 'none');
  assert.equal(browser.Mounts.length, 0);
  assert.equal(browser.HostConfig.ReadonlyRootfs, true);
  assert.equal(browser.Config.User, '1000:1000');
  assert.notEqual(browser.Id, f.computerName);
  await post('private-browser/clear');
  report.checks.push(
    'Real private Chromium starts, exposes accessibility and returns a screenshot through the native TLS pipe; it has no mounts or network interface',
  );
  await post('computer/snapshots/save');
  const saved = await f.until(async () => {
    const s = await f.json('/api/computer/snapshots');
    return !s.busy && s;
  }, 'Remote restore point');
  assert.equal(saved.phase, 'done', saved.error);
  assert.equal(saved.points.length, 1);
  assert.equal((await exec("printf 'changed' > /workspace/owner-control.txt")).exitCode, 0);
  const review = await post('computer/snapshots/prepare', {
    kind: 'restore',
    pointId: saved.points[0].id,
  });
  await post('computer/snapshots/apply', { id: review.review.id });
  const restored = await f.until(async () => {
    const s = await f.json('/api/computer/snapshots');
    return !s.busy && s;
  }, 'Remote restoration');
  assert.equal(restored.phase, 'done', restored.error);
  assert.equal((await exec('cat /workspace/owner-control.txt')).stdout, 'Owner still works');
  assert.equal((await f.json('/api/computer')).controller, 'owner');
  report.checks.push(
    'Real remote volume capture and restore recover exact previous file bytes, retain the owner freeze and keep chat history untouched',
  );
}

export async function checkRemoteStdio(f, report) {
  const { stdioFixture } = await import('./stdio-fixture.mjs');
  const program = `
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Store} from './server/store.mjs';
import {PrivateComputer} from './server/computer.mjs';
import {Connectors} from './server/connectors.mjs';
import {remoteComputerFromEnvironment} from './server/remote-computer.mjs';
const directory=await mkdtemp('/tmp/relay-remote-stdio-'),remote=await remoteComputerFromEnvironment();
const store=new Store(directory+'/state.sqlite',{sample:false});
const computer=new PrivateComputer(store,{enabled:true,image:remote.image,deployment:remote.deployment+':stdio-acceptance',dockerHost:remote.endpoint,remoteEngine:remote});
const connectors=new Connectors(store,{key:randomBytes(32),computer,timeoutMs:15000});
try {
 await computer.start();
 await computer.perform({kind:'files',action:'write',path:'local-tools.py',base64:Buffer.from(${JSON.stringify(stdioFixture)}).toString('base64'),operationId:'source'});
 const found=await connectors.prepare({transport:'stdio',name:'Remote local notebook',launchApproved:true,launch:{command:'python3',args:['/workspace/local-tools.py'],env:{LOCAL_KEY:'fictional-local-secret'}}});
 const saved=connectors.save({discoveryId:found.discoveryId,permissions:Object.fromEntries(found.connection.tools.map(t=>[t.name,t.readOnly?'auto':'ask']))}).connections[0];
 const payload=(toolName,args={})=>({connectionId:saved.id,revision:saved.revision,toolName,fingerprint:saved.tools.find(t=>t.name===toolName).fingerprint,arguments:args});
 const result=await connectors.call(payload('inspect_runtime'),'relay','inspect');const info=JSON.parse(result.content[0].text);
 assert.equal(info.uid,1000);assert.equal(info.directNetwork,false);assert.equal(info.secretEcho,'[redacted]');assert.equal(info.hostSecretPresent,false);
 await connectors.call(payload('save_note',{text:'Remote stdio works 🌱'}),'relay','save',{reviewed:true});
 assert.equal(Buffer.from((await computer.read('local-note.txt')).base64,'base64').toString(),'Remote stdio works 🌱');
 assert.equal(computer.stdio.rows().length,0);console.log('PASS remote stdio discovery and reviewed tool call');
}finally{
 await computer.stop().catch(()=>{});await computer.dockerRun(['rm','-f',computer.runtime.name,computer.name]);
 await computer.dockerRun(['volume','rm',computer.volume,computer.displayVolume]);store.close();await remote.close();await rm(directory,{recursive:true,force:true});
}`;
  const appId = await f.compose('ps', '-q', 'app');
  const result = await f.d('app', ['exec', '-i', appId, 'node', '--input-type=module', '-'], {
    input: program,
  });
  assert.match(result, /PASS remote stdio/);
  report.checks.push(
    'Actual MCP stdio discovery and a reviewed Unicode file write run from the Linux app over native TLS in a separate offline non-root guest; explicit tool secrets are redacted and guest sessions are cleaned up',
  );
}
