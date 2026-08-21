'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-contract-flow-'));
process.env.PAPER_ENABLED_STRATEGIES_FILE = path.join(tmpDir, 'enabled-strategies.json');
process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';
process.env.PAPER_LONG_ONLY_ENABLED = 'true';
process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';

const paperEnabledStrategies = require('./paperEnabledStrategiesService');
paperEnabledStrategies._internal.writeStoreAtomic(
  paperEnabledStrategies.buildInitialStore({
    now: '2026-07-11T18:00:00.000Z',
    source: 'manual_initial_migration',
  }),
  new Date('2026-07-11T18:00:00.000Z'),
);

const svc = require('./paperContractFlowValidationService');

function readyNarrow(overrides = {}) {
  return {
    // ── Futures, inte krypto ─────────────────────────────────────────────
    //
    // Fixturen använde BTCUSDT och förväntade sig att signalen mappades till
    // en futures-strategi. Den mappningen är AVSIKTLIGT spärrad sedan
    // instrumentsläktskapet infördes: steget mot paper var i praktiken
    // krypto→MNQ, alltså BTC-struktur som blev MNQ-order. Testet prövade
    // därmed det beteende spärren finns för att stoppa.
    //
    // Gaterna som testet faktiskt validerar är instrumentoberoende, så
    // fixturen kör dem på ett instrument mappningen tillåter.
    symbol: 'MNQ',
    marketType: 'futures',
    session: 'rth',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_BULL_ENTRY',
    status: 'active',
    nextMoveBias: 'UP',
    confidenceScore: 92,
    dataFreshness: 'LIVE',
    signalTimestamp: '2026-07-11T17:59:00.000Z',
    price: 100,
    volumeState: 'strong',
    extensionLevel: 'none',
    twoMinuteConfirmed: true,
    closedCandleConfirmed: true,
    closedCandle: true,
    producerConfirmationVersion: 'producer_confirmation_v1',
    producerEntryReadiness: {
      entryReady: true,
      status: 'entry_ready',
      confirmationObserved: ['two_minute_confirmation', 'closed_candle_confirmation'],
      missingConfirmations: [],
      blockers: [],
    },
    ...overrides,
  };
}

function main() {
  const state = {
    openTrades: [],
    cooldowns: {},
    strategyCooldowns: {},
    familyCooldowns: {},
    seenSignalIds: [],
    conservativeMode: false,
  };
  const result = svc.buildContractFlowValidation({
    now: new Date('2026-07-11T18:00:00.000Z'),
    state,
    candidates: [
      readyNarrow(),
      readyNarrow({
        symbol: 'MES',
        signalFamily: 'REGULAR_PULLBACK',
        signalSubtype: 'REGULAR_PULLBACK',
        status: 'watch',
        strategyId: 'trend_continuation',
        producerEntryReadiness: {
          entryReady: false,
          status: 'not_entry_ready',
          confirmationObserved: [],
          missingConfirmations: [],
          blockers: ['status_watch'],
        },
      }),
      readyNarrow({
        symbol: 'M2K',
        signalFamily: 'UNKNOWN',
        signalSubtype: 'NO_TRADE',
        status: 'wait',
        nextMoveBias: 'UNCERTAIN',
      }),
    ],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'paper_only');
  assert.equal(result.can_place_orders, false);
  assert.equal(result.summary.totalCandidates, 3);

  const narrow = result.candidates.find((row) => row.symbol === 'MNQ');
  assert.equal(narrow.strategyId, 'narrow_state_expansion_long');
  assert.equal(narrow.activeStrategy, true);
  assert.equal(narrow.gates.manual.status, 'pass');
  assert.equal(narrow.gates.runtimeConnector.status, 'pass');
  assert.equal(narrow.gates.strategyControl.status, 'pass');
  assert.equal(narrow.gates.entryContract.status, 'pass');
  assert.equal(narrow.gates.qualifiesForEntry.status, 'pass');
  assert.notEqual(narrow.stopAt, 'qualifiesForEntry', 'entry-ready active status must not be rejected after contract pass');

  const disabled = result.candidates.find((row) => row.symbol === 'MES');
  assert.equal(disabled.gates.manual.status, 'block');
  assert.equal(disabled.gates.manual.reasonCode, 'paper_strategy_not_enabled');
  assert.equal(disabled.stopAt, 'manual');

  const noTrade = result.candidates.find((row) => row.symbol === 'M2K');
  assert.equal(noTrade.gates.producerSubtype.status, 'block');
  assert.equal(noTrade.stopAt, 'producerSubtype');

  assert.equal(result.summary.byStrategyId.narrow_state_expansion_long.qualifiesPass, 1);
  assert.equal(result.summary.byStop.manual, 1);
  assert.equal(result.summary.byStop.producerSubtype, 1);

  const rankRegression = svc.buildContractFlowValidation({
    now: new Date('2026-07-11T18:00:00.000Z'),
    state,
    candidates: [
      readyNarrow({
        symbol: 'MNQ',
        status: 'watch',
        confidenceScore: 99,
        producerEntryReadiness: {
          entryReady: false,
          status: 'not_entry_ready',
          confirmationObserved: ['two_minute_confirmation', 'closed_candle_confirmation'],
          missingConfirmations: [],
          blockers: ['status_watch'],
        },
      }),
      readyNarrow({
        symbol: 'MES',
        confidenceScore: 80,
      }),
    ],
  });
  const watchWinnerCandidate = rankRegression.candidates.find((row) => row.symbol === 'MNQ');
  const eligibleCandidate = rankRegression.candidates.find((row) => row.symbol === 'MES');
  assert.equal(watchWinnerCandidate.gates.strategyControl.status, 'pass');
  assert.equal(watchWinnerCandidate.gates.strategyControl.familyRank, null);
  assert.equal(watchWinnerCandidate.gates.entryContract.status, 'block');
  assert.notEqual(watchWinnerCandidate.stopAt, 'strategyControl', 'watch candidate får inte blocka family-rank');
  assert.equal(eligibleCandidate.gates.strategyControl.status, 'pass');
  assert.equal(eligibleCandidate.gates.strategyControl.familyRank, 1, 'entry-ready kandidat blir familjevinnare');
  assert.equal(eligibleCandidate.gates.entryContract.status, 'pass');

  console.log('paperContractFlowValidationService.test.js passed');
}

try {
  main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
