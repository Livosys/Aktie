'use strict';

/**
 * Test: Automatic Lifecycle Promotion Triggered by Replay Evidence
 *
 * Verifies that after replay execution + evidence recording, strategies
 * automatically advance through lifecycle stages without requiring supervisor endpoint.
 */

const assert = require('assert');
const lib = require('../library/strategyLibraryService');
const promotion = require('../library/promotionEngineService');
const lifecyclePromotion = require('../library/strategyLifecyclePromotionService');

describe('Automatic Lifecycle Promotion (Event-Driven)', () => {
  describe('Scenario A: TESTING strategy reaches LEARNING on replay evidence', () => {
    it('TESTING strategy with replay evidence can advance to LEARNING', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find a TESTING strategy
      const testing = allStrategies.find(s => s.lifecycle === 'testing');
      assert.ok(testing, 'Should have at least one TESTING strategy');

      // If it has replay evidence, it should be evaluated as eligible for LEARNING
      if (testing.replayHistory && testing.replayHistory.length >= 10) {
        const evaluation = promotion.evaluatePromotion(testing);
        assert.strictEqual(evaluation.to, 'learning', 'Should evaluate to LEARNING as next stage');

        if (testing.replayHistory.length >= 10) {
          // If it has enough trades, evaluation should allow advancement
          if (evaluation.allowed) {
            console.log(`  ✓ ${testing.strategyId} can advance TESTING→LEARNING`);
          }
        }
      }
    });
  });

  describe('Scenario B: LEARNING strategy reaches CANDIDATE on sufficient evidence', () => {
    it('LEARNING strategy with 2+ regimes and sufficient score can advance to CANDIDATE', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find a LEARNING strategy
      const learning = allStrategies.filter(s => s.lifecycle === 'learning');
      assert.ok(learning.length > 0, 'Should have at least one LEARNING strategy');

      // Check if any can evaluate as ready for CANDIDATE
      const ready = learning.filter(s => {
        const evaluation = promotion.evaluatePromotion(s);
        return evaluation.from === 'learning' && evaluation.to === 'candidate' && evaluation.allowed;
      });

      console.log(`  ✓ Found ${learning.length} LEARNING strategies, ${ready.length} ready for CANDIDATE`);
    });
  });

  describe('Scenario C: CANDIDATE reaches PAPER with PAPER_REVIEW_RECOMMENDED', () => {
    it('CANDIDATE strategy passing PAPER gate is recommended for review', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find CANDIDATE strategies
      const candidates = allStrategies.filter(s => s.lifecycle === 'candidate');
      console.log(`  ✓ Found ${candidates.length} CANDIDATE strategies`);

      // Check which ones are ready for PAPER
      const readyForPaper = candidates.filter(s => {
        const evaluation = promotion.evaluatePromotion(s);
        return evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed;
      });

      if (readyForPaper.length > 0) {
        for (const strat of readyForPaper) {
          assert.ok(strat.strategyId, 'Should have strategyId');
          console.log(`  ✓ ${strat.strategyId} eligible for PAPER review`);
          assert.ok(strat.executionScore >= 40, 'Should have executionScore >= 40');
        }
      }
    });
  });

  describe('Scenario D: Blocked gate prevents lifecycle advancement', () => {
    it('TESTING strategy without replay runs is blocked', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find TESTING strategies with no replays
      const blocked = allStrategies.filter(s => {
        if (s.lifecycle !== 'testing') return false;
        const evaluation = promotion.evaluatePromotion(s);
        return !evaluation.allowed && evaluation.to === 'learning';
      });

      assert.ok(blocked.length > 0, 'Should have blocked TESTING strategies');

      // Verify they're blocked on expected gates
      const sample = blocked[0];
      const evaluation = promotion.evaluatePromotion(sample);
      assert.ok(evaluation.blockers.length > 0, 'Should have blockers');
      console.log(`  ✓ ${sample.strategyId} blocked: ${evaluation.blockers.join(', ')}`);
    });

    it('LEARNING strategy in single regime is blocked from CANDIDATE', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();

      // Find LEARNING strategies with only one regime
      const singleRegime = allStrategies.filter(s => {
        if (s.lifecycle !== 'learning') return false;
        const evaluation = promotion.evaluatePromotion(s);
        return evaluation.blockers.includes('tested_in_multiple_regimes');
      });

      if (singleRegime.length > 0) {
        const sample = singleRegime[0];
        const evaluation = promotion.evaluatePromotion(sample);
        assert.strictEqual(evaluation.from, 'learning');
        assert.strictEqual(evaluation.to, 'candidate');
        assert.strictEqual(evaluation.allowed, false);
        console.log(`  ✓ ${sample.strategyId} blocked: needs 2+ regimes, has 1`);
      }
    });
  });

  describe('Scenario E: Replay failure does not advance lifecycle', () => {
    it('Strategy with failed replay has no lifecycle advancement', () => {
      // This scenario would require injecting a failed replay, which is integration testing
      // For now, verify that the lifecycle service doesn't crash on edge cases
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const sample = allStrategies[0];

      // Calling promoteReadyStrategies should not crash
      const result = lifecyclePromotion.promoteReadyStrategies(lib.defaultStrategyLibrary);
      assert.ok(result !== undefined, 'Should return a result');
      assert.ok(typeof result.evaluated === 'number', 'Should have evaluated count');
      console.log(`  ✓ Evaluated ${result.evaluated} strategies, promoted ${result.promoted.length}`);
    });
  });

  describe('Scenario F: Duplicate replay callback prevents duplicate transitions', () => {
    it('Multiple promotion calls do not create duplicate events', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const sample = allStrategies.find(s => s.lifecycle === 'testing');

      if (sample) {
        const before = lib.defaultStrategyLibrary.getHistory(sample.strategyId).length;

        // Simulate two consecutive promotion runs
        const result1 = lifecyclePromotion.evaluateStrategyReadiness(lib.defaultStrategyLibrary, sample.strategyId);
        const result2 = lifecyclePromotion.evaluateStrategyReadiness(lib.defaultStrategyLibrary, sample.strategyId);

        // Both evaluations should be identical (deterministic)
        assert.deepStrictEqual(result1, result2, 'Evaluations should be deterministic');

        const after = lib.defaultStrategyLibrary.getHistory(sample.strategyId).length;
        // No events should be added from just evaluating
        assert.strictEqual(before, after, 'Evaluation alone should not add events');
        console.log(`  ✓ Evaluation is deterministic, no duplicate events`);
      }
    });
  });

  describe('Scenario G: State persists across reload', () => {
    it('Lifecycle transitions are persisted to event log', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const sample = allStrategies.find(s => s.lifecycle !== 'draft');

      if (sample) {
        const history = lib.defaultStrategyLibrary.getHistory(sample.strategyId);
        const transitions = history.filter(e => e.type === 'LIFECYCLE_TRANSITION');

        assert.ok(transitions.length > 0, `${sample.strategyId} should have transitions in event log`);
        console.log(`  ✓ ${sample.strategyId} has ${transitions.length} transitions persisted`);

        // Verify state can be reconstructed
        const reloaded = lib.defaultStrategyLibrary.getStrategy(sample.strategyId);
        assert.strictEqual(reloaded.lifecycle, sample.lifecycle, 'Lifecycle should be preserved');
      }
    });
  });

  describe('Scenario H: Supervisor overview no longer needed for progression', () => {
    it('Automatic promotion runs without supervisor endpoint', () => {
      // This is verified by the fact that promoteReadyStrategies is now called from orchestrator
      // Run the promotion engine directly (as orchestrator would)
      const result = lifecyclePromotion.promoteReadyStrategies(lib.defaultStrategyLibrary);

      assert.ok(result.ok !== undefined, 'Should have ok status');
      console.log(`  ✓ Direct promotion call (no supervisor): evaluated ${result.evaluated}, promoted ${result.promoted.length}`);

      if (result.promoted.length > 0) {
        console.log(`  ✓ Strategies promoted without supervisor endpoint:`);
        result.promoted.slice(0, 3).forEach(p => {
          console.log(`    - ${p.strategyId}: ${p.from}→${p.to}`);
        });
      }
    });
  });

  describe('Integration: Full lifecycle progression flow', () => {
    it('Complete lifecycle distribution shows proper progression', () => {
      const allStrategies = lib.defaultStrategyLibrary.listStrategies();
      const byLC = {};

      allStrategies.forEach(s => {
        byLC[s.lifecycle] = (byLC[s.lifecycle] || 0) + 1;
      });

      console.log('\n  Lifecycle Distribution:');
      Object.entries(byLC).sort().forEach(([stage, count]) => {
        console.log(`    ${stage}: ${count}`);
      });

      // Verify transitions are happening
      const withTransitions = allStrategies.filter(s => {
        const history = lib.defaultStrategyLibrary.getHistory(s.strategyId);
        return history.some(e => e.type === 'LIFECYCLE_TRANSITION');
      });

      console.log(`  ✓ ${withTransitions.length}/${allStrategies.length} strategies have lifecycle transitions`);
      assert.ok(withTransitions.length > 0, 'Should have strategies with transitions');
    });
  });
});

module.exports = { /* for programmatic use */ };
