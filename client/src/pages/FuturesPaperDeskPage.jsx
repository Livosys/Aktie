import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
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
import { buildTradeJournal } from '../domain/TradeJournalDomain.js';
import { buildScannerRows, summarizeScanner } from '../domain/ScannerDomain.js';
import { buildPositionDeskRows, summarizePositionDesk } from '../domain/PositionDeskDomain.js';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  boolText,
  boolTone,
  countOrEmpty,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtTime,
  hasValue,
  moneyOrWaiting,
  numberOrNull,
  snapshotHint,
  textOrEmpty,
} from '../utils/tradingFormatters.js';

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 7_000;

const STATUS_COPY = 'Futures Paper använder IBKR Paper Trading som enda execution-miljö. Systemet är nu i shadow mode: strategier och orderplaner valideras, men faktisk ordersändning är avstängd tills säkerhetsgranskningen och första pilotordern har godkänts. Livekonton och riktiga pengar är blockerade.';

// Flikordningen ÄR informationshierarkin. Trade först, därefter statistik, sedan
// brokerns lager (order → execution), sedan kontext och sist diagnostik. Id:na är
// oförändrade, så gamla ?tab=-länkar fortsätter fungera.
const TABS = [
  // Nivå 1 — det användaren öppnar varje dag. Nivå 2 (trade details) bor inuti raden.
  { id: 'trades', label: 'Trades' },
  { id: 'analytics', label: 'Analytics' },
  // Live Scanner: vad som scannas just nu. Id:t 'ordrar' behålls med flit —
  // sidomenyns Execution-post pekar hit och gamla länkar ska inte dö.
  { id: 'ordrar', label: 'Live Scanner' },
  // Nivå 3–4 — hur brokern hanterade traden.
  { id: 'broker-orders', label: 'Broker Orders' },
  { id: 'fills', label: 'Executions' },
  // Kontext kring traderna.
  { id: 'oversikt', label: 'Översikt' },
  { id: 'strategier', label: 'Strategy Dashboard' },
  { id: 'positioner', label: 'Positioner' },
  { id: 'konto', label: 'IBKR Paper-konto' },
  // Nivå 5 — identitet, diagnostik och arkiv.
  { id: 'runtime', label: 'Runtime' },
  { id: 'ibkr', label: 'IBKR Paper Execution' },
  { id: 'godkannande', label: 'Godkännande' },
  { id: 'teknik', label: 'Teknisk info' },
  { id: 'arkiv', label: 'Historiskt sim-arkiv' },
];

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

// Trades är den primära vyn — den är det operatören öppnar varje dag.
const DEFAULT_TAB = 'trades';

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

