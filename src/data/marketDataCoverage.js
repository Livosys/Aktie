'use strict';

// ── Täckning i marknadsdatalagret ────────────────────────────────────────────
//
// "Finns det data för den här perioden, och räcker den hela vägen?" är en
// fråga som Replay måste kunna svara på INNAN den börjar köra. En replay som
// tyst tar slut mitt i dygnet ser ut som en marknad utan signaler, vilket är
// den farligaste sortens fel: den ser ut som ett resultat.
//
// Frågan fanns tidigare bara som en kopierad hjälpfunktion i tre testfiler,
// och alla tre valde "senaste dygn med fler än 600 barer". Den regeln höll
// fram till att lagret fick dagens PÅGÅENDE dygn — 661 barer som slutar
// 11:00Z. Testerna valde då det dygnet och frågade efter 13:00Z, alltså efter
// datans slut, och fick noll signaler utan att någon sa något.
//
// Täckning mäts därför på sista barens tidsstämpel, inte på antalet barer.
//
// Read-only. Läser lagret, skriver aldrig.

const store = require('./marketDataStore');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_SOURCE = 'ib';

function barTs(bar) {
  return (bar && (bar.ts || bar.t || bar.timestamp)) || null;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** Datum som lagret känner till för en rot, nyast först. */
function listDates(root, { dataStore = store } = {}) {
  const listed = dataStore.listAvailableDates(root) || {};
  const dates = Array.isArray(listed)
    ? listed
    : [...(listed.raw || []), ...(listed['2m'] || [])];
  return [...new Set(dates)].sort().reverse();
}

/** Vad lagret faktiskt har för en rot och ett dygn. */
function coverageFor(root, date, {
  dataStore = store, source = DEFAULT_SOURCE, windowFromUtc = null, windowToUtc = null,
} = {}) {
  let bars = [];
  try {
    bars = dataStore.loadRawBars(root, date, date, source) || [];
  } catch (_) {
    bars = [];
  }
  const first = bars.length ? barTs(bars[0]) : null;
  const last = bars.length ? barTs(bars[bars.length - 1]) : null;
  // Barer INOM ett givet fönster. Räknas här därför att barerna redan är
  // laddade — och frågan "har dygnet data i det fönster jag tänker köra" går
  // inte att besvara med first och last, som bara säger var dygnet börjar och
  // slutar. Se listCompleteDays.
  let barsInWindow = null;
  if (windowFromUtc && windowToUtc) {
    const fromMs = new Date(`${date}T${windowFromUtc}:00.000Z`).getTime();
    const toMs = new Date(`${date}T${windowToUtc}:00.000Z`).getTime();
    barsInWindow = 0;
    for (const bar of bars) {
      const ts = barTs(bar);
      const ms = ts ? new Date(ts).getTime() : NaN;
      if (Number.isFinite(ms) && ms >= fromMs && ms < toMs) barsInWindow += 1;
    }
  }
  return {
    root,
    date,
    bars: bars.length,
    barsInWindow,
    firstTimestamp: first,
    lastTimestamp: last,
    firstMs: first ? new Date(first).getTime() : null,
    lastMs: last ? new Date(last).getTime() : null,
  };
}

/**
 * Täcker lagret hela [from, to) för samtliga rötter?
 *
 * Svaret är avsiktligt detaljerat i stället för ett booleskt värde — en
 * replay-rapport ska kunna visa exakt var datan tog slut.
 */
function coverageForRange({ roots = [], from, to, dataStore = store, source = DEFAULT_SOURCE } = {}) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const dates = [];
  for (let ms = fromMs; ms <= toMs; ms += 24 * 60 * 60 * 1000) dates.push(dateKey(ms));
  if (!dates.includes(dateKey(toMs))) dates.push(dateKey(toMs));

  const perRoot = roots.map((root) => {
    const days = [...new Set(dates)].map((date) => coverageFor(root, date, { dataStore, source }));
    const withBars = days.filter((day) => day.bars > 0);
    const lastMs = withBars.length ? Math.max(...withBars.map((day) => day.lastMs)) : null;
    const firstMs = withBars.length ? Math.min(...withBars.map((day) => day.firstMs)) : null;
    return {
      root,
      bars: withBars.reduce((total, day) => total + day.bars, 0),
      daysWithData: withBars.length,
      firstMs,
      lastMs,
      // Sista tidpunkt som går att utvärdera på riktigt.
      coversStart: firstMs != null && firstMs <= fromMs,
      coversEnd: lastMs != null && lastMs >= toMs,
      days,
    };
  });

  const covered = perRoot.length > 0 && perRoot.every((row) => row.coversEnd && row.bars > 0);
  const effectiveEndMs = perRoot.length && perRoot.every((row) => row.lastMs != null)
    ? Math.min(...perRoot.map((row) => row.lastMs))
    : null;

  return {
    covered,
    requestedFrom: new Date(fromMs).toISOString(),
    requestedTo: new Date(toMs).toISOString(),
    // Slutet som datan faktiskt räcker till. Replay klipper mot detta i
    // stället för att köra tomma tick förbi lagrets kant.
    effectiveTo: effectiveEndMs != null ? new Date(Math.min(effectiveEndMs, toMs)).toISOString() : null,
    roots: perRoot,
    ...SAFETY,
  };
}

