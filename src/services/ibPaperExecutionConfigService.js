'use strict';

// IBKR Paper Execution — central konfiguration, feature flags och kill switch.
//
// Säkerhetsmodell (§2 i execution-masterprompten):
//   - Paper-execution är flaggstyrd och AV som standard.
//   - Shadow mode är PÅ som standard när execution aktiveras.
//   - LIVE-execution saknar aktiverbar väg: värdena är frysta konstanter
//     som aldrig läser env. En konfigurationsmiss kan inte aktivera live.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./filePersistenceService');

const KILL_SWITCH_FILE = path.resolve(__dirname, '../../data/futures-paper/ibkr-execution/kill-switch.json');

// LIVE ÄR TEKNISKT OMÖJLIGT: frysta konstanter, ingen env-läsning, ingen setter.
const LIVE_EXECUTION = Object.freeze({
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
});

// Pilotens hårda gränser (§9-§13). Symboler kan snävas via env men aldrig
// utökas utanför HARD_MAX_ALLOWLIST.
const HARD_MAX_ALLOWLIST = Object.freeze(['MNQ', 'MES']);

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

function getFlags() {
  const executionEnabled = envBool('IBKR_PAPER_EXECUTION_ENABLED', false);
  const shadowMode = envBool('IBKR_PAPER_EXECUTION_SHADOW_MODE', true);
  const submissionEnabled = envBool('IBKR_PAPER_ORDER_SUBMISSION_ENABLED', false);
  return {
    executionEnabled,
    shadowMode,
    // Submit kräver: execution på + shadow AV + submit-flaggan på.
    submissionEnabled: executionEnabled && !shadowMode && submissionEnabled,
    orderSubmissionMode: !executionEnabled
      ? 'disabled'
      : (shadowMode ? 'shadow' : (submissionEnabled ? 'paper_pilot' : 'armed_but_submission_off')),
    ...LIVE_EXECUTION,
  };
}

function getPilotLimits() {
  const configured = String(process.env.IBKR_PAPER_PILOT_SYMBOLS || 'MNQ,MES')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  // Allowlisten kan bara SNÄVAS, aldrig breddas utanför MNQ/MES.
  const symbolAllowlist = configured.filter((s) => HARD_MAX_ALLOWLIST.includes(s));
  return {
    symbolAllowlist: symbolAllowlist.length ? symbolAllowlist : [...HARD_MAX_ALLOWLIST],
    maxQuantity: Math.min(envInt('IBKR_PAPER_PILOT_MAX_QUANTITY', 1), 1),
    maxOpenPositions: Math.min(envInt('IBKR_PAPER_PILOT_MAX_OPEN_POSITIONS', 1), 1),
    maxPendingEntryOrders: 1,
    maxOrdersPerSignal: 1,
    maxEntriesPerHour: envInt('IBKR_PAPER_PILOT_MAX_ENTRIES_PER_HOUR', 2),
    maxDailyLossSek: envInt('IBKR_PAPER_PILOT_MAX_DAILY_LOSS_SEK', 5000),
    maxConsecutiveLosses: envInt('IBKR_PAPER_PILOT_MAX_CONSECUTIVE_LOSSES', 3),
    maxSpreadTicks: envInt('IBKR_PAPER_PILOT_MAX_SPREAD_TICKS', 8),
    maxQuoteAgeMs: envInt('IBKR_PAPER_PILOT_MAX_QUOTE_AGE_MS', 30000),
    maxIntentAgeMs: envInt('IBKR_PAPER_PILOT_MAX_INTENT_AGE_MS', 120000),
    maxAccountSummaryAgeMs: envInt('IBKR_PAPER_ACCOUNT_SUMMARY_MAX_AGE_MS', 5 * 60 * 1000),
	    // Futures pilot risk model:
	    // - maxStopRiskUsd är den primära risken: |entry/last - stop| * pointValue * qty.
	    // - maxContractNotionalUsd är en separat sanity-limit, inte ett aktielikt
	    //   position-sizingmått. Defaulten tillåter exakt 1 MNQ eller 1 MES vid
	    //   normala nivåer men blockerar mini-kontrakt och felaktig quantity.
	    maxStopRiskUsd: envInt('IBKR_PAPER_MAX_STOP_RISK_USD', 1000),
	    maxContractNotionalUsd: envInt('IBKR_PAPER_MAX_CONTRACT_NOTIONAL_USD', 100000),
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

function getExecutionClientConfig() {
  return {
    dataClientId: envInt('IB_FUTURES_DATA_CLIENT_ID', 955),
    executionClientId: envInt('IBKR_PAPER_EXECUTION_CLIENT_ID', 956),
    probeClientId: envInt('IBKR_PAPER_PROBE_CLIENT_ID', 957),
    host: envString('IB_GATEWAY_HOST', '127.0.0.1'),
    port: envInt('IB_GATEWAY_PORT', 4002),
    expectedPaperAccountMasked: envString('IBKR_PAPER_EXPECTED_ACCOUNT_MASKED', ''),
    expectedEnvironment: 'paper',
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
function buildSafetyView() {
  const flags = getFlags();
  return {
    mode: 'ibkr_paper',
    paper_trading_enabled: true,
    paper_broker_enabled: flags.executionEnabled,
    paper_order_submission_enabled: flags.submissionEnabled,
    paperBrokerExecutionEnabled: flags.executionEnabled,
    liveBrokerExecutionEnabled: false,
    verifiedPaperAccount: false,
    liveAccountBlocked: true,
    orderSubmissionMode: flags.orderSubmissionMode,
    ...LIVE_EXECUTION,
    require_verified_paper_account: true,
    reject_unknown_account: true,
    reject_live_account: true,
    require_explicit_symbol_allowlist: true,
    require_risk_approval: true,
    require_strategy_execution_allowlist: true,
    require_entry_contract: true,
  };
}

module.exports = {
  LIVE_EXECUTION,
  HARD_MAX_ALLOWLIST,
  KILL_SWITCH_FILE,
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
