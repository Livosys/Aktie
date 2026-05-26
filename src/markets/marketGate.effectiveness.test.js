'use strict';

/**
 * Market Gate Effectiveness v1.2 — unit tests
 * Run: node src/markets/marketGate.effectiveness.test.js
 */

const assertNode = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  gateScoreBucket,
  emptyReport,
  buildGateEffectivenessReport,
} = require('./marketGateEffectiveness');

let passed = 0;
let failed = 0;

function assert(name, condition, got) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}  →  got: ${JSON.stringify(got)}`);
    failed++;
  }
}

function trade(overrides = {}) {
  return {
    tradeId: `t_${Math.random()}`,
    result: 'WIN',
    pnlPct: 0.2,
    gateScore: 75,
    marketGroup: 'US_STOCKS',
    riskProfileName: 'us_stocks_default',
    signalSubtype: 'VWAP_RECLAIM_UP',
    compassBias: 'RISK_ON',
    compassConflict: false,
    maxFavorablePct: 0.35,
    maxAdversePct: -0.08,
    entryTime: '2026-05-25T10:00:00.000Z',
    exitTime: '2026-05-25T10:12:00.000Z',
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    allowed: true,
    mode: 'normal',
    gateScore: 78,
    threshold: 70,
    decisionCode: 'allowed',
    marketGroup: 'US_STOCKS',
    signalSubtype: 'VWAP_RECLAIM_UP',
    compassBias: 'RISK_ON',
    timestamp: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

// ── Test 1: Empty report works without crash ────────────────────────────────
{
  const report = buildGateEffectivenessReport();
  assert('T1: empty report ok=true', report.ok === true, report.ok);
  assert('T1: empty bucket array exists', Array.isArray(report.byGateScoreBucket), report.byGateScoreBucket);
  assert('T1: empty recommendations include data recommendation',
    report.recommendations.includes('Samla minst 20 öppnade trades innan du ändrar thresholds.'),
    report.recommendations);
}

// ── Test 2: Score bucket mapping ────────────────────────────────────────────
{
  assert('T2: 35 => 0-39', gateScoreBucket(35) === '0-39', gateScoreBucket(35));
  assert('T2: 50 => 40-54', gateScoreBucket(50) === '40-54', gateScoreBucket(50));
  assert('T2: 60 => 55-69', gateScoreBucket(60) === '55-69', gateScoreBucket(60));
  assert('T2: 75 => 70-84', gateScoreBucket(75) === '70-84', gateScoreBucket(75));
  assert('T2: 90 => 85-100', gateScoreBucket(90) === '85-100', gateScoreBucket(90));
  assert('T2: null => UNKNOWN', gateScoreBucket(null) === 'UNKNOWN', gateScoreBucket(null));
}

// ── Test 3: DecisionCode grouping ───────────────────────────────────────────
{
  const report = buildGateEffectivenessReport({
    gateDecisions: [
      decision({ allowed: false, mode: 'blocked', decisionCode: 'low_gate_score', gateScore: 50 }),
      decision({ allowed: false, mode: 'blocked', decisionCode: 'low_gate_score', gateScore: 52 }),
      decision({ allowed: false, mode: 'blocked', decisionCode: 'outside_nyse_session', reasonSv: 'Marknaden är stängd.' }),
    ],
  });
  const row = report.byDecisionCode.find(r => r.decisionCode === 'low_gate_score');
  assert('T3: low_gate_score grouped count=2', row?.count === 2, row);
  assert('T3: low_gate_score block modes=2', row?.modes?.block === 2, row?.modes);
}

// ── Test 4: MarketGroup grouping ────────────────────────────────────────────
{
  const report = buildGateEffectivenessReport({
    trades: [
      trade({ marketGroup: 'CRYPTO_MAJOR', result: 'WIN', pnlPct: 0.3 }),
      trade({ marketGroup: 'CRYPTO_MAJOR', result: 'LOSS', pnlPct: -0.2 }),
    ],
    gateDecisions: [
      decision({ marketGroup: 'CRYPTO_MAJOR' }),
      decision({ marketGroup: 'CRYPTO_MAJOR', allowed: false, mode: 'blocked', decisionCode: 'low_gate_score' }),
    ],
  });
  const row = report.byMarketGroup.find(r => r.marketGroup === 'CRYPTO_MAJOR');
  assert('T4: marketGroup gateEvaluated=2', row?.gateEvaluated === 2, row);
  assert('T4: marketGroup openedTrades=2', row?.openedTrades === 2, row);
  assert('T4: marketGroup winRate=50', row?.winRate === 50, row?.winRate);
}

// ── Test 5: CompassConflict grouping ────────────────────────────────────────
{
  const report = buildGateEffectivenessReport({
    trades: [
      trade({ compassConflict: true, result: 'LOSS', pnlPct: -0.3 }),
      trade({ compassConflict: false, result: 'WIN', pnlPct: 0.25 }),
    ],
  });
  const conflict = report.byCompassConflict.find(r => r.compassConflict === true);
  const aligned = report.byCompassConflict.find(r => r.compassConflict === false);
  assert('T5: compassConflict=true openedTrades=1', conflict?.openedTrades === 1, conflict);
  assert('T5: compassConflict=false avgPnl positive', aligned?.avgPnlPct === 0.25, aligned);
}

// ── Test 6: Recommendations ─────────────────────────────────────────────────
{
  const little = buildGateEffectivenessReport({ trades: [] });
  assert('T6a: för lite data recommendation',
    little.recommendations.includes('Samla minst 20 öppnade trades innan du ändrar thresholds.'),
    little.recommendations);

  const lowAllow = buildGateEffectivenessReport({
    gateDecisions: Array.from({ length: 30 }, (_, i) => decision({
      allowed: i === 0,
      mode: i === 0 ? 'normal' : 'blocked',
      decisionCode: i === 0 ? 'allowed' : 'low_gate_score',
    })),
  });
  assert('T6b: låg allowRate recommendation',
    lowAllow.recommendations.includes('Market Gate släpper igenom få signaler. Kontrollera om thresholds är för hårda.'),
    lowAllow.recommendations);

  const timeoutTrades = Array.from({ length: 10 }, (_, i) => trade({
    result: i < 8 ? 'TIMEOUT' : 'WIN',
    pnlPct: i < 8 ? 0.01 : 0.2,
  }));
  const timeoutReport = buildGateEffectivenessReport({ trades: timeoutTrades });
  assert('T6c: hög timeoutRate recommendation',
    timeoutReport.recommendations.includes('Timeout-rate är hög. Kontrollera target, maxHold och signaltyper.'),
    timeoutReport.recommendations);

  const negativeGroup = buildGateEffectivenessReport({
    trades: Array.from({ length: 5 }, () => trade({ marketGroup: 'LEVERAGED_ETFS', result: 'LOSS', pnlPct: -0.2 })),
  });
  assert('T6d: negativ marketGroup recommendation',
    negativeGroup.recommendations.includes('MarketGroup LEVERAGED_ETFS har negativ PnL. Sätt den till observe_only tills mer data finns.'),
    negativeGroup.recommendations);
}

// ── Test 7: Endpoint returns ok:true with report ────────────────────────────
{
  const router = require('../routes/api');
  const layer = router.stack.find(l => l.route?.path === '/paper-trading/gate-effectiveness');
  let payload = null;
  assert('T7: endpoint route exists', !!layer, router.stack.map(l => l.route?.path).filter(Boolean));
  if (layer) {
    layer.route.stack[0].handle({}, { json: body => { payload = body; } });
    assert('T7: endpoint payload ok=true', payload?.ok === true, payload);
    assert('T7: endpoint payload has report', payload?.report?.summary != null, payload);
  }

  const historyLayer = router.stack.find(l => l.route?.path === '/paper-trading/gate-decisions-history');
  let historyPayload = null;
  assert('T7: gate-decisions-history route exists', !!historyLayer, router.stack.map(l => l.route?.path).filter(Boolean));
  if (historyLayer) {
    historyLayer.route.stack[0].handle({ query: {} }, { json: body => { historyPayload = body; } });
    assert('T7: gate-decisions-history endpoint ok=true', historyPayload?.ok === true, historyPayload);
    assert('T7: gate-decisions-history returns decisions array', Array.isArray(historyPayload?.decisions), historyPayload);
  }
}

// ── Test 8: Persisted gate decision JSONL helpers ───────────────────────────
{
  const paperTrading = require('../paperTrading/paperTradingAgent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-decisions-'));
  const file = path.join(dir, 'gate-decisions.jsonl');

  const row = paperTrading.appendGateDecision(
    {
      allowed: false,
      mode: 'blocked',
      gateScore: 42,
      threshold: 70,
      reasons: ['Gate blockerad (poäng 42/70).'],
      warnings: ['test warning'],
      penalties: ['test penalty'],
      boosts: [],
      compassConflict: true,
      marketGroup: 'US_STOCKS',
      riskProfileName: 'us_stocks_default',
    },
    {
      symbol: 'NVDA',
      signalSubtype: 'VWAP_RECLAIM_UP',
      dataFreshness: 'LIVE',
    },
    { file, timestamp: '2026-05-25T10:00:00.000Z' },
  );
  const text = fs.readFileSync(file, 'utf8').trim();
  const parsed = JSON.parse(text);

  assert('T8a: appendGateDecision writes JSONL', parsed.symbol === 'NVDA', parsed);
  assert('T8b: persisted mode is block', row.mode === 'block' && parsed.mode === 'block', parsed);

  const missing = paperTrading.loadGateDecisionHistory({ file: path.join(dir, 'missing.jsonl') });
  assert('T8c: loadGateDecisionHistory tolerates missing file', Array.isArray(missing) && missing.length === 0, missing);

  fs.appendFileSync(file, '{broken json\n', 'utf8');
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-05-25T11:00:00.000Z', symbol: 'BTCUSDT', mode: 'allow', allowed: true }) + '\n', 'utf8');
  const loaded = paperTrading.loadGateDecisionHistory({ file });
  assert('T8d: loadGateDecisionHistory skips broken rows', loaded.length === 2, loaded);
  assert('T8e: loadGateDecisionHistory newest first', loaded[0].symbol === 'BTCUSDT', loaded);
}

// ── Test 9: Effectiveness report uses persisted decisions metadata ──────────
{
  const persisted = [
    decision({ timestamp: '2026-05-25T11:00:00.000Z', decisionCode: 'allowed' }),
    decision({ timestamp: '2026-05-25T10:00:00.000Z', allowed: false, mode: 'blocked', decisionCode: 'low_gate_score' }),
  ];
  const report = buildGateEffectivenessReport({
    gateDecisions: persisted,
    gateDecisionSource: 'disk',
    persistedGateDecisionCount: persisted.length,
    inMemoryGateDecisionCount: 0,
    latestPersistedGateDecisionAt: persisted[0].timestamp,
  });
  assert('T9a: report gateDecisionCount from persisted decisions', report.dataQuality.gateDecisionCount === 2, report.dataQuality);
  assert('T9b: report records disk source', report.dataQuality.gateDecisionSource === 'disk', report.dataQuality);
  assert('T9c: summary uses persisted decision count', report.summary.totalGateEvaluated === 2, report.summary);
}

// ── Test 10: UI empty-array contract remains build-safe ─────────────────────
{
  const report = emptyReport();
  assertNode(Array.isArray(report.byGateScoreBucket));
  assertNode(Array.isArray(report.byDecisionCode));
  assertNode(Array.isArray(report.byMarketGroup));
  assertNode(Array.isArray(report.byCompassConflict));
  assert('T10: empty report arrays exist for UI', true);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${passed + failed} total — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
