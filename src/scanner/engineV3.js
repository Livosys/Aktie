'use strict';
const { calcMarketRegime }   = require('./marketRegime');
const { calcMtf }            = require('./mtf');
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
 * Reads optional private fields _candles5m/_candles15m (attached by scheduler)
 * and passes them to calcMtf — they are stripped from the output.
 *
 * MTF adjustment is NOT applied here; applyMtf() runs later in the pipeline
 * (after confidenceEngine) so that autoFilter.blocked is available for the
 * full hard-block safety check.
 */
function applyEngineV3(v2result, marketRef) {
  // Extract private candle fields; don't leak to clients
  const { _candles2m, _candles5m, _candles15m, ...rest } = v2result || {};

  // ── Del 1: Market Regime ──────────────────────────────────────────────────
  const marketCtx = marketRef
    ? calcMarketRegime(marketRef)
    : {
        marketRegime:    'UNKNOWN',
        marketScore:     50,
        marketDirection: 'neutral',
        marketReasonSv:  ['Ingen marknadsreferens (krypto — 24/7 market, no QQQ).'],
      };

  // ── Del 2: MTF — metadata only, adjustment applied by applyMtf() later ───
  const mtfCtx = calcMtf(rest, _candles5m || null, _candles15m || null);

  // ── Del 3: Score Breakdown (6 komponenter + market-justering) ────────────
  const breakdown = calcScoreBreakdown(rest, marketCtx);

  return {
    ...rest,
    _candles2m,

    // Market Regime (Del 1)
    marketRegime:    marketCtx.marketRegime,
    marketScore:     marketCtx.marketScore,
    marketDirection: marketCtx.marketDirection,
    marketReasonSv:  marketCtx.marketReasonSv,

    // MTF metadata (Del 2) — mtfAdjustment applied later by applyMtf()
    mtfStatus:        mtfCtx.mtfStatus,
    mtfAlignment:     mtfCtx.mtfAlignment,
    mtfScore:         mtfCtx.mtfScore,
    mtfRawAdjustment: mtfCtx.mtfRawAdjustment,
    mtfAdjustment:    mtfCtx.mtfAdjustment,
    mtfDirection:     mtfCtx.mtfDirection,
    mtfReasonSv:      mtfCtx.mtfReasonSv,
    mtfExplanationSv: mtfCtx.mtfExplanationSv,
    tf2mDirection:    mtfCtx.tf2mDirection,
    tf5mDirection:    mtfCtx.tf5mDirection,
    tf15mDirection:   mtfCtx.tf15mDirection,
    mtf5m:            mtfCtx.mtf5m,
    mtf15m:           mtfCtx.mtf15m,

    // Score Breakdown (Del 3)
    scores:             breakdown.scores,
    scoreExplanationSv: breakdown.scoreExplanationSv,

    tradeScore:  breakdown.finalScore,
    signalScore: breakdown.finalScore,
    scoreLabel:  scoreLabel(breakdown.finalScore),
  };
}

module.exports = { applyEngineV3 };
