// Enhetstester för trade journal-grupperingen (en rad = en trade).
// Ren presentationslogik — ingen broker, inget nätverk, ingen persistence.
// Körs direkt: node --experimental-default-type=module client/src/domain/TradeJournalDomain.test.js
import assert from 'node:assert/strict';
import {
  DEFAULT_TRADE_LIMIT,
  EMPTY_TRADE_FILTERS,
  buildBrokerOrderRows,
  buildFillRows,
  buildStrategyStatistics,
  buildTradeJournal,
  exitReasonOf,
  filterTrades,
  parseOrderRef,
  pnlPercentOf,
  summarizeAttention,
  summarizeTrades,
  tradeFilterOptions,
  tradeMatchesSearch,
  tradeNeedsAttention,
} from './TradeJournalDomain.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL', name, '→', err.message);
  }
}

// Verklig form på en stängd trade ur intent-indexet (fältnamn oförändrade).
const CLOSED_INTENT = {
  executionId: 'fxp_4e146a2488320080',
  idempotencyKey: '98c0fcd44446b16e80e0d8f2898f4815',
  intentId: '98c0fcd44446b16e80e0d8f2898f4815',
  status: 'filled',
  createdAt: '2026-08-12T14:11:45.788Z',
  updatedAt: '2026-08-12T16:40:58.097Z',
  strategyId: 'trend_continuation',
  lifecycleId: 'signal_lifecycle_9c2c69083ee65c0d722f125f',
  tradeId: 'futures_trade_4e146a2488320080',
  candidateId: 'futures_candidate_da6538d7581760f5',
  signalId: 'GOOGL_2026-08-12T14:08:00.000Z',
  root: 'MNQ',
  conId: 793356225,
  direction: 'short',
  executionTarget: 'ibkr_paper',
  signalTimestamp: '2026-08-12T14:10:00.000Z',
  orderType: 'MKT',
  quantity: 1,
  paperAccountIdMasked: 'DU***596',
  localSymbol: 'MNQU6',
  orderRef: 'TOS-PAPER-fxp_4e146a2488320080-entry',
  orderRefs: [
    'TOS-PAPER-fxp_4e146a2488320080-entry',
    'TOS-PAPER-fxp_4e146a2488320080-takeProfit',
    'TOS-PAPER-fxp_4e146a2488320080-stopLoss',
  ],
  expectedOrderIds: [163, 164, 165],
  expectedBracketLegs: [
    { leg: 'entry', orderId: 163, orderRef: 'TOS-PAPER-fxp_4e146a2488320080-entry', transmit: false },
    { leg: 'takeProfit', orderId: 164, orderRef: 'TOS-PAPER-fxp_4e146a2488320080-takeProfit', transmit: false },
    { leg: 'stopLoss', orderId: 165, orderRef: 'TOS-PAPER-fxp_4e146a2488320080-stopLoss', transmit: true },
  ],
  parentOrderId: 163,
  side: 'SELL',
  ibOrderId: 163,
  submitStartedAt: '2026-08-12T14:11:44.533Z',
  entryExecId: '0000e1a7.6a85b257.01.01',
  entryFilledPrice: 29931.25,
  entryFilledOrderId: 163,
  entryFilledAt: '2026-08-12T14:11:46.202Z',
  entryCommission: 0.61,
  entryCommissionCurrency: 'USD',
  filledLeg: 'takeProfit',
  filledExecId: '0000e1a7.6a85d74e.01.01',
  filledPrice: 29840.5,
  filledOrderId: 164,
  filledAt: '2026-08-12T15:04:01.480Z',
  filledCommission: 0.61,
  filledCommissionCurrency: 'USD',
  filledRealizedPNL: 180.28,
};

