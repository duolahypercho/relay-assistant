// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { validateAppearance } from './appearance.mjs';
import { assistantProfile, assistantSkills, threadAssistantId } from './assistant-scope.mjs';
import { assistantCommand } from './assistants.mjs';
import { skillFiles } from './skill-package.mjs';
import { skillCommand } from './skills.mjs';
import { skillMetadata, availableSkillSlug } from './skill-metadata.mjs';
import { validateSchedule } from './routines.mjs';
export const TEMPLATE_FORMAT = 'relay.assistant-template';
export const TEMPLATE_LIMIT = 256000;
const profileKeys = ['name', 'description', 'tone', 'avatarColor', 'memoryLearning', 'appearance'];
const skillKeys = ['title', 'slug', 'description', 'instructions', 'documentMeta', 'files'];
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains unsupported fields. Export a configuration-only template.`);
}
function text(value, label, max, optional = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!optional && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label} must contain ${optional ? '0' : '1'}–${max} characters.`);
  return value.trim();
}
function skill(value) {
  object(value, skillKeys, 'Skill');
  const slug = text(value.slug, 'Skill shortcut', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Use a valid skill shortcut.');
  return {
    title: text(value.title, 'Skill title', 100),
    slug,
    description: text(value.description || '', 'Skill description', 1024, true),
    instructions: text(value.instructions, 'Skill instructions', 12000),
    ...(value.documentMeta ? { documentMeta: skillMetadata(value.documentMeta) } : {}),
    ...(value.files !== undefined ? { files: skillFiles(value.files) } : {}),
  };
}
export function validateTemplate(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TEMPLATE_LIMIT)
    throw new Error('Keep templates under 256 KB.');
  object(value, ['format', 'version', 'profile', 'skills', 'routines'], 'Template');
  if (value.format !== TEMPLATE_FORMAT || ![1, 2].includes(value.version))
    throw new Error('Choose a supported Relay assistant template (version 1 or 2).');
  if (value.version === 1 && value.profile?.appearance !== undefined)
    throw new Error('Pictures and character choices need a version 2 template.');
  object(value.profile, profileKeys, 'Profile');
  const p = value.profile;
  if (!/^#[0-9a-f]{6}$/i.test(p.avatarColor)) throw new Error('Choose a valid assistant color.');
  if (typeof p.memoryLearning !== 'boolean') throw new Error('Choose a memory-learning setting.');
  const profile = {
    name: text(p.name, 'Assistant name', 40),
    description: text(p.description, 'Role instructions', 6000, true),
    tone: text(p.tone, 'Working style', 300),
    avatarColor: p.avatarColor,
    memoryLearning: p.memoryLearning,
    ...(p.appearance ? { appearance: validateAppearance(p.appearance) } : {}),
  };
  if (
    !Array.isArray(value.skills) ||
    value.skills.length > 100 ||
    !Array.isArray(value.routines) ||
    value.routines.length > 50
  )
    throw new Error('A template can contain up to 100 skills and 50 routines.');
  const skills = value.skills.map(skill);
  if (new Set(skills.map((s) => s.slug)).size !== skills.length)
    throw new Error('Each template skill needs a unique shortcut.');
  const routines = value.routines.map((r) => {
    object(
      r,
      ['title', 'instructions', 'execution', 'notification', 'schedule', 'skill'],
      'Routine',
    );
    object(
      r.schedule,
      ['kind', 'time', 'date', 'timeZone', 'days', 'minutes', 'sender', 'subject'],
      'Schedule',
    );
    const { at: _at, ...schedule } = validateSchedule(r.schedule);
    if (
      !['assistant', 'reminder'].includes(r.execution) ||
      !['changed', 'all', 'errors'].includes(r.notification)
    )
      throw new Error('Choose valid routine behavior.');
    const method = r.skill == null ? null : skill(r.skill);
    if (method && r.execution === 'reminder')
      throw new Error('Reminder routines cannot run a skill.');
    return {
      title: text(r.title, 'Routine title', 100),
      instructions: text(r.instructions, 'Routine instructions', 6000, !!method),
      execution: r.execution,
      notification: r.notification,
      schedule,
      skill: method,
    };
  });
  return { format: TEMPLATE_FORMAT, version: value.version, profile, skills, routines };
}
// Deliberately conservative warnings, never a claim to find every secret or private fact.
const sensitive = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*["']?[^\s"',;]{6,}["']?/gi,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];
function privateUrl(raw) {
  try {
    const u = new URL(raw),
      h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      u.username ||
      u.password ||
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      !h.includes('.') ||
      /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h) ||
      h.includes(':') ||
      [...u.searchParams.keys()].some((k) => /key|token|secret|password|signature/i.test(k))
    );
  } catch {
    return true;
  }
}
function cleaned(value) {
  let next = value;
  for (const pattern of sensitive) next = next.replace(pattern, '[credential removed]');
  next = next.replace(/https?:\/\/[^\s<>"')]+/gi, (url) =>
    privateUrl(url) ? '[private link removed]' : url,
  );
  return next;
}
export function templateWarnings(value) {
  const result = [];
  function visit(v, path) {
    if (typeof v === 'string' && cleaned(v) !== v) result.push(path);
    else if (Array.isArray(v)) v.forEach((item, i) => visit(item, `${path}[${i + 1}]`));
    else if (v && typeof v === 'object')
      Object.entries(v).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key));
  }
  visit(value, '');
  return result;
}
export function prepareTemplate(s, assistantId) {
  const profile = assistantProfile(s, assistantId);
  const pickSkill = (method) =>
    Object.fromEntries(
      skillKeys
        .filter((k) => !['documentMeta', 'files'].includes(k) || method[k])
        .map((k) => [k, method[k] || '']),
    );
  const raw = {
    format: TEMPLATE_FORMAT,
    version: 2,
    profile: {
      name: profile.name,
      description: profile.description,
      tone: profile.tone || 'Clear and friendly',
      avatarColor: profile.avatarColor,
      memoryLearning: profile.memoryLearning !== false,
      ...(profile.appearance ? { appearance: validateAppearance(profile.appearance) } : {}),
    },
    skills: assistantSkills(s, profile.id)
      .filter((method) => !method.archived)
      .map(pickSkill),
    routines: (s.routines || [])
      .filter((r) => !r.archived && threadAssistantId(s, r.threadId) === profile.id)
      .map((r) => {
        const { at: _at, ...schedule } = r.schedule;
        return {
          title: r.title,
          instructions: r.instructions,
          execution: r.execution,
          notification: r.notification,
          schedule,
          skill: r.skill ? pickSkill(r.skill) : null,
        };
      }),
  };
  const removed = templateWarnings(raw);
  const scrub = (v) =>
    typeof v === 'string'
      ? cleaned(v)
      : Array.isArray(v)
        ? v.map(scrub)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  const template = scrub(raw);
  // Sender filters often identify a private account. Require the recipient to replace them.
  template.routines.forEach((r, i) => {
    if (r.schedule.kind === 'email' && r.schedule.sender) {
      r.schedule.sender = 'choose-sender@example.invalid';
      removed.push(`routines[${i + 1}].schedule.sender`);
    }
  });
  return { template: validateTemplate(template), removed };
}
export function importTemplate(s, input, requestId) {
  const template = validateTemplate(input);
  if (requestId !== undefined) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId))
      throw Error('This template import has no valid receipt.');
    const previous = (s.templateImports || []).find((x) => x.id === requestId);
    if (previous) {
      const assistant = (s.assistants || []).find((a) => a.id === previous.assistantId);
      if (!assistant)
        throw Error('This template was already added and its assistant is no longer available.');
      return { ...assistant, alreadyImported: true };
    }
    if ((s.templateImports || []).length >= 10000)
      throw Error('This workspace has reached its template import receipt limit.');
  }
  const warnings = templateWarnings(template);
  if (warnings.length)
    throw new Error(`Remove possible credentials or private URLs from: ${warnings.join(', ')}.`);
  if (
    (s.skills || []).filter((x) => !x.archived).length + template.skills.length > 100 ||
    (s.routines || []).filter((x) => !x.archived).length + template.routines.length > 50
  )
    throw new Error('Archive some skills or routines before importing this template.');
  const next = structuredClone(s);
  const importedSkills = template.skills.map((method) => {
    const slug = availableSkillSlug(next.skills || [], method.slug);
    return skillCommand(next, 'skill.create', { ...method, slug });
  });
  const assistant = assistantCommand(next, 'assistant.create', {
    ...template.profile,
    enabledSkillIds: importedSkills.map((x) => x.id),
  });
  assistant.memoryLearning = template.profile.memoryLearning;
  next.routines ||= [];
  for (const r of template.routines)
    next.routines.push({
      ...structuredClone(r),
      id: uid('routine'),
      threadId: assistant.threadId,
      schedule: validateSchedule(r.schedule),
      skill: r.skill ? { ...r.skill, id: uid('template-skill'), version: 1 } : null,
      paused: true,
      archived: false,
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
      nextRunAt: null,
    });
  if (requestId) (next.templateImports ||= []).push({ id: requestId, assistantId: assistant.id });
  Object.assign(s, next);
  return assistant;
}
