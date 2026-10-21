// SPDX-License-Identifier: MIT
import { readSkillDocument, writeSkillDocument } from './skill-document.mjs';
import { skillFiles, skillBytes, skillCRC } from './skill-package.mjs';
// Portable stored ZIP. No local paths, timestamps, permissions or platform metadata escape.
export function writeSkillPackage(skill, document = writeSkillDocument(skill)) {
  const parsed = readSkillDocument(document);
  if (skill.slug !== parsed.slug) throw Error('The skill folder must match the reviewed name.');
  const files = [
    { path: 'SKILL.md', bytes: new TextEncoder().encode(document) },
    ...skillFiles(skill.files).map((f) => ({ path: f.path, bytes: skillBytes(f.base64) })),
  ];
  const local = [],
    central = [];
  let offset = 0,
    centralSize = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(`${skill.slug}/${file.path}`);
    const crc = skillCRC(file.bytes),
      size = file.bytes.length;
    const header = new Uint8Array(30 + name.length),
      v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x800, true);
    v.setUint16(12, 33, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, name.length, true);
    header.set(name, 30);
    const directory = new Uint8Array(46 + name.length),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint16(14, 33, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, size, true);
    d.setUint32(24, size, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    directory.set(name, 46);
    local.push(header, file.bytes);
    central.push(directory);
    offset += header.length + size;
    centralSize += directory.length;
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const bytes of [...local, ...central, end]) {
    output.set(bytes, position);
    position += bytes.length;
  }
  return output;
}
