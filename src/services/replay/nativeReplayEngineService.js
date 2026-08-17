'use strict';

// ── Native Replay Engine ─────────────────────────────────────────────────────
//
// Replay är inte ett eget system. Det är Paper Trading med klockan flyttad.
//
// Den här modulen innehåller därför INGEN handelslogik. Den innehåller en
// klocka och en bokföring. Varje beslut som fattas under en körning fattas av
// exakt samma moduler som fattar det i drift:
//
//   HistoricalPriceFeed      historicalPriceFeedService      (samma PriceFeed-kontrakt som live)
//     ↓
//   Native Scanner           nativeFuturesScannerService     (via signal-providern)
//     ↓
//   Decision Monitor         scanner/decisionMonitor         (inuti varje evaluator)
//     ↓
//   Canonical Adapter        nativeFuturesCanonicalAdapter   (inuti signal-providern)
//     ↓
//   Broker Risk Engine       ibPaperBrokerRiskService        (samma funktion som orchestratorn)
//     ↓
//   Fill Engine              fillEngineInterface             (utbytbar implementation)
//     ↓
//   Trade Ledger             tradeLedgerService
//     ↓
//   Performance Statistics   ledgerns summary + fillReportService
//     ↓
//   Strategy Score           strategyScoreV1Service
//
// ── Vad motorn INTE vet ──────────────────────────────────────────────────────
//
// Vilka strategier som finns. Den frågar aldrig efter en strategi, importerar
// aldrig en, och nämner ingen vid namn. Signal-providern hämtar dem ur Strategy
// Registry vid varje anrop, så en nyregistrerad strategi körs automatiskt.
//
// ── En avvikelse som redovisas i stället för att döljas ──────────────────────
//
// Produktionens native-väg går INTE genom Execution Readiness / entry contract:
// orchestratorn sätter bypassedAsProductionGate: true och går rakt från
// kandidat till Broker Risk (ibPaperExecutionOrchestratorService.js:963-975).
// Replay gör likadant. Att lägga in grinden här hade gjort Replay strängare än
// Paper, vilket är samma fel som att göra den mildare — bara åt andra hållet.
// När bypassen tas bort i drift tas den bort på ett ställe och gäller båda.
//
// Deterministisk: ingen Math.random, ingen Date.now, ingen fil-IO utanför
// datalagret, ingen broker. Samma indata ger samma RunResult varje gång.

const historicalFeedModule = require('../historicalPriceFeedService');
const signalProvider = require('../canonical/nativeFuturesSignalProvider');
const strategyRegistry = require('../nativeFuturesStrategyRegistryService');
const brokerRiskService = require('../ibPaperBrokerRiskService');
const fillEngineInterface = require('../execution/fillEngineInterface');
const simulatedFill = require('../execution/simulatedFillEngine');
const bracketExit = require('../execution/bracketExitResolver');
const tradeLedgerModule = require('../trade/tradeLedgerService');
const coverage = require('../../data/marketDataCoverage');

const { defaultNativeFuturesSignalReader } = signalProvider._internal;

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  source: 'native_replay_engine',
});

const ENGINE_VERSION = 'native-replay-engine-v1';

const DEFAULTS = Object.freeze({
  symbols: ['MNQ', 'MES'],
  timeframe: '2m',
  quantity: 1,
  orderType: 'MKT',
  executionTarget: 'ibkr_paper',
  // Hur länge en öppen position får leva innan fönstret tvingar en stängning.
  exitWindowMinutes: 240,
  // Quote-fönstret. En härledd quote är per konstruktion minst en bar gammal;
  // utan detta fastnar varje rad på stale_market_data. Sätts av
  // kompositionsroten, aldrig av motorn nedanför.
  maxQuoteAgeMs: 2 * 60 * 1000,
});

const TIMEFRAME_MS = Object.freeze({ '1m': 60000, '2m': 120000, '5m': 300000 });

