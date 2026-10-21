// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatNavigation } from '../shared/chat-navigation.mjs';

test('explicit page requests open named destinations without choosing a setting value', () => {
  for (const text of [
    'show my files',
    'Open files',
    ' Please show me my files! ',
    'go to the documents',
    'take me to my files, please',
  ])
    assert.deepEqual(chatNavigation(text), { page: 'files', section: undefined });
  assert.deepEqual(chatNavigation('open appearance settings'), {
    page: 'settings',
    section: 'personal',
  });
  assert.deepEqual(chatNavigation('open the computer'), { page: 'computer', section: undefined });
});
test('ordinary questions, multi-step requests, quoted instructions and filtered queries stay messages', () => {
  for (const text of [
    'files',
    'settings',
    'show my files from yesterday',
    'show my files and summarize them',
    'Can you show my files?',
    'do not open files',
    'open "files"',
    '"open files"',
    'open files\nplease',
    'open files\nand delete them',
    'open file.txt',
    'open https://example.com',
    'open calendar for tomorrow',
    'show me how to open files',
    'change appearance settings',
    'open dark mode',
    'show my memories',
    'open email from Alex',
    '',
    null,
    {},
    'open files'.repeat(20),
  ])
    assert.equal(chatNavigation(text), null, String(text));
});
test('attached context and ongoing input prevent navigation', () => {
  for (const context of [{ hasContext: true }, { busy: true }])
    assert.equal(chatNavigation('open files', context), null);
  assert.deepEqual(
    chatNavigation('open tasks', { hasContext: false, busy: false, dismissed: false }),
    { page: 'activity', section: undefined },
  );
});
