'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const model = fs.readFileSync(path.join(root, 'models', 'decisionModel.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'stores', 'decisionStore.js'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'domain', 'DecisionDomain.js'), 'utf8');
const explanation = fs.readFileSync(path.join(root, 'domain', 'DecisionExplanation.js'), 'utf8');

for (const field of [
  'decisionId',
  'eventId',
  'strategyId',
  'candidateId',
  'orderId',
  'positionId',
  'tradeId',
  'timestamp',
  'decisionType',
  'decisionSource',
  'decisionState',
  'confidence',
  'severity',
  'priority',
  'metadata',
  'summary',
  'description',
  'reason',
  'evidence',
  'recommendedAction',
  'alternativeActions',
  'blockedBy',
  'approvedBy',
  'createdBy',
  'source',
  'status',
]) {
  assert.match(model, new RegExp(field), `DecisionModel exposes ${field}`);
}

for (const type of [
  'AIRecommendation',
  'SupervisorApproval',
  'SupervisorReject',
  'RiskApproval',
  'RiskReject',
  'RiskPause',
  'RiskResume',
  'EntryDecision',
  'ExitDecision',
  'PositionManagement',
  'StopMove',
  'TargetMove',
  'BreakEvenMove',
  'ScaleOut',
  'ScaleIn',
  'CancelOrder',
  'OrderRetry',
  'ExecutionDecision',
  'LearningRecommendation',
  'ReplayDecision',
  'AlertDecision',
  'NotificationDecision',
  'HealthDecision',
]) {
  assert.match(model, new RegExp(type), `DecisionModel supports ${type}`);
}

for (const source of [model, store, domain, explanation]) {
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'decision architecture files do not fetch');
  assert.doesNotMatch(source, /\baxios\b/, 'decision architecture files do not use axios');
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b/, 'decision architecture files do not persist browser state');
  assert.doesNotMatch(source, /\bwindow\b|\bdocument\b/, 'decision architecture files do not use browser globals');
}

assert.match(store, /createTradingEventStore/, 'DecisionStore reuses TradingEventStore');
for (const selector of [
  'normalizeDecision',
  'mergeDecision',
  'resolveDecision',
  'getDecision',
  'getLatestDecision',
  'getLatestDecisionByStrategy',
  'getLatestDecisionByTrade',
  'getLatestDecisionByPosition',
  'getLatestDecisionByOrder',
  'getLatestDecisionByCandidate',
  'getDecisions',
  'getDecisionTimeline',
  'getBlockedDecisions',
  'getApprovedDecisions',
  'getRejectedDecisions',
  'getLearningDecisions',
  'getReplayDecisions',
]) {
  assert.match(store, new RegExp(selector), `DecisionStore exposes ${selector}`);
}

for (const fn of [
  'decisionLabel',
  'decisionDescription',
  'decisionSummary',
  'decisionSeverity',
  'decisionConfidence',
  'decisionPriority',
  'decisionColor',
  'decisionIcon',
  'decisionCategory',
  'decisionStatus',
  'isBlocked',
  'isApproved',
  'isRejected',
  'isPending',
  'isCritical',
  'recommendedAction',
  'alternativeActions',
  'decisionTimeline',
  'groupByTrade',
  'groupByStrategy',
  'groupBySession',
  'groupByMarket',
]) {
  assert.match(domain, new RegExp(`export function ${fn}`), `DecisionDomain exposes ${fn}`);
}

for (const helper of [
  'DecisionExplanation',
  'DecisionEvidence',
  'DecisionReason',
  'DecisionConfidence',
  'DecisionPriority',
  'DecisionSeverity',
  'DecisionRecommendation',
  'DecisionAlternatives',
  'DecisionHistory',
]) {
  assert.match(explanation, new RegExp(`export function ${helper}`), `DecisionExplanation exposes ${helper}`);
}

for (const component of [
  'DecisionCard.jsx',
  'DecisionTimeline.jsx',
  'DecisionInspector.jsx',
  'DecisionHistory.jsx',
  'DecisionBadge.jsx',
  'DecisionPanel.jsx',
  'DecisionSummary.jsx',
  'DecisionEvidencePanel.jsx',
  'DecisionRecommendationPanel.jsx',
  'DecisionMetadataPanel.jsx',
]) {
  const componentSource = fs.readFileSync(path.join(root, 'components', 'trading', component), 'utf8');
  assert.match(componentSource, /React\.memo/, `${component} is memoized`);
  assert.doesNotMatch(componentSource, /createDecisionStore|normalizeDecision|getDecisions\(/, `${component} does not own store or normalization logic`);
}

for (const page of [
  'FuturesPaperDeskPage.jsx',
  'PaperTradingPage.jsx',
  'InteractiveBrokersPage.jsx',
  'AiControlRoomPage.jsx',
  'SupervisorBrainPage.jsx',
  'SupervisorV2Page.jsx',
  'TradingLabPage.jsx',
  'ReplayPage.jsx',
]) {
  const source = fs.readFileSync(path.join(root, 'pages', page), 'utf8');
  assert.match(source, /createDecisionStore/, `${page} consumes DecisionStore`);
}
