import { useMemo } from 'react';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  getTranslation,
  translateText,
  translations,
} from './translations.js';

function readStoredLanguage() {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && translations[stored]) return stored;
  } catch (_) {
    // Read-only fallback.
  }
  const browserLanguage = typeof navigator !== 'undefined' ? String(navigator.language || '').slice(0, 2).toLowerCase() : '';
  return translations[browserLanguage] ? browserLanguage : DEFAULT_LANGUAGE;
}

export function useLanguage() {
  const language = readStoredLanguage();
  return useMemo(() => ({
    language,
    t(key, fallback = '') {
      return getTranslation(language, key, fallback || key);
    },
    tr(value) {
      return translateText(language, value);
    },
  }), [language]);
}

