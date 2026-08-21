'use strict';

// ── Replay Framework: tre exekveringslägen, en motor ─────────────────────────
//
// Production Replay, Strategy Replay och Portfolio Replay är INTE tre motorer.
// Att bygga dem som tre hade varit att bygga tre system som långsamt glider
// isär, och då är hela poängen med Fas 4 borta.
//
// Skillnaden mellan lägena är exakt två frågor:
//
//   1. Vilken BOK debiteras signalen?
//   2. Hur många böcker får ha en öppen position samtidigt?
//
// Allt annat — feed, scanner, decision monitor, canonical adapter, broker risk,
// fill engine, ledger, statistik, score — är identiskt och delas.
//
//   PRODUCTION  en enda bok för allt.                    Positionstaket sköts av
//               Bit för bit samma sak som Paper.         Broker Risk, inte här.
//
//   STRATEGY    en bok per strategi, obegränsat antal    AI:s träningsmiljö. Varje
//               samtidiga.                               strategi mäts på HELA sitt
//                                                        signalflöde, inte på vad
//                                                        som råkade bli över när
//                                                        någon annan tog platsen.
//
//   PORTFOLIO   en bok per strategi, högst N samtidiga,  Slutlig rangordning innan
//               endast godkända strategier, GEMENSAMT    Paper. Mäter samverkan:
//               kapital.                                 trängsel, samtidighet och
//                                                        vem som faktiskt bidrar.
//
// ── Varför en bok per strategi och inte ett höjt positionstak ────────────────
//
// Broker Risk hämtar maxOpenPositions ur ibPaperExecutionConfigService. Där är
// LIVE hårdkapat till 1 (Math.min(env, 1)) medan PAPER sedan 2026-08-20 får
// bära upp till HARD_MAX_OPEN_POSITIONS kontrakt, fördelade fritt mellan
// rötterna — same_root-grinden är borttagen, och taket räknar kontrakt i
// stället för positionsrader.
// Att höja taket för portföljläget hade ändå krävt en ändring i den modul som
// också styr paper och live — alltså precis den sortens ändring som inte får
// göras för att en analysfunktion vill något.
//
// I stället får varje bok sin egen positionsvy. Broker Risk ser då exakt en
// position per bok och är fullständigt oförändrad. En portfölj med N samtidiga
// strategier är i praktiken N paper-konton, vilket också är den ärligaste
// beskrivningen av exponeringen.
//
// Ren modul: ingen IO, ingen klocka, ingen slump, ingen broker.

const tradeLedgerModule = require('../trade/tradeLedgerService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'replay_book_allocator',
});

const REPLAY_MODES = Object.freeze({
  PRODUCTION: 'production',
  STRATEGY: 'strategy',
  PORTFOLIO: 'portfolio',
});

const PRODUCTION_BOOK = 'production';

// Varför en signal inte fick någon bok. Detta är ALLOKERINGSbeslut och hålls
// åtskilda från Broker Risks blockerare — de svarar på olika frågor och ska
// kunna räknas var för sig i rapporten.
const ALLOCATION_BLOCKS = Object.freeze({
  NOT_APPROVED: 'strategy_not_approved_for_portfolio',
  PORTFOLIO_FULL: 'portfolio_concurrency_full',
});

const MODE_PROFILES = Object.freeze({
  [REPLAY_MODES.PRODUCTION]: {
    bookKeyFor: () => PRODUCTION_BOOK,
    // Obegränsat antal böcker spelar ingen roll: det finns bara en, och
    // Broker Risk släpper igenom en position i den.
    maxConcurrentBooks: Infinity,
    // Kontot är boken själv.
    sharedCapital: false,
    admits: () => true,
    description: 'Identisk med Paper Trading: en bok, ett positionstak, samma grindar.',
  },
  [REPLAY_MODES.STRATEGY]: {
    bookKeyFor: (signal) => signal.strategyId || 'unknown',
    maxConcurrentBooks: Infinity,
    sharedCapital: false,
    admits: () => true,
    description: 'AI:s träningsmiljö: varje strategi isolerad med eget kapital och egen positionsplats.',
  },
  [REPLAY_MODES.PORTFOLIO]: {
    bookKeyFor: (signal) => signal.strategyId || 'unknown',
    maxConcurrentBooks: 3,
    sharedCapital: true,
    admits: (signal, { approved }) => approved == null || approved.has(signal.strategyId),
    description: 'Godkända strategier i samma kapital: mäter samverkan och trängsel inför Paper.',
  },
});

function normalizeMode(mode) {
  const value = String(mode || REPLAY_MODES.PRODUCTION).toLowerCase();
  if (!MODE_PROFILES[value]) {
    throw new Error(`replay_unknown_mode:${value} (giltiga: ${Object.values(REPLAY_MODES).join(', ')})`);
  }
  return value;
}

/**
 * @param {object}   options
 * @param {string}   options.mode                  production | strategy | portfolio
 * @param {number}   [options.maxConcurrentPositions]  endast portfolio
 * @param {string[]} [options.approvedStrategies]      endast portfolio; null = alla
 * @param {Function} [options.createLedger]            injicerbar för test
 */
