// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { repositoryHttpFixture, documents, commit } from './skill-repository-fixture.mjs';
import { SkillRepository } from '../server/skill-repository.mjs';
import { command } from '../shared/domain.mjs';
export const repositoryLink = 'https://github.com/relay-tests/methods/tree/main/calm-plan';
export const repositoryAnswer = 'One calm idea: a quiet tea break.';
export async function skillRepositoryAcceptance(directory, options = {}) {
  const remote = await repositoryHttpFixture();
  let f;
  try {
    f = await assistantsFixture(directory, {
      ...options,
      configure(store, services) {
        services.skillRepository = new SkillRepository({ fetch: remote.fetch });
        store.mutate((s) => {
          const existing = command(s, 'skill.create', {
            title: 'Existing method',
            slug: 'calm-plan',
            instructions: 'Keep this method unchanged.',
          });
          command(s, 'skill.archive', { id: existing.id });
        });
      },
      respond: async (body) => {
        const skill = f.store.read().skills.find((s) => !s.archived);
        const result = body.messages.filter((m) => m.role === 'tool').at(-1);
        if (!result)
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'read-imported-reference',
                type: 'function',
                function: {
                  name: 'read_skill_file',
                  arguments: JSON.stringify({
                    id: skill.id,
                    version: skill.version,
                    path: 'references/notes.md',
                  }),
                },
              },
            ],
          };
        const content = JSON.parse(result.content);
        assert.equal(content.result.text, documents.get('references/notes.md').toString());
        return { role: 'assistant', content: repositoryAnswer };
      },
    });
    const initial = f.store.read();
    return {
      ...f,
      remote,
      commit,
      verifyReview() {
        assert.equal(f.store.read().skills.length, 1);
        assert.deepEqual(f.store.read().messages, initial.messages);
        assert.equal(f.requests.length, 0);
      },
      verifySaved() {
        const state = f.store.read(),
          skill = state.skills.find((s) => !s.archived);
        assert.equal(state.skills.length, 2);
        assert.equal(skill.slug, 'calm-plan-2');
        assert.equal(skill.documentMeta.license, 'MIT');
        assert.equal(skill.files.length, 4);
        for (const file of skill.files)
          assert.deepEqual(Buffer.from(file.base64, 'base64'), documents.get(file.path));
        assert.deepEqual(
          state.skills.find((skill) => skill.id === initial.skills[0].id),
          initial.skills[0],
        );
        return skill;
      },
      verifyRun() {
        const skill = this.verifySaved(),
          state = f.store.read();
        assert.equal(state.runs.length, 1);
        assert.equal(state.runs[0].skill.version, 1);
        assert.deepEqual(state.runs[0].skill.files, skill.files);
        assert(state.messages.some((m) => m.text === repositoryAnswer));
        assert.equal(state.files.length, initial.files.length);
      },
      async close() {
        await f.close();
        await remote.close();
      },
    };
  } catch (error) {
    await f?.close();
    await remote.close();
    throw error;
  }
}
