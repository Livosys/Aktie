'use strict';

// ── Acceptanstest: godkänd policy inkopplad i batchflödet ───────────────────
//
// Policyn är godkänd och klassificerar nu varje research-hypotes automatiskt
// efter varje bokförd körning. Testerna bevakar de fem egenskaper som gör
// skillnaden mellan en grind och en gissning.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('./researchEvidencePolicyService');
const ledger = require('./researchEvidenceLedgerService');
const hypotheses = require('./researchHypothesisService');
const specification = require('./strategyResearchSpecificationService');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'cycle12Evidence.fixture.json'), 'utf8'),
);

const asRows = (values) => values.map((strategyPnlUsd) => ({ strategyPnlUsd }));

test('1. batchflödet använder den GODKÄNDA policyn', () => {
  assert.equal(policy.describePolicy().status, 'approved');
  assert.deepEqual(policy.listPendingHumanDecisions(), []);
  assert.equal(policy.APPROVAL.approvedBy, 'human_operator');
  assert.deepEqual([...policy.APPROVAL.scope].sort(),
    ['maxTopDayShare', 'minEdgeRetention', 'minPositiveDayShare', 'minTradingDays']);

  // Godkännandet får inte ha ändrat något värde. En policy som godkänns med
  // andra tal än de som granskades är inte den policy som godkändes.
  assert.equal(policy.THRESHOLDS.minTradingDays.value, 20);
  assert.equal(policy.THRESHOLDS.minEdgeRetention.value, 0.5);
  assert.equal(policy.THRESHOLDS.maxTopDayShare.value, 0.35);
  assert.equal(policy.THRESHOLDS.minPositiveDayShare.value, 0.4);
  // Nettokraven står kvar på båda perioderna.
  assert.equal(policy.THRESHOLDS.researchNetPositive.value, 0);
  assert.equal(policy.THRESHOLDS.validationNetPositive.value, 0);

  // Specifikationen läser status ur policyn, inte ur en handskriven sträng.
  const spec = specification.buildSpecifications()[0];
  assert.equal(spec.validationRequirements.thresholdsStatus, 'approved');
  assert.equal(spec.validationRequirements.thresholdsPolicyVersion, policy.POLICY_VERSION);

  // Och worker-vägen anropar faktiskt klassificeringen.
  const worker = fs.readFileSync(path.join(__dirname, '../../jobs/runNativeReplayWorker.js'), 'utf8');
  assert.match(worker, /classifyRecordedRun/);
  assert.match(worker, /researchEvidenceLedgerService/);
});

test('2. ett litet urval blir aldrig FÖRKASTAD', () => {
  // Den enskilt viktigaste egenskapen. Att förkasta något man inte mätte
  // tillräckligt ser ut precis som ett riktigt nej — och är det inte.
  for (const trades of [0, 1, 5, 29]) {
    const result = policy.classify({
      research: { trades, profitFactor: 0.1, netPnlUsd: -9999, maxDrawdownUsd: 9999 },
      validation: { trades, profitFactor: 0.1, netPnlUsd: -9999, maxDrawdownUsd: 9999 },
      researchDailyRows: asRows(new Array(Math.max(trades, 1)).fill(-100)),
      validationDailyRows: asRows(new Array(Math.max(trades, 1)).fill(-100)),
    });
    assert.notEqual(result.outcome, policy.OUTCOMES.REJECTED,
      `${trades} affärer får inte räcka för att förkasta`);
    assert.equal(result.outcome, policy.OUTCOMES.INSUFFICIENT);
  }

  // Även med gott om affärer räcker det inte om de kom från för få dagar.
  const fewDays = policy.classify({
    research: { trades: 400, profitFactor: 0.2, netPnlUsd: -5000, maxDrawdownUsd: 5000 },
    validation: { trades: 300, profitFactor: 0.2, netPnlUsd: -4000, maxDrawdownUsd: 4000 },
    researchDailyRows: asRows(new Array(4).fill(-1250)),
    validationDailyRows: asRows(new Array(4).fill(-1000)),
  });
  assert.equal(fewDays.outcome, policy.OUTCOMES.INSUFFICIENT);
  assert.equal(fewDays.reason, 'sample_below_policy_minimum');
});

