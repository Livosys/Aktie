'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createTradingViewPreviewLogService,
  buildLogRow,
} = require('./tradingViewPreviewLogService');

const PAPER_ONLY_SAFETY = {
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};

function tmpHistoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-preview-log-'));
  return path.join(dir, 'nested', 'preview-history.jsonl');
}

function samplePreview(overrides = {}) {
  return {
    ok: true,
    accepted: false,
    dryRun: true,
    wouldCreatePaperTest: false,
    wouldCreateReplayTest: false,
    blockedReason: 'feature_flag_disabled',
    dedupKey: 'abc123def456',
    candidate: { symbol: 'AAPL', timeframe: '15m', strategyId: 'strat_demo' },
    safety: { ...PAPER_ONLY_SAFETY },
    ...overrides,
  };
}

function assertSafety(obj, label) {
  assert.deepEqual(obj, PAPER_ONLY_SAFETY, `${label} must be paper_only`);
}

// 1) Missing file => empty history, no throw, no file created.
(function testMissingFileEmpty() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  const rows = service.readRecentPreviews();
  assert.deepEqual(rows, [], 'missing file => empty array');
  const summary = service.getPreviewHistorySummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.previewCount, 0, 'previewCount 0 when no file');
  assert.equal(summary.latestPreview, null);
  assert.equal(summary.latestBlockedReason, null);
  assertSafety(summary.safety, 'summary.safety');
  assert.equal(fs.existsSync(historyFile), false, 'reading must not create the file');
})();

// 2) Append writes valid JSONL with the required debugging fields + safety.
(function testAppendWritesJsonl() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  const res = service.appendPreview(samplePreview());
  assert.equal(res.ok, true, 'append ok');
  assert.equal(res.logWritten, true, 'logWritten true');
  assertSafety({ mode: res.mode, actions_allowed: res.actions_allowed, can_place_orders: res.can_place_orders, live_trading_enabled: res.live_trading_enabled, broker_enabled: res.broker_enabled }, 'append result safety');

  const raw = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  assert.equal(raw.length, 1, 'one JSONL line written');
  const row = JSON.parse(raw[0]);
  for (const key of ['timestamp', 'symbol', 'timeframe', 'strategyId', 'accepted', 'blockedReason', 'dryRun', 'wouldCreatePaperTest', 'wouldCreateReplayTest', 'dedupKey', 'safety']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), `row has ${key}`);
  }
  assert.equal(row.symbol, 'AAPL');
  assert.equal(row.timeframe, '15m');
  assert.equal(row.strategyId, 'strat_demo');
  assert.equal(row.dedupKey, 'abc123def456');
  assert.equal(row.accepted, false);
  assert.equal(row.dryRun, true);
  assert.equal(row.wouldCreatePaperTest, false);
  assert.equal(row.wouldCreateReplayTest, false);
  assertSafety(row.safety, 'row.safety');
})();

// 3) Broken/partial lines are ignored; valid rows still parse.
(function testBrokenLineIgnored() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(historyFile, [
    JSON.stringify(buildLogRow(samplePreview({ candidate: { symbol: 'MSFT', timeframe: '1h', strategyId: 's1' } }))),
    '{ this is not valid json',
    '',
    '   ',
    '["array","not","object"]',
    JSON.stringify(buildLogRow(samplePreview({ candidate: { symbol: 'TSLA', timeframe: '5m', strategyId: 's2' }, blockedReason: 'not_in_allowlist' }))),
  ].join('\n') + '\n', 'utf8');

  const rows = service.readRecentPreviews();
  assert.equal(rows.length, 2, 'only valid object rows parsed');
  assert.equal(rows[0].symbol, 'MSFT');
  assert.equal(rows[1].symbol, 'TSLA');
})();

// 4) latestPreview / latestBlockedReason reflect the newest row.
(function testLatestPreview() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  service.appendPreview(samplePreview({ candidate: { symbol: 'A', timeframe: '1m', strategyId: 's1' }, blockedReason: 'auth_required' }));
  service.appendPreview(samplePreview({ candidate: { symbol: 'B', timeframe: '5m', strategyId: 's2' }, blockedReason: 'invalid_symbol' }));
  const summary = service.getPreviewHistorySummary();
  assert.equal(summary.previewCount, 2);
  assert.equal(summary.latestPreview.symbol, 'B', 'latest is the newest appended');
  assert.equal(summary.latestBlockedReason, 'invalid_symbol');
  assertSafety(summary.safety, 'summary.safety');
})();

// 5) The service never produces order/trade/queue fields — only debug + safety.
(function testNoQueueOrTradeFields() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  service.appendPreview(samplePreview());
  const rows = service.readRecentPreviews();
  const row = rows[0];
  const allowedKeys = new Set(['timestamp', 'symbol', 'timeframe', 'strategyId', 'accepted', 'blockedReason', 'dryRun', 'wouldCreatePaperTest', 'wouldCreateReplayTest', 'dedupKey', 'safety']);
  for (const key of Object.keys(row)) {
    assert.ok(allowedKeys.has(key), `unexpected key in log row: ${key}`);
  }
  for (const forbidden of ['order', 'orders', 'trade', 'queue', 'paperQueue', 'replayQueue', 'broker']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, forbidden), false, `log row must not contain ${forbidden}`);
  }
  // accepted is always false-or-explicit and the dry-run flags stay false.
  assert.equal(row.wouldCreatePaperTest, false);
  assert.equal(row.wouldCreateReplayTest, false);
})();

// 6) Safety is always normalised to paper_only even if input safety is tampered.
(function testSafetyForcedPaperOnly() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile });
  service.appendPreview(samplePreview({
    safety: { mode: 'live', actions_allowed: true, can_place_orders: true, live_trading_enabled: true, broker_enabled: true },
  }));
  const row = service.readRecentPreviews()[0];
  assertSafety(row.safety, 'tampered safety must be forced paper_only');
})();

// 7) maxEntries caps how many rows are returned.
(function testMaxEntriesCap() {
  const historyFile = tmpHistoryFile();
  const service = createTradingViewPreviewLogService({ historyFile, maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) {
    service.appendPreview(samplePreview({ candidate: { symbol: `S${i}`, timeframe: '1m', strategyId: `s${i}` } }));
  }
  const rows = service.readRecentPreviews();
  assert.equal(rows.length, 3, 'capped to maxEntries');
  assert.equal(rows[2].symbol, 'S9', 'keeps the newest rows');
})();

console.log('tradingViewPreviewLogService tests passed.');
