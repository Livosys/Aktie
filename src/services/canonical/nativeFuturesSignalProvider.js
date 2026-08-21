'use strict';

// Native Futures Signal Provider
//
// Phase 3 only: collect already-formed Native Futures Signals and enforce the
// Phase 1 contract boundary. This module is not wired into scanner, strategy,
// candidate building, execution, broker, ledger, or UI.

const {
  createNativeFuturesSignal,
  validateNativeFuturesSignal,
  SAFETY: CONTRACT_SAFETY,
} = require('./nativeFuturesSignalContract');
const {
  createNativeFuturesScanner,
} = require('../nativeFuturesScannerService');
const strategyRegistry = require('../nativeFuturesStrategyRegistryService');
const {
  adaptNativeFuturesStrategyDecision,
} = require('./nativeFuturesCanonicalAdapter');
const {
  getCmeEquityIndexFuturesSessionState,
} = require('../futuresMarketHoursService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'native_futures_signal_provider',
});

// Strategierna hämtas ur Strategy Registry, som är den enda listan. Varje
// snapshot utvärderas av samtliga; en strategi som inte triggar returnerar
// NO_SIGNAL och bidrar med noll signaler. Ordningen påverkar bara i vilken
// ordning signaler köas, inte om de skapas.
//
// Listan läses vid varje anrop, inte en gång vid inläsning. Det är det som gör
// att en nyregistrerad strategi dyker upp i både Paper och Replay utan att en
// enda rad i någon av dem ändras.
//
// includeVariants avgör om registrets parametervarianter räknas med. Paper
// kallar utan flaggan och kör därför exakt de åtta modulerna, som förut.
// Replay ber om varianterna. Valet ligger hos kompositionsroten, inte här.
function strategyEvaluators(includeVariants = false, includeEvolved = false, includeResearch = false, includeBase = true, researchCycle = null, genomeHashes = []) {
  return strategyRegistry.listStrategyEvaluators({
    includeVariants, includeEvolved, includeResearch, includeBase, researchCycle, genomeHashes,
  });
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value?.signals)) return value.signals.filter(Boolean);
  return [];
}

