'use strict';

/**
 * Read-only IB Paper FUTURES contract discovery (Phase 1).
 *
 * This service returns a STATIC, hand-verified contract specification for the
 * primary CME futures roots (MES / MNQ / ES / NQ). It exists so the UI can show
 * a "Futures Control Room" without guessing anything.
 *
 * HARD RULES enforced here:
 *   - Paper only. Never submits, arms, cancels, retries, queues, or mutates any
 *     paper/live trading state. Pure data.
 *   - The front-month contract (lastTradeDateOrContractMonth / localSymbol /
 *     contractMonth) is NEVER guessed. Until an IB reqContractDetails lookup is
 *     wired, those fields are null and every contract is isTradablePreview=false
 *     with a `contract_month_unverified` blocker.
 *   - No price is invented. There is currently no IB/other futures market-data
 *     source, so a `no_futures_market_data` blocker is always present.
 *   - Submit routes stay independently hard-gated by IB_PAPER_SUBMIT_ROUTES_ENABLED.
 *
 * The static specs below (multiplier / minTick / tickValue / tradingClass) are
 * fixed exchange contract parameters that do not change between expiries, so it
 * is safe to hardcode them. Anything expiry-specific stays unverified.
 */

const SUBMIT_ROUTES_FLAG = 'IB_PAPER_SUBMIT_ROUTES_ENABLED';

// Expected IB paper account for this deployment. Informational only — this
// service never places an order, so it cannot act on any account.
const EXPECTED_PAPER_ACCOUNT = 'DUQ565596';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Hand-verified CME contract parameters. `tickValue` = USD per one minTick move
// = multiplier * minTick. These are constant per contract root.
const FUTURES_SPECS = Object.freeze([
  Object.freeze({
    root: 'MES',
    name: 'Micro E-mini S&P 500',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    tradingClass: 'MES',
    multiplier: 5,
    minTick: 0.25,
    tickValue: 1.25,
    marketName: 'ES',
    priority: 1,
    preferredFirstTest: true,
  }),
  Object.freeze({
    root: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    tradingClass: 'MNQ',
    multiplier: 2,
    minTick: 0.25,
    tickValue: 0.5,
    marketName: 'NQ',
    priority: 2,
    preferredFirstTest: true,
  }),
  Object.freeze({
    root: 'ES',
    name: 'E-mini S&P 500',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    tradingClass: 'ES',
    multiplier: 50,
    minTick: 0.25,
    tickValue: 12.5,
    marketName: 'ES',
    priority: 3,
    preferredFirstTest: false,
  }),
  Object.freeze({
    root: 'NQ',
    name: 'E-mini Nasdaq-100',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    tradingClass: 'NQ',
    multiplier: 20,
    minTick: 0.25,
    tickValue: 5,
    marketName: 'NQ',
    priority: 4,
    preferredFirstTest: false,
  }),
]);

function submitRoutesEnabled() {
  return ['true', '1', 'yes', 'on'].includes(
    String(process.env[SUBMIT_ROUTES_FLAG] ?? '').trim().toLowerCase(),
  );
}

/**
 * Blockers that apply to every futures contract in Phase 1. These are the exact
 * reasons a contract is not yet tradable-preview, expressed as stable codes.
 */
function contractBlockers() {
  const blockers = [
    // No IB reqContractDetails lookup wired yet, so the active front-month
    // expiry / localSymbol cannot be verified. Never guessed.
    'contract_month_unverified',
    // No IB (or other) futures market-data feed exists yet. Alpaca has no
    // futures. No price can be materialized, so no setup/bracket is possible.
    'no_futures_market_data',
    // Futures are not yet supported in the blueprint/submit chain (STK-only).
    'futures_execution_not_implemented',
  ];
  if (!submitRoutesEnabled()) {
    // Independent hard gate — reported for transparency.
    blockers.push('submit_routes_disabled');
  }
  return blockers;
}

function buildContract(spec, sharedBlockers) {
  return {
    root: spec.root,
    symbol: spec.root,
    name: spec.name,
    secType: spec.secType,
    exchange: spec.exchange,
    currency: spec.currency,
    tradingClass: spec.tradingClass,
    marketName: spec.marketName,
    multiplier: spec.multiplier,
    minTick: spec.minTick,
    tickValue: spec.tickValue,
    // Expiry-specific fields are UNVERIFIED and intentionally null. They must be
    // resolved via IB reqContractDetails before any preview/submit phase.
    lastTradeDateOrContractMonth: null,
    contractMonth: null,
    localSymbol: null,
    contractMonthVerified: false,
    // Phase 1 is always non-tradable-preview: expiry + price are unverified.
    isTradablePreview: false,
    preferredFirstTest: spec.preferredFirstTest,
    priority: spec.priority,
    blockers: [...sharedBlockers],
  };
}

/**
 * Build the read-only futures contract discovery payload.
 * Pure — no I/O, no order path, no state mutation.
 */
function buildFuturesContracts() {
  const sharedBlockers = contractBlockers();
  const contracts = FUTURES_SPECS
    .map((spec) => buildContract(spec, sharedBlockers))
    .sort((a, b) => a.priority - b.priority);

  return {
    ok: true,
    readOnly: true,
    mode: 'paper_only',
    generatedAt: new Date().toISOString(),
    source: 'static_contract_spec',
    account: EXPECTED_PAPER_ACCOUNT,
    submitRoutesEnabled: submitRoutesEnabled(),
    note:
      'Static CME futures contract specs (MES/MNQ/ES/NQ). Read-only Phase 1. '
      + 'Front-month expiry and price are unverified, so every contract is '
      + 'isTradablePreview=false. No order path exists here.',
    // What each contract still needs before it could become a tradable preview,
    // in later phases. Documented so the UI can show the gap honestly.
    requirements: Object.freeze({
      contractMonth: 'Resolve active front month via IB reqContractDetails (not guessed).',
      marketData: 'Wire a real futures market-data source (IB reqMktData). Alpaca has no futures.',
      execution: 'Add a FUT branch to the blueprint/bracket chain (currently STK-only).',
      submitGate: `Independent hard gate ${SUBMIT_ROUTES_FLAG} (currently ${submitRoutesEnabled() ? 'ON' : 'OFF'}).`,
      quantityCap: 'First real paper test caps quantity to exactly 1 contract (MES or MNQ).',
    }),
    counts: {
      total: contracts.length,
      tradablePreview: contracts.filter((c) => c.isTradablePreview).length,
      preferredFirstTest: contracts.filter((c) => c.preferredFirstTest).map((c) => c.root),
    },
    globalBlockers: sharedBlockers,
    contracts,
    safety: { ...SAFETY },
  };
}

module.exports = {
  SAFETY,
  EXPECTED_PAPER_ACCOUNT,
  FUTURES_SPECS,
  buildFuturesContracts,
  _internal: {
    submitRoutesEnabled,
    contractBlockers,
    buildContract,
  },
};
