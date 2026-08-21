'use strict';

// ── Market Intelligence ──────────────────────────────────────────────────────
//
// Market DNA beskriver vad marknaden VAR. Market Intelligence svarar på vad det
// betyder för strategierna:
//
//   · Vilka marknadsförhållanden finns över huvud taget i vår data?
//   · Vilka har den här strategin faktiskt handlat i?
//   · Vilka har den ALDRIG sett?
//   · Hur gick det, per regim?
//
// Den fjärde frågan är den vanliga. Den tredje är den viktiga.
//
// ── Blinda fläckar är inte samma sak som dåliga resultat ────────────────────
//
// En strategi med 70 % träff som bara prövats i lugna nedgångar är inte en
// 70 %-strategi. Den är obeprövad, och skillnaden syns bara om man vet vilka
// regimer som fanns tillgängliga men aldrig testades. Utan katalogen över
// tillgängliga regimer går den frågan inte att ställa — man kan bara räkna vad
// som testades, aldrig vad som saknas.
//
// Det är också därför katalogen byggs ur DATALAGRET och inte ur körningarna:
// frågan "vilka regimer finns" får inte besvaras av "vilka regimer vi råkade
// köra".
//
// ── Ingen AI ────────────────────────────────────────────────────────────────
//
// Modulen rekommenderar ingenting, optimerar ingenting och rangordnar inga
// strategier. Den räknar och redovisar. Vad man GÖR med en blind fläck är ett
// beslut, och det beslutet fattas inte här.
//
// Läser marknadsdatalagret och biblioteket. Skriver ingenting.

const marketDna = require('./marketDnaService');
const coverage = require('../../data/marketDataCoverage');
const store = require('../../data/marketDataStore');
const historicalFeed = require('../historicalPriceFeedService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'market_intelligence',
});

const VERSION = 'market-intelligence-v1';
const DEFAULT_ROOTS = Object.freeze(['MNQ', 'MES']);
const DEFAULT_MIN_BARS = 600;

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Katalog över marknadsförhållanden som FINNS i datalagret.
 *
 * En rad per (rot, handelsdag). Dagar utan tillräckligt underlag hoppas över
 * och räknas — en halv dag är inte en marknadsregim.
 */
// ── Cache på lagrets avtryck ─────────────────────────────────────────────────
//
// Katalogen läser en bar-serie per (rot, handelsdag) och beräknar Market DNA
// för var och en. Det är ~440 diskläsningar och 12,7 sekunder synkron CPU, och
// den byggdes om vid VARJE anrop — inklusive fyra gånger per laddning av
// fabrikssidan, via Strategy Brain. Det var den djupaste orsaken till att
// event-loopen stod stilla.
//
// Svaret beror bara på (a) argumenten och (b) barfilerna. Barfilerna skrivs
// bara till, så deras avtryck (storlek + mtime) avgör exakt när katalogen kan
// ha ändrats. Cachen kan därför aldrig servera ett svar som inte längre
// stämmer — till skillnad från en TTL.
const catalogCache = new Map();
const intelligenceCache = new Map();
const CACHE_LIMIT = 8;

