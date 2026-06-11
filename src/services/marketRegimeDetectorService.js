'use strict';

/**
 * Market Regime Detector — READ-ONLY normalization layer.
 *
 * This service does NOT detect anything new. It composes the already-existing,
 * non-writing functions of marketRegimeService into a single, compact,
 * render-safe object that the Strategy Research Manager and the Supervisor UI
 * can consume without having to know the internal shape of the regime engine.
 *
 * Why a separate file:
 *  - marketRegimeService.buildRegimeSummary() WRITES status.json/history.json as
 *    a side effect. This detector intentionally avoids that path and only calls
 *    the pure read functions (detectMarketRegime, calculateRegimeScore,
 *    buildMarketBias, calculateStrategyWeights) so it is guaranteed read-only.
 *  - marketRegimeService.SAFETY uses an older "analysis_only" shape. The
 *    Trading OS contract requires the canonical paper_only safety object, so we
 *    re-stamp it here.
 *
 * SAFETY: pure read. Never writes files, never places orders, never enables a
 * broker, never changes risk or live trading. Always paper_only.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Lazy require so a load error in the regime engine can never break callers.
function lazyRegime() {
  try { return require('./marketRegimeService'); } catch (_) { return null; }
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a compact, normalized regime detection. Never throws — on any failure
 * it returns a degraded/empty object that still carries the safety contract.
 *
 * @returns {{
 *   ok: boolean, status: 'ok'|'empty'|'degraded'|'error', source: string,
 *   regime: string|null, regimeLabelSv: string|null, regimeIcon: string|null,
 *   regimeDescSv: string|null, score: number|null, confidence: string|null,
 *   freshness: string|null, volatilityState: string|null,
 *   trendState: string|null, riskEnvironment: string|null, isChoppy: boolean,
 *   biasOverall: string|null, biasSummaryLines: string[],
 *   topStrategies: string[], bottomStrategies: string[],
 *   detectedAt: string, message: string|null, safety: object
 * }}
 */
function buildMarketRegimeDetection() {
  const regimeService = lazyRegime();
  const detectedAt = new Date().toISOString();
  const base = {
    ok: false,
    status: 'error',
    source: 'marketRegimeService',
    regime: null,
    regimeLabelSv: null,
    regimeIcon: null,
    regimeDescSv: null,
    score: null,
    confidence: null,
    freshness: null,
    riskEnvironment: null,
    isChoppy: false,
    biasOverall: null,
    biasSummaryLines: [],
    topStrategies: [],
    bottomStrategies: [],
    detectedAt,
    message: null,
    safety: SAFETY,
  };

  if (!regimeService || typeof regimeService.detectMarketRegime !== 'function') {
    return { ...base, status: 'empty', message: 'Marknadsregim-tjänsten kunde inte läsas.' };
  }

  try {
    const regime = regimeService.detectMarketRegime();
    const meta = (regimeService.REGIME_META && regimeService.REGIME_META[regime]) || {};
    const score = typeof regimeService.calculateRegimeScore === 'function'
      ? regimeService.calculateRegimeScore()
      : null;
    const bias = typeof regimeService.buildMarketBias === 'function'
      ? regimeService.buildMarketBias()
      : null;
    const weights = typeof regimeService.calculateStrategyWeights === 'function'
      ? regimeService.calculateStrategyWeights(regime)
      : null;

    return {
      ok: true,
      status: regime ? 'ok' : 'empty',
      source: 'marketRegimeService',
      regime: regime || null,
      regimeLabelSv: meta.labelSv || regime || null,
      regimeIcon: meta.icon || null,
      regimeDescSv: meta.descSv || null,
      score: score ? num(score.score) : null,
      confidence: score ? score.confidence || null : null,
      freshness: score ? score.freshness || null : null,
      riskEnvironment: bias ? (bias.riskOff ? 'risk_off' : bias.riskOn ? 'risk_on' : null) : null,
      isChoppy: regime === 'CHOPPY_MARKET',
      biasOverall: bias ? bias.overall || null : null,
      biasSummaryLines: bias && Array.isArray(bias.summaryLines) ? bias.summaryLines.slice(0, 6) : [],
      topStrategies: weights && Array.isArray(weights.topStrategies) ? weights.topStrategies.slice(0, 6) : [],
      bottomStrategies: weights && Array.isArray(weights.bottomStrategies) ? weights.bottomStrategies.slice(0, 6) : [],
      detectedAt,
      message: `Marknadsregim läst read-only: ${meta.labelSv || regime}.`,
      safety: SAFETY,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      message: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = {
  SAFETY,
  buildMarketRegimeDetection,
};
