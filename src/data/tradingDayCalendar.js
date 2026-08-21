'use strict';

// ── Handelsdagskalender ──────────────────────────────────────────────────────
//
// Vilka handelsdagar historiken innehåller, vilket kontrakt som äger var och en,
// och vilket kalenderfönster de motsvarar. Rena marknadsdatafakta — inget om
// research, inget om strategier, inget om experiment.
//
// Låg tidigare i researchDatasetBoundaryService. Det var rätt när research var
// enda läsaren, men replay-kön behöver samma svar, och en produktionsväg som
// importerar en modul kallad "research" är en lagerinversion som förvirrar mer
// för varje läsare. Frågorna nedan är inte research-frågor: de handlar om vad
// som ligger på disk.
//
// Research äger fortfarande sin egen halva — vad som är research- respektive
// valideringsperiod är ett metodval, inte ett faktum om lagret.
//
// ── Handelsdag ≠ kalenderdatum ───────────────────────────────────────────────
//
// Den kontraktspartitionerade backfillen partitionerar på CME:s handelsdag, och
// en handelsdag börjar kvällen före: filen 2026-01-15.jsonl innehåller barerna
// 2026-01-15T23:00Z → 2026-01-16T21:59Z. RTH-fönstret 13:00–17:00Z i den filen
// ligger alltså på KALENDERDATUMET 2026-01-16.
//
// Mätt över hela lagret 2026-08-20: 218 av 218 filer, undantagslöst +1 dygn,
// 240 minutbarer i fönstret. Inget filnamn sammanfaller med sitt eget
// RTH-datum. Ett fönster byggt på filnamnet pekar därför på fel dag — och på en
// dag vars barer ligger i en annan fil.
//
// Det felet fanns i replay-kön: 212 av 222 "kompletta" dygn hade noll barer
// mellan 13:00 och 17:00 på sitt eget datum, och kön hade bara inte hunnit
// rotera dit.
//
// ── Varför exact_contract ────────────────────────────────────────────────────
//
// Lagret kan läsas på två sätt, och de ger olika svar:
//
//   root_merged      marketDataStore läser rotkatalogen UTÖVER kontrakts-
//                    katalogerna när ingen exakt nyckel angetts. Ger fler dygn
//                    — men gränsen beror på vilka löpande infångningsfiler som
//                    råkar ligga kvar i roten.
//
//   exact_contract   bara den angivna kontraktskatalogen. Samma fråga ger samma
//                    svar imorgon.
//
// Mätt 2026-08-20: 222 dygn vid rotläsning, 218 vid kontraktsläsning. De fyra
// extra saknar kontraktsmotsvarighet helt.
//
// Ren modul: läser lagrets index, skriver ingenting, handlar inte.

const store = require('./marketDataStore');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'trading_day_calendar',
});

const CALENDAR_VERSION = 'trading-day-calendar-v1';

const DATA_ACCESS_MODES = Object.freeze({
  EXACT_CONTRACT: 'exact_contract',
  ROOT_MERGED: 'root_merged',
});

const DEFAULT_ROOTS = Object.freeze(['MNQ', 'MES']);

const RTH_WINDOW = Object.freeze({ fromUtc: '13:00', toUtc: '17:00' });

/** Kontraktets utgång, som den står i nyckeln ROOT:conId:YYYY-MM-DD. */
function expiryOf(contractKey) {
  const parts = String(contractKey).split(':');
  return parts.length >= 3 ? parts[2] : null;
}

/**
 * Kontrakten för en rot, sorterade på utgång (äldst först).
 *
 * @returns {Array<{contractKey, expiry, days: string[]}>}
 */
function listContracts(root, { dataStore = store } = {}) {
  const key = String(root || '').toUpperCase();
  const table = dataStore.listAvailableContractDates(key, 'ib') || {};
  return Object.entries(table)
    .map(([contractKey, days]) => ({
      contractKey,
      expiry: expiryOf(contractKey),
      days: [...days].sort(),
    }))
    .filter((row) => row.expiry && row.days.length)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
}

/**
 * Handelsdagar som finns för SAMTLIGA rötter i sitt respektive kontrakt.
 *
 * En dag som bara en rot har är inte en gemensam dag — replay kör MNQ och MES i
 * samma bok, och en halv dag hade gett en systematiskt sned bild av
 * samtidigheten.
 */
function sharedDays({ roots = DEFAULT_ROOTS, dataStore = store } = {}) {
  const perRoot = roots.map((root) => {
    const days = new Set();
    for (const contract of listContracts(root, { dataStore })) {
      for (const day of contract.days) days.add(day);
    }
    return days;
  });
  if (!perRoot.length) return [];
  return [...perRoot[0]].filter((day) => perRoot.every((set) => set.has(day))).sort();
}

/**
 * Kontraktsnyckeln som äger en given handelsdag för en rot.
 *
 * Replay-motorn tar emot contractKeyByRoot och läser då BARA den katalogen. Det
 * är den mekanismen som gör exact_contract till mer än en etikett.
 */
function contractKeyForDay(root, day, { dataStore = store } = {}) {
  for (const contract of listContracts(root, { dataStore })) {
    if (contract.days.includes(day)) return contract.contractKey;
  }
  return null;
}

/** Null när någon rot saknar kontrakt för dagen — halva marknaden duger inte. */
function contractKeyByRootForDay(day, { roots = DEFAULT_ROOTS, dataStore = store } = {}) {
  const out = {};
  for (const root of roots) {
    const key = contractKeyForDay(root, day, { dataStore });
    if (!key) return null;
    out[String(root).toUpperCase()] = key;
  }
  return out;
}

/** Kalenderdatumet en handelsdags RTH-fönster ligger på. */
function rthDateFor(tradingDay) {
  const d = new Date(`${tradingDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Replay-fönstret för en handelsdag, i kalendertid. */
function rthWindowFor(tradingDay) {
  const date = rthDateFor(tradingDay);
  return Object.freeze({
    tradingDay,
    date,
    from: `${date}T${RTH_WINDOW.fromUtc}:00.000Z`,
    to: `${date}T${RTH_WINDOW.toUtc}:00.000Z`,
  });
}

/** Vad lagret innehåller, som det ska bokföras i ett experiments härkomst. */
function describeCalendar({ roots = DEFAULT_ROOTS, dataStore = store } = {}) {
  const shared = sharedDays({ roots, dataStore });
  const contracts = {};
  for (const root of roots) {
    contracts[String(root).toUpperCase()] = listContracts(root, { dataStore })
      .map((row) => ({ contractKey: row.contractKey, expiry: row.expiry, days: row.days.length }));
  }
  return {
    calendarVersion: CALENDAR_VERSION,
    dataAccessMode: DATA_ACCESS_MODES.EXACT_CONTRACT,
    roots: [...roots].map((r) => String(r).toUpperCase()),
    sharedDayCount: shared.length,
    from: shared[0] || null,
    to: shared[shared.length - 1] || null,
    contracts,
    // Rotläsningen finns dokumenterad men används inte. Talet är med för att en
    // läsare ska kunna se att skillnaden är känd och medvetet bortvald.
    excludedByExactContract: 'rotnivåfiler utan kontraktsmotsvarighet ingår inte',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  CALENDAR_VERSION,
  DATA_ACCESS_MODES,
  DEFAULT_ROOTS,
  RTH_WINDOW,
  listContracts,
  sharedDays,
  contractKeyForDay,
  contractKeyByRootForDay,
  rthDateFor,
  rthWindowFor,
  describeCalendar,
  _internal: { expiryOf },
};
