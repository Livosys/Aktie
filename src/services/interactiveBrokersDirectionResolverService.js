'use strict';

/**
 * IB Paper Direction Resolver (READ-ONLY).
 *
 * Turns an IB Paper candidate into a clear, verifiable trade direction:
 *   BUY | SELL | BLOCKED | UNKNOWN
 *
 * Hard rules:
 *   - Direction is NEVER guessed. It is derived only from verifiable signals:
 *       1. an explicit side/direction field already on the candidate
 *       2. a deterministic long/short suffix baked into the strategy_id
 *          (e.g. vwap_failed_breakout_short -> SELL)
 *       3. a continuation strategy CONFIRMED by an explicit trend bias
 *          (e.g. trend_continuation + bullish -> BUY)
 *       4. a reversal/fakeout strategy ONLY when the reversal side is itself
 *          explicit and verifiable (narrow_fakeout_reversal_v1 is otherwise
 *          UNKNOWN — we never infer which way a reversal goes).
 *   - Conflicting explicit direction fields resolve to BLOCKED (never a pick).
 *   - Missing / unverifiable direction resolves to UNKNOWN with
 *     allowed=false and blocker 'direction_not_verified'.
 *   - This module sends no order, opens no broker connection, mutates no state
 *     and never changes any safety flag. It is pure and read-only.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const NOT_VERIFIED_BLOCKER = 'direction_not_verified';
const CONFLICT_BLOCKER = 'direction_conflict';

const BUY_TOKENS = new Set([
  'buy', 'long', 'bull', 'bullish', 'up', 'uptrend', 'call',
  'köp', 'kop', 'lång', 'lang', 'positive', 'higher', 'breakout_long',
]);
const SELL_TOKENS = new Set([
  'sell', 'short', 'bear', 'bearish', 'down', 'downtrend', 'put',
  'sälj', 'salj', 'kort', 'negative', 'lower', 'breakout_short',
]);

// Explicit direction-bearing fields, highest priority first.
const EXPLICIT_SIDE_FIELDS = [
  'side', 'direction', 'action', 'entrySide', 'tradeSide', 'signalDirection',
  'setupDirection', 'reversalSide', 'underlying_signal_direction',
  'recommendation', 'runtimeDirection',
];

// Fields that carry a trend bias (used to CONFIRM continuation strategies).
const TREND_BIAS_FIELDS = [
  'trendBias', 'trend', 'bias', 'marketBias', 'compassBias', 'regimeBias',
  'emaTrend', 'nextMoveBias', 'trendState', 'regimeLabel',
];

function safeLower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function safeUpper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

// Map a single raw token to 'BUY' | 'SELL' | null. null means "present but not
// directional" (UNCERTAIN/NEUTRAL/unknown) — never a guess.
function tokenToSide(value) {
  let raw = value;
  if (raw && typeof raw === 'object') {
    raw = raw.decision || raw.direction || raw.side || raw.bias || raw.value || '';
  }
  const token = safeLower(raw);
  if (token === '') return null;
  if (BUY_TOKENS.has(token)) return 'BUY';
  if (SELL_TOKENS.has(token)) return 'SELL';
  return null;
}

// Map a raw token to a trend bias 'bull' | 'bear' | null.
function tokenToBias(value) {
  const side = tokenToSide(value);
  if (side === 'BUY') return 'bull';
  if (side === 'SELL') return 'bear';
  return null;
}

/**
 * Classify a strategy_id into the kind of directional logic it uses.
 *   long_biased  — id deterministically encodes a long-only setup
 *   short_biased — id deterministically encodes a short-only setup
 *   continuation — direction follows the confirmed trend bias
 *   reversal     — direction must be explicit/verifiable (never inferred)
 *   neutral      — no directional hint from the id alone
 */
function classifyStrategyKind(strategyId) {
  const id = safeLower(strategyId);
  if (!id) return 'neutral';

  // Deterministic short/long suffixes baked into the id.
  if (/(^|[_-])short($|[_-])/.test(id) || /_short_/.test(id) || id.endsWith('short')) return 'short_biased';
  if (/(^|[_-])long($|[_-])/.test(id) || /_long_/.test(id) || id.endsWith('long')) return 'long_biased';

  // Reversal / fakeout / mean-reversion families: direction must be explicit.
  if (/(reversal|fakeout|mean_revers|reclaim_rejection|rejection)/.test(id)) return 'reversal';

  // Continuation / momentum / pullback / breakout families: follow trend bias.
  if (/(continuation|momentum|pullback|breakout|trend)/.test(id)) return 'continuation';

  return 'neutral';
}

