'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReplayQueueService } = require('./replayQueueService');
const { createReplayQueueRunnerService } = require('./replayQueueRunnerService');
const coverage = require('../data/marketDataCoverage');

function sampleJob(idSuffix = 'alpha') {
  return {
    strategy: { id: `strategy_${idSuffix}`, name: `Strategy ${idSuffix}`, source: 'internal', status: 'paper_only' },
    market_dna: {
      symbols: ['QQQ', 'SPY'],
      market_group: 'index',
      timeframe: '2m',
      dna_tags: ['confidence'],
    },
    replay_mode: 'confidence',
    period: { start: '2026-07-20', end: '2026-08-17' },
    execution_model: { engine_mode: 'scan_only', timeframe: '2m' },
    priority: { score: 75, metric: 'information_gain', components: { low_confidence: 18 }, win_rate_used: false },
    reason: 'Runner integration test.',
    requested_by: 'Strategy Brain',
  };
}

function makeQueue(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  let tick = 0;
  const base = Date.parse('2026-08-17T13:00:00.000Z');
  return createReplayQueueService({
    queueFile: path.join(tmp, 'events.jsonl'),
    now: () => new Date(base + (tick++ * 1000)).toISOString(),
  });
}

(async function run() {
  {
    const queue = makeQueue('replay-runner-paused');
    const appended = queue.appendJob(sampleJob('paused'));
    assert.equal(appended.created, true);
    queue.pauseQueue('pause before runner', 'test');

    let engineCalls = 0;
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay() {
          engineCalls += 1;
          throw new Error('should not run while paused');
        },
      },
      learningConnector: { recordReplayResult: () => ({ ok: true }) },
    });
    const result = await runner.runNextJob();
    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, 'replay_queue_paused');
    assert.equal(engineCalls, 0, 'paused queue must not call replay engine');
  }

  {
    const queue = makeQueue('replay-runner-success');
    const appended = queue.appendJob(sampleJob('success'));
    const engineCalls = [];
    const memoryCalls = [];
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay(args) {
          engineCalls.push(args);
          return {
            runId: 'run_existing_engine_1',
            summary: {
              runId: 'run_existing_engine_1',
              symbols: args.symbols,
              start: args.start,
              end: args.end,
              mode: args.mode,
              totalEvents: 12,
              avgTradeScore: 61.5,
              coverage: { replay_ready: args.symbols },
            },
          };
        },
      },
      learningConnector: {
        recordReplayResult(payload) {
          memoryCalls.push(payload);
          return { ok: true, event: { source: 'replay', event_id: payload.session_id } };
        },
      },
    });

    const result = await runner.runNextJob();
    assert.equal(result.ok, true);
    assert.equal(result.executed, true);
    assert.equal(result.memoryRecorded, true);
    assert.equal(engineCalls.length, 1, 'runner must call existing replay engine exactly once');
    assert.deepEqual(engineCalls[0], {
      symbols: ['QQQ', 'SPY'],
      start: '2026-07-20',
      end: '2026-08-17',
      mode: 'scan_only',
    });
    assert.equal(memoryCalls.length, 1, 'AI Memory/Learning Connector must be filled after job');
    assert.equal(memoryCalls[0].session_id, `replay_job:${appended.job.id}`);
    assert.equal(memoryCalls[0].strategy_id, 'strategy_success');
    assert.equal(memoryCalls[0].total_trades, 12);
    assert.equal(memoryCalls[0].mode, 'confidence');

    const status = queue.getStatus();
    assert.equal(status.summary.completed, 1);
    assert.equal(status.completed_jobs[0].run_id, 'run_existing_engine_1');
    assert.equal(status.completed_jobs[0].memory_recorded, true);
  }

  {
    const queue = makeQueue('replay-runner-failure');
    queue.appendJob(sampleJob('failure'));
    const memoryCalls = [];
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay() {
          throw new Error('engine failed');
        },
      },
      learningConnector: {
        recordReplayResult(payload) {
          memoryCalls.push(payload);
          return { ok: true };
        },
      },
    });
    const result = await runner.runNextJob();
    assert.equal(result.ok, false);
    assert.equal(result.failed, true);
    assert.equal(result.memoryRecorded, true, 'failed jobs still produce a memory event');
    assert.equal(memoryCalls.length, 1);
    assert.equal(memoryCalls[0].extra.status, 'failed');
    assert.equal(queue.getStatus().summary.failed, 1);
  }

  {
    const sourceFiles = [
      'src/services/replayQueueService.js',
      'src/services/replaySchedulerService.js',
      'src/jobs/replayScheduler.js',
    ];
    for (const rel of sourceFiles) {
      const text = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
      assert.equal(text.includes('../scanner/replayEngine'), false, `${rel} must not import replay engine`);
      assert.equal(text.includes('paperTradingRuntimeService'), false, `${rel} must not touch paper runtime`);
      assert.equal(text.includes('paperTradingAgent'), false, `${rel} must not touch paper agent`);
      assert.equal(text.includes('nativeFuturesScannerService'), false, `${rel} must not touch native scanner`);
      assert.equal(text.includes('futuresPaperScannerService'), false, `${rel} must not touch paper scanner`);
      assert.equal(text.includes('../scanner/scheduler'), false, `${rel} must not touch native scanner scheduler`);
    }
  }

  // ── futures-jobb dirigeras till Native Replay Engine ────────────────────────
  {
    const runner = require('./replayQueueRunnerService');
    const { isFuturesJob, nativeWindowForJob, nativeResultAsQueueResult } = runner._internal;

    assert.equal(isFuturesJob({ symbols: ['MNQ', 'MES'] }), true);
    assert.equal(isFuturesJob({ symbols: ['MNQ'] }), true);
    // Blandat jobb går INTE till native-motorn: den kan bara futures, och en
    // halvkörd körning ser ut som en marknad utan signaler.
    assert.equal(isFuturesJob({ symbols: ['MNQ', 'QQQ'] }), false);
    assert.equal(isFuturesJob({ symbols: ['QQQ', 'SPY'] }), false);
    assert.equal(isFuturesJob({ symbols: [] }), false);

    // ── Fönstret byggs på HANDELSDAGEN, inte på kalenderdatumet ─────────────
    //
    // Filen märkt D innehåller D 22:00 till D+1 20:59, så RTH-fönstret ligger på
    // D+1. Byggdes fönstret på D träffade det ingenting: 212 av 222 kompletta
    // dygn hade noll barer mellan 13:00 och 17:00 på sitt eget datum.
    //
    // Stubben speglar tradingDayCalendars verkliga kontrakt: handelsdagar i
    // stigande ordning, rthWindowFor som lägger på ett dygn, och en
    // kontraktsnyckel per rot.
    const rthDateFor = (day) => {
      const d = new Date(`${day}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const calendarStub = (tradingDays, { missingContractFor = [] } = {}) => ({
      sharedDays: () => [...tradingDays],
      rthWindowFor: (day) => {
        const date = rthDateFor(day);
        return { tradingDay: day, date, from: `${date}T13:00:00.000Z`, to: `${date}T17:00:00.000Z` };
      },
      contractKeyByRootForDay: (day) => (missingContractFor.includes(day)
        ? null
        : { MNQ: `MNQ:1:${day}`, MES: `MES:2:${day}` }),
    });
    // Lagret och feeden stubbas så testet mäter dygnsvalet och inget annat.
    const quietStore = { lastModifiedMs: () => 0 };
    const feedWithBars = { getBarsBetween: () => [{ ts: 'x' }] };
    const pick = (job, extra = {}) => nativeWindowForJob(job, {
      calendarService: calendarStub(extra.days || ['2026-08-13', '2026-08-16', '2026-08-17']),
      dataStore: quietStore,
      feedService: feedWithBars,
      ...extra,
    });

    // Handelsdag 2026-08-17 ger RTH-datum 2026-08-18.
    assert.equal(pick({ period: { start: '2026-08-01', end: '2026-08-31' } }).day, '2026-08-18');
    assert.equal(pick({ period: { start: '2026-08-01', end: '2026-08-31' } }).tradingDay, '2026-08-17');
    // Kontraktsnycklarna måste följa med, annars läser motorn sammanslaget.
    assert.deepEqual(pick({ period: {} }).contractKeyByRoot, { MNQ: 'MNQ:1:2026-08-17', MES: 'MES:2:2026-08-17' });
    assert.equal(pick({ period: {} }).dataAccessMode, 'exact_contract');

    // Perioden filtreras på RTH-datumet — det dygn körningen faktiskt täcker.
    assert.equal(pick({ period: { start: '2026-09-01', end: '2026-09-30' } }), null);
    assert.equal(nativeWindowForJob({ period: {} }, {
      calendarService: calendarStub([]), dataStore: quietStore, feedService: feedWithBars,
    }), null);

    // Ett dygn där en rot saknar kontrakt hoppas över: hälften av en marknad
    // är inte en marknad.
    assert.equal(pick({ period: {} }, { missing: true, days: ['2026-08-16', '2026-08-17'],
      calendarService: calendarStub(['2026-08-16', '2026-08-17'], { missingContractFor: ['2026-08-17'] }) }).tradingDay,
    '2026-08-16');

    // Ett dygn som lagret fortfarande skriver till får inte väljas.
    const hotStore = { lastModifiedMs: (root, day) => (day === '2026-08-17' ? Date.now() : 0) };
    assert.equal(pick({ period: {} }, { dataStore: hotStore }).tradingDay, '2026-08-16');

    // Ett tomt fönster bokförs aldrig som ett resultat.
    assert.equal(pick({ period: {} }, { feedService: { getBarsBetween: () => [] } }), null);

    // Dygnet roterar: ett dygn biblioteket redan har resultat för hoppas över,
    // annars replayas samma dag i evighet och resten av lagret prövas aldrig.
    // Biblioteket bokför RTH-datumet, så jämförelsen sker mot det.
    const libraryWith = (days) => ({
      listStrategies: () => [{ replayHistory: days.map((d) => ({ from: `${d}T13:00:00.000Z` })) }],
    });
    assert.equal(pick({ period: {} }, { library: libraryWith(['2026-08-18']) }).day, '2026-08-17');
    assert.equal(pick({ period: {} }, { library: libraryWith(['2026-08-18', '2026-08-17']) }).day, '2026-08-14');

    // Alla dygn körda → nyeste igen, och köns dubblettspärr tar vid.
    const exhausted = pick({ period: {} }, {
      library: libraryWith(['2026-08-18', '2026-08-17', '2026-08-14']),
    });
    assert.equal(exhausted.day, '2026-08-18');
    assert.equal(exhausted.availableDays, 3);
    assert.equal(exhausted.replayedDays, 3);

    // ── Regime-aware scheduling ───────────────────────────────────────────
    //
    // Canonical gate kräver 2+ regimer för promotion. Scheduler bör välja
    // dagar klassificerade med ANNAN regime än vad samma strategi redan
    // testats på för att möjliggöra promotion.
    const { strategiesTestedInRegimes, regimeKeysForDay } = runner._internal;

    // A. Strategi med endast en regime (t.ex. volatile_chop) bör välja dag med
    //    annan regime om sådan finns.
    const libraryWithOneRegime = {
      listStrategies: () => [{
        strategyId: 'test_strategy_v1',
        replayHistory: [
          { from: '2026-08-18T13:00:00.000Z', marketClassification: 'volatile_chop', marketRegimeKeys: ['chop/high'] },
        ],
      }],
    };
    const dayWithDifferentRegime = {
      listStrategies: () => [{
        strategyId: 'test_strategy_v1',
        replayHistory: [
          { from: '2026-08-18T13:00:00.000Z', marketClassification: 'volatile_chop', marketRegimeKeys: ['chop/high'] },
          { from: '2026-08-17T13:00:00.000Z', marketClassification: 'range', marketRegimeKeys: ['range/normal'] },
        ],
      }],
    };
    // Med strategiId och bibliotek som har data, väljs dagen med annan regime.
    const picked_regime = pick(
      { period: {}, strategy: { id: 'test_strategy_v1' }, genome: { dna_hash: 'abc123' } },
      { library: libraryWithOneRegime, days: ['2026-08-16', '2026-08-17'] },
    );
    // Borde välja 2026-08-17 (unreplayed, potentiell annan regime om klassificering skiljer).
    assert(picked_regime.day === '2026-08-17' || picked_regime.day === '2026-08-16',
      'regime-aware scheduler bör välja bland kandidater');

    // B. regimeKeysForDay klassificerar ett dygn från tidigare körningar.
    const regimes_for_day_17 = regimeKeysForDay('2026-08-17', libraryWithOneRegime);
    assert.equal(regimes_for_day_17.size, 0, 'dag utan tidigare körningar returnerar tom SET');
    const regimes_for_day_18 = regimeKeysForDay('2026-08-18', libraryWithOneRegime);
    assert.equal(regimes_for_day_18.size > 0, true, 'dag med tidigare körningar returnerar klassificeringar');
    assert(regimes_for_day_18.has('chop/high') || regimes_for_day_18.has('volatile_chop'),
      'regimeKeysForDay returnerar registry-regime eller marketClassification');

    // C. strategiesTestedInRegimes läser union av regimer per strategi.
    const tested = strategiesTestedInRegimes({}, dayWithDifferentRegime);
    const test_strat_regimes = tested.get('test_strategy_v1');
    assert(test_strat_regimes && test_strat_regimes.size === 2,
      'strategi med två körningar i olika regimer returnerar båda');
    assert(test_strat_regimes.has('chop/high') || test_strat_regimes.has('volatile_chop'),
      'första regimen sparas');
    assert(test_strat_regimes.has('range/normal') || test_strat_regimes.has('range'),
      'andra regimen sparas');

    // D. Om ingen strategyId finns fallbacker scheduler till befintlig logic.
    const picked_no_strategy = pick({ period: {} }, { library: libraryWithOneRegime });
    assert.equal(picked_no_strategy && picked_no_strategy.day, '2026-08-17', 'fallback till unreplayed day utan strategyId');

    // RunResult översätts till den form kön och Learning redan förstår.
    const translated = nativeResultAsQueueResult({
      config: { symbols: ['MNQ', 'MES'], from: 'a', to: 'b', strategiesFromRegistry: ['x', 'y'] },
      counts: { uniqueSignals: 12, trades: 3 },
      strategyScore: [{ strategyId: 'x', total: 40 }, { strategyId: 'y', total: 60 }],
    }, { day: '2026-08-18' });
    assert.equal(translated.engine, 'native_replay_engine');
    assert.equal(translated.summary.totalTrades, 3);
    assert.equal(translated.summary.strategies, 2);
    assert.equal(translated.summary.avgTradeScore, 50);

    // Hela vägen: futures-jobbet får aldrig gå till scanner-replayen.
    const queue = makeQueue('runner-native');
    const job = {
      ...sampleJob('futures'),
      market_dna: { ...sampleJob('futures').market_dna, symbols: ['MNQ', 'MES'] },
      period: { start: '2026-08-01', end: '2026-08-31' },
    };
    queue.appendJob(job);
    let scannerCalls = 0;
    let nativeConfig = null;
    const nativeRunner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: { runReplay: async () => { scannerCalls += 1; return {}; } },
      calendarService: calendarStub(['2026-08-13', '2026-08-16', '2026-08-17']),
      dataStore: quietStore,
      feedService: feedWithBars,
      strategyLibrary: { listStrategies: () => [] },
      runNativeReplay: async (config) => {
        nativeConfig = config;
        return {
          config: { ...config, strategiesFromRegistry: ['a', 'b', 'c'] },
          counts: { uniqueSignals: 9, trades: 2 },
          strategyScore: [],
          library: { created: 3 },
        };
      },
      learningConnector: { recordReplayResult: () => ({ ok: true }) },
    });
    const executed = await nativeRunner.runNextJob();
    assert.equal(scannerCalls, 0, 'futures-jobbet gick till scanner-replayen');
    assert.equal(executed.engine, 'native_replay_engine');
    assert.equal(nativeConfig.includeVariants, true, 'varianterna kördes inte');
    assert.equal(nativeConfig.includeEvolved, true, 'evolutionens genom kördes inte');
    assert.equal(nativeConfig.mode, 'strategy', 'utan strategiläge delar strategierna en bok');
    assert.deepEqual([...nativeConfig.symbols].sort(), ['MES', 'MNQ']);
    // Kontraktsnycklarna måste nå motorn. Utan dem läser den sammanslaget och
    // kan få ambiguous_contract_ownership — noll barer, och ett tomt resultat
    // som ser ut som en marknad utan signaler.
    assert.deepEqual(nativeConfig.contractKeyByRoot,
      { MNQ: 'MNQ:1:2026-08-17', MES: 'MES:2:2026-08-17' });
    assert.equal(nativeConfig.from, '2026-08-18T13:00:00.000Z', 'fönstret byggdes på etiketten i stället för handelsdagen');
    assert.equal(executed.library.created, 3);
  }

  console.log('# replayQueueRunnerService tests passed.');
})();
