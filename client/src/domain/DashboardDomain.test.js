import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivity,
  buildEquitySeries,
  buildMarketStatus,
  buildPnlBars,
  dayStartMs,
  summarizeToday,
} from './DashboardDomain.js';

const NOW = Date.parse('2026-08-13T15:00:00.000Z');
const TODAY = dayStartMs(NOW);
const HOUR = 3600 * 1000;

function closedTrade(patch = {}) {
  return {
    key: 'exec_1',
    symbol: 'MNQ',
    status: 'win',
    entryMs: TODAY + 9 * HOUR,
    exitMs: TODAY + 10 * HOUR,
    netPnl: 100,
    grossPnl: 101.24,
    commission: 1.24,
    ...patch,
  };
}

test('dagens siffror räknas bara på dagens trades', () => {
  const summary = summarizeToday({
    trades: [
      closedTrade({ key: 'a', netPnl: 100, grossPnl: 101.24, commission: 1.24 }),
      closedTrade({ key: 'b', status: 'loss', netPnl: -40, grossPnl: -38.76, commission: 1.24, exitMs: TODAY + 11 * HOUR }),
      // Igår — ska inte påverka någon KPI.
      closedTrade({ key: 'c', netPnl: 5000, grossPnl: 5001, commission: 1, entryMs: TODAY - 20 * HOUR, exitMs: TODAY - 19 * HOUR }),
    ],
    positionRows: [],
    now: NOW,
  });

  assert.equal(summary.tradesToday, 2);
  assert.equal(summary.closedToday, 2);
  assert.equal(summary.netPnl, 60);
  assert.equal(summary.grossPnl, 62.48);
  assert.equal(summary.commission, 2.48);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.winRate, 50);
});

test('net = gross − commission (samma aritmetik som Trades visar)', () => {
  const summary = summarizeToday({ trades: [closedTrade()], now: NOW });
  assert.equal(Number((summary.grossPnl - summary.commission).toFixed(2)), summary.netPnl);
});

test('realiserat och orealiserat blandas aldrig ihop i ett tal', () => {
  const summary = summarizeToday({
    trades: [closedTrade({ netPnl: 100 })],
    positionRows: [{ pnl: -25, status: 'in_loss' }, { pnl: 40, status: 'in_profit' }],
    now: NOW,
  });

  assert.equal(summary.netPnl, 100); // realiserat
  assert.equal(summary.unrealizedPnl, 15); // öppna positioner
  assert.equal(summary.netToday, 115); // summan redovisas separat
  assert.equal(summary.openPositions, 2);
});

test('en position som bärs över midnatt räknas fortfarande till idag', () => {
  const summary = summarizeToday({
    trades: [{ key: 'x', status: 'open', entryMs: TODAY - 3 * HOUR, exitMs: TODAY + 1 * HOUR, netPnl: 20 }],
    now: NOW,
  });
  assert.equal(summary.tradesToday, 1);
  assert.equal(summary.openedToday, 0);
  assert.equal(summary.closedToday, 1);
});

test('utan stängda trades finns ingen win rate — inte 0 %', () => {
  const summary = summarizeToday({ trades: [{ key: 'x', status: 'open', entryMs: TODAY + HOUR }], now: NOW });
  assert.equal(summary.winRate, null);
  assert.equal(summary.netPnl, null);
  assert.equal(summary.grossPnl, null);
  assert.equal(summary.commission, null);
});

test('oskyddade positioner räknas separat', () => {
  const summary = summarizeToday({
    positionRows: [{ pnl: 10, status: 'unprotected' }, { pnl: 5, status: 'in_profit' }],
    now: NOW,
  });
  assert.equal(summary.unprotectedPositions, 1);
});

test('equity idag är kumulativ realiserad PnL och startar på noll', () => {
  const points = buildEquitySeries({
    trades: [
      closedTrade({ key: 'b', netPnl: -40, exitMs: TODAY + 11 * HOUR }),
      closedTrade({ key: 'a', netPnl: 100, exitMs: TODAY + 10 * HOUR }),
      closedTrade({ key: 'c', netPnl: 25, exitMs: TODAY + 12 * HOUR }),
    ],
    now: NOW,
  });

  assert.deepEqual(points.map((point) => point.value), [0, 100, 60, 85]);
  assert.equal(points[0].at, TODAY);
});

test('ingen equity-kurva när inget stängts idag', () => {
  assert.deepEqual(buildEquitySeries({ trades: [{ key: 'x', status: 'open', entryMs: TODAY }], now: NOW }), []);
});

test('PnL-staplar: en per stängd trade, i stängningsordning', () => {
  const bars = buildPnlBars({
    trades: [
      closedTrade({ key: 'b', symbol: 'MES', netPnl: -40, exitMs: TODAY + 11 * HOUR }),
      closedTrade({ key: 'a', symbol: 'MNQ', netPnl: 100, exitMs: TODAY + 10 * HOUR }),
    ],
    now: NOW,
  });

  assert.deepEqual(bars.map((bar) => bar.key), ['a', 'b']);
  assert.deepEqual(bars.map((bar) => bar.tone), ['good', 'danger']);
  assert.equal(bars[1].value, -40);
});

