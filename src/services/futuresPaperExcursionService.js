'use strict';

// Futures Paper Excursion — ADDITIV instrumentering av MFE/MAE per position.
// Ren logik (ingen I/O), fullt testbar. Ändrar ALDRIG entry/stop/target/exit.
// Mäter prisbanan för en öppen position utifrån samma prisflöde som positionen
// redan uppdateras mot (markOpenPositionsToMarket). Priset i points är
// courtage-agnostiskt; SEK-måtten dokumenteras som GROSS (utan avgifter).
//
// Provenance:
//   mfeMaeSource      = 'runtime_price_updates' (observerade tick, ingen backfill)
//   priceFeedSource   = positionens dataSource (simulated_fallback | real ...)
//   measurementQuality= 'simulated' vid fallback-pris, annars 'real'
//
// Exit-typer (inga trailing/profit-lock ännu — experimentet är inte aktiverat):
const EXIT_TYPE = Object.freeze({
  INITIAL_STOP_LOSS: 'initial_stop_loss',
  TAKE_PROFIT: 'take_profit',
  MAX_HOLDING_TIME: 'max_holding_time',
  SYSTEM_CLOSE: 'system_close',
  UNKNOWN_LEGACY: 'unknown_legacy',
});

// Strikt numerisk normalisering: saknat värde (null/undefined/'') blir ALDRIG 0.
// Endast verkliga finita nummer (inkl. talet 0 och strängen "0") passerar.
// Exporteras så ledgerns läsvy kan använda samma strikta regel för excursion-
// fält i stället för en generell helper som gör Number(null) === 0.
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// En position räknas som instrumenterad först när initExcursion körts vid open
// (mfeMaeSource satt). Legacy-positioner (öppnade före instrumenteringen) saknar
// det och ska ALDRIG få high/low/MFE/MAE beräknade — annars coercas saknade fält
// till 0 och falsk excursion uppstår.
function isInstrumented(tracking) {
  return !!(tracking && tracking.mfeMaeSource != null);
}

// De enda fält excursion-instrumenteringen äger. Funktionerna returnerar bara
// dessa så att ledgerns Object.assign aldrig skriver över position-fält (status m.m.).
const EXCURSION_KEYS = Object.freeze([
  'highestPriceWhileOpen', 'lowestPriceWhileOpen',
  'maximumFavorableExcursionPoints', 'maximumAdverseExcursionPoints',
  'maximumFavorableExcursionSek', 'maximumAdverseExcursionSek',
  'maximumFavorableExcursionR', 'maximumAdverseExcursionR',
  'peakUnrealizedPnlSek', 'gaveBackFromPeakSek',
  'initialStopPrice', 'initialTargetPrice', 'initialRiskPoints', 'initialRiskSek',
  'finalStopPrice', 'exitType',
  'mfeMaeSource', 'priceFeedSource', 'usedFallbackPrice', 'measurementQuality',
]);

