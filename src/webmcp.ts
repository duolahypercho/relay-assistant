// Optional WebMCP tools share the interface's validated actions and state.
import { api } from './api';
function objectInput(input: unknown, allowed: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use an object input.');
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new Error(`Unexpected field: ${key}`);
  return input as Record<string, any>;
}
export function registerWorkspaceTools() {
  const context = (document as any).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools = [
    {
      name: 'read_workspace',
      title: 'Read workspace',
      description: 'Read a summary of goals, tasks, and pending reviews.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input: unknown) => {
        objectInput(input, []);
        const s = api.snapshot();
        return {
          mode: api.mode(),
          goals: s.goals
            .filter((g) => !g.archived)
            .map((g) => ({
              id: g.id,
              title: g.title,
              current: g.current,
              target: g.target,
              unit: g.unit,
            })),
          tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
          pendingReviews: s.approvals
            .filter((a) => a.status === 'pending')
            .map((a) => ({ id: a.id, title: a.title, kind: a.kind })),
        };
      },
    },
    {
      name: 'create_goal',
      title: 'Create a goal',
      description: 'Create a personal goal with a numeric target and optional description.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 140 },
          target: { type: 'number', minimum: 0 },
          unit: { type: 'string', minLength: 1, maxLength: 30 },
          description: { type: 'string', maxLength: 1000 },
        },
        required: ['title', 'target', 'unit'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const p = objectInput(input, ['title', 'target', 'unit', 'description']);
        if (
          typeof p.target !== 'number' ||
          !Number.isFinite(p.target) ||
          typeof p.unit !== 'string' ||
          !p.unit.trim()
        )
          throw new Error('Use a numeric target and a nonempty unit.');
        const result = await api.act('goal.create', p);
        return { id: result.id, title: result.title, target: result.target, unit: result.unit };
      },
    },
    {
      name: 'delegate_task',
      title: 'Delegate a task',
      description:
        'Delegate general, research, document, or finance work. External writes require a separate human review.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 180 },
          description: { type: 'string', maxLength: 4000 },
          kind: { type: 'string', enum: ['general', 'research', 'document', 'finance'] },
        },
        required: ['title', 'description', 'kind'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const p = objectInput(input, ['title', 'description', 'kind']);
        if (
          !['general', 'research', 'document', 'finance'].includes(p.kind) ||
          typeof p.description !== 'string'
        )
          throw new Error('Choose a supported task kind and a text description.');
        const result = await api.act('task.create', p);
        return { id: result.id, title: result.title, status: result.status };
      },
    },
  ];
  for (const tool of tools)
    try {
      void Promise.resolve(
        context.registerTool(
          {
            ...tool,
            execute: async (input: unknown) => {
              try {
                return {
                  content: [{ type: 'text', text: JSON.stringify(await tool.execute(input)) }],
                };
              } catch (e) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: e instanceof Error ? e.message : 'Invalid workspace action.',
                    },
                  ],
                };
              }
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    } catch {
      /* Experimental API support differs between browsers. */
    }
  return () => lifecycle.abort();
}
