'use strict';

// ── Trade Ledger ─────────────────────────────────────────────────────────────
//
// Bokföringen över vad som faktiskt hände: vilken signal som blev vilken order,
// vilken order som blev vilken position, och vad positionen kostade.
//
// Två saker gör den till en egen modul i stället för en del av replay:
//
//   1. VARJE affär bär hela sin härkomst — signalId, strategyId, candidateId,
//      signalFamily, signalSubtype. Det är det som gör att man kan klicka från
//      ett resultat tillbaka till signalen som skapade det. Härkomsten är inte
//      metadata som läggs på i efterhand; den är obligatorisk vid öppning, och
//      en affär utan signalId går inte att bokföra.
//
//   2. Varje affär räknas TVÅ gånger, med samma åtskillnad som fillReport:
//        strategyPnl   expectedPrice i båda ändar — strategins egen förtjänst
//        executedPnl   verkliga fills — vad exekveringen gjorde av den
//      Skillnaden är execution cost. AI får senare bara se det första.
//
// Pengamatten (punktvärde, kommission, PnL) ÄGS av futuresPaperLedgerService
// och importeras härifrån. Att räkna om MNQ:s punktvärde på ett andra ställe
// vore precis den sortens dubblering som gör att två delar av systemet till
// slut rapporterar olika resultat för samma affär.
//
// Deterministisk och tidlös: ingen fil-IO, ingen klocka, ingen Math.random,
// ingen broker. `now` skickas alltid in.

const paperLedgerMath = require('../futuresPaperLedgerService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'trade_ledger',
});

const TRADE_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

// Affärens id härleds ur signalen, inte ur en slumpgenerator. Paper-ledgerns
// createTradeId använder Math.random, vilket gör två identiska körningar
// omöjliga att jämföra — och en icke-reproducerbar körning är inget bevis.
function deterministicTradeId(signalId, sequence) {
  return `trade:${signalId}#${sequence}`;
}

function normalizeFillSide(side) {
  return String(side || '').toLowerCase() === 'short' ? 'short' : 'long';
}

function fillView(fill = {}) {
  return {
    expectedPrice: num(fill.expectedPrice),
    executedPrice: num(fill.executedPrice),
    timestamp: text(fill.timestamp),
    fillDelayMs: num(fill.fillDelayMs),
    slippage: num(fill.slippage),
    spread: num(fill.spread),
    status: text(fill.status),
    engine: text(fill.engine),
  };
}

// Största fall från en topp i den ackumulerade strategikurvan. Räknas på
// strategyPnl — exekveringens bidrag mäts separat och ska inte blandas in.
function maxDrawdown(rows) {
  let peak = 0;
  let equity = 0;
  let worst = 0;
  for (const row of rows) {
    equity += row.strategyPnlUsd;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > worst) worst = dd;
  }
  return round(worst, 2);
}

/**
 * Sammanfattar en uppsättning affärer.
 *
 * Ligger utanför ledgern med flit: Replay Framework kör flera böcker samtidigt
 * och måste kunna summera dem tillsammans utan en andra uträkning. Att ha två
 * funktioner som räknar profit factor är hur två delar av ett system börjar
 * rapportera olika resultat för samma affärer.
 */
function summarizeTrades(trades = []) {
  const closed = trades.filter((row) => row.status === TRADE_STATUS.CLOSED);
  const open = trades.filter((row) => row.status === TRADE_STATUS.OPEN);
  const withResult = closed.filter((row) => num(row.strategyPnlUsd) != null);
  const sum = (key) => withResult.reduce((total, row) => total + (num(row[key]) || 0), 0);
  const wins = withResult.filter((row) => row.strategyPnlUsd > 0);
  const losses = withResult.filter((row) => row.strategyPnlUsd < 0);
  const grossWin = wins.reduce((total, row) => total + row.strategyPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((total, row) => total + row.strategyPnlUsd, 0));

  return {
    trades: closed.length,
    openTrades: open.length,
    scored: withResult.length,
    wins: wins.length,
    losses: losses.length,
    winRate: withResult.length ? round((wins.length / withResult.length) * 100, 2) : null,
    strategyPnlUsd: round(sum('strategyPnlUsd'), 2),
    executedPnlUsd: round(sum('executedPnlUsd'), 2),
    executionCostUsd: round(sum('executionCostUsd'), 2),
    commissionUsd: round(sum('commissionUsd'), 2),
    netPnlUsd: round(sum('netPnlUsd'), 2),
    avgWinUsd: wins.length ? round(grossWin / wins.length, 2) : null,
    avgLossUsd: losses.length ? round(grossLoss / losses.length, 2) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : (grossWin > 0 ? null : 0),
    expectancyUsd: withResult.length ? round(sum('strategyPnlUsd') / withResult.length, 2) : null,
    maxDrawdownUsd: maxDrawdown(withResult),
    avgHoldingMs: withResult.length
      ? Math.round(withResult.reduce((t, r) => t + (r.holdingMs || 0), 0) / withResult.length) : null,
  };
}

