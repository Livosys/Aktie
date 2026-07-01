'use strict';

// IB Paper setup builder (read-only, pure logic).
//
// Purpose: sit between a scanner/watch signal and the IB Paper Multi-Strategy
// Test Plan and try to turn a candidate into a VERIFIED trade setup with a
// complete bracket (entry + stop-loss + take-profit). It never sends, arms,
// queues, or previews an order and never toggles any safety flag.
//
// HARD RULE — the builder never invents values:
//   * direction is taken ONLY from the shared direction resolver (which itself
//     never guesses); UNCERTAIN/INDETERMINATE stays blocked.
//   * entry/stop/take are used ONLY from real candidate fields, or optionally
//     derived from REAL market data (reference price + ATR/range) combined with
//     CONFIGURED strategy risk rules — and only when the caller opts in and
//     supplies those real inputs. Nothing is fabricated.
//   * A setup is never entry-only: missing stop OR take keeps it blocked.
//
// If a setup cannot be built the candidate stays blocked with explicit blockers.

const directionResolver = require('./interactiveBrokersDirectionResolverService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Mirror of the bracket normalizer's minimum stop distance (percent of entry).
const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;
const FORCE_QUANTITY = 1;

function safeUpper(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value);
    if (n != null) return n;
  }
  return null;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------------------
// Asset / market-group classification (never relaxes crypto; ETF gated).
// ---------------------------------------------------------------------------
function classifyAsset(candidate = {}, options = {}) {
  const includeEtf = options.includeEtf === true;
  const rawGroup = String(
    candidate.assetGroup
    || candidate.marketGroup
    || candidate.normalizedMarketGroup
    || '',
  ).trim().toLowerCase();

  const isCrypto = candidate.isCrypto === true
    || rawGroup === 'crypto'
    || rawGroup === 'krypto';
  const isQqqOrEtf = rawGroup === 'etfqqq'
    || rawGroup === 'etf'
    || rawGroup === 'qqq'
    || candidate.isQqq === true
    || candidate.isEtf === true;

  let blocker = null;
  if (isCrypto) blocker = 'crypto_blocked';
  else if (isQqqOrEtf && !includeEtf) blocker = 'qqq_etf_blocked';
  else if (!rawGroup) blocker = 'market_group_unknown';

  return { rawGroup: rawGroup || null, isCrypto, isQqqOrEtf, blocker };
}

// ---------------------------------------------------------------------------
// Bracket resolution.
//   Tier 1 (default): use explicit entry/stop/take fields already on the
//                     candidate. Pure mapping — no derivation.
//   Tier 2 (opt-in) : derive stop/take deterministically from a REAL reference
//                     price plus configured strategy risk rules. Requires
//                     options.allowRuleDerivedBracket === true AND real inputs.
// ---------------------------------------------------------------------------
function resolveExplicitBracket(candidate = {}) {
  const entryPrice = firstPositiveNumber(
    candidate.entryPrice,
    candidate.entryReferencePrice,
    candidate.entry,
    candidate.plannedEntry,
    candidate.limitPrice,
  );
  const stopLossPrice = firstPositiveNumber(
    candidate.stopLoss,
    candidate.stopLossPrice,
    candidate.stop_loss,
    candidate.stop,
    candidate.sl,
  );
  const takeProfitPrice = firstPositiveNumber(
    candidate.takeProfit,
    candidate.takeProfit1,
    candidate.take_profit,
    candidate.tp,
    candidate.target,
    candidate.targetPrice,
  );
  return {
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    entryPriceSource: entryPrice != null ? 'candidate_explicit_entry' : null,
    stopLossSource: stopLossPrice != null ? 'candidate_explicit_stop' : null,
    takeProfitSource: takeProfitPrice != null ? 'candidate_explicit_take' : null,
  };
}

function deriveRuleBracket(side, candidate = {}, options = {}) {
  // Real reference price: only a genuine market/quote price is accepted.
  const referencePrice = firstPositiveNumber(
    options.referencePrice,
    candidate.currentPrice,
    candidate.price,
    candidate.marketPrice,
  );
  // Configured strategy risk rules (must be provided by caller / catalog).
  const stopLossPct = safeNumber(options.stopLossPct); // percent of entry, e.g. 0.5 = 0.5%
  const takeProfitRMultiple = safeNumber(options.takeProfitRMultiple);

  if (referencePrice == null || stopLossPct == null || takeProfitRMultiple == null) {
    return {
      entryPrice: null,
      stopLossPrice: null,
      takeProfitPrice: null,
      entryPriceSource: null,
      stopLossSource: null,
      takeProfitSource: null,
    };
  }

  const stopDistance = referencePrice * (stopLossPct / 100);
  const takeDistance = stopDistance * takeProfitRMultiple;
  const entryPrice = round(referencePrice, 4);
  const stopLossPrice = side === 'BUY'
    ? round(referencePrice - stopDistance, 4)
    : round(referencePrice + stopDistance, 4);
  const takeProfitPrice = side === 'BUY'
    ? round(referencePrice + takeDistance, 4)
    : round(referencePrice - takeDistance, 4);

  return {
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    entryPriceSource: 'rule_reference_price',
    stopLossSource: `rule_stop_pct_${stopLossPct}`,
    takeProfitSource: `rule_take_r_${takeProfitRMultiple}`,
  };
}

/**
 * Build a verified IB Paper trade setup from a candidate. Pure, read-only.
 * @param {object} candidate scanner/preview candidate
 * @param {object} [options] { includeEtf, allowRuleDerivedBracket, referencePrice, stopLossPct, takeProfitRMultiple }
 */
