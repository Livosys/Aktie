'use strict';

// ── Replay Report ────────────────────────────────────────────────────────────
//
// Sammanställer en körning till det rapporten ska visa:
//
//   Signals Generated · Signals Filtered · Risk Blocks · Decision Monitor ·
//   Trades · Execution Cost · Strategy Score · Execution Score ·
//   Market Classification
//
// Rapporten RÄKNAR inte om något. Varje siffra kommer från den modul som äger
// den: fillReportService äger Strategy Edge kontra Execution Edge,
// strategyScoreV1Service äger Strategy Score, marketClassificationService äger
// klassificeringen, ledgern äger affärerna. Att räkna om en siffra här hade
// gjort rapporten till en andra sanning.
//
// ── Spårbarhet ───────────────────────────────────────────────────────────────
//
// Kravet "det skall gå att klicka från ett trade-resultat tillbaka till den
// signal som skapade traden" uppfylls av ett uppslagsindex, inte av en länk i
// UI:t. Varje affär bär signalId; indexet binder signalId till strategin,
// beslutet, riskutfallet och fyllningen. Vägen bakåt finns alltså i datan och
// fungerar likadant i API, UI och test.
//
// Ren beräkning: ingen IO, ingen klocka.

const fillReport = require('../execution/fillReportService');
const strategyScore = require('../score/strategyScoreV1Service');
const marketClassification = require('./marketClassificationService');
const strategyRegistry = require('../nativeFuturesStrategyRegistryService');
const ledgerMath = require('../futuresPaperLedgerService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'replay_report',
});

const REPORT_VERSION = 'replay-report-v1';

function tally(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = row[key] == null ? 'null' : String(row[key]);
    out.set(value, (out.get(value) || 0) + 1);
  }
  return Object.fromEntries([...out.entries()].sort((a, b) => b[1] - a[1]));
}

// Ledger-rader → fillReportens affärsform. Formen ägs av fillReportService;
// den här funktionen översätter bara fältnamn.
function toFillReportTrades(trades) {
  return trades
    .filter((row) => row.status === 'closed' && row.exit)
    .map((row) => ({
      symbol: row.symbol,
      side: row.side === 'short' ? 'sell' : 'buy',
      quantity: row.contracts,
      multiplier: 1,
      entry: row.entry,
      exit: row.exit,
    }));
}

// ── två sorters exekveringskostnad ───────────────────────────────────────────
//
// Execution cost är skillnaden mellan förväntat och verkligt pris. Den summan
// döljer två helt olika saker, och att slå ihop dem gör Execution Score
// missvisande:
//
//   modellerad   spread och slippage — det fyllningsmodellen medvetet tar
//                betalt. Storleksordning: någon enstaka tick.
//   drift        marknadens rörelse under den modellerade fyllnadsfördröjningen.
//                Det är INTE en exekveringskostnad i egentlig mening utan en
//                konsekvens av att en marknadsorder inte kan fyllas i samma
//                ögonblick som beslutet fattas. Den kan vara både positiv och
//                negativ och är ofta tio gånger större än den modellerade.
//
// Att sänka driften görs genom att byta ordertyp eller besluta oftare — inte
// genom att justera slippage-parametern. Därför redovisas de var för sig.
function decomposeExecutionCost(closedTrades) {
  let modelled = 0;
  let total = 0;
  let counted = 0;
  for (const row of closedTrades) {
    if (row.executionCostUsd == null) continue;
    const pointValue = ledgerMath.getPointValueUsd(row.root) || 0;
    const priceUnits = (Number(row.entry?.slippage) || 0) + (Number(row.entry?.spread) || 0)
      + (Number(row.exit?.slippage) || 0) + (Number(row.exit?.spread) || 0);
    modelled += priceUnits * pointValue * (row.contracts || 1);
    total += row.executionCostUsd;
    counted += 1;
  }
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    trades: counted,
    totalUsd: counted ? round2(total) : null,
    modelledSpreadAndSlippageUsd: counted ? round2(modelled) : null,
    // Resten: marknadens rörelse mellan beslut och fyllning.
    fillDelayDriftUsd: counted ? round2(total - modelled) : null,
  };
}

/**
 * Bygger rapporten för ett RunResult från nativeReplayEngineService.
 */
