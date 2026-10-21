// SPDX-License-Identifier: MIT
const fields = ['license', 'compatibility', 'metadata', 'requestedTools'];
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
export function skillMetadata(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw Error('Skill metadata contains unsupported fields.');
  const text = (value, limit) => {
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    )
      throw Error('Skill metadata must contain bounded plain text.');
    return value.trim();
  };
  /** @type {{ license?: string, compatibility?: string, requestedTools?: string, metadata?: Record<string, string> }} */
  const result = {};
  for (const [field, limit] of [
    ['license', 1024],
    ['compatibility', 500],
    ['requestedTools', 2000],
  ])
    if (value[field] !== undefined) {
      const clean = text(value[field], limit);
      if (clean) result[field] = clean;
    }
  if (value.metadata !== undefined) {
    if (
      !value.metadata ||
      typeof value.metadata !== 'object' ||
      Array.isArray(value.metadata) ||
      Object.keys(value.metadata).filter(
        (key) => !['relay-title', 'relay-requested-tools'].includes(key),
      ).length > 32
    )
      throw Error('Skill metadata supports up to 32 text entries.');
    const entries = Object.entries(value.metadata).map(([key, item]) => {
      if (!key || unsafe.has(key) || key.length > 80 || /[\x00-\x1f\x7f]/.test(key))
        throw Error('Skill metadata contains an invalid key.');
      return [key, text(item, 2000)];
    });
    if (entries.length) result.metadata = Object.fromEntries(entries);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 12000)
    throw Error('Keep skill metadata under 12 KB.');
  return result;
}
export function availableSkillSlug(skills, proposed) {
  let slug = proposed,
    number = 2;
  while (skills.some((skill) => skill.slug === slug)) {
    const suffix = `-${number++}`;
    slug = proposed.slice(0, 64 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return slug;
}
