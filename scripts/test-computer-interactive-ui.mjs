// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-pty-ui-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
let label;
const call = (name, args) => ({
  text: '',
  toolCalls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }],
});
const provider = {
  configured: true,
  model: 'Controlled interactive-computer test',
  complete: async (messages) => {
    const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    for (const result of results) expect(result.error).toBeUndefined();
    if (
      messages.some((m) =>
        m.content?.startsWith('Continue the original request after this background'),
      )
    )
      return results.length
        ? { text: 'Your personalized report is ready.', toolCalls: [] }
        : call('computer_export', { path: `interactive-${label}.txt` });
    if (!results.length) return call('computer_start', {});
    if (results.length > 1)
      return { text: 'The program is ready. You can reply in its details.', toolCalls: [] };
    const code = `import pathlib\nname=input("Your name? ")\nprint("Name received:",name)\nstyle=input("Which style? ")\npathlib.Path("/workspace/interactive-${label}.txt").write_text(name+" / "+style)\nprint("Report saved")`;
    return call('computer_job_start', {
      title: `Personalize report ${label}`,
      operationId: `interactive-${label}`,
      pty: true,
      seconds: 300,
      command: "python3 -u -c '" + code + "'",
    });
  },
};
const services = {
  mode: 'live',
  computer,
  provider,
  google: { configured: false },
  browser: { enabled: false },
  terminal: { enabled: false },
};
const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: '' });
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const worker = new BackgroundWorker(store, services, { pollMs: 150 });
worker.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
try {
  for (const mobile of [false, true]) {
    label = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    const draft = page.getByRole('textbox', { name: 'Message Relay', exact: true });
    await draft.fill(`Make my ${label} report.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await draft.fill(`Keep my ${label} draft`);
    const card = page.getByRole('region', {
      name: `Computer job: Personalize report ${label}`,
      exact: true,
    });
    await expect(card).toBeVisible({ timeout: 120000 });
    await expect(page.getByRole('button', { name: 'Open your computer', exact: true })).toHaveCount(
      0,
    );
    await card.getByText('Details & output', { exact: true }).click();
    await expect(card.getByLabel(`Output for Personalize report ${label}`)).toContainText(
      'Your name?',
      { timeout: 45000 },
    );
    const input = card.getByRole('textbox', { name: 'Reply to this program', exact: true });
    await expect(card.locator('.computer-job-command code')).toBeHidden();
    await card.getByText('Command details', { exact: true }).click();
    await expect(card.locator('.computer-job-command code')).toContainText('python3');
    await card.getByText('Command details', { exact: true }).click();
    expect(
      await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.fill('Renée');
    const attempts = [];
    await page.route('**/api/computer/jobs/*/input', async (route) => {
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (attempts.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await card.getByRole('button', { name: 'Send input', exact: true }).click();
    await expect(card.getByRole('alert')).toBeVisible({ timeout: 45000 });
    await expect(input).toHaveValue('Renée');
    await page.reload();
    await card.getByText('Details & output', { exact: true }).click();
    await expect(input).toHaveValue('Renée');
    await expect(card.getByLabel(`Output for Personalize report ${label}`)).toContainText(
      'Which style?',
      { timeout: 45000 },
    );
    await card.getByRole('button', { name: 'Send input', exact: true }).click();
    await expect(input).toHaveValue('', { timeout: 45000 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    await expect(card.getByRole('status')).toHaveText('Working');
    await input.fill('Gentle');
    await page.screenshot({ path: join(evidence, `interactive-prompt-${label}.png`) });
    check(
      `${label}: real PTY prompt, Unicode input and lost-response retry preserve one input identity and the chat draft`,
    );
    await card.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeEnabled(
      { timeout: 45000 },
    );
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    if (
      !(await card.getByRole('textbox', { name: 'Reply to this program', exact: true }).isVisible())
    )
      await card.getByText('Details & output', { exact: true }).click();
    await expect(
      card.getByRole('textbox', { name: 'Reply to this program', exact: true }),
    ).toBeDisabled({ timeout: 15000 });
    await expect(draft).toHaveValue(`Keep my ${label} draft`);
    await card.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    if (
      !(await card.getByRole('textbox', { name: 'Reply to this program', exact: true }).isVisible())
    )
      await card.getByText('Details & output', { exact: true }).click();
    const answer = card.getByRole('textbox', { name: 'Reply to this program', exact: true });
    await expect(answer).toBeEnabled({ timeout: 45000 });
    await expect(answer).toHaveValue('Gentle');
    await answer.press('Enter');
    const result = page.getByRole('button', {
      name: `interactive-${label}.txt Saved to your files`,
      exact: true,
    });
    await expect(result).toBeVisible({ timeout: 120000 });
    await expect(card.getByRole('status')).toHaveText('Finished');
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await result.click();
    const preview = page.getByRole('region', { name: 'File preview', exact: true });
    await expect(preview).toContainText('Renée / Gentle');
    await page.goBack();
    await expect(draft).toHaveValue(`Keep my ${label} draft`);
    expect(store.read().messages.filter((m) => m.role === 'user').length).toBe(mobile ? 2 : 1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(evidence, `interactive-complete-${label}.png`) });
    check(
      `${label}: takeover blocks terminal input; handback accepts one line and returns exact file contents without synthetic messages, lost chat draft, overflow or accessibility findings`,
    );
    await context.close();
  }
  await writeFile(
    join(evidence, 'computer-interactive-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Production desktop/mobile UI, real Docker PTY and file output; controlled model',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await worker.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