function pickExcursion(obj) {
  const out = {};
  for (const key of EXCURSION_KEYS) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeSide(side) {
  const s = String(side || '').trim().toLowerCase();
  return s === 'short' ? 'short' : 'long';
}

// Klassificera exit-typ ur den befintliga exitReason-koden. Trailing/profit-lock
// finns inte ännu, så de värdena används aldrig här.
function classifyExitType(exitReason) {
  const r = String(exitReason || '').trim().toLowerCase();
  if (!r) return EXIT_TYPE.UNKNOWN_LEGACY;
  if (r === 'stop_loss_hit') return EXIT_TYPE.INITIAL_STOP_LOSS;
  if (r === 'take_profit_hit') return EXIT_TYPE.TAKE_PROFIT;
  if (r === 'max_holding_time' || r === 'time_exit' || r === 'time_stop') return EXIT_TYPE.MAX_HOLDING_TIME;
  return EXIT_TYPE.SYSTEM_CLOSE;
}

// Skapar det initiala mät-tillståndet vid öppning. Highest/lowest startar på
// entryPrice; initial risk fryses direkt (initial stop/target ändras aldrig).
function initExcursion({
  entryPrice,
  side,
  stopLoss = null,
  takeProfit = null,
  pointValueUsd = 0,
  contracts = 0,
  fxUsdSek = 0,
  dataSource = 'simulated_fallback',
  usedFallbackPrice = true,
} = {}) {
  const entry = num(entryPrice);
  const dir = normalizeSide(side);
  const stop = num(stopLoss);
  const target = num(takeProfit);
  const pv = num(pointValueUsd) || 0;
  const size = num(contracts) || 0;
  const fx = num(fxUsdSek) || 0;

  const initialRiskPoints = (entry != null && stop != null) ? round(Math.abs(entry - stop), 4) : null;
  const initialRiskSek = initialRiskPoints != null ? round(initialRiskPoints * pv * size * fx, 2) : null;

  return {
    // prisbana
    highestPriceWhileOpen: entry,
    lowestPriceWhileOpen: entry,
    // excursion (uppdateras löpande)
    maximumFavorableExcursionPoints: 0,
    maximumAdverseExcursionPoints: 0,
    maximumFavorableExcursionSek: 0,
    maximumAdverseExcursionSek: 0,
    maximumFavorableExcursionR: initialRiskPoints ? 0 : null,
    maximumAdverseExcursionR: initialRiskPoints ? 0 : null,
    peakUnrealizedPnlSek: 0,
    gaveBackFromPeakSek: null,
    // initial risk/target (frozen)
    initialStopPrice: stop,
    initialTargetPrice: target,
    initialRiskPoints,
    initialRiskSek,
    finalStopPrice: null,
    exitType: null,
    // provenance
    mfeMaeSource: 'runtime_price_updates',
    priceFeedSource: dataSource || 'simulated_fallback',
    usedFallbackPrice: usedFallbackPrice !== false,
    measurementQuality: usedFallbackPrice !== false ? 'simulated' : 'real',
  };
}

// Recompute MFE/MAE ur highest/lowest. Long och short beräknas korrekt:
//   long : favorable = uppåt (highest-entry), adverse = nedåt (entry-lowest)
//   short: favorable = nedåt (entry-lowest),  adverse = uppåt (highest-entry)
function recompute(tracking, { entryPrice, side, pointValueUsd, contracts, fxUsdSek }) {
  const entry = num(entryPrice);
  const dir = normalizeSide(side);
  const pv = num(pointValueUsd) || 0;
  const size = num(contracts) || 0;
  const fx = num(fxUsdSek) || 0;
  const high = num(tracking.highestPriceWhileOpen);
  const low = num(tracking.lowestPriceWhileOpen);
  if (entry == null || high == null || low == null) return tracking;

  const favPoints = dir === 'short'
    ? Math.max(0, entry - low)
    : Math.max(0, high - entry);
  const advPoints = dir === 'short'
    ? Math.max(0, high - entry)
    : Math.max(0, entry - low);

  const toSek = (points) => round(points * pv * size * fx, 2);
  const risk = num(tracking.initialRiskPoints);

  tracking.maximumFavorableExcursionPoints = round(favPoints, 4);
  tracking.maximumAdverseExcursionPoints = round(advPoints, 4);
  tracking.maximumFavorableExcursionSek = toSek(favPoints);
  tracking.maximumAdverseExcursionSek = toSek(advPoints);
  tracking.maximumFavorableExcursionR = risk ? round(favPoints / risk, 4) : null;
  tracking.maximumAdverseExcursionR = risk ? round(advPoints / risk, 4) : null;
  // Peak orealiserad gross-vinst = gynnsam excursion i SEK.
  tracking.peakUnrealizedPnlSek = tracking.maximumFavorableExcursionSek;
  return tracking;
}

// Vik in ett observerat pris. Highest/lowest uppdateras monotont; MFE/MAE räknas
// om. Muterar inte input (returnerar ny kopia).
function applyPriceObservation(tracking, { price, entryPrice, side, pointValueUsd, contracts, fxUsdSek } = {}) {
  // Legacy-guard: uninstrumenterade positioner uppdaterar ingen excursion.
  // Returnerar {} → ledgerns mark-to-market lämnar excursion-fälten orörda
  // (currentPrice/unrealized/konto uppdateras fortfarande av anroparen).
  if (!isInstrumented(tracking)) return {};
  const p = num(price);
  const next = { ...(tracking || {}) };
  if (p == null || p <= 0) return next;
  const high = num(next.highestPriceWhileOpen);
  const low = num(next.lowestPriceWhileOpen);
  next.highestPriceWhileOpen = high == null ? p : Math.max(high, p);
  next.lowestPriceWhileOpen = low == null ? p : Math.min(low, p);
  recompute(next, { entryPrice, side, pointValueUsd, contracts, fxUsdSek });
  return pickExcursion(next);
}

// Frys slutvärden vid close. Viker först in exit-priset (om angivet) så extremen
// fångas, sätter sedan finalStopPrice, gaveBackFromPeak, exitType, quality.
// Inget trailing → finalStopPrice = initialStopPrice.
function finalizeExcursion(tracking, {
  exitPrice = null,
  exitReason = null,
  grossPnlSek = 0,
  entryPrice = null,
  side = 'long',
  pointValueUsd = 0,
  contracts = 0,
  fxUsdSek = 0,
} = {}) {
  // Legacy-guard: uninstrumenterade positioner får inga excursion-slutvärden.
  // exitType lämnas åt läsvyn (unknown_legacy); PnL/exit-pris är oberört.
  if (!isInstrumented(tracking)) return {};
  let next = { ...(tracking || {}) };
  const px = num(exitPrice);
  if (px != null && px > 0) {
    next = applyPriceObservation(next, { price: px, entryPrice, side, pointValueUsd, contracts, fxUsdSek });
  }
  const peak = num(next.maximumFavorableExcursionSek) || 0;
  const gross = num(grossPnlSek) || 0;
  next.gaveBackFromPeakSek = peak > 0 ? round(Math.max(0, peak - gross), 2) : 0;
  next.finalStopPrice = num(next.initialStopPrice); // ingen trailing ännu
  next.exitType = classifyExitType(exitReason);
  return pickExcursion(next);
}

module.exports = {
  EXIT_TYPE,
  EXCURSION_KEYS,
  normalizeExcursionNumber: num,
  isInstrumented,
  classifyExitType,
  initExcursion,
  recompute,
  applyPriceObservation,
  finalizeExcursion,
};
