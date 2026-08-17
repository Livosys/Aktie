'use strict';

// ── Market DNA ───────────────────────────────────────────────────────────────
//
// Ett fingeravtryck av vad marknaden VAR under en period.
//
// Biblioteket lagrade tidigare ett "market DNA" som bara var en hash av
// klassificeringsetiketterna ("range", "trend_up"). Det var för trubbigt för
// att bära sitt namn: två helt olika dagar som båda råkade vara sidledes fick
// samma hash, och frågan "har den här strategin prövats i något liknande?" gick
// därför inte att ställa.
//
// ── Kornigheten är hela problemet ───────────────────────────────────────────
//
// En hash av råa mätvärden vore värdelös åt andra hållet: varje dag blir unik,
// varje körning ser ut som en ny marknadsregim, och Confidence Score skulle
// maxa på brus. En hash av en enda etikett är för grov, en hash av decimaler är
// för fin.
//
// Lösningen är att kvantisera. Varje egenskap läggs i ett namngivet band, och
// fingeravtrycket är tupeln av band. Två dagar med samma karaktär får samma
// hash även om siffrorna skiljer sig på tredje decimalen; två dagar med olika
// karaktär får olika.
//
// Och därför finns TVÅ nivåer:
//
//   dnaHash     fint fingeravtryck av sju egenskaper. För likhet, matchning
//               och blinda fläckar i Market Intelligence.
//   regimeKey   grov gruppering (riktning × volatilitet). För att RÄKNA
//               regimer, t.ex. i Confidence Score.
//
// Att räkna på det fina avtrycket vore att låta upplösningen bestämma svaret:
// åtta dagar skulle ge åtta "regimer" och varje strategi se välprövad ut efter
// en vecka. Att matcha på det grova vore att kalla allt sidledes för samma sak.
//
// Underlaget är samma candles som Native Engine ser, via samma
// marketClassificationService. Ingen egen indikatorberäkning, ingen andra
// datamodell.
//
// Ren beräkning: ingen IO, ingen klocka, ingen slump.

const crypto = require('crypto');
const classification = require('../replay/marketClassificationService');
const { atr, bbWidth } = require('../../scanner/indicators');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DNA_VERSION = 'market_dna_v1';
const MIN_CANDLES = 30;

// ── banden ───────────────────────────────────────────────────────────────────
//
// Trösklarna är grova med flit. En finare kalibrering kräver utfall att mäta
// emot, och Market DNA ska beskriva marknaden — inte gissa vad som fungerar i
// den. Varje band är namngivet så att ett fingeravtryck går att läsa.

const BANDS = Object.freeze({
  // Nettorörelse i ATR-enheter: hur långt marknaden tog sig i förhållande till
  // sitt eget brus.
  direction: [
    { max: -3, name: 'down_strong' },
    { max: -1.5, name: 'down' },
    { max: 1.5, name: 'flat' },
    { max: 3, name: 'up' },
    { max: Infinity, name: 'up_strong' },
  ],
  // Hur rak vägen var. Nära 1 = trend, nära 0 = mycket rörelse utan riktning.
  efficiency: [
    { max: 0.06, name: 'churning' },
    { max: 0.15, name: 'choppy' },
    { max: 0.3, name: 'mixed' },
    { max: Infinity, name: 'clean' },
  ],
  // ATR i procent av pris. Instrumentneutralt, till skillnad från ATR i punkter.
  volatility: [
    { max: 0.02, name: 'dead' },
    { max: 0.05, name: 'low' },
    { max: 0.1, name: 'normal' },
    { max: 0.2, name: 'elevated' },
    { max: Infinity, name: 'high' },
  ],
  // Bollingerbredden nu mot början av fönstret: drar marknaden ihop sig eller
  // vidgas den?
  rangeExpansion: [
    { max: 0.75, name: 'contracting' },
    { max: 1.3, name: 'stable' },
    { max: Infinity, name: 'expanding' },
  ],
  // Volym i andra halvan mot första. Fångar dagar som dör ut eller vaknar.
  volumeProfile: [
    { max: 0.7, name: 'fading' },
    { max: 1.4, name: 'steady' },
    { max: Infinity, name: 'building' },
  ],
  // Största enskilda barens andel av hela periodens rörelse. Högt värde betyder
  // att allt hände i ett hopp — en helt annan marknad att handla i.
  shockiness: [
    { max: 0.15, name: 'smooth' },
    { max: 0.35, name: 'punctuated' },
    { max: Infinity, name: 'shock_driven' },
  ],
});

