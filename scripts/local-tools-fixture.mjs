// SPDX-License-Identifier: MIT
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { stdioFixture } from './stdio-fixture.mjs';
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: `local-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});
export async function localToolsFixture(directory, options = {}) {
  let computer, connectors;
  const f = await assistantsFixture(directory, {
    ...options,
    async configure(store, services) {
      computer = new PrivateComputer(store, { enabled: true, deployment: directory });
      connectors = new Connectors(store, { key: modelVaultKey(directory), computer });
      services.computer = computer;
      services.connectors = connectors;
      await computer.start();
      await computer.perform({
        kind: 'files',
        action: 'write',
        path: 'local-tools.py',
        base64: Buffer.from(stdioFixture).toString('base64'),
        operationId: 'local-fixture',
      });
    },
    respond({ messages }) {
      if (
        JSON.stringify(messages).includes(
          'Continue the original request using the confirmed result',
        )
      )
        return { role: 'assistant', content: 'Your local note is saved.' };
      const connection = connectors.read()[0];
      const outputs = messages
        .filter((m) => m.role === 'tool')
        .map((m) => {
          try {
            return JSON.parse(m.content).result || {};
          } catch {
            return {};
          }
        });
      if (!outputs.some((o) => o.apps))
        return tool('list_app_tools', { connectionId: connection.id, toolName: 'read_note' });
      if (!outputs.some((o) => o.toolName === 'read_note'))
        return tool('use_app_tool', {
          connectionId: connection.id,
          revision: connection.revision,
          toolName: 'read_note',
          arguments: {},
        });
      if (!outputs.some((o) => o.apps?.[0]?.tools?.[0]?.name === 'save_note'))
        return tool('list_app_tools', { connectionId: connection.id, toolName: 'save_note' });
      return tool('use_app_tool', {
        connectionId: connection.id,
        revision: connection.revision,
        toolName: 'save_note',
        arguments: { text: 'A quiet Sunday, saved by the local tool.' },
      });
    },
  });
  return {
    ...f,
    computer,
    connectors,
    async close() {
      await f.worker.stop();
      connectors.close();
      await computer.stop();
      await computer.checked(['rm', '-f', computer.name]);
      for (const volume of [computer.volume, computer.displayVolume])
        await computer.checked(['volume', 'rm', volume]);
      await f.close();
    },
  };
}
