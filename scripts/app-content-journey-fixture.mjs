import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { appContentFixture } from './app-content-fixture.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
export const contentAnswer =
  'Meet at noon, bring a book, and leave time for a quiet riverside walk. Your budget file is saved.';
export async function appContentJourneyFixture(directory, options = {}) {
  const remote = await appContentFixture({
      sse: !!options.sse,
      completions: !!options.completions,
    }),
    errors = [];
  const call = (name, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `content-${name}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let connectors;
  const f = await assistantsFixture(directory, {
    ...options,
    async configure(store, services) {
      connectors = services.connectors = new Connectors(store, { key: modelVaultKey(directory) });
      if (options.connected) {
        const found = await connectors.discover({
          name: 'Little library',
          endpoint: remote.endpoint,
        });
        connectors.save({
          discoveryId: found.discoveryId,
          permissions: Object.fromEntries(
            found.connection.tools.map((t) => [t.name, t.ownerChoice ? 'ask' : 'auto']),
          ),
        });
      }
    },
    respond({ messages }) {
      try {
        const all = JSON.stringify(messages);
        if (options.pickedTemplate && all.includes('Use the app template I explicitly selected')) {
          assert(all.includes(`Make a ${options.expectedMood || 'quiet'} plan.`));
          assert(all.includes('External actions still need their existing exact review'));
          return {
            role: 'assistant',
            content: 'Here is a gentle plan: bring a book and leave time for a riverside walk.',
          };
        }
        if (all.includes('Continue the original request using the confirmed result')) {
          assert(all.includes(`Make a ${options.expectedMood || 'quiet'} plan.`));
          assert(all.includes('sourceData'));
          return { role: 'assistant', content: contentAnswer };
        }
        const connection = connectors.publicState().connections[0];
        assert(connection);
        const outputs = messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content).result || {});
        const ordered = [
          connection.tools.find(
            (t) => t.kind === 'resource' && t.contentTarget.uri.includes('weekend'),
          ),
          connection.tools.find((t) => t.kind === 'resource-template'),
          connection.tools.find(
            (t) => t.kind === 'resource' && t.contentTarget.uri.includes('Budget.csv'),
          ),
          connection.tools.find((t) => t.kind === 'prompt'),
        ];
        for (const target of ordered) {
          if (outputs.some((o) => o.toolName === target.name)) continue;
          if (
            !outputs.some((o) => o.apps?.some((a) => a.tools.some((t) => t.name === target.name)))
          )
            return call('list_app_tools', { connectionId: connection.id, toolName: target.name });
          return call('use_app_tool', {
            connectionId: connection.id,
            revision: connection.revision,
            toolName: target.name,
            arguments:
              target.kind === 'resource-template'
                ? { day: '2026-10-12', tag: ['books', 'tea'] }
                : target.kind === 'prompt'
                  ? { mood: 'quiet' }
                  : {},
          });
        }
        throw Error('Fixture unexpectedly continued past a required prompt choice.');
      } catch (e) {
        errors.push(e.message);
        return { role: 'assistant', content: 'Fixture failed.' };
      }
    },
  });
  return {
    ...f,
    remote,
    errors,
    async close() {
      await f.close();
      await remote.close();
    },
  };
}
