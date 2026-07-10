'use strict';

// Read-only aggregator för Futures Paper "Teknisk info" (steg A + B).
//
// VIKTIGT: Den här servicen är INTE en ny källa till strategisanning. Den läser
// och normaliserar enbart de befintliga canonical registren:
//   - daytradingStrategyCatalogService  (strategikatalog: id/namn/family/regler/defaults)
//   - strategyIdNormalizerService       (stabil/canonical strategy-id)
//   - strategyRuntimeMatrixService       (runtime-status per strategi)
//   - strategyTradeControlService        (family/cooldown-config)
//   - futuresContractCatalogService      (point value, courtage – kontraktsinställningar)
//   - futuresPaperAccountService         (fxUsdSek – kontoinställning)
//   - futuresPaperPriceFeedService       (simulated_fallback base price/drift/step)
//
// Ingen ordinär, ingen execution, ingen broker, ingen skrivning. paper_only.

const crypto = require('crypto');

const catalogService = require('./daytradingStrategyCatalogService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const runtimeMatrixService = require('./strategyRuntimeMatrixService');
const strategyTradeControl = require('./strategyTradeControlService');
const futuresContractCatalog = require('./futuresContractCatalogService');
const futuresPaperAccount = require('./futuresPaperAccountService');
const futuresPaperPriceFeed = require('./futuresPaperPriceFeedService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_technical_info',
});

// Bumpa vid varje förändring av vilka fält som ingår i configHash eller av
// hash-algoritmen, så att en ny hash kan skiljas från en verklig strategiändring.
const CONFIG_HASH_SCHEMA_VERSION = 1;

// Allowlistade EFFEKTIVA strategifält som ingår i configHash. Får aldrig innehålla
// generatedAt, runtime-status som ändras över tid, hemligheter eller UI-fält.
const CONFIG_HASH_FIELDS = Object.freeze([
  'strategyId',
  'displayName',
  'family',
  'direction',
  'market',
  'signalRules',
  'defaultStopLossPct',
  'defaultTakeProfitR',
  'defaultHoldingTimeMin',
  'defaultTimeoutMin',
  'confidenceThreshold',
  'defaultTimeframes',
  'requiredIndicators',
  'optionalIndicators',
]);

const NOT_AVAILABLE_IN_RUNTIME = 'Ej tillgängligt i runtime';
const NUMERIC_INDICATOR_NOTE =
  'Numeriska indikatorparametrar finns inte lagrade som strukturerad runtime-konfiguration.';
const SIMULATION_SETTINGS_NOTE =
  'Simulations- och kontraktsinställningar, inte strategiinställningar.';

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function isNil(value) {
  return value === null || value === undefined;
}

// Deep equal utan att bry sig om objektnyckelordning (arrayer jämförs i ordning).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    if (!keysA.every((key, index) => key === keysB[index])) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

// Stabil serialisering: rekursiv nyckelsortering på objekt, arrayordning bevaras.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Bygger ett provenance-fält för en parameter: default (bas), override (patch),
// effective (patchat värde) och källa.
function makeParam({ defaultValue, effectiveValue, hasBase, source }) {
  const normalizedDefault = defaultValue === undefined ? null : defaultValue;
  const normalizedEffective = effectiveValue === undefined ? null : effectiveValue;
  let override = null;
  if (hasBase) {
    if (!deepEqual(normalizedDefault, normalizedEffective)) {
      override = normalizedEffective;
    }
  }
  const effective = normalizedEffective !== null ? normalizedEffective : normalizedDefault;
  return {
    default: hasBase ? normalizedDefault : null,
    override,
    effective: effective === undefined ? null : effective,
    source,
  };
}

const CATALOG_SOURCE = 'daytradingStrategyCatalogService';
const PATCH_SOURCE = 'daytradingStrategyCatalogService.state_history_patch';

// Läser ett fält från bas + effektiv strategi och bygger ett provenance-param.
function paramFrom(base, effective, baseKey, effKey = baseKey) {
  const hasBase = base !== null && base !== undefined;
  const defaultValue = hasBase ? base[baseKey] : null;
  const effectiveValue = effective ? effective[effKey] : null;
  const overrode = hasBase && !deepEqual(
    defaultValue === undefined ? null : defaultValue,
    effectiveValue === undefined ? null : effectiveValue,
  );
  return makeParam({
    defaultValue,
    effectiveValue,
    hasBase,
    source: overrode ? PATCH_SOURCE : CATALOG_SOURCE,
  });
}

