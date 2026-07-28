'use strict';

// Futures Paper Strategy Performance — READ-ONLY statistik per canonical
// strategyId. Default-källan är IBKR Paper fills. Den gamla interna
// futures-ledgern finns endast som separat legacy-archive och blandas aldrig
// med IBKR Paper-performance.
//
// Canonical numeriska värden (net/gross/fees) tas från ledgerns läsmodell
// (getFuturesPaperPositions → closedPositions), som normaliserar äldre trades.
// Provenance (stored_net vs derived_with_current_commission) härleds från den
// frusna append-loggen trades.jsonl per tradeId.

const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperStorageService = require('./futuresPaperStorageService');
const ibPaperExecutionOrchestratorService = require('./ibPaperExecutionOrchestratorService');
const internalSimulationRetirement = require('./futuresInternalSimulationRetirementService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const catalogService = require('./daytradingStrategyCatalogService');
const strategyPerformanceService = require('./strategyPerformanceService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_strategy_performance',
});

const MIN_TRADES_FOR_RATE_LEADERS = 5;

function nowIso() { return new Date().toISOString(); }

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function canonicalId(rawId) {
  const s = rawId === null || rawId === undefined ? '' : String(rawId).trim();
  if (!s) return null;
  try {
    const norm = strategyIdNormalizer.normalizeStrategyId(s);
    if (norm && norm.canonicalStrategyId) return norm.canonicalStrategyId;
  } catch (err) { /* fallback */ }
  return s;
}

function displayNameFor(id) {
  try {
    const s = catalogService.getStrategyById(id);
    if (s && s.name) return s.name;
  } catch (err) { /* noop */ }
  return id;
}

// tradeId → provenance ur den frusna trades.jsonl-loggen.
// stored_net: raden hade feesSek + netPnlSek lagrat vid stängning.
// derived_with_current_commission: äldre rad utan avgiftsfält (härleds vid läsning).
function provenanceByTradeId() {
  const map = new Map();
  try {
    const rows = futuresPaperStorageService.readJsonl(futuresPaperStorageService.FILES.trades) || [];
    for (const row of rows) {
      if (!row || !row.tradeId) continue;
      const hasStored = row.feesSek != null && row.netPnlSek != null;
      map.set(row.tradeId, hasStored ? 'stored_net' : 'derived_with_current_commission');
    }
  } catch (err) { /* loggen kan saknas → allt behandlas som derived nedan */ }
  return map;
}

function emptyStats(id) {
  return {
    strategyId: id,
    displayName: displayNameFor(id),
    closedTrades: 0,
    wins: 0,
    losses: 0,
    breakevenTrades: 0,
    winRatePct: null,
    grossPnlSek: 0,
    feesSek: 0,
    netPnlSek: 0,
    avgNetPnlSek: null,
    avgWinSek: null,
    avgLossSek: null,
    maxDrawdownSek: null,
    bestTradeSek: null,
    worstTradeSek: null,
    profitFactor: null,
    profitFactorNote: null,
    totalHistoricalClosedTrades: 0,
    dataSources: [],
    executionSources: [],
    usesSimulatedFallback: false,
    pnlCalculationSources: { broker_fill: 0, stored_net: 0, derived_with_current_commission: 0 },
    pnlProvenance: 'none',
  };
}

function isClosedBrokerExecution(row = {}) {
  const realized = row.realizedResult ?? row.realizedPnlSek ?? row.realizedPnl ?? row.realizedPNL;
  return Number.isFinite(Number(realized));
}

