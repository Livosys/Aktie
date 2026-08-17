'use strict';

// ── Market Classification ────────────────────────────────────────────────────
//
// Vilken sorts marknad var det egentligen? Utan svaret säger ett replay-resultat
// mycket mindre än det ser ut att göra: en strategi med 70 % träff i en
// trendande vecka och 30 % i en sidledes är inte "en 50 %-strategi", den är två
// olika saker.
//
// Klassificeringen räknas ur replay-fönstrets EGNA candles. Den befintliga
// marketRegimeService gör något som låter likadant men inte är det: den läser
// globala JSON-filer om aktier och krypto, saknar tidsparameter och skriver
// dessutom status till disk. Den kan alltså inte svara på frågan "hur såg MNQ
// ut mellan 13:00 och 15:00 den 14 augusti" — och en klassificering som inte
// kan tidsättas är oanvändbar i replay.
//
// Indikatorerna själva importeras från scanner/indicators. Inget mått räknas om
// här.
//
// Ren beräkning: ingen IO, ingen klocka.

const { ema, atr, bbWidth } = require('../../scanner/indicators');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const CLASSIFICATION_VERSION = 'market_classification_v1';

const CLASSES = Object.freeze({
  STRONG_TREND_UP: 'strong_trend_up',
  STRONG_TREND_DOWN: 'strong_trend_down',
  TREND_UP: 'trend_up',
  TREND_DOWN: 'trend_down',
  RANGE: 'range',
  VOLATILE_CHOP: 'volatile_chop',
  UNKNOWN: 'unknown',
});

const LABELS_SV = Object.freeze({
  strong_trend_up: 'Stark uppgång',
  strong_trend_down: 'Stark nedgång',
  trend_up: 'Uppgång',
  trend_down: 'Nedgång',
  range: 'Sidledes',
  volatile_chop: 'Volatil och riktningslös',
  unknown: 'Okänd',
});

const MIN_CANDLES = 30;

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// scanner/indicators.atr läser h/l/c. Fönstrets candles heter high/low/close.
function toIndicatorCandles(candles) {
  return candles.map((row) => ({
    h: Number(row.high ?? row.h),
    l: Number(row.low ?? row.l),
    c: Number(row.close ?? row.c),
    o: Number(row.open ?? row.o),
  })).filter((row) => Number.isFinite(row.h) && Number.isFinite(row.l) && Number.isFinite(row.c));
}

/**
 * Klassificerar ett candle-fönster.
 *
 * @param {object[]} candles  stängda candles i tidsordning
 */
function classifyCandles(candles = [], { symbol = null } = {}) {
  const rows = toIndicatorCandles(candles);
  if (rows.length < MIN_CANDLES) {
    return {
      symbol,
      classification: CLASSES.UNKNOWN,
      label: LABELS_SV.unknown,
      reason: 'too_few_candles',
      candles: rows.length,
      metrics: null,
      version: CLASSIFICATION_VERSION,
      ...SAFETY,
    };
  }

  const closes = rows.map((row) => row.c);
  const first = closes[0];
  const last = closes[closes.length - 1];

  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const atrValue = atr(rows, 14);
  const bbw = bbWidth(closes, 20);

  // Nettorörelse mätt i ATR: hur långt marknaden faktiskt tog sig, i enheter
  // av sitt eget brus. Ett procenttal ensamt går inte att jämföra mellan MNQ
  // och MES, eller mellan en lugn och en stökig dag.
  const netMove = last - first;
  const netMoveAtr = atrValue > 0 ? netMove / atrValue : null;

  // Vandrad sträcka jämfört med nettorörelsen. Nära 1 = rak trend, stort tal =
  // mycket rörelse som inte ledde någonstans.
  const path = rows.reduce((total, row, i) => (
    i === 0 ? 0 : total + Math.abs(row.c - rows[i - 1].c)
  ), 0);
  const efficiency = path > 0 ? Math.abs(netMove) / path : null;

  const atrPct = last > 0 && atrValue != null ? (atrValue / last) * 100 : null;
  const emaSpreadAtr = (emaFast != null && emaSlow != null && atrValue > 0)
    ? (emaFast - emaSlow) / atrValue
    : null;

  const metrics = {
    candles: rows.length,
    firstClose: round(first, 4),
    lastClose: round(last, 4),
    netMove: round(netMove, 4),
    netMoveAtr: round(netMoveAtr, 4),
    efficiency: round(efficiency, 4),
    atr: round(atrValue, 4),
    atrPct: round(atrPct, 4),
    bbWidth: round(bbw, 6),
    emaFast: round(emaFast, 4),
    emaSlow: round(emaSlow, 4),
    emaSpreadAtr: round(emaSpreadAtr, 4),
  };

  const classification = classify({ netMoveAtr, efficiency, emaSpreadAtr });
  return {
    symbol,
    classification,
    label: LABELS_SV[classification],
    reason: null,
    candles: rows.length,
    metrics,
    version: CLASSIFICATION_VERSION,
    ...SAFETY,
  };
}

// Trösklarna är avsiktligt grova. En finare kalibrering hör hemma i Strategy
// Score v2, där den kan mätas mot utfall — att finjustera dem nu vore att gissa
// utan mätning bakom sig.
function classify({ netMoveAtr, efficiency, emaSpreadAtr }) {
  if (netMoveAtr == null || efficiency == null) return CLASSES.UNKNOWN;
  const up = netMoveAtr > 0;
  const magnitude = Math.abs(netMoveAtr);
  const directional = emaSpreadAtr == null || (up ? emaSpreadAtr > 0 : emaSpreadAtr < 0);

  if (magnitude >= 3 && efficiency >= 0.25 && directional) {
    return up ? CLASSES.STRONG_TREND_UP : CLASSES.STRONG_TREND_DOWN;
  }
  if (magnitude >= 1.5 && efficiency >= 0.15) {
    return up ? CLASSES.TREND_UP : CLASSES.TREND_DOWN;
  }
  // Liten nettorörelse. Skiljer lugn sidledes från stökig sidledes på hur
  // mycket sträcka som gick åt för att komma ingenstans.
  if (efficiency < 0.06) return CLASSES.VOLATILE_CHOP;
  return CLASSES.RANGE;
}

/**
 * Klassificerar flera symboler och sammanfattar. Skiljer sig symbolerna åt
 * rapporteras det i stället för att döljas bakom ett medelvärde.
 */
function classifyRun(candlesBySymbol = {}) {
  const perSymbol = Object.entries(candlesBySymbol)
    .map(([symbol, candles]) => classifyCandles(candles, { symbol }));
  const known = perSymbol.filter((row) => row.classification !== CLASSES.UNKNOWN);
  const distinct = [...new Set(known.map((row) => row.classification))];

  return {
    perSymbol,
    // Enig klassificering, annars null och 'mixed'.
    classification: distinct.length === 1 ? distinct[0] : null,
    label: distinct.length === 1 ? LABELS_SV[distinct[0]] : 'Blandad',
    agreement: distinct.length <= 1,
    distinct,
    version: CLASSIFICATION_VERSION,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  CLASSES,
  LABELS_SV,
  CLASSIFICATION_VERSION,
  MIN_CANDLES,
  classifyCandles,
  classifyRun,
  _internal: { classify, toIndicatorCandles },
};
