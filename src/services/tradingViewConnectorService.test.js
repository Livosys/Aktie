'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createTradingViewConnectorService } = require('./tradingViewConnectorService');
const { createStrategyRegistryService } = require('./strategyRegistryService');

function makeCatalog() {
  return {
    getCatalog() {
      return {
        strategies: [
          {
            id: 'INTERNAL_ACTIVE',
            name: 'Internal Active',
            status: 'active',
            enabled: true,
            description: 'Active internal strategy',
            performanceSummary: { win_rate: 0.61, avg_pnl: 1.1, trades: 18, score: 72 },
            marketRegimeTags: ['trend'],
            allowedTimeframes: ['5m'],
            entryRules: ['price_above_vwap'],
            exitRules: ['stop_loss'],
          },
          {
            id: 'INTERNAL_PAUSED',
            name: 'Internal Paused',
            status: 'paused',
            enabled: false,
            description: 'Paused internal strategy',
            performanceSummary: { win_rate: 0.35, avg_pnl: -0.4, trades: 9, score: 24 },
            marketRegimeTags: ['chop'],
            allowedTimeframes: ['15m'],
            entryRules: ['range_breakout'],
            exitRules: ['timeout'],
          },
        ],
      };
    },
  };
}

function makeHarness(secret) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradingview-connector-'));
  const logFile = path.join(tmpDir, 'tradingview-signals.jsonl');
  const registryFile = path.join(tmpDir, 'strategy-registry.jsonl');
  const forwardedCandidates = [];
  const forwardedEvents = [];
  const fixedNow = () => new Date('2026-06-03T12:00:00.000Z');
  const registry = createStrategyRegistryService({
    registryFile,
    daytradingCatalog: makeCatalog(),
  });
  const connector = createTradingViewConnectorService({
    logFile,
    now: fixedNow,
    webhookSecret: secret,
    registryService: registry,
    candidateLogger: {
      logCandidate(entry) {
        forwardedCandidates.push(entry);
        return true;
      },
    },
    eventLogger: {
      appendEvent(event) {
        forwardedEvents.push(event);
        return { ok: true, event };
      },
    },
  });

  function readLog() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return { connector, registry, readLog, forwardedCandidates, forwardedEvents };
}

function assertSafety(result, label) {
  assert.equal(result.actions_allowed, false, `${label}: actions_allowed`);
  assert.equal(result.can_place_orders, false, `${label}: can_place_orders`);
  assert.equal(result.live_trading_enabled, false, `${label}: live_trading_enabled`);
  assert.equal(result.broker_enabled, false, `${label}: broker_enabled`);
  assert.equal(result.mode, 'paper_only', `${label}: mode`);
}

