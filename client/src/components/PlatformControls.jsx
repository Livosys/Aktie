import React from 'react';
import { configScope, CONFIG_SCOPES, useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

export const ADVANCED_MODE_KEY = 'platform_advanced_mode_v1';

export function useAdvancedMode() {
  const unified = useUnifiedConfig('core');
  return [unified.ui.advancedMode, unified.setAdvancedMode];
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
