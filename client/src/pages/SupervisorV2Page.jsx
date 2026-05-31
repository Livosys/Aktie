import React, { useEffect, useMemo, useState } from 'react';

const SAFETY_FLAGS = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  auto_apply_results: false,
});

const ENDPOINTS = [
  { key: 'status', url: '/api/status', label: 'Backend status' },
  { key: 'systemHealth', url: '/api/system/health', label: 'System health' },
  { key: 'safety', url: '/api/safety/status', label: 'Safety' },
  { key: 'autopilotStatus', url: '/api/strategy-test-autopilot/status', label: 'Strategy Test Autopilot' },
  { key: 'autopilotConfig', url: '/api/strategy-test-autopilot/config', label: 'Strategy Test Autopilot config' },
  { key: 'pipelineStatus', url: '/api/pipeline/daily/status', label: 'Daily Intelligence Pipeline' },
  { key: 'pipelineRecent', url: '/api/pipeline/daily/recent?n=5', label: 'Daily pipeline recent' },
  { key: 'dailyResults', url: '/api/results/daily-intelligence', label: 'Daily intelligence' },
  { key: 'learningConnectorStatus', url: '/api/learning/connector/status', label: 'Learning Connector' },
  { key: 'learningSummary', url: '/api/learning/latest-summary', label: 'Learning summary' },
  { key: 'priority', url: '/api/priority/summary', label: 'Priority Engine' },
  { key: 'optimization', url: '/api/optimization/summary', label: 'AI Optimization Agent' },
  { key: 'marketRegime', url: '/api/market-regime/status', label: 'Market Regime' },
  { key: 'paperStatus', url: '/api/paper-trading/status', label: 'Paper Trading status' },
  { key: 'paperPerformance', url: '/api/paper-trading/performance', label: 'Paper Trading performance' },
  { key: 'runtimeStrategies', url: '/api/daytrading/runtime-strategies', label: 'Daytrading runtime strategies' },
  { key: 'recommendation', url: '/api/daytrading/recommendation', label: 'Daytrading recommendation' },
];

const ADVISOR_WINDOWS = [
  { key: '1h', label: 'Senaste timmen', short: '1h' },
  { key: '1d', label: 'Idag', short: '1d' },
  { key: '7d', label: '7 dagar', short: '7d' },
  { key: '30d', label: '30 dagar', short: '30d' },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function textValue(value, fallback = 'Ej konfigurerad') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return value ? 'ja' : 'nej';
  if (Array.isArray(value)) {
    const parts = value.map((item) => textValue(item, '')).filter(Boolean);
    return parts.length ? parts.join(' · ') : fallback;
  }
  if (isObject(value)) {
    return textValue(
      value.label ??
      value.name ??
      value.title ??
      value.symbol ??
      value.message ??
      value.summary_sv ??
      value.summary ??
      value.conclusion_sv ??
      value.main_conclusion_sv ??
      value.note_sv ??
      value.text ??
      value.value,
      fallback,
    );
  }
  return fallback;
}

function deepPick(source, path) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function pickText(source, paths, fallback = 'Ej konfigurerad') {
  for (const path of paths) {
    const value = deepPick(source, path);
    if (value !== undefined && value !== null && value !== '') {
      const text = textValue(value, '');
      if (text) return text;
    }
  }
  return fallback;
}

function firstText(values, fallback = 'Ej konfigurerad') {
  for (const value of values) {
    const text = textValue(value, '');
    if (text) return text;
  }
  return fallback;
}

function buildAdvisorPrompt(advisor) {
  if (!advisor) return '';
  const summary = advisor.summary || {};
  const crypto = advisor.crypto_status || {};
  const highlights = advisor.strategy_highlights || {};
  const topWorking = normalizeArray(highlights.working).slice(0, 2).map((row) => `${row.name} (${row.win_rate ?? 0}% WR, ${row.closed ?? 0} trades)`).join(', ');
  const topBlocked = normalizeArray(highlights.blocked).slice(0, 2).map((row) => `${row.name} (${row.status || row.note || 'blockerad'})`).join(', ');
  const topFindings = normalizeArray(advisor.findings).slice(0, 4).map((item) => `${item.label}: ${item.text}`).join('\n');

  return [
    'Du är AI Operations Advisor i Trading OS Supervisor.',
    `Fönster: ${advisor.window_label_sv || advisor.window}`,
    `Kort slutsats: ${summary.conclusion_sv || 'saknas'}`,
    `Vad systemet såg: ${topFindings || summary.short_sv || 'saknas'}`,
    `Vad stoppades: ${advisor.blockers?.[0] ? `${advisor.blockers[0].label} (${advisor.blockers[0].count})` : 'inga tydliga blockerare'}`,
    `Bäst fungerande strategi: ${topWorking || 'ingen tydlig vinnare'}`,
    `Blockerade/partial: ${topBlocked || 'inga tydliga blockeringar'}`,
    `Crypto-status: signaler ${crypto.crypto_signals ?? 0}, runtime-active ${crypto.runtime_active ?? 0}, gate-blockade ${crypto.gate_blocked ?? 0}, VWAP ${crypto.vwap_routing_status || 'samlar data'}.`,
    `Rekommenderad nästa åtgärd: ${summary.next_action_sv || 'vänta och samla data'}.`,
    '',
    'Förklara kort varför inga eller få paper trades skapas och vad användaren bör testa eller bevaka härnäst.',
  ].join('\n');
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatInt(value, fallback = 'Ej konfigurerad') {
  const n = toNumber(value);
  return n === null ? fallback : new Intl.NumberFormat('sv-SE').format(Math.round(n));
}

function formatDecimal(value, decimals = 2, fallback = 'Ej konfigurerad') {
  const n = toNumber(value);
  if (n === null) return fallback;
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

function formatPct(value, decimals = 0, fallback = 'Ej konfigurerad') {
  const n = toNumber(value);
  return n === null ? fallback : `${formatDecimal(n, decimals, fallback)}%`;
}

function formatSignedPct(value, decimals = 2, fallback = 'Ej konfigurerad') {
  const n = toNumber(value);
  if (n === null) return fallback;
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatDecimal(n, decimals, fallback)}%`;
}

function formatDateTime(iso) {
  if (!iso) return 'Ej konfigurerad';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Ej konfigurerad';
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function ageText(iso) {
  if (!iso) return 'Ingen data ännu';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'Ingen data ännu';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'nyss';
  if (mins < 60) return `${mins} min sedan`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h sedan`;
  const days = Math.round(hours / 24);
  return `${days} d sedan`;
}

function endpointState(entry) {
  if (!entry) return { label: 'Ej konfigurerad', tone: 'missing' };
  if (entry.missing) return { label: 'Ej konfigurerad', tone: 'missing' };
  if (entry.error || entry.ok === false) return { label: 'Problem', tone: 'bad' };
  return { label: 'OK', tone: 'good' };
}

function unwrap(resource) {
  return resource?.data ?? null;
}

function unwrapSummary(resource) {
  const data = unwrap(resource);
  if (!data) return null;
  return data.summary ?? data;
}

function uniqueText(values) {
  const seen = new Set();
  const out = [];
  for (const value of normalizeArray(values)) {
    const text = textValue(value, '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function strategyLabel(item) {
  return firstText([
    item?.strategy_name,
    item?.strategyName,
    item?.name,
    item?.label,
    item?.strategy_id,
    item?.strategyId,
    item?.strategy,
  ], 'Ej konfigurerad');
}

function strategyDescriptor(item) {
  const parts = [strategyLabel(item)];
  const symbol = firstText([item?.symbol, item?.ticker], '');
  const market = firstText([item?.market_group, item?.marketGroup, item?.market, item?.market_label, item?.marketLabel], '');
  const timeframe = firstText([item?.timeframe], '');
  if (symbol) parts.push(symbol);
  if (market && market !== symbol) parts.push(market);
  if (timeframe) parts.push(timeframe);
  return parts.filter(Boolean).join(' · ');
}

function strategyKey(item) {
  const raw = firstText([
    item?.strategy_id,
    item?.strategyId,
    item?.strategy_name,
    item?.strategyName,
    item?.name,
    item?.label,
    item?.symbol,
  ], '');
  return raw ? raw.trim().toLowerCase() : '';
}

function collectStrategyKeys(values) {
  const keys = new Set();
  for (const item of normalizeArray(values)) {
    const key = strategyKey(item);
    if (key) keys.add(key);
  }
  return keys;
}

function winRateConfidence(trades) {
  const n = toNumber(trades);
  if (!Number.isFinite(n) || n <= 0) return 'Ingen data ännu';
  if (n <= 20) return 'låg datatrygghet';
  if (n <= 100) return 'medel datatrygghet';
  return 'högre trygghet';
}

function winRateText(winRate, trades) {
  const rate = toNumber(winRate);
  if (rate === null) return 'Win rate: Ingen data ännu';
  return `Win rate ${formatPct(rate, 1, 'Ingen data ännu')} (${winRateConfidence(trades)})`;
}

function marketRiskLabel(regime) {
  const raw = firstText([
    regime?.riskEnvLabelSv,
    regime?.risk_env_label_sv,
    regime?.riskEnvLabel,
    regime?.risk_env_label,
    regime?.risk_env,
    regime?.riskEnvironment,
  ], '');
  const lower = raw.toLowerCase();
  if (lower.includes('risk-off') || lower.includes('risk off')) return 'Risk-Off';
  if (lower.includes('risk-on') || lower.includes('risk on')) return 'Risk-On';
  if (lower.includes('neutral')) return 'Neutral';
  if (lower.includes('hög') || lower.includes('high')) return 'Risk-Off';
  if (lower.includes('låg') || lower.includes('low')) return 'Risk-On';
  return 'Neutral';
}

function marketVolatilityLabel(regime) {
  return firstText([
    regime?.volatilityLabelSv,
    regime?.volatilityState,
    regime?.volatility,
  ], 'Ej konfigurerad');
}

function moduleStateTone(ok, missing) {
  if (missing) return 'neutral';
  return ok ? 'ok' : 'danger';
}

function bestText(...segments) {
  return firstText(segments.filter(Boolean), 'Ingen data ännu');
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 404) {
      return { ok: false, missing: true, status: 404, url };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error || `API ${res.status}`,
        data,
        url,
      };
    }
    return { ok: true, status: res.status, data, url };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Nätverksfel',
      url,
    };
  }
}