test('3. en underkänd eller omätbar kontroll ger aldrig KANDIDAT', () => {
  const strong = {
    research: { trades: 300, profitFactor: 1.7, netPnlUsd: 6000, maxDrawdownUsd: 1200 },
    validation: { trades: 200, profitFactor: 1.5, netPnlUsd: 3000, maxDrawdownUsd: 900 },
    researchDailyRows: asRows(new Array(80).fill(0).map((_, i) => (i % 2 ? 200 : -100))),
    validationDailyRows: asRows(new Array(60).fill(0).map((_, i) => (i % 2 ? 200 : -100))),
  };
  assert.equal(policy.classify(strong).outcome, policy.OUTCOMES.CANDIDATE);

  // Ett saknat värde får inte passera som godkänt. Number(null) är 0, och utan
  // uttrycklig null-hantering hade ett SAKNAT netto blivit ett uppmätt
  // nollresultat — en bokföringsbrist förvandlad till ett mätvärde.
  for (const field of ['profitFactor', 'netPnlUsd', 'maxDrawdownUsd']) {
    for (const phase of ['research', 'validation']) {
      const broken = { ...strong, [phase]: { ...strong[phase], [field]: null } };
      const result = policy.classify(broken);
      assert.notEqual(result.outcome, policy.OUTCOMES.CANDIDATE,
        `${phase}.${field} = null får inte ge kandidat`);
    }
  }

  // Saknade dygnsrader gör robusthetskontrollerna omätbara — också då: inte kandidat.
  const noDaily = policy.classify({ ...strong, researchDailyRows: [], validationDailyRows: [] });
  assert.notEqual(noDaily.outcome, policy.OUTCOMES.CANDIDATE);
  assert.equal(noDaily.checks.filter((row) => !row.measurable).length > 0
    || noDaily.failed.includes('research_top_day_share'), true);

  // Och varje underkänd kontroll ska gå att peka ut.
  for (const row of policy.classify(noDaily).checks) {
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.passed, 'boolean');
    assert.equal(typeof row.measurable, 'boolean');
  }
});

test('4. en validerad kandidat är fortfarande varken runtime eller Paper', () => {
  const candidate = policy.classify({
    research: { trades: 300, profitFactor: 1.7, netPnlUsd: 6000, maxDrawdownUsd: 1200 },
    validation: { trades: 200, profitFactor: 1.5, netPnlUsd: 3000, maxDrawdownUsd: 900 },
    researchDailyRows: asRows(new Array(80).fill(0).map((_, i) => (i % 2 ? 200 : -100))),
    validationDailyRows: asRows(new Array(60).fill(0).map((_, i) => (i % 2 ? 200 : -100))),
  });
  assert.equal(candidate.outcome, policy.OUTCOMES.CANDIDATE);
  assert.equal(candidate.grants_runtime_eligibility, false);
  assert.equal(candidate.grants_paper_eligibility, false);
  assert.equal(candidate.live_trading_enabled, false);
  assert.equal(candidate.can_place_orders, false);

  const gates = hypotheses.gatesFor('HISTORICALLY_VALIDATED_CANDIDATE');
  assert.equal(gates.runtimeEligible, false);
  assert.equal(gates.paperEligible, false);

  // Hypotesobjekten själva står kvar.
  for (const row of hypotheses.listHypotheses()) {
    assert.equal(row.runtimeEligible, false);
    assert.equal(row.paperEligible, false);
  }
  // Och paper-vägen ser fortfarande ingen research.
  const registry = require('../nativeFuturesStrategyRegistryService');
  assert.equal(registry.listStrategyEvaluators().some((row) => hypotheses.isResearchStrategyId(row.strategyId)), false);
});

