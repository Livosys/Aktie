'use strict';
const fs   = require('fs');
const path = require('path');
const { loadCandles, getDatesInRange } = require('../data/marketDataStore');
const { toScannerFormat }              = require('../data/candleAggregator');
const { loadSignals }                  = require('./historicalScanner');
const { buildSignalFamilyDebug, classifySignalFamily } = require('./signalFamilyClassifier');
const {
  signalFamilyDebugSummarySv,
  signalFamilyLabel,
  signalSubtypeLabel,
} = require('./signalFamilyLabels');
const {
  classifyVolumeState,
  enrichIndicatorsFromCandles,
} = require('./indicatorEnrichment');

const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const CRYPTO_RE    = /USDT$|BUSD$|USD$|BTC$|ETH$/i;

// ── Derived-field helpers ─────────────────────────────────────────────────────

function classifyMarketType(symbol) {
  return CRYPTO_RE.test(symbol || '') ? 'crypto' : 'stocks';
}

function deriveDirection(sig) {
  const s = sig.signal || '';
  if (s.startsWith('LONG') || s === 'WIDE_REVERSAL_WATCH') return 'UP';
  if (s.startsWith('SHORT'))                               return 'DOWN';
  if (sig.marketDirection === 'bullish')                   return 'UP';
  if (sig.marketDirection === 'bearish')                   return 'DOWN';
  return 'UNKNOWN';
}