function statusBadgeTone(status) {
  if (status === 'Stabilt' || status === 'Testa') return 'green';
  if (status === 'Vänta') return 'yellow';
  if (status === 'Undvik' || status === 'Problem') return 'red';
  return 'blue';
}

function recommendationPillTone(status) {
  if (status === 'Testa') return 'good';
  if (status === 'Undvik') return 'bad';
  return 'missing';
}

function ModuleCard({ card }) {
  return (
    <article className={`sup-v2-card sup-v2-card-${card.tone}`}>
      <div className="sup-v2-card-head">
        <div>
          <div className="sup-v2-card-kicker">{card.kicker}</div>
          <h3>{card.title}</h3>
        </div>
        <span className={`badge badge-${card.badgeTone}`}>{card.statusLabel}</span>
      </div>
      <p className="sup-v2-card-summary">{card.summary}</p>
      <div className="sup-v2-card-meta">
        {card.points.map((point) => (
          <span key={`${card.key}-${point}`} className="sup-v2-chip">
            {point}
          </span>
        ))}
      </div>
      <div className="sup-v2-card-source">{card.source}</div>
    </article>
  );
}

function DecisionCard({ item }) {
  return (
    <article className={`sup-v2-answer sup-v2-answer-${item.tone}`}>
      <div className="sup-v2-answer-head">
        <div>
          <div className="sup-v2-answer-kicker">{item.index}</div>
          <h3>{item.title}</h3>
        </div>
        <span className={`badge badge-${item.badgeTone}`}>{item.badge}</span>
      </div>
      <p className="sup-v2-answer-main">{item.summary}</p>
      {item.points.length > 0 && (
        <ul className="sup-v2-answer-list">
          {item.points.map((point) => (
            <li key={`${item.index}-${point}`}>{point}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function buildTechnicalCards(resources, decision) {
  const status = unwrap(resources.status);
  const health = unwrap(resources.systemHealth);
  const safety = unwrap(resources.safety);
  const autopilotStatus = unwrap(resources.autopilotStatus);
  const autopilotConfig = unwrap(resources.autopilotConfig);
  const pipelineStatus = unwrap(resources.pipelineStatus);
  const dailyResults = unwrap(resources.dailyResults);
  const learningConnectorStatus = unwrap(resources.learningConnectorStatus);
  const learningSummary = unwrapSummary(resources.learningSummary);
  const priority = unwrap(resources.priority);
  const optimization = unwrap(resources.optimization);
  const marketRegime = unwrap(resources.marketRegime);
  const paperStatus = unwrap(resources.paperStatus);
  const paperPerformance = unwrap(resources.paperPerformance);

  const autopilotRecentRuns = normalizeArray(autopilotStatus?.recent_runs || autopilotStatus?.status?.recent_runs);
  const lastAutopilotRun = autopilotRecentRuns.length ? autopilotRecentRuns[autopilotRecentRuns.length - 1] : null;
  const autopilotConfigData = autopilotConfig?.config || autopilotConfig || {};
  const allowedStrategies = normalizeArray(autopilotConfigData?.allowed_strategies);
  const allowedSymbols = normalizeArray(autopilotConfigData?.allowed_symbols);
  const allowedTimeframes = normalizeArray(autopilotConfigData?.allowed_timeframes);

  const connectorSummary = learningSummary?.connector || {};
  const pipelineAi = dailyResults?.ai_summary || {};
  const optimizationStats = optimization?.overallStats || optimization?.overall_stats || {};
  const bestOptimizationStrategy = optimization?.daytradingStrategies?.bestStrategy || null;
  const weakOptimizationStrategy = normalizeArray(optimization?.daytradingStrategies?.pauseCandidates || optimization?.weakConfigs || []);
  const regimeLabel = firstText([marketRegime?.regimeLabelSv, marketRegime?.regime], 'Ej konfigurerad');
  const riskLabel = marketRiskLabel(marketRegime);
  const runtimeSummary = decision.runtimeSummary || {};
  const runtimeStrategies = decision.runtimeStrategies || [];
  const topFocus = decision.topFocus || [];
  const avoidList = decision.avoidList || [];

  return [
    {
      key: 'autopilot',
      title: 'Strategy Test Autopilot',
      kicker: 'Teknisk källa 1',
      tone: autopilotStatus?.enabled ? 'ok' : 'neutral',
      badgeTone: autopilotStatus?.enabled ? 'green' : 'gray',
      statusLabel: autopilotStatus?.enabled ? 'På' : 'Av',
      summary: autopilotStatus?.enabled
        ? `Planerar testkörningar i ${textValue(autopilotConfigData?.mode, 'paper/replay/batch-only')} läge. Ingen livehandel eller auto-apply.`
        : 'Avstängd. Kan bara planera paper/replay/batch-only tester.',
      points: [
        `Intervall ${formatInt(autopilotConfigData?.interval_minutes, 'Ej konfigurerad')} min`,
        `Max ${formatInt(autopilotConfigData?.max_runs_per_day, 'Ej konfigurerad')} körningar/dygn`,
        `${allowedStrategies.length} strategier`,
        `${allowedSymbols.length} symboler`,
        `${allowedTimeframes.length} timeframes`,
        lastAutopilotRun ? `Senaste plan: ${textValue(lastAutopilotRun.summary_sv || lastAutopilotRun.message_sv, 'Plan skapad.')}` : 'Ingen körning ännu',
      ],
      source: '/api/strategy-test-autopilot/status + /config',
    },
    {
      key: 'learning',
      title: 'Learning Connector',
      kicker: 'Teknisk källa 2',
      tone: learningConnectorStatus?.connector_active !== false ? 'ok' : 'danger',
      badgeTone: learningConnectorStatus?.connector_active !== false ? 'green' : 'red',
      statusLabel: learningConnectorStatus?.connector_active !== false ? 'Aktiv' : 'Av',
      summary: bestText(
        learningSummary?.connector?.win_rate != null ? `Samlar lärdomar med ${winRateText(learningSummary.connector.win_rate, learningSummary?.connector?.total_events)}.` : '',
        connectorSummary?.by_source ? 'Samlar händelser från flera källor.' : '',
        learningSummary?.connector?.avg_pnl_pct != null ? `Snitt-P/L ${formatSignedPct(learningSummary.connector.avg_pnl_pct, 2)}.` : '',
      ),
      points: [
        `${formatInt(learningConnectorStatus?.total_events, 'Ingen data ännu')} events totalt`,
        `${formatInt(connectorSummary?.total_events, 'Ingen data ännu')} i senaste summaryn`,
        `${formatInt(learningSummary?.strategies_count, 'Ingen data ännu')} strategier med lärande`,
        `Paper ${learningConnectorStatus?.paper_connected ? 'på' : 'av'}`,
        `Replay ${learningConnectorStatus?.replay_connected ? 'på' : 'av'}`,
        `Batch ${learningConnectorStatus?.batch_connected ? 'på' : 'av'}`,
        `Scanner ${learningConnectorStatus?.sources_connected?.scanner ? 'på' : 'av'}`,
      ],
      source: '/api/learning/connector/status + /learning/latest-summary',
    },
    {
      key: 'pipeline',
      title: 'Daily Intelligence Pipeline',
      kicker: 'Teknisk källa 3',
      tone: pipelineStatus?.pipeline_status === 'completed' || pipelineStatus?.pipeline_status === 'completed_with_warnings' ? 'ok' : 'neutral',
      badgeTone: pipelineStatus?.pipeline_status === 'completed' || pipelineStatus?.pipeline_status === 'completed_with_warnings' ? 'green' : 'gray',
      statusLabel: textValue(pipelineStatus?.pipeline_status, 'Ej konfigurerad'),
      summary: bestText(
        pipelineAi.main_conclusion_sv,
        dailyResults?.conclusion_sv,
        pipelineStatus?.last_run_message_sv,
      ),
      points: [
        `Körningar ${formatInt(pipelineStatus?.total_runs, 'Ingen data ännu')}`,
        `Senaste körning ${ageText(pipelineStatus?.last_run_at)}`,
        `Replay ${textValue(dailyResults?.replay?.status, 'Ingen data ännu')}`,
        `Batch ${textValue(dailyResults?.batch?.status, 'Ingen data ännu')}`,
        `Paper ${textValue(dailyResults?.paper?.status, 'Ingen data ännu')}`,
        normalizeArray(pipelineAi.next_test_plan).length ? `${normalizeArray(pipelineAi.next_test_plan).length} nästa-test-punkter` : 'Inga nästa-test-punkter',
      ],
      source: '/api/pipeline/daily/status + /results/daily-intelligence + /pipeline/daily/recent',
    },
    {
      key: 'priority',
      title: 'Priority Engine',
      kicker: 'Teknisk källa 4',
      tone: normalizeArray(priority?.topFocus).length > 0 ? 'ok' : 'neutral',
      badgeTone: normalizeArray(priority?.topFocus).length > 0 ? 'green' : 'gray',
      statusLabel: normalizeArray(priority?.topFocus).length > 0 ? 'Fokuserad' : 'Avvaktar',
      summary: bestText(
        priority?.insights?.[0],
        priority?.marketContext?.regimeLabelSv,
        priority?.marketContext?.riskEnvLabelSv,
      ),
      points: [
        `${formatInt(normalizeArray(priority?.topFocus).length, 'Ingen data ännu')} top focus`,
        `${formatInt(normalizeArray(priority?.watchlist).length, 'Ingen data ännu')} watchlist`,
        `${formatInt(normalizeArray(priority?.avoid).length, 'Ingen data ännu')} avoid`,
        textValue(priority?.marketContext?.regimeLabelSv, 'Ej konfigurerad'),
        textValue(priority?.marketContext?.riskEnvLabelSv, 'Ej konfigurerad'),
      ],
      source: '/api/priority/summary',
    },
    {
      key: 'optimization',
      title: 'AI Optimization Agent',
      kicker: 'Teknisk källa 5',
      tone: normalizeArray(optimization?.topConfigs).length > 0 ? 'ok' : 'neutral',
      badgeTone: normalizeArray(optimization?.topConfigs).length > 0 ? 'green' : 'gray',
      statusLabel: normalizeArray(optimization?.topConfigs).length > 0 ? 'Har signaler' : 'Tom',
      summary: bestText(
        optimization?.recommendations?.green?.[0],
        optimization?.recommendations?.yellow?.[0],
        optimization?.recommendations?.red?.[0],
        bestOptimizationStrategy?.strategy_name ? `Bäst hittills: ${bestOptimizationStrategy.strategy_name}.` : '',
      ),
      points: [
        `Trades ${formatInt(optimizationStats?.n || optimization?.tradeCount, 'Ingen data ännu')}`,
        bestOptimizationStrategy?.strategy_name ? `Bäst: ${bestOptimizationStrategy.strategy_name}` : 'Bäst: Ej konfigurerad',
        normalizeArray(optimization?.weakConfigs).length ? `${formatInt(normalizeArray(optimization?.weakConfigs).length)} weak configs` : 'Inga weak configs',
        weakOptimizationStrategy.length ? `Pause candidates ${weakOptimizationStrategy.length}` : 'Inga pause candidates',
      ],
      source: '/api/optimization/summary',
    },
    {
      key: 'regime',
      title: 'Market Regime',
      kicker: 'Teknisk källa 6',
      tone: 'neutral',
      badgeTone: 'blue',
      statusLabel: riskLabel,
      summary: bestText(
        marketRegime?.recommendations?.[0]?.textSv,
        `${regimeLabel} · ${riskLabel}`,
      ),
      points: [
        `Volatilitet ${marketVolatilityLabel(marketRegime)}`,
        `Trend ${textValue(pickText(marketRegime, [['trendLabelSv'], ['trendState']], ''), 'Ej konfigurerad')}`,
        `Risk ${riskLabel}`,
        normalizeArray(marketRegime?.strategyWeights?.topStrategies).length ? `${normalizeArray(marketRegime.strategyWeights.topStrategies).length} top-strategier` : 'Inga top-strategier',
      ],
      source: '/api/market-regime/status',
    },
    {
      key: 'paper',
      title: 'Paper Trading',
      kicker: 'Teknisk källa 7',
      tone: paperStatus?.enabled ? 'ok' : 'neutral',
      badgeTone: paperStatus?.enabled ? 'green' : 'gray',
      statusLabel: paperStatus?.enabled ? 'På' : 'Av',
      summary: bestText(
        paperStatus?.messageSv,
        paperPerformance?.conclusion_sv,
        `${textValue(paperPerformance?.best_strategy, 'Ej konfigurerad')} fungerar bäst i paper just nu.`,
      ),
      points: [
        `Öppna ${formatInt(paperStatus?.openCount, 'Ingen data ännu')}`,
        `Win rate ${formatPct(paperPerformance?.win_rate, 1, 'Ingen data ännu')} (${winRateConfidence(paperPerformance?.trades ?? paperPerformance?.total_trades ?? paperPerformance?.count)})`,
        `Timeout ${formatPct(paperPerformance?.timeout_rate, 0, 'Ingen data ännu')}`,
        `Snitt-P/L ${formatSignedPct(paperPerformance?.avg_pnl, 2, 'Ingen data ännu')}`,
        paperPerformance?.latest_trade?.symbol ? `Senaste trade ${paperPerformance.latest_trade.symbol}` : 'Senaste trade: Ingen data ännu',
      ],
      source: '/api/paper-trading/status + /performance',
    },
    {
      key: 'runtime',
      title: 'Daytrading Runtime',
      kicker: 'Teknisk källa 8',
      tone: 'neutral',
      badgeTone: 'blue',
      statusLabel: 'Read-only',
      summary: bestText(
        `Katalogstrategier: ${formatInt(runtimeSummary.total_catalog_strategies, 'Ingen data ännu')}.`,
        `Kan skapa paper trades: ${formatInt(runtimeSummary.can_create_paper_trade_count, 'Ingen data ännu')}.`,
      ),
      points: [
        `Valda ${formatInt(runtimeSummary.enabled_by_user, 'Ingen data ännu')}`,
        `Kan skapa paper trades ${formatInt(runtimeSummary.can_create_paper_trade_count, 'Ingen data ännu')}`,
        `Saknar entry-regel ${formatInt(runtimeSummary.runtime_no_entry_rule, 'Ingen data ännu')}`,
        `Saknar mapping ${formatInt(runtimeSummary.runtime_not_connected, 'Ingen data ännu')}`,
        `Paper trades 48h ${formatInt(runtimeSummary.paper_trades_48h, 'Ingen data ännu')}`,
        `Runtime-strategier ${formatInt(runtimeStrategies.length, 'Ingen data ännu')}`,
      ],
      source: '/api/daytrading/runtime-strategies',
    },
  ];
}

function buildDecisionModel(resources) {
  const status = unwrap(resources.status);
  const health = unwrap(resources.systemHealth);
  const safety = unwrap(resources.safety);
  const autopilotStatus = unwrap(resources.autopilotStatus);
  const autopilotConfig = unwrap(resources.autopilotConfig);
  const pipelineStatus = unwrap(resources.pipelineStatus);
  const dailyResults = unwrap(resources.dailyResults);
  const learningConnectorStatus = unwrap(resources.learningConnectorStatus);
  const learningSummary = unwrapSummary(resources.learningSummary);
  const priority = unwrap(resources.priority);
  const optimization = unwrap(resources.optimization);
  const marketRegime = unwrap(resources.marketRegime);
  const paperStatus = unwrap(resources.paperStatus);
  const paperPerformance = unwrap(resources.paperPerformance);
  const recommendation = unwrap(resources.recommendation);
  const runtime = unwrap(resources.runtimeStrategies);

  const runtimeSummary = runtime?.summary || {};
  const runtimeStrategies = normalizeArray(runtime?.strategies);
  const topFocus = normalizeArray(priority?.topFocus || []);
  const avoidList = normalizeArray(priority?.avoid || []);

  const selectedStrategies = runtimeStrategies.filter((strategy) => strategy.enabled_by_user === true);
  const runnableStrategies = runtimeStrategies.filter((strategy) => strategy.can_create_paper_trade === true);
  const selectedButNotRunnable = selectedStrategies.filter((strategy) => strategy.can_create_paper_trade !== true);
  const noEntryRule = runtimeStrategies.filter((strategy) => strategy.runtime_status === 'no_entry_rule');
  const noMapping = runtimeStrategies.filter((strategy) => strategy.runtime_status === 'not_connected');
  const selectedButNotRunnableCount = selectedButNotRunnable.length;
  const paperTradeCount = toNumber(runtimeSummary.can_create_paper_trade_count) ?? runnableStrategies.length;
  const selectedCount = toNumber(runtimeSummary.enabled_by_user) ?? selectedStrategies.length;
  const noEntryRuleCount = toNumber(runtimeSummary.runtime_no_entry_rule) ?? noEntryRule.length;
  const noMappingCount = toNumber(runtimeSummary.runtime_not_connected) ?? noMapping.length;

  const systemProblems = uniqueText([
    ...normalizeArray(safety?.warnings),
    ...normalizeArray(health?.issues),
    ...normalizeArray(health?.warnings),
    ...(paperPerformance?.timeout_rate != null && toNumber(paperPerformance.timeout_rate) >= 30 ? [`Paper trading timeout-rate ${formatPct(paperPerformance.timeout_rate, 0)}.`] : []),
    ...(learningSummary?.connector?.avg_pnl_pct != null ? [] : ['Learning summary saknar P/L-underlag.']),
    ...(learningConnectorStatus?.errors?.length ? [`Learning Connector har ${formatInt(learningConnectorStatus.errors.length)} fel i kö.`] : []),
    ...(pipelineStatus?.warnings?.length ? [`Pipeline har ${formatInt(pipelineStatus.warnings.length)} varningar.`] : []),
    ...(status?.ok === false ? ['Backend svarar inte.'] : []),
    ...(health?.ok === false ? ['Systemhälsa är inte tillgänglig.'] : []),
    ...(runtime?.ok === false ? ['Daytrading runtime-data är inte tillgänglig.'] : []),
  ]);

  const marketMode = marketRiskLabel(marketRegime);
  const volatilityText = marketVolatilityLabel(marketRegime);
  const systemStatus = systemProblems.length > 0 ? 'Problem' : 'Stabilt';
  const tradingMode = SAFETY_FLAGS.live_trading_enabled ? 'Live blockerad' : 'Endast test';

  const bestStrategy = recommendation?.best_strategy
    || optimization?.daytradingStrategies?.bestStrategy
    || topFocus[0]
    || null;
  const avoidStrategy = recommendation?.avoid_strategy
    || optimization?.daytradingStrategies?.pauseCandidates?.[0]
    || avoidList[0]
    || null;

  const recommendedKeys = collectStrategyKeys([
    bestStrategy,
    ...normalizeArray(dailyResults?.ai_summary?.recommended_strategies),
    ...normalizeArray(optimization?.recommendations?.green),
    ...topFocus,
  ]);
  const avoidKeys = collectStrategyKeys([
    avoidStrategy,
    ...normalizeArray(dailyResults?.ai_summary?.strategies_to_avoid),
    ...normalizeArray(optimization?.recommendations?.red),
    ...avoidList,
  ]);
  const conflictKeys = [...recommendedKeys].filter((key) => avoidKeys.has(key));
  const hasConflict = conflictKeys.length > 0;

  const selectedButNotRunnableLabel = selectedButNotRunnableCount > 0
    ? `${selectedButNotRunnableCount} strategier är valda men inte körbara`
    : 'Inga valda strategier är blockerade';
  const entryRuleLabel = noEntryRuleCount > 0
    ? `${noEntryRuleCount} saknar entry-regel`
    : 'Ingen strategi saknar entry-regel';
  const mappingLabel = noMappingCount > 0
    ? `${noMappingCount} saknar mapping till runtime`
    : 'Ingen strategi saknar mapping';

  const systemSummary = systemProblems.length === 0
    ? `Systemet är stabilt och ${paperTradeCount} strategier kan faktiskt skapa paper trades.`
    : `Systemet är stabilt, men endast ${paperTradeCount} strategier kan faktiskt skapa paper trades. ${selectedButNotRunnableCount} strategier är valda men saknar körbar koppling.`;

  const systemSummaryExtra = uniqueText([
    selectedCount > 0 ? `${selectedCount} strategier är valda.` : '',
    noEntryRuleCount > 0 ? `${noEntryRuleCount} strategier saknar entry-regel.` : '',
    noMappingCount > 0 ? `${noMappingCount} strategier saknar mapping till runtime.` : '',
    paperTradeCount > 0 ? `${paperTradeCount} strategier kan skapa paper trades.` : 'Ingen strategi kan skapa paper trades ännu.',
  ]);

  const bestReason = bestText(
    recommendation?.recommendation_sv,
    pickText(bestStrategy, [['reason_sv'], ['reason'], ['note_sv'], ['message_sv'], ['message'], ['conclusion_sv']], ''),
    priority?.insights?.[0],
    optimization?.recommendations?.green?.[0],
    dailyResults?.ai_summary?.recommended_strategies?.[0],
  );
  const avoidReason = bestText(
    pickText(avoidStrategy, [['reason_sv'], ['reason'], ['note_sv'], ['message_sv'], ['message'], ['conclusion_sv']], ''),
    priority?.avoid?.[0],
    optimization?.recommendations?.red?.[0],
    dailyResults?.ai_summary?.strategies_to_avoid?.[0],
  );

  const mixedSignalSummary = 'Blandad signal — kräver mer testdata';
  const bestKey = strategyKey(bestStrategy);
  const avoidKey = strategyKey(avoidStrategy);
  const bestMixed = hasConflict && (conflictKeys.includes(bestKey) || bestKey === avoidKey);
  const avoidMixed = hasConflict && (conflictKeys.includes(avoidKey) || bestKey === avoidKey);

  const bestCardSummary = bestMixed
    ? mixedSignalSummary
    : bestText(
        `${strategyDescriptor(bestStrategy)}.`,
        bestReason,
        bestStrategy ? winRateText(bestStrategy.win_rate ?? bestStrategy.winRate, bestStrategy.trades ?? bestStrategy.count) : '',
      );
  const avoidCardSummary = avoidMixed
    ? mixedSignalSummary
    : bestText(
        `${strategyDescriptor(avoidStrategy)}.`,
        avoidReason,
        avoidStrategy ? winRateText(avoidStrategy.win_rate ?? avoidStrategy.winRate, avoidStrategy.trades ?? avoidStrategy.count) : '',
      );

  const bestPoints = uniqueText([
    strategyDescriptor(bestStrategy),
    bestStrategy?.symbol ? `Symbol ${bestStrategy.symbol}` : '',
    bestStrategy?.market_group || bestStrategy?.market ? `Marknad ${bestStrategy.market_group || bestStrategy.market}` : '',
    bestStrategy?.timeframe ? `Timeframe ${bestStrategy.timeframe}` : '',
    bestStrategy ? winRateText(bestStrategy.win_rate ?? bestStrategy.winRate, bestStrategy.trades ?? bestStrategy.count) : '',
  ]);

  const avoidPoints = uniqueText([
    strategyDescriptor(avoidStrategy),
    avoidStrategy?.symbol ? `Symbol ${avoidStrategy.symbol}` : '',
    avoidStrategy?.market_group || avoidStrategy?.market ? `Marknad ${avoidStrategy.market_group || avoidStrategy.market}` : '',
    avoidStrategy?.timeframe ? `Timeframe ${avoidStrategy.timeframe}` : '',
    avoidStrategy ? winRateText(avoidStrategy.win_rate ?? avoidStrategy.winRate, avoidStrategy.trades ?? avoidStrategy.count) : '',
  ]);

  const problemPoints = uniqueText([
    selectedButNotRunnableLabel,
    entryRuleLabel,
    mappingLabel,
    paperTradeCount > 0 ? `${paperTradeCount} strategier kan skapa paper trades` : 'Ingen strategi kan skapa paper trades ännu',
    systemProblems[0] || '',
  ]);

  const actionItems = [];
  if (marketMode === 'Risk-Off') {
    actionItems.push('Var försiktig med long-signaler. Prioritera test och riskkontroll.');
  }
  if (selectedButNotRunnableCount > 0) {
    actionItems.push('Gå till Daytrading och kontrollera Runtime Ready-strategier.');
  }
  if (noEntryRuleCount > 0) {
    actionItems.push('Implementera entry-regler för strategier som är valda men inte körbara.');
  }
  if (noMappingCount > 0) {
    actionItems.push('Koppla strategier som saknar mapping till runtime.');
  }
  if (hasConflict) {
    actionItems.push('Kontrollera strategikonflikten i Insikter/Daytrading.');
  }
  if (actionItems.length === 0) {
    actionItems.push('Testa den bästa strategin i paper och följ upp win rate med fler trades.');
  }

  const recommendationLabel = systemProblems.length > 0 || marketMode === 'Risk-Off'
    ? 'Undvik'
    : bestStrategy && paperTradeCount > 0
      ? 'Testa'
      : 'Vänta';

  const riskSafetyPoints = uniqueText([
    `Market regime: ${marketMode}`,
    `Volatilitet: ${volatilityText}`,
    `actions_allowed=${SAFETY_FLAGS.actions_allowed}`,
    `can_place_orders=${SAFETY_FLAGS.can_place_orders}`,
    `live_trading_enabled=${SAFETY_FLAGS.live_trading_enabled}`,
    'Supervisor är read-only. Den visar beslut och rekommendationer, men ändrar inte strategier.',
    marketMode === 'Risk-Off' ? 'Var försiktig med long-signaler. Prioritera test och riskkontroll.' : '',
  ]);

  const glossary = [
    ['Risk-Off', 'Marknaden är försiktig. Då är det klokt att ta färre trades och skydda kapitalet.'],
    ['Paper Trading', 'Testaffärer med låtsaspengar. Inga riktiga ordrar skickas.'],
    ['Autopilot', 'En funktion som planerar tester automatiskt, men fortfarande bara i testläge.'],
    ['Replay', 'Spelar upp historik för att se hur en strategi hade fungerat.'],
    ['Batch', 'Kör många testkombinationer i ett paket för att jämföra resultat.'],
    ['Win rate', 'Andelen trades som slutade med vinst.'],
    ['Priority focus', 'Systemets korta lista över det som bör tittas på först.'],
    ['Avoid', 'Det som systemet tycker att du bör undvika just nu.'],
  ];

  const systemConclusion = systemSummaryExtra.length
    ? `${systemSummary} ${systemSummaryExtra.join(' ')}`.trim()
    : systemSummary;

  return {
    status,
    health,
    safety,
    autopilotStatus,
    pipelineStatus,
    learningConnectorStatus,
    priority,
    optimization,
    marketRegime,
    paperStatus,
    paperPerformance,
    recommendation,
    runtime,
    runtimeSummary,
    runtimeStrategies,
    topFocus,
    avoidList,
    selectedStrategies,
    runnableStrategies,
    selectedButNotRunnable,
    noEntryRule,
    noMapping,
    selectedCount,
    paperTradeCount,
    selectedButNotRunnableCount,
    noEntryRuleCount,
    noMappingCount,
    marketMode,
    volatilityText,
    systemStatus,
    tradingMode,
    recommendationLabel,
    systemSummary,
    systemConclusion,
    bestStrategy,
    avoidStrategy,
    bestCardSummary,
    avoidCardSummary,
    bestPoints,
    avoidPoints,
    problemPoints,
    actionItems: actionItems.slice(0, 3),
    riskSafetyPoints,
    hasConflict,
    conflictKeys,
    conflictMessage: hasConflict
      ? 'Strategikonflikt upptäckt: samma strategi förekommer både som rekommenderad och att undvika. Kontrollera datakällor i Insikter/Daytrading.'
      : '',
    mixedSignalSummary,
    mixedBest: bestMixed,
    mixedAvoid: avoidMixed,
    systemProblems,
    glossary,
    selectedButNotRunnableLabel,
    entryRuleLabel,
    mappingLabel,
    loadingMessage: 'Laddar Supervisor v2...',
  };
}

function buildEndpointRows(resources) {
  return ENDPOINTS.map((spec) => {
    const entry = resources[spec.key];
    const state = endpointState(entry);
    return {
      ...spec,
      state,
      ok: !!entry?.ok,
      missing: !!entry?.missing,
      error: entry?.error || '',
    };
  });
}

export default function SupervisorV2Page() {
  const [resources, setResources] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [advisorWindow, setAdvisorWindow] = useState('1d');
  const [advisorResources, setAdvisorResources] = useState({});
  const [advisorLoading, setAdvisorLoading] = useState(true);
  const [advisorError, setAdvisorError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      const entries = await Promise.all(
        ENDPOINTS.map(async (spec) => [spec.key, await fetchJson(spec.url)]),
      );
      if (cancelled) return;
      setResources(Object.fromEntries(entries));
      setLastUpdated(new Date().toISOString());
      setLoading(false);
      setRefreshing(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAdvisor() {
      setAdvisorLoading(true);
      setAdvisorError('');
      try {
        const entries = await Promise.all(
          ADVISOR_WINDOWS.map(async (spec) => [spec.key, await fetchJson(`/api/supervisor/operations-advisor?window=${spec.key}`)]),
        );
        if (cancelled) return;
        setAdvisorResources(Object.fromEntries(entries));
      } catch (err) {
        if (cancelled) return;
        setAdvisorError(err?.message || 'Kunde inte läsa AI Operations Advisor.');
      } finally {
        if (!cancelled) setAdvisorLoading(false);
      }
    }

    loadAdvisor();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const entries = await Promise.all(
        ENDPOINTS.map(async (spec) => [spec.key, await fetchJson(spec.url)]),
      );
      setResources(Object.fromEntries(entries));
      setLastUpdated(new Date().toISOString());
      setAdvisorLoading(true);
      setAdvisorError('');
      const advisorEntries = await Promise.all(
        ADVISOR_WINDOWS.map(async (spec) => [spec.key, await fetchJson(`/api/supervisor/operations-advisor?window=${spec.key}`)]),
      );
      setAdvisorResources(Object.fromEntries(advisorEntries));
    } catch (err) {
      setAdvisorError(err?.message || 'Kunde inte uppdatera AI Operations Advisor.');
    } finally {
      setRefreshing(false);
      setAdvisorLoading(false);
    }
  }

  const model = useMemo(() => buildDecisionModel(resources), [resources]);
  const endpointRows = useMemo(() => buildEndpointRows(resources), [resources]);
  const technicalCards = useMemo(() => buildTechnicalCards(resources, model), [resources, model]);
  const advisorRows = useMemo(() => ADVISOR_WINDOWS.map((spec) => {
    const entry = advisorResources[spec.key];
    const state = endpointState(entry);
    return {
      ...spec,
      state,
      ok: !!entry?.ok,
      missing: !!entry?.missing,
      error: entry?.error || '',
      data: entry?.data || null,
    };
  }), [advisorResources]);
  const selectedAdvisor = advisorResources[advisorWindow]?.data || null;

  const moduleCoverageText = `${technicalCards.length}/8 källor svarar`;
  const summaryTone = model.systemStatus === 'Stabilt' ? 'good' : 'bad';
  const recommendationTone = recommendationPillTone(model.recommendationLabel);

  return (
    <div className="sup-page sup-v2-page">
      <div className="sup-hero sup-v2-hero">
        <div className="sup-hero-copy">
          <div className="sup-kicker">AI Supervisor — Beslutsrapport</div>
          <h1>Read-only beslutsläge för Trading OS v2</h1>
          <p>
            Den här sidan läser befintliga endpoints och gör dem lättare att förstå för en nybörjare.
            Den ändrar inte strategier, aktiverar inte tester och påverkar inte live trading.
          </p>
          <div className="sup-safety-copy">
            Supervisor är read-only. Den visar beslut och rekommendationer, men ändrar inte strategier.
          </div>
        </div>
      <div className="sup-hero-actions">
        <button type="button" className="btn sup-refresh" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Uppdaterar...' : 'Uppdatera'}
        </button>
        <div className="sup-last-updated">Senast uppdaterad: {formatDateTime(lastUpdated)}</div>
      </div>
    </div>

      <section className="sup-section sup-advisor-section">
        <div className="sup-section-head">
          <div>
            <h2>🧠 AI Operations Advisor</h2>
            <p>Read-only läsning av senaste timmen, idag, 7 dagar eller 30 dagar. Ingen trading, inga ordrar.</p>
          </div>
          <div className="sup-advisor-safety">
            <span>actions_allowed=false</span>
            <span>can_place_orders=false</span>
            <span>live_trading_enabled=false</span>
          </div>
        </div>

        <div className="sup-advisor-window-strip">
          {advisorRows.map((row) => {
            const summary = row.data?.summary || {};
            const lead = summary.conclusion_sv || summary.short_sv || row.state.label;
            return (
              <button
                key={row.key}
                type="button"
                className={`sup-advisor-window-btn sup-advisor-window-${row.state.tone}${advisorWindow === row.key ? ' sup-advisor-window-active' : ''}`}
                onClick={() => setAdvisorWindow(row.key)}
              >
                <span>{row.label}</span>
                <small>{lead}</small>
              </button>
            );
          })}
        </div>

        {advisorLoading && <div className="sup-loading">Laddar AI Operations Advisor...</div>}
        {advisorError && <div className="sup-error">{advisorError}</div>}

        {!advisorLoading && selectedAdvisor && (
          <>
            <div className="sup-v2-report-lead sup-advisor-lead">
              <div className="sup-advisor-lead-copy">
                <div className="sup-kicker">Fönster: {selectedAdvisor.window_label_sv}</div>
                <h3>{selectedAdvisor.summary.conclusion_sv}</h3>
                <p>{selectedAdvisor.summary.short_sv}</p>
              </div>
              <div className="sup-advisor-lead-meta">
                <span>Uppdaterad: {formatDateTime(selectedAdvisor.generated_at)}</span>
                <span>Signaler: {formatInt(selectedAdvisor.window_metrics.signals_seen, '0')}</span>
                <span>Paper trades: {formatInt(selectedAdvisor.window_metrics.paper_trades_created, '0')}</span>
                <span>VWAP: {selectedAdvisor.crypto_status.vwap_routing_status}</span>
              </div>
            </div>

            <div className="sup-v2-answer-grid sup-advisor-grid">
              <DecisionCard
                item={{
                  index: '1',
                  title: 'Kort slutsats',
                  tone: 'ok',
                  badgeTone: 'green',
                  badge: selectedAdvisor.summary.next_action_sv || 'Analys',
                  summary: selectedAdvisor.summary.conclusion_sv,
                  points: uniqueText([
                    `Top strategy: ${selectedAdvisor.summary.top_strategy_sv || 'saknas'}`,
                    `Top blocker: ${selectedAdvisor.summary.top_blocker_sv || 'saknas'}`,
                  ]),
                }}
              />
              <DecisionCard
                item={{
                  index: '2',
                  title: 'Vad systemet såg',
                  tone: 'neutral',
                  badgeTone: 'blue',
                  badge: `${formatInt(selectedAdvisor.window_metrics.signals_seen, '0')} signaler`,
                  summary: selectedAdvisor.summary.short_sv,
                  points: uniqueText([
                    `Paper trades: ${formatInt(selectedAdvisor.window_metrics.paper_trades_created, '0')}`,
                    `Skippade signaler: ${formatInt(selectedAdvisor.window_metrics.learning_skipped, '0')}`,
                    `Öppna trades: ${formatInt(selectedAdvisor.window_metrics.open_trades, '0')}`,
                    selectedAdvisor.findings?.[0]?.text || '',
                  ]),
                }}
              />
              <DecisionCard
                item={{
                  index: '3',
                  title: 'Vad stoppades',
                  tone: 'warn',
                  badgeTone: selectedAdvisor.blockers?.length ? 'yellow' : 'green',
                  badge: selectedAdvisor.blockers?.length ? `${selectedAdvisor.blockers.length} blockerare` : 'Inga tydliga stopp',
                  summary: selectedAdvisor.findings?.find((item) => item.label === 'Vad stoppades')?.text || 'Inga tydliga stopp i detta fönster.',
                  points: normalizeArray(selectedAdvisor.blockers).length
                    ? selectedAdvisor.blockers.slice(0, 4).map((item) => `${item.label} (${item.count})`)
                    : ['Inga tydliga blockerare just nu.'],
                }}
              />
              <DecisionCard
                item={{
                  index: '4',
                  title: 'Strategier som fungerar',
                  tone: 'ok',
                  badgeTone: selectedAdvisor.strategy_highlights?.working?.length ? 'green' : 'gray',
                  badge: selectedAdvisor.strategy_highlights?.working?.length ? `${selectedAdvisor.strategy_highlights.working.length} fungerar` : 'Behöver mer data',
                  summary: selectedAdvisor.findings?.find((item) => item.label === 'Strategier som fungerar')?.text || 'Ingen strategi har tillräckligt med positiv historik ännu.',
                  points: selectedAdvisor.strategy_highlights?.working?.length
                    ? selectedAdvisor.strategy_highlights.working.slice(0, 4).map((item) => `${item.name} · ${item.win_rate}% WR · ${item.closed} trades`)
                    : ['Kör mer paper/replay för att få en stabil vinnare.'],
                }}
              />
              <DecisionCard
                item={{
                  index: '5',
                  title: 'Blockerade / partial',
                  tone: 'warn',
                  badgeTone: (selectedAdvisor.strategy_highlights?.blocked?.length || selectedAdvisor.strategy_highlights?.partial?.length) ? 'yellow' : 'gray',
                  badge: `${(selectedAdvisor.strategy_highlights?.blocked?.length || 0) + (selectedAdvisor.strategy_highlights?.partial?.length || 0)} strategier`,
                  summary: selectedAdvisor.summary.blocked_strategy_sv,
                  points: uniqueText([
                    ...(selectedAdvisor.strategy_highlights?.blocked || []).slice(0, 3).map((item) => `${item.name} · ${item.status}`),
                    ...(selectedAdvisor.strategy_highlights?.partial || []).slice(0, 3).map((item) => `${item.name} · ${item.status}`),
                  ]).slice(0, 4),
                }}
              />
              <DecisionCard
                item={{
                  index: '6',
                  title: 'Crypto-status och nästa steg',
                  tone: selectedAdvisor.crypto_status?.vwap_routing_fungerar ? 'ok' : 'warn',
                  badgeTone: selectedAdvisor.crypto_status?.vwap_routing_fungerar ? 'green' : selectedAdvisor.crypto_status?.vwap_routing_status === 'observe-only' ? 'yellow' : 'blue',
                  badge: `VWAP ${selectedAdvisor.crypto_status?.vwap_routing_status || 'samlar data'}`,
                  summary: selectedAdvisor.summary.next_action_sv,
                  points: uniqueText([
                    `Crypto-signaler ${selectedAdvisor.crypto_status?.crypto_signals ?? 0}`,
                    `Runtime-active ${selectedAdvisor.crypto_status?.runtime_active ?? 0}`,
                    `Gate-blockade ${selectedAdvisor.crypto_status?.gate_blocked ?? 0}`,
                    `VWAP-papper ${selectedAdvisor.crypto_status?.vwap_paper_trades ?? 0}`,
                  ]),
                }}
              />
            </div>

            <div className="sup-advisor-actions">
              <button
                type="button"
                className="btn sup-ai-submit sup-advisor-ai-btn"
                onClick={() => {
                  const prompt = buildAdvisorPrompt(selectedAdvisor);
                  window.dispatchEvent(new CustomEvent('ai-copilot:open', {
                    detail: { question: prompt, autoAsk: true, source: 'supervisor-advisor' },
                  }));
                }}
              >
                Fråga AI om detta
              </button>
            </div>
          </>
        )}
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Översikt</h2>
            <p>Högst upp visas en enkel läsning av läget just nu.</p>
          </div>
        </div>

        <div className="sup-pill-grid sup-v2-pill-grid">
          <div className={`sup-pill sup-pill-${summaryTone}`}>
            <span>Systemstatus</span>
            <strong>{model.systemStatus}</strong>
          </div>
          <div className="sup-pill sup-pill-missing">
            <span>Tradingläge</span>
            <strong>{model.tradingMode}</strong>
          </div>
          <div className="sup-pill sup-pill-good">
            <span>Marknadsläge</span>
            <strong>{model.marketMode}</strong>
          </div>
          <div className={`sup-pill sup-pill-${recommendationTone}`}>
            <span>Rekommendation</span>
            <strong>{model.recommendationLabel}</strong>
          </div>
        </div>

        <div className="sup-grid sup-grid-5 sup-v2-metrics">
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Kan köra paper trades</span>
            <strong className="sup-block-value">{formatInt(model.paperTradeCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Strategier som faktiskt kan skapa paper trades.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Valda men inte körbara</span>
            <strong className="sup-block-value">{formatInt(model.selectedButNotRunnableCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Valda strategier som inte kan skapa paper trades ännu.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Saknar entry-regel</span>
            <strong className="sup-block-value">{formatInt(model.noEntryRuleCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">På men saknar den regel som behövs för att bli körbar.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Saknar mapping</span>
            <strong className="sup-block-value">{formatInt(model.noMappingCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Finns i katalogen men är inte kopplade till runtime.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Read-only</span>
            <strong className="sup-block-value">På</strong>
            <span className="sup-block-note">actions_allowed=false, can_place_orders=false, live_trading_enabled=false.</span>
          </article>
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>AI Supervisor — Beslutsrapport</h2>
            <p>En enkel sammanfattning av vad systemet tycker att du ska göra just nu.</p>
          </div>
        </div>
        <div className="sup-v2-answer-grid">
          <DecisionCard
            item={{
              index: 'A',
              title: 'Systemets slutsats just nu',
              tone: model.systemProblems.length > 0 ? 'warn' : 'ok',
              badgeTone: model.systemProblems.length > 0 ? 'yellow' : 'green',
              badge: model.systemStatus,
              summary: model.systemConclusion,
              points: uniqueText([
                `Kan skapa paper trades: ${formatInt(model.paperTradeCount, 'Ingen data ännu')}`,
                model.selectedButNotRunnableLabel,
                model.entryRuleLabel,
                model.mappingLabel,
              ]),
            }}
          />
          <DecisionCard
            item={{
              index: 'B',
              title: 'Bäst att testa just nu',
              tone: 'ok',
              badgeTone: 'green',
              badge: model.mixedBest ? 'Blandad signal' : model.recommendationLabel === 'Testa' ? 'Testa' : 'Bevaka',
              summary: model.bestCardSummary,
              points: model.bestPoints.length > 0 ? model.bestPoints : ['Ingen tydlig bästa strategi ännu.'],
            }}
          />
          <DecisionCard
            item={{
              index: 'C',
              title: 'Undvik just nu',
              tone: model.recommendationLabel === 'Undvik' ? 'danger' : 'warn',
              badgeTone: model.recommendationLabel === 'Undvik' ? 'red' : 'yellow',
              badge: model.mixedAvoid ? 'Blandad signal' : 'Undvik',
              summary: model.avoidCardSummary,
              points: model.avoidPoints.length > 0 ? model.avoidPoints : ['Ingen tydlig avoid-signal ännu.'],
            }}
          />
          <DecisionCard
            item={{
              index: 'D',
              title: 'Största problem',
              tone: model.systemProblems.length > 0 ? 'danger' : 'warn',
              badgeTone: model.systemProblems.length > 0 ? 'red' : 'yellow',
              badge: model.systemProblems.length > 0 ? 'Problem' : 'Bevaka',
              summary: model.systemProblems.length > 0
                ? bestText(model.systemProblems[0], model.systemProblems[1])
                : 'Inga stora blockerare syns just nu.',
              points: model.problemPoints,
            }}
          />
          <DecisionCard
            item={{
              index: 'E',
              title: 'Nästa rekommenderade åtgärd',
              tone: model.recommendationLabel === 'Undvik' ? 'warn' : 'ok',
              badgeTone: statusBadgeTone(model.recommendationLabel),
              badge: model.recommendationLabel,
              summary: bestText(model.actionItems[0], 'Ingen tydlig åtgärd ännu.'),
              points: model.actionItems,
            }}
          />
          <DecisionCard
            item={{
              index: 'F',
              title: 'Risk och safety',
              tone: model.marketMode === 'Risk-Off' ? 'danger' : 'warn',
              badgeTone: model.marketMode === 'Risk-Off' ? 'red' : 'yellow',
              badge: model.marketMode,
              summary: model.marketMode === 'Risk-Off'
                ? 'Var försiktig med long-signaler. Prioritera test och riskkontroll.'
                : bestText(model.marketMode, model.volatilityText),
              points: model.riskSafetyPoints,
            }}
          />
        </div>
        {model.hasConflict && (
          <div className="sup-safety-copy" style={{ marginTop: 12, borderColor: 'rgba(239,68,68,.32)', background: 'rgba(239,68,68,.08)', color: 'var(--red)' }}>
            {model.conflictMessage}
          </div>
        )}
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Vad ska jag göra nu?</h2>
            <p>1-3 enkla rekommendationer baserade på dagens läge.</p>
          </div>
        </div>
        <div className="sup-focus-box">
          <div className="sup-focus-title">Nästa steg</div>
          {model.actionItems.map((item, index) => (
            <div className="sup-focus-item" key={`${index}-${item}`}>
              <strong>{index + 1}</strong>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Begrepp för nybörjare</h2>
            <p>De svåra orden förklarade med enkel svensk text.</p>
          </div>
        </div>
        <div className="sup-focus-box">
          {model.glossary.map(([term, explanation]) => (
            <div className="sup-focus-item" key={term}>
              <strong>{term}</strong>
              <span>{explanation}</span>
            </div>
          ))}
        </div>
      </section>

      <details className="sup-advanced">
        <summary>Tekniska källor</summary>
        <p className="sup-muted" style={{ marginTop: 10 }}>
          Här ligger de tekniska modulerna, endpoints och debug-svar som rapporten bygger på.
        </p>
        <div className="sup-v2-module-grid" style={{ marginTop: 12 }}>
          {technicalCards.map((card) => (
            <ModuleCard key={card.key} card={card} />
          ))}
        </div>

        <div className="sup-section-head" style={{ marginTop: 16, marginBottom: 0 }}>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 900 }}>API-endpoints</h3>
            <p>Det här är bara läsning av befintliga endpoints.</p>
          </div>
        </div>
        <div className="sup-advanced-grid">
          {endpointRows.map((row) => (
            <div key={row.key} className="sup-advanced-row">
              <strong>{row.label}</strong>
              <span>{row.url}</span>
              <em>{row.state.label}</em>
            </div>
          ))}
        </div>

        <details className="sup-advanced" style={{ marginTop: 14 }}>
          <summary>Teknisk debug</summary>
          <pre className="sup-json">{JSON.stringify({
            safety_flags: SAFETY_FLAGS,
            system_status: model.systemStatus,
            trading_mode: model.tradingMode,
            market_mode: model.marketMode,
            recommendation: model.recommendationLabel,
            paper_trade_count: model.paperTradeCount,
            selected_count: model.selectedCount,
            selected_but_not_runnable: model.selectedButNotRunnableCount,
            no_entry_rule_count: model.noEntryRuleCount,
            no_mapping_count: model.noMappingCount,
            has_conflict: model.hasConflict,
            conflict_keys: model.conflictKeys,
            module_coverage: moduleCoverageText,
            last_updated: lastUpdated,
          }, null, 2)}</pre>
        </details>
      </details>

      {!loading && error && <div className="sup-error">{error}</div>}
      {loading && <div className="sup-loading">{model.loadingMessage}</div>}
    </div>
  );
}