function createBookAllocator(options = {}) {
  const mode = normalizeMode(options.mode);
  const profile = MODE_PROFILES[mode];
  const createLedger = options.createLedger || tradeLedgerModule.createTradeLedger;
  const approved = Array.isArray(options.approvedStrategies)
    ? new Set(options.approvedStrategies)
    : null;
  const maxConcurrentBooks = mode === REPLAY_MODES.PORTFOLIO
    ? Math.max(1, Number(options.maxConcurrentPositions) || profile.maxConcurrentBooks)
    : profile.maxConcurrentBooks;

  // bookId → ledger. Skapas lat, så en strategi som aldrig signalerar aldrig
  // får en bok och inte heller syns som "0 affärer" i rapporten.
  const books = new Map();
  // Räknare på hur ofta trängseln band, per strategi.
  const allocationBlocks = [];

  function ledgerFor(bookId) {
    if (!books.has(bookId)) books.set(bookId, createLedger());
    return books.get(bookId);
  }

  function booksWithOpenPosition() {
    let count = 0;
    for (const ledger of books.values()) {
      if (ledger.openTrades().length > 0) count += 1;
    }
    return count;
  }

  /**
   * Tilldelar en bok för en signal.
   *
   * @returns {{ok: true, bookId, ledger} | {ok: false, blocker, detail}}
   */
  function acquire(signal, { now = null } = {}) {
    if (!profile.admits(signal, { approved })) {
      const block = {
        at: now ? new Date(now).toISOString() : null,
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        blocker: ALLOCATION_BLOCKS.NOT_APPROVED,
      };
      allocationBlocks.push(block);
      return { ok: false, blocker: ALLOCATION_BLOCKS.NOT_APPROVED, detail: block };
    }

    const bookId = profile.bookKeyFor(signal);
    const existing = books.get(bookId);
    const bookIsBusy = existing ? existing.openTrades().length > 0 : false;

    // Trängselgrinden gäller bara när en NY bok skulle behöva öppna en position.
    // En bok som redan har en position kvar i marknaden tar ingen ny plats — och
    // att den inte får öppna en till sköter Broker Risk, precis som i paper.
    if (!bookIsBusy && booksWithOpenPosition() >= maxConcurrentBooks) {
      const block = {
        at: now ? new Date(now).toISOString() : null,
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        blocker: ALLOCATION_BLOCKS.PORTFOLIO_FULL,
        concurrentPositions: booksWithOpenPosition(),
        maxConcurrentPositions: maxConcurrentBooks,
      };
      allocationBlocks.push(block);
      return { ok: false, blocker: ALLOCATION_BLOCKS.PORTFOLIO_FULL, detail: block };
    }

    return { ok: true, bookId, ledger: ledgerFor(bookId) };
  }

  /**
   * Positionerna som Broker Risk ska se för en given bok.
   *
   * I production och strategy är det bokens egna positioner. I portfolio ÄR det
   * också bokens egna — den delade exponeringen begränsas av trängselgrinden
   * ovan, inte genom att blåsa upp positionsvyn. Att låtsas att en portfölj är
   * en enda position hade fått Broker Risk att blockera allt utom det första.
   */
  function positionsFor(bookId) {
    const ledger = books.get(bookId);
    return ledger ? ledger.brokerPositionsView() : [];
  }

  /**
   * Realiserat resultat som dagsförlustgränsen ska mätas mot.
   *
   * Här — och bara här — spelar sharedCapital roll: i portföljläget delar
   * strategierna kapital, så en strategis förluster påverkar de andras
   * riskutrymme. Det är själva poängen med läget.
   */
  function realizedPnlFor(bookId) {
    if (!profile.sharedCapital) {
      const ledger = books.get(bookId);
      return ledger ? (ledger.summary().netPnlUsd ?? 0) : 0;
    }
    let total = 0;
    for (const ledger of books.values()) total += ledger.summary().netPnlUsd ?? 0;
    return total;
  }

  function listBooks() {
    return [...books.entries()].map(([bookId, ledger]) => ({
      bookId,
      trades: ledger.all(),
      performance: ledger.summary(),
    }));
  }

  /** Sammanfattning över samtliga böcker, räknad av ledgerns egen matematik. */
  function mergedPerformance() {
    return tradeLedgerModule.summarizeTrades(mergedTrades());
  }

  function mergedTrades() {
    return [...books.values()].flatMap((ledger) => ledger.all());
  }

  /** Alla affärer grupperade per strategi, över samtliga böcker. */
  function tradesByStrategy() {
    const groups = new Map();
    for (const row of mergedTrades()) {
      if (row.status !== 'closed') continue;
      const key = row.strategyId || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }

  function describe() {
    return {
      mode,
      description: profile.description,
      maxConcurrentPositions: Number.isFinite(maxConcurrentBooks) ? maxConcurrentBooks : null,
      sharedCapital: profile.sharedCapital,
      isolatedBooks: mode !== REPLAY_MODES.PRODUCTION,
      approvedStrategies: approved ? [...approved] : null,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    mode,
    describe,
    acquire,
    ledgerFor,
    positionsFor,
    realizedPnlFor,
    listBooks,
    mergedTrades,
    mergedPerformance,
    tradesByStrategy,
    booksWithOpenPosition,
    allocationBlocks: () => allocationBlocks,
  };
}

module.exports = {
  SAFETY,
  REPLAY_MODES,
  ALLOCATION_BLOCKS,
  PRODUCTION_BOOK,
  MODE_PROFILES,
  createBookAllocator,
  _internal: { normalizeMode },
};