{
  const { connector, registry, readLog, forwardedCandidates, forwardedEvents } = makeHarness('top-secret');

  const accepted = connector.handleWebhook({
    source: 'tradingview',
    secret: 'top-secret',
    strategy: 'TV_RSI_VWAP_LONG',
    symbol: 'AAPL',
    timeframe: '5',
    signal: 'long',
    price: 187.42,
    timestamp: '2026-06-03T12:00:00.000Z',
    rsi: 61,
    vwap_state: 'above',
    trend_state: 'bullish',
    market_regime: 'risk_on',
    metadata: { note: 'valid long', secret: 'should-not-leak' },
    live: true,
    can_place_orders: true,
    actions_allowed: true,
    broker_enabled: true,
  });

  assert.equal(accepted.ok, true, 'accepted long: ok');
  assert.equal(accepted.accepted, true, 'accepted long: accepted');
  assert.equal(accepted.paper_forwarded, true, 'accepted long: paper_forwarded');
  assert.equal(accepted.blocked_reason, null, 'accepted long: blocked_reason');
  assertSafety(accepted, 'accepted long');
  assert.equal(forwardedCandidates.length, 1, 'accepted long: candidate forwarded');
  assert.equal(forwardedEvents.length, 1, 'accepted long: event logged');

  const tvRegistered = registry.getStrategy('TV_RSI_VWAP_LONG');
  assert.equal(tvRegistered.source, 'tradingview', 'accepted long: registered source');
  assert.equal(tvRegistered.status, 'paper_only', 'accepted long: registered status');
  assert.equal(tvRegistered.enabled, true, 'accepted long: registered enabled');

  const records = readLog();
  assert.equal(records.length, 1, 'accepted long: one log record');
  assert.equal(records[0].accepted, true, 'accepted long: record accepted');
  assert.equal(records[0].paper_forwarded, true, 'accepted long: record paper_forwarded');
  assert.equal(records[0].live_trading_enabled, false, 'accepted long: live forced false');
  assert.equal(records[0].can_place_orders, false, 'accepted long: can_place_orders forced false');
  assert.equal(records[0].actions_allowed, false, 'accepted long: actions_allowed forced false');
  assert.equal(records[0].raw_payload.secret, undefined, 'accepted long: secret scrubbed from raw payload');
  assert.equal(records[0].metadata.secret, undefined, 'accepted long: secret scrubbed from metadata');
  assert.equal(forwardedEvents[0].metadata.secret, undefined, 'accepted long: secret not forwarded to event log');

  const internalActive = connector.handleWebhook({
    source: 'tradingview',
    secret: 'top-secret',
    strategy: 'INTERNAL_ACTIVE',
    symbol: 'MSFT',
    timeframe: '5',
    signal: 'long',
    price: 410.5,
    timestamp: '2026-06-03T12:00:30.000Z',
  });

  assert.equal(internalActive.ok, true, 'internal active: ok');
  assert.equal(internalActive.accepted, true, 'internal active: accepted');
  assert.equal(internalActive.paper_forwarded, true, 'internal active: forwarded');
  assert.equal(internalActive.blocked_reason, null, 'internal active: no blocked reason');
  assert.equal(registry.getStrategy('INTERNAL_ACTIVE').source, 'internal', 'internal active: source stays internal');

  const status = connector.getStatus();
  assert.equal(status.enabled, true, 'status: enabled');
  assert.equal(status.webhook_auth_configured, true, 'status: auth configured');
  assert.equal(status.mode, 'paper_only', 'status: mode');
  assert.equal(status.total_signals_today, 2, 'status: total_signals_today');
  assert.equal(status.accepted_signals, 2, 'status: accepted_signals');
  assert.equal(status.rejected_signals, 0, 'status: rejected_signals');
  assert.equal(status.last_signal_at, '2026-06-03T12:00:30.000Z', 'status: last_signal_at');
  assertSafety(status, 'status');

  const wrongSecret = connector.handleWebhook({
    source: 'tradingview',
    secret: 'wrong-secret',
    strategy: 'TV_RSI_VWAP_LONG',
    symbol: 'AAPL',
    timeframe: '5',
    signal: 'long',
    price: 187.42,
    timestamp: '2026-06-03T12:01:00.000Z',
  });

  assert.equal(wrongSecret.ok, false, 'wrong secret: ok');
  assert.equal(wrongSecret.accepted, false, 'wrong secret: accepted');
  assert.equal(wrongSecret.statusCode, 401, 'wrong secret: statusCode');
  assert.ok(wrongSecret.errors.includes('unauthorized'), `wrong secret: errors ${JSON.stringify(wrongSecret.errors)}`);
  assertSafety(wrongSecret, 'wrong secret');
  assert.equal(forwardedCandidates.length, 2, 'wrong secret: no candidate forward');
  assert.equal(forwardedEvents.length, 2, 'wrong secret: no event forward');
  const afterWrong = readLog();
  assert.equal(afterWrong.length, 3, 'wrong secret: rejected log entry added');
  assert.equal(afterWrong[2].accepted, false, 'wrong secret: log rejected');
  assert.equal(afterWrong[2].rejected_reason, 'auth_failed', 'wrong secret: auth_failed');
  assert.equal(afterWrong[2].raw_payload.secret, undefined, 'wrong secret: secret scrubbed');

  const liveOverride = connector.handleWebhook({
    source: 'tradingview',
    secret: 'top-secret',
    strategy: 'TV_RSI_VWAP_SHORT',
    symbol: 'MSFT',
    timeframe: '15',
    signal: 'short',
    price: 410.5,
    timestamp: '2026-06-03T12:02:00.000Z',
    live: true,
    can_place_orders: true,
    broker_enabled: true,
  });

  assert.equal(liveOverride.live_trading_enabled, false, 'live override: live false');
  assert.equal(liveOverride.can_place_orders, false, 'live override: can_place_orders false');
  assert.equal(liveOverride.actions_allowed, false, 'live override: actions_allowed false');
  assert.equal(liveOverride.broker_enabled, false, 'live override: broker_enabled false');
  assert.equal(liveOverride.paper_forwarded, true, 'live override: paper_forwarded');
  assert.equal(liveOverride.blocked_reason, null, 'live override: no blocked reason');
  const afterLive = readLog();
  assert.equal(afterLive.length, 4, 'live override: four log records');
  assert.equal(afterLive[3].live_trading_enabled, false, 'live override: record live false');
  assert.equal(afterLive[3].can_place_orders, false, 'live override: record can_place_orders false');
  assert.equal(afterLive[3].broker_enabled, false, 'live override: record broker_enabled false');

  registry.pauseStrategy('TV_RSI_VWAP_LONG', 'poor performance');
  const paused = connector.handleWebhook({
    source: 'tradingview',
    secret: 'top-secret',
    strategy: 'TV_RSI_VWAP_LONG',
    symbol: 'AAPL',
    timeframe: '5',
    signal: 'long',
    price: 187.42,
    timestamp: '2026-06-03T12:03:00.000Z',
  });

  assert.equal(paused.ok, true, 'paused strategy: ok');
  assert.equal(paused.accepted, true, 'paused strategy: accepted');
  assert.equal(paused.paper_forwarded, false, 'paused strategy: not forwarded');
  assert.equal(paused.blocked_reason, 'strategy_disabled', 'paused strategy: blocked reason');
  assert.equal(forwardedCandidates.length, 3, 'paused strategy: no candidate forward');
  assert.equal(forwardedEvents.length, 4, 'paused strategy: event still logged');
  const afterPaused = readLog();
  assert.equal(afterPaused.length, 5, 'paused strategy: log entry added');
  assert.equal(afterPaused[4].paper_forwarded, false, 'paused strategy: log says not forwarded');
  assert.equal(afterPaused[4].blocked_reason, 'strategy_disabled', 'paused strategy: log blocked reason');

  registry.ensureStrategy('TV_DEPRECATED', {
    source: 'tradingview',
    status: 'deprecated',
    enabled: false,
    disabled_reason: 'deprecated',
    strategy_name: 'TV Deprecated',
  });

  const deprecated = connector.handleWebhook({
    source: 'tradingview',
    secret: 'top-secret',
    strategy: 'TV_DEPRECATED',
    symbol: 'AAPL',
    timeframe: '5',
    signal: 'short',
    price: 187.42,
    timestamp: '2026-06-03T12:04:00.000Z',
  });

  assert.equal(deprecated.ok, true, 'deprecated strategy: ok');
  assert.equal(deprecated.accepted, true, 'deprecated strategy: accepted');
  assert.equal(deprecated.paper_forwarded, false, 'deprecated strategy: not forwarded');
  assert.equal(deprecated.blocked_reason, 'strategy_disabled', 'deprecated strategy: blocked reason');
  assert.equal(forwardedCandidates.length, 3, 'deprecated strategy: no candidate forward');
  assert.equal(forwardedEvents.length, 5, 'deprecated strategy: event still logged');
  const afterDeprecated = readLog();
  assert.equal(afterDeprecated.length, 6, 'deprecated strategy: log entry added');
  assert.equal(afterDeprecated[5].paper_forwarded, false, 'deprecated strategy: log says not forwarded');
  assert.equal(afterDeprecated[5].blocked_reason, 'strategy_disabled', 'deprecated strategy: log blocked reason');
}

