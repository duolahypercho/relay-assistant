// Real WebKit HTTPS, reviewed standalone skill files and UIKit destination picker.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { readSkillDocument } from '../shared/skill-document.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control;
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
      'Relay Skill File Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await assistantsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    respond: async () => ({ role: 'assistant', content: 'Your saved calm plan method is ready.' }),
    configure(store) {
      store.mutate((s) => {
        const skill = command(s, 'skill.create', {
          title: 'Existing plan',
          slug: 'calm-plan',
          instructions: 'Preserve me.',
        });
        command(s, 'skill.archive', { id: skill.id });
      });
    },
  });
  const before = f.store.read().messages;
  control = createServer(async (req, res) => {
    try {
      const state = f.store.read(),
        skill = state.skills.find((s) => !s.archived);
      if (req.url === '/reviewed') {
        assert.equal(state.skills.length, 1);
        assert.equal(f.requests.length, 0);
        assert.deepEqual(state.messages, before);
      } else if (req.url === '/edited') {
        assert.equal(state.skills.length, 2);
        assert.equal(skill.version, 2);
        assert.equal(skill.slug, 'calm-plan-2');
        assert.equal(skill.documentMeta.license, 'MIT');
        assert.equal(skill.documentMeta.metadata.author, 'Relay acceptance');
        assert.equal(f.requests.length, 0);
        assert.deepEqual(state.messages, before);
      } else if (req.url === '/verify') {
        assert.equal(state.runs.length, 1);
        assert.equal(state.runs[0].skill.version, 2);
        assert(JSON.stringify(f.requests).includes('marker 42'));
        assert(state.messages.some((m) => m.text === 'Your saved calm plan method is ready.'));
        async function findSaved(dir) {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await findSaved(path);
              if (found) return found;
            } else if (entry.isFile() && entry.name === 'SKILL.md') return path;
          }
        }
        const saved = await findSaved(
          join(
            homedir(),
            'Library/Developer/CoreSimulator/Devices',
            device,
            'data/Containers/Shared/AppGroup',
          ),
        );
        assert(saved, 'Native file must exist in the isolated Simulator file-provider storage');
        const document = readSkillDocument(await readFile(saved, 'utf8'));
        assert.equal(document.instructions, skill.instructions);
        assert.equal(document.documentMeta.license, 'MIT');
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
    bundle = resolve(`../../work/skill-files-native-${stamp}.xcresult`),
    log = resolve(`../../work/skill-files-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testSkillFileReviewAndRun',
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
  assert.equal(code, 0, `Inspect native skill acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'skill-files-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'real WebKit HTTPS',
          'native text import and reviewed collision-safe save',
          'inline edit with preserved license and author',
          'native system destination save with independently checked file bytes',
          'live HTTP model receives frozen saved method',
          'Main draft preserved',
        ],
        limits:
          'iOS Simulator. Physical devices, Android and native source-file picking remain unverified; downloaded bytes are tested in browser and Mac.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native reviewed skill file import, editor, save picker and run');
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
