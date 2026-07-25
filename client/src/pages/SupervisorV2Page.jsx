import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import BeginnerInfoCard from '../components/tradingos/BeginnerInfoCard.jsx';
import EmptyLearningState from '../components/tradingos/EmptyLearningState.jsx';
import GlossaryTooltip from '../components/tradingos/GlossaryTooltip.jsx';
import QuickHelpModal from '../components/tradingos/QuickHelpModal.jsx';
import SimpleStatusCard from '../components/tradingos/SimpleStatusCard.jsx';
import {
  resolveKnownStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import { createDecisionStore } from '../stores/decisionStore.js';
import { createTradingEventStore } from '../stores/tradingEventStore.js';

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
  { key: 'daytradingLearningSummary', url: '/api/daytrading/learning-summary?hours=48&limit=200', label: 'Lärandesammanfattning' },
  { key: 'priority', url: '/api/priority/summary', label: 'Priority Engine' },
  { key: 'optimization', url: '/api/optimization/summary', label: 'AI Optimization Agent' },
  { key: 'tradingviewStatus', url: '/api/tradingview/status', label: 'TradingView status' },
  { key: 'marketRegime', url: '/api/market-regime/status', label: 'Market Regime' },
  { key: 'paperStatus', url: '/api/paper-trading/status', label: 'Paper Trading status' },
  { key: 'paperPerformance', url: '/api/paper-trading/performance', label: 'Paper Trading performance' },
  { key: 'supervisorOverview', url: '/api/supervisor/overview', label: 'Supervisor overview' },
  { key: 'runtimeStrategies', url: '/api/daytrading/runtime-strategies', label: 'Runtime-strategier' },
  { key: 'registryStatus', url: '/api/strategies/registry/status', label: 'Strategy Registry status' },
  { key: 'strategyScoreStatus', url: '/api/strategies/score/status', label: 'Strategy Score v1' },
  { key: 'testPlannerStatus', url: '/api/strategies/test-planner/status', label: 'Strategy Test Planner v1' },
  { key: 'testQueueStatus', url: '/api/strategies/test-queue/status', label: 'Manual Test Queue' },
  { key: 'recommendation', url: '/api/daytrading/recommendation', label: 'Rekommendation' },
  { key: 'eventsRecent', url: '/api/events/recent?n=100', label: 'Recent trading events' },
  { key: 'eventsStatus', url: '/api/events/status', label: 'Event system status' },
  { key: 'paperAllowlistStatus', url: '/api/automation/paper-allowlist/status', label: 'Paper allowlist status' },
  { key: 'paperEvents', url: '/api/paper-trading/events?limit=100', label: 'Paper Trading events' },
  { key: 'candidatesRecent', url: '/api/candidates/recent', label: 'Candidates recent' },
  { key: 'replaySessions', url: '/api/replay/sessions', label: 'Replay sessions' },
  { key: 'dataCoverageStatus', url: '/api/data-coverage/status', label: 'Data coverage status' },
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

function queueItemStatus(item) {
  return String(item?.status || '').toLowerCase();
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
  const topWorking = normalizeArray(highlights.working).slice(0, 2).map((row) => {
    const winRate = formatPct(row.win_rate, 0, 'Ej konfigurerad');
    const closed = formatInt(row.closed, 'Ej konfigurerad');
    return `${row.name} (${winRate} WR, ${closed} trades)`;
  }).join(', ');
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
    `Crypto-status: signaler ${formatInt(crypto.crypto_signals, 'Ej konfigurerad')}, runtime-active ${formatInt(crypto.runtime_active, 'Ej konfigurerad')}, gate-blockade ${formatInt(crypto.gate_blocked, 'Ej konfigurerad')}, VWAP ${crypto.vwap_routing_status || 'samlar data'}.`,
    `Rekommenderad nästa åtgärd: ${summary.next_action_sv || 'vänta och samla data'}.`,
    '',
    'Förklara kort varför inga eller få paper trades skapas och vad användaren bör testa eller bevaka härnäst.',
  ].join('\n');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
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

function activeLabel(value) {
  if (value === true) return 'Aktiv';
  if (value === false) return 'Av';
  return 'Ingen data ännu';
}

function onOffLabel(value) {
  if (value === true) return 'på';
  if (value === false) return 'av';
  return 'Ingen data ännu';
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

function supervisorV2StrategyModel(item = {}) {
  return resolveKnownStrategy(item);
}

function strategyLabel(item) {
  return strategyDisplayName(supervisorV2StrategyModel(item), '—');
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
  const model = supervisorV2StrategyModel(item);
  const raw = firstText([model.strategyId, model.strategyName, item?.strategy, item?.symbol], '');
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

function eventDetailsSummary(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return '';
  const parts = [];
  if (details.recommendation) parts.push(`Recommendation ${details.recommendation}`);
  if (details.total_trades != null) parts.push(`${details.total_trades} trades`);
  if (details.trades != null) parts.push(`${details.trades} trades`);
  if (details.win_rate != null) parts.push(`WR ${details.win_rate}%`);
  if (details.avg_pnl != null) parts.push(`avg PnL ${details.avg_pnl}`);
  if (details.total_pnl != null) parts.push(`PnL ${details.total_pnl}`);
  if (details.result) parts.push(`Result ${details.result}`);
  if (details.reason) parts.push(`${details.reason}`);
  return parts.join(' · ');
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

function renderReasonLabel(item) {
  if (item == null) return 'Okänt';
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object') {
    return item.label || item.reason || item.key || item.name || item.type || 'Okänt';
  }
  return String(item);
}

function renderReasonCount(item) {
  if (!item || typeof item !== 'object') return null;
  return toNumber(item.count);
}

function renderReasonShare(item) {
  if (!item || typeof item !== 'object') return null;
  const share = toNumber(item.share);
  if (share === null) return null;
  const pctValue = share <= 1 ? share * 100 : share;
  return `${Math.round(pctValue)}%`;
}

function eventTone(eventType) {
  const type = String(eventType || '').toLowerCase();
  if (type === 'signal.detected') return 'blue';
  if (type === 'strategy.matched') return 'blue';
  if (type === 'market_gate.allowed') return 'green';
  if (type === 'market_gate.blocked') return 'red';
  if (type === 'market_gate.observe_only') return 'yellow';
  if (type === 'paper_trade.opened') return 'green';
  if (type === 'paper_trade.closed') return 'gray';
  if (type === 'paper_trade.skipped') return 'yellow';
  if (type === 'batch.started') return 'purple';
  if (type === 'batch.completed') return 'blue';
  if (type === 'learning.summary_created') return 'purple';
  return 'gray';
}

function eventDecisionTone(decision) {
  const value = String(decision || '').toLowerCase();
  if (value === 'allowed' || value === 'paper_opened') return 'green';
  if (value === 'blocked') return 'red';
  if (value === 'observe_only') return 'yellow';
  if (value === 'paper_closed') return 'gray';
  if (value === 'no_trade') return 'gray';
  return 'gray';
}

function eventSummary(event) {
  const pieces = [];
  if (event.reason) pieces.push(event.reason);
  if (event.score != null && event.threshold != null) pieces.push(`Score ${event.score}/${event.threshold}`);
  else if (event.score != null) pieces.push(`Score ${event.score}`);
  if (event.market) pieces.push(`Market ${event.market}`);
  return pieces.length ? pieces.join(' · ') : 'Ingen extra information sparad.';
}

function commonEntry(rows, key) {
  const counts = new Map();
  for (const row of normalizeArray(rows)) {
    const value = textValue(row?.[key], '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'sv'))[0] || null;
}

function commonDerivedEntry(rows, getValue) {
  const counts = new Map();
  for (const row of normalizeArray(rows)) {
    const value = textValue(getValue(row), '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'sv'))[0] || null;
}

function eventTypeKey(event) {
  const raw = String(event?.event_type || event?.type || '').trim().toLowerCase();
  if (raw === 'gate_blocked' || raw === 'market_gate_blocked') return 'market_gate.blocked';
  if (raw === 'trade_skipped' || raw === 'paper_trade_skipped') return 'paper_trade.skipped';
  if (raw === 'trade_opened' || raw === 'paper_trade_opened') return 'paper_trade.opened';
  if (raw === 'trade_closed' || raw === 'paper_trade_closed') return 'paper_trade.closed';
  if (raw === 'signal_detected') return 'signal.detected';
  if (raw === 'strategy_matched') return 'strategy.matched';
  return raw;
}

function eventMarketValue(event) {
  return firstText([event?.market, event?.marketType, event?.marketGroup], '');
}

function eventStrategyValue(event) {
  return firstText([
    event?.strategy,
    event?.strategyId,
    event?.strategyName,
    event?.resolvedStrategyId,
    event?.resolvedStrategyName,
    event?.strategy_id,
    event?.strategy_name,
  ], '');
}

function summarizeStopReason(event) {
  const reason = textValue(event?.reason, '').trim();
  if (reason) return reason;
  const metaReason = textValue(event?.metadata?.reason_sv || event?.metadata?.reason || event?.metadata?.exit_reason_code || event?.metadata?.exit_source, '').trim();
  if (metaReason) return metaReason;
  const type = eventTypeKey(event);
  if (type === 'market_gate.blocked') return 'Market Gate blockerade signalen';
  if (type === 'market_gate.observe_only') return 'Market Gate satte observe_only';
  if (type === 'paper_trade.skipped') return 'Paper trade skippades';
  return 'Ingen tydlig stopporsak sparad';
}

function signalStopSummary(eventsResource) {
  const data = unwrap(eventsResource);
  if (!Array.isArray(data?.events)) {
    return {
      hasEvents: false,
      eventsUnavailable: true,
      totalRelevant: null,
      detected: null,
      matched: null,
      allowed: null,
      blocked: null,
      observeOnly: null,
      opened: null,
      skipped: null,
      topReason: 'Ingen eventdata från backend',
      topReasonCount: null,
      topSymbol: 'Ingen data ännu',
      topSymbolCount: null,
      topStrategy: 'Ingen data ännu',
      topStrategyCount: null,
      latestBlocked: null,
      conclusion: 'Eventfält saknas i backendsvaret.',
    };
  }
  const events = normalizeArray(data?.events);
  const counts = events.reduce((acc, event) => {
    const type = eventTypeKey(event);
    if (!type) return acc;
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const sortedEvents = [...events].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const lastBlocked = sortedEvents.find((event) => eventTypeKey(event) === 'market_gate.blocked') || null;
  const topReason = commonEntry(events, 'reason') || commonEntry(events.map((event) => ({ reason: summarizeStopReason(event) })), 'reason');
  const topSymbol = commonEntry(events, 'symbol');
  const topStrategy = commonEntry(events, 'strategy') || commonDerivedEntry(events, eventStrategyValue);
  const detected = counts['signal.detected'] || 0;
  const matched = counts['strategy.matched'] || 0;
  const allowed = counts['market_gate.allowed'] || 0;
  const blocked = counts['market_gate.blocked'] || 0;
  const observeOnly = counts['market_gate.observe_only'] || 0;
  const opened = counts['paper_trade.opened'] || 0;
  const skipped = counts['paper_trade.skipped'] || 0;
  const totalRelevant = detected + matched + allowed + blocked + observeOnly + opened + skipped;
  const strongestStop = blocked > 0
    ? 'Systemet hittar signaler, men flest stoppas i Market Gate på grund av blockerande regler.'
    : observeOnly > 0 || skipped > 0
      ? 'Systemet hittar signaler, men många hamnar i observe_only eller skippas innan paper trade.'
      : opened > 0
        ? 'Systemet hittar signaler och flera leder till paper trades.'
        : 'Systemet samlar signaler men har ännu inte visat tydliga stoppmönster.';

  return {
    hasEvents: events.length > 0,
    totalRelevant,
    detected,
    matched,
    allowed,
    blocked,
    observeOnly,
    opened,
    skipped,
    topReason: topReason?.value || 'Ingen tydlig stopporsak sparad',
    topReasonCount: topReason?.count ?? null,
    topSymbol: topSymbol?.value || 'Ingen data ännu',
    topSymbolCount: topSymbol?.count ?? null,
    topStrategy: topStrategy?.value || 'Ingen data ännu',
    topStrategyCount: topStrategy?.count ?? null,
    latestBlocked: lastBlocked,
    conclusion: strongestStop,
  };
}

function buildEventsByMarketSummary(events) {
  const rows = normalizeArray(events);
  const markets = ['crypto', 'stocks', 'nasdaq', 'unknown'];
  const normalizedMarket = (event) => {
    const raw = textValue(eventMarketValue(event), 'unknown').trim().toLowerCase();
    return markets.includes(raw) ? raw : 'unknown';
  };

  const marketRows = markets.reduce((acc, market) => {
    acc[market] = rows.filter((event) => normalizedMarket(event) === market);
    return acc;
  }, {});

  const topMarket = markets
    .map((market) => ({ market, count: marketRows[market].length }))
    .sort((a, b) => b.count - a.count || a.market.localeCompare(b.market, 'sv'))[0] || { market: 'unknown', count: 0 };

  const summaries = markets.map((market) => {
    const eventsForMarket = marketRows[market];
    const counts = eventsForMarket.reduce((acc, event) => {
      const type = eventTypeKey(event);
      if (!type) return acc;
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    const detected = counts['signal.detected'] || 0;
    const matched = counts['strategy.matched'] || 0;
    const blocked = counts['market_gate.blocked'] || 0;
    const observeOnly = counts['market_gate.observe_only'] || 0;
    const opened = counts['paper_trade.opened'] || 0;
    const skipped = counts['paper_trade.skipped'] || 0;
    const topReason = commonEntry(eventsForMarket, 'reason') || commonEntry(eventsForMarket.map((event) => ({ reason: summarizeStopReason(event) })), 'reason');
    const topSymbol = commonEntry(eventsForMarket, 'symbol');
    const topStrategy = commonEntry(eventsForMarket, 'strategy') || commonDerivedEntry(eventsForMarket, eventStrategyValue);
    const totalRelevant = detected + matched + blocked + observeOnly + opened + skipped;
    const tone = opened > 0
      ? 'green'
      : blocked > Math.max(observeOnly, skipped, opened)
        ? 'red'
        : observeOnly > 0 || skipped > 0
          ? 'yellow'
          : totalRelevant > 0
            ? 'blue'
            : 'gray';

    let interpretation = 'Inga events ännu för denna marknad.';
    if (market === 'crypto' && (detected > 0 || matched > 0) && opened === 0) {
      interpretation = 'Crypto scannas, men inga paper trades öppnades i detta eventfönster.';
    } else if (market === 'stocks' && topMarket.market === 'stocks' && topMarket.count > 0) {
      interpretation = 'Senaste eventen domineras av aktier/ETF.';
    } else if (market === 'unknown' && topMarket.market === 'unknown' && topMarket.count > 0) {
      interpretation = 'Vissa events saknar market-fält och bör förbättras senare.';
    } else if (opened > 0) {
      interpretation = 'Paper trades öppnas för denna marknad.';
    } else if (blocked > observeOnly && blocked >= 2) {
      interpretation = 'Flera signaler stoppas här innan paper trade.';
    } else if (observeOnly > 0 || skipped > 0) {
      interpretation = 'Marknaden observeras eller skippas oftare än den öppnas.';
    } else if (totalRelevant > 0) {
      interpretation = 'Det finns signaler, men få tydliga beslut ännu.';
    }

    return {
      market,
      count: eventsForMarket.length,
      detected,
      matched,
      blocked,
      observeOnly,
      opened,
      skipped,
      topReason: topReason?.value || 'Ingen tydlig stopporsak sparad',
      topReasonCount: topReason?.count ?? null,
      topSymbol: topSymbol?.value || 'Ingen data ännu',
      topSymbolCount: topSymbol?.count ?? null,
      topStrategy: topStrategy?.value || 'Ingen data ännu',
      topStrategyCount: topStrategy?.count ?? null,
      tone,
      interpretation,
      hasEvents: eventsForMarket.length > 0,
      isTopMarket: topMarket.market === market && topMarket.count > 0,
    };
  });

  return { summaries, topMarket };
}

function buildEventAiConclusion(events) {
  if (!Array.isArray(events)) {
    return {
      tone: 'gray',
      headline: 'Ingen eventdata från backend',
      conclusion: 'Eventfält saknas i backendsvaret.',
      interpretation: [
        'Det finns inget backendunderlag för en eventslutsats ännu.',
      ],
      nextStep: 'Vänta på eventdata från backend.',
      metrics: {
        detected: null,
        matched: null,
        blocked: null,
        observeOnly: null,
        opened: null,
        skipped: null,
        topReason: 'Ingen data ännu',
        topSymbol: 'Ingen data ännu',
        topStrategy: 'Ingen data ännu',
        topMarket: 'Ingen data ännu',
      },
    };
  }
  const rows = normalizeArray(events);
  if (rows.length === 0) {
    return {
      tone: 'gray',
      headline: 'Inga events ännu',
      conclusion: 'Inga events ännu. Systemet väntar på nya signaler.',
      interpretation: [
        'Det finns inget underlag ännu för att dra en slutsats.',
      ],
      nextStep: 'Ingen åtgärd behövs just nu. Vänta på nya signaler.',
      metrics: {
        detected: 0,
        matched: 0,
        blocked: 0,
        observeOnly: 0,
        opened: 0,
        skipped: 0,
        topReason: 'Ingen data ännu',
        topSymbol: 'Ingen data ännu',
        topStrategy: 'Ingen data ännu',
        topMarket: 'Ingen data ännu',
      },
    };
  }

  const counts = rows.reduce((acc, event) => {
    const type = eventTypeKey(event);
    if (!type) return acc;
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const topReason = commonEntry(rows, 'reason') || commonEntry(rows.map((event) => ({ reason: summarizeStopReason(event) })), 'reason');
  const topSymbol = commonEntry(rows, 'symbol');
  const topStrategy = commonEntry(rows, 'strategy') || commonDerivedEntry(rows, eventStrategyValue);
  const topMarket = commonEntry(rows, 'market') || commonDerivedEntry(rows, eventMarketValue);

  const detected = counts['signal.detected'] || 0;
  const matched = counts['strategy.matched'] || 0;
  const blocked = counts['market_gate.blocked'] || 0;
  const observeOnly = counts['market_gate.observe_only'] || 0;
  const opened = counts['paper_trade.opened'] || 0;
  const skipped = counts['paper_trade.skipped'] || 0;
  const allowed = counts['market_gate.allowed'] || 0;

  const totalRelevant = detected + matched + blocked + observeOnly + opened + skipped + allowed;
  const blockedDominant = blocked >= Math.max(3, observeOnly + opened);
  const observeDominant = observeOnly > blocked && observeOnly >= skipped;
  const paperDominant = opened > 0 && opened >= skipped;
  const skippedDominant = skipped > opened && skipped >= 2;
  const matchWithoutPaper = matched > 0 && opened === 0;
  const topReasonText = topReason?.value || 'Ingen tydlig stopporsak sparad';
  const topReasonLower = topReasonText.toLowerCase();

  let headline = 'Systemet hittar signaler.';
  if (blockedDominant) headline = 'Många signaler stoppas i Market Gate.';
  else if (observeDominant) headline = 'Systemet ser lägen men väljer att bara observera.';
  else if (paperDominant) headline = 'Systemet öppnar paper trades när reglerna godkänner.';
  else if (skippedDominant) headline = 'Paper trades skippas ofta efter beslutskedjan.';
  else if (matchWithoutPaper) headline = 'Strategier matchar, men inget når paper trade ännu.';
  else if (totalRelevant > 0) headline = 'Systemet hittar signaler, men flödet är fortfarande försiktigt.';

  const interpretation = [];
  if (blocked > 0) {
    interpretation.push('Många signaler stoppas i Market Gate.');
  }
  if (topReasonLower.includes('score_below_threshold')) {
    interpretation.push('Vanligaste orsaken är att score är under tröskeln.');
  } else if (topReasonLower.includes('threshold')) {
    interpretation.push(`Vanligaste orsaken verkar vara ${topReasonText}.`);
  }
  if (observeOnly > 0) {
    interpretation.push('Systemet ser lägen men väljer att bara observera.');
  }
  if (opened > 0) {
    interpretation.push('Systemet öppnar paper trades, men bara när reglerna godkänner.');
  }
  if (skipped > 0) {
    interpretation.push('Paper trades skippas ofta efter beslutskedjan.');
  }
  if (!interpretation.length) {
    interpretation.push('Flödet är aktivt men ännu inte tillräckligt tydligt för starka slutsatser.');
  }

  let nextStep = 'Fortsätt observera om signalerna är weak/uncertain.';
  if (blocked > observeOnly && blocked >= Math.max(2, opened + skipped)) {
    nextStep = 'Kontrollera Market Gate-threshold om många stoppas på score.';
  } else if (observeOnly > blocked && observeOnly >= Math.max(2, opened)) {
    nextStep = 'Kontrollera conservativeMode om nästan allt blockeras.';
  } else if (matched > 0 && opened === 0) {
    nextStep = 'Kontrollera runtime/entry-regler om strategier matchar men ingen paper trade öppnas.';
  } else if (opened > 0 && opened >= skipped && opened >= blocked) {
    nextStep = 'Ingen åtgärd behövs om paper trades öppnas normalt.';
  } else if (skipped > opened && skipped >= 2) {
    nextStep = 'Kontrollera varför paper trades skippas efter gate och riskbedömning.';
  }

  const tone = opened > 0
    ? 'green'
    : blocked > observeOnly
      ? 'red'
      : observeOnly > 0 || skipped > 0
        ? 'yellow'
        : totalRelevant > 0
          ? 'blue'
          : 'gray';

  return {
    tone,
    headline,
    conclusion: headline,
    interpretation,
    nextStep,
    metrics: {
      detected,
      matched,
      blocked,
      observeOnly,
      opened,
      skipped,
      topReason: topReasonText,
      topSymbol: topSymbol?.value || 'Ingen data ännu',
      topStrategy: topStrategy?.value || 'Ingen data ännu',
      topMarket: topMarket?.value || 'Ingen data ännu',
    },
  };
}

function topReasonRows(events) {
  const counts = new Map();
  for (const event of normalizeArray(events)) {
    const reason = firstText([
      event?.reasonSv,
      event?.reason_sv,
      event?.reason,
      event?.messageSv,
      event?.message_sv,
      event?.metadata?.reasonSv,
      event?.metadata?.reason_sv,
      event?.metadata?.reason,
      summarizeStopReason(event),
    ], '').trim();
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'sv'))
    .slice(0, 3);
}

function normalizeStrategyId(...values) {
  return firstText(values, '').trim().toLowerCase();
}

function paperEventReason(event) {
  return firstText([
    event?.reasonSv,
    event?.reason_sv,
    event?.blockedReason,
    event?.blocked_reason,
    event?.reason,
    event?.messageSv,
    event?.message_sv,
    event?.message,
    event?.metadata?.reasonSv,
    event?.metadata?.reason_sv,
    event?.metadata?.reason,
    summarizeStopReason(event),
  ], 'Okänd orsak');
}

function paperEventStrategyId(event) {
  return normalizeStrategyId(
    event?.strategyId,
    event?.resolvedStrategyId,
    event?.sourceStrategyId,
    event?.strategy_id,
    event?.strategy,
  );
}

function paperEventStrategyName(event) {
  return firstText([
    event?.strategyName,
    event?.resolvedStrategyName,
    event?.sourceStrategyName,
    event?.strategy_name,
    event?.strategyLabel,
  ], 'Okänd strategi');
}

function isPaperBlockedEvent(event) {
  const type = String(event?.type || event?.event_type || '').toLowerCase();
  const decision = String(event?.decision || '').toLowerCase();
  return type.includes('blocked') || type.includes('skip') || type.includes('gate') || decision === 'blocked' || decision === 'skipped';
}

function aggregatePaperBlocks(events, allowlistIds = new Set()) {
  const byStrategy = new Map();
  const byReason = new Map();
  let blockedByAllowlist = 0;
  let blockedByOther = 0;

  for (const event of normalizeArray(events)) {
    if (!isPaperBlockedEvent(event)) continue;
    const id = paperEventStrategyId(event);
    const name = paperEventStrategyName(event);
    const reason = paperEventReason(event);
    const key = id || name || reason || `event-${byStrategy.size + 1}`;
    const isAllowlisted = !!(id && allowlistIds.has(id));
    const row = byStrategy.get(key) || {
      id,
      name,
      count: 0,
      latestAt: '',
      latestDecision: '',
      latestReason: '',
      reasons: new Map(),
      allowlisted: isAllowlisted,
    };

    row.count += 1;
    row.allowlisted = row.allowlisted || isAllowlisted;
    row.latestReason = reason || row.latestReason;
    row.latestDecision = String(event?.decision || event?.type || '').toLowerCase() || row.latestDecision;
    const ts = String(event?.timestamp || '');
    if (!row.latestAt || ts > row.latestAt) row.latestAt = ts;
    row.reasons.set(reason, (row.reasons.get(reason) || 0) + 1);
    byStrategy.set(key, row);

    byReason.set(reason, (byReason.get(reason) || 0) + 1);
    if (reason.toLowerCase().includes('allowlist') || reason.toLowerCase().includes('approval_gate') || reason.toLowerCase().includes('not_in_allowlist')) {
      blockedByAllowlist += 1;
    } else {
      blockedByOther += 1;
    }
  }

  const strategies = [...byStrategy.values()]
    .map((row) => ({
      ...row,
      commonReason: [...row.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'sv'))[0]?.reason || 'Okänd orsak',
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'sv'));

  const reasons = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'sv'));

  return {
    totalBlocked: strategies.reduce((sum, row) => sum + row.count, 0),
    blockedByAllowlist,
    blockedByOther,
    strategies,
    reasons,
  };
}

function buildPaperTradeDiagnostics(resources, model) {
  const paperStatus = unwrap(resources.paperStatus) || {};
  const paperEventsData = unwrap(resources.paperEvents) || {};
  const allowlist = unwrap(resources.paperAllowlistStatus) || {};
  const supervisorOverview = unwrap(resources.supervisorOverview) || {};
  const paperRuntimeOverview = supervisorOverview.paperRuntimeSummary || unwrap(supervisorOverview.paperRuntimeSummary) || {};
  const paperRuntimeSummary = paperRuntimeOverview.summary || {};
  const candidates = unwrap(resources.candidatesRecent) || {};
  const candidateStats = unwrap(resources.candidatesStats) || {};
  const replay = unwrap(resources.replaySessions) || {};
  const coverage = unwrap(resources.dataCoverageStatus) || {};
  const hasRuntimeStrategies = Array.isArray(model?.runtimeStrategies);
  const hasPaperEvents = Array.isArray(paperEventsData?.events);
  const hasRecentTrades = Array.isArray(paperStatus?.recentPaperTrades);
  const hasOpenTrades = Array.isArray(paperStatus?.openTrades);
  const hasCandidateRows = Array.isArray(candidates?.candidates);
  const hasReplaySessions = Array.isArray(replay?.sessions);
  const hasAllowlistRows = Array.isArray(allowlist?.allowlist) || Array.isArray(allowlist?.approvedStrategies) || Array.isArray(allowlist?.strategies);
  const runtimeStrategies = normalizeArray(model?.runtimeStrategies);
  const runtimeStrategyRows = normalizeArray(paperRuntimeOverview?.strategies);
  const paperEvents = normalizeArray(paperEventsData?.events);
  const recentTrades = normalizeArray(paperStatus?.recentPaperTrades);
  const approvedRows = normalizeArray(allowlist?.allowlist || allowlist?.approvedStrategies || allowlist?.strategies);
  const approvedIds = new Set(approvedRows.map((row) => normalizeStrategyId(row?.id, row?.strategyId, row?.strategy_id)));
  const runtimeRowsById = new Map(
    runtimeStrategyRows
      .map((row) => [normalizeStrategyId(row?.strategy_id, row?.strategyId, row?.strategy_name, row?.strategyName), row])
      .filter(([id]) => !!id),
  );
  const recentTradeByStrategy = new Map();
  for (const trade of recentTrades) {
    const tradeId = normalizeStrategyId(trade?.strategy_id, trade?.strategyId, trade?.strategy_name, trade?.strategyName, trade?.strategy);
    if (!tradeId || recentTradeByStrategy.has(tradeId)) continue;
    recentTradeByStrategy.set(tradeId, trade);
  }
  const blocks = aggregatePaperBlocks(paperEvents, approvedIds);

  const openCount = toNumber(paperStatus?.openCount)
    ?? toNumber(paperRuntimeSummary.openCount)
    ?? (hasOpenTrades ? normalizeArray(paperStatus?.openTrades).length : null);
  const closedCount = toNumber(paperStatus?.closedCount)
    ?? toNumber(paperRuntimeSummary.closedCount)
    ?? (hasRecentTrades ? recentTrades.filter((trade) => String(trade?.status || '').toLowerCase() === 'completed').length : null);
  const blockedCount = toNumber(paperStatus?.blockedCount)
    ?? toNumber(paperRuntimeSummary.blockedCount)
    ?? (hasPaperEvents ? blocks.totalBlocked : null);
  const latestEventAt = firstText([
    paperStatus?.latestEventAt,
    paperRuntimeSummary.latestEventAt,
    paperEvents[0]?.timestamp,
    recentTrades[0]?.timestamp,
  ], '');
  const candidatesCount = toNumber(candidateStats?.total) ?? (hasCandidateRows ? normalizeArray(candidates?.candidates).length : null);
  const replayCount = hasReplaySessions ? normalizeArray(replay?.sessions).length : null;
  const coverageScore = toNumber(coverage?.total_coverage_score);
  const missingDataCount = toNumber(coverage?.symbols_missing_data);
  const paperEnabled = paperStatus?.enabled === true ? true : paperStatus?.enabled === false ? false : null;
  const allowlistApprovedCount = toNumber(allowlist?.totalApproved) ?? (hasAllowlistRows ? approvedRows.length : null);
  const allowlistReadyCount = toNumber(allowlist?.readyForPaperRuntime) ?? (hasAllowlistRows ? approvedRows.filter((row) => row?.paperRuntimeReady !== false).length : null);
  const allowlistReady = allowlist?.paperRuntimeReady === true
    ? true
    : allowlist?.paperRuntimeReady === false
      ? false
      : allowlistReadyCount !== null
        ? allowlistReadyCount > 0
        : null;
  const technicalPaperCount = toNumber(model?.paperTradeCount) ?? (hasRuntimeStrategies ? runtimeStrategies.filter((strategy) => strategy?.can_create_paper_trade === true).length : null);
  const activeCount = toNumber(model?.selectedCount) ?? (hasRuntimeStrategies ? runtimeStrategies.filter((strategy) => strategy?.enabled_by_user === true).length : null);
  const totalCount = hasRuntimeStrategies ? runtimeStrategies.length : null;
  const selectedButNotRunnableCount = toNumber(model?.selectedButNotRunnableCount) ?? (hasRuntimeStrategies ? runtimeStrategies.filter((strategy) => strategy?.enabled_by_user === true && strategy?.can_create_paper_trade !== true).length : null);

  const matrix = [
    {
      group: 'Alla strategier',
      count: totalCount,
      meaning: 'Alla strategier i runtime-katalogen.',
    },
    {
      group: 'Aktiva strategier',
      count: activeCount,
      meaning: 'Strategier som är valda eller aktiva i runtime just nu.',
    },
    {
      group: 'Tekniskt paper-kopplade',
      count: technicalPaperCount,
      meaning: 'Kan tekniskt skapa paper trades när andra regler tillåter det.',
    },
    {
      group: 'Godkända i allowlist',
      count: allowlistApprovedCount,
      meaning: 'Får skapa paper trades enligt allowlisten.',
    },
    {
      group: 'Kandidater just nu',
      count: candidatesCount,
      meaning: 'Aktuella kandidater som faktiskt kan bli paper trades nu.',
    },
    {
      group: 'Blockerade senaste perioden',
      count: blockedCount,
      meaning: 'Senaste paper-events som stoppats av allowlist, risk eller testregler.',
    },
  ];

  const approvedStrategies = approvedRows.map((row) => {
    const id = normalizeStrategyId(row?.id, row?.strategyId, row?.strategy_id);
    const runtimeRow = runtimeRowsById.get(id) || {};
    const latestTrade = recentTradeByStrategy.get(id) || null;
    const latestEventAt = firstText([
      runtimeRow?.latestEventAt,
      latestTrade?.timestamp,
      row?.latestEventAt,
    ], '');
    const blockedCount = toNumber(runtimeRow?.blockedCount);
    return {
      id: id || textValue(row?.id, 'okänd-strategi'),
      name: firstText([row?.name, runtimeRow?.strategy_name, runtimeRow?.strategyName, row?.id], 'Okänd strategi'),
      status: firstText([row?.paperRuntimeStatus, runtimeRow?.paperRuntimeStatus, row?.automaticStatus], 'Ej konfigurerad'),
      runtimeReady: row?.paperRuntimeReady === true || row?.readyForPaperRuntime === true || runtimeRow?.paperRuntimeReady === true || runtimeRow?.readyForPaperRuntime === true,
      latestEventAt,
      latestTradeAt: latestTrade?.timestamp || '',
      latestActivityAt: latestTrade?.timestamp || latestEventAt,
      latestActivityLabel: latestTrade?.timestamp
        ? `Trade ${formatDateTime(latestTrade.timestamp)}`
        : latestEventAt
          ? `Event ${formatDateTime(latestEventAt)}`
          : 'Ingen aktivitet ännu',
      latestBlockedReason: firstText([
        latestTrade?.blockedReason,
        runtimeRow?.latestBlockedReason,
        row?.latestBlockedReason,
      ], ''),
      blockedCount,
      allowlistStatus: row?.hasBlockers ? 'Har blockerare' : row?.approvedForPaperTesting === true ? 'Godkänd' : 'Okänd',
      automaticStatus: textValue(row?.automaticStatus, 'Ej angivet'),
    };
  });

  const approvedStrategyIds = new Set(approvedStrategies.map((row) => row.id));
  const blockedStrategies = blocks.strategies.map((row) => ({
    id: row.id || normalizeStrategyId(row.name),
    name: row.name || row.id || 'Okänd strategi',
    count: row.count,
    commonReason: row.commonReason,
    latestAt: row.latestAt,
    latestReason: row.latestReason,
    allowlisted: row.allowlisted || approvedStrategyIds.has(normalizeStrategyId(row.id, row.name)),
    allowlistStatus: row.allowlisted || approvedStrategyIds.has(normalizeStrategyId(row.id, row.name))
      ? 'Godkänd men stoppas av annan regel'
      : 'Ej godkänd i allowlist',
  }));

  const explanation = [];
  if (candidatesCount === 0) {
    explanation.push('Just nu finns inga aktuella kandidater att öppna paper trades på.');
  } else {
    explanation.push(`${candidatesCount} kandidater finns just nu.`);
  }

  if (blocks.blockedByAllowlist > 0) {
    explanation.push(`Allowlist stoppar fortfarande ${blocks.blockedByAllowlist} senaste blockeringar. Bara ${allowlistApprovedCount} strategier är godkända just nu.`);
  }
  if (blocks.blockedByOther > 0) {
    explanation.push('Andra stopp kommer från testregler, status Vänta eller riskmotor.');
  }
  if (missingDataCount > 0 || (coverageScore != null && coverageScore <= 20)) {
    explanation.push('Data coverage är ett separat problem. Det betyder att historik saknas, inte att allowlisten ändras.');
  }
  if (replayCount === 0) {
    explanation.push('Replay-underlag saknas ännu, så mer analys måste vänta på historisk data.');
  }
  if (paperEnabled === false) {
    explanation.push('Paper Trading är inte aktivt just nu.');
  } else if (paperEnabled === null) {
    explanation.push('Paper Trading enabled-status saknas i backendsvaret.');
  }
  if (allowlistReady && allowlistApprovedCount > 0) {
    explanation.push(`Allowlist är en säkerhetslista. Bara strategier på listan får skapa låtsasaffärer. ${allowlistApprovedCount} strategier är godkända och ${allowlistReadyCount} är redo för paper-runtime.`);
  }

  return {
    paperEnabled,
    openCount,
    closedCount,
    blockedCount,
    latestEventAt,
    candidatesCount,
    replayCount,
    coverageScore,
    missingDataCount,
    allowlist,
    approvedRows,
    allowlistApprovedCount,
    allowlistReadyCount,
    allowlistReady,
    technicalPaperCount,
    activeCount,
    totalCount,
    selectedButNotRunnableCount,
    blocks,
    matrix,
    approvedStrategies,
    blockedStrategies,
    explanation: uniqueText(explanation),
  };
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

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `API ${res.status}`);
  }
  return data;
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

function strategyCatalogStatusKey(strategy = {}) {
  const status = String(strategy.status || strategy.catalog_status || '').toLowerCase();
  if (['active', 'testing', 'paused', 'roadmap', 'legacy'].includes(status)) return status;
  if (strategy.enabled_by_user === false) return 'paused';
  return 'roadmap';
}

function strategyCatalogStatusLabel(status) {
  return {
    active: 'ACTIVE',
    testing: 'TESTING',
    paused: 'PAUSED',
    roadmap: 'ROADMAP',
    legacy: 'LEGACY',
  }[String(status || '').toLowerCase()] || 'ROADMAP';
}

// Översätter batchstatus till enkel svensk UI-text för read-only analys.
function getBatchUiStatus(batch) {
  if (!batch || !batch.id) {
    return { key: 'none', emoji: '', label: 'Ingen batch', tone: 'none', sentence: 'Ingen batch finns ännu.', busy: false };
  }
  const status = String(batch.status || '').toLowerCase();
  const total = toNumber(batch.progress?.total);
  const completed = toNumber(batch.progress?.completed);
  const done = total !== null && completed !== null && total > 0 && completed >= total;
  const hasError = !!batch.error || status === 'failed' || status === 'error';

  if (hasError) {
    return { key: 'failed', emoji: '🔴', label: 'Misslyckades', tone: 'failed', busy: false,
      sentence: 'Batch misslyckades. Något gick fel — se orsak och rekommenderad åtgärd nedan.' };
  }
  if (['preparing', 'planning', 'thinking', 'queued'].includes(status)) {
    return { key: 'thinking', emoji: '🔵', label: 'Förbereder', tone: 'thinking', busy: true,
      sentence: 'Systemet förbereder testet. Vänta några sekunder innan du gör något.' };
  }
  if (status === 'running' && !done) {
    return { key: 'running', emoji: '🟡', label: 'Körs', tone: 'running', busy: true,
      sentence: 'Batch körs just nu. Systemet testar strategier.' };
  }
  if (status === 'paused') {
    return { key: 'paused', emoji: '🟠', label: 'Pausad', tone: 'partial', busy: false,
      sentence: `Batchen är pausad efter ${completed}/${total} tester.` };
  }
  if (done && status === 'stopped') {
    return { key: 'done_stopped', emoji: '⚪', label: 'Stoppad efter färdig körning', tone: 'stopped', busy: false,
      sentence: 'Batch stoppad efter att alla tester redan var klara.' };
  }
  if (done) {
    return { key: 'done', emoji: '🟢', label: 'Klar', tone: 'done', busy: false,
      sentence: 'Batch klar. Alla tester är färdiga.' };
  }
  if (status === 'stopped') {
    return { key: 'stopped', emoji: '⚪', label: 'Stoppad – ej klar', tone: 'partial', busy: false,
      sentence: `Batchen stoppades efter ${completed}/${total} tester.` };
  }
  if (completed > 0 && completed < total) {
    return { key: 'partial', emoji: '🟠', label: 'Halvklar', tone: 'partial', busy: false,
      sentence: `Batchen hann bara köra ${completed}/${total} tester.` };
  }
  return { key: 'waiting', emoji: '⚪', label: 'Väntar', tone: 'waiting', busy: false,
    sentence: 'Batch väntar på att startas.' };
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
          {item.points.slice(0, 5).map((point) => (
            <li key={`${item.index}-${point}`}>{point}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function strategySourceBadgeTone(source) {
  if (source === 'tradingview') return 'yellow';
  if (source === 'internal') return 'blue';
  return 'gray';
}

function strategyStatusBadgeTone(status) {
  if (status === 'active' || status === 'paper_only') return 'green';
  if (status === 'experimental') return 'blue';
  if (status === 'watch') return 'yellow';
  if (status === 'paused' || status === 'deprecated') return 'red';
  return 'gray';
}

function plannerTestTypeBadgeTone(testType) {
  const type = String(testType || '').toLowerCase();
  if (type === 'replay') return 'green';
  if (type === 'batch') return 'blue';
  if (type === 'paper_observation') return 'yellow';
  if (type === 'history_review') return 'gray';
  return 'gray';
}

function queueStatusBadgeTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'pending') return 'yellow';
  if (value === 'completed') return 'green';
  if (value === 'cancelled') return 'gray';
  if (value === 'failed') return 'red';
  return 'gray';
}

function queueStrategyOriginLabel(item) {
  const source = String(item?.source || '').toLowerCase();
  if (source === 'planner') return 'Planner';
  if (source === 'tradingview') return 'TradingView';
  if (source === 'internal') return 'Intern';
  return textValue(item?.source, 'Okänd källa');
}

function queueStrategyTypeLabel(item) {
  const source = String(item?.source || '').toLowerCase();
  const strategyId = String(item?.strategy_id || '').trim().toUpperCase();
  if (source === 'tradingview' || strategyId.startsWith('TV_')) return 'TradingView-strategi';
  return 'Intern strategi';
}

function queueStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'pending') return 'Väntar på manuell granskning';
  if (value === 'cancelled') return 'Avbruten. Ingen testkörning startades.';
  if (value === 'completed') return 'Slutförd manuellt.';
  if (value === 'failed') return 'Misslyckades. Ingen automatisk körning.';
  return textValue(status, 'Okänd status');
}

function queueNextStepText(item) {
  const type = String(item?.test_type || '').toLowerCase();
  if (type === 'replay') return 'Granska strategins historik innan du kör replay manuellt.';
  if (type === 'batch') return 'Bekräfta scope och riskfrihet innan du kör batch manuellt.';
  if (type === 'paper_observation') return 'Bekräfta att scope är rimligt innan du lägger mer data.';
  if (type === 'history_review') return 'Läs historiken och jämför lärdomar innan du bestämmer nästa steg.';
  return 'Detta är bara en köpost. Inget test startas automatiskt.';
}

function queueItemPriorityLabel(priority) {
  const value = toNumber(priority);
  if (!Number.isFinite(value)) return textValue(priority, '–');
  if (value >= 8) return `Hög (${value})`;
  if (value >= 4) return `Medel (${value})`;
  return `Låg (${value})`;
}

function readableDateTime(value) {
  if (!value) return 'Ingen data ännu';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Ingen data ännu';
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function drilldownRowLabel(strategy) {
  return strategyLabel(strategy);
}

function drilldownRowMeta(strategy) {
  return [
    `source=${textValue(strategy?.source, 'Ej konfigurerad')}`,
    `status=${textValue(strategy?.status, 'Ej konfigurerad')}`,
    `score=${textValue(strategy?.score, '–')}`,
    `confidence=${textValue(strategy?.confidence, '–')}%`,
    `sample=${textValue(strategy?.sample_size, '–')}`,
  ].join(' · ');
}

function StrategyDrilldownCard({ title, kicker, badge, badgeTone, summary, items, emptyText, onSelectStrategy, selectedStrategyId }) {
  const rows = normalizeArray(items).slice(0, 5);
  return (
    <article className="sup-v2-answer sup-v2-answer-neutral">
      <div className="sup-v2-answer-head">
        <div>
          <div className="sup-v2-answer-kicker">{kicker}</div>
          <h3>{title}</h3>
        </div>
        <span className={`badge badge-${badgeTone}`}>{badge}</span>
      </div>
      <p className="sup-v2-answer-main">{summary}</p>
      {rows.length > 0 ? (
        <ul className="sup-v2-answer-list">
          {rows.map((strategy) => {
            const model = supervisorV2StrategyModel(strategy);
            const strategyId = model.strategyId || '';
            return (
            <li key={`${title}-${strategyId || drilldownRowLabel(strategy)}`} style={{ listStyle: 'none' }}>
              <button
                type="button"
                onClick={() => onSelectStrategy?.(strategyId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: '1px solid rgba(148,163,184,0.16)',
                  borderRadius: 14,
                  padding: '10px 12px',
                  background: selectedStrategyId === strategyId
                    ? 'rgba(37, 99, 235, 0.14)'
                    : 'rgba(15, 23, 42, 0.24)',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <strong>{drilldownRowLabel(strategy)}</strong>
                  <span className={`badge badge-${strategyStatusBadgeTone(strategy?.status)}`}>{textValue(strategy?.status, 'Ej konfigurerad')}</span>
                </div>
                <div style={{ lineHeight: 1.45, marginBottom: 6 }}>
                  Score {textValue(strategy?.score, '–')} · Confidence {textValue(strategy?.confidence, '–')}%
                </div>
                <div className="sup-v2-card-source" style={{ marginBottom: 0 }}>
                  {textValue(strategy?.recommended_action, 'Ingen rekommendation ännu.')}
                </div>
              </button>
            </li>
            );
          })}
        </ul>
      ) : (
        <div className="sup-safety-copy" style={{ marginTop: 8 }}>
          {emptyText}
        </div>
      )}
    </article>
  );
}

function StrategyPlannerCard({ item, onSelect, onQueue, queueBusyId }) {
  const queueDisabled = queueBusyId === item.id;
  return (
    <article className="sup-v2-answer sup-v2-answer-neutral" style={{ cursor: 'pointer' }} onClick={() => onSelect?.(item)}>
      <div className="sup-v2-answer-head">
        <div>
          <div className="sup-v2-answer-kicker">Rekommendation</div>
          <h3>{item.strategy_id}</h3>
        </div>
        <span className={`badge badge-${plannerTestTypeBadgeTone(item.test_type)}`}>{item.test_type}</span>
      </div>
      <p className="sup-v2-answer-main">{item.reason}</p>
      <div className="sup-v2-card-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <span className="sup-v2-chip">Priority {textValue(item.priority, '–')}</span>
        <span className={`badge badge-${strategySourceBadgeTone(item.source)}`}>{textValue(item.source, 'Ej konfigurerad')}</span>
        <span className={`badge badge-${strategyStatusBadgeTone(item.status)}`}>{textValue(item.status, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Scope {textValue(item.suggested_scope, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Learning {textValue(item.expected_learning_value, 'Ej konfigurerad')}</span>
      </div>
      <div className="sup-v2-card-source" style={{ marginTop: 8 }}>{textValue(item.safety_note, 'Read-only')}</div>
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sup-refresh"
          disabled={queueDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onQueue?.(item);
          }}
        >
          {queueDisabled ? 'Lägger till...' : 'Lägg i testkö'}
        </button>
      </div>
    </article>
  );
}

function StrategyPlannerPanel({ planner, onSelectRecommendation, onQueueRecommendation, queueBusyId }) {
  const recommendations = normalizeArray(planner?.recommendations).slice(0, 5);
  const summary = planner?.summary || {};

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Nästa rekommenderade tester</h2>
          <p>Förslag bara. Inga tester startas automatiskt.</p>
        </div>
        <SafetyTag />
      </div>

      <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <span className="sup-v2-chip">Totalt {textValue(summary.total_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Replay {textValue(summary.replay_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Batch {textValue(summary.batch_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Paper {textValue(summary.paper_observation_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">History {textValue(summary.history_review_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">TradingView {textValue(summary.tradingview_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Internal {textValue(summary.internal_recommendations, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Paused/deprecated {textValue(summary.skipped_paused_count, 'Ej konfigurerad')}</span>
      </div>

      {recommendations.length > 0 ? (
        <div className="sup-v2-answer-grid">
          {recommendations.map((item) => (
            <StrategyPlannerCard
              key={item.id || `${item.strategy_id}-${item.test_type}`}
              item={item}
              onSelect={onSelectRecommendation}
              onQueue={onQueueRecommendation}
              queueBusyId={queueBusyId}
            />
          ))}
        </div>
      ) : (
        <div className="sup-safety-copy">Inga rekommendationer ännu. Systemet verkar vara tillräckligt täckt just nu.</div>
      )}
    </section>
  );
}

function ManualTestQueuePanel({ queue, onCancelQueueItem, onViewHistory, onViewPlan, queueMessage, queueBusyId, queueView, onChangeQueueView }) {
  const queueData = queue && typeof queue === 'object' && !Array.isArray(queue)
    ? (queue.data && typeof queue.data === 'object' ? queue.data : (queue.ok === false ? null : queue))
    : null;
  const summary = queueData?.summary || {};
  const queueError = queue?.error || (queue?.ok === false ? 'Kunde inte läsa testkön just nu.' : '');
  const apiItems = normalizeArray(queueData?.items);
  const pendingItems = normalizeArray(queueData?.pending_items);
  const recentItems = normalizeArray(queueData?.recent_items);
  const allItems = apiItems.length > 0 ? apiItems : [...pendingItems, ...recentItems];
  const sortedItems = [...allItems].sort((a, b) => {
    const aTime = new Date(a?.created_at || 0).getTime();
    const bTime = new Date(b?.created_at || 0).getTime();
    return bTime - aTime;
  });
  const latestItem = sortedItems[0] || null;
  const filteredPendingItems = pendingItems.length > 0 ? pendingItems : sortedItems.filter((item) => queueItemStatus(item) === 'pending');
  const filteredCancelledItems = normalizeArray(queueData?.cancelled_items).length > 0
    ? normalizeArray(queueData?.cancelled_items)
    : sortedItems.filter((item) => queueItemStatus(item) === 'cancelled');
  const visibleItems = queueView === 'all'
    ? sortedItems
    : queueView === 'pending'
      ? filteredPendingItems
      : queueView === 'cancelled'
        ? filteredCancelledItems
        : sortedItems.filter((item) => queueItemStatus(item) === queueView);
  const recentCancelledItems = filteredCancelledItems.slice(0, 5);

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <p className="sup-kicker">Manuell testkö är laddad</p>
          <h2>Manuell testkö</h2>
          <p>AI kan föreslå tester, men inget körs automatiskt. Du har alltid kontroll.</p>
          <p>Granska Trading OS-vyn. Kontrollera rekommenderade tester och testkön. Live trading är avstängt.</p>
        </div>
      </div>

      <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <span className="sup-v2-chip">Totalt {textValue(summary.total ?? sortedItems.length, '0')}</span>
        <span className="sup-v2-chip">Pending {textValue(summary.pending ?? filteredPendingItems.length, '0')}</span>
        <span className="sup-v2-chip">Completed {textValue(summary.completed ?? sortedItems.filter((item) => queueItemStatus(item) === 'completed').length, '0')}</span>
        <span className="sup-v2-chip">Cancelled {textValue(summary.cancelled ?? recentCancelledItems.length, '0')}</span>
        <span className="sup-v2-chip">Failed {textValue(summary.failed ?? sortedItems.filter((item) => queueItemStatus(item) === 'failed').length, '0')}</span>
        <span className="sup-v2-chip">
          Senast tillagd {latestItem ? `${textValue(latestItem.strategy_id, 'Okänd strategi')} · ${readableDateTime(latestItem.created_at)}` : 'Ingen köpost ännu'}
        </span>
      </div>

      <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {[
          { key: 'pending', label: 'Pending' },
          { key: 'cancelled', label: 'Cancelled' },
          { key: 'all', label: 'Alla' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`badge badge-${queueView === tab.key ? 'blue' : 'gray'}`}
            onClick={() => onChangeQueueView?.(tab.key)}
            style={{ border: 'none', cursor: 'pointer' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {queueError ? (
        <div className="sup-error" style={{ marginBottom: 12 }}>
          {queueError}
        </div>
      ) : null}

      {queueMessage ? (
        <div className="sup-safety-copy" style={{ marginBottom: 12 }}>
          {queueMessage}
        </div>
      ) : null}

      <div className="sup-safety-copy" style={{ marginBottom: 12 }}>
        Testkön startar inga replay- eller batchjobb automatiskt. Live trading är avstängt.
      </div>

      {visibleItems.length > 0 ? (
        <div className="sup-v2-answer-grid">
          {visibleItems.map((item) => {
            const status = queueItemStatus(item);
            const isPending = status === 'pending';
            const isTradingView = queueStrategyTypeLabel(item) === 'TradingView-strategi';
            return (
              <article key={item.id} className="sup-v2-answer sup-v2-answer-neutral">
                <div className="sup-v2-answer-head">
                  <div>
                    <div className="sup-v2-answer-kicker">
                      {queueStrategyOriginLabel(item)} · {queueStrategyTypeLabel(item)}
                    </div>
                    <h3>{item.strategy_id}</h3>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                    {isTradingView ? <span className="badge badge-yellow">TradingView-strategi</span> : <span className="badge badge-blue">Intern strategi</span>}
                    <span className={`badge badge-${queueStatusBadgeTone(status)}`}>{queueStatusLabel(status)}</span>
                  </div>
                </div>
                <p className="sup-v2-answer-main">{textValue(item.reason, 'Ingen förklaring ännu.')}</p>
                <div className="sup-v2-card-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <span className="sup-v2-chip">Typ {textValue(item.test_type, '–')}</span>
                  <span className="sup-v2-chip">Prioritet {queueItemPriorityLabel(item.priority)}</span>
                  <span className="sup-v2-chip">Källa {queueStrategyOriginLabel(item)}</span>
                  <span className="sup-v2-chip">Tillagd {readableDateTime(item.created_at)}</span>
                </div>
                <div className="sup-v2-card-source" style={{ marginTop: 8 }}>Scope: {textValue(item.suggested_scope, 'Ej konfigurerad')}</div>
                <div className="sup-v2-card-source" style={{ marginTop: 8 }}>Lärande: {textValue(item.expected_learning_value, 'Ej konfigurerad')}</div>
                <div className="sup-v2-card-source" style={{ marginTop: 8 }}>Safety: {textValue(item.safety_note, 'Read-only')}</div>
                <div className="sup-safety-copy" style={{ marginTop: 8 }}>{queueNextStepText(item)}</div>
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="badge badge-gray"
                    onClick={() => onViewPlan?.(item.id)}
                    style={{ border: 'none', cursor: 'pointer', marginRight: 8 }}
                    disabled={!item.id}
                  >
                    Visa plan
                  </button>
                  <button
                    type="button"
                    className="badge badge-blue"
                    onClick={() => onViewHistory?.(item.strategy_id, item)}
                    style={{ border: 'none', cursor: 'pointer', marginRight: 8 }}
                  >
                    Visa historik
                  </button>
                  {isPending ? (
                    <button
                      type="button"
                      className="btn sup-refresh"
                      disabled={queueBusyId === item.id}
                      onClick={() => onCancelQueueItem?.(item.id)}
                    >
                      {queueBusyId === item.id ? 'Avbryter...' : 'Avbryt'}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="sup-safety-copy">
          {queueView === 'pending' ? (
            <>
              <div>Inga väntande tester just nu.</div>
              <div>Lägg ett test från "Nästa rekommenderade tester" för att granska planen här.</div>
            </>
          ) : queueView === 'cancelled' ? (
            <>
              <div>Inga avbrutna tester just nu.</div>
              <div>Avbrutna poster visas här när de finns i köhistoriken.</div>
            </>
          ) : (
            'Inga köposter för valt filter.'
          )}
        </div>
      )}

      {recentCancelledItems.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 900 }}>Senaste avbrutna</h3>
          <div className="sup-v2-answer-grid">
            {recentCancelledItems.map((item) => (
              <article key={item.id} className="sup-v2-answer sup-v2-answer-neutral">
                <div className="sup-v2-answer-head">
                  <div>
                    <div className="sup-v2-answer-kicker">
                      {queueStrategyOriginLabel(item)} · {queueStrategyTypeLabel(item)}
                    </div>
                    <h3>{item.strategy_id}</h3>
                  </div>
                  <span className={`badge badge-${queueStatusBadgeTone('cancelled')}`}>{queueStatusLabel('cancelled')}</span>
                </div>
                <p className="sup-v2-answer-main">{textValue(item.reason, 'Ingen förklaring ännu.')}</p>
                <div className="sup-safety-copy" style={{ marginTop: 8 }}>{queueNextStepText(item)}</div>
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="badge badge-gray"
                    onClick={() => onViewPlan?.(item.id)}
                    style={{ border: 'none', cursor: 'pointer', marginRight: 8 }}
                    disabled={!item.id}
                  >
                    Visa plan
                  </button>
                  <button
                    type="button"
                    className="badge badge-blue"
                    onClick={() => onViewHistory?.(item.strategy_id, item)}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    Visa historik
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TestPlanPreviewCard({ preview, loading, error, onClear }) {
  const data = preview?.ok ? preview : null;
  const queueItem = data?.queue_item || {};
  const strategy = data?.strategy_context || {};
  const plan = data?.plan_preview || {};
  const dataStatus = data?.data_status || {};
  const missingData = dataStatus?.missing_data || {};
  const isTradingView = String(strategy?.source || queueItem?.source || '').toLowerCase() === 'tradingview'
    || String(queueItem?.strategy_id || '').toUpperCase().startsWith('TV_');

  if (loading) {
    return (
      <section className="sup-section">
        <div className="sup-loading">Laddar testplan-preview...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="sup-section">
        <div className="sup-error">{error}</div>
      </section>
    );
  }

  if (!data) return null;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>{plan.title || 'Förhandsgranskning av testplan'}</h2>
          <p>Detta är endast en förhandsgranskning. Inget replay- eller batchtest startas.</p>
        </div>
        <button type="button" className="badge badge-gray" onClick={onClear} style={{ border: 'none', cursor: 'pointer' }}>
          Stäng
        </button>
      </div>

      <article className="sup-v2-answer sup-v2-answer-neutral">
        <div className="sup-v2-answer-head">
          <div>
            <div className="sup-v2-answer-kicker">{queueItem.strategy_id || 'Okänd strategi'}</div>
            <h3>{plan.title || 'Förhandsgranskning av testplan'}</h3>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            {isTradingView ? <span className="badge badge-yellow">TradingView-strategi</span> : <span className="badge badge-blue">Intern strategi</span>}
            <span className={`badge badge-${queueStatusBadgeTone(queueItem.status)}`}>{queueStatusLabel(queueItem.status)}</span>
          </div>
        </div>

        <p className="sup-v2-answer-main">{plan.objective || 'Ingen målbeskrivning ännu.'}</p>
        <div className="sup-safety-copy" style={{ marginTop: 8 }}>
          {data.queue_status_message || 'Köstatus läses read-only.'}
        </div>

        <div className="sup-v2-card-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span className="sup-v2-chip">Källa {textValue(strategy.source || queueItem.source, 'internal')}</span>
          <span className="sup-v2-chip">Testtyp {textValue(plan.test_type || queueItem.test_type, '–')}</span>
          <span className="sup-v2-chip">Prioritet {queueItem.priority != null ? textValue(queueItem.priority, '–') : '–'}</span>
          <span className="sup-v2-chip">Score {strategy.score != null ? textValue(strategy.score, '–') : '–'}</span>
          <span className="sup-v2-chip">Confidence {strategy.confidence != null ? `${textValue(strategy.confidence, '–')}%` : '–'}</span>
          <span className="sup-v2-chip">Sample {textValue(strategy.sample_size, '0')}</span>
        </div>

        {isTradingView ? (
          <div className="sup-safety-copy" style={{ marginTop: 12 }}>
            TradingView-strategi. Signalen kommer från TradingView/webhook. TradingView används endast för signaler och test, inte order.
          </div>
        ) : null}

        <div className="sup-grid sup-grid-2" style={{ marginTop: 12 }}>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Varför testet föreslogs</span>
            <strong className="sup-block-value">{plan.why_this_test || 'Ingen förklaring ännu.'}</strong>
            <span className="sup-block-note">Föreslaget scope kommer från queue-posten och befintlig historik.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Föreslaget scope</span>
            <strong className="sup-block-value">{plan.suggested_scope || 'Ej konfigurerad'}</strong>
            <span className="sup-block-note">{plan.manual_next_step || 'Ingen nästa manuell åtgärd ännu.'}</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Vad testet skulle mäta</span>
            <strong className="sup-block-value">
              {normalizeArray(plan.what_it_would_measure).length > 0
                ? normalizeArray(plan.what_it_would_measure).slice(0, 3).join(' · ')
                : 'Ingen mätbeskrivning ännu.'}
            </strong>
            <span className="sup-block-note">Fokuserar på lärande, inte execution.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Förväntat learning-värde</span>
            <strong className="sup-block-value">{plan.expected_learning_value || 'Ej konfigurerad'}</strong>
            <span className="sup-block-note">Preview bygger endast resonemang, inte körning.</span>
          </article>
        </div>

        <div className="sup-v2-card-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <span className="sup-v2-chip">Paper trades {textValue(dataStatus.paper_trades_count, '0')}</span>
          <span className="sup-v2-chip">Replay {textValue(dataStatus.replay_tests_count, '0')}</span>
          <span className="sup-v2-chip">Batch {textValue(dataStatus.batch_tests_count, '0')}</span>
          <span className="sup-v2-chip">Learning {textValue(dataStatus.learning_events_count, '0')}</span>
          <span className="sup-v2-chip">
            Saknas {' '}
            {Object.entries(missingData)
              .filter(([, value]) => value === true)
              .map(([key]) => key)
              .slice(0, 4)
              .join(' · ') || 'ingen tydlig lucka'}
          </span>
        </div>

        <div className="sup-v2-answer-list" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Data som saknas</div>
          {Object.entries(missingData).length > 0 ? (
            <ul className="sup-v2-answer-list">
              {Object.entries(missingData).map(([key, value]) => (
                <li key={key}>{`${key}: ${value ? 'saknas' : 'finns'}`}</li>
              ))}
            </ul>
          ) : (
            <div className="sup-safety-copy">Ingen tydlig lucka i data enligt befintlig historik.</div>
          )}
        </div>

        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          {plan.limitations?.join(' ')}
        </div>
        <div className="sup-safety-copy" style={{ marginTop: 8 }}>
          Safety: {plan.safety_notes?.join(' · ')}
        </div>
        <div className="sup-safety-copy" style={{ marginTop: 8 }}>
          can_execute: {data.can_execute ? 'ja' : 'nej'} · execution_available: {data.execution_available ? 'ja' : 'nej'}
        </div>
      </article>
    </section>
  );
}

function StrategyHistoryDetail({ history, loading, error, onClear, plannerContext }) {
  const data = history?.ok ? history : null;
  const recentEvents = normalizeArray(data?.recent_events).slice(0, 5);
  const learningNotes = normalizeArray(data?.learning_notes).slice(0, 5);
  const nextSteps = normalizeArray(data?.recommended_next_steps).slice(0, 5);
  const score = data?.score || {};
  const historySummary = data?.history_summary || {};
  const registry = data?.registry || {};
  const planner = plannerContext || null;

  return (
    <>
      {loading ? (
        <div className="sup-loading">Laddar strategi-historik...</div>
      ) : error ? (
        <div className="sup-error">{error}</div>
      ) : !data ? (
        <div className="sup-safety-copy">Ingen historik ännu. Klicka på en strategi eller rekommendation för att se detaljer.</div>
      ) : (
        <article className="sup-v2-answer sup-v2-answer-neutral">
          <div className="sup-v2-answer-head">
            <div>
              <div className="sup-v2-answer-kicker">{data.strategy_id}</div>
              <h3>{data.strategy_id}</h3>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`badge badge-${strategySourceBadgeTone(registry.source)}`}>{textValue(registry.source, 'Ej konfigurerad')}</span>
              <span className={`badge badge-${strategyStatusBadgeTone(registry.status)}`}>{textValue(registry.status, 'Ej konfigurerad')}</span>
              <button type="button" className="badge badge-blue" onClick={onClear} style={{ cursor: 'pointer', border: 'none' }}>
                Stäng
              </button>
            </div>
          </div>

          <p className="sup-v2-answer-main">
            Score {textValue(score.score, '–')} · Confidence {textValue(score.confidence, '–')}% · Sample size {textValue(score.sample_size, 'Ej konfigurerad')}
          </p>

          {planner ? (
            <div className="sup-safety-copy" style={{ marginBottom: 10 }}>
              <strong>Öppnat från planner.</strong><br />
              <strong>Föreslaget test:</strong> {textValue(planner.test_type, 'history_review')} ·{' '}
              <strong>Prioritet:</strong> {textValue(planner.priority, '–')} ·{' '}
              <strong>Varför:</strong> {textValue(planner.reason, 'Ingen förklaring ännu.')}<br />
              <strong>Suggested scope:</strong> {textValue(planner.suggested_scope, 'Ej konfigurerad')}<br />
              <strong>Expected learning value:</strong> {textValue(planner.expected_learning_value, 'Ej konfigurerad')}<br />
              <strong>Safety note:</strong> {textValue(planner.safety_note, 'Read-only')}.
            </div>
          ) : null}

          <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <span className="sup-v2-chip">Paper {textValue(historySummary.paper_trades_count, 'Ej konfigurerad')}</span>
            <span className="sup-v2-chip">Replay {textValue(historySummary.replay_tests_count, 'Ej konfigurerad')}</span>
            <span className="sup-v2-chip">Batch {textValue(historySummary.batch_tests_count, 'Ej konfigurerad')}</span>
            <span className="sup-v2-chip">Learning {textValue(historySummary.learning_events_count, 'Ej konfigurerad')}</span>
            <span className="sup-v2-chip">Last signal {ageText(historySummary.last_signal_at)}</span>
            <span className="sup-v2-chip">Last test {ageText(historySummary.last_test_at)}</span>
          </div>

          <div className="sup-grid sup-grid-2" style={{ marginTop: 8 }}>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Varför score ser ut så här</span>
              <strong className="sup-block-value">{score.recommended_action || 'Ingen rekommendation ännu'}</strong>
              <span className="sup-block-note">
                {uniqueText([
                  ...(normalizeArray(score.strengths).slice(0, 2)),
                  ...(normalizeArray(score.weaknesses).slice(0, 2)),
                ]).join(' · ') || 'Ingen score-kommentar ännu.'}
              </span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Registry och timing</span>
              <strong className="sup-block-value">{textValue(registry.mode, 'Ej konfigurerad')}</strong>
              <span className="sup-block-note">
                Source {textValue(registry.source, 'Ej konfigurerad')} · Status {textValue(registry.status, 'Ej konfigurerad')} · Enabled {registry.enabled === true ? 'ja' : registry.enabled === false ? 'nej' : 'Ej konfigurerad'}
              </span>
            </article>
          </div>

          <div className="sup-v2-answer-list" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Strengths</div>
            <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {normalizeArray(score.strengths).length > 0
                ? normalizeArray(score.strengths).slice(0, 5).map((item) => <span key={item} className="sup-v2-chip">{item}</span>)
                : <span className="sup-v2-chip">Ingen historik ännu</span>}
            </div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Weaknesses</div>
            <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {normalizeArray(score.weaknesses).length > 0
                ? normalizeArray(score.weaknesses).slice(0, 5).map((item) => <span key={item} className="sup-v2-chip">{item}</span>)
                : <span className="sup-v2-chip">Ingen historik ännu</span>}
            </div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Learning notes</div>
            <ul className="sup-v2-answer-list">
              {learningNotes.length > 0
                ? learningNotes.map((item) => <li key={item}>{item}</li>)
                : <li>Ingen historik ännu</li>}
            </ul>
            <div style={{ fontWeight: 800, marginTop: 10, marginBottom: 6 }}>Recommended next steps</div>
            <ul className="sup-v2-answer-list">
              {nextSteps.length > 0
                ? nextSteps.map((item) => <li key={item}>{item}</li>)
                : <li>Ingen historik ännu</li>}
            </ul>
            <div style={{ fontWeight: 800, marginTop: 10, marginBottom: 6 }}>Recent events</div>
            <ul className="sup-v2-answer-list">
              {recentEvents.length > 0
                ? recentEvents.map((event) => (
                    <li key={`${event.timestamp || ''}-${event.event_type || ''}-${event.summary || ''}`}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                        <strong>{event.summary || 'Event'}</strong>
                        <span className={`badge badge-${strategySourceBadgeTone(event.source)}`}>{textValue(event.source, 'unknown')}</span>
                        <span className="sup-v2-chip">{textValue(event.event_type, 'event')}</span>
                        <span className="sup-v2-chip">{formatDateTime(event.timestamp)}</span>
                      </div>
                      {event.details ? (
                        <div style={{ lineHeight: 1.45 }}>
                          {eventDetailsSummary(event.details) || 'Ingen ytterligare detaljer ännu.'}
                        </div>
                      ) : null}
                    </li>
                  ))
                : <li>Ingen historik ännu</li>}
            </ul>
          </div>
        </article>
      )}
    </>
  );
}

function ResultWhyNoTradesPanel({ resources, model }) {
  const diagnostics = buildPaperTradeDiagnostics(resources, model);
  const allowlistState = endpointState(resources.paperAllowlistStatus);
  const candidatesState = endpointState(resources.candidatesRecent);
  const replayState = endpointState(resources.replaySessions);
  const coverageState = endpointState(resources.dataCoverageStatus);
  const allowlistRows = diagnostics.approvedStrategies;
  const blockedRows = diagnostics.blockedStrategies;
  const technicalPaperCount = diagnostics.technicalPaperCount;
  const approvedCount = diagnostics.allowlistApprovedCount;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Varför inga paper trades?</h2>
          <p>Read-only diagnos som skiljer på katalog, runtime, allowlist, kandidater, blockeringar och data coverage.</p>
        </div>
        <SafetyTag />
      </div>

      <div className="sup-safety-copy" style={{ marginTop: 8 }}>
        <strong>Snabbtolkning:</strong>{' '}
        {diagnostics.candidatesCount === 0
          ? 'Just nu finns inga aktuella kandidater att öppna paper trades på.'
          : diagnostics.candidatesCount === null ? 'Kandidatantal saknas i backendsvaret.' : `${diagnostics.candidatesCount} kandidater finns just nu.`}
        <br />
        <strong>Tydlig skillnad:</strong> {formatInt(technicalPaperCount, 'Ingen data ännu')} strategier har teknisk paper-koppling, men {formatInt(approvedCount, 'Ingen data ännu')} är godkända i allowlist just nu.
        <br />
        <strong>Allowlist:</strong> bara strategier på listan får skapa låtsasaffärer. Andra strategier kan analyseras, men stoppas innan paper trade.
      </div>

      <div className="sup-grid sup-grid-2" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 12 }}>
        <article className={`sup-block ${diagnostics.paperEnabled === true ? 'sup-block-ok' : diagnostics.paperEnabled === false ? 'sup-block-warning' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Paper Trading</span>
          <strong className="sup-block-value">{diagnostics.paperEnabled === true ? 'Aktivt' : diagnostics.paperEnabled === false ? 'Ej aktivt' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">Öppna {formatInt(diagnostics.openCount, 'Ingen data ännu')} · stängda {formatInt(diagnostics.closedCount, 'Ingen data ännu')} · blockerade {formatInt(diagnostics.blockedCount, 'Ingen data ännu')}</span>
        </article>
        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Senaste paper-event</span>
          <strong className="sup-block-value">{diagnostics.latestEventAt ? formatDateTime(diagnostics.latestEventAt) : 'Ingen eventdata ännu'}</strong>
          <span className="sup-block-note">{diagnostics.latestEventAt ? ageText(diagnostics.latestEventAt) : 'Systemet väntar på nya signaler.'}</span>
        </article>
        <article className={`sup-block ${allowlistState.tone === 'good' ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Allowlist</span>
          <strong className="sup-block-value">{formatInt(diagnostics.allowlistReadyCount, 'Ingen data ännu')} redo</strong>
          <span className="sup-block-note">{formatInt(diagnostics.allowlistApprovedCount, 'Ingen data ännu')} godkända · {formatInt(diagnostics.allowlist?.pendingRuntimeConnection, 'Ingen data ännu')} väntar på runtime</span>
        </article>
        <article className={`sup-block ${coverageState.tone === 'good' ? 'sup-block-ok' : 'sup-block-warning'}`}>
          <span className="sup-block-title">Data coverage</span>
          <strong className="sup-block-value">{diagnostics.coverageScore == null ? 'Ingen data ännu' : `${diagnostics.coverageScore}/100`}</strong>
          <span className="sup-block-note">{formatInt(diagnostics.missingDataCount, 'Ingen data ännu')} symboler saknar data</span>
        </article>
        <article className={`sup-block ${candidatesState.tone === 'good' ? 'sup-block-neutral' : 'sup-block-warning'}`}>
          <span className="sup-block-title">Candidates</span>
          <strong className="sup-block-value">{formatInt(diagnostics.candidatesCount, 'Ingen data ännu')}</strong>
          <span className="sup-block-note">Aktuella kandidater i senaste GET-svaret.</span>
        </article>
        <article className={`sup-block ${replayState.tone === 'good' ? 'sup-block-neutral' : 'sup-block-warning'}`}>
          <span className="sup-block-title">Replay sessions</span>
          <strong className="sup-block-value">{formatInt(diagnostics.replayCount, 'Ingen data ännu')}</strong>
          <span className="sup-block-note">Används som extra diagnos när historik saknas.</span>
        </article>
      </div>

      <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
        <strong>Systemet kör, men inga trades skapas just nu eftersom…</strong>
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {diagnostics.explanation.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Statusmatris</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr>
                {['Grupp', 'Antal', 'Vad betyder det?'].map((label) => (
                  <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.24)', fontSize: 13 }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {diagnostics.matrix.map((row) => (
                <tr key={row.group}>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', fontWeight: 700 }}>{row.group}</td>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{formatInt(row.count, 'Ingen data ännu')}</td>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', lineHeight: 1.45 }}>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
        <strong>Vanligaste blockeringsorsaker:</strong>{' '}
        {diagnostics.blocks.reasons.length > 0
          ? diagnostics.blocks.reasons.map((row) => `${row.reason} (${row.count})`).join(' · ')
          : 'Inga tydliga blockeringsorsaker ännu.'}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Godkända strategier på allowlist</div>
        {allowlistRows.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  {['Strategy id', 'Display name', 'Status', 'Runtime ready', 'Senaste aktivitet', 'Blockeringar'].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.24)', fontSize: 13 }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allowlistRows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', fontWeight: 700 }}>{row.id}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.name}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                      <span className={`badge badge-${row.runtimeReady ? 'green' : 'yellow'}`}>{row.status}</span>
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                      {row.runtimeReady ? 'Ja' : 'Nej'}
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', lineHeight: 1.45 }}>
                      {row.latestActivityAt ? `${row.latestActivityLabel} · ${ageText(row.latestActivityAt)}` : row.latestActivityLabel}
                      {row.latestBlockedReason ? <div style={{ marginTop: 4, opacity: 0.8 }}>{row.latestBlockedReason}</div> : null}
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                      {formatInt(row.blockedCount, 'Ingen data ännu')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy">Ingen lista över godkända strategier finns i payloaden just nu. Endpointen är fortfarande read-only och sidan förblir stabil.</div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Blockerade strategier</div>
        {blockedRows.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  {['Strategy id', 'Blockeringar', 'Vanligaste blockedReason', 'Allowlist-status', 'Senaste aktivitet'].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.24)', fontSize: 13 }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {blockedRows.map((row) => (
                  <tr key={`${row.id}-${row.name}`}>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', fontWeight: 700 }}>
                      {row.id || row.name}
                      <div style={{ marginTop: 4, opacity: 0.8 }}>{row.name}</div>
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{formatInt(row.count, 'Ingen data ännu')}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', lineHeight: 1.45 }}>
                      {row.commonReason}
                      {row.latestReason && row.latestReason !== row.commonReason ? <div style={{ marginTop: 4, opacity: 0.8 }}>Senaste: {row.latestReason}</div> : null}
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.allowlistStatus}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.latestAt ? `${formatDateTime(row.latestAt)} · ${ageText(row.latestAt)}` : 'Ingen aktivitet ännu'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy">Inga blockerade strategier finns i den senaste loggen ännu.</div>
        )}
      </div>
    </section>
  );
}

function PaperAllowlistPanel({ resources, model }) {
  const diagnostics = buildPaperTradeDiagnostics(resources, model);
  const state = endpointState(resources.paperAllowlistStatus);
  const data = unwrap(resources.paperAllowlistStatus) || {};
  const rows = diagnostics.approvedStrategies;
  const blockedRows = diagnostics.blockedStrategies;
  const ready = data?.paperRuntimeReady === true || data?.runtimeConnectionStatus === 'ready';

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Allowlist för Paper Trading</h2>
          <p>Endast strategier på allowlist får skapa paper trades. Blockerade strategier visas i Paper Trading-events.</p>
        </div>
        <SafetyTag />
      </div>

      {state.label === 'Problem' && !state.missing && (
        <div className="sup-warning">Allowlist-status kunde inte läsas just nu. Panelen är read-only och visar neutral fallback.</div>
      )}

      <div className="sup-safety-copy" style={{ marginBottom: 12 }}>
        <strong>Nyckelpoäng:</strong> {formatInt(diagnostics.technicalPaperCount, 'Ej konfigurerad')} strategier har teknisk paper-koppling, men bara {formatInt(diagnostics.allowlistApprovedCount, 'Ej konfigurerad')} är godkända i allowlist just nu.
      </div>

      <div className="sup-grid sup-grid-2" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <article className={`sup-block ${ready ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Paper runtime ready</span>
          <strong className="sup-block-value">{ready ? 'Ja' : 'Avvaktar'}</strong>
          <span className="sup-block-note">{textValue(data?.runtimeConnectionStatus, 'Ingen status ännu')}</span>
        </article>
        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Approved</span>
          <strong className="sup-block-value">{formatInt(data?.totalApproved, 'Ej konfigurerad')}</strong>
          <span className="sup-block-note">{formatInt(data?.readyForPaperRuntime, 'Ej konfigurerad')} redo · {formatInt(data?.pendingRuntimeConnection, 'Ej konfigurerad')} väntar</span>
        </article>
        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Enabled for runtime</span>
          <strong className="sup-block-value">{textValue(data?.enabledForPaperRuntime, 'Ej angivet')}</strong>
          <span className="sup-block-note">automaticPaperOnlyTesting: {textValue(data?.automaticPaperOnlyTesting, 'Ej angivet')}</span>
        </article>
        <article className={`sup-block ${data?.safety ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Safety</span>
          <strong className="sup-block-value">{textValue(data?.safety?.mode, 'Ej konfigurerad')}</strong>
          <span className="sup-block-note">actions_allowed={onOffLabel(data?.safety?.actions_allowed)} · can_place_orders={onOffLabel(data?.safety?.can_place_orders)} · live_trading_enabled={onOffLabel(data?.safety?.live_trading_enabled)}</span>
        </article>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Godkända strategier</div>
        {rows.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 840 }}>
              <thead>
                <tr>
                  {['Strategy id', 'Display name', 'Status', 'Runtime ready', 'Senaste aktivitet', 'Blockeringar'].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.24)', fontSize: 13 }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', fontWeight: 700 }}>{row.id}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.name}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                      <span className={`badge badge-${row.runtimeReady ? 'green' : 'yellow'}`}>{row.status}</span>
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.runtimeReady ? 'Ja' : 'Nej'}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', lineHeight: 1.45 }}>
                      {row.latestActivityAt ? `${row.latestActivityLabel} · ${ageText(row.latestActivityAt)}` : row.latestActivityLabel}
                      {row.latestBlockedReason ? <div style={{ marginTop: 4, opacity: 0.8 }}>{row.latestBlockedReason}</div> : null}
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{formatInt(row.blockedCount, 'Ingen data ännu')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy" style={{ marginTop: 12 }}>
            Ingen lista över godkända strategier finns i payloaden just nu. Endpointen är fortfarande read-only och sidan förblir stabil.
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Blockerade strategier</div>
        {blockedRows.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  {['Strategy id', 'Blockeringar', 'Vanligaste blockedReason', 'Allowlist-status', 'Senaste aktivitet'].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.24)', fontSize: 13 }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {blockedRows.map((row) => (
                  <tr key={`${row.id}-${row.name}`}>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', fontWeight: 700 }}>
                      {row.id || row.name}
                      <div style={{ marginTop: 4, opacity: 0.8 }}>{row.name}</div>
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{formatInt(row.count, 'Ingen data ännu')}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)', lineHeight: 1.45 }}>
                      {row.commonReason}
                      {row.latestReason && row.latestReason !== row.commonReason ? <div style={{ marginTop: 4, opacity: 0.8 }}>Senaste: {row.latestReason}</div> : null}
                    </td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.allowlistStatus}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,.12)' }}>{row.latestAt ? `${formatDateTime(row.latestAt)} · ${ageText(row.latestAt)}` : 'Ingen aktivitet ännu'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy">Inga blockerade strategier finns i den senaste loggen ännu.</div>
        )}
      </div>
    </section>
  );
}

function RecentTradingEvents({ resource }) {
  const data = unwrap(resource);
  const state = endpointState(resource);
  const events = normalizeArray(data?.events).slice(0, 8);
  const hasEvents = events.length > 0;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Senaste händelser</h2>
          <p>Detta är en read-only tidslinje. Den påverkar inte tradingbeslut.</p>
        </div>
        <SafetyTag />
      </div>

      {!state.missing && state.label === 'Problem' && (
        <div className="sup-warning">
          Kunde inte läsa event-loggen just nu. Tidslinjen visar senaste data när backend är tillgänglig.
        </div>
      )}

      {hasEvents ? (
        <div className="sup-event-list">
          {events.map((event, index) => {
            const tone = eventTone(event.event_type);
            const decisionTone = eventDecisionTone(event.decision);
            return (
              <article key={event.event_id || `${event.timestamp || 'event'}-${index}`} className={`sup-event-row sup-event-tone-${tone}`}>
                <div className="sup-event-left">
                  <div className="sup-event-time">{formatDateTime(event.timestamp)}</div>
                  <div className="sup-event-symbol">{event.symbol || 'SYSTEM'}</div>
                  <div className="sup-event-market">{event.market || 'unknown'}</div>
                </div>
                <div className="sup-event-right">
                  <div className="sup-event-topline">
                    <span className={`badge badge-${tone}`}>{event.event_type}</span>
                    <span className={`badge badge-${decisionTone}`}>{event.decision || 'no_trade'}</span>
                    {event.strategy ? <span className="sup-v2-chip">{event.strategy}</span> : null}
                  </div>
                  <div className="sup-event-summary">{eventSummary(event)}</div>
                  <div className="sup-event-meta">
                    {event.score != null && <span className="sup-v2-chip">Score {event.score}</span>}
                    {event.threshold != null && <span className="sup-v2-chip">Threshold {event.threshold}</span>}
                    {event.timeframe ? <span className="sup-v2-chip">{event.timeframe}</span> : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="opt-empty">Inga events ännu. Systemet väntar på nya signaler.</div>
      )}
    </section>
  );
}

function EventAiConclusion({ resource }) {
  const data = unwrap(resource);
  const state = endpointState(resource);
  const hasEventsField = Array.isArray(data?.events);
  const events = hasEventsField ? normalizeArray(data?.events).slice(0, 100) : null;
  const ai = buildEventAiConclusion(events);
  const toneClass = ai.tone === 'green'
    ? 'sup-block-ok'
    : ai.tone === 'red'
      ? 'sup-block-danger'
      : ai.tone === 'yellow'
        ? 'sup-block-warning'
        : ai.tone === 'blue'
          ? 'sup-block-neutral'
          : 'sup-block-neutral';

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>AI-slutsats från events</h2>
          <p>Detta är en deterministisk read-only tolkning av de senaste 100 eventen.</p>
        </div>
        <SafetyTag />
      </div>

      {!state.missing && state.label === 'Problem' && (
        <div className="sup-warning">
          Kunde inte läsa eventdata just nu. Slutsatsen visar senaste kända läge när backend är tillgänglig.
        </div>
      )}

      <article className={`sup-block ${toneClass}`}>
        <span className="sup-block-title">Kort slutsats</span>
        <strong className="sup-block-value">{ai.conclusion}</strong>
        <span className="sup-block-note">{ai.interpretation[0] || 'Ingen tydlig slutsats ännu.'}</span>
      </article>

      <div className="sup-grid sup-grid-2" style={{ marginTop: 12 }}>
        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Viktigaste datapunkter</span>
          <strong className="sup-block-value">{formatInt(ai.metrics.detected, 'Ingen data ännu')} signal.detected</strong>
          <span className="sup-block-note">
            strategy.matched {formatInt(ai.metrics.matched, 'Ingen data ännu')} · market_gate.blocked {formatInt(ai.metrics.blocked, 'Ingen data ännu')} · market_gate.observe_only {formatInt(ai.metrics.observeOnly, 'Ingen data ännu')} · paper_trade.opened {formatInt(ai.metrics.opened, 'Ingen data ännu')} · paper_trade.skipped {formatInt(ai.metrics.skipped, 'Ingen data ännu')}
          </span>
        </article>

        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Dominerande mönster</span>
          <strong className="sup-block-value">{ai.metrics.topReason}</strong>
          <span className="sup-block-note">
            Symbol {ai.metrics.topSymbol} · strategi {ai.metrics.topStrategy} · market {ai.metrics.topMarket}
          </span>
        </article>

        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Enkel tolkning</span>
          <strong className="sup-block-value">{ai.interpretation[0] || 'Flödet är aktivt men ännu inte tydligt.'}</strong>
          <span className="sup-block-note">{ai.interpretation.slice(1).join(' · ') || 'Ingen extra tolkning ännu.'}</span>
        </article>

        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Nästa säkra steg</span>
          <strong className="sup-block-value">{ai.nextStep}</strong>
          <span className="sup-block-note">
            {ai.metrics.opened > 0
              ? 'Systemet fungerar och öppnar paper trades när reglerna godkänner.'
              : ai.metrics.opened === null ? 'Ingen backenddata för öppnade paper trades ännu.' : 'Fortsätt bara observera eller kontrollera gate/risk om allt blockeras.'}
          </span>
        </article>
      </div>

      <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
        <strong>AI-läsning:</strong> {ai.conclusion}
        <div style={{ marginTop: 6 }}>
          {ai.interpretation.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>

      <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
        <strong>Nästa säkra steg:</strong> {ai.nextStep}
      </div>

      <div className="sup-safety-copy" style={{ marginTop: 12 }}>
        Detta är en read-only AI-slutsats. Den påverkar inte tradingbeslut.
      </div>
    </section>
  );
}

function EventsByMarket({ resource }) {
  const data = unwrap(resource);
  const state = endpointState(resource);
  const hasEventsField = Array.isArray(data?.events);
  const events = hasEventsField ? normalizeArray(data?.events).slice(0, 100) : [];
  const summary = buildEventsByMarketSummary(events);
  const hasEvents = events.length > 0;

  const toneClassFor = (tone) => {
    if (tone === 'green') return 'sup-block-ok';
    if (tone === 'red') return 'sup-block-danger';
    if (tone === 'yellow') return 'sup-block-warning';
    if (tone === 'blue') return 'sup-block-neutral';
    return 'sup-block-neutral';
  };

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Events per marknad</h2>
          <p>Read-only sammanfattning per market baserad på de senaste 100 eventen.</p>
        </div>
        <SafetyTag />
      </div>

      {!state.missing && state.label === 'Problem' && (
        <div className="sup-warning">
          Kunde inte läsa eventdata just nu. Market-sammanfattningen visar senaste kända läge när backend är tillgänglig.
        </div>
      )}

      {!hasEventsField ? (
        <div className="opt-empty">Ingen eventdata från backend ännu.</div>
      ) : !hasEvents ? (
        <div className="opt-empty">Backend returnerade 0 events i aktuell vy.</div>
      ) : (
        <>
          <div className="sup-v2-report-lead" style={{ marginBottom: 12 }}>
            <strong>Översikt:</strong> {summary.topMarket.count > 0 ? `Flest events kommer från ${summary.topMarket.market}.` : 'Inga tydliga marknadsmönster ännu.'}
          </div>

          <div className="sup-grid sup-grid-2">
            {summary.summaries.map((item) => (
              <article key={item.market} className={`sup-block ${toneClassFor(item.tone)}`}>
                <span className="sup-block-title">{item.market}</span>
                <strong className="sup-block-value">{formatInt(item.count, 'Ingen data ännu')} events</strong>
                <span className="sup-block-note">{item.interpretation}</span>
                <div className="sup-v2-report-lead" style={{ marginTop: 10, marginBottom: 0 }}>
                  <strong>Nyckeltal:</strong> signal.detected {formatInt(item.detected, 'Ingen data ännu')} · strategy.matched {formatInt(item.matched, 'Ingen data ännu')} · market_gate.blocked {formatInt(item.blocked, 'Ingen data ännu')} · market_gate.observe_only {formatInt(item.observeOnly, 'Ingen data ännu')} · paper_trade.opened {formatInt(item.opened, 'Ingen data ännu')} · paper_trade.skipped {formatInt(item.skipped, 'Ingen data ännu')}
                </div>
                <div className="sup-v2-report-lead" style={{ marginTop: 10, marginBottom: 0 }}>
                  <strong>Vanligast:</strong> {item.topReason}
                  <div>Symbol: {item.topSymbol} · strategi: {item.topStrategy}</div>
                </div>
                <div className="sup-v2-report-lead" style={{ marginTop: 10, marginBottom: 0 }}>
                  <strong>Tolkning:</strong> {item.opened > 0
                    ? 'Paper trades öppnas för denna marknad.'
                    : item.market === 'crypto' && (item.detected > 0 || item.matched > 0)
                      ? 'Crypto scannas, men inga paper trades öppnades i detta eventfönster.'
                      : item.market === 'stocks' && item.count > 0
                        ? 'Senaste eventen domineras av aktier/ETF.'
                        : item.market === 'unknown' && item.count > 0
                          ? 'Vissa events saknar market-fält och bör förbättras senare.'
                          : item.interpretation}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EventSystemStatus({ resource }) {
  const data = unwrap(resource);
  const state = endpointState(resource);
  const jsonlEnabled = data?.jsonl_enabled === true ? true : data?.jsonl_enabled === false ? false : null;
  const kafkaEnabled = data?.kafka_enabled === true ? true : data?.kafka_enabled === false ? false : null;
  const kafkaConfigured = data?.kafka_configured === true ? true : data?.kafka_configured === false ? false : null;
  const kafkaTopic = textValue(data?.kafka_topic, 'Ej konfigurerad');
  const kafkaClientId = textValue(data?.kafka_client_id, 'Ej konfigurerad');
  const kafkaBrokers = Array.isArray(data?.kafka_brokers) ? data.kafka_brokers.filter(Boolean) : [];
  const kafkaError = textValue(data?.kafka_last_error, '');
  const kafkaLastPublishAt = data?.kafka_last_publish_at || null;
  const kafkaLastAttemptAt = data?.kafka_last_attempt_at || null;
  const safetyItems = [
    ['actions_allowed', data?.actions_allowed],
    ['can_place_orders', data?.can_place_orders],
    ['live_trading_enabled', data?.live_trading_enabled],
  ];

  let statusMessage = 'Eventsystemets transportstatus saknas i backendsvaret.';
  if (kafkaEnabled && kafkaError) {
    statusMessage = 'Kafka har fel, men tradingflödet påverkas inte.';
  } else if (kafkaEnabled) {
    statusMessage = 'Kafka är aktivt som extra transportlager. JSONL är fortfarande primär.';
  } else if (kafkaEnabled === false) {
    statusMessage = 'Kafka är avstängt enligt backend. JSONL är primär om backend rapporterar den som aktiv.';
  }

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Systemstatus för events</h2>
          <p>Read-only översikt av JSONL-loggen och den optionala Kafka-adaptern.</p>
        </div>
        <SafetyTag />
      </div>

      {!state.missing && state.label === 'Problem' && (
        <div className="sup-warning">
          Kunde inte läsa eventsystemets status just nu. Sidan visar senaste kända läge när backend är tillgänglig.
        </div>
      )}

      <div className="sup-v2-report-lead">
        <strong>Event system status:</strong> {statusMessage}
      </div>

      <div className="sup-grid sup-grid-2">
        <article className={`sup-block ${jsonlEnabled === true ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">JSONL-logg</span>
          <strong className="sup-block-value">{jsonlEnabled === true ? 'aktiv' : jsonlEnabled === false ? 'inaktiv' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">Primär lagring i data/events/trading-events.jsonl.</span>
        </article>

        <article className={`sup-block ${kafkaEnabled && kafkaError ? 'sup-block-danger' : kafkaEnabled ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Kafka</span>
          <strong className="sup-block-value">{kafkaEnabled && !kafkaError ? 'aktiv' : kafkaEnabled ? 'på med fel' : kafkaEnabled === false ? 'av' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">{statusMessage}</span>
        </article>

        <article className={`sup-block ${kafkaConfigured === true ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Kafka konfigurerad</span>
          <strong className="sup-block-value">{kafkaConfigured === true ? 'ja' : kafkaConfigured === false ? 'nej' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">
            Brokers: {Array.isArray(data?.kafka_brokers) && data.kafka_brokers.length ? data.kafka_brokers.join(', ') : 'ej konfigurerade'}.
          </span>
        </article>

        <article className={`sup-block ${kafkaEnabled && !kafkaError ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Redpanda transport</span>
          <strong className="sup-block-value">{kafkaEnabled && !kafkaError ? 'aktiv' : kafkaEnabled === false ? 'avvaktar' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">
            Kafka/Redpanda är {kafkaEnabled && !kafkaError ? 'aktivt som extra event-transport. JSONL är fortfarande primär.' : 'förberett men inte i aktiv drift.'}
          </span>
        </article>

        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Senaste Kafka publish</span>
          <strong className="sup-block-value">{kafkaLastPublishAt ? formatDateTime(kafkaLastPublishAt) : 'Ingen publicering ännu'}</strong>
          <span className="sup-block-note">
            {kafkaLastAttemptAt ? `Senaste försök: ${formatDateTime(kafkaLastAttemptAt)}` : 'Inget publish-försök ännu.'}
          </span>
        </article>

        <article className={`sup-block ${kafkaError ? 'sup-block-danger' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Senaste Kafka-fel</span>
          <strong className="sup-block-value">{kafkaError || 'Inga fel'}</strong>
          <span className="sup-block-note">{kafkaError ? 'Kafka-adaptern rapporterar fel, men tradingflödet fortsätter.' : 'Inga aktuella Kafka-fel.'}</span>
        </article>

        <article className={`sup-block ${kafkaEnabled && !kafkaError ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Transportdetaljer</span>
          <strong className="sup-block-value">topic {kafkaTopic}</strong>
          <span className="sup-block-note">
            brokers: {kafkaBrokers.length ? kafkaBrokers.join(', ') : 'ej konfigurerade'} · client_id: {kafkaClientId}
          </span>
        </article>

        <article className="sup-block sup-block-neutral">
          <span className="sup-block-title">Safety</span>
          <strong className="sup-block-value">{safetyItems.some(([, value]) => value !== undefined && value !== null) ? 'backendfält' : 'Ingen data ännu'}</strong>
          <span className="sup-block-note">
            {safetyItems.map(([key, value]) => `${key}=${onOffLabel(value)}`).join(' · ')}
          </span>
        </article>
      </div>
    </section>
  );
}

function SignalStopSummary({ resource }) {
  const summary = signalStopSummary(resource);
  const latestBlocked = summary.latestBlocked;
  const stoppedSignals = [summary.blocked, summary.observeOnly, summary.skipped].every((value) => value !== null)
    ? summary.blocked + summary.observeOnly + summary.skipped
    : null;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Varför stoppas signaler?</h2>
          <p>Vanligaste orsaken, antal stopp och en kort förklaring.</p>
        </div>
        <SafetyTag />
      </div>

      {summary.eventsUnavailable ? (
        <div className="opt-empty">Ingen eventdata från backend ännu.</div>
      ) : !summary.hasEvents ? (
        <div className="opt-empty">Backend returnerade 0 events i aktuell vy.</div>
      ) : (
        <>
          <div className="sup-grid sup-grid-2">
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Vanligaste stopporsak</span>
              <strong className="sup-block-value">{summary.topReason}</strong>
              <span className="sup-block-note">{summary.topReasonCount !== null && summary.topReasonCount > 0 ? `${summary.topReasonCount} händelser` : 'Ingen tydlig stopporsak ännu.'}</span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Antal stoppade signaler</span>
              <strong className="sup-block-value">{formatInt(stoppedSignals, 'Ingen data ännu')}</strong>
              <span className="sup-block-note">{formatInt(summary.blocked, 'Ingen data ännu')} blockerade · {formatInt(summary.observeOnly, 'Ingen data ännu')} observe_only · {formatInt(summary.skipped, 'Ingen data ännu')} skippade</span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Kort förklaring</span>
              <strong className="sup-block-value">{summary.conclusion}</strong>
              <span className="sup-block-note">{formatInt(summary.allowed, 'Ingen data ännu')} tillåtna · {formatInt(summary.opened, 'Ingen data ännu')} öppnade paper trades</span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Senaste blockerade signal</span>
              <strong className="sup-block-value">{latestBlocked?.symbol || 'Ingen blockering ännu'}</strong>
              <span className="sup-block-note">
                {latestBlocked
                  ? `${formatDateTime(latestBlocked.timestamp)} · ${summarizeStopReason(latestBlocked)}`
                  : 'Systemet har inte blockerat någon signal ännu.'}
              </span>
            </article>
          </div>

          <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Slutsats:</strong> {summary.conclusion}
          </div>
        </>
      )}
    </section>
  );
}

function OptScoreBadge({ score }) {
  const n = toNumber(score);
  const color = n == null ? '#94a3b8' : n >= 60 ? '#22c55e' : n >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <span className="opt-score-badge" style={{ background: `${color}18`, color, borderColor: `${color}50` }}>
      {n == null ? '–' : `${formatDecimal(n, 0, '–')}/100`}
    </span>
  );
}

function StatRow({ label, value, highlight }) {
  return (
    <div className="opt-stat-row">
      <span className="opt-stat-label">{label}</span>
      <span className={`opt-stat-value${highlight ? ' opt-stat-hi' : ''}`}>{value ?? '–'}</span>
    </div>
  );
}

function MiniBar({ pct, color }) {
  const n = toNumber(pct);
  return (
    <div className="opt-minibar-track">
      <div className="opt-minibar-fill" style={{ width: `${n == null ? 0 : Math.max(0, Math.min(100, n))}%`, background: color }} />
    </div>
  );
}

function ConfigCard({ config, rank }) {
  const [open, setOpen] = React.useState(false);
  if (!config?.stats) return null;
  const { winRatePct, timeoutRatePct, avgPnl, n } = config.stats;
  const winRate = toNumber(winRatePct);
  const timeoutRate = toNumber(timeoutRatePct);
  const pnl = toNumber(avgPnl);
  const isTop = rank <= 2;
  return (
    <div className={`opt-config-card ${isTop ? 'opt-config-top' : ''}`}>
      <div className="opt-config-header">
        <div className="opt-config-rank">#{rank}</div>
        <div className="opt-config-info">
          <div className="opt-config-label">{config.label}</div>
          <div className="opt-config-n">{formatInt(n, '–')} trades</div>
        </div>
        <OptScoreBadge score={config.score} />
      </div>
      <div className="opt-config-bars">
        <div className="opt-config-bar-row">
          <span>Win rate</span>
          <MiniBar pct={winRate} color={winRate == null ? '#94a3b8' : winRate >= 50 ? '#22c55e' : winRate >= 35 ? '#f59e0b' : '#ef4444'} />
          <span className="opt-bar-val">{winRate == null ? '–' : `${formatDecimal(winRate, 1, '–')}%`}</span>
        </div>
        <div className="opt-config-bar-row">
          <span>Timeout</span>
          <MiniBar pct={timeoutRate} color={timeoutRate == null ? '#94a3b8' : timeoutRate > 50 ? '#ef4444' : timeoutRate > 30 ? '#f59e0b' : '#22c55e'} />
          <span className="opt-bar-val">{timeoutRate == null ? '–' : `${formatDecimal(timeoutRate, 1, '–')}%`}</span>
        </div>
      </div>
      <div className={`opt-config-pnl ${pnl == null || pnl === 0 ? '' : pnl > 0 ? 'opt-pnl-pos' : 'opt-pnl-neg'}`}>
        {pnl == null ? '–' : formatSignedPct(pnl, 3, '–')} snitt P/L
      </div>
      <button className="opt-expand-btn" onClick={() => setOpen((v) => !v)} type="button">
        {open ? '▲ Dölj' : '▼ Parametrar'}
      </button>
      {open && (
        <div className="opt-config-params">
          {Object.entries(config.params || {}).map(([k, v]) => (
            <span key={k} className="opt-param-chip"><span>{k}</span>{v}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function WeakConfigCard({ config }) {
  if (!config?.stats) return null;
  const { winRatePct, timeoutRatePct, n } = config.stats;
  const winRate = toNumber(winRatePct);
  const timeoutRate = toNumber(timeoutRatePct);
  return (
    <div className="opt-weak-card">
      <div className="opt-weak-header">
        <span className="opt-weak-icon">⚠️</span>
        <div>
          <div className="opt-weak-label">{config.label}</div>
          <div className="opt-weak-n">{n} trades</div>
        </div>
        <OptScoreBadge score={config.score} />
      </div>
      {config.warning && <div className="opt-weak-warning">{config.warning}</div>}
      <div className="opt-weak-stats">
        <span>WR: {winRate == null ? '–' : `${formatDecimal(winRate, 1, '–')}%`}</span>
        <span>Timeout: {timeoutRate == null ? '–' : `${formatDecimal(timeoutRate, 1, '–')}%`}</span>
        <span>{formatInt(n, '–')} trades</span>
      </div>
    </div>
  );
}

function BucketBar({ items, scoreKey = 'score', labelKey = 'label', metricKey = 'stats', metricField = 'winRatePct' }) {
  if (!items?.length) return <div className="opt-empty">Ingen data</div>;
  const scores = items.map((item) => toNumber(item?.[scoreKey])).filter((value) => value !== null);
  const maxScore = scores.length ? Math.max(...scores) : null;
  return (
    <div className="opt-bucket-list">
      {items.map((item, i) => {
        const st = item?.[metricKey];
        if (!st) return null;
        const val = toNumber(st[metricField]);
        const color = val == null ? '#94a3b8' : val >= 50 ? '#22c55e' : val >= 35 ? '#f59e0b' : '#ef4444';
        const score = toNumber(item?.[scoreKey]);
        const isBest = maxScore !== null && (i === 0 || score === maxScore);
        return (
          <div key={`${item?.[labelKey] || i}`} className={`opt-bucket-row ${isBest ? 'opt-bucket-best' : ''}`}>
            <div className="opt-bucket-label">{item?.[labelKey]}</div>
            <div className="opt-bucket-bar-wrap">
              <MiniBar pct={val} color={color} />
            </div>
            <div className="opt-bucket-vals">
              <span style={{ color, fontWeight: 600 }}>{val == null ? '–' : `${formatDecimal(val, 1, '–')}%`}</span>
              <span className="opt-bucket-n">n={formatInt(st.n, '–')}</span>
              {isBest && <span className="opt-bucket-best-badge">✓ Bäst</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecommendationsList({ recs }) {
  if (!recs) return null;
  const green = normalizeArray(recs.green);
  const yellow = normalizeArray(recs.yellow);
  const red = normalizeArray(recs.red);
  return (
    <div className="opt-recs">
      {green.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-green-label">🟢 Rekommenderat</div>
          {green.map((r, i) => <div key={i} className="opt-rec-item opt-rec-green">{r}</div>)}
        </div>
      )}
      {yellow.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-yellow-label">🟡 Behöver mer data / Justera</div>
          {yellow.map((r, i) => <div key={i} className="opt-rec-item opt-rec-yellow">{r}</div>)}
        </div>
      )}
      {red.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-red-label">🔴 Undvik</div>
          {red.map((r, i) => <div key={i} className="opt-rec-item opt-rec-red">{r}</div>)}
        </div>
      )}
      {!green.length && !yellow.length && !red.length && (
        <div className="opt-empty">Inga rekommendationer ännu — kör mer paper trading.</div>
      )}
    </div>
  );
}

const OPTIMIZATION_SECTIONS = [
  { key: 'overview', label: 'Översikt', icon: '📊' },
  { key: 'configs', label: 'Konfigurationer', icon: '🏆' },
  { key: 'params', label: 'Parametrar', icon: '⚙️' },
  { key: 'exits_a', label: 'Exit-analys', icon: '↘️' },
  { key: 'markets', label: 'Marknader', icon: '🌍' },
  { key: 'batch', label: 'Batch', icon: '🧪' },
  { key: 'recs', label: 'Råd', icon: '💡' },
];

function buildOptimizationPrompt(optimization, sectionKey) {
  if (!optimization) return null;
  const overallStats = optimization.overallStats || optimization.overall_stats || {};
  const topConfigs = normalizeArray(optimization.topConfigs);
  const weakConfigs = normalizeArray(optimization.weakConfigs);
  const bestStrategy = optimization.daytradingStrategies?.bestStrategy || null;
  const pauseCandidates = normalizeArray(optimization.daytradingStrategies?.pauseCandidates || []);
  const batch = optimization.strategyBatchTesting || {};
  const sectionLabel = OPTIMIZATION_SECTIONS.find((section) => section.key === sectionKey)?.label || 'Översikt';

  const sectionData = {
    overview: {
      tradeCount: optimization.tradeCount,
      overallScore: optimization.overallScore,
      overallStats,
      bestStrategy: bestStrategy ? {
        strategy_name: bestStrategy.strategy_name,
        strategy_id: bestStrategy.strategy_id,
        label: bestStrategy.label,
        win_rate: bestStrategy.win_rate,
        trades: bestStrategy.trades,
        count: bestStrategy.count,
      } : null,
      topConfigs: topConfigs.slice(0, 4).map((item) => ({
        label: strategyLabel(item),
        score: item.score,
        stats: item.stats,
      })),
      weakConfigs: weakConfigs.slice(0, 4).map((item) => ({
        label: strategyLabel(item),
        score: item.score,
        stats: item.stats,
      })),
      recommendations: optimization.recommendations || {},
    },
    configs: {
      topConfigs: topConfigs.slice(0, 5).map((item) => ({
        label: strategyLabel(item),
        score: item.score,
        stats: item.stats,
        params: item.params,
      })),
      weakConfigs: weakConfigs.slice(0, 5).map((item) => ({
        label: strategyLabel(item),
        score: item.score,
        warning: item.warning,
        stats: item.stats,
      })),
    },
    params: {
      stopLoss: normalizeArray(optimization.stopLoss?.buckets).slice(0, 4),
      holdingTime: normalizeArray(optimization.holdingTime?.buckets).slice(0, 4),
      confidence: normalizeArray(optimization.confidence?.buckets).slice(0, 4),
      recommendations: {
        stopLoss: optimization.stopLoss?.recommendation || '',
        holdingTime: normalizeArray(optimization.holdingTime?.recommendations || []),
        confidence: normalizeArray(optimization.confidence?.recommendations || []),
      },
    },
    exits_a: {
      exitReasons: normalizeArray(optimization.exits?.byReason).slice(0, 5),
      timeoutCount: optimization.exits?.timeoutCount ?? null,
      timeoutPct: optimization.exits?.timeoutPct ?? null,
      motorExitStats: optimization.exits?.motorExitStats || null,
      manualExitStats: optimization.exits?.manualExitStats || null,
      recommendations: normalizeArray(optimization.exits?.recommendations || []),
    },
    markets: {
      markets: normalizeArray(optimization.markets?.markets).slice(0, 5),
      combinations: normalizeArray(optimization.combinations?.bestCombinations).slice(0, 5),
      recommendations: normalizeArray(optimization.markets?.recommendations || []),
    },
    batch: {
      latestBatch: batch.latestBatch || null,
      bestStrategy: batch.bestStrategy || null,
      bestStopLoss: batch.bestStopLoss || null,
      bestTakeProfit: batch.bestTakeProfit || null,
      bestConfidence: batch.bestConfidence || null,
      pauseCandidates: pauseCandidates.slice(0, 6).map((item) => ({
        strategy_name: item.strategy_name,
        strategy_id: item.strategy_id,
        name: item.name,
        score: item.score,
        win_rate: item.win_rate,
        trades: item.trades,
      })),
      recommendations: batch.recommendations || optimization.recommendations || {},
    },
    recs: {
      recommendations: optimization.recommendations || {},
    },
  };

  return {
    question: `Förklara AI Optimization Center - ${sectionLabel}. Vad betyder siffrorna och vilket nästa steg är rimligt?`,
    context: {
      module: 'ai_optimization_center',
      moduleLabel: 'AI Optimization Center',
      sectionKey,
      sectionLabel,
      safety: {
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
      },
      tradeCount: optimization.tradeCount,
      overallScore: optimization.overallScore,
      overallStats,
      sectionData: sectionData[sectionKey] || sectionData.overview,
    },
  };
}

function optimizationSectionTitle(title, sectionKey, onAsk, description) {
  return (
    <div className="opt-section-head">
      <div>
        <div className="opt-subsection">{title}</div>
        {description && <div className="opt-rec-note" style={{ marginTop: 8, marginBottom: 0 }}>{description}</div>}
      </div>
      <button className="opt-rebuild-btn" onClick={() => onAsk(sectionKey)} type="button">
        Fråga AI om detta
      </button>
    </div>
  );
}

function OptimizationCenter({ optimization }) {
  const [section, setSection] = React.useState('overview');
  const tradeCount = toNumber(optimization?.tradeCount);
  const overallStats = optimization?.overallStats || optimization?.overall_stats || null;
  const overallScore = toNumber(optimization?.overallScore);
  const topConfigs = normalizeArray(optimization?.topConfigs);
  const weakConfigs = normalizeArray(optimization?.weakConfigs);
  const stopLoss = optimization?.stopLoss || {};
  const holdingTime = optimization?.holdingTime || {};
  const exitsData = optimization?.exits || {};
  const combinations = optimization?.combinations || {};
  const markets = optimization?.markets || {};
  const confidence = optimization?.confidence || {};
  const recommendations = optimization?.recommendations || {};
  const strategyBatchTesting = optimization?.strategyBatchTesting || {};
  const bestStrategy = optimization?.daytradingStrategies?.bestStrategy || null;
  const pauseCandidates = normalizeArray(optimization?.daytradingStrategies?.pauseCandidates || []);
  const activeSection = OPTIMIZATION_SECTIONS.find((item) => item.key === section) || OPTIMIZATION_SECTIONS[0];

  function askAi(sectionKey = section) {
    const prompt = buildOptimizationPrompt(optimization, sectionKey);
    if (!prompt) return;
    window.dispatchEvent(new CustomEvent('ai-copilot:open', {
      detail: {
        question: prompt.question,
        context: prompt.context,
        label: `AI Optimization Center · ${OPTIMIZATION_SECTIONS.find((item) => item.key === sectionKey)?.label || 'Översikt'}`,
        autoAsk: true,
        source: 'supervisor-optimization-center',
      },
    }));
  }

  if (!optimization) {
    return (
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>🧠 AI Optimization Center</h2>
            <p>Read-only analys av historiska trades. Ingen livehandel, inga ordrar och inga apply-knappar.</p>
          </div>
        </div>
        <div className="opt-empty">Ingen data tillgänglig ännu.</div>
      </section>
    );
  }

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>🧠 AI Optimization Center</h2>
          <p>Samma analysmotor som i Lab, men visad i Supervisor-format och låst till read-only.</p>
        </div>
      </div>

      <div className="opt-panel">
        <div className="opt-header">
          <div className="opt-header-left">
            <div className="opt-title">🤖 AI Optimization Agent</div>
            <div className="opt-subtitle">
              Analyserar {formatInt(tradeCount, 'Ej konfigurerad')} historiska trades och förklarar vad som fungerar, vad som blockeras och vad nästa steg är.
            </div>
          </div>
          <div className="opt-header-right">
            <button className="opt-rebuild-btn" onClick={askAi} type="button" title="Öppna AiCopilot med aktuell flik">
              Fråga AI om detta
            </button>
          </div>
        </div>

      <div className="opt-safety-note">
        🔒 actions_allowed=false · can_place_orders=false · live_trading_enabled=false — Bara analys
      </div>

        <div className="opt-section-nav">
          {OPTIMIZATION_SECTIONS.map((item) => (
            <button
              key={item.key}
              className={`opt-section-btn${section === item.key ? ' opt-section-active' : ''}`}
              onClick={() => setSection(item.key)}
              type="button"
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="opt-rec-note" style={{ marginTop: 14 }}>
          Aktiv flik: {activeSection.label}. AiCopilot får sammanhang från just denna vy när du frågar.
        </div>

        {section === 'overview' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Översikt', 'overview', askAi, 'Sammantagen läsning av historiska trades och bästa nuvarande riktning.')}
            {overallStats && (
              <div className="opt-overview-grid">
                <div className="opt-overview-card">
                  <div className="opt-ov-val" style={{ color: toNumber(overallStats.winRatePct) == null ? '#94a3b8' : toNumber(overallStats.winRatePct) >= 50 ? '#22c55e' : '#f59e0b' }}>
                    {toNumber(overallStats.winRatePct) == null ? '–' : `${formatDecimal(overallStats.winRatePct, 1, '–')}%`}
                  </div>
                  <div className="opt-ov-label">Total win rate</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val" style={{ color: toNumber(overallStats.timeoutRatePct) == null ? '#94a3b8' : toNumber(overallStats.timeoutRatePct) > 40 ? '#ef4444' : '#22c55e' }}>
                    {toNumber(overallStats.timeoutRatePct) == null ? '–' : `${formatDecimal(overallStats.timeoutRatePct, 1, '–')}%`}
                  </div>
                  <div className="opt-ov-label">Timeout-rate</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val" style={{ color: toNumber(overallStats.avgPnl) == null ? '#94a3b8' : toNumber(overallStats.avgPnl) >= 0 ? '#22c55e' : '#ef4444' }}>
                    {formatSignedPct(overallStats.avgPnl, 3, '–')}
                  </div>
                  <div className="opt-ov-label">Snitt P/L</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{formatInt(tradeCount, '–')}</div>
                  <div className="opt-ov-label">Trades analyserade</div>
                </div>
              </div>
            )}
            <div className="opt-subsection">Snabba insikter</div>
            <RecommendationsList recs={recommendations} />
            <div className="opt-rec-note">Bästa strategi: {bestStrategy ? strategyLabel(bestStrategy) : 'Ingen tydlig vinnare ännu'}.</div>
          </div>
        )}

        {section === 'configs' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Konfigurationer', 'configs', askAi, 'Jämför starkaste och svagaste konfigurationer.')}
            {topConfigs?.length > 0
              ? topConfigs.slice(0, 5).map((c, i) => <ConfigCard key={c.id || c.key || i} config={c} rank={i + 1} />)
              : <div className="opt-empty">Inte tillräcklig data för konfigurationsranking.</div>
            }
            {weakConfigs?.length > 0 && (
              <>
                <div className="opt-subsection opt-weak-sub">⚠️ Svaga konfigurationer</div>
                {weakConfigs.map((c, i) => <WeakConfigCard key={c.id || c.key || i} config={c} />)}
              </>
            )}
          </div>
        )}

        {section === 'params' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Parametrar', 'params', askAi, 'Här visas vilka parametrar som ger bäst win rate, timeout och balans.')}
            <div className="opt-subsection">Stop Loss</div>
            {stopLoss?.buckets?.length > 0
              ? <BucketBar items={stopLoss.buckets} />
              : <div className="opt-empty">Ingen SL-data.</div>
            }
            {stopLoss?.recommendation && (
              <div className="opt-rec-note">💡 {stopLoss.recommendation}</div>
            )}

            <div className="opt-subsection">Hålltid (Holding Time)</div>
            {holdingTime?.buckets?.length > 0
              ? <BucketBar items={holdingTime.buckets} />
              : <div className="opt-empty">Ingen hålltid-data.</div>
            }
            {normalizeArray(holdingTime?.recommendations).map((r, i) => (
              <div key={`ht-${i}`} className="opt-rec-note">💡 {r}</div>
            ))}

            <div className="opt-subsection">Styrketröskell (Confidence)</div>
            {confidence?.buckets?.length > 0
              ? <BucketBar items={confidence.buckets} />
              : <div className="opt-empty">Ingen styrka-data.</div>
            }
            {normalizeArray(confidence?.recommendations).map((r, i) => (
              <div key={`cf-${i}`} className="opt-rec-note">💡 {r}</div>
            ))}
          </div>
        )}

        {section === 'exits_a' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Exit-analys', 'exits_a', askAi, 'Jämför exit-orsaker, timeout-rate och exitmotor mot manuell exit.')}
            <div className="opt-subsection">Exit-typer</div>
            {exitsData?.byReason?.length > 0
              ? <BucketBar items={exitsData.byReason} labelKey="reasonSv" />
              : <div className="opt-empty">Ingen exit-data.</div>
            }
            <div className="opt-exit-meta">
              <div className="opt-exit-stat">
                <span>Timeouts:</span>
                <strong style={{ color: toNumber(exitsData?.timeoutPct) == null ? '#94a3b8' : toNumber(exitsData?.timeoutPct) > 40 ? '#ef4444' : '#22c55e' }}>
                  {formatInt(exitsData?.timeoutCount, '–')} ({toNumber(exitsData?.timeoutPct) == null ? '–' : `${formatDecimal(exitsData.timeoutPct, 1, '–')}%`})
                </strong>
              </div>
              {exitsData?.motorExitStats && (
                <div className="opt-exit-stat">
                  <span>Exitmotor:</span>
                  <strong>{toNumber(exitsData.motorExitStats.winRatePct) == null ? '–' : `${formatDecimal(exitsData.motorExitStats.winRatePct, 1, '–')}%`} WR ({formatInt(exitsData.motorExitStats.n, '–')} trades)</strong>
                </div>
              )}
              {exitsData?.manualExitStats && (
                <div className="opt-exit-stat">
                  <span>Manuell exit:</span>
                  <strong>{toNumber(exitsData.manualExitStats.winRatePct) == null ? '–' : `${formatDecimal(exitsData.manualExitStats.winRatePct, 1, '–')}%`} WR ({formatInt(exitsData.manualExitStats.n, '–')} trades)</strong>
                </div>
              )}
            </div>
            {normalizeArray(exitsData?.recommendations).map((r, i) => (
              <div key={`ex-${i}`} className="opt-rec-note">💡 {r}</div>
            ))}
          </div>
        )}

        {section === 'markets' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Marknader', 'markets', askAi, 'Titta på vilka marknader och kombinationer som fungerar bäst.')}
            <div className="opt-subsection">Marknadstyper</div>
            {markets?.markets?.length > 0 ? (
              <div className="opt-market-list">
                {markets.markets.map((m, i) => (
                  <div key={i} className="opt-market-card">
                    <div className="opt-market-header">
                      <span className="opt-market-name">{m.marketSv}</span>
                      <OptScoreBadge score={m.score} />
                    </div>
                    {m.stats && (
                      <div className="opt-market-stats">
                        <StatRow label="Win rate" value={toNumber(m.stats.winRatePct) == null ? '–' : `${formatDecimal(m.stats.winRatePct, 1, '–')}%`} highlight={toNumber(m.stats.winRatePct) !== null && toNumber(m.stats.winRatePct) >= 50} />
                        <StatRow label="Timeout" value={toNumber(m.stats.timeoutRatePct) == null ? '–' : `${formatDecimal(m.stats.timeoutRatePct, 1, '–')}%`} />
                        <StatRow label="Trades" value={formatInt(m.stats.n, '–')} />
                        {m.avgHoldMin != null && <StatRow label="Snitt hålltid" value={`${formatDecimal(m.avgHoldMin, 1, '–')} min`} />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : <div className="opt-empty">Ingen marknadsdata.</div>}
            {normalizeArray(markets?.recommendations).map((r, i) => (
              <div key={`m-${i}`} className="opt-rec-note">💡 {r}</div>
            ))}
            <div className="opt-subsection">Bästa signalkombinationer</div>
            {combinations?.bestCombinations?.length > 0 ? (
              <div className="opt-combo-list">
                {combinations.bestCombinations.map((c, i) => (
                  <div key={i} className="opt-combo-card">
                    <div className="opt-combo-header">
                      <span className="opt-combo-label">{c.label}</span>
                      <OptScoreBadge score={c.score} />
                    </div>
                    {c.stats && <div className="opt-combo-wr">{toNumber(c.stats.winRatePct) == null ? '–' : `${formatDecimal(c.stats.winRatePct, 1, '–')}%`} WR · {formatInt(c.stats.n, '–')} trades</div>}
                  </div>
                ))}
              </div>
            ) : <div className="opt-empty">Behöver fler trades för kombinations-analys.</div>}
          </div>
        )}

        {section === 'batch' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Batch', 'batch', askAi, 'Läs batchresultat och se vilka strategier eller parametrar som sticker ut.')}
            {strategyBatchTesting?.latestBatch?.id ? (
              <>
                <div className="opt-overview-grid">
                  <div className="opt-overview-card">
                    <div className="opt-ov-val">{strategyBatchTesting.bestStrategy ? strategyLabel(strategyBatchTesting.bestStrategy) : '–'}</div>
                    <div className="opt-ov-label">Bästa strategi</div>
                  </div>
                  <div className="opt-overview-card">
                    <div className="opt-ov-val">{strategyBatchTesting.bestStopLoss?.key ?? '–'}</div>
                    <div className="opt-ov-label">Bästa SL</div>
                  </div>
                  <div className="opt-overview-card">
                    <div className="opt-ov-val">{strategyBatchTesting.bestTakeProfit?.key ?? '–'}</div>
                    <div className="opt-ov-label">Bästa TP</div>
                  </div>
                  <div className="opt-overview-card">
                    <div className="opt-ov-val">{strategyBatchTesting.bestConfidence?.key ?? '–'}</div>
                    <div className="opt-ov-label">Bästa confidence</div>
                  </div>
                </div>
                <div className="opt-rec-note">
                  Batch {strategyBatchTesting.latestBatch.name} · {getBatchUiStatus(strategyBatchTesting.latestBatch).emoji} {getBatchUiStatus(strategyBatchTesting.latestBatch).label} · {formatInt(strategyBatchTesting.latestBatch.progress?.completed, '–')}/{formatInt(strategyBatchTesting.latestBatch.progress?.total, '–')}
                </div>
                <RecommendationsList recs={strategyBatchTesting.recommendations} />
                {pauseCandidates?.length > 0 && (
                  <>
                    <div className="opt-subsection opt-weak-sub">Strategier att pausa/testa om</div>
                    <div className="opt-market-list">
                      {pauseCandidates.slice(0, 6).map((s, i) => (
                        <div key={`${s.strategy_id}-${i}`} className="opt-market-card">
                          <div className="opt-market-header">
                            <span className="opt-market-name">{strategyLabel(s)}</span>
                            <OptScoreBadge score={s.score} />
                          </div>
                          <div className="opt-market-stats">
                            <StatRow label="Win rate" value={toNumber(s.win_rate) == null ? '–' : `${formatDecimal(s.win_rate, 1, '–')}%`} />
                            <StatRow label="Trades" value={formatInt(s.trades, '–')} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="opt-rec-note">
                  Körning sker i Lab. Här visas bara resultat och tolkning.{' '}
                  <Link to="/lab?tab=batch">Öppna Lab för att köra eller jämföra batcher.</Link>
                </div>
              </>
            ) : (
              <div className="opt-empty">
                Inga batch-resultat ännu.{' '}
                <Link to="/lab?tab=batch">Öppna Lab för att köra Batch-test.</Link>
              </div>
            )}
          </div>
        )}

        {section === 'recs' && (
          <div className="opt-section-content">
            {optimizationSectionTitle('Råd', 'recs', askAi, 'Sammanfattade rekommendationer baserade på optimeringsläget just nu.')}
            <RecommendationsList recs={recommendations} />
            <div className="opt-rec-note">
              Supervisor visar råd och tolkning. Själva appliceringen och batch-körningarna görs i Lab.
            </div>
          </div>
        )}
      </div>
    </section>
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
  const daytradingLearning = unwrap(resources.daytradingLearningSummary)?.data || null;
  const learningSummary = daytradingLearning?.summary || null;
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
        learningSummary?.win_rate != null ? `Samlar lärdomar med win rate ${formatPct(learningSummary.win_rate, 0)}.` : '',
        learningSummary?.avg_pl != null ? `Snitt-P/L ${formatSignedPct(learningSummary.avg_pl, 2)}.` : '',
      ),
      points: [
        `${formatInt(learningSummary?.trades_total, 'Ingen data ännu')} trades totalt`,
        `${formatInt(learningSummary?.closed_trades, 'Ingen data ännu')} stängda trades`,
        `${formatInt(daytradingLearning?.by_strategy?.length, 'Ingen data ännu')} strategier med lärande`,
        `${formatInt(learningSummary?.needs_more_data_count, 'Ingen data ännu')} behöver mer data`,
        `${formatInt(daytradingLearning?.skip_reasons?.length, 'Ingen data ännu')} skip-orsaker`,
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
        `Trades ${formatInt(optimizationStats?.n ?? optimization?.tradeCount, 'Ingen data ännu')}`,
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
        `Win rate ${formatPct(paperPerformance?.winRate ?? paperPerformance?.win_rate, 1, 'Ingen data ännu')} (${winRateConfidence(paperPerformance?.totalTrades ?? paperPerformance?.trades ?? paperPerformance?.total_trades ?? paperPerformance?.count)})`,
        `Timeout ${formatPct(paperPerformance?.timeoutRate ?? paperPerformance?.timeout_rate, 0, 'Ingen data ännu')}`,
        `Snitt-P/L ${formatSignedPct(paperPerformance?.avgPnlPct ?? paperPerformance?.avg_pnl, 2, 'Ingen data ännu')}`,
        paperPerformance?.latest_trade?.symbol ? `Senaste trade ${paperPerformance.latest_trade.symbol}` : 'Senaste trade: Ingen data ännu',
      ],
      source: '/api/paper-trading/status + /performance',
    },
    {
      key: 'runtime',
      title: 'Runtime-översikt',
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
  const daytradingLearning = unwrap(resources.daytradingLearningSummary)?.data || null;
  const learningSummary = daytradingLearning?.summary || null;
  const paperAllowlistStatus = unwrap(resources.paperAllowlistStatus);
  const paperEvents = unwrap(resources.paperEvents);
  const candidatesRecent = unwrap(resources.candidatesRecent);
  const candidatesStats = unwrap(resources.candidatesStats);
  const replaySessions = unwrap(resources.replaySessions);
  const dataCoverageStatus = unwrap(resources.dataCoverageStatus);
  const priority = unwrap(resources.priority);
  const optimization = unwrap(resources.optimization);
  const marketRegime = unwrap(resources.marketRegime);
  const paperStatus = unwrap(resources.paperStatus);
  const paperPerformance = unwrap(resources.paperPerformance);
  const supervisorOverview = unwrap(resources.supervisorOverview);
  const supervisorPaperRuntimeSummary = supervisorOverview?.paperRuntimeSummary?.summary || {};
  const recommendation = unwrap(resources.recommendation);
  const runtime = unwrap(resources.runtimeStrategies);
  const registryStatus = unwrap(resources.registryStatus);
  const strategyScoreStatus = unwrap(resources.strategyScoreStatus);
  const testPlannerStatus = unwrap(resources.testPlannerStatus);
  const tradingViewStatus = unwrap(resources.tradingviewStatus);

  const runtimeSummary = runtime?.summary || {};
  const hasRuntimeStrategies = Array.isArray(runtime?.strategies);
  const runtimeStrategies = normalizeArray(runtime?.strategies);
  const topFocus = normalizeArray(priority?.topFocus || []);
  const avoidList = normalizeArray(priority?.avoid || []);
  const hasPaperAllowlistRows = Array.isArray(paperAllowlistStatus?.allowlist);
  const paperAllowlistRows = normalizeArray(paperAllowlistStatus?.allowlist);
  const hasCandidateRows = Array.isArray(candidatesRecent?.candidates);
  const candidateRows = normalizeArray(candidatesRecent?.candidates);
  const hasReplaySessions = Array.isArray(replaySessions?.sessions);
  const replayRows = normalizeArray(replaySessions?.sessions);
  const hasPaperEventRows = Array.isArray(paperEvents?.events);
  const paperEventRows = normalizeArray(paperEvents?.events);
  const allowlistApprovedCount = toNumber(paperAllowlistStatus?.totalApproved) ?? (hasPaperAllowlistRows ? paperAllowlistRows.length : null);
  const allowlistReadyCount = toNumber(paperAllowlistStatus?.readyForPaperRuntime) ?? (hasPaperAllowlistRows ? paperAllowlistRows.filter((row) => row?.paperRuntimeReady !== false).length : null);
  const candidateCount = toNumber(candidatesStats?.total) ?? (hasCandidateRows ? candidateRows.length : null);
  const replayCount = hasReplaySessions ? replayRows.length : null;
  const paperBlockCount = toNumber(paperStatus?.summary?.blockedCount)
    ?? toNumber(supervisorPaperRuntimeSummary.blockedCount)
    ?? (hasPaperEventRows ? paperEventRows.filter((event) => {
    const type = eventTypeKey(event);
    const decision = String(event?.decision || '').toLowerCase();
    return type.includes('blocked') || type.includes('skip') || type.includes('gate') || decision === 'blocked' || decision === 'skipped';
  }).length : null);
  const coverageScore = toNumber(dataCoverageStatus?.total_coverage_score);
  const missingDataCount = toNumber(dataCoverageStatus?.symbols_missing_data);
  const catalogStatusCounts = runtimeStrategies.reduce((acc, strategy) => {
    const key = strategyCatalogStatusKey(strategy);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const catalogStatusCount = (key) => (hasRuntimeStrategies ? (catalogStatusCounts[key] ?? 0) : null);
  const catalogStatusRows = runtimeStrategies
    .map((strategy) => {
      const statusKey = strategyCatalogStatusKey(strategy);
      const model = supervisorV2StrategyModel(strategy);
      return {
        id: model.strategyId || strategy.id || strategy.strategy_id || '',
        name: strategyDisplayName(model, 'Okänd strategi'),
        statusKey,
        statusLabel: strategyCatalogStatusLabel(statusKey),
        supportsScanner: strategy.supportsScanner === true,
        supportsReplay: strategy.supportsReplay === true,
        supportsBatch: strategy.supportsBatch === true,
        supportsPaper: strategy.supportsPaper === true,
        supportsLearning: strategy.supportsLearning === true,
      };
    })
    .sort((a, b) => a.statusKey.localeCompare(b.statusKey) || String(a.name).localeCompare(String(b.name)));

  const selectedStrategies = runtimeStrategies.filter((strategy) => strategy.enabled_by_user === true);
  const runnableStrategies = runtimeStrategies.filter((strategy) => strategy.can_create_paper_trade === true);
  const selectedButNotRunnable = selectedStrategies.filter((strategy) => strategy.can_create_paper_trade !== true);
  const noEntryRule = runtimeStrategies.filter((strategy) => strategy.runtime_status === 'no_entry_rule');
  const noMapping = runtimeStrategies.filter((strategy) => strategy.runtime_status === 'not_connected');
  const selectedButNotRunnableCount = hasRuntimeStrategies ? selectedButNotRunnable.length : null;
  const totalCount = toNumber(runtimeSummary.total) ?? (hasRuntimeStrategies ? runtimeStrategies.length : null);
  const paperTradeCount = toNumber(runtimeSummary.can_create_paper_trade_count) ?? (hasRuntimeStrategies ? runnableStrategies.length : null);
  const selectedCount = toNumber(runtimeSummary.enabled_by_user) ?? (hasRuntimeStrategies ? selectedStrategies.length : null);
  const noEntryRuleCount = toNumber(runtimeSummary.runtime_no_entry_rule) ?? (hasRuntimeStrategies ? noEntryRule.length : null);
  const noMappingCount = toNumber(runtimeSummary.runtime_not_connected) ?? (hasRuntimeStrategies ? noMapping.length : null);

  const systemProblems = uniqueText([
    ...normalizeArray(safety?.warnings),
    ...normalizeArray(health?.issues),
    ...normalizeArray(health?.warnings),
    ...((paperPerformance?.timeoutRate ?? paperPerformance?.timeout_rate) != null && toNumber(paperPerformance?.timeoutRate ?? paperPerformance?.timeout_rate) >= 30 ? [`Paper trading timeout-rate ${formatPct(paperPerformance?.timeoutRate ?? paperPerformance?.timeout_rate, 0)}.`] : []),
    ...(learningSummary?.trades_total != null ? [] : ['Lärandesammanfattningen saknar underlag.']),
    ...(learningConnectorStatus?.errors?.length ? [`Learning Connector har ${formatInt(learningConnectorStatus.errors.length)} fel i kö.`] : []),
    ...(pipelineStatus?.warnings?.length ? [`Pipeline har ${formatInt(pipelineStatus.warnings.length)} varningar.`] : []),
    ...(registryStatus?.ok === false ? ['Strategy Registry-data är inte tillgänglig.'] : []),
    ...(strategyScoreStatus?.ok === false ? ['Strategy Score-data är inte tillgänglig.'] : []),
    ...(tradingViewStatus?.webhook_auth_configured === false ? ['TradingView-webhook auth är inte konfigurerad.'] : []),
    ...(status?.ok === false ? ['Backend svarar inte.'] : []),
    ...(health?.ok === false ? ['Systemhälsa är inte tillgänglig.'] : []),
    ...(runtime?.ok === false ? ['Runtime-data är inte tillgänglig.'] : []),
  ]);

  const marketMode = marketRiskLabel(marketRegime);
  const volatilityText = marketVolatilityLabel(marketRegime);
  const systemStatus = systemProblems.length > 0 ? 'Problem' : 'Stabilt';
  const safetyMode = textValue(safety?.mode ?? safety?.trading_mode ?? safety?.profile, 'Ingen data ännu');
  const safetyActionsAllowed = safety?.actions_allowed;
  const safetyCanPlaceOrders = safety?.can_place_orders;
  const safetyLiveTradingEnabled = safety?.live_trading_enabled;
  const tradingMode = safetyMode;

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
    : selectedButNotRunnableCount === 0 ? 'Inga valda strategier är blockerade' : 'Ingen runtime-data ännu';
  const entryRuleLabel = noEntryRuleCount > 0
    ? `${noEntryRuleCount} saknar entry-regel`
    : noEntryRuleCount === 0 ? 'Ingen strategi saknar entry-regel' : 'Ingen runtime-data ännu';
  const mappingLabel = noMappingCount > 0
    ? `${noMappingCount} saknar mapping till runtime`
    : noMappingCount === 0 ? 'Ingen strategi saknar mapping' : 'Ingen runtime-data ännu';

  const totalCountText = formatInt(totalCount, 'Ingen data ännu');
  const selectedCountText = formatInt(selectedCount, 'Ingen data ännu');
  const paperTradeCountText = formatInt(paperTradeCount, 'Ingen data ännu');
  const allowlistApprovedCountText = formatInt(allowlistApprovedCount, 'Ingen data ännu');
  const selectedButNotRunnableCountText = formatInt(selectedButNotRunnableCount, 'Ingen data ännu');
  const systemSummary = systemProblems.length === 0
    ? `${totalCountText} strategier finns i katalogen, ${selectedCountText} är aktiva, ${paperTradeCountText} har teknisk paper-koppling och ${allowlistApprovedCountText} är godkända i allowlist just nu.`
    : `${totalCountText} strategier finns i katalogen, ${selectedCountText} är aktiva, ${paperTradeCountText} har teknisk paper-koppling och ${allowlistApprovedCountText} är godkända i allowlist just nu. ${selectedButNotRunnableCountText} strategier är valda men saknar körbar koppling.`;

  const systemSummaryExtra = uniqueText([
    selectedCount > 0 ? `${selectedCount} strategier är valda.` : '',
    noEntryRuleCount > 0 ? `${noEntryRuleCount} strategier saknar entry-regel.` : '',
    noMappingCount > 0 ? `${noMappingCount} strategier saknar mapping till runtime.` : '',
    paperTradeCount > 0 ? `${paperTradeCount} strategier har teknisk paper-koppling, men ${allowlistApprovedCountText} är godkända i allowlist.` : paperTradeCount === 0 ? 'Ingen strategi har teknisk paper-koppling ännu.' : '',
    allowlistApprovedCount > 0 ? `${allowlistApprovedCount} strategier är godkända i allowlist.` : allowlistApprovedCount === 0 ? 'Inga strategier är godkända i allowlist ännu.' : '',
    candidateCount === 0 ? 'Just nu finns inga aktuella kandidater.' : candidateCount === null ? '' : `${candidateCount} kandidater finns just nu.`,
    replayCount === 0 ? 'Replay-underlag saknas ännu.' : replayCount === null ? '' : `${replayCount} replay-sessioner finns.`,
    coverageScore != null ? `Data coverage: ${coverageScore}/100.` : '',
    missingDataCount != null && missingDataCount > 0 ? `${missingDataCount} symboler saknar data.` : '',
    daytradingLearning?.summary?.best_strategy?.key ? `Bäst i learning: ${daytradingLearning.summary.best_strategy.key}.` : '',
  ]);

  const registrySummary = {
    total: toNumber(registryStatus?.total_strategies),
    active: toNumber(registryStatus?.active_strategies),
    tradingview: toNumber(registryStatus?.tradingview_strategies),
    paused: toNumber(registryStatus?.paused_strategies),
    deprecated: toNumber(registryStatus?.deprecated_strategies),
    latestTradingView: registryStatus?.latest_tradingview_strategy || null,
    latestBlockedReason: registryStatus?.latest_blocked_reason || null,
  };

  const hasScoreStrategies = Array.isArray(strategyScoreStatus?.strategies);
  const scoreStrategies = normalizeArray(strategyScoreStatus?.strategies);
  const scoreTop = scoreStrategies[0] || strategyScoreStatus?.top_scores?.[0] || null;
  const scoreWeak = strategyScoreStatus?.weakest_scores?.[0] || scoreStrategies[scoreStrategies.length - 1] || null;
  const scoreTopDrilldown = normalizeArray(strategyScoreStatus?.top_strategies).slice(0, 5);
  const scoreWeakDrilldown = normalizeArray(strategyScoreStatus?.weak_strategies).slice(0, 5);
  const scoreUncertainDrilldown = normalizeArray(strategyScoreStatus?.uncertain_strategies).slice(0, 5);
  const scoreTradingViewDrilldown = normalizeArray(strategyScoreStatus?.tradingview_strategies).slice(0, 5);
  const scoreInternalDrilldown = normalizeArray(strategyScoreStatus?.internal_strategies).slice(0, 5);
  const scoreNextTestsDrilldown = normalizeArray(strategyScoreStatus?.recommended_next_tests).slice(0, 5);
  const scoreTopFallback = scoreStrategies.filter((row) => row.status !== 'paused' && row.status !== 'deprecated').slice(0, 5);
  const scoreWeakFallback = [...scoreStrategies].reverse().slice(0, 5);
  const scoreUncertainFallback = scoreStrategies
    .filter((row) => row.confidence < 50 || row.sample_size < 10)
    .sort((a, b) => a.confidence - b.confidence || a.sample_size - b.sample_size || a.score - b.score)
    .slice(0, 5);
  const scoreTradingViewFallback = scoreStrategies.filter((row) => row.source === 'tradingview').slice(0, 5);
  const scoreInternalFallback = scoreStrategies.filter((row) => row.source === 'internal').slice(0, 5);
  const scoreNextTestsFallback = scoreStrategies
    .filter((row) => row.status !== 'paused' && row.status !== 'deprecated')
    .filter((row) => String(row.recommended_action || '').toLowerCase().includes('replay') || String(row.recommended_action || '').toLowerCase().includes('batch'))
    .slice(0, 5);
  const scoreSummary = {
    total: toNumber(strategyScoreStatus?.total_strategies) ?? (hasScoreStrategies ? scoreStrategies.length : null),
    uncertain: toNumber(strategyScoreStatus?.uncertain_count) ?? (Array.isArray(strategyScoreStatus?.uncertain_strategies) ? scoreUncertainDrilldown.length : null),
    top: scoreTop,
    weak: scoreWeak,
    topDrilldown: scoreTopDrilldown.length > 0 ? scoreTopDrilldown : scoreTopFallback,
    weakDrilldown: scoreWeakDrilldown.length > 0 ? scoreWeakDrilldown : scoreWeakFallback,
    uncertainDrilldown: scoreUncertainDrilldown.length > 0 ? scoreUncertainDrilldown : scoreUncertainFallback,
    tradingviewDrilldown: scoreTradingViewDrilldown.length > 0 ? scoreTradingViewDrilldown : scoreTradingViewFallback,
    internalDrilldown: scoreInternalDrilldown.length > 0 ? scoreInternalDrilldown : scoreInternalFallback,
    nextTestsDrilldown: scoreNextTestsDrilldown.length > 0 ? scoreNextTestsDrilldown : scoreNextTestsFallback,
  };
  const plannerSummary = testPlannerStatus?.summary || {};
  const plannerRecommendations = normalizeArray(testPlannerStatus?.recommendations).slice(0, 5);

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
    `${totalCountText} strategier i katalogen`,
    `${selectedCountText} aktiva strategier`,
    `${paperTradeCountText} tekniskt paper-kopplade`,
    `${allowlistApprovedCountText} godkända i allowlist`,
    candidateCount === 0 ? 'Inga aktuella kandidater just nu' : candidateCount === null ? '' : `${candidateCount} kandidater just nu`,
    paperBlockCount > 0 ? `${paperBlockCount} blockerade paper-events senaste perioden` : paperBlockCount === 0 ? 'Inga blockerade paper-events senaste perioden' : '',
  ]);

  const actionItems = [];
  if (marketMode === 'Risk-Off') {
    actionItems.push('Var försiktig med long-signaler. Prioritera test och riskkontroll.');
  }
  if (selectedButNotRunnableCount > 0) {
    actionItems.push('Kontrollera Trading OS-vyn och granska rekommenderade tester.');
  }
  if (candidateCount === 0) {
    actionItems.push('Det finns inga aktuella kandidater att öppna just nu. Vänta på nya signaler eller mer data.');
  }
  if (noEntryRuleCount > 0) {
    actionItems.push('Implementera entry-regler för strategier som är valda men inte körbara.');
  }
  if (noMappingCount > 0) {
    actionItems.push('Koppla strategier som saknar mapping till runtime.');
  }
  if (hasConflict) {
    actionItems.push('Kontrollera strategikonflikten i Trading OS och Insikter.');
  }
  if (actionItems.length === 0) {
    actionItems.push('Testa den bästa strategin i paper och följ upp win rate med fler trades.');
  }

  const recommendationLabel = systemProblems.length > 0 || marketMode === 'Risk-Off'
    ? 'Undvik'
    : bestStrategy && candidateCount > 0 && allowlistApprovedCount > 0
      ? 'Testa'
      : 'Vänta';

  const riskSafetyPoints = uniqueText([
    `Market regime: ${marketMode}`,
    `Volatilitet: ${volatilityText}`,
    `actions_allowed=${onOffLabel(safetyActionsAllowed)}`,
    `can_place_orders=${onOffLabel(safetyCanPlaceOrders)}`,
    `live_trading_enabled=${onOffLabel(safetyLiveTradingEnabled)}`,
    'Supervisor är read-only. Den visar beslut och rekommendationer, men ändrar inte strategier.',
    marketMode === 'Risk-Off' ? 'Var försiktig med long-signaler. Prioritera test och riskkontroll.' : '',
  ]).slice(0, 5);

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
    paperAllowlistStatus,
    paperEvents,
    candidatesRecent,
    candidatesStats,
    replaySessions,
    dataCoverageStatus,
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
    allowlistApprovedCount,
    allowlistReadyCount,
    candidateCount,
    replayCount,
    coverageScore,
    missingDataCount,
    paperBlockCount,
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
    registrySummary,
    scoreSummary,
    testPlannerStatus,
    daytradingLearning,
    learningSummary,
    tradingViewStatus,
    hasConflict,
    conflictKeys,
    conflictMessage: hasConflict
      ? 'Strategikonflikt upptäckt: samma strategi förekommer både som rekommenderad och att undvika. Granska Trading OS-vyn och kontrollera rekommenderade tester och testkön.'
      : '',
    mixedSignalSummary,
    mixedBest: bestMixed,
    mixedAvoid: avoidMixed,
    systemProblems,
    catalogStatusCounts,
    catalogStatusCount,
    catalogStatusRows,
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

function SafetyTag() {
  return (
    <span
      className="badge badge-gray"
      title="Denna frontendvy är read-only och skickar inga order."
      style={{ whiteSpace: 'nowrap' }}
    >
      🔒 Read-only UI
    </span>
  );
}

function SupGroupDivider({ index, title, question }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '36px 0 8px' }}>
      <div
        style={{
          flex: '0 0 auto',
          width: 40,
          height: 40,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 900,
          fontSize: 17,
          background: 'rgba(37,99,235,0.16)',
          color: '#60a5fa',
          border: '1px solid rgba(37,99,235,0.32)',
        }}
      >
        {index}
      </div>
      <div>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 900 }}>{title}</h2>
        {question ? <p style={{ margin: '2px 0 0', opacity: 0.7, fontSize: 13 }}>{question}</p> : null}
      </div>
    </div>
  );
}

const RESULT_TABS = [
  { id: 'overview', label: 'Översikt' },
  { id: 'paper', label: 'Paper Trading' },
  { id: 'allowlist', label: 'Allowlist' },
  { id: 'strategies', label: 'Strategier' },
  { id: 'blocked', label: 'Blockeringar' },
  { id: 'learning', label: 'Learning' },
  { id: 'technical', label: 'Teknisk diagnostik' },
];

function pnlToneClass(value) {
  const n = toNumber(value);
  if (n == null || n === 0) return 'pnl-neutral';
  return n > 0 ? 'pnl-positive' : 'pnl-negative';
}

function winRateToneClass(value) {
  const n = toNumber(value);
  if (n == null) return 'metric-neutral';
  return n >= 50 ? 'metric-good' : 'metric-bad';
}

function PaperTradingResultPanel({ resources, summary }) {
  const perf = unwrap(resources.paperPerformance) || {};
  const status = unwrap(resources.paperStatus) || {};
  const openTrades = normalizeArray(status.openTrades);
  const closedTrades = normalizeArray(status.recentPaperTrades || status.closedPaperTrades || status.closedTrades);
  const openCount = toNumber(summary?.openCount) ?? (Array.isArray(status.openTrades) ? openTrades.length : null);
  const closedCount = toNumber(summary?.closedCount) ?? (Array.isArray(status.recentPaperTrades) || Array.isArray(status.closedPaperTrades) || Array.isArray(status.closedTrades) ? closedTrades.length : null);
  const blockedCount = toNumber(summary?.blockedCount);
  const winRate = perf?.winRate;
  const avgPnl = perf?.avgPnlPct;
  const wins = toNumber(perf?.wins);
  const losses = toNumber(perf?.losses);
  const timeouts = toNumber(perf?.timeouts);
  const hasTrades = [openCount, closedCount, toNumber(perf?.totalTrades)].some((value) => value !== null && value > 0);
  const hasResultCounts = [wins, losses, timeouts].some((value) => value !== null);
  const resultCountSum = (wins ?? 0) + (losses ?? 0) + (timeouts ?? 0);
  const resultTone = wins !== null && losses !== null && wins > losses ? 'metric-good' : wins !== null && losses !== null && losses > wins ? 'metric-bad' : 'metric-neutral';

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Paper Trading-resultat</h2>
          <p>Färgkodad sammanfattning av låtsasaffärer. Grön = vinst eller redo, orange = varning eller blockering, röd = förlust eller fel, blå/grå = neutral och read-only.</p>
        </div>
        <SafetyTag />
      </div>

      <div className="result-metric-grid">
        <article className="result-metric metric-neutral">
          <span className="result-metric-title">Öppna låtsasaffärer</span>
          <strong className="result-metric-value">{formatInt(openCount, 'Ej konfigurerad')}</strong>
          <span className="result-metric-note">Trades som fortfarande är igång.</span>
        </article>
        <article className="result-metric metric-neutral">
          <span className="result-metric-title">Stängda låtsasaffärer</span>
          <strong className="result-metric-value">{formatInt(closedCount, 'Ej konfigurerad')}</strong>
          <span className="result-metric-note">Trades som är avslutade.</span>
        </article>
        <article className={`result-metric ${resultTone}`}>
          <span className="result-metric-title">Vinst / förlust</span>
          <strong className="result-metric-value">{hasResultCounts ? `${formatInt(wins, 'Ej konfigurerad')} vinst · ${formatInt(losses, 'Ej konfigurerad')} förlust` : 'Ingen data'}</strong>
          <span className="result-metric-note">{resultCountSum > 0 && timeouts !== null ? `${formatInt(timeouts, '0')} timeouts` : 'Avslutade trades plus eller minus.'}</span>
        </article>
        <article className={`result-metric ${winRateToneClass(winRate)}`}>
          <span className="result-metric-title">Win rate</span>
          <strong className="result-metric-value">{winRate == null ? 'Ingen data' : formatPct(winRate, 0)}</strong>
          <span className="result-metric-note">Hur många avslutade trades som slutade plus.</span>
        </article>
        <article className={`result-metric ${pnlToneClass(avgPnl)}`}>
          <span className="result-metric-title">Average P/L</span>
          <strong className="result-metric-value">{avgPnl == null ? 'Ingen data' : formatSignedPct(avgPnl, 2)}</strong>
          <span className="result-metric-note">Snittresultat per avslutad trade.</span>
        </article>
        <article className={`result-metric ${blockedCount !== null && blockedCount > 0 ? 'metric-warn' : 'metric-neutral'}`}>
          <span className="result-metric-title">Blockerade paper-events</span>
          <strong className="result-metric-value">{formatInt(blockedCount, 'Ej konfigurerad')}</strong>
          <span className="result-metric-note">Stoppade innan en trade hann skapas.</span>
        </article>
        <article className="result-metric metric-neutral">
          <span className="result-metric-title">Senaste paper-event</span>
          <strong className="result-metric-value">{summary?.latestEventAt ? formatDateTime(summary.latestEventAt) : 'Ingen ännu'}</strong>
          <span className="result-metric-note">{summary?.latestEventAt ? ageText(summary.latestEventAt) : 'Systemet väntar på nya signaler.'}</span>
        </article>
      </div>

      {!hasTrades && (
        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          Inga paper trades har öppnats ännu. Systemet är redo, men saknar godkända kandidater just nu.
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Öppna låtsasaffärer</div>
        {openTrades.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="result-trade-table">
              <thead>
                <tr>{['Tid', 'Symbol', 'Strategi', 'Entry', 'Nuvarande pris', 'Orealiserad P/L', 'P/L %', 'Status', 'Signal/orsak'].map((label) => <th key={label}>{label}</th>)}</tr>
              </thead>
              <tbody>
                {openTrades.map((t, i) => {
                  const plPct = t?.unrealizedPnlPct ?? t?.pnlPct;
                  return (
                    <tr key={t?.id || `${t?.symbol}-${i}`}>
                      <td>{(t?.timestamp || t?.openedAt) ? formatDateTime(t.timestamp || t.openedAt) : '–'}</td>
                      <td>{textValue(t?.symbol, '–')}</td>
                      <td>{strategyLabel(t)}</td>
                      <td>{textValue(t?.entryPrice ?? t?.entry, '–')}</td>
                      <td>{textValue(t?.currentPrice ?? t?.lastPrice, '–')}</td>
                      <td className={pnlToneClass(t?.unrealizedPnl ?? plPct)}>{textValue(t?.unrealizedPnl, '–')}</td>
                      <td className={pnlToneClass(plPct)}>{plPct == null ? '–' : formatSignedPct(plPct, 2)}</td>
                      <td>{textValue(t?.status, 'Öppen')}</td>
                      <td>{textValue(t?.reason || t?.signal || t?.entryReason, '–')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy">Ingen trade-historik tillgänglig ännu.</div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Stängda låtsasaffärer</div>
        {closedTrades.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="result-trade-table">
              <thead>
                <tr>{['Öppnad', 'Stängd', 'Symbol', 'Strategi', 'Entry', 'Exit', 'Realiserad P/L', 'P/L %', 'Resultat', 'Exit reason'].map((label) => <th key={label}>{label}</th>)}</tr>
              </thead>
              <tbody>
                {closedTrades.map((t, i) => {
                  const plPct = t?.pnlPct ?? t?.realizedPnlPct;
                  const plRef = toNumber(plPct) ?? toNumber(t?.pnl);
                  const isWin = plRef !== null && plRef > 0;
                  const isLoss = plRef !== null && plRef < 0;
                  return (
                    <tr key={t?.id || `${t?.symbol}-${i}`}>
                      <td>{(t?.openedAt || t?.entryTime) ? formatDateTime(t.openedAt || t.entryTime) : '–'}</td>
                      <td>{(t?.closedAt || t?.exitTime) ? formatDateTime(t.closedAt || t.exitTime) : '–'}</td>
                      <td>{textValue(t?.symbol, '–')}</td>
                      <td>{strategyLabel(t)}</td>
                      <td>{textValue(t?.entryPrice ?? t?.entry, '–')}</td>
                      <td>{textValue(t?.exitPrice ?? t?.exit, '–')}</td>
                      <td className={pnlToneClass(t?.pnl ?? plPct)}>{textValue(t?.pnl, '–')}</td>
                      <td className={pnlToneClass(plPct)}>{plPct == null ? '–' : formatSignedPct(plPct, 2)}</td>
                      <td className={isWin ? 'pnl-positive' : isLoss ? 'pnl-negative' : 'pnl-neutral'}>{isWin ? 'Vinst' : isLoss ? 'Förlust' : textValue(t?.result || t?.status, '–')}</td>
                      <td>{textValue(t?.exitReason || t?.closeReason, '–')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sup-safety-copy">Ingen trade-historik tillgänglig ännu.</div>
        )}
      </div>
    </section>
  );
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
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [selectedStrategyHistory, setSelectedStrategyHistory] = useState(null);
  const [selectedStrategyPlannerContext, setSelectedStrategyPlannerContext] = useState(null);
  const [strategyHistoryLoading, setStrategyHistoryLoading] = useState(false);
  const [strategyHistoryError, setStrategyHistoryError] = useState('');
  const [selectedTestPlanPreview, setSelectedTestPlanPreview] = useState(null);
  const [testPlanPreviewLoading, setTestPlanPreviewLoading] = useState(false);
  const [testPlanPreviewError, setTestPlanPreviewError] = useState('');
  const [queueMessage, setQueueMessage] = useState('');
  const [queueBusyId, setQueueBusyId] = useState('');
  const [queueView, setQueueView] = useState('pending');
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeResultTab, setActiveResultTab] = useState('overview');

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
    function openHelp() {
      setHelpOpen(true);
    }

    window.addEventListener('trading-os-help:open', openHelp);
    return () => window.removeEventListener('trading-os-help:open', openHelp);
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

  async function loadStrategyHistory(strategyId, plannerContext = null) {
    const id = String(strategyId || '').trim();
    if (!id) return;
    setSelectedStrategyId(id);
    setSelectedStrategyPlannerContext(plannerContext || null);
    setStrategyHistoryLoading(true);
    setStrategyHistoryError('');
    try {
      const data = await fetchJson(`/api/strategies/${encodeURIComponent(id)}/history`);
      setSelectedStrategyHistory(data);
    } catch (err) {
      setSelectedStrategyHistory(null);
      setStrategyHistoryError(err?.message || 'Kunde inte läsa strategi-historik.');
    } finally {
      setStrategyHistoryLoading(false);
    }
  }

  async function loadTestPlanPreview(queueId) {
    const id = String(queueId || '').trim();
    if (!id) return;
    setTestPlanPreviewLoading(true);
    setTestPlanPreviewError('');
    try {
      const data = await fetchJson(`/api/strategies/test-queue/${encodeURIComponent(id)}/preview`);
      if (!data?.ok) {
        throw new Error(data?.error || 'Kunde inte bygga testplan-preview.');
      }
      setSelectedTestPlanPreview(data);
    } catch (err) {
      setSelectedTestPlanPreview(null);
      setTestPlanPreviewError(err?.message || 'Kunde inte bygga testplan-preview.');
    } finally {
      setTestPlanPreviewLoading(false);
    }
  }

  function clearStrategyHistory() {
    setSelectedStrategyId('');
    setSelectedStrategyHistory(null);
    setSelectedStrategyPlannerContext(null);
    setStrategyHistoryError('');
    setStrategyHistoryLoading(false);
  }

  async function addRecommendationToQueue(recommendation) {
    const queueId = String(recommendation?.id || `${recommendation?.strategy_id || ''}:${recommendation?.test_type || ''}`).trim();
    if (!recommendation?.strategy_id || !recommendation?.test_type) {
      setQueueMessage('Kunde inte lägga i testkö: ogiltig rekommendation.');
      return;
    }
    setQueueBusyId(queueId || recommendation.strategy_id);
    setQueueMessage('');
    try {
      const result = await postJson('/api/strategies/test-queue/add', recommendation);
      setQueueMessage(`Lade i testkö: ${result.item?.strategy_id || recommendation.strategy_id} · ${result.item?.test_type || recommendation.test_type}.`);
      await refresh();
    } catch (err) {
      setQueueMessage(err?.message || 'Kunde inte lägga i testkö.');
    } finally {
      setQueueBusyId('');
    }
  }

  async function cancelQueueItem(id) {
    const queueId = String(id || '').trim();
    if (!queueId) return;
    setQueueBusyId(queueId);
    setQueueMessage('');
    try {
      const result = await postJson(`/api/strategies/test-queue/${encodeURIComponent(queueId)}/cancel`, {});
      setQueueMessage(`Avbröt köpost: ${result.item?.strategy_id || queueId}.`);
      await refresh();
    } catch (err) {
      setQueueMessage(err?.message || 'Kunde inte avbryta köposten.');
    } finally {
      setQueueBusyId('');
    }
  }

  const model = useMemo(() => buildDecisionModel(resources), [resources]);
  const endpointRows = useMemo(() => buildEndpointRows(resources), [resources]);
  const technicalCards = useMemo(() => buildTechnicalCards(resources, model), [resources, model]);
  const optimization = unwrap(resources.optimization);
  const testPlannerStatus = model.testPlannerStatus || null;
  const plannerSummary = testPlannerStatus?.summary || {};
  const plannerRecommendations = normalizeArray(testPlannerStatus?.recommendations).slice(0, 5);
  const manualQueueStatus = resources.testQueueStatus || null;
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

  const registryStatus = unwrap(resources.registryStatus) || {};
  const strategyScoreStatus = unwrap(resources.strategyScoreStatus) || {};
  const tradingViewStatus = model.tradingViewStatus || unwrap(resources.tradingviewStatus) || {};
  const daytradingLearning = model.daytradingLearning || unwrap(resources.daytradingLearningSummary)?.data || null;
  const learningSummary = model.learningSummary || daytradingLearning?.summary || null;
  const selectedHistory = selectedStrategyHistory?.ok ? selectedStrategyHistory : null;
  const selectedHistoryScore = selectedHistory?.score || {};
  const selectedHistorySummary = selectedHistory?.history_summary || {};
  const selectedHistoryLearningNotes = normalizeArray(selectedHistory?.learning_notes).slice(0, 5);
  const selectedHistoryNextSteps = normalizeArray(selectedHistory?.recommended_next_steps).slice(0, 5);
  const tradingEventStore = useMemo(() => {
    const eventsRecent = unwrap(resources.eventsRecent) || {};
    const paperEvents = unwrap(resources.paperEvents) || {};
    return createTradingEventStore({
      supervisorSnapshot: unwrap(resources.supervisorOverview) || {},
      liveActivity: eventsRecent,
      aiSources: {
        optimization: unwrap(resources.optimization) || {},
        operationsAdvisor: selectedAdvisor || {},
      },
      analyticsSnapshot: unwrap(resources.daytradingLearningSummary) || {},
      events: [
        ...normalizeArray(eventsRecent.events),
        ...normalizeArray(paperEvents.events),
      ],
    });
  }, [resources, selectedAdvisor]);
  const tradingEventCount = tradingEventStore.getAllEvents().length;
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    supervisorSnapshot: unwrap(resources.supervisorOverview) || {},
    aiSources: {
      optimization: unwrap(resources.optimization) || {},
      operationsAdvisor: selectedAdvisor || {},
    },
    analyticsSnapshot: unwrap(resources.daytradingLearningSummary) || {},
    decisions: [
      ...normalizeArray((unwrap(resources.eventsRecent) || {}).events),
      ...normalizeArray((unwrap(resources.paperEvents) || {}).events),
    ],
  }), [resources, selectedAdvisor, tradingEventStore]);
  const decisionCount = decisionStore.getDecisions().length;

  const topStrategies = normalizeArray(model.scoreSummary?.topDrilldown);
  const weakStrategies = normalizeArray(model.scoreSummary?.weakDrilldown);
  const uncertainStrategies = normalizeArray(model.scoreSummary?.uncertainDrilldown);
  const tradingViewStrategies = normalizeArray(model.scoreSummary?.tradingviewDrilldown);
  const internalStrategies = normalizeArray(model.scoreSummary?.internalDrilldown);
  const learningStrategies = normalizeArray(daytradingLearning?.by_strategy);
  const learningNeedsMoreData = learningStrategies.filter((row) => String(row?.status || '').toLowerCase() === 'needs_more_data').slice(0, 5);

  const tvEnabled = tradingViewStatus?.enabled === true ? true : tradingViewStatus?.enabled === false ? false : null;
  const tvWebhookAuth = tradingViewStatus?.webhook_auth_configured === true ? true : tradingViewStatus?.webhook_auth_configured === false ? false : null;
  const tvMode = textValue(tradingViewStatus?.mode, 'Ingen data ännu');
  const tvAccepted = toNumber(tradingViewStatus?.accepted_signals);
  const tvRejected = toNumber(tradingViewStatus?.rejected_signals);
  const latestTvStrategy = registryStatus?.latest_tradingview_strategy || null;
  const latestBlockedReason = registryStatus?.latest_blocked_reason || null;
  const latestBlockedStrategy = registryStatus?.latest_blocked_strategy || null;
  const totalStrategies = toNumber(registryStatus?.total_strategies);
  const activeStrategies = toNumber(registryStatus?.active_strategies);
  const pausedStrategies = toNumber(registryStatus?.paused_strategies);
  const tradingViewCount = toNumber(registryStatus?.tradingview_strategies) ?? (Array.isArray(model.scoreSummary?.tradingviewDrilldown) ? tradingViewStrategies.length : null);
  const uncertainStrategyCount = toNumber(model.scoreSummary?.uncertain) ?? uncertainStrategies.length;
  const internalStrategyCount = internalStrategies.length;
  const nextPlannerRecommendation = plannerRecommendations[0] || null;
  const nextPlannerAction = nextPlannerRecommendation
    ? `${nextPlannerRecommendation.strategy_id} · ${nextPlannerRecommendation.test_type}`
    : model.recommendationLabel;
  const nextPlannerReason = nextPlannerRecommendation?.reason || model.bestCardSummary;
  const keyRisk = model.systemProblems[0] || model.riskSafetyPoints[0] || 'Ingen tydlig risk just nu.';
  const beginnerCards = [
    {
      icon: '📈',
      title: 'Vad Resultat visar',
      description: 'Här ser du daytrading, Paper Trading och varför trades öppnas eller stoppas.',
      tone: 'info',
    },
    {
      icon: '🧪',
      title: 'Vad som händer just nu',
      description: 'Paper runtime, blocked candidates och allowlist sammanfattas utan att något körs härifrån.',
      tone: 'good',
    },
    {
      icon: '🔎',
      title: 'Vad du ska titta på',
      description: 'Börja med varför inga trades skapas, läs allowlist-status och öppna full Paper Trading-vy vid behov.',
      tone: 'warning',
    },
  ];
  const resultSummary = useMemo(() => buildPaperTradeDiagnostics(resources, model), [resources, model]);

  const systemStatusCards = [
    {
      icon: '🟢',
      title: 'Systemstatus',
      value: model.systemStatus,
      summary: bestText(model.systemConclusion, 'Systemet är igång.'),
      detail: 'En enkel läsning av helhetsläget.',
      tone: summaryTone === 'good' ? 'good' : 'warning',
      progress: null,
    },
    {
      icon: '🔒',
      title: 'Säkerhetsläge',
      value: tradingMode,
      summary: safety ? 'Backend safety-status mottagen.' : 'Ingen safety-status mottagen från backend.',
      detail: `actions_allowed=${onOffLabel(safetyActionsAllowed)} · live_trading_enabled=${onOffLabel(safetyLiveTradingEnabled)}`,
      tone: safetyLiveTradingEnabled === false && safetyActionsAllowed === false ? 'good' : safety ? 'warning' : 'muted',
      progress: null,
    },
    {
      icon: '📡',
      title: 'TradingView',
      value: activeLabel(tvEnabled),
      summary: tvEnabled === true ? 'Signalflödet finns på plats.' : tvEnabled === false ? 'TradingView är avstängt just nu.' : 'TradingView-status saknas i backendsvaret.',
      detail: `Mode ${tvMode} · auth ${onOffLabel(tvWebhookAuth)}`,
      tone: tvEnabled === true ? 'good' : tvEnabled === false ? 'muted' : 'warning',
      progress: null,
    },
    {
      icon: '🧩',
      title: 'Strategier',
      value: formatInt(activeStrategies, 'Ingen data ännu'),
      summary: `${formatInt(totalStrategies, 'Ingen data ännu')} totalt · ${formatInt(pausedStrategies, 'Ingen data ännu')} pausade`,
      detail: 'Hur många arbetssätt som just nu följs.',
      tone: 'info',
      progress: null,
    },
    {
      icon: '📝',
      title: 'Nästa test',
      value: nextPlannerAction,
      summary: bestText(nextPlannerReason, 'Ingen rekommendation ännu.'),
      detail: 'Det här är bara ett förslag, inte en körning.',
      tone: 'info',
      progress: null,
    },
    {
      icon: '⚠️',
      title: 'Risk',
      value: keyRisk,
      summary: 'Sidan är läsbar och avsedd för test.',
      detail: 'Ingen livehandel härifrån.',
      tone: model.systemProblems.length > 0 ? 'warning' : 'good',
      progress: null,
    },
  ];

  if (loading && !resources.status) {
    return (
      <div className="sup-page sup-v2-page" data-trading-event-count={tradingEventCount} data-decision-count={decisionCount}>
        <div className="sup-hero sup-v2-hero">
          <div className="sup-hero-copy">
            <div className="sup-kicker">Trading OS</div>
            <h1>Trading OS</h1>
            <p>En enkel vy för strategier, TradingView-signaler, AI-lärdomar och nästa test.</p>
          </div>
        </div>
        <div className="sup-loading">Laddar Trading OS...</div>
      </div>
    );
  }

  return (
    <div className="sup-page sup-v2-page" data-trading-event-count={tradingEventCount} data-decision-count={decisionCount}>
      <div className="sup-hero sup-v2-hero">
        <div className="sup-hero-copy">
          <div className="sup-kicker">Trading OS</div>
          <h1>Resultat</h1>
          <p>Daytrading, Paper Trading och diagnos för varför trades skapas eller stoppas.</p>
          <div className="sup-safety-copy">Systemet är i testläge. Inga riktiga köp eller sälj görs.</div>
        </div>
        <div className="sup-hero-actions">
          <button type="button" className="btn sup-refresh" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Uppdaterar...' : 'Uppdatera'}
          </button>
          <div className="sup-last-updated">Senast uppdaterad: {formatDateTime(lastUpdated)}</div>
        </div>
      </div>

      <nav className="result-tabs" role="tablist" aria-label="Resultatflikar">
        {RESULT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeResultTab === tab.id}
            className={`result-tab${activeResultTab === tab.id ? ' result-tab-active' : ''}`}
            onClick={() => setActiveResultTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeResultTab === 'overview' && (
        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Översikt</h2>
              <p>Det viktigaste först. Allt är read-only och i testläge.</p>
            </div>
            <SafetyTag />
          </div>
          <div className="sup-pill-grid sup-v2-pill-grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div className="sup-pill sup-pill-neutral"><span>Säkerhetsläge</span><strong>{tradingMode}</strong></div>
            <div className="sup-pill sup-pill-neutral"><span>Alla strategier</span><strong>{formatInt(resultSummary.totalCount, 'Ingen data ännu')}</strong></div>
            <div className="sup-pill sup-pill-good"><span>Aktiva</span><strong>{formatInt(resultSummary.activeCount, 'Ingen data ännu')}</strong></div>
            <div className="sup-pill sup-pill-neutral"><span>Tekniskt paper-kopplade</span><strong>{formatInt(resultSummary.technicalPaperCount, 'Ingen data ännu')}</strong></div>
            <div className="sup-pill sup-pill-warning"><span>Godkända i allowlist</span><strong>{formatInt(resultSummary.allowlistApprovedCount, 'Ingen data ännu')}</strong></div>
            <div className="sup-pill sup-pill-neutral"><span>Kandidater nu</span><strong>{formatInt(resultSummary.candidatesCount, 'Ingen data ännu')}</strong></div>
            <div className={`sup-pill ${resultSummary.blockedCount !== null && resultSummary.blockedCount > 0 ? 'sup-pill-warning' : 'sup-pill-neutral'}`}><span>Blockerade</span><strong>{formatInt(resultSummary.blockedCount, 'Ingen data ännu')}</strong></div>
          </div>
          <div className="sup-safety-copy" style={{ marginTop: 12 }}>
            <strong>Varför inga paper trades just nu?</strong> {resultSummary.explanation?.[0] || 'Systemet är redo och väntar på godkända kandidater.'}
          </div>
          <div className="sup-safety-copy" style={{ marginTop: 8 }}>
            Inga riktiga köp eller sälj görs. actions_allowed=false · can_place_orders=false · live_trading_enabled=false.
          </div>
        </section>
      )}

      {activeResultTab === 'paper' && (
      <>
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Paper Trading</h2>
            <p>Det här är huvudvyn för resultat, paper runtime och diagnos. Full loggbok finns kvar via direktlänken.</p>
          </div>
          <SafetyTag />
        </div>

        <div className="sup-grid sup-grid-2" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <article className={`sup-block ${resultSummary.paperEnabled === true ? 'sup-block-ok' : resultSummary.paperEnabled === false ? 'sup-block-warning' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">Paper Trading</span>
            <strong className="sup-block-value">{resultSummary.paperEnabled === true ? 'Synligt i Resultat' : resultSummary.paperEnabled === false ? 'Avvaktar' : 'Ingen data ännu'}</strong>
            <span className="sup-block-note">Öppna {formatInt(resultSummary.openCount, 'Ingen data ännu')} · stängda {formatInt(resultSummary.closedCount, 'Ingen data ännu')} · blockerade {formatInt(resultSummary.blockedCount, 'Ingen data ännu')}</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Direktvy</span>
            <strong className="sup-block-value">/paper-trading</strong>
            <span className="sup-block-note">Separat full runtime-vy finns kvar för djupare loggbok.</span>
          </article>
        </div>

        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          Paper Trading är read-only här. Inga start, stop eller approve-actions finns på denna sida.
        </div>
        <div className="sup-v2-report-lead" style={{ marginTop: 12, marginBottom: 0 }}>
          <Link to="/paper-trading">Öppna full Paper Trading-vy</Link>
        </div>
      </section>

      <PaperTradingResultPanel resources={resources} summary={resultSummary} />
      </>
      )}

      {activeResultTab === 'blocked' && <ResultWhyNoTradesPanel resources={resources} model={model} />}
      {activeResultTab === 'allowlist' && <PaperAllowlistPanel resources={resources} model={model} />}

      {activeResultTab === 'technical' && (
      <section className="sup-section sup-intro-section">
        <div className="sup-section-head">
          <div>
            <h2>Hur du läser Resultat</h2>
            <p>En enkel introduktion till daytrading, Paper Trading och de vanligaste blockerarna.</p>
          </div>
        </div>
        <div className="sup-intro-grid">
          {beginnerCards.map((card) => (
            <BeginnerInfoCard key={card.title} {...card} />
          ))}
        </div>
        <div className="sup-glossary-row" aria-label="Snabb förklaring av viktiga ord">
          <GlossaryTooltip term="Signal" help="Ett tecken på att systemet hittat något intressant." />
          <GlossaryTooltip term="Strategi" help="Ett sätt som systemet testar för att se om något fungerar bättre." />
          <GlossaryTooltip term="Replay" help="Ett test på gammal data för att se hur något hade fungerat tidigare." />
          <GlossaryTooltip term="Batch" help="Många tester i grupp." />
          <GlossaryTooltip term="Score" help="En enkel bedömning av hur lovande något verkar just nu." />
          <GlossaryTooltip term="Paper only" help="Bara testläge, inga riktiga köp eller sälj görs." />
          <GlossaryTooltip term="Testkö" help="En lista med tester som kan granskas manuellt." />
        </div>
      </section>
      )}

      {activeResultTab === 'overview' && (<>
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Läget just nu</h2>
            <p>Här ser du det viktigaste först: läget, säkerheten och nästa steg.</p>
          </div>
          <SafetyTag />
        </div>

        <div className="sup-status-grid">
          {systemStatusCards.map((card) => (
            <SimpleStatusCard key={card.title} {...card} />
          ))}
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Vad ska jag göra nu?</h2>
            <p>Tre enkla förslag. Inget körs automatiskt.</p>
          </div>
        </div>
        <div className="sup-focus-box">
          <div className="sup-focus-title">Nästa steg</div>
          {[
            {
              title: 'Granska testkön',
              text: 'Se vilka tester som väntar, är avbrutna eller behöver en manuell plan.',
            },
            {
              title: 'Läs varför signaler stoppas',
              text: 'Se den vanligaste orsaken när systemet säger nej.',
            },
            {
              title: 'Öppna historik',
              text: 'Jämför vad systemet har lärt sig om en vald strategi.',
            },
          ].map((item, index) => (
            <div className="sup-focus-item" key={item.title}>
              <strong>{index + 1}. {item.title}</strong>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </section>
      </>)}

      {activeResultTab === 'strategies' && (<>
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Strategier</h2>
            <p>Här ser du vilka arbetssätt systemet följer just nu.</p>
          </div>
        </div>

        <div
          className="sup-pill-grid sup-v2-pill-grid"
          style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
        >
          <div className="sup-pill sup-pill-good">
            <span>Alla strategier</span>
            <strong>{formatInt(totalStrategies, 'Ingen data ännu')}</strong>
          </div>
          <div className="sup-pill sup-pill-good">
            <span>Aktiva</span>
            <strong>{formatInt(activeStrategies, 'Ingen data ännu')}</strong>
          </div>
          <div className="sup-pill sup-pill-missing">
            <span>Pausade</span>
            <strong>{formatInt(pausedStrategies, 'Ingen data ännu')}</strong>
          </div>
          <div className="sup-pill sup-pill-warning">
            <span>Osäkra</span>
            <strong>{formatInt(uncertainStrategyCount, 'Ingen data ännu')}</strong>
          </div>
          <div className="sup-pill sup-pill-good">
            <span>TradingView</span>
            <strong>{formatInt(tradingViewCount, 'Ingen data ännu')}</strong>
          </div>
          <div className="sup-pill sup-pill-neutral">
            <span>Interna</span>
            <strong>{formatInt(internalStrategyCount, 'Ingen data ännu')}</strong>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <StrategyDrilldownCard
            title="Starkast just nu"
            kicker="Bedömning"
            badge="Starkast"
            badgeTone="green"
            summary="De strategier som ser mest lovande ut just nu."
            items={topStrategies}
            emptyText="Inga tydligt starka strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Behöver mer data"
            kicker="Bedömning"
            badge="Svagast"
            badgeTone="red"
            summary="Strategier som ännu inte ser tillräckligt starka ut."
            items={weakStrategies}
            emptyText="Inga tydligt svaga strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Behöver mer data"
            kicker="Datatrygghet"
            badge="Osäkra"
            badgeTone="yellow"
            summary="Strategier som behöver mer underlag innan de går att bedöma tydligt."
            items={uncertainStrategies}
            emptyText="Inga osäkra strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Från TradingView"
            kicker="Källa"
            badge={tradingViewStrategies.length ? `${tradingViewStrategies.length} TV` : '0 TV'}
            badgeTone="yellow"
            summary={tradingViewStrategies.length > 0
              ? `${tradingViewStrategies.length} signaler eller strategier kommer från TradingView. ${latestBlockedReason ? `Senaste blockering: ${latestBlockedReason}.` : 'Ingen senaste blockering.'}`
              : 'Inga TradingView-strategier ännu.'}
            items={tradingViewStrategies}
            emptyText="Inga TradingView-strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Strategier från TradingView</h2>
            <p>TradingView används bara för signaler och strategi-test, inte live orders.</p>
          </div>
          <SafetyTag />
        </div>

        <div
          className="sup-grid sup-grid-2"
          style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
        >
          <article className={`sup-block ${tvEnabled === true ? 'sup-block-ok' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">TradingView</span>
            <strong className="sup-block-value">{activeLabel(tvEnabled)}</strong>
            <span className="sup-block-note">Extern källa för signaler och tester.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Webhook auth</span>
            <strong className="sup-block-value">{onOffLabel(tvWebhookAuth)}</strong>
            <span className="sup-block-note">Avgör om signaler får komma in.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Mode</span>
            <strong className="sup-block-value">{tvMode}</strong>
            <span className="sup-block-note">Allt hålls i testläge.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Antal TV-strategier</span>
            <strong className="sup-block-value">{formatInt(tradingViewCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Senaste strategi: {latestTvStrategy ? strategyDescriptor(latestTvStrategy) : 'ingen ännu'}</span>
          </article>
          <article className={`sup-block ${latestBlockedReason ? 'sup-block-warning' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">Senaste blockeringsorsak</span>
            <strong className="sup-block-value">{latestBlockedReason || 'Ingen blockering sparad'}</strong>
            <span className="sup-block-note">{latestBlockedStrategy ? `Gällde ${strategyDescriptor(latestBlockedStrategy)}.` : 'Ingen senaste blockerade strategi sparad.'}</span>
          </article>
        </div>

        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          TradingView används bara för signaler och strategi-test, inte live orders.
        </div>
      </section>
      </>)}

      {activeResultTab === 'learning' && (<>
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Vad AI har lärt sig</h2>
            <p>En enkel sammanfattning av vad systemet verkar lära sig just nu.</p>
          </div>
        </div>

        {learningSummary ? (
          <div className="sup-grid sup-grid-2" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <article className="sup-block sup-block-ok">
              <span className="sup-block-title">Bästa mönster just nu</span>
              <strong className="sup-block-value">
                {learningSummary?.best_strategy?.label || learningSummary?.best_strategy?.key || 'Samlar lärdomar'}
              </strong>
              <span className="sup-block-note">
                {learningSummary?.win_rate != null
                  ? `Win rate ${formatPct(learningSummary.win_rate, 0)} · Snitt P/L ${formatSignedPct(learningSummary.avg_pl, 2)}`
                  : 'Ingen learning-summary ännu.'}
              </span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Behöver mer data</span>
              <strong className="sup-block-value">{formatInt(learningSummary?.needs_more_data_count, 'Ingen data ännu')}</strong>
              <span className="sup-block-note">
                {learningSummary?.worst_strategy?.label || learningSummary?.worst_strategy?.key || 'Ingen tydlig svag strategi ännu.'}
              </span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Viktig lärdom</span>
              <strong className="sup-block-value">
                {learningSummary?.best_market_group?.label || learningSummary?.best_risk_class?.label || 'Ingen tydlig lärdom ännu'}
              </strong>
              <span className="sup-block-note">
                {learningSummary?.best_market_group?.key
                  ? `Bäst marknadsgrupp: ${learningSummary.best_market_group.key}`
                  : 'Learning sammanfattar fortfarande för få trades.'}
              </span>
            </article>
            <article className="sup-block sup-block-warning">
              <span className="sup-block-title">Viktig varning</span>
              <strong className="sup-block-value">
                {learningSummary?.warning || 'Systemet behöver fortfarande mer underlag.'}
              </strong>
              <span className="sup-block-note">
                {learningSummary?.warning_detail || 'Ingen tydlig varning ännu.'}
              </span>
            </article>
          </div>
        ) : (
          <EmptyLearningState />
        )}

        {learningNeedsMoreData.length > 0 && (
          <div className="sup-safety-copy" style={{ marginTop: 12 }}>
            Behöver mer data: {learningNeedsMoreData.slice(0, 3).map((row) => strategyDescriptor(row)).join(' · ')}
          </div>
        )}
      </section>

      <StrategyPlannerPanel
        planner={testPlannerStatus}
        onSelectRecommendation={(item) => loadStrategyHistory(item?.strategy_id, item)}
      />

      <ManualTestQueuePanel
        queue={manualQueueStatus}
        queueMessage={queueMessage}
        queueBusyId={queueBusyId}
        onCancelQueueItem={cancelQueueItem}
        onViewHistory={loadStrategyHistory}
        onViewPlan={loadTestPlanPreview}
        queueView={queueView}
        onChangeQueueView={setQueueView}
      />

      <SignalStopSummary resource={resources.eventsRecent} />

      {(selectedStrategyId || selectedHistory || strategyHistoryLoading || strategyHistoryError) && (
        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Historik för vald strategi</h2>
              <p>Klicka på en strategi eller rekommendation för att öppna historik och lärdomar.</p>
            </div>
          </div>
          <StrategyHistoryDetail
            history={selectedHistory}
            loading={strategyHistoryLoading}
            error={strategyHistoryError}
            onClear={clearStrategyHistory}
            plannerContext={selectedStrategyPlannerContext}
          />
          {selectedHistory ? (
            <div className="sup-safety-copy" style={{ marginTop: 12 }}>
              <strong>History details:</strong> Score {textValue(selectedHistoryScore.score, '–')} · Confidence {textValue(selectedHistoryScore.confidence, '–')}% · Sample {textValue(selectedHistoryScore.sample_size, '–')}
              <br />
              <strong>Summary:</strong> Paper {textValue(selectedHistorySummary.paper_trades_count, 'Ej konfigurerad')} · Replay {textValue(selectedHistorySummary.replay_tests_count, 'Ej konfigurerad')} · Batch {textValue(selectedHistorySummary.batch_tests_count, 'Ej konfigurerad')} · Learning {textValue(selectedHistorySummary.learning_events_count, 'Ej konfigurerad')}
              {selectedHistoryLearningNotes.length > 0 ? (
                <>
                  <br />
                  <strong>Learning notes:</strong> {selectedHistoryLearningNotes.join(' · ')}
                </>
              ) : null}
              {selectedHistoryNextSteps.length > 0 ? (
                <>
                  <br />
                  <strong>Next steps:</strong> {selectedHistoryNextSteps.join(' · ')}
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      )}
      </>)}

      {activeResultTab === 'technical' && (
      <details className="sup-advanced" style={{ marginTop: 16 }}>
        <summary>Visa teknisk diagnostik</summary>
        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          Rådata, endpoints och debugpaneler. Dold i normalvy för att hålla sidan enkel.
        </div>

        <div style={{ display: 'grid', gap: 12, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          {technicalCards.map((card) => (
            <ModuleCard key={card.key} card={card} />
          ))}
        </div>

        <div className="sup-grid sup-grid-2" style={{ display: 'grid', gap: 12, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">API-endpoints</span>
            <strong className="sup-block-value">{endpointRows.filter((row) => row.ok).length}/{endpointRows.length}</strong>
            <span className="sup-block-note">Status för alla lästa endpoints.</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Debug JSON</span>
            <strong className="sup-block-value">Sammanfattning</strong>
            <span className="sup-block-note">Endast för teknisk felsökning.</span>
          </article>
        </div>

        <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {endpointRows.slice(0, 12).map((row) => (
            <span key={row.key} className={`sup-v2-chip`} title={row.url}>
              {row.label} · {row.state.label}
            </span>
          ))}
        </div>

        <RecentTradingEvents resource={resources.eventsRecent} />
        <EventSystemStatus resource={resources.eventsStatus} />
        <OptimizationCenter optimization={optimization} />

        <pre className="sup-safety-copy" style={{ marginTop: 12, whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>
          {JSON.stringify({
            system: {
              status: model.systemStatus,
              summary: model.systemSummary,
              conclusion: model.systemConclusion,
            },
            safety: safety || null,
            registry: model.registrySummary,
            score: model.scoreSummary,
            planner: plannerSummary,
            tradingview: {
              enabled: tvEnabled,
              webhook_auth_configured: tvWebhookAuth,
              mode: tvMode,
              accepted_signals: tvAccepted,
              rejected_signals: tvRejected,
            },
          }, null, 2)}
        </pre>
      </details>
      )}
      <QuickHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );

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

      <SupGroupDivider index="1" title="Beslutsläge" question="Vad händer just nu — och vad ska jag göra?" />
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
            <span className="sup-block-title">Tekniskt paper-kopplade</span>
            <strong className="sup-block-value">{formatInt(model.paperTradeCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Kan skapa paper trades tekniskt, men får ändå stoppas av allowlist eller andra regler.</span>
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
            <strong className="sup-block-value">{safety ? 'Backend safety' : 'Ingen data ännu'}</strong>
            <span className="sup-block-note">actions_allowed={onOffLabel(safetyActionsAllowed)}, can_place_orders={onOffLabel(safetyCanPlaceOrders)}, live_trading_enabled={onOffLabel(safetyLiveTradingEnabled)}.</span>
          </article>
        </div>
        <details className="sup-advanced" style={{ marginTop: 12 }}>
          <summary>Visa katalogstatus</summary>
          <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <span className="sup-v2-chip">ACTIVE {formatInt(model.catalogStatusCount?.('active'), 'Ingen data ännu')}</span>
            <span className="sup-v2-chip">TESTING {formatInt(model.catalogStatusCount?.('testing'), 'Ingen data ännu')}</span>
            <span className="sup-v2-chip">PAUSED {formatInt(model.catalogStatusCount?.('paused'), 'Ingen data ännu')}</span>
            <span className="sup-v2-chip">ROADMAP {formatInt(model.catalogStatusCount?.('roadmap'), 'Ingen data ännu')}</span>
            <span className="sup-v2-chip">LEGACY {formatInt(model.catalogStatusCount?.('legacy'), 'Ingen data ännu')}</span>
          </div>
          <div className="sup-v2-card-source" style={{ marginTop: 8 }}>
            Katalogstatus kommer från Strategy Catalog. Runtime-koppling, paper-körbarhet och learning-stöd visas separat i Lab och Teknik.
          </div>
          {model.catalogStatusRows?.length > 0 && (
            <div className="sup-v2-card-source" style={{ marginTop: 8 }}>
              Exempel: {model.catalogStatusRows.slice(0, 5).map((row) => `${row.name} · ${row.statusLabel} · Scanner:${row.supportsScanner ? 'Ja' : 'Nej'} Replay:${row.supportsReplay ? 'Ja' : 'Nej'}`).join(' | ')}
            </div>
          )}
        </details>
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
                `Tekniskt paper-kopplade: ${formatInt(model.paperTradeCount, 'Ingen data ännu')}`,
                `Godkända i allowlist: ${formatInt(model.allowlistApprovedCount, 'Ingen data ännu')}`,
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

      <section className="sup-section sup-advisor-section">
        <div className="sup-section-head">
          <div>
            <h2>🧠 AI Operations Advisor</h2>
            <p>Read-only läsning av senaste timmen, idag, 7 dagar eller 30 dagar. Ingen trading, inga ordrar.</p>
          </div>
          <SafetyTag />
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
                <span>Signaler: {formatInt(selectedAdvisor.window_metrics?.signals_seen, 'Ingen data ännu')}</span>
                <span>Paper trades: {formatInt(selectedAdvisor.window_metrics?.paper_trades_created, 'Ingen data ännu')}</span>
                <span>VWAP: {textValue(selectedAdvisor.crypto_status?.vwap_routing_status, 'Ingen data ännu')}</span>
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
                  badge: `${formatInt(selectedAdvisor.window_metrics?.signals_seen, 'Ingen data ännu')} signaler`,
                  summary: selectedAdvisor.summary.short_sv,
                  points: uniqueText([
                    `Paper trades: ${formatInt(selectedAdvisor.window_metrics?.paper_trades_created, 'Ingen data ännu')}`,
                    `Skippade signaler: ${formatInt(selectedAdvisor.window_metrics?.learning_skipped, 'Ingen data ännu')}`,
                    `Öppna trades: ${formatInt(selectedAdvisor.window_metrics?.open_trades, 'Ingen data ännu')}`,
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
                  badgeTone: (Array.isArray(selectedAdvisor.strategy_highlights?.blocked) && selectedAdvisor.strategy_highlights.blocked.length > 0) || (Array.isArray(selectedAdvisor.strategy_highlights?.partial) && selectedAdvisor.strategy_highlights.partial.length > 0) ? 'yellow' : 'gray',
                  badge: `${formatInt(Array.isArray(selectedAdvisor.strategy_highlights?.blocked) || Array.isArray(selectedAdvisor.strategy_highlights?.partial) ? (Array.isArray(selectedAdvisor.strategy_highlights?.blocked) ? selectedAdvisor.strategy_highlights.blocked.length : 0) + (Array.isArray(selectedAdvisor.strategy_highlights?.partial) ? selectedAdvisor.strategy_highlights.partial.length : 0) : null, 'Ingen data ännu')} strategier`,
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
                  tone: selectedAdvisor.crypto_status?.vwap_routing_fungerar === true ? 'ok' : selectedAdvisor.crypto_status?.vwap_routing_fungerar === false ? 'warn' : 'neutral',
                  badgeTone: selectedAdvisor.crypto_status?.vwap_routing_fungerar === true ? 'green' : selectedAdvisor.crypto_status?.vwap_routing_status === 'observe-only' ? 'yellow' : 'blue',
                  badge: `VWAP ${textValue(selectedAdvisor.crypto_status?.vwap_routing_status, 'Ingen data ännu')}`,
                  summary: selectedAdvisor.summary.next_action_sv,
                  points: uniqueText([
                    `Crypto-signaler ${formatInt(selectedAdvisor.crypto_status?.crypto_signals, 'Ingen data ännu')}`,
                    `Runtime-active ${formatInt(selectedAdvisor.crypto_status?.runtime_active, 'Ingen data ännu')}`,
                    `Gate-blockade ${formatInt(selectedAdvisor.crypto_status?.gate_blocked, 'Ingen data ännu')}`,
                    `VWAP-papper ${formatInt(selectedAdvisor.crypto_status?.vwap_paper_trades, 'Ingen data ännu')}`,
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

      <SupGroupDivider index="2" title="Strategiöversikt" question="Vilka strategier finns och hur presterar de?" />
      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Strategy Registry och Score</h2>
            <p>Read-only översikt av interna och TradingView-strategier samt första versionen av Strategy Score.</p>
          </div>
          <SafetyTag />
        </div>

        <div className="sup-v2-answer-grid">
          <DecisionCard
            item={{
              index: 'R1',
              title: 'Registry översikt',
              tone: 'neutral',
              badgeTone: 'blue',
              badge: `${formatInt(model.registrySummary.total, 'Ingen data ännu')} strategier`,
              summary: `Aktiva ${formatInt(model.registrySummary.active, 'Ingen data ännu')} · TradingView ${formatInt(model.registrySummary.tradingview, 'Ingen data ännu')} · Paused ${formatInt(model.registrySummary.paused, 'Ingen data ännu')} · Deprecated ${formatInt(model.registrySummary.deprecated, 'Ingen data ännu')}.`,
              points: uniqueText([
                `Senaste TradingView: ${strategyDescriptor(model.registrySummary.latestTradingView)}`,
                model.registrySummary.latestBlockedReason ? `Senaste blockering: ${model.registrySummary.latestBlockedReason}` : 'Ingen blockering sparad ännu.',
                `Safety: actions_allowed=${onOffLabel(safetyActionsAllowed)} · can_place_orders=${onOffLabel(safetyCanPlaceOrders)} · live_trading_enabled=${onOffLabel(safetyLiveTradingEnabled)} · mode=${tradingMode}`,
              ]),
            }}
          />
          <DecisionCard
            item={{
              index: 'R2',
              title: 'Strategy Score v1',
              tone: 'ok',
              badgeTone: model.scoreSummary.uncertain > 0 ? 'yellow' : 'green',
              badge: `${model.scoreSummary.total} scores`,
              summary: model.scoreSummary.top
                ? `${model.scoreSummary.top.strategy_id} · score ${model.scoreSummary.top.score} · confidence ${model.scoreSummary.top.confidence}%`
                : 'Ingen score-data ännu.',
              points: uniqueText([
                `Osäkra scores: ${model.scoreSummary.uncertain}`,
                model.scoreSummary.top ? `Bäst: ${model.scoreSummary.top.strategy_id} (${model.scoreSummary.top.score})` : 'Ingen toppstrategi ännu.',
                model.scoreSummary.weak ? `Svagast: ${model.scoreSummary.weak.strategy_id} (${model.scoreSummary.weak.score})` : 'Ingen svagaste strategi ännu.',
              ]),
            }}
          />
          <DecisionCard
            item={{
              index: 'R3',
              title: 'Tolkning',
              tone: model.scoreSummary.top && model.scoreSummary.top.confidence < 50 ? 'warn' : 'ok',
              badgeTone: model.scoreSummary.top && model.scoreSummary.top.confidence < 50 ? 'yellow' : 'green',
              badge: model.scoreSummary.top?.recommended_action || 'Bevaka',
              summary: model.scoreSummary.top
                ? model.scoreSummary.top.recommended_action
                : 'Kör replay och batch-test för att få första score-underlaget.',
              points: uniqueText([
                model.scoreSummary.top?.strengths?.[0] || 'Inga tydliga styrkor ännu.',
                model.scoreSummary.top?.weaknesses?.[0] || 'Inga tydliga svagheter ännu.',
                model.scoreSummary.top?.sample_size != null ? `Sample size ${model.scoreSummary.top.sample_size}` : '',
              ]),
            }}
          />
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Strategy Drilldown</h2>
            <p>Read-only listor över de starkaste, svagaste och mest osäkra strategierna samt vilka tester som bör köras härnäst.</p>
          </div>
          <SafetyTag />
        </div>

        <div className="sup-v2-answer-grid">
          <StrategyDrilldownCard
            title="Top 5 starkaste"
            kicker="Styrka"
            badge={`${model.scoreSummary.topDrilldown.length} strategier`}
            badgeTone="green"
            summary="Högst score bland aktiva och körbara strategier."
            items={model.scoreSummary.topDrilldown}
            emptyText="Inga starka strategier att visa ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Top 5 svagaste"
            kicker="Svaghet"
            badge={`${model.scoreSummary.weakDrilldown.length} strategier`}
            badgeTone="red"
            summary="Strategier med lägst score eller tydlig svag historik."
            items={model.scoreSummary.weakDrilldown}
            emptyText="Inga svaga strategier att visa ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Top 5 mest osäkra"
            kicker="Osäkerhet"
            badge={`${model.scoreSummary.uncertainDrilldown.length} strategier`}
            badgeTone="yellow"
            summary="Strategier med låg confidence eller litet sample size."
            items={model.scoreSummary.uncertainDrilldown}
            emptyText="Inga osäkra strategier att visa ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="TradingView-strategier"
            kicker="Extern källa"
            badge={`${model.scoreSummary.tradingviewDrilldown.length} strategier`}
            badgeTone="yellow"
            summary="TradingView-strategier som registrerats i registry."
            items={model.scoreSummary.tradingviewDrilldown}
            emptyText="Inga TradingView-strategier registrerade ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Interna strategier"
            kicker="Intern källa"
            badge={`${model.scoreSummary.internalDrilldown.length} strategier`}
            badgeTone="blue"
            summary="Interna katalogstrategier från Trading OS."
            items={model.scoreSummary.internalDrilldown}
            emptyText="Inga interna strategier att visa ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Rekommenderade nästa tester"
            kicker="Nästa steg"
            badge={`${model.scoreSummary.nextTestsDrilldown.length} strategier`}
            badgeTone="green"
            summary="Strategier som score v1 pekar ut för replay eller batch-test."
            items={model.scoreSummary.nextTestsDrilldown}
            emptyText="Inga nästa tester föreslagna ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
        </div>
      </section>

      <SupGroupDivider index="3" title="Testrekommendationer" question="Vad bör testas härnäst?" />
      <StrategyPlannerPanel
        planner={{
          ok: testPlannerStatus?.ok !== false,
          recommendations: plannerRecommendations,
          summary: plannerSummary,
          safety: testPlannerStatus?.safety || null,
        }}
        onSelectRecommendation={loadStrategyHistory}
        onQueueRecommendation={addRecommendationToQueue}
        queueBusyId={queueBusyId}
      />

      <TestPlanPreviewCard
        preview={selectedTestPlanPreview}
        loading={testPlanPreviewLoading}
        error={testPlanPreviewError}
        onClear={() => {
          setSelectedTestPlanPreview(null);
          setTestPlanPreviewError('');
        }}
      />

      {(selectedStrategyId || selectedHistory || strategyHistoryLoading || strategyHistoryError) && (
        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Historik för vald strategi</h2>
              <p>Klicka på en strategi eller rekommendation för att öppna historik och lärdomar.</p>
            </div>
          </div>
          <StrategyHistoryDetail
            history={selectedHistory}
            loading={strategyHistoryLoading}
            error={strategyHistoryError}
            onClear={clearStrategyHistory}
            plannerContext={selectedStrategyPlannerContext}
          />
          {selectedHistory ? (
            <div className="sup-safety-copy" style={{ marginTop: 12 }}>
              <strong>History details:</strong> Score {textValue(selectedHistoryScore.score, '–')} · Confidence {textValue(selectedHistoryScore.confidence, '–')}% · Sample {textValue(selectedHistoryScore.sample_size, '–')}
              <br />
              <strong>Summary:</strong> Paper {textValue(selectedHistorySummary.paper_trades_count, '–')} · Replay {textValue(selectedHistorySummary.replay_tests_count, '–')} · Batch {textValue(selectedHistorySummary.batch_tests_count, '–')} · Learning {textValue(selectedHistorySummary.learning_events_count, '–')}
              {selectedHistoryLearningNotes.length > 0 ? (
                <>
                  <br />
                  <strong>Learning notes:</strong> {selectedHistoryLearningNotes.join(' · ')}
                </>
              ) : null}
              {selectedHistoryNextSteps.length > 0 ? (
                <>
                  <br />
                  <strong>Next steps:</strong> {selectedHistoryNextSteps.join(' · ')}
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      <SupGroupDivider index="4" title="Signaldiagnostik" question="Var stoppades signalerna och varför?" />
      <SignalStopSummary resource={resources.eventsRecent} />

      <EventAiConclusion resource={resources.eventsRecent} />

      <EventsByMarket resource={resources.eventsRecent} />

      <SupGroupDivider index="5" title="Teknisk diagnostik" question="Loggar, event-system och optimering. Öppnas vid behov." />
      <details className="sup-advanced">
        <summary>Visa teknisk diagnostik</summary>
        <p className="sup-muted" style={{ marginTop: 10 }}>
          Tekniska detaljer och rådata. Behövs inte för det dagliga beslutet.
        </p>
      <RecentTradingEvents resource={resources.eventsRecent} />
      <EventSystemStatus resource={resources.eventsStatus} />
      <OptimizationCenter optimization={optimization} />
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
            safety_flags: safety || null,
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
      </details>


      {!loading && error && <div className="sup-error">{error}</div>}
      {loading && <div className="sup-loading">{model.loadingMessage}</div>}
    </div>
  );
}
