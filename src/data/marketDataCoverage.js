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
function coverageFor(root, date, { dataStore = store, source = DEFAULT_SOURCE } = {}) {
  let bars = [];
  try {
    bars = dataStore.loadRawBars(root, date, date, source) || [];
  } catch (_) {
    bars = [];
  }
  const first = bars.length ? barTs(bars[0]) : null;
  const last = bars.length ? barTs(bars[bars.length - 1]) : null;
  return {
    root,
    date,
    bars: bars.length,
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
function findCompleteDay({
  roots = ['MNQ', 'MES'],
  throughUtcTime = '15:00',
  minBars = 600,
  dataStore = store,
  source = DEFAULT_SOURCE,
} = {}) {
  const [hh, mm] = String(throughUtcTime).split(':').map(Number);
  for (const date of listDates(roots[0], { dataStore })) {
    const needMs = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00.000Z`).getTime();
    const rows = roots.map((root) => coverageFor(root, date, { dataStore, source }));
    if (rows.every((row) => row.bars >= minBars && row.lastMs != null && row.lastMs >= needMs)) {
      return date;
    }
  }
  return null;
}

module.exports = {
  SAFETY,
  listDates,
  coverageFor,
  coverageForRange,
  findCompleteDay,
};
