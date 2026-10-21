// SPDX-License-Identifier: MIT
// Real worker SIGKILL + forced stop of an explicitly dedicated, otherwise empty VM.
// Controlled model decisions; this checks durability, not general model reasoning.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';

const profile = 'relay-live-acceptance';
const dockerHost = process.env.RELAY_TEST_DOCKER_HOST;
assert.equal(
  dockerHost,
  `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`,
  'Choose the dedicated relay-live-acceptance engine explicitly.',
);
const image = process.env.RELAY_TEST_COMPUTER_IMAGE;
assert(image?.startsWith('relay-desktop:'), 'Choose an installed Relay test image.');
const makeComputer = (store, directory) =>
  new PrivateComputer(store, {
    enabled: true,
    deployment: directory,
    dockerHost,
    image,
  });
const call = (name, args, id) => ({
  id,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});
const bytes = 'Recovery checklist\nNotebook\nCable\nKeys\n';
const knownCommand = `python3 - <<'PY'
import os
with open('/workspace/ledger.txt', 'a') as f:
    f.write('completed once\\n'); f.flush(); os.fsync(f.fileno())
with open('/workspace/Recovery.txt', 'w') as f:
    f.write(${JSON.stringify(bytes)}); f.flush(); os.fsync(f.fileno())
print('Saved Recovery.txt')
PY`;
const unknownCommand = `python3 - <<'PY'
import os, time
with open('/workspace/uncertain.txt', 'a') as f:
    f.write('started once\\n'); f.flush(); os.fsync(f.fileno())
time.sleep(60)
open('/workspace/must-not-complete.txt', 'w').write('late')
PY`;

if (process.argv.includes('--child')) {
  const directory = process.argv.at(-2),
    mode = process.argv.at(-1);
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const computer = makeComputer(store, directory);
  const original = computer.perform.bind(computer);
  computer.perform = async (...args) => {
    const result = await original(...args);
    if (mode === 'known') {
      process.send({ phase: 'receipt-committed' });
      await new Promise(() => {});
    }
    return result;
  };
  let calls = 0;
  const provider = {
    configured: true,
    complete: async () => {
      assert.equal(++calls, 1, 'Child must stop at its first action');
      return {
        text: '',
        toolCalls: [
          call(
            'computer_run',
            { command: mode === 'known' ? knownCommand : unknownCommand, seconds: 60 },
            'write',
          ),
          call(
            'computer_run',
            { command: 'echo duplicate >> /workspace/ledger.txt' },
            'stale-plan',
          ),
        ],
      };
    },
  };
  const worker = new BackgroundWorker(store, { mode: 'live', provider, computer, google: {} });
  await worker.reply(store.read().runs.at(-1).id, new AbortController().signal);
  throw Error('The fixture child was supposed to be killed at its action boundary.');
}

const execute = promisify(execFile);
const colima = async (...args) =>
  (
    await execute('/opt/homebrew/bin/colima', args, {
      timeout: 180000,
      maxBuffer: 2_000_000,
    })
  ).stdout;
const profiles = async () => (await colima('list', '--json')).trim().split('\n').map(JSON.parse);
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-interruption',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-interruption-'));
let store = new Store(join(directory, 'state.sqlite'), { sample: false });
let computer = makeComputer(store, directory),
  worker,
  child;
let childExit,
  cleanedUp = false;
const checks = [],
  logs = [];
const initialProfiles = await profiles();
assert.equal(initialProfiles.find((p) => p.name === profile)?.status, 'Running');
const originalContext = (
  await execute('/opt/homebrew/bin/docker', ['context', 'show'])
).stdout.trim();
const check = (name, detail = {}) => {
  checks.push({ name, passed: true, ...detail });
  console.log('PASS', name);
};
const allContainers = async () =>
  (await computer.checked(['ps', '-aq'])).trim().split('\n').filter(Boolean);