/**
 * Senaste dygn där samtliga rötter har data hela vägen fram till `throughUtcTime`.
 *
 * Det pågående dygnet väljs bort automatiskt, eftersom dess sista bar ligger
 * före den efterfrågade sluttiden.
 *
 * @param {string} throughUtcTime  t.ex. '15:00' — måttet på "hela vägen"
 */
/**
 * ALLA dygn lagret täcker hela vägen, nyast först.
 *
 * Fanns tidigare bara som "det nyaste" (findCompleteDay). Det räckte för ett
 * test som behöver ett dygn att köra på, men inte för en fabrik som ska lära
 * sig av sin historik: varje replay-körning valde samma dygn, och de övriga
 * dygnen i lagret prövades aldrig av någon.
 */
function listCompleteDays({
  roots = ['MNQ', 'MES'],
  throughUtcTime = '15:00',
  minBars = 600,
  dataStore = store,
  source = DEFAULT_SOURCE,
  // Kräv att lagret legat STILLA om dygnet i minst så här länge. null = ingen
  // sådan kontroll, vilket är oförändrat beteende för befintliga anropare.
  quietForMs = null,
  now = null,
  // ── Har dygnet data i det fönster anroparen tänker köra? ──────────────────
  //
  // `bars >= minBars` och `lastMs >= throughUtcTime` säger bara att dygnet har
  // MYCKET data och att den sträcker sig långt. Ingetdera säger att det finns
  // något i fönstret.
  //
  // Skillnaden är inte teoretisk. Den kontraktspartitionerade backfillen
  // partitionerar på CME:s handelsdag, som börjar kvällen före: filen märkt D
  // innehåller D 22:00 till D+1 20:59. Ett fönster byggt på KALENDERdatumet D
  // träffar därför ingenting. Mätt 2026-08-20 hade 212 av 222 "kompletta" dygn
  // noll barer mellan 13:00 och 17:00 på sitt eget datum.
  //
  // Fördelningen är binär — ett dygn har antingen 0 eller hela fönstret (240
  // minutbarer) — så den exakta nivån nedan bär ingen vikt. Den finns för att
  // fånga ett genuint stympat dygn, inte för att kalibrera något.
  //
  // null = ingen kontroll, alltså oförändrat beteende för befintliga anropare.
  windowFromUtc = null,
  windowToUtc = null,
  minBarsInWindow = null,
} = {}) {
  const at = (date, clock) => {
    const [h, m] = String(clock).split(':').map(Number);
    return new Date(`${date}T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00.000Z`).getTime();
  };
  const complete = [];
  for (const date of listDates(roots[0], { dataStore })) {
    const needMs = at(date, throughUtcTime);
    const rows = roots.map((root) => coverageFor(root, date, {
      dataStore, source, windowFromUtc, windowToUtc,
    }));
    if (!rows.every((row) => row.bars >= minBars && row.lastMs != null && row.lastMs >= needMs)) continue;
    if (minBarsInWindow != null
      && !rows.every((row) => row.barsInWindow != null && row.barsInWindow >= minBarsInWindow)) continue;
    if (quietForMs != null && !isQuiet(date, { roots, dataStore, source, quietForMs, now })) continue;
    complete.push(date);
  }
  return complete;
}

// ── Komplett är inte samma sak som STÄNGT ────────────────────────────────────
//
// Ett dygn kan ha alla sina barer och ändå ta emot fler. Den löpande
// IB-infångningen underhåller ett rullande fönster och skriver om de senaste
// dygnens filer långt efter att sessionen stängt: mätt 2026-08-20 skrevs fyra
// dygn (2026-08-17 till -20) inom samma sekund, medan alla äldre dygn hade
// legat orörda i drygt femton timmar.
//
// Skillnaden spelar roll för allt som måste läsa SAMMA data två gånger. Ett
// determinismtest som väljer det nyaste kompletta dygnet jämför i praktiken två
// olika filer och rapporterar motorn som icke-deterministisk när det i själva
// verket var lagret som ändrades under körningen.
//
// En timmes tystnad räcker med god marginal: den längsta uppmätta körningen av
// determinismtestet tog sextio sekunder, och gränsen ligger sextio gånger över
// det. Den skiljer också de aktivt infångade dygnen (noll timmar) från alla
// andra utan att kasta bort mer historik än nödvändigt.
const CLOSED_DAY_QUIET_MS = 60 * 60 * 1000;

