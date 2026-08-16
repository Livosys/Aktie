'use strict';

// IBKR Futures Execution — central konfiguration, feature flags och kill switch.
//
// Säkerhetsmodell (§2 i execution-masterprompten):
//   - Paper-execution är flaggstyrd och AV som standard.
//   - Shadow mode är PÅ som standard när execution aktiveras.
//   - Live-execution är en separat execution target och är AV som standard.
//     Den kräver egna live-flaggor och kan inte aktiveras via paper-flaggor.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./filePersistenceService');

const KILL_SWITCH_FILE = path.resolve(__dirname, '../../data/futures-paper/ibkr-execution/kill-switch.json');

const EXECUTION_TARGETS = Object.freeze({
  PAPER: 'ibkr_paper',
  LIVE: 'ibkr_live',
});

const TARGET_ENVIRONMENTS = Object.freeze({
  [EXECUTION_TARGETS.PAPER]: 'paper',
  [EXECUTION_TARGETS.LIVE]: 'live',
});

const LIVE_DISABLED = Object.freeze({
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
});

// Backwards-compatible export name used by the paper modules/tests.
const LIVE_EXECUTION = LIVE_DISABLED;

// Pilotens hårda gränser (§9-§13). Symboler kan snävas via env men aldrig
// utökas utanför HARD_MAX_ALLOWLIST.
const HARD_MAX_ALLOWLIST = Object.freeze(['MNQ', 'MES']);

function normalizeExecutionTarget(value = null) {
  const text = String(value || '').trim().toLowerCase();
  if (text === EXECUTION_TARGETS.LIVE || text === 'live' || text === 'ib_live') return EXECUTION_TARGETS.LIVE;
  return EXECUTION_TARGETS.PAPER;
}

function getActiveExecutionTarget() {
  return normalizeExecutionTarget(process.env.IBKR_EXECUTION_TARGET);
}

function getExpectedEnvironment(executionTarget = null) {
  const target = normalizeExecutionTarget(executionTarget || getActiveExecutionTarget());
  return TARGET_ENVIRONMENTS[target] || 'paper';
}

