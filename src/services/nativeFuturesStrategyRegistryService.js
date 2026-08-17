'use strict';

/**
 * nativeFuturesStrategyRegistryService — READ-ONLY register över de native
 * futures-strategierna och deras koppling till legacy-katalogen.
 *
 * Varje migrerad strategi deklarerar själv sitt ursprung via ORIGIN_STRATEGY_ID.
 * Det här registret läser den deklarationen i stället för att duplicera den i en
 * handskriven tabell, så kopplingen kan aldrig glida isär från koden.
 *
 * Registret handlar inte, utvärderar inga signaler och ändrar inget tillstånd.
 * Det finns för att observability-lagret ska kunna svara på frågan "vilken
 * legacy-strategi är det här native-id:t?" — vilket behövs eftersom trades,
 * intents och broker-order stämplas med native-id medan strategiöversikten,
 * approvals och performance är nycklade på legacy-id.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'native_futures_strategy_registry',
});

// DEN ENDA listan över native futures-strategier i systemet.
//
// Tidigare fanns den två gånger: här, och som NATIVE_STRATEGY_EVALUATORS inuti
// nativeFuturesSignalProvider. Två listor över samma sak glider förr eller
// senare isär — och konsekvensen hade varit tyst: en strategi som körs i paper
// men inte syns i registret, eller tvärtom. Providern läser numera härifrån,
// vilket också är det som gör att Replay kan köra utan att känna till en enda
// strategi. Registrera en modul här och den dyker upp i BÅDA.
const STRATEGY_MODULES = Object.freeze([
  require('./nativeFuturesMomentumStrategyService'),
  require('./nativeFuturesNarrowStateExpansionStrategyService'),
  require('./nativeFuturesEmaPullbackContinuationStrategyService'),
  require('./nativeFuturesVwapVolumeBreakoutStrategyService'),
  require('./nativeFuturesVwapFailedBreakoutShortStrategyService'),
  require('./nativeFuturesTrendContinuationStrategyService'),
  require('./nativeFuturesNarrowBreakoutShortStrategyService'),
  require('./nativeFuturesNarrowFakeoutReversalStrategyService'),
]);

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function describe(strategyModule) {
  const strategyId = text(strategyModule?.STRATEGY_ID);
  if (!strategyId) return null;
  const originStrategyId = text(strategyModule?.ORIGIN_STRATEGY_ID);
  return Object.freeze({
    strategyId,
    strategyVersion: text(strategyModule?.STRATEGY_VERSION),
    // null = native från början (ingen legacy-förlaga att spegla tillbaka mot).
    originStrategyId,
    migrated: originStrategyId != null,
    targetSignalFamily: text(strategyModule?.TARGET_SIGNAL_FAMILY),
    targetSignalSubtype: text(strategyModule?.TARGET_SIGNAL_SUBTYPE),
  });
}

const DESCRIPTORS = Object.freeze(STRATEGY_MODULES.map(describe).filter(Boolean));

// ── evaluators ───────────────────────────────────────────────────────────────
//
// Varje strategimodul exporterar exakt en `evaluate*`-funktion, men under sitt
// eget namn (evaluateNativeFuturesMomentumStrategy, ...). Konventionen läses
// här i stället för att varje anropare importerar de åtta namnen för hand.
//
// Hittas noll eller flera kastar modulen vid inläsning. En strategi som tyst
// hoppas över är den värsta av de tänkbara utgångarna: paper och replay skulle
// då köra olika uppsättningar utan att någonting rapporterade det.
function resolveEvaluator(strategyModule) {
  const keys = Object.keys(strategyModule || {})
    .filter((key) => key.startsWith('evaluate') && typeof strategyModule[key] === 'function');
  const strategyId = text(strategyModule?.STRATEGY_ID) || '(okänd modul)';
  if (keys.length !== 1) {
    throw new Error(
      `${strategyId}: en strategimodul måste exportera exakt en evaluate*-funktion, hittade ${keys.length} (${keys.join(', ') || 'inga'})`,
    );
  }
  return strategyModule[keys[0]];
}

const EVALUATORS = Object.freeze(
  STRATEGY_MODULES
    .filter((strategyModule) => text(strategyModule?.STRATEGY_ID))
    .map((strategyModule) => Object.freeze({
      strategyId: text(strategyModule.STRATEGY_ID),
      evaluate: resolveEvaluator(strategyModule),
    })),
);

const BY_STRATEGY_ID = new Map(DESCRIPTORS.map((row) => [row.strategyId, row]));

// Ett legacy-id kan i princip bära flera native-implementationer. Det gör det
// inte idag, men kartan är en lista så att en framtida andra implementation
// syns som en tvetydighet i stället för att tyst skriva över den första.
const BY_ORIGIN_STRATEGY_ID = (() => {
  const map = new Map();
  for (const row of DESCRIPTORS) {
    if (!row.originStrategyId) continue;
    const bucket = map.get(row.originStrategyId) || [];
    bucket.push(row);
    map.set(row.originStrategyId, bucket);
  }
  for (const [key, bucket] of map) map.set(key, Object.freeze(bucket));
  return map;
})();

function listNativeStrategies() {
  return DESCRIPTORS;
}

/**
 * Strategierna som utvärderingsbara enheter, i registreringsordning.
 *
 * Det här är den enda vägen till en native-evaluator. Signal-providern (och
 * därmed både Paper och Replay) itererar över den här listan — ingen anropare
 * får importera en strategimodul direkt för att köra den.
 *
 * @returns {ReadonlyArray<{strategyId: string, evaluate: Function}>}
 */
function listStrategyEvaluators() {
  return EVALUATORS;
}

/** Familj/subtyp för ett native-id. Det är den enda kopplingen som finns. */
function signalTaxonomyFor(strategyId) {
  const row = getNativeStrategy(strategyId);
  return {
    signalFamily: row?.targetSignalFamily || null,
    signalSubtype: row?.targetSignalSubtype || null,
  };
}

function getNativeStrategy(strategyId) {
  return BY_STRATEGY_ID.get(text(strategyId)) || null;
}

function isNativeStrategyId(strategyId) {
  return BY_STRATEGY_ID.has(text(strategyId));
}

/** Native-id → legacy-id. null när id:t inte är native eller saknar förlaga. */
function originStrategyIdFor(strategyId) {
  return getNativeStrategy(strategyId)?.originStrategyId || null;
}

/** Legacy-id → native-descriptorer. Tom lista när strategin inte är migrerad. */
function nativeStrategiesForOrigin(originStrategyId) {
  return BY_ORIGIN_STRATEGY_ID.get(text(originStrategyId)) || [];
}

/**
 * Den enda native-implementationen av ett legacy-id, eller null när strategin
 * inte är migrerad ELLER när flera implementationer gör svaret tvetydigt.
 * Tvetydighet löses aldrig genom gissning.
 */
function soleNativeStrategyForOrigin(originStrategyId) {
  const rows = nativeStrategiesForOrigin(originStrategyId);
  return rows.length === 1 ? rows[0] : null;
}

module.exports = {
  SAFETY,
  listNativeStrategies,
  listStrategyEvaluators,
  signalTaxonomyFor,
  getNativeStrategy,
  isNativeStrategyId,
  originStrategyIdFor,
  nativeStrategiesForOrigin,
  soleNativeStrategyForOrigin,
};
