'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersPaperMultiStrategyConfigService');

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function withEnv(env, fn) {
  const original = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

(async () => {
  await run('default config is safe and conservative', () => {
    const cfg = svc.getIbPaperMultiStrategyConfig({});
    assert.deepEqual(cfg, {
      enabled: false,
      includeEtf: false,
      maxCandidates: 20,
      globalDailyCap: 10,
      perStrategyDailyCap: 3,
      forceQuantity: 1,
      bracketRequired: true,
      entryOnlyBlocked: true,
      openOrderPositionGuard: true,
      duplicateGuardMinutes: 30,
      cryptoBlocked: true,
    });
  });

  await run('readFlag parses truthy and falsy strings deterministically', () => {
    assert.strictEqual(svc.readFlag('X', { X: 'true' }), true);
    assert.strictEqual(svc.readFlag('X', { X: '1' }), true);
    assert.strictEqual(svc.readFlag('X', { X: 'yes' }), true);
    assert.strictEqual(svc.readFlag('X', { X: 'on' }), true);
    assert.strictEqual(svc.readFlag('X', { X: 'false' }), false);
    assert.strictEqual(svc.readFlag('X', { X: 'no' }), false);
    assert.strictEqual(svc.readFlag('X', { X: '' }), false);
    assert.strictEqual(svc.readFlag('X', {}), false);
  });

  await run('IB_PAPER_MULTI_STRATEGY_TEST_MODE parsing is deterministic', () => {
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'true' }).enabled, true);
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'false' }).enabled, false);
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'maybe' }).enabled, false);
  });

  await run('IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF parsing is deterministic', () => {
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: 'true' }).includeEtf, true);
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: 'false' }).includeEtf, false);
    assert.strictEqual(svc.getIbPaperMultiStrategyConfig({ IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: 'maybe' }).includeEtf, false);
  });

  await run('limits view mirrors the config safely', () => {
    assert.deepEqual(svc.getIbPaperMultiStrategyLimits({ IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: 'true' }), {
      maxCandidates: 20,
      globalDailyCap: 10,
      perStrategyDailyCap: 3,
      forceQuantity: 1,
      bracketRequired: true,
      entryOnlyBlocked: true,
      openOrderPositionGuard: true,
      duplicateGuardMinutes: 30,
      includeEtf: true,
      cryptoBlocked: true,
    });
  });

  await run('module exports the symbols preview service requires', () => {
    assert.strictEqual(typeof svc.getIbPaperMultiStrategyConfig, 'function');
    assert.strictEqual(typeof svc.getIbPaperMultiStrategyLimits, 'function');
    assert.strictEqual(typeof svc.readFlag, 'function');
    assert.strictEqual(svc.MODE_FLAG, 'IB_PAPER_MULTI_STRATEGY_TEST_MODE');
    assert.strictEqual(svc.ETF_FLAG, 'IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF');
    assert.strictEqual(svc.SUBMIT_ROUTES_FLAG, 'IB_PAPER_SUBMIT_ROUTES_ENABLED');
  });

  await run('module stays read-only under env overrides', async () => {
    await withEnv({
      IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'true',
      IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: 'true',
      IB_PAPER_SUBMIT_ROUTES_ENABLED: 'true',
    }, () => {
      const cfg = svc.getIbPaperMultiStrategyConfig();
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.includeEtf, true);
      assert.strictEqual(cfg.cryptoBlocked, true);
    });
  });

  console.log(`\ninteractiveBrokersPaperMultiStrategyConfigService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
