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
const marketDna = require('../market/marketDnaService');
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

// ── lägesspecifika avsnitt ───────────────────────────────────────────────────
//
// De tre lägena svarar på tre olika frågor, och rapporten ska svara på den
// fråga som ställdes — inte på alla tre varje gång.
//
//   production  Hade Paper gjort så här? (Rapportens huvuddel räcker.)
//   strategy    Hur bra är varje strategi FÖR SIG? Underlag till AI.
//   portfolio   Vilka bör gå till Paper, och hur trängs de?
//
// Gemensamt: inget avsnitt räknar om en siffra som redan finns.

function buildStrategyModeReport(runResult, scores) {
  const decisions = runResult.decisions || [];
  const signalsByStrategy = tally(decisions.filter((row) => row.decision === 'SIGNAL'), 'strategyId');
  const blocksByStrategy = tally(runResult.riskBlocks || [], 'strategyId');

  // En rad per strategi, med hela dess isolerade underlag. Det är precis den
  // här tabellen AI ska tränas mot — varje strategi mätt på sitt eget flöde,
  // inte på vad som blev över när någon annan tog platsen.
  const rows = scores.perStrategy.map((score) => ({
    strategyId: score.strategyId,
    signals: signalsByStrategy[score.strategyId] || 0,
    blocked: blocksByStrategy[score.strategyId] || 0,
    trades: score.stats.trades,
    strategyScore: score.total,
    band: score.band,
    winRate: score.stats.winRate,
    expectancyUsd: score.stats.expectancyUsd,
    profitFactor: score.stats.profitFactor,
    maxDrawdownUsd: score.stats.maxDrawdownUsd,
    meetsWinRateFloor: score.meetsWinRateFloor,
    qualified: score.qualified,
    confidence: score.confidence,
    // Så få affärer att poängen inte betyder något ännu.
    sampleWarning: score.qualified ? null : 'thin_sample',
  }));

  return {
    mode: 'strategy',
    purpose: 'AI-träning: varje strategi isolerad med eget kapital och egen positionsplats.',
    minTradesForRanking: strategyScore.MIN_TRADES_FOR_RANKING,
    strategies: rows,
    // Kandidater för portföljläget. Kräver ett underlag som håller — annars
    // hade en enda lyckträff kunnat ta sig hela vägen till Paper.
    portfolioCandidates: rows
      .filter((row) => row.qualified && row.strategyScore >= 55)
      .map((row) => row.strategyId),
    thinSamples: rows.filter((row) => row.sampleWarning).map((row) => row.strategyId),
  };
}

