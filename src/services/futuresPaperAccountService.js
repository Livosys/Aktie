'use strict';

const storageService = require('./futuresPaperStorageService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_account',
});

const DEFAULT_CONFIG = Object.freeze({
  currency: 'SEK',
  startingBalanceSek: 250000,
  fxUsdSek: 10.5,
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return round(n, 2);
}

// PnL-fält får vara negativa — clampMoney är bara för saldon/marginaler.
function signedMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round(n, 2);
}

function buildAccountSnapshot({ config, state, updatedAt = null } = {}) {
  const cfg = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const st = state && typeof state === 'object' ? state : {};
  const startingBalanceSek = clampMoney(st.startingBalanceSek ?? cfg.startingBalanceSek ?? DEFAULT_CONFIG.startingBalanceSek) ?? DEFAULT_CONFIG.startingBalanceSek;
  const cashSek = clampMoney(st.cashSek ?? startingBalanceSek) ?? startingBalanceSek;
  const equitySek = clampMoney(st.equitySek ?? cashSek) ?? cashSek;
  const realizedPnlSek = signedMoney(st.realizedPnlSek ?? 0) ?? 0;
  const unrealizedPnlSek = signedMoney(st.unrealizedPnlSek ?? 0) ?? 0;
  const totalPnlSek = signedMoney(st.totalPnlSek ?? (equitySek - startingBalanceSek)) ?? round(equitySek - startingBalanceSek, 2);
  const dailyPnlSek = signedMoney(st.dailyPnlSek ?? totalPnlSek) ?? totalPnlSek;
  const peakEquitySek = clampMoney(st.peakEquitySek ?? Math.max(startingBalanceSek, equitySek)) ?? Math.max(startingBalanceSek, equitySek);
  const drawdownSek = clampMoney(st.drawdownSek ?? Math.max(0, peakEquitySek - equitySek)) ?? Math.max(0, peakEquitySek - equitySek);
  const drawdownPct = peakEquitySek > 0 ? round((drawdownSek / peakEquitySek) * 100, 2) : 0;
  const openExposureSek = clampMoney(st.openExposureSek ?? 0) ?? 0;
  const usedMarginSek = clampMoney(st.usedMarginSek ?? 0) ?? 0;
  const availableMarginSek = clampMoney(st.availableMarginSek ?? Math.max(0, cashSek - usedMarginSek)) ?? Math.max(0, cashSek - usedMarginSek);
  const buyingPowerSek = clampMoney(st.buyingPowerSek ?? Math.max(availableMarginSek, cashSek)) ?? Math.max(availableMarginSek, cashSek);
  const totalFeesSek = clampMoney(st.totalFeesSek ?? 0) ?? 0;
  const fxUsdSek = clampMoney(st.fxUsdSek ?? cfg.fxUsdSek ?? DEFAULT_CONFIG.fxUsdSek) ?? DEFAULT_CONFIG.fxUsdSek;

  return {
    currency: cfg.currency || DEFAULT_CONFIG.currency,
    startingBalanceSek,
    cashSek,
    equitySek,
    realizedPnlSek,
    unrealizedPnlSek,
    totalPnlSek,
    dailyPnlSek,
    peakEquitySek,
    drawdownSek,
    drawdownPct,
    openExposureSek,
    buyingPowerSek,
    usedMarginSek,
    availableMarginSek,
    totalFeesSek,
    fxUsdSek,
    updatedAt: updatedAt || st.updatedAt || nowIso(),
  };
}

function createDefaultState(config = DEFAULT_CONFIG, now = new Date()) {
  const startingBalanceSek = clampMoney(config.startingBalanceSek ?? DEFAULT_CONFIG.startingBalanceSek) ?? DEFAULT_CONFIG.startingBalanceSek;
  const fxUsdSek = clampMoney(config.fxUsdSek ?? DEFAULT_CONFIG.fxUsdSek) ?? DEFAULT_CONFIG.fxUsdSek;
  const updatedAt = nowIso(now);
  return buildAccountSnapshot({
    config: { currency: config.currency || DEFAULT_CONFIG.currency, startingBalanceSek, fxUsdSek },
    state: {
      startingBalanceSek,
      cashSek: startingBalanceSek,
      equitySek: startingBalanceSek,
      realizedPnlSek: 0,
      unrealizedPnlSek: 0,
      totalPnlSek: 0,
      dailyPnlSek: 0,
      peakEquitySek: startingBalanceSek,
      drawdownSek: 0,
      drawdownPct: 0,
      openExposureSek: 0,
      buyingPowerSek: startingBalanceSek,
      usedMarginSek: 0,
      availableMarginSek: startingBalanceSek,
      fxUsdSek,
      updatedAt,
    },
    updatedAt,
  });
}

