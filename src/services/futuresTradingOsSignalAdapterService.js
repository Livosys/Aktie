'use strict';

const crypto = require('crypto');

const { getRiskProfile } = require('../markets/marketProfiles');
const { buildFuturesSessionMetadata } = require('./futuresMarketHoursService');
const strategyReadinessService = require('./strategyReadinessService');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'trading_os_signal_adapter',
});

const SOURCE = 'trading_os_signal_adapter';
const NATIVE_FUTURES_CANDIDATE_SOURCE = 'native_futures_candidate_adapter';
const DEFAULT_TIMEFRAME = '2m';
const MICRO_FUTURES_ROOTS = new Set(['MNQ', 'MES']);
const FUTURES_ROOT_ALIASES = Object.freeze({
  MNQ: 'MNQ',
  NQ: 'MNQ',
  MES: 'MES',
  ES: 'MES',
});

const NASDAQ_SYMBOLS = new Set([
  'QQQ',
  'NDX',
  'NASDAQ',
  'NASDAQ100',
  'NAS100',
  'NQ',
  'MNQ',
  'TQQQ',
  'SQQQ',
  'NVDA',
  'AMD',
  'TSLA',
  'AAPL',
  'MSFT',
  'AMZN',
  'META',
  'NFLX',
  'GOOGL',
]);

