'use strict';

// Setup Focus Mode Service v1 — Read-only analysis layer.
// Selects top-performing setups, marks poor ones for warn/pause.
// Affects paper/replay analysis only — never live trading.
// actions_allowed=false, can_place_orders=false, live_trading_enabled=false

const fs   = require('fs');
const path = require('path');
const redisService     = require('./redisService');
const setupPerformance = require('./setupPerformanceService');

// ── Safety ────────────────────────────────────────────────────────────────────

const SAFETY = Object.freeze({
  actions_allowed:       false,
  can_place_orders:      false,
  live_trading_enabled:  false,
  can_create_trades:     false,
  can_modify_risk:       false,
  focus_mode_can_trade:  false,
  source:                'setup_focus_mode_v1',
});

// ── Paths + keys ──────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, '../../data/signals/setup-focus-config.json');

const KEYS = Object.freeze({
  status:         'setups:focus:status',
  config:         'setups:focus:config',
  top:            'setups:focus:top',
  recommendation: 'setups:focus:recommendation',
});

const TTL = Object.freeze({ status: 30, config: 60, top: 120, recommendation: 120 });

// ── Forbidden config keys (can never be set via updateFocusConfig) ────────────

const FORBIDDEN_CONFIG = new Set([
  'actions_allowed', 'can_place_orders', 'live_trading_enabled',
  'can_create_trades', 'can_modify_risk', 'focus_mode_can_trade',
]);

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  enabled:               false,
  mode:                  'paper_replay_only',
  top_setup_limit:       3,
  min_decisive_trades:   5,
  min_win_rate:          55,
  min_avg_pnl:           0,
  pause_worst_setups:    true,
  worst_setup_action:    'warn_only',  // 'warn_only' | 'block_paper' (v1 always warn_only)
});

// ── In-memory fallback ────────────────────────────────────────────────────────

const memCache = new Map();

async function rGet(key) {
  try { const v = await redisService.getJson(key, null); if (v) return v; } catch (_) {}
  const e = memCache.get(key);
  return (e && e.exp > Date.now()) ? e.v : null;
}

async function rSet(key, value, ttl) {
  try { await redisService.setJson(key, value, ttl); } catch (_) {}
  memCache.set(key, { v: value, exp: Date.now() + ttl * 1000 });
}

function invalidateAll() {
  for (const k of Object.values(KEYS)) memCache.delete(k);
}

// ── Config persistence ────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfigSync() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (_) {}
  return { ...DEFAULT_CONFIG };
}

function saveConfigSync(cfg) {
  ensureDir();
  const safe = { ...cfg };
  for (const k of FORBIDDEN_CONFIG) delete safe[k];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(safe, null, 2));
}

// ── Core selection logic ──────────────────────────────────────────────────────

async function selectTopSetups(limit = 3) {
  const cfg  = loadConfigSync();
  const perf = await setupPerformance.getPerformance();

  const minDecisive = cfg.min_decisive_trades ?? DEFAULT_CONFIG.min_decisive_trades;
  const minWr       = cfg.min_win_rate        ?? DEFAULT_CONFIG.min_win_rate;
  const minAvgPnl   = cfg.min_avg_pnl         ?? DEFAULT_CONFIG.min_avg_pnl;

  return perf.setups
    .filter(s =>
      s.decisive >= minDecisive &&
      s.win_rate !== null && s.win_rate >= minWr &&
      s.avg_pnl_pct >= minAvgPnl
    )
    .sort((a, b) => {
      // Primary: win rate; secondary: avg pnl
      if (b.win_rate !== a.win_rate) return (b.win_rate || 0) - (a.win_rate || 0);
      return (b.avg_pnl_pct || 0) - (a.avg_pnl_pct || 0);
    })
    .slice(0, limit);
}

async function selectWorstSetups() {
  const perf = await setupPerformance.getPerformance();
  return perf.setups
    .filter(s => s.category === 'poor' || s.category === 'pause')
    .sort((a, b) => (a.win_rate || 100) - (b.win_rate || 100));
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getFocusConfig() {
  const cached = await rGet(KEYS.config);
  if (cached) return cached;
  const cfg = loadConfigSync();
  const result = { ok: true, config: cfg, ...SAFETY };
  await rSet(KEYS.config, result, TTL.config);
  return result;
}

async function updateFocusConfig(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Input must be an object', ...SAFETY };
  }

  const current = loadConfigSync();
  const updates = {};

  const ALLOWED_KEYS = new Set([
    'enabled', 'top_setup_limit', 'min_decisive_trades',
    'min_win_rate', 'min_avg_pnl', 'pause_worst_setups', 'worst_setup_action',
  ]);

  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_CONFIG.has(k)) {
      return { ok: false, error: `Cannot set '${k}' — safety constant`, ...SAFETY };
    }
    if (!ALLOWED_KEYS.has(k)) continue;
    updates[k] = v;
  }

  // Validate ranges
  if (updates.top_setup_limit !== undefined) {
    const n = Number(updates.top_setup_limit);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return { ok: false, error: 'top_setup_limit must be 1–10', ...SAFETY };
    }
    updates.top_setup_limit = n;
  }
  if (updates.min_win_rate !== undefined) {
    const n = Number(updates.min_win_rate);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: 'min_win_rate must be 0–100', ...SAFETY };
    }
    updates.min_win_rate = n;
  }
  if (updates.min_decisive_trades !== undefined) {
    const n = Number(updates.min_decisive_trades);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'min_decisive_trades must be ≥1', ...SAFETY };
    }
    updates.min_decisive_trades = n;
  }
  if (updates.worst_setup_action !== undefined) {
    if (!['warn_only', 'block_paper'].includes(updates.worst_setup_action)) {
      return { ok: false, error: 'worst_setup_action must be warn_only or block_paper', ...SAFETY };
    }
  }

  const newCfg = { ...current, ...updates, updated_at: new Date().toISOString() };
  saveConfigSync(newCfg);
  invalidateAll();

  return { ok: true, config: newCfg, updated: Object.keys(updates), ...SAFETY };
}