function resolveExplicitSide(candidate) {
  const found = [];
  const rawFields = {};
  for (const field of EXPLICIT_SIDE_FIELDS) {
    const value = candidate[field];
    if (value == null || value === '') continue;
    rawFields[field] = value;
    const side = tokenToSide(value);
    if (side === 'BUY' || side === 'SELL') found.push({ field, side });
  }
  const distinct = [...new Set(found.map((f) => f.side))];
  if (distinct.length === 0) return { side: null, source: null, conflict: false, rawFields };
  if (distinct.length > 1) return { side: null, source: 'conflict', conflict: true, rawFields };
  return { side: distinct[0], source: found[0].field, conflict: false, rawFields };
}

function resolveTrendBias(candidate) {
  const found = [];
  const rawFields = {};
  for (const field of TREND_BIAS_FIELDS) {
    const value = candidate[field];
    if (value == null || value === '') continue;
    rawFields[field] = value;
    const bias = tokenToBias(value);
    if (bias) found.push({ field, bias });
  }
  const distinct = [...new Set(found.map((f) => f.bias))];
  if (distinct.length === 0) return { bias: null, source: null, conflict: false, rawFields };
  if (distinct.length > 1) return { bias: null, source: 'conflict', conflict: true, rawFields };
  return { bias: distinct[0], source: found[0].field, conflict: false, rawFields };
}

function buildResult({ direction, side, source, confidence, blocker, reason, reasonSv, evidence }) {
  const allowed = direction === 'BUY' || direction === 'SELL';
  return {
    direction,
    side: side || null,
    longShort: side === 'BUY' ? 'long' : side === 'SELL' ? 'short' : null,
    allowed,
    verified: allowed,
    blocker: blocker || null,
    blockers: blocker ? [blocker] : [],
    confidence: confidence || null,
    source: source || null,
    reason: reason || null,
    reasonSv: reasonSv || null,
    evidence: evidence || {},
    safety: { ...SAFETY },
  };
}

/**
 * Resolve a candidate's direction. Pure function, read-only.
 * @param {object} candidate
 * @returns {{direction:'BUY'|'SELL'|'BLOCKED'|'UNKNOWN', side:string|null, allowed:boolean, blocker:string|null, ...}}
 */
