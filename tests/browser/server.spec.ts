import { test, expect } from '@playwright/test';
test('self-hosted interface receives background results over the live state connection', async ({
  page,
}) => {
  await page.goto('/#activity');
  await expect(page.getByText('Self-hosted sample', { exact: true })).toBeVisible();
  await page
    .getByLabel('What needs to get done?', { exact: true })
    .fill('Server browser-test spending note');
  await page.getByText('Add context or choose the kind of work', { exact: true }).click();
  await page.getByLabel('Kind of work', { exact: true }).selectOption('finance');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.locator('.task-detail-meta .status')).toHaveText(/Completed/);
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'File preview', exact: true })
      .getByText('Income: $4,650.00', { exact: true }),
  ).toBeVisible();
});
test('server persists an uploaded note and exposes an owned download, while missing files fail', async ({
  request,
}) => {
  const response = await request.post('/api/command', {
    data: {
      action: 'file.add',
      payload: {
        name: 'server-test-note.txt',
        mime: 'text/plain',
        text: 'A server-persisted note',
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { result } = await response.json();
  const file = await request.get(`/api/files/${result.id}`);
  expect(await file.text()).toBe('A server-persisted note');
  expect((await request.get('/api/files/missing')).status()).toBe(404);
  const state = await (await request.get('/api/state')).json();
  expect(state.files.find((f: any) => f.id === result.id).text).toBe('A server-persisted note');
});
test('server rejects private browser navigation and preserves unreviewed external actions', async ({
  request,
}) => {
  const navigation = await request.post('/api/browser/navigate', {
    data: { url: 'http://127.0.0.1:5181' },
  });
  expect(navigation.status()).toBe(400);
  const response = await request.post('/api/command', {
    data: {
      action: 'mail.prepare',
      payload: {
        to: 'recipient@example.invalid',
        subject: 'Unreviewed test message',
        body: 'Never sent before review',
      },
    },
  });
  const { result } = await response.json();
  expect(result.status).toBe('pending');
  const state = await (await request.get('/api/state')).json();
  expect(state.mail.find((m: any) => m.subject === 'Unreviewed test message')).toBeUndefined();
});

test('an action review previews its frozen attachment after the workspace file changes', async ({
  page,
  request,
}) => {
  const added = await request.post('/api/command', {
    data: {
      action: 'file.add',
      payload: {
        name: 'review-snapshot.txt',
        mime: 'text/plain',
        text: 'Original reviewed attachment',
      },
    },
  });
  const file = (await added.json()).result;
  await request.post('/api/command', {
    data: {
      action: 'mail.prepare',
      payload: {
        to: 'review@example.invalid',
        subject: 'Frozen attachment check',
        body: 'Review the saved copy.',
        attachmentIds: [file.id],
      },
    },
  });
  await request.post('/api/command', {
    data: { action: 'file.edit', payload: { id: file.id, text: 'Later workspace edit' } },
  });
  await page.goto('/#activity');
  await page.getByRole('button', { name: /Send “Frozen attachment check”/ }).click();
  await page
    .locator('.workspace-page .approval-detail')
    .getByRole('button', { name: 'review-snapshot.txt', exact: true })
    .click();
  const preview = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'review-snapshot.txt', exact: true }) });
  await expect(preview.getByText('Original reviewed attachment', { exact: true })).toBeVisible();
  await expect(preview.getByText('Later workspace edit', { exact: true })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Edit text', exact: true })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await preview.getByRole('link', { name: 'Download', exact: true }).click();
  const saved = await download;
  const path = test.info().outputPath('review-snapshot.txt');
  await saved.saveAs(path);
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path, 'utf8')).toBe('Original reviewed attachment');
});

test('server refreshes preserve the reading position on a long workspace page', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await request.post('/api/command', {
    data: {
      action: 'routine.create',
      payload: {
        title: 'Viewport schedule',
        instructions: 'Read the current sources and keep their links.\n'.repeat(28),
        threadId: 'main',
        schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      },
    },
  });
  await page.goto('/#chat');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  const transcript = page.locator('.workspace-page-scroll');
  await expect(page.getByRole('article', { name: 'Viewport schedule' })).toBeVisible();
  await transcript.hover();
  await page.mouse.wheel(0, 5000);
  await expect
    .poll(async () => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  const before = await transcript.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(500);
  const changed = await request.post('/api/command', {
    data: { action: 'profile.update', payload: { assistantName: 'Scroll check' } },
  });
  expect(changed.ok()).toBeTruthy();
  await expect(
    page.getByRole('button', { name: 'Open assistant details', exact: true }),
  ).toContainText('Scroll check');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await transcript.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
  await request.post('/api/command', {
    data: { action: 'profile.update', payload: { assistantName: 'Relay' } },
  });
});

