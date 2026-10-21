// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  desktopInput,
  computerCoordinateMode,
  computerCoordinateTools,
  tagComputerCoordinates,
} from '../server/computer-coordinates.mjs';
import { ModelProvider } from '../server/model.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { toolDefinitions, executeTool } from '../server/agent.mjs';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';

const mode = 'normalized_1000';
const local = { protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:27b' };
const caps = { source: 'ollama', vision: true, tools: true };
const tools = toolDefinitions.filter((t) => ['computer_use', 'computer_look'].includes(t.name));
const call = (args) => ({
  id: 'click-1',
  type: 'function',
  function: { name: 'computer_use', arguments: JSON.stringify(args) },
});

test('normalized desktop coordinates cover rectangular screens, edges, drag endpoints and observed Qwen grounding', () => {
  assert.deepEqual(desktopInput({ action: 'click', x: 378, y: 342, coordinateSpace: mode }), {
    action: 'click',
    x: 484,
    y: 274,
  });
  assert.deepEqual(
    desktopInput({ action: 'drag', x: 0, y: 0, toX: 1000, toY: 1000, coordinateSpace: mode }),
    { action: 'drag', x: 0, y: 0, toX: 1279, toY: 799 },
  );
  assert.deepEqual(desktopInput({ action: 'move', x: 500, y: 500, coordinateSpace: mode }), {
    action: 'move',
    x: 640,
    y: 400,
  });
  for (const action of [
    { action: 'click', x: 700, y: 400 },
    { action: 'type', text: 'hello' },
    { action: 'key', key: 'Return' },
    { action: 'scroll', direction: 'down' },
  ]) {
    assert.deepEqual(desktopInput(action), action);
    assert.deepEqual(desktopInput({ ...action, coordinateSpace: 'pixels' }), action);
    if (!('x' in action))
      assert.deepEqual(desktopInput({ ...action, coordinateSpace: mode }), action);
  }
  for (const x of [undefined, null, '300', NaN, Infinity, -1, 1001])
    assert.throws(
      () => desktopInput({ action: 'click', x, y: 30, coordinateSpace: mode }),
      /finite coordinate/,
    );
  assert.throws(
    () => desktopInput({ action: 'drag', x: 0, y: 0, coordinateSpace: mode }),
    /finite coordinate/,
  );
  assert.throws(() => desktopInput({ coordinateSpace: 'percent' }), /Choose pixels/);
});

test('automatic grounding is limited to identified local Qwen vision models and does not mutate shared tools', () => {
  assert.equal(computerCoordinateMode(local, caps, tools), mode);
  assert.equal(computerCoordinateMode({ ...local, model: 'qwen3-vl:8b' }, caps, tools), mode);
  for (const model of ['qwen2.5vl:7b', 'qwen3:8b', 'custom', 'qwen3.5-other'])
    assert.equal(computerCoordinateMode({ ...local, model }, caps, tools), undefined);
  assert.equal(
    computerCoordinateMode({ ...local, baseUrl: 'https://example.com/v1' }, caps, tools),
    undefined,
  );
  for (const capabilities of [{}, { ...caps, vision: false }, { ...caps, source: 'unknown' }])
    assert.equal(computerCoordinateMode(local, capabilities, tools), undefined);
  assert.equal(computerCoordinateMode(local, caps, []), undefined);
  const before = structuredClone(tools);
  const adapted = computerCoordinateTools(tools, mode);
  assert.deepEqual(tools, before);
  assert.equal(computerCoordinateTools(tools), tools);
  assert.deepEqual(
    adapted.find((t) => t.name === 'computer_use').parameters.properties.coordinateSpace.enum,
    [mode],
  );
  assert.equal(
    adapted.find((t) => t.name === 'computer_look'),
    tools.find((t) => t.name === 'computer_look'),
  );
});

test('model keyboard aliases preserve one bounded shortcut without accepting arbitrary key sequences', () => {
  const aliases = {
    backspace: 'BackSpace',
    Backspace: 'BackSpace',
    ENTER: 'Return',
    'Shift+Tab': 'shift+Tab',
    'Control+a': 'ctrl+a',
    'CTRL+SHIFT+ArrowLeft': 'ctrl+shift+Left',
    PageDown: 'Next',
    Escape: 'Escape',
    F12: 'F12',
    'alt+f4': 'alt+F4',
    'super+r': 'super+r',
    A: 'A',
  };
  for (const coordinateSpace of ['pixels', mode]) {
    for (const [key, expected] of Object.entries(aliases)) {
      const input = { action: 'key', key, coordinateSpace };
      assert.equal(desktopInput(input).key, expected);
      assert.equal(input.key, key);
    }
    for (const key of [
      undefined,
      null,
      13,
      '',
      '\b',
      'ctrl+a Return',
      'Return;id',
      '--clearmodifiers',
      'ctrl++a',
      'ctrl+ctrl+a',
      'ctrl+alt+shift+super+a',
      'F13',
      'unknown',
      'constructor',
      '__proto__',
    ])
      assert.throws(() => desktopInput({ action: 'key', key, coordinateSpace }), /Unsupported key/);
  }
  assert.deepEqual(desktopInput({ action: 'type', text: 'backspace' }), {
    action: 'type',
    text: 'backspace',
  });
});

test('actual provider wire binds its coordinate contract to returned calls and rejects contradictory units', async () => {
  const requests = [];
  let args = { operationId: 'select-passport', action: 'click', x: 378, y: 342 };
  const make = (record, capabilities) =>
    new ModelProvider({
      ...record,
      getCapabilities: async () => capabilities,
      fetcher: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return Response.json({
          choices: [
            { message: { content: '', tool_calls: [call(args)] }, finish_reason: 'tool_calls' },
          ],
        });
      },
    });
  const provider = make(local, caps);
  const result = await provider.complete([{ role: 'user', content: 'Select Passport.' }], tools);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    ...args,
    coordinateSpace: mode,
  });
  assert.deepEqual(
    requests[0].tools.find((t) => t.function.name === 'computer_use').function.parameters.properties
      .coordinateSpace.enum,
    [mode],
  );
  const hosted = await make({ ...local, baseUrl: 'https://example.com/v1' }, caps).complete(
    [],
    tools,
  );
  assert.deepEqual(JSON.parse(hosted.toolCalls[0].function.arguments), args);
  // A queued call retains the actual responding provider's contract even when
  // the currently selected provider is different, e.g. after fallback/restart.
  assert.deepEqual(
    desktopInput(
      JSON.parse(JSON.stringify(result)).toolCalls.map((c) => JSON.parse(c.function.arguments))[0],
    ),
    { ...args, x: 484, y: 274 },
  );
  args = { ...args, coordinateSpace: 'pixels' };
  await assert.rejects(provider.complete([], tools), /conflicting coordinate units/);
  const malformed = {
    toolCalls: [{ ...call({}), function: { name: 'computer_use', arguments: '{bad' } }],
  };
  assert.deepEqual(tagComputerCoordinates(malformed, mode), malformed);
});

