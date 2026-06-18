'use strict';

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_CONFIG = Object.freeze({
  paperRuntimeEnabled: true,
  paperEquitiesEnabled: true,
  paperCryptoEnabled: false,
  maxNewPaperTradesPerDay: 3,
  maxOpenPaperTrades: 3,
  dailyCandidatesMode: 'preview_only',
  minPaperGateScore: 70,
  nearMissLearningEnabled: true,
  nearMissLearningMargin: 5,
  allowSoftStatusesForPaper: false,
  allowWeakVolumeForPaper: false,
  emergencyPause: false,
  updatedAt: null,
  updatedBy: 'manual',
});

const CACHE_TTL_MS = 10_000;
const DATA_FILE = path.resolve(__dirname, '../../data/paper-trading/market-config.json');

let _cache = null;
let _cacheAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function dataFile(options = {}) {
  return path.resolve(options.dataFile || DATA_FILE);
}

function normalizeToggle(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (!Number.isFinite(rounded)) return fallback;
  return Math.max(min, Math.min(max, rounded));
}

function normalizeMode(value, fallback) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return fallback;
  if (mode === 'preview_only' || mode === 'auto_paper') return mode;
  return fallback;
}

function normalizeStoredConfig(parsed = {}) {
  const legacyCrypto = parsed.cryptoPaperEnabled;
  const legacyEquity = parsed.equityPaperEnabled;
  const legacyRuntime = parsed.paperRuntimeEnabled;
  const legacyEquities = parsed.paperEquitiesEnabled;
  const legacyPaperCrypto = parsed.paperCryptoEnabled;

  return {
    paperRuntimeEnabled: normalizeToggle(
      legacyRuntime,
      normalizeToggle(parsed.paperRuntimeEnabled, DEFAULT_CONFIG.paperRuntimeEnabled),
    ),
    paperEquitiesEnabled: normalizeToggle(
      legacyEquities,
      normalizeToggle(legacyEquity, DEFAULT_CONFIG.paperEquitiesEnabled),
    ),
    paperCryptoEnabled: normalizeToggle(
      legacyPaperCrypto,
      normalizeToggle(legacyCrypto, DEFAULT_CONFIG.paperCryptoEnabled),
    ),
    maxNewPaperTradesPerDay: normalizePositiveInt(
      parsed.maxNewPaperTradesPerDay,
      DEFAULT_CONFIG.maxNewPaperTradesPerDay,
      1,
      10,
    ),
    maxOpenPaperTrades: normalizePositiveInt(
      parsed.maxOpenPaperTrades,
      DEFAULT_CONFIG.maxOpenPaperTrades,
      1,
      5,
    ),
    dailyCandidatesMode: normalizeMode(parsed.dailyCandidatesMode, DEFAULT_CONFIG.dailyCandidatesMode),
    minPaperGateScore: normalizePositiveInt(
      parsed.minPaperGateScore,
      DEFAULT_CONFIG.minPaperGateScore,
      50,
      70,
    ),
    nearMissLearningEnabled: normalizeToggle(parsed.nearMissLearningEnabled, DEFAULT_CONFIG.nearMissLearningEnabled),
    nearMissLearningMargin: normalizePositiveInt(
      parsed.nearMissLearningMargin,
      DEFAULT_CONFIG.nearMissLearningMargin,
      1,
      10,
    ),
    allowSoftStatusesForPaper: normalizeToggle(parsed.allowSoftStatusesForPaper, DEFAULT_CONFIG.allowSoftStatusesForPaper),
    allowWeakVolumeForPaper: normalizeToggle(parsed.allowWeakVolumeForPaper, DEFAULT_CONFIG.allowWeakVolumeForPaper),
    emergencyPause: normalizeToggle(parsed.emergencyPause, DEFAULT_CONFIG.emergencyPause),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    updatedBy: typeof parsed.updatedBy === 'string' && parsed.updatedBy.trim() ? parsed.updatedBy.trim() : DEFAULT_CONFIG.updatedBy,
  };
}

function configWithAliases(config) {
  return {
    ...config,
    cryptoPaperEnabled: config.paperCryptoEnabled,
    equityPaperEnabled: config.paperEquitiesEnabled,
  };
}