function buildReplayReport(runResult = {}) {
  const trades = runResult.trades || [];
  const closed = trades.filter((row) => row.status === 'closed');
  const decisions = runResult.decisions || [];

  // ── Execution Edge ────────────────────────────────────────────────────────
  const execution = fillReport.buildFillReport(toFillReportTrades(trades), {
    engine: runResult.config?.fillEngine?.engine || null,
    unfilledOrders: runResult.counts?.unfilledEntries || 0,
  });
  const executionScore = fillReport.calculateExecutionScore(execution);

  // ── Strategy Score ────────────────────────────────────────────────────────
  const scores = strategyScore.scoreByStrategy(
    runResult.tradesByStrategy || new Map(),
    closed,
  );

  // ── Market Classification ─────────────────────────────────────────────────
  const classification = marketClassification.classifyRun(runResult.candlesBySymbol || {});

  // ── Decision Monitor ──────────────────────────────────────────────────────
  const signalDecisions = decisions.filter((row) => row.decision === 'SIGNAL');
  const decisionMonitor = {
    evaluations: decisions.length,
    byDecision: tally(decisions, 'decision'),
    bySnapshotStatus: tally(decisions, 'snapshotStatus'),
    byStrategy: tally(decisions, 'strategyId'),
    // Vilka strategier som faktiskt sa SIGNAL, och hur ofta.
    signalsByStrategy: tally(signalDecisions, 'strategyId'),
    signalsBySymbol: tally(signalDecisions, 'symbol'),
    // Vanligaste anledningen till att inget hände.
    topReasons: Object.entries(tally(decisions.filter((r) => r.decision !== 'SIGNAL'), 'reason'))
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
  };

  // ── Spårbarhetsindex: trade → signal → beslut → risk → fyllning ───────────
  const traceBySignalId = {};
  for (const row of trades) {
    traceBySignalId[row.signalId] = {
      tradeId: row.tradeId,
      signalId: row.signalId,
      strategyId: row.strategyId,
      candidateId: row.candidateId,
      signalFamily: row.signalFamily,
      signalSubtype: row.signalSubtype,
      symbol: row.symbol,
      direction: row.direction,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      exitReason: row.exitReason,
      entry: row.entry,
      exit: row.exit,
      strategyPnlUsd: row.strategyPnlUsd,
      executedPnlUsd: row.executedPnlUsd,
      executionCostUsd: row.executionCostUsd,
      netPnlUsd: row.netPnlUsd,
      originStrategyId: strategyRegistry.originStrategyIdFor(row.strategyId),
    };
  }

  return {
    version: REPORT_VERSION,
    engineVersion: runResult.engineVersion || null,
    config: runResult.config || null,
    dataCoverage: runResult.dataCoverage || null,
    ticks: runResult.ticks || 0,

    // ── de nio rubrikerna ───────────────────────────────────────────────────
    signalsGenerated: runResult.counts?.signalsGenerated || 0,
    signalsFiltered: {
      // Signaler som strategin sa ja till men som inte överlevde kontraktet.
      rejectedByContract: runResult.counts?.signalsRejectedByContract || 0,
      // Dubbletter av samma signalId över flera tick.
      duplicateSignalIds: Math.max(
        0,
        (runResult.counts?.signalsGenerated || 0) - (runResult.counts?.uniqueSignals || 0),
      ),
      unfilledEntries: runResult.counts?.unfilledEntries || 0,
      rows: runResult.rejectedSignals || [],
    },
    riskBlocks: {
      count: runResult.counts?.riskBlocked || 0,
      byBlocker: tally(
        (runResult.riskBlocks || []).flatMap((row) => (row.blockers || []).map((blocker) => ({ blocker }))),
        'blocker',
      ),
      byStrategy: tally(runResult.riskBlocks || [], 'strategyId'),
      rows: runResult.riskBlocks || [],
    },
    decisionMonitor,
    trades: {
      count: closed.length,
      openAtEnd: runResult.counts?.openAtEnd || 0,
      byExitReason: tally(closed, 'exitReason'),
      byStrategy: tally(closed, 'strategyId'),
      rows: trades,
    },
    executionCost: {
      totalUsd: execution.executionEdge?.totalExecutionCost ?? null,
      avgPerTradeUsd: execution.executionEdge?.avgExecutionCost ?? null,
      shareOfEdgePct: execution.executionEdge?.costShareOfEdge ?? null,
      avgEntryDifference: execution.executionEdge?.avgEntryDifference ?? null,
      avgExitDifference: execution.executionEdge?.avgExitDifference ?? null,
      avgFillDelayMs: execution.executionEdge?.avgFillDelayMs ?? null,
      totalSlippage: execution.executionEdge?.totalSlippage ?? null,
      totalSpread: execution.executionEdge?.totalSpread ?? null,
      fillRatePct: execution.fillRate ?? null,
      // Vad som är modell och vad som är marknadsrörelse.
      decomposition: decomposeExecutionCost(closed),
    },
    strategyEdge: execution.strategyEdge,
    strategyScore: scores,
    executionScore,
    marketClassification: classification,
    performance: runResult.performance || null,

    // ── vägen bakåt ─────────────────────────────────────────────────────────
    traceBySignalId,

    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  REPORT_VERSION,
  buildReplayReport,
  _internal: { toFillReportTrades, tally, decomposeExecutionCost },
};
