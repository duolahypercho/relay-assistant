// SPDX-License-Identifier: MIT
// Disposable child used to prove recovery after a real owner-process crash.
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
const directory = process.argv[2];
const store = new Store(join(directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
const transport = computer.stdio.transport({
  command: 'python3',
  args: ['/workspace/local-tools.py'],
  cwd: '/workspace',
  env: {},
});
const client = new Client({ name: 'Relay acceptance crash', version: '1' }, { capabilities: {} });
await client.connect(transport);
process.send?.({ ready: true });
await client.callTool({ name: 'slow_write', arguments: {} }, undefined, { timeout: 75000 });
await client.close();
store.close();