test('5. cykel 1 och 2 behåller exakt samma klassificering under v1', () => {
  // Domarna avkunnades under v1. Att räkna om dem i efterhand hade varit att
  // ändra ett protokoll — v2 gäller framåt, inte bakåt.
  const entries = Object.entries(FIXTURE);
  assert.equal(entries.length, 22);
  const counts = {};
  for (const [strategyId, row] of entries) {
    const result = policy.classify({
      research: row.research,
      validation: row.validation,
      researchDailyRows: asRows(row.researchDaily),
      validationDailyRows: asRows(row.validationDaily),
      policyVersion: policy.POLICY_VERSIONS.V1,
    });
    assert.equal(result.outcome, row.expectedOutcome,
      `${strategyId} bytte klassificering`);
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  }
  assert.deepEqual(counts, {
    REJECTED_BY_HISTORICAL_EVIDENCE: 19,
    INSUFFICIENT_EVIDENCE: 3,
  });
  assert.equal(counts[policy.OUTCOMES.CANDIDATE] ?? 0, 0, 'ingen kandidat fanns och ingen ska uppstå');
});

test('5b. v2 flyttar sju domar från FÖRKASTAD till OTILLRÄCKLIG — och skapar ingen kandidat', () => {
  const counts = {};
  for (const row of Object.values(FIXTURE)) {
    const result = policy.classify({
      research: row.research,
      validation: row.validation,
      researchDailyRows: asRows(row.researchDaily),
      validationDailyRows: asRows(row.validationDaily),
    });
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  }
  assert.deepEqual(counts, {
    REJECTED_BY_HISTORICAL_EVIDENCE: 12,
    INSUFFICIENT_EVIDENCE: 10,
  });
  // Det viktigaste: v2 lättade på vad ett misslyckande KALLAS, inte på vad som
  // får befordras. Noll kandidater, precis som under v1.
  assert.equal(counts[policy.OUTCOMES.CANDIDATE] ?? 0, 0);
});

test('6. ledgern aggregerar ur biblioteket utan att blanda perioderna', () => {
  const split = {
    dataAccessMode: 'exact_contract',
    research: { days: ['2026-01-01'] },
    validation: { days: ['2026-02-01'] },
  };
  const day = (from, trades, winRate, avgWin, avgLoss, net) => ({
    type: 'REPLAY_RECORDED', strategyId: 'research__x__H001', from, trades, winRate,
    avgWinUsd: avgWin, avgLossUsd: avgLoss, strategyPnlUsd: net, netPnlUsd: net,
  });
  const library = {
    getAuditTrail: () => [
      day('2026-01-02T13:00:00.000Z', 10, 60, 100, 50, 400),
      day('2026-02-02T13:00:00.000Z', 8, 50, 90, 60, 120),
      // En dag utanför splitten hör inte till någon period.
      day('2026-05-05T13:00:00.000Z', 99, 99, 999, 1, 99999),
    ],
  };
  const evidence = ledger.collectEvidence('research__x__H001', { library, split });
  assert.equal(evidence.research.length, 1);
  assert.equal(evidence.validation.length, 1);

  const aggregate = ledger.aggregateDailyRows(evidence.research);
  assert.equal(aggregate.trades, 10);
  assert.equal(aggregate.netPnlUsd, 400);
  assert.equal(aggregate.netAvailable, true);
  // 6 vinnare a 100 mot 4 forlorare a 50 => 600/200
  assert.equal(aggregate.profitFactor, 3);
  assert.equal(aggregate.drawdownResolution, 'trading_day');

  // Saknas netto ska det synas som saknat, inte som noll.
  const withoutNet = ledger.aggregateDailyRows([{ ...day('2026-01-02T13:00:00.000Z', 10, 60, 100, 50, 400), netPnlUsd: undefined }]);
  assert.equal(withoutNet.netAvailable, false);
  assert.equal(withoutNet.netPnlUsd, null);
});