test('agent converts before computer input, rejects invalid coordinates without input, and respects owner takeover', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.inspect = async () => null;
  computer.runtime.pause = async () => {};
  const actions = [];
  computer.perform = async (input, options) => {
    options.guard();
    actions.push(input);
    return { screenshot: 'screen', width: 1280, height: 800 };
  };
  try {
    const input = {
      operationId: 'select-passport',
      action: 'click',
      x: 378,
      y: 342,
      coordinateSpace: mode,
    };
    const result = await executeTool(store, 'computer_use', input, { computer });
    assert.equal(result.image, 'data:image/jpeg;base64,screen');
    assert.deepEqual(actions, [
      { operationId: 'select-passport', action: 'click', x: 484, y: 274, kind: 'desktop' },
    ]);
    await assert.rejects(
      executeTool(store, 'computer_use', { ...input, x: 1001 }, { computer }),
      /finite coordinate/,
    );
    for (const coordinateSpace of ['pixels', mode])
      await assert.rejects(
        executeTool(
          store,
          'computer_use',
          { ...input, coordinateSpace, action: 'type', text: 'Wrong field' },
          { computer },
        ),
        /current keyboard focus/,
      );
    await computer.takeControl();
    await assert.rejects(
      executeTool(store, 'computer_use', input, { computer }),
      /owner has taken control/,
    );
    assert.equal(actions.length, 1);
  } finally {
    store.close();
  }
});

