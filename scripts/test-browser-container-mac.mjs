// SPDX-License-Identifier: MIT
// Production packaged backend, actual contained Chromium, public IANA example page.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-browser-contained-mac-'));
const owner = createHash('sha256').update(join(directory, 'workspace')).digest('hex').slice(0, 16);
const host = process.env.DOCKER_HOST;
assert(host?.startsWith('unix:///'), 'Set DOCKER_HOST to the explicit test engine.');
const docker = '/opt/homebrew/bin/docker',
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let app,
  port = '0';
const checks = [];
const containers = async () =>
  JSON.parse(
    (
      await exec(docker, [
        '--host',
        host,
        'ps',
        '-a',
        '--filter',
        `label=org.relay.owner=${owner}`,
        '--filter',
        'label=org.relay.role=private-browser',
        '--format',
        'json',
      ])
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line)
      .join(',')
      .replace(/^/, '[')
      .replace(/$/, ']'),
  );
const launch = async () => {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${port}`],
    env: {
      ...process.env,
      DOCKER_HOST: host,
      RELAY_MODE: 'live',
      RELAY_DESKTOP_ENABLED: 'true',
      RELAY_DESKTOP_IMAGE: 'relay-desktop:local',
      RELAY_TRUSTED_BROWSER_ENABLED: 'true',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(25000);
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible({
    timeout: 30000,
  });
  port = new URL(page.url()).port;
  return page;
};
try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page
    .getByRole('textbox', { name: 'Message Relay', exact: true })
    .fill('Keep my private browser draft');
  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Open computer', exact: true })
    .click();
  const ui = page.getByRole('region', { name: 'Private browser', exact: true });
  await expect(ui).toBeVisible();
  await ui.getByRole('button', { name: 'Take control', exact: true }).click();
  await ui
    .getByRole('textbox', { name: 'Website address', exact: true })
    .fill('https://example.com/');
  await ui.getByRole('button', { name: 'Open website', exact: true }).click();
  await expect(
    ui.getByRole('img', { name: 'Current private browser page', exact: true }),
  ).toBeVisible({ timeout: 60000 });
  const observation = await page.evaluate(async () => {
    const r = await fetch('/api/private-browser/accessibility');
    if (!r.ok) throw Error('Owner observation failed');
    return r.json();
  });
  assert(JSON.stringify(observation).includes('Example Domain'));
  const list = await containers();
  assert.equal(list.length, 1);
  const container = JSON.parse(
    (await exec(docker, ['--host', host, 'inspect', list[0].ID])).stdout,
  )[0];
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.Mounts.length, 0);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(
    await page.evaluate(async () => (await (await fetch('/api/state')).json()).messages.length),
    0,
  );
  await page.screenshot({ path: join(evidence, 'browser-container-local-native-mac.png') });
  checks.push(
    'Packaged app local backend opens the public example page through the broker in a real network-none, mount-free Chromium container',
  );
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    'Keep my private browser draft',
  );
  await app.close();
  app = null;
  await expect.poll(async () => (await containers()).length).toBe(0);
  checks.push('Full native quit removes its owned browser container');
  page = await launch();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    'Keep my private browser draft',
  );
  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Open computer', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible();
  assert.equal(
    (await containers()).length,
    0,
    'Relaunch alone must not open websites or start a browser',
  );
  checks.push(
    'Full relaunch retains the chat draft and owner control without reopening a site or adding history',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, 'browser-container-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        containerImage: container.Image,
        scope:
          'Unsigned packaged arm64 Mac, production bundled backend, real Docker Chromium and public example.com; no account credentials or model inference',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS', checks.join('\nPASS '));
} finally {
  await app?.close().catch(() => {});
  for (const c of await containers()) await exec(docker, ['--host', host, 'rm', '-f', c.ID]);
  await rm(directory, { recursive: true, force: true });
}
