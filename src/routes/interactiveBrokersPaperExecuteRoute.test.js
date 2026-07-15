'use strict';

const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-route-'));
process.env.IB_PAPER_ONE_SHOT_DATA_DIR = path.join(tempRoot, 'one-shot');
process.env.IB_PAPER_ONE_SHOT_ARM_DATA_DIR = path.join(tempRoot, 'arm');
process.env.IB_PAPER_EXECUTION_DATA_DIR = path.join(tempRoot, 'execution');
process.env.DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Realmadrid25932593';

const paperTradingTruthService = require('../services/paperTradingTruthService');
const interactiveBrokersTradeBlueprintService = require('../services/interactiveBrokersTradeBlueprintService');
const interactiveBrokersPaperPreflightService = require('../services/interactiveBrokersPaperPreflightService');
const interactiveBrokersPaperProtectiveOrderService = require('../services/interactiveBrokersPaperProtectiveOrderService');
const interactiveBrokersPaperBracketSubmissionService = require('../services/interactiveBrokersPaperBracketSubmissionService');
const interactiveBrokersPaperOneShotExecutionService = require('../services/interactiveBrokersPaperOneShotExecutionService');
const interactiveBrokersPaperOneShotArmService = require('../services/interactiveBrokersPaperOneShotArmService');
const interactiveBrokersPaperFinalGateStatusService = require('../services/interactiveBrokersPaperFinalGateStatusService');

const selectedGooGlBlueprint = {
  blueprintId: 'bp-googl-narrow-breakout',
  candidateId: 'cand-googl-narrow-breakout',
  symbol: 'GOOGL',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  direction: 'short',
  side: 'SELL',
  quantity: 40,
  entryReferencePrice: 367.04,
  stopLoss: 367.41,
  takeProfit: 366.31,
  takeProfit2: 365.84,
  marketGroup: 'stock',
  account: 'DUQ565596',
  accountMode: 'ib_paper',
  stopLossPct: 0.1008,
  riskReward: 1.97,
  riskPct: 1.5,
  riskAmount: 500,
  blueprintReady: true,
  manualApprovalReady: true,
  executionReady: false,
  expiresAt: '2026-07-16T23:10:00.000Z',
};

