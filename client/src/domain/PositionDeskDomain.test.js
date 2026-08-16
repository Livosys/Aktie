import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITION_STATUS,
  buildPositionDeskRows,
  currentPriceOf,
  directionOf,
  livePositionMetrics,
  resolvePositionStatus,
  summarizePositionDesk,
} from './PositionDeskDomain.js';

// MNQ: tick 0,25 punkter, 2 USD per punkt.
const MNQ = { tickSize: 0.25, pointValue: 2 };

function longPosition(patch = {}) {
  return {
    root: 'MNQ',
    localSymbol: 'MNQZ5',
    conId: 711,
    side: 'BUY',
    quantity: 1,
    entryPrice: 20000,
    stopLoss: 19980,
    takeProfit: 20040,
    entryTime: '2026-08-13T10:00:00.000Z',
    strategyId: 'mnq_globex',
    ...patch,
  };
}

test('LONG: allt live räknas ur priset just nu', () => {
  const metrics = livePositionMetrics({
    direction: 'LONG',
    entryPrice: 20000,
    currentPrice: 20010,
    quantity: 2,
    stopPrice: 19980,
    takeProfitPrice: 20040,
    ...MNQ,
  });

  assert.equal(metrics.points, 10);
  assert.equal(metrics.ticks, 40);
  assert.equal(metrics.pnl, 40); // 10 punkter × 2 USD × 2 kontrakt
  assert.equal(metrics.pnlComputed, true);
  assert.equal(metrics.rMultiple, 0.5); // risk = 20 punkter
  assert.equal(metrics.distanceToStop, 30);
  assert.equal(metrics.distanceToTarget, 30);
  assert.equal(metrics.distanceToStopTicks, 120);
  assert.equal(metrics.stopFraction, 1.5);
  assert.equal(metrics.targetFraction, 0.75);
});

test('SHORT vänder tecknet på PnL och avstånd', () => {
  const metrics = livePositionMetrics({
    direction: 'SHORT',
    entryPrice: 20000,
    currentPrice: 19990,
    quantity: 1,
    stopPrice: 20020,
    takeProfitPrice: 19960,
    ...MNQ,
  });

  assert.equal(metrics.points, 10);
  assert.equal(metrics.pnl, 20);
  assert.equal(metrics.rMultiple, 0.5);
  assert.equal(metrics.distanceToStop, 30); // stop ligger ovanför priset
  assert.equal(metrics.distanceToTarget, 30); // target ligger under priset
});

test('utan pointValue faller PnL tillbaka på brokerns orealiserade värde', () => {
  const metrics = livePositionMetrics({
    direction: 'LONG',
    entryPrice: 20000,
    currentPrice: 20010,
    quantity: 1,
    tickSize: 0.25,
    pointValue: null,
    fallbackPnl: 17.5,
  });

  assert.equal(metrics.pnl, 17.5);
  assert.equal(metrics.pnlComputed, false);
  assert.equal(metrics.ticks, 40); // ticks kräver bara tickSize
});

test('utan pris finns inga live-fält — inget gissas fram', () => {
  const metrics = livePositionMetrics({
    direction: 'LONG',
    entryPrice: 20000,
    currentPrice: null,
    stopPrice: 19980,
    ...MNQ,
  });

  assert.equal(metrics.points, null);
  assert.equal(metrics.ticks, null);
  assert.equal(metrics.rMultiple, null);
  assert.equal(metrics.distanceToStop, null);
  assert.equal(metrics.riskPoints, 20); // entry→stop är känt utan pris
});

test('status: position utan stop är alltid oskyddad', () => {
  const status = resolvePositionStatus({
    metrics: livePositionMetrics({ direction: 'LONG', entryPrice: 20000, currentPrice: 20010, ...MNQ }),
    stopPrice: null,
    currentPrice: 20010,
  });
  assert.equal(status, POSITION_STATUS.UNPROTECTED);
});

