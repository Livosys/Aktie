'use strict';

const SCORE_BUCKETS = ['0-39', '40-54', '55-69', '70-84', '85-100', 'UNKNOWN'];

function round(v, decimals = 2) {
  if (!Number.isFinite(v)) return null;
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(part, total) {
  return total > 0 ? round((part / total) * 100, 2) : null;
}

function avg(values, decimals = 4) {
  const nums = values.map(toNumber).filter(v => v != null);
  return nums.length ? round(nums.reduce((s, v) => s + v, 0) / nums.length, decimals) : null;
}

function gateScoreBucket(score) {
  const n = toNumber(score);
  if (n == null) return 'UNKNOWN';
  if (n <= 39) return '0-39';
  if (n <= 54) return '40-54';
  if (n <= 69) return '55-69';
  if (n <= 84) return '70-84';
  if (n <= 100) return '85-100';
  return 'UNKNOWN';
}

function stableCodeFromText(text, fallback = 'unknown') {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/data inte f.rsk|datafreshness|fresh/.test(raw)) return 'stale_stock_data';
  if (/marknaden .r st.ngd|market closed|session/.test(raw)) return 'outside_nyse_session';
  if (/ema ned.t.*crypto|crypto_ema_down/.test(raw)) return 'crypto_ema_down_blocked';
  if (/normal volym.*crypto|vwap-signaler|normal_vol/.test(raw)) return 'crypto_normal_vol_vwap_only';
  if (/ema upp.t.*stark volym|ema_up.*strong/.test(raw)) return 'crypto_ema_up_requires_strong_volume';
  if (/blandad marknadsbild|mixed/.test(raw)) return 'mixed_compass_low_score';
  if (/po.ng|score|tr.skel|threshold/.test(raw)) return 'low_gate_score';
  if (/risk-off|risk-on|kompass|compass/.test(raw)) return 'compass_conflict';
  return raw
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .slice(0, 80) || fallback;
}

function firstText(...lists) {
  for (const list of lists) {
    if (Array.isArray(list)) {
      const item = list.find(Boolean);
      if (item) return item;
    } else if (list) {
      return list;
    }
  }
  return null;
}

function getTradeGateScore(t) {
  return toNumber(t?.gateScore ?? t?.gateDecision?.gateScore);
}

function normalizeTrade(t) {
  const result = String(t?.result || 'OPEN').toUpperCase();
  return {
    ...t,
    result,
    gateScore: getTradeGateScore(t),
    marketGroup: t?.marketGroup || t?.gateDecision?.marketGroup || 'UNKNOWN',
    riskProfileName: t?.riskProfileName || t?.paperRiskProfile?.profileName || t?.gateDecision?.riskProfileName || 'UNKNOWN',
    signalSubtype: t?.signalSubtype || 'UNKNOWN',
    compassBias: t?.compassBias || t?.gateDecision?.compassBias || 'UNKNOWN',
    compassConflict: t?.compassConflict === true || t?.gateDecision?.compassConflict === true,
  };
}

function normalizeDecision(d) {
  const reasonSv = firstText(d?.reasonSv, d?.reasons, d?.penalties, d?.warnings, d?.boosts);
  const mode = d?.mode === 'observe_only'
    ? 'observe_only'
    : d?.allowed === false || d?.mode === 'blocked'
      ? 'block'
      : 'allow';
  const threshold = toNumber(d?.threshold);
  const gateScore = toNumber(d?.gateScore);
  const fallback = mode === 'allow'
    ? 'allowed'
    : mode === 'observe_only'
      ? 'observe_only'
      : (gateScore != null && threshold != null && gateScore < threshold ? 'low_gate_score' : 'blocked');
  return {
    raw: d,
    mode,
    gateScore,
    threshold,
    decisionCode: d?.decisionCode || d?.reasonCode || d?.code || stableCodeFromText(reasonSv, fallback),
    reasonSv,
    marketGroup: d?.marketGroup || d?.signal?.marketGroup || 'UNKNOWN',
    signalSubtype: d?.signalSubtype || d?.signal?.signalSubtype || 'UNKNOWN',
    compassBias: d?.compassBias || d?.marketCompass?.bias || d?.compass?.bias || 'UNKNOWN',
    compassConflict: d?.compassConflict === true || d?.signal?.compassConflict === true,
    timestamp: d?.timestamp || d?.evaluatedAt || d?.createdAt || null,
  };
}

function holdMinutes(t) {
  const start = new Date(t?.entryTime || t?.openedAt || 0).getTime();
  const end = new Date(t?.exitTime || t?.closedAt || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || end < start) return null;
  return round((end - start) / 60_000, 2);
}

