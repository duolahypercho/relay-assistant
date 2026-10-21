// SPDX-License-Identifier: MIT
import { parseDocument, stringify, visit, isAlias, isMap, isScalar, isSeq } from 'yaml';
import { skillMetadata } from './skill-metadata.mjs';
export const SKILL_DOCUMENT_LIMIT = 64000;
const supported = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
function bounded(text, label, max, required = true) {
  if (
    typeof text !== 'string' ||
    (required && !text.trim()) ||
    text.trim().length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  )
    throw Error(`${label} must contain ${required ? '1' : '0'}–${max} characters.`);
  return text.trim();
}
export function readSkillDocument(input) {
  if (
    typeof input !== 'string' ||
    new TextEncoder().encode(input).byteLength > SKILL_DOCUMENT_LIMIT
  )
    throw Error('Choose a skill instructions file smaller than 64 KB.');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!match)
    throw Error(
      'A SKILL.md file needs a name and description between --- lines, followed by instructions.',
    );
  if (match[1].length > 16000) throw Error('Keep skill file metadata under 16,000 characters.');
  let raw;
  try {
    const doc = parseDocument(match[1], {
      schema: 'failsafe',
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
    });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw Error();
    let count = 0;
    visit(doc, (_key, node, path) => {
      if (
        ++count > 512 ||
        path.length > 8 ||
        isAlias(node) ||
        isSeq(node) ||
        (node &&
          typeof node === 'object' &&
          (('anchor' in node && node.anchor) || ('tag' in node && node.tag)))
      )
        throw Error();
      if (
        isMap(node) &&
        node.items.some(
          (item) =>
            !isScalar(item.key) ||
            typeof item.key.value !== 'string' ||
            ['__proto__', 'constructor', 'prototype'].includes(item.key.value),
        )
      )
        throw Error();
    });
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw Error(
      'Use plain YAML metadata with unique text keys. Aliases, custom tags and nested collections are not supported.',
    );
  }
  if (Object.keys(raw).some((key) => !supported.includes(key)))
    throw Error(
      'This skill has unsupported metadata fields. Keep name, description, license, compatibility, metadata and allowed-tools.',
    );
  const slug = bounded(raw.name, 'Skill name', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw Error('The skill name must use lowercase letters, numbers and single hyphens.');
  const documentMeta = skillMetadata({
    ...(raw.license !== undefined ? { license: raw.license } : {}),
    ...(raw.compatibility !== undefined ? { compatibility: raw.compatibility } : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    ...(raw['allowed-tools'] !== undefined ? { requestedTools: raw['allowed-tools'] } : {}),
  });
  const title = documentMeta.metadata?.['relay-title'] || slug.replaceAll('-', ' ');
  return {
    title: bounded(title, 'Skill title', 100),
    slug,
    description: bounded(raw.description, 'Skill description', 1024),
    instructions: bounded(match[2], 'Instructions', 12000),
    documentMeta,
  };
}
export function writeSkillDocument(skill) {
  const documentMeta = skillMetadata(skill.documentMeta || {});
  const metadata = { ...documentMeta.metadata, 'relay-title': skill.title };
  // Cross-client imports cannot silently turn a file's tool hints into grants.
  if (documentMeta.requestedTools) metadata['relay-requested-tools'] = documentMeta.requestedTools;
  const front = {
    name: skill.slug,
    description: skill.description || `Use the ${skill.title} method when requested.`,
    ...(documentMeta.license ? { license: documentMeta.license } : {}),
    ...(documentMeta.compatibility ? { compatibility: documentMeta.compatibility } : {}),
    metadata,
  };
  const text = `---\n${stringify(front, { lineWidth: 0 })}---\n\n${skill.instructions}\n`;
  readSkillDocument(text);
  return text;
}