{
  const { connector, readLog, forwardedCandidates, forwardedEvents } = makeHarness('');
  const missingSecret = connector.handleWebhook({
    source: 'tradingview',
    secret: 'anything',
    strategy: 'TV_RSI_VWAP_LONG',
    symbol: 'AAPL',
    timeframe: '5',
    signal: 'long',
    price: 187.42,
    timestamp: '2026-06-03T12:03:00.000Z',
  });

  assert.equal(missingSecret.ok, false, 'missing secret: ok');
  assert.equal(missingSecret.accepted, false, 'missing secret: accepted');
  assert.equal(missingSecret.disabled, true, 'missing secret: disabled');
  assert.equal(missingSecret.statusCode, 503, 'missing secret: statusCode');
  assert.ok(missingSecret.errors.includes('webhook_auth_not_configured'), `missing secret: errors ${JSON.stringify(missingSecret.errors)}`);
  assertSafety(missingSecret, 'missing secret');
  assert.equal(forwardedCandidates.length, 0, 'missing secret: no candidate forward');
  assert.equal(forwardedEvents.length, 0, 'missing secret: no event forward');
  const records = readLog();
  assert.equal(records.length, 1, 'missing secret: rejected log entry added');
  assert.equal(records[0].accepted, false, 'missing secret: log rejected');
  assert.equal(records[0].rejected_reason, 'auth_not_configured', 'missing secret: auth_not_configured');
  assert.equal(records[0].raw_payload.secret, undefined, 'missing secret: secret scrubbed');

  const status = connector.getStatus();
  assert.equal(status.webhook_auth_configured, false, 'missing secret status: auth configured false');
  assert.equal(status.enabled, false, 'missing secret status: enabled false');
  assertSafety(status, 'missing secret status');
}

console.log('TradingView connector tests passed.');
