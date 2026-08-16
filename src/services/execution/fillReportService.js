'use strict';

// ── Fill Report: Strategy Edge kontra Execution Edge ─────────────────────────
//
// Ett backtest som bara redovisar "resultat" kan inte svara på den viktigaste
// frågan när ett system börjar bli självlärande: är strategin dålig, eller är
// strategin bra men utförandet dåligt? De två kräver rakt motsatta åtgärder —
// den ena ska skrivas om, den andra ska få bättre ordertyper.
//
// Rapporten räknar därför varje affär två gånger:
//
//   Strategy Edge    resultatet med expectedPrice i båda ändar. Det är
//                    strategins egen logik, opåverkad av hur ordern gick.
//                    AI OPTIMERAR MOT DETTA.
//   Execution Edge   skillnaden mellan verkligt och förväntat. Slippage,
//                    spread och latens. Mäts separat och blir Execution Score.
//
// Att låta AI:n optimera mot executedPrice vore att lära den kompensera för
// slippage — den skulle börja välja setuper vars fyllningsbrus råkade falla
// åt rätt håll, vilket inte överlever mötet med nästa marknad.
//
// Ren beräkning: ingen IO, inget nätverk, ingen klocka.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Poängkomponenter för Execution Score. Summerar till 100.
const EXECUTION_SCORE_MAX = Object.freeze({
  fillRate: 30,        // hur ofta ordern över huvud taget blev en affär
  slippageCost: 30,    // hur mycket pris som tappas per affär
  costShare: 25,       // hur stor del av bruttoedgen som äts av exekvering
  fillDelay: 15,       // hur länge ordern låg innan den fylldes
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Riktningstecken: en köpt position tjänar på att priset stiger.
function directionSign(side) {
  return side === 'buy' ? 1 : -1;
}

/**
 * En affär i rapportens mening: en entry-fill och en exit-fill, båda med sitt
 * förväntade och sitt verkliga pris.
 *
 *   { symbol, side, quantity,
 *     entry: { expectedPrice, executedPrice, fillDelayMs, slippage, spread, status },
 *     exit:  { expectedPrice, executedPrice, fillDelayMs, slippage, spread, status },
 *     multiplier }
 */
function buildTradeExecution(trade = {}) {
  const side = trade.side === 'sell' ? 'sell' : 'buy';
  const sign = directionSign(side);
  const qty = num(trade.quantity) || 0;
  const multiplier = num(trade.multiplier) || 1;

  const entryExpected = num(trade.entry?.expectedPrice);
  const entryExecuted = num(trade.entry?.executedPrice);
  const exitExpected = num(trade.exit?.expectedPrice);
  const exitExecuted = num(trade.exit?.executedPrice);

  // Strategins eget resultat: förväntat in, förväntat ut.
  const strategyPnl = (entryExpected != null && exitExpected != null)
    ? round(sign * (exitExpected - entryExpected) * qty * multiplier, 4)
    : null;

  // Verkligt resultat: så som ordrarna faktiskt fylldes.
  const executedPnl = (entryExecuted != null && exitExecuted != null)
    ? round(sign * (exitExecuted - entryExecuted) * qty * multiplier, 4)
    : null;

  // Kostnaden är skillnaden. Positivt tal = exekveringen kostade pengar.
  const executionCost = (strategyPnl != null && executedPnl != null)
    ? round(strategyPnl - executedPnl, 4)
    : null;

  const entryDifference = (entryExpected != null && entryExecuted != null)
    ? round(entryExecuted - entryExpected, 6) : null;
  const exitDifference = (exitExpected != null && exitExecuted != null)
    ? round(exitExecuted - exitExpected, 6) : null;

  return {
    symbol: trade.symbol || null,
    side,
    quantity: qty,
    // Fill Report-fälten, med de namn rapporten utlovar.
    entryPrice: entryExecuted,
    expectedEntry: entryExpected,
    executedEntry: entryExecuted,
    entryDifference,
    expectedExit: exitExpected,
    executedExit: exitExecuted,
    exitDifference,
    fillDelayMs: num(trade.entry?.fillDelayMs),
    exitFillDelayMs: num(trade.exit?.fillDelayMs),
    slippage: round((num(trade.entry?.slippage) || 0) + (num(trade.exit?.slippage) || 0), 6),
    spread: round((num(trade.entry?.spread) || 0) + (num(trade.exit?.spread) || 0), 6),
    strategyPnl,
    executedPnl,
    executionCost,
    entryStatus: trade.entry?.status || null,
    exitStatus: trade.exit?.status || null,
  };
}

/**
 * Aggregerar affärer till en rapport med två skilda resultatspår.
 */
function buildFillReport(trades = [], { engine = null, unfilledOrders = 0 } = {}) {
  const rows = trades.map(buildTradeExecution);
  const complete = rows.filter((row) => row.strategyPnl != null && row.executedPnl != null);

  const sum = (list, key) => list.reduce((total, row) => total + (num(row[key]) || 0), 0);

  const strategyPnl = round(sum(complete, 'strategyPnl'), 4);
  const executedPnl = round(sum(complete, 'executedPnl'), 4);
  const executionCost = round(sum(complete, 'executionCost'), 4);
  const totalOrders = rows.length + unfilledOrders;

  const wins = (key) => complete.filter((row) => (num(row[key]) || 0) > 0).length;

  return {
    engine,
    trades: rows,
    counts: {
      trades: rows.length,
      completeTrades: complete.length,
      unfilledOrders,
      totalOrders,
    },
    // Strategy Edge — det AI ska optimera mot.
    strategyEdge: {
      pnl: strategyPnl,
      wins: wins('strategyPnl'),
      winRate: complete.length ? round((wins('strategyPnl') / complete.length) * 100, 2) : null,
      avgPnl: complete.length ? round(strategyPnl / complete.length, 4) : null,
    },
    // Execution Edge — mäts separat, optimeras aldrig mot.
    executionEdge: {
      pnl: executedPnl,
      wins: wins('executedPnl'),
      winRate: complete.length ? round((wins('executedPnl') / complete.length) * 100, 2) : null,
      avgPnl: complete.length ? round(executedPnl / complete.length, 4) : null,
      totalExecutionCost: executionCost,
      avgExecutionCost: complete.length ? round(executionCost / complete.length, 4) : null,
      // Hur stor andel av bruttoedgen som försvann i utförandet.
      costShareOfEdge: (strategyPnl && strategyPnl > 0)
        ? round((executionCost / strategyPnl) * 100, 2) : null,
      avgEntryDifference: complete.length
        ? round(sum(complete, 'entryDifference') / complete.length, 6) : null,
      avgExitDifference: complete.length
        ? round(sum(complete, 'exitDifference') / complete.length, 6) : null,
      avgFillDelayMs: complete.length
        ? Math.round(sum(complete, 'fillDelayMs') / complete.length) : null,
      totalSlippage: round(sum(complete, 'slippage'), 6),
      totalSpread: round(sum(complete, 'spread'), 6),
    },
    fillRate: totalOrders ? round((rows.length / totalOrders) * 100, 2) : null,
    ...SAFETY,
  };
}

/**
 * Execution Score, 0–100.
 *
 * Skilt från Strategy Score med flit. En strategi kan ha utmärkt logik och
 * uselt utförande, eller tvärtom — och åtgärden skiljer sig helt. Tillsammans
 * med Production Score (paper/live över tid) ger de tre betygen AI:n möjlighet
 * att skilja "strategin är dålig" från "strategin är bra men utförandet är det
 * inte".
 */
function calculateExecutionScore(report = {}) {
  const e = report.executionEdge || {};
  const components = {};

  // Inget fylldes. Då finns inget utförande att betygsätta, och att ge halva
  // poäng för okända komponenter vore att belöna frånvaron av data.
  if (!(Number(report.counts?.completeTrades) > 0)) {
    const zeroed = Object.fromEntries(Object.keys(EXECUTION_SCORE_MAX).map((k) => [k, 0]));
    return {
      total: 0,
      components: zeroed,
      max: { ...EXECUTION_SCORE_MAX },
      band: 'prohibitive',
      reason: 'no_complete_trades',
      ...SAFETY,
    };
  }

  // Fyllningsgrad: en order som aldrig blir en affär är den dyraste av alla.
  const fillRate = num(report.fillRate);
  components.fillRate = fillRate == null ? 0
    : round((clamp(fillRate, 0, 100) / 100) * EXECUTION_SCORE_MAX.fillRate, 2);

  // Kostnad per affär, normerad mot ett tickvärde. 0 kostnad = full poäng.
  const avgCost = num(e.avgExecutionCost);
  const tickValue = num(report.tickValue) || 0.5;
  components.slippageCost = avgCost == null ? 0
    : round(EXECUTION_SCORE_MAX.slippageCost * (1 - clamp(Math.abs(avgCost) / (tickValue * 8), 0, 1)), 2);

  // Andel av edgen som äts upp. Under 10 % är bra, över 60 % är illa.
  const share = num(e.costShareOfEdge);
  components.costShare = share == null
    ? round(EXECUTION_SCORE_MAX.costShare * 0.5, 2)
    : round(EXECUTION_SCORE_MAX.costShare * (1 - clamp((Math.abs(share) - 10) / 50, 0, 1)), 2);

  // Fyllningsfördröjning. En bar (60 s) är fortfarande rimligt.
  const delay = num(e.avgFillDelayMs);
  components.fillDelay = delay == null ? 0
    : round(EXECUTION_SCORE_MAX.fillDelay * (1 - clamp(delay / (5 * 60 * 1000), 0, 1)), 2);

  const total = round(Object.values(components).reduce((a, b) => a + b, 0), 2);
  return {
    total: clamp(total, 0, 100),
    components,
    max: { ...EXECUTION_SCORE_MAX },
    band: total >= 80 ? 'clean' : total >= 60 ? 'acceptable' : total >= 40 ? 'costly' : 'prohibitive',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  EXECUTION_SCORE_MAX,
  buildTradeExecution,
  buildFillReport,
  calculateExecutionScore,
};