test('status: sista fjärdedelen mot stop respektive target larmar', () => {
  const nearStop = livePositionMetrics({
    direction: 'LONG', entryPrice: 20000, currentPrice: 19984, stopPrice: 19980, takeProfitPrice: 20040, ...MNQ,
  });
  assert.equal(nearStop.stopFraction, 0.2);
  assert.equal(resolvePositionStatus({ metrics: nearStop, stopPrice: 19980, currentPrice: 19984 }), POSITION_STATUS.NEAR_STOP);

  const nearTarget = livePositionMetrics({
    direction: 'LONG', entryPrice: 20000, currentPrice: 20035, stopPrice: 19980, takeProfitPrice: 20040, ...MNQ,
  });
  assert.equal(nearTarget.targetFraction, 0.125);
  assert.equal(resolvePositionStatus({ metrics: nearTarget, stopPrice: 19980, currentPrice: 20035 }), POSITION_STATUS.NEAR_TARGET);
});

test('status: annars avgör PnL-tecknet', () => {
  const profit = livePositionMetrics({ direction: 'LONG', entryPrice: 20000, currentPrice: 20010, stopPrice: 19980, ...MNQ });
  assert.equal(resolvePositionStatus({ metrics: profit, stopPrice: 19980, currentPrice: 20010 }), POSITION_STATUS.IN_PROFIT);

  const loss = livePositionMetrics({ direction: 'LONG', entryPrice: 20000, currentPrice: 19995, stopPrice: 19900, ...MNQ });
  assert.equal(resolvePositionStatus({ metrics: loss, stopPrice: 19900, currentPrice: 19995 }), POSITION_STATUS.IN_LOSS);

  const flat = livePositionMetrics({ direction: 'LONG', entryPrice: 20000, currentPrice: 20000, stopPrice: 19900, ...MNQ });
  assert.equal(resolvePositionStatus({ metrics: flat, stopPrice: 19900, currentPrice: 20000 }), POSITION_STATUS.FLAT);
});

test('riktning läses ur side, direction eller tecknet på kvantiteten', () => {
  assert.equal(directionOf({ side: 'BOT' }), 'LONG');
  assert.equal(directionOf({ side: 'SLD' }), 'SHORT');
  assert.equal(directionOf({ direction: 'short' }), 'SHORT');
  assert.equal(directionOf({ signedQuantity: -2 }), 'SHORT');
  assert.equal(directionOf({}), null);
});

test('quoten går före brokerns frusna marketPrice', () => {
  assert.equal(currentPriceOf({ quote: { price: 20010 }, position: { marketPrice: 19990 } }), 20010);
  assert.equal(currentPriceOf({ quote: null, position: { marketPrice: 19990 } }), 19990);
  assert.equal(currentPriceOf({ quote: {}, position: {} }), null);
});

test('en rad per öppen position — quote och instrument matchas på root', () => {
  const rows = buildPositionDeskRows({
    brokerPositions: [longPosition()],
    quotes: [{ root: 'MNQ', price: 20010, source: 'ib_realtime' }],
    instruments: [{ root: 'MNQ', tickSize: 0.25, pointValueUsd: 2 }],
    now: Date.parse('2026-08-13T10:30:00.000Z'),
  });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.symbol, 'MNQ');
  assert.equal(row.direction, 'LONG');
  assert.equal(row.currentPrice, 20010);
  assert.equal(row.ticks, 40);
  assert.equal(row.pnl, 20);
  assert.equal(row.rMultiple, 0.5);
  assert.equal(row.durationMs, 30 * 60 * 1000);
  assert.equal(row.status, POSITION_STATUS.IN_PROFIT);
  assert.equal(row.quoteFreshness.live, true);
});

test('den öppna traden bär strategiidentitet och identitetskedja till raden', () => {
  const rows = buildPositionDeskRows({
    brokerPositions: [longPosition({ executionId: 'exec-1', strategyId: null })],
    trades: [{
      key: 'exec-1',
      executionId: 'exec-1',
      conId: 711,
      status: 'open',
      symbol: 'MNQ',
      strategyId: 'mnq_globex',
      strategyName: 'MNQ Globex',
      strategyFamily: 'momentum',
      identity: { signalId: 'sig-1', executionId: 'exec-1' },
    }],
    quotes: [{ root: 'MNQ', price: 20010 }],
    instruments: [{ root: 'MNQ', ...({ tickSize: 0.25, pointValueUsd: 2 }) }],
    resolveStrategy: ({ strategyId }) => ({ strategyName: 'MNQ Globex', strategyFamily: 'momentum', strategyId }),
    now: Date.parse('2026-08-13T10:30:00.000Z'),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].strategyName, 'MNQ Globex');
  assert.equal(rows[0].strategyFamily, 'momentum');
  assert.equal(rows[0].identity.signalId, 'sig-1');
  assert.equal(rows[0].trade.key, 'exec-1');
});

