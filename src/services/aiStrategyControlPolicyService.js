'use strict';

/**
 * AI Strategy Control Policy
 *
 * The AI may work independently with research strategies, test variants,
 * replay/batch/learning results and read-only strategy recommendations.
 * It must not touch Interactive Brokers, broker/order/risk/execution flows or
 * strategies that are approved for trade.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  affects_trading: false,
});

const PROTECTED_ROUTE_PREFIXES = Object.freeze([
  '/interactive-brokers',
  '/api/interactive-brokers',
]);

const PAPER_TRADING_ROUTE_PREFIXES = Object.freeze([
  '/paper-trading',
  '/api/paper-trading',
]);

const PROTECTED_AREA_LABELS = Object.freeze([
  '/interactive-brokers',
  'IB components',
  'IB services',
  'IB submit',
  'IB paper/manual execution',
  'broker settings',
  'order routes',
  'account routes',
  'approved trade strategies',
  'order/broker/risk',
]);

const ALLOWED_RESEARCH_AREAS = Object.freeze([
  '/ai',
  '/supervisor',
  '/overview',
  '/narrow',
  '/paper-trading read-only analysis',
  'lab',
  'replay',
  'batch tester',
  'learning engine',
  'strategy results',
  'system health',
]);

const REQUIRES_APPROVAL_ACTIONS = Object.freeze([
  'commit',
  'push',
  'pm2_restart',
  'merge',
  'deploy',
  'delete_files',
  'interactive_brokers_change',
  'trade_approved_strategy_change',
  'order_trade_broker_risk_change',
  'large_backend_flow_change',
  'new_automatic_scheduler_change',
]);

const TRADE_APPROVED_STATUSES = Object.freeze(new Set([
  'trade_approved',
  'approved_for_trade',
  'approved_for_trading',
  'live_approved',
  'broker_approved',
  'execution_approved',
  'trade-ready',
  'trade_ready',
]));

const TRADE_APPROVED_FLAGS = Object.freeze([
  'tradeApproved',
  'trade_approved',
  'approvedForTrade',
  'approved_for_trade',
  'approvedForTrading',
  'approved_for_trading',
  'liveApproved',
  'live_approved',
  'brokerApproved',
  'broker_approved',
  'executionApproved',
  'execution_approved',
  'canTrade',
  'can_trade',
]);

const PROTECTED_FILE_PATTERNS = Object.freeze([
  /(^|\/)client\/src\/pages\/InteractiveBrokersPage\.(jsx|tsx|js|ts)$/i,
  /(^|\/)client\/src\/components\/.*\b(InteractiveBrokers|IB[A-Z_-]?)/i,
  /(^|\/)src\/services\/interactiveBrokers/i,
  /(^|\/)src\/routes\/.*interactiveBrokers/i,
  /(^|\/)src\/.*(brokerSettings|orderRoutes|accountRoutes)/i,
]);

const BLOCKED_INTENT_PATTERNS = Object.freeze([
  /\binteractive[-_\s]?brokers\b/i,
  /\bib[-_\s]?(component|service|submit|paper|manual|execution)\b/i,
  /\bbroker\b/i,
  /\border[-_\s]?route\b/i,
  /\baccount[-_\s]?route\b/i,
  /\bsubmit[-_\s]?order\b/i,
  /\bplace[-_\s]?order\b/i,
  /\bexecution\b/i,
  /\bbuy\b/i,
  /\bsell\b/i,
  /\brisk[-_\s]?(setting|config|limit|change|auto)\b/i,
  /\blive[-_\s]?trading\b/i,
]);

const PAPER_TRADING_WRITE_PATTERNS = Object.freeze([
  /\bstart\b/i,
  /\bstop\b/i,
  /\bresume\b/i,
  /\bconfig\b/i,
  /\bmarket[-_\s]?config\b/i,
  /\brisk[-_\s]?review\b/i,
  /\bcreate[-_\s]?trade\b/i,
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function boolFlag(row, key) {
  if (!row || typeof row !== 'object') return false;
  return row[key] === true || String(row[key]).trim().toLowerCase() === 'true';
}

function includesTradeApprovedTag(value) {
  return asArray(value)
    .map(normalizeKey)
    .some((tag) => TRADE_APPROVED_STATUSES.has(tag));
}

function isTradeApprovedStrategy(strategy = {}) {
  if (!strategy || typeof strategy !== 'object') return false;

  for (const key of TRADE_APPROVED_FLAGS) {
    if (boolFlag(strategy, key)) return true;
  }

  const statusFields = [
    strategy.status,
    strategy.runtime_status,
    strategy.runtimeStatus,
    strategy.approval_status,
    strategy.approvalStatus,
    strategy.approval,
  ];

  if (statusFields.map(normalizeKey).some((value) => TRADE_APPROVED_STATUSES.has(value))) {
    return true;
  }

  return includesTradeApprovedTag(strategy.tags) ||
    includesTradeApprovedTag(strategy.permissions) ||
    includesTradeApprovedTag(strategy.approvals);
}

function pathLooksProtected(filePath) {
  const normalized = normalizeText(filePath).replace(/\\/g, '/');
  if (!normalized) return false;
  return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function routeLooksProtected(route) {
  const normalized = normalizeText(route).toLowerCase();
  if (!normalized) return false;
  return PROTECTED_ROUTE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function routeLooksPaperTrading(route) {
  const normalized = normalizeText(route).toLowerCase();
  if (!normalized) return false;
  return PAPER_TRADING_ROUTE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function blockedIntent(text) {
  const value = normalizeText(text);
  if (!value) return null;
  const hit = BLOCKED_INTENT_PATTERNS.find((pattern) => pattern.test(value));
  return hit ? hit.source : null;
}

function blockedPaperTradingIntent(text) {
  const value = normalizeText(text);
  if (!value) return null;
  const hit = PAPER_TRADING_WRITE_PATTERNS.find((pattern) => pattern.test(value));
  return hit ? hit.source : null;
}

function evaluateArea(input = {}) {
  const intentText = [
    input.area,
    input.feature,
    input.operation,
    input.intent,
    input.description,
  ].map(normalizeText).filter(Boolean).join(' ');

  const route = normalizeText(input.route || input.path || input.url);
  if (routeLooksProtected(route)) {
    return block('interactive_brokers_route', 'Interactive Brokers-sidan ar skyddad trade-zon.');
  }

  if (routeLooksPaperTrading(route) && blockedPaperTradingIntent(intentText)) {
    return block('paper_trading_read_only_only', 'Paper Trading far bara anvandas for read-only analys och testdiagnostik av AI.');
  }

  const filePath = normalizeText(input.filePath || input.file || input.modulePath);
  if (pathLooksProtected(filePath)) {
    return block('protected_ib_file', 'IB-komponenter och IB-services ar skyddad trade-zon.');
  }

  const intent = blockedIntent(intentText);
  if (intent) {
    return block('protected_trade_intent', 'Order, broker, execution, live trading och riskandring ar forbjudet omrade.');
  }

  return allow('research_area', 'AI far arbeta inom icke-trade research och read-only strategiutveckling.');
}

function block(reason, messageSv) {
  return {
    allowed: false,
    reason,
    message_sv: messageSv,
    risk_level: 'blockerad',
    affects_trading: false,
    safety: SAFETY,
  };
}

function allow(reason, messageSv, riskLevel = 'lag') {
  return {
    allowed: true,
    reason,
    message_sv: messageSv,
    risk_level: riskLevel,
    affects_trading: false,
    safety: SAFETY,
  };
}

function canAiWorkOnStrategy(strategy = {}, context = {}) {
  const area = evaluateArea(context);
  if (!area.allowed) return area;

  if (
    context.affectsTrading === true ||
    context.affects_trading === true ||
    context.can_place_orders === true ||
    context.actions_allowed === true ||
    context.live_trading_enabled === true ||
    context.broker_enabled === true ||
    context.can_modify_risk === true ||
    context.canModifyRisk === true
  ) {
    return block('trading_impact_requested', 'AI-rekommendationen stoppas eftersom den kan paverka trading, order, broker eller risk.');
  }

  if (isTradeApprovedStrategy(strategy)) {
    return block('trade_approved_strategy_protected', 'Strategin ar trade-godkand och far inte andras av AI utan separat beslut.');
  }

  return allow('non_trade_strategy_research', 'Strategin ar inte trade-godkand. AI far analysera, jamfora och foresla sakra teststeg.');
}

function normalizeRiskLevel(value, fallback = 'lag') {
  const raw = normalizeKey(value || fallback);
  if (raw === 'low' || raw === 'lag' || raw === 'låg') return 'lag';
  if (raw === 'medium' || raw === 'medel') return 'medel';
  if (raw === 'high' || raw === 'hog' || raw === 'hög') return 'hog';
  if (raw === 'blocked' || raw === 'blockerad') return 'blockerad';
  return fallback;
}

function firstText(items, fallback) {
  for (const item of asArray(items)) {
    const value = normalizeText(item);
    if (value) return value;
  }
  return fallback;
}

function buildRecommendationExplanation(input = {}) {
  const strategy = input.strategy || {};
  const decision = canAiWorkOnStrategy(strategy, input.context || {});
  const riskLevel = decision.allowed
    ? normalizeRiskLevel(input.riskLevel || input.risk_level || decision.risk_level, 'lag')
    : 'blockerad';

  return {
    allowed: decision.allowed,
    blocked_reason: decision.allowed ? null : decision.reason,
    vad_ai_sag: firstText(input.whatAiSaw || input.what_ai_saw, 'AI sag befintlig strategi- och testdata.'),
    varfor_det_spelar_roll: firstText(input.whyItMatters || input.why_it_matters, 'Det avgor om strategin behover mer testdata, battre forklaring eller lagre prioritet.'),
    vad_ai_vill_forbattra: firstText(input.improvement || input.what_to_improve, 'Forbattra strategiunderlag och forklaring utan att paverka trading.'),
    riskniva: riskLevel,
    paverkar_trading: 'nej',
    affects_trading: false,
    nasta_steg: decision.allowed
      ? firstText(input.nextStep || input.next_step, 'Fortsatt med read-only analys eller sakert testforslag.')
      : `Stoppa har: ${decision.message_sv}`,
    policy_reason: decision.reason,
    policy_message_sv: decision.message_sv,
  };
}

function requiresUserApproval(action) {
  const key = normalizeKey(action).replace(/[\s-]+/g, '_');
  return REQUIRES_APPROVAL_ACTIONS.includes(key);
}

function getPolicySummary() {
  return {
    ok: true,
    policy: 'ai_strategy_control_v1',
    goal_sv: 'AI ar systemets strategi- och systemforbattrare 24/7, men aldrig trade-, IB-, order-, broker- eller riskmotor.',
    allowed_research_areas: [...ALLOWED_RESEARCH_AREAS],
    protected_areas: [...PROTECTED_AREA_LABELS],
    requires_approval_actions: [...REQUIRES_APPROVAL_ACTIONS],
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  PROTECTED_ROUTE_PREFIXES,
  PROTECTED_AREA_LABELS,
  ALLOWED_RESEARCH_AREAS,
  REQUIRES_APPROVAL_ACTIONS,
  isTradeApprovedStrategy,
  evaluateArea,
  canAiWorkOnStrategy,
  buildRecommendationExplanation,
  requiresUserApproval,
  getPolicySummary,
};