function signalIdOf(signal = {}) {
  return signal?.signalId || signal?.id || null;
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function reject(row, reason, errors = [], index = null) {
  return {
    index,
    signalId: signalIdOf(row),
    reason,
    errors: errors.length ? [...errors] : [reason],
    source: SAFETY.source,
  };
}

function readSourceSignals(signalReader, context = {}) {
  if (typeof signalReader !== 'function') return [];
  return signalReader(context);
}

function feedQuoteFor(feed = {}, symbol) {
  const key = upper(symbol);
  return (Array.isArray(feed?.quotes) ? feed.quotes : []).find((row) => {
    const root = upper(row?.root || row?.symbol || row?.instrument);
    return root === key || String(root || '').startsWith(key);
  }) || null;
}

function normalizeContractFrom(source = {}, symbol) {
  if (!source || typeof source !== 'object') return null;
  const root = upper(source.root || source.symbol || symbol);
  const expiry = safeString(source.expiry || source.lastTradeDateOrContractMonth);
  return {
    root,
    symbol: upper(source.symbol || root),
    localSymbol: upper(source.localSymbol),
    conId: source.conId,
    secType: upper(source.secType || 'FUT'),
    exchange: upper(source.exchange || 'CME'),
    currency: upper(source.currency || 'USD'),
    expiry,
    lastTradeDateOrContractMonth: expiry,
  };
}

function nativeDecisionInput(decision = {}) {
  return {
    decision: decision.decision,
    direction: decision.direction,
    entryPrice: decision.entryPrice,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    riskReward: decision.riskReward,
    reason: decision.reason,
    strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion,
    symbol: decision.symbol,
    timeframe: decision.timeframe,
    signalTimestamp: decision.signalTimestamp,
    marketSnapshotTimestamp: decision.marketSnapshotTimestamp,
  };
}

function defaultNativeFuturesSignalReader({
  now = new Date(),
  priceFeedService = null,
  feed = null,
  symbols = ['MNQ', 'MES'],
  timeframe = '2m',
  // Färskhetsfönstret för quotes. Live vill ha sekunder; en historisk feed
  // härleder sin quote ur senast stängda candle och är därför alltid minst en
  // bar gammal. Utan den här parametern skulle varje replay-rad fastna på
  // stale_market_data och kedjan aldrig utvärderas.
  //
  // Motorn lär sig INTE vilken feed den har — det är kompositionsroten som
  // sätter fönstret, precis som den väljer feed.
  maxQuoteAgeMs = null,
  // Ren observationskrok för Replay-rapporten (Decision Monitor-utfall per
  // strategi och symbol). Anropas efter att beslutet är fattat och kan därför
  // inte påverka det. Utelämnas i live och paper.
  onDecision = null,
  // Kör även registrets parametervarianter av de åtta modulerna. Av som
  // standard: paper-vägen ska bete sig oförändrat.
  includeVariants = false,
  // Kör även släktträdets muterade genom. Av som standard, av samma skäl.
  includeEvolved = false,
  // Kör även research-hypoteserna. Av som standard — de får ALDRIG nå paper,
  // och paper-vägen anropar utan flaggor.
  includeResearch = false,
  // Av-knapp för de åtta produktionsmodulerna. På som standard; stängs bara av
  // för en isolerad research-batch.
  includeBase = true,
  // Begränsar research till en forskningscykel. null = samtliga.
  researchCycle = null,
  // Genom som körningen UTTRYCKLIGEN begärt, oavsett EVOLVED_LIMIT. Ett
  // replay-jobb som skapades för ett visst genom måste kunna garantera att just
  // det genomet körs — annars svarar körningen på en annan fråga än den ställda.
  genomeHashes = [],
} = {}) {
  if (!priceFeedService && !feed) return [];
  const observer = typeof onDecision === 'function' ? onDecision : null;
  const candleCache = new Map();
  const quoteCache = new Map();

  function candlesFor(symbol) {
    const key = upper(symbol);
    if (!candleCache.has(key)) {
      const result = priceFeedService && typeof priceFeedService.getCandles === 'function'
        // 250 ljus: sma200 kräver 200, bbwPct120 140 och atrPct120 136. Med 50 kunde
        // bara momentumstrategin (ett ljus) räknas. Feeden håller 4000 1m-bars i minnet
        // efter backfill, så fönstret finns redan — det efterfrågades bara inte.
        ? priceFeedService.getCandles(key, { now, timeframe, limit: 250 })
        : null;
      candleCache.set(key, result || { candles: [] });
    }
    return candleCache.get(key);
  }

  function quoteFor(symbol) {
    const key = upper(symbol);
    if (!quoteCache.has(key)) {
      quoteCache.set(
        key,
        feedQuoteFor(feed, key)
          || (priceFeedService && typeof priceFeedService.getQuote === 'function'
            ? priceFeedService.getQuote(key, now)
            : null)
      );
    }
    return quoteCache.get(key);
  }

  const scanner = createNativeFuturesScanner({
    symbols,
    timeframe,
    // Number(null) är 0 och Number.isFinite(0) är true — utan null-kontrollen
    // hade utelämnad parameter satt fönstret till noll och gjort varje quote
    // stale. Endast ett positivt tal får åsidosätta scannerns default.
    ...(maxQuoteAgeMs != null && Number(maxQuoteAgeMs) > 0
      ? { maxQuoteAgeMs: Number(maxQuoteAgeMs) }
      : {}),
    contractReader: ({ symbol }) => {
      const candleResult = candlesFor(symbol);
      return normalizeContractFrom(candleResult?.contract || quoteFor(symbol), symbol);
    },
    candleReader: ({ symbol }) => {
      const candleResult = candlesFor(symbol);
      return Array.isArray(candleResult?.candles) ? candleResult.candles : [];
    },
    quoteReader: ({ symbol }) => quoteFor(symbol),
    sessionReader: () => getCmeEquityIndexFuturesSessionState(now),
  });

  const scan = scanner.scan({ now });
  const signals = [];
  for (const snapshot of scan.rows || []) {
    for (const { strategyId, evaluate } of strategyEvaluators(includeVariants, includeEvolved, includeResearch, includeBase, researchCycle, genomeHashes)) {
      const decision = evaluate(snapshot, { now });
      const adapted = adaptNativeFuturesStrategyDecision(nativeDecisionInput(decision), {
        marketSnapshot: snapshot,
        now,
      });
      // Observationskrok. Paper skickar inte in någon; Replay samlar upp varje
      // beslut för sin rapport. Kroken får aldrig påverka utfallet — den ser
      // resultatet efter att det redan är bestämt.
      if (observer) {
        observer({
          now, strategyId, snapshot, decision,
          accepted: adapted.ok === true && Boolean(adapted.signal),
          adapterReason: adapted.reason || null,
          adapterErrors: adapted.errors || [],
          signal: adapted.signal || null,
        });
      }
      if (adapted.ok === true && adapted.signal) signals.push(adapted.signal);
    }
  }
  return signals;
}

function createNativeFuturesSignalProvider(options = {}) {
  const staticSignals = Array.isArray(options.signals) ? [...options.signals] : null;
  const signalReader = typeof options.signalReader === 'function'
    ? options.signalReader
    : (staticSignals
      ? (() => staticSignals)
      : defaultNativeFuturesSignalReader);

  function collectNativeFuturesSignals({ now = new Date(), priceFeedService = null, feed = null } = {}) {
    const generatedAt = nowIso(now);
    const accepted = [];
    const rejected = [];
    let rawRows = [];

    try {
      rawRows = safeArray(readSourceSignals(signalReader, { now, priceFeedService, feed }));
    } catch (err) {
      return {
        ok: false,
        generatedAt,
        signals: [],
        rejected: [reject(null, 'signal_reader_error', [err && err.message ? err.message : String(err)])],
        stats: {
          inputSignals: 0,
          acceptedSignals: 0,
          rejectedSignals: 1,
        },
        ...SAFETY,
      };
    }

    rawRows.forEach((row, index) => {
      const rawValidation = validateNativeFuturesSignal(row, { now });
      if (rawValidation.ok !== true) {
        rejected.push(reject(row, 'native_futures_contract_rejected', rawValidation.errors, index));
        return;
      }

      const signal = createNativeFuturesSignal(row);
      const normalizedValidation = validateNativeFuturesSignal(signal, { now });
      if (normalizedValidation.ok !== true) {
        rejected.push(reject(row, 'native_futures_normalized_contract_rejected', normalizedValidation.errors, index));
        return;
      }

      accepted.push(signal);
    });

    return {
      ok: rejected.length === 0,
      generatedAt,
      signals: accepted,
      rejected,
      stats: {
        inputSignals: rawRows.length,
        acceptedSignals: accepted.length,
        rejectedSignals: rejected.length,
      },
      contractSource: CONTRACT_SAFETY.source,
      ...SAFETY,
    };
  }

  function getNativeFuturesSignals({ now = new Date(), priceFeedService = null, feed = null } = {}) {
    return collectNativeFuturesSignals({ now, priceFeedService, feed }).signals;
  }

  return {
    SAFETY,
    collectNativeFuturesSignals,
    getNativeFuturesSignals,
  };
}

const defaultNativeFuturesSignalProvider = createNativeFuturesSignalProvider();

module.exports = {
  SAFETY,
  createNativeFuturesSignalProvider,
  defaultNativeFuturesSignalProvider,
  _internal: {
    defaultNativeFuturesSignalReader,
    normalizeContractFrom,
    nativeDecisionInput,
    feedQuoteFor,
  },
};
