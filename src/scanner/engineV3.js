'use strict';
const { calcMarketRegime } = require('./marketRegime');
const { calcMtf }          = require('./mtf');
const { calcScoreBreakdown } = require('./scoreBreakdown');

function scoreLabel(score) {
  if (score >= 60) return 'Strong';
  if (score >= 35) return 'Watch';
  if (score >= 15) return 'Weak';
  return 'Avoid';
}

/**
 * Engine v3 — Orchestrator
 *
 * Takes a v2 classifyNarrowState result and enriches it with Engine v3 fields.
 * All original v2 fields are preserved unchanged.
 * tradeScore is replaced by the v3 finalScore (breakdown-based).
 *
 * @param {object} v2result        — output from classifyNarrowState()
 * @param {object|null} marketRef  — v2 result for the market reference symbol (QQQ for stocks).
 *                                   Pass null for crypto or when no reference is available.
 * @returns {object}               — v2result spread + new v3 fields
 */
function applyEngineV3(v2result, marketRef) {
  // ── Del 1: Market Regime ──────────────────────────────────────────────────
  const marketCtx = marketRef
    ? calcMarketRegime(marketRef)
    : {
        marketRegime:    'UNKNOWN',
        marketScore:     50,
        marketDirection: 'neutral',
        marketReasonSv:  ['Ingen marknadsreferens (krypto — 24/7 market, no QQQ).'],
      };

  // ── Del 2: MTF ────────────────────────────────────────────────────────────
  const mtfCtx = calcMtf(v2result);

  // ── Del 3: Score Breakdown (steg 2 — 6 komponenter + market-justering) ──────
  const breakdown = calcScoreBreakdown(v2result, marketCtx);

  // ── Merge: spread v2 fields, override tradeScore, add v3 fields ──────────
  return {
    ...v2result,

    // Market Regime (Del 1)
    marketRegime:    marketCtx.marketRegime,
    marketScore:     marketCtx.marketScore,
    marketDirection: marketCtx.marketDirection,
    marketReasonSv:  marketCtx.marketReasonSv,

    // MTF (Del 2)
    mtfStatus:      mtfCtx.mtfStatus,
    mtfAlignment:   mtfCtx.mtfAlignment,
    mtfScore:       mtfCtx.mtfScore,
    mtfReasonSv:    mtfCtx.mtfReasonSv,
    tf2mDirection:  mtfCtx.tf2mDirection,
    tf5mDirection:  mtfCtx.tf5mDirection,
    tf15mDirection: mtfCtx.tf15mDirection,

    // Score Breakdown (Del 3)
    scores:             breakdown.scores,
    scoreExplanationSv: breakdown.scoreExplanationSv,

    // tradeScore and signalScore replaced by v3 finalScore
    tradeScore:  breakdown.finalScore,
    signalScore: breakdown.finalScore,
    scoreLabel:  scoreLabel(breakdown.finalScore),
  };
}

module.exports = { applyEngineV3 };