const originalBuildPaperTradingTruth = paperTradingTruthService.buildPaperTradingTruth.bind(paperTradingTruthService);
paperTradingTruthService.buildPaperTradingTruth = async (...args) => {
  const truth = await originalBuildPaperTradingTruth(...args);
  const nextValidId = 101;
  return {
    ...truth,
    topStrategies: {
      ...(truth?.topStrategies || {}),
      topStrategies: [
        { rank: 1, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
      ],
    },
    readiness: {
      ...(truth?.readiness || {}),
      nextValidId,
      gatewayReachable: true,
      ibApiVerified: true,
      paperAccountVerified: true,
      paperModeVerified: true,
      sessionVerified: true,
      paperAccountId: 'DUQ565596',
      managedAccounts: ['DUQ565596'],
    },
    ibPaper: {
      ...(truth?.ibPaper || {}),
      connectionReadiness: {
        ...(truth?.ibPaper?.connectionReadiness || {}),
        source: 'live_connection_readiness',
        liveReadinessLoaded: true,
        staleTruthUsed: false,
        nextValidId,
        gatewayReachable: true,
        ibApiVerified: true,
        paperAccountVerified: true,
        paperModeVerified: true,
        sessionVerified: true,
        paperAccountId: 'DUQ565596',
        managedAccounts: ['DUQ565596'],
      },
      readiness: {
        ...(truth?.ibPaper?.readiness || {}),
        source: 'live_connection_readiness',
        liveReadinessLoaded: true,
        staleTruthUsed: false,
        nextValidId,
        gatewayReachable: true,
        ibApiVerified: true,
        paperAccountVerified: true,
        paperModeVerified: true,
        sessionVerified: true,
        paperAccountId: 'DUQ565596',
        managedAccounts: ['DUQ565596'],
      },
      executionStatus: {
        ...(truth?.ibPaper?.executionStatus || {}),
        readiness: {
          ...(truth?.ibPaper?.executionStatus?.readiness || {}),
          nextValidId,
        },
      },
    },
  };
};

interactiveBrokersTradeBlueprintService.getTradeBlueprint = async () => ({
  ok: true,
  ready: true,
  selectedBlueprint: selectedGooGlBlueprint,
  blueprints: [selectedGooGlBlueprint],
  source: 'test_fixture',
});

function authHeader() {
  return `Basic ${Buffer.from(`${process.env.DASHBOARD_USER}:${process.env.DASHBOARD_PASSWORD}`).toString('base64')}`;
}

function bodyFor(selectedBlueprint, extra = {}) {
  return {
    selectedBlueprint,
    blueprintId: selectedBlueprint?.blueprintId || null,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
    secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
    armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
    finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
    idempotencyKey: 'TEST-AUTH-E2E-3LEG-001',
    acknowledgePaperOnly: true,
    acknowledgeNoLiveTrading: true,
    acknowledgeOneOrderOnly: true,
    acknowledgeBracketOrder: true,
    acknowledgeNoRetry: true,
    manualUserInitiated: false,
    openRealSubmitGateForThisAttempt: false,
    ...extra,
  };
}

function jsonRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function authMiddleware(req, res, next) {
  return interactiveBrokersPaperOneShotArmService.requireDashboardAuth(req, res) ? next() : undefined;
}

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/interactive-brokers/truth', async (req, res) => {
    res.json(await paperTradingTruthService.buildPaperTradingTruth({ now: req.body?.now || req.query.now || undefined }));
  });

  app.get('/api/interactive-brokers/trade-blueprint', async (req, res) => {
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: req.query.now || undefined });
    res.json(await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: req.query.now || undefined,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
      topStrategies: truth?.topStrategies,
    }));
  });

  app.get('/api/interactive-brokers/paper-execute/arm-status', authMiddleware, async (req, res) => {
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: req.query.now || undefined });
    res.json(interactiveBrokersPaperOneShotArmService.getArmStatus({
      now: req.query.now || undefined,
      truth,
      executionStatus: truth?.ibPaper?.executionStatus || null,
      tradeBlueprint: truth?.ibPaper?.tradeBlueprint || null,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || null,
    }));
  });

  app.get('/api/interactive-brokers/paper-execute/final-gate-status', authMiddleware, async (req, res) => {
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: req.query.now || undefined });
    const executionStatus = truth?.ibPaper?.executionStatus || await paperTradingTruthService.buildExecutionStatus({ now: req.query.now || undefined });
    const tradeBlueprint = await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: req.query.now || undefined,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
      topStrategies: truth?.topStrategies,
    });
    const selectedBlueprint = tradeBlueprint?.selectedBlueprint || null;
    const preflight = interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
      now: req.query.now || undefined,
      blueprintId: selectedBlueprint?.blueprintId || null,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
      preflightOnly: true,
    });
    const protectivePreflight = interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
      now: req.query.now || undefined,
      blueprintId: selectedBlueprint?.blueprintId || null,
      selectedBlueprintId: selectedBlueprint?.blueprintId || null,
      selectedBlueprint,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    const bracketSubmissionPlan = interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPreflight({
      now: req.query.now || undefined,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
      selectedBlueprint,
      protectivePlan: protectivePreflight,
      nextValidId: truth?.ibPaper?.connectionReadiness?.nextValidId || executionStatus?.readiness?.nextValidId || null,
    });
    const armStatus = interactiveBrokersPaperOneShotArmService.getArmStatus({
      now: req.query.now || undefined,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    res.json(interactiveBrokersPaperFinalGateStatusService.buildFinalGateStatus({
      now: req.query.now || undefined,
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      preflight,
      protectivePreflight,
      bracketSubmissionPlan,
      armStatus,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    }));
  });

  app.post('/api/interactive-brokers/paper-execute/protective-preflight', authMiddleware, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: body.now || req.query.now || undefined });
    const executionStatus = truth?.ibPaper?.executionStatus || await paperTradingTruthService.buildExecutionStatus({ now: body.now || req.query.now || undefined });
    const readiness = truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined;
    const tradeBlueprint = await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: body.now || req.query.now || undefined,
      readiness,
      topStrategies: truth?.topStrategies,
    });
    const selectedBlueprint = body.selectedBlueprint || tradeBlueprint?.selectedBlueprint || null;
    res.json(interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
      now: body.now || req.query.now || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprint,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness,
    }));
  });

  app.post('/api/interactive-brokers/paper-execute/arm', authMiddleware, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: body.now || req.query.now || undefined });
    const executionStatus = truth?.ibPaper?.executionStatus || await paperTradingTruthService.buildExecutionStatus({ now: body.now || req.query.now || undefined });
    const tradeBlueprint = await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: body.now || req.query.now || undefined,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
      topStrategies: truth?.topStrategies,
    });
    const selectedBlueprint = body.selectedBlueprint || tradeBlueprint?.selectedBlueprint || null;
    const preflight = await interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
      now: body.now || req.query.now || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      confirmationPhrase: body.confirmationPhrase || '',
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    const protectivePlan = interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
      now: body.now || req.query.now || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprint,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    res.json(interactiveBrokersPaperOneShotArmService.armOneShot({
      now: body.now || req.query.now || undefined,
      body,
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      preflight,
      protectivePlan,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      idempotencyKey: body.idempotencyKey || '',
      ttlSeconds: body.ttlSeconds,
    }));
  });

  app.post('/api/interactive-brokers/paper-execute', authMiddleware, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const truth = await paperTradingTruthService.buildPaperTradingTruth({ now: body.now || req.query.now || undefined });
    const executionStatus = truth?.ibPaper?.executionStatus || await paperTradingTruthService.buildExecutionStatus({ now: body.now || req.query.now || undefined });
    const tradeBlueprint = await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: body.now || req.query.now || undefined,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
      topStrategies: truth?.topStrategies,
    });
    const selectedBlueprint = body.selectedBlueprint || tradeBlueprint?.selectedBlueprint || null;
    const armStatus = interactiveBrokersPaperOneShotArmService.getArmStatus({ now: body.now || req.query.now || undefined });
    const preflight = await interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
      now: body.now || req.query.now || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      confirmationPhrase: body.confirmationPhrase || body.confirmationText || '',
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    const protectivePlan = interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
      now: body.now || req.query.now || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      selectedBlueprint,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
    });
    const routeOptions = {
      now: body.now || req.query.now || undefined,
      body,
      simulateMockCalls: body.testHarnessSimulateMockCalls === true,
      truth,
      executionStatus,
      tradeBlueprint,
      selectedBlueprint,
      readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
      blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
      confirmationPhrase: body.confirmationPhrase || body.confirmationText || '',
      secondConfirmationPhrase: body.secondConfirmationPhrase || '',
      idempotencyKey: body.idempotencyKey || '',
      executionCommand: body.finalExecutionCommand || body.executionCommand || body.orderCommand || '',
      finalPhaseEnabled: body.finalPhase === '4G-2D' || body.finalPhaseEnabled === true,
      armStatus,
      preflight,
      protectivePlan: body.testHarnessProtectivePlan || {
        ...protectivePlan,
        protectiveExecutionReady: body.testHarnessProtectiveExecutionReady === true ? true : protectivePlan.protectiveExecutionReady,
      },
      bracketSubmissionPlan: body.testHarnessBracketSubmissionPlan || undefined,
    };
    res.json(await interactiveBrokersPaperOneShotExecutionService.buildPaperOneShotExecution(routeOptions));
  });

  return app;
}

