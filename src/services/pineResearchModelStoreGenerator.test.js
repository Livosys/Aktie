'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const model = require('./pineResearchModelService');
const { createPineResearchStore } = require('./pineResearchStoreService');
const generator = require('./pineScriptGeneratorService');
const validator = require('./pineScriptValidationService');
const loop = require('./pineResearchLoopService');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pine-research-store-'));
}

function main() {
  const root = tempDir();
  try {
    assert.throws(() => model.normalizeCandidate({ baseStrategyId: 'x', live_trading_enabled: true }), /live_trading_enabled/);
    assert.throws(() => model.normalizeEvaluation({
      pineVersionId: 'v',
      nextAction: 'activate_paper_trading',
    }), /next_action_is_invalid/);
    assert.throws(() => model.normalizeEvaluation({
      pineVersionId: 'v',
      nextAction: 'hold_for_review',
      recommendedChanges: [{ field: 'approvalStatus', operation: 'set', value: 'READY' }],
    }), /recommended_change_field_not_allowed/);

    const store = createPineResearchStore({ rootDir: root });
    const candidate = store.saveCandidate({ baseStrategyId: 'opening_range_breakout', strategyName: 'ORB' });
    assert.equal(candidate.safety.mode, 'paper_only');
    assert.equal(candidate.safety.can_place_orders, false);

    const version = generator.generatePineVersion({
      candidateId: candidate.candidateId,
      baseStrategyId: candidate.baseStrategyId,
      version: 'v1_baseline',
      parameters: { direction: 'both', openingRangeMinutes: 15 },
    });
    assert.match(version.sourceCode, /^\/\/@version=6/m);
    assert.match(version.sourceCode, /strategy\(/);
    assert.match(version.sourceCode, /input\.time\(timestamp\("01 Jan 2025 00:00 -0500"\)/);
    assert.doesNotMatch(version.sourceCode, /lookahead_on|strategy\.order|alert\s*\(/i);
    assert.equal(version.sourceHash, model.hashText(version.sourceCode));
    assert.equal(version.parameterHash, model.hashValue(version.parameters));

    const validated = validator.validatePineVersion(version);
    assert.equal(validated.compileStatus, 'static_valid');
    assert.equal(validated.status, 'ready_for_test');
    assert.deepEqual(validated.compileErrors, []);

    const invalid = validator.validatePineSource({
      sourceCode: `${version.sourceCode}\nrequest.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on)`,
    });
    assert.equal(invalid.compileStatus, 'static_invalid');
    assert.ok(invalid.compileErrors.includes('lookahead_on_is_not_allowed'));

    store.saveVersion(validated);
    store.saveVersion(validated);
    assert.equal(store.list('versions').length, 1, 'sourceHash+parameterHash dedup should keep one version');

    const pilot = loop.ensureOrbPilot(store);
    assert.equal(pilot.versions.length, 9);
    assert.ok(pilot.versions.every((item) => item.baseStrategyId === 'opening_range_breakout'));
    assert.ok(pilot.versions.every((item) => item.compileStatus === 'static_valid'));

    fs.writeFileSync(path.join(root, 'candidates.json'), '{broken-json', 'utf8');
    const degraded = store.readCollection('candidates');
    assert.equal(degraded.status, 'degraded');
    assert.deepEqual(degraded.items, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
console.log('pineResearchModelStoreGenerator.test.js passed');
