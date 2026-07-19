'use strict';

const {
  SESSION_IDS,
  buildFuturesSessionMetadata,
  getCmeEquityIndexFuturesSessionState,
} = require('./futuresMarketHoursService');
const futuresContractCatalog = require('./futuresContractCatalogService');

const STRATEGY_ID = 'mnq_globex_momentum_v1';
const STRATEGY_FAMILY = 'futures_globex_momentum';
const INSTRUMENT = 'MNQ';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_mnq_globex_momentum_producer',
});

const DEFAULT_CONFIG = Object.freeze({
  timeframe: '1m',
  lookback: 5,
  minClosedCandles: 5,
  momentumThresholdPoints: 12,
  staleAfterMs: 15 * 60 * 1000,
  maxExtensionRangeMultiple: 2.5,
  stopLossPct: 0.3,
  takeProfitPct: 0.6,
  riskReward: 2,
  requireVolume: false,
});

const OPEN_SESSION_IDS = new Set([
  SESSION_IDS.OVERNIGHT,
  SESSION_IDS.ASIA,
  SESSION_IDS.EUROPE,
  SESSION_IDS.US_PREMARKET,
  SESSION_IDS.US_RTH,
  SESSION_IDS.US_AFTER_HOURS,
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDataQuality(value, fallback = 'unknown') {
  const text = String(value || '').toLowerCase();
  if (text.includes('simulated') || text.includes('fallback')) return 'simulated';
  if (text === 'ib' || text.includes('ib_historical') || text.includes('ibkr') || text.includes('interactive_brokers')) return 'real';
  if (text.includes('real')) return 'real';
  if (text.includes('delayed')) return 'delayed';
  if (text.includes('import')) return 'imported';
  return fallback;
}

function normalizeInstrument(value) {
  if (value && typeof value === 'object') {
    return normalizeInstrument(value.root || value.symbol || value.instrument);
  }
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  return futuresContractCatalog.normalizeRoot(text, text) || text;
}

function canonicalDataSource(dataQuality) {
  if (dataQuality === 'real') return 'real_market_data';
  if (dataQuality === 'delayed') return 'delayed_market_data';
  if (dataQuality === 'simulated') return 'simulated_fallback';
  if (dataQuality === 'imported') return 'imported_market_data';
  return 'unknown_market_data';
}

function instrumentHintsFromCandles(candles = []) {
  const hints = new Set();
  for (const row of candles) {
    const hint = normalizeInstrument(row?.instrument || row?.root || row?.symbol || row?.contract?.root || row?.contract);
    if (hint) hints.add(hint);
  }
  return [...hints];
}

function sessionFields(sessionMetadata) {
  return {
    session: sessionMetadata?.session || 'Globex',
    sessionId: sessionMetadata?.sessionId || null,
    sessionLabel: sessionMetadata?.sessionLabel || null,
    exchangeTimezone: sessionMetadata?.exchangeTimezone || 'America/Chicago',
    exchangeLocalDate: sessionMetadata?.exchangeLocalDate || null,
    exchangeLocalTime: sessionMetadata?.exchangeLocalTime || null,
    isRth: sessionMetadata?.isRth ?? null,
    isMarketOpen: sessionMetadata?.isMarketOpen ?? null,
  };
}

function normalizeCandle(row = {}) {
  const timestamp = isoOrNull(
    row.timestamp
      || row.ts
      || row.t
      || row.closedAt
      || row.endTime
      || row.end
      || row.startTime,
  );
  const open = toNumber(row.open ?? row.o);
  const high = toNumber(row.high ?? row.h);
  const low = toNumber(row.low ?? row.l);
  const close = toNumber(row.close ?? row.c);
  const volume = toNumber(row.volume ?? row.v);
  const explicitOpen = row.closed === false
    || row.complete === false
    || row.incomplete === true
    || row.isClosed === false;
  const explicitClosed = row.closed === true
    || row.complete === true
    || row.incomplete === false
    || row.isClosed === true;

  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    closed: explicitClosed && !explicitOpen,
    explicitlyOpen: explicitOpen,
    source: row.source || row.dataSource || null,
    raw: row,
  };
}

function hasValidOhlc(candle) {
  if (!candle) return false;
  const values = [candle.open, candle.high, candle.low, candle.close];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return false;
  if (candle.high < candle.low) return false;
  if (candle.high < candle.open || candle.high < candle.close) return false;
  if (candle.low > candle.open || candle.low > candle.close) return false;
  return true;
}

function readCandles({
  candles = null,
  candleProvider = null,
  priceFeedService = null,
  feed = null,
  now = new Date(),
  config = DEFAULT_CONFIG,
} = {}) {
  if (Array.isArray(candles)) {
    return {
      candles,
      source: 'injected_candles',
      dataQuality: normalizeDataQuality(candles[0]?.dataSource || candles[0]?.source, 'unknown'),
      contract: null,
      instrumentHints: instrumentHintsFromCandles(candles),
      warnings: [],
    };
  }

  if (typeof candleProvider === 'function') {
    const result = candleProvider({
      symbol: INSTRUMENT,
      root: INSTRUMENT,
      timeframe: config.timeframe,
      limit: Math.max(config.minClosedCandles, config.lookback) + 5,
      now,
    });
    if (Array.isArray(result)) {
      return {
        candles: result,
        source: 'candle_provider',
        dataQuality: normalizeDataQuality(result[0]?.dataSource || result[0]?.source, 'unknown'),
        contract: null,
        instrumentHints: instrumentHintsFromCandles(result),
        warnings: [],
      };
    }
    return {
      candles: Array.isArray(result?.candles) ? result.candles : [],
      source: result?.source || 'candle_provider',
      dataQuality: normalizeDataQuality(result?.dataQuality || result?.source, 'unknown'),
      contract: result?.contract || null,
      instrumentHints: [
        ...instrumentHintsFromCandles(result?.candles || []),
        normalizeInstrument(result?.instrument || result?.root || result?.symbol || result?.contract?.root || result?.contract),
      ].filter(Boolean),
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    };
  }

  if (priceFeedService && typeof priceFeedService.getMnqCandles === 'function') {
    const result = priceFeedService.getMnqCandles({ now, timeframe: config.timeframe });
    return {
      candles: Array.isArray(result?.candles) ? result.candles : [],
      source: result?.source || 'price_feed_mnq_candles',
      dataQuality: normalizeDataQuality(result?.dataQuality || result?.source, 'unknown'),
      contract: result?.contract || null,
      instrumentHints: [
        ...instrumentHintsFromCandles(result?.candles || []),
        normalizeInstrument(result?.instrument || result?.root || result?.symbol || result?.contract?.root || result?.contract),
      ].filter(Boolean),
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    };
  }

  if (priceFeedService && typeof priceFeedService.getCandles === 'function') {
    const result = priceFeedService.getCandles(INSTRUMENT, { now, timeframe: config.timeframe });
    return {
      candles: Array.isArray(result?.candles) ? result.candles : [],
      source: result?.source || 'price_feed_candles',
      dataQuality: normalizeDataQuality(result?.dataQuality || result?.source, 'unknown'),
      contract: result?.contract || null,
      instrumentHints: [
        ...instrumentHintsFromCandles(result?.candles || []),
        normalizeInstrument(result?.instrument || result?.root || result?.symbol || result?.contract?.root || result?.contract),
      ].filter(Boolean),
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    };
  }

  const feedSource = feed?.feed?.source || feed?.source || null;
  return {
    candles: [],
    source: feedSource || 'missing_mnq_candles',
    dataQuality: normalizeDataQuality(feedSource, 'unknown'),
    contract: null,
    instrumentHints: [],
    warnings: ['runtime_has_quotes_only_no_mnq_candles'],
  };
}

function baseResult({
  now,
  sessionMetadata,
  dataQuality = 'unknown',
  blockedReason = null,
  signalState = 'blocked',
  direction = null,
  ok = false,
  warnings = [],
  parameters = DEFAULT_CONFIG,
  producerEvidence = {},
} = {}) {
  return {
    ok,
    strategyId: STRATEGY_ID,
    family: STRATEGY_FAMILY,
    strategyFamily: STRATEGY_FAMILY,
    instrument: INSTRUMENT,
    root: INSTRUMENT,
    producerType: 'futures_native',
    canonicalSignalReady: false,
    signal: null,
    direction,
    signalState,
    blockedReason,
    dataQuality,
    timestamp: nowIso(now),
    sessionMetadata,
    ...sessionFields(sessionMetadata),
    parameters: { ...parameters },
    warnings,
    producerEvidence,
    ...SAFETY,
  };
}

function buildCanonicalSignal({ result, latest, config, evidence, dataQuality }) {
  const signalTimestamp = latest.timestamp || result.timestamp;
  return {
    signalId: `${STRATEGY_ID}:${signalTimestamp}:${result.direction}`,
    strategyId: STRATEGY_ID,
    strategyName: 'MNQ Globex Momentum',
    family: STRATEGY_FAMILY,
    strategyFamily: STRATEGY_FAMILY,
    signalFamily: STRATEGY_FAMILY,
    signalSubtype: 'GLOBEX_MOMENTUM',
    symbol: INSTRUMENT,
    originalSymbol: INSTRUMENT,
    market: 'futures',
    marketType: 'futures',
    direction: result.direction,
    confidence: 0.72,
    entry: latest.close,
    entryPrice: latest.close,
    referencePrice: latest.close,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    riskReward: config.riskReward,
    timeframe: config.timeframe,
    status: 'ready',
    signalStatus: 'ready',
    source: 'futures_native_mnq_candles',
    signalSource: 'futures_native_mnq_candles',
    dataSource: canonicalDataSource(dataQuality),
    dataFreshness: dataQuality === 'real' ? 'LIVE' : String(dataQuality || 'unknown').toUpperCase(),
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    candleTimestamp: signalTimestamp,
    createdAt: signalTimestamp,
    timestamp: signalTimestamp,
    strategyLogicVersion: STRATEGY_ID,
    producerType: 'futures_native',
    producerEvidence: evidence,
    sessionMetadata: result.sessionMetadata,
  };
}

function createFuturesMnqGlobexMomentumProducerService(options = {}) {
  const defaultConfig = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const defaultCandleProvider = options.candleProvider || null;
  const defaultPriceFeedService = options.priceFeedService || null;

  function evaluate(input = {}) {
    const now = input.now instanceof Date ? input.now : new Date(input.now || new Date());
    if (Number.isNaN(now.getTime())) {
      return baseResult({
        now: new Date(),
        sessionMetadata: null,
        blockedReason: 'invalid_timestamp',
        signalState: 'blocked',
        parameters: defaultConfig,
      });
    }

    const config = { ...defaultConfig, ...(input.config || {}) };
    const evaluationSession = getCmeEquityIndexFuturesSessionState(now);
    const evaluationSessionMetadata = buildFuturesSessionMetadata(now);
    if (!evaluationSession.isOpen) {
      return baseResult({
        now,
        sessionMetadata: evaluationSessionMetadata,
        blockedReason: evaluationSession.sessionId === SESSION_IDS.MAINTENANCE_BREAK
          ? 'maintenance_break'
          : 'market_closed',
        signalState: 'blocked',
        parameters: config,
      });
    }
    if (!OPEN_SESSION_IDS.has(evaluationSession.sessionId)) {
      return baseResult({
        now,
        sessionMetadata: evaluationSessionMetadata,
        blockedReason: 'market_closed',
        signalState: 'blocked',
        parameters: config,
      });
    }

    const contract = futuresContractCatalog.getContract(INSTRUMENT);
    if (!contract) {
      return baseResult({
        now,
        sessionMetadata: evaluationSessionMetadata,
        blockedReason: 'missing_contract_mapping',
        signalState: 'blocked',
        parameters: config,
      });
    }

    const data = readCandles({
      candles: input.candles,
      candleProvider: input.candleProvider || defaultCandleProvider,
      priceFeedService: input.priceFeedService || defaultPriceFeedService,
      feed: input.feed,
      now,
      config,
    });
    const dataQuality = normalizeDataQuality(input.dataQuality || data.dataQuality || data.source, data.dataQuality || 'unknown');
    const warnings = [...(data.warnings || [])];
    const instrumentHints = [
      normalizeInstrument(input.instrument || input.root || input.symbol),
      ...(data.instrumentHints || []),
    ].filter(Boolean);
    const wrongInstrument = instrumentHints.find((hint) => hint !== INSTRUMENT);
    if (wrongInstrument) {
      return baseResult({
        now,
        sessionMetadata: evaluationSessionMetadata,
        dataQuality,
        blockedReason: 'wrong_instrument',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          expectedInstrument: INSTRUMENT,
          receivedInstrument: wrongInstrument,
          instrumentHints,
        },
      });
    }
    const normalized = (data.candles || [])
      .map(normalizeCandle)
      .filter((candle) => candle.timestamp)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    if (!normalized.length) {
      return baseResult({
        now,
        sessionMetadata: evaluationSessionMetadata,
        dataQuality,
        blockedReason: 'missing_mnq_data',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract,
          candleCount: 0,
        },
      });
    }

    const invalid = normalized.find((candle) => !hasValidOhlc(candle));
    if (invalid) {
      return baseResult({
        now,
        sessionMetadata: buildFuturesSessionMetadata(invalid.timestamp) || evaluationSessionMetadata,
        dataQuality,
        blockedReason: invalid.close == null ? 'missing_price' : 'invalid_ohlc',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract: data.contract || contract,
          invalidCandleTimestamp: invalid.timestamp,
        },
      });
    }

    const closedCandles = normalized.filter((candle) => candle.closed);
    const latestCandle = normalized[normalized.length - 1];
    if (!closedCandles.length && latestCandle?.explicitlyOpen) {
      return baseResult({
        now,
        sessionMetadata: buildFuturesSessionMetadata(latestCandle.timestamp) || evaluationSessionMetadata,
        dataQuality,
        blockedReason: 'open_candle_not_eligible',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract: data.contract || contract,
          latestCandleTimestamp: latestCandle.timestamp,
        },
      });
    }

    if (closedCandles.length < config.minClosedCandles || closedCandles.length < config.lookback) {
      return baseResult({
        now,
        sessionMetadata: buildFuturesSessionMetadata(latestCandle.timestamp) || evaluationSessionMetadata,
        dataQuality,
        blockedReason: closedCandles.length ? 'insufficient_candles' : 'open_candle_not_eligible',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract: data.contract || contract,
          closedCandlesAvailable: closedCandles.length,
          minClosedCandles: config.minClosedCandles,
          latestCandleTimestamp: latestCandle.timestamp,
        },
      });
    }

    const used = closedCandles.slice(-config.lookback);
    const latest = used[used.length - 1];
    const previous = used[used.length - 2] || used[0];
    const signalSessionMetadata = buildFuturesSessionMetadata(latest.timestamp) || evaluationSessionMetadata;
    const latestMs = Date.parse(latest.timestamp);
    const staleAgeMs = now.getTime() - latestMs;
    if (!Number.isFinite(staleAgeMs) || staleAgeMs < 0) {
      return baseResult({
        now,
        sessionMetadata: signalSessionMetadata,
        dataQuality,
        blockedReason: 'invalid_timestamp',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract: data.contract || contract,
          latestCandleTimestamp: latest.timestamp,
        },
      });
    }
    if (staleAgeMs > config.staleAfterMs) {
      return baseResult({
        now,
        sessionMetadata: signalSessionMetadata,
        dataQuality,
        blockedReason: 'stale_market_data',
        signalState: 'blocked',
        warnings,
        parameters: config,
        producerEvidence: {
          source: data.source,
          contract: data.contract || contract,
          latestCandleTimestamp: latest.timestamp,
          staleAgeMs,
          staleAfterMs: config.staleAfterMs,
        },
      });
    }

    const volumeMissing = used.some((candle) => candle.volume == null);
    if (volumeMissing) {
      if (config.requireVolume) {
        return baseResult({
          now,
          sessionMetadata: signalSessionMetadata,
          dataQuality,
          blockedReason: 'missing_volume',
          signalState: 'blocked',
          warnings,
          parameters: config,
          producerEvidence: {
            source: data.source,
            contract: data.contract || contract,
            latestCandleTimestamp: latest.timestamp,
          },
        });
      }
      warnings.push('missing_volume');
    }

    const ranges = used.map((candle) => candle.high - candle.low);
    const avgRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
    const latestRange = latest.high - latest.low;
    const netChangePoints = latest.close - used[0].close;
    const previousChangePoints = latest.close - previous.close;
    const extended = avgRange > 0 && latestRange > avgRange * config.maxExtensionRangeMultiple;
    const evidence = {
      source: 'futures_native_mnq_candles',
      dataSource: data.source,
      contract: data.contract || contract,
      lookback: config.lookback,
      closedCandlesUsed: used.length,
      closedCandlesAvailable: closedCandles.length,
      timeframe: config.timeframe,
      latestCandleTimestamp: latest.timestamp,
      latestClose: latest.close,
      previousClose: previous.close,
      netChangePoints,
      previousChangePoints,
      avgRange,
      latestRange,
      staleAgeMs,
      volumeAvailable: !volumeMissing,
    };

    let direction = null;
    let blockedReason = 'momentum_threshold_not_met';
    if (!extended && latest.close > previous.close && netChangePoints > config.momentumThresholdPoints) {
      direction = 'long';
      blockedReason = null;
    } else if (!extended && latest.close < previous.close && netChangePoints < -config.momentumThresholdPoints) {
      direction = 'short';
      blockedReason = null;
    } else if (extended) {
      blockedReason = 'latest_candle_extended';
    }

    if (!direction) {
      return baseResult({
        now,
        sessionMetadata: signalSessionMetadata,
        dataQuality,
        blockedReason,
        signalState: 'no_signal',
        ok: true,
        warnings,
        parameters: config,
        producerEvidence: evidence,
      });
    }

    const result = baseResult({
      now,
      sessionMetadata: signalSessionMetadata,
      dataQuality,
      direction,
      blockedReason: null,
      signalState: 'signal',
      ok: true,
      warnings,
      parameters: config,
      producerEvidence: evidence,
    });
    result.signal = buildCanonicalSignal({
      result,
      latest,
      config,
      evidence,
      dataQuality,
    });
    result.canonicalSignalReady = true;
    return result;
  }

  return {
    SAFETY,
    STRATEGY_ID,
    STRATEGY_FAMILY,
    INSTRUMENT,
    DEFAULT_CONFIG,
    evaluate,
  };
}

const defaultFuturesMnqGlobexMomentumProducerService = createFuturesMnqGlobexMomentumProducerService();

module.exports = {
  SAFETY,
  STRATEGY_ID,
  STRATEGY_FAMILY,
  INSTRUMENT,
  DEFAULT_CONFIG,
  normalizeCandle,
  createFuturesMnqGlobexMomentumProducerService,
  defaultFuturesMnqGlobexMomentumProducerService,
};
