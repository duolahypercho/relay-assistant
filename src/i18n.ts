import { useEffect, useSyncExternalStore } from 'react';
import { resolveUiLocale, uiText, validUiLanguage } from '../shared/ui-language.mjs';

export const languagePreferenceKey = 'relay.ui-language';
const listeners = new Set<() => void>();
function savedPreference() {
  try {
    const value = localStorage.getItem(languagePreferenceKey);
    return validUiLanguage(value) ? value! : 'system';
  } catch {
    return 'system';
  }
}
let preference = savedPreference();
export const uiLocale = () =>
  resolveUiLocale(preference, [...(navigator.languages || [navigator.language])]);
export const tr = (key: string, values: Record<string, string | number> = {}) =>
  uiText(uiLocale(), key, values);
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === languagePreferenceKey) {
    preference = savedPreference();
    notify();
  }
});
window.addEventListener('languagechange', notify);
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => `${preference}:${uiLocale()}`;
export function setUiLanguage(value: string) {
  if (!validUiLanguage(value)) throw new Error('Choose an available app language.');
  // Persist before changing the UI; a failed save must not pretend to survive a relaunch.
  localStorage.setItem(languagePreferenceKey, value);
  preference = value;
  notify();
}
export function useUiLanguage() {
  useSyncExternalStore(subscribe, snapshot);
  return { preference, locale: uiLocale(), setLanguage: setUiLanguage, tr };
}
export function useDocumentLanguage() {
  const language = useUiLanguage();
  useEffect(() => {
    document.documentElement.lang = language.locale;
    document.documentElement.dir = 'ltr';
    document.title = tr('Relay · Your personal workspace');
  }, [language.locale]);
}
