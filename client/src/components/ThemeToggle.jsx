import React, { useState, useEffect } from 'react';

export function getTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

export default function ThemeToggle() {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    function handler(e) { setThemeState(e.detail); }
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setThemeState(next);
  }

  const isDark = theme === 'dark';
  return (
    <button
      className="topbar-theme-btn"
      onClick={toggle}
      title={isDark ? 'Byt till ljust läge' : 'Byt till mörkt läge'}
      type="button"
    >
      <span className="topbar-theme-icon">{isDark ? '☀' : '☾'}</span>
      <span className="topbar-theme-label">{isDark ? 'Ljust' : 'Mörkt'}</span>
    </button>
  );
}
