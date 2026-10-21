// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { localOllamaConnection } from '../shared/model-catalog.mjs';

const normalized = 'normalized_1000';
const axes = { x: 1280, y: 800, toX: 1280, toY: 800 };

// Qwen's documented grounding convention differs from the desktop's pixels.
// Scope automatic adaptation to identified local vision models; custom aliases
// and other providers keep their existing contract and can opt in per action.
export function computerCoordinateMode(provider, capabilities, tools) {
  return localOllamaConnection(provider) &&
    capabilities.source === 'ollama' &&
    capabilities.vision === true &&
    /^(?:qwen3\.5|qwen3-vl)(?::|$)/i.test(provider.model || '') &&
    tools.some((tool) => tool.name === 'computer_use')
    ? normalized
    : undefined;
}

export function computerCoordinateTools(tools, mode) {
  if (!mode) return tools;
  return tools.map((tool) =>
    tool.name !== 'computer_use'
      ? tool
      : {
          ...tool,
          description: `${tool.description} For this connection, x/y/toX/toY use a 0–1000 normalized screen: (0,0) is the top-left, (1000,1000) is the bottom-right. The host converts to desktop pixels. Use this normalized scale directly.`,
          parameters: {
            ...tool.parameters,
            properties: {
              ...tool.parameters.properties,
              ...Object.fromEntries(
                Object.keys(axes).map((key) => [
                  key,
                  {
                    type: 'number',
                    minimum: 0,
                    maximum: 1000,
                    description: `${key.endsWith('X') || key === 'x' ? 'Horizontal' : 'Vertical'} position on the normalized 0–1000 screen.`,
                  },
                ]),
              ),
              coordinateSpace: { type: 'string', enum: [normalized] },
            },
          },
        },
  );
}

// Persist the actual responding connection's contract on its tool call. This
// survives fallback, queued execution and restart without guessing from numbers.
export function tagComputerCoordinates(result, mode) {
  if (!mode) return result;
  return {
    ...result,
    toolCalls: result.toolCalls.map((call) => {
      if (call.function?.name !== 'computer_use') return call;
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return call;
      }
      if (!args || Array.isArray(args) || typeof args !== 'object') return call;
      if (args.coordinateSpace !== undefined && args.coordinateSpace !== mode)
        throw Error(
          'The model returned a computer action with conflicting coordinate units. No action was performed.',
        );
      return {
        ...call,
        function: {
          ...call.function,
          arguments: JSON.stringify({ ...args, coordinateSpace: mode }),
        },
      };
    }),
  };
}

export function computerOperationId(value, toolOperationId) {
  if (value !== undefined) return value;
  if (typeof toolOperationId === 'string' && toolOperationId)
    return 'tool-' + createHash('sha256').update(toolOperationId).digest('hex');
}

export function desktopInput(input, toolOperationId) {
  const { coordinateSpace = 'pixels', ...result } = input;
  // The worker already owns a durable identity for each tool call. Models may
  // omit this bookkeeping field; explicit retry IDs keep their old semantics.
  if (input.operationId === undefined && typeof toolOperationId === 'string' && toolOperationId)
    result.operationId = computerOperationId(input.operationId, toolOperationId);
  if (input.action === 'type' && Object.keys(axes).some((key) => input[key] !== undefined))
    throw Error(
      'Typing uses current keyboard focus. Click the target field or press Tab first, then call type with text and no coordinates.',
    );
  if (input.action === 'key') result.key = desktopShortcut(input.key);
  if (coordinateSpace === 'pixels') return result;
  if (coordinateSpace !== normalized)
    throw Error('Choose pixels or normalized_1000 for computer coordinates.');
  const required = ['click', 'double_click', 'right_click', 'move', 'drag'].includes(input.action)
    ? input.action === 'drag'
      ? ['x', 'y', 'toX', 'toY']
      : ['x', 'y']
    : [];
  for (const [key, size] of Object.entries(axes)) {
    const value = input[key];
    if (value === undefined && !required.includes(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000)
      throw Error(`${key} must be a finite coordinate from 0 to 1000.`);
    result[key] = Math.min(size - 1, Math.round((value * size) / 1000));
  }
  return result;
}

// Model providers use both browser key names and X11 names. Canonicalize only
// a single allowlisted chord; never pass arbitrary key sequences to xdotool.
function desktopShortcut(value) {
  const parts = typeof value === 'string' ? value.split('+') : [];
  const raw = parts.pop();
  const names = {
    enter: 'Return',
    return: 'Return',
    tab: 'Tab',
    esc: 'Escape',
    escape: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    left: 'Left',
    arrowleft: 'Left',
    right: 'Right',
    arrowright: 'Right',
    up: 'Up',
    arrowup: 'Up',
    down: 'Down',
    arrowdown: 'Down',
    home: 'Home',
    end: 'End',
    pageup: 'Prior',
    prior: 'Prior',
    pagedown: 'Next',
    next: 'Next',
    space: 'space',
    spacebar: 'space',
  };
  const key =
    raw &&
    ((Object.hasOwn(names, raw.toLowerCase()) && names[raw.toLowerCase()]) ||
      (/^[a-zA-Z0-9]$/.test(raw)
        ? raw
        : /^f(?:[1-9]|1[0-2])$/i.test(raw)
          ? raw.toUpperCase()
          : ''));
  const modifiers = parts.map((p) => (p.toLowerCase() === 'control' ? 'ctrl' : p.toLowerCase()));
  if (
    !key ||
    modifiers.length > 3 ||
    new Set(modifiers).size !== modifiers.length ||
    modifiers.some((p) => !['ctrl', 'alt', 'shift', 'super'].includes(p))
  )
    throw Error('Unsupported key. Use one key or chord, such as Tab, Enter, Backspace, or ctrl+a.');
  return [...modifiers, key].join('+');
}