function makeTradeAccumulator() {
  return {
    count: 0,
    openedTrades: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    pnl: [],
    gateScores: [],
    maxFav: [],
    maxAdv: [],
    hold: [],
  };
}

function addTrade(acc, t) {
  acc.count++;
  acc.openedTrades++;
  if (t.result === 'WIN') acc.wins++;
  if (t.result === 'LOSS') acc.losses++;
  if (t.result === 'TIMEOUT') acc.timeouts++;
  if (t.result !== 'OPEN') acc.pnl.push(t.pnlPct);
  acc.gateScores.push(t.gateScore);
  acc.maxFav.push(t.maxFavorablePct);
  acc.maxAdv.push(t.maxAdversePct);
  acc.hold.push(holdMinutes(t));
}

function finalizeTradeAccumulator(acc, includeCount = true) {
  const out = {
    openedTrades: acc.openedTrades,
    wins: acc.wins,
    losses: acc.losses,
    timeouts: acc.timeouts,
    winRate: pct(acc.wins, acc.openedTrades),
    lossRate: pct(acc.losses, acc.openedTrades),
    timeoutRate: pct(acc.timeouts, acc.openedTrades),
    avgPnlPct: avg(acc.pnl),
    avgMaxFavorablePct: avg(acc.maxFav),
    avgMaxAdversePct: avg(acc.maxAdv),
    avgHoldMinutes: avg(acc.hold, 2),
  };
  if (includeCount) out.count = acc.count;
  return out;
}

function sortByCount(arr, key = 'count') {
  return arr.sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

function topCounts(items, key, limit = 8) {
  const counts = {};
  for (const item of items) {
    const k = item?.[key] || 'UNKNOWN';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function emptyReport() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      totalGateEvaluated: 0,
      allowed: 0,
      blocked: 0,
      observeOnly: 0,
      openedTrades: 0,
      gateAllowRate: null,
      gateBlockRate: null,
      gateObserveOnlyRate: null,
      tradeOpenRate: null,
      avgGateScoreOpened: null,
      avgGateScoreBlocked: null,
      avgGateScoreObserveOnly: null,
      avgPnlOpened: null,
      winRateOpened: null,
      timeoutRateOpened: null,
    },
    byGateScoreBucket: SCORE_BUCKETS.map(bucket => ({ bucket, ...finalizeTradeAccumulator(makeTradeAccumulator()) })),
    byDecisionCode: [],
    byMarketGroup: [],
    byRiskProfile: [],
    bySignalSubtype: [],
    byCompassBias: [],
    byCompassConflict: [],
    blockedSummary: { total: 0, topDecisionCodes: [], topMarketGroups: [], topSignalSubtypes: [], topCompassBiases: [], latest: [] },
    observeOnlySummary: { total: 0, topDecisionCodes: [], topMarketGroups: [], topSignalSubtypes: [], latest: [] },
    allowedSummary: { total: 0, openedTrades: 0, notOpenedCount: 0, topMarketGroups: [], topSignalSubtypes: [], latest: [] },
    missedOpportunity: {
      supported: false,
      noteSv: 'Prisuppföljning efter blockerade signaler är inte implementerad ännu.',
      futureFields: ['maxMoveAfterSignalPct', 'minMoveAfterSignalPct', 'estimatedWouldHitTarget', 'estimatedWouldHitStop'],
    },
    recommendations: [],
    dataQuality: {
      hasEnoughTrades: false,
      hasEnoughGateDecisions: false,
      openedTradesCount: 0,
      gateDecisionCount: 0,
      persistedGateDecisionCount: 0,
      inMemoryGateDecisionCount: 0,
      latestPersistedGateDecisionAt: null,
      gateDecisionSource: 'memory',
      noteSv: 'Det finns ännu för lite data för säkra slutsatser. Samla fler gate decisions och trades.',
    },
  };
}