function createAccountEvent(type, payload = {}) {
  return {
    eventId: `futures_account_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    timestamp: nowIso(),
    ...payload,
    ...SAFETY,
  };
}

function normalizeHistoryOptions(options = {}) {
  const includeHistory = options.includeHistory !== false;
  const rawLimit = options.historyLimit;
  const parsedLimit = rawLimit === null || rawLimit === undefined || rawLimit === ''
    ? null
    : Number(rawLimit);
  const historyLimit = Number.isFinite(parsedLimit) && parsedLimit >= 0
    ? Math.floor(parsedLimit)
    : null;
  return {
    includeHistory: includeHistory && historyLimit !== 0,
    historyLimit,
  };
}

function applyHistoryLimit(rows, limit) {
  if (!Array.isArray(rows)) return [];
  if (limit === null) return rows;
  return rows.slice(-limit);
}

function createFuturesPaperAccountService(options = {}) {
  const storage = options.storageService || storageService.defaultFuturesPaperStorageService;

  function ensureFiles() {
    storage.ensureDefaults(DEFAULT_CONFIG, createDefaultState(DEFAULT_CONFIG));
  }

  function readConfig() {
    ensureFiles();
    const raw = storage.readAccountConfig(DEFAULT_CONFIG) || DEFAULT_CONFIG;
    return {
      currency: raw.currency || DEFAULT_CONFIG.currency,
      startingBalanceSek: clampMoney(raw.startingBalanceSek ?? DEFAULT_CONFIG.startingBalanceSek) ?? DEFAULT_CONFIG.startingBalanceSek,
      fxUsdSek: clampMoney(raw.fxUsdSek ?? DEFAULT_CONFIG.fxUsdSek) ?? DEFAULT_CONFIG.fxUsdSek,
      updatedAt: raw.updatedAt || null,
    };
  }

  function writeConfig(nextConfig) {
    const config = {
      currency: nextConfig.currency || DEFAULT_CONFIG.currency,
      startingBalanceSek: clampMoney(nextConfig.startingBalanceSek ?? DEFAULT_CONFIG.startingBalanceSek) ?? DEFAULT_CONFIG.startingBalanceSek,
      fxUsdSek: clampMoney(nextConfig.fxUsdSek ?? DEFAULT_CONFIG.fxUsdSek) ?? DEFAULT_CONFIG.fxUsdSek,
      updatedAt: nowIso(),
    };
    storage.writeAccountConfig(config);
    return config;
  }

  function readState() {
    ensureFiles();
    return storage.readAccountState(null);
  }

  function writeState(snapshot) {
    const state = { ...snapshot, updatedAt: nowIso() };
    storage.writeAccountState(state);
    storage.appendEquityCurve({
      timestamp: state.updatedAt,
      currency: state.currency,
      startingBalanceSek: state.startingBalanceSek,
      cashSek: state.cashSek,
      equitySek: state.equitySek,
      realizedPnlSek: state.realizedPnlSek,
      unrealizedPnlSek: state.unrealizedPnlSek,
      totalPnlSek: state.totalPnlSek,
      dailyPnlSek: state.dailyPnlSek,
      peakEquitySek: state.peakEquitySek,
      drawdownSek: state.drawdownSek,
      drawdownPct: state.drawdownPct,
      openExposureSek: state.openExposureSek,
      buyingPowerSek: state.buyingPowerSek,
      usedMarginSek: state.usedMarginSek,
      availableMarginSek: state.availableMarginSek,
      fxUsdSek: state.fxUsdSek,
      ...SAFETY,
    });
    return state;
  }

  function persistEvent(type, payload = {}) {
    return storage.appendEvent(createAccountEvent(type, payload));
  }

  function readHistory(historyLimit = null) {
    const events = storage.readJsonl ? storage.readJsonl(storage.files.events) : [];
    const equityCurve = storage.readJsonl ? storage.readJsonl(storage.files.equityCurve) : [];
    return {
      events: applyHistoryLimit(events, historyLimit),
      equityCurve: applyHistoryLimit(equityCurve, historyLimit),
    };
  }

  function getFuturesPaperAccount(options = {}) {
    const historyOptions = normalizeHistoryOptions(options);
    const config = readConfig();
    const state = readState();
    const snapshot = buildAccountSnapshot({ config, state, updatedAt: state?.updatedAt || config.updatedAt || null });
    if (!state) {
      writeState(snapshot);
    }
    return {
      ok: true,
      account: snapshot,
      config,
      state: snapshot,
      history: historyOptions.includeHistory ? readHistory(historyOptions.historyLimit) : { events: [], equityCurve: [] },
      ...SAFETY,
    };
  }

  function resetFuturesPaperAccount({ reason = 'manual_reset' } = {}) {
    const config = readConfig();
    const snapshot = createDefaultState(config);
    storage.writeAccountState(snapshot);
    persistEvent('FUTURES_ACCOUNT_RESET', {
      reason,
      account: snapshot,
      config,
    });
    writeState(snapshot);
    return {
      ok: true,
      account: snapshot,
      config,
      eventType: 'FUTURES_ACCOUNT_RESET',
      ...SAFETY,
    };
  }

  function setFuturesPaperBalance({ startingBalanceSek, fxUsdSek, reason = 'manual_set_balance' } = {}) {
    const nextStartingBalanceSek = clampMoney(startingBalanceSek);
    if (nextStartingBalanceSek === null) {
      return { ok: false, error: 'startingBalanceSek_must_be_a_non_negative_number', ...SAFETY };
    }

    const currentConfig = readConfig();
    const nextConfig = writeConfig({
      ...currentConfig,
      startingBalanceSek: nextStartingBalanceSek,
      fxUsdSek: fxUsdSek == null ? currentConfig.fxUsdSek : clampMoney(fxUsdSek) ?? currentConfig.fxUsdSek,
    });
    const snapshot = buildAccountSnapshot({
      config: nextConfig,
      state: {
        startingBalanceSek: nextConfig.startingBalanceSek,
        cashSek: nextConfig.startingBalanceSek,
        equitySek: nextConfig.startingBalanceSek,
        realizedPnlSek: 0,
        unrealizedPnlSek: 0,
        totalPnlSek: 0,
        dailyPnlSek: 0,
        peakEquitySek: nextConfig.startingBalanceSek,
        drawdownSek: 0,
        drawdownPct: 0,
        openExposureSek: 0,
        buyingPowerSek: nextConfig.startingBalanceSek,
        usedMarginSek: 0,
        availableMarginSek: nextConfig.startingBalanceSek,
        fxUsdSek: nextConfig.fxUsdSek,
      },
    });
    writeState(snapshot);
    persistEvent('FUTURES_ACCOUNT_SET_BALANCE', {
      reason,
      startingBalanceSek: nextStartingBalanceSek,
      fxUsdSek: nextConfig.fxUsdSek,
      account: snapshot,
    });
    return {
      ok: true,
      account: snapshot,
      config: nextConfig,
      eventType: 'FUTURES_ACCOUNT_SET_BALANCE',
      ...SAFETY,
    };
  }

  ensureFiles();

  return {
    SAFETY,
    DEFAULT_CONFIG,
    storage,
    ensureFiles,
    readConfig,
    readState,
    buildAccountSnapshot,
    createDefaultState,
    getFuturesPaperAccount,
    resetFuturesPaperAccount,
    setFuturesPaperBalance,
  };
}

const defaultFuturesPaperAccountService = createFuturesPaperAccountService();

module.exports = {
  SAFETY,
  DEFAULT_CONFIG,
  nowIso,
  round,
  num,
  clampMoney,
  buildAccountSnapshot,
  createDefaultState,
  createAccountEvent,
  createFuturesPaperAccountService,
  defaultFuturesPaperAccountService,
};