// Ren aggregering av normaliserade trades (testbar utan ledger).
// Varje trade: { strategyId, netPnlSek, grossPnlSek, feesSek, dataSource, provenance }.
function aggregateTrades(trades = []) {
  const byStrategy = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const id = canonicalId(t && t.strategyId);
    if (!id) continue;
    if (!byStrategy.has(id)) byStrategy.set(id, emptyStats(id));
    const s = byStrategy.get(id);

    const net = num(t.netPnlSek);
    const gross = num(t.grossPnlSek != null ? t.grossPnlSek : net);
    const fees = num(t.feesSek);

    s.closedTrades += 1;
    s.totalHistoricalClosedTrades += 1;
    s.netPnlSek = round(s.netPnlSek + net);
    s.grossPnlSek = round(s.grossPnlSek + gross);
    s.feesSek = round(s.feesSek + fees);

    // Break-even-regel: net > 0 win, net < 0 loss, net == 0 breakeven.
    if (net > 0) s.wins += 1;
    else if (net < 0) s.losses += 1;
    else s.breakevenTrades += 1;

    if (s.bestTradeSek === null || net > s.bestTradeSek) s.bestTradeSek = round(net);
    if (s.worstTradeSek === null || net < s.worstTradeSek) s.worstTradeSek = round(net);

    const ds = t.dataSource || 'unknown';
    if (!s.dataSources.includes(ds)) s.dataSources.push(ds);
    if (ds === 'simulated_fallback') s.usesSimulatedFallback = true;
    const executionSource = t.executionSource || t.source || 'ibkr_paper';
    if (!s.executionSources.includes(executionSource)) s.executionSources.push(executionSource);

    const prov = t.provenance || 'derived_with_current_commission';
    s.pnlCalculationSources[prov] = (s.pnlCalculationSources[prov] || 0) + 1;

    s.__winSum = (s.__winSum || 0) + (net > 0 ? net : 0);
    s.__lossSum = (s.__lossSum || 0) + (net < 0 ? net : 0);
    // Sekvensen behövs för drawdown (equity-kurva i tradeordning).
    (s.__pnls = s.__pnls || []).push(net);
  }

  const out = [];
  for (const s of byStrategy.values()) {
    // Win rate: wins / closedTrades (breakeven ingår i totalen, ej i wins/losses).
    s.winRatePct = s.closedTrades > 0 ? round((s.wins / s.closedTrades) * 100, 1) : null;
    s.avgNetPnlSek = s.closedTrades > 0 ? round(s.netPnlSek / s.closedTrades) : null;

    // Average win/loss: summorna beräknas redan ovan — de exponeras nu i stället
    // för att kastas bort. Genomsnitten avser endast vinnande respektive
    // förlorande trades (breakeven ingår i ingendera).
    s.avgWinSek = s.wins > 0 ? round((s.__winSum || 0) / s.wins) : null;
    s.avgLossSek = s.losses > 0 ? round((s.__lossSum || 0) / s.losses) : null;
    // Drawdown via samma definition som strategyPerformanceService använder.
    s.maxDrawdownSek = (s.__pnls && s.__pnls.length)
      ? round(strategyPerformanceService.maxDrawdownFromPnls(s.__pnls))
      : null;

    const lossAbs = Math.abs(s.__lossSum || 0);
    if (lossAbs === 0) {
      s.profitFactor = null;
      s.profitFactorNote = (s.__winSum || 0) > 0 ? 'no_losing_trades' : 'no_trades_with_pnl';
    } else {
      s.profitFactor = round((s.__winSum || 0) / lossAbs);
      s.profitFactorNote = null;
    }

    // provenance-sammanfattning
    const bf = s.pnlCalculationSources.broker_fill || 0;
    const st = s.pnlCalculationSources.stored_net || 0;
    const dv = s.pnlCalculationSources.derived_with_current_commission || 0;
    const provenanceTypes = [bf > 0 ? 'broker_fill' : null, st > 0 ? 'stored_net' : null, dv > 0 ? 'derived_with_current_commission' : null].filter(Boolean);
    s.pnlProvenance = provenanceTypes.length > 1 ? 'mixed' : (provenanceTypes[0] || 'none');

    delete s.__winSum;
    delete s.__lossSum;
    delete s.__pnls;
    out.push(s);
  }
  out.sort((a, b) => a.strategyId.localeCompare(b.strategyId));
  return out;
}

// Läser stängda futures-positioner ur ledgern, kopplar provenance ur trades.jsonl
// och aggregerar. Canonical numeriska värden kommer från ledgerns läsmodell.
function buildLegacyStrategyStats() {
  const provenance = provenanceByTradeId();
  let closed = [];
  try {
    const positions = futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperPositions();
    closed = Array.isArray(positions.closedPositions) ? positions.closedPositions : [];
  } catch (err) { closed = []; }

  const normalized = closed
    .filter((row) => row && row.status === 'closed')
    .map((row) => ({
      strategyId: row.strategyId,
      netPnlSek: row.netPnlSek != null ? row.netPnlSek : row.realizedPnlSek,
      grossPnlSek: row.grossPnlSek,
      feesSek: row.feesSek,
      dataSource: row.dataSource || 'unknown',
      executionSource: internalSimulationRetirement.LEGACY_SOURCE,
      provenance: provenance.get(row.tradeId) || 'derived_with_current_commission',
    }));
  return aggregateTrades(normalized);
}

// IBKR:s reqExecutions returnerar bara innevarande handelsdag, och broker-
// executions persisteras inte. Stängda trades från tidigare dagar finns däremot
// kvar i intent-loggen med brokerns egen realiserade PnL (filledRealizedPNL).
// Utan den här källan nollställs all historik vid dygnsskiftet.
function closedIntentRows(intents = []) {
  const rows = [];
  for (const intent of (Array.isArray(intents) ? intents : [])) {
    if (!intent || intent.status !== 'filled') continue;
    const realized = Number(
      intent.filledRealizedPNL ?? intent.filledRealizedPnl ?? intent.realizedPNL,
    );
    // Endast broker-verifierad realiserad PnL räknas — samma krav som
    // isClosedBrokerExecution ställer på live-executions. Härledda värden undviks.
    if (!Number.isFinite(realized)) continue;
    const fees = (Number(intent.entryCommission) || 0) + (Number(intent.filledCommission) || 0);
    rows.push({
      execId: intent.filledExecId || null,
      strategyId: intent.strategyId || intent.orderRef || null,
      realizedResult: realized,
      commission: fees,
    });
  }
  return rows;
}

