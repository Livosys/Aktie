import React, { useCallback, useEffect, useState } from 'react';
import { configScope, CONFIG_SCOPES } from '../hooks/useUnifiedConfig.js';

export const ADVANCED_MODE_KEY = 'platform_advanced_mode_v1';

function readAdvancedMode() {
  try {
    if (typeof window === 'undefined') return false;
    const raw = window.localStorage.getItem(ADVANCED_MODE_KEY);
    return raw === null ? false : raw !== 'false';
  } catch {
    return false;
  }
}

function writeAdvancedMode(enabled) {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ADVANCED_MODE_KEY, String(enabled));
      window.dispatchEvent(new CustomEvent('advancedmodechange', { detail: enabled }));
    }
  } catch {}
}

export function useAdvancedMode() {
  const [advancedMode, setAdvancedModeState] = useState(readAdvancedMode);

  useEffect(() => {
    function syncFromStorage() {
      setAdvancedModeState(readAdvancedMode());
    }
    function syncFromEvent(event) {
      if (typeof event?.detail === 'boolean') {
        setAdvancedModeState(event.detail);
        return;
      }
      syncFromStorage();
    }

    window.addEventListener('advancedmodechange', syncFromEvent);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener('advancedmodechange', syncFromEvent);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  const setAdvancedMode = useCallback((next) => {
    const current = readAdvancedMode();
    const enabled = typeof next === 'function' ? Boolean(next(current)) : Boolean(next);
    writeAdvancedMode(enabled);
    setAdvancedModeState(enabled);
  }, []);

  return [advancedMode, setAdvancedMode];
}

export function useAdvancedModeListener() {
  return useAdvancedMode()[0];
}

export function AdvancedModeToggle({ value, onChange }) {
  return (
    <button
      type="button"
      className={`platform-advanced-toggle${value ? ' is-on' : ''}`}
      onClick={() => onChange(!value)}
      aria-pressed={value}
      title="Visa eller dölj avancerade AI- och strategimått"
    >
      <span>🧠</span>
      <span>Advanced Mode</span>
      <strong>{value ? 'PÅ' : 'AV'}</strong>
    </button>
  );
}

export function PlatformSafetyBar({ className = '' }) {
  return (
    <div className={`platform-safety-bar ${className}`.trim()}>
      <span>🔒</span>
      <strong>{CONFIG_SCOPES.SAFETY.label}</strong>
      <span>actions_allowed=false</span>
      <span>can_place_orders=false</span>
      <span>live_trading_enabled=false</span>
    </div>
  );
}

export function ConfigScopeBadge({ scope = 'ui', className = '' }) {
  const meta = configScope(scope);
  return (
    <span className={`config-scope-badge config-scope-${meta.key} ${className}`.trim()} title={meta.help}>
      <span>{meta.icon}</span>
      <span>{meta.label}</span>
    </span>
  );
}

export function PlatformEmptyState({ title, text, action }) {
  return (
    <div className="platform-empty-state">
      <div className="platform-empty-title">{title || 'Ingen data ännu'}</div>
      <div className="platform-empty-text">{text || 'Systemet väntar på ny analysdata.'}</div>
      {action}
    </div>
  );
}

export function safeDisplay(value, fallback = '–') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' && Number.isNaN(value)) return fallback;
  if (value === 'null' || value === 'undefined' || value === 'NaN') return fallback;
  return value;
}