test('PnL-staplarna kapas till de senaste', () => {
  const trades = Array.from({ length: 20 }, (_, index) => closedTrade({
    key: `t${index}`,
    netPnl: index,
    exitMs: TODAY + 8 * HOUR + index * 60000,
  }));
  const bars = buildPnlBars({ trades, now: NOW, limit: 5 });
  assert.equal(bars.length, 5);
  assert.deepEqual(bars.map((bar) => bar.value), [15, 16, 17, 18, 19]);
});

test('statusindikatorerna säger okänt när snapshoten inte vet', () => {
  const status = buildMarketStatus({ now: NOW });
  const byKey = Object.fromEntries(status.indicators.map((row) => [row.key, row]));

  assert.equal(byKey.market.value, 'okänt');
  assert.equal(byKey.scanner.value, 'okänt');
  assert.equal(byKey.broker.value, 'okänt');
  assert.equal(byKey.market.tone, 'neutral');
  assert.equal(byKey.broker.tone, 'neutral');
});

test('statusindikatorerna speglar en levande kedja', () => {
  const status = buildMarketStatus({
    market: { isMarketOpen: true, sessionLabel: 'RTH' },
    scanner: { connected: true, lastScanAt: new Date(NOW - 45000).toISOString() },
    quotes: [{ root: 'MNQ' }, { root: 'MES' }],
    executionConnected: true,
    marketDataConnected: true,
    now: NOW,
  });
  const byKey = Object.fromEntries(status.indicators.map((row) => [row.key, row]));

  assert.equal(byKey.market.value, 'öppen');
  assert.equal(byKey.market.hint, 'RTH');
  assert.equal(byKey.scanner.tone, 'success');
  assert.equal(byKey.broker.tone, 'success');
  assert.equal(byKey.quotes.value, '2');
  assert.equal(byKey.last_scan.tone, 'success');
  assert.equal(status.scanAgeMs, 45000);
});

test('en radar som stått still i över fem minuter larmar', () => {
  const status = buildMarketStatus({
    scanner: { connected: true },
    scanHistory: [{ scanId: 's1', startedAt: new Date(NOW - 9 * 60000).toISOString() }],
    now: NOW,
  });
  const lastScan = status.indicators.find((row) => row.key === 'last_scan');
  assert.equal(lastScan.tone, 'warning');
  assert.equal(status.scanAgeMs, 9 * 60000);
});

test('stale quotes syns som varning, inte som OK', () => {
  const status = buildMarketStatus({
    quotes: [{ root: 'MNQ', stale: true }, { root: 'MES' }],
    marketDataConnected: true,
    now: NOW,
  });
  const quotes = status.indicators.find((row) => row.key === 'quotes');
  assert.equal(quotes.tone, 'warning');
  assert.equal(quotes.hint, '1 utan färsk feed');
});

test('aktivitet: senaste trades, scanner-event och positioner', () => {
  const activity = buildActivity({
    trades: [
      closedTrade({ key: 'a', exitMs: TODAY + 10 * HOUR, netPnl: 100 }),
      closedTrade({ key: 'b', exitMs: TODAY + 12 * HOUR, netPnl: -40, status: 'loss' }),
      { key: 'c', symbol: 'NQ', status: 'open', entryMs: TODAY + 13 * HOUR, unrealizedPnl: 12 },
    ],
    scanHistory: [
      { scanId: 's1', startedAt: new Date(TODAY + 9 * HOUR).toISOString(), candidatesCreated: 0 },
      { scanId: 's2', startedAt: new Date(TODAY + 14 * HOUR).toISOString(), candidatesCreated: 2 },
    ],
    positionRows: [
      { key: 'p1', symbol: 'MNQ', entryMs: TODAY + 11 * HOUR, pnl: 30, status: 'in_profit' },
      { key: 'p2', symbol: 'MES', entryMs: TODAY + 14.5 * HOUR, pnl: null, status: 'unprotected' },
    ],
    now: NOW,
  });

  assert.deepEqual(activity.trades.map((row) => row.id), ['c', 'b', 'a']);
  assert.equal(activity.trades[0].closed, false);
  assert.equal(activity.trades[1].tone, 'danger');

  assert.deepEqual(activity.scannerEvents.map((row) => row.id), ['s2', 's1']);
  assert.equal(activity.scannerEvents[0].tone, 'good');
  assert.equal(activity.scannerEvents[0].ageMs, HOUR);

  assert.deepEqual(activity.positions.map((row) => row.id), ['p2', 'p1']);
  assert.equal(activity.positions[0].tone, 'danger'); // utan stop
});

test('aktivitetslistorna kapas till limit', () => {
  const trades = Array.from({ length: 12 }, (_, index) => closedTrade({ key: `t${index}`, exitMs: TODAY + index * HOUR }));
  const activity = buildActivity({ trades, limit: 4, now: NOW });
  assert.equal(activity.trades.length, 4);
  assert.deepEqual(activity.trades.map((row) => row.id), ['t11', 't10', 't9', 't8']);
});
