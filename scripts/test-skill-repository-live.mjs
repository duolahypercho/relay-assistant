// SPDX-License-Identifier: MIT
// Explicit public URL only. External contents are neither installed nor retained.
import { SkillRepository } from '../server/skill-repository.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const target = process.env.RELAY_SKILL_REPOSITORY_TEST_URL;
if (!target) throw Error('Set RELAY_SKILL_REPOSITORY_TEST_URL to a public GitHub skill link.');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { checkedAt: new Date().toISOString(), target, passed: false };
try {
  const result = await new SkillRepository().read(target);
  Object.assign(report, {
    passed: true,
    source: result.source,
    documentBytes: Buffer.byteLength(result.document),
    documentSha256: hash(result.document),
    files: result.files.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.base64, 'base64').length,
      sha256: hash(Buffer.from(file.base64, 'base64')),
    })),
    scope:
      'Actual unauthenticated GitHub metadata and immutable raw-file downloads through production loader. External skill is not installed, executed, included in product source or saved as source contents.',
  });
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
}
await writeFile(
  join(evidence, 'skill-repository-live.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