const OPEN_INTENT = {
  executionId: 'fxp_a18a506e19876ad8',
  intentId: '4ed4ccfb64edc4115e0ed10199092167',
  status: 'submitted',
  createdAt: '2026-08-12T15:04:45.826Z',
  updatedAt: '2026-08-12T16:40:58.101Z',
  strategyId: 'trend_continuation',
  lifecycleId: 'signal_lifecycle_db8baecc1cfa0ff92f97e473',
  tradeId: 'futures_trade_a18a506e19876ad8',
  candidateId: 'futures_candidate_b85f4f8a3e9034ee',
  signalId: 'TSLA_2026-08-12T15:02:00.000Z',
  root: 'MNQ',
  conId: 793356225,
  direction: 'short',
  quantity: 1,
  localSymbol: 'MNQU6',
  side: 'SELL',
  ibOrderId: 166,
  expectedOrderIds: [166, 167, 168],
  entryFilledPrice: 29849.5,
  entryFilledOrderId: 166,
  entryFilledAt: '2026-08-12T15:04:46.216Z',
  entryCommission: 0.61,
};

const CANCELLED_INTENT = {
  executionId: 'fxp_cancelled01',
  status: 'expired',
  createdAt: '2026-08-11T10:00:00.000Z',
  updatedAt: '2026-08-11T10:05:00.000Z',
  strategyId: 'mnq_globex_momentum_v1',
  root: 'MNQ',
  direction: 'long',
  quantity: 1,
  blocker: 'signal_too_old',
};

const OPEN_ORDERS = [
  {
    orderId: 167,
    permId: 1123581321,
    orderRef: 'TOS-PAPER-fxp_a18a506e19876ad8-takeProfit',
    executionId: 'fxp_a18a506e19876ad8',
    strategyId: 'trend_continuation',
    symbol: 'MNQ',
    localSymbol: 'MNQU6',
    conId: 793356225,
    action: 'BUY',
    quantity: 1,
    orderType: 'LMT',
    limitPrice: 29800,
    stopPrice: null,
    status: 'PreSubmitted',
    updatedAt: '2026-08-12T15:04:47.000Z',
    source: 'ibkr_paper',
    accountMasked: 'DU***596',
  },
  {
    orderId: 168,
    permId: 1123581322,
    orderRef: 'TOS-PAPER-fxp_a18a506e19876ad8-stopLoss',
    executionId: 'fxp_a18a506e19876ad8',
    strategyId: 'trend_continuation',
    symbol: 'MNQ',
    localSymbol: 'MNQU6',
    conId: 793356225,
    action: 'BUY',
    quantity: 1,
    orderType: 'STP',
    limitPrice: null,
    stopPrice: 29920,
    status: 'PreSubmitted',
    updatedAt: '2026-08-12T15:04:47.000Z',
    source: 'ibkr_paper',
    accountMasked: 'DU***596',
  },
];

const FILLS = [
  {
    execId: '0000e1a7.6a85b257.01.01',
    orderId: 163,
    permId: 1123581300,
    orderRef: 'TOS-PAPER-fxp_4e146a2488320080-entry',
    executionId: 'fxp_4e146a2488320080',
    orderLeg: 'entry',
    strategyId: 'trend_continuation',
    localSymbol: 'MNQU6',
    conId: 793356225,
    side: 'SLD',
    quantity: 1,
    fillPrice: 29931.25,
    commission: 0.61,
    commissionCurrency: 'USD',
    time: '20260812 09:11:46 US/Central',
    receivedAt: '2026-08-12T14:11:46.300Z',
    source: 'ibkr_paper',
  },
  {
    execId: '0000e1a7.6a85d74e.01.01',
    orderId: 164,
    permId: 1123581301,
    orderRef: 'TOS-PAPER-fxp_4e146a2488320080-takeProfit',
    executionId: 'fxp_4e146a2488320080',
    orderLeg: 'take_profit',
    strategyId: 'trend_continuation',
    localSymbol: 'MNQU6',
    conId: 793356225,
    side: 'BOT',
    quantity: 1,
    fillPrice: 29840.5,
    commission: 0.61,
    realizedResult: 180.28,
    time: '20260812 10:04:01 US/Central',
    receivedAt: '2026-08-12T15:04:01.600Z',
    source: 'ibkr_paper',
  },
];

