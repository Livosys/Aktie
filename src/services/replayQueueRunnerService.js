'use strict';

const path = require('path');
const schedulerModule = require('./replaySchedulerService');
const { fork } = require('child_process');

const replayQueue = require('./replayQueueService');
const replayEngine = require('../scanner/replayEngine');
const learningConnector = require('./learningConnectorService');
const coverage = require('../data/marketDataCoverage');
const marketDataStore = require('../data/marketDataStore');
const historicalFeedModule = require('../services/historicalPriceFeedService');
// Handelsdagsmappningen och kontraktsnycklarna är marknadsdatafakta och bor i
// src/data. Kön läste dem tidigare ur researchDatasetBoundaryService — samma
// definition, men en produktionsväg som importerar en modul kallad "research"
// är en lagerinversion som förvirrar mer för varje läsare.
const calendar = require('../data/tradingDayCalendar');
const strategyLibraryModule = require('./library/strategyLibraryService');

// ── Två motorer, ett kösystem ────────────────────────────────────────────────
//
// Kön har alltid kört src/scanner/replayEngine: en scanner-replay i läget
// scan_only som producerar signalstatistik per symbol. Den vet ingenting om
// strategier, och därför har ingen köad strategi någonsin utvärderats som
// strategi — jobbet bar ett strategy-id som resultatet inte kunde svara på.
//
// Futures-jobb (MNQ/MES) dirigeras därför till Native Replay Engine, som kör
// exakt samma kedja som Paper Trading med klockan flyttad: scanner → decision
// monitor → canonical adapter → broker risk → fill engine → trade ledger →
// strategy score. Övriga jobb (aktier, krypto) går som förut till
// scanner-replayen. Ingen väg tas bort, ingen route ändras.
const FUTURES_ROOTS = Object.freeze(new Set(['MNQ', 'MES']));
const NATIVE_REPLAY_WORKER_FILE = path.resolve(__dirname, '../jobs/runNativeReplayWorker.js');
// 49 s mätt för 29 strategier på ett fyratimmarsfönster. Taket ligger med god
// marginal över det men avslutar en körning som fastnat.
const NATIVE_REPLAY_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.NATIVE_REPLAY_TIMEOUT_MS) || 600000,
);
// Fönstret är samma enhet som replay-acceptanstestet behandlar som en komplett
// körning: ett dygn som lagret täcker hela vägen genom RTH. Ett jobb ber om 30
// dagar, men lagret har 13 och motorn stegar synkront — utan bound hade en
// körning tagit timmar och mest gått genom dygn utan data.
const NATIVE_REPLAY_WINDOW = Object.freeze({
  throughUtcTime: process.env.NATIVE_REPLAY_THROUGH_UTC || '18:00',
  fromUtcTime: process.env.NATIVE_REPLAY_FROM_UTC || '13:00',
  toUtcTime: process.env.NATIVE_REPLAY_TO_UTC || '17:00',
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Timeframen jobbet körs i. Uttrycket stod tidigare på två ställen i den här
// filen och ett tredje i schemaläggaren; tre kopior av samma regel är hur två
// delar av ett system börjar köra i olika timeframes utan att någon märker det.
// Motorns förval hör hemma HÄR, vid exekveringen — inte hos den som föreslår.
function executedTimeframeFor(job = {}) {
  return schedulerModule.resolveJobTimeframe({ job }) || schedulerModule.DEFAULT_JOB_TIMEFRAME;
}

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function replayArgsFromJob(job = {}) {
  const symbols = safeArray(job.market_dna?.symbols)
    .map((symbol) => safeString(symbol).toUpperCase())
    .filter(Boolean);
  return {
    symbols,
    start: safeString(job.period?.start),
    end: safeString(job.period?.end),
    mode: safeString(job.execution_model?.engine_mode || 'scan_only', 'scan_only'),
  };
}

/** Är jobbet ett futures-jobb? Endast om SAMTLIGA symboler är futures-rötter. */
function isFuturesJob(args = {}) {
  const symbols = safeArray(args.symbols);
  return symbols.length > 0 && symbols.every((symbol) => FUTURES_ROOTS.has(symbol));
}

/** Dygn biblioteket redan har ett replay-resultat för. */
function replayedDaysFrom(library) {
  const days = new Set();
  if (!library || typeof library.listStrategies !== 'function') return days;
  try {
    for (const record of library.listStrategies()) {
      for (const row of safeArray(record.replayHistory)) {
        const from = safeString(row.from);
        if (from) days.add(from.slice(0, 10));
      }
    }
  } catch (_) { /* biblioteket är inte en förutsättning för att kunna köra */ }
  return days;
}

/**
 * Fönstret Native Replay ska köra, eller null när historiken saknar ett
 * körbart dygn inom jobbets period.
 *
 * ── Handelsdag, inte kalenderdatum ───────────────────────────────────────────
 *
 * Fönstret byggdes tidigare som `${dygn}T13:00–17:00` på ett dygn ur
 * listCompleteDays, alltså ett KALENDERdatum. Det var fel mot hur historiken
 * faktiskt ligger: den kontraktspartitionerade backfillen partitionerar på
 * CME:s handelsdag, som börjar kvällen före, så filen märkt D innehåller
 * D 22:00 till D+1 20:59. Mätt 2026-08-20 hade 212 av 222 kompletta dygn noll
 * barer mellan 13:00 och 17:00 på sitt eget datum.
 *
 * Kön hade bara hunnit rotera genom fem dygn — alla nyliga, alla med en rotfil
 * på kalenderdatum — och därför hade det aldrig visat sig. Nästa dygn i
 * rotationen var söndagen 2026-08-16, vars fönster är tomt.
 *
 * Mappningen handelsdag → RTH-datum (etikett + 1 dygn) ägs av
 * researchDatasetBoundaryService och är mätt över hela lagret: 218 av 218 filer
 * lägger sitt 13:00–17:00-fönster på etikett + 1, med 240 minutbarer i varje.
 * Den läses härifrån i stället för att skrivas en andra gång — två uträkningar
 * av samma mappning hade förr eller senare pekat på olika dygn.
 *
 * ── Kontraktsnycklar följer med ──────────────────────────────────────────────
 *
 * Dygnen kommer ur kontraktskatalogen, så körningen måste också LÄSA den
 * katalogen. Utan contractKeyByRoot faller motorn tillbaka på den sammanslagna
 * rotläsningen, och då kan ett fönster spänna över två kontrakt — vilket feeden
 * svarar på med ambiguous_contract_ownership och noll barer. Nycklarna bärs
 * därför i fönstret och skickas vidare till motorn.
 *
 * ── Varför dygnet ROTERAR ────────────────────────────────────────────────────
 *
 * Nyaste ännu ej replayade dygn väljs först. När alla är körda faller valet
 * tillbaka på det nyaste, och köns egen dubblettspärr hindrar då att samma jobb
 * körs igen. Utan rotationen replayades samma dygn om och om igen medan resten
 * av lagret aldrig prövades av någon.
 *
 * ── Varför bara STÄNGDA dygn ─────────────────────────────────────────────────
 *
 * Ett dygn som lagret fortfarande skriver till ger evidens räknad på data som
 * växer. Resultatet blir inte fel på ett synligt sätt: det blir ett riktigt
 * utseende resultat räknat på halva dagen, inskrivet i Strategy Library som om
 * det vore hela — och nästa körning av samma dygn hade gett ett annat svar.
 *
 * Tystnaden mäts på både rot- och kontraktsfilen. Det är strängare än nödvändigt
 * för en ren kontraktsläsning, men åt rätt håll: ett dygn som någon del av
 * lagret rör vid är inte färdigt.
 *
 * Att returnera null när inget körbart dygn finns i perioden är avsiktligt: en
 * replay som tar slut mitt i perioden ser ut som en marknad utan signaler, och
 * det är den farligaste sortens fel — det ser ut som ett resultat.
 */
function nativeWindowForJob(job = {}, {
  calendarService = calendar,
  dataStore = marketDataStore,
  feedService = null,
  library = null,
  now = null,
} = {}) {
  const roots = [...FUTURES_ROOTS];
  const tradingDays = typeof calendarService.sharedDays === 'function'
    ? [...calendarService.sharedDays({ roots })].sort().reverse()
    : [];
  if (!tradingDays.length) return null;

  const start = safeString(job.period?.start);
  const end = safeString(job.period?.end);
  const nowMs = now == null ? Date.now() : new Date(now).getTime();

  const candidates = [];
  for (const tradingDay of tradingDays) {
    const window = calendarService.rthWindowFor(tradingDay);
    // Perioden filtreras på RTH-datumet, alltså det dygn körningen faktiskt
    // täcker — inte på filens etikett, som ligger ett dygn tidigare.
    if (start && window.date < start) continue;
    if (end && window.date > end) continue;
    const contractKeyByRoot = calendarService.contractKeyByRootForDay(tradingDay, { roots });
    // En rot utan kontrakt för dygnet gör körningen ensidig. Hälften av en
    // marknad är inte en marknad.
    if (!contractKeyByRoot) continue;
    if (!isQuietDay(tradingDay, { roots, dataStore, nowMs })) continue;
    candidates.push({ tradingDay, window, contractKeyByRoot });
  }
  if (!candidates.length) return null;

  const replayed = replayedDaysFrom(library);
  const picked = candidates.find((row) => !replayed.has(row.window.date)) || candidates[0];

  // Sista kontrollen görs på DET dygn som ska köras, inte på alla 218: att läsa
  // fönstret är en filläsning per rot, och att göra det för hela listan hade
  // kostat sekunder för en grind som mätningen säger aldrig utlöser. Men den
  // ska finnas — ett tomt fönster som bokförs är exakt felet ovan.
  if (!hasBarsInWindow(picked, { roots, feedService })) return null;

  return {
    day: picked.window.date,
    tradingDay: picked.tradingDay,
    from: picked.window.from,
    to: picked.window.to,
    contractKeyByRoot: picked.contractKeyByRoot,
    dataAccessMode: 'exact_contract',
    availableDays: candidates.length,
    replayedDays: replayed.size,
  };
}

/** Har lagret legat stilla om handelsdagen tillräckligt länge? */
function isQuietDay(tradingDay, { roots, dataStore, nowMs }) {
  if (!dataStore || typeof dataStore.lastModifiedMs !== 'function') return true;
  for (const root of roots) {
    const modified = dataStore.lastModifiedMs(root, tradingDay, 'ib');
    if (modified == null) continue;
    if (nowMs - modified < coverage.CLOSED_DAY_QUIET_MS) return false;
  }
  return true;
}

/** Finns det barer i fönstret, läst med samma kontraktsnyckel som motorn? */
function hasBarsInWindow({ window, contractKeyByRoot }, { roots, feedService }) {
  const feed = feedService || historicalFeedModule.createHistoricalPriceFeedService();
  if (typeof feed.getBarsBetween !== 'function') return true;
  return roots.every((root) => {
    const bars = feed.getBarsBetween(root, window.from, window.to, {
      contractKey: contractKeyByRoot[root],
    });
    return Array.isArray(bars) && bars.length > 0;
  });
}

/**
 * Kör Native Replay i en barnprocess.
 *
 * Loopen är synkron hela vägen; i serverprocessen hade den frusit event-loopen
 * lika länge som körningen tar. Se runNativeReplayWorker.js.
 */
function runNativeReplayInWorker(config, meta = {}, { workerFile = NATIVE_REPLAY_WORKER_FILE } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(workerFile, [], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, NATIVE_REPLAY_WORKER: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const done = (err, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (err) {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        reject(err);
        return;
      }
      resolve(payload);
    };
    const timer = setTimeout(() => done(new Error('native_replay_worker_timeout')), NATIVE_REPLAY_TIMEOUT_MS);
    child.on('message', (msg) => {
      if (!msg || msg.type !== 'native_replay_result') return;
      if (msg.ok) done(null, msg.payload);
      else done(new Error(msg.error || 'native_replay_worker_failed'));
    });
    child.on('error', (err) => done(err));
    child.on('exit', (code, signal) => {
      if (!settled) done(new Error(`native_replay_worker_exit_${signal || code}`));
    });
    child.send({ type: 'native_replay_run', config, runId: meta.runId || null, requestedBy: meta.requestedBy || null });
  });
}

/**
 * Native RunResult → samma form som kön och Learning redan förstår.
 *
 * Learning-kopplingen fanns redan och ska inte byggas två gånger; den behöver
 * bara ett resultat den känner igen.
 */
function nativeResultAsQueueResult(payload = {}, window = {}) {
  const counts = payload.counts || {};
  const scores = safeArray(payload.strategyScore);
  const scored = scores.filter((row) => Number.isFinite(Number(row.total)));
  const avgTradeScore = scored.length
    ? Math.round((scored.reduce((acc, row) => acc + Number(row.total), 0) / scored.length) * 10) / 10
    : null;
  return {
    runId: `native_replay:${window.day || payload.config?.from || 'unknown'}`,
    engine: 'native_replay_engine',
    summary: {
      symbols: safeArray(payload.config?.symbols),
      totalEvents: safeNumber(counts.uniqueSignals, 0),
      totalTrades: safeNumber(counts.trades, 0),
      avgTradeScore,
      marketClassification: payload.marketClassification || null,
      strategies: safeArray(payload.config?.strategiesFromRegistry).length,
      window: `${payload.config?.from || ''} -> ${payload.config?.effectiveTo || payload.config?.to || ''}`,
      // Vilket genom körningen FAKTISKT laddade. Ett jobb kan be om ett genom
      // som inte går att köra (roten saknar kod, mutationen ändrade inget
      // läsbart), och då är svaret ett annat än det som beställdes. Skillnaden
      // måste synas hela vägen upp i vyn — annars ser en körning som prövade
      // något annat ut som en körning som prövade det man bad om.
      requestedGenomes: safeArray(payload.config?.requestedGenomes),
      executedGenomes: safeArray(payload.config?.strategiesFromRegistry)
        .filter((id) => String(id).includes('@')),
    },
    strategyScore: scores,
    library: payload.library || null,
    lineage: payload.lineage || null,
    counts,
  };
}

function memoryPayloadFromJob(job = {}, result = {}, status = 'completed', error = null) {
  const summary = result.summary || {};
  const symbols = safeArray(summary.symbols).length ? summary.symbols : safeArray(job.market_dna?.symbols);
  return {
    session_id: `replay_job:${job.id}`,
    source: 'replayQueue',
    strategy_id: job.strategy?.id || null,
    strategy_name: job.strategy?.name || null,
    symbol: symbols[0] || 'MULTI',
    symbols,
    timeframe: executedTimeframeFor(job),
    replay_window: `${job.period?.start || ''} -> ${job.period?.end || ''}`,
    // Scanner-replayen räknar signalhändelser; Native Replay räknar affärer.
    // Learning frågar efter "hur många gånger hände det här", och för en
    // strategikörning är svaret affärer — inte signaler som aldrig fylldes.
    total_trades: safeNumber(summary.totalTrades ?? summary.totalEvents, 0),
    avg_trade_score: summary.avgTradeScore ?? null,
    mode: job.replay_mode || 'manual',
    outcome: status === 'failed' ? 'unknown' : undefined,
    extra: {
      job_id: job.id,
      replay_mode: job.replay_mode,
      requested_by: job.requested_by,
      status,
      run_id: result.runId || null,
      error: error ? safeString(error) : null,
    },
  };
}

function recordJobMemory(job, result, status, error, connector) {
  if (!connector || typeof connector.recordReplayResult !== 'function') {
    return { ok: false, error: 'learning_connector_unavailable', ...SAFETY };
  }
  try {
    const recorded = connector.recordReplayResult(memoryPayloadFromJob(job, result, status, error));
    return {
      ok: recorded?.ok !== false,
      result: recorded,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      ...SAFETY,
    };
  }
}

function createReplayQueueRunnerService(options = {}) {
  const queueService = options.queueService || replayQueue.defaultReplayQueueService;
  const engine = options.replayEngine || replayEngine;
  const connector = options.learningConnector || learningConnector;
  const workerId = safeString(options.workerId || 'replay_queue_runner');
  const coverageService = options.coverageService || coverage;
  const calendarService = options.calendarService || calendar;
  // Injicerbara av samma skäl som boundaryService: dygnsvalet läser lagret
  // (ligger dygnet stilla?) och feeden (finns det barer i fönstret?), och båda
  // frågorna måste gå att svara på utan riktiga filer i ett test.
  const dataStore = options.dataStore || marketDataStore;
  const feedService = options.feedService || null;
  const runNativeReplay = options.runNativeReplay || runNativeReplayInWorker;
  // Läses bara för att välja dygn. Skrivningen till biblioteket sker i
  // barnprocessen, där RunResult fortfarande är helt.
  const library = options.strategyLibrary || strategyLibraryModule.defaultStrategyLibrary;

  /**
   * Futures-jobbet, kört mot de riktiga evaluatorerna.
   *
   * mode: 'strategy' ger varje strategi en egen bok. Det är hela poängen med
   * en strategikö: i production-läget delar alla strategier en position, och
   * den som råkar signalera först stänger ute resten — då mäter körningen
   * turordning i stället för strategi.
   */
  async function runNativeJob(job, args) {
    const window = nativeWindowForJob(job, { calendarService, dataStore, feedService, library });
    if (!window) {
      throw new Error('native_replay_no_complete_day_in_period');
    }
    const payload = await runNativeReplay({
      from: window.from,
      to: window.to,
      symbols: args.symbols,
      timeframe: executedTimeframeFor(job),
      mode: 'strategy',
      // Dygnen kommer ur kontraktskatalogen, så körningen måste läsa samma
      // katalog. Utan nycklarna faller motorn tillbaka på den sammanslagna
      // rotläsningen och kan då få ambiguous_contract_ownership — noll barer,
      // och ett tomt resultat som ser ut som en marknad utan signaler.
      contractKeyByRoot: window.contractKeyByRoot,
      // Registrets parametervarianter av de åtta modulerna. Det är det som gör
      // att kön kan utvärdera fler strategier än det finns strategifiler.
      includeVariants: true,
      // Släktträdets muterade genom. Utan dem skapar Evolution Engine
      // generationer som ingen någonsin prövar.
      includeEvolved: true,
      // Genomet jobbet skapades FÖR. includeEvolved ovan tar de nyaste
      // EVOLVED_LIMIT genomen, vilket är ett urval och inte ett löfte — hade 24
      // nyare genom hunnit skapas prövades aldrig det genom jobbet gällde.
      // Ett uttryckligen begärt genom går förbi taket.
      genomeHashes: job.genome?.dna_hash ? [job.genome.dna_hash] : [],
    }, { runId: `replay_job:${job.id}`, requestedBy: 'scheduler' });
    return nativeResultAsQueueResult(payload, window);
  }

  async function runNextJob() {
    const next = queueService.nextPendingJob();
    if (!next.ok || next.blocked || !next.job) {
      return {
        ok: next.ok,
        executed: false,
        blocked: true,
        blockedReason: next.blockedReason || next.error || 'no_replay_job_available',
        job: null,
        ...SAFETY,
      };
    }

    const started = queueService.startJob(next.job.id, { workerId });
    if (!started.ok) {
      return {
        ok: false,
        executed: false,
        blocked: true,
        blockedReason: started.error,
        job: next.job,
        ...SAFETY,
      };
    }

    const job = started.job || next.job;
    try {
      const args = replayArgsFromJob(job);
      const native = isFuturesJob(args);
      if (!native && (!engine || typeof engine.runReplay !== 'function')) {
        throw new Error('replay_engine_unavailable');
      }
      const result = native ? await runNativeJob(job, args) : await engine.runReplay(args);
      const memory = recordJobMemory(job, result, 'completed', null, connector);
      const completed = queueService.completeJob(job.id, {
        runId: result?.runId || null,
        replaySummary: result?.summary || null,
        memoryRecorded: memory.ok === true,
      });
      return {
        ok: completed.ok,
        executed: true,
        engine: native ? 'native_replay_engine' : 'scanner_replay_engine',
        job: completed.job,
        replay: result,
        // Bibliotekssynken och REPLAY_RECORDED sker inuti barnprocessen, där
        // RunResult fortfarande är helt. Kvittot följer med hit.
        library: native ? (result.library || null) : null,
        lineage: native ? (result.lineage || null) : null,
        memoryRecorded: memory.ok === true,
        memory,
        ...SAFETY,
      };
    } catch (err) {
      const memory = recordJobMemory(job, {}, 'failed', err.message || String(err), connector);
      const failed = queueService.failJob(job.id, {
        error: err.message || String(err),
        memoryRecorded: memory.ok === true,
      });
      return {
        ok: false,
        executed: true,
        failed: true,
        job: failed.job || job,
        error: err.message || String(err),
        memoryRecorded: memory.ok === true,
        memory,
        ...SAFETY,
      };
    }
  }

  return {
    SAFETY,
    runNextJob,
    _internal: {
      replayArgsFromJob,
      memoryPayloadFromJob,
      runNativeJob,
    },
  };
}

const defaultReplayQueueRunnerService = createReplayQueueRunnerService();

module.exports = {
  SAFETY,
  createReplayQueueRunnerService,
  defaultReplayQueueRunnerService,
  _internal: {
    replayArgsFromJob,
    memoryPayloadFromJob,
    recordJobMemory,
    isFuturesJob,
    nativeWindowForJob,
    nativeResultAsQueueResult,
    FUTURES_ROOTS,
  },
};
