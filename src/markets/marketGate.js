'use strict';

/**
 * Market Gate v3 — paper trading safety/calibration layer.
 *
 * Evaluates a signal candidate against 7 rule categories and returns a gateScore
 * (0-100) + mode/reasons/penalties/boosts object. Integrated into paperTradingAgent
 * BEFORE buildOpenTrade. No effect on live signals or Decision Monitor.
 *
 * Rule categories:
 *   A) Data freshness
 *   B) Session
 *   C) paperOnly flag
 *   D) Market compass
 *   E) Market group risk thresholds
 *   F) Calibration safety (conservativeMode, subtype stats)
 *   G) Signal subtype safety (v3 rules re-enforced at gate level)
 */

const { getMarketGroup, getRiskProfile } = require('./marketProfiles');
const compassModule                      = require('./marketCompass');

// ── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLD_NORMAL       = 70;
const THRESHOLD_CONSERVATIVE = 80;
const THRESHOLD_OBSERVE_ONLY = 55;
const THRESHOLD_LEVERAGED    = 85;
const THRESHOLD_CRYPTO_SEC   = 80;
const PAPER_RULE_VERSION      = 'v3';

// ── Symbol helpers ────────────────────────────────────────────────────────────

const NYSE_GROUPS    = new Set(['US_STOCKS', 'INDEX_ETFS', 'LEVERAGED_ETFS']);
const INVERSE_ETFS   = new Set(['SQQQ', 'SOXS', 'TZA']); // short-biased leveraged ETFs
const WEAK_VOLUME_STATES = new Set(['weak', 'low', 'very_low']);
const VWAP_SUBTYPES = new Set(['VWAP_RECLAIM_UP', 'VWAP_REJECTION_DOWN']);
const EMA_PULLBACK_SUBTYPES = new Set(['EMA_PULLBACK_UP', 'EMA_PULLBACK_DOWN']);

function isCrypto(signal) {
  const mt = String(signal.marketType || signal.market || '').toLowerCase();
  return mt === 'crypto' || String(signal.symbol || '').endsWith('USDT');
}

function getEffectiveThreshold(marketGroup, conservativeMode) {
  if (marketGroup === 'LEVERAGED_ETFS')    return THRESHOLD_LEVERAGED;
  if (marketGroup === 'CRYPTO_SECONDARY')  return THRESHOLD_CRYPTO_SEC;
  return conservativeMode ? THRESHOLD_CONSERVATIVE : THRESHOLD_NORMAL;
}

// ── Gate evaluator ────────────────────────────────────────────────────────────

/**
 * @param {object} signal  — candidate signal (same shape as c in paperTradingAgent)
 * @param {object} context — { conservativeMode, calibrationStats }
 *   calibrationStats: { bySignalSubtype: Record<string, {trades,timeoutRate,avgPnlPct}> }
 * @returns {GateDecision}
 */