const ORDER_STATUSES = [
  { orderId: 167, permId: 1123581321, parentId: 166, status: 'presubmitted', ibStatus: 'PreSubmitted', filled: 0, remaining: 1, updatedAt: '2026-08-12T15:04:47.000Z' },
  { orderId: 168, permId: 1123581322, parentId: 166, status: 'presubmitted', ibStatus: 'PreSubmitted', filled: 0, remaining: 1, updatedAt: '2026-08-12T15:04:47.000Z' },
  { orderId: 163, status: 'filled', ibStatus: 'Filled', filled: 1, remaining: 0, avgFillPrice: 29931.25, updatedAt: '2026-08-12T14:11:46.500Z' },
];

const POSITIONS = [{ conId: 793356225, root: 'MNQ', quantity: -1, unrealizedPnl: 42.5 }];

function journal(extra = {}) {
  return buildTradeJournal({
    intents: [CLOSED_INTENT, OPEN_INTENT, CANCELLED_INTENT],
    brokerOrders: OPEN_ORDERS,
    brokerFills: FILLS,
    brokerOrderStatuses: ORDER_STATUSES,
    brokerPositions: POSITIONS,
    resolveStrategy: ({ strategyId }) => ({
      strategyId,
      strategyName: strategyId === 'trend_continuation' ? 'Trend Continuation' : strategyId,
      strategyFamily: 'trend_family',
    }),
    ...extra,
  });
}

test('parseOrderRef plockar ut executionId och ben', () => {
  assert.deepEqual(parseOrderRef('TOS-PAPER-fxp_abc123-stopLoss'), { executionId: 'fxp_abc123', leg: 'stopLoss' });
  assert.deepEqual(parseOrderRef('TOS-PAPER-fxp_abc123-someNewLeg'), { executionId: 'fxp_abc123', leg: 'someNewLeg' });
  assert.deepEqual(parseOrderRef('okänd-ref'), { executionId: null, leg: null });
});

test('en trade per executionId — inte en rad per orderben', () => {
  const { trades, totalTrades } = journal();
  assert.equal(totalTrades, 3);
  assert.equal(trades.length, 3);
  assert.equal(new Set(trades.map((row) => row.executionId)).size, 3);
});

test('öppna trades ligger överst, därefter senast stängda', () => {
  const { trades } = journal();
  assert.equal(trades[0].executionId, 'fxp_a18a506e19876ad8');
  assert.equal(trades[0].status, 'open');
  assert.equal(trades[1].executionId, 'fxp_4e146a2488320080');
  assert.equal(trades[2].status, 'cancelled');
});

test('stängd trade får entry, exit, PnL, commission och exit reason', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  assert.equal(trade.status, 'win');
  assert.equal(trade.direction, 'SHORT');
  assert.equal(trade.entryPrice, 29931.25);
  assert.equal(trade.exitPrice, 29840.5);
  assert.equal(trade.netPnl, 180.28);
  assert.equal(Number(trade.commission.toFixed(2)), 1.22);
  // IBKR:s realizedPNL är netto efter courtage; brutto = netto + avgifter.
  assert.equal(Number(trade.grossPnl.toFixed(2)), 181.5);
  assert.equal(trade.exitReason, 'TAKE PROFIT');
  assert.equal(trade.executionState, 'Filled');
  assert.equal(trade.takeProfitPrice, 29840.5);
  assert.equal(trade.durationMs, Date.parse('2026-08-12T15:04:01.480Z') - Date.parse('2026-08-12T14:11:46.202Z'));
});

test('PnL % räknas med riktning', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  assert.ok(trade.pnlPercent > 0, 'short som föll i pris ska ge positiv procent');
  assert.equal(Math.round(trade.pnlPercent * 1000) / 1000, 0.303);
  assert.equal(pnlPercentOf({ entryPrice: 100, exitPrice: 110, direction: 'LONG' }), 10);
  assert.equal(pnlPercentOf({ entryPrice: 100, exitPrice: 110, direction: 'SHORT' }), -10);
  assert.equal(pnlPercentOf({ entryPrice: null, exitPrice: 110, direction: 'LONG' }), null);
});

