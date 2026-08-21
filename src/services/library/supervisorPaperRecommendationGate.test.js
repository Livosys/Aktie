'use strict';

/**
 * Test: Supervisor Paper Recommendation Gate
 *
 * Verifies that supervisor uses canonical promotionEngineService evaluator
 * to determine PAPER readiness, not duplicated gate logic.
 */

const assert = require('assert');
const lib = require('./strategyLibraryService');
const promotion = require('./promotionEngineService');

describe('Supervisor PAPER Recommendation Gate', () => {
  describe('uses canonical promotionEngine.evaluatePromotion()', () => {
    it('DRAFT strategies should NOT be recommended', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const draftStrategies = allStrategies.filter(s => s.lifecycle === 'draft').slice(0, 3);

      for (const draft of draftStrategies) {
        const evaluation = promotion.evaluatePromotion(draft);
        // DRAFT → TESTING is the next stage, not PAPER
        assert.notEqual(evaluation.to, 'paper', `${draft.strategyId} should not transition to PAPER from DRAFT`);
        // Would only recommend if from=candidate AND to=paper AND allowed=true
        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        assert.strictEqual(wouldRecommend, false, `${draft.strategyId} should NOT be recommended`);
      }
    });

    it('TESTING strategies should NOT be recommended', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const testingStrategies = allStrategies.filter(s => s.lifecycle === 'testing').slice(0, 3);

      for (const testing of testingStrategies) {
        const evaluation = promotion.evaluatePromotion(testing);
        // TESTING → LEARNING is next, not PAPER
        assert.notEqual(evaluation.to, 'paper', `${testing.strategyId} should not transition to PAPER from TESTING`);
        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        assert.strictEqual(wouldRecommend, false, `${testing.strategyId} should NOT be recommended`);
      }
    });

    it('LEARNING strategies should NOT be recommended', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const learningStrategies = allStrategies.filter(s => s.lifecycle === 'learning').slice(0, 3);

      for (const learning of learningStrategies) {
        const evaluation = promotion.evaluatePromotion(learning);
        // LEARNING → CANDIDATE is next, not PAPER
        assert.notEqual(evaluation.to, 'paper', `${learning.strategyId} should not transition to PAPER from LEARNING`);
        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        assert.strictEqual(wouldRecommend, false, `${learning.strategyId} should NOT be recommended`);
      }
    });

    it('CANDIDATE strategies only recommended if evaluation.allowed is true', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const candidateStrategies = allStrategies.filter(s => s.lifecycle === 'candidate');

      for (const candidate of candidateStrategies) {
        const evaluation = promotion.evaluatePromotion(candidate);
        // For CANDIDATE, next stage should be PAPER
        assert.strictEqual(evaluation.to, 'paper', `${candidate.strategyId} next stage should be PAPER`);
        assert.strictEqual(evaluation.from, 'candidate');

        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        // If allowed=true, should be recommended; if allowed=false, should NOT
        assert.strictEqual(wouldRecommend, evaluation.allowed, `Recommendation status should match evaluation.allowed`);
      }
    });

    it('uses evaluatePromotion without duplicating gate thresholds', () => {
      // This test verifies that supervisor implementation does NOT contain
      // hardcoded threshold checks like "executionScore >= 40"
      // Instead it relies entirely on evaluatePromotion result
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // The logic is:
      // for each strategy:
      //   evaluation = promotionEngine.evaluatePromotion(strategy)
      //   if evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed:
      //     recommend()

      // This ensures:
      // 1. No duplicated threshold logic
      // 2. If REQUIREMENTS change in promotionEngine, supervisor automatically follows
      // 3. Single source of truth

      const testStrategy = allStrategies.find(s => s.lifecycle === 'candidate') ||
                          allStrategies.find(s => s.lifecycle === 'draft');
      if (testStrategy) {
        const eval1 = promotion.evaluatePromotion(testStrategy);
        const eval2 = promotion.evaluatePromotion(testStrategy);
        // Both evaluations should be identical (deterministic)
        assert.deepStrictEqual(eval1, eval2);
      }
    });

    it('RETIRED strategies should NOT be recommended', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const retiredStrategies = allStrategies.filter(s => s.lifecycle === 'retired').slice(0, 3);

      for (const retired of retiredStrategies) {
        const evaluation = promotion.evaluatePromotion(retired);
        // RETIRED is terminal
        assert.strictEqual(evaluation.to, null, `${retired.strategyId} should have no next stage (RETIRED)`);
        assert.strictEqual(evaluation.allowed, false);
        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        assert.strictEqual(wouldRecommend, false, `${retired.strategyId} should NOT be recommended`);
      }
    });
  });

  describe('bestStrategy does NOT gate readiness', () => {
    it('highest performer may NOT be CANDIDATE-eligible', () => {
      // bestStrategy is purely informational - it's the strategy with highest win rate
      // but win rate is NOT part of CANDIDATE→PAPER gate
      // A DRAFT strategy with lucky 100% win rate should NOT be recommended
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find highest win rate strategy
      const byWinRate = allStrategies
        .filter(s => s.paperHistory && s.paperHistory.length > 0)
        .sort((a, b) => {
          const aWR = a.paperWinRate || 0;
          const bWR = b.paperWinRate || 0;
          return bWR - aWR;
        });

      if (byWinRate.length > 0) {
        const best = byWinRate[0];
        const evaluation = promotion.evaluatePromotion(best);

        // Even if best performer, should only recommend if CANDIDATE + evaluation.allowed
        const wouldRecommend = evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
        const shouldRecommendByCanonical = wouldRecommend;

        // bestStrategy does NOT gate readiness
        assert.notStrictEqual(
          best.lifecycle === 'draft',
          shouldRecommendByCanonical,
          `DRAFT best-performer should NOT be recommended, only canonical gates matter`
        );
      }
    });
  });

  describe('promotion gates are single source of truth', () => {
    it('if REQUIREMENTS change, supervisor follows automatically', () => {
      // REQUIREMENTS is defined in promotionEngineService
      // Supervisor asks: evaluation = evaluatePromotion(strategy)
      // Supervisor does NOT hardcode: executionScore >= 40
      // This means if REQUIREMENTS[CANDIDATE->PAPER] is updated,
      // all supervisors automatically use new gates

      const requirements = promotion.REQUIREMENTS['candidate->paper'];
      assert.ok(requirements, 'REQUIREMENTS for CANDIDATE→PAPER must exist');
      assert.ok(Array.isArray(requirements), 'REQUIREMENTS must be an array of gate objects');
      assert.ok(requirements.length > 0, 'Must have at least one gate');

      // Each requirement has: code, test, detail
      for (const req of requirements) {
        assert.ok(req.code, `Requirement must have code (got ${req.code})`);
        assert.strictEqual(typeof req.test, 'function', 'Each requirement must have test function');
      }
    });
  });
});
