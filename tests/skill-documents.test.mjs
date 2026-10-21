import test from 'node:test';
import assert from 'node:assert/strict';
import { readSkillDocument, writeSkillDocument } from '../shared/skill-document.mjs';
import { availableSkillSlug } from '../shared/skill-metadata.mjs';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { skillSnapshot } from '../shared/skills.mjs';
import { prepareTemplate, importTemplate } from '../shared/assistant-templates.mjs';
const source = `---
name: weekly-review
description: >
  Review the week and prepare the next one.
license: CC-BY-4.0
compatibility: Requires access to current calendar information.
metadata:
  author: "Example author: original method"
  relay-title: "Weekly reflection"
allowed-tools: "Bash(*) SendMail"
---
Ask about missing priorities. Read current sources. Prepare changes for review.
`;
test('standalone skill files read BOM/CRLF, folded descriptions, attribution and bounded standard names', () => {
  const skill = readSkillDocument('\uFEFF' + source.replaceAll('\n', '\r\n'));
  assert.equal(skill.title, 'Weekly reflection');
  assert.equal(skill.description, 'Review the week and prepare the next one.');
  assert.equal(skill.documentMeta.license, 'CC-BY-4.0');
  assert.equal(skill.documentMeta.requestedTools, 'Bash(*) SendMail');
  const long = source
    .replace('name: weekly-review', `name: ${'a'.repeat(64)}`)
    .replace('Review the week and prepare the next one.', 'x'.repeat(1024));
  const state = createWorkspace();
  const added = command(state, 'skill.create', readSkillDocument(long));
  assert.equal(added.slug.length, 64);
  assert.equal(added.description.length, 1024);
});
test('malformed YAML, active tags, aliases, duplicate keys, nested values and over-budget files fail explicitly', () => {
  for (const bad of [
    source.replace('name: weekly-review', 'name: weekly-review\nname: overwritten'),
    source
      .replace('name: weekly-review', 'name: &shared weekly-review')
      .replace('license: CC-BY-4.0', 'license: *shared'),
    source.replace('name: weekly-review', 'name: !!js/function function(){}'),
    source.replace('name: weekly-review', 'name: Wrong--Name'),
    source.replace('license: CC-BY-4.0', 'license: [a, b]'),
    source.replace('license: CC-BY-4.0', 'license:\n  nested: value'),
    source.replace('license: CC-BY-4.0', '__proto__: dangerous'),
    source.replace('license: CC-BY-4.0', 'permission: unrestricted'),
    source.replace('author: "Example author: original method"', 'author:\n    nested: value'),
    '---\nname: example\ndescription: short\n---\n',
    '# A file without metadata',
    source + '文'.repeat(22000),
    source.replace('name: weekly-review', 'name: ' + 'a'.repeat(65)),
  ])
    assert.throws(() => readSkillDocument(bad));
});
test('reviewed import creates a fresh inactive method without overwriting archived/current methods or starting work', () => {
  const state = createWorkspace(),
    before = structuredClone(state);
  const parsed = readSkillDocument(source);
  const first = command(state, 'skill.create', parsed);
  command(state, 'skill.archive', { id: first.id });
  const next = { ...parsed, slug: availableSkillSlug(state.skills, parsed.slug) };
  const added = command(state, 'skill.create', next);
  assert.equal(added.slug, 'weekly-review-2');
  assert.notEqual(added.id, first.id);
  assert.equal(first.archived, true);
  assert.equal(first.version, 1);
  const snapshot = structuredClone(state);
  assert.throws(() => command(state, 'skill.create', next), /already belongs/);
  assert.deepEqual(state, snapshot);
  for (const field of ['messages', 'runs', 'approvals', 'routines', 'connections', 'assistants'])
    assert.deepEqual(state[field], before[field]);
  const long = 'a'.repeat(64);
  assert.equal(availableSkillSlug([{ slug: long }], long), 'a'.repeat(62) + '-2');
});
test('metadata validation also protects direct save requests and leaves failed edits atomic', () => {
  const state = createWorkspace();
  const skill = command(state, 'skill.create', readSkillDocument(source));
  const before = structuredClone(state);
  for (const meta of [
    { license: false },
    { compatibility: 0 },
    { permissions: ['all'] },
    { metadata: { nested: { value: 'bad' } } },
    JSON.parse('{"metadata":{"__proto__":"bad"}}'),
  ]) {
    assert.throws(() =>
      command(state, 'skill.update', {
        id: skill.id,
        title: 'Must not persist',
        documentMeta: meta,
      }),
    );
    assert.deepEqual(state, before);
  }
});
test('skill file exports preserve attribution, exclude workspace provenance and do not export tool grants', () => {
  const parsed = readSkillDocument(source);
  const text = writeSkillDocument({
    ...parsed,
    id: 'private-id',
    sourceMessageId: 'private-message',
    sourceTeachingId: 'private-demo',
    token: 'private-token',
    archived: true,
  });
  for (const value of [
    'private-id',
    'private-message',
    'private-demo',
    'private-token',
    'allowed-tools:',
  ])
    assert(!text.includes(value));
  const restored = readSkillDocument(text);
  assert.equal(restored.instructions, parsed.instructions);
  assert.equal(restored.documentMeta.license, 'CC-BY-4.0');
  assert.equal(restored.documentMeta.metadata.author, parsed.documentMeta.metadata.author);
  assert.equal(restored.documentMeta.metadata['relay-requested-tools'], 'Bash(*) SendMail');
  assert.equal(restored.documentMeta.requestedTools, undefined);
});
test('metadata survives edits, frozen runs and assistant-template transfer without rewriting source skills', () => {
  const state = createWorkspace();
  const original = command(state, 'skill.create', readSkillDocument(source));
  const frozen = skillSnapshot(state, original.id);
  command(state, 'skill.update', { id: original.id, title: 'Renamed reflection' });
  assert.equal(original.documentMeta.license, 'CC-BY-4.0');
  assert.equal(frozen.title, 'Weekly reflection');
  command(state, 'skill.update', { id: original.id, documentMeta: { license: 'MIT' } });
  assert.equal(frozen.documentMeta.license, 'CC-BY-4.0');
  const { template } = prepareTemplate(state, 'relay');
  const target = createWorkspace();
  importTemplate(target, template);
  assert(
    target.skills.some((s) => s.title === 'Renamed reflection' && s.documentMeta.license === 'MIT'),
  );
  assert.equal(original.documentMeta.license, 'MIT');
});
