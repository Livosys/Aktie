'use strict';

/**
 * Futures Paper Allowlist — Enrollment för native futures-strategier
 *
 * Denna tjänst hanterar godkännande av Futures-specifika strategier
 * för Futures Paper Trading. Skild från regelbunden Paper Trading.
 * Är alltid paper_only, ingen broker/live trading.
 */

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DATA_FILE = path.resolve(
  process.env.FUTURES_PAPER_ALLOWLIST_FILE
    || path.resolve(__dirname, '../../data/futures-paper/allowlist.json'),
);

const DEFAULT_ALLOWLIST = Object.freeze({
  version: 1,
  updatedAt: null,
  updatedBy: 'system',
  strategies: [],
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function readAllowlistFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { allowlist: { ...DEFAULT_ALLOWLIST }, warning: null };
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { allowlist: { ...DEFAULT_ALLOWLIST }, warning: 'futures_paper_allowlist_invalid' };
    }
    return {
      allowlist: parsed,
      warning: null,
    };
  } catch (err) {
    return { allowlist: { ...DEFAULT_ALLOWLIST }, warning: 'futures_paper_allowlist_corrupt' };
  }
}

function writeAllowlistFile(allowlist) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8');
}

function getFuturesPaperAllowlist() {
  const { allowlist, warning } = readAllowlistFile();
  return {
    ok: true,
    version: allowlist.version || 1,
    strategies: allowlist.strategies || [],
    strategyIds: (allowlist.strategies || []).map(s => s.strategyId),
    total: (allowlist.strategies || []).length,
    updatedAt: allowlist.updatedAt,
    updatedBy: allowlist.updatedBy,
    ...(warning ? { warning } : {}),
    ...SAFETY,
  };
}

function enrollStrategy(strategyId, { now = new Date() } = {}) {
  const { allowlist, warning: readWarning } = readAllowlistFile();
  const current = allowlist.strategies || [];

  // Check if already enrolled
  if (current.some(s => s.strategyId === strategyId)) {
    return {
      ok: true,
      changed: false,
      strategyId,
      enrolled: true,
      message: 'strategy_already_enrolled',
      ...SAFETY,
    };
  }

  // Add to allowlist
  const nextAllowlist = {
    version: allowlist.version || 1,
    updatedAt: nowIso(now),
    updatedBy: 'system',
    strategies: [
      ...current,
      {
        strategyId,
        enrolledAt: nowIso(now),
      },
    ],
  };

  writeAllowlistFile(nextAllowlist);

  return {
    ok: true,
    changed: true,
    strategyId,
    enrolled: true,
    enrolledAt: nowIso(now),
    ...SAFETY,
  };
}

function removeStrategy(strategyId, { now = new Date() } = {}) {
  const { allowlist } = readAllowlistFile();
  const current = allowlist.strategies || [];

  const filtered = current.filter(s => s.strategyId !== strategyId);
  if (filtered.length === current.length) {
    return {
      ok: true,
      changed: false,
      strategyId,
      removed: false,
      message: 'strategy_not_found',
      ...SAFETY,
    };
  }

  const nextAllowlist = {
    version: allowlist.version || 1,
    updatedAt: nowIso(now),
    updatedBy: 'system',
    strategies: filtered,
  };

  writeAllowlistFile(nextAllowlist);

  return {
    ok: true,
    changed: true,
    strategyId,
    removed: true,
    ...SAFETY,
  };
}

function isEnrolled(strategyId) {
  const { strategies } = getFuturesPaperAllowlist();
  return strategies.some(s => s.strategyId === strategyId);
}

module.exports = {
  SAFETY,
  getFuturesPaperAllowlist,
  enrollStrategy,
  removeStrategy,
  isEnrolled,
};
