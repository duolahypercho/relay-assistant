// SPDX-License-Identifier: MIT
// Real local vision/actions against Relay's real isolated desktop and SQLite.
// Requires an explicitly chosen test engine, installed image, model and model cache.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const mac = process.argv.includes('--mac');
const controls = process.argv.includes('--controls');
const model = process.env.RELAY_COMPUTER_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const dockerHost = process.env.RELAY_COMPUTER_TEST_DOCKER_HOST;
const replyMode = process.env.RELAY_COMPUTER_TEST_REPLY_MODE || 'quick';
const taskTimeoutMs = Number(process.env.RELAY_COMPUTER_TEST_TIMEOUT_MS || 300000);
assert(
  Number.isInteger(taskTimeoutMs) && taskTimeoutMs >= 60000 && taskTimeoutMs <= 900000,
  'Choose a bounded task timeout from 60 to 900 seconds.',
);
assert(model && modelsDirectory, 'Choose installed test weights and a dedicated model cache.');
assert(dockerHost?.startsWith('unix:///'), 'Choose an explicit local test Docker socket.');
assert(['quick', 'default'].includes(replyMode));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-live');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-computer-live-'));
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
const computer = new PrivateComputer(f.store, {
  enabled: true,
  deployment: directory,
  dockerHost,
  ...(process.env.RELAY_TEST_COMPUTER_IMAGE
    ? { image: process.env.RELAY_TEST_COMPUTER_IMAGE }
    : {}),
});
f.worker.services.computer = computer;
if (mac) await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
const browser = mac
  ? await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${directory}`],
    })
  : await chromium.launch({ channel: 'chrome', headless: true });
const page = mac
  ? await browser.firstWindow()
  : await browser.newPage({ viewport: { width: 1365, height: 950 } });
if (mac)
  await browser.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.hide()),
  );
const requests = [],
  responses = [],
  captures = [],
  checks = [],
  pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const report = {
  model,
  replyMode,
  controls,
  surface: mac ? 'mac' : 'desktop-browser',
  passed: false,
  taskTimeoutMs,
  checks,
};
const marker = `MAPLE-${randomInt(10000, 99999)}`;
const city = ['Oslo', 'Lisbon', 'Vienna'][randomInt(3)];
const choices = ['Passport', 'Charger', 'Umbrella'];
for (let index = choices.length - 1; index > 0; index--) {
  const other = randomInt(index + 1);
  [choices[index], choices[other]] = [choices[other], choices[index]];
}
const fixture = `import tkinter as tk, json, os
city=${JSON.stringify(city)}; reference=${JSON.stringify(marker)}
r=tk.Tk(); r.title('Travel checklist'); r.geometry('580x480+350+100'); r.attributes('-topmost',True); r.configure(bg='#faf8f2')
tk.Label(r,text='Trip to '+city,font=('DejaVu Sans',25,'bold'),bg='#faf8f2').pack(pady=(28,8))
tk.Label(r,text='Reference: '+reference,font=('DejaVu Sans',18),bg='#faf8f2').pack(pady=(0,18))
values={}; actions=[]; saves=0
def state():
 data={'city':city,'reference':reference,'items':{k:bool(v.get()) for k,v in values.items()},'actions':actions,'saves':saves}
 with open('/workspace/.checklist-state.next','w') as f: json.dump(data,f)
 os.replace('/workspace/.checklist-state.next','/workspace/.checklist-state.json')
def changed(k):
 actions.append({'action':'toggle','item':k,'checked':bool(values[k].get())}); state()
for k in ${JSON.stringify(choices)}:
 values[k]=tk.IntVar(value=0)
 tk.Checkbutton(r,text=k,variable=values[k],command=lambda k=k:changed(k),font=('DejaVu Sans',21),bg='#faf8f2',activebackground='#faf8f2',anchor='w',width=16).pack(pady=5)
notice=tk.StringVar(value='Choose what is packed, then save.')
def save():
 global saves
 with open('/workspace/trip-checklist.txt','w') as f:
  f.write('Trip: '+city+'\\nReference: '+reference+'\\nPacked:\\n'+''.join('- '+k+'\\n' for k in sorted(values) if values[k].get()))
 saves+=1; actions.append({'action':'save'}); state(); notice.set('Saved: trip-checklist.txt')
