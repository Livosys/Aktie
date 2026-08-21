'use strict';

// ── Acceptanstest: Research Evidence Policy ─────────────────────────────────
//
// Policyn avgör om en hypotes får kallas validerad kandidat. Tre egenskaper
// måste hålla, och alla tre har en konkret anledning:
//
//   · den får inte förkasta något den inte mätte tillräckligt
//   · den får inte godkänna en kontroll som inte gick att köra
//   · den får inte ge någon behörighet — den klassificerar, inget annat

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./researchEvidencePolicyService');

// Ett utfall som klarar samtliga grindar. Varje test nedan bryter EN sak.
function strongResearch(overrides = {}) {
  return { trades: 200, profitFactor: 1.6, netPnlUsd: 4000, maxDrawdownUsd: 1000, ...overrides };
}
function strongValidation(overrides = {}) {
  return { trades: 120, profitFactor: 1.4, netPnlUsd: 2000, maxDrawdownUsd: 800, ...overrides };
}
// 60 dagar, jämnt fördelade, ingen enskild dag dominerar.
function evenDays(count = 60, positiveShare = 0.6, each = 100) {
  return Array.from({ length: count }, (_, i) => ({
    strategyPnlUsd: i < Math.round(count * positiveShare) ? each : -each / 2,
  }));
}

function classifyStrong(overrides = {}) {
  return policy.classify({
    research: strongResearch(overrides.research),
    validation: strongValidation(overrides.validation),
    researchDailyRows: overrides.researchDailyRows || evenDays(),
    validationDailyRows: overrides.validationDailyRows || evenDays(50),
  });
}

test('1. en hypotes som klarar allt blir kandidat', () => {
  const result = classifyStrong();
  assert.equal(result.outcome, policy.OUTCOMES.CANDIDATE, JSON.stringify(result.failed));
  assert.deepEqual(result.failed, []);
});

test('2. för litet urval ger OTILLRÄCKLIG, aldrig FÖRKASTAD', () => {
  // Det här är policyns viktigaste egenskap. Att förkasta en hypotes man inte
  // mätte tillräckligt är att kasta bort en möjlig sanning och kalla det ett
  // resultat — och utfallet ser likadant ut som ett riktigt nej.
  const result = policy.classify({
    research: strongResearch({ trades: 12, profitFactor: 0.3, netPnlUsd: -900 }),
    validation: strongValidation({ trades: 5, profitFactor: 0.2, netPnlUsd: -500 }),
    researchDailyRows: evenDays(6),
    validationDailyRows: evenDays(4),
  });
  assert.equal(result.outcome, policy.OUTCOMES.INSUFFICIENT);
  assert.equal(result.reason, 'sample_below_policy_minimum');
  assert.notEqual(result.outcome, policy.OUTCOMES.REJECTED);
});

test('3. tillräckligt urval utan edge ger FÖRKASTAD', () => {
  // Bruttoedgen måste falla också, annars är det inte "ingen edge" — se test 3b.
  const result = classifyStrong({ validation: { profitFactor: 0.8, netPnlUsd: -2000 } });
  assert.equal(result.outcome, policy.OUTCOMES.REJECTED);
  assert.equal(result.reason, 'sufficient_sample_shows_no_edge');
  assert.ok(result.failed.includes('validation_net_positive'));
});

test('3b. bruttoedge som inte bär sin kostnad är inte ett nej', () => {
  // Profit factor över 1 i BÅDA perioderna betyder att signalen fungerar; ett
  // negativt netto betyder att kostnaden äter den. Två olika svar som leder
  // till olika arbete — det ena "sök vidare", det andra "angrip kostnaden".
  //
  // Sju hypoteser i cykel 1 och 2 låg precis här och kallades förkastade.
  const result = classifyStrong({ validation: { profitFactor: 1.1, netPnlUsd: -1400 } });
  assert.equal(result.outcome, policy.OUTCOMES.INSUFFICIENT);
  assert.equal(result.reason, 'gross_edge_holds_but_costs_are_not_carried');
  // Men den blir ALDRIG kandidat: nettokravet står kvar bland teckentesten.
  assert.notEqual(result.outcome, policy.OUTCOMES.CANDIDATE);
  assert.ok(result.failed.includes('validation_net_positive'));

  // v1 avkunnade en annan dom, och den domen står kvar för det som redan mätts.
  const underV1 = policy.classify({
    research: strongResearch(), validation: strongValidation({ profitFactor: 1.1, netPnlUsd: -1400 }),
    researchDailyRows: evenDays(), validationDailyRows: evenDays(50),
    policyVersion: policy.POLICY_VERSIONS.V1,
  });
  assert.equal(underV1.outcome, policy.OUTCOMES.REJECTED);
  assert.throws(() => policy.classify({ policyVersion: 'v9' }), /unknown_research_evidence_policy_version/);
});