function isQuiet(date, { roots, dataStore, source, quietForMs, now }) {
  if (typeof dataStore.lastModifiedMs !== 'function') return true;
  const nowMs = now == null ? Date.now() : new Date(now).getTime();
  for (const root of roots) {
    const modified = dataStore.lastModifiedMs(root, date, source);
    // Ett dygn utan fil kan inte vara i rörelse.
    if (modified == null) continue;
    if (nowMs - modified < quietForMs) return false;
  }
  return true;
}

function findCompleteDay(options = {}) {
  return listCompleteDays(options)[0] || null;
}

/**
 * Nyaste kompletta dygn som lagret INTE längre skriver till.
 *
 * Använd den här — inte findCompleteDay — överallt där samma data måste läsas
 * mer än en gång och ge samma svar.
 */
/** Halva fönstret, i minutbarer. Se minBarsInWindow om varför nivån är trubbig. */
function halfWindowBars(fromUtc, toUtc) {
  const minutes = (Number(String(toUtc).split(':')[0]) * 60 + Number(String(toUtc).split(':')[1] || 0))
    - (Number(String(fromUtc).split(':')[0]) * 60 + Number(String(fromUtc).split(':')[1] || 0));
  return Math.max(1, Math.floor(minutes / 2));
}

// ── När är ett dygn SLUT? ────────────────────────────────────────────────────
//
// Tystnad räcker inte. `quietForMs` svarar bara på om lagret slutat skriva, och
// det gör det av två helt olika skäl: antingen är handelsdagen över, eller så
// dog infångningen mitt i den. Efter en timme ser de likadana ut.
//
// Skillnaden är inte teoretisk. 2026-08-20 stannade infångningen 17:33 när en
// annan process tog över porten. En timme senare passerade dygnet tystnads-
// kontrollen, hade 240 barer i RTH-fönstret och valdes som "stängt komplett
// dygn" — trots att halva sessionen saknades. Testet som mätte exekverings-
// kostnad över sextio signaler föll då på att kostnaden blev noll.
//
// Ett stängt dygn är därför ett dygn vars data NÅR FRAM TILL sessionens slut.
// Färdiga dygn i lagret går till 23:59 (rotfiler) eller till 20:59 dagen efter
// (kontraktspartitionerade); ett avhugget dygn gör ingetdera.
//
// 21:00 ligger efter RTH-stängning 20:00 och före rotfilernas 23:59, alltså
// innanför bägge formernas slut men efter allt som räknas som handelsdag.
const CLOSED_DAY_THROUGH_UTC = '21:00';

function laterClock(a, b) {
  const minutes = (clock) => {
    const [h, m] = String(clock).split(':').map(Number);
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  };
  return minutes(a) >= minutes(b) ? a : b;
}

/**
 * Nyaste dygn som är komplett, som lagret slutat skriva till, som faktiskt har
 * data i fönstret anroparen tänker köra, OCH vars session hunnit ta slut.
 *
 * Använd den här — inte findCompleteDay — överallt där samma data måste läsas
 * mer än en gång, och överallt där ett tomt eller halvt fönster skulle bokföras
 * som ett resultat.
 */
function findClosedCompleteDay({
  windowFromUtc = '13:00',
  windowToUtc = '17:00',
  // Anroparens krav: "dygnet måste ha data fram till hit, för det är så långt
  // jag tänker köra". Ett SVAGARE krav än stängningskravet får aldrig sänka
  // det — därför den senare av de två.
  throughUtcTime = CLOSED_DAY_THROUGH_UTC,
  ...options
} = {}) {
  return listCompleteDays({
    quietForMs: CLOSED_DAY_QUIET_MS,
    windowFromUtc,
    windowToUtc,
    minBarsInWindow: halfWindowBars(windowFromUtc, windowToUtc),
    throughUtcTime: laterClock(throughUtcTime, CLOSED_DAY_THROUGH_UTC),
    ...options,
  })[0] || null;
}

module.exports = {
  SAFETY,
  listDates,
  coverageFor,
  coverageForRange,
  listCompleteDays,
  findCompleteDay,
  findClosedCompleteDay,
  halfWindowBars,
  CLOSED_DAY_QUIET_MS,
  CLOSED_DAY_THROUGH_UTC,
};