function readConfigFile(options = {}) {
  const file = dataFile(options);
  const now = Date.now();
  if (!options.force && _cache && _cache.file === file && (now - _cacheAt) < CACHE_TTL_MS) {
    return _cache.result;
  }

  try {
    if (!fs.existsSync(file)) {
      const result = { config: { ...DEFAULT_CONFIG }, warning: 'paper_market_config_missing' };
      _cache = { file, result };
      _cacheAt = now;
      return result;
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      const result = { config: { ...DEFAULT_CONFIG }, warning: 'paper_market_config_invalid' };
      _cache = { file, result };
      _cacheAt = now;
      return result;
    }

    const config = normalizeStoredConfig(parsed);

    const result = { config };
    _cache = { file, result };
    _cacheAt = now;
    return result;
  } catch (_) {
    const result = { config: { ...DEFAULT_CONFIG }, warning: 'paper_market_config_corrupt' };
    _cache = { file, result };
    _cacheAt = now;
    return result;
  }
}

function writeConfigFile(file, config) {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function readPaperMarketConfig(options = {}) {
  const file = dataFile(options);
  const { config, warning } = readConfigFile({ ...options, dataFile: file });
  return {
    ok: true,
    ...configWithAliases(config),
    ...(warning ? { warning } : {}),
    safety: SAFETY,
  };
}

function isCryptoSymbol(symbol) {
  return /USDT$/i.test(String(symbol || '').trim().toUpperCase());
}

function getPaperMarketForSymbol(symbol) {
  return isCryptoSymbol(symbol) ? 'crypto' : 'equity';
}

function isPaperMarketEnabled(symbol, configInput = null) {
  const config = configInput && typeof configInput === 'object'
    ? {
        paperCryptoEnabled: configInput.paperCryptoEnabled !== false && configInput.cryptoPaperEnabled !== false,
        paperEquitiesEnabled: configInput.paperEquitiesEnabled !== false && configInput.equityPaperEnabled !== false,
      }
    : readPaperMarketConfig();
  const market = getPaperMarketForSymbol(symbol);
  return market === 'crypto' ? config.paperCryptoEnabled !== false : config.paperEquitiesEnabled !== false;
}

function getPaperMarketGateDecision(symbol, configInput = null) {
  const market = getPaperMarketForSymbol(symbol);
  const enabled = isPaperMarketEnabled(symbol, configInput);
  if (enabled) {
    return {
      allowed: true,
      market,
      blockedReason: null,
      reasonSv: null,
      safety: SAFETY,
    };
  }
  const blockedReason = market === 'crypto'
    ? 'paper_crypto_disabled_by_user'
    : 'paper_equities_disabled_by_user';
  const reasonSv = market === 'crypto'
    ? 'Crypto paper trading är avstängt av användaren.'
    : 'Aktie/QQQ paper trading är avstängt av användaren.';
  return {
    allowed: false,
    market,
    blockedReason,
    reasonSv,
    safety: SAFETY,
  };
}

function getPaperRuntimeGateDecision(candidate = {}, runtimeState = {}, configInput = null) {
  const config = configInput && typeof configInput === 'object'
    ? normalizeStoredConfig(configInput)
    : readPaperMarketConfig();
  const symbol = candidate?.symbol || null;
  const market = getPaperMarketForSymbol(symbol);
  const status = String(candidate?.status || '').toLowerCase();
  const volumeState = String(candidate?.volumeState || '').toLowerCase();
  const gateScore = Number(candidate?.gateScore ?? candidate?.score ?? candidate?.priorityScore);
  const dailyNewPaperTrades = Number(runtimeState?.dailyNewPaperTrades);
  const openPaperTrades = Number(runtimeState?.openPaperTrades);

  if (config.paperRuntimeEnabled === false) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_runtime_disabled_by_user',
      reasonSv: 'Paper runtime är avstängd av användaren.',
      safety: SAFETY,
    };
  }
  if (config.emergencyPause === true) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_emergency_pause',
      reasonSv: 'Emergency pause är aktiv.',
      safety: SAFETY,
    };
  }
  if (market === 'crypto' && config.paperCryptoEnabled === false) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_crypto_disabled_by_user',
      reasonSv: 'Crypto paper trading är avstängt av användaren.',
      safety: SAFETY,
    };
  }
  if (market !== 'crypto' && config.paperEquitiesEnabled === false) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_equities_disabled_by_user',
      reasonSv: 'Aktie/QQQ paper trading är avstängt av användaren.',
      safety: SAFETY,
    };
  }
  if (config.dailyCandidatesMode === 'preview_only') {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_daily_candidates_preview_only',
      reasonSv: 'Daily candidates är i preview-only-läge.',
      safety: SAFETY,
    };
  }
  if (Number.isFinite(dailyNewPaperTrades) && dailyNewPaperTrades >= config.maxNewPaperTradesPerDay) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_daily_limit_reached',
      reasonSv: 'Dagsgränsen för nya paper trades är nådd.',
      safety: SAFETY,
    };
  }
  if (Number.isFinite(openPaperTrades) && openPaperTrades >= config.maxOpenPaperTrades) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_open_trade_limit_reached',
      reasonSv: 'Max antal öppna paper trades är nått.',
      safety: SAFETY,
    };
  }
  if (!config.allowSoftStatusesForPaper && ['wait', 'active'].includes(status)) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_soft_status_blocked',
      reasonSv: 'Soft status är inte tillåten i paper runtime.',
      safety: SAFETY,
    };
  }
  if (!config.allowWeakVolumeForPaper && ['weak', 'low', 'very_low'].includes(volumeState)) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_weak_volume_blocked',
      reasonSv: 'Svag volym är inte tillåten i paper runtime.',
      safety: SAFETY,
    };
  }
  if (Number.isFinite(gateScore) && gateScore < config.minPaperGateScore) {
    return {
      allowed: false,
      market,
      blockedReason: 'paper_gate_score_too_low',
      reasonSv: `Paper gate score är för låg (${gateScore} < ${config.minPaperGateScore}).`,
      safety: SAFETY,
    };
  }
  return {
    allowed: true,
    market,
    blockedReason: null,
    reasonSv: null,
    safety: SAFETY,
  };
}

