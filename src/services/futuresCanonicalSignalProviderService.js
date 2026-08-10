'use strict';

const crypto = require('crypto');

const {
  getLatestResults,
  getStockFeedStatus,
  getLiveCandlesDebug: getStockLiveCandlesDebug,
} = require('../scanner/scheduler');
const {
  getCryptoResults,
  getLiveCandlesDebug: getCryptoLiveCandlesDebug,
} = require('../scanner/cryptoScheduler');
const { buildDecisionMonitor } = require('../scanner/decisionMonitor');
const decisionMonitorProducerContext = require('./decisionMonitorProducerContextService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_canonical_signal_provider',
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function signalIdOf(signal = {}) {
  return safeString(signal.signalId)
    || safeString(signal.signal_id)
    || null;
}

function lifecycleIdFromSignalId(signalId) {
  const id = safeString(signalId);
  if (!id) return null;
  return `signal_lifecycle_${crypto.createHash('sha1').update(id).digest('hex').slice(0, 24)}`;
}

function lifecycleIdOf(signal = {}) {
  return safeString(signal.lifecycleId)
    || safeString(signal.lifecycle_id)
    || safeString(signal.metadata?.lifecycleId)
    || safeString(signal.metadata?.lifecycle_id)
    || lifecycleIdFromSignalId(signalIdOf(signal));
}

function withLifecycleId(signal = {}) {
  if (!signal || typeof signal !== 'object') return signal;
  const lifecycleId = lifecycleIdOf(signal);
  if (!lifecycleId) return signal;
  if (signal.lifecycleId === lifecycleId) return signal;
  return { ...signal, lifecycleId };
}

// Måste bygga monitorn med SAMMA indata som paperTradingAgent. Utan
// liveCandleDebugBySymbol ser latestClosedCandleMeta() noll candles för varje
// symbol och sätter closedCandleConfirmed=false / source='missing_live_candle'.
// Varje entry contract kräver closed_candle_confirmation, så futures-vägen
// blockerades på 100% av kandidaterna oavsett marknadsläge.
function defaultSignalReader() {
  const stockResults = decisionMonitorProducerContext.addDaytradeSignals(getLatestResults() || []);
  const cryptoResults = decisionMonitorProducerContext.addDaytradeSignals(getCryptoResults() || []);
  const liveCandleDebugBySymbol = decisionMonitorProducerContext.buildLiveCandleDebugMap([
    ...stockResults.map((row) => ({ ...row, _market: 'stock' })),
    ...cryptoResults.map((row) => ({ ...row, _market: 'crypto' })),
  ], {
    stockReader: getStockLiveCandlesDebug,
    cryptoReader: getCryptoLiveCandlesDebug,
  });
  const dm = buildDecisionMonitor({
    stockResults,
    cryptoResults,
    liveCandleDebugBySymbol,
    stockFeedStatus: typeof getStockFeedStatus === 'function' ? getStockFeedStatus() : null,
  });
  return safeArray(dm?.candidates);
}

function producerIdOf(producer, result = null, index = 0) {
  return safeString(result?.strategyId)
    || safeString(producer?.STRATEGY_ID)
    || safeString(producer?.id)
    || `signal_provider_${index + 1}`;
}

function summarizeProducerResult({ producer, result, error = null, index = 0 }) {
  const providerId = producerIdOf(producer, result, index);
  const signalReady = Boolean(result?.ok === true && result?.signal && typeof result.signal === 'object');
  return {
    providerId,
    ok: error ? false : result?.ok === true,
    signals: signalReady ? 1 : 0,
    noSignal: error ? 0 : (result?.signalState === 'no_signal' ? 1 : 0),
    blocked: Boolean(error || result?.ok === false || result?.signalState === 'blocked'),
    blockedReason: error?.message || result?.blockedReason || null,
    signalState: result?.signalState || (signalReady ? 'signal' : null),
    direction: result?.direction || null,
    dataQuality: result?.dataQuality || null,
    latestSignalTimestamp: result?.producerEvidence?.latestCandleTimestamp || result?.timestamp || null,
    result: result || null,
    ...SAFETY,
  };
}

function createFuturesCanonicalSignalProviderService(options = {}) {
  const readSignals = typeof options.signalReader === 'function' ? options.signalReader : defaultSignalReader;
  const producers = Array.isArray(options.signalProducers)
    ? options.signalProducers.filter(Boolean)
    : [];

  function collectProducerSignals({ now = new Date(), priceFeedService = null, feed = null } = {}) {
    const signals = [];
    const providerResults = {};

    producers.forEach((producer, index) => {
      let result = null;
      let error = null;
      try {
        if (!producer || typeof producer.evaluate !== 'function') {
          throw new Error('signal_provider_missing_evaluate');
        }
        result = producer.evaluate({
          now,
          priceFeedService,
          feed,
        });
        if (result?.ok === true && result.signal && typeof result.signal === 'object') {
          result = {
            ...result,
            signal: withLifecycleId(result.signal),
          };
          signals.push(result.signal);
        }
      } catch (err) {
        error = err;
      }
      const summary = summarizeProducerResult({ producer, result, error, index });
      providerResults[summary.providerId] = summary;
    });

    return { signals, providerResults };
  }

  function getCanonicalSignals({ now = new Date(), priceFeedService = null, feed = null } = {}) {
    const readerSignals = safeArray(readSignals({ now, priceFeedService, feed })).map(withLifecycleId);
    const producerOutput = collectProducerSignals({ now, priceFeedService, feed });
    const signals = [
      ...readerSignals,
      ...producerOutput.signals,
    ];

    return {
      ok: true,
      generatedAt: nowIso(now),
      signalInputs: signals,
      signals,
      providerResults: producerOutput.providerResults,
      stats: {
        signalInputsRead: signals.length,
        readerSignalsRead: readerSignals.length,
        providerSignalsRead: producerOutput.signals.length,
        providersEvaluated: producers.length,
      },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    getCanonicalSignals,
  };
}

const defaultFuturesCanonicalSignalProviderService = createFuturesCanonicalSignalProviderService();

module.exports = {
  SAFETY,
  createFuturesCanonicalSignalProviderService,
  defaultFuturesCanonicalSignalProviderService,
};
