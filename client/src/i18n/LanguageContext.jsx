import React, { createContext, useContext, useMemo, useState } from 'react';
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, getTranslation, translateText } from './translations.js';

const LanguageContext = createContext(null);
const SUPPORTED_LANGUAGES = ['sv', 'en'];

function readInitialLanguage() {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.includes(saved) ? saved : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readInitialLanguage);

  function setLanguage(next) {
    const safeNext = SUPPORTED_LANGUAGES.includes(next) ? next : DEFAULT_LANGUAGE;
    setLanguageState(safeNext);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, safeNext);
    } catch {
      // localStorage can be unavailable in private or restricted browser contexts.
    }
  }

  const value = useMemo(() => ({
    language,
    setLanguage,
    t: (key, fallback) => getTranslation(language, key, fallback),
    tr: (value) => translateText(language, value),
  }), [language]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    return {
      language: DEFAULT_LANGUAGE,
      setLanguage: () => {},
      t: (key, fallback) => getTranslation(DEFAULT_LANGUAGE, key, fallback),
      tr: (value) => translateText(DEFAULT_LANGUAGE, value),
    };
  }
  return context;
}
