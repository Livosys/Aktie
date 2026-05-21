'use strict';
const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');

const TV_EXCHANGE_MAP = {
  BTCUSDT: 'BINANCE', ETHUSDT: 'BINANCE', SOLUSDT: 'BINANCE',
  AAPL: 'NASDAQ', NVDA: 'NASDAQ', TSLA: 'NASDAQ',
  AMD: 'NASDAQ', MSFT: 'NASDAQ', META: 'NASDAQ', AMZN: 'NASDAQ', QQQ: 'NASDAQ',
};

function buildTradingViewUrl(symbol) {
  const exchange = TV_EXCHANGE_MAP[symbol] || 'NASDAQ';
  return `https://www.tradingview.com/chart/di3qlKNB/?symbol=${encodeURIComponent(exchange + ':' + symbol)}&interval=2`;
}

function getDatesInRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T00:00:00Z');
  const fin = new Date(end   + 'T00:00:00Z');
  while (cur <= fin) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function loadJsonlFile(fp) {
  if (!fs.existsSync(fp)) return [];
  try {
    return fs.readFileSync(fp, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const WAIT_SIGNALS = new Set(['WAIT', 'WAIT_PULLBACK', 'NO_TRADE']);

function isDefensiveSignal(sig) {
  if (!sig) return false;
  if (WAIT_SIGNALS.has(sig.signal)) return true;
  const actionSv  = sig.actionSv || '';
  const reasonSv  = Array.isArray(sig.reasonSv) ? sig.reasonSv.join(' ') : (sig.reasonSv || '');
  const combined  = (actionSv + ' ' + reasonSv).toLowerCase();
  if (combined.includes('jaga inte'))           return true;
  if (combined.includes('för långt från zon'))  return true;
  if (combined.includes('pris för långt'))      return true;
  if (sig.blocked === true)                     return true;
  return false;
}

function classifyMissedMove(outcome, merged) {
  const o5  = outcome.outcome5  || {};
  const o10 = outcome.outcome10 || {};
  const o20 = outcome.outcome20 || {};

  const moveUp10   = o10.maxMoveUp      || 0;
  const moveUp20   = o20.maxMoveUp      || 0;
  const moveDown10 = o10.maxMoveDown    || 0;
  const chg10      = o10.priceChangePct || 0;
  const chg20      = o20.priceChangePct || 0;
  const dip5       = o5.maxMoveDown     || 0;

  const maxUp     = Math.max(moveUp10, moveUp20);
  const isBullish = moveUp10 > moveDown10;

  const continuationStrength = Math.min(100, Math.round(maxUp * 20));
  const speedBonus           = moveUp10 >= 1.0 ? 20 : moveUp10 >= 0.5 ? 10 : 0;
  const persBonus            = chg20    >= 1.0 ? 20 : chg20    >= 0.5 ? 10 : 0;
  const breakoutStrength     = Math.min(100, continuationStrength + speedBonus + persBonus);

  const pullbackOccurred     = dip5 > 0.15;
  const movedWithoutPullback = !pullbackOccurred && chg10 > 0;
  const lateEntryQuality     = chg20 > 0 ? Math.min(100, Math.round(chg20 * 30)) : 0;

  // distanceFromZone from original signal if available
  const distanceFromZone = merged.priceToZoneAtr ?? null;

  let missedType;
  if (isBullish) {
    if (moveUp10 >= 1.5)           missedType = 'BULLISH_EXTENDED';
    else if (movedWithoutPullback) missedType = 'LATE_CONTINUATION';
    else if (chg20 >= 0.5)         missedType = 'TREND_PERSISTENCE';
    else                           missedType = 'BULLISH_CONTINUATION';
  } else {
    missedType = 'BEARISH_CONTINUATION';
  }

  const pct = maxUp.toFixed(2);
  let reviewSummarySv;
  if      (missedType === 'BULLISH_EXTENDED')     reviewSummarySv = `Priset steg kraftigt +${pct}% – systemet missade en stark bullish rörelse.`;
  else if (missedType === 'LATE_CONTINUATION')    reviewSummarySv = `Priset steg +${pct}% utan pullback – sent entry hade fortfarande gett vinst.`;
  else if (missedType === 'TREND_PERSISTENCE')    reviewSummarySv = `Trend fortsatte +${pct}% – systemet underskattade trendstyrkan.`;
  else if (missedType === 'BEARISH_CONTINUATION') reviewSummarySv = `Priset föll ${moveDown10.toFixed(2)}% – systemet missade bearish continuation.`;
  else                                            reviewSummarySv = `Priset fortsatte +${pct}% efter defensiv signal.`;

  return {
    continuationStrength,
    breakoutStrength,
    lateEntryQuality,
    pullbackOccurred,
    movedWithoutPullback,
    distanceFromZone,
    missedType,
    reviewSummarySv,
    movedPct10: chg10,
    movedPct20: chg20,
    maxUpPct:   maxUp,
  };
}

function fmtUTC(iso) {
  if (!iso) return '';
  const d   = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function fmtSwedish(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Stockholm',
  });
}

function buildReviewText(item, utcLabel, sweLabel) {
  const reasonArr = Array.isArray(item.reasonSv) ? item.reasonSv : (item.reasonSv ? [item.reasonSv] : []);
  return [
    item.symbol,
    `Signal: ${item.actionSv || item.signal || '–'}`,
    `Timestamp UTC: ${utcLabel.replace(' UTC', '')}`,
    `TradeScore: ${item.tradeScore ?? '–'}`,
    `NarrowScore: ${item.narrowScore ?? '–'}`,
    '',
    'Systemet blockerade setupen:',
    reasonArr.length ? `"${reasonArr[0]}"` : `"${item.signal}"`,
    '',
    'Vad hände:',
    `+${(item.maxUpPct || 0).toFixed(2)}% continuation efter signal.`,
    '',
    'Trolig förbättring:',
    'Systemet bör skilja mellan:',
    '- dålig entry',
    '- dålig direction',
  ].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

function findMissedBreakouts({ start, end, symbol, limit, onlyBlocked } = {}) {
  const defaultEnd   = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const s   = start  || defaultStart;
  const e   = end    || defaultEnd;
  const lim = Math.min(parseInt(limit, 10) || 200, 1000);

  const dates = getDatesInRange(s, e);

  // ── Load signal history (has actionSv, reasonSv, priceToZoneAtr, blocked)
  const signalMap = new Map();
  for (const date of dates) {
    for (const sig of loadJsonlFile(path.join(SIGNALS_DIR, `${date}.jsonl`))) {
      if (symbol && sig.symbol !== symbol) continue;
      if (sig.signalId) signalMap.set(sig.signalId, sig);
    }
  }

  // ── Load outcomes and join
  const results = [];
  for (const date of dates) {
    for (const outcome of loadJsonlFile(path.join(OUTCOMES_DIR, `${date}.jsonl`))) {
      if (symbol && outcome.symbol !== symbol) continue;

      const fr = outcome.failureReason;
      if (fr === 'insufficient_data' || fr === 'market_closed') continue;

      const sig    = outcome.signalId ? signalMap.get(outcome.signalId) : null;
      const merged = {
        ...outcome,
        ...(sig ? {
          actionSv:       sig.actionSv,
          reasonSv:       sig.reasonSv,
          blocked:        sig.blocked,
          priceToZoneAtr: sig.priceToZoneAtr,
          confidence:     sig.confidence,
          adaptiveEdge:   sig.adaptiveEdge,
          setupDNA:       sig.setupDNA,
        } : {}),
      };

      if (!isDefensiveSignal(merged))     continue;
      if (onlyBlocked && !merged.blocked) continue;

      const o10      = outcome.outcome10 || {};
      const o20      = outcome.outcome20 || {};
      const moveUp10 = o10.maxMoveUp      || 0;
      const moveUp20 = o20.maxMoveUp      || 0;
      const chg20    = o20.priceChangePct || 0;
      if (moveUp10 < 0.5 && moveUp20 < 1.0 && chg20 < 0.5) continue;

      const classification = classifyMissedMove(outcome, merged);
      const ts             = outcome.timestamp || '';
      const utcLabel       = fmtUTC(ts);
      const sweLabel       = fmtSwedish(ts);

      const item = {
        signalId:         outcome.signalId,
        symbol:           outcome.symbol,
        timestamp:        ts,
        signalTidUTC:     utcLabel,
        signalTidSverige: sweLabel,
        signal:           outcome.signal,
        actionSv:         merged.actionSv  || null,
        reasonSv:         merged.reasonSv  || null,
        tradeScore:       outcome.tradeScore,
        narrowScore:      outcome.narrowScore,
        blocked:          merged.blocked   || false,
        marketRegime:     outcome.marketRegime,
        marketDirection:  outcome.marketDirection,
        relVol20:         outcome.relVol20,
        entryPrice:       outcome.entryPrice,
        outcome3:         outcome.outcome3,
        outcome5:         outcome.outcome5,
        outcome10:        outcome.outcome10,
        outcome20:        outcome.outcome20,
        ...classification,
        tradingView:      buildTradingViewUrl(outcome.symbol),
        confidence:       merged.confidence   || null,
        adaptiveEdge:     merged.adaptiveEdge || null,
        setupDNA:         merged.setupDNA     || null,
      };
      item.copyReviewText = buildReviewText(item, utcLabel, sweLabel);

      results.push(item);
    }
  }

  results.sort((a, b) => b.continuationStrength - a.continuationStrength);
  return results.slice(0, lim);
}

module.exports = { findMissedBreakouts, classifyMissedMove };
