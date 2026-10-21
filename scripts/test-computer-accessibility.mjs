// SPDX-License-Identifier: MIT
// Actual isolated desktop controls; no host accessibility or owner workspace access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { executeTool } from '../server/agent.mjs';
const image = process.env.RELAY_TEST_COMPUTER_IMAGE;
const dockerHost = process.env.RELAY_COMPUTER_TEST_DOCKER_HOST;
assert(
  image && dockerHost?.includes('relay-live-acceptance'),
  'Choose a built image in the dedicated acceptance engine.',
);
const directory = await mkdtemp(join(tmpdir(), 'relay-accessible-controls-'));
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-accessibility',
);
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, {
  enabled: true,
  image,
  dockerHost,
  deployment: directory,
});
const checks = [],
  observations = [];
const services = { computer };
const owner = (payload) =>
  computer.perform({ ...payload, operationId: randomUUID() }, { actor: 'owner' });
const tool = (name, args = {}) => executeTool(store, name, args, services);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Control notebook</title>
<style>body{font:22px system-ui;padding:28px 64px;background:#f7f4e8;color:#263f33}label{display:block;margin:16px 0}input,button{font:inherit;padding:10px}button{background:#386c51;color:white;border:0;margin:10px}#hidden{display:none}#offscreen{position:absolute;top:3000px}</style>
<h1>Control notebook</h1><label>Note title <input id="title" aria-label="Note title"></label>
<label>Password <input type="password" value="original-fixture-secret"></label>
<label><input type="checkbox" checked> Save a copy</label><button disabled>Unavailable option</button>
<button id="move">Move download</button><button id="download">Download note</button>
<button id="hidden">Hidden action</button><button id="offscreen">Offscreen action</button>
<p id="status">Downloads: 0</p><script>const move=document.getElementById('move'),download=document.getElementById('download'),title=document.getElementById('title'),status=document.getElementById('status');let count=0;move.onclick=()=>{download.style.marginLeft='280px';move.disabled=true};download.onclick=()=>{count++;status.textContent='Downloads: '+count;const a=document.createElement('a');a.download='control-note.txt';a.href=URL.createObjectURL(new Blob(['Title: '+title.value+'\\nReceipt: ORIGINAL-CONTROLS\\n'],{type:'text/plain'}));a.click()};</script></html>`;
const check = (value) => {
  checks.push(value);
  console.log('PASS', value);
};
async function look(predicate = () => true) {
  const deadline = Date.now() + 15000;
  do {
    const started = Date.now();
    const result = await tool('computer_look');
    observations.push({ elapsedMs: Date.now() - started, ...result.result });
    if (predicate(result.result.accessibility)) return result;
    await delay(150);
  } while (Date.now() < deadline);
  throw Error('Expected controls did not appear.');
}
const named = (frame, name) =>
  frame.result.accessibility.controls.find((control) => control.name === name);
async function click(frame, name, operationId = randomUUID()) {
  const target = named(frame, name);
  assert(target, name);
  return tool('computer_use', {
    action: 'click',
    operationId,
    x: target.x,
    y: target.y,
    coordinateSpace: frame.result.accessibility.coordinateSpace,
  });
}
try {
  await computer.start('owner');
  await computer.takeControl();
  await owner({
    kind: 'files',
    action: 'write',
    path: 'controls.html',
    base64: Buffer.from(html).toString('base64'),
  });
  await owner({
    kind: 'exec',
    command:
      'chromium --no-sandbox --user-data-dir=/workspace/.home/chromium --app=file:///workspace/controls.html >/tmp/control-notebook.log 2>&1 &',
  });
  await computer.release();
  const frame = await look(
    (a) => a?.available && a.controls.some((c) => c.name === 'Download note'),
  );
  assert.equal(frame.result.accessibility.coordinateSpace, 'normalized_1000');
  assert(named(frame, 'Note title'));
  assert(named(frame, 'Save a copy').checked);
  assert.equal(named(frame, 'Unavailable option').enabled, false);
  assert(!named(frame, 'Hidden action'));
  assert(!named(frame, 'Offscreen action'));
  assert(!JSON.stringify(frame.result).includes('original-fixture-secret'));
  assert(
    frame.result.accessibility.controls.some((c) => c.protected && c.name === 'Password field'),
  );
  assert(!frame.result.accessibility.controls.some((c) => /little room/.test(c.name)));
  await writeFile(
    join(evidence, 'controls-before.jpg'),
    Buffer.from(frame.image.split(',')[1], 'base64'),
  );
  check(
    'Actual Chromium names, normalized positions and states; background/hidden/offscreen/protected values excluded',
  );
  const ownerFrame = await computer.screenshot();
  assert.equal(ownerFrame.accessibility, undefined);
  check('Ordinary owner screen polling avoids accessibility traversal');
  await click(frame, 'Note title');
  await tool('computer_use', { action: 'type', text: 'Reading plans', operationId: randomUUID() });
  const moved = await click(frame, 'Move download');
  assert(moved.result.accessibility.available);
  assert.notEqual(named(moved, 'Download note').x, named(frame, 'Download note').x);
  const id = randomUUID();
  await click(moved, 'Download note', id);
  const repeated = await click(moved, 'Download note', id);
  assert.equal(repeated.result.repeated, true);
  assert.equal(repeated.result.accessibility, undefined);
  assert.equal(repeated.image, undefined);
  const after = await look((a) => a?.controls.some((c) => c.name === 'Downloads: 1'));
  assert(!named(after, 'Downloads: 2'));
  const files = await computer.list('.home/Downloads');
  const result = await computer.read('.home/Downloads/control-note.txt');
  assert.equal(
    Buffer.from(result.base64, 'base64').toString(),
    'Title: Reading plans\nReceipt: ORIGINAL-CONTROLS\n',
  );
  assert.equal(files.entries.filter((file) => file.name.endsWith('.txt')).length, 1);
  await writeFile(
    join(evidence, 'controls-after.jpg'),
    Buffer.from(after.image.split(',')[1], 'base64'),
  );
  check(
    'Observed targets actually focus fields and click a moved button; exact downloaded bytes and replay-safe action receipt',
  );
  const isolated = await computer.perform({
    kind: 'exec',
    operationId: randomUUID(),
    command: 'test ! -S /tmp/relay-runtime/bus && printf isolated',
  });
  assert.equal(isolated.stdout, 'isolated');
  const desktop = await computer.inspect();
  assert.equal(desktop.HostConfig.NetworkMode, 'none');
  assert.equal(Object.keys(desktop.HostConfig.PortBindings || {}).length, 0);
  assert.equal(desktop.Mounts.length, 2);
  check(
    'Accessibility bus remains inside the desktop; no published ports, host mounts or command-runtime bus',
  );
  await computer.takeControl();
  await assert.rejects(tool('computer_look'), /owner|control/);
  await owner({
    kind: 'exec',
    command: 'xterm -T "No accessibility probe" >/tmp/accessibility-xterm.log 2>&1 &',
  });
  await computer.release();
  const fallback = await look((a) => a?.available === false);
  assert(fallback.image.startsWith('data:image/jpeg;base64,'));
  check('Owner takeover denies observations; unsupported app retains screenshot fallback');
  await writeFile(
    join(evidence, 'acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        image,
        checks,
        observations,
        scope:
          'Real isolated offline Chromium/Xterm, screenshots, input and downloaded bytes; no model-quality claim and no host desktop access.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ passed: false, error: error.message, checks, observations }, null, 2),
  );
  throw error;
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]);
  await computer.dockerRun(['volume', 'rm', computer.volume, computer.displayVolume]);
  store.close();
  await rm(directory, { recursive: true, force: true });
}