const SP500_SYMBOLS = new Set([
  'SPY',
  'SPX',
  'SPX500',
  'S&P500',
  'S&P 500',
  'ES',
  'MES',
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function safeBool(value) {
  return value == null ? null : value === true;
}

// Entry contracts (paperStrategyEntryContractService) kräver samma bekräftelse-
// evidens som aktie-paper-vägen redan får från decisionMonitor: 2m-bekräftelse,
// EMA-/VWAP-kontext, volym och extension. Utan dessa fält blockeras varje
// canonical strategi på futures-desken med missing_*_confirmation, trots att
// signalen uppströms bär evidensen. Adaptern ska förmedla den oförändrad —
// aldrig hitta på den. Saknas ett fält i källsignalen förblir det utelämnat,
// så kontraktet blockerar ärligt i stället för att passera på gissningar.
function entryConfirmationEvidence(signal = {}) {
  const evidence = {};
  const setIfPresent = (key, value) => {
    if (value !== null && value !== undefined) evidence[key] = value;
  };

  setIfPresent('twoMinuteConfirmed', safeBool(signal.twoMinuteConfirmed));
  setIfPresent('twoMinuteConfirmation', plainObject(signal.twoMinuteConfirmation));
  setIfPresent('candleConfirmation', plainObject(signal.candleConfirmation));
  setIfPresent('confirmation', plainObject(signal.confirmation));
  setIfPresent('producerEntryReadiness', plainObject(signal.producerEntryReadiness));

  setIfPresent('volumeContext', plainObject(signal.volumeContext));
  setIfPresent('volumeState', safeString(signal.volumeState || signal.volumeContext?.state));
  setIfPresent('rvol', safeNumber(signal.rvol ?? signal.relVol20 ?? signal.volumeContext?.rvol));

  setIfPresent('emaContext', plainObject(signal.emaContext));
  setIfPresent('trendIntact', safeBool(signal.trendIntact));
  setIfPresent('emaPullbackConfirmed', safeBool(signal.emaPullbackConfirmed));
  setIfPresent('emaReclaimConfirmed', safeBool(signal.emaReclaimConfirmed));
  setIfPresent('pullbackReclaimConfirmed', safeBool(signal.pullbackReclaimConfirmed));

  setIfPresent('vwapContext', plainObject(signal.vwapContext));
  setIfPresent('vwapReclaimConfirmed', safeBool(signal.vwapReclaimConfirmed));
  setIfPresent('closeAboveVwap', safeBool(signal.closeAboveVwap));

  // Late/extended-evidens gör kontraktet striktare, inte mildare — den ska med
  // så att lateEntryPolicy/extendedMovePolicy kan göra sitt jobb.
  setIfPresent('extensionLevel', safeString(signal.extensionLevel));
  setIfPresent('extensionMeta', plainObject(signal.extensionMeta));
  setIfPresent('lateMove', safeBool(signal.lateMove));

  return evidence;
}

function stableCandidateId(signal, futuresSymbol, now = new Date()) {
  const seed = JSON.stringify({
    signalId: signal.signalId || signal.signal_id || signal.id || null,
    strategyId: signal.strategyId || signal.strategy_id || signal.resolvedStrategyId || null,
    symbol: signal.symbol || signal.originalSymbol || null,
    futuresSymbol,
    timestamp: signal.createdAt || signal.timestamp || signal.detected_at || nowIso(now),
  });
  return `futures_candidate_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9& ]/g, '');
}

function normalizeFuturesRoot(value) {
  const normalized = normalizeSymbol(value);
  if (!normalized) return null;
  const token = normalized.split(/\s+/).find((part) => FUTURES_ROOT_ALIASES[part])
    || Object.keys(FUTURES_ROOT_ALIASES).find((root) => normalized === root || normalized.startsWith(root));
  const mapped = FUTURES_ROOT_ALIASES[token] || null;
  return MICRO_FUTURES_ROOTS.has(mapped) ? mapped : null;
}

function normalizeMarket(signal = {}) {
  return safeString(signal.market)
    || safeString(signal.marketType)
    || safeString(signal.market_group)
    || safeString(signal.marketGroup)
    || null;
}

function isNativeFuturesSignal(signal = {}) {
  const source = safeString(signal.signalSource) || safeString(signal.source);
  const market = String(normalizeMarket(signal) || '').toLowerCase();
  const provider = String(safeString(signal.provider) || '').toLowerCase();
  const exchange = normalizeSymbol(signal.exchange || signal.contract?.exchange);
  const root = normalizeFuturesRoot(signal.symbol || signal.root || signal.contract?.root || signal.contract?.symbol);
  return source === 'native_futures'
    && market === 'futures'
    && Boolean(root)
    && (!provider || provider === 'ibkr')
    && (!exchange || exchange === 'CME');
}

// Marknader där ett Nasdaq-mikroterminskontrakt är en försvarbar proxy för
// signalens underliggande instrument. Medvetet en tillåtelselista, inte en
// spärrlista: en ny marknadsklass ska behöva bevisa sitt släktskap, inte
// slinka igenom för att ingen hann lägga till den.
const INDEX_KINDRED_MARKETS = new Set([
  'stocks',
  'stock',
  'equity',
  'equities',
  'index',
  'indices',
  'futures',
]);

function hasIndexKinship(signal = {}) {
  const market = String(normalizeMarket(signal) || '').trim().toLowerCase();
  return INDEX_KINDRED_MARKETS.has(market);
}

function normalizeDirection(signal = {}) {
  const raw = safeString(
    signal.direction
      || signal.side
      || signal.nextMoveBias
      || signal.bias
      || signal.signal
      || signal.raw_signal,
  );
  const value = String(raw || '').trim().toUpperCase();
  if (['LONG', 'BUY', 'UP', 'BULL', 'BULLISH', 'LONG_TRIGGERED', 'LONG_WATCH'].includes(value)) return 'long';
  if (['SHORT', 'SELL', 'DOWN', 'BEAR', 'BEARISH', 'SHORT_TRIGGERED', 'SHORT_WATCH'].includes(value)) return 'short';
  return null;
}

// Ren observability — påverkar INTE om signalen släpps igenom.
//
// normalizeDirection kortsluter på nextMoveBias, som decisionMonitor alltid
// sätter (decisionMonitor.js:1380). Är biaset UNCERTAIN/NEUTRAL faller
// riktningen bort redan där, och signal-token längre ned i kedjan
// (LONG_TRIGGERED etc.) hinner aldrig läsas. Utan den här uppdelningen
// rapporteras båda fallen som missing_signal_direction, trots att det ena är
// "strategin gav ingen riktning" och det andra "2m-konfluensen lade veto".
//
// Vi kör samma normalizeDirection igen, men bara på signal-token — så delas
// token-vokabulären ovan och kan aldrig glida isär från den.
function hasDirectionalSignalToken(signal = {}) {
  return normalizeDirection({
    signal: signal.signal,
    raw_signal: signal.raw_signal,
  }) != null;
}

function normalizeConfidence(signal = {}) {
  const value = safeNumber(signal.confidence ?? signal.confidenceScore ?? signal.score ?? signal.priorityScore ?? signal.tradeScore);
  if (value == null) return null;
  if (value > 1) return round(Math.max(0, Math.min(100, value)) / 100, 4);
  return round(Math.max(0, Math.min(1, value)), 4);
}

function signalIdOf(signal = {}) {
  return safeString(signal.signalId)
    || safeString(signal.signal_id)
    || safeString(signal.id)
    || null;
}

function lifecycleIdOf(signal = {}) {
  return lifecycleIdentity.firstText(
    signal.lifecycleId,
    signal.lifecycle_id,
    signal.metadata?.lifecycleId,
    signal.metadata?.lifecycle_id,
  );
}

// signalTimestamp först: decisionMonitor har redan löst "stängning om bekräftad,
// annars öppning" (decisionMonitor.js:1328-1330). Läser vi i stället timestamp
// får vi candle-ÖPPNING, vilket för 2m förbrukar hela maxAgeMs-budgeten (120000)
// innan candlen ens stängt — se futuresPaperScannerService.js:76.
function signalTimestampOf(signal = {}) {
  return safeString(signal.signalTimestamp)
    || safeString(signal.createdAt)
    || safeString(signal.timestamp)
    || safeString(signal.detected_at)
    || safeString(signal.lastUpdate)
    || null;
}

function strategyIdOf(signal = {}, approval = null) {
  return safeString(signal.strategyId)
    || safeString(signal.strategy_id)
    || safeString(signal.resolvedStrategyId)
    || safeString(signal.sourceStrategyId)
    || safeString(approval?.strategyId)
    || safeString(approval?.strategy?.strategy_id)
    || null;
}

function readyForPaperStrategyRows(options = {}) {
  if (Array.isArray(options.readyForPaperStrategies)) return options.readyForPaperStrategies.filter(Boolean);
  try {
    const readiness = strategyReadinessService.getStrategyReadiness();
    return (Array.isArray(readiness?.strategies) ? readiness.strategies : [])
      .filter((row) => row?.readiness === 'READY_FOR_PAPER');
  } catch (_) {
    return [];
  }
}

function readyForPaperStrategyIds(options = {}) {
  if (options.readyForPaperStrategyIds instanceof Set) return options.readyForPaperStrategyIds;
  if (Array.isArray(options.readyForPaperStrategyIds)) return new Set(options.readyForPaperStrategyIds.filter(Boolean).map(String));
  return new Set(readyForPaperStrategyRows(options).map((row) => strategyIdOf(row)).filter(Boolean));
}

function signalSubtypeOf(signal = {}) {
  return safeString(signal.signalSubtype)
    || safeString(signal.signal_subtype)
    || safeString(signal.setup)
    || safeString(signal.eventType)
    || null;
}

function resolveReadyForPaperStrategy(signal = {}, options = {}) {
  const explicitId = strategyIdOf(signal);
  const readyIds = readyForPaperStrategyIds(options);
  if (explicitId && readyIds.has(explicitId)) {
    return { strategyId: explicitId, row: readyForPaperStrategyRows(options).find((row) => strategyIdOf(row) === explicitId) || null };
  }

  const subtype = String(signalSubtypeOf(signal) || '').trim().toUpperCase();
  if (!subtype) return { strategyId: null, row: null };

  const matches = readyForPaperStrategyRows(options).filter((row) => (
    Array.isArray(row?.producedSubtypes)
    && row.producedSubtypes.map((value) => String(value || '').trim().toUpperCase()).includes(subtype)
  ));
  if (matches.length !== 1) return { strategyId: null, row: null };
  const strategyId = strategyIdOf(matches[0]);
  return strategyId ? { strategyId, row: matches[0] } : { strategyId: null, row: null };
}

function explicitFuturesRoot(signal = {}) {
  return normalizeFuturesRoot(
    signal.futuresSymbol
      || signal.mappedFuturesSymbol
      || signal.futuresInstrument
      || signal.futures_instrument
      || signal.executionSymbol
      || signal.execution_symbol
      || signal.executionRoot
      || signal.execution_root
      || signal.instrument
      || signal.root
      || signal.mapping?.futuresSymbol
      || signal.mapping?.executionSymbol
      || signal.execution?.symbol
      || signal.execution?.root,
  );
}

function strategyNameOf(signal = {}, approval = null) {
  return safeString(signal.strategyName)
    || safeString(signal.strategy_name)
    || safeString(signal.resolvedStrategyName)
    || safeString(signal.sourceStrategyName)
    || safeString(approval?.strategyName)
    || safeString(approval?.strategy?.strategy_name)
    || strategyIdOf(signal, approval);
}

function sourceOf(signal = {}) {
  const explicit = safeString(signal.signalSource) || safeString(signal.source);
  if (!explicit) return 'trading_os';
  if (explicit === 'tradingview') return 'tradingview_webhook';
  return explicit;
}

function dataSourceOf(signal = {}, quote = null, usedFallbackPrice = false) {
  if (usedFallbackPrice || quote?.fallback === true || quote?.source === 'simulated_fallback') return 'simulated_fallback';
  const explicit = safeString(signal.dataSource) || safeString(signal.data_source);
  if (explicit) return explicit;
  const freshness = String(signal.dataFreshness || '').toUpperCase();
  if (freshness === 'LIVE') return 'real_market_data';
  if (freshness === 'STALE' || freshness === 'MARKET_CLOSED') return 'delayed_market_data';
  return 'real_market_data';
}

function mapSignalToFutures(signal = {}, options = {}) {
  const originalSymbol = normalizeSymbol(signal.originalSymbol || signal.symbol || signal.ticker);
  const market = String(normalizeMarket(signal) || '').toLowerCase();
  const text = [
    originalSymbol,
    signal.market,
    signal.marketType,
    signal.market_group,
    signal.marketGroup,
    signal.indexBias,
    signal.market_regime,
    signal.strategyName,
    signal.strategy_name,
    signal.signalFamily,
    signal.signalSubtype,
  ].filter(Boolean).join(' ').toUpperCase();

  const originalFuturesRoot = normalizeFuturesRoot(originalSymbol);
  if (isNativeFuturesSignal(signal) && originalFuturesRoot) {
    return {
      futuresSymbol: originalFuturesRoot,
      mappingConfidence: 1,
      nativeFutures: true,
    };
  }
  if (originalFuturesRoot) {
    return {
      originalSymbol,
      originalMarket: normalizeMarket(signal),
      futuresSymbol: originalFuturesRoot,
      mappingReason: originalFuturesRoot === 'MNQ' ? 'signal_is_mnq' : 'signal_is_mes',
      mappingConfidence: 1,
    };
  }
  const explicitRoot = explicitFuturesRoot(signal);
  if (explicitRoot) {
    return {
      originalSymbol,
      originalMarket: normalizeMarket(signal),
      futuresSymbol: explicitRoot,
      mappingReason: 'explicit_futures_execution_root',
      mappingConfidence: 1,
    };
  }
  if (NASDAQ_SYMBOLS.has(originalSymbol) || /NASDAQ|NDX|NAS100|TECH BIAS/.test(text)) {
    return {
      originalSymbol,
      originalMarket: normalizeMarket(signal) || market || null,
      futuresSymbol: 'MNQ',
      mappingReason: NASDAQ_SYMBOLS.has(originalSymbol) ? 'nasdaq_100_or_large_cap_proxy' : 'nasdaq_market_bias',
      mappingConfidence: NASDAQ_SYMBOLS.has(originalSymbol) && ['QQQ', 'NDX', 'NASDAQ', 'NASDAQ100', 'NAS100', 'NQ'].includes(originalSymbol) ? 0.95 : 0.72,
    };
  }
  if (SP500_SYMBOLS.has(originalSymbol) || /S&P|SP500|SPX|BROAD INDEX/.test(text)) {
    return {
      originalSymbol,
      originalMarket: normalizeMarket(signal) || market || null,
      futuresSymbol: 'MES',
      mappingReason: SP500_SYMBOLS.has(originalSymbol) ? 'sp500_index_or_etf_proxy' : 'sp500_market_bias',
      mappingConfidence: 0.95,
    };
  }
  if (resolveReadyForPaperStrategy(signal, options).strategyId) {
    // Steg 3 och 4 ovan mappar på symbolens FAKTISKA släktskap med indexet —
    // QQQ/MSFT/META är Nasdaq-100-innehav, så MNQ är en äkta proxy. Det här
    // steget har ingen sådan koppling: det finns bara för att READY_FOR_PAPER-
    // strategier ska kunna producera futures-kandidater alls, och mappade
    // därför vad som helst till MNQ.
    //
    // I praktiken var det en krypto→MNQ-regel. Hela signalbeslutet — riktning,
    // subtyp, rvol, regim — beräknas på BTCUSDT och exekveras sedan som MNQ med
    // entry/stop/target omräknade mot MNQ:s pris. En stark struktur i Bitcoin
    // säger ingenting om Nasdaq-100.
    //
    // Kravet är därför att signalen åtminstone kommer från en marknad där ett
    // Nasdaq-mikroterminskontrakt är en försvarbar proxy. Okänd marknad räknas
    // aldrig som släktskap: kan kopplingen inte visas mappar vi inte.
    if (!hasIndexKinship(signal)) {
      return {
        originalSymbol,
        originalMarket: normalizeMarket(signal) || market || null,
        futuresSymbol: null,
        mappingReason: 'no_index_kinship_for_default_root',
        mappingConfidence: 0,
      };
    }
    return {
      originalSymbol,
      originalMarket: normalizeMarket(signal) || market || null,
      futuresSymbol: 'MNQ',
      mappingReason: 'ready_for_paper_default_micro_futures_root',
      mappingConfidence: 0.68,
    };
  }
  return {
    originalSymbol,
    originalMarket: normalizeMarket(signal) || market || null,
    futuresSymbol: null,
    mappingReason: 'no_safe_futures_mapping',
    mappingConfidence: 0,
  };
}

function quoteFor(quotes = [], futuresSymbol) {
  return (Array.isArray(quotes) ? quotes : []).find((row) => {
    const key = String(row.root || row.symbol || '').toUpperCase();
    return key === futuresSymbol || key.startsWith(futuresSymbol);
  }) || null;
}

function resolveEntry(signal = {}, mapping, quote = null) {
  const signalEntry = safeNumber(signal.entry ?? signal.entryPrice ?? signal.price ?? signal.referencePrice);
  const originalSymbol = normalizeSymbol(signal.originalSymbol || signal.symbol || signal.ticker);
  const isAlreadyFutures = originalSymbol === mapping.futuresSymbol || originalSymbol.startsWith(mapping.futuresSymbol);
  if (isAlreadyFutures && signalEntry != null && signalEntry > 0) {
    return { entryPrice: signalEntry, usedFallbackPrice: false, entrySource: 'canonical_signal' };
  }

  const quotePrice = safeNumber(quote?.price);
  if (quotePrice != null && quotePrice > 0) {
    return {
      entryPrice: quotePrice,
      usedFallbackPrice: quote?.fallback === true || quote?.source === 'simulated_fallback',
      entrySource: quote?.source || 'futures_quote',
    };
  }

  return { entryPrice: null, usedFallbackPrice: false, entrySource: null };
}

function pctDistance(entry, level, direction, kind) {
  const e = safeNumber(entry);
  const l = safeNumber(level);
  if (!e || !l) return null;
  if (kind === 'stop') {
    return direction === 'short'
      ? ((l - e) / e) * 100
      : ((e - l) / e) * 100;
  }
  return direction === 'short'
    ? ((e - l) / e) * 100
    : ((l - e) / e) * 100;
}

function priceFromPct(entryPrice, pct, direction, kind) {
  const entry = safeNumber(entryPrice);
  const distance = safeNumber(pct);
  if (!entry || distance == null || distance <= 0) return null;
  if (kind === 'stop') {
    return direction === 'short'
      ? entry * (1 + distance / 100)
      : entry * (1 - distance / 100);
  }
  return direction === 'short'
    ? entry * (1 - distance / 100)
    : entry * (1 + distance / 100);
}

function deriveRiskFromSignal(signal = {}, { entryPrice, direction, mapping }) {
  const signalEntry = safeNumber(signal.entry ?? signal.entryPrice ?? signal.price ?? signal.referencePrice);
  const rawStop = safeNumber(signal.stopLoss ?? signal.stop_loss ?? signal.sl ?? signal.stop);
  const rawTake = safeNumber(signal.takeProfit ?? signal.take_profit ?? signal.tp ?? signal.target);
  const stopPctInput = safeNumber(signal.stopLossPct ?? signal.stop_loss_pct ?? signal.stopPct ?? signal.slPct);
  const targetPctInput = safeNumber(signal.takeProfitPct ?? signal.take_profit_pct ?? signal.targetPct ?? signal.tpPct);
  const originalSymbol = normalizeSymbol(signal.originalSymbol || signal.symbol || signal.ticker);
  const isAlreadyFutures = originalSymbol === mapping.futuresSymbol || originalSymbol.startsWith(mapping.futuresSymbol);

  let stopLoss = null;
  let takeProfit = null;
  let stopPct = null;
  let targetPct = null;
  let source = null;

  if (isAlreadyFutures && rawStop != null && rawTake != null) {
    stopLoss = rawStop;
    takeProfit = rawTake;
    source = 'signal_absolute_levels';
  } else if (signalEntry && rawStop != null && rawTake != null) {
    stopPct = pctDistance(signalEntry, rawStop, direction, 'stop');
    targetPct = pctDistance(signalEntry, rawTake, direction, 'target');
    stopLoss = priceFromPct(entryPrice, stopPct, direction, 'stop');
    takeProfit = priceFromPct(entryPrice, targetPct, direction, 'target');
    source = 'signal_risk_percent_mapped_to_futures';
  } else if (stopPctInput != null && targetPctInput != null) {
    stopPct = stopPctInput;
    targetPct = targetPctInput;
    stopLoss = priceFromPct(entryPrice, stopPct, direction, 'stop');
    takeProfit = priceFromPct(entryPrice, targetPct, direction, 'target');
    source = 'signal_risk_percent';
  }

  if ((!stopLoss || !takeProfit) && signal.symbol) {
    const profile = getRiskProfile(signal.symbol);
    if (profile?.stopPct != null && profile?.targetPct != null) {
      stopPct = profile.stopPct;
      targetPct = profile.targetPct;
      stopLoss = priceFromPct(entryPrice, stopPct, direction, 'stop');
      takeProfit = priceFromPct(entryPrice, targetPct, direction, 'target');
      source = 'trading_os_market_risk_profile';
    }
  }

  const risk = direction === 'short'
    ? safeNumber(stopLoss) - safeNumber(entryPrice)
    : safeNumber(entryPrice) - safeNumber(stopLoss);
  const reward = direction === 'short'
    ? safeNumber(entryPrice) - safeNumber(takeProfit)
    : safeNumber(takeProfit) - safeNumber(entryPrice);
  const riskReward = risk > 0 && reward > 0 ? round(reward / risk, 3) : safeNumber(signal.riskReward ?? signal.risk_reward);

  return {
    stopLoss: round(stopLoss, 2),
    takeProfit: round(takeProfit, 2),
    riskReward,
    riskSource: source,
    stopPct: stopPct == null ? null : round(stopPct, 4),
    targetPct: targetPct == null ? null : round(targetPct, 4),
  };
}

function createFuturesTradingOsSignalAdapterService(options = {}) {
  const readSignals = typeof options.signalReader === 'function' ? options.signalReader : () => [];
  const nowFn = typeof options.now === 'function' ? options.now : () => new Date();
  const readReadyForPaperStrategyIds = typeof options.readyForPaperStrategyIdsReader === 'function'
    ? options.readyForPaperStrategyIdsReader
    : readyForPaperStrategyIds;
  const readReadyForPaperStrategies = typeof options.readyForPaperStrategiesReader === 'function'
    ? options.readyForPaperStrategiesReader
    : readyForPaperStrategyRows;

  function readReadyForPaperContext() {
    const readyForPaperStrategies = readReadyForPaperStrategies();
    return {
      readyForPaperStrategies,
      readyForPaperStrategyIds: readReadyForPaperStrategyIds({ readyForPaperStrategies }),
    };
  }

  function adaptSignal(signal = {}, context = {}) {
    const now = context.now ? new Date(context.now) : nowFn();
    const signalTimestamp = signalTimestampOf(signal);
    const signalSessionMetadata = buildFuturesSessionMetadata(signalTimestamp);
    const readyContext = readReadyForPaperContext();
    const mapping = mapSignalToFutures(signal, readyContext);
    if (!mapping.futuresSymbol) {
      // skipReason är kategorin som nedströms konsumenter nycklar på; den exakta
      // orsaken (t.ex. no_index_kinship_for_default_root) följer med i `mapping`
      // i samma objekt, så detaljen går inte förlorad.
      return { ok: false, skipReason: 'no_safe_futures_mapping', mapping, signal, signalTimestamp, signalSessionMetadata };
    }

    const direction = normalizeDirection(signal);
    if (!direction) {
      // Samma grind som förut — bara en ärligare etikett på varför.
      const skipReason = hasDirectionalSignalToken(signal)
        ? 'direction_vetoed_by_bias'
        : 'missing_signal_direction';
      return { ok: false, skipReason, mapping, signal, signalTimestamp, signalSessionMetadata };
    }

    const quote = quoteFor(context.quotes, mapping.futuresSymbol);
    const entry = resolveEntry(signal, mapping, quote);
    if (!entry.entryPrice || entry.entryPrice <= 0) {
      return { ok: false, skipReason: 'no_futures_entry_price', mapping, signal, signalTimestamp, signalSessionMetadata };
    }

    const risk = deriveRiskFromSignal(signal, {
      entryPrice: entry.entryPrice,
      direction,
      mapping,
    });
    if (!risk.stopLoss || !risk.takeProfit || !risk.riskReward) {
      return { ok: false, skipReason: 'missing_trading_os_risk', mapping, signal, signalTimestamp, signalSessionMetadata };
    }

    const dataSource = dataSourceOf(signal, quote, entry.usedFallbackPrice);
    const excludedFromStats = dataSource === 'simulated_fallback' || entry.usedFallbackPrice === true;
    const createdAt = signalTimestamp || nowIso(now);
    const sessionMetadata = buildFuturesSessionMetadata(createdAt);
    const originalSignalId = signalIdOf(signal);
    const readyStrategy = resolveReadyForPaperStrategy(signal, readyContext);
    const strategyId = strategyIdOf(signal) || readyStrategy.strategyId;
    const strategyName = strategyNameOf(signal) || strategyNameOf(readyStrategy.row || {});
    const candidateId = stableCandidateId(signal, mapping.futuresSymbol, now);
    const lifecycleId = lifecycleIdOf(signal);
    const nativeFuturesSignal = mapping.nativeFutures === true || isNativeFuturesSignal(signal);
    const candidateSource = nativeFuturesSignal ? NATIVE_FUTURES_CANDIDATE_SOURCE : SOURCE;
    // Native-signaler har ingen ursprungssymbol att mappa från — fälten utelämnas
    // helt i stället för att fyllas med kontraktets eget rotnamn.
    const legacyMappingFields = nativeFuturesSignal ? {} : {
      mappedFuturesSymbol: mapping.futuresSymbol,
      originalSymbol: mapping.originalSymbol,
      originalMarket: mapping.originalMarket,
      mappingReason: mapping.mappingReason,
      mappingConfidence: mapping.mappingConfidence,
      mapping: {
        originalSymbol: mapping.originalSymbol,
        originalMarket: mapping.originalMarket,
        futuresSymbol: mapping.futuresSymbol,
        mappingReason: mapping.mappingReason,
        mappingConfidence: mapping.mappingConfidence,
      },
    };

    return {
      ok: true,
      candidate: {
        lifecycleId,
        candidateId,
        signalId: originalSignalId,
        originalSignalId,
        strategyId,
        strategyName,
        symbol: mapping.futuresSymbol,
        futuresSymbol: mapping.futuresSymbol,
        executionSymbol: mapping.futuresSymbol,
        futuresInstrument: mapping.futuresSymbol,
        direction,
        confidence: normalizeConfidence(signal),
        signalStatus: safeString(signal.signalStatus || signal.status) || null,
        signalFamily: safeString(signal.signalFamily || signal.family || signal.strategyFamily) || null,
        signalSubtype: safeString(signal.signalSubtype || signal.signal_subtype || signal.setup) || null,
        entryPrice: round(entry.entryPrice, 2),
        referencePrice: round(entry.entryPrice, 2),
        stopLoss: risk.stopLoss,
        takeProfit: risk.takeProfit,
        riskReward: risk.riskReward,
        stopLossPct: risk.stopPct,
        takeProfitPct: risk.targetPct,
        riskSource: risk.riskSource,
        timeframe: safeString(signal.timeframe) || DEFAULT_TIMEFRAME,
        source: candidateSource,
        signalSource: sourceOf(signal),
        market: nativeFuturesSignal ? 'futures' : (safeString(signal.market) || null),
        marketType: nativeFuturesSignal ? 'futures' : (safeString(signal.marketType || signal.market) || null),
        provider: nativeFuturesSignal ? (safeString(signal.provider) || null) : undefined,
        exchange: nativeFuturesSignal ? (safeString(signal.exchange || signal.contract?.exchange) || null) : undefined,
        contract: nativeFuturesSignal && signal.contract && typeof signal.contract === 'object' ? { ...signal.contract } : undefined,
        marketRegime: safeString(signal.marketRegime || signal.market_regime || signal.marketRegimeV2) || null,
        dataSource,
        dataFreshness: safeString(signal.dataFreshness) || null,
        priceSource: entry.entrySource,
        closedCandleConfirmed: signal.closedCandleConfirmed === true || signal.latestCandleClosed === true,
        latestCandleClosed: signal.latestCandleClosed === true || signal.closedCandleConfirmed === true,
        candleTimestamp: safeString(signal.candleTimestamp || signal.barTimestamp) || null,
        ...entryConfirmationEvidence(signal),
        paperOnly: true,
        executionGate: 'strategy_registry_execution_allowlist',
        registryGatePending: true,
        signalTimestamp,
        signalSessionMetadata,
        sessionMetadata,
        session: sessionMetadata?.session || null,
        sessionId: sessionMetadata?.sessionId || null,
        sessionLabel: sessionMetadata?.sessionLabel || null,
        exchangeTimezone: sessionMetadata?.exchangeTimezone || null,
        exchangeLocalDate: sessionMetadata?.exchangeLocalDate || null,
        exchangeLocalTime: sessionMetadata?.exchangeLocalTime || null,
        isRth: sessionMetadata?.isRth ?? null,
        isMarketOpen: sessionMetadata?.isMarketOpen ?? null,
        usedRealStrategyLogic: true,
        usedFallbackPrice: entry.usedFallbackPrice === true,
        excludedFromStats,
        tradeType: 'canonical_signal',
        strategyLogicVersion: safeString(signal.strategyLogicVersion)
          || safeString(signal.strategy_logic_version)
          || safeString(signal.paperRulesVersion)
          || (nativeFuturesSignal ? 'native_futures_runtime_current' : 'trading_os_runtime_current'),
        ...legacyMappingFields,
        rawSignalSummary: {
          status: signal.status || null,
          signalFamily: signal.signalFamily || null,
          signalSubtype: signal.signalSubtype || null,
          marketRegime: signal.marketRegime || signal.market_regime || signal.marketRegimeV2 || null,
          nextMoveBias: signal.nextMoveBias || null,
          dataFreshness: signal.dataFreshness || null,
          timestamp: signalTimestamp,
          sessionMetadata: signalSessionMetadata,
        },
        createdAt,
        timestamp: createdAt,
        status: 'queued',
        ...SAFETY,
        source: candidateSource,
      },
    };
  }

  function getFuturesCandidates({ now = new Date(), quotes = [], signalInputs = null } = {}) {
    const readerSignals = signalInputs == null ? readSignals() || [] : [];
    const signals = Array.isArray(signalInputs)
      ? signalInputs.filter(Boolean)
      : (Array.isArray(readerSignals) ? readerSignals.filter(Boolean) : []);
    const candidates = [];
    const skipped = [];
    for (const signal of signals) {
      const result = adaptSignal(signal, { now, quotes });
      if (result.ok) candidates.push(result.candidate);
      else skipped.push({
        lifecycleId: lifecycleIdOf(signal),
        signalId: signalIdOf(signal),
        symbol: signal?.symbol || signal?.originalSymbol || null,
        strategyId: signal?.strategyId || signal?.strategy_id || signal?.resolvedStrategyId || null,
        skipReason: result.skipReason,
        signalTimestamp: result.signalTimestamp || signalTimestampOf(signal),
        signalSessionMetadata: result.signalSessionMetadata || buildFuturesSessionMetadata(signalTimestampOf(signal)),
        mapping: result.mapping || null,
      });
    }

    return {
      ok: true,
      generatedAt: nowIso(now),
      signalsRead: signals.length,
      candidates,
      skipped,
      stats: {
        signalInputsRead: signals.length,
        readerSignalsRead: Array.isArray(readerSignals) ? readerSignals.length : 0,
        signalsMappedToFutures: candidates.length,
        signalsSkippedNoMapping: skipped.filter((row) => row.skipReason === 'no_safe_futures_mapping').length,
        signalsSkippedNoRisk: skipped.filter((row) => row.skipReason === 'missing_trading_os_risk').length,
        signalsSkippedNoDirection: skipped.filter((row) => row.skipReason === 'missing_signal_direction').length,
        signalsSkippedDirectionVetoed: skipped.filter((row) => row.skipReason === 'direction_vetoed_by_bias').length,
        // Femte och sista orsaken. adaptSignal skippar bara på dessa fem, så
        // räknarna summerar exakt till skipped.length — samma uppdelning som
        // scannern persisterar i scan-posten, där de tre sista tillsammans
        // utgör signalsSkippedOther. Testet asserterar båda summorna.
        signalsSkippedNoEntryPrice: skipped.filter((row) => row.skipReason === 'no_futures_entry_price').length,
      },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    SOURCE,
    mapSignalToFutures,
    adaptSignal,
    getFuturesCandidates,
  };
}

const defaultFuturesTradingOsSignalAdapterService = createFuturesTradingOsSignalAdapterService();

module.exports = {
  SAFETY,
  SOURCE,
  NATIVE_FUTURES_CANDIDATE_SOURCE,
  mapSignalToFutures,
  normalizeDirection,
  createFuturesTradingOsSignalAdapterService,
  defaultFuturesTradingOsSignalAdapterService,
};