function iso(value) {
  return new Date(value).toISOString();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function createNativeReplayEngine(options = {}) {
  const feed = options.feed || historicalFeedModule.createHistoricalPriceFeedService();
  const fillEngine = fillEngineInterface.assertFillEngine(
    options.fillEngine || simulatedFill.createSimulatedFillEngine(),
    'nativeReplayEngine.fillEngine',
  );
  const signalReader = typeof options.signalReader === 'function'
    ? options.signalReader
    : defaultNativeFuturesSignalReader;
  const brokerRisk = options.brokerRisk || brokerRiskService;
  const createLedger = options.createLedger || tradeLedgerModule.createTradeLedger;

  // Barer efter beslutet. Feedens exekveringssidiga anrop, aldrig getCandles —
  // getCandles lämnar per konstruktion aldrig ut framtiden.
  function barsForFill(root, fromIso, minutes) {
    if (typeof feed.getBarsBetween !== 'function') return [];
    const fromMs = new Date(fromIso).getTime();
    return feed.getBarsBetween(root, fromIso, iso(fromMs + minutes * 60 * 1000));
  }

  /**
   * Kör en replay.
   *
   * @returns {object} RunResult — se buildRunResult längst ned
   */
  function run(config = {}) {
    const symbols = (config.symbols || DEFAULTS.symbols).map((s) => String(s).toUpperCase());
    const timeframe = config.timeframe || DEFAULTS.timeframe;
    const stepMs = TIMEFRAME_MS[timeframe];
    if (!stepMs) throw new Error(`replay_unsupported_timeframe:${timeframe}`);

    const quantity = num(config.quantity) || DEFAULTS.quantity;
    const orderType = config.orderType || DEFAULTS.orderType;
    const executionTarget = config.executionTarget || DEFAULTS.executionTarget;
    const exitWindowMinutes = num(config.exitWindowMinutes) || DEFAULTS.exitWindowMinutes;
    const maxQuoteAgeMs = num(config.maxQuoteAgeMs) || DEFAULTS.maxQuoteAgeMs;

    // Täckningen kontrolleras INNAN körningen. En replay som tyst tar slut
    // mitt i perioden ser ut som en marknad utan signaler.
    const dataCoverage = coverage.coverageForRange({
      roots: symbols, from: config.from, to: config.to,
    });
    const startMs = new Date(config.from).getTime();
    const requestedEndMs = new Date(config.to).getTime();
    const endMs = dataCoverage.effectiveTo
      ? Math.min(requestedEndMs, new Date(dataCoverage.effectiveTo).getTime())
      : requestedEndMs;

    const ledger = createLedger();
    const decisions = [];
    const riskBlocks = [];
    const unfilledEntries = [];
    const rejectedSignals = [];
    // tradeId → { exitAtMs, exit, reason } — utgången löses vid entry men
    // bokförs först när klockan passerar den, så att positionen upptar sin
    // plats i riskmotorn under hela sin livstid precis som i drift.
    const pendingExits = new Map();

    let ticks = 0;
    let signalsGenerated = 0;
    const seenSignalIds = new Set();
    const candlesBySymbol = Object.fromEntries(symbols.map((s) => [s, []]));

    for (let ms = startMs; ms <= endMs; ms += stepMs) {
      const now = new Date(ms);
      ticks += 1;

      // 1. Stäng positioner vars utgång ligger bakom klockan. Måste ske FÖRE
      //    nya signaler, annars kan en stängd position blockera en ny entry.
      for (const [tradeId, pending] of [...pendingExits.entries()]) {
        if (pending.exitAtMs > ms) continue;
        ledger.close(tradeId, { exit: pending.exit, reason: pending.reason, closedAt: iso(pending.exitAtMs) });
        pendingExits.delete(tradeId);
      }

      // 2. Native Scanner → Decision Monitor → Canonical Adapter.
      //    Ett enda anrop. Exakt samma funktion som paper-vägen använder.
      const signals = signalReader({
        now,
        priceFeedService: feed,
        symbols,
        timeframe,
        maxQuoteAgeMs,
        onDecision: (event) => {
          decisions.push({
            at: iso(now),
            symbol: event.snapshot?.symbol || null,
            strategyId: event.strategyId,
            decision: event.decision?.decision || null,
            direction: event.decision?.direction || null,
            reason: event.decision?.reason || null,
            snapshotStatus: event.snapshot?.status || null,
            accepted: event.accepted,
            adapterReason: event.adapterReason,
          });
          if (!event.accepted && event.decision?.decision === 'SIGNAL') {
            rejectedSignals.push({
              at: iso(now),
              strategyId: event.strategyId,
              reason: event.adapterReason,
              errors: event.adapterErrors,
            });
          }
        },
      });

      // Candles sparas en gång per symbol för marknadsklassificeringen.
      if (ticks === 1 || ms + stepMs > endMs) {
        for (const symbol of symbols) {
          const result = feed.getCandles(symbol, { now, timeframe, limit: 250 });
          if (result?.candles?.length) candlesBySymbol[symbol] = result.candles;
        }
      }

      signalsGenerated += signals.length;

      // 3. Broker Risk → Fill Engine → Trade Ledger, per signal.
      for (const signal of signals) {
        if (seenSignalIds.has(signal.signalId)) continue;
        seenSignalIds.add(signal.signalId);

        const root = String(signal.symbol || '').toUpperCase();
        const quote = feed.getQuote(root, now);

        const risk = brokerRisk.evaluateBrokerRisk({
          executionTarget,
          root,
          quantity,
          orderType,
          stopLossPrice: signal.stopLoss,
          quote: quote ? { ...quote, updatedAt: quote.timestamp } : null,
          openOrders: [],
          positions: ledger.brokerPositionsView(),
          accountSummary: replayAccountSummary(ledger, now, executionTarget),
          reconciliation: null,
          now,
        });
        const partition = brokerRisk.partitionBlockers(risk);

        if (!partition.orderRiskAllowed) {
          riskBlocks.push({
            at: iso(now),
            signalId: signal.signalId,
            strategyId: signal.strategyId,
            symbol: root,
            blockers: partition.orderRiskBlockers,
            connectivityBlockers: partition.connectivityBlockers,
          });
          continue;
        }

        // Entry. expectedPrice är strategins pris — det AI senare optimerar mot.
        const entryBars = barsForFill(root, iso(now), exitWindowMinutes);
        const side = String(signal.direction).toUpperCase() === 'SHORT' ? 'sell' : 'buy';
        const entryFill = fillEngine.fill({
          orderId: `${signal.signalId}:entry`,
          symbol: root,
          side,
          type: 'market',
          quantity,
          expectedPrice: num(signal.entryPrice),
          timestamp: iso(now),
        }, { bars: entryBars });

        if (entryFill.status !== fillEngineInterface.FILL_STATUS.FILLED) {
          unfilledEntries.push({
            at: iso(now),
            signalId: signal.signalId,
            strategyId: signal.strategyId,
            symbol: root,
            reason: entryFill.reason,
          });
          continue;
        }

        const taxonomy = strategyRegistry.signalTaxonomyFor(signal.strategyId);
        const openedAt = entryFill.fills[0]?.timestamp || iso(now);
        const trade = ledger.open({
          signalId: signal.signalId,
          strategyId: signal.strategyId,
          candidateId: signal.candidateId || signal.signalId,
          signalFamily: taxonomy.signalFamily,
          signalSubtype: taxonomy.signalSubtype,
          symbol: root,
          direction: signal.direction,
          contracts: quantity,
          entry: {
            expectedPrice: entryFill.expectedPrice,
            executedPrice: entryFill.executedPrice,
            timestamp: openedAt,
            fillDelayMs: entryFill.fillDelayMs,
            slippage: entryFill.slippage,
            spread: entryFill.spread,
            status: entryFill.status,
            engine: entryFill.engine,
          },
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          openedAt,
        });

        // Utgången löses direkt mot barerna efter entry, men bokförs först när
        // klockan når dit (steg 1 ovan).
        const exitBars = barsForFill(root, openedAt, exitWindowMinutes);
        const resolved = bracketExit.resolveBracketExit({
          tradeId: trade.tradeId,
          symbol: root,
          side: trade.side,
          contracts: quantity,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          openedAt,
        }, { bars: exitBars, fillEngine });

        if (resolved.exit) {
          pendingExits.set(trade.tradeId, {
            exitAtMs: new Date(resolved.exit.timestamp).getTime(),
            exit: resolved.exit,
            reason: resolved.reason,
          });
        }
      }
    }

    // Kvarvarande öppna positioner stängs på sin lösta utgång även om klockan
    // inte hann dit. En öppen position får aldrig försvinna ur statistiken.
    for (const [tradeId, pending] of pendingExits.entries()) {
      ledger.close(tradeId, { exit: pending.exit, reason: pending.reason, closedAt: iso(pending.exitAtMs) });
    }

    return {
      config: {
        from: iso(startMs),
        to: iso(requestedEndMs),
        effectiveTo: iso(endMs),
        symbols, timeframe, quantity, orderType, executionTarget,
        exitWindowMinutes, maxQuoteAgeMs,
        fillEngine: fillEngine.describe(),
        // Strategierna LISTAS för spårbarhet, men motorn har aldrig frågat
        // efter dem — providern hämtade dem ur registret.
        strategiesFromRegistry: strategyRegistry.listStrategyEvaluators().map((row) => row.strategyId),
      },
      dataCoverage,
      ticks,
      counts: {
        signalsGenerated,
        uniqueSignals: seenSignalIds.size,
        signalsRejectedByContract: rejectedSignals.length,
        riskBlocked: riskBlocks.length,
        unfilledEntries: unfilledEntries.length,
        trades: ledger.closedTrades().length,
        openAtEnd: ledger.openTrades().length,
      },
      decisions,
      rejectedSignals,
      riskBlocks,
      unfilledEntries,
      trades: ledger.all(),
      tradesByStrategy: ledger.byStrategy(),
      performance: ledger.summary(),
      candlesBySymbol,
      engineVersion: ENGINE_VERSION,
      ...SAFETY,
    };
  }

  return { SAFETY, ENGINE_VERSION, run, feed, fillEngine };
}

// Kontosammanfattning för replay. Ärligt märkt: kontot är körningen själv.
// realizedPnl matas in på riktigt, vilket gör att dagsförlustgränsen i
// riskmotorn faktiskt fungerar under en replay.
//
// OBS en enhetsblandning som ÄRVS från drift och inte uppfinns här: gränsen
// heter maxDailyLossSek medan realizedPnl kommer i USD, både från IB och
// härifrån. Replay speglar driften i stället för att tyst räkna om — annars
// hade replay och paper haft olika gränser.
function replayAccountSummary(ledger, now, executionTarget) {
  const summary = ledger.summary();
  return {
    ok: true,
    generatedAt: iso(now),
    cacheAgeMs: 0,
    account: {
      accountIdMasked: 'REPLAY',
      classification: executionTarget === 'ibkr_live' ? 'live_or_unknown' : 'paper',
      realizedPnl: summary.netPnlUsd ?? 0,
      unrealizedPnl: 0,
    },
  };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  DEFAULTS,
  createNativeReplayEngine,
  _internal: { replayAccountSummary },
};