function buildExecutionSafety(executionTarget = null) {
  const target = normalizeExecutionTarget(executionTarget || getActiveExecutionTarget());
  const environment = getExpectedEnvironment(target);
  return {
    mode: target,
    executionTarget: target,
    environment,
    paperOnly: target === EXECUTION_TARGETS.PAPER,
    paper_trading_enabled: target === EXECUTION_TARGETS.PAPER,
    live_enabled: target === EXECUTION_TARGETS.LIVE,
    ...(
      target === EXECUTION_TARGETS.LIVE
        ? {
            live_trading_enabled: envBool('IBKR_LIVE_TRADING_ENABLED', false),
            live_broker_enabled: envBool('IBKR_LIVE_BROKER_ENABLED', false),
            live_order_submission_enabled: envBool('IBKR_LIVE_ORDER_SUBMISSION_ENABLED', false),
            live_account_orders_allowed: envBool('IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED', false),
          }
        : LIVE_DISABLED
    ),
  };
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function envString(name, fallback = '') {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const text = String(raw).trim();
  return text || fallback;
}

function getFlags(options = {}) {
  const executionTarget = normalizeExecutionTarget(options.executionTarget || getActiveExecutionTarget());
  const liveTarget = executionTarget === EXECUTION_TARGETS.LIVE;
  const executionEnabled = liveTarget
    ? envBool('IBKR_LIVE_EXECUTION_ENABLED', false)
    : envBool('IBKR_PAPER_EXECUTION_ENABLED', false);
  const shadowMode = liveTarget
    ? envBool('IBKR_LIVE_EXECUTION_SHADOW_MODE', true)
    : envBool('IBKR_PAPER_EXECUTION_SHADOW_MODE', true);
  const rawSubmissionEnabled = liveTarget
    ? envBool('IBKR_LIVE_ORDER_SUBMISSION_ENABLED', false)
    : envBool('IBKR_PAPER_ORDER_SUBMISSION_ENABLED', false);
  const liveBrokerEnabled = liveTarget ? envBool('IBKR_LIVE_BROKER_ENABLED', false) : false;
  const liveTradingEnabled = liveTarget ? envBool('IBKR_LIVE_TRADING_ENABLED', false) : false;
  const liveAccountOrdersAllowed = liveTarget ? envBool('IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED', false) : false;
  const liveSubmissionGate = !liveTarget || (liveBrokerEnabled && liveTradingEnabled && liveAccountOrdersAllowed);
  const submissionEnabled = executionEnabled && !shadowMode && rawSubmissionEnabled && liveSubmissionGate;
  return {
    executionTarget,
    expectedEnvironment: getExpectedEnvironment(executionTarget),
    executionEnabled,
    shadowMode,
    // Submit kräver: execution på + shadow AV + submit-flaggan på.
    submissionEnabled,
    orderSubmissionMode: !executionEnabled
      ? 'disabled'
      : (shadowMode
        ? 'shadow'
        : (submissionEnabled ? (liveTarget ? 'live_pilot' : 'paper_pilot') : 'armed_but_submission_off')),
    paperBrokerExecutionEnabled: liveTarget ? false : executionEnabled,
    liveBrokerExecutionEnabled: liveTarget ? (executionEnabled && liveBrokerEnabled) : false,
    live_trading_enabled: liveTarget ? liveTradingEnabled : false,
    live_broker_enabled: liveTarget ? liveBrokerEnabled : false,
    live_order_submission_enabled: liveTarget ? rawSubmissionEnabled : false,
    live_account_orders_allowed: liveTarget ? liveAccountOrdersAllowed : false,
  };
}

function getPilotLimits(options = {}) {
  const executionTarget = normalizeExecutionTarget(options.executionTarget || getActiveExecutionTarget());
  const prefix = executionTarget === EXECUTION_TARGETS.LIVE ? 'IBKR_LIVE' : 'IBKR_PAPER';
  const configured = String(process.env[`${prefix}_PILOT_SYMBOLS`] || 'MNQ,MES')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  // Allowlisten kan bara SNÄVAS, aldrig breddas utanför MNQ/MES.
  const symbolAllowlist = configured.filter((s) => HARD_MAX_ALLOWLIST.includes(s));
  return {
    executionTarget,
    symbolAllowlist: symbolAllowlist.length ? symbolAllowlist : [...HARD_MAX_ALLOWLIST],
    maxQuantity: Math.min(envInt(`${prefix}_PILOT_MAX_QUANTITY`, 1), 1),
    maxOpenPositions: Math.min(envInt(`${prefix}_PILOT_MAX_OPEN_POSITIONS`, 1), 1),
    maxPendingEntryOrders: 1,
    maxOrdersPerSignal: 1,
    maxEntriesPerHour: envInt(`${prefix}_PILOT_MAX_ENTRIES_PER_HOUR`, 2),
    maxDailyLossSek: envInt(`${prefix}_PILOT_MAX_DAILY_LOSS_SEK`, 5000),
    maxConsecutiveLosses: envInt(`${prefix}_PILOT_MAX_CONSECUTIVE_LOSSES`, 3),
    maxSpreadTicks: envInt(`${prefix}_PILOT_MAX_SPREAD_TICKS`, 8),
    maxQuoteAgeMs: envInt(`${prefix}_PILOT_MAX_QUOTE_AGE_MS`, 30000),
    maxIntentAgeMs: envInt(`${prefix}_PILOT_MAX_INTENT_AGE_MS`, 120000),
    maxAccountSummaryAgeMs: envInt(`${prefix}_ACCOUNT_SUMMARY_MAX_AGE_MS`, 5 * 60 * 1000),
	    // Futures pilot risk model:
	    // - maxStopRiskUsd är den primära risken: |entry/last - stop| * pointValue * qty.
	    // - maxContractNotionalUsd är en separat sanity-limit, inte ett aktielikt
	    //   position-sizingmått. Defaulten tillåter exakt 1 MNQ eller 1 MES vid
	    //   normala nivåer men blockerar mini-kontrakt och felaktig quantity.
	    maxStopRiskUsd: envInt(`${prefix}_MAX_STOP_RISK_USD`, 1000),
	    maxContractNotionalUsd: envInt(`${prefix}_MAX_CONTRACT_NOTIONAL_USD`, 100000),
    requireStopLoss: true,
    allowedOrderTypes: Object.freeze(['MKT', 'LMT']),
    requiredExchange: 'CME',
    requiredCurrency: 'USD',
  };
}

// Weekend entry cutoff (fas 1). Blockerar NYA entries de sista minuterna före
// CME:s veckostängning så att en färsk position inte tvingas bära helgens
// ~49h gap-risk. Påverkar inte exits, TP/SL eller redan öppna positioner.
//
// AKTIVERAD som standard — till skillnad från execution-flaggorna, som är av
// tills någon aktivt slår på handel. En riskgrind som defaultar av skyddar
// ingenting. Sätt FUTURES_WEEKEND_ENTRY_CUTOFF_ENABLED=false för att stänga av.
function getWeekendEntryCutoffConfig() {
  return {
    enabled: envBool('FUTURES_WEEKEND_ENTRY_CUTOFF_ENABLED', true),
    cutoffMinutes: envInt('FUTURES_WEEKEND_ENTRY_CUTOFF_MINUTES', 90),
  };
}

function getExecutionClientConfig(options = {}) {
  const executionTarget = normalizeExecutionTarget(options.executionTarget || getActiveExecutionTarget());
  const liveTarget = executionTarget === EXECUTION_TARGETS.LIVE;
  return {
    executionTarget,
    dataClientId: envInt('IB_FUTURES_DATA_CLIENT_ID', 955),
    executionClientId: liveTarget ? envInt('IBKR_LIVE_EXECUTION_CLIENT_ID', 966) : envInt('IBKR_PAPER_EXECUTION_CLIENT_ID', 956),
    probeClientId: liveTarget ? envInt('IBKR_LIVE_PROBE_CLIENT_ID', 967) : envInt('IBKR_PAPER_PROBE_CLIENT_ID', 957),
    host: liveTarget ? envString('IBKR_LIVE_GATEWAY_HOST', envString('IB_GATEWAY_HOST', '127.0.0.1')) : envString('IB_GATEWAY_HOST', '127.0.0.1'),
    port: liveTarget ? envInt('IBKR_LIVE_GATEWAY_PORT', 4001) : envInt('IB_GATEWAY_PORT', 4002),
    expectedPaperAccountMasked: liveTarget ? '' : envString('IBKR_PAPER_EXPECTED_ACCOUNT_MASKED', ''),
    expectedLiveAccountMasked: liveTarget ? envString('IBKR_LIVE_EXPECTED_ACCOUNT_MASKED', '') : '',
    expectedEnvironment: getExpectedEnvironment(executionTarget),
    reconnectBehavior: 'fetch_fresh_nextValidId_after_reconnect',
    orderIdOwnership: 'execution_client_nextValidId_only',
  };
}

// Kill switch (§22): pause new entries persisteras på disk så att den
// överlever restart. Emergency flatten hanteras av separat flöde.
function defaultKillSwitch() {
  return { pauseNewEntries: false, reason: null, updatedAt: null };
}

function safeKillSwitchOnReadFailure(err) {
  console.warn('[IBPaperExecutionConfig] kill switch read failed; pausing new entries:', err && err.message ? err.message : err);
  return { pauseNewEntries: true, reason: 'kill_switch_read_failed', updatedAt: null };
}

function readKillSwitchFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      pauseNewEntries: raw.pauseNewEntries === true,
      reason: raw.reason || null,
      updatedAt: raw.updatedAt || null,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultKillSwitch();
    return safeKillSwitchOnReadFailure(err);
  }
}