function validateUpdatePatch(patch = {}) {
  const allowedKeys = new Set([
    'paperRuntimeEnabled',
    'paperEquitiesEnabled',
    'paperCryptoEnabled',
    'cryptoPaperEnabled',
    'equityPaperEnabled',
    'maxNewPaperTradesPerDay',
    'maxOpenPaperTrades',
    'dailyCandidatesMode',
    'minPaperGateScore',
    'nearMissLearningEnabled',
    'nearMissLearningMargin',
    'allowSoftStatusesForPaper',
    'allowWeakVolumeForPaper',
    'emergencyPause',
    'updatedBy',
  ]);
  for (const key of Object.keys(patch || {})) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `unknown_field:${key}` };
    }
  }
  if ('paperRuntimeEnabled' in patch && typeof patch.paperRuntimeEnabled !== 'boolean') return { ok: false, error: 'paperRuntimeEnabled måste vara boolean.' };
  if ('paperEquitiesEnabled' in patch && typeof patch.paperEquitiesEnabled !== 'boolean') return { ok: false, error: 'paperEquitiesEnabled måste vara boolean.' };
  if ('paperCryptoEnabled' in patch && typeof patch.paperCryptoEnabled !== 'boolean') return { ok: false, error: 'paperCryptoEnabled måste vara boolean.' };
  if ('cryptoPaperEnabled' in patch && typeof patch.cryptoPaperEnabled !== 'boolean') return { ok: false, error: 'cryptoPaperEnabled måste vara boolean.' };
  if ('equityPaperEnabled' in patch && typeof patch.equityPaperEnabled !== 'boolean') return { ok: false, error: 'equityPaperEnabled måste vara boolean.' };
  if ('maxNewPaperTradesPerDay' in patch) {
    const n = Number(patch.maxNewPaperTradesPerDay);
    if (!Number.isFinite(n) || Math.round(n) < 1 || Math.round(n) > 10) return { ok: false, error: 'maxNewPaperTradesPerDay måste vara ett heltal mellan 1 och 10.' };
  }
  if ('maxOpenPaperTrades' in patch) {
    const n = Number(patch.maxOpenPaperTrades);
    if (!Number.isFinite(n) || Math.round(n) < 1 || Math.round(n) > 5) return { ok: false, error: 'maxOpenPaperTrades måste vara ett heltal mellan 1 och 5.' };
  }
  if ('dailyCandidatesMode' in patch && !['preview_only', 'auto_paper'].includes(String(patch.dailyCandidatesMode || '').trim().toLowerCase())) {
    return { ok: false, error: 'dailyCandidatesMode måste vara preview_only eller auto_paper.' };
  }
  if ('minPaperGateScore' in patch) {
    const n = Number(patch.minPaperGateScore);
    if (!Number.isFinite(n) || Math.round(n) < 50 || Math.round(n) > 70) return { ok: false, error: 'minPaperGateScore måste vara ett heltal mellan 50 och 70.' };
  }
  if ('nearMissLearningEnabled' in patch && typeof patch.nearMissLearningEnabled !== 'boolean') return { ok: false, error: 'nearMissLearningEnabled måste vara boolean.' };
  if ('nearMissLearningMargin' in patch) {
    const n = Number(patch.nearMissLearningMargin);
    if (!Number.isFinite(n) || Math.round(n) < 1 || Math.round(n) > 10) return { ok: false, error: 'nearMissLearningMargin måste vara ett heltal mellan 1 och 10.' };
  }
  if ('allowSoftStatusesForPaper' in patch && typeof patch.allowSoftStatusesForPaper !== 'boolean') return { ok: false, error: 'allowSoftStatusesForPaper måste vara boolean.' };
  if ('allowWeakVolumeForPaper' in patch && typeof patch.allowWeakVolumeForPaper !== 'boolean') return { ok: false, error: 'allowWeakVolumeForPaper måste vara boolean.' };
  if ('emergencyPause' in patch && typeof patch.emergencyPause !== 'boolean') return { ok: false, error: 'emergencyPause måste vara boolean.' };
  return { ok: true };
}

