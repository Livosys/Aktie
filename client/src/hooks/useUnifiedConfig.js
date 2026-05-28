import { useCallback, useEffect, useSyncExternalStore } from 'react';

const TRADING_LAB_KEY = 'tradinglab_config_v1';
const TRADING_LAB_BACKUP_KEY = 'tradinglab_config_v1_backup';
const ADAPTIVE_KEY = 'ami_adaptive_mode_v1';
const ADVANCED_MODE_KEY = 'platform_advanced_mode_v1';
const GLOBAL_FILTER_KEY = 'trading_os_global_filters_v2';

export const DEFAULT_GLOBAL_FILTERS = {
  market: 'all',
  direction: 'all',
  minScore: 0,
  symbol: '',
  hideAvoid: true,
};

export const CONFIG_SCOPES = {
  GLOBAL: {
    key: 'global',
    label: 'Globalt aktiv',
    icon: '🟢',
    help: 'Detta läses av det riktiga systemet/scannern.',
  },
  TEST: {
    key: 'test',
    label: 'Bara detta test',
    icon: '🧪',
    help: 'Påverkar endast tester och analys.',
  },
  SAFETY: {
    key: 'safety',
    label: 'Safety alltid aktiv',
    icon: '🔒',
    help: 'Safety Engine är read-only i UI och kan inte stängas av.',
  },
  UI: {
    key: 'ui',
    label: 'Bara visualisering',
    icon: '👁️',
    help: 'Sparas bara som frontend/UI-state.',
  },
};

export const DEFAULT_TRADING_LAB_TOGGLES = {
  vwap_reclaim: true,
  vwap_rejection: true,
  ema_trend: true,
  ema_pullback: true,
  narrow_state: true,
  breakout: true,
  momentum: true,
  mean_reversion: false,
  volume_spike: true,
  ai_agent: true,
  trading_agents: true,
  historical_memory: true,
  market_gate: true,
  risk_engine: true,
  safety_engine: true,
  vwap_momentum: false,
  vwap_momentum_long: false,
  vwap_rejection_short: false,
  opening_range_breakout: false,
  opening_range_fakeout: false,
  ema_pullback_continuation: false,
  ema_breakdown: false,
  narrow_breakout: false,
  pullback_continuation: false,
  trend_continuation: false,
  support_bounce: false,
  resistance_rejection: false,
  index_confirmed_long: false,
  index_confirmed_short: false,
  crypto_momentum_scalper: false,
  low_volatility_breakout: false,
  high_volatility_reversal: false,
  gap_continuation: false,
  gap_fade: false,
  mean_reversion_vwap: false,
  volume_spike_momentum: false,
  index_trend_mode: false,
  sector_confirmation: false,
  news_volatility_watch: false,
};

export const DEFAULT_TRADING_LAB_PARAMS = {
  stop_loss: 1.5,
  take_profit: 3,
  confidence_threshold: 60,
  holding_time: 30,
  cooldown: 5,
  volume_filter: 1.0,
  risk_per_trade: 1.0,
  timeout: 30,
  momentum_requirement: 60,
  vwap_distance: 0.4,
  ema_distance: 0.5,
  narrow_sensitivity: 5,
  breakout_strength: 65,
  reversal_sensitivity: 55,
  max_volatility: 3.0,
  max_spread: 0.15,
  trend_requirement: 55,
  index_support: 'Normal',
  news_risk: 'Normal',
  certificate_risk: 'Hög',
};

export const DEFAULT_TRADING_LAB_EXITS = {
  trailing_stop: true,
  time_exit: true,
  ema_exit: false,
  vwap_exit: false,
  profit_target: true,
  dynamic_exit: false,
  volatility_exit: false,
};

const RESOURCE_DEFS = {
  systemHealth: {
    url: '/api/system/health',
    section: 'global',
    field: 'systemHealth',
    intervalMs: 30_000,
  },
  scanStatus: {
    url: '/api/status',
    section: 'global',
    field: 'scannerStatus',
    intervalMs: 30_000,
  },
  riskStatus: {
    url: '/api/risk/status',
    section: 'global',
    field: 'riskStatus',
    intervalMs: 45_000,
  },
  riskConfig: {
    url: '/api/risk/config',
    section: 'global',
    field: 'riskConfigResponse',
    intervalMs: 60_000,
  },
  safetyStatus: {
    url: '/api/safety/status',
    section: 'global',
    field: 'safetyStatus',
    intervalMs: 30_000,
  },
  safetyConfig: {
    url: '/api/safety/config',
    section: 'global',
    field: 'safetyConfigResponse',
    intervalMs: 60_000,
  },
  blockerConfig: {
    url: '/api/blockers/config',
    section: 'global',
    field: 'blockerConfig',
    intervalMs: 60_000,
  },
  marketUniverse: {
    url: '/api/markets/universe',
    section: 'global',
    field: 'marketUniverse',
    intervalMs: 60_000,
  },
  marketRegime: {
    url: '/api/market-regime/status',
    section: 'test',
    field: 'marketRegime',
    intervalMs: 60_000,
  },
  setupPerformance: {
    url: '/api/setups/performance',
    section: 'test',
    field: 'setupPerformance',
    intervalMs: 60_000,
  },
  paperPerformance: {
    url: '/api/paper-trading/performance',
    section: 'test',
    field: 'paperPerformance',
    intervalMs: 45_000,
  },
  prioritySummary: {
    url: '/api/priority/summary',
    section: 'test',
    field: 'prioritySummary',
    intervalMs: 30_000,
  },
};