function writeKillSwitchFile(file, paused, reason = null) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const state = {
    pauseNewEntries: paused === true,
    reason: reason || null,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(file, state, { trailingNewline: false });
  return state;
}

function readKillSwitch() {
  return readKillSwitchFile(KILL_SWITCH_FILE);
}

function setPauseNewEntries(paused, reason = null) {
  return writeKillSwitchFile(KILL_SWITCH_FILE, paused, reason);
}

// Publik säkerhetsvy för API/UI (§2): tydlig paper/live-separation.
function buildSafetyView(options = {}) {
  const executionTarget = normalizeExecutionTarget(options.executionTarget || getActiveExecutionTarget());
  const flags = getFlags({ executionTarget });
  const safety = buildExecutionSafety(executionTarget);
  return {
    ...safety,
    paper_broker_enabled: executionTarget === EXECUTION_TARGETS.PAPER && flags.executionEnabled,
    paper_order_submission_enabled: executionTarget === EXECUTION_TARGETS.PAPER && flags.submissionEnabled,
    paperBrokerExecutionEnabled: flags.paperBrokerExecutionEnabled,
    liveBrokerExecutionEnabled: flags.liveBrokerExecutionEnabled,
    verifiedPaperAccount: false,
    verifiedLiveAccount: false,
    liveAccountBlocked: executionTarget === EXECUTION_TARGETS.PAPER,
    orderSubmissionMode: flags.orderSubmissionMode,
    require_verified_paper_account: executionTarget === EXECUTION_TARGETS.PAPER,
    require_verified_live_account: executionTarget === EXECUTION_TARGETS.LIVE,
    reject_unknown_account: true,
    reject_live_account: executionTarget === EXECUTION_TARGETS.PAPER,
    reject_paper_account: executionTarget === EXECUTION_TARGETS.LIVE,
    require_explicit_symbol_allowlist: true,
    require_risk_approval: true,
    require_strategy_execution_allowlist: true,
    require_entry_contract: true,
  };
}

module.exports = {
  EXECUTION_TARGETS,
  TARGET_ENVIRONMENTS,
  LIVE_EXECUTION,
  HARD_MAX_ALLOWLIST,
  KILL_SWITCH_FILE,
  normalizeExecutionTarget,
  getActiveExecutionTarget,
  getExpectedEnvironment,
  buildExecutionSafety,
  getFlags,
  getPilotLimits,
  getWeekendEntryCutoffConfig,
  getExecutionClientConfig,
  readKillSwitch,
  setPauseNewEntries,
  buildSafetyView,
  _internal: {
    readKillSwitchFile,
    writeKillSwitchFile,
  },
};
