// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { connectorFixture } from './connectors-fixture.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { command } from '../shared/domain.mjs';
export const mentionsFinal = 'Saved the calmer Sunday plan to Little notebook.';
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: `mention-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
export async function appMentionsFixture(directory, { tls } = {}) {
  const remote = await connectorFixture();
  const errors = [];
  let selected, other, writer, group, connectors;
  const f = await assistantsFixture(directory, {
    tls,
    async configure(store, services) {
      connectors = services.connectors = new Connectors(store, { key: modelVaultKey(directory) });
      writer = store.mutate((s) =>
        command(s, 'assistant.create', { name: 'Mochi', instructions: 'Help with writing.' }),
      );
      group = store.mutate((s) =>
        command(s, 'group.create', { title: 'Little team', participantIds: ['relay', writer.id] }),
      );
      for (const name of ['Little notebook', 'Other notebook', 'Writer only', 'Paused app']) {
        const discovered = await connectors.discover({
          name,
          endpoint: remote.endpoint,
          token: remote.token,
        });
        connectors.save({
          discoveryId: discovered.discoveryId,
          permissions: { find_note: 'auto', save_note: 'ask' },
          assistantIds: name === 'Writer only' ? [writer.id] : null,
        });
      }
      const list = connectors.chatCatalog();
      [selected, other] = list;
      connectors.update({ id: list[3].id, revision: list[3].revision, enabled: false });
    },
    respond({ messages }) {
      try {
        selected = connectors.chatCatalog().find((a) => a.id === selected.id);
        const system = messages.find((m) => m.role === 'system').content;
        assert.ok(
          system.includes(selected.id),
          'The selected app must reach the actual HTTP model',
        );
        assert.ok(system.includes('Use only these apps'), 'Selection is scoped to this request');
        assert.ok(!system.includes(other.id), 'An unselected app is not part of this request');
        if (
          JSON.stringify(messages).includes(
            'Continue the original request using the confirmed result',
          )
        )
          return { role: 'assistant', content: mentionsFinal };
        const outputs = messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content).result || {});
        const listing = outputs.find((o) => o.apps);
        if (!listing) return tool('list_app_tools', {});
        assert.deepEqual(
          listing.apps.map((a) => a.id),
          [selected.id],
        );
        if (!outputs.some((o) => o.toolName === 'find_note'))
          return tool('use_app_tool', {
            connectionId: selected.id,
            revision: selected.revision,
            toolName: 'find_note',
            arguments: { topic: 'Sunday' },
          });
        if (!outputs.some((o) => o.apps?.[0]?.tools?.[0]?.name === 'save_note'))
          return tool('list_app_tools', { connectionId: selected.id, toolName: 'save_note' });
        return tool('use_app_tool', {
          connectionId: selected.id,
          revision: selected.revision,
          toolName: 'save_note',
          arguments: { title: 'Sunday', body: 'A slow morning and a walk by the water.' },
        });
      } catch (error) {
        errors.push(error.message);
        throw error;
      }
    },
  });
  return {
    ...f,
    remote,
    errors,
    writer,
    group,
    get selected() {
      return connectors.chatCatalog().find((a) => a.id === selected.id);
    },
    other,
    async close() {
      await f.close();
      connectors.close();
      await remote.close();
    },
  };
}
