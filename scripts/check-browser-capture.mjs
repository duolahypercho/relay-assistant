// SPDX-License-Identifier: MIT
// Synthetic microphone capability check: no physical microphone or user workspace.
import assert from 'node:assert/strict';
const results = [];
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
const server = createServer((req, res) =>
  res.end('<!doctype html><button>Capture</button>'),
).listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  for (const channel of [undefined, 'chromium']) {
    const browser = await chromium.launch({
      headless: true,
      channel,
      args: ['--use-fake-device-for-media-stream'],
    });
    try {
      const context = await browser.newContext({ permissions: ['microphone'] });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = {
        channel: channel || 'headless shell',
        result: await page.evaluate(async () => {
          let stream;
          try {
            const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].map(
              (m) => [m, MediaRecorder.isTypeSupported(m)],
            );
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            const recorder = new MediaRecorder(stream, {
              mimeType: formats.find((f) => f[1])[0],
              audioBitsPerSecond: 64000,
            });
            const bytes = await new Promise((resolve, reject) => {
              let total = 0;
              recorder.ondataavailable = (e) => (total += e.data.size);
              recorder.onerror = reject;
              recorder.onstop = () => resolve(total);
              recorder.start(250);
              setTimeout(() => recorder.stop(), 1000);
            });
            return { formats, bytes };
          } catch (e) {
            return { name: e.name, message: e.message };
          } finally {
            stream?.getTracks().forEach((t) => t.stop());
          }
        }),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}

assert(
  results.every((r) => r.result.bytes > 12),
  'The hosted browser could not record synthetic audio; inspect the capability results above.',
);
