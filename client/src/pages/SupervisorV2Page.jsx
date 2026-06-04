import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

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
  { key: 'daytradingLearningSummary', url: '/api/daytrading/learning-summary?hours=48&limit=200', label: 'Daytrading learning summary' },
  { key: 'priority', url: '/api/priority/summary', label: 'Priority Engine' },
  { key: 'optimization', url: '/api/optimization/summary', label: 'AI Optimization Agent' },
  { key: 'tradingviewStatus', url: '/api/tradingview/status', label: 'TradingView status' },
  { key: 'marketRegime', url: '/api/market-regime/status', label: 'Market Regime' },
  { key: 'paperStatus', url: '/api/paper-trading/status', label: 'Paper Trading status' },
  { key: 'paperPerformance', url: '/api/paper-trading/performance', label: 'Paper Trading performance' },
  { key: 'runtimeStrategies', url: '/api/daytrading/runtime-strategies', label: 'Daytrading runtime strategies' },
  { key: 'registryStatus', url: '/api/strategies/registry/status', label: 'Strategy Registry status' },
  { key: 'strategyScoreStatus', url: '/api/strategies/score/status', label: 'Strategy Score v1' },
  { key: 'testPlannerStatus', url: '/api/strategies/test-planner/status', label: 'Strategy Test Planner v1' },
  { key: 'recommendation', url: '/api/daytrading/recommendation', label: 'Daytrading recommendation' },
  { key: 'eventsRecent', url: '/api/events/recent?n=100', label: 'Recent trading events' },
  { key: 'eventsStatus', url: '/api/events/status', label: 'Event system status' },
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

function summarizeStopReason(event) {
  const reason = textValue(event?.reason, '').trim();
  if (reason) return reason;
  const metaReason = textValue(event?.metadata?.reason_sv || event?.metadata?.reason || event?.metadata?.exit_reason_code || event?.metadata?.exit_source, '').trim();
  if (metaReason) return metaReason;
  const type = String(event?.event_type || '').toLowerCase();
  if (type === 'market_gate.blocked') return 'Market Gate blockerade signalen';
  if (type === 'market_gate.observe_only') return 'Market Gate satte observe_only';
  if (type === 'paper_trade.skipped') return 'Paper trade skippades';
  return 'Ingen tydlig stopporsak sparad';
}

function signalStopSummary(eventsResource) {
  const data = unwrap(eventsResource);
  const events = normalizeArray(data?.events);
  const counts = events.reduce((acc, event) => {
    const type = String(event?.event_type || '').toLowerCase();
    if (!type) return acc;
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const sortedEvents = [...events].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const lastBlocked = sortedEvents.find((event) => String(event?.event_type || '').toLowerCase() === 'market_gate.blocked') || null;
  const topReason = commonEntry(events, 'reason') || commonEntry(events.map((event) => ({ reason: summarizeStopReason(event) })), 'reason');
  const topSymbol = commonEntry(events, 'symbol');
  const topStrategy = commonEntry(events, 'strategy');
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
    topReasonCount: topReason?.count || 0,
    topSymbol: topSymbol?.value || 'Ingen data ännu',
    topSymbolCount: topSymbol?.count || 0,
    topStrategy: topStrategy?.value || 'Ingen data ännu',
    topStrategyCount: topStrategy?.count || 0,
    latestBlocked: lastBlocked,
    conclusion: strongestStop,
  };
}

function buildEventsByMarketSummary(events) {
  const rows = normalizeArray(events);
  const markets = ['crypto', 'stocks', 'nasdaq', 'unknown'];
  const normalizedMarket = (event) => {
    const raw = textValue(event?.market, 'unknown').trim().toLowerCase();
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
      const type = String(event?.event_type || '').toLowerCase();
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
    const topStrategy = commonEntry(eventsForMarket, 'strategy');
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
      topReasonCount: topReason?.count || 0,
      topSymbol: topSymbol?.value || 'Ingen data ännu',
      topSymbolCount: topSymbol?.count || 0,
      topStrategy: topStrategy?.value || 'Ingen data ännu',
      topStrategyCount: topStrategy?.count || 0,
      tone,
      interpretation,
      hasEvents: eventsForMarket.length > 0,
      isTopMarket: topMarket.market === market && topMarket.count > 0,
    };
  });

  return { summaries, topMarket };
}

