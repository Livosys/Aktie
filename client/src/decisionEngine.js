// Signal Decision Engine — pure JS, no React dependency.
// computeDecision(signal, learningSummary) → decision object
// All historical enrichment is derived from the learningSummary returned by
// GET /api/history/learning-summary and the live signal fields.

const REGIME_SV = {
  BULLISH_TREND:   'Stark upptrend',
  BEARISH_TREND:   'Stark nedtrend',
  CHOPPY:          'Stökig marknad',
  RANGE_DAY:       'Sidledsdag',
  TREND_DAY_UP:    'Trenddag uppåt',
  TREND_DAY_DOWN:  'Trenddag nedåt',
  HIGH_VOLATILITY: 'Hög volatilitet',
  PANIC:           'Panik',
  UNKNOWN:         'Okänt läge',
};

export function isAvoidSignal(r) {
  return (
    r.autoFilter?.blocked ||
    ['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'BREAKOUT_ALREADY_OCCURRED', 'NO_TRADE'].includes(r.state) ||
    r.threeFingerSpread?.active ||
    r.breakoutAlreadyOccurred
  );
}

export function computeDecision(signal, learningSummary) {
  if (!signal) return null;

  const score       = signal.tradeScore ?? 0;
  const isBlocked   = isAvoidSignal(signal);
  const isLong      = ['LONG_TRIGGERED', 'LONG_WATCH'].includes(signal.signal);
  const isShort     = ['SHORT_TRIGGERED', 'SHORT_WATCH'].includes(signal.signal);
  const isTriggered = ['LONG_TRIGGERED', 'SHORT_TRIGGERED'].includes(signal.signal);

  // ── Action ────────────────────────────────────────────────────────────────
  let action;
  if (isBlocked) {
    action = 'AVOID';
  } else if (isTriggered && score >= 60) {
    action = 'CONFIRMED';
  } else if (isLong) {
    action = 'BUY_WATCH';
  } else if (isShort) {
    action = 'SELL_WATCH';
  } else {
    action = 'WAIT';
  }

  // ── Risk level ────────────────────────────────────────────────────────────
  const isChoppy   = ['CHOPPY', 'HIGH_VOLATILITY', 'PANIC'].includes(signal.marketRegime);
  const weakVol    = signal.relVol20 != null && signal.relVol20 < 0.7;
  const farZone    = signal.priceToZoneAtr != null && signal.priceToZoneAtr > 1.5;
  const tfsActive  = signal.threeFingerSpread?.active;

  let riskLevel;
  if (isBlocked || signal.marketRegime === 'PANIC' || tfsActive) {
    riskLevel = 'HIGH';
  } else if (isChoppy || weakVol || farZone) {
    riskLevel = 'HIGH';
  } else if (score >= 65 && !isChoppy && !weakVol) {
    riskLevel = 'LOW';
  } else {
    riskLevel = 'MEDIUM';
  }

  // ── Confidence level ──────────────────────────────────────────────────────
  const confLabel = signal.confidence?.label;
  let confidenceLevel;
  if (confLabel === 'Mycket stark' || confLabel === 'Stark') confidenceLevel = 'HIGH';
  else if (confLabel === 'Svag' || confLabel === 'Blockerad') confidenceLevel = 'LOW';
  else confidenceLevel = 'MEDIUM';

  // ── Historical stats from learning summary ────────────────────────────────
  const ls         = learningSummary || {};
  const symStats   = ls.bySymbol?.[signal.symbol];
  const regStats   = ls.byMarketRegime?.[signal.marketRegime];

  const symWR    = symStats?.winRate   != null ? Math.round(symStats.winRate   * 100) : null;
  const symMove  = symStats?.avgMove10 != null ? +(symStats.avgMove10 * 100).toFixed(2) : null;
  const symCount = symStats?.samples   ?? 0;
  const overallWR = ls.overallWinRate  != null ? Math.round(ls.overallWinRate * 100) : null;

  // Symbol rank (by win rate, among symbols with ≥5 samples)
  const allSymRanked = Object.entries(ls.bySymbol || {})
    .filter(([, v]) => v.samples >= 5 && v.winRate != null)
    .sort(([, a], [, b]) => b.winRate - a.winRate);
  const symRankIdx = allSymRanked.findIndex(([k]) => k === signal.symbol);
  const symRank    = symRankIdx >= 0 ? symRankIdx + 1 : null;
  const isBestSym  = symRank === 1;
  const isWorstSym = symRank != null && symRank === allSymRanked.length && allSymRanked.length > 1;
  const worstSymKeys = (ls.worstSymbols || []).map(s => s.key);
  const isInWorst    = worstSymKeys.includes(signal.symbol);

  // ── Signal score (adjusted for historical data) ───────────────────────────
  let signalScore = score;
  if (symWR !== null) {
    if      (symWR >= 60) signalScore = Math.min(100, signalScore + 5);
    else if (symWR < 40)  signalScore = Math.max(0,   signalScore - 5);
  }
  if (regStats?.winRate != null && regStats.winRate < 0.42) {
    signalScore = Math.max(0, signalScore - 5);
  }
  if (isBestSym)  signalScore = Math.min(100, signalScore + 3);
  if (isInWorst)  signalScore = Math.max(0,   signalScore - 3);
  signalScore = Math.round(signalScore);

  // ── Why factors ───────────────────────────────────────────────────────────
  const factors = [];

  if (signal.state === 'HIGH_QUALITY_NARROW')
    factors.push({ text: 'Bästa narrow state — priset är ihoptryckt', good: true });
  if (signal.state === 'MEDIUM_NARROW')
    factors.push({ text: 'Okej narrow state — potentiell setup', good: true });
  if (signal.narrowType === 'coil_flat')
    factors.push({ text: 'Coil/Flat — klassisk fjäder-setup', good: true });
  if (signal.narrowType === 'attack_200')
    factors.push({ text: 'Attack 200 — SMA20 rör sig mot SMA200', good: true });
  if (isTriggered)
    factors.push({ text: 'Signal är triggrad — rörelsen har startat', good: true });
  if (signal.relVol20 != null && signal.relVol20 >= 1.5)
    factors.push({ text: `Hög volym (${signal.relVol20.toFixed(1)}x normal)`, good: true });
  if ((signal.marketRegime === 'BULLISH_TREND' || signal.marketRegime === 'TREND_DAY_UP') && isLong)
    factors.push({ text: 'Upptrend stödjer long-setup', good: true });
  if ((signal.marketRegime === 'BEARISH_TREND' || signal.marketRegime === 'TREND_DAY_DOWN') && isShort)
    factors.push({ text: 'Nedtrend stödjer short-setup', good: true });
  if (symWR !== null && symWR >= 55)
    factors.push({ text: `${signal.symbol} historisk träffsäkerhet: ${symWR}%`, good: true });
  if (isBestSym)
    factors.push({ text: `${signal.symbol} är topprankad historiskt`, good: true });
  if (signal.elephantBar?.active && score >= 40)
    factors.push({ text: `Stor candle (${signal.elephantBar.rangeMultiple}x) bekräftar momentum`, good: true });

  if (isChoppy)
    factors.push({ text: 'Stökig marknad — fler falska signaler', good: false });
  if (weakVol)
    factors.push({ text: `Svag volym (${signal.relVol20?.toFixed(2) ?? '?'}x) — sämre bekräftelse`, good: false });
  if (signal.breakoutAlreadyOccurred)
    factors.push({ text: 'Utbrott redan skett — sämre entrytiming', good: false });
  if (farZone)
    factors.push({ text: 'Priset är för långt från entry-zonen', good: false });
  if (symWR !== null && symWR < 45)
    factors.push({ text: `${signal.symbol} historisk träffsäkerhet bara ${symWR}%`, good: false });
  if (isInWorst)
    factors.push({ text: `${signal.symbol} är bland sämst presterande historiskt`, good: false });

  // ── Explanation (primary description) ────────────────────────────────────
  const explanation = signal.actionSv || signal.scoreExplanationSv?.[0] || '';

  // ── Historical summary text ───────────────────────────────────────────────
  let historicalSummary;
  if (symCount >= 5 && symWR !== null) {
    const dir = symMove != null && symMove >= 0 ? '+' : '';
    historicalSummary = `${signal.symbol}: ${symWR}% träffsäkerhet på ${symCount} liknande signaler`;
    if (symMove !== null) historicalSummary += ` · snitt ${dir}${symMove}% (20 min)`;
    if (regStats?.winRate != null) {
      const regLabel = REGIME_SV[signal.marketRegime] || signal.marketRegime || '';
      historicalSummary += ` · i ${regLabel}: ${Math.round(regStats.winRate * 100)}%`;
    }
    historicalSummary += '.';
  } else if (overallWR !== null) {
    historicalSummary = `System-total träffsäkerhet: ${overallWR}%. Behöver mer data om ${signal.symbol}.`;
  } else {
    historicalSummary = 'Ingen historisk data — kör historisk analys för bättre underlag.';
  }

  // ── Market regime comment ─────────────────────────────────────────────────
  const regimeSvLabel = REGIME_SV[signal.marketRegime] || signal.marketRegime || 'Okänt';
  let marketRegimeComment = regimeSvLabel;
  if (regStats?.winRate != null) {
    marketRegimeComment += ` · ${Math.round(regStats.winRate * 100)}% historisk träffsäkerhet (${regStats.samples} sig.)`;
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  let recommendation;
  if (action === 'AVOID') {
    recommendation = 'Undvik — systemet blockerar detta läge.';
  } else if (action === 'CONFIRMED') {
    recommendation = 'Signalen är triggrad med högt betyg. Reagera snabbt, respektera stop-loss.';
  } else if (action === 'BUY_WATCH') {
    recommendation = riskLevel === 'HIGH'
      ? 'Bevaka men var försiktig — hög risk. Vänta på tydligare bekräftelse.'
      : 'Bevaka long-entry. Vänta på att priset passerar triggnivån.';
  } else if (action === 'SELL_WATCH') {
    recommendation = riskLevel === 'HIGH'
      ? 'Bevaka men var försiktig — hög risk. Vänta på tydligare bekräftelse.'
      : 'Bevaka short-entry. Vänta på att priset passerar triggnivån nedåt.';
  } else {
    recommendation = 'Vänta på bättre setup. Återkom när marknaden är tydligare.';
  }
  if (isChoppy && action !== 'AVOID') {
    recommendation += ' Stökig marknad — minska positionsstorlek.';
  }

  // ── Setup type ────────────────────────────────────────────────────────────
  const setupType = signal.narrowType === 'coil_flat' ? 'Coil/Flat'
    : signal.narrowType === 'attack_200' ? 'Attack 200'
    : signal.state === 'HIGH_QUALITY_NARROW' ? 'Bästa narrow'
    : signal.state === 'MEDIUM_NARROW' ? 'Okej narrow'
    : signal.state === 'REGULAR_TREND' ? 'Trend'
    : (signal.eventType || 'Okänd').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  return {
    signalScore,
    action,
    riskLevel,
    confidenceLevel,
    explanation,
    historicalSummary,
    bestTimeframe: '2m',
    similarSignalCount: symCount,
    historicalWinRate: symWR,
    historicalAverageMove: symMove,
    historicalBestSymbolRank: symRank,
    marketRegimeComment,
    recommendation,
    setupType,
    factors,
  };
}

// Enrich an array of signals with _decision fields
export function enrichWithDecisions(results, learningSummary) {
  return results.map(r => ({ ...r, _decision: computeDecision(r, learningSummary) }));
}

// Get the single best signal (highest signalScore, non-blocked)
export function getBestSignal(enriched) {
  const active = enriched.filter(r => !isAvoidSignal(r));
  if (!active.length) return null;
  return active.sort(
    (a, b) => (b._decision?.signalScore ?? b.tradeScore ?? 0)
            - (a._decision?.signalScore ?? a.tradeScore ?? 0)
  )[0];
}

// Get top N signals (non-blocked, sorted by decision score)
export function getTopN(enriched, n = 5) {
  return enriched
    .filter(r => !isAvoidSignal(r))
    .sort((a, b) => (b._decision?.signalScore ?? b.tradeScore ?? 0)
                  - (a._decision?.signalScore ?? a.tradeScore ?? 0))
    .slice(0, n);
}

// Group signals by symbol
export function groupBySymbol(enriched) {
  const groups = {};
  for (const r of enriched) {
    if (!groups[r.symbol]) groups[r.symbol] = [];
    groups[r.symbol].push(r);
  }
  return groups;
}