function updatePaperMarketConfig(patch = {}, options = {}) {
  const file = dataFile(options);
  const current = normalizeStoredConfig(readConfigFile({ ...options, dataFile: file }).config || { ...DEFAULT_CONFIG });
  const validation = validateUpdatePatch(patch);
  if (!validation.ok) {
    return { ok: false, error: validation.error, ...SAFETY };
  }

  const mergedPatch = {
    ...patch,
    paperCryptoEnabled: patch.paperCryptoEnabled ?? patch.cryptoPaperEnabled,
    paperEquitiesEnabled: patch.paperEquitiesEnabled ?? patch.equityPaperEnabled,
  };
  const next = normalizeStoredConfig({
    ...current,
    ...mergedPatch,
    updatedAt: current.updatedAt || null,
    updatedBy: current.updatedBy || DEFAULT_CONFIG.updatedBy,
  });

  const payload = {
    ...next,
    updatedAt: nowIso(),
    updatedBy: typeof patch.updatedBy === 'string' && patch.updatedBy.trim()
      ? patch.updatedBy.trim()
      : DEFAULT_CONFIG.updatedBy,
  };

  writeConfigFile(file, payload);
  _cache = null;
  _cacheAt = 0;

  const currentConfig = readPaperMarketConfig({ ...options, dataFile: file });
  return {
    ok: true,
    changed: JSON.stringify(normalizeStoredConfig(payload)) !== JSON.stringify(current),
    ...currentConfig,
  };
}

module.exports = {
  SAFETY,
  DEFAULT_CONFIG,
  readPaperMarketConfig,
  updatePaperMarketConfig,
  getPaperRuntimeGateDecision,
  isCryptoSymbol,
  getPaperMarketForSymbol,
  isPaperMarketEnabled,
  getPaperMarketGateDecision,
  _internal: {
    readConfigFile,
    writeConfigFile,
    dataFile,
    normalizeStoredConfig,
    validateUpdatePatch,
  },
};