const RESOURCE_GROUPS = {
  core: ['systemHealth', 'scanStatus', 'riskStatus', 'riskConfig', 'safetyStatus', 'safetyConfig', 'blockerConfig', 'marketUniverse', 'marketRegime', 'setupPerformance', 'paperPerformance', 'prioritySummary'],
  health: ['systemHealth', 'scanStatus'],
  safety: ['riskStatus', 'riskConfig', 'safetyStatus', 'safetyConfig', 'blockerConfig'],
  lab: ['marketUniverse', 'blockerConfig', 'marketRegime', 'setupPerformance', 'paperPerformance', 'prioritySummary'],
  results: ['setupPerformance', 'paperPerformance'],
  priority: ['prioritySummary'],
};

const listeners = new Set();
const inFlight = new Map();
const timers = new Map();
const lastLoadedAt = new Map();

let initialized = false;

let state = {
  global: {
    riskStatus: null,
    riskConfigResponse: null,
    riskConfig: null,
    safetyStatus: null,
    safetyConfigResponse: null,
    safetyConfig: null,
    blockerConfig: null,
    marketUniverse: null,
    scannerStatus: null,
    systemHealth: null,
  },
  test: {
    tradingLabConfig: loadTradingLabConfig(),
    adaptiveConfig: loadAdaptiveConfig(),
    marketRegime: null,
    setupPerformance: null,
    paperPerformance: null,
    prioritySummary: null,
  },
  ui: {
    advancedMode: readBoolean(ADVANCED_MODE_KEY, false),
    globalFilters: normalizeGlobalFilters(readJson(GLOBAL_FILTER_KEY, DEFAULT_GLOBAL_FILTERS)),
  },
  meta: {
    loading: true,
    lastUpdatedAt: null,
    errors: {},
  },
};

function readJson(key, fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readBoolean(key, fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw !== 'false';
  } catch {
    return fallback;
  }
}

function writeBoolean(key, value) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, String(value));
  } catch {}
}

function loadTradingLabConfig() {
  const saved = readJson(TRADING_LAB_KEY, {});
  return normalizeTradingLabConfig(saved);
}

function normalizeTradingLabConfig(input = {}) {
  const toggles = { ...DEFAULT_TRADING_LAB_TOGGLES, ...(input.toggles || {}) };
  toggles.risk_engine = true;
  toggles.safety_engine = true;
  return {
    toggles,
    params: { ...DEFAULT_TRADING_LAB_PARAMS, ...(input.params || {}) },
    exits: { ...DEFAULT_TRADING_LAB_EXITS, ...(input.exits || {}) },
    scope: CONFIG_SCOPES.TEST.key,
  };
}

function loadAdaptiveConfig() {
  return {
    enabled: readBoolean(ADAPTIVE_KEY, true),
    scope: CONFIG_SCOPES.TEST.key,
  };
}

function normalizeGlobalFilters(input = {}) {
  const minScore = Number(input.minScore);
  return {
    market: input.market || DEFAULT_GLOBAL_FILTERS.market,
    direction: input.direction || DEFAULT_GLOBAL_FILTERS.direction,
    minScore: Number.isFinite(minScore) ? minScore : DEFAULT_GLOBAL_FILTERS.minScore,
    symbol: String(input.symbol || '').toUpperCase().trim(),
    hideAvoid: Boolean(input.hideAvoid),
  };
}

function notify() {
  listeners.forEach((listener) => listener());
}

function setState(updater) {
  const next = typeof updater === 'function' ? updater(state) : updater;
  state = next;
  notify();
}

function patchNested(section, field, value) {
  setState((prev) => {
    const nextSection = { ...prev[section], [field]: value };
    if (field === 'riskConfigResponse') nextSection.riskConfig = value?.config || value || null;
    if (field === 'safetyConfigResponse') nextSection.safetyConfig = { ...(value?.config || value || {}), enabled: true };
    return {
      ...prev,
      [section]: nextSection,
      meta: {
        ...prev.meta,
        loading: false,
        lastUpdatedAt: new Date().toISOString(),
      },
    };
  });
}

