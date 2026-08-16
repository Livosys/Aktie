import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SCANNER_FILTERS,
  SCANNER_STATUS,
  buildScannerRows,
  filterScannerRows,
  scanIntervalMs,
  summarizeScanner,
} from './ScannerDomain.js';

function overviewRow(patch = {}) {
  return {
    strategyId: 'strat_a',
    displayName: 'Strategy A',
    family: 'momentum',
    instruments: ['MNQ'],
    status: 'READY_WAITING_FOR_SIGNAL',
    marketOpen: true,
    sessionAllowed: true,
    canTradeNow: true,
    ...patch,
  };
}

test('en strategi som bevakar två marknader blir två rader', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ instruments: ['MNQ', 'MES'] })],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.symbol).sort(), ['MES', 'MNQ']);
});

test('strategi utan futures-mappning hamnar inte på radarn', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ instruments: [], instrument: null })],
  });
  assert.equal(rows.length, 0);
});

test('instrument som sammanslagen sträng delas upp', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ instruments: [], instrument: 'MNQ / MES' })],
  });
  assert.deepEqual(rows.map((row) => row.symbol), ['MNQ', 'MES']);
});

test('statusprioritet: position slår kandidat slår setup slår scanning', () => {
  const base = { strategyOverview: [overviewRow({ entryReady: true })] };

  const scanning = buildScannerRows({ strategyOverview: [overviewRow()] });
  assert.equal(scanning[0].status, SCANNER_STATUS.SCANNING);

  const setup = buildScannerRows(base);
  assert.equal(setup[0].status, SCANNER_STATUS.SETUP_READY);

  const candidate = buildScannerRows({
    ...base,
    candidates: [{ strategyId: 'strat_a', symbol: 'MNQ', candidateId: 'cand-1', status: 'queued' }],
  });
  assert.equal(candidate[0].status, SCANNER_STATUS.CANDIDATE);

  const submitted = buildScannerRows({
    ...base,
    candidates: [{ strategyId: 'strat_a', symbol: 'MNQ', candidateId: 'cand-1', status: 'submitted' }],
  });
  assert.equal(submitted[0].status, SCANNER_STATUS.SUBMITTED);

  const inPosition = buildScannerRows({
    ...base,
    candidates: [{ strategyId: 'strat_a', symbol: 'MNQ', candidateId: 'cand-1', status: 'submitted' }],
    brokerPositions: [{ strategyId: 'strat_a', root: 'MNQ', direction: 'LONG', quantity: 1 }],
  });
  assert.equal(inPosition[0].status, SCANNER_STATUS.IN_POSITION);
  assert.equal(inPosition[0].position.direction, 'LONG');
});

test('cooldown och trade cap läses som cooldown, inte som blockering', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ canTradeNow: false, mainBlocker: 'strategy_cooldown_active' })],
  });
  assert.equal(rows[0].status, SCANNER_STATUS.COOLDOWN);
  assert.equal(rows[0].activeOnRadar, true);

  const cap = buildScannerRows({
    strategyOverview: [overviewRow({ canTradeNow: false, mainBlocker: 'daily_trade_cap_reached' })],
  });
  assert.equal(cap[0].status, SCANNER_STATUS.COOLDOWN);
});

test('stängd session ger blocked och räknas inte som aktiv', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ canTradeNow: false, marketOpen: false, mainBlocker: 'session_closed' })],
  });
  assert.equal(rows[0].status, SCANNER_STATUS.BLOCKED);
  assert.equal(rows[0].activeOnRadar, false);
});

test('rader sorteras närmast entry överst', () => {
  const rows = buildScannerRows({
    strategyOverview: [
      overviewRow({ strategyId: 'a', displayName: 'A', instruments: ['MNQ'] }),
      overviewRow({ strategyId: 'b', displayName: 'B', instruments: ['MES'], entryReady: true }),
    ],
    brokerPositions: [{ strategyId: 'a', root: 'MNQ', direction: 'SHORT' }],
  });
  assert.deepEqual(rows.map((row) => row.status), [SCANNER_STATUS.IN_POSITION, SCANNER_STATUS.SETUP_READY]);
});