function resolveDirection(candidate = {}) {
  const symbol = safeUpper(candidate.symbol) || null;
  const strategyId = String(candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId || '').trim() || null;
  const strategyKind = classifyStrategyKind(strategyId);
  const explicit = resolveExplicitSide(candidate);
  const trend = resolveTrendBias(candidate);

  const baseEvidence = {
    symbol,
    strategyId,
    strategyKind,
    explicitSide: explicit.side,
    explicitSource: explicit.source,
    explicitRawFields: explicit.rawFields,
    trendBias: trend.bias,
    trendSource: trend.source,
    trendRawFields: trend.rawFields,
  };

  // 1. Conflicting explicit direction fields -> BLOCKED (never pick a side).
  if (explicit.conflict) {
    return buildResult({
      direction: 'BLOCKED',
      side: null,
      source: 'explicit_conflict',
      confidence: null,
      blocker: CONFLICT_BLOCKER,
      reason: 'Conflicting explicit direction fields',
      reasonSv: 'Motstridiga riktningsfält – riktningen blockerades och kan inte gissas.',
      evidence: baseEvidence,
    });
  }

  // 2. A single unambiguous explicit side always wins (highest confidence).
  if (explicit.side) {
    // Reversal strategies are allowed ONLY because the reversal side is explicit.
    const source = strategyKind === 'reversal' ? 'explicit_reversal_side' : 'explicit_side';
    return buildResult({
      direction: explicit.side,
      side: explicit.side,
      source,
      confidence: 'high',
      blocker: null,
      reason: `Explicit ${explicit.side} from field "${explicit.source}"`,
      reasonSv: explicit.side === 'BUY' ? 'Tydlig köp-riktning (BUY) från explicit fält.' : 'Tydlig sälj-riktning (SELL) från explicit fält.',
      evidence: baseEvidence,
    });
  }

  // 3. Deterministic long/short suffix in the strategy_id.
  if (strategyKind === 'short_biased') {
    return buildResult({
      direction: 'SELL',
      side: 'SELL',
      source: 'strategy_id_suffix',
      confidence: 'high',
      blocker: null,
      reason: `strategy_id "${strategyId}" is deterministically short`,
      reasonSv: 'Strateginamnet anger entydigt en kort-/säljriktning (SELL).',
      evidence: baseEvidence,
    });
  }
  if (strategyKind === 'long_biased') {
    return buildResult({
      direction: 'BUY',
      side: 'BUY',
      source: 'strategy_id_suffix',
      confidence: 'high',
      blocker: null,
      reason: `strategy_id "${strategyId}" is deterministically long`,
      reasonSv: 'Strateginamnet anger entydigt en lång-/köpriktning (BUY).',
      evidence: baseEvidence,
    });
  }

  // 4. Continuation strategies follow a CONFIRMED trend bias.
  if (strategyKind === 'continuation') {
    if (trend.conflict) {
      return buildResult({
        direction: 'BLOCKED',
        side: null,
        source: 'trend_conflict',
        confidence: null,
        blocker: CONFLICT_BLOCKER,
        reason: 'Conflicting trend bias for a continuation strategy',
        reasonSv: 'Motstridig trend-bias för en continuation-strategi – riktningen blockerades.',
        evidence: baseEvidence,
      });
    }
    if (trend.bias === 'bull') {
      return buildResult({
        direction: 'BUY',
        side: 'BUY',
        source: 'continuation_with_trend',
        confidence: 'medium',
        blocker: null,
        reason: `${strategyId} continuation confirmed by bullish trend`,
        reasonSv: 'Continuation-strategi bekräftad av bullish trend → köp (BUY).',
        evidence: baseEvidence,
      });
    }
    if (trend.bias === 'bear') {
      return buildResult({
        direction: 'SELL',
        side: 'SELL',
        source: 'continuation_with_trend',
        confidence: 'medium',
        blocker: null,
        reason: `${strategyId} continuation confirmed by bearish trend`,
        reasonSv: 'Continuation-strategi bekräftad av bearish trend → sälj (SELL).',
        evidence: baseEvidence,
      });
    }
    // No verifiable trend bias -> cannot confirm a continuation direction.
    return buildResult({
      direction: 'UNKNOWN',
      side: null,
      source: 'continuation_unconfirmed',
      confidence: null,
      blocker: NOT_VERIFIED_BLOCKER,
      reason: 'Continuation strategy without a verifiable trend bias',
      reasonSv: 'Continuation-strategi saknar verifierbar trend-bias – riktningen kan inte bekräftas.',
      evidence: baseEvidence,
    });
  }

  // 5. Reversal/fakeout with no explicit reversal side -> never inferred.
  if (strategyKind === 'reversal') {
    return buildResult({
      direction: 'UNKNOWN',
      side: null,
      source: 'reversal_side_not_verified',
      confidence: null,
      blocker: NOT_VERIFIED_BLOCKER,
      reason: 'Reversal/fakeout strategy without an explicit, verifiable reversal side',
      reasonSv: 'Reversal/fakeout-strategi saknar tydlig, verifierbar vändningsriktning – riktningen får inte gissas.',
      evidence: baseEvidence,
    });
  }

  // 6. Nothing verifiable.
  return buildResult({
    direction: 'UNKNOWN',
    side: null,
    source: null,
    confidence: null,
    blocker: NOT_VERIFIED_BLOCKER,
    reason: 'No verifiable direction signal',
    reasonSv: 'Ingen verifierbar riktning – kandidaten tillåts inte.',
    evidence: baseEvidence,
  });
}

/** Resolve a list of candidates, returning per-candidate results + a summary. */
function resolveDirections(candidates = []) {
  const rows = (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    symbol: safeUpper(candidate?.symbol) || null,
    strategyId: String(candidate?.strategyId || candidate?.strategy_id || '').trim() || null,
    ...resolveDirection(candidate || {}),
  }));
  const summary = {
    total: rows.length,
    buy: rows.filter((r) => r.direction === 'BUY').length,
    sell: rows.filter((r) => r.direction === 'SELL').length,
    blocked: rows.filter((r) => r.direction === 'BLOCKED').length,
    unknown: rows.filter((r) => r.direction === 'UNKNOWN').length,
    verified: rows.filter((r) => r.allowed === true).length,
  };
  return { ok: true, mode: 'direction_resolver', readOnly: true, rows, summary, safety: { ...SAFETY } };
}

module.exports = {
  SAFETY,
  NOT_VERIFIED_BLOCKER,
  CONFLICT_BLOCKER,
  resolveDirection,
  resolveDirections,
  _internal: {
    classifyStrategyKind,
    resolveExplicitSide,
    resolveTrendBias,
    tokenToSide,
    tokenToBias,
    BUY_TOKENS,
    SELL_TOKENS,
  },
};