function bandFor(kind, value) {
  if (!Number.isFinite(value)) return 'unknown';
  for (const band of BANDS[kind]) {
    if (value <= band.max) return band.name;
  }
  return 'unknown';
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function toRows(candles) {
  return candles
    .map((row) => ({
      h: Number(row.high ?? row.h),
      l: Number(row.low ?? row.l),
      c: Number(row.close ?? row.c),
      o: Number(row.open ?? row.o),
      v: Number(row.volume ?? row.v ?? 0),
    }))
    .filter((row) => Number.isFinite(row.h) && Number.isFinite(row.l) && Number.isFinite(row.c));
}

function unknownDna(symbol, reason, candles) {
  return {
    symbol: symbol || null,
    dnaHash: null,
    regimeKey: 'unknown',
    traits: null,
    metrics: null,
    classification: 'unknown',
    candles,
    reason,
    version: DNA_VERSION,
    ...SAFETY,
  };
}

/**
 * Beräknar Market DNA för ett candle-fönster.
 *
 * @param {object[]} candles  stängda candles i tidsordning
 */
function computeMarketDna(candles = [], { symbol = null, from = null, to = null } = {}) {
  const rows = toRows(candles);
  if (rows.length < MIN_CANDLES) return unknownDna(symbol, 'too_few_candles', rows.length);

  // Klassificeringen och dess mått ÅTERANVÄNDS. Att räkna om netMoveAtr här
  // vore att skapa ett andra svar på samma fråga.
  const classified = classification.classifyCandles(candles, { symbol });
  const metrics = classified.metrics || {};

  const closes = rows.map((row) => row.c);
  const atrValue = atr(rows, 14);
  const last = closes[closes.length - 1];

  // Vidgning: bredden nu mot bredden i början av fönstret.
  const half = Math.floor(rows.length / 2);
  const bbwEarly = bbWidth(closes.slice(0, Math.max(20, half)), 20);
  const bbwLate = bbWidth(closes, 20);
  const rangeExpansion = bbwEarly > 0 && Number.isFinite(bbwLate) ? bbwLate / bbwEarly : null;

  // Volymprofil: andra halvan mot första.
  const volEarly = rows.slice(0, half).reduce((total, row) => total + (row.v || 0), 0);
  const volLate = rows.slice(half).reduce((total, row) => total + (row.v || 0), 0);
  const volumeProfile = volEarly > 0 ? volLate / volEarly : null;

  // Chockighet: största barens andel av total vandrad sträcka.
  const moves = rows.map((row, i) => (i === 0 ? 0 : Math.abs(row.c - rows[i - 1].c)));
  const path = moves.reduce((a, b) => a + b, 0);
  const shockiness = path > 0 ? Math.max(...moves) / path : null;

  const atrPct = last > 0 && Number.isFinite(atrValue) ? (atrValue / last) * 100 : null;

  const traits = {
    direction: bandFor('direction', metrics.netMoveAtr),
    efficiency: bandFor('efficiency', metrics.efficiency),
    volatility: bandFor('volatility', atrPct),
    rangeExpansion: bandFor('rangeExpansion', rangeExpansion),
    volumeProfile: bandFor('volumeProfile', volumeProfile),
    shockiness: bandFor('shockiness', shockiness),
    // Klassificeringen från fas 4 är den sjunde egenskapen. Den är härledd ur
    // samma mått men uttrycker helheten, och den gör avtrycket läsbart.
    classification: classified.classification,
  };

  // Ordningen är låst: nycklarna sorteras så att samma egenskaper alltid ger
  // samma hash oavsett i vilken ordning de råkar skrivas.
  const fingerprint = Object.keys(traits).sort()
    .map((key) => `${key}=${traits[key]}`)
    .join('|');

  // Den GROVA nyckeln. Endast riktning och volatilitet — det är den upplösning
  // som gör "hur många regimer har vi sett" till en ärlig fråga.
  const regimeKey = `${coarseDirection(traits.direction)}/${coarseVolatility(traits.volatility)}`;

  return {
    symbol: symbol || null,
    from,
    to,
    dnaHash: sha(`${DNA_VERSION}::${fingerprint}`),
    regimeKey,
    traits,
    fingerprint,
    metrics: {
      ...metrics,
      atrPct: round(atrPct),
      rangeExpansion: round(rangeExpansion),
      volumeProfile: round(volumeProfile),
      shockiness: round(shockiness),
    },
    classification: classified.classification,
    label: classified.label,
    candles: rows.length,
    reason: null,
    version: DNA_VERSION,
    ...SAFETY,
  };
}

function coarseDirection(direction) {
  if (direction === 'up' || direction === 'up_strong') return 'up';
  if (direction === 'down' || direction === 'down_strong') return 'down';
  if (direction === 'flat') return 'flat';
  return 'unknown';
}

function coarseVolatility(volatility) {
  if (volatility === 'dead' || volatility === 'low') return 'quiet';
  if (volatility === 'normal') return 'normal';
  if (volatility === 'elevated' || volatility === 'high') return 'volatile';
  return 'unknown';
}

/**
 * Hur lika två fingeravtryck är, 0–1.
 *
 * Andelen egenskaper som stämmer överens. Enkelt med flit: en viktad modell
 * skulle kräva utfall att kalibrera mot, och den kalibreringen hör hemma i
 * Strategy Score v2 — inte i beskrivningen av marknaden.
 */
function dnaSimilarity(a, b) {
  if (!a?.traits || !b?.traits) return null;
  const keys = Object.keys(a.traits);
  const matches = keys.filter((key) => a.traits[key] === b.traits[key]).length;
  return round(matches / keys.length, 3);
}

/**
 * Slår ihop flera profiler till ETT avtryck.
 *
 * En strategis "current market DNA" är inte en enskild dag utan mängden
 * förhållanden den har levt igenom. Hashen är därför över den sorterade
 * unika mängden — ordningen den prövades i ska inte ändra svaret, och en
 * upprepad profil ska inte heller göra det.
 */
function combineMarketDnaHashes(hashes = []) {
  const unique = [...new Set(hashes.filter(Boolean))].sort();
  return unique.length ? sha(`${DNA_VERSION}::set::${unique.join('|')}`) : null;
}

/** Sammanfattar en samling DNA-avtryck: vilka regimer och profiler som finns. */
function summarizeDnaSet(dnaList = []) {
  const usable = dnaList.filter((row) => row && row.dnaHash);
  const byRegime = new Map();
  const byHash = new Map();
  for (const row of usable) {
    byRegime.set(row.regimeKey, (byRegime.get(row.regimeKey) || 0) + 1);
    if (!byHash.has(row.dnaHash)) byHash.set(row.dnaHash, { dnaHash: row.dnaHash, traits: row.traits, count: 0, periods: [] });
    const entry = byHash.get(row.dnaHash);
    entry.count += 1;
    entry.periods.push({ symbol: row.symbol, from: row.from, to: row.to });
  }
  return {
    periods: usable.length,
    unknown: dnaList.length - usable.length,
    distinctRegimes: byRegime.size,
    distinctProfiles: byHash.size,
    regimeCounts: Object.fromEntries([...byRegime.entries()].sort((a, b) => b[1] - a[1])),
    profiles: [...byHash.values()].sort((a, b) => b.count - a.count),
    version: DNA_VERSION,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  DNA_VERSION,
  BANDS,
  MIN_CANDLES,
  computeMarketDna,
  combineMarketDnaHashes,
  dnaSimilarity,
  summarizeDnaSet,
  _internal: { bandFor, coarseDirection, coarseVolatility, toRows },
};
