// SPDX-License-Identifier: MIT
import translations from '../public/native-connection-language.json' with { type: 'json' };
import { resolveUiLocale } from './ui-language.mjs';

export function connectionText(locale, key, values = {}) {
  const index = resolveUiLocale(locale) === 'zh-CN' ? 0 : locale === 'zh-TW' ? 1 : -1;
  const entry = Object.hasOwn(translations, key) ? translations[key] : undefined;
  const text = index >= 0 && Array.isArray(entry) ? entry[index] : key;
  return text.replace(/\{(\w+)\}/g, (token, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}
