// SPDX-License-Identifier: MIT
export const MAIN_ASSISTANT = 'relay';
export function threadAssistantId(s, threadId = 'main') {
  const thread = s.threads.find((t) => t.id === threadId);
  return thread?.participantIds?.[0] || thread?.assistantId || MAIN_ASSISTANT;
}
export function assistantProfile(s, id = MAIN_ASSISTANT) {
  if (id === MAIN_ASSISTANT)
    return {
      id,
      name: s.profile.assistantName || 'Relay',
      description: s.profile.assistantDescription || '',
      tone: s.profile.tone,
      avatarColor: s.profile.avatarColor || '#eaa267',
      appearance: s.profile.assistantAppearance || { kind: 'sprout' },
      notificationMode: s.profile.notificationMode || 'all',
      threadId: 'main',
      enabledSkillIds: s.profile.assistantSkillIds || null,
      revision: s.profile.assistantRevision || 1,
      memoryLearning: s.profile.memoryLearning !== false,
      memoryControlVersion: s.profile.memoryControlVersion || 0,
      memoryLearnAfter: s.profile.memoryLearnAfter || 0,
    };
  const profile = (s.assistants || []).find((a) => a.id === id);
  if (!profile) throw new Error('This assistant no longer exists.');
  return profile;
}
export function assistantForThread(s, threadId = 'main') {
  return assistantProfile(s, threadAssistantId(s, threadId));
}
export function acceptsAssistant(s, threadId, id) {
  const thread = s.threads.find((t) => t.id === threadId);
  return thread?.participantIds
    ? thread.participantIds.includes(id)
    : threadAssistantId(s, threadId) === id;
}
export function runAssistantId(s, run) {
  const id =
    run?.assistant?.id ||
    run?.questionContext?.origin.assistant?.id ||
    threadAssistantId(s, run?.threadId);
  if (!acceptsAssistant(s, run?.threadId, id))
    throw new Error('The assistant for this request is no longer in the conversation.');
  return id;
}
export function assistantSnapshot(s, threadId = 'main') {
  return profileSnapshot(s, threadAssistantId(s, threadId));
}
export function profileSnapshot(s, assistantId = MAIN_ASSISTANT) {
  const { id, name, description, tone, avatarColor, revision } = assistantProfile(s, assistantId);
  return { id, name, description, tone, avatarColor, revision };
}
export function memoryAssistantId(memory) {
  return memory.assistantId || MAIN_ASSISTANT;
}
export function assistantMemories(s, id = MAIN_ASSISTANT) {
  return s.memories.filter((m) => memoryAssistantId(m) === id);
}
export function assistantMemoryControls(s, id = MAIN_ASSISTANT) {
  return id === MAIN_ASSISTANT ? s.profile : assistantProfile(s, id);
}
export function assistantSkills(s, id = MAIN_ASSISTANT) {
  const selected = assistantProfile(s, id).enabledSkillIds;
  return (s.skills || []).filter((skill) => !selected || selected.includes(skill.id));
}
export function assistantWorkspace(s, id = MAIN_ASSISTANT, frozen = null) {
  const { assistantAppearance: _appearance, ...profile } = s.profile;
  const current = assistantProfile(s, id),
    identity = frozen || current;
  return {
    ...s,
    profile: {
      ...profile,
      assistantName: identity.name,
      assistantDescription: identity.description,
      tone: identity.tone,
      avatarColor: identity.avatarColor,
      memoryLearning: current.memoryLearning,
      memoryControlVersion: current.memoryControlVersion || 0,
    },
    memories: assistantMemories(s, id),
    skills: assistantSkills(s, id),
    routines: (s.routines || []).filter((r) => threadAssistantId(s, r.threadId) === id),
  };
}
