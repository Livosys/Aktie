'use strict';

// Futures Paper Strategy Performance — READ-ONLY statistik per canonical
// strategyId. Läser ENDAST Futures Paper ledger/storage. Ingen approval-status,
// inget test-run, ingen mutation. Vanlig Paper Trading blandas aldrig in.
//
// Canonical numeriska värden (net/gross/fees) tas från ledgerns läsmodell
// (getFuturesPaperPositions → closedPositions), som normaliserar äldre trades.
// Provenance (stored_net vs derived_with_current_commission) härleds från den
// frusna append-loggen trades.jsonl per tradeId.

const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperStorageService = require('./futuresPaperStorageService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const catalogService = require('./daytradingStrategyCatalogService');

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
    bestTradeSek: null,
    worstTradeSek: null,
    profitFactor: null,
    profitFactorNote: null,
    totalHistoricalClosedTrades: 0,
    dataSources: [],
    usesSimulatedFallback: false,
    pnlCalculationSources: { stored_net: 0, derived_with_current_commission: 0 },
    pnlProvenance: 'none',
  };
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

    const prov = t.provenance || 'derived_with_current_commission';
    s.pnlCalculationSources[prov] = (s.pnlCalculationSources[prov] || 0) + 1;

    s.__winSum = (s.__winSum || 0) + (net > 0 ? net : 0);
    s.__lossSum = (s.__lossSum || 0) + (net < 0 ? net : 0);
  }

  const out = [];
  for (const s of byStrategy.values()) {
    // Win rate: wins / closedTrades (breakeven ingår i totalen, ej i wins/losses).
    s.winRatePct = s.closedTrades > 0 ? round((s.wins / s.closedTrades) * 100, 1) : null;
    s.avgNetPnlSek = s.closedTrades > 0 ? round(s.netPnlSek / s.closedTrades) : null;

    const lossAbs = Math.abs(s.__lossSum || 0);
    if (lossAbs === 0) {
      s.profitFactor = null;
      s.profitFactorNote = (s.__winSum || 0) > 0 ? 'no_losing_trades' : 'no_trades_with_pnl';
    } else {
      s.profitFactor = round((s.__winSum || 0) / lossAbs);
      s.profitFactorNote = null;
    }

    // provenance-sammanfattning
    const st = s.pnlCalculationSources.stored_net || 0;
    const dv = s.pnlCalculationSources.derived_with_current_commission || 0;
    s.pnlProvenance = st > 0 && dv > 0 ? 'mixed' : (st > 0 ? 'stored_net' : (dv > 0 ? 'derived_with_current_commission' : 'none'));

    delete s.__winSum;
    delete s.__lossSum;
    out.push(s);
  }
  out.sort((a, b) => a.strategyId.localeCompare(b.strategyId));
  return out;
}

// Läser stängda futures-positioner ur ledgern, kopplar provenance ur trades.jsonl
// och aggregerar. Canonical numeriska värden kommer från ledgerns läsmodell.
function buildStrategyStats() {
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
      provenance: provenance.get(row.tradeId) || 'derived_with_current_commission',
    }));
  return aggregateTrades(normalized);
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
    performanceContext: 'simulated_fallback',
    notRealMarketPerformance: true,
    minTradesForRateLeaders: MIN_TRADES_FOR_RATE_LEADERS,
  };
}

// Publikt: karta strategyId → stats (för aggregatorn) + lista + topplistor.
function getPerformance() {
  const strategies = buildStrategyStats();
  return {
    status: 'ok',
    readOnly: true,
    generatedAt: nowIso(),
    performanceContext: 'simulated_fallback',
    notRealMarketPerformance: true,
    count: strategies.length,
    strategies,
    leaders: buildLeaders(strategies),
    ...SAFETY,
  };
}

function getPerformanceMap() {
  const map = new Map();
  for (const s of buildStrategyStats()) map.set(s.strategyId, s);
  return map;
}

module.exports = {
  SAFETY,
  MIN_TRADES_FOR_RATE_LEADERS,
  aggregateTrades,
  buildStrategyStats,
  buildLeaders,
  pickLeader,
  provenanceByTradeId,
  getPerformance,
  getPerformanceMap,
};