function remember(cache, key, build) {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = build();
  cache.set(key, value);
  // Håll cachen liten: nycklarna innehåller ett filavtryck och blir därför
  // aldrig återanvända efter att lagret ändrats.
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** Töm cacherna. För tester och för den som vet att lagret bytts ut under fötterna. */
function clearCaches() {
  catalogCache.clear();
  intelligenceCache.clear();
  dayCache.clear();
}

function buildMarketDnaCatalog({
  roots = DEFAULT_ROOTS,
  feed = null,
  minBars = DEFAULT_MIN_BARS,
  timeframe = '2m',
  limit = 250,
  atUtcTime = '20:00',
} = {}) {
  // En inskickad feed kan läsa vad som helst — då äger anroparen svaret och vi
  // cachar inte. Standardvägen läser lagret och är cachebar.
  if (feed) return computeMarketDnaCatalog({ roots, feed, minBars, timeframe, limit, atUtcTime });
  const key = [
    'catalog', roots.join(','), minBars, timeframe, limit, atUtcTime,
    store.fingerprint([...roots]),
  ].join('|');
  return remember(catalogCache, key, () => computeMarketDnaCatalog({
    roots, feed, minBars, timeframe, limit, atUtcTime,
  }));
}

// Ett dygns resultat, nycklat på dygnets egna filavtryck. Ett stängt dygn
// räknas därför en gång i processens liv, och dagens pågående dygn räknas om
// bara när det faktiskt fått nya barer.
const dayCache = new Map();
const DAY_CACHE_LIMIT = 2000;

function computeMarketDnaCatalog({ roots, feed, minBars, timeframe, limit, atUtcTime }) {
  const priceFeed = feed || historicalFeed.createHistoricalPriceFeedService();
  const cacheable = !feed;
  const periods = [];
  const skipped = [];

  for (const root of roots) {
    const dayFingerprints = cacheable ? store.fingerprintByDate(root) : null;
    for (const date of coverage.listDates(root).sort()) {
      const cacheKey = cacheable
        ? `${root}|${date}|${minBars}|${timeframe}|${limit}|${atUtcTime}|${dayFingerprints.get(date) || 'none'}`
        : null;
      const cached = cacheKey ? dayCache.get(cacheKey) : null;
      if (cached) {
        if (cached.skipped) skipped.push(cached.skipped);
        else periods.push(cached.dna);
        continue;
      }

      const outcome = computeDay({ root, date, priceFeed, minBars, timeframe, limit, atUtcTime });
      if (cacheKey) {
        dayCache.set(cacheKey, outcome);
        while (dayCache.size > DAY_CACHE_LIMIT) dayCache.delete(dayCache.keys().next().value);
      }
      if (outcome.skipped) skipped.push(outcome.skipped);
      else periods.push(outcome.dna);
    }
  }

  return {
    ok: true,
    roots: [...roots],
    periods,
    skipped,
    summary: marketDna.summarizeDnaSet(periods),
    version: VERSION,
    ...SAFETY,
  };
}

/** Ett (rot, dygn): antingen ett Market DNA eller ett redovisat överhopp. */
function computeDay({ root, date, priceFeed, minBars, timeframe, limit, atUtcTime }) {
  const day = coverage.coverageFor(root, date);
  if (day.bars < minBars) {
    return { skipped: { root, date, bars: day.bars, reason: 'insufficient_bars' } };
  }
  // Klockan sätts alltid explicit — feeden lämnar aldrig ut framtiden, så
  // fönstret är det strategin hade kunnat se vid den tidpunkten.
  const now = new Date(`${date}T${atUtcTime}:00.000Z`);
  const window = priceFeed.getCandles(root, { now, timeframe, limit });
  const dna = marketDna.computeMarketDna(window.candles || [], {
    symbol: root, from: date, to: date,
  });
  if (!dna.dnaHash) {
    return { skipped: { root, date, bars: day.bars, reason: dna.reason || 'no_dna' } };
  }
  return { dna };
}

// Regimerna en körning täckte. En körning över två symboler kan spänna över
// två regimer, och då är det båda som setts — inte en påhittad tredje.
//
// Äldre rader i loggen bär en SAMMANSATT nyckel ("down/normal+down/quiet") från
// innan mängden lagrades som mängd. De raderna kan inte skrivas om — loggen är
// append-only, och det är hela poängen med den. Läsaren delar dem i stället upp
// igen, så att gammal historik tolkas rätt utan att någon rad ändras.
function regimeKeysOf(run) {
  const raw = (Array.isArray(run.marketRegimeKeys) && run.marketRegimeKeys.length)
    ? run.marketRegimeKeys
    : (run.marketRegimeKey ? [run.marketRegimeKey] : []);
  return [...new Set(raw.flatMap((key) => String(key).split('+')).filter(Boolean))];
}

// Regimer och profiler en strategi faktiskt har handlat i, ur biblioteket.
function testedProfilesFor(record) {
  const runs = (record?.replayHistory || []).filter((row) => (Number(row.trades) || 0) > 0);
  return {
    runs,
    // Unionen: allt strategin har mött.
    regimeKeys: [...new Set(runs.flatMap(regimeKeysOf))],
    dnaHashes: [...new Set(runs.map((row) => row.marketDnaHash).filter(Boolean))],
  };
}

/**
 * Resultat per regim.
 *
 * Endast körningar med EN entydig regim får bidra. En körning som spände över
 * två regimer säger inget om någon av dem — resultatet går inte att fördela, och
 * att dela det på måfå vore att uppfinna evidens. Sådana körningar räknas för
 * sig och redovisas som mixedRegimeRuns.
 *
 * Räknas på strategyPnl. Exekveringens bidrag hör hemma i Execution Score och
 * skulle här bara göra regimjämförelsen brusig.
 */
function performanceByRegime(runs) {
  const groups = new Map();
  let mixedRuns = 0;
  let mixedTrades = 0;
  let untaggedRuns = 0;

  for (const run of runs) {
    const keys = regimeKeysOf(run);
    if (keys.length === 0) { untaggedRuns += 1; continue; }
    if (keys.length > 1) {
      mixedRuns += 1;
      mixedTrades += Number(run.trades) || 0;
      continue;
    }
    const key = keys[0];
    if (!groups.has(key)) groups.set(key, { regimeKey: key, runs: 0, trades: 0, strategyPnlUsd: 0, winRateSum: 0 });
    const entry = groups.get(key);
    entry.runs += 1;
    entry.trades += Number(run.trades) || 0;
    entry.strategyPnlUsd += Number(run.strategyPnlUsd) || 0;
    entry.winRateSum += (Number(run.winRate) || 0) * (Number(run.trades) || 0);
  }

  const rows = [...groups.values()]
    .map((entry) => ({
      regimeKey: entry.regimeKey,
      runs: entry.runs,
      trades: entry.trades,
      strategyPnlUsd: round(entry.strategyPnlUsd),
      winRate: entry.trades > 0 ? round(entry.winRateSum / entry.trades) : null,
      // Ett resultat på för få affärer är ingen slutsats om regimen.
      conclusive: entry.trades >= 20,
    }))
    .sort((a, b) => b.trades - a.trades);

  return { rows, mixedRuns, mixedTrades, untaggedRuns };
}

/**
 * Kopplar ihop katalogen med biblioteket.
 *
 * @param {object} library  strategyLibraryService-instans
 * @param {object} catalog  från buildMarketDnaCatalog
 */
function buildMarketIntelligence({ library, catalog } = {}) {
  // Svaret beror på katalogen och på bibliotekets logg. Bägge har billiga,
  // exakta avtryck; en inskickad katalog eller ett bibliotek utan avtryck
  // räknas om varje gång i stället för att gissas på.
  const libraryFingerprint = libraryFingerprintOf(library);
  if (catalog || !libraryFingerprint) return computeMarketIntelligence({ library, catalog });
  const key = ['intel', libraryFingerprint, store.fingerprint([...DEFAULT_ROOTS])].join('|');
  return remember(intelligenceCache, key, () => computeMarketIntelligence({ library, catalog }));
}

/** Bibliotekets loggversion, eller null när den inte går att avgöra billigt. */
function libraryFingerprintOf(library) {
  try {
    const status = typeof library?.getStatus === 'function' ? library.getStatus() : null;
    const events = status?.events;
    return Number.isFinite(events) ? `events:${events}` : null;
  } catch (_) {
    return null;
  }
}

function computeMarketIntelligence({ library, catalog } = {}) {
  const dnaCatalog = catalog || buildMarketDnaCatalog();
  const availableRegimes = Object.keys(dnaCatalog.summary.regimeCounts || {});
  const availableProfiles = (dnaCatalog.summary.profiles || []).map((row) => row.dnaHash);
  const profileByHash = new Map((dnaCatalog.summary.profiles || []).map((row) => [row.dnaHash, row]));

  const strategies = library.listStrategies().map((record) => {
    const tested = testedProfilesFor(record);
    const untestedRegimes = availableRegimes.filter((key) => !tested.regimeKeys.includes(key));
    const untestedProfiles = availableProfiles.filter((hash) => !tested.dnaHashes.includes(hash));
    const perf = performanceByRegime(tested.runs);
    // Bara regimer som FINNS i katalogen räknas som täckning. En körning kan i
    // princip bära en regimnyckel som lagret inte längre har data för, och den
    // ska inte höja täckningsgraden.
    const coveredRegimes = tested.regimeKeys.filter((key) => availableRegimes.includes(key));

    return {
      strategyId: record.strategyId,
      lifecycle: record.lifecycle,
      confidenceScore: record.confidenceScore,
      currentMarketDnaHash: record.currentMarketDnaHash,

      regimesTested: coveredRegimes.sort(),
      regimesAvailable: availableRegimes.length,
      // Andelen av de tillgängliga förhållandena strategin faktiskt mött.
      regimeCoveragePct: availableRegimes.length
        ? round((coveredRegimes.length / availableRegimes.length) * 100)
        : null,
      // DE BLINDA FLÄCKARNA. Regimer som finns i datan men aldrig prövats.
      blindSpots: untestedRegimes.sort(),
      untestedProfiles: untestedProfiles.length,

      profilesTested: tested.dnaHashes.length,
      profilesAvailable: availableProfiles.length,
      performanceByRegime: perf.rows,
      // Körningar vars resultat inte går att tillskriva en enskild regim.
      // Räknas, används aldrig som evidens för någon av dem.
      mixedRegimeRuns: perf.mixedRuns,
      mixedRegimeTrades: perf.mixedTrades,
      untaggedRuns: perf.untaggedRuns,
      // Regimer där strategin faktiskt HAR ett underlag att uttala sig om.
      conclusiveRegimes: perf.rows.filter((row) => row.conclusive).map((row) => row.regimeKey),
    };
  });

  return {
    ok: true,
    market: {
      periods: dnaCatalog.summary.periods,
      distinctRegimes: dnaCatalog.summary.distinctRegimes,
      distinctProfiles: dnaCatalog.summary.distinctProfiles,
      regimeCounts: dnaCatalog.summary.regimeCounts,
      // Regimer INGEN strategi har prövats i. Systemets gemensamma blinda fläck,
      // och därmed nästa replay-period värd att köra.
      untestedByAnyone: availableRegimes.filter(
        (key) => !strategies.some((row) => row.regimesTested.includes(key)),
      ).sort(),
      skippedDays: dnaCatalog.skipped.length,
    },
    strategies,
    profiles: [...profileByHash.values()],
    version: VERSION,
    ...SAFETY,
  };
}

/**
 * Vilka lagrade perioder liknar en given DNA-profil mest?
 *
 * Svarar på "har vi någonsin sett något liknande?" — grunden för att kunna
 * välja en meningsfull replay-period i stället för den senaste.
 */
function findSimilarPeriods(target, catalog, { limit = 5, minSimilarity = 0.5 } = {}) {
  if (!target?.traits) return [];
  return (catalog.periods || [])
    .map((period) => ({ period, similarity: marketDna.dnaSimilarity(target, period) }))
    .filter((row) => row.similarity != null && row.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map((row) => ({
      symbol: row.period.symbol,
      from: row.period.from,
      to: row.period.to,
      dnaHash: row.period.dnaHash,
      regimeKey: row.period.regimeKey,
      classification: row.period.classification,
      similarity: row.similarity,
    }));
}

module.exports = {
  SAFETY,
  VERSION,
  DEFAULT_ROOTS,
  buildMarketDnaCatalog,
  buildMarketIntelligence,
  clearCaches,
  findSimilarPeriods,
  _internal: { testedProfilesFor, performanceByRegime },
};
