import { notificationMode } from './attention.mjs';
// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { validateAppearance } from './appearance.mjs';
import { assistantProfile, MAIN_ASSISTANT, threadAssistantId } from './assistant-scope.mjs';
const text = (value, name, limit, optional = false) => {
  if (
    typeof value !== 'string' ||
    value.trim().length > limit ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (!optional && !value.trim())
  )
    throw new Error(`${name} must contain ${optional ? '0' : '1'}–${limit} characters.`);
  return value.trim();
};
function values(s, p) {
  const enabledSkillIds = p.enabledSkillIds ?? null;
  if (
    enabledSkillIds !== null &&
    (!Array.isArray(enabledSkillIds) ||
      enabledSkillIds.length > 100 ||
      enabledSkillIds.some(
        (id) => typeof id !== 'string' || !(s.skills || []).some((skill) => skill.id === id),
      ))
  )
    throw new Error('Choose saved skills for this assistant.');
  if (!/^#[0-9a-f]{6}$/i.test(p.avatarColor || '#eaa267'))
    throw new Error('Choose a valid assistant color.');
  return {
    notificationMode: notificationMode(p.notificationMode || 'all'),
    enabledSkillIds: enabledSkillIds === null ? null : [...new Set(enabledSkillIds)],
    name: text(p.name, 'Assistant name', 40),
    description: text(p.description || '', 'Role instructions', 6000, true),
    tone: text(p.tone || 'Clear and friendly', 'Response style', 300),
    avatarColor: p.avatarColor || '#eaa267',
    appearance: validateAppearance(p.appearance),
  };
}
function create(s, p) {
  if ((s.assistants || []).length >= 30) throw new Error('Keep up to 30 specialist assistants.');
  const profile = {
    id: uid('assistant'),
    ...values(s, p),
    revision: 1,
    hidden: false,
    pinned: false,
    memoryLearning: true,
    memoryControlVersion: 0,
    memoryLearnAfter: s.messages.length,
    createdAt: iso(),
    threadId: uid('thread'),
  };
  s.assistants ||= [];
  s.assistants.push(profile);
  s.threads.unshift({
    id: profile.threadId,
    assistantId: profile.id,
    assistantHome: true,
    title: profile.name,
    archived: false,
    draft: '',
    createdAt: iso(),
  });
  return profile;
}
export function assistantCommand(s, action, p) {
  if (action === 'assistant.create') return create(s, p);
  const profile = assistantProfile(s, p.id);
  if (action === 'assistant.duplicate') {
    const routines = (s.routines || []).filter(
      (r) => !r.archived && threadAssistantId(s, r.threadId) === profile.id,
    );
    if ((s.routines || []).filter((r) => !r.archived).length + routines.length > 50)
      throw new Error('Archive some routines before duplicating this assistant.');
    const copy = create(s, { ...profile, name: `${profile.name.slice(0, 35)} copy` });
    // Copy configuration only. No previous outputs, email cursor, history,
    // learned memories, credentials or pending jobs follow the new assistant.
    s.routines ||= [];
    for (const r of routines)
      s.routines.push({
        id: uid('routine'),
        title: r.title,
        instructions: r.instructions,
        skill: r.skill
          ? Object.fromEntries(
              Object.entries(structuredClone(r.skill)).filter(([key]) => key !== 'sourceMessageId'),
            )
          : null,
        schedule: structuredClone(r.schedule),
        execution: r.execution,
        notification: r.notification,
        threadId: copy.threadId,
        paused: true,
        archived: false,
        version: 1,
        createdAt: iso(),
        updatedAt: iso(),
        nextRunAt: null,
      });
    copy.memoryLearning = profile.memoryLearning !== false;
    return copy;
  }
  if (action === 'assistant.update') {
    if (p.revision !== profile.revision)
      throw new Error(
        'This assistant changed in another window. Reopen the profile before saving.',
      );
    const next = values(s, { ...profile, ...p });
    if (profile.id === MAIN_ASSISTANT)
      Object.assign(s.profile, {
        assistantName: next.name,
        assistantDescription: next.description,
        assistantSkillIds: next.enabledSkillIds,
        tone: next.tone,
        avatarColor: next.avatarColor,
        assistantAppearance: next.appearance,
        notificationMode: next.notificationMode,
        assistantRevision: profile.revision + 1,
      });
    else {
      Object.assign(profile, next, { revision: profile.revision + 1, updatedAt: iso() });
      const home = s.threads.find((t) => t.id === profile.threadId);
      if (home) home.title = next.name;
    }
    return assistantProfile(s, profile.id);
  }
  if (action === 'assistant.learning') {
    if (typeof p.enabled !== 'boolean')
      throw new Error('Choose whether this assistant learns from chats.');
    const controls = profile.id === MAIN_ASSISTANT ? s.profile : profile;
    if (controls.memoryLearning !== p.enabled) {
      controls.memoryLearning = p.enabled;
      controls.memoryControlVersion = (controls.memoryControlVersion || 0) + 1;
      controls.memoryLearnAfter = s.messages.length;
    }
    return assistantProfile(s, profile.id);
  }
  if (['assistant.pin', 'assistant.hide'].includes(action)) {
    if (profile.id === MAIN_ASSISTANT) throw new Error('Your main assistant stays available.');
    if (typeof p.value !== 'boolean') throw new Error('Choose a valid visibility setting.');
    profile[action === 'assistant.pin' ? 'pinned' : 'hidden'] = p.value;
    return profile;
  }
  throw new Error('Unknown assistant action.');
}
