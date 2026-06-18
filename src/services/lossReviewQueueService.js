'use strict';

const fs = require('fs');
const path = require('path');

const paperTradeExplanationService = require('./paperTradeExplanationService');
const entryQualityGateService = require('./entryQualityGateService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const ISSUE_PRIORITY = [
  'late_entry',
  'missing_2m_confirmation',
  'stop_loss_hit',
  'choppy_market',
  'low_mfe_direct_adverse',
  'missing_logging_fields',
  'unknown',
];

function nowIso() {
  return new Date().toISOString();
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function iso(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function normalizeTrade(row = {}) {
  const raw = row || {};
  const openedAt = iso(raw.openedAt || raw.opened_at || raw.entryTime || raw.entry_time || raw.timestamp || null);
  const closedAt = iso(raw.closedAt || raw.closed_at || raw.exitTime || raw.exit_time || null);
  const tradeStats = {
    mfePct: num(raw.mfePct ?? raw.maxFavorablePct ?? raw.max_favorable_pct ?? null),
    maePct: num(raw.maePct ?? raw.maxAdversePct ?? raw.max_adverse_pct ?? null),
    stopLoss: num(raw.stopLoss ?? raw.stop_loss ?? raw.stopPct ?? raw.stop_pct ?? null),
    takeProfit: num(raw.takeProfit ?? raw.take_profit ?? raw.targetPct ?? raw.target_pct ?? null),
  };

  return {
    tradeId: text(raw.tradeId || raw.id || raw.signalId || null),
    symbol: text(raw.symbol, null),
    strategyId: text(
      raw.strategyId
      || raw.strategy_id
      || raw.canonicalStrategyId
      || raw.canonical_strategy_id
      || raw.resolvedStrategyId
      || raw.resolved_strategy_id
      || raw.sourceStrategyId
      || raw.source_strategy_id
      || raw.raw_strategy
      || raw.setup
      || raw.signalSubtype
      || raw.signalFamily
      || null,
      null,
    ),
    setup: text(raw.setup || raw.signalSubtype || raw.signalFamily || null, null),
    result: text(raw.result || raw.outcome || null, 'unknown').toUpperCase(),
    pnlPct: num(raw.pnlPct ?? raw.pnl_pct ?? raw.pnl),
    openedAt,
    closedAt,
    paperOnly: raw.paperOnly === true || raw.paper_only === true,
    statusAtEntry: text(raw.statusAtEntry || raw.runtime_status || raw.runtimeStatus || null, 'unknown'),
    bias: text(raw.nextMoveBias || raw.bias || raw.direction || null, 'unknown'),
    confidenceScore: num(raw.confidenceScore ?? raw.gateScore ?? null),
    tradeStats,
    raw,
  };
}

function isClosedTrade(row = {}) {
  const result = text(row.result || row.outcome || null, 'OPEN').toUpperCase();
  if (result === 'OPEN') return false;
  return Boolean(row.closed_at || row.closedAt || row.exitTime || row.exit_time || row.result || row.outcome);
}

function clampLimit(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(1000, Math.round(n)));
}

function isStopRelated(reasonText, exitTypeText) {
  const value = `${reasonText || ''} ${exitTypeText || ''}`.toLowerCase();
  return /stop_hit|stop_loss|trailing_stop|tightened_stop|break_even|breakeven|stop/.test(value);
}

function pickPrimaryIssue(tags) {
  const set = new Set(tags || []);
  for (const issueType of ISSUE_PRIORITY) {
    if (set.has(issueType)) return issueType;
  }
  return 'unknown';
}

function labelForIssue(issueType) {
  switch (issueType) {
    case 'late_entry': return 'Sen entry';
    case 'missing_2m_confirmation': return 'Saknar 2m-bekräftelse';
    case 'stop_loss_hit': return 'Stop loss träffad';
    case 'choppy_market': return 'Choppy marknad';
    case 'low_mfe_direct_adverse': return 'Låg MFE, snabb motrörelse';
    case 'missing_logging_fields': return 'Saknade loggfält';
    default: return 'Okänt mönster';
  }
}

function diagnosisForIssue(issueType, group) {
  switch (issueType) {
    case 'late_entry':
      return `Flera losses tyder på att entry tas sent efter en redan utdragen rörelse. (${group.count} lossar i denna grupp.)`;
    case 'missing_2m_confirmation':
      return 'Losses återkommer när caution-läge inte följs av ny 2m-bekräftelse.';
    case 'stop_loss_hit':
      return group.avgMfePct != null && group.avgMfePct > 0
        ? 'Traden hade positiv rörelse före exit, så tidigare exit eller trailing är rimligare att testa än bara bredare stop.'
        : 'Losses ser ut att bero mer på entry eller marknad än på en ensam stop-profil.';
    case 'choppy_market':
      return 'Losses samlas i en ryckig eller brusig miljö där filter och timing behöver testas separat.';
    case 'low_mfe_direct_adverse':
      return 'Traden fick nästan ingen positiv rörelse innan den gick snabbt emot. Entry-filter är sannolikt viktigare än bredare stop.';
    case 'missing_logging_fields':
      return 'Kritiska loggfält saknas, så analysen behöver bättre observability innan säkra slutsatser går att dra.';
    default:
      return 'Mönstret är för svagt eller för blandat för en specifik slutsats.';
  }
}

function recommendationForGroup(issueType, group) {
  const baseVariant = {
    late_entry: 'regular_pullback_late_entry_filter_v1',
    missing_2m_confirmation: 'regular_pullback_two_minute_confirmation_v1',
    stop_loss_hit: 'regular_pullback_stop_profile_review_v1',
    choppy_market: 'regular_pullback_choppy_market_filter_v1',
    low_mfe_direct_adverse: 'regular_pullback_entry_filter_first_v1',
    missing_logging_fields: 'paper_trading_logging_enrichment_v1',
    unknown: 'paper_loss_manual_review_v1',
  }[issueType] || 'paper_loss_manual_review_v1';

  const descriptions = {
    late_entry: 'Kör replay där REGULAR_PULLBACK kräver pullback eller ny 2m-bekräftelse när statusAtEntry=caution. Sänk confidence vid extended move, men ändra inte runtime ännu.',
    missing_2m_confirmation: 'Testa en striktare 2m-regel: om statusAtEntry=caution och entryReason nämner 2m-bekräftelse, krävs ny 2m-signal innan entry.',
    stop_loss_hit: group.avgMfePct != null && group.avgMfePct > 0
      ? 'Testa trailing eller tidigare exit i replay. Bredare stop ska inte införas utan separat evidence, eftersom drawdown kan öka.'
      : 'Testa först entry-filter innan någon bredare stop övervägs. Om MFE nästan saknas är entry eller marknad oftare roten till problemet.',
    choppy_market: 'Testa choppy-filter. Sänk confidence eller blockera REGULAR_PULLBACK i ryckig miljö, och komplettera med logging om candle/regime-data saknas.',
    low_mfe_direct_adverse: 'Testa entry-filter först. När MFE är nära noll och priset snabbt går emot hjälper bredare stop normalt mindre än bättre entry.',
    missing_logging_fields: 'Förbättra loggningen för entryReason, exitReasonCode, exitSource, stopLoss, takeProfit, mfePct, maePct och candle/regime metadata.',
    unknown: 'Kör en manuell replay-review av gruppen och samla mer data innan någon ändring föreslås.',
  };

  const changes = {
    late_entry: [
      'Sänk confidence vid extended move',
      'Kräv ny 2m-confirmation vid caution',
      'Blockera inte runtime ännu; testa endast i replay/paper',
    ],
    missing_2m_confirmation: [
      'Kräv ny 2m-confirmation vid caution',
      'Testa på samma setup utan att ändra runtime',
      'Jämför mot nuvarande baseline i replay',
    ],
    stop_loss_hit: group.avgMfePct != null && group.avgMfePct > 0
      ? [
        'Testa trailing stop',
        'Testa tidigare exit vid snabb MFE-falloff',
        'Håll stop-profilen oförändrad i runtime tills test är klar',
      ]
      : [
        'Testa entry-filter först',
        'Undvik att bara bredda stop utan data',
        'Håll runtime oförändrad',
      ],
    choppy_market: [
      'Sänk confidence eller blockera i choppy miljö',
      'Testa filtrering på volatilitet och event-densitet',
      'Lägg till logging om marknadsdata saknas',
    ],
    low_mfe_direct_adverse: [
      'Testa striktare entry-filter',
      'Sänk confidence vid snabb motrörelse',
      'Låt stop-regler vara oförändrade tills replay visar annat',
    ],
    missing_logging_fields: [
      'Logga entryReason, exitReasonCode, exitSource',
      'Logga stopLoss, takeProfit, mfePct och maePct',
      'Lägg till candle/regime metadata för bättre analys',
    ],
    unknown: [
      'Granska gruppen manuellt',
      'Samla mer historik innan test',
      'Undvik automatisk ändring',
    ],
  }[issueType] || ['Granska gruppen manuellt'];

  return {
    type: issueType === 'missing_logging_fields' ? 'logging_improvement' : 'replay_test',
    title: {
      late_entry: 'Testa late-entry filter',
      missing_2m_confirmation: 'Testa 2m-confirmation',
      stop_loss_hit: group.avgMfePct != null && group.avgMfePct > 0
        ? 'Testa trailing/earlier-exit'
        : 'Testa entry-filter före bredare stop',
      choppy_market: 'Testa choppy-market filter',
      low_mfe_direct_adverse: 'Testa entry-filter först',
      missing_logging_fields: 'Förbättra loggning',
      unknown: 'Manuell replay-review',
    }[issueType] || 'Manuell replay-review',
    description: descriptions[issueType] || descriptions.unknown,
    safeActionOnly: true,
    proposedVariant: {
      name: baseVariant,
      changes,
    },
  };
}

function buildGroupPreview(group) {
  const recommendation = recommendationForGroup(group.issueType, group);
  return {
    testType: 'replay',
    source: 'loss_review_queue',
    strategyId: group.strategyId || null,
    setup: group.setup || null,
    issueType: group.issueType,
    variantId: recommendation.proposedVariant.name,
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
    safety_note: 'paper_only preview; original strategy is unchanged',
    reason: recommendation.description,
    proposedVariant: recommendation.proposedVariant,
    recommendation,
    queue_item: {
      strategy_id: group.strategyId || '',
      test_type: 'replay',
      source: 'loss_review_queue',
      priority: group.count,
      reason: recommendation.description,
      suggested_scope: `${group.strategyId || 'unknown'} · ${group.setup || 'unknown'} · ${group.issueType}`,
      expected_learning_value: recommendation.proposedVariant.changes.join(' / '),
      safety_note: 'paper_only; original strategy unchanged',
      mode: 'paper_only',
    },
  };
}

function aggregateLosses(losses, tradeContexts) {
  const groups = new Map();
  const issueCounts = new Map();
  const strategyCounts = new Map();
  const missingFields = new Set();

  for (const context of tradeContexts) {
    const { trade, explanation, entryQualityGate, lookupFound } = context;
    const gate = entryQualityGate || {};
    const tradeStats = trade.tradeStats || {};
    const exitReason = text(trade.raw?.exitReason || trade.raw?.exitReasonCode || explanation?.exit?.reason || explanation?.exit?.exitType || null, '');
    const stopHit = isStopRelated(exitReason, explanation?.exit?.exitType);
    const mfePct = num(tradeStats.mfePct ?? explanation?.tradeStats?.mfePct ?? null);
    const maePct = num(tradeStats.maePct ?? explanation?.tradeStats?.maePct ?? null);
    const directAdverse = Number.isFinite(mfePct) && Math.abs(mfePct) <= 0.02 && Number.isFinite(maePct) && maePct < 0;
    const gateMissing = Array.isArray(gate.missingFields) ? gate.missingFields : [];
    const issueTags = unique([
      gate?.checks?.lateEntry?.status === 'warn' ? 'late_entry' : null,
      gate?.checks?.twoMinuteConfirmation?.status === 'warn' ? 'missing_2m_confirmation' : null,
      gate?.checks?.stopFit?.status === 'warn' || stopHit ? 'stop_loss_hit' : null,
      gate?.checks?.choppyMarket?.status === 'warn' ? 'choppy_market' : null,
      directAdverse ? 'low_mfe_direct_adverse' : null,
      gateMissing.length ? 'missing_logging_fields' : null,
      !lookupFound && !explanation ? 'missing_logging_fields' : null,
    ]);
    const issueType = pickPrimaryIssue(issueTags);
    const groupKey = `${issueType}:${trade.strategyId || 'unknown'}:${trade.setup || 'unknown'}`;

    missingFieldsForTrade(gateMissing, missingFields);
    const bias = trade.bias || explanation?.entry?.bias || explanation?.entry?.nextMoveBias || 'unknown';
    const statusAtEntry = trade.statusAtEntry || explanation?.entry?.status || 'unknown';
    const strategyId = trade.strategyId || 'unknown';
    const setup = trade.setup || 'unknown';
    const symbol = trade.symbol || 'unknown';
    const confidence = num(trade.confidenceScore ?? explanation?.entry?.confidence ?? null);
    const pnlPct = num(trade.pnlPct ?? null);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: groupKey,
        issueType,
        issueLabel: labelForIssue(issueType),
        strategyId,
        setup,
        count: 0,
        avgConfidence: null,
        avgPnlPct: null,
        symbols: [],
        symbolCounts: {},
        biasCounts: {},
        statusAtEntryCounts: {},
        issueTags: new Set(),
        missingFields: new Set(),
        examples: [],
        diagnosis: '',
        recommendation: null,
        nextAction: 'create_manual_test_queue_preview',
      });
    }

    const group = groups.get(groupKey);
    group.count += 1;
    if (symbol) {
      if (!group.symbols.includes(symbol)) group.symbols.push(symbol);
      group.symbolCounts[symbol] = (group.symbolCounts[symbol] || 0) + 1;
    }
    if (bias) group.biasCounts[bias] = (group.biasCounts[bias] || 0) + 1;
    if (statusAtEntry) group.statusAtEntryCounts[statusAtEntry] = (group.statusAtEntryCounts[statusAtEntry] || 0) + 1;
    issueTags.forEach((tag) => group.issueTags.add(tag));
    gateMissing.forEach((field) => group.missingFields.add(field));
    if (confidence != null) {
      group._confidenceSum = (group._confidenceSum || 0) + confidence;
      group._confidenceCount = (group._confidenceCount || 0) + 1;
    }
    if (pnlPct != null) {
      group._pnlSum = (group._pnlSum || 0) + pnlPct;
      group._pnlCount = (group._pnlCount || 0) + 1;
    }
    if (group.examples.length < 3) {
      group.examples.push({
        tradeId: trade.tradeId || null,
        symbol,
        openedAt: trade.openedAt || null,
        pnlPct,
        explanation: groupExampleExplanation(issueType, trade, explanation, gate),
      });
    }

    issueCounts.set(issueType, (issueCounts.get(issueType) || 0) + 1);
    strategyCounts.set(strategyId, (strategyCounts.get(strategyId) || 0) + 1);
  }

  const resolvedGroups = [...groups.values()].map((group) => {
    const issueType = group.issueType;
    const avgConfidence = group._confidenceCount ? Number((group._confidenceSum / group._confidenceCount).toFixed(2)) : null;
    const avgPnlPct = group._pnlCount ? Number((group._pnlSum / group._pnlCount).toFixed(4)) : null;
    const sortedSymbols = [...group.symbols].sort();
    return {
      id: group.id,
      issueType,
      issueLabel: group.issueLabel,
      strategyId: group.strategyId,
      setup: group.setup,
      count: group.count,
      avgConfidence,
      avgPnlPct,
      symbols: sortedSymbols,
      symbolCounts: group.symbolCounts,
      biasCounts: group.biasCounts,
      statusAtEntryCounts: group.statusAtEntryCounts,
      issueTags: unique([...group.issueTags]),
      missingFields: unique([...group.missingFields]),
      examples: group.examples.map((example) => ({
        ...example,
        explanation: example.explanation || diagnosisForIssue(issueType, group),
      })),
      diagnosis: diagnosisForIssue(issueType, group),
      recommendation: recommendationForGroup(issueType, group),
      nextAction: group.nextAction,
    };
  }).sort((a, b) => b.count - a.count || String(a.issueType).localeCompare(String(b.issueType)) || String(a.strategyId).localeCompare(String(b.strategyId)));

  const topIssueEntry = [...issueCounts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || ['unknown', 0];
  const topStrategyEntry = [...strategyCounts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || ['unknown', 0];

  return {
    groups: resolvedGroups,
    summary: {
      topIssue: topIssueEntry[0],
      topStrategyIssue: topStrategyEntry[0],
      issueCounts: Object.fromEntries(issueCounts),
      strategyCounts: Object.fromEntries(strategyCounts),
    },
    missingFields: unique([...missingFields]),
  };
}

function missingFieldsForTrade(gateMissing, missingFields) {
  for (const field of gateMissing || []) {
    if (field) missingFields.add(field);
  }
}

function groupExampleExplanation(issueType, trade, explanation, gate) {
  const checks = gate?.checks || {};
  const gateReason = {
    late_entry: checks.lateEntry?.reason,
    missing_2m_confirmation: checks.twoMinuteConfirmation?.reason,
    stop_loss_hit: checks.stopFit?.reason,
    choppy_market: checks.choppyMarket?.reason,
    low_mfe_direct_adverse: 'Low MFE och snabb motrörelse tyder på entry/marknad snarare än stopprofil.',
    missing_logging_fields: 'Kritiska loggfält saknas, så analysen är delvis osäker.',
    unknown: null,
  }[issueType];

  return gateReason
    || explanation?.diagnosis?.lesson
    || explanation?.diagnosis?.whyWinOrLoss
    || explanation?.entry?.explanation
    || explanation?.exit?.explanation
    || explanation?.diagnosis?.summary
    || 'Ingen tydlig förklaring i loggen.';
}

function buildTradeContext(trade, options) {
  const explanationService = options.explanationService || paperTradeExplanationService;
  const gateService = options.entryQualityGateService || entryQualityGateService;
  const lookup = typeof options.resolveTradeExplanation === 'function'
    ? options.resolveTradeExplanation(trade)
    : explanationService.buildTradeExplanationLookup({
      files: options.files,
      lookup: {
        tradeId: trade.tradeId || null,
        symbol: trade.symbol || null,
        strategyId: trade.strategyId || null,
        openedAt: trade.openedAt || null,
        closedAt: trade.closedAt || null,
      },
    });

  const explanation = lookup?.tradeExplanation || null;
  const entryQualityGate = explanation?.entryQualityGate
    || gateService.buildEntryQualityGate({
      trade: trade.raw || trade,
      explanation: explanation || {},
      events: [],
    });

  return {
    trade,
    explanation,
    entryQualityGate,
    lookupFound: lookup?.found !== false,
  };
}

function createLossReviewQueueService(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };

  function loadClosedTrades() {
    const rows = Array.isArray(options.trades) ? options.trades : readJsonl(files.trades);
    return rows
      .filter(isClosedTrade)
      .map(normalizeTrade)
      .filter((trade) => trade.result === 'LOSS')
      .sort((a, b) => String(b.closedAt || b.openedAt || '').localeCompare(String(a.closedAt || a.openedAt || '')));
  }

  function buildLossReviewQueue() {
    const closedTrades = loadClosedTrades();
    const tradeContexts = closedTrades.map((trade) => buildTradeContext(trade, { ...options, files }));
    const { groups, summary, missingFields } = aggregateLosses(closedTrades, tradeContexts);

    return {
      ok: true,
      safety: { ...SAFETY },
      summary: {
        totalClosed: closedTrades.length,
        totalLosses: closedTrades.length,
        reviewedLosses: tradeContexts.length,
        topIssue: summary.topIssue,
        topStrategyIssue: summary.topStrategyIssue,
        generatedAt: nowIso(),
      },
      groups,
      missingFields,
    };
  }

  function getLossReviewQueue() {
    return buildLossReviewQueue();
  }

  function buildTestPreview(groupId) {
    const queue = buildLossReviewQueue();
    const id = text(groupId, '');
    const group = queue.groups.find((item) => item.id === id) || null;
    if (!group) {
      return { ok: false, error: 'loss_group_not_found', safety: { ...SAFETY } };
    }

    return {
      ok: true,
      safety: { ...SAFETY },
      groupId: group.id,
      group,
      preview: buildGroupPreview(group),
      nextAction: 'create_manual_test_queue_preview',
    };
  }

  return {
    SAFETY,
    getLossReviewQueue,
    buildLossReviewQueue,
    buildTestPreview,
  };
}

const defaultLossReviewQueueService = createLossReviewQueueService();

module.exports = {
  SAFETY,
  createLossReviewQueueService,
  defaultLossReviewQueueService,
};