async function main() {
  const app = buildApp();
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: authHeader(),
    'content-type': 'application/json',
  };

  try {
    const truthRes = await fetch(`${baseUrl}/api/interactive-brokers/truth`);
    assert.equal(truthRes.status, 200);

    const noAuthRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor(null)),
    });
    assert.equal(noAuthRes.status, 401);
    assert.equal(await noAuthRes.text(), 'Autentisering krävs');

    const blueprintRes = await fetch(`${baseUrl}/api/interactive-brokers/trade-blueprint`);
    const blueprintJson = await blueprintRes.json();
    const selectedBlueprint = blueprintJson.previewBlueprint || blueprintJson.selectedBlueprint || blueprintJson.blueprints?.[0] || selectedGooGlBlueprint;
    assert.ok(selectedBlueprint?.blueprintId, 'selected blueprint exists');

    const unauthProtectiveRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/protective-preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor(selectedBlueprint)),
    });
    assert.equal(unauthProtectiveRes.status, 401);

    const protectiveRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/protective-preflight`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint)),
    });
    const protectiveJson = await protectiveRes.json();
    assert.equal(protectiveRes.status, 200);
    assert.equal(protectiveJson.accepted, true);
    assert.equal(protectiveJson.orderSent, false);
    assert.equal(protectiveJson.executed, false);
    assert.equal(protectiveJson.readinessVerification.source, 'live_connection_readiness');
    assert.equal(protectiveJson.helperReady, true);
    assert.equal(protectiveJson.bracketOrderCount, 3);
    assert.equal(protectiveJson.entryOnlyBlocked, true);
    assert.equal(protectiveJson.accountId, 'DUQ565596');

    const noArmExecRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-000',
      })),
    });
    const noArmExec = await noArmExecRes.json();
    assert.equal(noArmExecRes.status, 200);
    assert.equal(noArmExec.accepted, false);
    assert.equal(typeof noArmExec.helperReady, 'boolean');
    assert.equal(noArmExec.entryOnlyBlocked, true);
    assert.equal(noArmExec.orderSent, false);
    assert.equal(noArmExec.executed, false);
    assert.equal(noArmExec.realSubmitForThisAttempt, false);

    const armRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/arm`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint)),
    });
    const armJson = await armRes.json();
    assert.equal(armRes.status, 200);
    assert.equal(typeof armJson.armed, 'boolean');
    assert.equal(armJson.orderSent, false);
    assert.equal(armJson.executed, false);

    const finalGateRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/final-gate-status`, {
      method: 'GET',
      headers,
    });
    const finalGateJson = await finalGateRes.json();
    assert.equal(finalGateRes.status, 200);
    assert.equal(finalGateJson.ok, true);
    assert.equal(finalGateJson.orderSent, false);
    assert.equal(finalGateJson.executed, false);
    assert.equal(finalGateJson.submitReady, false);
    assert.equal(finalGateJson.canArm, false);
    assert.equal(finalGateJson.realSubmitGate?.gateOpensRealSubmit, false);
    assert.equal(finalGateJson.oneShotArm?.status, 'armed');
    assert.equal(finalGateJson.openOrders?.readOnly, true);
    assert.equal(finalGateJson.positions?.readOnly, true);
    assert.equal(finalGateJson.openOrders?.checked, true);
    assert.equal(finalGateJson.positions?.checked, true);

    const manualMissingExecRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-001',
        finalPhase: '4G-2D',
        openRealSubmitGateForThisAttempt: true,
      })),
    });
    const manualMissingExec = await manualMissingExecRes.json();
    assert.equal(manualMissingExecRes.status, 200);
    assert.equal(manualMissingExec.accepted, false);
    assert.equal(typeof manualMissingExec.helperReady, 'boolean');
    assert.equal(typeof manualMissingExec.bracketSubmissionPlanReady, 'boolean');
    assert.equal(typeof manualMissingExec.bracketOrderCount, 'number');
    assert.equal(typeof manualMissingExec.entryOnlyBlocked, 'boolean');
    assert.equal(typeof manualMissingExec.runtimeBracketSubmitUnlocked, 'boolean');
    assert.equal(typeof manualMissingExec.realSubmitGate?.gateReady, 'boolean');
    assert.equal(typeof manualMissingExec.realSubmitGate?.gateOpensRealSubmit, 'boolean');
    assert.equal(typeof manualMissingExec.realSubmitForThisAttempt, 'boolean');
    assert.equal(manualMissingExec.orderSent, false);
    assert.equal(manualMissingExec.executed, false);
    assert.equal(typeof manualMissingExec.blockedReason, 'string');

    const armRes2 = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/arm`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-002',
      })),
    });
    const armJson2 = await armRes2.json();
    assert.equal(armRes2.status, 200);
    assert.equal(armJson2.armed, true);

    const armedLiveExecRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-002',
        manualUserInitiated: true,
        finalPhase: '4G-2D',
        openRealSubmitGateForThisAttempt: true,
        testHarnessSimulateMockCalls: true,
      })),
    });
    const armedLiveExec = await armedLiveExecRes.json();
    assert.equal(armedLiveExecRes.status, 200);
    assert.equal(armedLiveExec.accepted, true);
    assert.equal(armedLiveExec.helperReady, true);
    assert.equal(armedLiveExec.bracketSubmissionPlanReady, true);
    assert.equal(armedLiveExec.bracketOrderCount, 3);
    assert.equal(armedLiveExec.entryOnlyBlocked, true);
    assert.equal(armedLiveExec.runtimeBracketSubmitUnlocked, true);
    assert.equal(armedLiveExec.realSubmitForThisAttempt, true);
    assert.equal(armedLiveExec.bracketSubmissionRealSubmitEnabled, false);
    assert.equal(armedLiveExec.explicitRealSubmitGate, true);
    assert.equal(armedLiveExec.realSubmitGate.gateReady, true);
    assert.equal(armedLiveExec.realSubmitGate.gateOpensRealSubmit, true);
    assert.equal(armedLiveExec.realSubmitGate.requiresFinalPhase, '4G-2D');
    assert.equal(armedLiveExec.orderSent, false);
    assert.equal(armedLiveExec.executed, false);
    assert.equal(armedLiveExec.blockedReason, null);
    assert.equal(armedLiveExec.orderButtonLocked, true);

    const armRes3 = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/arm`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-002',
      })),
    });
    const armJson3 = await armRes3.json();
    assert.equal(armRes3.status, 200);
    assert.equal(armJson3.armed, false);
    assert.equal(armJson3.orderSent, false);
    assert.equal(armJson3.executed, false);
    assert.equal(armJson3.blockedReason, 'duplicate_order_request');

    const armStatusAfter = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/arm-status`, {
      method: 'GET',
      headers,
    });
    const armStatusJsonAfter = await armStatusAfter.json();
    assert.equal(armStatusAfter.status, 200);
    assert.equal(armStatusJsonAfter.armed, false);
    assert.equal(armStatusJsonAfter.used, true);

    const routeHelperCalls = [];
    const helperResult = await interactiveBrokersPaperBracketSubmissionService.submitBracketOrderGroup({
      submissionPlan: armedLiveExec.bracketSubmissionPlan?.submissionPlan || armedLiveExec.bracketSubmissionPlan,
      contract: armedLiveExec.bracketSubmissionPlan?.submissionPlan?.contract || armedLiveExec.bracketSubmissionPlan?.contract,
      selectedBlueprint,
      direction: selectedBlueprint?.direction,
      executionAttemptId: 'TEST-AUTH-E2E-3LEG-001-ATTEMPT',
      idempotencyKey: 'TEST-AUTH-E2E-3LEG-001',
      accountMode: 'ib_paper',
      mockOnly: true,
      dryRun: true,
      simulateMockCalls: true,
      ibClient: {
        placeOrder(orderId, contract, order) {
          routeHelperCalls.push({
            orderId,
            contract,
            order,
          });
        },
      },
    });
    assert.equal(helperResult.helperReady, true);
    assert.equal(helperResult.mockPlaceOrderCalls.length, 3);
    assert.deepEqual(helperResult.mockPlaceOrderCalls.map((row) => row.role), ['entry', 'take_profit', 'stop_loss']);
    assert.deepEqual(helperResult.mockPlaceOrderCalls.map((row) => row.transmit), [false, false, true]);
    assert.deepEqual(helperResult.mockPlaceOrderCalls.map((row) => row.parentId), [null, 101, 101]);
    assert.deepEqual(helperResult.mockPlaceOrderCalls.map((row) => row.action), ['SELL', 'BUY', 'BUY']);
    assert.equal(routeHelperCalls.length, 0);
    assert.deepEqual(helperResult.mockPlaceOrderCalls.map((row) => row.orderId), [101, 102, 103]);

    const wrongCommandRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        finalExecutionCommand: 'WRONG COMMAND',
        testHarnessProtectiveExecutionReady: true,
        testHarnessSimulateMockCalls: true,
      })),
    });
    const wrongCommand = await wrongCommandRes.json();
    assert.equal(wrongCommand.orderSent, false);
    assert.equal(wrongCommand.executed, false);

    const entryOnlyPlan = {
      orderCount: 1,
      entryOnlyBlocked: true,
      accountMode: 'ib_paper',
      direction: 'short',
      side: 'SELL',
      quantity: 40,
      contract: armedLiveExec.bracketSubmissionPlan?.submissionPlan?.contract || armedLiveExec.bracketSubmissionPlan?.contract || null,
      entry: {
        role: 'entry',
        orderId: 1,
        parentId: null,
        action: 'SELL',
        orderType: 'LMT',
        quantity: 40,
        transmit: false,
        lmtPrice: 367.04,
        contract: armedLiveExec.bracketSubmissionPlan?.submissionPlan?.contract || armedLiveExec.bracketSubmissionPlan?.contract || null,
      },
      stopLoss: {
        role: 'stop_loss',
        orderId: 2,
        parentId: 1,
        action: 'BUY',
        orderType: 'STP',
        quantity: 40,
        transmit: false,
        auxPrice: 367.41,
        contract: armedLiveExec.bracketSubmissionPlan?.submissionPlan?.contract || armedLiveExec.bracketSubmissionPlan?.contract || null,
      },
      takeProfit: {
        role: 'take_profit',
        orderId: 3,
        parentId: 1,
        action: 'BUY',
        orderType: 'LMT',
        quantity: 40,
        transmit: true,
        lmtPrice: 366.31,
        contract: armedLiveExec.bracketSubmissionPlan?.submissionPlan?.contract || armedLiveExec.bracketSubmissionPlan?.contract || null,
      },
      orderIds: [1, 2, 3],
      transmitSequence: ['entry:false'],
    };
    const entryOnlyRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(selectedBlueprint, {
        testHarnessProtectiveExecutionReady: true,
        testHarnessBracketSubmissionPlan: entryOnlyPlan,
        testHarnessSimulateMockCalls: true,
        idempotencyKey: 'TEST-AUTH-E2E-3LEG-002',
      })),
    });
    const entryOnly = await entryOnlyRes.json();
    assert.equal(entryOnly.orderSent, false);
    assert.equal(entryOnly.executed, false);
    assert.equal(typeof entryOnly.blockedReason, 'string');

    const unauthArmRes = await fetch(`${baseUrl}/api/interactive-brokers/paper-execute/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor(selectedBlueprint)),
    });
    assert.equal(unauthArmRes.status, 401);

    console.log('interactiveBrokersPaperExecuteRoute.test.js: OK');
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