test('4. positiva tecken men för svag magnitud ger OTILLRÄCKLIG', () => {
  // PF 1.15 på research: hypotesen tjänar pengar men når inte projektets egen
  // befordringsnivå. Det är inte ett nej — det är ett "inte bevisat".
  const result = classifyStrong({
    research: { profitFactor: 1.15 },
    validation: { profitFactor: 1.05 },
  });
  assert.equal(result.outcome, policy.OUTCOMES.INSUFFICIENT);
  assert.equal(result.reason, 'edge_present_but_below_policy_magnitude');
  assert.ok(result.failed.includes('research_profit_factor'));
});

test('5. edgen mäts över break-even, inte som andel av profit factor', () => {
  // 1.60 -> 1.24 ser ut som ett fall på 22 % men är 40 % av edgen kvar.
  const result = classifyStrong({ validation: { profitFactor: 1.24 } });
  assert.ok(result.measured.edgeRetention < 0.5);
  assert.ok(result.failed.includes('edge_retention'));
  // Och 1.60 -> 1.40 är 67 % kvar och ska hålla.
  assert.equal(classifyStrong().failed.includes('edge_retention'), false);
});

test('6. en kontroll som inte gick att köra räknas som ej uppfylld', () => {
  // Utan per-dygnsrader kan koncentrationen inte mätas. Att låta den passera
  // hade gjort robusthetskravet verkningslöst för varje anropare som råkar
  // sakna underlaget — alltså precis när det behövs som mest.
  const result = policy.classify({
    research: strongResearch(), validation: strongValidation(),
    researchDailyRows: [], validationDailyRows: [],
  });
  assert.notEqual(result.outcome, policy.OUTCOMES.CANDIDATE);
  const concentration = result.checks.find((row) => row.id === 'research_top_day_share');
  assert.equal(concentration.passed, false);
  assert.match(concentration.note, /kunde inte köras/);
});

test('7. koncentration fångar en edge som kom från en enda dag', () => {
  const oneBigDay = [{ strategyPnlUsd: 5000 }, ...Array.from({ length: 59 }, () => ({ strategyPnlUsd: 20 }))];
  const result = classifyStrong({ researchDailyRows: oneBigDay });
  assert.ok(result.measured.researchRobustness.topDayShare > policy.THRESHOLDS.maxTopDayShare.value);
  assert.ok(result.failed.includes('research_top_day_share'));
  assert.equal(result.outcome, policy.OUTCOMES.INSUFFICIENT);
});

test('8. drawdown vägs via recoveryFactor mot nettot', () => {
  // Nettot är positivt men mindre än periodens värsta nedgång.
  const result = classifyStrong({ research: { netPnlUsd: 500, maxDrawdownUsd: 2000 } });
  assert.ok(result.measured.researchRecoveryFactor < 1);
  assert.ok(result.failed.includes('research_recovery_factor'));
});

test('9. varje tröskel bär sin härkomst och sitt skäl', () => {
  for (const [name, row] of Object.entries(policy.THRESHOLDS)) {
    assert.ok(Object.values(policy.ORIGIN).includes(row.origin), `${name} saknar giltig härkomst`);
    assert.ok(row.rationale && row.rationale.length > 40, `${name} saknar skäl`);
    if (row.origin === policy.ORIGIN.PROJECT_DERIVED) {
      assert.ok(row.source && row.source.includes('src/'), `${name} påstår sig komma ur koden men pekar inte på var`);
    }
  }
  // Så länge något förslag är ogodkänt får policyn inte utge sig för att vara beslutad.
  const described = policy.describePolicy();
  assert.equal(described.status, described.pendingHumanDecisions.length ? 'proposed_pending_human_approval' : 'approved');
});

test('10. policyn ger ingen behörighet', () => {
  const result = classifyStrong();
  assert.equal(result.outcome, policy.OUTCOMES.CANDIDATE);
  // Även en godkänd kandidat är varken runtime eller paper.
  assert.equal(result.grants_runtime_eligibility, false);
  assert.equal(result.grants_paper_eligibility, false);
  assert.equal(result.live_trading_enabled, false);
  assert.equal(result.can_place_orders, false);
  const hypotheses = require('./researchHypothesisService');
  assert.equal(hypotheses.gatesFor('HISTORICALLY_VALIDATED_CANDIDATE').runtimeEligible, false);
  assert.equal(hypotheses.gatesFor('HISTORICALLY_VALIDATED_CANDIDATE').paperEligible, false);
});

test('11. inga strateginamn i policyn — den är generisk', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'researchEvidencePolicyService.js'), 'utf8');
  for (const id of require('./researchHypothesisService').STRATEGY_IDS) {
    assert.doesNotMatch(source, new RegExp(id), `policyn nämner ${id}`);
  }
  assert.doesNotMatch(source, /native_futures_\w+_v\d/);
});

console.log('researchEvidencePolicy.acceptance.test.js loaded');
