'use strict';

/**
 * Supervisor Overview Service — READ-ONLY system brain aggregator.
 *
 * Collects the already-existing system-wide endpoints into one fault-isolated
 * response so the Supervisor can answer: how is the system, what did AI learn,
 * best/worst strategies, what is being tested, what to test next, risks, and a
 * focus action plan.
 *
 * Contract: docs/supervisor-overview-contract.md
 *
 * SAFETY: only reads. Never writes files, never places orders, never enables a
 * broker, never changes risk. Each block is wrapped so one failing source can
 * never blank the page or throw out of buildOverview().
 */

const tradeStats = require('./tradeStatsService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'supervisor_overview_v1',
});

// Lazy require so a load error in one source module cannot break the whole file.
function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

/**
 * Run one block producer in full isolation. Always resolves to a block object;
 * never throws. `producer` may be sync or async and may return null/undefined
 * (→ status 'empty').
 */
async function safeBlock(meta, producer) {
  const base = { status: 'error', scope: meta.scope, source: meta.source, summary: null };
  try {
    const raw = await producer();
    if (raw === null || raw === undefined) return { ...base, status: 'empty' };
    return { ...base, status: 'ok', summary: raw };
  } catch (err) {
    return { ...base, status: 'error', error: err && err.message ? err.message : String(err) };
  }
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── per-block summarizers (condense, never dump full payloads) ────────────────
function summarizeSystemHealth(h) {
  if (!h) return null;
  const alerts = Array.isArray(h.alerts) ? h.alerts : [];
  return {
    overallStatus: h.overallStatus || h.status || 'UNKNOWN',
    summarySv: h.summarySv || h.summary_sv || null,
    componentCount: Array.isArray(h.components) ? h.components.length : null,
    alertCount: alerts.length,
    criticalAlerts: alerts.filter((a) => (a.severity || '').toLowerCase() === 'critical').length,
  };
}

function summarizeLearning(latest) {
  // Canonical paper-trade truth, always available from disk.
  let canonical = null;
  try { canonical = tradeStats.buildPaperTradeStats(); } catch (_) { canonical = null; }
  return {
    canonicalPaperStats: canonical && {
      totalTrades: canonical.totalTrades,
      winRate: canonical.winRate,
      decisiveWinRate: canonical.decisiveWinRate,
      timeoutRate: canonical.timeoutRate,
      avgPnl: canonical.avgPnl,
    },
    connectorSummary: latest ? {
      generatedAt: latest.generatedAt || latest.generated_at || null,
      strategiesTracked: Array.isArray(latest.strategies) ? latest.strategies.length
        : (latest.strategyCount || latest.strategies_tracked || null),
    } : null,
  };
}

function summarizeStrategies(top, worst) {
  const pick = (list) => (Array.isArray(list) ? list : (list && list.strategies) || [])
    .slice(0, 5)
    .map((s) => ({
      key: s.key || s.strategy_id || s.strategyId || s.id || s.name || 'unknown',
      winRate: num(s.win_rate ?? s.winRate ?? s.winRatePct),
      trades: num(s.trades ?? s.tradeCount ?? s.n ?? s.total),
    }));
  return { top: pick(top), worst: pick(worst) };
}

function summarizeNarrow(n) {
  if (!n) return null;
  const s = n.summary || n;
  return {
    status: s.status || null,
    totalTrades: num(s.totalTrades ?? s.totalNarrowTrades),
    dataConfidence: s.dataConfidence || null,
    bestStrategy: s.bestStrategy && (s.bestStrategy.strategy_id || s.bestStrategy.id || s.bestStrategy),
    worstStrategy: s.worstStrategy && (s.worstStrategy.strategy_id || s.worstStrategy.id || s.worstStrategy),
    bestScoreBand: s.bestScoreBand || null,
    recommendedNextTest: s.recommendedNextTest || null,
  };
}

function summarizeAutopilot(status, scheduler) {
  const a = (status && status.autopilot) || status || {};
  return {
    schedulerActive: scheduler ? Boolean(scheduler.schedulerActive) : null,
    dryRunOnly: scheduler ? Boolean(scheduler.dryRunOnly) : true,
    executionEnabled: scheduler ? Boolean(scheduler.executionEnabled) : false,
    nextRunAt: scheduler ? scheduler.nextRunAt || null : null,
    lastRecommendedTest: scheduler ? scheduler.lastRecommendedTest || null : null,
    lastPlanStrategy: a && a.lastPlan ? (a.lastPlan.strategy_id || null) : null,
    blockedReason: scheduler ? scheduler.blockedReason || null : null,
  };
}

function summarizeRegime(r) {
  if (!r) return null;
  return {
    regime: r.regime || r.currentRegime || (r.detected && r.detected.regime) || null,
    biasSv: r.biasSv || r.bias_sv || (r.bias && r.bias.labelSv) || null,
    volatilityState: r.volatilityState || (r.detected && r.detected.volatilityState) || null,
  };
}

function summarizePriority(p) {
  if (!p) return null;
  const len = (x) => (Array.isArray(x) ? x.length : null);
  const top = (p.topFocus || p.top_focus || [])[0] || null;
  return {
    topFocusCount: len(p.topFocus || p.top_focus),
    watchlistCount: len(p.watchlist),
    avoidCount: len(p.avoid),
    topPick: top && (top.symbol || top.key || null),
  };
}

function summarizeDaily(d) {
  if (!d) return null;
  return {
    enabled: d.enabled !== undefined ? Boolean(d.enabled) : null,
    lastRunAt: d.lastRunAt || d.last_run_at || (d.lastRun && d.lastRun.startedAt) || null,
    lastStatus: d.lastStatus || d.last_status || (d.lastRun && d.lastRun.status) || null,
  };
}

function summarizeOptimization(o) {
  if (!o) return null;
  const st = o.overallStats || o;
  return {
    tradeCount: num(o.tradeCount ?? st.n),
    overallScore: num(o.overallScore),
    winRatePct: num(st.winRatePct),
    timeoutRatePct: num(st.timeoutRatePct),
    avgPnl: num(st.avgPnl),
  };
}

function summarizeOpsAdvisor(o) {
  if (!o) return null;
  return {
    headlineSv: o.headlineSv || o.headline_sv || o.summarySv || null,
    recommendationCount: Array.isArray(o.recommendations) ? o.recommendations.length : null,
    window: o.window || null,
  };
}

// ── risk + action-plan derivation (read-only, derived from the blocks) ────────
function deriveRisks(blocks, canonical) {
  const risks = [];

  const sh = blocks.system_health;
  if (sh && sh.status === 'ok' && sh.summary) {
    const os = (sh.summary.overallStatus || '').toUpperCase();
    if (os === 'CRITICAL') risks.push({ level: 'critical', code: 'system_health_critical', message_sv: sh.summary.summarySv || 'Systemhälsa kritisk.' });
    else if (os === 'WARNING' || os === 'DEGRADED') risks.push({ level: 'warning', code: 'system_health_degraded', message_sv: sh.summary.summarySv || 'Systemhälsa försämrad.' });
    if (sh.summary.criticalAlerts > 0) risks.push({ level: 'critical', code: 'critical_alerts', message_sv: `${sh.summary.criticalAlerts} kritiska larm aktiva.` });
  }

  if (canonical) {
    if (canonical.avgPnl !== null && canonical.avgPnl < 0) {
      risks.push({ level: 'warning', code: 'negative_avg_pnl', message_sv: `Genomsnittlig P/L är negativ (${canonical.avgPnl}). Detta är testdata, ingen bevisad edge.` });
    }
    if (canonical.timeoutRate !== null && canonical.timeoutRate >= 15) {
      risks.push({ level: 'warning', code: 'high_timeout_rate', message_sv: `Hög timeout-andel (${canonical.timeoutRate}%): många trades avgörs av maxtid, inte target/stop.` });
    }
  }

  const ap = blocks.autopilot;
  if (ap && ap.status === 'ok' && ap.summary && ap.summary.blockedReason) {
    risks.push({ level: 'info', code: 'autopilot_blocked', message_sv: `Autopilot pausad/blockerad: ${ap.summary.blockedReason}.` });
  }

  for (const [name, b] of Object.entries(blocks)) {
    if (b && b.status === 'error') {
      risks.push({ level: 'warning', code: `block_error:${name}`, message_sv: `Block "${name}" kunde inte läsas: ${b.error || 'okänt fel'}.` });
    }
  }

  // Always-on reassurance that live trading stays off.
  risks.push({ level: 'info', code: 'paper_only', message_sv: 'Live trading är avstängt. Endast analys, paper, replay och batch.' });
  return risks;
}

function deriveActionPlan(blocks) {
  const plan = [];

  const narrow = blocks.narrow;
  const rec = narrow && narrow.status === 'ok' && narrow.summary && narrow.summary.recommendedNextTest;
  if (rec) {
    plan.push({
      priority: rec.priority || 'low',
      title_sv: 'Kör nästa rekommenderade narrow-test',
      detail_sv: rec.reason || `Testa ${rec.strategy_id || 'rekommenderad strategi'} (${rec.selectedNarrowScoreBand || 'band okänt'}).`,
      source: '/api/supervisor/narrow-state',
    });
  }

  const strat = blocks.strategies;
  if (strat && strat.status === 'ok' && strat.summary && Array.isArray(strat.summary.worst) && strat.summary.worst.length) {
    const w = strat.summary.worst[0];
    plan.push({
      priority: 'medium',
      title_sv: 'Granska svagaste strategin',
      detail_sv: `"${w.key}" presterar svagast (winRate ${w.winRate}%, ${w.trades} trades). Överväg att pausa eller justera i Trading Lab — ingen auto-apply.`,
      source: '/api/daytrading-strategies/worst',
    });
  }

  if (!plan.length) {
    plan.push({ priority: 'low', title_sv: 'Samla mer testdata', detail_sv: 'För få avgjorda trades för en stark rekommendation. Kör fler paper/batch-tester.', source: 'supervisor_overview' });
  }
  return plan;
}

// ── main aggregator ───────────────────────────────────────────────────────────
async function buildOverview() {
  const systemHealth = lazy('../systemHealth');
  const learningConnector = lazy('./learningConnectorService');
  const strategyRead = lazy('./strategyPerformanceReadService');
  const narrowPerf = lazy('./narrowPerformanceLearningService');
  const autopilot = lazy('./narrowTestAutopilotService');
  const scheduler = lazy('../jobs/narrowAutopilotScheduler');
  const marketRegime = lazy('./marketRegimeService');
  const priority = lazy('./priorityEngineService');
  const daily = lazy('./dailyIntelligencePipelineService');
  const optimization = lazy('./aiOptimizationAgentService');
  const opsAdvisor = lazy('./supervisorOperationsAdvisorService');

  const [
    system_health, learning, strategies, narrow, autopilotBlock,
    market_regime, priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
  ] = await Promise.all([
    safeBlock({ scope: 'system_wide', source: '/api/system/health' },
      () => summarizeSystemHealth(systemHealth.buildSystemHealth())),
    safeBlock({ scope: 'system_wide', source: '/api/learning/latest-summary' },
      () => summarizeLearning(learningConnector.loadLatestSummary())),
    safeBlock({ scope: 'system_wide', source: '/api/daytrading-strategies/top|worst' },
      () => summarizeStrategies(strategyRead.getTopStrategies(5), strategyRead.getWorstStrategies(5))),
    safeBlock({ scope: 'narrow_only', source: '/api/supervisor/narrow-state' },
      () => summarizeNarrow(narrowPerf.buildSupervisorNarrowLearning())),
    safeBlock({ scope: 'narrow_only', source: '/api/autopilot/narrow/status' },
      () => summarizeAutopilot(autopilot.getNarrowAutopilotStatus(), scheduler.getNarrowAutopilotSchedulerStatus())),
    safeBlock({ scope: 'system_wide', source: '/api/market-regime/status' },
      () => summarizeRegime(marketRegime.buildRegimeSummary(false))),
    safeBlock({ scope: 'system_wide', source: '/api/priority/summary' },
      async () => summarizePriority(await priority.buildPrioritySummary())),
    safeBlock({ scope: 'system_wide', source: '/api/pipeline/daily/status' },
      () => summarizeDaily(daily.status())),
    safeBlock({ scope: 'system_wide', source: '/api/optimization/summary' },
      () => summarizeOptimization(optimization.getCachedSummary())),
    safeBlock({ scope: 'system_wide', source: '/api/supervisor/operations-advisor' },
      () => summarizeOpsAdvisor(opsAdvisor.getOperationsAdvisor())),
  ]);

  const blocks = {
    system_health, learning, strategies, narrow, autopilot: autopilotBlock,
    market_regime, priority: priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
  };

  // Canonical headline from the single source of truth.
  let canonicalStats = null;
  try {
    const c = tradeStats.buildPaperTradeStats();
    canonicalStats = {
      totalTrades: c.totalTrades, winRate: c.winRate, decisiveWinRate: c.decisiveWinRate,
      timeoutRate: c.timeoutRate, avgPnl: c.avgPnl,
    };
  } catch (_) { canonicalStats = null; }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    ...SAFETY,
    canonicalStats,
    blocks,
    risks: deriveRisks(blocks, canonicalStats),
    actionPlan: deriveActionPlan(blocks),
  };
}

module.exports = {
  SAFETY,
  buildOverview,
  // exported for tests
  safeBlock,
  deriveRisks,
  deriveActionPlan,
  summarizeStrategies,
};