// Hämtar det effektiva värdet ur ett param-objekt.
function effOf(param) {
  return param && !isNil(param.effective) ? param.effective : null;
}

function buildRuntimeMatrixMap() {
  try {
    const matrix = runtimeMatrixService.getStrategyRuntimeMatrix();
    const rows = Array.isArray(matrix?.strategies)
      ? matrix.strategies
      : (Array.isArray(matrix?.rows) ? matrix.rows : []);
    const map = new Map();
    for (const row of rows) {
      const id = row?.id || row?.strategy_id;
      if (id) map.set(id, row);
    }
    return map;
  } catch (err) {
    return new Map();
  }
}

function buildFamilyResolver() {
  try {
    const config = strategyTradeControl.getStrategyTradeControlConfig();
    return { config, ok: true };
  } catch (err) {
    return { config: null, ok: false };
  }
}

// Bygger den fullständiga tekniska vyn för EN strategi (A + B).
function buildStrategyEntry(base, effective, matrixRow) {
  const strategyId = safeString(effective?.id || base?.id);
  const displayName = safeString(effective?.name || base?.name) || strategyId;

  const family = paramFrom(base, effective, 'family');
  const direction = paramFrom(base, effective, 'direction');
  const market = paramFrom(base, effective, 'market_group', 'market_group');
  const signalRules = paramFrom(base, effective, 'signal_rules');
  const defaultTimeframes = paramFrom(base, effective, 'default_timeframes');
  const confidenceThreshold = paramFrom(base, effective, 'confidence_threshold');
  const requiredIndicators = paramFrom(base, effective, 'required_indicators');
  const optionalIndicators = paramFrom(base, effective, 'optional_indicators');
  const defaultStopLossPct = paramFrom(base, effective, 'default_sl', 'default_stop_loss_pct');
  const defaultTakeProfitR = paramFrom(base, effective, 'default_tp', 'default_take_profit_r');
  const defaultHoldingTimeMin = paramFrom(base, effective, 'default_holding_time', 'default_holding_time_min');
  const defaultTimeoutMin = paramFrom(base, effective, 'default_timeout_min');

  // Canonical/stabil id-kontroll (påverkar inte sanningen, bara metadata).
  let idNormalization = null;
  try {
    const norm = strategyIdNormalizer.normalizeStrategyId(strategyId);
    idNormalization = {
      canonicalStrategyId: norm?.canonicalStrategyId || null,
      status: norm?.status || null,
      stable: norm?.status === 'canonical',
    };
  } catch (err) {
    idNormalization = { canonicalStrategyId: null, status: null, stable: false };
  }

  const runtimeStatus = safeString(matrixRow?.paperRuntimeStatus) || 'unknown';
  const automaticStatus = safeString(matrixRow?.automaticStatus) || 'unknown';

  const catalogStatus = safeString(effective?.status || effective?.catalog_status) || 'unknown';
  const active = effective ? effective.enabled !== false : false;

  // configHash byggs ENBART av allowlistade effektiva fält (+ schemaversion).
  const hashPayload = {
    __configHashSchemaVersion: CONFIG_HASH_SCHEMA_VERSION,
    strategyId,
    displayName,
    family: effOf(family),
    direction: effOf(direction),
    market: effOf(market),
    signalRules: effOf(signalRules) || [],
    defaultStopLossPct: effOf(defaultStopLossPct),
    defaultTakeProfitR: effOf(defaultTakeProfitR),
    defaultHoldingTimeMin: effOf(defaultHoldingTimeMin),
    defaultTimeoutMin: effOf(defaultTimeoutMin),
    confidenceThreshold: effOf(confidenceThreshold),
    defaultTimeframes: effOf(defaultTimeframes) || [],
    requiredIndicators: effOf(requiredIndicators) || [],
    optionalIndicators: effOf(optionalIndicators) || [],
  };
  const configHash = crypto
    .createHash('sha256')
    .update(stableStringify(hashPayload))
    .digest('hex');

  return {
    // ---- A. Strategikatalog ----
    strategyId,
    displayName,
    family: effOf(family),
    direction: effOf(direction),
    active,
    catalogStatus,
    runtimeStatus,
    automaticStatus,
    version: safeString(effective?.version) || null,
    defaultTimeframes: effOf(defaultTimeframes) || [],
    // Futures-symboler kan inte härledas säkert per strategi ur katalogen
    // (katalogen har marknadsgrupp stocks/crypto/all, inte MNQ/MES).
    supportedSymbols: null,
    supportedSymbolsNote: NOT_AVAILABLE_IN_RUNTIME,
    market: effOf(market),
    signalRules: effOf(signalRules) || [],
    defaultStopLossPct: effOf(defaultStopLossPct),
    defaultTakeProfitR: effOf(defaultTakeProfitR),
    defaultHoldingTimeMin: effOf(defaultHoldingTimeMin),
    // datakälla för Futures Paper-körning är den delade simulerade feeden.
    dataSource: futuresPaperPriceFeed.FEED_SOURCE || 'simulated_fallback',
    provenance: {
      catalog: CATALOG_SOURCE,
      runtimeStatus: matrixRow ? 'strategyRuntimeMatrixService' : NOT_AVAILABLE_IN_RUNTIME,
      idNormalization: 'strategyIdNormalizerService',
    },
    idStable: idNormalization.stable,
    canonicalStrategyId: idNormalization.canonicalStrategyId,
    configHash,
    configHashSchemaVersion: CONFIG_HASH_SCHEMA_VERSION,

    // ---- B. Strategidetaljer (default/override/effective/source per parameter) ----
    details: {
      entryAndIndicators: {
        signalRules,
        defaultTimeframes,
        confidenceThreshold,
        requiredIndicators,
        optionalIndicators,
        numericIndicatorParameters: {
          available: false,
          note: NUMERIC_INDICATOR_NOTE,
        },
      },
      riskAndExit: {
        defaultStopLossPct,
        defaultTakeProfitR,
        defaultHoldingTimeMin,
        defaultTimeoutMin,
      },
      sessionAndData: {
        family,
        market,
        direction,
        feedSource: {
          default: futuresPaperPriceFeed.FEED_SOURCE || 'simulated_fallback',
          override: null,
          effective: futuresPaperPriceFeed.FEED_SOURCE || 'simulated_fallback',
          source: 'futuresPaperPriceFeedService',
        },
      },
    },
  };
}

