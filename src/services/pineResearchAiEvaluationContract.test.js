'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPineResearchStore } = require('./pineResearchStoreService');
const loop = require('./pineResearchLoopService');
const aiEvaluation = require('./pineResearchAiEvaluationService');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pine-research-ai-contract-'));
}

function validPayload(overrides = {}) {
  return {
    verdict: 'insufficient_data',
    score: 0,
    strengths: [],
    weaknesses: ['No internal performance test exists yet.'],
    dataQualityWarnings: ['Static validation only.'],
    overfitWarnings: [],
    recommendedChanges: [],
    nextAction: 'run_more_tests',
    confidence: 0.2,
    ...overrides,
  };
}

async function runWithPayload(payload, { wrap = false, asText = true } = {}) {
  const root = tempDir();
  const store = createPineResearchStore({ rootDir: root });
  const pilot = loop.ensureOrbPilot(store);
  const version = pilot.versions.find((item) => item.pineVersionId === 'opening_range_breakout_v1_baseline');
  const responsePayload = wrap ? { AIEvaluation: payload } : payload;
  try {
    const result = await aiEvaluation.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerCall: async () => (asText ? JSON.stringify(responsePayload) : responsePayload),
    });
    return { result, store, root };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

async function assertInvalid(payload, expectedStatus = 'provider_response_invalid', options = {}) {
  const { result, store, root } = await runWithPayload(payload, options);
  try {
    assert.equal(result.ok, false);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.schemaValid, false);
    assert.equal(store.list('evaluations').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  {
    const { result, store, root } = await runWithPayload(validPayload());
    try {
      assert.equal(result.ok, true);
      assert.equal(result.status, 'ok');
      assert.equal(result.evaluation.verdict, 'insufficient_data');
      assert.equal(result.evaluation.nextAction, 'run_more_tests');
      assert.equal(store.list('evaluations').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const { result, store, root } = await runWithPayload(validPayload({ verdict: 'hold_for_review', nextAction: 'hold_for_review' }), { wrap: true });
    try {
      assert.equal(result.ok, true);
      assert.equal(result.evaluation.verdict, 'hold_for_review');
      assert.equal(store.list('evaluations').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  await assertInvalid({ Evaluation: validPayload() });
  await assertInvalid({ ...validPayload(), confidence: undefined });
  await assertInvalid({ ...validPayload(), strengths: 'good' });
  await assertInvalid({ ...validPayload(), nextAction: 'activate_paper_trading' });
  await assertInvalid({ ...validPayload(), confidence: 1.2 });
  await assertInvalid({
    ...validPayload(),
    recommendedChanges: [{ field: 'approvalStatus', operation: 'set', value: 'READY', reason: 'unsafe' }],
  });
  await assertInvalid({ ...validPayload(), winRate: 99 });

  {
    const root = tempDir();
    const store = createPineResearchStore({ rootDir: root });
    const pilot = loop.ensureOrbPilot(store);
    const version = pilot.versions.find((item) => item.pineVersionId === 'opening_range_breakout_v1_baseline');
    try {
      const result = await aiEvaluation.runEvaluation({
        store,
        pineVersionId: version.pineVersionId,
        providerCall: async () => `\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\``,
      });
      assert.equal(result.ok, true);
      assert.equal(store.list('evaluations').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = tempDir();
    const store = createPineResearchStore({ rootDir: root });
    const pilot = loop.ensureOrbPilot(store);
    const version = pilot.versions.find((item) => item.pineVersionId === 'opening_range_breakout_v1_baseline');
    try {
      const result = await aiEvaluation.runEvaluation({
        store,
        pineVersionId: version.pineVersionId,
        providerCall: async () => `Here is the JSON: ${JSON.stringify(validPayload())}`,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'provider_response_invalid');
      assert.equal(store.list('evaluations').length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => console.log('pineResearchAiEvaluationContract.test.js passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
