// SPDX-License-Identifier: MIT
// Actual packaged Mac backend, official releases, new private HOME and no engine env override.
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setupProcess } from '../server/computer-setup.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const directory = await mkdtemp('/tmp/ri-');
await mkdir(join(directory, 'home'));
const engineRoot = join(
  directory,
  '.relay/vm',
  createHash('sha256').update(join(directory, 'workspace')).digest('hex').slice(0, 16),
);
const evidence = resolve('../relay-evidence');
let app,
  page,
  port = '0';
const checks = [];
let passed = false;
const ownerBefore = {
  profiles: (await setupProcess('/opt/homebrew/bin/colima', ['list', '--json'])).stdout,
  context: (await setupProcess('/opt/homebrew/bin/docker', ['context', 'show'])).stdout,
};
const api = (path, body) =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(
        '/api/' + path,
        body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {},
      );
      if (!r.ok) throw Error('Owner API ' + r.status);
      return r.json();
    },
    { path, body },
  );
async function launch() {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${port}`],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/^(RELAY_|GOOGLE_|DOCKER_|COLIMA_|LIMA_)/.test(k),
        ),
      ),
      HOME: directory,
      RELAY_MODE: 'sample',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
    },
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.hide();
  });
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  port = new URL(page.url()).port;
}
try {
  await launch();
  await page
    .getByLabel('Message Relay', { exact: true })
    .fill('Keep my private Mac computer draft');
  const before = (await api('state')).messages;
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  const region = page.getByRole('region', { name: 'Private computer setup', exact: true });
  await expect(region).toBeVisible();
  await page.screenshot({ path: join(evidence, 'computer-install-mac-before.png') });
  await region.getByRole('button', { name: 'Set up computer', exact: true }).click();
  let installationState;
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect
      .poll(async () => (await api('computer/installation')).busy, {
        timeout: 25 * 60000,
        intervals: [1000],
      })
      .toBe(false);
    installationState = await api('computer/installation');
    if (installationState.installation.phase === 'ready') break;
    checks.push(
      'Setup attempt ' +
        (attempt + 1) +
        ' returned ' +
        JSON.stringify(installationState.installation),
    );
    if (attempt === 2) break;
    await region.getByRole('button', { name: 'Continue setup', exact: true }).click();
  }
  assert.equal(installationState.installation.phase, 'ready', JSON.stringify(installationState));
  await expect(page.locator('.computer-screen-input img')).toBeVisible({ timeout: 45000 });
  const receipt = JSON.parse(await readFile(join(engineRoot, 'tools/relay-release.json'), 'utf8'));
  assert(receipt.version.includes('colima-0.10.3'));
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('Commands & activity', { exact: true }).click();
  await page
    .getByLabel('Private computer command')
    .fill("printf 'Private Mac computer works' > private-mac-install.txt");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect
    .poll(async () => JSON.stringify(await api('computer/files')))
    .toContain('private-mac-install.txt');
  await page.screenshot({ path: join(evidence, 'computer-install-mac-ready.png') });
  assert.deepEqual((await api('state')).messages, before);
  checks.push(
    'Fresh Mac profile: inline setup, official private tools, real VM/workspace, screen, owner control and command-created file',
  );
  await app.close();
  app = null;
  await launch();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my private Mac computer draft',
  );
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible();
  assert.equal((await api('computer/installation')).managed, true);
  assert(JSON.stringify(await api('computer/files')).includes('private-mac-install.txt'));
  assert.deepEqual((await api('state')).messages, before);
  checks.push(
    'Full packaged-app quit/relaunch restores private CLI, saved file, owner control and draft without reinstallation',
  );
  await page.screenshot({ path: join(evidence, 'computer-install-mac-restored.png') });
  passed = true;
} finally {
  if (app)
    await writeFile(
      join(evidence, 'computer-install-mac-final-state.json'),
      JSON.stringify(await api('computer/installation').catch(() => ({})), null, 2),
    );
  await app?.close();
  for (const name of ['ha.stderr.log', 'serialv.log']) {
    try {
      await writeFile(
        join(evidence, 'computer-install-mac-' + name),
        await readFile(join(engineRoot, 'colima/_lima/colima-relay', name)),
      );
    } catch {}
  }
  const env = {
    HOME: join(engineRoot, 'home'),
    COLIMA_HOME: join(engineRoot, 'colima'),
    XDG_CACHE_HOME: join(engineRoot, 'cache'),
    DOCKER_CONFIG: join(engineRoot, 'docker-config'),
    PATH: join(engineRoot, 'tools/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: join(engineRoot, 'tmp'),
  };
  let cleanup = false;
  try {
    const owned = JSON.parse(await readFile(join(engineRoot, 'relay-engine.json'), 'utf8'));
    assert.equal(
      owned.owner,
      createHash('sha256').update(join(directory, 'workspace')).digest('hex').slice(0, 16),
    );
    const colima = join(engineRoot, 'tools/bin/colima');
    await setupProcess(colima, ['stop', '--force', '--profile', 'relay'], { env, timeout: 90000 });
    const result = await setupProcess(
      colima,
      ['delete', '--force', '--data', '--profile', 'relay'],
      { env, timeout: 90000 },
    );
    assert.equal(result.exitCode, 0);
    cleanup = true;
  } catch (e) {
    if (passed) throw e;
  }
  const ownerAfter = {
    profiles: (await setupProcess('/opt/homebrew/bin/colima', ['list', '--json'])).stdout,
    context: (await setupProcess('/opt/homebrew/bin/docker', ['context', 'show'])).stdout,
  };
  assert.deepEqual(ownerAfter, ownerBefore);
  await writeFile(
    join(evidence, 'computer-install-mac-acceptance.json'),
    JSON.stringify({ passed, checks, cleanup, ownerUnchanged: true, engineRoot }, null, 2),
  );
  if (cleanup) await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ passed, checks, cleanup }));
}
