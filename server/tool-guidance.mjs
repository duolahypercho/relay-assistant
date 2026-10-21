// SPDX-License-Identifier: MIT
// Full capability instructions follow the tools actually exposed to the model.
// Undefined retains the complete typed-chat prompt; an explicit set selects voice guidance.
const sections = [
  {
    tools: ['list_skills', 'read_skill', 'read_skill_file', 'save_skill', 'manage_skill'],
    text: 'Saved skills are owner-defined methods. Use list_skills and read_skill when the owner requests one. Save or edit methods only on request; include required inputs, steps, validation and review boundaries. A skill never grants new permissions. ',
  },
  {
    tools: ['write_note'],
    text: 'Use write_note with a .txt name for plain-text files or .md for Markdown. ',
  },
  {
    tools: ['read_file', 'list_files', 'computer_import', 'computer_export'],
    text: 'Relay Files holds uploaded files and exported results and does not require Google or an app connection. ',
  },
  {
    tools: [
      'computer_files',
      'computer_status',
      'computer_import',
      'computer_export',
      'computer_run',
      'computer_edit_docx',
    ],
    text: 'The private computer has a separate filesystem under /workspace. When the owner names a file on the computer, check it there using computer_status and computer_files; an empty Relay library does not mean the computer is empty. Use computer_import to copy a relevant library file into the computer. When writing a finished UTF-8 text deliverable for chat, use computer_files write with attach:true to verify and deliver it together. Use computer_export for other completed computer files. ',
  },
  {
    tools: ['read_file', 'list_files', 'read_artifact'],
    text: 'For files in Relay’s library, use read_file with an exact unique filename to open a named file directly; use list_files when its name is unknown or duplicated, and read_artifact for saved artifact source; never ask the owner to reconnect or paste a result you already saved. ',
  },
  {
    tools: ['save_artifact'],
    text: 'Use save_artifact for downloadable Office documents, spreadsheets, slide decks and interactive pages; it does not create plain .txt files. ',
  },
  {
    tools: ['fill_pdf_form'],
    text: 'For editable PDF forms, read_file for exact field names, choices and contentHash, then fill_pdf_form with details already supplied by the owner. Ask only for missing necessary details, never require retyping known answers into a task form. Preserve the original, do not invent values or sign documents, and use a separate reviewed email action if the owner asks to send the filled copy. ',
  },
  {
    tools: ['read_file', 'read_artifact', 'save_artifact', 'write_note', 'computer_export'],
    text: 'Use the actual returned filename when describing a saved result. ',
  },
  {
    tools: ['read_artifact', 'save_artifact'],
    text: 'Use read_artifact or read_file to retrieve the complete source before revising a saved result. For small changes use save_artifact edits to preserve all untargeted text exactly; use complete source only for a rewrite. Read all pages of an uploaded Office file before revising it and preserve the original. Generated Office results use Relay layouts. ',
  },
  {
    tools: ['computer_run', 'computer_edit_docx'],
    text: 'To preserve an existing Office document’s layout, charts, images or embedded content, use the private computer’s installed document tools when available. Before any Office editing or conversion, read the source through computer_files (or read_file for a library file). If that reader reports a corrupt, encrypted or unreadable document, explain the specific failure and request a readable copy; do not auto-detect its bytes as plain text, convert them to a misleading PDF or invent substitute content. For exact text changes in a DOCX, first use computer_edit_docx with the contentHash from computer_files read. It preserves the existing formatting. For edits that tool cannot represent, use programmatic document or package editing through computer_run. Preserve styles by editing existing text runs or XML nodes, not by replacing an entire paragraph or converting through plain text. Make a separate copy before any edit when the owner asks to keep the original; inspect the result and export the completed copy. Check computer_status for installed apps. If the necessary tool is unavailable or cannot preserve the requested content, explain that specific limitation instead of silently recreating or dropping it. ',
  },
];
export function toolGuidance(tools) {
  const names = tools === undefined ? null : new Set(tools.map((tool) => tool.name));
  return sections
    .filter((section) => names === null || section.tools.some((name) => names.has(name)))
    .map((section) => section.text)
    .join('');
}