// Bygger en placeholder om en enskild strategipost är trasig, så att hela
// katalogsvaret inte kraschar (test: en trasig strategi kraschar inte katalogen).
function buildBrokenStrategyEntry(rawId, err) {
  return {
    strategyId: safeString(rawId),
    displayName: safeString(rawId),
    error: true,
    errorMessage: safeString(err && err.message) || 'strategy_entry_failed',
    active: false,
    catalogStatus: 'unknown',
    runtimeStatus: 'unknown',
    configHash: null,
    configHashSchemaVersion: CONFIG_HASH_SCHEMA_VERSION,
    details: null,
    ...SAFETY,
  };
}

// Kontrakts- och simuleringsinställningar (INTE strategiinställningar).
function buildSimulationAndContractSettings() {
  let fxUsdSek = null;
  let startingBalanceSek = null;
  try {
    const config = futuresPaperAccount.defaultFuturesPaperAccountService.readConfig();
    fxUsdSek = isNil(config?.fxUsdSek) ? futuresPaperAccount.DEFAULT_CONFIG.fxUsdSek : config.fxUsdSek;
    startingBalanceSek = isNil(config?.startingBalanceSek)
      ? futuresPaperAccount.DEFAULT_CONFIG.startingBalanceSek
      : config.startingBalanceSek;
  } catch (err) {
    fxUsdSek = futuresPaperAccount.DEFAULT_CONFIG.fxUsdSek;
    startingBalanceSek = futuresPaperAccount.DEFAULT_CONFIG.startingBalanceSek;
  }

  const basePrices = futuresPaperPriceFeed.BASE_PRICES || {};
  const contracts = [];
  try {
    for (const contract of futuresContractCatalog.listContracts()) {
      const feed = basePrices[contract.root] || {};
      const commissionPerSideUsd = contract.defaultCommissionPerSideUsd;
      const roundTripCommissionUsd = futuresContractCatalog.roundTripCostUsd(contract.root, 1);
      contracts.push({
        root: contract.root,
        name: contract.name,
        contractClass: contract.contractClass,
        pointValueUsd: contract.pointValueUsd,
        tickSize: contract.tickSize,
        tickValueUsd: contract.tickValueUsd,
        commissionPerSideUsd,
        roundTripCommissionUsd,
        roundTripCommissionSek: isNil(fxUsdSek) || isNil(roundTripCommissionUsd)
          ? null
          : Math.round(roundTripCommissionUsd * fxUsdSek * 100) / 100,
        feedSource: futuresPaperPriceFeed.FEED_SOURCE || 'simulated_fallback',
        basePrice: isNil(feed.basePrice) ? null : feed.basePrice,
        maxDriftPct: isNil(feed.maxDriftPct) ? null : feed.maxDriftPct,
        stepPct: isNil(feed.stepPct) ? null : feed.stepPct,
      });
    }
  } catch (err) {
    // Returnera det vi hann samla; kraschar aldrig endpointen.
  }

  return {
    label: 'simulation_and_contract_settings',
    note: SIMULATION_SETTINGS_NOTE,
    feedSource: futuresPaperPriceFeed.FEED_SOURCE || 'simulated_fallback',
    isRealMarketData: false,
    fxUsdSek,
    startingBalanceSek,
    contracts,
  };
}

