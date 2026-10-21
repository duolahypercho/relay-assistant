// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverURL, navigationKind, clipboardText } from '../native/desktop/urls.mjs';
test('native server connection rejects executable, credential-bearing and ambiguous destinations', () => {
  assert.equal(serverURL(' https://relay.example.com/ '), 'https://relay.example.com');
  assert.equal(serverURL('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://remote.example',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?token=x',
    'https://example.com/#x',
  ])
    assert.throws(() => serverURL(url));
  assert.equal(
    navigationKind('https://relay.example.com/api/state', 'https://relay.example.com'),
    'workspace',
  );
  assert.equal(
    navigationKind('https://accounts.google.com/o/oauth2/v2/auth', 'https://relay.example.com'),
    'google',
  );
  assert.equal(
    navigationKind('https://relay.example.com.evil.invalid', 'https://relay.example.com'),
    'external',
  );
  assert.equal(navigationKind('file:///etc/passwd', 'https://relay.example.com'), 'blocked');
});

test('native clipboard writes accept bounded text only from the workspace URL', () => {
  assert.equal(
    clipboardText('A useful reply', 'https://relay.example/#chat', 'https://relay.example'),
    'A useful reply',
  );
  for (const url of [
    'https://other.example/',
    'https://relay.example/share/assistant/x',
    'file:///tmp/result.html',
    'data:text/html,hi',
  ])
    assert.throws(
      () => clipboardText('text', url, 'https://relay.example'),
      /main Relay workspace/,
    );
  assert.throws(
    () => clipboardText('界'.repeat(333334), 'https://relay.example/', 'https://relay.example'),
    /1 MB/,
  );
  assert.throws(
    () => clipboardText({ text: 'object' }, 'https://relay.example/', 'https://relay.example'),
    /plain text/,
  );
});

test('server setup rejects browser-blocked ports before navigation or a connection-link exchange', async () => {
  const { blockedWebPorts, blockedPortMessage } = await import('../shared/web-ports.mjs');
  const { connectionInput } = await import('../shared/device-link.mjs');
  for (const port of blockedWebPorts) {
    const address = `https://relay.example:${port}/`;
    assert.throws(() => serverURL(address), { message: blockedPortMessage });
    assert.throws(() => connectionInput(address + '#connect=' + 'a'.repeat(43)), {
      message: blockedPortMessage,
    });
  }
  assert.equal(serverURL('https://relay.example:8443/'), 'https://relay.example:8443');
});
