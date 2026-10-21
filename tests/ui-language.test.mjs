// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiLanguages, validUiLanguage, resolveUiLocale, uiText } from '../shared/ui-language.mjs';
import { chinese } from '../shared/ui-translations.mjs';
import connectionCopy from '../public/native-connection-language.json' with { type: 'json' };
import { connectionText } from '../shared/native-connection-language.mjs';
import { chatNavigation } from '../shared/chat-navigation.mjs';

test('app language follows supported device preferences and honors explicit choices', () => {
  for (const language of uiLanguages) assert.equal(validUiLanguage(language.id), true);
  for (const value of [null, {}, 'fr', 'zh', '', '__proto__'])
    assert.equal(validUiLanguage(value), false);
  for (const [preference, device, expected] of [
    ['en', ['zh-CN'], 'en'],
    ['zh-TW', ['en-US'], 'zh-TW'],
    ['system', ['fr-FR', 'zh-HK', 'en'], 'zh-TW'],
    ['system', ['en-AU', 'zh-TW'], 'en'],
    ['system', ['zh-SG'], 'zh-CN'],
    ['system', ['zh-Hant-CN'], 'zh-TW'],
    ['system', ['zh-Hans-TW'], 'zh-CN'],
    ['system', ['bad_hint', 'zh-MO'], 'zh-TW'],
    ['unsupported', ['zh'], 'zh-CN'],
    ['system', ['fr-FR'], 'en'],
    ['system', [], 'en'],
  ])
    assert.equal(resolveUiLocale(preference, device), expected);
});

test('every advertised translation has both scripts and preserves placeholders', () => {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [key, pair] of Object.entries({ ...chinese, ...connectionCopy })) {
    assert.equal(pair.length, 2, key);
    for (const value of pair) {
      assert.ok(typeof value === 'string' && value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(key), key);
    }
  }
  assert.equal(uiText('zh-CN', 'Files'), '文件');
  assert.equal(uiText('zh-TW', 'Files'), '檔案');
  assert.equal(uiText('en', 'Files'), 'Files');
  assert.equal(uiText('zh-CN', 'Unknown label'), 'Unknown label');
  assert.equal(uiText('zh-TW', 'constructor'), 'constructor');
});

test('interpolation preserves names and handles missing values without evaluating content', () => {
  const name = '<script>Files ${secret}</script>';
  assert.equal(uiText('zh-TW', 'Message {name}', { name }), `傳訊息給${name}`);
  assert.equal(uiText('en', 'Message {name}'), 'Message {name}');
  assert.equal(uiText('en', '{count} matches', { count: 0 }), '0 matches');
  assert.equal(uiText('en', '{name}', Object.create({ name: 'inherited' })), '{name}');
});

test('Chinese page requests remain narrow and never consume context', () => {
  for (const text of ['打开我的文件', '請打開檔案！', '查看文件。'])
    assert.deepEqual(chatNavigation(text), { page: 'files', section: undefined });
  assert.deepEqual(chatNavigation('打开语言设置'), { page: 'settings', section: 'personal' });
  assert.deepEqual(chatNavigation('前往語言設定'), { page: 'settings', section: 'personal' });
  for (const text of [
    '打开昨天的文件',
    '打开文件并总结',
    '请不要打开文件',
    '“打开文件”',
    '打开文件？',
    '打开文件\n然后总结',
  ])
    assert.equal(chatNavigation(text), null, text);
  for (const context of [{ hasContext: true }, { busy: true }])
    assert.equal(chatNavigation('打开文件', context), null);
});

test('native connection copy preserves destination data and safely falls back for unknown labels', () => {
  const url = 'https://relay.example/#connect=' + 'a'.repeat(43);
  assert.equal(connectionText('zh-CN', 'Connected to {url}', { url }), `已连接到 ${url}`);
  assert.equal(connectionText('zh-TW', 'Connected to {url}', { url }), `已連接到 ${url}`);
  assert.equal(connectionText('zh-CN', 'constructor'), 'constructor');
  assert.equal(connectionText('en', 'Unknown label'), 'Unknown label');
  assert.equal(
    connectionText('zh-CN', 'Connected to {url}', Object.create({ url })),
    '已连接到 {url}',
  );
});