test('öppen trade hämtar stop och take profit från levande skyddsordrar', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_a18a506e19876ad8');
  assert.equal(trade.status, 'open');
  assert.equal(trade.entryPrice, 29849.5);
  assert.equal(trade.exitPrice, null);
  assert.equal(trade.stopPrice, 29920);
  assert.equal(trade.takeProfitPrice, 29800);
  assert.equal(trade.netPnl, null);
  assert.equal(trade.unrealizedPnl, 42.5);
  assert.equal(trade.exitReason, null);
});

test('avbruten trade utan fill klassas som cancelled och behåller blocker', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_cancelled01');
  assert.equal(trade.status, 'cancelled');
  assert.equal(trade.executionState, 'Cancelled');
  assert.equal(trade.evidence.blocker, 'signal_too_old');
  assert.equal(trade.netPnl, null);
});

test('identitetskedjan följer med hela vägen', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  assert.deepEqual(trade.identity, {
    signalId: 'GOOGL_2026-08-12T14:08:00.000Z',
    candidateId: 'futures_candidate_da6538d7581760f5',
    lifecycleId: 'signal_lifecycle_9c2c69083ee65c0d722f125f',
    intentId: '98c0fcd44446b16e80e0d8f2898f4815',
    executionId: 'fxp_4e146a2488320080',
    tradeId: 'futures_trade_4e146a2488320080',
    idempotencyKey: '98c0fcd44446b16e80e0d8f2898f4815',
  });
});

test('broker-id:n, perm-id:n, orderRefs och execIds samlas per trade', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  assert.deepEqual(trade.brokerOrderIds.map(Number).sort((a, b) => a - b), [163, 164, 165]);
  assert.deepEqual(trade.permIds.map(Number).sort((a, b) => a - b), [1123581300, 1123581301]);
  assert.equal(trade.execIds.length, 2);
  assert.equal(trade.orderRefs.length, 3);
  assert.equal(trade.fills.length, 2);
});

test('legs kopplar ihop orderplan, brokerorder, orderstatus och fills', () => {
  const open = journal().trades.find((row) => row.executionId === 'fxp_a18a506e19876ad8');
  const stop = open.legs.find((leg) => leg.leg === 'stopLoss');
  assert.equal(stop.orderId, 168);
  assert.equal(stop.stopPrice, 29920);
  assert.equal(stop.remaining, 1);
  assert.equal(stop.ibStatus, 'PreSubmitted');

  const closed = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  const entry = closed.legs.find((leg) => leg.leg === 'entry');
  assert.equal(entry.orderId, 163);
  assert.equal(entry.avgFillPrice, 29931.25);
  assert.equal(entry.fills.length, 1);
  assert.equal(closed.legs.length, 3, 'entry + takeProfit + stopLoss');
});

test('broker-rader utan intent tappas inte bort', () => {
  const { trades } = buildTradeJournal({
    intents: [],
    brokerFills: [{ execId: 'x1', orderId: 900, orderRef: 'TOS-PAPER-fxp_orphan-entry', fillPrice: 100, side: 'BOT' }],
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].executionId, 'fxp_orphan');
});