function evaluateMarketGate(signal, context = {}) {
  const { conservativeMode = false, calibrationStats = {} } = context;

  const reasons   = []; // blocking reasons (Swedish)
  const warnings  = []; // non-blocking warnings
  const penalties = []; // applied score deductions
  const boosts    = []; // applied score additions

  const marketGroup    = getMarketGroup(signal.symbol) || signal.marketGroup || 'UNKNOWN';
  const profile        = getRiskProfile(signal.symbol);
  const riskProfileName = profile
    ? `${profile.groupName.toLowerCase()}_default`
    : 'unknown';

  const compass  = compassModule.getMarketCompass();
  const compassBias = compass?.bias || 'UNKNOWN';
  const sub      = signal.signalSubtype || '';
  const bias     = signal.nextMoveBias;   // 'UP' | 'DOWN'
  const volState = String(signal.volumeState || '').toLowerCase();
  const crypto   = isCrypto(signal);
  const confScore = signal.confidenceScore ?? 0;

  let gateScore   = 60; // baseline
  let blocked     = false;
  let observeOnly = false;
  let compassConflict = false;
  let volumeGateDecision = null;
  let observeOnlyReasonSv = null;

  function setObserveOnly(reasonSv, decision = 'observe_only') {
    observeOnly = true;
    observeOnlyReasonSv = observeOnlyReasonSv || reasonSv;
    volumeGateDecision = volumeGateDecision || decision;
    warnings.push(reasonSv);
  }

  // ── A) Data freshness ────────────────────────────────────────────────────────
  if (!crypto && signal.dataFreshness !== 'LIVE') {
    blocked = true;
    reasons.push('Data inte färsk — signalen godkänns ej.');
  }

  if (marketGroup === 'UNKNOWN') {
    setObserveOnly('Marknadsgrupp saknas. Agenten observerar bara.');
  }

  // ── B) Session ───────────────────────────────────────────────────────────────
  if (NYSE_GROUPS.has(marketGroup) && signal.marketClosed) {
    observeOnly = true;
    gateScore  -= 20;
    warnings.push('Marknaden är stängd — signal i bevakningsläge.');
  }

  // ── C) paperOnly ─────────────────────────────────────────────────────────────
  if (profile?.paperOnly) {
    warnings.push('Instrument är paperOnly — ej ett riktigt värdepapper.');
  }

  // ── D) Market compass ─────────────────────────────────────────────────────────
  if (compass) {
    const isNYSELong  = bias === 'UP'   && NYSE_GROUPS.has(marketGroup);
    const isInvShort  = bias === 'DOWN' && INVERSE_ETFS.has(signal.symbol);
    const isNonInvShort = bias === 'DOWN' && !INVERSE_ETFS.has(signal.symbol);

    if (compass.riskOff && isNYSELong) {
      compassConflict = true;
      gateScore -= 15;
      penalties.push('Marknaden risk-off — lång-signal i aktier/ETF straffas (−15).');
    } else if (compass.riskOn && isInvShort) {
      // Short on inverse ETF when market is risk-on = actually net bearish → penalize
      compassConflict = true;
      gateScore -= 15;
      penalties.push('Marknaden risk-on — kort position i inverterat ETF straffas (−15).');
    } else if (compass.riskOn && isNonInvShort && NYSE_GROUPS.has(marketGroup)) {
      compassConflict = true;
      gateScore -= 10;
      penalties.push('Marknaden risk-on — kort signal i aktier straffas (−10).');
    } else if (compass.bias === 'MIXED') {
      gateScore -= 5;
      warnings.push('Blandad marknadsbild — kompassen ger ingen tydlig riktning (−5).');
    }

    if (!compassConflict) {
      if (compass.riskOn && bias === 'UP') {
        gateScore += 8;
        boosts.push('Kompassriktning risk-on stöder lång-signal (+8).');
      } else if (compass.riskOff && bias === 'DOWN') {
        gateScore += 8;
        boosts.push('Kompassriktning risk-off stöder kort-signal (+8).');
      }
    }
  }

  // ── D2) Stop weak crypto conditions (paper rules v3) ───────────────────────
  if (crypto) {
    const isVwap = VWAP_SUBTYPES.has(sub);
    const isEmaPullback = EMA_PULLBACK_SUBTYPES.has(sub);

    if (isVwap) {
      if (volState === 'strong') {
        volumeGateDecision = volumeGateDecision || 'allow';
      } else if (volState === 'normal') {
        setObserveOnly(
          compassBias === 'MIXED'
            ? 'Blandad marknad och inte stark volym.'
            : 'Crypto VWAP med normal volym. Agenten observerar bara.'
        );
      } else if (WEAK_VOLUME_STATES.has(volState)) {
        blocked = true;
        volumeGateDecision = 'block';
        reasons.push('Crypto VWAP med svag volym blockeras.');
      }
    }

    if (isEmaPullback) {
      setObserveOnly('EMA i crypto är pausad. Agenten observerar bara.');
    }

    if (!isVwap && !isEmaPullback && WEAK_VOLUME_STATES.has(volState) && compassBias !== 'MIXED') {
      blocked = true;
      volumeGateDecision = 'block';
      reasons.push('Svag volym i crypto blockeras.');
    }

    if (compassBias === 'MIXED' && volState !== 'strong' && !blocked) {
      setObserveOnly('Blandad marknad och inte stark volym.');
    }
  }

  // ── E) Market group risk ─────────────────────────────────────────────────────
  if (marketGroup === 'LEVERAGED_ETFS') {
    gateScore -= 5;
    warnings.push('Hävstångs-ETF — förhöjd risk, tröskel 85 (−5).');
  }
  if (marketGroup === 'CRYPTO_SECONDARY') {
    gateScore -= 5;
    warnings.push('Sekundär krypto — förhöjd risk, tröskel 80 (−5).');
  }

  // ── F) Calibration safety ────────────────────────────────────────────────────
  if (conservativeMode) {
    gateScore -= 5;
    penalties.push('Konservativt läge aktivt — tröskel höjd till 80 (−5).');
  }

  const subtypeStats = calibrationStats.bySignalSubtype?.[sub];
  if (subtypeStats && subtypeStats.trades >= 5) {
    if (subtypeStats.timeoutRate > 70 && sub === 'VWAP_RECLAIM_UP' && volState !== 'strong') {
      gateScore -= 10;
      penalties.push(`VWAP_RECLAIM_UP: ${subtypeStats.timeoutRate}% timeout i kalibreringen — svag volym straffas (−10).`);
    }
    if (subtypeStats.avgPnlPct < 0) {
      gateScore -= 8;
      penalties.push(`Signaltypen ${sub} har negativ genomsnittlig PnL i kalibreringen (−8).`);
    }
  }

  // ── G) Signal subtype safety (gate-level v3 re-enforcement) ─────────────────
  if (crypto) {
    if (!observeOnly && volState === 'normal' && sub !== 'VWAP_RECLAIM_UP' && sub !== 'VWAP_REJECTION_DOWN' && !EMA_PULLBACK_SUBTYPES.has(sub)) {
      blocked = true;
      reasons.push('Normal volym i crypto — enbart VWAP-signaler godkänns vid gate.');
    } else if (confScore >= 50 && (signal.extensionLevel || 'none') !== 'none' && volState !== 'strong') {
      gateScore -= 15;
      penalties.push('Rörelsen kan vara sen (hög konfidenspoäng + extension + ej stark volym) (−15).');
    }
  }

  // ── Boosts: signal quality ───────────────────────────────────────────────────
  if (sub === 'VWAP_RECLAIM_UP') {
    gateScore += 12;
    boosts.push('VWAP_RECLAIM_UP — starkaste VWAP-signalen (+12).');
  } else if (sub === 'VWAP_REJECTION_DOWN') {
    gateScore += 10;
    boosts.push('VWAP_REJECTION_DOWN — godkänd signaltyp (+10).');
  } else if (sub === 'EMA_PULLBACK_UP') {
    gateScore += 6;
    boosts.push('EMA_PULLBACK_UP — godkänd signaltyp (+6).');
  }

  if (volState === 'strong') {
    gateScore += 8;
    boosts.push('Stark volym stöder signalen (+8).');
  }

  if (confScore >= 70) {
    gateScore += 5;
    boosts.push(`Konfidenspoäng ${confScore} — hög kvalitet (+5).`);
  } else if (confScore >= 50) {
    gateScore += 2;
    boosts.push(`Konfidenspoäng ${confScore} — godkänd (+2).`);
  }

  // ── Finalise ─────────────────────────────────────────────────────────────────
  const effectiveThreshold = getEffectiveThreshold(marketGroup, conservativeMode);
  const threshold          = observeOnly ? THRESHOLD_OBSERVE_ONLY : effectiveThreshold;
  const finalScore         = Math.max(0, Math.min(100, Math.round(gateScore)));

  let mode;
  let allowed;

  if (marketGroup === 'UNKNOWN') {
    blocked = false;
    observeOnly = true;
    observeOnlyReasonSv = 'Marknadsgrupp saknas. Agenten observerar bara.';
    volumeGateDecision = 'observe_only';
  }

  if (blocked) {
    allowed = false;
    mode    = 'blocked';
  } else if (observeOnly) {
    allowed = false;
    mode    = 'observe_only';
  } else {
    allowed = finalScore >= threshold;
    mode    = conservativeMode ? 'conservative' : 'normal';
  }

  if (!volumeGateDecision) {
    volumeGateDecision = mode === 'observe_only' ? 'observe_only' : (allowed ? 'allow' : 'block');
  }

  return {
    ruleVersion: PAPER_RULE_VERSION,
    allowed,
    gateScore:    finalScore,
    threshold,
    mode,
    reasons,
    warnings,
    penalties,
    boosts,
    observeOnlyReasonSv,
    volumeGateDecision,
    compassConflict,
    compassBias,
    marketGroup,
    riskProfileName,
    evaluatedAt: new Date().toISOString(),
    signal: {
      symbol:         signal.symbol,
      signalSubtype:  sub,
      nextMoveBias:   bias,
      volumeState:    volState,
      confidenceScore: confScore,
    },
  };
}

/**
 * Returns a Swedish text explanation of a gate decision.
 */
function explainMarketGateDecision(decision) {
  if (!decision) return 'Ingen gate-beslut.';
  const { allowed, gateScore, threshold, mode, reasons, warnings, penalties, boosts } = decision;

  const lines = [
    allowed
      ? `Gate godkänd — poäng ${gateScore}/${threshold}, läge: ${mode}.`
      : `Gate blockerad — poäng ${gateScore}/${threshold}, läge: ${mode}.`,
  ];
  for (const r of reasons)   lines.push(`• Blockerad: ${r}`);
  for (const w of warnings)  lines.push(`• Varning: ${w}`);
  for (const p of penalties) lines.push(`• Straff: ${p}`);
  for (const b of boosts)    lines.push(`• Boost: ${b}`);

  return lines.join('\n');
}

module.exports = {
  evaluateMarketGate,
  explainMarketGateDecision,
  THRESHOLD_NORMAL,
  THRESHOLD_CONSERVATIVE,
  THRESHOLD_OBSERVE_ONLY,
  THRESHOLD_LEVERAGED,
  THRESHOLD_CRYPTO_SEC,
  PAPER_RULE_VERSION,
};
