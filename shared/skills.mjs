// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { skillFiles, skillFileList } from './skill-package.mjs';
import { skillMetadata } from './skill-metadata.mjs';

function text(value, label, limit, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()))
    throw new Error(`${label} is required.`);
  if (value.trim().length > limit)
    throw new Error(`${label} must be ${limit} characters or fewer.`);
  return value.trim();
}
export function skillSnapshot(s, id) {
  const skill = (s.skills || []).find((x) => x.id === id && !x.archived);
  if (!skill) throw new Error('Choose an available skill.');
  const { title, slug, description, instructions, version, sourceMessageId, documentMeta, files } =
    skill;
  return structuredClone({
    id,
    title,
    slug,
    description,
    instructions,
    version,
    sourceMessageId,
    ...(documentMeta ? { documentMeta } : {}),
    ...(files?.length ? { files } : {}),
  });
}
export function skillInvocation(s, message) {
  const match = message.match(/^\/([a-z0-9][a-z0-9-]*)\b(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const skill = (s.skills || []).find((x) => x.slug === match[1].toLowerCase() && !x.archived);
  if (!skill) throw new Error(`Skill /${match[1]} is unavailable. Type / to choose a saved skill.`);
  return { skill: skillSnapshot(s, skill.id), skillInput: match[2]?.trim() || '' };
}
export function skillPrompt(skill, input = '') {
  return `Use my saved skill “${skill.title}” (/${skill.slug}, version ${skill.version}).${skill.documentMeta?.compatibility ? `\nRequirements noted by the skill author: ${skill.documentMeta.compatibility}` : ''}${skill.files?.length ? `\nSupporting files (use read_skill_file or computer_prepare_skill with id ${skill.id}, version ${skill.version}): ${JSON.stringify(skillFileList(skill.files))}` : ''}\nSaved method:\n${skill.instructions}\n\nFor this run:\n${input || 'Follow the saved method. Ask if required inputs are missing.'}\nCarry out this requested run using the tools available in this conversation. A saved skill supplies reusable instructions; it is not a separate executable that needs enabling. Inspect the current workspace or app through the available tools before saying access is missing or asking the owner to repeat setup. Ask for genuinely missing inputs and required action reviews. Honor extra checkpoints explicitly requested by the owner; do not invent additional setup or approvals for ordinary local steps. The saved method does not grant additional tool permissions or bypass action review.`;
}
export function skillCommand(s, action, p) {
  s.skills ||= [];
  const current = action === 'skill.create' ? null : s.skills.find((x) => x.id === p.id);
  if (action !== 'skill.create' && !current) throw new Error('Skill was not found.');
  if (action === 'skill.create' || action === 'skill.update') {
    if (current?.archived) throw new Error('Restore this skill before editing it.');
    if (!current && s.skills.filter((x) => !x.archived).length >= 100)
      throw new Error('Archive a skill before adding more than 100.');
    if (current && p.version !== undefined && p.version !== current.version)
      throw new Error('This skill changed elsewhere. Reopen it before saving your edits.');
    const values = { ...current, ...p };
    const title = text(values.title, 'Skill name', 100);
    const slug = text(values.slug, 'Shortcut', 64).replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new Error('Use letters, numbers and single hyphens for the shortcut.');
    if (s.skills.some((x) => x.id !== current?.id && x.slug === slug))
      throw new Error(`/${slug} already belongs to a saved or archived skill.`);
    const description = text(values.description || '', 'When to use it', 1024, true);
    const instructions = text(values.instructions, 'Instructions', 12000);
    const documentMeta =
      values.documentMeta === undefined ? undefined : skillMetadata(values.documentMeta);
    const files = values.files === undefined ? undefined : skillFiles(values.files);
    const sourceMessageId = current?.sourceMessageId || p.sourceMessageId || '';
    if (sourceMessageId && !s.messages.some((m) => m.id === sourceMessageId))
      throw new Error('The source message is unavailable.');
    const skill = current || { id: uid('skill'), archived: false, createdAt: iso() };
    Object.assign(skill, {
      title,
      slug,
      description,
      instructions,
      ...(documentMeta ? { documentMeta } : {}),
      ...(files ? { files } : {}),
      sourceMessageId,
      version: (current?.version || 0) + 1,
      updatedAt: iso(),
    });
    if (!current) s.skills.unshift(skill);
    return skill;
  }
  if (action === 'skill.archive') {
    current.archived = true;
    return current;
  }
  if (action === 'skill.restore') {
    if (s.skills.filter((x) => !x.archived).length >= 100)
      throw new Error('Archive another skill first.');
    current.archived = false;
    return current;
  }
  throw new Error('Unknown skill action.');
}