test('senaste intent-posten per executionId vinner', () => {
  const { trades } = buildTradeJournal({
    intents: [
      { executionId: 'fxp_dup', status: 'submitted', updatedAt: '2026-08-01T10:00:00.000Z', entryFilledPrice: 100 },
      { executionId: 'fxp_dup', status: 'filled', updatedAt: '2026-08-01T11:00:00.000Z', entryFilledPrice: 100, filledPrice: 110, filledAt: '2026-08-01T11:00:00.000Z', filledRealizedPNL: 9 },
    ],
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'win');
});

test('stängd trade utan broker-verifierad PnL visas inte som breakeven', () => {
  const { trades } = buildTradeJournal({
    intents: [{
      executionId: 'fxp_legacy_no_pnl',
      status: 'filled',
      updatedAt: '2026-07-21T22:46:05.653Z',
      filledLeg: 'stopLoss',
      filledPrice: 29255.25,
      filledAt: '2026-07-21T22:46:05.653Z',
    }],
  });
  assert.equal(trades[0].status, 'closed_unverified');
  assert.equal(trades[0].statusLabel, 'Closed (PnL saknas)');
  assert.equal(trades[0].netPnl, null);
  assert.equal(trades[0].exitReason, 'STOP');

  const summary = summarizeTrades(trades);
  assert.equal(summary.closedTrades, 0, 'ingen verifierad PnL → räknas inte som stängd i statistiken');
  assert.equal(summary.unverifiedTrades, 1);
  assert.equal(summary.winRate, null);
  assert.equal(buildStrategyStatistics(trades)[0].unverifiedTrades, 1);
});

test('breakeven kräver verifierad PnL som är exakt noll', () => {
  const { trades } = buildTradeJournal({
    intents: [{
      executionId: 'fxp_flat',
      status: 'filled',
      updatedAt: '2026-07-21T22:46:05.653Z',
      entryFilledPrice: 100,
      filledPrice: 100,
      filledAt: '2026-07-21T22:46:05.653Z',
      filledRealizedPNL: 0,
    }],
  });
  assert.equal(trades[0].status, 'breakeven');
  assert.equal(summarizeTrades(trades).closedTrades, 1);
});

test('exitReasonOf mappar orderben till läsbar orsak', () => {
  assert.equal(exitReasonOf({ filledLeg: 'stopLoss', hasExit: true }), 'STOP');
  assert.equal(exitReasonOf({ filledLeg: 'takeProfit', hasExit: true }), 'TAKE PROFIT');
  assert.equal(exitReasonOf({ filledLeg: 'flatten', hasExit: true }), 'MANUAL');
  assert.equal(exitReasonOf({ filledLeg: null, status: 'rejected' }), 'ERROR');
  assert.equal(exitReasonOf({ filledLeg: null, hasExit: true }), 'UNKNOWN');
  assert.equal(exitReasonOf({ filledLeg: null, hasExit: false }), null);
});

test('summering räknar wins, losses, win rate, brutto, courtage och netto', () => {
  const { trades } = journal();
  const summary = summarizeTrades(trades);
  assert.equal(summary.trades, 3);
  assert.equal(summary.closedTrades, 1);
  assert.equal(summary.openTrades, 1);
  assert.equal(summary.cancelledTrades, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 0);
  assert.equal(summary.winRate, 100);
  assert.equal(summary.netPnl, 180.28);
  assert.equal(Number(summary.commission.toFixed(2)), 1.22);
  assert.equal(Number(summary.grossPnl.toFixed(2)), 181.5);
  assert.equal(summary.averageWinner, 180.28);
  assert.equal(summary.averageLoser, null);
  assert.equal(summary.profitFactor, null, 'utan förluster finns ingen profit factor');
});

test('filter på status, strategi, marknad, riktning, datum, PnL och open only', () => {
  const { trades } = journal();
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, status: 'win' }).length, 1);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, openOnly: true }).length, 1);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, direction: 'SHORT' }).length, 2);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, symbol: 'MNQ' }).length, 3);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, strategyId: 'trend_continuation' }).length, 2);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, pnl: 'positive' }).length, 1);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, pnl: 'negative' }).length, 0);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, from: '2026-08-12' }).length, 2);
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, to: '2026-08-11' }).length, 1);
});

test('sök träffar hela identitetskedjan och broker-id:n', () => {
  const trade = journal().trades.find((row) => row.executionId === 'fxp_4e146a2488320080');
  for (const query of [
    'fxp_4e146a2488320080',
    'futures_trade_4e146a2488320080',
    '98c0fcd44446b16e80e0d8f2898f4815',
    'futures_candidate_da6538d7581760f5',
    'GOOGL_2026-08-12T14:08:00.000Z',
    'trend_continuation',
    '164',
    '0000e1a7.6a85d74e.01.01',
    'TOS-PAPER-fxp_4e146a2488320080-stopLoss',
  ]) {
    assert.equal(tradeMatchesSearch(trade, query), true, `sökning skulle träffa: ${query}`);
  }
  assert.equal(tradeMatchesSearch(trade, 'finns_inte'), false);
});