test('a fallback binds desktop units to the provider that actually answered in either direction', async () => {
  for (const localBackup of [true, false]) {
    const store = new Store(':memory:', { sample: false });
    const wire = [];
    const records = [
      local,
      { protocol: 'chat', baseUrl: 'https://hosted.example/v1', model: 'hosted' },
    ];
    if (localBackup) records.reverse();
    const models = new ModelConnections(store, {
      key: Buffer.alloc(32, 7),
      fetcher: async (url, init) => {
        if (url.endsWith('/api/show'))
          return Response.json({ capabilities: ['completion', 'tools', 'vision'] });
        const body = JSON.parse(init.body);
        wire.push(body);
        if (body.model === records[0].model) return Response.json({}, { status: 503 });
        return Response.json({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [call({ action: 'click', x: 500, y: 500, operationId: 'click-1' })],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      },
    });
    try {
      const primary = models.save({ ...records[0], preset: 'custom' }).id;
      const backup = models.save({ ...records[1], preset: 'custom' }).id;
      models.setFallbacks(primary, [backup]);
      store.mutate((s) => s.runs.push({ id: 'coordinate-run', status: 'running' }));
      const result = await models
        .forRun(store.read().runs[0])
        .complete([{ role: 'user', content: 'Click the center.' }], tools);
      const args = JSON.parse(result.toolCalls[0].function.arguments);
      assert.equal(args.coordinateSpace, localBackup ? mode : undefined);
      assert.equal(desktopInput(args).x, localBackup ? 640 : 500);
      assert.equal(models.publicState().active, primary);
      assert.deepEqual(
        wire.map((r) => r.model),
        records.map((r) => r.model),
      );
    } finally {
      store.close();
    }
  }
});

test('omitted desktop action IDs use the worker call identity while explicit and replayed IDs keep their semantics', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  let dispatched = 0;
  computer.requireRunning = async () => ({});
  computer.rpc = async () => {
    dispatched++;
    return { accepted: true };
  };
  const action = { action: 'click', x: 100, y: 120 };
  assert.equal(
    desktopInput(action).operationId,
    undefined,
    'A caller without worker context cannot invent a receipt identity.',
  );
  const id = desktopInput(action, 'bound-call-1').operationId;
  assert.match(id, /^tool-[a-f0-9]{64}$/);
  assert.notEqual(desktopInput(action, 'bound-call-2').operationId, id);
  assert.equal(
    desktopInput({ ...action, operationId: 'explicit' }, 'bound-call-1').operationId,
    'explicit',
  );
  try {
    const services = { computer, operationId: 'bound-call-1', runId: 'request-1' };
    const first = await executeTool(store, 'computer_use', action, services);
    assert.equal(first.result.retryOperationId, id);
    assert.equal(
      (
        await executeTool(
          store,
          'computer_use',
          { ...action, operationId: first.result.retryOperationId },
          { ...services, operationId: 'new-model-retry-call' },
        )
      ).result.repeated,
      true,
    );
    assert.equal(
      (await executeTool(store, 'computer_use', action, services)).result.repeated,
      true,
    );
    assert.equal(dispatched, 1);
    await assert.rejects(
      executeTool(store, 'computer_use', { ...action, x: 101 }, services),
      /different action/,
    );
    await executeTool(store, 'computer_use', action, { ...services, operationId: 'bound-call-2' });
    assert.equal(dispatched, 2);
    const schema = toolDefinitions.find((t) => t.name === 'computer_use');
    assert(!schema.parameters.required.includes('operationId'));
  } finally {
    store.close();
  }
});

test('worker-owned file and command IDs support exact replay and reject a changed action without model bookkeeping', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.requireRunning = async () => ({});
  computer.runtime.ensure = async () => {};
  let dispatched = 0;
  computer.rpc = async () => {
    dispatched++;
    return { accepted: true, stdout: 'done', stderr: '', exitCode: 0 };
  };
  try {
    for (const [name, input] of [
      ['computer_files', { action: 'write', path: '/workspace/brief.md', text: 'noon' }],
      ['computer_files', { action: 'mkdir', path: '/workspace/notes' }],
      ['computer_run', { command: 'printf done' }],
    ]) {
      const before = dispatched,
        context = { computer, runId: 'file-and-command-run', operationId: 'durable-' + before };
      const first = await executeTool(store, name, input, context);
      assert.match(first.result.retryOperationId, /^tool-[a-f0-9]{64}$/);
      assert((await executeTool(store, name, input, context)).result.repeated);
      assert(
        (
          await executeTool(
            store,
            name,
            { ...input, operationId: first.result.retryOperationId },
            { ...context, operationId: 'explicit-retry-' + before },
          )
        ).result.repeated,
      );
      assert.equal(dispatched, before + 1);
      const changed =
        name === 'computer_run'
          ? { ...input, command: 'printf changed' }
          : { ...input, path: '/workspace/different' };
      await assert.rejects(executeTool(store, name, changed, context), /different action/);
      await assert.rejects(
        executeTool(store, name, { ...input, operationId: '' }, context),
        /operation ID/,
      );
      await assert.rejects(
        executeTool(store, name, input, { computer, runId: context.runId }),
        /operation ID/,
      );
      assert.equal(dispatched, before + 1);
    }
    assert(
      !toolDefinitions
        .find((t) => t.name === 'computer_run')
        .parameters.required.includes('operationId'),
    );
  } finally {
    store.close();
  }
});
