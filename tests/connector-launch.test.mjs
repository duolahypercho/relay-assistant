// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorLaunch, redactConnection } from '../server/connector-launch.mjs';
import { publicConnection } from '../server/connector-oauth.mjs';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { randomBytes } from 'node:crypto';

test('local program config preserves literal arguments and requires workspace folders', () => {
  const launch = connectorLaunch({
    command: 'python3',
    args: ['file with spaces.py', '$(not a shell)', '你好'],
    cwd: 'tools',
    env: { EXPLICIT: 'value' },
  });
  assert.equal(launch.cwd, '/workspace/tools');
  assert.equal(launch.args[1], '$(not a shell)');
  assert.equal(
    connectorLaunch({ command: '/workspace/my tools/server' }).command,
    '/workspace/my tools/server',
  );
  for (const input of [
    { command: 'python3 server.py' },
    { command: 'x', cwd: '../../etc' },
    { command: 'x', args: ['bad\0'] },
    { command: 'x', env: { 'bad key': 'x' } },
    { command: 'x', env: { V: 'x'.repeat(9000) } },
    { command: 'x', args: Array(101).fill('a') },
  ])
    assert.throws(() => connectorLaunch(input));
});
test('saved secrets remain bound to exact program, arguments and folder, with explicit removal', () => {
  const prior = connectorLaunch({
    command: 'node',
    args: ['/workspace/tool.js'],
    env: { TOKEN: 'secret' },
  });
  assert.equal(connectorLaunch({ ...prior, env: { TOKEN: null } }, prior).env.TOKEN, 'secret');
  for (const change of [{ command: 'python3' }, { args: ['other'] }, { cwd: '/workspace/other' }])
    assert.throws(
      () => connectorLaunch({ ...prior, ...change, env: { TOKEN: null } }, prior),
      /Re-enter/,
    );
  assert.deepEqual(connectorLaunch({ ...prior, env: {} }, prior).env, {});
  assert.equal(
    connectorLaunch({ ...prior, command: 'python3', env: { TOKEN: 'new' } }, prior).env.TOKEN,
    'new',
  );
});
test('owner views omit environment values; returned text, keys and structured data redact them', () => {
  const record = {
    id: 'tool',
    transport: 'stdio',
    launch: connectorLaunch({
      command: 'node',
      env: { TOKEN: 'private-long-secret', ALSO: 'private' },
    }),
    token: '',
  };
  const view = publicConnection(record);
  assert.deepEqual(view.launch.envKeys, ['TOKEN', 'ALSO']);
  assert(!JSON.stringify(view).includes('private'));
  assert.deepEqual(
    redactConnection(
      { ['private-long-secret']: ['private-long-secret', { value: 'private' }] },
      record,
    ),
    { '[redacted]': ['[redacted]', { value: '[redacted]' }] },
  );
});
test('local discovery requires explicit launch and an enabled computer; it saves no connection on failure', async () => {
  const store = new Store(':memory:', { sample: false });
  const connectors = new Connectors(store, { key: randomBytes(32) });
  const input = {
    transport: 'stdio',
    launch: { command: 'python3', args: ['/workspace/tool.py'] },
  };
  try {
    await assert.rejects(connectors.prepare(input), /Review the program/);
    await assert.rejects(
      connectors.prepare({ ...input, launchApproved: true }),
      /Set up and start/,
    );
    assert.deepEqual(connectors.read(), []);
    assert.equal(connectors.discoveries.size, 0);
  } finally {
    connectors.close();
    store.close();
  }
});
