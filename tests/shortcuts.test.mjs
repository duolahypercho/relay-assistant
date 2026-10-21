// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcutCommand } from '../shared/shortcuts.mjs';
const key = (value, extra = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});
test('shortcuts use the platform primary modifier and preserve OS fullscreen chords', () => {
  assert.equal(shortcutCommand(key('f', { metaKey: true }), true), 'find-chat');
  assert.equal(shortcutCommand(key('f', { ctrlKey: true }), false), 'find-chat');
  assert.equal(shortcutCommand(key('f', { ctrlKey: true }), true), null);
  assert.equal(shortcutCommand(key('f', { ctrlKey: true, metaKey: true }), true), null);
  assert.equal(shortcutCommand(key('0', { metaKey: true }), true), null);
});
test('composition, repeated commands and AltGr cannot trigger navigation or send', () => {
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }])
    assert.equal(shortcutCommand(key('Enter', { ctrlKey: true, ...extra })), null);
  assert.equal(shortcutCommand(key('n', { ctrlKey: true, altKey: true })), null);
  assert.equal(
    shortcutCommand(
      key('b', { ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' }),
    ),
    null,
  );
});
test('chat cycling is Control on Mac and distinguishes reverse cycling', () => {
  assert.equal(shortcutCommand(key('Tab', { ctrlKey: true }), true), 'next-chat');
  assert.equal(
    shortcutCommand(key('Tab', { ctrlKey: true, shiftKey: true }), true),
    'previous-chat',
  );
  assert.equal(shortcutCommand(key('Tab', { metaKey: true }), true), null);
  assert.equal(shortcutCommand(key('ArrowDown', { altKey: true })), 'next-chat');
  assert.equal(shortcutCommand(key('ArrowDown', { altKey: true, shiftKey: true })), null);
});
test('search scopes, shifted comma layouts and numeric chat shortcuts stay distinct', () => {
  assert.equal(shortcutCommand(key('F', { metaKey: true, shiftKey: true }), true), 'search-chats');
  for (const value of [',', '<'])
    assert.equal(shortcutCommand(key(value, { ctrlKey: true, shiftKey: true })), 'details');
  assert.equal(shortcutCommand(key('9', { ctrlKey: true })), 'chat-9');
  assert.equal(shortcutCommand(key('1', { ctrlKey: true, shiftKey: true })), null);
  assert.equal(shortcutCommand(key('Enter', { ctrlKey: true, shiftKey: true })), null);
});
