import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import { contextHref } from '../components/ContextNavigation.jsx';
import FuturesTechnicalInfoPanel from '../components/futures/FuturesTechnicalInfoPanel.jsx';
import FuturesPaperStrategyApprovalPanel from '../components/futures/FuturesPaperStrategyApprovalPanel.jsx';
import {
  BrokerOrdersPanel,
  FieldGrid,
  FillsPanel,
  LiveScannerPanel,
  MetricCard,
  OverviewPanel,
  PositionDeskPanel,
  PortfolioIntelligence,
  QuoteTape,
  SectionHeader,
  StatusBadge,
  StatusBadge as Pill,
  StatusRail,
  StrategyDashboard,
  StrategyStatisticsPanel,
  TradeJournal,
  TradingAnalyticsPanel,
  createDecisionStore,
  createTradingEventStore,
  createStrategyStore,
  statusTone,
  tradingSectionStyle as sectionStyle,
} from '../components/trading/index.js';
import { buildTradeJournal, summarizeTrades } from '../domain/TradeJournalDomain.js';
import { buildScannerRows, summarizeScanner } from '../domain/ScannerDomain.js';
import { buildPositionDeskRows, summarizePositionDesk } from '../domain/PositionDeskDomain.js';
import { aiStoryPaperStatus } from '../services/aiStoryService.js';
import { strategyDisplayName } from '../models/strategyViewModel.js';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  boolText,
  boolTone,
  countOrEmpty,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTime,
  hasValue,
  moneyOrWaiting,
  numberOrNull,
  snapshotHint,
  textOrEmpty,
} from '../utils/tradingFormatters.js';
import { FACTORY_TERM_KEYS, uiCopy, uiFactorySafeText, uiName } from '../services/uiTerminologyService.js';

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 7_000;

const PAPER_DESK_COPY = uiCopy('futuresPaperDesk');
const PANEL_GAP = 'var(--s5)';

const PRODUCT_TABS = [
  { id: 'oversikt', label: PAPER_DESK_COPY.tabs.today },
  { id: 'positioner', label: PAPER_DESK_COPY.tabs.positions },
  { id: 'trades', label: PAPER_DESK_COPY.tabs.recentTrades },
  { id: 'godkannande', label: PAPER_DESK_COPY.tabs.approval },
];

// Gamla ?tab=-länkar behålls för bakåtkompatibilitet, men de visas inte längre i
// huvudflikarna. Tekniska vyer nås från Dagens läge eller direkta gamla länkar.
const LEGACY_TABS = [
  { id: 'analytics', label: 'Analys' },
  { id: 'ordrar', label: 'Marknadsbevakning' },
  { id: 'broker-orders', label: 'Brokerordrar' },
  { id: 'fills', label: 'Brokeravslut' },
  { id: 'strategier', label: uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY) },
  { id: 'konto', label: 'IBKR Paper-konto' },
  { id: 'runtime', label: 'Teknisk drift' },
  { id: 'ibkr', label: 'IBKR orderstatus' },
  { id: 'teknik', label: 'Visa teknisk information' },
  { id: 'arkiv', label: 'Historiskt sim-arkiv' },
];

const TABS = [...PRODUCT_TABS, ...LEGACY_TABS];
const VISIBLE_TABS = PRODUCT_TABS;
const TAB_IDS = new Set(TABS.map((tab) => tab.id));

const DEFAULT_TAB = 'oversikt';

function normalizeTabId(tabId) {
  return TAB_IDS.has(tabId) ? tabId : DEFAULT_TAB;
}

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function useJson(url, refreshToken = 0) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;
    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout(url, { signal: activeController.signal })
        .then((data) => {
          if (alive) setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({ loading: false, error: err?.message || 'request_failed', data: prev.data }));
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (activeController) activeController.abort();
    };
  }, [url, refreshToken]);

  return state;
}

function paperSafeText(value, fallback = EMPTY_VALUE) {
  const text = uiFactorySafeText(value);
  return text || fallback;
}