function buildStrategyStats({ executions = [], intents = [] } = {}) {
  const closedExecutions = (Array.isArray(executions) ? executions : [])
    .filter((row) => row && (row.strategyId || row.orderRef) && isClosedBrokerExecution(row));
  // Live-executionen vinner när samma fill finns i båda källorna, så en trade
  // som stängdes idag inte räknas två gånger.
  const seenExecIds = new Set(closedExecutions.map((row) => row.execId).filter(Boolean));
  const historical = closedIntentRows(intents)
    .filter((row) => !(row.execId && seenExecIds.has(row.execId)));

  const normalized = [...closedExecutions, ...historical]
    .filter((row) => row.strategyId || row.orderRef)
    .map((row) => ({
      strategyId: row.strategyId || row.orderRef,
      netPnlSek: row.realizedResult ?? row.realizedPnlSek ?? row.realizedPnl ?? row.realizedPNL,
      grossPnlSek: row.realizedResult ?? row.realizedPnlSek ?? row.realizedPnl ?? row.realizedPNL,
      feesSek: row.commission ?? 0,
      dataSource: 'ibkr_paper',
      executionSource: 'ibkr_paper',
      provenance: 'broker_fill',
    }));
  return aggregateTrades(normalized);
}

function readBrokerExecutions(options = {}) {
  if (Array.isArray(options.executions)) return options.executions;
  if (options.reconciliation && Array.isArray(options.reconciliation.executions)) {
    return options.reconciliation.executions;
  }
  try {
    const cached = ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService
      .reconciliation.getCachedReconciliation();
    return Array.isArray(cached?.executions) ? cached.executions : [];
  } catch (_) {
    return [];
  }
}

// Deterministisk topplistval: primärt värde, sedan fler trades, sedan strategyId.
function pickLeader(list, valueFn, { minTrades = 0 } = {}) {
  const eligible = list.filter((s) => s.closedTrades >= minTrades && valueFn(s) !== null && valueFn(s) !== undefined);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const va = valueFn(a);
    const vb = valueFn(b);
    if (vb !== va) return vb - va;
    if (b.closedTrades !== a.closedTrades) return b.closedTrades - a.closedTrades;
    return a.strategyId.localeCompare(b.strategyId);
  });
  const w = eligible[0];
  return { strategyId: w.strategyId, displayName: w.displayName, value: valueFn(w), closedTrades: w.closedTrades };
}

function buildLeaders(list) {
  return {
    highestNetPnl: pickLeader(list, (s) => s.netPnlSek),
    highestWinRate: pickLeader(list, (s) => s.winRatePct, { minTrades: MIN_TRADES_FOR_RATE_LEADERS }),
    mostWins: pickLeader(list, (s) => s.wins),
    highestAverageNetPnl: pickLeader(list, (s) => s.avgNetPnlSek, { minTrades: MIN_TRADES_FOR_RATE_LEADERS }),
    performanceContext: 'ibkr_paper',
    notRealMarketPerformance: false,
    minTradesForRateLeaders: MIN_TRADES_FOR_RATE_LEADERS,
  };
}

// Publikt: karta strategyId → stats (för aggregatorn) + lista + topplistor.
function getPerformance(options = {}) {
  const executions = readBrokerExecutions(options);
  const strategies = buildStrategyStats({ executions });
  return {
    status: 'ok',
    readOnly: true,
    generatedAt: nowIso(),
    performanceContext: 'ibkr_paper',
    executionSource: 'ibkr_paper',
    notRealMarketPerformance: false,
    legacySimulationExcluded: true,
    count: strategies.length,
    strategies,
    leaders: buildLeaders(strategies),
    ...SAFETY,
  };
}

function getPerformanceMap() {
  const map = new Map();
  for (const s of buildStrategyStats({ executions: readBrokerExecutions() })) map.set(s.strategyId, s);
  return map;
}

module.exports = {
  SAFETY,
  MIN_TRADES_FOR_RATE_LEADERS,
  aggregateTrades,
  // Kanonisk nollstatistik — används även för strategier som bara har en öppen
  // position, så att antal/summor blir 0 i stället för okända.
  emptyStats,
  // Persisterad stängningshistorik ur intent-loggen — används även för
  // verifieringen i deskens performance-normalisering.
  closedIntentRows,
  buildStrategyStats,
  buildLegacyStrategyStats,
  isClosedBrokerExecution,
  readBrokerExecutions,
  buildLeaders,
  pickLeader,
  provenanceByTradeId,
  getPerformance,
  getPerformanceMap,
};
