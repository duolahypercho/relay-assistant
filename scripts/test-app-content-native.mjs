// Real WebKit HTTPS, connected app documents and owner-chosen templates.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { appContentJourneyFixture, contentAnswer } from './app-content-journey-fixture.mjs';
const documents = process.argv.includes('--documents');
const picked = process.argv.includes('--templates');
const label = picked ? 'picked-templates' : documents ? 'app-documents' : 'app-content';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control;
const inputEvents = [];
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Isolated Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await writeFile(
    join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',
  );
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-config',
    join(directory, 'ca.conf'),
    '-keyout',
    join(directory, 'ca.key'),
    '-out',
    join(directory, 'ca.pem'),
  ]);
  await exec('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.csr'),
  ]);
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    join(directory, 'server.csr'),
    '-CA',
    join(directory, 'ca.pem'),
    '-CAkey',
    join(directory, 'ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    join(directory, 'leaf.ext'),
    '-out',
    join(directory, 'server.pem'),
  ]);
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay App Content Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await appContentJourneyFixture(directory, {
    middleware:
      process.env.RELAY_NATIVE_INPUT_DIAGNOSTICS === '1'
        ? async (req, res, next) => {
            if (req.url === '/native-input-diagnostics' && req.method === 'POST') {
              let body = '';
              for await (const chunk of req) body += chunk;
              if (body.length < 12000 && inputEvents.length < 2000)
                inputEvents.push(JSON.parse(body));
              res.end('ok');
              return;
            }
            if (req.url === '/') {
              const html = await readFile(resolve('dist/index.html'), 'utf8');
              const script = `<script>for(const kind of ['pointerdown','pointerup','click','scroll'])document.addEventListener(kind,e=>{const rect=q=>{const r=document.querySelector(q)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};fetch('/native-input-diagnostics',{method:'POST',body:JSON.stringify({kind,x:e.clientX,y:e.clientY,target:e.target?.getAttribute?.('aria-label')||e.target?.tagName,classes:e.target?.className,find:rect('[aria-label="Find options for mood"]'),composer:rect('[aria-label="Message Relay"]'),messages:rect('.messages'),scroll:document.querySelector('.messages')?.scrollTop,scrollHeight:document.querySelector('.messages')?.scrollHeight,focus:document.activeElement?.tagName,height:innerHeight,viewport:visualViewport?{height:visualViewport.height,top:visualViewport.offsetTop}:null})}).catch(()=>{})},true)</script>`;
              res.setHeader('Content-Type', 'text/html');
              res.end(html.replace('</body>', script + '</body>'));
              return;
            }
            next();
          }
        : undefined,
    connected: true,
    pickedTemplate: picked,
    expectedMood: 'curious',
    completions: true,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  if (documents) {
    const connection = f.services.connectors.publicState().connections[0];
    f.services.connectors.update({
      id: connection.id,
      revision: connection.revision,
      permissions: Object.fromEntries(connection.tools.map((tool) => [tool.name, 'ask'])),
    });
  }
  const before = f.store.read().messages;
  control = createServer(async (req, res) => {
    try {
      if (picked) {
        const state = f.store.read();
        assert.equal(state.approvals.length, 0);
        assert.equal(
          state.threads.find((t) => t.id === 'main').draft,
          'Keep my native template draft',
        );
        if (req.url === '/browse') {
          assert.equal(f.remote.calls.length, 0);
          assert.equal(f.requests.length, 0);
          assert.equal(state.messages.length, 0);
          assert.equal(state.runs.length, 0);
          assert.equal(f.remote.suggestions.length, 1);
          assert.deepEqual(f.remote.suggestions[0].params, {
            ref: { type: 'ref/prompt', name: 'quiet_plan' },
            argument: { name: 'mood', value: 'cu' },
          });
        } else if (req.url === '/verify') {
          assert.equal(f.remote.calls.length, 1);
          assert.equal(f.remote.calls[0].method, 'prompts/get');
          assert.deepEqual(f.remote.calls[0].params.arguments, { mood: 'curious' });
          assert.equal(f.requests.length, 1);
          assert.equal(state.runs.length, 1);
          assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
          assert(
            state.messages.some(
              (m) => m.role === 'assistant' && m.text.includes('Here is a gentle plan'),
            ),
          );
          verified = true;
        } else throw Error('Unknown template control');
      } else if (documents) {
        assert.equal(f.requests.length, 0);
        assert.deepEqual(f.store.read().messages, before);
        assert.equal(f.store.read().runs.length, 0);
        assert.equal(f.store.read().approvals.length, 0);
        if (req.url === '/browse') assert.equal(f.remote.calls.length, 0);
        else if (req.url === '/before-document-options') {
          assert.equal(f.remote.calls.length, 1);
          assert.equal(f.remote.suggestions.length, 0);
        } else if (req.url === '/document-options') {
          assert.equal(f.remote.calls.length, 1);
          assert.equal(f.remote.suggestions.length, 1);
          assert.deepEqual(f.remote.suggestions[0].params, {
            ref: { type: 'ref/resource', uri: 'notebook://daily/{day}{?tag*}' },
            argument: { name: 'day', value: '2026-10' },
            context: { arguments: { tag: 'reading' } },
          });
        } else if (req.url === '/verify') {
          assert.equal(f.remote.calls.length, 3);
          assert(f.remote.calls.every((call) => call.method === 'resources/read'));
          assert.equal(f.remote.calls[1].params.uri, 'notebook://daily/2026-10-14?tag=reading');
          const state = f.store.read();
          const file = state.files.find((item) => item.name === 'Budget.csv');
          assert(Buffer.from(file.base64, 'base64').equals(f.remote.csv));
          const main = state.threads.find((thread) => thread.id === 'main');
          assert.equal(main.draft, 'Keep my native document draft');
          assert(
            main.draftFileIds.includes(
              state.files.find((item) => item.name === 'Weekend plan.txt').id,
            ),
          );
          verified = true;
        } else throw Error('Unknown document control');
      } else if (req.url === '/reviewed') {
        assert.equal(f.remote.suggestions.length, 0);
        assert.equal(f.remote.calls.length, 3);
        assert(f.remote.calls.every((c) => c.method === 'resources/read'));
        assert.equal(f.store.read().approvals.filter((a) => a.status === 'pending').length, 1);
        const csv = f.store.read().files.find((x) => x.name === 'Budget.csv');
        assert(csv && Buffer.from(csv.base64, 'base64').equals(f.remote.csv));
      } else if (req.url === '/before-options') {
        assert.equal(f.remote.suggestions.length, 0);
        assert.equal(f.remote.calls.length, 3);
      } else if (req.url === '/options') {
        assert.equal(f.remote.suggestions.length, 1);
        assert.deepEqual(f.remote.suggestions[0].params, {
          ref: { type: 'ref/prompt', name: 'quiet_plan' },
          argument: { name: 'mood', value: 'cu' },
        });
        assert.equal(f.remote.calls.length, 3);
        assert(
          f.store
            .read()
            .approvals.some((a) => a.status === 'pending' && a.payload.arguments.mood === 'quiet'),
        );
      } else if (req.url === '/verify') {
        assert.equal(f.remote.suggestions.length, 1);
        assert.equal(f.remote.calls.length, 4);
        assert.deepEqual(f.remote.calls.at(-1).params, {
          name: 'quiet_plan',
          arguments: { mood: 'curious' },
        });
        assert.equal(f.remote.calls.at(-1).method, 'prompts/get');
        assert.equal(f.errors.length, 0);
        assert(f.store.read().messages.some((m) => m.text === contentAnswer));
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep this next thought.',
        );
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Acceptance check failed.');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/${label}-native-${stamp}.xcresult`),
    log = resolve(`../../work/${label}-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      `-only-testing:RelayShareUITests/ConnectionUITests/${picked ? 'testPickedAppTemplate' : documents ? 'testAppDocumentBrowser' : 'testConnectedAppContent'}`,
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
      `RELAY_CONNECTION_TEST_SERVER=${f.url}`,
      `RELAY_CONNECTION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = createWriteStream(log);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  output.end();
  if (inputEvents.length)
    await writeFile(
      join(evidence, 'native-input-diagnostics.json'),
      JSON.stringify(inputEvents, null, 2) + '\n',
    );
  if (code !== 0)
    await writeFile(
      join(evidence, `${label}-native-ios-failure.json`),
      JSON.stringify(
        {
          passed: false,
          checkedAt: new Date().toISOString(),
          device,
          resultBundle: bundle,
          log,
          suggestions: f.remote.suggestions.map((item) => item.params),
          calls: f.remote.calls.map((item) => item.method),
        },
        null,
        2,
      ) + '\n',
    );
  assert.equal(code, 0, `Inspect native app content acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, `${label}-native-ios-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: picked
          ? [
              'native iPhone WebKit HTTPS with a chosen app template',
              'native field editing, inline options and retained values after full relaunch',
              'one exact prompt retrieval and one assistant request/reply',
              'unfinished Main draft retained after use and another relaunch',
              'no pending approval from the explicitly chosen template',
            ]
          : documents
            ? [
                'native iPhone WebKit HTTPS with Ask-policy content-only app',
                'document browsing does not call a model or retrieve content',
                'native keyboard fields and inline resource choices send exact URI/context only after Find options',
                'direct text and binary preview plus parameterized read from native keyboard',
                'Ask about this preserves Main chat draft and file attachment through full relaunch',
                'no chat messages, assistant runs or approvals from page navigation and reads',
              ]
            : [
                'native WebKit HTTPS with an independently preconnected content-only app',
                'actual HTTP model -> resources/read and parameterized resource read',
                'exact binary resource bytes saved to Files',
                'prompt template waits for explicit inline choice',
                'explicit native option lookup sends only current fields, selection fills the field without retrieving or approving the template',
                'native template editing, navigation and full relaunch retain both the chat draft and edited template fields',
                'prompts/get once after approval and frozen model continuation',
              ],
        limits:
          'iOS Simulator with original MCP fixtures; document-browser mode makes no model calls. Physical devices, Android, native source-file picking and live vendor accounts remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: native ${picked ? 'chosen template picker' : documents ? 'document browser' : 'app documents and prompt-template choice'}`,
  );
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