test('filteralternativ listar strategier och marknader som finns', () => {
  const options = tradeFilterOptions(journal().trades);
  assert.deepEqual(options.symbols, ['MNQ']);
  assert.equal(options.strategies.length, 2);
});

test('limit kapar listan men rapporterar totalen', () => {
  const intents = Array.from({ length: 12 }, (_, index) => ({
    executionId: `fxp_${index}`,
    status: 'filled',
    updatedAt: `2026-08-0${(index % 9) + 1}T10:00:00.000Z`,
    entryFilledPrice: 100,
    filledPrice: 101,
    filledAt: `2026-08-0${(index % 9) + 1}T11:00:00.000Z`,
    filledRealizedPNL: 1,
  }));
  const result = buildTradeJournal({ intents, limit: 5 });
  assert.equal(result.trades.length, 5);
  assert.equal(result.totalTrades, 12);
  assert.equal(result.truncated, true);
  // Standardtaket ska rymma 3000 trades — journalen paginerar i stället för att kapa.
  assert.equal(DEFAULT_TRADE_LIMIT, 3000);
});

test('3000 trades kapas inte av standardtaket', () => {
  const intents = Array.from({ length: 3000 }, (_, index) => ({
    executionId: `fxp_${index}`,
    status: 'filled',
    updatedAt: '2026-08-05T10:00:00.000Z',
    entryFilledPrice: 100,
    filledPrice: 101,
    filledAt: '2026-08-05T11:00:00.000Z',
    filledRealizedPNL: 1,
  }));
  const result = buildTradeJournal({ intents });
  assert.equal(result.trades.length, 3000);
  assert.equal(result.truncated, false);
});

test('strategistatistik räknas ur samma journalrader', () => {
  const stats = buildStrategyStatistics(journal().trades);
  const trend = stats.find((row) => row.strategyId === 'trend_continuation');
  assert.equal(trend.strategyName, 'Trend Continuation');
  assert.equal(trend.trades, 2);
  assert.equal(trend.openTrades, 1);
  assert.equal(trend.closedTrades, 1);
  assert.equal(trend.wins, 1);
  assert.equal(trend.winRate, 100);
  assert.equal(trend.netPnl, 180.28);
  assert.equal(trend.expectancy, 180.28);
  assert.equal(trend.largestWin, 180.28);
  assert.equal(trend.largestLoss, null);
  assert.equal(trend.sharpe, null, 'en enda trade ger ingen sharpe');
  assert.equal(trend.drawdown, 0);
});

test('strategistatistik: sharpe, profit factor och drawdown på flera trades', () => {
  const mk = (id, pnl, at) => ({
    executionId: id,
    status: 'filled',
    strategyId: 'multi',
    updatedAt: at,
    entryFilledPrice: 100,
    filledPrice: 101,
    filledAt: at,
    filledLeg: 'takeProfit',
    filledRealizedPNL: pnl,
    entryCommission: 0.5,
    filledCommission: 0.5,
  });
  const { trades } = buildTradeJournal({
    intents: [
      mk('fxp_s1', 100, '2026-08-01T10:00:00.000Z'),
      mk('fxp_s2', -50, '2026-08-02T10:00:00.000Z'),
      mk('fxp_s3', 50, '2026-08-03T10:00:00.000Z'),
    ],
  });
  const [stats] = buildStrategyStatistics(trades);
  assert.equal(stats.closedTrades, 3);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.netPnl, 100);
  assert.equal(stats.grossPnl, 103);
  assert.equal(stats.commission, 3);
  assert.equal(stats.profitFactor, 3);
  assert.equal(stats.averageWin, 75);
  assert.equal(stats.averageLoss, -50);
  assert.equal(stats.drawdown, -50);
  assert.ok(stats.sharpe > 0 && stats.sharpe < 1);
});

