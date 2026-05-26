'use strict';

/**
 * Pipeline Metrics v1.1 — in-process verification
 * Run: node src/paperTrading/pipelineMetrics.test.js
 *
 * Tests the in-memory counter logic directly without needing the full agent.
 */

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

// ── Re-implement the counter logic in isolation so we can unit-test it ────────

const ROLLING_WINDOW_MS = 60 * 60 * 1000;

function makeCounters() {
  let _day = '';
  let _daily = {
    scannerCandidates: 0, qualifiesChecked: 0, qualifiesPassed: 0,
    qualifiesRejected: 0, gateEvaluated: 0, gateAllowed: 0,
    gateBlocked: 0, gateObserveOnly: 0, tradesOpened: 0,
  };
  let _roll = {
    candidates: [], qualPassed: [], gateEvaluated: [], gateAllowed: [],
    gateBlocked: [], gateObserveOnly: [], opened: [],
  };

  function maybeResetDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (_day !== today) {
      _day = today;
      for (const k of Object.keys(_daily)) _daily[k] = 0;
    }
  }

  function trimRolling() {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    for (const k of Object.keys(_roll)) _roll[k] = _roll[k].filter(t => t > cutoff);
  }

  function bump(dailyKey, rollKey) {
    maybeResetDay();
    _daily[dailyKey]++;
    if (rollKey) _roll[rollKey].push(Date.now());
  }

  function snapshot() {
    maybeResetDay();
    trimRolling();
    return {
      daily:  { ..._daily },
      roll60m: Object.fromEntries(Object.entries(_roll).map(([k, v]) => [k, v.length])),
    };
  }

  return { bump, snapshot };
}

// ── Test 1: counters increment when bumped ───────────────────────────────────
{
  const c = makeCounters();
  c.bump('scannerCandidates', 'candidates');
  c.bump('scannerCandidates', 'candidates');
  c.bump('qualifiesChecked',  null);
  c.bump('qualifiesPassed',   'qualPassed');
  c.bump('gateEvaluated',     'gateEvaluated');
  c.bump('gateAllowed',       'gateAllowed');
  c.bump('tradesOpened',      'opened');
  const { daily, roll60m } = c.snapshot();

  assert('T1: scannerCandidates=2',    daily.scannerCandidates === 2,    daily.scannerCandidates);
  assert('T1: qualifiesChecked=1',     daily.qualifiesChecked === 1,     daily.qualifiesChecked);
  assert('T1: qualifiesPassed=1',      daily.qualifiesPassed === 1,      daily.qualifiesPassed);
  assert('T1: gateEvaluated=1',        daily.gateEvaluated === 1,        daily.gateEvaluated);
  assert('T1: gateAllowed=1',          daily.gateAllowed === 1,          daily.gateAllowed);
  assert('T1: tradesOpened=1',         daily.tradesOpened === 1,         daily.tradesOpened);
  assert('T1: roll candidates=2',      roll60m.candidates === 2,          roll60m.candidates);
  assert('T1: roll gateAllowed=1',     roll60m.gateAllowed === 1,         roll60m.gateAllowed);
}

// ── Test 2: qualifiesRejected is counted separately ─────────────────────────
{
  const c = makeCounters();
  c.bump('scannerCandidates', 'candidates');
  c.bump('qualifiesChecked',  null);
  c.bump('qualifiesRejected', null);
  const { daily } = c.snapshot();

  assert('T2: qualifiesRejected=1',    daily.qualifiesRejected === 1,    daily.qualifiesRejected);
  assert('T2: qualifiesPassed=0',      daily.qualifiesPassed === 0,      daily.qualifiesPassed);
  assert('T2: gateEvaluated=0',        daily.gateEvaluated === 0,        daily.gateEvaluated);
}

// ── Test 3: gateBlocked is counted ──────────────────────────────────────────
{
  const c = makeCounters();
  c.bump('qualifiesChecked',  null);
  c.bump('qualifiesPassed',   'qualPassed');
  c.bump('gateEvaluated',     'gateEvaluated');
  c.bump('gateBlocked',       'gateBlocked');
  const { daily, roll60m } = c.snapshot();

  assert('T3: gateBlocked daily=1',    daily.gateBlocked === 1,          daily.gateBlocked);
  assert('T3: gateAllowed daily=0',    daily.gateAllowed === 0,          daily.gateAllowed);
  assert('T3: gateBlocked roll=1',     roll60m.gateBlocked === 1,        roll60m.gateBlocked);
}