function buildPortfolioModeReport(runResult, scores) {
  const closed = (runResult.trades || []).filter((row) => row.status === 'closed');
  const allocationBlocks = (runResult.riskBlocks || []).filter((row) => row.allocationBlock === true);
  const netTotal = closed.reduce((total, row) => total + (Number(row.netPnlUsd) || 0), 0);

  const byStrategy = new Map();
  for (const row of closed) {
    const key = row.strategyId || 'unknown';
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(row);
  }

  const scoreOf = new Map(scores.perStrategy.map((row) => [row.strategyId, row]));

  // Andel av portföljens resultat är bara meningsfull mot en POSITIV summa. Med
  // en förlustbringande portfölj gav divisionen omvända tecken: en strategi som
  // tjänade pengar redovisades som -53 % "bidrag". Andelen av den absoluta
  // rörelsen är däremot alltid definierad och behåller sitt tecken.
  //
  // Nämnaren summeras per STRATEGI, inte per affär. Med affärer i nämnaren och
  // strateginetton i täljaren tog andelarna inte ut varandra till 100 %, för då
  // jämfördes två olika saker.
  const netByStrategy = new Map(
    [...byStrategy.entries()].map(([strategyId, rows]) => [
      strategyId,
      rows.reduce((total, row) => total + (Number(row.netPnlUsd) || 0), 0),
    ]),
  );
  const grossAbsolute = [...netByStrategy.values()]
    .reduce((total, net) => total + Math.abs(net), 0);

  // Rangordningen inför Paper. Bidraget till portföljens resultat väger, men
  // avgör inte ensamt: en strategi som tjänar pengar och samtidigt tränger ut
  // alla andra är inte självklart den man vill ta vidare.
  const ranking = [...byStrategy.entries()].map(([strategyId, rows]) => {
    const net = netByStrategy.get(strategyId) || 0;
    const score = scoreOf.get(strategyId);
    return {
      strategyId,
      trades: rows.length,
      netPnlUsd: Math.round(net * 100) / 100,
      // Andel av en VINST. Null när portföljen inte gick plus — då finns ingen
      // vinst att fördela, och ett procenttal hade bara varit vilseledande.
      shareOfProfitPct: netTotal > 0 ? Math.round((net / netTotal) * 10000) / 100 : null,
      // Alltid definierad: hur stor del av portföljens totala rörelse strategin
      // stod för, med sitt eget tecken.
      shareOfActivityPct: grossAbsolute > 0 ? Math.round((net / grossAbsolute) * 10000) / 100 : null,
      strategyScore: score?.total ?? null,
      band: score?.band ?? null,
      qualified: score?.qualified ?? false,
      confidence: score?.confidence ?? 0,
      winRate: score?.stats.winRate ?? null,
      meetsWinRateFloor: score?.meetsWinRateFloor ?? false,
      // Hur ofta strategin stängdes ute av att portföljen var full.
      crowdedOut: allocationBlocks.filter((row) => row.strategyId === strategyId).length,
    };
  }).sort((a, b) => Number(b.qualified) - Number(a.qualified) // ogrundade sist
    || (b.strategyScore ?? -1) - (a.strategyScore ?? -1)
    || b.netPnlUsd - a.netPnlUsd);

  return {
    mode: 'portfolio',
    purpose: 'Slutlig rangordning innan Paper: godkända strategier i samma kapital.',
    maxConcurrentPositions: runResult.config?.allocation?.maxConcurrentPositions ?? null,
    approvedStrategies: runResult.config?.allocation?.approvedStrategies ?? null,
    sharedCapital: runResult.config?.allocation?.sharedCapital === true,
    ranking,
    // Rangordningens faktiska svar. Kräver ett underlag som håller — en
    // strategi med för få affärer kan aldrig rekommenderas till Paper, hur
    // bra siffrorna än ser ut.
    readyForPaper: ranking
      .filter((row) => row.qualified && row.strategyScore >= 55 && row.netPnlUsd > 0)
      .map((row) => row.strategyId),
    blockedByThinSample: ranking.filter((row) => !row.qualified).map((row) => row.strategyId),
    crowding: {
      // Trängseln är portföljens egen kostnad. Är den hög är taket för lågt,
      // eller så är strategierna för lika varandra.
      blockedByConcurrency: allocationBlocks.length,
      byStrategy: tally(allocationBlocks, 'strategyId'),
      booksUsed: runResult.counts?.books ?? null,
    },
    portfolioPerformance: runResult.performance || null,
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

  // ── Market Classification och Market DNA ──────────────────────────────────
  const classification = marketClassification.classifyRun(runResult.candlesBySymbol || {});
  // DNA per symbol, plus ett sammanslaget avtryck för hela körningen. Etiketten
  // säger VAD marknaden var; DNA:t är fingeravtrycket som gör det möjligt att
  // hitta liknande perioder och se vad strategin aldrig prövats i.
  const dnaBySymbol = Object.entries(runResult.candlesBySymbol || {})
    .map(([symbol, candles]) => marketDna.computeMarketDna(candles, {
      symbol,
      from: runResult.config?.from || null,
      to: runResult.config?.effectiveTo || runResult.config?.to || null,
    }));
  const dnaSummary = marketDna.summarizeDnaSet(dnaBySymbol);

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

  const mode = runResult.config?.mode || 'production';
  const modeReport = mode === 'strategy' ? buildStrategyModeReport(runResult, scores)
    : mode === 'portfolio' ? buildPortfolioModeReport(runResult, scores)
      : {
        mode: 'production',
        purpose: 'Identisk med Paper Trading: en bok, samma grindar, samma positionstak.',
      };

  return {
    version: REPORT_VERSION,
    engineVersion: runResult.engineVersion || null,
    mode,
    modeReport,
    books: (runResult.books || []).map((book) => ({
      bookId: book.bookId,
      trades: book.trades.length,
      performance: book.performance,
    })),
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
      // Åtskilda med flit: Broker Risk säger "ordern får inte läggas", medan
      // allokeringen säger "portföljen har ingen plats". Olika frågor, olika
      // åtgärder.
      fromAllocation: runResult.counts?.allocationBlocked || 0,
      fromBrokerRisk: (runResult.counts?.riskBlocked || 0) - (runResult.counts?.allocationBlocked || 0),
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
    marketDna: {
      perSymbol: dnaBySymbol,
      // Ett avtryck för hela körningen: mängden förhållanden den täckte.
      combinedHash: marketDna.combineMarketDnaHashes(dnaBySymbol.map((row) => row.dnaHash)),
      // Grov regim är det som räknas när man frågar "hur många regimer".
      // Skiljer sig symbolerna åt redovisas båda i stället för ett medelvärde.
      regimeKeys: [...new Set(dnaBySymbol.map((row) => row.regimeKey).filter((key) => key && key !== 'unknown'))],
      distinctProfiles: dnaSummary.distinctProfiles,
      distinctRegimes: dnaSummary.distinctRegimes,
    },
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