function createTradeLedger(options = {}) {
  const math = options.ledgerMath || paperLedgerMath;
  const trades = new Map();
  let sequence = 0;

  function pnlFor({ root, side, entryPrice, exitPrice, contracts }) {
    if (entryPrice == null || exitPrice == null) return null;
    return math.calculatePnlUsd({ root, side, entryPrice, exitPrice, contracts });
  }

  /**
   * Öppnar en affär. Härkomsten är obligatorisk.
   */
  function open({
    signalId,
    strategyId = null,
    candidateId = null,
    signalFamily = null,
    signalSubtype = null,
    symbol,
    direction,
    contracts = 1,
    entry = {},
    stopLoss = null,
    takeProfit = null,
    openedAt = null,
    marketClassification = null,
  } = {}) {
    const id = text(signalId);
    if (!id) throw new Error('trade_ledger_requires_signal_id: en affär utan signal går inte att spåra tillbaka');
    const root = math.normalizeRoot(symbol, symbol);
    const side = normalizeFillSide(direction);
    sequence += 1;
    const tradeId = deterministicTradeId(id, sequence);

    const row = {
      tradeId,
      status: TRADE_STATUS.OPEN,
      // ── härkomst: vägen tillbaka till signalen ────────────────────────────
      signalId: id,
      strategyId: text(strategyId),
      candidateId: text(candidateId),
      signalFamily: text(signalFamily),
      signalSubtype: text(signalSubtype),
      // ── position ─────────────────────────────────────────────────────────
      symbol: root,
      root,
      direction: side === 'short' ? 'SHORT' : 'LONG',
      side,
      contracts: num(contracts) || 1,
      stopLoss: num(stopLoss),
      takeProfit: num(takeProfit),
      openedAt: text(openedAt) || text(entry.timestamp),
      entry: fillView(entry),
      exit: null,
      closedAt: null,
      exitReason: null,
      marketClassification: text(marketClassification),
      // ── resultat, fyllt vid stängning ────────────────────────────────────
      strategyPnlUsd: null,
      executedPnlUsd: null,
      executionCostUsd: null,
      commissionUsd: null,
      netPnlUsd: null,
      holdingMs: null,
    };
    trades.set(tradeId, row);
    return row;
  }

  /**
   * Stänger en affär och räknar båda resultatspåren.
   */
  function close(tradeId, { exit = {}, reason = null, closedAt = null } = {}) {
    const row = trades.get(tradeId);
    if (!row) return null;
    if (row.status === TRADE_STATUS.CLOSED) return row;

    const exitFill = fillView(exit);
    const contracts = row.contracts;

    const strategyPnl = pnlFor({
      root: row.root, side: row.side, contracts,
      entryPrice: row.entry.expectedPrice, exitPrice: exitFill.expectedPrice,
    });
    const executedPnl = pnlFor({
      root: row.root, side: row.side, contracts,
      entryPrice: row.entry.executedPrice, exitPrice: exitFill.executedPrice,
    });
    // Round trip: två sidor.
    const commission = math.calcCommissionUsd(row.root, contracts, 2);
    const openedMs = row.openedAt ? new Date(row.openedAt).getTime() : null;
    const closedMs = exitFill.timestamp ? new Date(exitFill.timestamp).getTime() : null;

    row.status = TRADE_STATUS.CLOSED;
    row.exit = exitFill;
    row.exitReason = text(reason);
    row.closedAt = text(closedAt) || exitFill.timestamp;
    row.strategyPnlUsd = strategyPnl;
    row.executedPnlUsd = executedPnl;
    row.executionCostUsd = (strategyPnl != null && executedPnl != null)
      ? round(strategyPnl - executedPnl, 4) : null;
    row.commissionUsd = num(commission);
    row.netPnlUsd = executedPnl != null && commission != null
      ? round(executedPnl - commission, 4) : executedPnl;
    row.holdingMs = (openedMs != null && closedMs != null) ? Math.max(0, closedMs - openedMs) : null;
    return row;
  }

  function all() { return [...trades.values()]; }
  function openTrades() { return all().filter((row) => row.status === TRADE_STATUS.OPEN); }
  function closedTrades() { return all().filter((row) => row.status === TRADE_STATUS.CLOSED); }
  function get(tradeId) { return trades.get(tradeId) || null; }

  /** Positionsvy i den form Broker Risk läser (signerad kvantitet per rad). */
  function brokerPositionsView() {
    return openTrades().map((row) => ({
      symbol: row.root,
      root: row.root,
      position: row.side === 'short' ? -row.contracts : row.contracts,
      quantity: row.contracts,
    }));
  }

  function summary() {
    return summarizeTrades(all());
  }

  /** Affärer grupperade per strategi — underlaget för Strategy Score. */
  function byStrategy() {
    const groups = new Map();
    for (const row of closedTrades()) {
      const key = row.strategyId || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }

  return {
    SAFETY,
    TRADE_STATUS,
    open,
    close,
    get,
    all,
    openTrades,
    closedTrades,
    brokerPositionsView,
    summary,
    byStrategy,
  };
}

module.exports = {
  SAFETY,
  TRADE_STATUS,
  createTradeLedger,
  summarizeTrades,
  _internal: { deterministicTradeId, maxDrawdown },
};
