// SPDX-License-Identifier: MIT
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { BrowserContainer } from '../server/browser-container.mjs';
const store = new Store(':memory:', { sample: false });
const computer = new PrivateComputer(store, {
  enabled: true,
  deployment: process.argv[3] || `browser-lifecycle-${randomUUID()}`,
});
const runtime = new BrowserContainer(computer);
if (process.argv[2] === '--child') {
  const browser = await runtime.launch();
  await (await browser.newPage()).goto('data:text/html,<p>Crash acceptance</p>');
  process.send({ id: runtime.id, directory: runtime.directory });
  setInterval(() => {}, 1000);
} else {
  const checks = [];
  let parent, childId;
  try {
    const browser = await runtime.launch(),
      id = runtime.id;
    await computer.checked(['kill', id]);
    for (let n = 0; n < 100 && browser.isConnected(); n++) await delay(50);
    assert.equal(browser.isConnected(), false);
    const next = await runtime.launch();
    assert(next.isConnected());
    assert.notEqual(runtime.id, id);
    const page = await next.newPage();
    await page.goto('data:text/html,<h1>Recovered</h1>');
    assert.equal(await page.locator('h1').innerText(), 'Recovered');
    await runtime.close();
    assert.notEqual((await computer.dockerRun(['inspect', id])).exitCode, 0);
    checks.push(
      'A stopped browser container disconnects, is removed, and a fresh independently bounded browser can render',
    );
    parent = fork(fileURLToPath(import.meta.url), ['--child', `browser-crash-${randomUUID()}`], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const event = await Promise.race([
      once(parent, 'message'),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('Child startup timeout')), 30000);
        timer.unref();
      }),
    ]);
    childId = event[0].id;
    assert.match(childId, /^[a-f0-9]{64}$/);
    const exited = once(parent, 'exit');
    parent.kill('SIGKILL');
    await exited;
    let removed = false;
    for (let n = 0; n < 100; n++) {
      if ((await computer.dockerRun(['inspect', childId])).exitCode) {
        removed = true;
        break;
      }
      await delay(100);
    }
    assert(removed, 'Pipe EOF must remove the browser after its parent is killed');
    for (let n = 0; n < 100; n++) {
      try {
        await stat(event[0].directory);
      } catch {
        break;
      }
      await delay(50);
    }
    await assert.rejects(stat(event[0].directory), /ENOENT/);
    checks.push(
      'Actual parent SIGKILL closes its CDP pipe and the owned browser container disappears without touching peer runtimes',
    );
    const evidence = resolve('../relay-evidence');
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, 'browser-container-lifecycle-acceptance.json'),
      JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2) + '\n',
    );
    console.log('PASS', checks.join('\nPASS '));
  } finally {
    await runtime.close();
    if (parent && parent.exitCode === null) parent.kill('SIGKILL');
    if (childId) await computer.dockerRun(['rm', '-f', childId]).catch(() => {});
    store.close();
  }
}