test('broker order-rader är rena orderrader utan PnL', () => {
  const rows = buildBrokerOrderRows({ brokerOrders: OPEN_ORDERS, brokerOrderStatuses: ORDER_STATUSES });
  assert.equal(rows.length, 2);
  const stop = rows.find((row) => row.orderId === 168);
  assert.equal(stop.orderRef, 'TOS-PAPER-fxp_a18a506e19876ad8-stopLoss');
  assert.equal(stop.executionId, 'fxp_a18a506e19876ad8');
  assert.equal(stop.leg, 'stopLoss');
  assert.equal(stop.price, 29920);
  assert.equal(stop.filled, 0);
  assert.equal(stop.remaining, 1);
  assert.equal(stop.broker, 'IBKR Paper');
  assert.equal('pnl' in stop, false);
  assert.equal('winRate' in stop, false);
});

test('fill-rader bär execution-identitet och pekar på sin trade', () => {
  const rows = buildFillRows({ brokerFills: FILLS });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].execId, '0000e1a7.6a85d74e.01.01', 'senaste fill först');
  assert.equal(rows[0].executionId, 'fxp_4e146a2488320080');
  assert.equal(rows[0].commission, 0.61);
  assert.equal(rows[0].brokerTime, '20260812 10:04:01 US/Central');
  assert.equal(rows[0].time, '2026-08-12T15:04:01.600Z');
  assert.equal('realizedResult' in rows[0], false, 'ingen PnL på fills-sidan');
});

test('uppmärksamhet flaggar rejected, oskyddad öppen position och saknad PnL', () => {
  assert.equal(tradeNeedsAttention({ status: 'rejected' }), true);
  assert.equal(tradeNeedsAttention({ status: 'closed_unverified' }), true);
  assert.equal(tradeNeedsAttention({ status: 'open', stopPrice: null }), true);
  // Skyddad öppen position kräver ingen åtgärd.
  assert.equal(tradeNeedsAttention({ status: 'open', stopPrice: 29500 }), false);
  // Avbruten order är rutin och ska inte bli brus i standardvyn.
  assert.equal(tradeNeedsAttention({ status: 'cancelled' }), false);
  assert.equal(tradeNeedsAttention({ status: 'win', netPnl: 12 }), false);
});

test('summarizeAttention räknar varje orsak för sig', () => {
  const trades = [
    { status: 'rejected' },
    { status: 'open', stopPrice: null },
    { status: 'open', stopPrice: 29500 },
    { status: 'closed_unverified' },
    { status: 'cancelled' },
    { status: 'win', netPnl: 10 },
  ];
  const attention = summarizeAttention(trades);
  assert.equal(attention.rejected, 1);
  assert.equal(attention.openWithoutStop, 1);
  assert.equal(attention.unverified, 1);
  assert.equal(attention.total, 3);
});

test('summarizeTrades exponerar strategier och uppmärksamhet', () => {
  const trades = [
    { status: 'win', netPnl: 10, strategyId: 'a', strategyName: 'VWAP Reclaim' },
    { status: 'loss', netPnl: -4, strategyId: 'b', strategyName: 'Narrow State' },
    { status: 'open', stopPrice: null, strategyId: 'a', strategyName: 'VWAP Reclaim' },
  ];
  const summary = summarizeTrades(trades);
  assert.equal(summary.activeStrategies, 2);
  assert.deepEqual(summary.strategyNames, ['Narrow State', 'VWAP Reclaim']);
  assert.equal(summary.attention.total, 1);
});

test('statusfiltret attention är ett tvärsnitt över flera statusar', () => {
  const trades = [
    { status: 'rejected', symbol: 'MNQ' },
    { status: 'open', stopPrice: null, symbol: 'MNQ' },
    { status: 'open', stopPrice: 29500, symbol: 'MNQ' },
    { status: 'win', netPnl: 5, symbol: 'MNQ' },
  ];
  const filtered = filterTrades(trades, { ...EMPTY_TRADE_FILTERS, status: 'attention' });
  assert.equal(filtered.length, 2);
  // Vanliga statusfilter påverkas inte.
  assert.equal(filterTrades(trades, { ...EMPTY_TRADE_FILTERS, status: 'win' }).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
