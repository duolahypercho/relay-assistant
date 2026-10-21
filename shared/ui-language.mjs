// SPDX-License-Identifier: MIT
import { chinese } from './ui-translations.mjs';

export const uiLanguages = [
  { id: 'system', name: 'Follow system' },
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-TW', name: '繁體中文' },
];
export function validUiLanguage(value) {
  return uiLanguages.some((language) => language.id === value);
}
export function resolveUiLocale(preference, deviceLanguages = []) {
  if (validUiLanguage(preference) && preference !== 'system') return preference;
  for (const language of deviceLanguages) {
    try {
      const locale = new Intl.Locale(language);
      if (locale.language === 'en') return 'en';
      if (locale.language === 'zh') {
        if (locale.script) return locale.script === 'Hant' ? 'zh-TW' : 'zh-CN';
        return ['TW', 'HK', 'MO'].includes(locale.region) ? 'zh-TW' : 'zh-CN';
      }
    } catch {
      /* Ignore malformed device hints. */
    }
  }
  return 'en';
}
export function uiText(locale, key, values = {}) {
  const entry = Object.hasOwn(chinese, key) ? chinese[key] : undefined;
  const text = locale === 'zh-CN' ? entry?.[0] : locale === 'zh-TW' ? entry?.[1] : key;
  return (typeof text === 'string' ? text : key).replace(/\{(\w+)\}/g, (token, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}