async function getFocusSetups() {
  const cached = await rGet(KEYS.top);
  if (cached) return cached;

  const cfg  = loadConfigSync();
  const top  = await selectTopSetups(cfg.top_setup_limit);
  const poor = await selectWorstSetups();

  const result = {
    ok: true,
    enabled: cfg.enabled,
    focus_setups:     top.map(s => s.setup_id),
    focus_setups_detail: top,
    poor_setups:      poor.map(s => s.setup_id),
    poor_setups_detail: poor,
    focus_count: top.length,
    poor_count:  poor.length,
    ...SAFETY,
  };
  await rSet(KEYS.top, result, TTL.top);
  return result;
}

async function isFocusedSetup(setupId) {
  const focused = await getFocusSetups();
  return focused.focus_setups.includes(setupId);
}

async function shouldPauseSetup(setupId) {
  const cfg = loadConfigSync();
  if (!cfg.pause_worst_setups) return false;
  const focused = await getFocusSetups();
  return focused.poor_setups.includes(setupId);
}

async function buildFocusRecommendation() {
  const cached = await rGet(KEYS.recommendation);
  if (cached) return cached;

  const cfg     = loadConfigSync();
  const perf    = await setupPerformance.getPerformance();
  const top     = await selectTopSetups(cfg.top_setup_limit);
  const poor    = await selectWorstSetups();

  // Data quality check
  const totalDecisive = perf.setups.reduce((s, x) => s + x.decisive, 0);
  const dataQuality   = totalDecisive < 20 ? 'low' : totalDecisive < 50 ? 'medium' : 'high';
  const dataWarning   = dataQuality === 'low'
    ? 'Lite data — rekommendationerna är preliminära'
    : dataQuality === 'medium'
    ? 'Måttlig data — fortsätt samla trades för säkrare bild'
    : null;

  const topReasons = top.map(s => ({
    setup_id:   s.setup_id,
    label:      s.label,
    reason:     `${s.win_rate}% vinstprocent · ${s.decisive} avgörande trades · snitt ${s.avg_pnl_pct >= 0 ? '+' : ''}${s.avg_pnl_pct}%/trade`,
    win_rate:   s.win_rate,
    decisive:   s.decisive,
    avg_pnl:    s.avg_pnl_pct,
  }));

  const poorReasons = poor.map(s => ({
    setup_id:   s.setup_id,
    label:      s.label,
    reason:     `${s.win_rate}% vinstprocent · ${s.decisive} avgörande trades · ${s.category === 'pause' ? 'bör pausas' : 'underpresterar'}`,
    win_rate:   s.win_rate,
    action:     cfg.worst_setup_action,
  }));

  const result = {
    ok:              true,
    enabled:         cfg.enabled,
    mode:            cfg.mode,
    data_quality:    dataQuality,
    data_warning:    dataWarning,
    total_trades:    perf.total_trades,
    overall_win_rate: perf.overall_win_rate,
    focus_recommendation: top.length > 0
      ? `Fokusera på ${top.length} setup-mönster med ≥${cfg.min_win_rate}% vinstprocent`
      : `Ingen setup uppfyller kraven ännu — fortsätt samla data`,
    top: topReasons,
    poor: poorReasons,
    discovery_note: 'Discovery Mode samlar fortfarande data — alla setups kör som vanligt tills Focus Mode aktiveras',
    ...SAFETY,
  };

  await rSet(KEYS.recommendation, result, TTL.recommendation);
  return result;
}

async function getFocusModeStatus() {
  const cached = await rGet(KEYS.status);
  if (cached) return cached;

  const cfg  = loadConfigSync();
  const top  = await selectTopSetups(cfg.top_setup_limit);
  const poor = await selectWorstSetups();

  const status = {
    ok:                     true,
    enabled:                cfg.enabled,
    mode:                   cfg.mode,
    top_setup_limit:        cfg.top_setup_limit,
    focused_setup_count:    top.length,
    poor_setup_count:       poor.length,
    focus_setups:           top.map(s => s.setup_id),
    poor_setups:            poor.map(s => s.setup_id),
    pause_worst_setups:     cfg.pause_worst_setups,
    worst_setup_action:     cfg.worst_setup_action,
    config_updated_at:      cfg.updated_at || null,
    ...SAFETY,
  };

  await rSet(KEYS.status, status, TTL.status);
  return status;
}

module.exports = {
  getFocusConfig,
  updateFocusConfig,
  selectTopSetups,
  getFocusSetups,
  isFocusedSetup,
  shouldPauseSetup,
  buildFocusRecommendation,
  getFocusModeStatus,
  SAFETY,
};
