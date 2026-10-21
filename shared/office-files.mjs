// SPDX-License-Identifier: MIT
const formats = {
  docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: [
    'presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
};
export function officeKind(file) {
  const extension = String(file?.name || '')
    .split('.')
    .at(-1)
    ?.toLowerCase();
  return (
    formats[extension]?.[0] ||
    Object.values(formats).find(([, mime]) => mime === file?.mime)?.[0] ||
    null
  );
}
export function officeMime(name) {
  return formats[String(name).split('.').at(-1)?.toLowerCase()]?.[1];
}

const textExtensions = new Set([
  'txt',
  'log',
  'md',
  'csv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'eml',
  'ipynb',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'css',
  'sql',
  'sh',
]);
export function readableText(file) {
  return (
    file?.text !== undefined ||
    file?.mime?.startsWith('text/') ||
    [
      'application/json',
      'application/xml',
      'application/yaml',
      'application/javascript',
      'application/x-yaml',
    ].includes(file?.mime) ||
    ((!file?.mime || file.mime === 'application/octet-stream') &&
      textExtensions.has(
        String(file?.name || '')
          .split('.')
          .at(-1)
          ?.toLowerCase(),
      ))
  );
}
