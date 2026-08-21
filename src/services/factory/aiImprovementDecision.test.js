'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const improvement = require('./aiImprovementDecisionService');
const policy = require('../research/researchEvidencePolicyService');

const { DECISIONS, IMPROVEMENT_TRIGGER_SCORE } = improvement;

function record(overrides = {}) {
  return {
    strategyId: 'native_futures_momentum_v1',
    lifecycle: 'draft',
    currentDnaHash: 'parent0000000001',
    strategyScore: null,
    productionScore: null,
    confidenceScore: null,
    retired: false,
    ...overrides,
  };
}

function classification(outcome, reason, measured = {}) {
  return {
    outcome,
    reason,
    measured: { researchTrades: 120, validationTrades: 90, ...measured },
  };
}

// ── separationen: 65 får aldrig bli en lönsamhetsgrind ──────────────────────

test('en kandidat befordras även med poäng långt under förbättringströskeln', () => {
  const out = improvement.decideFor(
    record({ strategyScore: 12 }),
    classification(policy.OUTCOMES.CANDIDATE, 'all_policy_checks_passed'),
  );
  assert.equal(out.decision, DECISIONS.PROMOTE);
  assert.ok(out.score < IMPROVEMENT_TRIGGER_SCORE, 'testet ska bevisa att låg poäng INTE stoppar befordran');
});

test('förbättringsbeslutet ändrar aldrig klassificeringen', () => {
  const source = classification(policy.OUTCOMES.REJECTED, 'sufficient_sample_shows_no_edge');
  const frozen = JSON.parse(JSON.stringify(source));
  const out = improvement.decideFor(record({ strategyScore: 30 }), source);
  assert.deepEqual(source, frozen, 'indata får inte muteras');
  assert.equal(out.evidence.outcome, policy.OUTCOMES.REJECTED);
  assert.equal(out.evidence.reason, 'sufficient_sample_shows_no_edge');
});

test('65-procentsregeln finns inte i evidenspolicyn', () => {
  const described = JSON.stringify(policy.describePolicy());
  assert.ok(!described.includes('65'), 'policyn ska inte känna till förbättringströskeln');
  assert.equal(improvement.describe().improvementTriggerScore, 65);
});

test('negativt netto blir aldrig kandidat — och förbättringslagret ändrar inte det', () => {
  const classified = policy.classify({
    research: { trades: 200, profitFactor: 1.4, netPnlUsd: -900, maxDrawdownUsd: 500 },
    validation: { trades: 150, profitFactor: 1.3, netPnlUsd: -400, maxDrawdownUsd: 300 },
    researchDailyRows: Array.from({ length: 40 }, (_, i) => ({ date: `2026-01-${i + 1}`, strategyPnlUsd: 10 })),
    validationDailyRows: Array.from({ length: 30 }, (_, i) => ({ date: `2026-05-${i + 1}`, strategyPnlUsd: 10 })),
  });
  assert.notEqual(classified.outcome, policy.OUTCOMES.CANDIDATE);

  const out = improvement.decideFor(record({ strategyScore: 40 }), classified);
  assert.notEqual(out.decision, DECISIONS.PROMOTE, 'förbättringslagret får inte befordra det policyn nekade');
  assert.equal(out.evidence.outcome, classified.outcome);
});

// ── förbättringsbeslutet ────────────────────────────────────────────────────

test('bruttoedge som inte bär kostnaden pekar mot entry och exekvering', () => {
  const out = improvement.decideFor(
    record({ strategyScore: 55 }),
    classification(policy.OUTCOMES.INSUFFICIENT, 'gross_edge_holds_but_costs_are_not_carried'),
  );
  assert.equal(out.decision, DECISIONS.IMPROVE);
  assert.equal(out.improvementFocus, 'entry_and_execution');
  assert.ok(out.wants.includes('kostnad'));
  assert.equal(out.parentDnaHash, 'parent0000000001');
});

test('för litet urval väntar på data i stället för att bygga om', () => {
  const out = improvement.decideFor(
    record({ strategyScore: 20 }),
    classification(policy.OUTCOMES.INSUFFICIENT, 'sample_below_policy_minimum', { researchTrades: 4, validationTrades: 2 }),
  );
  assert.equal(out.decision, DECISIONS.WAITING_FOR_MORE_DATA);
});

test('omätbart teckentest är en bokföringsbrist, inte en dom', () => {
  const out = improvement.decideFor(
    record({ strategyScore: 20 }),
    classification(policy.OUTCOMES.INSUFFICIENT, 'sign_test_not_measurable'),
  );
  assert.equal(out.decision, DECISIONS.WAITING_FOR_MORE_DATA);
});

test('en förkastad hypotes med användbar evidens skickas till förbättring, inte till nedläggning', () => {
  const out = improvement.decideFor(
    record({ strategyScore: 31 }),
    classification(policy.OUTCOMES.REJECTED, 'sufficient_sample_shows_no_edge'),
  );
  assert.equal(out.decision, DECISIONS.IMPROVE);
  assert.notEqual(out.decision, DECISIONS.REJECT);
  assert.ok(out.learned.includes('research-affärer'));
});

test('förkastad utan en enda mätt affär ger otillräcklig evidens', () => {
  const out = improvement.decideFor(
    record(),
    classification(policy.OUTCOMES.REJECTED, 'sufficient_sample_shows_no_edge', { researchTrades: 0, validationTrades: 0 }),
  );
  assert.equal(out.decision, DECISIONS.INSUFFICIENT_EVIDENCE);
});

test('REJECT ges bara till en redan pensionerad strategi', () => {
  const out = improvement.decideFor(record({ retired: true, lifecycle: 'retired', strategyScore: 10 }), null);
  assert.equal(out.decision, DECISIONS.REJECT);
});

// ── 65-procentsregeln utan klassificering ───────────────────────────────────

test('poäng under 65 utan evidens utlöser förbättring', () => {
  const out = improvement.decideFor(record({ strategyScore: 64.9 }), null);
  assert.equal(out.decision, DECISIONS.IMPROVE);
  assert.equal(out.improvementFocus, 'exploration');
});

test('poäng på eller över 65 utan evidens väntar på data', () => {
  const out = improvement.decideFor(record({ strategyScore: 65 }), null);
  assert.equal(out.decision, DECISIONS.WAITING_FOR_MORE_DATA);
});

test('production score används bara när strategy score saknas', () => {
  assert.equal(improvement._internal.scoreOf({ strategyScore: 70, productionScore: 10 }).source, 'strategyScore');
  assert.equal(improvement._internal.scoreOf({ productionScore: 10 }).source, 'productionScore');
  assert.equal(improvement._internal.scoreOf({}).value, null);
});

test('en population summeras per beslut', () => {
  const decisions = improvement.decideAll([
    record({ strategyId: 'a', strategyScore: 20 }),
    record({ strategyId: 'b', strategyScore: 90 }),
    record({ strategyId: 'c', retired: true }),
  ]);
  const summary = improvement.summarize(decisions);
  assert.equal(summary.total, 3);
  assert.equal(summary.counts[DECISIONS.IMPROVE], 1);
  assert.equal(summary.counts[DECISIONS.WAITING_FOR_MORE_DATA], 1);
  assert.equal(summary.counts[DECISIONS.REJECT], 1);
  assert.equal(summary.needsImprovement, 1);
});

test('beslutslagret ger ingen behörighet', () => {
  const d = improvement.describe();
  assert.equal(d.actions_allowed, false);
  assert.equal(d.can_place_orders, false);
  assert.equal(d.live_trading_enabled, false);
  assert.equal(d.readOnly, true);
});