async function verifyDedicated() {
  for (const id of await allContainers()) {
    const c = JSON.parse(await computer.checked(['inspect', id]))[0];
    assert.equal(
      c.Config.Labels?.['org.relay.owner'],
      computer.owner,
      'Do not interrupt another deployment',
    );
    assert([`/${computer.name}`, `/${computer.runtime.name}`].includes(c.Name));
  }
}
async function until(fn, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw Error('Test child exited early');
    if (await fn()) return;
    await delay(150);
  }
  throw Error(message);
}
async function killChild() {
  assert(child && child.exitCode === null);
  child.kill('SIGKILL');
  const [code, signal] = await childExit;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  child = null;
}
async function restartVM() {
  await verifyDedicated();
  const before = JSON.parse(await computer.checked(['inspect', computer.name]))[0];
  await colima('stop', '--force', '--profile', profile);
  assert.equal((await profiles()).find((p) => p.name === profile).status, 'Stopped');
  await assert.rejects(computer.checked(['info']));
  await colima('start', '--profile', profile, '--activate=false');
  await computer.start();
  const after = JSON.parse(await computer.checked(['inspect', computer.name]))[0];
  assert.notEqual(after.State.StartedAt, before.State.StartedAt);
  assert.equal(after.Mounts.find((m) => m.Destination === '/workspace').Name, computer.volume);
  return { previousBoot: before.State.StartedAt, recoveredBoot: after.State.StartedAt };
}
async function savedText(path) {
  return Buffer.from((await computer.read(path)).base64, 'base64').toString();
}
try {
  assert.deepEqual(await allContainers(), [], 'The dedicated test VM must be empty initially.');
  const mounts = await colima('ssh', '--profile', profile, '--', 'cat', '/proc/mounts');
  assert(
    !/\s(?:9p|virtiofs)\s|\/Users\//.test(mounts),
    'Test VM must not mount owner host folders',
  );
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  await computer.start();
  for (const mode of ['known', 'unknown']) {
    const run = store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: 'main',
        text:
          mode === 'known'
            ? 'On your computer, save the recovery checklist and attach Recovery.txt here.'
            : 'Perform the next local operation and report its result.',
      }),
    );
    store.close();
    store = null;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', directory, mode], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    childExit = once(child, 'exit');
    child.stdout.on('data', (v) => logs.push(String(v)));
    child.stderr.on('data', (v) => logs.push(String(v)));
    let receiptCommitted = false;
    child.on('message', (m) => {
      receiptCommitted ||= m.phase === 'receipt-committed';
    });
    if (mode === 'known') await until(() => receiptCommitted, 'No completed action receipt');
    else
      await until(async () => {
        // The service DB is closed in this process; observe the guest independently.
        const r = await computer
          .rpc({ kind: 'files', action: 'read', path: 'uncertain.txt' })
          .catch(() => null);
        return r && Buffer.from(r.base64, 'base64').toString() === 'started once\n';
      }, 'The uncertain action did not reach its fsynced first effect');
    await killChild();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const checkpoint = store.db
      .prepare('SELECT phase FROM agent_checkpoints WHERE run_id=?')
      .get(run.id);
    assert.equal(checkpoint.phase, 'acting');
    assert.equal(store.read().runs.find((r) => r.id === run.id).status, 'running');
    computer = makeComputer(store, directory);
    const boots = await restartVM();
    const receiptCount = store.db.prepare('SELECT COUNT(*) AS n FROM computer_operations').get().n;
    let modelCalls = 0;
    const provider = {
      configured: true,
      complete: async (messages) => {
        assert.equal(mode, 'known', 'Uncertain work must stop before asking a model to repeat it');
        modelCalls++;
        const receipt = JSON.parse(messages.find((m) => m.tool_call_id === 'write').content);
        assert.equal(receipt.recoveredReceipt, true);
        assert.equal(receipt.result.repeated, true);
        assert.match(receipt.result.stdout, /Saved Recovery.txt/);
        assert.match(messages.find((m) => m.tool_call_id === 'stale-plan').content, /Not executed/);
        if (modelCalls === 1)
          return {
            text: '',
            toolCalls: [
              call(
                'computer_files',
                {
                  action: 'read',
                  path: 'Recovery.txt',
                },
                'verify-saved',
              ),
            ],
          };
        if (modelCalls === 2)
          return {
            text: '',
            toolCalls: [
              call(
                'computer_export',
                {
                  path: 'Recovery.txt',
                },
                'return-file',
              ),
            ],
          };
        return { text: 'Your recovered checklist is attached.', toolCalls: [] };
      },
    };
    const services = { mode: 'live', provider, computer, google: {} };
    recoverWork(store);
    worker = new BackgroundWorker(store, services);
    await worker.reply(run.id, new AbortController().signal);
    await worker.stop();
    worker = null;
    const state = store.read(),
      finished = state.runs.find((r) => r.id === run.id);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM computer_operations').get().n,
      receiptCount,
    );
    assert.equal(await savedText('ledger.txt'), 'completed once\n');
    assert.equal(await savedText('Recovery.txt'), bytes);
    if (mode === 'known') {
      assert.equal(finished.status, 'completed', finished.error);
      assert.equal(modelCalls, 3);
      assert.equal(state.files.length, 1);
      const file = state.files[0];
      const actual = file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.text);
      assert.equal(actual.toString(), bytes);
      assert(state.messages.at(-1).cards.some((c) => c.kind === 'file' && c.id === file.id));
      await writeFile(join(evidence, 'Recovery.txt'), actual);
      check(
        'Confirmed work survives worker kill and VM stop; original chat receives the file once',
        {
          ...boots,
          modelCalls,
          sha256: createHash('sha256').update(actual).digest('hex'),
          operationReceipts: receiptCount,
          fileId: file.id,
        },
      );
    } else {
      assert.equal(finished.status, 'failed');
      assert.match(finished.error, /interrupted/);
      assert.equal(modelCalls, 0);
      assert.equal(state.files.length, 1, 'No substitute result or duplicate attachment');
      assert.equal(await savedText('uncertain.txt'), 'started once\n');
      await assert.rejects(computer.read('must-not-complete.txt'), /No such file/);
      check('Partly executed work stays uncertain after VM restart and is never repeated', {
        ...boots,
        error: finished.error,
        modelCalls,
        operationReceipts: receiptCount,
      });
    }
    await writeFile(join(evidence, `${mode}-state.json`), JSON.stringify(state, null, 2));
  }
} finally {
  if (child) await killChild();
  await worker?.stop();
  if (!store) store = new Store(join(directory, 'state.sqlite'), { sample: false });
  computer = makeComputer(store, directory);
  if ((await profiles()).find((p) => p.name === profile)?.status === 'Stopped')
    await colima('start', '--profile', profile, '--activate=false');
  await verifyDedicated();
  await computer.stop();
  for (const id of await allContainers()) await computer.checked(['rm', '-f', id]);
  const volumes = (
    await computer.checked([
      'volume',
      'ls',
      '--filter',
      `label=org.relay.owner=${computer.owner}`,
      '--format',
      '{{.Name}}',
    ])
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const name of volumes) {
    await computer.verifyVolume(name);
    await computer.checked(['volume', 'rm', name]);
  }
  assert.deepEqual(await allContainers(), []);
  store.close();
  await rm(directory, { recursive: true, force: true });
  assert.equal(
    (await execute('/opt/homebrew/bin/docker', ['context', 'show'])).stdout.trim(),
    originalContext,
  );
  const finalProfiles = await profiles();
  assert.deepEqual(finalProfiles, initialProfiles);
  cleanedUp = true;
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'server/agent.mjs',
        'server/agent-checkpoint.mjs',
        'server/computer.mjs',
        'server/computer-receipts.mjs',
        'server/worker.mjs',
        'scripts/test-computer-interruption.mjs',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  await writeFile(join(evidence, 'child.log'), logs.join(''));
  await writeFile(
    join(evidence, 'acceptance.json'),
    JSON.stringify(
      {
        passed: checks.length === 2,
        checks,
        cleanedUp,
        sourceHashes,
        initialProfiles,
        finalProfiles,
        scope:
          'Actual ARM64 VM forced stop and real worker SIGKILL, with controlled model decisions. Not physical host power-loss or general model reasoning.',
      },
      null,
      2,
    ),
  );
}