// Samlar katalog: default (bas STRATEGIES) + effektiv (patchad getCatalog).
function collectStrategyEntries() {
  const baseList = safeArray(catalogService.STRATEGIES);
  const baseById = new Map(baseList.map((row) => [row?.id, row]));

  let effectiveList = [];
  try {
    const catalog = catalogService.getCatalog();
    effectiveList = safeArray(catalog?.strategies);
  } catch (err) {
    effectiveList = [];
  }

  const matrixMap = buildRuntimeMatrixMap();

  const entries = [];
  const seen = new Set();
  for (const effective of effectiveList) {
    const id = effective?.id;
    seen.add(id);
    try {
      entries.push(buildStrategyEntry(baseById.get(id) || null, effective, matrixMap.get(id) || null));
    } catch (err) {
      entries.push(buildBrokenStrategyEntry(id, err));
    }
  }
  // Bas-strategier som saknas i effektiv lista (skulle vara ovanligt).
  for (const base of baseList) {
    if (base && !seen.has(base.id)) {
      try {
        entries.push(buildStrategyEntry(base, base, matrixMap.get(base.id) || null));
      } catch (err) {
        entries.push(buildBrokenStrategyEntry(base.id, err));
      }
    }
  }
  return entries;
}

// Publikt: hela katalogen (A + B) + kontrakts-/simuleringsinställningar.
function getStrategiesTechnicalInfo() {
  const strategies = collectStrategyEntries();
  return {
    status: 'ok',
    readOnly: true,
    generatedAt: nowIso(),
    configHashSchemaVersion: CONFIG_HASH_SCHEMA_VERSION,
    count: strategies.length,
    strategies,
    simulationAndContractSettings: buildSimulationAndContractSettings(),
    ...SAFETY,
  };
}

// Publikt: en strategi via id (canonical eller känt alias). null om okänd.
function getStrategyTechnicalInfoById(rawId) {
  const requested = safeString(rawId);
  if (!requested) return null;

  const baseList = safeArray(catalogService.STRATEGIES);
  const baseById = new Map(baseList.map((row) => [row?.id, row]));

  let effective = null;
  try {
    effective = catalogService.getStrategyById(requested);
  } catch (err) {
    effective = null;
  }

  // Prova canonical-id om direkt uppslag missade.
  let resolvedId = requested;
  if (!effective) {
    try {
      const norm = strategyIdNormalizer.normalizeStrategyId(requested);
      if (norm?.canonicalStrategyId && norm.canonicalStrategyId !== requested) {
        resolvedId = norm.canonicalStrategyId;
        effective = catalogService.getStrategyById(resolvedId);
      }
    } catch (err) {
      // ignorera – behandlas som not found nedan
    }
  }

  if (!effective) return null;

  const matrixMap = buildRuntimeMatrixMap();
  try {
    return buildStrategyEntry(baseById.get(resolvedId) || null, effective, matrixMap.get(resolvedId) || null);
  } catch (err) {
    return buildBrokenStrategyEntry(resolvedId, err);
  }
}

module.exports = {
  SAFETY,
  CONFIG_HASH_SCHEMA_VERSION,
  CONFIG_HASH_FIELDS,
  stableStringify,
  deepEqual,
  getStrategiesTechnicalInfo,
  getStrategyTechnicalInfoById,
  buildSimulationAndContractSettings,
};