test('kandidat utan symbol matchar strategins alla marknader', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({ instruments: ['MNQ', 'MES'] })],
    candidates: [{ strategyId: 'strat_a', candidateId: 'cand-9', status: 'queued' }],
  });
  assert.deepEqual(rows.map((row) => row.candidateId), ['cand-9', 'cand-9']);
});

test('villkor delas i uppfyllda och saknade utan att hitta på nya', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow({
      requiredContext: ['vwap', 'volume', 'trend'],
      missingComponents: ['volume'],
      canonicalReadiness: { evidenceGaps: ['atr'] },
    })],
  });
  assert.deepEqual(rows[0].conditions.met, ['vwap', 'trend']);
  assert.deepEqual(rows[0].conditions.missing, ['volume', 'atr']);
});

test('indikatorer läses bara ur befintliga skalära fält', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow()],
    candidates: [{
      strategyId: 'strat_a',
      symbol: 'MNQ',
      candidateId: 'c1',
      indicators: { rsi: 61.2, vwap: 20155.25, nested: { skip: true } },
    }],
  });
  assert.deepEqual(rows[0].indicators, [
    { label: 'rsi', value: 61.2 },
    { label: 'vwap', value: 20155.25 },
  ]);
});

test('scanIntervalMs mäter medianen ur scanhistoriken', () => {
  const history = [
    { startedAt: '2026-08-13T10:03:00.000Z' },
    { startedAt: '2026-08-13T10:02:00.000Z' },
    { startedAt: '2026-08-13T10:01:00.000Z' },
  ];
  assert.equal(scanIntervalMs(history), 60_000);
  assert.equal(scanIntervalMs([]), 60_000);
});

test('nästa scan projiceras ur senaste scan plus mätt kadens', () => {
  const rows = buildScannerRows({
    strategyOverview: [overviewRow()],
    scanner: { lastScanAt: '2026-08-13T10:03:00.000Z' },
    scanHistory: [
      { startedAt: '2026-08-13T10:03:00.000Z' },
      { startedAt: '2026-08-13T10:02:00.000Z' },
    ],
  });
  assert.equal(rows[0].nextScanAt, new Date('2026-08-13T10:04:00.000Z').getTime());
});

test('summeringen räknar bara aktiva rader som scannade marknader', () => {
  const rows = buildScannerRows({
    strategyOverview: [
      overviewRow({ strategyId: 'a', instruments: ['MNQ'] }),
      overviewRow({ strategyId: 'b', instruments: ['MES'], canTradeNow: false, marketOpen: false }),
    ],
  });
  const summary = summarizeScanner(rows, { scanner: { lastScanAt: '2026-08-13T10:03:00.000Z' } });
  assert.equal(summary.scanningSymbols, 1);
  assert.equal(summary.activeStrategies, 1);
  assert.equal(summary.totalRows, 2);
  assert.equal(summary.activeRows, 1);
});

test('filtret döljer blockerade rader som standard', () => {
  const rows = buildScannerRows({
    strategyOverview: [
      overviewRow({ strategyId: 'a', instruments: ['MNQ'] }),
      overviewRow({ strategyId: 'b', instruments: ['MES'], canTradeNow: false, marketOpen: false }),
    ],
  });
  assert.equal(filterScannerRows(rows, EMPTY_SCANNER_FILTERS).length, 1);
  assert.equal(filterScannerRows(rows, { ...EMPTY_SCANNER_FILTERS, activeOnly: false }).length, 2);
  assert.equal(filterScannerRows(rows, { ...EMPTY_SCANNER_FILTERS, symbol: 'MNQ' }).length, 1);
  assert.equal(filterScannerRows(rows, { ...EMPTY_SCANNER_FILTERS, search: 'strategy a' }).length, 1);
});