function CompactTable({ rows, columns, emptyText = 'Inga data.' }) {
  if (!rows.length) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{emptyText}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ textAlign: 'left', padding: '10px 12px', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0, borderBottom: '1px solid var(--border)' }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.id || row.execId || row.orderId || row.tradeId || rowIndex}>
              {columns.map((col) => (
                <td key={col.key} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 13, verticalAlign: 'top' }}>
                  {typeof col.render === 'function' ? col.render(row) : row[col.key] ?? EMPTY_VALUE}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function orderIdentityKeys(row = {}) {
  return [
    row.orderRef,
    row.orderId,
    row.ibOrderId,
    row.permId,
    row.executionId,
  ].filter(hasValue).map(String);
}

function mergeOrderLifecycleRows(brokerOrders = [], orderIntents = []) {
  const seen = new Set(brokerOrders.flatMap(orderIdentityKeys));
  const historical = orderIntents.filter((row) => !orderIdentityKeys(row).some((key) => seen.has(key)));
  return [...brokerOrders, ...historical];
}

function moneyTone(value) {
  const number = numberOrNull(value);
  if (number == null) return 'neutral';
  if (number > 0) return 'success';
  if (number < 0) return 'danger';
  return 'neutral';
}

function brokerStateLabel(copy, value, waiting = false) {
  if (waiting) return { value: copy.brokerStates.loading, tone: 'neutral' };
  if (value === true) return { value: copy.brokerStates.connected, tone: 'success' };
  if (value === false) return { value: copy.brokerStates.problem, tone: 'danger' };
  return { value: copy.brokerStates.waiting, tone: 'neutral' };
}

function resultText(value, currency, copy) {
  const number = numberOrNull(value);
  return number == null ? copy.states.noResultYet : fmtMoney(number, currency, 2);
}

function latestClosedTrades(trades = []) {
  return trades
    .filter((trade) => trade.status !== 'open')
    .sort((a, b) => (
      (b.exitMs || Date.parse(b.exitTime || b.updatedAt || b.createdAt || '') || 0)
      - (a.exitMs || Date.parse(a.exitTime || a.updatedAt || a.createdAt || '') || 0)
    ))
    .slice(0, 5);
}

function closedPaperResultTrades(trades = []) {
  return trades.filter((trade) => (
    trade?.status === 'win'
    || trade?.status === 'loss'
    || trade?.status === 'breakeven'
  ));
}

function tradeCloseMs(trade = {}) {
  const direct = numberOrNull(trade.exitMs);
  if (direct != null) return direct;
  const parsed = Date.parse(trade.exitTime || trade.updatedAt || trade.createdAt || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalWeek(ms) {
  const date = new Date(ms);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalMonth(ms) {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function summarizePaperKpis(trades = [], referenceTimeMs = Date.now()) {
  const closedTrades = closedPaperResultTrades(trades)
    .map((trade) => ({ trade, tradeCloseMs: tradeCloseMs(trade) }))
    .filter((row) => row.tradeCloseMs != null && row.tradeCloseMs <= referenceTimeMs);
  const closed = closedTrades.map((row) => row.trade);
  const summary = summarizeTrades(closed);
  const closedCount = summary.closedTrades;
  const hasClosedTrades = closedCount > 0;
  const sumPositive = (rows) => rows.reduce((total, trade) => {
    const pnl = numberOrNull(trade.netPnl);
    return total + (pnl != null && pnl > 0 ? pnl : 0);
  }, 0);
  const sumNegative = (rows) => rows.reduce((total, trade) => {
    const pnl = numberOrNull(trade.netPnl);
    return total + (pnl != null && pnl < 0 ? pnl : 0);
  }, 0);
  const summarizePeriod = (startMs) => {
    const periodTrades = closedTrades
      .filter((row) => row.tradeCloseMs >= startMs)
      .map((row) => row.trade);
    const periodSummary = summarizeTrades(periodTrades);
    if (!periodSummary.closedTrades) {
      return {
        result: null,
        wins: null,
        losses: null,
        winRate: null,
        closedTrades: 0,
      };
    }
    return {
      result: periodSummary.netPnl,
      wins: sumPositive(periodTrades),
      losses: sumNegative(periodTrades),
      winRate: periodSummary.winRate,
      closedTrades: periodSummary.closedTrades,
    };
  };
  return {
    totalResult: hasClosedTrades ? summary.netPnl : null,
    totalWins: hasClosedTrades ? sumPositive(closed) : null,
    totalLosses: hasClosedTrades ? sumNegative(closed) : null,
    totalWinRate: hasClosedTrades ? summary.winRate : null,
    closedTrades: summary.closedTrades,
    periods: {
      day: summarizePeriod(startOfLocalDay(referenceTimeMs)),
      week: summarizePeriod(startOfLocalWeek(referenceTimeMs)),
      month: summarizePeriod(startOfLocalMonth(referenceTimeMs)),
      total: {
        result: hasClosedTrades ? summary.netPnl : null,
        wins: hasClosedTrades ? sumPositive(closed) : null,
        losses: hasClosedTrades ? sumNegative(closed) : null,
        winRate: hasClosedTrades ? summary.winRate : null,
        closedTrades: summary.closedTrades,
      },
    },
  };
}

function paperMetricText(value, formatter) {
  return value == null ? 'Ingen data ännu' : formatter(value);
}

function PaperPerformanceKpis({ performance, currency }) {
  const totals = performance || {};
  const periods = totals.periods || {};
  return (
    <OverviewPanel
      data-paper-performance-kpis
      eyebrow="Resultat"
      title="Resultatöversikt"
      summary="Räknat ur samma stängda trades som affärsjournalen. Ingen post räknas två gånger."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s3)' }}>
        <MetricCard label="Totalt resultat sedan första paper-traden" value={paperMetricText(totals.totalResult, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(totals.totalResult)} />
        <MetricCard label="Totala vinster" value={paperMetricText(totals.totalWins, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(totals.totalWins)} />
        <MetricCard label="Totala förluster" value={paperMetricText(totals.totalLosses, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(totals.totalLosses)} />
        <MetricCard label="Win rate" value={paperMetricText(totals.totalWinRate, (value) => fmtPercent(value, 1))} tone={totals.totalWinRate == null ? 'neutral' : (totals.totalWinRate >= 50 ? 'success' : 'warning')} />
        <MetricCard label="Antal avslutade trades" value={paperMetricText(totals.closedTrades, (value) => fmtNumber(value))} tone={totals.closedTrades > 0 ? 'info' : 'neutral'} />
      </div>

      <div style={{ marginTop: 'var(--s4)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s3)' }}>
        <MetricCard label="Dagens resultat" value={paperMetricText(periods.day?.result, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(periods.day?.result)} />
        <MetricCard label="Veckans resultat" value={paperMetricText(periods.week?.result, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(periods.week?.result)} />
        <MetricCard label="Månadens resultat" value={paperMetricText(periods.month?.result, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(periods.month?.result)} />
        <MetricCard label="Totalt sedan start" value={paperMetricText(periods.total?.result, (value) => fmtMoney(value, currency, 2))} tone={moneyTone(periods.total?.result)} />
      </div>
    </OverviewPanel>
  );
}

function paperTradeStatusLabel(trade = {}) {
  return {
    open: 'Öppen',
    win: 'Vinst',
    loss: 'Förlust',
    breakeven: 'Plus minus noll',
    closed_unverified: 'Resultat saknas',
    cancelled: 'Avbruten',
    rejected: 'Stoppad',
  }[trade.status] || trade.statusLabel || EMPTY_VALUE;
}

function paperDirectionLabel(value) {
  if (value === 'LONG') return 'Lång';
  if (value === 'SHORT') return 'Kort';
  return value || EMPTY_VALUE;
}

function buildDeskStatus({ copy, waiting, degraded, executionConnected, openPositions, approvalCount, dailyResult }) {
  if (waiting) {
    return {
      label: copy.states.loading,
      tone: 'neutral',
      normal: copy.states.waiting,
      reason: 'Senaste paperläge hämtas från befintlig brokerstatus.',
      next: 'Vänta tills sidan har fått en ny snapshot.',
    };
  }
  if (degraded || executionConnected === false) {
    return {
      label: copy.states.problem,
      tone: 'danger',
      normal: copy.states.problem,
      reason: 'Brokerkopplingen eller avstämningen rapporterar ett problem.',
      next: 'Kontrollera brokerstatus längst ned.',
    };
  }
  if (approvalCount > 0) {
    return {
      label: copy.states.approval,
      tone: 'warning',
      normal: copy.states.waiting,
      reason: 'Minst en strategi väntar på manuell granskning.',
      next: 'Öppna godkännande och granska underlaget.',
    };
  }
  if (openPositions > 0) {
    return {
      label: copy.states.trading,
      tone: moneyTone(dailyResult) === 'danger' ? 'warning' : 'success',
      normal: copy.states.normal,
      reason: 'Det finns öppna paperpositioner som följs mot marknaden.',
      next: 'Följ positionerna och dagens resultat.',
    };
  }
  return {
    label: copy.states.noPositions,
    tone: 'neutral',
    normal: copy.states.normal,
    reason: 'Inga paperpositioner är öppna just nu.',
    next: 'AI väntar på nästa godkända möjlighet.',
  };
}

function buildDeskAction({ copy, degraded, runtimeError, executionError, approvals, tradeAttention }) {
  if (runtimeError || executionError || degraded) return { ...copy.actions.checkBroker, tone: 'warning', tab: 'teknik' };
  if (approvals > 0) return { ...copy.actions.approve, tone: 'warning', tab: 'godkannande' };
  if (tradeAttention > 0) return { ...copy.actions.checkResults, tone: 'danger', tab: 'trades' };
  return { ...copy.actions.noAction, tone: 'success', tab: 'oversikt' };
}

function PaperDeskDailyState({ copy, status, story, dailyResult, currency, openPositions, approvalCount, action }) {
  const text = copy.sections.daily;
  return (
    <section data-paper-daily-state style={sectionStyle({ marginBottom: PANEL_GAP, borderColor: 'rgba(199,154,75,0.34)' })}>
      <SectionHeader eyebrow={text.eyebrow} title={text.title} summary={story?.headline || text.summary} action={action} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--s3)' }}>
        <MetricCard label={text.status} value={status.label} tone={status.tone} />
        <MetricCard label={text.result} value={resultText(dailyResult, currency, copy)} tone={moneyTone(dailyResult)} />
        <MetricCard label={text.positions} value={fmtNumber(openPositions)} tone={openPositions ? 'info' : 'neutral'} />
        <MetricCard label={text.normality} value={status.normal} tone={status.normal === copy.states.problem ? 'danger' : status.normal === copy.states.waiting ? 'warning' : 'success'} />
      </div>
      <div style={{ marginTop: 'var(--s4)' }}>
        <FieldGrid
          items={[
            { label: text.why, value: story?.why || status.reason },
            { label: text.next, value: approvalCount ? `${approvalCount} väntar på granskning.` : (story?.next || status.next) },
          ]}
        />
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, margin: 'var(--s4) 0 0' }}>
        {copy.safetyCopy}
      </p>
    </section>
  );
}

function PaperOpenPositionsPreview({ copy, rows, currency, onOpen }) {
  const text = copy.sections.positions;
  const visible = rows.slice(0, 4);
  return (
    <section data-paper-open-positions style={sectionStyle({ marginBottom: PANEL_GAP })}>
      <SectionHeader
        eyebrow={text.eyebrow}
        title={text.title}
        summary={text.summary}
        action={<button type="button" className="btn ghost" onClick={onOpen}>{text.open}</button>}
      />
      {visible.length ? (
        <div style={{ display: 'grid', gap: 'var(--s2)' }}>
          {visible.map((row) => (
            <div key={row.key} className="m-row">
              <span className="m-row-body">
                <span className="m-h3" style={{ display: 'block' }}>{row.symbol || EMPTY_VALUE}</span>
                <p>{row.strategyName || EMPTY_VALUE} · {paperDirectionLabel(row.direction)} · {fmtNumber(row.quantity)}</p>
              </span>
              <span style={{ color: moneyTone(row.pnl) === 'danger' ? 'var(--danger)' : moneyTone(row.pnl) === 'success' ? 'var(--success)' : 'var(--text)', fontFamily: 'var(--data)' }}>
                {fmtMoney(row.pnl, currency, 2)}
              </span>
              <Pill tone={row.statusTone} compact>{row.statusLabel}</Pill>
            </div>
          ))}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{text.noRows}</div>
          <div className="m-empty-body">{copy.states.waiting}</div>
        </div>
      )}
    </section>
  );
}

function PaperRecentTradesPreview({ copy, rows, currency, onOpen }) {
  const text = copy.sections.recentTrades;
  return (
    <section data-paper-recent-trades style={sectionStyle({ marginBottom: PANEL_GAP })}>
      <SectionHeader
        eyebrow={text.eyebrow}
        title={text.title}
        summary={text.summary}
        action={<button type="button" className="btn ghost" onClick={onOpen}>{text.open}</button>}
      />
      {rows.length ? (
        <div style={{ display: 'grid', gap: 'var(--s2)' }}>
          {rows.map((trade) => (
            <div key={trade.key} className="m-row">
              <span className="m-row-time">{fmtTime(trade.exitTime || trade.updatedAt || trade.createdAt)}</span>
              <span className="m-row-body">
                <span className="m-h3" style={{ display: 'block' }}>{trade.symbol || EMPTY_VALUE}</span>
                <p>{trade.strategyName || EMPTY_VALUE} · {paperDirectionLabel(trade.direction)}</p>
              </span>
              <span style={{ color: moneyTone(trade.netPnl) === 'danger' ? 'var(--danger)' : moneyTone(trade.netPnl) === 'success' ? 'var(--success)' : 'var(--text)', fontFamily: 'var(--data)' }}>
                {fmtMoney(trade.netPnl, currency, 2)}
              </span>
              <Pill tone={trade.statusTone} compact>{paperTradeStatusLabel(trade)}</Pill>
            </div>
          ))}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{text.noRows}</div>
          <div className="m-empty-body">{copy.states.noClosedTrades}</div>
        </div>
      )}
    </section>
  );
}

function PaperNeedsYou({ copy, task, story, onOpen }) {
  const text = copy.sections.needsYou;
  return (
    <section data-paper-needs-you style={sectionStyle({ marginBottom: PANEL_GAP, borderColor: task.tone === 'success' ? 'rgba(34,197,94,0.30)' : 'rgba(199,154,75,0.40)' })}>
      <SectionHeader eyebrow={text.eyebrow} title={task.title} summary={story?.headline || text.summary} />
      <FieldGrid
        items={[
          { label: text.priority, value: task.priority, tone: task.tone },
          { label: text.why, value: story?.why || task.why },
          { label: 'Uppgift', value: task.explanation },
        ]}
      />
      <div style={{ marginTop: 'var(--s4)' }}>
        <button type="button" className={task.tone === 'success' ? 'btn ghost' : 'btn'} onClick={onOpen}>
          {task.button}
        </button>
      </div>
    </section>
  );
}

function PaperBrokerStatus({ copy, items }) {
  const text = copy.sections.broker;
  return (
    <section data-paper-broker-status style={sectionStyle({ marginBottom: PANEL_GAP })}>
      <SectionHeader eyebrow={text.eyebrow} title={text.title} summary={text.summary} />
      <FieldGrid items={items} />
    </section>
  );
}

function paperStrategyName(strategy) {
  return strategyDisplayName(strategy, EMPTY_VALUE);
}

function paperStrategyMarket(strategy) {
  return paperSafeText(
    strategy.performance?.bestMarket
    || strategy.marketRegime
    || strategy.metadata?.market
    || strategy.signal
    || strategy.strategyFamily,
  );
}

function paperStrategyResult(strategy, currency) {
  const perf = strategy?.performance || {};
  const parts = [];
  if (hasValue(perf.netPnl)) parts.push(fmtMoney(perf.netPnl, currency, 2));
  else if (hasValue(perf.score)) parts.push(`Betyg ${fmtNumber(perf.score)}`);
  else if (hasValue(perf.winRate)) parts.push(`Vinst ${fmtPercent(perf.winRate, 1)}`);
  if (hasValue(perf.winRate) && !parts.some((part) => part.includes('Vinst'))) parts.push(`Vinst ${fmtPercent(perf.winRate, 1)}`);
  if (hasValue(perf.bestSymbol)) parts.push(`Bäst i ${paperSafeText(perf.bestSymbol)}`);
  return parts.length ? parts.join(' · ') : 'Inga resultat ännu.';
}

function paperStrategyNextStep(strategy) {
  const runtime = String(strategy?.runtimeState || '').trim().toLowerCase();
  const approval = String(strategy?.approvalState || '').trim().toLowerCase();
  const lifecycle = String(strategy?.lifecycle || strategy?.status || '').trim().toLowerCase();
  const score = numberOrNull(strategy?.performance?.score ?? strategy?.strategyScore ?? strategy?.score);

  if (strategy?.retired === true || lifecycle === 'retired' || runtime.includes('retired')) return 'Läs arkivet';
  if (strategy?.blocked === true || runtime.includes('blocked')) return 'Granska resultat';
  if (strategy?.currentCandidate === true || approval === 'approved' || lifecycle === 'candidate' || lifecycle === 'paper') return 'Öppna godkännande';
  if (runtime.includes('running') || runtime.includes('testing') || runtime.includes('active')) return 'Vänta på fler tester';
  if (runtime.includes('waiting') || runtime.includes('pending')) return 'Vänta på mer data';
  if (score !== null && score >= 65) return 'Följ resultatet';
  if (score !== null && score < 45) return 'Behöver förbättras';
  return 'Öppna strategi';
}

function paperStrategyTone(strategy) {
  const runtime = String(strategy?.runtimeState || '').trim().toLowerCase();
  const approval = String(strategy?.approvalState || '').trim().toLowerCase();
  const lifecycle = String(strategy?.lifecycle || strategy?.status || '').trim().toLowerCase();
  const score = numberOrNull(strategy?.performance?.score ?? strategy?.strategyScore ?? strategy?.score);

  if (strategy?.retired === true || lifecycle === 'retired' || runtime.includes('retired')) return { label: 'Pausad', tone: 'warning' };
  if (strategy?.blocked === true || runtime.includes('blocked')) return { label: 'Behöver uppmärksamhet', tone: 'warning' };
  if (strategy?.currentCandidate === true || approval === 'approved' || lifecycle === 'candidate' || lifecycle === 'paper') return { label: 'Redo för Paper', tone: 'info' };
  if (runtime.includes('running') || runtime.includes('testing') || runtime.includes('active')) return { label: 'Testas', tone: 'neutral' };
  if (runtime.includes('waiting') || runtime.includes('pending')) return { label: 'Väntar', tone: 'warning' };
  if (score !== null && score >= 65) return { label: 'Redo', tone: 'success' };
  return { label: 'Väntar', tone: 'neutral' };
}

function paperStrategyMeta(strategy, currency) {
  return {
    ...paperStrategyTone(strategy),
    result: paperStrategyResult(strategy, currency),
    market: paperStrategyMarket(strategy),
    next: paperStrategyNextStep(strategy),
  };
}

function strategyLinks(strategyId) {
  return contextHref('strategy', { strategyId });
}

function buildPaperStrategySections(strategies = [], currency = 'USD') {
  const enriched = strategies
    .map((strategy, index) => ({
      strategy,
      strategyId: strategy.strategyId || strategy.id || `strategy-${index}`,
      name: paperStrategyName(strategy),
      meta: paperStrategyMeta(strategy, currency),
      score: numberOrNull(strategy.performance?.score ?? strategy.strategyScore ?? strategy.score),
      winRate: numberOrNull(strategy.performance?.winRate),
      netPnl: numberOrNull(strategy.performance?.netPnl),
      confidence: numberOrNull(strategy.confidenceScore ?? strategy.performance?.confidence),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const bestToday = [...enriched]
    .filter((row) => row.netPnl != null || row.score != null || row.winRate != null)
    .sort((a, b) => (b.netPnl ?? -Infinity) - (a.netPnl ?? -Infinity) || (b.score ?? -Infinity) - (a.score ?? -Infinity) || (b.winRate ?? -Infinity) - (a.winRate ?? -Infinity))
    .slice(0, 4);
  const testingNow = [...enriched]
    .filter((row) => {
      const runtime = String(row.strategy.runtimeState || '').toLowerCase();
      return runtime.includes('running') || runtime.includes('testing') || runtime.includes('active');
    })
    .slice(0, 4);
  const readyForPaper = [...enriched]
    .filter((row) => {
      const lifecycle = String(row.strategy.lifecycle || row.strategy.status || '').toLowerCase();
      const runtime = String(row.strategy.runtimeState || '').toLowerCase();
      const approval = String(row.strategy.approvalState || '').toLowerCase();
      return row.strategy.currentCandidate === true || approval === 'approved' || lifecycle === 'candidate' || lifecycle === 'paper' || runtime.includes('ready');
    })
    .slice(0, 4);
  const needsAttention = [...enriched]
    .filter((row) => row.strategy.blocked === true || String(row.strategy.runtimeState || '').toLowerCase().includes('blocked') || (row.score != null && row.score < 45))
    .slice(0, 4);

  const byNetPnl = [...enriched]
    .filter((row) => row.netPnl != null)
    .sort((a, b) => b.netPnl - a.netPnl || String(a.name).localeCompare(String(b.name)))
    .slice(0, 3);
  const byWinRate = [...enriched]
    .filter((row) => row.winRate != null)
    .sort((a, b) => b.winRate - a.winRate || (b.score ?? -1) - (a.score ?? -1) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 3);
  const byScore = [...enriched]
    .filter((row) => row.score != null || row.confidence != null)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.confidence ?? -1) - (a.confidence ?? -1) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 3);
  const promising = [...enriched]
    .sort((a, b) => (
      (b.score ?? -1) - (a.score ?? -1)
      || (b.confidence ?? -1) - (a.confidence ?? -1)
      || (b.winRate ?? -1) - (a.winRate ?? -1)
      || (b.netPnl ?? -Infinity) - (a.netPnl ?? -Infinity)
      || String(a.name).localeCompare(String(b.name))
    ))
    .slice(0, 3);

  return {
    spotlight: [
      {
        key: 'bestToday',
        title: PAPER_DESK_COPY.sections.strategies.categories.bestToday.title,
        empty: PAPER_DESK_COPY.sections.strategies.categories.bestToday.empty,
        rows: bestToday,
      },
      {
        key: 'testingNow',
        title: PAPER_DESK_COPY.sections.strategies.categories.testingNow.title,
        empty: PAPER_DESK_COPY.sections.strategies.categories.testingNow.empty,
        rows: testingNow,
      },
      {
        key: 'readyForPaper',
        title: PAPER_DESK_COPY.sections.strategies.categories.readyForPaper.title,
        empty: PAPER_DESK_COPY.sections.strategies.categories.readyForPaper.empty,
        rows: readyForPaper,
      },
      {
        key: 'needsAttention',
        title: PAPER_DESK_COPY.sections.strategies.categories.needsAttention.title,
        empty: PAPER_DESK_COPY.sections.strategies.categories.needsAttention.empty,
        rows: needsAttention,
      },
    ],
    leaderboards: [
      {
        key: 'bestResult',
        title: PAPER_DESK_COPY.sections.leaderboards.bestResult,
        empty: PAPER_DESK_COPY.sections.leaderboards.empty,
        metric: (row) => (row.netPnl != null ? fmtMoney(row.netPnl, currency, 2) : (row.score != null ? `Betyg ${fmtNumber(row.score)}` : '—')),
        rows: byNetPnl,
      },
      {
        key: 'highestWinRate',
        title: PAPER_DESK_COPY.sections.leaderboards.highestWinRate,
        empty: PAPER_DESK_COPY.sections.leaderboards.empty,
        metric: (row) => (row.winRate != null ? fmtPercent(row.winRate, 1) : '—'),
        rows: byWinRate,
      },
      {
        key: 'biggestImprovement',
        title: PAPER_DESK_COPY.sections.leaderboards.biggestImprovement,
        empty: PAPER_DESK_COPY.sections.leaderboards.empty,
        metric: (row) => (row.score != null ? `Betyg ${fmtNumber(row.score)}` : (row.confidence != null ? `Konfidens ${fmtNumber(row.confidence)}` : '—')),
        rows: byScore,
      },
      {
        key: 'mostPromising',
        title: PAPER_DESK_COPY.sections.leaderboards.mostPromising,
        empty: PAPER_DESK_COPY.sections.leaderboards.empty,
        metric: (row) => {
          if (row.score != null && row.winRate != null) return `Betyg ${fmtNumber(row.score)} · ${fmtPercent(row.winRate, 1)}`;
          if (row.score != null) return `Betyg ${fmtNumber(row.score)}`;
          if (row.winRate != null) return `Vinst ${fmtPercent(row.winRate, 1)}`;
          return row.netPnl != null ? fmtMoney(row.netPnl, currency, 2) : '—';
        },
        rows: promising,
      },
    ],
  };
}

function PaperStrategyRow({ strategy }) {
  const href = strategyLinks(strategy.strategyId);
  const meta = strategy.meta;
  return (
    <Link
      to={href}
      className="m-row"
      style={{ textDecoration: 'none', color: 'inherit' }}
      data-paper-strategy-id={strategy.strategyId}
    >
      <span className="m-row-body">
        <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{strategy.name}</span>
        <p style={{ overflowWrap: 'anywhere' }}>
          {meta.result}
          {meta.market ? ` · ${meta.market}` : ''}
        </p>
        <span className="m-eyebrow" style={{ display: 'block', marginTop: 'var(--s2)' }}>
          Nästa steg: {meta.next}
        </span>
      </span>
      <StatusBadge tone={meta.tone} compact>{meta.label}</StatusBadge>
    </Link>
  );
}

function PaperStrategyGroupPanel({ group }) {
  return (
    <OverviewPanel
      data-paper-strategy-spotlight={group.key}
      eyebrow={PAPER_DESK_COPY.sections.strategies.eyebrow}
      title={group.title}
      summary={PAPER_DESK_COPY.sections.strategies.summary}
      action={<Link to="/factory/library" className="btn ghost" style={{ textDecoration: 'none' }}>{PAPER_DESK_COPY.sections.strategies.labels.openStrategy}</Link>}
    >
      {group.rows.length ? (
        <div style={{ display: 'grid', gap: 'var(--s2)' }}>
          {group.rows.map((strategy) => <PaperStrategyRow key={strategy.strategyId} strategy={strategy} />)}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{group.empty}</div>
          <div className="m-empty-body">{group.title}</div>
        </div>
      )}
    </OverviewPanel>
  );
}

function PaperLeaderboardPanel({ board }) {
  return (
    <OverviewPanel
      data-paper-leaderboard={board.key}
      eyebrow={PAPER_DESK_COPY.sections.leaderboards.eyebrow}
      title={board.title}
      summary={PAPER_DESK_COPY.sections.leaderboards.summary}
      action={<Link to="/factory/library" className="btn ghost" style={{ textDecoration: 'none' }}>{PAPER_DESK_COPY.sections.strategies.labels.openStrategy}</Link>}
    >
      {board.rows.length ? (
        <div style={{ display: 'grid', gap: 'var(--s2)' }}>
          {board.rows.map((strategy, index) => (
            <Link
              key={strategy.strategyId}
              to={strategyLinks(strategy.strategyId)}
              className="m-row"
              style={{ textDecoration: 'none', color: 'inherit' }}
              data-paper-leaderboard-id={`${board.key}-${strategy.strategyId}`}
            >
              <span className="m-row-body">
                <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{index + 1}. {strategy.name}</span>
                <p style={{ overflowWrap: 'anywhere' }}>{board.metric(strategy)}</p>
              </span>
              <StatusBadge tone={strategy.meta.tone} compact>{strategy.meta.label}</StatusBadge>
            </Link>
          ))}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{board.empty}</div>
          <div className="m-empty-body">{board.title}</div>
        </div>
      )}
    </OverviewPanel>
  );
}

export default function FuturesPaperDeskPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTabId(searchParams.get('tab'));
  const paperCopy = PAPER_DESK_COPY;
  const runtimeDiagnostic = uiCopy('futuresRuntimeDiagnostic');
  const handleTabChange = useCallback((tabId) => {
    const nextTab = normalizeTabId(tabId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextTab === DEFAULT_TAB) {
        next.delete('tab');
      } else {
        next.set('tab', nextTab);
      }
      return next;
    });
  }, [setSearchParams]);
  const [refreshToken, setRefreshToken] = useState(0);
  const runtime = useJson('/api/futures-paper/runtime', refreshToken);
  const execution = useJson('/api/futures-paper/ibkr-paper-execution/status?connect=false', refreshToken);

  const data = runtime.data || {};
  const executionData = execution.data || {};
  const hasRuntimeSnapshot = Boolean(runtime.data);
  const hasExecutionSnapshot = Boolean(execution.data);
  const waitingForRuntime = runtime.loading && !runtime.data;
  const waitingForExecution = execution.loading && !execution.data;
  const account = data.account || {};
  const portfolio = data.portfolio || data.portfolioSummary || {};
  const analytics = data.analytics || data.strategyAnalytics || data.performance || {};
  const currency = account.currency || executionData.account?.currency || 'USD';
  const hasBrokerPositionSnapshot = Array.isArray(data.brokerPositions);
  const hasBrokerOrderSnapshot = Array.isArray(data.brokerOrders);
  const hasBrokerFillSnapshot = Array.isArray(data.brokerFills) || Array.isArray(data.brokerExecutions);
  const brokerPositions = Array.isArray(data.brokerPositions) ? data.brokerPositions : [];
  const brokerOrders = Array.isArray(data.brokerOrders) ? data.brokerOrders : [];
  const brokerFills = Array.isArray(data.brokerFills) && data.brokerFills.length
    ? data.brokerFills
    : (Array.isArray(data.brokerExecutions) ? data.brokerExecutions : []);
  const brokerCommissions = Array.isArray(data.brokerCommissions) ? data.brokerCommissions : [];
  const reconciliation = data.brokerReconciliation || executionData.reconciliation || {};
  const brokerOrderStatuses = Array.isArray(data.brokerOrderStatuses)
    ? data.brokerOrderStatuses
    : (Array.isArray(executionData.brokerOrderStatuses)
      ? executionData.brokerOrderStatuses
      : (Array.isArray(reconciliation.orderStatuses) ? reconciliation.orderStatuses : []));
  const brokerOrderIntents = Array.isArray(reconciliation.intents) ? reconciliation.intents : [];
  const orderLifecycleRows = useMemo(
    () => mergeOrderLifecycleRows(brokerOrders, brokerOrderIntents),
    [brokerOrders, brokerOrderIntents],
  );
  const hasBrokerOrderStatusSnapshot = Array.isArray(data.brokerOrderStatuses)
    || Array.isArray(executionData.brokerOrderStatuses)
    || Array.isArray(reconciliation.orderStatuses);
  const hasOrderLifecycleSnapshot = hasBrokerOrderSnapshot || Array.isArray(reconciliation.intents);
  const legacy = data.legacyInternalSimulation || {};
  const scanner = data.scanner || {};
  const candidateQueue = data.candidateQueue || {};
  const queueCandidates = Array.isArray(candidateQueue.candidates) ? candidateQueue.candidates : [];
  const scanHistory = Array.isArray(data.scanHistory) ? data.scanHistory : [];

  // FAS 9: Use canonical data models (not legacy fallbacks)
  const canonical = data.canonical || {};
  const canonicalBrokerHealth = data.brokerHealth || {};
  const canonicalMarketWatch = data.marketWatch || {};
  const canonicalRankings = data.rankings || {};
  const canonicalAiSummary = data.aiSummaryContext || {};
  const strategyOverview = Array.isArray(data.strategyOverview) ? data.strategyOverview : [];
  const strategyStatus = Array.isArray(data.strategyStatus) ? data.strategyStatus : [];
  const strategyPulse = Array.isArray(data.strategyPulse) ? data.strategyPulse : [];
  const statusReasons = Array.isArray(data.statusReasons) ? data.statusReasons : [];
  const flags = executionData.flags || {};
  const safety = executionData.safety || {};
  const executionClient = executionData.executionClient || {};
  const market = data.market || {};
  const ibDataLayer = data.ibDataLayer || {};
  const ibAccount = data.ibAccount || {};
  const dataPipeline = data.dataPipeline || {};
  const dataFeed = data.dataFeed || {};
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
  const instruments = Array.isArray(data.instruments) ? data.instruments : [];
  const strategyOverviewMeta = data.strategyOverviewMeta || {};
  const strategyOverviewCounts = strategyOverviewMeta.counts || {};
  const strategyStatusMeta = data.strategyStatusMeta || {};
  const nextSessionTransition = data.nextSessionTransition || {};
  const reconciliationCounts = reconciliation.counts || {};
  const executionRuntimeState = executionData.executionRuntimeState || executionData.runtimeState || executionClient.connectionState || executionClient.state || null;
  const executionConnected = executionData.executionConnected ?? executionClient.connected ?? executionClient.ready ?? null;
  const nextValidIdReady = executionData.nextValidIdReady ?? executionClient.nextValidIdReady ?? null;
  const marketDataConnected = ibDataLayer.connected ?? dataFeed.connected ?? null;
  const executionTarget = data.executionTarget
    || data.desk?.executionTarget
    || data.executionTargetModel?.onlyActiveExecutionTarget
    || data.executionTargetModel?.executionTarget
    || scanner.executionTarget
    || scanner.executionTargetModel?.onlyActiveExecutionTarget
    || scanner.lastScanSummary?.executionTarget
    || queueCandidates.find((row) => hasValue(row?.executionTarget))?.executionTarget
    || scanHistory.find((row) => hasValue(row?.executionTarget))?.executionTarget
    || null;
  const executionTargetText = paperSafeText(executionTarget);
  const isLiveExecution = executionTarget === 'ibkr_live';
  const executionModeText = isLiveExecution ? 'Live' : (executionTarget === 'ibkr_paper' ? 'Paper' : executionTargetText);
  const executionModeLabel = isLiveExecution ? 'IBKR Live' : 'IBKR Paper';
  const accountSourceText = paperSafeText(account.source || executionData.account?.source || data.technical?.accountSource);
  const brokerMirrorSourceText = paperSafeText(reconciliation.source || executionData.reconciliation?.source || data.technical?.activePositionSource || data.technical?.activeTradeSource || account.source);
  const accountHint = paperSafeText(
    account.accountIdMasked
    || executionData.account?.accountIdMasked
    || account.unavailableReason
    || snapshotHint({ waiting: waitingForRuntime }),
  );
  const reconciliationStatus = paperSafeText(reconciliation.status);

  const dailyBrokerPnl = account.dailyPnl ?? null;
  const degraded = account.degraded === true || reconciliation.degraded === true;

  const strategyStore = useMemo(() => createStrategyStore({
    runtimeSnapshot: data,
    executionSnapshot: executionData,
    strategyOverview,
    strategyStatus,
    strategyPulse,
    candidateQueue,
    reconciliation,
  }), [candidateQueue, data, executionData, reconciliation, strategyOverview, strategyPulse, strategyStatus]);

  const tradingEventStore = useMemo(() => createTradingEventStore({
    runtimeSnapshot: data,
    executionSnapshot: executionData,
    strategyOverview,
    strategyStatus,
    strategyPulse,
    candidateQueue,
    reconciliation,
    analyticsSnapshot: analytics,
    strategyStore,
  }), [analytics, candidateQueue, data, executionData, reconciliation, strategyOverview, strategyPulse, strategyStatus, strategyStore]);
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    runtimeSnapshot: data,
    executionSnapshot: executionData,
    analyticsSnapshot: analytics,
  }), [analytics, data, executionData, tradingEventStore]);
  const allStrategies = useMemo(() => strategyStore.getAllStrategies(), [strategyStore]);
  const paperStrategySections = useMemo(
    () => buildPaperStrategySections(allStrategies, currency),
    [allStrategies, currency],
  );
  const primaryStrategyId = useMemo(() => (
    queueCandidates.find((candidate) => candidate?.strategyId || candidate?.strategy?.id)
    || allStrategies[0]
    || null
  ), [allStrategies, queueCandidates]);
  const tabs = useMemo(() => VISIBLE_TABS.map((tab) => {
    if (tab.id === 'konto') return { ...tab, label: `IBKR ${executionModeText}-konto` };
    if (tab.id === 'ibkr') return { ...tab, label: `IBKR ${executionModeText} orderstatus` };
    return tab;
  }), [executionModeText]);

  // En rad = en trade. Grupperingen använder befintlig identitetskedja
  // (signalId → candidateId → intentId → executionId → tradeId → brokerOrderIds)
  // och skapar ingen ny datamodell och ingen ny persistence.
  const tradeJournal = useMemo(() => buildTradeJournal({
    intents: brokerOrderIntents,
    brokerOrders,
    brokerFills,
    brokerOrderStatuses,
    brokerPositions,
    resolveStrategy: (source) => strategyStore.resolveStrategy(source),
  }), [brokerFills, brokerOrderIntents, brokerOrderStatuses, brokerOrders, brokerPositions, strategyStore]);

  // Live Scanner: en rad per (strategi × marknad). Härleds ur samma runtime-
  // snapshot som resten av sidan — ingen egen hämtning, inget nytt API.
  const scannerRows = useMemo(() => buildScannerRows({
    strategyOverview,
    candidates: queueCandidates,
    brokerPositions,
    scanner,
    scanHistory,
    quotes,
    resolveStrategy: (source) => strategyStore.resolveStrategy(source),
  }), [brokerPositions, quotes, queueCandidates, scanHistory, scanner, strategyOverview, strategyStore]);

  const scannerSummary = useMemo(
    () => summarizeScanner(scannerRows, { scanner, candidates: queueCandidates, scanHistory }),
    [queueCandidates, scanHistory, scanner, scannerRows],
  );

  const [focusExecutionId, setFocusExecutionId] = useState(null);
  const selectTrade = useCallback((executionId) => {
    if (!executionId) return;
    setFocusExecutionId(executionId);
    handleTabChange('trades');
  }, [handleTabChange]);

  // Live Trading Desk: en rad = en öppen position. Raden byggs ur broker mirror
  // och den öppna traden i journalen, och allt live räknas ur den quote som
  // runtime-snapshoten redan levererar — ingen ny hämtning, inget nytt API.
  const positionDeskRows = useMemo(() => buildPositionDeskRows({
    brokerPositions,
    trades: tradeJournal.trades,
    quotes,
    instruments,
    resolveStrategy: (source) => strategyStore.resolveStrategy(source),
    now: Date.now(),
  }), [brokerPositions, instruments, quotes, strategyStore, tradeJournal.trades]);

  const positionDeskSummary = useMemo(
    () => summarizePositionDesk(positionDeskRows, { trades: tradeJournal.trades, now: Date.now() }),
    [positionDeskRows, tradeJournal.trades],
  );
  const tradeSummary = useMemo(() => summarizeTrades(tradeJournal.trades), [tradeJournal.trades]);
  const performanceReferenceMs = useMemo(() => {
    const raw = runtime.generatedAt || executionData.generatedAt || data.generatedAt || null;
    const parsed = Date.parse(raw || '');
    return Number.isFinite(parsed) ? parsed : Date.now();
  }, [data.generatedAt, executionData.generatedAt, runtime.generatedAt]);
  const paperPerformance = useMemo(
    () => summarizePaperKpis(tradeJournal.trades, performanceReferenceMs),
    [performanceReferenceMs, tradeJournal.trades],
  );
  const dailyDeskResult = numberOrNull(positionDeskSummary.netToday) ?? numberOrNull(dailyBrokerPnl);
  const recentClosedTrades = useMemo(() => latestClosedTrades(tradeJournal.trades), [tradeJournal.trades]);
  const deskStory = useMemo(() => aiStoryPaperStatus({
    strategyId: primaryStrategyId?.strategyId || primaryStrategyId?.strategy?.id || primaryStrategyId?.id || null,
    result: dailyDeskResult,
    waiting: (waitingForRuntime || waitingForExecution) && !hasRuntimeSnapshot && !hasExecutionSnapshot,
    degraded,
    approvalCount: queueCandidates.length,
    reason: reconciliation.blockedReason || runtime.error || execution.error || account.unavailableReason || reconciliationStatus,
  }), [
    account.unavailableReason,
    dailyDeskResult,
    degraded,
    execution.error,
    hasExecutionSnapshot,
    hasRuntimeSnapshot,
    primaryStrategyId,
    queueCandidates.length,
    reconciliation.blockedReason,
    reconciliationStatus,
    runtime.error,
    waitingForExecution,
    waitingForRuntime,
  ]);
  const deskStatus = useMemo(() => buildDeskStatus({
    copy: paperCopy,
    waiting: (waitingForRuntime || waitingForExecution) && !hasRuntimeSnapshot && !hasExecutionSnapshot,
    degraded,
    executionConnected,
    openPositions: positionDeskRows.length,
    approvalCount: queueCandidates.length,
    dailyResult: dailyDeskResult,
  }), [
    dailyDeskResult,
    degraded,
    executionConnected,
    hasExecutionSnapshot,
    hasRuntimeSnapshot,
    paperCopy,
    positionDeskRows.length,
    queueCandidates.length,
    waitingForExecution,
    waitingForRuntime,
  ]);
  const deskAction = useMemo(() => buildDeskAction({
    copy: paperCopy,
    degraded,
    runtimeError: runtime.error,
    executionError: execution.error,
    approvals: queueCandidates.length,
    tradeAttention: tradeSummary.attention.total,
  }), [degraded, execution.error, paperCopy, queueCandidates.length, runtime.error, tradeSummary.attention.total]);
  const brokerStatusItems = useMemo(() => {
    const brokerConnection = brokerStateLabel(paperCopy, executionConnected, waitingForExecution && !hasExecutionSnapshot);
    const marketConnection = brokerStateLabel(paperCopy, marketDataConnected, waitingForRuntime && !hasRuntimeSnapshot);

    // FAS 7: Use canonical broker health, not mixed flags
    const orderState = canonicalBrokerHealth.state === 'ready'
      ? { value: 'Allt normalt', tone: 'success' }
      : canonicalBrokerHealth.state === 'degraded'
        ? { value: 'Behöver uppmärksamhet', tone: 'warning' }
        : { value: canonicalBrokerHealth.reason || 'Problem', tone: 'danger' };

    const checkState = degraded
      ? { value: paperCopy.brokerStates.problem, tone: 'danger' }
      : hasValue(reconciliation.status)
        ? { value: paperCopy.states.normal, tone: 'success' }
        : { value: paperCopy.brokerStates.waiting, tone: 'neutral' };
    return [
      { label: paperCopy.sections.broker.connection, value: brokerConnection.value, tone: brokerConnection.tone },
      { label: paperCopy.sections.broker.data, value: marketConnection.value, tone: marketConnection.tone },
      { label: paperCopy.sections.broker.orders, value: orderState.value, tone: orderState.tone },
      { label: paperCopy.sections.broker.check, value: checkState.value, tone: checkState.tone, hint: degraded ? 'Kontroll behövs' : null },
    ];
  }, [
    canonicalBrokerHealth,
    degraded,
    executionConnected,
    flags.submissionEnabled,
    hasExecutionSnapshot,
    hasRuntimeSnapshot,
    marketDataConnected,
    paperCopy,
    reconciliation.status,
    waitingForExecution,
    waitingForRuntime,
  ]);

  // KPI-raden ligger ovanför varje flik, alltså även i standardvyn. Den ska svara
  // på "kan jag handla och hur mycket", inte rapportera rå driftstatus.
  // Ordermiljö är ett routingvärde som står still dygnet runt; det visas i
  // Teknisk info och på affären. Brokeravstämning visas bara
  // när den är degraderad, för då är den ett faktiskt varningstecken.
  // Positioner har egna KPI:er (öppet, orealiserat, dagens resultat). Konto- och
  // brokerkorten skulle bara konkurrera med dem om blicken - de bor på Översikt
  // och IBKR Paper-konto och visas därför inte ovanför trading desken.
  const kpis = useMemo(() => (activeTab === 'positioner' ? [] : [
    ...(hasValue(executionTarget) ? [] : [
      { label: 'Aktiv handelsmiljö', value: executionTargetText, tone: 'warning' },
    ]),
    {
      label: 'Kontovärde',
      value: moneyOrWaiting(account.netLiquidation, currency, waitingForRuntime),
      hint: accountHint,
      tone: account.netLiquidation == null ? 'warning' : 'blue',
    },
    {
      label: 'Tillgängligt',
      value: moneyOrWaiting(account.availableFunds, currency, waitingForRuntime),
      hint: accountSourceText,
      tone: account.availableFunds == null ? 'warning' : 'blue',
    },
    {
      label: 'Köpkraft',
      value: moneyOrWaiting(account.buyingPower, currency, waitingForRuntime),
      hint: accountSourceText,
      tone: account.buyingPower == null ? 'warning' : 'blue',
    },
    {
      label: 'Öppna positioner',
      value: countOrEmpty(brokerPositions.length, hasBrokerPositionSnapshot),
      hint: snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText }),
      tone: hasBrokerPositionSnapshot && brokerPositions.length ? 'blue' : 'good',
    },
    ...(degraded ? [{
      label: 'Avstämning',
      value: reconciliationStatus,
      hint: paperSafeText(reconciliation.blockedReason, '') || snapshotHint({ waiting: waitingForRuntime || waitingForExecution, fallback: 'Brokeravstämning' }),
      tone: 'warning',
    }] : []),
  ]), [
    activeTab,
    account.availableFunds,
    account.buyingPower,
    account.netLiquidation,
    accountHint,
    accountSourceText,
    brokerMirrorSourceText,
    brokerPositions.length,
    currency,
    degraded,
    executionTarget,
    executionTargetText,
    hasBrokerPositionSnapshot,
    reconciliation.blockedReason,
    reconciliationStatus,
    waitingForExecution,
    waitingForRuntime,
  ]);

  const refreshButton = (
    <button type="button" className="btn" onClick={() => setRefreshToken((value) => value + 1)}>Uppdatera</button>
  );

  return (
    <DashboardShell
      title={paperCopy.title}
      subtitle={paperCopy.subtitle}
      safety={data}
      tabs={tabs}
      activeTab={activeTab}
      onTab={handleTabChange}
      kpis={kpis}
    >
      {runtime.error && activeTab !== DEFAULT_TAB ? (
        <section style={{ ...sectionStyle({ marginBottom: PANEL_GAP, borderColor: 'rgba(239,68,68,0.35)' }) }}>
          <strong style={{ color: 'var(--danger)' }}>Paperläget kunde inte läsas</strong>
          <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13 }}>{paperSafeText(runtime.error)}</div>
        </section>
      ) : null}

      {activeTab === 'trades' && (
        <div style={{ marginTop: PANEL_GAP }}>
          <TradeJournal
            trades={tradeJournal.trades}
            totalTrades={tradeJournal.totalTrades}
            truncated={tradeJournal.truncated}
            currency={currency || 'USD'}
            waiting={waitingForRuntime && !hasOrderLifecycleSnapshot}
            focusExecutionId={focusExecutionId}
            onFocusHandled={() => setFocusExecutionId(null)}
            action={refreshButton}
          />
        </div>
      )}

      {activeTab === 'oversikt' && (
        <>
          <PaperPerformanceKpis performance={paperPerformance} currency={currency} />

          <PaperDeskDailyState
            copy={paperCopy}
            status={deskStatus}
            story={deskStory}
            dailyResult={dailyDeskResult}
            currency={currency}
            openPositions={positionDeskRows.length}
            approvalCount={queueCandidates.length}
            action={refreshButton}
          />

          <PaperNeedsYou
            copy={paperCopy}
            task={deskAction}
            story={deskStory}
            onOpen={() => handleTabChange(deskAction.tab)}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: PANEL_GAP, marginBottom: PANEL_GAP }}>
            {paperStrategySections.spotlight.map((group) => (
              <PaperStrategyGroupPanel key={group.key} group={group} />
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: PANEL_GAP, marginBottom: PANEL_GAP }}>
            {paperStrategySections.leaderboards.map((board) => (
              <PaperLeaderboardPanel key={board.key} board={board} />
            ))}
          </div>

          <PaperOpenPositionsPreview
            copy={paperCopy}
            rows={positionDeskRows}
            currency={currency}
            onOpen={() => handleTabChange('positioner')}
          />

          <PaperRecentTradesPreview
            copy={paperCopy}
            rows={recentClosedTrades}
            currency={currency}
            onOpen={() => handleTabChange('trades')}
          />

          <PaperBrokerStatus copy={paperCopy} items={brokerStatusItems} />

          <details style={{ marginTop: PANEL_GAP }}>
            <summary
              className="btn ghost"
              style={{
                display: 'inline-flex',
                cursor: 'pointer',
                listStyle: 'none',
              }}
            >
              {paperCopy.sections.broker.technical}
            </summary>
          <section style={{ ...sectionStyle({ marginTop: PANEL_GAP, borderColor: 'rgba(59,130,246,0.30)' }) }}>
            <SectionHeader
              eyebrow="Teknisk information"
              title="Brokerstatus"
              summary={`Översikten använder befintlig driftstatus och ${executionModeLabel} orderstatus. Saknade brokerfält visas som — tills en ny snapshot finns.`}
              action={refreshButton}
            />
            <StatusRail
              items={[
                {
                  label: uiName(FACTORY_TERM_KEYS.STRATEGY_RUNTIME),
                  value: hasRuntimeSnapshot ? fmtTime(data.generatedAt) : EMPTY_VALUE,
                  tone: hasRuntimeSnapshot ? 'success' : 'warning',
                },
                {
                  label: 'Orderstatus',
                  value: hasExecutionSnapshot ? paperSafeText(executionData.status) : EMPTY_VALUE,
                  tone: hasExecutionSnapshot ? statusTone(executionData.status) : 'warning',
                },
                {
                  label: 'IB Gateway',
                  value: boolText(executionConnected),
                  tone: boolTone(executionConnected),
                },
                {
                  label: 'Marknadsdata',
                  value: boolText(marketDataConnected),
                  tone: boolTone(marketDataConnected),
                },
                {
                  label: 'Order',
                  value: paperSafeText(executionData.orderSubmissionMode || safety.orderSubmissionMode),
                  tone: boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' }),
                },
                {
                  label: 'Avstämning',
                  value: reconciliationStatus,
                  tone: degraded ? 'warning' : (hasValue(reconciliation.status) ? 'success' : 'neutral'),
                },
              ]}
            />
            {(waitingForRuntime || waitingForExecution) ? (
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>
                {WAITING_BROKER}
              </div>
            ) : null}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--s3)', marginTop: PANEL_GAP }}>
            <MetricCard label="Kontovärde" value={moneyOrWaiting(account.netLiquidation, currency, waitingForRuntime)} hint={accountHint} tone={account.netLiquidation == null ? 'warning' : 'info'} />
            <MetricCard label="Tillgängligt" value={moneyOrWaiting(account.availableFunds, currency, waitingForRuntime)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: accountSourceText })} tone={account.availableFunds == null ? 'warning' : 'neutral'} />
            <MetricCard label="Köpkraft" value={moneyOrWaiting(account.buyingPower, currency, waitingForRuntime)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: accountSourceText })} tone={account.buyingPower == null ? 'warning' : 'neutral'} />
            <MetricCard label="Orealiserat resultat" value={moneyOrWaiting(account.unrealizedPnl, currency, waitingForRuntime)} hint={accountSourceText} tone={numberOrNull(account.unrealizedPnl) < 0 ? 'danger' : (hasValue(account.unrealizedPnl) ? 'success' : 'warning')} />
            <MetricCard label="Realiserat resultat" value={moneyOrWaiting(account.realizedPnl, currency, waitingForRuntime)} hint={accountSourceText} tone={numberOrNull(account.realizedPnl) < 0 ? 'danger' : (hasValue(account.realizedPnl) ? 'success' : 'warning')} />
            <MetricCard label="Dagens brokerresultat" value={moneyOrWaiting(dailyBrokerPnl, currency, waitingForRuntime)} hint={hasValue(dailyBrokerPnl) ? 'Dagens resultat från broker' : snapshotHint({ waiting: waitingForRuntime, fallback: 'Dagens brokerresultat saknas i snapshot' })} tone={numberOrNull(dailyBrokerPnl) < 0 ? 'danger' : (hasValue(dailyBrokerPnl) ? 'success' : 'warning')} />
            <MetricCard label="Öppna brokerpositioner" value={countOrEmpty(brokerPositions.length, hasBrokerPositionSnapshot)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText })} tone={hasBrokerPositionSnapshot && brokerPositions.length ? 'info' : 'neutral'} />
            <MetricCard label="Öppna brokerordrar" value={countOrEmpty(brokerOrders.length, hasBrokerOrderSnapshot)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText })} tone={hasBrokerOrderSnapshot && brokerOrders.length ? 'warning' : 'neutral'} />
            <MetricCard label="Avstämning" value={reconciliationStatus} hint={paperSafeText(reconciliation.blockedReason, '') || snapshotHint({ waiting: waitingForRuntime || waitingForExecution, fallback: 'Brokeravstämning' })} tone={degraded ? 'warning' : 'success'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 'var(--s4)', marginTop: PANEL_GAP }}>
            <OverviewPanel eyebrow="Konto" title="Kontoöversikt" summary={`Kontovärden från IBKR ${executionModeText}. Inga interna simvärden används.`}>
              <FieldGrid
                items={[
                  { label: 'Konto', value: textOrEmpty(account.accountIdMasked || executionData.account?.accountIdMasked), hint: account.unavailableReason || executionData.account?.blocker || `Maskerat ${executionModeText}-konto`, tone: account.accountIdMasked || executionData.account?.accountIdMasked ? 'success' : 'warning' },
                  { label: 'Valuta', value: textOrEmpty(currency) },
                  { label: 'Uppdaterad', value: fmtTime(account.updatedAt || ibAccount.generatedAt || executionData.account?.generatedAt), hint: ibAccount.cacheAgeMs != null || executionData.account?.cacheAgeMs != null ? `ålder ${fmtAge(ibAccount.cacheAgeMs ?? executionData.account?.cacheAgeMs)}` : null },
                  { label: 'Kontostatus', value: account.degraded ? 'Nedsatt' : (hasValue(account.accountIdMasked) ? 'OK' : EMPTY_VALUE), hint: account.stale ? 'gammal snapshot' : null, tone: account.degraded ? 'warning' : (hasValue(account.accountIdMasked) ? 'success' : 'neutral') },
                  { label: 'Kontanter', value: moneyOrWaiting(account.totalCashValue, currency, waitingForRuntime) },
                  { label: 'Kontotyp', value: paperSafeText(account.classification || executionData.account?.classification || ibAccount.account?.classification) },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Order" title="Orderkontroll" summary={`Lässtatus från ${executionModeLabel} orderhantering.`}>
              <FieldGrid
                items={[
                  { label: 'Läge', value: hasExecutionSnapshot ? paperSafeText(executionData.status) : EMPTY_VALUE, tone: statusTone(executionData.status) },
                  { label: 'Motorläge', value: paperSafeText(executionRuntimeState), hint: paperSafeText(executionData.runtimeLifecycleState, ''), tone: statusTone(executionRuntimeState) },
                  { label: 'API ansluten', value: boolText(executionConnected), hint: executionData.lastHeartbeat ? `senaste signal ${fmtTime(executionData.lastHeartbeat)}` : null, tone: boolTone(executionConnected) },
                  { label: 'Ordernummer klart', value: boolText(nextValidIdReady), hint: hasValue(executionData.nextValidId) ? `nummer ${executionData.nextValidId}` : null, tone: boolTone(nextValidIdReady) },
                  { label: 'Paperkonto verifierat', value: boolText(executionData.paperAccountVerified ?? safety.verifiedPaperAccount), tone: boolTone(executionData.paperAccountVerified ?? safety.verifiedPaperAccount) },
                  { label: 'Livekonto blockerat', value: boolText(executionData.liveAccountBlocked ?? safety.liveAccountBlocked), tone: boolTone(executionData.liveAccountBlocked ?? safety.liveAccountBlocked, { trueTone: 'success', falseTone: 'danger' }) },
                  { label: 'Orderläge', value: paperSafeText(executionData.orderSubmissionMode || safety.orderSubmissionMode), tone: boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' }) },
                  { label: 'Upptid', value: fmtAge(executionData.runtimeUptimeMs ?? executionData.uptimeMs ?? executionData.uptime), hint: executionData.reconnectCount != null ? `återanslutningar ${fmtNumber(executionData.reconnectCount)}` : null },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Broker" title="Positioner, order och avslut" summary="Antal kommer från brokeravstämning när snapshot finns.">
              <FieldGrid
                items={[
                  { label: 'Avstämning', value: reconciliationStatus, hint: paperSafeText(reconciliation.blockedReason, '') || fmtTime(reconciliation.generatedAt || executionData.lastReconciliationAt), tone: degraded ? 'warning' : 'success' },
                  { label: 'Nya affärer', value: boolText(reconciliation.newEntriesAllowed), tone: boolTone(reconciliation.newEntriesAllowed) },
                  { label: 'Positioner', value: countOrEmpty(reconciliationCounts.positions ?? brokerPositions.length, hasBrokerPositionSnapshot || hasValue(reconciliationCounts.positions)), hint: 'Öppna brokerpositioner' },
                  { label: 'Öppna order', value: countOrEmpty(reconciliationCounts.openOrders ?? brokerOrders.length, hasBrokerOrderSnapshot || hasValue(reconciliationCounts.openOrders)), hint: 'Öppna brokerorder' },
                  { label: 'Avslut', value: countOrEmpty(reconciliationCounts.executions ?? brokerFills.length, hasBrokerFillSnapshot || hasValue(reconciliationCounts.executions)), hint: 'Brokeravslut' },
                  { label: 'Orderstatusar', value: countOrEmpty(reconciliationCounts.orderStatuses, hasValue(reconciliationCounts.orderStatuses)) },
                  { label: 'Avvikelser', value: countOrEmpty(Array.isArray(reconciliation.discrepancies) ? reconciliation.discrepancies.length : null, Array.isArray(reconciliation.discrepancies)), tone: Array.isArray(reconciliation.discrepancies) && reconciliation.discrepancies.length ? 'warning' : 'success' },
                  { label: 'Senast uppdaterad', value: fmtTime(reconciliation.generatedAt || executionData.lastReconciliationAt) },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Marknad" title="Marknadsdata" summary="Marknadsdata och prisuppdateringar visas från befintligt statusflöde.">
              <FieldGrid
                items={[
                  { label: 'Session', value: paperSafeText(market.sessionLabel || market.session || strategyOverviewMeta.currentSession), hint: paperSafeText(market.sessionId || strategyOverviewMeta.currentSessionId, ''), tone: market.isMarketOpen || market.isOpen || strategyOverviewMeta.marketOpen ? 'success' : 'warning' },
                  { label: 'Marknaden öppen', value: boolText(market.isMarketOpen ?? market.isOpen ?? strategyOverviewMeta.marketOpen), tone: boolTone(market.isMarketOpen ?? market.isOpen ?? strategyOverviewMeta.marketOpen) },
                  { label: 'Nästa skifte', value: fmtTime(nextSessionTransition.at || nextSessionTransition.timestamp || nextSessionTransition.nextTransitionAt), hint: paperSafeText(nextSessionTransition.toSession || nextSessionTransition.sessionLabel || nextSessionTransition.type, '') },
                  { label: 'IB-data', value: boolText(marketDataConnected), hint: paperSafeText(ibDataLayer.source || dataFeed.source, ''), tone: boolTone(marketDataConnected) },
                  { label: 'Datakälla', value: paperSafeText(dataFeed.source), hint: dataFeed.provider || dataFeed.description || null, tone: hasValue(dataFeed.source) ? (dataFeed.simulated || dataFeed.fallback ? 'warning' : 'success') : 'neutral' },
                  { label: 'Priser', value: countOrEmpty(quotes.length, Array.isArray(data.quotes)), hint: dataFeed.delayed ? 'fördröjt flöde' : null },
                ]}
              />
              <div style={{ marginTop: 'var(--s4)' }}>
                <QuoteTape quotes={quotes} waiting={waitingForRuntime} />
              </div>
            </OverviewPanel>

            <OverviewPanel eyebrow="Driftpuls" title="Marknadsbevakning och strategier" summary="Visar om systemet hittar nya lägen och vilka strategier som väntar.">
              <FieldGrid
                items={[
                  // FAS 8: Use canonical market watch, not legacy scanner
                  { label: 'Marknadsbevakning', value: canonicalMarketWatch.active ? 'Aktiv' : 'Inaktiv', hint: canonicalMarketWatch.latestSignalAt ? `senaste signal ${fmtTime(canonicalMarketWatch.latestSignalAt)}` : null, tone: canonicalMarketWatch.health === 'fresh' ? 'success' : (canonicalMarketWatch.health === 'stale' ? 'warning' : 'neutral') },
                  { label: 'Senaste sökning', value: canonicalMarketWatch.latestScanAt ? fmtTime(canonicalMarketWatch.latestScanAt) : 'Ingen aktuell sökning', hint: canonicalMarketWatch.reason || '' },
                  { label: 'Väntar på granskning', value: countOrEmpty(canonical.strategies?.data?.totalStrategies ?? strategyOverview.length, false), hint: 'Kandidater väntar inte längre på godkännande' },
                  { label: 'Strategier totalt', value: countOrEmpty(strategyOverviewMeta.totalStrategies ?? strategyOverview.length, hasValue(strategyOverviewMeta.totalStrategies) || Array.isArray(data.strategyOverview)) },
                  { label: 'Redo och väntar', value: countOrEmpty(strategyOverviewCounts.readyWaitingForSignal, hasValue(strategyOverviewCounts.readyWaitingForSignal)) },
                  { label: 'Aktiva i Paper', value: countOrEmpty(strategyOverviewCounts.active, hasValue(strategyOverviewCounts.active)) },
                  { label: 'Kan handlas nu', value: countOrEmpty(strategyStatusMeta.tradableNow ?? strategyOverviewCounts.canTradeNow, hasValue(strategyStatusMeta.tradableNow) || hasValue(strategyOverviewCounts.canTradeNow)) },
                  { label: 'Stopporsaker', value: countOrEmpty(statusReasons.length, Array.isArray(data.statusReasons)), tone: statusReasons.length ? 'warning' : 'success' },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Teknik" title="Testmotorer" summary="Historiska tester och testgrupper visas som läsbar status; de påverkar inte brokeravstämningen.">
              <FieldGrid
                items={[
                  { label: 'Historiska tester redo', value: boolText(dataPipeline.replay?.ready), hint: paperSafeText(dataPipeline.replay?.blocker || dataPipeline.replay?.status, ''), tone: boolTone(dataPipeline.replay?.ready) },
                  { label: 'Många tester redo', value: boolText(dataPipeline.batch?.ready), hint: paperSafeText(dataPipeline.batch?.blocker || dataPipeline.batch?.status, ''), tone: boolTone(dataPipeline.batch?.ready) },
                  { label: 'Snapshotålder', value: data.cacheAgeMs != null ? fmtAge(data.cacheAgeMs) : EMPTY_VALUE, hint: data.cached ? 'hämtad från cache' : (data.stale ? 'gammal snapshot' : null), tone: data.stale ? 'warning' : 'neutral' },
                  { label: 'Skapad', value: fmtTime(data.generatedAt) },
                ]}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', marginTop: 'var(--s4)' }}>
                <Pill tone={boolTone(flags.executionEnabled)}>Orderkoppling: {boolText(flags.executionEnabled)}</Pill>
                <Pill tone={boolTone(flags.shadowMode)}>Skuggläge: {boolText(flags.shadowMode)}</Pill>
                <Pill tone={boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' })}>Orderskick: {boolText(flags.submissionEnabled)}</Pill>
                <Pill tone={boolTone(executionData.liveBrokerExecutionEnabled, { trueTone: 'danger', falseTone: 'success' })}>Livebroker: {boolText(executionData.liveBrokerExecutionEnabled)}</Pill>
                <Pill tone={boolTone(data.controls?.manualTradingEnabled, { trueTone: 'warning', falseTone: 'success' })}>Manuell handel: {boolText(data.controls?.manualTradingEnabled)}</Pill>
              </div>
            </OverviewPanel>
          </div>
          </details>
        </>
      )}

      {activeTab === 'strategier' && (
        <div style={{ display: 'grid', gap: PANEL_GAP }}>
          {/* Strategy Brain: vad systemet INTE vet. Ligger överst för att den
              ramar in tabellen under — ett svagt resultat betyder olika saker
              beroende på om strategin är mätt eller obeprövad. */}
          <StrategyBrainPanel />
          <StrategyDashboard
            strategyStore={strategyStore}
            eventStore={tradingEventStore}
            decisionStore={decisionStore}
            waiting={waitingForRuntime && !hasRuntimeSnapshot}
            title="Strategiöversikt"
            summary="Samlar strategier, signaler, risk, godkännande och resultat för handelstestet."
          />
        </div>
      )}

      {activeTab === 'analytics' && (
        <div style={{ display: 'grid', gap: PANEL_GAP }}>
          {/* Analys = statistik för traders. Samma journalrader ses ur tre vinklar:
              vilken strategi, vilken familj och vilken marknad som tjänar pengar.
              Siffrorna kan inte gå isär med senaste avslut - de räknas ur samma rader.
              Tekniska fält och seriekatalogen ligger i driftvyn, inte här. */}
          <StrategyStatisticsPanel
            trades={tradeJournal.trades}
            currency={currency}
            waiting={waitingForRuntime && !hasOrderLifecycleSnapshot}
            groupBy="strategy"
          />
          <StrategyStatisticsPanel
            trades={tradeJournal.trades}
            currency={currency || 'USD'}
            waiting={waitingForRuntime && !hasOrderLifecycleSnapshot}
            groupBy="family"
          />
          <StrategyStatisticsPanel
            trades={tradeJournal.trades}
            currency={currency || 'USD'}
            waiting={waitingForRuntime && !hasOrderLifecycleSnapshot}
            groupBy="symbol"
          />
        </div>
      )}

      {activeTab === 'konto' && (
        <div style={{ marginTop: 14 }}>
          <PortfolioIntelligence
            account={account}
            portfolio={portfolio}
            reconciliation={reconciliation}
            currency={currency}
            eventStore={tradingEventStore}
            decisionStore={decisionStore}
            waiting={waitingForRuntime}
          />
        </div>
      )}

      {activeTab === 'positioner' && (
        <div style={{ marginTop: 14 }}>
          {/* Positioner är en trading desk, inte en brokerspegel: standardvyn visar
              bara öppna positioner och det som avgör nästa beslut. Brokeravstämning,
              kontoöversikt och orderkontroll ligger i teknisk drift respektive
              IBKR Paper-konto - de finns kvar, men inte här. */}
          <PositionDeskPanel
            rows={positionDeskRows}
            summary={positionDeskSummary}
            currency={currency || 'USD'}
            waiting={waitingForRuntime && !hasBrokerPositionSnapshot}
            action={refreshButton}
          />
        </div>
      )}

      {activeTab === 'ordrar' && (
        <div style={{ marginTop: 14 }}>
          <LiveScannerPanel
            rows={scannerRows}
            summary={scannerSummary}
            scanHistory={scanHistory}
            scannerConnected={scanner.connected ?? null}
            waiting={waitingForRuntime && !hasRuntimeSnapshot}
            action={refreshButton}
          />
        </div>
      )}

      {activeTab === 'broker-orders' && (
        <>
          <BrokerOrdersPanel
            brokerOrders={brokerOrders}
            brokerOrderStatuses={brokerOrderStatuses}
            waiting={waitingForRuntime && !hasBrokerOrderSnapshot && !hasBrokerOrderStatusSnapshot}
            onSelectTrade={selectTrade}
            action={refreshButton}
          />
          {brokerOrderStatuses.length ? (
            <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
              <SectionHeader
                eyebrow="Broker"
                title="Orderstatus"
                summary="IBKR:s orderstatus från brokeravstämningen. Ingen resultatstatistik, bara orderns väg."
              />
              <CompactTable
                rows={brokerOrderStatuses.map((row, index) => ({ ...row, id: row.orderId || row.permId || index }))}
                emptyText="Inga orderstatusar i snapshot."
                columns={[
                  { key: 'orderId', label: 'Ordernummer' },
                  { key: 'permId', label: 'Brokernummer' },
                  { key: 'parentId', label: 'Huvudorder' },
                  { key: 'ibStatus', label: 'IB-status', render: (row) => paperSafeText(row.ibStatus) },
                  { key: 'status', label: 'Orderläge', render: (row) => <Pill tone={statusTone(row.status)}>{paperSafeText(row.status)}</Pill> },
                  { key: 'filled', label: 'Fyllt', render: (row) => fmtNumber(row.filled) },
                  { key: 'remaining', label: 'Kvar', render: (row) => fmtNumber(row.remaining) },
                  { key: 'avgFillPrice', label: 'Snittpris', render: (row) => fmtNumber(row.avgFillPrice, 2) },
                  { key: 'lastFillPrice', label: 'Senaste pris', render: (row) => fmtNumber(row.lastFillPrice, 2) },
                  { key: 'updatedAt', label: 'Uppdaterad', render: (row) => fmtTime(row.updatedAt) },
                ]}
              />
            </section>
          ) : null}
          {/* Ingen trade-statistik här — den här sidan svarar bara för brokerns ordrar. */}
          <div style={{ marginTop: 'var(--s3)', color: 'var(--muted)', fontSize: 12 }}>
            {fmtNumber(orderLifecycleRows.length)} orderrader i brokeravstämning och orderlogg.
          </div>
        </>
      )}

      {activeTab === 'fills' && (
        <>
          <FillsPanel
            brokerFills={brokerFills}
            currency={currency || 'USD'}
            waiting={waitingForRuntime && !hasBrokerFillSnapshot}
            onSelectTrade={selectTrade}
            action={refreshButton}
          />
          {brokerCommissions.length ? (
            <div style={{ marginTop: 'var(--s3)', color: 'var(--muted)', fontSize: 12 }}>Avgiftsrader: {fmtNumber(brokerCommissions.length)}</div>
          ) : null}
        </>
      )}

      {activeTab === 'runtime' && (
        <>
        {/* Marknadsradarn och granskningar ligger i marknadsbevakningen. Kvar här
            ligger driftinformation: vägval, stopporsaker och räknare som beskriver
            systemet, inte handeln. */}
        <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
          <SectionHeader
            eyebrow={runtimeDiagnostic.eyebrow}
            title={runtimeDiagnostic.title}
            summary={runtimeDiagnostic.summary}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', marginBottom: 'var(--s4)' }}>
            <Pill tone={hasValue(executionTarget) ? 'success' : 'warning'}>{executionModeText}</Pill>
            <Pill tone={hasValue(executionTarget) ? 'success' : 'warning'}>Ordermiljö: {executionTargetText}</Pill>
            <Pill tone="success">Väntar på granskning: {countOrEmpty(queueCandidates.length, Array.isArray(candidateQueue.candidates))}</Pill>
            <Pill tone={market.isMarketOpen || market.isOpen ? 'success' : 'warning'}>Session: {paperSafeText(market.sessionLabel || market.session)}</Pill>
            <Pill tone={degraded ? 'warning' : 'success'}>Avstämning: {reconciliationStatus}</Pill>
          </div>
          <div style={{ marginTop: PANEL_GAP }}>
            <SectionHeader eyebrow="Stopporsaker" title="Varför systemet väntar" />
            <div style={{ display: 'grid', gap: 'var(--s2)' }}>
              {statusReasons.length ? statusReasons.map((row) => (
                <div key={row.code} style={{ color: 'var(--muted)', fontSize: 13 }}>{paperSafeText(row.code)}: {paperSafeText(row.message)}</div>
              )) : <div style={{ color: 'var(--muted)', fontSize: 13 }}>Inga driftorsaker.</div>}
            </div>
          </div>
          {/* Brokeravstämningen låg tidigare på Positioner. Den beskriver hur
              brokern speglas, inte hur handeln går, och är därför diagnostik. */}
          <div style={{ marginTop: PANEL_GAP }}>
            <SectionHeader eyebrow={`Brokerkälla · ${brokerMirrorSourceText}`} title="Brokerpositioner" summary="Brokerfält från avstämningen. Handelsvyn över samma positioner finns på Positioner." />
            <CompactTable
              rows={brokerPositions}
              emptyText={degraded ? `Brokerpositioner är osäkra: ${paperSafeText(reconciliation.blockedReason || 'reconciliation_degraded')}` : 'Inga öppna brokerpositioner.'}
              columns={[
                { key: 'accountMasked', label: 'Konto', render: (row) => row.accountMasked || EMPTY_VALUE },
                { key: 'root', label: 'Symbolbas', render: (row) => row.root || row.symbol || EMPTY_VALUE },
                { key: 'localSymbol', label: 'Kontrakt' },
                { key: 'conId', label: 'Kontraktsnyckel' },
                { key: 'expiry', label: 'Förfall' },
                { key: 'side', label: 'Sida' },
                { key: 'quantity', label: 'Antal', render: (row) => fmtNumber(row.quantity) },
                { key: 'averageCost', label: 'Snittkostnad', render: (row) => fmtNumber(row.averageCost ?? row.avgCost, 2) },
                { key: 'marketPrice', label: 'Marknadspris', render: (row) => fmtNumber(row.marketPrice, 2) },
                { key: 'unrealizedPnl', label: 'Orealiserat resultat', render: (row) => fmtMoney(row.unrealizedPnl, currency) },
                { key: 'realizedPnl', label: 'Realiserat resultat', render: (row) => fmtMoney(row.realizedPnl, currency) },
                { key: 'source', label: 'Källa', render: (row) => (hasValue(row.source || row.executionSource) ? <Pill tone="success">{paperSafeText(row.source || row.executionSource)}</Pill> : EMPTY_VALUE) },
                { key: 'reconciliationTimestamp', label: 'Avstämd', render: (row) => fmtTime(row.reconciliationTimestamp) },
                { key: 'protectiveOrderStatus', label: 'Skydd', render: (row) => paperSafeText(row.protectiveOrderStatus) },
              ]}
            />
          </div>
          <div style={{ marginTop: PANEL_GAP }}>
            <SectionHeader eyebrow="Marknadsbevakning" title="Senaste sökningar" summary="Senaste bakgrundssökningar. Detaljer per strategi finns i marknadsbevakningen." />
            <CompactTable
              rows={scanHistory.map((row) => ({ ...row, id: row.scanId }))}
              emptyText="Inga sökningar ännu."
              columns={[
                { key: 'startedAt', label: 'Tidpunkt', render: (row) => fmtTime(row.startedAt) },
                { key: 'tradingOsSignalsRead', label: 'Signaler', render: (row) => fmtNumber(row.tradingOsSignalsRead) },
                { key: 'candidatesCreated', label: 'Granskningar', render: (row) => fmtNumber(row.candidatesCreated) },
                { key: 'executionTarget', label: 'Ordermiljö', render: (row) => paperSafeText(row.executionTarget) },
                { key: 'blockedByExecutionTarget', label: 'Stoppade', render: (row) => Array.isArray(row.blockedByExecutionTarget) ? fmtNumber(row.blockedByExecutionTarget.length) : EMPTY_VALUE },
                { key: 'status', label: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{paperSafeText(row.status)}</Pill> },
              ]}
            />
          </div>
        </section>
        {/* Tekniska prestandafält och seriekatalogen beskriver vilka fält driftvyn
            exponerar. Det är diagnostik, inte handelsstatistik. */}
        <div style={{ marginTop: PANEL_GAP }}>
          <TradingAnalyticsPanel
            strategyStore={strategyStore}
            eventStore={tradingEventStore}
            decisionStore={decisionStore}
            analytics={analytics}
            waiting={waitingForRuntime && !hasRuntimeSnapshot}
          />
        </div>
        </>
      )}

      {activeTab === 'ibkr' && (
        <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
          <SectionHeader eyebrow={`IBKR ${executionModeText} orderstatus`} title="Orderstatus" summary={`${executionModeText} miljö`} action={refreshButton} />
          {execution.error ? <div style={{ color: 'var(--warning)', marginBottom: 10 }}>{paperSafeText(execution.error)}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--s3)' }}>
            <MetricCard label="Status" value={paperSafeText(executionData.status)} hint={paperSafeText(executionData.orderSubmissionMode || safety.orderSubmissionMode)} tone={statusTone(executionData.status)} />
            <MetricCard label="Orderkoppling" value={boolText(executionConnected)} hint={executionClient.host || executionClient.port ? `${executionClient.host || EMPTY_VALUE}:${executionClient.port || EMPTY_VALUE}` : EMPTY_VALUE} tone={boolTone(executionConnected)} />
            <MetricCard label={isLiveExecution ? 'Livekonto' : 'Paperkonto'} value={(isLiveExecution ? executionData.liveAccountVerified : executionData.paperAccountVerified) ? 'Verifierat' : (hasExecutionSnapshot ? 'Blockerat' : EMPTY_VALUE)} hint={paperSafeText(executionData.account?.accountIdMasked || executionData.account?.blocker)} tone={(isLiveExecution ? executionData.liveAccountVerified : executionData.paperAccountVerified) ? 'success' : 'warning'} />
            <MetricCard label="Avstämning" value={reconciliationStatus} hint={paperSafeText(reconciliation.blockedReason)} tone={degraded ? 'warning' : 'success'} />
            <MetricCard label="Öppna order" value={countOrEmpty(reconciliation.counts?.openOrders ?? brokerOrders.length, hasValue(reconciliation.counts?.openOrders) || hasBrokerOrderSnapshot)} hint={brokerMirrorSourceText} />
            <MetricCard label="Avslut" value={countOrEmpty(reconciliation.counts?.executions ?? brokerFills.length, hasValue(reconciliation.counts?.executions) || hasBrokerFillSnapshot)} hint={brokerMirrorSourceText} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', marginTop: 'var(--s4)' }}>
            <Pill tone={boolTone(flags.executionEnabled)}>Orderkoppling: {boolText(flags.executionEnabled)}</Pill>
            <Pill tone={boolTone(flags.shadowMode)}>Skuggläge: {boolText(flags.shadowMode)}</Pill>
            <Pill tone={boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' })}>Orderskick: {boolText(flags.submissionEnabled)}</Pill>
            <Pill tone={boolTone(safety.liveAccountBlocked, { trueTone: 'success', falseTone: 'danger' })}>Livekonto blockerat: {boolText(safety.liveAccountBlocked)}</Pill>
            <Pill tone={boolTone(executionData.paperOnly)}>Paperläge: {boolText(executionData.paperOnly)}</Pill>
          </div>
        </section>
      )}

      {activeTab === 'godkannande' && (
        <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
            <SectionHeader eyebrow="Godkännande" title="Strategigodkännande" summary={`Godkännande, kontrakt, session och riskregler styr om en strategi får följas i ${executionModeLabel}.`} />
          <FuturesPaperStrategyApprovalPanel currency={currency} />
        </section>
      )}

      {activeTab === 'teknik' && (
        <>
          <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
            <SectionHeader eyebrow="Tekniskt" title="Aktiva källor" summary={`Aktivt konto, positioner och avslut kommer från ${executionModeLabel}. Historiska tester och testgrupper är separata analysflöden.`} />
            <CompactTable
              rows={[
                { key: 'Ordermiljö', value: executionTargetText, detail: 'Rapporterad ordermiljö' },
                { key: 'Kontokälla', value: paperSafeText(data.technical?.accountSource), detail: 'Kontovärde, tillgängligt kapital och köpkraft' },
                { key: 'Positionskälla', value: paperSafeText(data.technical?.activePositionSource), detail: `${executionModeLabel} positioner` },
                { key: 'Affärskälla', value: paperSafeText(data.technical?.activeTradeSource), detail: 'Avslut och avgifter' },
                { key: 'Historiska tester', value: data.dataPipeline?.replay?.ready ? 'Redo' : paperSafeText(data.dataPipeline?.replay?.blocker), detail: 'Körs vid sidan av brokerstatus' },
                { key: 'Många tester', value: data.dataPipeline?.batch?.ready ? 'Redo' : paperSafeText(data.dataPipeline?.batch?.blocker), detail: 'Körs vid sidan av brokerstatus' },
              ]}
              columns={[
                { key: 'key', label: 'Del' },
                { key: 'value', label: 'Värde' },
                { key: 'detail', label: 'Detalj' },
              ]}
            />
          </section>
          <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
            <SectionHeader eyebrow="Teknisk info" title="Strategikatalog och strategidetaljer" summary="Läsbar strategiinfo." />
            <FuturesTechnicalInfoPanel />
          </section>
        </>
      )}

      {activeTab === 'arkiv' && (
        <section style={{ ...sectionStyle({ marginTop: PANEL_GAP }) }}>
          <SectionHeader eyebrow="Läsarkiv" title="Äldre interna simuleringar" summary="Äldre interna simuleringar används inte för nya affärer och påverkar inte aktuella KPI:er." />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', marginBottom: 'var(--s4)' }}>
            <Pill tone="warning">Arkivkälla</Pill>
            <Pill tone="success">Läsvy</Pill>
            <Pill tone="success">Inte aktiv handel</Pill>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s3)', marginBottom: PANEL_GAP }}>
            <MetricCard label="Äldre öppna" value={countOrEmpty(legacy.positions?.totalOpen ?? legacy.openPositions?.length, hasValue(legacy.positions?.totalOpen) || Array.isArray(legacy.openPositions))} hint="Ej aktiv positionskälla" tone="warning" />
            <MetricCard label="Äldre stängda" value={countOrEmpty(legacy.positions?.totalClosed ?? legacy.closedTrades?.length, hasValue(legacy.positions?.totalClosed) || Array.isArray(legacy.closedTrades))} hint="Ej aktiv affärskälla" tone="warning" />
            <MetricCard label="Arkiverat konto" value={legacy.account ? 'Arkiverat' : EMPTY_VALUE} hint="Ej aktivt saldo" tone="warning" />
          </div>
          <CompactTable
            rows={Array.isArray(legacy.recentClosedTrades) ? legacy.recentClosedTrades : []}
            emptyText="Inga äldre affärer i arkivvyn."
            columns={[
              { key: 'closedAt', label: 'Stängd', render: (row) => fmtTime(row.closedAt) },
              { key: 'symbol', label: 'Symbol', render: (row) => row.symbol || row.root || EMPTY_VALUE },
              { key: 'strategyId', label: 'Strategi' },
              { key: 'tradeType', label: 'Arkivtyp' },
              { key: 'source', label: 'Källa', render: () => <Pill tone="warning">Arkiverad simulering</Pill> },
              { key: 'realizedPnlSek', label: 'Arkivresultat', render: (row) => fmtMoney(row.realizedPnlSek, currency) },
            ]}
          />
        </section>
      )}
    </DashboardShell>
  );
}