test('a background reply preserves the reading position and the jump control returns to live chat', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (let i = 0; i < 3; i++) {
    const response = await request.post('/api/command', {
      data: {
        action: 'chat.send',
        payload: {
          threadId: 'main',
          text:
            `Reading position example ${i}. ` +
            'A longer note that I want to be able to read without interruption. '.repeat(12),
        },
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/state')).json()).runs.filter((r: any) =>
          ['queued', 'running'].includes(r.status),
        ).length,
    )
    .toBe(0);
  await page.goto('/#chat');
  const transcript = page.locator('.messages');
  await transcript.hover();
  await page.mouse.wheel(0, -10000);
  const latest = page.getByRole('button', { name: 'Latest messages', exact: true });
  await expect(latest).toBeVisible();
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  const response = await request.post('/api/command', {
    data: {
      action: 'chat.send',
      payload: { threadId: 'main', text: 'Remember that I prefer the morning for planning' },
    },
  });
  expect(response.ok()).toBeTruthy();
  await expect(page.locator('.message.assistant').last()).toContainText('Memory saved');
  expect(await transcript.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  expect(await page.locator('.message.assistant').last().isVisible()).toBe(true);
});

test('desktop startup never falls back to demo storage when its server is slow or unavailable', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    (window as any).relayNative = {
      platform: 'darwin',
      ready() {},
      onCommand() {
        return () => {};
      },
    };
  });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/state', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/#chat');
  // Deliberately hold the response beyond the former 1.8-second fallback deadline.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await expect(page.getByText('Opening your workspace…')).toBeVisible();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Self-hosted sample', exact: true })).toBeVisible();
  await page.unroute('**/api/state');
  await page.route('**/api/state', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Your saved work stays on the server');
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Self-hosted sample', exact: true })).toBeVisible();
});

test('idle devices follow newer drafts without overwriting local offline edits', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const created = await (
    await request.post('/api/command', {
      data: { action: 'thread.create', payload: { title: 'Shared draft regression' } },
    })
  ).json();
  const id = created.result.id;
  const state = async () =>
    (await (await request.get('/api/state')).json()).threads.find((t: any) => t.id === id);
  const second = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const phone = await second.newPage();
    await page.goto('/#chat/' + id);
    await phone.goto('/#chat/' + id);
    const firstInput = page.getByLabel('Message Relay', { exact: true }),
      phoneInput = phone.getByLabel('Message Relay', { exact: true });
    await expect(firstInput).toHaveValue('');
    await expect(phoneInput).toHaveValue('');
    // A real local edit must become eligible for handoff after its save is
    // acknowledged, even though this editor originally authored the text.
    await firstInput.fill('Desktop starting draft');
    await expect(firstInput).toHaveValue('Desktop starting draft');
    await expect.poll(async () => (await state()).draft).toBe('Desktop starting draft');
    await expect(phoneInput).toHaveValue('Desktop starting draft');
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/command') && r.method() === 'POST') {
        const b = r.postDataJSON();
        if (b.action === 'thread.update' && Object.hasOwn(b.payload, 'draft'))
          writes.push(b.payload.draft);
      }
    });
    await phoneInput.fill('Newer phone draft');
    await expect.poll(async () => (await state()).draft).toBe('Newer phone draft');
    await expect(firstInput).toHaveValue('Newer phone draft');
    await page.goto('/#files');
    await page.goto('/#chat/' + id);
    await expect(firstInput).toHaveValue('Newer phone draft');
    expect(writes).toEqual([]);
    await second.setOffline(true);
    await phoneInput.fill('My unfinished offline phone edit');
    await expect(phone.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
    await request.post('/api/command', {
      data: { action: 'thread.update', payload: { id, draft: 'An update from another device' } },
    });
    await expect(firstInput).toHaveValue('An update from another device');
    await expect(phoneInput).toHaveValue('My unfinished offline phone edit');
    await second.setOffline(false);
    await expect.poll(async () => (await state()).draft).toBe('My unfinished offline phone edit');
    await expect(firstInput).toHaveValue('My unfinished offline phone edit');
    expect(writes).toEqual([]);
  } finally {
    await second.close();
  }
});
