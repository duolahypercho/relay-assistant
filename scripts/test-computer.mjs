// SPDX-License-Identifier: MIT
// Opt-in acceptance against a real Docker engine and the independently built guest.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { executeTool, agentReply } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
const root = await mkdtemp(join(tmpdir(), 'relay-computer-acceptance-'));
const evidence = resolve(process.env.RELAY_COMPUTER_EVIDENCE || '../relay-evidence');
await mkdir(evidence, { recursive: true });
let store = new Store(join(root, 'test.sqlite'), { sample: false });
let computer = new PrivateComputer(store, { enabled: true, deployment: root });
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let counter = 0;
const run = (command, extra = {}) =>
  computer.perform({ kind: 'exec', command, operationId: `command-${++counter}`, ...extra });
try {
  await computer.start();
  assert.equal((await computer.status()).state, 'running');
  check('Real Linux desktop starts with verified isolation');
  const c = await computer.inspect();
  assert.equal(c.HostConfig.NetworkMode, 'none');
  assert.equal(c.Mounts.length, 2);
  assert.equal(Object.keys(c.HostConfig.PortBindings || {}).length, 0);
  check('No published ports, host folders, or guest network');
  const shot = await computer.screenshot();
  assert.equal(shot.width, 1280);
  assert.ok(shot.screenshot.length > 10000);
  await writeFile(
    join(evidence, 'computer-guest-desktop.jpg'),
    Buffer.from(shot.screenshot, 'base64'),
  );
  check('A real 1280×800 screenshot is returned');
  const versions = await run('id -u; python3 --version; node --version; pwd');
  assert.equal(versions.exitCode, 0);
  assert.match(versions.stdout, /1000\nPython/);
  assert.match(versions.stdout, /\/workspace/);
  check('Nonroot Python and Node commands execute in the guest');
  const p = { kind: 'exec', command: "printf 'once\\n' >> once.txt", operationId: 'idempotent' };
  await computer.perform(p);
  await computer.perform(p);
  assert.equal(
    Buffer.from((await computer.read('once.txt')).base64, 'base64').toString(),
    'once\n',
  );
  check('Repeated operation IDs do not repeat writes');
  await executeTool(
    store,
    'computer_files',
    {
      action: 'write',
      path: 'agent-note.md',
      text: '# Made by Relay\nA real file.',
      operationId: 'agent-file',
    },
    { computer, runId: 'fixture' },
  );
  const exported = await executeTool(
    store,
    'computer_export',
    { path: 'agent-note.md' },
    { computer, runId: 'fixture' },
  );
  assert.equal(exported.card.kind, 'file');
  assert.equal(store.read().files.find((f) => f.id === exported.card.id).name, 'agent-note.md');
  check('Agent creates a file and exports a real Relay file card');
  await executeTool(
    store,
    'computer_import',
    { fileId: exported.card.id, path: 'copied-note.md', operationId: 'agent-import' },
    { computer, runId: 'fixture' },
  );
  assert.equal((await computer.read('copied-note.md')).size, 28);
  check('Relay file imports into the computer');
  const agentRun = store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: 'Create and return a file with the computer.',
    }),
  );
  let round = 0;
  const fixtureCalls = [
    [
      'computer_run',
      { command: "printf 'A complete tool loop.' > tool-loop.txt", operationId: 'loop-write' },
    ],
    ['computer_status', {}],
    ['computer_look', {}],
    ['computer_export', { path: 'tool-loop.txt' }],
  ];
  let sawImage = false;
  const fixtureProvider = {
    complete: async (messages, tools) => {
      for (const message of messages.filter((m) => m.role === 'tool'))
        assert.equal(JSON.parse(message.content).error, undefined);
      assert.ok(tools.some((t) => t.name === 'computer_run'));
      sawImage ||= messages.some((m) => m.visual?.startsWith('data:image/jpeg;base64,'));
      const call = fixtureCalls[round++];
      return call
        ? {
            text: '',
            toolCalls: [
              {
                id: `step-${round}`,
                function: { name: call[0], arguments: JSON.stringify(call[1]) },
              },
            ],
          }
        : { text: 'Saved the result.', toolCalls: [] };
    },
  };
  const reply = await agentReply(
    store,
    fixtureProvider,
    agentRun,
    { computer },
    { signal: new AbortController().signal },
  );
  assert.equal(sawImage, true);
  assert.equal(reply.cards[0].kind, 'file');
  assert.equal(store.read().files.find((f) => f.id === reply.cards[0].id).name, 'tool-loop.txt');
  check('Complete agent tool loop executes, observes and returns a file (controlled model)');
  await executeTool(
    store,
    'computer_files',
    {
      action: 'write',
      path: 'click-check.py',
      operationId: 'click-fixture',
      text: `import tkinter as tk\nfrom pathlib import Path\nr=tk.Tk()\nr.overrideredirect(True)\nr.geometry('300x100+20+20')\nr.attributes('-topmost', True)\ndef done():\n    Path('/workspace/clicked.txt').write_text('clicked')\n    r.destroy()\ntk.Button(r,text='Verify pointer input',command=done).pack(fill='both',expand=True)\nr.mainloop()\n`,
    },
    { computer, runId: 'fixture' },
  );
  await run('python3 /workspace/click-check.py >/tmp/click-check.log 2>&1 &');
  await new Promise((r) => setTimeout(r, 700));
  await computer.screenshot();
  await computer.perform({
    kind: 'desktop',
    action: 'click',
    x: 150,
    y: 65,
    operationId: 'click-check',
  });
  assert.equal(
    Buffer.from((await computer.read('clicked.txt')).base64, 'base64').toString(),
    'clicked',
  );
  check('Pointer input activates a real graphical application');
  await assert.rejects(computer.read('../etc/passwd'), /inside/);
  await run('ln -s /etc/passwd unsafe-link');
  await assert.rejects(computer.read('unsafe-link'), /symbolic|Too many levels/);
  check('File transfer rejects traversal and symlinks');
  const timed = await run('sleep 5', { seconds: 1 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, 124);
  check('Timed-out processes stop and report timeout');
  const flood = await run('python3 -c "print(\'x\'*200000)"');
  assert.equal(flood.truncated, true);
  assert.ok(flood.stdout.length <= 128000);
  check('Output is bounded and truncation is explicit');
  const pending = run('sleep 20; touch should-not-exist');
  const rejection = assert.rejects(pending, /stopped/);
  // Wait for dispatch, not an arbitrary delay: verifying the two containers
  // can take longer than 500 ms on a busy engine.
  rejection.catch(() => {});
  for (let n = 0; n < 150 && !computer.active; n++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(computer.active, 'The command reached the runtime before takeover');
  await computer.takeControl();
  await rejection;
  await assert.rejects(run('touch agent-must-wait'), /owner has taken control/);
  await assert.rejects(computer.read('should-not-exist'), /No such file/);
  check('Owner takeover cancels active work and blocks agent input');
  await computer.perform(
    {
      kind: 'exec',
      command: 'mousepad /workspace/typed.txt >/tmp/editor.log 2>&1 &',
      operationId: 'editor',
    },
    { actor: 'owner' },
  );
  await new Promise((r) => setTimeout(r, 1000));
  await computer.perform(
    { kind: 'desktop', action: 'type', text: 'Typed through Relay.', operationId: 'typing' },
    { actor: 'owner' },
  );
  await computer.perform(
    { kind: 'desktop', action: 'key', key: 'ctrl+s', operationId: 'save-typing' },
    { actor: 'owner' },
  );
  await new Promise((r) => setTimeout(r, 350));
  assert.match(
    Buffer.from((await computer.read('typed.txt')).base64, 'base64').toString(),
    /Typed through Relay/,
  );
  check('Desktop typing and keyboard shortcuts edit a real document');
  await computer.stop();
  store.close();
  store = new Store(join(root, 'test.sqlite'), { sample: false });
  computer = new PrivateComputer(store, { enabled: true, deployment: root });
  assert.equal(computer.controller, 'owner');
  await computer.start('owner');
  assert.match(
    Buffer.from((await computer.read('typed.txt')).base64, 'base64').toString(),
    /Typed through Relay/,
  );
  check('Files and owner control survive stop and server restart');
  await computer.stop();
  const priorId = (await computer.inspect()).Id;
  await computer.checked(['rm', computer.name]);
  await computer.start('owner');
  assert.notEqual((await computer.inspect()).Id, priorId);
  const replacementScreen = await computer.screenshot();
  assert.match(replacementScreen.title, /Relay.*A little room to work/);
  assert.match(
    Buffer.from((await computer.read('typed.txt')).base64, 'base64').toString(),
    /Typed through Relay/,
  );
  check('Replacing the guest preserves files and opens Chromium without a stale profile dialog');
  await computer.release();
  assert.equal(computer.controller, 'agent');
  const visual = await executeTool(store, 'computer_look', {}, { computer });
  assert.match(visual.image, /^data:image\/jpeg;base64,/);
  check('Agent receives the desktop as a vision image');
  await computer.stop();
  assert.equal((await computer.status()).state, 'stopped');
  await writeFile(
    join(evidence, 'computer-acceptance.json'),
    JSON.stringify(
      { testedAt: new Date().toISOString(), runtime: 'real Docker Linux desktop', checks },
      null,
      2,
    ),
  );
  console.log(`${checks.length} real-computer checks passed.`);
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  store.close();
  await rm(root, { recursive: true, force: true });
}
