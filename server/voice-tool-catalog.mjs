// SPDX-License-Identifier: MIT
// Voice and local Quick mode start with a compact index; discovery grants no permissions.
const lookupTools = new Set([
  'list_skills',
  'list_assistants',
  'list_groups',
  'list_routines',
  'list_files',
  'summarize_finance',
  'search_mail',
  'read_mail',
  'list_calendar',
]);
const core = new Set([
  'answer_question',
  'start_new_request',
  'ask_question',
  'show_workspace',
  'search_conversation',
  'read_conversation_message',
  'read_file',
  'read_selected_sources',
  'computer_files',
  'computer_export',
  'list_app_tools',
  'use_app_tool',
  'learn_memory',
  'remember',
  'forget_memory',
]);
const immediate = (tool) =>
  core.has(tool.name) || lookupTools.has(tool.name) || tool.name.startsWith('app_doc_');
const deferred = (tools) => tools.filter((tool) => !immediate(tool));
// This is a directory, not a replacement for any tool's full instructions.
// Group descriptions explain the available jobs once; exact names remain in
// both the directory and validated schema. Unknown capabilities keep their hint.
const groups = [
  [
    'Reusable methods',
    [
      'list_skills',
      'read_skill',
      'read_skill_file',
      'save_skill',
      'manage_skill',
      'computer_prepare_skill',
    ],
  ],
  [
    'Follow-ups',
    ['create_reminder', 'create_routine', 'list_routines', 'change_reminder', 'manage_routine'],
  ],
  [
    'Email and calendar',
    [
      'search_mail',
      'read_mail',
      'import_mail_attachment',
      'list_calendar',
      'prepare_email',
      'prepare_calendar',
    ],
  ],
  [
    'Web',
    ['read_web', 'search_web', 'browse_web', 'private_browser_look', 'private_browser_action'],
  ],
  [
    'Assistants, groups, tasks and goals',
    ['list_assistants', 'list_groups', 'ask_assistant', 'delegate_task', 'create_goal'],
  ],
  [
    'Files and media',
    [
      'list_files',
      'create_voice_memo',
      'read_video_frame',
      'transcribe_video',
      'fill_pdf_form',
      'read_pdf_page',
      'import_email_attachment',
    ],
  ],
  ['Editable results and text files', ['read_artifact', 'save_artifact', 'write_note']],
  ['Spending', ['summarize_finance']],
  [
    'Computer',
    [
      'prepare_command',
      'computer_status',
      'computer_open_website',
      'computer_start',
      'computer_look',
      'computer_use',
      'computer_run',
      'computer_job_start',
      'computer_job_input',
      'computer_job',
      'computer_edit_docx',
      'computer_import',
    ],
  ],
];
const hints = {
  list_skills: 'read saved methods',
  list_assistants: 'read saved specialist names and roles',
  list_routines: 'read saved reminders and routines',
  search_mail: 'search stored mail, also when disconnected',
  read_mail: 'read a stored message',
  list_calendar: 'read stored events, also when disconnected',
  create_reminder: 'fixed text',
  create_routine: 'scheduled assistant work',
  prepare_email: 'saved draft for review',
  prepare_calendar: 'change for review',
  delegate_task: 'durable background work',
  create_voice_memo: 'spoken audio',
  save_artifact: 'Word, Excel, PowerPoint or interactive pages',
  write_note: 'plain text or Markdown file',
  summarize_finance: 'read imported spending totals',
  prepare_command: 'workspace command for review',
};
function directory(tools) {
  const available = new Set(tools.map((tool) => tool.name));
  const assigned = new Set();
  const lines = groups.flatMap(([purpose, names]) => {
    const included = names.filter((name) => available.has(name));
    included.forEach((name) => assigned.add(name));
    return included.length
      ? [
          `${purpose}: ${included.map((name) => name + (hints[name] ? ` (${hints[name]})` : '')).join(', ')}`,
        ]
      : [];
  });
  for (const tool of tools) {
    if (!assigned.has(tool.name))
      lines.push(`${tool.name}: ${tool.description.split(/(?<=[.!?])\s/)[0].slice(0, 220)}`);
  }
  return lines.join('\n');
}
export function loadVoiceTools(tools, loaded, input) {
  // Older saved turns may still contain a load request for a lookup that is
  // now immediate. Acknowledge its current schema without running the lookup.
  // Current availability still comes exclusively from this request's tool set.
  const available = new Set(
    tools.filter((tool) => !immediate(tool) || lookupTools.has(tool.name)).map((tool) => tool.name),
  );
  if (
    !input ||
    Object.keys(input).some((key) => key !== 'names') ||
    !Array.isArray(input.names) ||
    !input.names.length ||
    input.names.length > 8 ||
    input.names.some((name) => typeof name !== 'string' || !available.has(name))
  )
    throw Error(
      'Choose one to eight exact names from the available tool catalog. Loading instructions does not execute any action.',
    );
  return [
    ...new Set([
      ...(Array.isArray(loaded) ? loaded : []).filter((name) => available.has(name)),
      ...input.names,
    ]),
  ];
}
export function voiceToolCatalog(tools, loaded = []) {
  const later = deferred(tools);
  if (!later.length) return tools;
  const selected = [...new Set(Array.isArray(loaded) ? loaded : [])];
  const load = {
    name: 'load_tools',
    description:
      'Load full instructions for available capabilities before using them. Choose all tools needed for the task together, up to eight; independent source reads may run in the same batch. The selected tools become available in the next model step and remain loaded for this request. This is internal discovery: no owner interaction, permission change or action execution. Available catalog: ' +
      directory(later),
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', enum: later.map((tool) => tool.name) },
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    strict: false,
  };
  return [
    load,
    ...tools.filter(immediate),
    ...selected.flatMap((name) => later.filter((tool) => tool.name === name)),
  ];
}