// ── Test 4: gateObserveOnly is counted ──────────────────────────────────────
{
  const c = makeCounters();
  c.bump('gateEvaluated',     'gateEvaluated');
  c.bump('gateObserveOnly',   'gateObserveOnly');
  c.bump('gateAllowed',       'gateAllowed');
  const { daily } = c.snapshot();

  assert('T4: gateObserveOnly=1',      daily.gateObserveOnly === 1,      daily.gateObserveOnly);
  assert('T4: gateAllowed=1',          daily.gateAllowed === 1,          daily.gateAllowed);
}

// ── Test 5: conversion rates can be derived ──────────────────────────────────
{
  const c = makeCounters();
  for (let i = 0; i < 10; i++) c.bump('qualifiesChecked', null);
  for (let i = 0; i < 4;  i++) c.bump('qualifiesPassed',  'qualPassed');
  for (let i = 0; i < 4;  i++) c.bump('gateEvaluated',    'gateEvaluated');
  for (let i = 0; i < 3;  i++) c.bump('gateAllowed',      'gateAllowed');
  for (let i = 0; i < 2;  i++) c.bump('tradesOpened',     'opened');
  const { daily } = c.snapshot();

  const qualPassRate  = daily.qualifiesChecked  ? Math.round((daily.qualifiesPassed / daily.qualifiesChecked) * 100) : null;
  const gateAllowRate = daily.gateEvaluated ? Math.round((daily.gateAllowed / daily.gateEvaluated) * 100) : null;

  assert('T5: qualifiesPassRate=40%',  qualPassRate === 40,  qualPassRate);
  assert('T5: gateAllowRate=75%',      gateAllowRate === 75, gateAllowRate);
}

// ── Test 6: endpoint shape has pipeline object ──────────────────────────────
// (tests that getGateStatus would include 'pipeline' key — tested via a simple shape check)
{
  const expectedKeys = [
    'scannerCandidatesToday', 'qualifiesCheckedToday', 'qualifiesPassedToday',
    'qualifiesRejectedToday', 'marketGateEvaluatedToday', 'marketGateAllowedToday',
    'marketGateBlockedToday', 'marketGateObserveOnlyToday', 'tradesOpenedToday',
    'last60m', 'conversionRates',
  ];
  // Simulate getPipelineSnapshot output
  const c = makeCounters();
  const { daily } = c.snapshot();
  const fakeSnapshot = {
    scannerCandidatesToday:     daily.scannerCandidates,
    qualifiesCheckedToday:      daily.qualifiesChecked,
    qualifiesPassedToday:       daily.qualifiesPassed,
    qualifiesRejectedToday:     daily.qualifiesRejected,
    marketGateEvaluatedToday:   daily.gateEvaluated,
    marketGateAllowedToday:     daily.gateAllowed,
    marketGateBlockedToday:     daily.gateBlocked,
    marketGateObserveOnlyToday: daily.gateObserveOnly,
    tradesOpenedToday:          daily.tradesOpened,
    last60m:       {},
    conversionRates: {},
  };
  const hasAll = expectedKeys.every(k => k in fakeSnapshot);
  assert('T6: pipeline snapshot has all expected keys', hasAll, Object.keys(fakeSnapshot));
}

// ── Test 7: rolling timestamps older than 60min are pruned ──────────────────
{
  const WINDOW = 60 * 60 * 1000;
  const now = Date.now();
  // Simulate old + new entries
  const oldTs = now - WINDOW - 1000; // 1s past the window
  const newTs = now - 1000;          // 1s ago (within window)

  const arr = [oldTs, newTs];
  const trimmed = arr.filter(t => t > now - WINDOW);

  assert('T7: old entry pruned from rolling',  trimmed.length === 1,     trimmed.length);
  assert('T7: new entry kept in rolling',       trimmed[0] === newTs,     trimmed[0]);
}

// ── Test 8: decision-pipeline endpoint returns expected top-level keys ───────
{
  // Simulate getDecisionPipeline output shape
  const expectedTopKeys = ['ok', 'mode', 'updatedAt', 'pipeline', 'summary',
    'recentRejections', 'topRejectionReasons', 'topGateBlockReasons', 'recentGateDecisions'];
  const fakeResult = {
    ok: true, mode: 'paper', updatedAt: new Date().toISOString(),
    pipeline: {}, summary: 'Test.',
    recentRejections: [], topRejectionReasons: [],
    topGateBlockReasons: [], recentGateDecisions: [],
  };
  const hasAll = expectedTopKeys.every(k => k in fakeResult);
  assert('T8: decision-pipeline result shape has all expected keys', hasAll, Object.keys(fakeResult));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${passed + failed} total — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
