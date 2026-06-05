import React, { useState, useEffect } from 'react';

export function getTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

export default function ThemeToggle({ locked = false }) {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    function handler(e) { setThemeState(e.detail); }
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  function toggle() {
    if (locked) return;
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setThemeState(next);
  }

  const isDark = theme === 'dark';
  const label = locked ? 'Mörkt låst' : isDark ? 'Ljust' : 'Mörkt';
  return (
    <button
      className={`topbar-theme-btn${locked ? ' topbar-theme-btn-locked' : ''}`}
      onClick={toggle}
      title={locked ? 'Supervisor är låst i mörkt läge' : isDark ? 'Byt till ljust läge' : 'Byt till mörkt läge'}
      type="button"
      disabled={locked}
      aria-disabled={locked}
    >
      <span className="topbar-theme-icon">{locked ? '☾' : isDark ? '☀' : '☾'}</span>
      <span className="topbar-theme-label">{label}</span>
    </button>
  );
}