test('7. kostnadsbackfill är en egen typ och räknas aldrig som ännu en körning', () => {
  const library = require('../library/strategyLibraryService');
  assert.equal(library.EVENT_TYPES.REPLAY_COST_BACKFILLED, 'REPLAY_COST_BACKFILLED');
  assert.notEqual(library.EVENT_TYPES.REPLAY_COST_BACKFILLED, library.EVENT_TYPES.REPLAY_RECORDED);

  // Ledgern får aldrig räkna den som en replay-rad — då hade en backfill
  // dubblerat evidensen den skulle komplettera.
  const split = {
    dataAccessMode: 'exact_contract',
    research: { days: ['2026-01-01'] },
    validation: { days: ['2026-02-01'] },
  };
  const replay = {
    type: 'REPLAY_RECORDED', strategyId: 'research__x__H001', runId: 'r1',
    from: '2026-01-02T13:00:00.000Z', trades: 10, winRate: 60,
    avgWinUsd: 100, avgLossUsd: 50, strategyPnlUsd: 400,
  };
  const backfill = {
    type: 'REPLAY_COST_BACKFILLED', strategyId: 'research__x__H001',
    phase: 'research', resolution: 'period', trades: 10, netPnlUsd: 375.6,
    executionCostUsd: 0, commissionUsd: 24.4,
  };
  const evidence = ledger.collectEvidence('research__x__H001', {
    library: { getAuditTrail: () => [replay, backfill] }, split, excludedRuns: new Set(),
  });
  assert.equal(evidence.research.length, 1, 'backfillen får inte räknas som en körning');
  assert.equal(evidence.costBackfill.research.netPnlUsd, 375.6);
});

test('8. backfillen används bara när dygnsraderna saknar netto', () => {
  const daily = ledger.aggregateDailyRows([{
    from: '2026-01-02T13:00:00.000Z', trades: 10, winRate: 60,
    avgWinUsd: 100, avgLossUsd: 50, strategyPnlUsd: 400, netPnlUsd: 400,
  }]);
  const withBackfill = ledger._internal.withCostBackfill(daily, { trades: 10, netPnlUsd: 999 });
  assert.equal(withBackfill.netPnlUsd, 400, 'dygnsraderna är den bättre källan när de finns');
  assert.equal(withBackfill.netSource, 'daily_rows');

  const missing = ledger.aggregateDailyRows([{
    from: '2026-01-02T13:00:00.000Z', trades: 10, winRate: 60,
    avgWinUsd: 100, avgLossUsd: 50, strategyPnlUsd: 400,
  }]);
  const filled = ledger._internal.withCostBackfill(missing, { trades: 10, netPnlUsd: 375.6 });
  assert.equal(filled.netPnlUsd, 375.6);
  assert.equal(filled.netSource, 'period_backfill');
  assert.equal(filled.netResolution, 'period');
});

test('9. en backfill som täcker andra körningar avvisas i stället för att blandas', () => {
  // Antalet affärer måste stämma. Gör det inte beskriver backfillen ett annat
  // underlag än raderna, och att ändå använda den vore att svara på en fråga
  // ingen ställde.
  const daily = ledger.aggregateDailyRows([{
    from: '2026-01-02T13:00:00.000Z', trades: 10, winRate: 60,
    avgWinUsd: 100, avgLossUsd: 50, strategyPnlUsd: 400,
  }]);
  const rejected = ledger._internal.withCostBackfill(daily, { trades: 744, netPnlUsd: 896.14 });
  assert.equal(rejected.netPnlUsd, null);
  assert.equal(rejected.netAvailable, false);
  assert.equal(rejected.netBackfillRejected, 'trade_count_mismatch');
});

test('10. uteslutna körningar filtreras på PARET strategi och körning', () => {
  // En körning omfattar samtliga hypoteser i passet. Att utesluta på runId
  // ensamt hade tagit bort hela passet för alla — inklusive de hypoteser som
  // kördes korrekt.
  const memory = {
    listExperiments: () => [{
      excluded: true,
      libraryRef: { strategyId: 'research__a__H001' },
      exclusion: { evidence: { strategyId: 'research__a__H001', libraryRunId: 'shared-run' } },
      provenance: [{ runId: 'shared-run' }],
    }],
  };
  const keys = ledger._internal.excludedRunKeys(memory);
  assert.equal(keys.has('research__a__H001|shared-run'), true);
  assert.equal(keys.has('research__b__H001|shared-run'), false, 'grannen i samma körning får inte strykas');
});

console.log('researchEvidenceIntegration.acceptance.test.js loaded');