function buildGateEffectivenessReport(input = {}) {
  const trades = (input.trades || []).filter(Boolean).map(normalizeTrade);
  const decisions = (input.gateDecisions || []).filter(Boolean).map(normalizeDecision);
  const pipeline = input.pipeline || {};

  const report = emptyReport();
  report.generatedAt = new Date().toISOString();

  const openedTrades = trades.length;
  const closedTrades = trades.filter(t => t.result !== 'OPEN');
  const openedAcc = makeTradeAccumulator();
  for (const t of trades) addTrade(openedAcc, t);
  const openedStats = finalizeTradeAccumulator(openedAcc);

  const decisionCounts = {
    allow: decisions.filter(d => d.mode === 'allow').length,
    block: decisions.filter(d => d.mode === 'block').length,
    observe_only: decisions.filter(d => d.mode === 'observe_only').length,
  };

  const pipelineGateEvaluated = toNumber(pipeline.marketGateEvaluatedToday ?? pipeline.gateEvaluated);
  const pipelineAllowed = toNumber(pipeline.marketGateAllowedToday ?? pipeline.gateAllowed);
  const pipelineBlocked = toNumber(pipeline.marketGateBlockedToday ?? pipeline.gateBlocked);
  const pipelineObserve = toNumber(pipeline.marketGateObserveOnlyToday ?? pipeline.gateObserveOnly);
  const pipelineOpened = toNumber(pipeline.tradesOpenedToday ?? pipeline.tradesOpened);

  const totalGateEvaluated = decisions.length || pipelineGateEvaluated || 0;
  const allowed = decisions.length ? decisionCounts.allow : (pipelineAllowed || 0);
  const blocked = decisions.length ? decisionCounts.block : (pipelineBlocked || 0);
  const observeOnly = decisions.length ? decisionCounts.observe_only : (pipelineObserve || 0);
  const openedForRate = pipelineOpened != null && pipelineGateEvaluated != null && pipelineGateEvaluated > 0 ? pipelineOpened : openedTrades;

  report.summary = {
    totalGateEvaluated,
    allowed,
    blocked,
    observeOnly,
    openedTrades,
    gateAllowRate: pct(allowed, totalGateEvaluated),
    gateBlockRate: pct(blocked, totalGateEvaluated),
    gateObserveOnlyRate: pct(observeOnly, totalGateEvaluated),
    tradeOpenRate: pct(openedForRate, totalGateEvaluated),
    avgGateScoreOpened: avg(trades.map(t => t.gateScore)),
    avgGateScoreBlocked: avg(decisions.filter(d => d.mode === 'block').map(d => d.gateScore)),
    avgGateScoreObserveOnly: avg(decisions.filter(d => d.mode === 'observe_only').map(d => d.gateScore)),
    avgPnlOpened: avg(closedTrades.map(t => t.pnlPct)),
    winRateOpened: pct(closedTrades.filter(t => t.result === 'WIN').length, closedTrades.length),
    timeoutRateOpened: pct(closedTrades.filter(t => t.result === 'TIMEOUT').length, closedTrades.length),
  };

  const bucketAcc = Object.fromEntries(SCORE_BUCKETS.map(b => [b, makeTradeAccumulator()]));
  for (const t of trades) addTrade(bucketAcc[gateScoreBucket(t.gateScore)], t);
  report.byGateScoreBucket = SCORE_BUCKETS.map(bucket => ({ bucket, ...finalizeTradeAccumulator(bucketAcc[bucket]) }));

  const byDecision = {};
  for (const d of decisions) {
    const k = d.decisionCode || 'unknown';
    if (!byDecision[k]) {
      byDecision[k] = {
        decisionCode: k,
        count: 0,
        modes: { allow: 0, block: 0, observe_only: 0 },
        marketGroups: {},
        signalSubtypes: {},
        gateScores: [],
        exampleReasonSv: null,
        latestAt: null,
      };
    }
    const row = byDecision[k];
    row.count++;
    row.modes[d.mode] = (row.modes[d.mode] || 0) + 1;
    row.marketGroups[d.marketGroup] = (row.marketGroups[d.marketGroup] || 0) + 1;
    row.signalSubtypes[d.signalSubtype] = (row.signalSubtypes[d.signalSubtype] || 0) + 1;
    row.gateScores.push(d.gateScore);
    if (!row.exampleReasonSv && d.reasonSv) row.exampleReasonSv = d.reasonSv;
    if (d.timestamp && (!row.latestAt || d.timestamp > row.latestAt)) row.latestAt = d.timestamp;
  }
  report.byDecisionCode = sortByCount(Object.values(byDecision).map(row => ({
    decisionCode: row.decisionCode,
    count: row.count,
    modes: row.modes,
    marketGroups: row.marketGroups,
    signalSubtypes: row.signalSubtypes,
    avgGateScore: avg(row.gateScores),
    exampleReasonSv: row.exampleReasonSv,
    latestAt: row.latestAt,
  })));

  function groupedDecisionTradeReport(groupKey, labelKey, includeGate = true) {
    const map = {};
    for (const d of decisions) {
      const k = d[groupKey] || 'UNKNOWN';
      if (!map[k]) map[k] = { [labelKey]: k, gateEvaluated: 0, allowed: 0, blocked: 0, observeOnly: 0, trades: makeTradeAccumulator(), gateScores: [] };
      map[k].gateEvaluated++;
      if (d.mode === 'allow') map[k].allowed++;
      if (d.mode === 'block') map[k].blocked++;
      if (d.mode === 'observe_only') map[k].observeOnly++;
      map[k].gateScores.push(d.gateScore);
    }
    for (const t of trades) {
      const k = t[groupKey] || 'UNKNOWN';
      if (!map[k]) map[k] = { [labelKey]: k, gateEvaluated: 0, allowed: 0, blocked: 0, observeOnly: 0, trades: makeTradeAccumulator(), gateScores: [] };
      addTrade(map[k].trades, t);
      map[k].gateScores.push(t.gateScore);
    }
    return sortByCount(Object.values(map).map(row => {
      const stats = finalizeTradeAccumulator(row.trades, false);
      const out = {
        [labelKey]: row[labelKey],
        gateEvaluated: row.gateEvaluated,
        allowed: row.allowed,
        blocked: row.blocked,
        observeOnly: row.observeOnly,
        openedTrades: stats.openedTrades,
        wins: stats.wins,
        losses: stats.losses,
        timeouts: stats.timeouts,
        gateAllowRate: pct(row.allowed, row.gateEvaluated),
        tradeOpenRate: pct(stats.openedTrades, row.gateEvaluated),
        winRate: stats.winRate,
        timeoutRate: stats.timeoutRate,
        avgPnlPct: stats.avgPnlPct,
        avgGateScore: avg(row.gateScores),
      };
      if (includeGate) {
        out.avgMaxFavorablePct = stats.avgMaxFavorablePct;
        out.avgMaxAdversePct = stats.avgMaxAdversePct;
      }
      return out;
    }), 'openedTrades');
  }

  report.byMarketGroup = groupedDecisionTradeReport('marketGroup', 'marketGroup');
  report.bySignalSubtype = groupedDecisionTradeReport('signalSubtype', 'signalSubtype');
  report.byCompassBias = groupedDecisionTradeReport('compassBias', 'compassBias', false);

  const riskMap = {};
  for (const t of trades) {
    const k = t.riskProfileName || 'UNKNOWN';
    if (!riskMap[k]) riskMap[k] = { riskProfileName: k, trades: makeTradeAccumulator(), gateScores: [] };
    addTrade(riskMap[k].trades, t);
    riskMap[k].gateScores.push(t.gateScore);
  }
  report.byRiskProfile = sortByCount(Object.values(riskMap).map(row => {
    const stats = finalizeTradeAccumulator(row.trades);
    return {
      riskProfileName: row.riskProfileName,
      count: stats.count,
      openedTrades: stats.openedTrades,
      wins: stats.wins,
      losses: stats.losses,
      timeouts: stats.timeouts,
      winRate: stats.winRate,
      timeoutRate: stats.timeoutRate,
      avgPnlPct: stats.avgPnlPct,
      avgGateScore: avg(row.gateScores),
      avgMaxFavorablePct: stats.avgMaxFavorablePct,
      avgMaxAdversePct: stats.avgMaxAdversePct,
    };
  }));

  const conflictMap = {
    true: makeTradeAccumulator(),
    false: makeTradeAccumulator(),
  };
  for (const t of trades) addTrade(conflictMap[String(t.compassConflict === true)], t);
  report.byCompassConflict = [true, false].map(value => {
    const stats = finalizeTradeAccumulator(conflictMap[String(value)], false);
    return {
      compassConflict: value,
      openedTrades: stats.openedTrades,
      wins: stats.wins,
      losses: stats.losses,
      timeouts: stats.timeouts,
      winRate: stats.winRate,
      timeoutRate: stats.timeoutRate,
      avgPnlPct: stats.avgPnlPct,
    };
  });

  const latestByTime = arr => arr
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 10)
    .map(d => ({
      timestamp: d.timestamp,
      decisionCode: d.decisionCode,
      gateScore: d.gateScore,
      reasonSv: d.reasonSv,
      marketGroup: d.marketGroup,
      signalSubtype: d.signalSubtype,
      compassBias: d.compassBias,
    }));
  const blockedDecisions = decisions.filter(d => d.mode === 'block');
  const observeDecisions = decisions.filter(d => d.mode === 'observe_only');
  const allowedDecisions = decisions.filter(d => d.mode === 'allow');

  report.blockedSummary = {
    total: blockedDecisions.length,
    topDecisionCodes: topCounts(blockedDecisions, 'decisionCode'),
    topMarketGroups: topCounts(blockedDecisions, 'marketGroup'),
    topSignalSubtypes: topCounts(blockedDecisions, 'signalSubtype'),
    topCompassBiases: topCounts(blockedDecisions, 'compassBias'),
    latest: latestByTime(blockedDecisions),
  };
  report.observeOnlySummary = {
    total: observeDecisions.length,
    topDecisionCodes: topCounts(observeDecisions, 'decisionCode'),
    topMarketGroups: topCounts(observeDecisions, 'marketGroup'),
    topSignalSubtypes: topCounts(observeDecisions, 'signalSubtype'),
    latest: latestByTime(observeDecisions),
  };
  const openedAllowedTrades = trades.filter(t => t.gateDecision?.allowed !== false).length;
  report.allowedSummary = {
    total: allowedDecisions.length,
    openedTrades: openedAllowedTrades,
    notOpenedCount: Math.max(0, allowedDecisions.length - openedAllowedTrades),
    topMarketGroups: topCounts(allowedDecisions, 'marketGroup'),
    topSignalSubtypes: topCounts(allowedDecisions, 'signalSubtype'),
    latest: latestByTime(allowedDecisions),
  };

  const recommendations = [];
  const addRecommendation = text => {
    if (text && !recommendations.includes(text)) recommendations.push(text);
  };

  if (openedTrades < 20) addRecommendation('Samla minst 20 öppnade trades innan du ändrar thresholds.');
  if (report.summary.gateAllowRate != null && report.summary.gateAllowRate < 10 && decisions.length >= 30) {
    addRecommendation('Market Gate släpper igenom få signaler. Kontrollera om thresholds är för hårda.');
  }
  if (report.summary.gateAllowRate != null && report.summary.gateAllowRate > 70 && report.summary.avgPnlOpened != null && report.summary.avgPnlOpened < 0) {
    addRecommendation('Market Gate släpper igenom många signaler men PnL är negativ. Skärp filtreringen.');
  }
  if (report.summary.timeoutRateOpened != null && report.summary.timeoutRateOpened > 70 && openedTrades >= 10) {
    addRecommendation('Timeout-rate är hög. Kontrollera target, maxHold och signaltyper.');
  }
  const b85 = report.byGateScoreBucket.find(b => b.bucket === '85-100');
  const b70 = report.byGateScoreBucket.find(b => b.bucket === '70-84');
  if (b85?.avgPnlPct != null && b70?.avgPnlPct != null && b85.avgPnlPct < b70.avgPnlPct) {
    addRecommendation('Högsta gateScore-bucket presterar inte bäst. Kontrollera score-vikterna.');
  }
  const conflictTrue = report.byCompassConflict.find(r => r.compassConflict === true);
  const conflictFalse = report.byCompassConflict.find(r => r.compassConflict === false);
  if (conflictTrue?.avgPnlPct != null && conflictFalse?.avgPnlPct != null && conflictTrue.avgPnlPct < conflictFalse.avgPnlPct) {
    addRecommendation('Compass conflict-trades presterar sämre. Överväg hårdare penalty/block.');
  }
  for (const row of report.byMarketGroup) {
    if (row.openedTrades >= 5 && row.avgPnlPct != null && row.avgPnlPct < 0) {
      addRecommendation(`MarketGroup ${row.marketGroup} har negativ PnL. Sätt den till observe_only tills mer data finns.`);
    }
  }
  for (const row of report.bySignalSubtype) {
    if (row.openedTrades >= 5 && row.timeoutRate != null && row.timeoutRate > 70) {
      addRecommendation(`SignalSubtype ${row.signalSubtype} har hög timeout-rate. Överväg hårdare gate.`);
    }
  }
  report.recommendations = recommendations;

  report.dataQuality = {
    hasEnoughTrades: openedTrades >= 20,
    hasEnoughGateDecisions: decisions.length >= 50,
    openedTradesCount: openedTrades,
    gateDecisionCount: decisions.length,
    persistedGateDecisionCount: input.persistedGateDecisionCount ?? (input.gateDecisionSource === 'disk' ? decisions.length : 0),
    inMemoryGateDecisionCount: input.inMemoryGateDecisionCount ?? null,
    latestPersistedGateDecisionAt: input.latestPersistedGateDecisionAt || null,
    gateDecisionSource: input.gateDecisionSource || 'memory',
    noteSv: openedTrades >= 20 && decisions.length >= 50
      ? 'Det finns tillräckligt med data för preliminär gate-kalibrering.'
      : 'Det finns ännu för lite data för säkra slutsatser. Samla fler gate decisions och trades.',
  };

  return report;
}

module.exports = {
  SCORE_BUCKETS,
  gateScoreBucket,
  emptyReport,
  buildGateEffectivenessReport,
};