export default function FuturesPaperDeskPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTabId(searchParams.get('tab'));
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
  const currency = account.currency || executionData.account?.currency || null;
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
  const executionTargetText = textOrEmpty(executionTarget);
  const isLiveExecution = executionTarget === 'ibkr_live';
  const executionModeText = isLiveExecution ? 'LIVE' : (executionTarget === 'ibkr_paper' ? 'PAPER' : executionTargetText);
  const executionFlagPrefix = isLiveExecution ? 'IBKR_LIVE' : 'IBKR_PAPER';
  const executionModeLabel = isLiveExecution ? 'IBKR Live' : 'IBKR Paper';
  const statusCopy = isLiveExecution
    ? 'Futures använder IBKR Live som aktiv execution target. Strategier, riskgrindar, idempotency och broker-submit körs genom Live-pathen.'
    : STATUS_COPY;
  const accountSourceText = textOrEmpty(account.source || executionData.account?.source || data.technical?.accountSource);
  const brokerMirrorSourceText = textOrEmpty(reconciliation.source || executionData.reconciliation?.source || data.technical?.activePositionSource || data.technical?.activeTradeSource || account.source);
  const accountHint = account.accountIdMasked
    || executionData.account?.accountIdMasked
    || account.unavailableReason
    || snapshotHint({ waiting: waitingForRuntime });
  const reconciliationStatus = reconciliation.status || EMPTY_VALUE;

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
  const tabs = useMemo(() => TABS.map((tab) => {
    if (tab.id === 'konto') return { ...tab, label: `IBKR ${executionModeText}-konto` };
    if (tab.id === 'ibkr') return { ...tab, label: `IBKR ${executionModeText} Execution` };
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

  // KPI-raden ligger ovanför varje flik, alltså även i standardvyn. Den ska svara
  // på "kan jag handla och hur mycket", inte rapportera backend-tillstånd.
  // Execution target är ett routingvärde som står still dygnet runt — det bor i
  // Teknisk info och på traden. Reconciliation är brokerdiagnostik: den visas bara
  // när den är degraderad, för då är den ett faktiskt varningstecken.
  // Positioner har egna KPI:er (öppet, orealiserat, dagens resultat). Konto- och
  // brokerkorten skulle bara konkurrera med dem om blicken — de bor på Översikt
  // och IBKR Paper-konto och visas därför inte ovanför trading desken.
  const kpis = useMemo(() => (activeTab === 'positioner' ? [] : [
    ...(hasValue(executionTarget) ? [] : [
      { label: 'Execution target', value: executionTargetText, tone: 'warning' },
    ]),
    {
      label: 'Net Liquidation',
      value: moneyOrWaiting(account.netLiquidation, currency, waitingForRuntime),
      hint: accountHint,
      tone: account.netLiquidation == null ? 'warning' : 'blue',
    },
    {
      label: 'Available Funds',
      value: moneyOrWaiting(account.availableFunds, currency, waitingForRuntime),
      hint: accountSourceText,
      tone: account.availableFunds == null ? 'warning' : 'blue',
    },
    {
      label: 'Buying Power',
      value: moneyOrWaiting(account.buyingPower, currency, waitingForRuntime),
      hint: accountSourceText,
      tone: account.buyingPower == null ? 'warning' : 'blue',
    },
    {
      label: 'Open broker positions',
      value: countOrEmpty(brokerPositions.length, hasBrokerPositionSnapshot),
      hint: snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText }),
      tone: hasBrokerPositionSnapshot && brokerPositions.length ? 'blue' : 'good',
    },
    ...(degraded ? [{
      label: 'Reconciliation',
      value: reconciliationStatus,
      hint: reconciliation.blockedReason || snapshotHint({ waiting: waitingForRuntime || waitingForExecution, fallback: 'Broker mirror' }),
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
      title={isLiveExecution ? 'Futures Live Desk' : 'Futures Paper Desk'}
      // Underrubriken säger vad sidan visar, inte hur den är byggd. Att IBKR Paper är
      // enda execution-miljö står redan i säkerhetsbannern nedanför — och att den interna
      // simuleringen är avvecklad är migrationshistorik, inte något en trader behöver.
      subtitle="Trades tagna av dina strategier: vilken strategi, hur det gick och varför de stängdes."
      safety={data}
      tabs={tabs}
      activeTab={activeTab}
      onTab={handleTabChange}
      kpis={kpis}
    >
      <section style={{ ...sectionStyle({ marginBottom: 14, borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.08)' }) }}>
        <strong>{statusCopy}</strong>
      </section>

      {runtime.error ? (
        <section style={{ ...sectionStyle({ marginBottom: 14, borderColor: 'rgba(239,68,68,0.35)' }) }}>
          <strong style={{ color: 'var(--danger)' }}>Runtime kunde inte läsas</strong>
          <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13 }}>{runtime.error}</div>
        </section>
      ) : null}

      {activeTab === 'trades' && (
        <div style={{ marginTop: 14 }}>
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
          <section style={{ ...sectionStyle({ marginTop: 14, borderColor: 'rgba(59,130,246,0.30)' }) }}>
            <SectionHeader
              eyebrow="Dashboard overview"
              title="Broker runtime snapshot"
              summary={`Overview-vyn använder befintlig runtime och ${executionModeLabel} execution status. Saknade brokerfält visas som — tills backend levererar en snapshot.`}
              action={refreshButton}
            />
            <StatusRail
              items={[
                {
                  label: 'Runtime',
                  value: hasRuntimeSnapshot ? fmtTime(data.generatedAt) : EMPTY_VALUE,
                  tone: hasRuntimeSnapshot ? 'success' : 'warning',
                },
                {
                  label: 'Execution',
                  value: hasExecutionSnapshot ? textOrEmpty(executionData.status) : EMPTY_VALUE,
                  tone: hasExecutionSnapshot ? statusTone(executionData.status) : 'warning',
                },
                {
                  label: 'IB Gateway API',
                  value: boolText(executionConnected),
                  tone: boolTone(executionConnected),
                },
                {
                  label: 'Market Data',
                  value: boolText(marketDataConnected),
                  tone: boolTone(marketDataConnected),
                },
                {
                  label: 'Orders',
                  value: textOrEmpty(executionData.orderSubmissionMode || safety.orderSubmissionMode),
                  tone: boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' }),
                },
                {
                  label: 'Reconciliation',
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 14 }}>
            <MetricCard label="Net Liquidation" value={moneyOrWaiting(account.netLiquidation, currency, waitingForRuntime)} hint={accountHint} tone={account.netLiquidation == null ? 'warning' : 'info'} />
            <MetricCard label="Available Funds" value={moneyOrWaiting(account.availableFunds, currency, waitingForRuntime)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: accountSourceText })} tone={account.availableFunds == null ? 'warning' : 'neutral'} />
            <MetricCard label="Buying Power" value={moneyOrWaiting(account.buyingPower, currency, waitingForRuntime)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: accountSourceText })} tone={account.buyingPower == null ? 'warning' : 'neutral'} />
            <MetricCard label="Unrealized PnL" value={moneyOrWaiting(account.unrealizedPnl, currency, waitingForRuntime)} hint={accountSourceText} tone={numberOrNull(account.unrealizedPnl) < 0 ? 'danger' : (hasValue(account.unrealizedPnl) ? 'success' : 'warning')} />
            <MetricCard label="Realized PnL" value={moneyOrWaiting(account.realizedPnl, currency, waitingForRuntime)} hint={accountSourceText} tone={numberOrNull(account.realizedPnl) < 0 ? 'danger' : (hasValue(account.realizedPnl) ? 'success' : 'warning')} />
            <MetricCard label="Daily broker PnL" value={moneyOrWaiting(dailyBrokerPnl, currency, waitingForRuntime)} hint={hasValue(dailyBrokerPnl) ? `${executionModeLabel} dailyPnl` : snapshotHint({ waiting: waitingForRuntime, fallback: 'Broker dailyPnl saknas i snapshot' })} tone={numberOrNull(dailyBrokerPnl) < 0 ? 'danger' : (hasValue(dailyBrokerPnl) ? 'success' : 'warning')} />
            <MetricCard label="Open broker positions" value={countOrEmpty(brokerPositions.length, hasBrokerPositionSnapshot)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText })} tone={hasBrokerPositionSnapshot && brokerPositions.length ? 'info' : 'neutral'} />
            <MetricCard label="Open broker orders" value={countOrEmpty(brokerOrders.length, hasBrokerOrderSnapshot)} hint={snapshotHint({ waiting: waitingForRuntime, fallback: brokerMirrorSourceText })} tone={hasBrokerOrderSnapshot && brokerOrders.length ? 'warning' : 'neutral'} />
            <MetricCard label="Reconciliation status" value={reconciliationStatus} hint={reconciliation.blockedReason || snapshotHint({ waiting: waitingForRuntime || waitingForExecution, fallback: 'Broker mirror' })} tone={degraded ? 'warning' : 'success'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 14 }}>
            <OverviewPanel eyebrow="Account" title="Account overview" summary={`Konto-KPI:er från IBKR ${executionModeText}. Inga interna simvärden används.`}>
              <FieldGrid
                items={[
                  { label: 'Account', value: textOrEmpty(account.accountIdMasked || executionData.account?.accountIdMasked), hint: account.unavailableReason || executionData.account?.blocker || `Maskerat ${executionModeText}-konto`, tone: account.accountIdMasked || executionData.account?.accountIdMasked ? 'success' : 'warning' },
                  { label: 'Currency', value: textOrEmpty(currency) },
                  { label: 'Snapshot', value: fmtTime(account.updatedAt || ibAccount.generatedAt || executionData.account?.generatedAt), hint: ibAccount.cacheAgeMs != null || executionData.account?.cacheAgeMs != null ? `cache age ${fmtAge(ibAccount.cacheAgeMs ?? executionData.account?.cacheAgeMs)}` : null },
                  { label: 'Account status', value: account.degraded ? 'Degraded' : (hasValue(account.accountIdMasked) ? 'OK' : EMPTY_VALUE), hint: account.stale ? 'stale snapshot' : null, tone: account.degraded ? 'warning' : (hasValue(account.accountIdMasked) ? 'success' : 'neutral') },
                  { label: 'Total Cash', value: moneyOrWaiting(account.totalCashValue, currency, waitingForRuntime) },
                  { label: 'Classification', value: textOrEmpty(account.classification || executionData.account?.classification || ibAccount.account?.classification) },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Execution" title="Execution control" summary={`Read-only status från ${executionModeLabel} execution orchestrator.`}>
              <FieldGrid
                items={[
                  { label: 'Status', value: hasExecutionSnapshot ? textOrEmpty(executionData.status) : EMPTY_VALUE, tone: statusTone(executionData.status) },
                  { label: 'Runtime state', value: textOrEmpty(executionRuntimeState), hint: executionData.runtimeLifecycleState || null, tone: statusTone(executionRuntimeState) },
                  { label: 'API connected', value: boolText(executionConnected), hint: executionData.lastHeartbeat ? `heartbeat ${fmtTime(executionData.lastHeartbeat)}` : null, tone: boolTone(executionConnected) },
                  { label: 'Next valid id', value: boolText(nextValidIdReady), hint: hasValue(executionData.nextValidId) ? `id ${executionData.nextValidId}` : null, tone: boolTone(nextValidIdReady) },
                  { label: 'Paper verified', value: boolText(executionData.paperAccountVerified ?? safety.verifiedPaperAccount), tone: boolTone(executionData.paperAccountVerified ?? safety.verifiedPaperAccount) },
                  { label: 'Live blocked', value: boolText(executionData.liveAccountBlocked ?? safety.liveAccountBlocked), tone: boolTone(executionData.liveAccountBlocked ?? safety.liveAccountBlocked, { trueTone: 'success', falseTone: 'danger' }) },
                  { label: 'Order mode', value: textOrEmpty(executionData.orderSubmissionMode || safety.orderSubmissionMode), tone: boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' }) },
                  { label: 'Uptime', value: fmtAge(executionData.runtimeUptimeMs ?? executionData.uptimeMs ?? executionData.uptime), hint: executionData.reconnectCount != null ? `reconnects ${fmtNumber(executionData.reconnectCount)}` : null },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Broker mirror" title="Positions, orders, fills" summary="Counts kommer från reconciliation och broker arrays när snapshot finns.">
              <FieldGrid
                items={[
                  { label: 'Reconciliation', value: reconciliationStatus, hint: reconciliation.blockedReason || fmtTime(reconciliation.generatedAt || executionData.lastReconciliationAt), tone: degraded ? 'warning' : 'success' },
                  { label: 'New entries', value: boolText(reconciliation.newEntriesAllowed), tone: boolTone(reconciliation.newEntriesAllowed) },
                  { label: 'Positions', value: countOrEmpty(reconciliationCounts.positions ?? brokerPositions.length, hasBrokerPositionSnapshot || hasValue(reconciliationCounts.positions)), hint: 'Open broker positions' },
                  { label: 'Open orders', value: countOrEmpty(reconciliationCounts.openOrders ?? brokerOrders.length, hasBrokerOrderSnapshot || hasValue(reconciliationCounts.openOrders)), hint: 'Open broker orders' },
                  { label: 'Executions', value: countOrEmpty(reconciliationCounts.executions ?? brokerFills.length, hasBrokerFillSnapshot || hasValue(reconciliationCounts.executions)), hint: 'Broker fills' },
                  { label: 'Order statuses', value: countOrEmpty(reconciliationCounts.orderStatuses, hasValue(reconciliationCounts.orderStatuses)) },
                  { label: 'Discrepancies', value: countOrEmpty(Array.isArray(reconciliation.discrepancies) ? reconciliation.discrepancies.length : null, Array.isArray(reconciliation.discrepancies)), tone: Array.isArray(reconciliation.discrepancies) && reconciliation.discrepancies.length ? 'warning' : 'success' },
                  { label: 'Last update', value: fmtTime(reconciliation.generatedAt || executionData.lastReconciliationAt) },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Market data" title="Feed and quote tape" summary="Marknadsdata och quote freshness visas från runtime-payloaden.">
              <FieldGrid
                items={[
                  { label: 'Session', value: textOrEmpty(market.sessionLabel || market.session || strategyOverviewMeta.currentSession), hint: textOrEmpty(market.sessionId || strategyOverviewMeta.currentSessionId), tone: market.isMarketOpen || market.isOpen || strategyOverviewMeta.marketOpen ? 'success' : 'warning' },
                  { label: 'Market open', value: boolText(market.isMarketOpen ?? market.isOpen ?? strategyOverviewMeta.marketOpen), tone: boolTone(market.isMarketOpen ?? market.isOpen ?? strategyOverviewMeta.marketOpen) },
                  { label: 'Next transition', value: fmtTime(nextSessionTransition.at || nextSessionTransition.timestamp || nextSessionTransition.nextTransitionAt), hint: textOrEmpty(nextSessionTransition.toSession || nextSessionTransition.sessionLabel || nextSessionTransition.type) },
                  { label: 'IB data layer', value: boolText(marketDataConnected), hint: textOrEmpty(ibDataLayer.source || dataFeed.source), tone: boolTone(marketDataConnected) },
                  { label: 'Feed source', value: textOrEmpty(dataFeed.source), hint: dataFeed.provider || dataFeed.description || null, tone: hasValue(dataFeed.source) ? (dataFeed.simulated || dataFeed.fallback ? 'warning' : 'success') : 'neutral' },
                  { label: 'Quotes', value: countOrEmpty(quotes.length, Array.isArray(data.quotes)), hint: dataFeed.delayed ? 'delayed feed' : null },
                ]}
              />
              <div style={{ marginTop: 12 }}>
                <QuoteTape quotes={quotes} waiting={waitingForRuntime} />
              </div>
            </OverviewPanel>

            <OverviewPanel eyebrow="Runtime pulse" title="Scanner and strategies" summary="Operational pulse från scanner, candidate queue och strategy overview metadata.">
              <FieldGrid
                items={[
                  { label: 'Scanner connected', value: boolText(scanner.connected), hint: scanner.lastTickAt ? `tick ${fmtTime(scanner.lastTickAt)}` : null, tone: boolTone(scanner.connected) },
                  { label: 'Last scan', value: fmtTime(scanner.lastScanAt), hint: scanner.lastScanSummary?.status || null },
                  { label: 'Candidate queue', value: countOrEmpty(candidateQueue.length ?? queueCandidates.length, hasValue(candidateQueue.length) || Array.isArray(candidateQueue.candidates)), hint: candidateQueue.connected === false ? 'queue disconnected' : null, tone: (candidateQueue.length ?? queueCandidates.length) ? 'info' : 'neutral' },
                  { label: 'Strategies total', value: countOrEmpty(strategyOverviewMeta.totalStrategies ?? strategyOverview.length, hasValue(strategyOverviewMeta.totalStrategies) || Array.isArray(data.strategyOverview)) },
                  { label: 'Ready waiting', value: countOrEmpty(strategyOverviewCounts.readyWaitingForSignal, hasValue(strategyOverviewCounts.readyWaitingForSignal)) },
                  { label: 'Active paper', value: countOrEmpty(strategyOverviewCounts.active, hasValue(strategyOverviewCounts.active)) },
                  { label: 'Tradable now', value: countOrEmpty(strategyStatusMeta.tradableNow ?? strategyOverviewCounts.canTradeNow, hasValue(strategyStatusMeta.tradableNow) || hasValue(strategyOverviewCounts.canTradeNow)) },
                  { label: 'Status reasons', value: countOrEmpty(statusReasons.length, Array.isArray(data.statusReasons)), tone: statusReasons.length ? 'warning' : 'success' },
                ]}
              />
            </OverviewPanel>

            <OverviewPanel eyebrow="Pipeline" title="Research engines" summary="Replay och Batch visas som read-only runtime-status; de påverkar inte broker mirror.">
              <FieldGrid
                items={[
                  { label: 'Replay ready', value: boolText(dataPipeline.replay?.ready), hint: dataPipeline.replay?.blocker || dataPipeline.replay?.status || null, tone: boolTone(dataPipeline.replay?.ready) },
                  { label: 'Batch ready', value: boolText(dataPipeline.batch?.ready), hint: dataPipeline.batch?.blocker || dataPipeline.batch?.status || null, tone: boolTone(dataPipeline.batch?.ready) },
                  { label: 'Runtime cache', value: data.cacheAgeMs != null ? fmtAge(data.cacheAgeMs) : EMPTY_VALUE, hint: data.cached ? 'cached snapshot' : (data.stale ? 'stale snapshot' : null), tone: data.stale ? 'warning' : 'neutral' },
                  { label: 'Generated', value: fmtTime(data.generatedAt) },
                ]}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                <Pill tone={boolTone(flags.executionEnabled)}>{executionFlagPrefix}_EXECUTION_ENABLED={boolText(flags.executionEnabled)}</Pill>
                <Pill tone={boolTone(flags.shadowMode)}>{executionFlagPrefix}_EXECUTION_SHADOW_MODE={boolText(flags.shadowMode)}</Pill>
                <Pill tone={boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' })}>{executionFlagPrefix}_ORDER_SUBMISSION_ENABLED={boolText(flags.submissionEnabled)}</Pill>
                <Pill tone={boolTone(executionData.liveBrokerExecutionEnabled, { trueTone: 'danger', falseTone: 'success' })}>LIVE broker={boolText(executionData.liveBrokerExecutionEnabled)}</Pill>
                <Pill tone={boolTone(data.controls?.manualTradingEnabled, { trueTone: 'warning', falseTone: 'success' })}>manualTradingEnabled={boolText(data.controls?.manualTradingEnabled)}</Pill>
              </div>
            </OverviewPanel>
          </div>
        </>
      )}

      {activeTab === 'strategier' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <StrategyDashboard
            strategyStore={strategyStore}
            eventStore={tradingEventStore}
            decisionStore={decisionStore}
            waiting={waitingForRuntime && !hasRuntimeSnapshot}
            title="Strategy Dashboard"
            summary="Central operating console for Futures Paper strategy state, signal context, risk, approval and performance. All rows consume the shared Strategy Store."
          />
        </div>
      )}

      {activeTab === 'analytics' && (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* Analytics = statistik för traders. Samma journalrader ses ur tre vinklar:
              vilken strategi, vilken familj och vilken marknad som tjänar pengar.
              Siffrorna kan inte gå isär med Trades-sidan — de räknas ur samma rader.
              Backend-fälten och seriekatalogen bor i Runtime, inte här. */}
          <StrategyStatisticsPanel
            trades={tradeJournal.trades}
            currency={currency || 'USD'}
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
              bara öppna positioner och det som avgör nästa beslut. Broker mirror,
              reconciliation, account summary och execution control bor i Runtime
              respektive IBKR Paper-konto — de finns kvar, men inte här. */}
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
            <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
              <SectionHeader
                eyebrow="Broker lifecycle events"
                title="Order status events"
                summary="Råa IBKR orderStatus-fält från broker reconciliation. Ingen PnL, ingen strategistatistik — bara brokerns egen orderlivscykel."
              />
              <CompactTable
                rows={brokerOrderStatuses.map((row, index) => ({ ...row, id: row.orderId || row.permId || index }))}
                emptyText="Inga orderstatus-events i snapshot."
                columns={[
                  { key: 'orderId', label: 'OrderId' },
                  { key: 'permId', label: 'PermId' },
                  { key: 'parentId', label: 'ParentId' },
                  { key: 'ibStatus', label: 'IB Status', render: (row) => row.ibStatus || EMPTY_VALUE },
                  { key: 'status', label: 'Lifecycle', render: (row) => <Pill tone={statusTone(row.status)}>{row.status || EMPTY_VALUE}</Pill> },
                  { key: 'filled', label: 'Filled', render: (row) => fmtNumber(row.filled) },
                  { key: 'remaining', label: 'Remaining', render: (row) => fmtNumber(row.remaining) },
                  { key: 'avgFillPrice', label: 'Avg fill', render: (row) => fmtNumber(row.avgFillPrice, 2) },
                  { key: 'lastFillPrice', label: 'Last fill', render: (row) => fmtNumber(row.lastFillPrice, 2) },
                  { key: 'updatedAt', label: 'Updated', render: (row) => fmtTime(row.updatedAt) },
                ]}
              />
            </section>
          ) : null}
          {/* Ingen trade-statistik här — den här sidan svarar bara för brokerns ordrar. */}
          <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12 }}>
            {fmtNumber(orderLifecycleRows.length)} orderrader i broker mirror + intent-logg.
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
            <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12 }}>Commission reports: {fmtNumber(brokerCommissions.length)}</div>
          ) : null}
        </>
      )}

      {activeTab === 'runtime' && (
        <>
        {/* Radarn — kandidatkön och scanhistoriken — bor på Live Scanner. Kvar här
            ligger den råa runtime-diagnostiken: routing, blockers och scanmotorns
            egna räknare, alltså det som beskriver systemet och inte handeln. */}
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="Runtime" title="Scanner runtime" summary="Routing, blockers och scanmotorns egna räknare. Vad som faktiskt scannas visas på Live Scanner." />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <Pill tone={hasValue(executionTarget) ? 'success' : 'warning'}>{executionModeText}</Pill>
            <Pill tone={hasValue(executionTarget) ? 'success' : 'warning'}>onlyActiveExecutionTarget={executionTargetText}</Pill>
            <Pill tone="success">candidate queue={countOrEmpty(queueCandidates.length, Array.isArray(candidateQueue.candidates))}</Pill>
            <Pill tone={market.isMarketOpen || market.isOpen ? 'success' : 'warning'}>session={market.sessionLabel || market.session || EMPTY_VALUE}</Pill>
            <Pill tone={degraded ? 'warning' : 'success'}>reconciliation={reconciliation.status || EMPTY_VALUE}</Pill>
          </div>
          <div style={{ marginTop: 14 }}>
            <SectionHeader eyebrow="Blockers" title="Status reasons" />
            <div style={{ display: 'grid', gap: 6 }}>
              {statusReasons.length ? statusReasons.map((row) => (
                <div key={row.code} style={{ color: 'var(--muted)', fontSize: 13 }}>{row.code}: {row.message}</div>
              )) : <div style={{ color: 'var(--muted)', fontSize: 13 }}>Inga runtime-reasons.</div>}
            </div>
          </div>
          {/* Broker mirror-tabellen låg tidigare på Positioner. Den beskriver hur
              brokern speglas, inte hur handeln går, och är därför diagnostik. */}
          <div style={{ marginTop: 14 }}>
            <SectionHeader eyebrow={`Broker mirror · source=${brokerMirrorSourceText}`} title="Brokerpositioner" summary="Råa brokerfält från reconciliation-spegeln. Handelsvyn över samma positioner finns på Positioner." />
            <CompactTable
              rows={brokerPositions}
              emptyText={degraded ? `Brokerpositioner är osäkra: ${reconciliation.blockedReason || 'reconciliation_degraded'}` : 'Inga öppna brokerpositioner.'}
              columns={[
                { key: 'accountMasked', label: 'Account', render: (row) => row.accountMasked || EMPTY_VALUE },
                { key: 'root', label: 'Root', render: (row) => row.root || row.symbol || EMPTY_VALUE },
                { key: 'localSymbol', label: 'LocalSymbol' },
                { key: 'conId', label: 'conId' },
                { key: 'expiry', label: 'Expiry' },
                { key: 'side', label: 'Side' },
                { key: 'quantity', label: 'Qty', render: (row) => fmtNumber(row.quantity) },
                { key: 'averageCost', label: 'Avg cost', render: (row) => fmtNumber(row.averageCost ?? row.avgCost, 2) },
                { key: 'marketPrice', label: 'Market price', render: (row) => fmtNumber(row.marketPrice, 2) },
                { key: 'unrealizedPnl', label: 'Unrealized PnL', render: (row) => fmtMoney(row.unrealizedPnl, currency) },
                { key: 'realizedPnl', label: 'Realized PnL', render: (row) => fmtMoney(row.realizedPnl, currency) },
                { key: 'source', label: 'Source', render: (row) => (hasValue(row.source || row.executionSource) ? <Pill tone="success">{row.source || row.executionSource}</Pill> : EMPTY_VALUE) },
                { key: 'reconciliationTimestamp', label: 'Reconciled', render: (row) => fmtTime(row.reconciliationTimestamp) },
                { key: 'protectiveOrderStatus', label: 'Protection', render: (row) => row.protectiveOrderStatus || EMPTY_VALUE },
              ]}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <SectionHeader eyebrow="Scan history" title="Senaste scans" summary="Rå scanmotor-telemetri. Scanner-timeline per strategi finns i Live Scanner-radens detaljvy." />
            <CompactTable
              rows={scanHistory.map((row) => ({ ...row, id: row.scanId }))}
              emptyText="Inga scans ännu."
              columns={[
                { key: 'startedAt', label: 'Tidpunkt', render: (row) => fmtTime(row.startedAt) },
                { key: 'tradingOsSignalsRead', label: 'OS-signaler', render: (row) => fmtNumber(row.tradingOsSignalsRead) },
                { key: 'candidatesCreated', label: 'Kandidater', render: (row) => fmtNumber(row.candidatesCreated) },
                { key: 'executionTarget', label: 'Target', render: (row) => row.executionTarget || EMPTY_VALUE },
                { key: 'blockedByExecutionTarget', label: 'Target block', render: (row) => Array.isArray(row.blockedByExecutionTarget) ? fmtNumber(row.blockedByExecutionTarget.length) : EMPTY_VALUE },
                { key: 'status', label: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status || EMPTY_VALUE}</Pill> },
              ]}
            />
          </div>
        </section>
        {/* Backend performance-fält och seriekatalogen beskriver vilka fält runtime
            exponerar — diagnostik, inte handelsstatistik. Den bor i Runtime. */}
        <div style={{ marginTop: 14 }}>
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
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow={`IBKR ${executionModeText} Execution`} title="Execution status" summary={`${executionModeText} target`} action={refreshButton} />
          {execution.error ? <div style={{ color: 'var(--warning)', marginBottom: 10 }}>{execution.error}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <MetricCard label="Status" value={executionData.status || EMPTY_VALUE} hint={executionData.orderSubmissionMode || safety.orderSubmissionMode || EMPTY_VALUE} tone={statusTone(executionData.status)} />
            <MetricCard label="Execution client" value={boolText(executionConnected)} hint={executionClient.host || executionClient.port ? `${executionClient.host || EMPTY_VALUE}:${executionClient.port || EMPTY_VALUE}` : EMPTY_VALUE} tone={boolTone(executionConnected)} />
            <MetricCard label={isLiveExecution ? 'Live account' : 'Paper account'} value={(isLiveExecution ? executionData.liveAccountVerified : executionData.paperAccountVerified) ? 'Verifierat' : (hasExecutionSnapshot ? 'Blockerat' : EMPTY_VALUE)} hint={executionData.account?.accountIdMasked || executionData.account?.blocker || EMPTY_VALUE} tone={(isLiveExecution ? executionData.liveAccountVerified : executionData.paperAccountVerified) ? 'success' : 'warning'} />
            <MetricCard label="Reconciliation" value={reconciliation.status || EMPTY_VALUE} hint={reconciliation.blockedReason || EMPTY_VALUE} tone={degraded ? 'warning' : 'success'} />
            <MetricCard label="Open orders" value={countOrEmpty(reconciliation.counts?.openOrders ?? brokerOrders.length, hasValue(reconciliation.counts?.openOrders) || hasBrokerOrderSnapshot)} hint={brokerMirrorSourceText} />
            <MetricCard label="Executions" value={countOrEmpty(reconciliation.counts?.executions ?? brokerFills.length, hasValue(reconciliation.counts?.executions) || hasBrokerFillSnapshot)} hint={brokerMirrorSourceText} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <Pill tone={boolTone(flags.executionEnabled)}>executionEnabled={boolText(flags.executionEnabled)}</Pill>
            <Pill tone={boolTone(flags.shadowMode)}>shadowMode={boolText(flags.shadowMode)}</Pill>
            <Pill tone={boolTone(flags.submissionEnabled, { trueTone: 'danger', falseTone: 'success' })}>submissionEnabled={boolText(flags.submissionEnabled)}</Pill>
            <Pill tone={boolTone(safety.liveAccountBlocked, { trueTone: 'success', falseTone: 'danger' })}>liveAccountBlocked={boolText(safety.liveAccountBlocked)}</Pill>
            <Pill tone={boolTone(executionData.paperOnly)}>paperOnly={boolText(executionData.paperOnly)}</Pill>
          </div>
        </section>
      )}

      {activeTab === 'godkannande' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
            <SectionHeader eyebrow="Godkännande" title="Strategigodkännande" summary={`Approval, entry contracts, session eligibility och riskregler styr om en candidate får nå ${executionModeLabel}.`} />
          <FuturesPaperStrategyApprovalPanel />
        </section>
      )}

      {activeTab === 'teknik' && (
        <>
          <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
            <SectionHeader eyebrow="Tekniskt" title="Aktiva källor" summary={`Aktiv konto-, positions- och fill-state kommer från ${executionModeLabel}. Replay och Batch är separata forskningsmotorer.`} />
            <CompactTable
              rows={[
                { key: 'Execution target', value: executionTargetText, detail: 'Runtime-reported target' },
                { key: 'Account source', value: data.technical?.accountSource || EMPTY_VALUE, detail: 'NetLiquidation, AvailableFunds, BuyingPower' },
                { key: 'Position source', value: data.technical?.activePositionSource || EMPTY_VALUE, detail: `${executionModeLabel} positions API / mirror` },
                { key: 'Trade source', value: data.technical?.activeTradeSource || EMPTY_VALUE, detail: 'execDetails + commissionReport' },
                { key: 'Replay', value: data.dataPipeline?.replay?.ready ? 'Redo' : (data.dataPipeline?.replay?.blocker || EMPTY_VALUE), detail: 'Offline research, skriver inte broker mirror' },
                { key: 'Batch', value: data.dataPipeline?.batch?.ready ? 'Redo' : (data.dataPipeline?.batch?.blocker || EMPTY_VALUE), detail: 'Offline research, skriver inte broker mirror' },
              ]}
              columns={[
                { key: 'key', label: 'Del' },
                { key: 'value', label: 'Värde' },
                { key: 'detail', label: 'Detalj' },
              ]}
            />
          </section>
          <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
            <SectionHeader eyebrow="Teknisk info" title="Strategikatalog och strategidetaljer" summary="Read-only strategiinfo." />
            <FuturesTechnicalInfoPanel />
          </section>
        </>
      )}

      {activeTab === 'arkiv' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="Read-only archive" title="Äldre interna simuleringar" summary="Äldre interna simuleringar - används inte för nya trades och påverkar inte aktuella KPI:er." />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <Pill tone="warning">source=internal_legacy_simulation</Pill>
            <Pill tone="success">readOnly=true</Pill>
            <Pill tone="success">activeRuntime=false</Pill>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
            <MetricCard label="Legacy open" value={countOrEmpty(legacy.positions?.totalOpen ?? legacy.openPositions?.length, hasValue(legacy.positions?.totalOpen) || Array.isArray(legacy.openPositions))} hint="Ej aktiv positionskälla" tone="warning" />
            <MetricCard label="Legacy closed" value={countOrEmpty(legacy.positions?.totalClosed ?? legacy.closedTrades?.length, hasValue(legacy.positions?.totalClosed) || Array.isArray(legacy.closedTrades))} hint="Ej aktiv tradekälla" tone="warning" />
            <MetricCard label="Legacy account" value={legacy.account ? 'Arkiverat' : EMPTY_VALUE} hint="Ej aktivt saldo" tone="warning" />
          </div>
          <CompactTable
            rows={Array.isArray(legacy.recentClosedTrades) ? legacy.recentClosedTrades : []}
            emptyText="Inga legacy-trades i arkivvyn."
            columns={[
              { key: 'closedAt', label: 'Stängd', render: (row) => fmtTime(row.closedAt) },
              { key: 'symbol', label: 'Symbol', render: (row) => row.symbol || row.root || EMPTY_VALUE },
              { key: 'strategyId', label: 'Strategi' },
              { key: 'tradeType', label: 'Legacy typ' },
              { key: 'source', label: 'Source', render: () => <Pill tone="warning">internal_legacy_simulation</Pill> },
              { key: 'realizedPnlSek', label: 'Legacy result', render: (row) => fmtMoney(row.realizedPnlSek, 'SEK') },
            ]}
          />
        </section>
      )}
    </DashboardShell>
  );
}