// Mirrors EXTENSION_*_ATR thresholds in decisionMonitor.js
function approxExtensionLevel(sig) {
  const pz      = Number(sig.priceToZoneAtr) || 0;
  const tfs     = sig.threeFingerSpreadActive === true;
  const breakout = sig.breakoutAlreadyOccurred === true;
  if (pz >= 12 || (breakout && pz >= 7)) return 'extreme';
  if (pz >= 7  || breakout || (tfs && pz >= 6.5)) return 'medium';
  if (pz >= 1.5 || tfs)                            return 'mild';
  return 'none';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function firstText(value) {
  if (Array.isArray(value)) return value.find(Boolean) ?? null;
  return value ?? null;
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strOrUnknown(value) {
  return value == null || value === '' ? 'unknown' : String(value);
}

function derivePriority(sig) {
  if (sig.priority) return sig.priority;
  if (sig.status) return sig.status;
  const state = sig.state || '';
  const signal = sig.signal || '';
  const score = numOrNull(sig.tradeScore) ?? 0;

  if (state === 'THREE_FINGER_SPREAD_AVOID' || state === 'WIDE_AVOID' || state === 'BREAKOUT_ALREADY_OCCURRED' || signal === 'NO_TRADE') {
    return 'avoid';
  }
  if ((signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') && score >= 70) return 'active';
  if ((signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') && score >= 50) return 'watch';
  if (score >= 30 || signal.includes('WATCH')) return 'watch';
  return 'wait';
}

function deriveNextMoveBias(sig, direction) {
  if (sig.nextMoveBias) return sig.nextMoveBias;
  if (direction === 'UP' || direction === 'DOWN') return direction;
  return 'UNCERTAIN';
}

function deriveVwapDistancePct(sig, entryPrice) {
  if (sig.vwapDistancePct != null) return numOrNull(sig.vwapDistancePct);
  const vwap = numOrNull(sig.vwap);
  const price = numOrNull(entryPrice);
  if (!vwap || !price) return null;
  return round(((price - vwap) / vwap) * 100, 4);
}

function candleOpposesTf2m(tf2m, candleScore2m) {
  const dir = candleScore2m?.scoreDirection || 'unknown';
  return (tf2m === 'bullish' && dir === 'bearish') ||
    (tf2m === 'bearish' && dir === 'bullish');
}

function deriveTimeframeAgreement(sig) {
  return {
    tf2m:  sig.tf2m  ?? sig.tf2mDirection  ?? 'unknown',
    tf5m:  sig.tf5m  ?? sig.tf5mDirection  ?? sig.mtf5m?.direction  ?? 'unknown',
    tf10m: sig.tf10m ?? 'unknown',
    tf15m: sig.tf15m ?? sig.tf15mDirection ?? sig.mtf15m?.direction ?? 'unknown',
    tf30m: sig.tf30m ?? 'unknown',
    tf1h:  sig.tf1h  ?? 'unknown',
  };
}

function deriveAgreementCount(sig, tf) {
  if (sig.agreementCount != null) return numOrNull(sig.agreementCount);
  const dirs = Object.values(tf).filter((v) => v === 'bullish' || v === 'bearish');
  const bull = dirs.filter((v) => v === 'bullish').length;
  const bear = dirs.filter((v) => v === 'bearish').length;
  return Math.max(bull, bear);
}

function deriveDataFreshness(sig) {
  if (sig.dataFreshness) return sig.dataFreshness;
  return 'unknown';
}

function deriveDataAgeSeconds(sig) {
  if (sig.dataAgeSeconds != null) return numOrNull(sig.dataAgeSeconds);
  return null;
}

function deriveMarketPersonality(sig) {
  return sig.marketPersonality ?? sig.personality ?? null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function outcomeFilePath(date) {
  return path.join(OUTCOMES_DIR, `${date}.jsonl`);
}

function appendOutcome(date, row) {
  try {
    ensureDir(OUTCOMES_DIR);
    fs.appendFileSync(outcomeFilePath(date), JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    console.warn('[OutcomeAnalyzer] appendOutcome failed:', err.message);
  }
}

function loadExistingSignalIds(date) {
  const ids = new Set();
  const fp = outcomeFilePath(date);
  if (!fs.existsSync(fp)) return ids;

  try {
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.signalId) ids.add(row.signalId);
      } catch {
        // Ignore bad historical lines; quality analysis already skips them too.
      }
    }
  } catch (err) {
    console.warn(`[OutcomeAnalyzer] duplicate scan failed (${fp}):`, err.message);
  }
  return ids;
}

// ── Candle lookup helpers ─────────────────────────────────────────────────────

/**
 * Load all 2m candles for a symbol around a date range (padded by ±5 days).
 * Returns a map: ts-string → index, plus the candles array.
 */
function loadCandlesWithIndex(symbol, signalDate, candleCache) {
  if (candleCache[symbol]) return candleCache[symbol];

  // Pad ±5 days to ensure we have candles before and after the signal date
  const d = new Date(signalDate + 'T00:00:00Z');
  const start = new Date(d); start.setUTCDate(start.getUTCDate() - 5);
  const end   = new Date(d); end.setUTCDate(end.getUTCDate()   + 5);

  let raw;
  try {
    raw = loadCandles(
      symbol,
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
      '2m'
    );
  } catch { raw = []; }

  const candles = toScannerFormat(raw).filter((c) => !c.incomplete);
  const tsIndex = new Map();
  candles.forEach((c, i) => {
    const key = c.t || c.ts;
    if (key && !tsIndex.has(key)) tsIndex.set(key, i);
  });

  candleCache[symbol] = { candles, tsIndex };
  return candleCache[symbol];
}

// ── Outcome calculation ───────────────────────────────────────────────────────

function calcOutcome(candles, startIdx, horizons) {
  const entry  = candles[startIdx];
  if (!entry) return {};
  const entryPrice = entry.c;
  const result = {};

  for (const n of horizons) {
    const slice  = candles.slice(startIdx + 1, startIdx + 1 + n);
    if (slice.length === 0) continue;

    const closes  = slice.map((c) => c.c);
    const highs   = slice.map((c) => c.h);
    const lows    = slice.map((c) => c.l);
    const lastClose = closes[closes.length - 1];

    const priceChangePct = ((lastClose - entryPrice) / entryPrice) * 100;
    const maxHigh        = Math.max(...highs);
    const minLow         = Math.min(...lows);
    const maxMoveUp      = ((maxHigh - entryPrice) / entryPrice) * 100;
    const maxMoveDown    = ((entryPrice - minLow)  / entryPrice) * 100;

    result[`outcome${n}`] = {
      priceChangePct: round(priceChangePct, 4),
      maxMoveUp:      round(maxMoveUp, 4),
      maxMoveDown:    round(maxMoveDown, 4),
      candlesAvail:   slice.length,
    };
  }

  return result;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Determine whether a signal was successful.
 * Long: price moved up ≥ 1 ATR within 5 candles.
 * Short: price moved down ≥ 1 ATR within 5 candles.
 */
function calcSuccess(signal, entryPrice, atr14, outcome5) {
  if (!outcome5 || !atr14 || atr14 <= 0) {
    return { success: null, failureReason: 'insufficient_data' };
  }

  const isLong  = signal && (signal.includes('LONG')  || signal === 'WIDE_REVERSAL_WATCH');
  const isShort = signal && signal.includes('SHORT');

  if (!isLong && !isShort) {
    return { success: null, failureReason: 'non_directional_signal' };
  }

  const atrPct = (atr14 / entryPrice) * 100;

  if (isLong) {
    if (outcome5.maxMoveUp >= atrPct) return { success: true,  failureReason: null };
    if (outcome5.maxMoveDown >= atrPct * 0.5)
      return { success: false, failureReason: 'stopped_out' };
    return { success: false, failureReason: 'no_follow_through' };
  }

  // isShort
  if (outcome5.maxMoveDown >= atrPct) return { success: true,  failureReason: null };
  if (outcome5.maxMoveUp >= atrPct * 0.5)
    return { success: false, failureReason: 'stopped_out' };
  return { success: false, failureReason: 'no_follow_through' };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Analyze outcomes for signals in a date range.
 *
 * @param {object} opts
 * @param {string[]} opts.symbols
 * @param {string}   opts.start   - "YYYY-MM-DD"
 * @param {string}   opts.end     - "YYYY-MM-DD"
 * @returns {Promise<object>} summary
 */
async function analyzeOutcomes({ symbols, start, end }) {
  const HORIZONS = [3, 5, 10, 20, 30];
  const summary  = { processed: 0, skipped: 0, skippedDuplicates: 0, bySymbol: {} };

  // Load all signals for the date range
  const signals = loadSignals(start, end, null);
  const filtered = symbols && symbols.length > 0
    ? signals.filter((s) => symbols.includes(s.symbol))
    : signals;

  console.log(`[OutcomeAnalyzer] ${filtered.length} signals to analyze (${start} → ${end})`);

  const candleCache = {};
  const existingIdsByDate = {};

  for (const sig of filtered) {
    const { symbol, candleTs, timestamp, signalId, signal, eventType, price, atr14,
      tradeScore, narrowScore } = sig;

    const date       = (candleTs || timestamp || '').slice(0, 10);
    if (!date || !symbol) { summary.skipped++; continue; }

    if (signalId) {
      if (!existingIdsByDate[date]) existingIdsByDate[date] = loadExistingSignalIds(date);
      if (existingIdsByDate[date].has(signalId)) {
        summary.skippedDuplicates++;
        continue;
      }
    }

    const { candles, tsIndex } = loadCandlesWithIndex(symbol, date, candleCache);

    const searchTs = candleTs || timestamp;
    let startIdx   = tsIndex.get(searchTs);

    // Try to find nearest candle if exact match missing
    if (startIdx === undefined && searchTs) {
      const target = new Date(searchTs).getTime();
      let closest = Infinity;
      candles.forEach((c, i) => {
        const diff = Math.abs(new Date(c.t || c.ts).getTime() - target);
        if (diff < closest) { closest = diff; startIdx = i; }
      });
      if (closest > 5 * 60 * 1000) startIdx = undefined; // >5 min gap — skip
    }

    if (startIdx === undefined) { summary.skipped++; continue; }

    const entryPrice = price || candles[startIdx]?.c;
    if (!entryPrice) { summary.skipped++; continue; }

    const indicatorWindow = candles.slice(Math.max(0, startIdx - 260), startIdx + 1);
    const indicatorFields = enrichIndicatorsFromCandles({ ...sig, price: entryPrice }, indicatorWindow);
    const enrichedSig = { ...sig, ...indicatorFields };
    const outcomes  = calcOutcome(candles, startIdx, HORIZONS);
    const { success, failureReason } = calcSuccess(signal, entryPrice, enrichedSig.atr14 ?? atr14, outcomes.outcome5);

    const marketType     = enrichedSig.marketType || classifyMarketType(symbol);
    const direction      = deriveDirection(sig);
    const priority       = derivePriority(enrichedSig);
    const status         = enrichedSig.status ?? priority;
    const score          = enrichedSig.score ?? enrichedSig.tradeScore ?? enrichedSig.daytradeScore ?? null;
    const confidenceScore = enrichedSig.confidenceScore ?? enrichedSig.confidence?.confidenceScore ?? null;
    const nextMoveBias   = deriveNextMoveBias(enrichedSig, direction);
    const extensionLevel = approxExtensionLevel(enrichedSig);
    const volumeState   = enrichedSig.volumeState || classifyVolumeState(enrichedSig.rvol ?? enrichedSig.relVol20);
    const timeframeAgreement = deriveTimeframeAgreement(enrichedSig);
    const agreementCount = deriveAgreementCount(enrichedSig, timeframeAgreement);
    const hardBlockers = asArray(enrichedSig.hardBlockers);
    const softBlockers = asArray(enrichedSig.softBlockers);
    const blockers = asArray(enrichedSig.blockers).length ? asArray(enrichedSig.blockers) : [...hardBlockers, ...softBlockers];
    const primaryReason = enrichedSig.primaryReason ?? firstText(enrichedSig.reasonSv);
    const decisionTextSv = enrichedSig.decisionTextSv ?? null;
    const dataFreshness = deriveDataFreshness(enrichedSig);
    const dataAgeSeconds = deriveDataAgeSeconds(enrichedSig);
    const vwapDistancePct = deriveVwapDistancePct(enrichedSig, entryPrice);
    const candleScore2m = enrichedSig.candleScore2m ?? null;
    const twoMinuteConflict = enrichedSig.twoMinuteConflict ?? candleOpposesTf2m(timeframeAgreement.tf2m, candleScore2m);
    const familyInput = {
      ...enrichedSig,
      marketType,
      price: entryPrice,
      priceAtSignal: entryPrice,
      direction,
      nextMoveBias,
      extensionLevel,
      volumeState,
      timeframeAgreement,
      agreementCount,
      hardBlockers,
      softBlockers,
      dataFreshness,
      dataAgeSeconds,
      vwapDistancePct,
      candleScore2m,
      twoMinuteConflict,
      rvol: enrichedSig.rvol ?? enrichedSig.relVol20,
    };
    const familyClassification = classifySignalFamily(familyInput);
    const familyDebug = buildSignalFamilyDebug(familyInput);
    const signalFamily = familyClassification.signalFamily;
    const signalSubtype = enrichedSig.signalSubtype ?? familyClassification.signalSubtype ?? enrichedSig.eventType ?? 'UNKNOWN';

    const record = {
      // ── Identity ──────────────────────────────────────────────────────────
      signalId,
      timestamp:        searchTs,
      symbol,
      marketType,

      // ── Signal classification ─────────────────────────────────────────────
      signal,
      eventType,
      state:            sig.state            ?? null,
      narrowType:       sig.narrowType       ?? null,
      narrowState:      sig.narrowState ?? sig.state ?? null,
      status,
      priority,
      signalFamily,
      signalSubtype,
      familyLabelSv: signalFamilyLabel(signalFamily),
      subtypeLabelSv: signalSubtypeLabel(signalSubtype),
      signalFamilyReasonSv: familyClassification.reasonSv,
      familyDebugSummarySv: signalFamilyDebugSummarySv(familyDebug, signalFamily),
      direction,
      nextMoveBias,
      primaryReason,
      decisionTextSv,

      // ── Score ─────────────────────────────────────────────────────────────
      score,
      tradeScore,
      narrowScore,
      confidenceScore,
      marketScore:      enrichedSig.marketScore      ?? null,

      // ── Market context ────────────────────────────────────────────────────
      marketRegime:     enrichedSig.marketRegime     ?? null,
      marketDirection:  enrichedSig.marketDirection  ?? null,
      choppyState:      enrichedSig.choppyState ?? (enrichedSig.marketRegime === 'CHOPPY'),
      marketPersonality: deriveMarketPersonality(enrichedSig),

      // ── Price / zone ──────────────────────────────────────────────────────
      entryPrice,
      priceAtSignal:    entryPrice,
      atr14:            enrichedSig.atr14            ?? null,
      priceToZoneAtr:   enrichedSig.priceToZoneAtr   ?? null,
      smaGapAtr:        enrichedSig.smaGapAtr        ?? null,
      slope20Atr:       enrichedSig.slope20Atr       ?? null,
      rsi14:            enrichedSig.rsi14            ?? null,
      rsi:              enrichedSig.rsi ?? enrichedSig.rsi14 ?? null,
      ema9:             enrichedSig.ema9             ?? null,
      ema21:            enrichedSig.ema21            ?? null,
      ema50:            enrichedSig.ema50            ?? null,
      sma20:            enrichedSig.sma20            ?? null,
      sma50:            enrichedSig.sma50            ?? null,
      sma200:           enrichedSig.sma200           ?? null,
      vwap:             enrichedSig.vwap             ?? null,
      vwapDistancePct,
      rangeCompression: enrichedSig.rangeCompression ?? null,

      // ── Extension / structure ─────────────────────────────────────────────
      extensionLevel,
      fakeoutRiskLevel: enrichedSig.fakeoutRiskLevel ?? null,
      threeFingerSpreadActive:   enrichedSig.threeFingerSpreadActive   ?? false,
      threeFingerSpreadStrength: enrichedSig.threeFingerSpreadStrength ?? null,
      breakoutAlreadyOccurred:   enrichedSig.breakoutAlreadyOccurred   ?? false,

      // ── Data freshness ────────────────────────────────────────────────────
      dataFreshness,
      dataAgeSeconds,

      // ── Volume ────────────────────────────────────────────────────────────
      rvol:        enrichedSig.rvol ?? enrichedSig.relVol20 ?? null,
      volumeState,

      // ── 2m / timeframe context ────────────────────────────────────────────
      candleScore2m,
      twoMinuteConflict,
      tf2m:              timeframeAgreement.tf2m,
      tf5m:              timeframeAgreement.tf5m,
      tf10m:             timeframeAgreement.tf10m,
      tf15m:             timeframeAgreement.tf15m,
      tf30m:             timeframeAgreement.tf30m,
      tf1h:              timeframeAgreement.tf1h,
      timeframeAgreement,
      agreementCount,

      // ── Blockers ──────────────────────────────────────────────────────────
      hardBlockers,
      softBlockers,
      blockers,

      // ── Outcomes ──────────────────────────────────────────────────────────
      ...outcomes,
      success,
      failureReason,
    };

    appendOutcome(date, record);
    if (signalId && existingIdsByDate[date]) existingIdsByDate[date].add(signalId);
    summary.processed++;
    summary.bySymbol[symbol] = (summary.bySymbol[symbol] || 0) + 1;
  }

  console.log(`[OutcomeAnalyzer] Done — processed: ${summary.processed}, skipped: ${summary.skipped}, skippedDuplicates: ${summary.skippedDuplicates}`);
  return summary;
}

/**
 * Load saved outcome records for a date range.
 */
function loadOutcomes(start, end, symbolFilter) {
  const dates    = getDatesInRange(start, end);
  const outcomes = [];

  for (const date of dates) {
    const fp = outcomeFilePath(date);
    if (!fs.existsSync(fp)) continue;
    try {
      fs.readFileSync(fp, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => {
          try {
            const o = JSON.parse(l);
            if (!symbolFilter || o.symbol === symbolFilter) outcomes.push(o);
          } catch { /* skip */ }
        });
    } catch (err) {
      console.warn(`[OutcomeAnalyzer] loadOutcomes read error (${fp}):`, err.message);
    }
  }

  return outcomes;
}

module.exports = { analyzeOutcomes, loadOutcomes };
