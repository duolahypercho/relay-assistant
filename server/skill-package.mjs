// SPDX-License-Identifier: MIT
import * as yauzl from 'yauzl';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readSkillDocument, writeSkillDocument } from '../shared/skill-document.mjs';
import {
  skillFiles,
  skillPath,
  SKILL_ZIP_LIMIT,
  SKILL_FILES_LIMIT,
  SKILL_FILE_LIMIT,
} from '../shared/skill-package.mjs';

export async function readSkillPackage(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > SKILL_ZIP_LIMIT ||
    bytes.length < 4 ||
    bytes.readUInt32LE(0) !== 0x04034b50
  )
    throw Error(
      'Choose a skill ZIP of up to 2 MB containing one SKILL.md and its supporting files.',
    );
  const zip = await yauzl.fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const entries = [],
    names = new Set();
  let total = 0;
  try {
    if (zip.entryCount > 130) throw Error('This skill ZIP contains too many entries.');
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      const path = skillPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (
        entry.generalPurposeBitFlag & 1 ||
        ![0, 0o100000, 0o040000].includes(type) ||
        (type === 0o040000 && !directory) ||
        (type === 0o100000 && directory)
      )
        throw Error(
          'Unlock the ZIP and include ordinary files and folders only; links are not supported.',
        );
      if (names.has(path.toLowerCase())) throw Error('This skill ZIP has duplicate paths.');
      names.add(path.toLowerCase());
      total += entry.uncompressedSize;
      if (
        entry.uncompressedSize > SKILL_FILE_LIMIT ||
        total > SKILL_FILES_LIMIT + 64000 ||
        (directory && entry.uncompressedSize)
      )
        throw Error('Skill ZIP contents exceed the file size limit.');
      if (directory) continue;
      if (entries.length >= 65) throw Error('A skill can include up to 64 supporting files.');
      const stream = await zip.openReadStreamPromise(entry),
        chunks = [];
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > entry.uncompressedSize || length > SKILL_FILE_LIMIT) {
          stream.destroy();
          throw Error('A skill file exceeds its declared size.');
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (crc32(data) !== entry.crc32) throw Error('This skill ZIP contains damaged content.');
      entries.push({ path, data });
    }
  } finally {
    zip.close();
  }
  const documents = entries.filter((e) => /(^|\/)SKILL\.md$/.test(e.path));
  if (documents.length !== 1) throw Error('Choose a ZIP containing exactly one SKILL.md.');
  const root = documents[0].path.slice(0, -'SKILL.md'.length);
  if (root && root.split('/').length !== 2)
    throw Error('Put SKILL.md at the ZIP root or inside one skill folder.');
  if (entries.some((e) => !e.path.startsWith(root)))
    throw Error('All files must belong to the same skill folder.');
  const document = new TextDecoder('utf-8', { fatal: true }).decode(documents[0].data);
  const method = readSkillDocument(document);
  if (root && root !== `${method.slug}/`)
    throw Error('The skill folder name must match the name in SKILL.md.');
  const files = skillFiles(
    entries
      .filter((e) => e !== documents[0])
      .map((e) => ({ path: e.path.slice(root.length), base64: e.data.toString('base64') })),
  );
  return { document, files };
}

export async function prepareComputerSkill(computer, skill, operationId, options) {
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(operationId || ''))
    throw Error('Give this skill preparation a unique operation ID, up to 80 characters.');
  const files = [
    { path: 'SKILL.md', base64: Buffer.from(writeSkillDocument(skill)).toString('base64') },
    ...skillFiles(skill.files),
  ];
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const key = createHash('sha256')
    .update(`${options.scope}:${operationId}:${fingerprint}`)
    .digest('hex')
    .slice(0, 24);
  const root = `/workspace/skill-${key}`;
  const folders = new Set(['']);
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    for (let n = 1; n <= parts.length; n++) folders.add(parts.slice(0, n).join('/'));
  }
  let index = 0;
  for (const folder of folders) {
    options.guard?.();
    options.signal?.throwIfAborted();
    await computer.perform(
      {
        kind: 'files',
        action: 'mkdir',
        path: root + (folder ? '/' + folder : ''),
        operationId: `${operationId}:folder:${index++}`,
      },
      options,
    );
  }
  for (const [i, file] of files.entries()) {
    options.guard?.();
    options.signal?.throwIfAborted();
    await computer.perform(
      {
        kind: 'files',
        action: 'write',
        path: `${root}/${file.path}`,
        base64: file.base64,
        operationId: `${operationId}:file:${i}`,
      },
      options,
    );
  }
  options.guard?.();
  return {
    path: root,
    version: skill.version,
    fileCount: files.length,
    fingerprint,
    notice:
      'Working copy prepared; no script has run. Inspect requirements and run an appropriate interpreter with computer_run. No dependencies were installed. Usual computer permissions and reviews apply. Changes to this copy do not change the saved skill.',
  };
}