function buildSetup(candidate = {}, options = {}) {
  const symbol = safeUpper(candidate.symbol || candidate.ticker) || null;
  const strategyId = String(
    candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId || '',
  ).trim() || null;

  const blockers = [];
  const diagnostics = {
    directionSource: null,
    entryPriceSource: null,
    stopLossSource: null,
    takeProfitSource: null,
    setupSource: null,
    reason: null,
  };

  if (!symbol) blockers.push('missing_symbol');
  if (!strategyId) blockers.push('missing_strategy_id');

  // 1. Asset / market group gating (crypto always blocked; ETF gated).
  const asset = classifyAsset(candidate, options);
  if (asset.blocker) blockers.push(asset.blocker);

  // 2. Direction — ONLY from the shared resolver; never guessed here.
  const direction = directionResolver.resolveDirection(candidate);
  diagnostics.directionSource = direction.source || null;
  let side = null;
  if (direction.direction === 'BUY' || direction.direction === 'SELL') {
    side = direction.direction;
  } else if (direction.direction === 'BLOCKED') {
    blockers.push('direction_conflict');
  } else {
    blockers.push('direction_not_verified');
  }

  // 3. Bracket — explicit fields first, then optional rule-based derivation.
  let bracket = resolveExplicitBracket(candidate);
  if (
    side
    && (bracket.entryPrice == null || bracket.stopLossPrice == null || bracket.takeProfitPrice == null)
    && options.allowRuleDerivedBracket === true
  ) {
    const derived = deriveRuleBracket(side, candidate, options);
    // Only fill fields that were missing; never overwrite an explicit value.
    bracket = {
      entryPrice: bracket.entryPrice ?? derived.entryPrice,
      stopLossPrice: bracket.stopLossPrice ?? derived.stopLossPrice,
      takeProfitPrice: bracket.takeProfitPrice ?? derived.takeProfitPrice,
      entryPriceSource: bracket.entryPriceSource ?? derived.entryPriceSource,
      stopLossSource: bracket.stopLossSource ?? derived.stopLossSource,
      takeProfitSource: bracket.takeProfitSource ?? derived.takeProfitSource,
    };
  }

  const { entryPrice, stopLossPrice, takeProfitPrice } = bracket;
  diagnostics.entryPriceSource = bracket.entryPriceSource;
  diagnostics.stopLossSource = bracket.stopLossSource;
  diagnostics.takeProfitSource = bracket.takeProfitSource;

  if (entryPrice == null) blockers.push('missing_entry_price');
  if (stopLossPrice == null) blockers.push('missing_stop_loss');
  if (takeProfitPrice == null) blockers.push('missing_take_profit');

  // 4. Bracket geometry — only when a side and all three prices exist.
  if (side && entryPrice != null && stopLossPrice != null && takeProfitPrice != null) {
    const stopOnCorrectSide = side === 'BUY' ? stopLossPrice < entryPrice : stopLossPrice > entryPrice;
    const takeOnCorrectSide = side === 'BUY' ? takeProfitPrice > entryPrice : takeProfitPrice < entryPrice;
    if (!stopOnCorrectSide) blockers.push('stop_loss_invalid_side');
    if (!takeOnCorrectSide) blockers.push('take_profit_invalid');
    const stopLossPct = round((Math.abs(entryPrice - stopLossPrice) / entryPrice) * 100, 4);
    if (stopOnCorrectSide && !(stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT - 1e-9)) {
      blockers.push('stop_loss_too_small');
    }
  }

  // 5. Bracket-required / entry-only guard.
  const hasCompleteBracket = entryPrice != null && stopLossPrice != null && takeProfitPrice != null;
  if (!hasCompleteBracket) blockers.push('bracket_required_missing');

  // A pure watch signal = no verified direction AND no explicit prices at all.
  const isWatchSignalOnly = !side && entryPrice == null && stopLossPrice == null && takeProfitPrice == null;
  if (isWatchSignalOnly) {
    blockers.push('candidate_is_watch_signal_not_trade_setup');
    diagnostics.reason = 'candidate_is_watch_signal_not_trade_setup';
  }

  const uniqueBlockers = [...new Set(blockers)];
  const setupReady = uniqueBlockers.length === 0 && side != null && hasCompleteBracket;
  if (setupReady) {
    diagnostics.setupSource = diagnostics.entryPriceSource
      && diagnostics.entryPriceSource.startsWith('rule_')
      ? 'rule_derived'
      : 'candidate_explicit';
  }

  return {
    ok: true,
    readOnly: true,
    setupReady,
    symbol,
    strategyId,
    side: setupReady ? side : null,
    entryPrice: setupReady ? entryPrice : (entryPrice ?? null),
    stopLossPrice: setupReady ? stopLossPrice : (stopLossPrice ?? null),
    takeProfitPrice: setupReady ? takeProfitPrice : (takeProfitPrice ?? null),
    quantity: setupReady ? FORCE_QUANTITY : null,
    bracketReady: setupReady,
    blockers: uniqueBlockers,
    diagnostics,
    safety: { ...SAFETY },
  };
}

/** Build setups for a list of candidates + a summary. Read-only. */
function buildSetups(candidates = [], options = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).map((c) => buildSetup(c || {}, options));
  const summary = {
    total: rows.length,
    setupReady: rows.filter((r) => r.setupReady).length,
    blocked: rows.filter((r) => !r.setupReady).length,
    buy: rows.filter((r) => r.setupReady && r.side === 'BUY').length,
    sell: rows.filter((r) => r.setupReady && r.side === 'SELL').length,
  };
  return { ok: true, mode: 'ib_paper_setup_builder', readOnly: true, rows, summary, safety: { ...SAFETY } };
}

module.exports = {
  buildSetup,
  buildSetups,
  SAFETY,
  REQUIRED_STOP_LOSS_MIN_PCT,
  _internal: { classifyAsset, resolveExplicitBracket, deriveRuleBracket },
};