test('öppen trade utan spegelrad hos brokern försvinner inte', () => {
  const rows = buildPositionDeskRows({
    brokerPositions: [],
    trades: [
      {
        key: 'exec-2',
        executionId: 'exec-2',
        conId: 712,
        status: 'open',
        symbol: 'MES',
        direction: 'LONG',
        entryPrice: 5000,
        quantity: 1,
        stopPrice: 4990,
        entryTime: '2026-08-13T10:00:00.000Z',
      },
      { key: 'exec-3', status: 'win', symbol: 'MNQ' },
    ],
    quotes: [{ root: 'MES', price: 5005 }],
    now: Date.parse('2026-08-13T10:10:00.000Z'),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'open_trade');
  assert.equal(rows[0].symbol, 'MES');
  assert.equal(rows[0].currentPrice, 5005);
});

test('det som kräver beslut först ligger överst', () => {
  const rows = buildPositionDeskRows({
    brokerPositions: [
      longPosition({ root: 'MNQ', conId: 1, entryPrice: 20000 }),
      longPosition({ root: 'MES', conId: 2, entryPrice: 5000, stopLoss: null, takeProfit: null }),
      longPosition({ root: 'NQ', conId: 3, entryPrice: 20000, stopLoss: 19980, takeProfit: 20040 }),
    ],
    quotes: [
      { root: 'MNQ', price: 20010 },
      { root: 'MES', price: 5005 },
      { root: 'NQ', price: 19984 },
    ],
    instruments: [
      { root: 'MNQ', tickSize: 0.25, pointValueUsd: 2 },
      { root: 'MES', tickSize: 0.25, pointValueUsd: 5 },
      { root: 'NQ', tickSize: 0.25, pointValueUsd: 20 },
    ],
    now: Date.parse('2026-08-13T10:30:00.000Z'),
  });

  assert.deepEqual(rows.map((row) => row.status), [
    POSITION_STATUS.UNPROTECTED,
    POSITION_STATUS.NEAR_STOP,
    POSITION_STATUS.IN_PROFIT,
  ]);
});

test('KPI:erna summerar samma rader som tabellen visar', () => {
  const now = Date.parse('2026-08-13T14:00:00.000Z');
  const rows = buildPositionDeskRows({
    brokerPositions: [
      longPosition({ root: 'MNQ', conId: 1, entryTime: '2026-08-13T13:00:00.000Z' }),
      longPosition({ root: 'MES', conId: 2, entryPrice: 5000, stopLoss: 4990, takeProfit: 5030, entryTime: '2026-08-13T13:40:00.000Z' }),
    ],
    quotes: [
      { root: 'MNQ', price: 20010 }, // +20 USD
      { root: 'MES', price: 4998 }, // -10 USD
    ],
    instruments: [
      { root: 'MNQ', tickSize: 0.25, pointValueUsd: 2 },
      { root: 'MES', tickSize: 0.25, pointValueUsd: 5 },
    ],
    now,
  });

  const summary = summarizePositionDesk(rows, {
    trades: [
      { status: 'win', netPnl: 125, exitMs: Date.parse('2026-08-13T11:00:00.000Z') },
      { status: 'loss', netPnl: -25, exitMs: Date.parse('2026-08-13T12:00:00.000Z') },
      // Gårdagens trade räknas inte in i dagens resultat.
      { status: 'win', netPnl: 999, exitMs: Date.parse('2026-08-12T12:00:00.000Z') },
    ],
    now,
  });

  assert.equal(summary.openPositions, 2);
  assert.equal(summary.unrealizedPnl, 10);
  assert.equal(summary.realizedToday, 100);
  assert.equal(summary.netToday, 110);
  assert.equal(summary.closedToday, 2);
  assert.equal(summary.winningPositions, 1);
  assert.equal(summary.losingPositions, 1);
  assert.equal(summary.averageDurationMs, 40 * 60 * 1000); // 60 min och 20 min
});

test('tom desk ger nollor och inga påhittade siffror', () => {
  const summary = summarizePositionDesk([], { trades: [], now: Date.now() });
  assert.equal(summary.openPositions, 0);
  assert.equal(summary.unrealizedPnl, null);
  assert.equal(summary.realizedToday, null);
  assert.equal(summary.netToday, null);
  assert.equal(summary.averageDurationMs, null);
});