tk.Button(r,text='Save checklist',command=save,font=('DejaVu Sans',18),padx=18,pady=8).pack(pady=(18,10))
tk.Label(r,textvariable=notice,font=('DejaVu Sans',13),bg='#faf8f2').pack()
state(); r.mainloop()
`;
// Independent offline fixture. The random destination/reference only appear in
// the real window; the task does not provide them to the model.
const accessibleFixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Travel checklist</title>
<style>body{font:23px system-ui;background:#faf8f2;color:#264135;padding:30px 90px}label{display:block;margin:24px 0}input{width:24px;height:24px;margin-right:14px}button{font:inherit;padding:16px 25px;background:#386c51;color:white;border:0;border-radius:12px}#notice{font-size:18px}</style>
<h1>Trip to ${city}</h1><p>Reference: ${marker}</p>
${choices.map((item) => `<label><input type="checkbox" value="${item}">${item}</label>`).join('')}
<button id="save">Save checklist</button><p id="notice">Choose what is packed, then save.</p>
<script>document.getElementById('save').onclick=()=>{
const packed=Array.from(document.querySelectorAll('input:checked')).map(input=>input.value).sort();
const a=document.createElement('a');a.download='trip-checklist.txt';
a.href=URL.createObjectURL(new Blob(['Trip: ${city}\\nReference: ${marker}\\nPacked:\\n'+packed.map(item=>'- '+item+'\\n').join('')],{type:'text/plain'}));a.click();
document.getElementById('notice').textContent='Saved: trip-checklist.txt';
};</script></html>`;
const savedPath = controls ? '.home/Downloads/trip-checklist.txt' : 'trip-checklist.txt';
const transport = f.provider.fetcher;
f.provider.fetcher = async (url, init) => {
  const completion = url.endsWith('/chat/completions');
  const index = requests.length;
  if (completion) requests.push(JSON.parse(init.body));
  const response = await transport(url, init);
  if (completion)
    captures.push(
      response
        .clone()
        .text()
        .then((body) => {
          responses[index] = { status: response.status, body };
        })
        .catch((error) => {
          responses[index] = { error: String(error) };
        }),
    );
  return response;
};
const check = (text) => {
  checks.push(text);
  console.log(`PASS ${text}`);
};
try {
  await computer.start();
  const inspected = await computer.inspect();
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert.equal(Object.keys(inspected.HostConfig.PortBindings || {}).length, 0);
  assert(inspected.Mounts.every((mount) => mount.Type === 'volume'));
  assert.match(inspected.Config.User, /^1000(?::1000)?$/);
  report.isolation = {
    image: inspected.Image,
    user: inspected.Config.User,
    network: inspected.HostConfig.NetworkMode,
    mounts: inspected.Mounts.map((mount) => ({ type: mount.Type, destination: mount.Destination })),
    publishedPorts: Object.keys(inspected.HostConfig.PortBindings || {}).length,
  };
  check('Dedicated desktop has no host mounts, published ports or direct network');
  if (controls) {
    await computer.takeControl();
    await computer.perform(
      {
        kind: 'files',
        action: 'write',
        path: 'travel.html',
        base64: Buffer.from(accessibleFixture).toString('base64'),
        operationId: 'prepare-accessible-checklist',
      },
      { actor: 'owner' },
    );
    await computer.perform(
      {
        kind: 'exec',
        operationId: 'open-accessible-checklist',
        command:
          'chromium --no-sandbox --user-data-dir=/workspace/.home/chromium --app=file:///workspace/travel.html >/tmp/travel.log 2>&1 &',
      },
      { actor: 'owner' },
    );
    await computer.release();
    await expect
      .poll(async () =>
        (await computer.screenshot({ controls: true })).accessibility?.controls?.some(
          (c) => c.name === 'Save checklist',
        ),
      )
      .toBe(true);
  } else {
    const prepared = await computer.perform({
      kind: 'exec',
      operationId: 'prepare-independent-checklist',
      seconds: 5,
      command: `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(fixture).toString('base64')}'))" >/tmp/relay-checklist.log 2>&1 </dev/null &`,
    });
    assert.equal(prepared.exitCode, 0);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(
            Buffer.from((await computer.read('.checklist-state.json')).base64, 'base64'),
          ).reference;
        } catch {
          return '';
        }
      })
      .toBe(marker);
  }
  const initial = await computer.screenshot();
  await writeFile(
    join(evidence, 'computer-live-before.jpg'),
    Buffer.from(initial.screenshot, 'base64'),
  );
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
    replyMode,
  });
  f.store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  await page.goto(f.url);
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await expect(composer).toBeVisible();
  const prompt =
    'Pack Passport and Charger in the checklist window on your computer. Leave Umbrella unchecked, save the checklist using the window, and attach the saved file here. Mention the destination and the reference shown in the window.';
  report.prompt = prompt;
  const started = performance.now();
  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => f.store.read().runs.length).toBe(1);
  await expect
    .poll(() => ['completed', 'failed', 'cancelled'].includes(f.store.read().runs[0].status), {
      timeout: taskTimeoutMs,
    })
    .toBe(true);
  report.elapsedMs = Math.round(performance.now() - started);
  const state = f.store.read(),
    run = state.runs[0];
  report.run = run;
  report.reply = state.messages.findLast((m) => m.role === 'assistant')?.text;
  assert.equal(run.status, 'completed', JSON.stringify(run));
  await Promise.all(captures);
  const toolCalls = [];
  for (const [responseIndex, response] of responses.entries()) {
    const calls = new Map();
    for (const line of (response.body || '')
      .split('\n')
      .filter((line) => line.startsWith('data: {'))) {
      for (const choice of JSON.parse(line.slice(6)).choices || [])
        for (const delta of choice.delta?.tool_calls || []) {
          const call = calls.get(delta.index) || { name: '', arguments: '', responseIndex };
          call.name += delta.function?.name || '';
          call.arguments += delta.function?.arguments || '';
          calls.set(delta.index, call);
        }
    }
    toolCalls.push(...calls.values());
  }
  report.toolCalls = toolCalls;
  const finalText = responses
    .at(-1)
    .body.split('\n')
    .filter((line) => line.startsWith('data: {'))
    .flatMap((line) => JSON.parse(line.slice(6)).choices || [])
    .map((choice) => choice.delta?.content || '')
    .join('');
  assert.equal(
    report.reply,
    finalText,
    'Completed chat must show the final answer without accumulated tool narration.',
  );
  assert(
    toolCalls.some((c) => c.name === 'computer_export'),
    'The saved guest file must be exported.',
  );
  assert(
    !toolCalls.some((c) => ['computer_run', 'computer_job_start'].includes(c.name)),
    'Checklist acceptance requires GUI actions, not shell manipulation.',
  );
  const firstUse = toolCalls.findIndex((c) => c.name === 'computer_use');
  assert(firstUse >= 0, 'The live model must perform actual desktop input.');
  assert(
    requests[toolCalls[firstUse].responseIndex].messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    ),
    'The live vision model must receive a real screenshot before its first desktop input.',
  );
  if (controls) {
    const observations = requests
      .flatMap((r) => r.messages)
      .map((m) => {
        try {
          if (m.role === 'tool') return JSON.parse(m.content).result;
          const text = Array.isArray(m.content)
            ? m.content.find((part) => part.type === 'text')?.text
            : m.content;
          if (
            m.role === 'user' &&
            typeof text === 'string' &&
            text.startsWith('Current private computer observation for this request.')
          )
            return JSON.parse(text.slice(text.indexOf('\n') + 1)).result;
        } catch {
          /* Not an observation envelope. */
        }
        return null;
      });
    assert(
      observations.some(
        (result) =>
          result?.accessibility?.available &&
          result.accessibility.controls.some((c) => c.name === 'Save checklist'),
      ),
      'Live model must receive actual accessible control names and positions.',
    );
    const observed = (await computer.screenshot({ controls: true })).accessibility;
    report.observed = observed;
    for (const name of choices)
      assert.equal(
        observed.controls.find((c) => c.role === 'check box' && c.name === name)?.checked,
        name !== 'Umbrella',
      );
    assert(observed.controls.some((c) => c.name === 'Saved: trip-checklist.txt'));
    check(
      'Real model receives accessible names/positions with the screenshot and leaves the actual controls in the requested state',
    );
  } else {
    const observed = JSON.parse(
      Buffer.from((await computer.read('.checklist-state.json')).base64, 'base64'),
    );
    report.observed = observed;
    assert.deepEqual(
      observed.items,
      Object.fromEntries(choices.map((name) => [name, name !== 'Umbrella'])),
    );
    assert(observed.saves >= 1 && observed.actions.some((a) => a.action === 'save'));
    for (const name of ['Passport', 'Charger'])
      assert(observed.actions.some((a) => a.action === 'toggle' && a.item === name && a.checked));
  }
  check('Live model observes the screen, selects the requested checkboxes and presses Save');
  const file = state.files.find((f) => f.name === 'trip-checklist.txt');
  assert(file, 'A real exported checklist is required, not a completion claim.');
  const actual = Buffer.from(file.base64, 'base64');
  const expected = `Trip: ${city}\nReference: ${marker}\nPacked:\n- Charger\n- Passport\n`;
  assert.equal(actual.toString(), expected);
  assert.deepEqual(actual, Buffer.from((await computer.read(savedPath)).base64, 'base64'));
  assert(report.reply.includes(city) && report.reply.includes(marker));
  assert.equal(state.files.length, 1);
  assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(
    state.messages.flatMap((m) => (m.cards || []).filter((c) => c.kind === 'question')).length,
    0,
  );
  check('Exact saved bytes and random screen-only facts return through one chat request');
  const after = await computer.screenshot();
  await writeFile(
    join(evidence, 'computer-live-after.jpg'),
    Buffer.from(after.screenshot, 'base64'),
  );
  await composer.fill('Keep my next thought.');
  await page.screenshot({ path: join(evidence, 'computer-live-chat.png') });
  await page
    .locator('.messages')
    .getByRole('button', { name: /trip-checklist\.txt/ })
    .click();
  const exported = join(evidence, 'trip-checklist.txt');
  if (mac) {
    // Electron owns downloads outside Playwright's page download event. Select
    // this test's destination using Electron's real download API, then inspect
    // the finished bytes. This does not exercise the operating-system picker.
    await browser.evaluate(({ BrowserWindow }, path) => {
      globalThis.relayTestDownload = { state: 'waiting' };
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => {
          globalThis.relayTestDownload = { state, name: item.getFilename() };
        });
      });
    }, exported);
    await page.getByRole('link', { name: 'Download', exact: true }).click();
    await expect
      .poll(() => browser.evaluate(() => globalThis.relayTestDownload.state))
      .toBe('completed');
    report.download = await browser.evaluate(() => globalThis.relayTestDownload);
  } else {
    const downloadPending = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download', exact: true }).click();
    const download = await downloadPending;
    assert.equal(await download.failure(), null);
    await download.saveAs(exported);
    report.download = { state: 'completed', name: download.suggestedFilename() };
  }
  assert.deepEqual(await readFile(exported), actual);
  report.sha256 = createHash('sha256').update(actual).digest('hex');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep my next thought.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.locator('.computer-display img')).toBeVisible();
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => computer.controller).toBe('owner');
  await page.screenshot({ path: join(evidence, 'computer-live-owner-control.png') });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep my next thought.');
  await page.reload();
  await expect(composer).toHaveValue('Keep my next thought.');
  assert.equal(f.store.read().messages.length, state.messages.length);
  assert.equal(f.store.read().runs.length, 1);
  assert.deepEqual(pageErrors, []);
  check('Download, separate Computer page, takeover and reload preserve the draft and history');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  report.run = f.store.read().runs[0];
  report.reply = f.store.read().messages.findLast((m) => m.role === 'assistant')?.text;
  try {
    report.observed = controls
      ? (await computer.screenshot({ controls: true })).accessibility
      : JSON.parse(Buffer.from((await computer.read('.checklist-state.json')).base64, 'base64'));
    const frame = await computer.screenshot();
    await writeFile(
      join(evidence, 'computer-live-failure.jpg'),
      Buffer.from(frame.screenshot, 'base64'),
    );
  } catch (captureError) {
    report.captureError = String(captureError);
  }
  await page.screenshot({ path: join(evidence, 'computer-live-failure.png') }).catch(() => {});
  throw error;
} finally {
  await f.worker.stop();
  await Promise.allSettled(captures);
  report.checkedAt = new Date().toISOString();
  report.receipts = computer.receipts();
  await writeFile(join(evidence, 'computer-live-acceptance.json'), JSON.stringify(report, null, 2));
  await writeFile(
    join(evidence, 'computer-live-transport.json'),
    JSON.stringify({ requests, responses }, null, 2),
  );
  await browser.close();
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
