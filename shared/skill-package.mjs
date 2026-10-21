// SPDX-License-Identifier: MIT
export const SKILL_FILES_LIMIT = 1024 * 1024;
export const SKILL_FILE_LIMIT = 256 * 1024;
export const SKILL_ZIP_LIMIT = 2 * 1024 * 1024;
export function skillPath(path) {
  if (
    typeof path !== 'string' ||
    path.length > 240 ||
    path !== path.normalize('NFC') ||
    path.split('/').length > 8 ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[\\:<>"|?*\u0000-\u001f\u007f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw Error('Skill files need ordinary relative paths without links or parent folders.');
  return path;
}
export function skillBytes(base64) {
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil(SKILL_FILE_LIMIT / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw Error('A skill file has invalid data or exceeds 256 KB.');
  const raw = atob(base64);
  if (btoa(raw) !== base64 || raw.length > SKILL_FILE_LIMIT)
    throw Error('Invalid skill file data.');
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function skillBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function skillFiles(input = []) {
  if (!Array.isArray(input) || input.length > 64)
    throw Error('A skill can include up to 64 supporting files.');
  const names = new Set(['skill.md']);
  let total = 0;
  const files = input.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      Object.keys(file).some((k) => !['path', 'base64'].includes(k))
    )
      throw Error('Each skill file needs a path and its contents.');
    const path = skillPath(file.path),
      key = path.toLowerCase();
    if (names.has(key)) throw Error('A skill has duplicate file names or another SKILL.md.');
    names.add(key);
    total += skillBytes(file.base64).length;
    if (total > SKILL_FILES_LIMIT) throw Error('Keep supporting skill files under 1 MB in total.');
    return { path, base64: file.base64 };
  });
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join('/')))
        throw Error('A skill path cannot be both a file and a folder.');
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function skillFileText(file) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(skillBytes(file.base64));
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}
export const skillFileList = (files) =>
  (files || []).map((f) => ({ path: f.path, bytes: skillBytes(f.base64).length }));
export function skillManifest(skill) {
  const { files, ...method } = skill;
  return { ...method, ...(files?.length ? { files: skillFileList(files) } : {}) };
}
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function skillCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