function patchError(key, error) {
  setState((prev) => ({
    ...prev,
    meta: {
      ...prev.meta,
      loading: false,
      errors: { ...prev.meta.errors, [key]: error },
    },
  }));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function loadResource(key, { force = false } = {}) {
  const def = RESOURCE_DEFS[key];
  if (!def) return null;
  const last = lastLoadedAt.get(key) || 0;
  if (!force && Date.now() - last < 1_000) return state[def.section]?.[def.field] || null;
  if (inFlight.has(key)) return inFlight.get(key);

  const request = fetchJson(def.url)
    .then((data) => {
      lastLoadedAt.set(key, Date.now());
      patchNested(def.section, def.field, data);
      return data;
    })
    .catch((err) => {
      patchError(key, err.message || String(err));
      return null;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

function keysFor(scope) {
  if (Array.isArray(scope)) return scope;
  if (!scope || scope === 'core') return RESOURCE_GROUPS.core;
  return RESOURCE_GROUPS[scope] || [scope];
}

function startTimer(key) {
  if (timers.has(key)) return;
  const def = RESOURCE_DEFS[key];
  if (!def?.intervalMs) return;
  if (typeof window === 'undefined') return;
  timers.set(key, window.setInterval(() => loadResource(key), def.intervalMs));
}

function ensureInitialized(scope = 'core') {
  const keys = keysFor(scope).filter(Boolean);
  keys.forEach(startTimer);
  keys.forEach((key) => loadResource(key));
  if (!initialized) initialized = true;
}

function updateTradingLabConfig(patch) {
  setState((prev) => {
    const current = prev.test.tradingLabConfig || normalizeTradingLabConfig();
    const incoming = typeof patch === 'function' ? patch(current) : patch;
    const next = normalizeTradingLabConfig({
      toggles: { ...current.toggles, ...(incoming?.toggles || {}) },
      params: { ...current.params, ...(incoming?.params || {}) },
      exits: { ...current.exits, ...(incoming?.exits || {}) },
    });
    writeJson(TRADING_LAB_KEY, next);
    return {
      ...prev,
      test: { ...prev.test, tradingLabConfig: next },
    };
  });
}

function replaceTradingLabConfig(nextConfig) {
  const next = normalizeTradingLabConfig(nextConfig);
  writeJson(TRADING_LAB_KEY, next);
  setState((prev) => ({
    ...prev,
    test: { ...prev.test, tradingLabConfig: next },
  }));
}

function backupTradingLabConfig() {
  writeJson(TRADING_LAB_BACKUP_KEY, state.test.tradingLabConfig);
}

function restoreTradingLabConfigBackup() {
  const backup = readJson(TRADING_LAB_BACKUP_KEY, null);
  if (!backup) return false;
  replaceTradingLabConfig(backup);
  return true;
}

function setAdaptiveEnabled(enabled) {
  writeBoolean(ADAPTIVE_KEY, enabled);
  setState((prev) => ({
    ...prev,
    test: {
      ...prev.test,
      adaptiveConfig: { enabled, scope: CONFIG_SCOPES.TEST.key },
    },
  }));
}

function setAdvancedMode(enabled) {
  writeBoolean(ADVANCED_MODE_KEY, enabled);
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('advancedmodechange', { detail: enabled }));
  } catch {}
  setState((prev) => ({
    ...prev,
    ui: { ...prev.ui, advancedMode: enabled },
  }));
}

function setGlobalFilters(patch) {
  setState((prev) => {
    const current = normalizeGlobalFilters(prev.ui.globalFilters);
    const incoming = typeof patch === 'function' ? patch(current) : patch;
    const next = normalizeGlobalFilters({ ...current, ...(incoming || {}) });
    writeJson(GLOBAL_FILTER_KEY, next);
    return {
      ...prev,
      ui: { ...prev.ui, globalFilters: next },
    };
  });
}

function resetGlobalFilters() {
  setGlobalFilters(DEFAULT_GLOBAL_FILTERS);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

export function useUnifiedConfig(scope = 'core') {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureInitialized(scope);
  }, [scope]);

  const refresh = useCallback((target = scope, options = {}) => {
    const keys = keysFor(target);
    return Promise.all(keys.map((key) => loadResource(key, { ...options, force: true })));
  }, [scope]);

  return {
    ...snapshot,
    scopes: CONFIG_SCOPES,
    refresh,
    updateTradingLabConfig,
    replaceTradingLabConfig,
    backupTradingLabConfig,
    restoreTradingLabConfigBackup,
    setAdaptiveEnabled,
    setAdvancedMode,
    setGlobalFilters,
    resetGlobalFilters,
  };
}

export function configScope(scopeKey) {
  return Object.values(CONFIG_SCOPES).find((scope) => scope.key === scopeKey) || CONFIG_SCOPES.UI;
}
