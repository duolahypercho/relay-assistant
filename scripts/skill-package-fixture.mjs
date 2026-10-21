import { homedir } from 'node:os';
import { writeSkillPackage } from '../shared/skill-archive.mjs';
// Original fixture; controlled HTTP model and actual isolated Linux computer.
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { readSkillDocument } from '../shared/skill-document.mjs';
import { skillFiles } from '../shared/skill-package.mjs';
import { command } from '../shared/domain.mjs';
export const packageAnswer =
  'Your packing list has 3 items. I saved the checked list as packing-list.csv.';
const file = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
export const packageMethod = {
  ...readSkillDocument(
    '---\nname: packing-list\ndescription: Make a checked packing list from the included template.\nlicense: MIT\ncompatibility: Python 3, using only its standard library.\nmetadata:\n  author: Relay acceptance\n---\n\nRead references/guide.md. Prepare this skill in the computer, then run python3 scripts/pack.py from its working folder. Export the generated packing-list.csv. Check there are three items.\n',
  ),
  title: 'My packing list',
  files: [
    file(
      'references/guide.md',
      'Use one row per item. Preserve the accents in café mug and 茶. Never send this list to anyone.\n',
    ),
    file('assets/items.json', '["passport", "café mug", "茶"]\n'),
    file(
      'scripts/pack.py',
      'import csv, json\nfrom pathlib import Path\nitems = json.loads(Path("assets/items.json").read_text())\nwith open("packing-list.csv", "w", newline="") as f:\n    writer = csv.writer(f)\n    writer.writerow(["item", "packed"])\n    writer.writerows((item, "no") for item in items)\nprint(f"Verified {len(items)} items")\n',
    ),
    file(
      'LICENSE',
      'Copyright 2026 Relay contributors\nSPDX-License-Identifier: MIT\nOriginal acceptance fixture.\n',
    ),
  ],
};
export const packageZip = Buffer.from(writeSkillPackage(packageMethod));
export async function skillPackageFixture(directory, options = {}) {
  const errors = [],
    steps = [];
  let computer;
  const f = await assistantsFixture(directory, {
    ...options,
    async configure(store, services) {
      computer = services.computer = new PrivateComputer(store, {
        enabled: true,
        deployment: directory,
        dockerHost: process.env.DOCKER_HOST || `unix://${homedir()}/.colima/relay/docker.sock`,
      });
      await computer.start();
      if (options.seed) store.mutate((s) => command(s, 'skill.create', packageMethod));
    },
    async respond(body) {
      try {
        const results = body.messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content));
        assert(
          results.every((r) => !r.error),
          JSON.stringify(results),
        );
        const skill = f.store.read().runs.findLast((r) => r.status === 'running')?.skill;
        assert(skill, 'Run must contain a frozen package.');
        const call = (name, args) => ({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `package-step-${results.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        steps.push(results.length);
        if (!results.length)
          return call('read_skill_file', {
            id: skill.id,
            version: skill.version,
            path: 'references/guide.md',
          });
        if (results.length === 1) {
          assert.match(results[0].result.text, /café mug and 茶/);
          return call('computer_prepare_skill', {
            id: skill.id,
            version: skill.version,
            operationId: 'prepare-packing-list',
          });
        }
        const root = results[1].result.path;
        assert.match(root, /^\/workspace\/skill-[a-f0-9]{24}$/);
        if (results.length === 2) {
          for (const source of skillFiles(packageMethod.files))
            assert.equal((await computer.read(`${root}/${source.path}`)).base64, source.base64);
          return call('computer_run', {
            command: 'python3 scripts/pack.py',
            cwd: root,
            seconds: 10,
            operationId: 'make-packing-list',
          });
        }
        assert.equal(results[2].result.exitCode, 0, JSON.stringify(results[2]));
        assert.match(results[2].result.stdout, /Verified 3 items/);
        if (results.length === 3)
          return call('computer_export', { path: `${root}/packing-list.csv` });
        assert.equal(results.length, 4);
        return { role: 'assistant', content: packageAnswer };
      } catch (error) {
        errors.push(error.message);
        return { role: 'assistant', content: 'Fixture failed.' };
      }
    },
  });
  return {
    ...f,
    computer,
    errors,
    steps,
    async close() {
      await f.services.worker.stop();
      await computer.stop();
      await computer.dockerRun(['volume', 'rm', computer.volume, computer.displayVolume]);
      await f.close();
    },
  };
}