function buildEventAiConclusion(events) {
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
    const type = String(event?.event_type || '').toLowerCase();
    if (!type) return acc;
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const topReason = commonEntry(rows, 'reason') || commonEntry(rows.map((event) => ({ reason: summarizeStopReason(event) })), 'reason');
  const topSymbol = commonEntry(rows, 'symbol');
  const topStrategy = commonEntry(rows, 'strategy');
  const topMarket = commonEntry(rows, 'market');

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
  const total = Number(batch.progress?.total || 0);
  const completed = Number(batch.progress?.completed || 0);
  const done = total > 0 && completed >= total;
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

function drilldownRowLabel(strategy) {
  return firstText([strategy?.strategy_id, strategy?.strategyId, strategy?.strategy_name, strategy?.strategyName], 'Ej konfigurerad');
}

function drilldownRowMeta(strategy) {
  return [
    `source=${textValue(strategy?.source, 'internal')}`,
    `status=${textValue(strategy?.status, 'paper_only')}`,
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
          {rows.map((strategy) => (
            <li key={`${title}-${drilldownRowLabel(strategy)}`} style={{ listStyle: 'none' }}>
              <button
                type="button"
                onClick={() => onSelectStrategy?.(strategy?.strategy_id || strategy?.strategyId || strategy?.name || strategy?.label || '')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: '1px solid rgba(148,163,184,0.16)',
                  borderRadius: 14,
                  padding: '10px 12px',
                  background: selectedStrategyId === (strategy?.strategy_id || strategy?.strategyId || strategy?.name || strategy?.label)
                    ? 'rgba(37, 99, 235, 0.14)'
                    : 'rgba(15, 23, 42, 0.24)',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <strong>{drilldownRowLabel(strategy)}</strong>
                  <span className={`badge badge-${strategySourceBadgeTone(strategy?.source)}`}>{textValue(strategy?.source, 'internal')}</span>
                  <span className={`badge badge-${strategyStatusBadgeTone(strategy?.status)}`}>{textValue(strategy?.status, 'paper_only')}</span>
                  <span className="badge badge-blue">Visa detaljer</span>
                </div>
                <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                  <span className="sup-v2-chip">Score {textValue(strategy?.score, '–')}</span>
                  <span className="sup-v2-chip">Confidence {textValue(strategy?.confidence, '–')}%</span>
                  <span className="sup-v2-chip">Sample {textValue(strategy?.sample_size, '–')}</span>
                </div>
                <div style={{ lineHeight: 1.45 }}>{textValue(strategy?.recommended_action, 'Ingen rekommendation ännu.')}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="sup-safety-copy" style={{ marginTop: 8 }}>
          {emptyText}
        </div>
      )}
    </article>
  );
}

function StrategyPlannerCard({ item, onSelect }) {
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
        <span className={`badge badge-${strategySourceBadgeTone(item.source)}`}>{textValue(item.source, 'internal')}</span>
        <span className={`badge badge-${strategyStatusBadgeTone(item.status)}`}>{textValue(item.status, 'paper_only')}</span>
        <span className="sup-v2-chip">Scope {textValue(item.suggested_scope, 'Ej konfigurerad')}</span>
        <span className="sup-v2-chip">Learning {textValue(item.expected_learning_value, 'Ej konfigurerad')}</span>
      </div>
      <div className="sup-v2-card-source" style={{ marginTop: 8 }}>{textValue(item.safety_note, 'Read-only')}</div>
    </article>
  );
}

function StrategyPlannerPanel({ planner, onSelectRecommendation }) {
  const recommendations = normalizeArray(planner?.recommendations).slice(0, 5);
  const summary = planner?.summary || {};
  const safety = planner?.safety || SAFETY_FLAGS;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Recommended Next Tests</h2>
          <p>Read-only planner. Rekommendationerna startar inga tester automatiskt.</p>
        </div>
        <SafetyTag />
      </div>

      <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <span className="sup-v2-chip">Totalt {textValue(summary.total_recommendations, '0')}</span>
        <span className="sup-v2-chip">Replay {textValue(summary.replay_recommendations, '0')}</span>
        <span className="sup-v2-chip">Batch {textValue(summary.batch_recommendations, '0')}</span>
        <span className="sup-v2-chip">Paper {textValue(summary.paper_observation_recommendations, '0')}</span>
        <span className="sup-v2-chip">History {textValue(summary.history_review_recommendations, '0')}</span>
        <span className="sup-v2-chip">TradingView {textValue(summary.tradingview_recommendations, '0')}</span>
        <span className="sup-v2-chip">Internal {textValue(summary.internal_recommendations, '0')}</span>
        <span className="sup-v2-chip">Paused/deprecated {textValue(summary.skipped_paused_count, '0')}</span>
      </div>

      {recommendations.length > 0 ? (
        <div className="sup-v2-answer-grid">
          {recommendations.map((item) => (
            <StrategyPlannerCard
              key={item.id || `${item.strategy_id}-${item.test_type}`}
              item={item}
              onSelect={onSelectRecommendation}
            />
          ))}
        </div>
      ) : (
        <div className="sup-safety-copy">Inga rekommendationer ännu. Systemet verkar vara tillräckligt täckt just nu.</div>
      )}
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
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Strategy History Drilldown</h2>
          <p>Kompakt read-only detaljvy för vald strategi. Inga tester startas och inga statusar ändras här.</p>
        </div>
        <SafetyTag />
      </div>

      {loading ? (
        <div className="sup-loading">Laddar strategi-historik...</div>
      ) : error ? (
        <div className="sup-error">{error}</div>
      ) : !data ? (
        <div className="sup-safety-copy">Ingen historik ännu. Klicka på en strategi i Drilldown för att se detaljer.</div>
      ) : (
        <article className="sup-v2-answer sup-v2-answer-neutral">
          <div className="sup-v2-answer-head">
            <div>
              <div className="sup-v2-answer-kicker">{data.strategy_id}</div>
              <h3>{data.strategy_id}</h3>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`badge badge-${strategySourceBadgeTone(registry.source)}`}>{textValue(registry.source, 'internal')}</span>
              <span className={`badge badge-${strategyStatusBadgeTone(registry.status)}`}>{textValue(registry.status, 'paper_only')}</span>
              <button type="button" className="badge badge-blue" onClick={onClear} style={{ cursor: 'pointer', border: 'none' }}>
                Stäng
              </button>
            </div>
          </div>

          <p className="sup-v2-answer-main">
            Score {textValue(score.score, '–')} · Confidence {textValue(score.confidence, '–')}% · Sample size {textValue(score.sample_size, '0')}
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
            <span className="sup-v2-chip">Paper {textValue(historySummary.paper_trades_count, '0')}</span>
            <span className="sup-v2-chip">Replay {textValue(historySummary.replay_tests_count, '0')}</span>
            <span className="sup-v2-chip">Batch {textValue(historySummary.batch_tests_count, '0')}</span>
            <span className="sup-v2-chip">Learning {textValue(historySummary.learning_events_count, '0')}</span>
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
              <strong className="sup-block-value">{registry.mode || 'paper_only'}</strong>
              <span className="sup-block-note">
                Source {textValue(registry.source, 'internal')} · Status {textValue(registry.status, 'paper_only')} · Enabled {registry.enabled ? 'ja' : 'nej'}
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
    </section>
  );
}

function RecentTradingEvents({ resource }) {
  const data = unwrap(resource);
  const state = endpointState(resource);
  const events = normalizeArray(data?.events).slice(0, 20);
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
  const events = normalizeArray(data?.events).slice(0, 100);
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
          <strong className="sup-block-value">{ai.metrics.detected} signal.detected</strong>
          <span className="sup-block-note">
            strategy.matched {ai.metrics.matched} · market_gate.blocked {ai.metrics.blocked} · market_gate.observe_only {ai.metrics.observeOnly} · paper_trade.opened {ai.metrics.opened} · paper_trade.skipped {ai.metrics.skipped}
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
              : 'Fortsätt bara observera eller kontrollera gate/risk om allt blockeras.'}
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
  const events = normalizeArray(data?.events).slice(0, 100);
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

      {!hasEvents ? (
        <div className="opt-empty">Inga events ännu. Systemet väntar på nya signaler.</div>
      ) : (
        <>
          <div className="sup-v2-report-lead" style={{ marginBottom: 12 }}>
            <strong>Översikt:</strong> {summary.topMarket.count > 0 ? `Flest events kommer från ${summary.topMarket.market}.` : 'Inga tydliga marknadsmönster ännu.'}
          </div>

          <div className="sup-grid sup-grid-2">
            {summary.summaries.map((item) => (
              <article key={item.market} className={`sup-block ${toneClassFor(item.tone)}`}>
                <span className="sup-block-title">{item.market}</span>
                <strong className="sup-block-value">{item.count} events</strong>
                <span className="sup-block-note">{item.interpretation}</span>
                <div className="sup-v2-report-lead" style={{ marginTop: 10, marginBottom: 0 }}>
                  <strong>Nyckeltal:</strong> signal.detected {item.detected} · strategy.matched {item.matched} · market_gate.blocked {item.blocked} · market_gate.observe_only {item.observeOnly} · paper_trade.opened {item.opened} · paper_trade.skipped {item.skipped}
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
  const jsonlEnabled = data?.jsonl_enabled !== false;
  const kafkaEnabled = data?.kafka_enabled === true;
  const kafkaConfigured = data?.kafka_configured === true;
  const kafkaTopic = textValue(data?.kafka_topic, 'trading.events');
  const kafkaClientId = textValue(data?.kafka_client_id, 'trading-os-v2');
  const kafkaBrokers = Array.isArray(data?.kafka_brokers) ? data.kafka_brokers.filter(Boolean) : [];
  const kafkaError = textValue(data?.kafka_last_error, '');
  const kafkaLastPublishAt = data?.kafka_last_publish_at || null;
  const kafkaLastAttemptAt = data?.kafka_last_attempt_at || null;
  const safetyItems = [
    ['actions_allowed', data?.actions_allowed],
    ['can_place_orders', data?.can_place_orders],
    ['live_trading_enabled', data?.live_trading_enabled],
  ];

  let statusMessage = 'Kafka är förberett men avstängt. Events sparas lokalt i JSONL.';
  if (kafkaEnabled && kafkaError) {
    statusMessage = 'Kafka har fel, men tradingflödet påverkas inte.';
  } else if (kafkaEnabled) {
    statusMessage = 'Kafka är aktivt som extra transportlager. JSONL är fortfarande primär.';
  }

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Event system status</h2>
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
        <article className={`sup-block ${jsonlEnabled ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">JSONL-logg</span>
          <strong className="sup-block-value">{jsonlEnabled ? 'aktiv' : 'inaktiv'}</strong>
          <span className="sup-block-note">Primär lagring i data/events/trading-events.jsonl.</span>
        </article>

        <article className={`sup-block ${kafkaEnabled && kafkaError ? 'sup-block-danger' : kafkaEnabled ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Kafka</span>
          <strong className="sup-block-value">{kafkaEnabled && !kafkaError ? 'aktiv' : kafkaEnabled ? 'på med fel' : 'av'}</strong>
          <span className="sup-block-note">{statusMessage}</span>
        </article>

        <article className={`sup-block ${kafkaConfigured ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Kafka konfigurerad</span>
          <strong className="sup-block-value">{kafkaConfigured ? 'ja' : 'nej'}</strong>
          <span className="sup-block-note">
            Brokers: {Array.isArray(data?.kafka_brokers) && data.kafka_brokers.length ? data.kafka_brokers.join(', ') : 'ej konfigurerade'}.
          </span>
        </article>

        <article className={`sup-block ${kafkaEnabled && !kafkaError ? 'sup-block-ok' : 'sup-block-neutral'}`}>
          <span className="sup-block-title">Redpanda transport</span>
          <strong className="sup-block-value">{kafkaEnabled && !kafkaError ? 'aktiv' : 'avvaktar'}</strong>
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

        <article className="sup-block sup-block-ok">
          <span className="sup-block-title">Safety</span>
          <strong className="sup-block-value">låst</strong>
          <span className="sup-block-note">
            {safetyItems.map(([key, value]) => `${key}=${String(value)}`).join(' · ')}
          </span>
        </article>
      </div>
    </section>
  );
}

function SignalStopSummary({ resource }) {
  const summary = signalStopSummary(resource);
  const latestBlocked = summary.latestBlocked;

  return (
    <section className="sup-section">
      <div className="sup-section-head">
        <div>
          <h2>Var stoppades signalerna?</h2>
          <p>Read-only sammanfattning av de senaste 100 eventen från event-loggen.</p>
        </div>
        <SafetyTag />
      </div>

      {!summary.hasEvents ? (
        <div className="opt-empty">Inga events ännu. Systemet väntar på nya signaler.</div>
      ) : (
        <>
          <div className="sup-pill-grid">
            <div className="sup-pill sup-pill-missing">
              <span>signal.detected</span>
              <strong>{summary.detected}</strong>
            </div>
            <div className="sup-pill sup-pill-missing">
              <span>strategy.matched</span>
              <strong>{summary.matched}</strong>
            </div>
            <div className="sup-pill sup-pill-good">
              <span>market_gate.allowed</span>
              <strong>{summary.allowed}</strong>
            </div>
            <div className="sup-pill sup-pill-bad">
              <span>market_gate.blocked</span>
              <strong>{summary.blocked}</strong>
            </div>
            <div className="sup-pill sup-pill-missing">
              <span>market_gate.observe_only</span>
              <strong>{summary.observeOnly}</strong>
            </div>
            <div className="sup-pill sup-pill-good">
              <span>paper_trade.opened</span>
              <strong>{summary.opened}</strong>
            </div>
            <div className="sup-pill sup-pill-missing">
              <span>paper_trade.skipped</span>
              <strong>{summary.skipped}</strong>
            </div>
          </div>

          <div className="sup-grid sup-grid-2">
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Vanligaste stopporsak</span>
              <strong className="sup-block-value">{summary.topReason}</strong>
              <span className="sup-block-note">{summary.topReasonCount ? `${summary.topReasonCount} händelser` : 'Ingen tydlig stopporsak ännu.'}</span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Vanligaste symbol</span>
              <strong className="sup-block-value">{summary.topSymbol}</strong>
              <span className="sup-block-note">{summary.topSymbolCount ? `${summary.topSymbolCount} händelser` : 'Ingen tydlig symbol ännu.'}</span>
            </article>
            <article className="sup-block sup-block-neutral">
              <span className="sup-block-title">Vanligaste strategi</span>
              <strong className="sup-block-value">{summary.topStrategy}</strong>
              <span className="sup-block-note">{summary.topStrategyCount ? `${summary.topStrategyCount} händelser` : 'Ingen tydlig strategi ännu.'}</span>
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
  const color = score >= 60 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <span className="opt-score-badge" style={{ background: `${color}18`, color, borderColor: `${color}50` }}>
      {score}/100
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
  return (
    <div className="opt-minibar-track">
      <div className="opt-minibar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function ConfigCard({ config, rank }) {
  const [open, setOpen] = React.useState(false);
  if (!config?.stats) return null;
  const { winRatePct, timeoutRatePct, avgPnl, n } = config.stats;
  const isTop = rank <= 2;
  return (
    <div className={`opt-config-card ${isTop ? 'opt-config-top' : ''}`}>
      <div className="opt-config-header">
        <div className="opt-config-rank">#{rank}</div>
        <div className="opt-config-info">
          <div className="opt-config-label">{config.label}</div>
          <div className="opt-config-n">{n} trades</div>
        </div>
        <OptScoreBadge score={config.score || 0} />
      </div>
      <div className="opt-config-bars">
        <div className="opt-config-bar-row">
          <span>Win rate</span>
          <MiniBar pct={winRatePct || 0} color={(winRatePct || 0) >= 50 ? '#22c55e' : (winRatePct || 0) >= 35 ? '#f59e0b' : '#ef4444'} />
          <span className="opt-bar-val">{winRatePct}%</span>
        </div>
        <div className="opt-config-bar-row">
          <span>Timeout</span>
          <MiniBar pct={timeoutRatePct || 0} color={(timeoutRatePct || 0) > 50 ? '#ef4444' : (timeoutRatePct || 0) > 30 ? '#f59e0b' : '#22c55e'} />
          <span className="opt-bar-val">{timeoutRatePct}%</span>
        </div>
      </div>
      <div className={`opt-config-pnl ${avgPnl >= 0 ? 'opt-pnl-pos' : 'opt-pnl-neg'}`}>
        {avgPnl >= 0 ? '+' : ''}{(avgPnl * 100).toFixed(3)}% snitt P/L
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
  return (
    <div className="opt-weak-card">
      <div className="opt-weak-header">
        <span className="opt-weak-icon">⚠️</span>
        <div>
          <div className="opt-weak-label">{config.label}</div>
          <div className="opt-weak-n">{n} trades</div>
        </div>
        <OptScoreBadge score={config.score || 0} />
      </div>
      {config.warning && <div className="opt-weak-warning">{config.warning}</div>}
      <div className="opt-weak-stats">
        <span>WR: {winRatePct}%</span>
        <span>Timeout: {timeoutRatePct}%</span>
      </div>
    </div>
  );
}

function BucketBar({ items, scoreKey = 'score', labelKey = 'label', metricKey = 'stats', metricField = 'winRatePct' }) {
  if (!items?.length) return <div className="opt-empty">Ingen data</div>;
  const maxScore = Math.max(...items.map((item) => item?.[scoreKey] || 0));
  return (
    <div className="opt-bucket-list">
      {items.map((item, i) => {
        const st = item?.[metricKey];
        if (!st) return null;
        const val = st[metricField] ?? 0;
        const color = val >= 50 ? '#22c55e' : val >= 35 ? '#f59e0b' : '#ef4444';
        const isBest = i === 0 || (item?.[scoreKey] || 0) === maxScore;
        return (
          <div key={`${item?.[labelKey] || i}`} className={`opt-bucket-row ${isBest ? 'opt-bucket-best' : ''}`}>
            <div className="opt-bucket-label">{item?.[labelKey]}</div>
            <div className="opt-bucket-bar-wrap">
              <MiniBar pct={val} color={color} />
            </div>
            <div className="opt-bucket-vals">
              <span style={{ color, fontWeight: 600 }}>{val}%</span>
              <span className="opt-bucket-n">n={st.n}</span>
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
        label: item.label || item.strategy_name || item.name,
        score: item.score,
        stats: item.stats,
      })),
      weakConfigs: weakConfigs.slice(0, 4).map((item) => ({
        label: item.label || item.strategy_name || item.name,
        score: item.score,
        stats: item.stats,
      })),
      recommendations: optimization.recommendations || {},
    },
    configs: {
      topConfigs: topConfigs.slice(0, 5).map((item) => ({
        label: item.label || item.strategy_name || item.name,
        score: item.score,
        stats: item.stats,
        params: item.params,
      })),
      weakConfigs: weakConfigs.slice(0, 5).map((item) => ({
        label: item.label || item.strategy_name || item.name,
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
      timeoutCount: optimization.exits?.timeoutCount ?? 0,
      timeoutPct: optimization.exits?.timeoutPct ?? 0,
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
  const tradeCount = optimization?.tradeCount ?? 0;
  const overallStats = optimization?.overallStats || optimization?.overall_stats || {};
  const overallScore = optimization?.overallScore ?? 0;
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
              Analyserar {tradeCount} historiska trades och förklarar vad som fungerar, vad som blockeras och vad nästa steg är.
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
                  <div className="opt-ov-val" style={{ color: (overallStats.winRatePct || 0) >= 50 ? '#22c55e' : '#f59e0b' }}>
                    {overallStats.winRatePct}%
                  </div>
                  <div className="opt-ov-label">Total win rate</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val" style={{ color: (overallStats.timeoutRatePct || 0) > 40 ? '#ef4444' : '#22c55e' }}>
                    {overallStats.timeoutRatePct}%
                  </div>
                  <div className="opt-ov-label">Timeout-rate</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val" style={{ color: (overallStats.avgPnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                    {(overallStats.avgPnl || 0) >= 0 ? '+' : ''}{((overallStats.avgPnl || 0) * 100).toFixed(3)}%
                  </div>
                  <div className="opt-ov-label">Snitt P/L</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{tradeCount}</div>
                  <div className="opt-ov-label">Trades analyserade</div>
                </div>
              </div>
            )}
            <div className="opt-subsection">Snabba insikter</div>
            <RecommendationsList recs={recommendations} />
            <div className="opt-rec-note">Bästa strategi: {bestStrategy?.strategy_name || 'Ingen tydlig vinnare ännu'}.</div>
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
                <strong style={{ color: (exitsData?.timeoutPct || 0) > 40 ? '#ef4444' : '#22c55e' }}>
                  {exitsData?.timeoutCount ?? 0} ({exitsData?.timeoutPct ?? 0}%)
                </strong>
              </div>
              {exitsData?.motorExitStats && (
                <div className="opt-exit-stat">
                  <span>Exitmotor:</span>
                  <strong>{exitsData.motorExitStats.winRatePct}% WR ({exitsData.motorExitStats.n} trades)</strong>
                </div>
              )}
              {exitsData?.manualExitStats && (
                <div className="opt-exit-stat">
                  <span>Manuell exit:</span>
                  <strong>{exitsData.manualExitStats.winRatePct}% WR ({exitsData.manualExitStats.n} trades)</strong>
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
                      <OptScoreBadge score={m.score || 0} />
                    </div>
                    {m.stats && (
                      <div className="opt-market-stats">
                        <StatRow label="Win rate" value={`${m.stats.winRatePct}%`} highlight={m.stats.winRatePct >= 50} />
                        <StatRow label="Timeout" value={`${m.stats.timeoutRatePct}%`} />
                        <StatRow label="Trades" value={m.stats.n} />
                        {m.avgHoldMin != null && <StatRow label="Snitt hålltid" value={`${m.avgHoldMin} min`} />}
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
                      <OptScoreBadge score={c.score || 0} />
                    </div>
                    {c.stats && <div className="opt-combo-wr">{c.stats.winRatePct}% WR · {c.stats.n} trades</div>}
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
                    <div className="opt-ov-val">{strategyBatchTesting.bestStrategy?.strategy_name || '–'}</div>
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
                  Batch {strategyBatchTesting.latestBatch.name} · {getBatchUiStatus(strategyBatchTesting.latestBatch).emoji} {getBatchUiStatus(strategyBatchTesting.latestBatch).label} · {strategyBatchTesting.latestBatch.progress?.completed || 0}/{strategyBatchTesting.latestBatch.progress?.total || 0}
                </div>
                <RecommendationsList recs={strategyBatchTesting.recommendations} />
                {pauseCandidates?.length > 0 && (
                  <>
                    <div className="opt-subsection opt-weak-sub">Strategier att pausa/testa om</div>
                    <div className="opt-market-list">
                      {pauseCandidates.slice(0, 6).map((s, i) => (
                        <div key={`${s.strategy_id}-${i}`} className="opt-market-card">
                          <div className="opt-market-header">
                            <span className="opt-market-name">{s.strategy_name || s.strategy_id}</span>
                            <OptScoreBadge score={s.score || 0} />
                          </div>
                          <div className="opt-market-stats">
                            <StatRow label="Win rate" value={`${s.win_rate || 0}%`} />
                            <StatRow label="Trades" value={s.trades || 0} />
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
  const daytradingLearning = unwrap(resources.daytradingLearningSummary)?.data || null;
  const learningSummary = daytradingLearning?.summary || null;
  const priority = unwrap(resources.priority);
  const optimization = unwrap(resources.optimization);
  const marketRegime = unwrap(resources.marketRegime);
  const paperStatus = unwrap(resources.paperStatus);
  const paperPerformance = unwrap(resources.paperPerformance);
  const recommendation = unwrap(resources.recommendation);
  const runtime = unwrap(resources.runtimeStrategies);
  const registryStatus = unwrap(resources.registryStatus);
  const strategyScoreStatus = unwrap(resources.strategyScoreStatus);
  const testPlannerStatus = unwrap(resources.testPlannerStatus);
  const tradingViewStatus = unwrap(resources.tradingviewStatus);

  const runtimeSummary = runtime?.summary || {};
  const runtimeStrategies = normalizeArray(runtime?.strategies);
  const topFocus = normalizeArray(priority?.topFocus || []);
  const avoidList = normalizeArray(priority?.avoid || []);
  const catalogStatusCounts = runtimeStrategies.reduce((acc, strategy) => {
    const key = strategyCatalogStatusKey(strategy);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const catalogStatusRows = runtimeStrategies
    .map((strategy) => {
      const statusKey = strategyCatalogStatusKey(strategy);
      return {
        id: strategy.id || strategy.strategy_id || '',
        name: strategy.name || strategy.strategy_name || strategy.id || strategy.strategy_id || 'Okänd strategi',
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
    ...(learningSummary?.trades_total != null ? [] : ['Daytrading learning summary saknar underlag.']),
    ...(learningConnectorStatus?.errors?.length ? [`Learning Connector har ${formatInt(learningConnectorStatus.errors.length)} fel i kö.`] : []),
    ...(pipelineStatus?.warnings?.length ? [`Pipeline har ${formatInt(pipelineStatus.warnings.length)} varningar.`] : []),
    ...(registryStatus?.ok === false ? ['Strategy Registry-data är inte tillgänglig.'] : []),
    ...(strategyScoreStatus?.ok === false ? ['Strategy Score-data är inte tillgänglig.'] : []),
    ...(tradingViewStatus?.webhook_auth_configured === false ? ['TradingView-webhook auth är inte konfigurerad.'] : []),
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
    daytradingLearning?.summary?.best_strategy?.key ? `Bäst i learning: ${daytradingLearning.summary.best_strategy.key}.` : '',
  ]);

  const registrySummary = {
    total: toNumber(registryStatus?.total_strategies) ?? 0,
    active: toNumber(registryStatus?.active_strategies) ?? 0,
    tradingview: toNumber(registryStatus?.tradingview_strategies) ?? 0,
    paused: toNumber(registryStatus?.paused_strategies) ?? 0,
    deprecated: toNumber(registryStatus?.deprecated_strategies) ?? 0,
    latestTradingView: registryStatus?.latest_tradingview_strategy || null,
    latestBlockedReason: registryStatus?.latest_blocked_reason || null,
  };

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
    total: toNumber(strategyScoreStatus?.total_strategies) ?? scoreStrategies.length,
    uncertain: toNumber(strategyScoreStatus?.uncertain_count) ?? 0,
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
    registrySummary,
    scoreSummary,
    testPlannerStatus,
    daytradingLearning,
    learningSummary,
    tradingViewStatus,
    hasConflict,
    conflictKeys,
    conflictMessage: hasConflict
      ? 'Strategikonflikt upptäckt: samma strategi förekommer både som rekommenderad och att undvika. Kontrollera datakällor i Insikter/Daytrading.'
      : '',
    mixedSignalSummary,
    mixedBest: bestMixed,
    mixedAvoid: avoidMixed,
    systemProblems,
    catalogStatusCounts,
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
      title="actions_allowed=false · can_place_orders=false · live_trading_enabled=false"
      style={{ whiteSpace: 'nowrap' }}
    >
      🔒 Read-only · paper_only
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

  function clearStrategyHistory() {
    setSelectedStrategyId('');
    setSelectedStrategyHistory(null);
    setSelectedStrategyPlannerContext(null);
    setStrategyHistoryError('');
    setStrategyHistoryLoading(false);
  }

  const model = useMemo(() => buildDecisionModel(resources), [resources]);
  const endpointRows = useMemo(() => buildEndpointRows(resources), [resources]);
  const technicalCards = useMemo(() => buildTechnicalCards(resources, model), [resources, model]);
  const optimization = unwrap(resources.optimization);
  const testPlannerStatus = model.testPlannerStatus || null;
  const plannerSummary = testPlannerStatus?.summary || {};
  const plannerRecommendations = normalizeArray(testPlannerStatus?.recommendations).slice(0, 5);
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

  const topStrategies = normalizeArray(model.scoreSummary?.topDrilldown);
  const weakStrategies = normalizeArray(model.scoreSummary?.weakDrilldown);
  const uncertainStrategies = normalizeArray(model.scoreSummary?.uncertainDrilldown);
  const tradingViewStrategies = normalizeArray(model.scoreSummary?.tradingviewDrilldown);
  const internalStrategies = normalizeArray(model.scoreSummary?.internalDrilldown);
  const learningStrategies = normalizeArray(daytradingLearning?.by_strategy);
  const learningNeedsMoreData = learningStrategies.filter((row) => String(row?.status || '').toLowerCase() === 'needs_more_data').slice(0, 5);
  const learningSkipReasons = normalizeArray(daytradingLearning?.skip_reasons).slice(0, 3);

  const tvEnabled = tradingViewStatus?.enabled !== false;
  const tvWebhookAuth = tradingViewStatus?.webhook_auth_configured === true;
  const tvMode = textValue(tradingViewStatus?.mode, 'paper_only');
  const tvAccepted = toNumber(tradingViewStatus?.accepted_signals) ?? 0;
  const tvRejected = toNumber(tradingViewStatus?.rejected_signals) ?? 0;
  const tvForwardingState = tvRejected > 0 ? 'Delvis/blockeras' : tvAccepted > 0 ? 'Ja' : 'Okänt';
  const latestTvStrategy = registryStatus?.latest_tradingview_strategy || null;
  const latestBlockedReason = registryStatus?.latest_blocked_reason || null;
  const latestBlockedStrategy = registryStatus?.latest_blocked_strategy || null;
  const totalStrategies = toNumber(registryStatus?.total_strategies) ?? 0;
  const activeStrategies = toNumber(registryStatus?.active_strategies) ?? 0;
  const pausedStrategies = toNumber(registryStatus?.paused_strategies) ?? 0;
  const tradingViewCount = toNumber(registryStatus?.tradingview_strategies) ?? tradingViewStrategies.length;
  const uncertainStrategyCount = toNumber(model.scoreSummary?.uncertain) ?? uncertainStrategies.length;
  const internalStrategyCount = internalStrategies.length;
  const nextPlannerRecommendation = plannerRecommendations[0] || null;
  const nextPlannerAction = nextPlannerRecommendation
    ? `${nextPlannerRecommendation.strategy_id} · ${nextPlannerRecommendation.test_type}`
    : model.recommendationLabel;
  const nextPlannerReason = nextPlannerRecommendation?.reason || model.bestCardSummary;
  const keyRisk = model.systemProblems[0] || model.riskSafetyPoints[0] || 'Ingen tydlig risk just nu.';

  if (loading && !resources.status) {
    return (
      <div className="sup-page sup-v2-page">
        <div className="sup-hero sup-v2-hero">
          <div className="sup-hero-copy">
            <div className="sup-kicker">Trading OS · Huvudvy</div>
            <h1>Laddar Trading OS</h1>
            <p>Systemet kör endast paper/test. Live trading är avstängt.</p>
          </div>
        </div>
        <div className="sup-loading">Laddar sammanfogad Daytrading- och Supervisor-vy...</div>
      </div>
    );
  }

  return (
    <div className="sup-page sup-v2-page">
      <div className="sup-hero sup-v2-hero">
        <div className="sup-hero-copy">
          <div className="sup-kicker">Trading OS · Huvudvy</div>
          <h1>En enkel vy för strategi, learning och safety</h1>
          <p>
            Systemet kör endast paper/test. Live trading är avstängt. TradingView är kopplat för signaler och strategi-test.
          </p>
          <div className="sup-safety-copy">
            Den här sidan samlar Daytrading och Supervisor i en enda huvudvy. Debug, rådata och tekniska paneler ligger bakom teknisk diagnostik.
          </div>
        </div>
        <div className="sup-hero-actions">
          <button type="button" className="btn sup-refresh" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Uppdaterar...' : 'Uppdatera'}
          </button>
          <div className="sup-last-updated">Senast uppdaterad: {formatDateTime(lastUpdated)}</div>
        </div>
      </div>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Läget just nu</h2>
            <p>Snabb överblick utan debug-brus.</p>
          </div>
          <SafetyTag />
        </div>

        <div
          className="sup-grid sup-grid-5"
          style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
        >
          <article className={`sup-block ${summaryTone === 'good' ? 'sup-block-ok' : 'sup-block-warning'}`}>
            <span className="sup-block-title">Systemstatus</span>
            <strong className="sup-block-value">{model.systemStatus}</strong>
            <span className="sup-block-note">{model.systemConclusion}</span>
          </article>
          <article className="sup-block sup-block-ok">
            <span className="sup-block-title">Paper mode / Safety</span>
            <strong className="sup-block-value">paper_only</strong>
            <span className="sup-block-note">Endast paper/test. Live trading är avstängt.</span>
          </article>
          <article className={`sup-block ${tvEnabled ? 'sup-block-ok' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">TradingView</span>
            <strong className="sup-block-value">{tvEnabled ? 'Aktiv' : 'Avstängd'}</strong>
            <span className="sup-block-note">Mode {tvMode} · auth {tvWebhookAuth ? 'ja' : 'nej'} · {tvForwardingState}</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Aktiva strategier</span>
            <strong className="sup-block-value">{formatInt(activeStrategies, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">{formatInt(totalStrategies, 'Ingen data ännu')} totalt · {formatInt(pausedStrategies, 'Ingen data ännu')} pausade</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Rekommenderat nästa test</span>
            <strong className="sup-block-value">{nextPlannerAction}</strong>
            <span className="sup-block-note">{nextPlannerReason || 'Ingen rekommendation ännu.'}</span>
          </article>
          <article className={`sup-block ${model.systemProblems.length > 0 ? 'sup-block-danger' : 'sup-block-warning'}`}>
            <span className="sup-block-title">Viktigaste risk</span>
            <strong className="sup-block-value">{keyRisk}</strong>
            <span className="sup-block-note">Inga liveorder kan skickas härifrån.</span>
          </article>
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Nästa steg</h2>
            <p>Högst fem tydliga punkter för idag.</p>
          </div>
        </div>
        <div className="sup-focus-box">
          <div className="sup-focus-title">Nästa steg</div>
          {model.actionItems.slice(0, 5).map((item, index) => (
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
            <h2>Strategier</h2>
            <p>Aktiva, pausade, osäkra och TradingView-strategier.</p>
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
            title="Top 5 starkaste strategier"
            kicker="Score"
            badge="Starkast"
            badgeTone="green"
            summary="De strategier som ser bäst ut just nu."
            items={topStrategies}
            emptyText="Inga starka strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Top 5 svagaste strategier"
            kicker="Score"
            badge="Svagast"
            badgeTone="red"
            summary="Strategier med lägst styrka eller tydligast svaghet."
            items={weakStrategies}
            emptyText="Inga svaga strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="Top 5 mest osäkra strategier"
            kicker="Datatrygghet"
            badge="Osäkra"
            badgeTone="yellow"
            summary="Strategier som behöver mer data eller har låg confidence."
            items={uncertainStrategies}
            emptyText="Inga osäkra strategier ännu."
            onSelectStrategy={loadStrategyHistory}
            selectedStrategyId={selectedStrategyId}
          />
          <StrategyDrilldownCard
            title="TradingView-strategier"
            kicker="Källa"
            badge={tradingViewStrategies.length ? `${tradingViewStrategies.length} TV` : '0 TV'}
            badgeTone="yellow"
            summary={tradingViewStrategies.length > 0
              ? `${tradingViewStrategies.length} TradingView-strategier hittade. ${latestBlockedReason ? `Senaste blockering: ${latestBlockedReason}.` : 'Ingen senaste blockering sparad.'}`
              : 'Inga TradingView-strategier hittade ännu.'}
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
            <h2>TradingView-strategier</h2>
            <p>TradingView används för signaler och test, inte live trading.</p>
          </div>
          <SafetyTag />
        </div>

        <div
          className="sup-grid sup-grid-2"
          style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
        >
          <article className={`sup-block ${tvEnabled ? 'sup-block-ok' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">TradingView status</span>
            <strong className="sup-block-value">{tvEnabled ? 'Enabled' : 'Disabled'}</strong>
            <span className="sup-block-note">auth {tvWebhookAuth ? 'konfigurerad' : 'inte konfigurerad'} · mode {tvMode}</span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Forwardas eller blockeras</span>
            <strong className="sup-block-value">{tvForwardingState}</strong>
            <span className="sup-block-note">
              {tvAccepted > 0 || tvRejected > 0
                ? `Godkända ${formatInt(tvAccepted, '0')} · blockerade ${formatInt(tvRejected, '0')}`
                : 'Inga TradingView-signaler har registrerats ännu.'}
            </span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Antal TV-strategier</span>
            <strong className="sup-block-value">{formatInt(tradingViewCount, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">Senaste TradingView-strategi: {latestTvStrategy ? strategyDescriptor(latestTvStrategy) : 'ingen ännu'}</span>
          </article>
          <article className={`sup-block ${latestBlockedReason ? 'sup-block-warning' : 'sup-block-neutral'}`}>
            <span className="sup-block-title">Senaste blockeringsorsak</span>
            <strong className="sup-block-value">{latestBlockedReason || 'Ingen blockering sparad'}</strong>
            <span className="sup-block-note">{latestBlockedStrategy ? `Gällde ${strategyDescriptor(latestBlockedStrategy)}.` : 'Ingen senaste blockerade strategi sparad.'}</span>
          </article>
        </div>

        <div className="sup-safety-copy" style={{ marginTop: 12 }}>
          {tradingViewCount === 1
            ? '1 TradingView-strategi hittad.'
            : `${formatInt(tradingViewCount, '0')} TradingView-strategier hittade.`}
        </div>
      </section>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>AI och lärande</h2>
            <p>En primär sammanfattning. Dubletter ligger bakom debug.</p>
          </div>
        </div>

        <div
          className="sup-grid sup-grid-2"
          style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
        >
          <article className="sup-block sup-block-ok">
            <span className="sup-block-title">Vad AI verkar ha lärt sig</span>
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
            <span className="sup-block-title">Senaste learning notes</span>
            <strong className="sup-block-value">
              {learningSummary?.best_market_group?.label || learningSummary?.best_risk_class?.label || 'Ingen tydlig lärdom ännu'}
            </strong>
            <span className="sup-block-note">
              {learningSummary?.best_market_group?.key
                ? `Bäst marknadsgrupp: ${learningSummary.best_market_group.key}`
                : 'Learning sammanfattar fortfarande för få trades.'}
            </span>
          </article>
          <article className="sup-block sup-block-neutral">
            <span className="sup-block-title">Saknar underlag</span>
            <strong className="sup-block-value">{formatInt(learningSummary?.skipped_total, 'Ingen data ännu')}</strong>
            <span className="sup-block-note">{formatInt(learningSummary?.risk_blocks_total, 'Ingen data ännu')} risk-blockerade · {formatInt(learningSummary?.closed_trades, 'Ingen data ännu')} stängda trades</span>
          </article>
        </div>

        {learningNeedsMoreData.length > 0 && (
          <div className="sup-safety-copy" style={{ marginTop: 12 }}>
            Strategier som behöver mer data: {learningNeedsMoreData.map((row) => strategyDescriptor(row)).join(' · ')}
          </div>
        )}

        {learningSkipReasons.length > 0 && (
          <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {learningSkipReasons.map((reason) => (
              <span key={reason} className="sup-v2-chip">{reason}</span>
            ))}
          </div>
        )}
      </section>

      <StrategyPlannerPanel
        planner={testPlannerStatus}
        onSelectRecommendation={(item) => loadStrategyHistory(item?.strategy_id, item)}
      />

      <SignalStopSummary resource={resources.eventsRecent} />

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Strategy History Drilldown</h2>
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
            <strong>Summary:</strong> Paper {textValue(selectedHistorySummary.paper_trades_count, '0')} · Replay {textValue(selectedHistorySummary.replay_tests_count, '0')} · Batch {textValue(selectedHistorySummary.batch_tests_count, '0')} · Learning {textValue(selectedHistorySummary.learning_events_count, '0')}
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

        <pre className="sup-safety-copy" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify({
            system: {
              status: model.systemStatus,
              summary: model.systemSummary,
              conclusion: model.systemConclusion,
            },
            safety: SAFETY_FLAGS,
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
        <details className="sup-advanced" style={{ marginTop: 12 }}>
          <summary>Visa katalogstatus</summary>
          <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <span className="sup-v2-chip">ACTIVE {model.catalogStatusCounts?.active || 0}</span>
            <span className="sup-v2-chip">TESTING {model.catalogStatusCounts?.testing || 0}</span>
            <span className="sup-v2-chip">PAUSED {model.catalogStatusCounts?.paused || 0}</span>
            <span className="sup-v2-chip">ROADMAP {model.catalogStatusCounts?.roadmap || 0}</span>
            <span className="sup-v2-chip">LEGACY {model.catalogStatusCounts?.legacy || 0}</span>
          </div>
          <div className="sup-v2-card-source" style={{ marginTop: 8 }}>
            Katalogstatus kommer från Strategy Catalog. Runtime-koppling, paper-körbarhet och learning-stöd visas separat i Daytrading och Lab.
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
              badge: `${model.registrySummary.total} strategier`,
              summary: `Aktiva ${model.registrySummary.active} · TradingView ${model.registrySummary.tradingview} · Paused ${model.registrySummary.paused} · Deprecated ${model.registrySummary.deprecated}.`,
              points: uniqueText([
                `Senaste TradingView: ${strategyDescriptor(model.registrySummary.latestTradingView)}`,
                model.registrySummary.latestBlockedReason ? `Senaste blockering: ${model.registrySummary.latestBlockedReason}` : 'Ingen blockering sparad ännu.',
                'Safety: actions_allowed=false · can_place_orders=false · live_trading_enabled=false · mode=paper_only',
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

      <StrategyHistoryDetail
        history={selectedStrategyHistory}
        loading={strategyHistoryLoading}
        error={strategyHistoryError}
        onClear={clearStrategyHistory}
        plannerContext={selectedStrategyPlannerContext}
      />

      <SupGroupDivider index="3" title="Testrekommendationer" question="Vad bör testas härnäst?" />
      <StrategyPlannerPanel
        planner={{
          ok: testPlannerStatus?.ok !== false,
          recommendations: plannerRecommendations,
          summary: plannerSummary,
          safety: testPlannerStatus?.safety || SAFETY_FLAGS,
        }}
        onSelectRecommendation={loadStrategyHistory}
      />

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
