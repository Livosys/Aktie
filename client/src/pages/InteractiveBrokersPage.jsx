import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { DashboardShell, EmptyState } from '../components/dashboard/DashboardKit.jsx';
import {
  REQUIRED_FINAL_EXECUTION_COMMAND,
  REQUIRED_CONFIRMATION_PHRASE,
  REQUIRED_SECOND_CONFIRMATION_PHRASE,
  REQUIRED_ARM_CONFIRMATION_PHRASE,
  buildManualPaperBracketSubmitState,
} from '../lib/interactiveBrokersManualPaperSubmit.mjs';
import {
  resolveStableSelectedIbPaperBlueprint,
} from '../lib/interactiveBrokersManualPaperBlueprintResolver.mjs';
import {
  mapBracketReadinessHttpError,
  readinessFalseLabel,
} from '../lib/interactiveBrokersManualPaperReadiness.mjs';
import {
  resolveStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import { createDecisionStore } from '../stores/decisionStore.js';
import { createTradingEventStore } from '../stores/tradingEventStore.js';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtNumber,
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';
import { apiFetch } from '../lib/apiClient.js';
const manualPaperHelperAvailable = typeof buildManualPaperBracketSubmitState === 'function';

// Interactive Brokers Paper — Phase 1 read-only preview page.
//
// This page is informational only. It renders the IB Paper status, the
// connection readiness probe, already-approved strategies and a read-only
// preview of today's best candidates. No order buttons exist here.

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 6_500;
const PREVIEW_LIMIT = 3;
const IB_PAPER_UI_VERSION = '4G-2G-stable-snapshot';
const IBKR_TABS = [
  { id: 'oversikt', label: 'Översikt' },
  { id: 'status', label: 'Status' },
  { id: 'konto', label: 'Konto' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'futures-exec', label: 'Futures Exec' },
  { id: 'paper-only', label: 'Paper Only' },
  { id: 'teknik', label: 'Teknik' },
];
const SAFE_EXECUTION_PREVIEW_BODY = Object.freeze({
  symbol: 'QQQ',
  action: 'BUY',
  quantity: 1,
  orderType: 'MKT',
  dryRun: true,
  mockOnly: true,
  reason: 'ui_preview_status_no_order',
});

function strategyLabel(row, fallback = '—') {
  return strategyDisplayName(resolveStrategy(row || {}), fallback);
}

function selectedBlueprintStrategyLabel(blueprint, fallback = '—') {
  if (!blueprint) return fallback;
  return `${blueprint.symbol || '—'} · ${strategyLabel(blueprint, '—')}`;
}

function hasOwn(source, key) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function displayField(value, available = true, waitingText = EMPTY_VALUE) {
  if (!available) return waitingText;
  if (!hasValue(value)) return EMPTY_VALUE;
  return typeof value === 'number' ? fmtNumber(value) : String(value);
}

function displayNumberField(source, key, available = true, waitingText = EMPTY_VALUE) {
  if (!available || !hasOwn(source, key)) return waitingText;
  return hasValue(source[key]) ? fmtNumber(source[key]) : EMPTY_VALUE;
}

function displayCountValue(value, available = true, waitingText = EMPTY_VALUE) {
  if (!available) return waitingText;
  return hasValue(value) ? fmtNumber(value) : EMPTY_VALUE;
}

function displayRatio(numerator, numeratorAvailable, denominator, denominatorAvailable, waitingText = EMPTY_VALUE) {
  return `${displayCountValue(numerator, numeratorAvailable, waitingText)}/${displayCountValue(denominator, denominatorAvailable, waitingText)}`;
}

function displayBooleanField(source, key, available = true, waitingText = EMPTY_VALUE) {
  if (!available || !hasOwn(source, key)) return waitingText;
  if (source[key] === true) return 'true';
  if (source[key] === false) return 'false';
  return EMPTY_VALUE;
}

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal, csrfToken, ...fetchOptions } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const headers = new Headers(fetchOptions.headers || {});
      if (csrfToken && !headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', csrfToken);
      }
      return await apiFetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
        credentials: fetchOptions.credentials || 'include',
      });
    }
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      credentials: fetchOptions.credentials || 'include',
    });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const CARD_STYLE = {
  border: '1px solid rgba(148,163,184,0.18)',
  borderRadius: 16,
  padding: 20,
  background: 'var(--surface-2)',
  marginBottom: 16,
};

// Read-only futures-datalager (marknadsdata + paper-konto) — tekniskt
// kontrollrum för IB-dataadaptern. Ingen orderkapabilitet.
function IbFuturesDataStatusCard({ hidden }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let alive = true;
    let controller = null;
    const load = () => {
      if (controller) controller.abort();
      controller = new AbortController();
      fetchJsonWithTimeout('/api/interactive-brokers/futures/status', { signal: controller.signal })
        .then((data) => { if (alive) setState({ loading: false, error: null, data }); })
        .catch((err) => {
          if (alive) setState((prev) => ({ loading: false, error: err?.message || 'futures_status_unavailable', data: prev.data || null }));
        });
    };
    load();
    const timer = setInterval(load, 20000);
    return () => { alive = false; clearInterval(timer); if (controller) controller.abort(); };
  }, []);

  const layer = state.data?.dataLayer || null;
  const adapter = layer?.adapter || null;
  const account = state.data?.paperAccount || null;
  const quotes = layer?.quotes || {};
  const candles = layer?.candles || {};
  const contracts = adapter?.contracts || [];
  const lastError = (adapter?.lastErrors || [])[adapter?.lastErrors?.length - 1] || null;

  return (
    <div hidden={hidden} style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
      <h2 style={{ marginTop: 0 }}>Futures-data (read-only datalager)</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
        IBKR används här för read-only marknadsdata och paper-kontoinformation.
        Inga riktiga order kan skickas från denna integration.
      </p>
      {state.error && !layer ? (
        <div style={{ color: 'var(--warning)' }}>Status kunde inte läsas: {state.error}</div>
      ) : null}
      {layer ? (
        <>
          <Row label="Datalager aktiverat"><Badge ok={layer.enabled === true} labelTrue="Ja" labelFalse="Nej (IB_FUTURES_DATA_ENABLED=false)" /></Row>
          <Row label="API-anslutning"><Badge ok={adapter?.connected === true} labelTrue="Ansluten" labelFalse="Frånkopplad" /></Row>
          <Row label="Host/Port"><code>{adapter ? `${adapter.host}:${adapter.port}` : '–'}</code></Row>
          <Row label="Read-only clientId"><code>{adapter?.clientId ?? '–'}</code></Row>
          <Row label="Server version"><code>{adapter?.serverVersion ?? '–'}</code></Row>
          <Row label="CME market data"><Badge ok={adapter?.marketDataTypeLabel === 'realtime'} labelTrue="realtime" labelFalse={adapter?.marketDataTypeLabel || 'okänd'} /></Row>
          <Row label="Reconnects"><code>{displayCountValue(adapter?.reconnectCount, hasValue(adapter?.reconnectCount))}</code></Row>
          <Row label="Senaste fel"><code>{lastError ? `${lastError.code || ''} ${lastError.message}`.trim() : 'none'}</code></Row>
          <Row label="Kontrakt (front month)">
            <code>
              {contracts.length
                ? contracts.map((c) => `${c.root}=${c.localSymbol} (conId ${c.conId}, exp ${c.expiry})`).join(' · ')
                : 'inga upplösta ännu'}
            </code>
          </Row>
          {['MNQ', 'MES', 'NQ', 'ES'].map((root) => {
            const q = quotes[root];
            const c = candles[root];
            return (
              <Row key={root} label={`${root} quote/candles`}>
                <code>
                  {q ? `last=${q.last ?? '–'} bid=${q.bid ?? '–'} ask=${q.ask ?? '–'} ålder=${q.staleAgeMs != null ? `${Math.round(q.staleAgeMs / 1000)}s` : '–'}` : 'ingen quote'}
                  {c ? ` · 1m-bars=${c.bars1mInMemory} refresh=${c.lastRefreshOk === true ? 'ok' : (c.lastError || 'väntar')}` : ''}
                </code>
              </Row>
            );
          })}
          <Row label="Paper-konto (read-only)">
            {account?.ok === true ? (
              <code>
                {account.account.accountIdMasked} · {account.account.currency || EMPTY_VALUE} · NetLiq {displayCountValue(account.account.netLiquidation, hasValue(account.account.netLiquidation))}
              </code>
            ) : (
              <code>{account?.blocker || 'ej läst ännu'}</code>
            )}
          </Row>
          <Row label="Orderkapabilitet"><Badge ok labelTrue="Saknas (endast data)" labelFalse="-" /></Row>
        </>
      ) : (
        <div style={{ color: 'var(--muted)' }}>Läser futures-datastatus…</div>
      )}
    </div>
  );
}

function Badge({ ok, labelTrue, labelFalse }) {
  const good = ok === true;
  const unknown = ok === null || ok === undefined;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: unknown ? 'rgba(148,163,184,0.12)' : good ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.15)',
        color: unknown ? 'var(--muted)' : good ? 'var(--success)' : 'var(--danger)',
        border: `1px solid ${unknown ? 'rgba(148,163,184,0.3)' : good ? 'rgba(34,197,94,0.4)' : 'rgba(248,113,113,0.4)'}`,
      }}
    >
      {unknown ? WAITING_BROKER : good ? labelTrue : labelFalse}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', gap: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function staleIbExecutionBlocker(blocker, executionStatus = null) {
  if (executionStatus?.executionEnabled !== true) return false;
  return blocker === 'feature_flag_disabled' || blocker === 'ib_paper_execution_disabled';
}

function filterCurrentExecutionBlockers(blockers = [], executionStatus = null) {
  if (!Array.isArray(blockers)) return [];
  return blockers.filter((blocker) => !staleIbExecutionBlocker(blocker, executionStatus));
}

function currentBlockedReason(reason, executionStatus = null) {
  if (staleIbExecutionBlocker(reason, executionStatus)) return null;
  return reason || null;
}

function buildIbPaperReadinessSnapshot({
  loading = true,
  errors = {},
  status = null,
  readiness = null,
  truth = null,
  tradeBlueprint = null,
  executionStatus = null,
  protectivePreflight = null,
  paperPreflightResult = null,
  armStatus = null,
  paperOneShotResult = null,
  previousSnapshot = null,
  selectedBlueprintResolution = null,
  protectiveReadinessStatus = 'idle',
  protectiveReadinessError = null,
}) {
  const protectiveView = protectivePreflight || paperPreflightResult || null;
  const truthExecutionStatus = truth?.ibPaper?.executionStatus || null;
  const truthSelectedBlueprint = truth?.ibPaper?.selectedBlueprint || tradeBlueprint?.selectedBlueprint || null;
  const selectedBlueprint = selectedBlueprintResolution?.blueprint
    || paperOneShotResult?.selectedBlueprint
    || protectiveView?.selectedBlueprint
    || truthSelectedBlueprint
    || previousSnapshot?.selectedBlueprint
    || null;
  const paperAccountId = pickFirstDefined(
    protectiveView?.account?.paperAccountId,
    readiness?.paperAccountId,
    readiness?.paperAccountIdMasked,
    truthExecutionStatus?.paperAccountId,
    truthExecutionStatus?.account?.paperAccountId,
    previousSnapshot?.account?.paperAccountId,
    previousSnapshot?.account?.paperAccountIdMasked,
  );
  const paperAccountIdMasked = pickFirstDefined(
    protectiveView?.account?.paperAccountIdMasked,
    readiness?.paperAccountIdMasked,
    truthExecutionStatus?.paperAccountIdMasked,
    truthExecutionStatus?.account?.paperAccountIdMasked,
    previousSnapshot?.account?.paperAccountIdMasked,
  );
  const account = {
    paperAccountId,
    paperAccountIdMasked,
    accountMode: pickFirstDefined(
      protectiveView?.account?.accountMode,
      readiness?.accountMode,
      truthExecutionStatus?.accountMode,
      previousSnapshot?.account?.accountMode,
      'ib_paper',
    ),
  };
  const selectedBlueprintExists = Boolean(selectedBlueprint?.blueprintId);
  const protectivePathAvailable = protectiveView?.protectivePathAvailable === true
    || previousSnapshot?.protectivePathAvailable === true;
  const protectivePlanReady = protectiveView?.protectivePlanReady === true
    || previousSnapshot?.protectivePlanReady === true;
  const bracketSubmissionPlanReady = protectiveView?.bracketSubmissionPlanReady === true
    || paperOneShotResult?.bracketSubmissionPlanReady === true
    || previousSnapshot?.bracketSubmissionPlanReady === true;
  const bracketOrderCount = numberOrNull(pickFirstDefined(
    protectiveView?.bracketOrderCount,
    paperOneShotResult?.bracketOrderCount,
    previousSnapshot?.bracketOrderCount,
  ));
  const entryOnlyBlocked = protectiveView?.entryOnlyBlocked === true
    || paperOneShotResult?.entryOnlyBlocked === true
    || previousSnapshot?.entryOnlyBlocked === true;
  const helperReady = protectiveView?.protectiveExecutionReady === true
    || protectiveView?.bracketSubmissionPlanReady === true
    || paperOneShotResult?.helperReady === true
    || previousSnapshot?.helperReady === true;
  const executionOpenTradeCount = numberOrNull(executionStatus?.openTradeCount);
  const executionOpenPositionCount = numberOrNull(executionStatus?.openPositionCount);
  const hasOpenOrderTruth = executionOpenTradeCount != null || Array.isArray(executionStatus?.openTrades);
  const hasPositionTruth = executionOpenPositionCount != null || Array.isArray(executionStatus?.openPositions) || Array.isArray(executionStatus?.positions);
  const noOpenOrders = hasOpenOrderTruth
    && (executionOpenTradeCount == null || executionOpenTradeCount === 0)
    && (!Array.isArray(executionStatus?.openTrades) || executionStatus.openTrades.length === 0)
    && (previousSnapshot?.noOpenOrders !== false);
  const noPositions = hasPositionTruth
    && (executionOpenPositionCount == null || executionOpenPositionCount === 0)
    && (!Array.isArray(executionStatus?.openPositions) || executionStatus.openPositions.length === 0)
    && (!Array.isArray(executionStatus?.positions) || executionStatus.positions.length === 0)
    && (previousSnapshot?.noPositions !== false);
  const realSubmitGate = paperOneShotResult?.realSubmitGate
    || previousSnapshot?.realSubmitGate
    || {
      gateReady: helperReady === true && bracketSubmissionPlanReady === true && bracketOrderCount === 3 && entryOnlyBlocked === true,
      gateSource: 'runtime_one_shot_real_submit_gate',
      gateScope: 'single_ib_paper_bracket_order',
      gateOpensRealSubmit: false,
      requiresFinalPhase: '4G-2D',
      blockers: helperReady === true
        ? (selectedBlueprintResolution?.blockers?.length ? selectedBlueprintResolution.blockers : [])
        : ['manual_submit_helper_unavailable'],
      blockedReason: helperReady === true
        ? (selectedBlueprintResolution?.blockedReason || 'real_submit_gate_not_open')
        : 'manual_submit_helper_unavailable',
    };
  const realSubmitGateReady = realSubmitGate?.gateReady === true;
  const realSubmitGateOpensRealSubmit = realSubmitGate?.gateOpensRealSubmit === true;
  const safetyLocked = status?.safety?.actions_allowed === false
    && status?.safety?.can_place_orders === false
    && status?.safety?.live_trading_enabled === false
    && status?.safety?.broker_enabled === false;
  const loadingState = protectiveReadinessStatus === 'loading'
    ? 'loading'
    : protectiveReadinessStatus === 'ready'
      ? 'ready'
      : protectiveReadinessStatus === 'blocked'
        ? 'blocked'
        : protectiveReadinessStatus === 'error'
          ? 'error'
          : (loading === true
            ? 'loading'
            : (errors.protectivePreflight ? 'error' : (protectiveView ? 'ready' : 'idle')));
  const staleState = loadingState !== 'ready' && Boolean(previousSnapshot);
  const blockedReason = paperOneShotResult?.blockedReason
    || protectiveView?.blockedReason
    || realSubmitGate?.blockedReason
    || (loadingState === 'loading' ? 'loading' : (loadingState === 'error' ? protectiveReadinessError || errors.protectivePreflight || 'protective_readiness_error' : (loadingState === 'idle' ? 'protective_readiness_idle' : null)));
  const userMessageSv = paperOneShotResult?.userMessageSv
    || protectiveView?.userMessageSv
    || realSubmitGate?.userMessageSv
    || (loadingState === 'loading' ? 'Laddar IB Paper-status…' : (loadingState === 'idle' ? 'Kör bracket-readiness för att hämta status.' : null));
  const orderSent = paperOneShotResult?.orderSent === true;
  const executed = paperOneShotResult?.executed === true;
  const orderButtonLocked = Boolean(
    loadingState !== 'ready'
    || !selectedBlueprintExists
    || account.paperAccountId !== 'DUQ565596'
    || helperReady !== true
    || bracketSubmissionPlanReady !== true
    || bracketOrderCount !== 3
    || entryOnlyBlocked !== true
    || realSubmitGateReady !== true
    || realSubmitGateOpensRealSubmit === true
    || !noOpenOrders
    || !noPositions
    || safetyLocked !== true
    || paperOneShotResult?.accepted === true
    || paperOneShotResult?.orderSent === true
    || paperOneShotResult?.executed === true
  );

  return {
    loadingState,
    staleState,
    account,
    selectedBlueprint,
    accountMode: account.accountMode,
    symbol: selectedBlueprint?.symbol || previousSnapshot?.symbol || null,
    strategyId: selectedBlueprint?.strategyId || previousSnapshot?.strategyId || null,
    side: selectedBlueprint?.side || previousSnapshot?.side || null,
    quantity: selectedBlueprint?.quantity ?? previousSnapshot?.quantity ?? null,
    entryPrice: selectedBlueprint?.entryPrice ?? selectedBlueprint?.entryReferencePrice ?? previousSnapshot?.entryPrice ?? null,
    stopLoss: selectedBlueprint?.stopLoss ?? selectedBlueprint?.stopLossPrice ?? previousSnapshot?.stopLoss ?? null,
    takeProfit: selectedBlueprint?.takeProfit ?? selectedBlueprint?.takeProfit1 ?? previousSnapshot?.takeProfit ?? null,
    selectedBlueprintResolution,
    blueprintSource: selectedBlueprintResolution?.source || 'none',
    blueprintFallback: selectedBlueprintResolution?.isFallback === true,
    blueprintSafetyStatus: selectedBlueprintResolution?.safetyStatus || 'blocked',
    blueprintLoadStatus: selectedBlueprintResolution?.loadStatus || 'idle',
    blueprintLoadError: selectedBlueprintResolution?.loadError || null,
    safeForDisplay: selectedBlueprintResolution?.safeForDisplay === true,
    safeForBracketPreview: selectedBlueprintResolution?.safeForBracketPreview === true,
    safeForArm: selectedBlueprintResolution?.safeForArm === true,
    safeForSubmit: selectedBlueprintResolution?.safeForSubmit === true,
    selectedBlueprintId: selectedBlueprintResolution?.selectedBlueprintId || null,
    selectedBlueprintBlockers: Array.isArray(selectedBlueprintResolution?.blockers) ? selectedBlueprintResolution.blockers : [],
    selectedBlueprintIdempotencyKey: selectedBlueprintResolution?.idempotencyKey || null,
    protectivePathAvailable,
    protectivePlanReady,
    helperReady,
    bracketSubmissionPlanReady,
    bracketOrderCount,
    entryOnlyBlocked,
    realSubmitGate,
    realSubmitGateReady,
    realSubmitGateOpensRealSubmit,
    noOpenOrders,
    noPositions,
    safetyLocked,
    blockedReason,
    userMessageSv,
    protectiveReadinessStatus,
    protectiveReadinessError,
    orderSent,
    executed,
    orderButtonLocked,
    helperImportStatus: manualPaperHelperAvailable ? 'ok' : 'missing_function',
  };
}

function CandidateCard({ candidate }) {
  const ok = candidate.allowedForIbPaperPreview === true;
  const blockers = Array.isArray(candidate.blockers) ? candidate.blockers : [];
  const strategy = resolveStrategy(candidate);
  return (
    <div
      style={{
        border: `1px solid ${ok ? 'rgba(34,197,94,0.28)' : 'rgba(248,113,113,0.35)'}`,
        borderRadius: 14,
        padding: 14,
        background: ok ? 'rgba(34,197,94,0.06)' : 'rgba(248,113,113,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--text)' }}>
          {candidate.symbol || '—'} · {strategyDisplayName(strategy, '—')}
        </strong>
        <Badge ok={ok} labelTrue="Tillåten" labelFalse="Blockerad" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10, fontSize: 14 }}>
        <div><span style={{ color: 'var(--muted)' }}>Strategi:</span> {strategy.strategyId || '—'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Riktning:</span> {candidate.direction || EMPTY_VALUE}</div>
        <div><span style={{ color: 'var(--muted)' }}>Källa:</span> {candidate.source || '–'}</div>
        <div>
          <span style={{ color: 'var(--muted)' }}>Confidence/score:</span>{' '}
          {candidate.confidence ?? candidate.gateScore ?? '–'}
        </div>
      </div>
      <div style={{ marginTop: 10, color: 'var(--text)', lineHeight: 1.55 }}>
        {candidate.reasonSv || 'Förhandsvisning endast. Inga order skickas ännu.'}
      </div>
      {blockers.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {blockers.map((chip) => (
            <span
              key={chip}
              style={{
                display: 'inline-block',
                padding: '2px 10px',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--danger)',
                border: '1px solid rgba(248,113,113,0.35)',
                background: 'rgba(248,113,113,0.08)',
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BlueprintCard({ blueprint }) {
  const strategy = resolveStrategy(blueprint || {});
  const blueprintReady = blueprint?.blueprintReady === true || blueprint?.readyForFutureIbPaper === true;
  const manualApprovalReady = blueprint?.manualApprovalReady === true;
  const executionReady = blueprint?.executionReady === true;
  const rawBlockers = Array.isArray(blueprint?.blockers) ? blueprint.blockers : [];
  const historicalExecutionBlockers = rawBlockers.filter((blocker) => blocker === 'feature_flag_disabled' || blocker === 'ib_paper_execution_disabled');
  const currentBlockers = rawBlockers.filter((blocker) => !historicalExecutionBlockers.includes(blocker));
  const displayBlockedReason = blueprint?.blockedReason === 'feature_flag_disabled' || blueprint?.blockedReason === 'ib_paper_execution_disabled'
    ? null
    : blueprint?.blockedReason;
  const readyTone = blueprintReady ? 'rgba(34,197,94,0.28)' : 'rgba(248,113,113,0.35)';
  return (
    <div
      style={{
        border: `1px solid ${readyTone}`,
        borderRadius: 14,
        padding: 14,
        background: blueprintReady ? 'rgba(34,197,94,0.06)' : 'rgba(248,113,113,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--text)' }}>
          {blueprint?.symbol || '—'} · {strategyDisplayName(strategy, '—')}
        </strong>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Badge ok={blueprintReady} labelTrue="Blueprint redo" labelFalse="Blueprint blockerad" />
          <Badge ok={manualApprovalReady} labelTrue="Manuell granskning redo" labelFalse="Manuell granskning blockerad" />
          <Badge ok={executionReady} labelTrue="Execution redo" labelFalse="Execution blockerad" />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10, fontSize: 14 }}>
        <div><span style={{ color: 'var(--muted)' }}>Blueprint ID:</span> {blueprint?.blueprintId || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Candidate ID:</span> {blueprint?.candidateId || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Top 3 rank:</span> {blueprint?.top3Rank ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Källa:</span> {blueprint?.top3Source || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Riktning:</span> {blueprint?.direction || EMPTY_VALUE}</div>
        <div><span style={{ color: 'var(--muted)' }}>Side:</span> {blueprint?.side || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Entry:</span> {blueprint?.entryReferencePrice ?? blueprint?.entryPrice ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Stop loss:</span> {blueprint?.stopLoss ?? blueprint?.stopLossPrice ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>TP1:</span> {blueprint?.takeProfit1 ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>TP2:</span> {blueprint?.takeProfit2 ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>RR:</span> {blueprint?.riskReward ?? blueprint?.riskRewardRatio ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Quantity:</span> {blueprint?.quantity ?? '–'} ({blueprint?.quantityStatus || EMPTY_VALUE})</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10, fontSize: 14 }}>
        <div><span style={{ color: 'var(--muted)' }}>Stop loss %:</span> {blueprint?.stopLossPct ?? blueprint?.stopLossDistancePct ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Min stop loss:</span> {blueprint?.minStopLossPct ?? blueprint?.requiredStopLossMinPct ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Risk %:</span> {blueprint?.riskPct ?? '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Risk amount:</span> {blueprint?.riskAmount ?? '–'} {blueprint?.riskAmountCurrency || ''}</div>
        <div><span style={{ color: 'var(--muted)' }}>Estimated notional:</span> {blueprint?.estimatedNotional ?? '–'} {blueprint?.currency || ''}</div>
        <div><span style={{ color: 'var(--muted)' }}>Expires:</span> {blueprint?.expiresAt || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Blueprint ready:</span> {blueprintReady ? 'Ja' : 'Nej'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Manual approval ready:</span> {manualApprovalReady ? 'Ja' : 'Nej'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Execution ready:</span> {executionReady ? 'Ja' : 'Nej'}</div>
      </div>
      <div style={{ marginTop: 10, color: 'var(--text)', lineHeight: 1.55 }}>
        <div>Account mode: {blueprint?.accountMode || 'ib_paper'}</div>
        <div>Order type: {blueprint?.orderType || 'LMT'}</div>
        <div>TIF: {blueprint?.timeInForce || 'DAY'}</div>
        <div>Förhandsvisning endast</div>
        <div>Inga order skapas</div>
        <div>Inga order skickas</div>
        <div>Blueprint only</div>
        {blueprint?.warnings?.length ? <div style={{ marginTop: 8, color: 'var(--blue)' }}>Warnings: {blueprint.warnings.join(', ')}</div> : null}
        {displayBlockedReason ? <div style={{ marginTop: 8, color: 'var(--warning)' }}>BlockedReason: {displayBlockedReason}</div> : null}
        {currentBlockers.length > 0 ? (
          <div style={{ marginTop: 8, color: 'var(--danger)' }}>Blockers: {currentBlockers.join(', ')}</div>
        ) : null}
        {historicalExecutionBlockers.length > 0 ? (
          <div style={{ marginTop: 8, color: 'var(--warning)' }}>Historisk/blueprint-blocker: {historicalExecutionBlockers.join(', ')}</div>
        ) : null}
      </div>
    </div>
  );
}

function ManualApprovalCard({ manualApproval, selectedBlueprint, selectedBlueprintLoadStatus = 'idle' }) {
  const approval = manualApproval || {};
  const hasPendingBlueprints = Array.isArray(approval.pendingBlueprints);
  const pendingCount = hasPendingBlueprints ? approval.pendingBlueprints.length : null;
  const approvalStatusKnown = hasValue(approval.approvalStatus);
  const approvalReady = approvalStatusKnown
    ? (approval.approvalStatus === 'waiting_for_user' || approval.approvalStatus === 'ready_for_future_execution')
    : null;
  const selected = approval.selectedBlueprint || selectedBlueprint || null;
  return (
    <div style={{ border: '1px solid rgba(251,191,36,0.35)', borderRadius: 14, padding: 14, background: 'rgba(251,191,36,0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--text)' }}>Manual approval panel</strong>
        <Badge
          ok={approvalReady}
          labelTrue={approval.approvalStatus}
          labelFalse={approval.approvalStatus || EMPTY_VALUE}
        />
      </div>
      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, fontSize: 14 }}>
        <div><span style={{ color: 'var(--muted)' }}>Required phrase:</span> {approval.requiredConfirmationPhrase || EMPTY_VALUE}</div>
        <div><span style={{ color: 'var(--muted)' }}>Confirmation entered:</span> {approval.confirmationEntered === true ? 'Ja' : approval.confirmationEntered === false ? 'Nej' : EMPTY_VALUE}</div>
        <div><span style={{ color: 'var(--muted)' }}>Approval status:</span> {approval.approvalStatus || EMPTY_VALUE}</div>
        <div><span style={{ color: 'var(--muted)' }}>Pending blueprints:</span> {displayCountValue(pendingCount, hasPendingBlueprints)}</div>
        <div><span style={{ color: 'var(--muted)' }}>Created at:</span> {approval.createdAt || '–'}</div>
        <div><span style={{ color: 'var(--muted)' }}>Expires at:</span> {approval.expiresAt || '–'}</div>
      </div>
      <div style={{ marginTop: 10, color: 'var(--text)', lineHeight: 1.55 }}>
        <div>Selected blueprint: {selected ? selectedBlueprintStrategyLabel(selected) : (selectedBlueprintLoadStatus === 'loading' ? 'Laddar…' : '—')}</div>
        <div>Manual approval required: yes</div>
        <div>Execution remains blocked in this phase.</div>
        {Array.isArray(approval.blockers) && approval.blockers.length > 0 ? (
          <div style={{ marginTop: 8, color: 'var(--danger)' }}>Blockers: {approval.blockers.join(', ')}</div>
        ) : null}
        {Array.isArray(approval.warnings) && approval.warnings.length > 0 ? (
          <div style={{ marginTop: 8, color: 'var(--blue)' }}>Warnings: {approval.warnings.join(', ')}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function InteractiveBrokersPage() {
  const auth = useAuth();
  const csrfToken = auth.csrfToken || null;
  const csrfRequired = auth.authEnabled !== false;
  const [activeTab, setActiveTab] = useState('oversikt');
  const [state, setState] = useState({
    loading: true,
    errors: {
      status: null,
      readiness: null,
      truth: null,
      preview: null,
      orderPreview: null,
      blueprint: null,
      scaffold: null,
      executionStatus: null,
      executionPreview: null,
      gatewayHealth: null,
      protectivePreflight: null,
      armStatus: null,
    },
    status: null,
    readiness: null,
    truth: null,
    preview: null,
    orderPreview: null,
    blueprint: null,
    scaffold: null,
    executionStatus: null,
    executionPreview: null,
    gatewayHealth: null,
    protectivePreflight: null,
    armStatus: null,
  });
  const [confirmationText, setConfirmationText] = useState('');
  const [paperPreflightSubmitting, setPaperPreflightSubmitting] = useState(false);
  const [paperPreflightResult, setPaperPreflightResult] = useState(null);
  const [paperExecutionSubmitting, setPaperExecutionSubmitting] = useState(false);
  const [paperExecutionResult, setPaperExecutionResult] = useState(null);
  const [protectiveReadinessStatus, setProtectiveReadinessStatus] = useState('idle');
  const [protectiveReadinessError, setProtectiveReadinessError] = useState(null);
  const [oneShotConfirmationText, setOneShotConfirmationText] = useState('CONFIRM PAPER TRADE');
  const [oneShotSecondConfirmationText, setOneShotSecondConfirmationText] = useState('CONFIRM FIRST IB PAPER ORDER');
  const [oneShotIdempotencyKey, setOneShotIdempotencyKey] = useState('');
  const [oneShotAckPaperOnly, setOneShotAckPaperOnly] = useState(false);
  const [oneShotAckNoLiveTrading, setOneShotAckNoLiveTrading] = useState(false);
  const [oneShotAckOneOrderOnly, setOneShotAckOneOrderOnly] = useState(false);
  const [oneShotAckBracketOrder, setOneShotAckBracketOrder] = useState(false);
  const [oneShotAckNoRetry, setOneShotAckNoRetry] = useState(false);
  const [manualFinalExecutionCommand, setManualFinalExecutionCommand] = useState('');
  const [paperOneShotSubmitting, setPaperOneShotSubmitting] = useState(false);
  const [paperOneShotResult, setPaperOneShotResult] = useState(null);
  const [armIdempotencyKey, setArmIdempotencyKey] = useState('');
  const [armTtlSeconds, setArmTtlSeconds] = useState(300);
  const [armConfirmationText, setArmConfirmationText] = useState('ARM IB PAPER ONE SHOT');
  const [armSubmitting, setArmSubmitting] = useState(false);
  const [disarmSubmitting, setDisarmSubmitting] = useState(false);
  const [armResult, setArmResult] = useState(null);
  const [finalGateStatusResult, setFinalGateStatus] = useState(null);
  const lastIbPaperSnapshotRef = useRef(null);

  useEffect(() => {
    if (csrfRequired && !csrfToken) return undefined;
    let alive = true;
    let controller = null;

    const load = async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      setProtectiveReadinessStatus('loading');
      setProtectiveReadinessError(null);

      const requests = [
        ['status', fetchJsonWithTimeout('/api/interactive-brokers/status', { signal: controller.signal })],
        ['readiness', fetchJsonWithTimeout('/api/interactive-brokers/connection-readiness', { signal: controller.signal })],
        ['truth', fetchJsonWithTimeout('/api/interactive-brokers/truth', { signal: controller.signal })],
        ['preview', fetchJsonWithTimeout('/api/interactive-brokers/approved-strategies-preview', { signal: controller.signal })],
        ['orderPreview', fetchJsonWithTimeout('/api/interactive-brokers/order-preview', { signal: controller.signal })],
        ['blueprint', fetchJsonWithTimeout('/api/interactive-brokers/trade-blueprint', { signal: controller.signal })],
        ['scaffold', fetchJsonWithTimeout('/api/interactive-brokers/dry-run-scaffold', { signal: controller.signal })],
        ['executionStatus', fetchJsonWithTimeout('/api/interactive-brokers/execution-status', { signal: controller.signal })],
        ['futuresExecutionStatus', fetchJsonWithTimeout('/api/interactive-brokers/paper-execution/futures-status', { signal: controller.signal })],
        ['gatewayHealth', fetchJsonWithTimeout('/api/interactive-brokers/gateway-health', { signal: controller.signal })],
        ['executionPreview', fetchJsonWithTimeout('/api/interactive-brokers/paper-execution-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(SAFE_EXECUTION_PREVIEW_BODY),
          csrfToken,
          signal: controller.signal,
        })],
      ];

      const settled = await Promise.allSettled(requests.map(([, promise]) => promise));
      if (!alive) return;

      const next = {
        loading: false,
        errors: {
          status: null,
          readiness: null,
          truth: null,
          preview: null,
          orderPreview: null,
          blueprint: null,
          scaffold: null,
          executionStatus: null,
          futuresExecutionStatus: null,
          executionPreview: null,
          gatewayHealth: null,
          protectivePreflight: null,
          armStatus: null,
          finalGateStatus: null,
        },
        status: null,
        readiness: null,
        truth: null,
        preview: null,
        orderPreview: null,
        blueprint: null,
        scaffold: null,
        executionStatus: null,
        futuresExecutionStatus: null,
        executionPreview: null,
        gatewayHealth: null,
        protectivePreflight: null,
        armStatus: null,
        finalGateStatus: null,
      };

      settled.forEach((result, index) => {
        const [key] = requests[index];
        if (result.status === 'fulfilled') {
          next[key] = result.value;
        } else {
          const mapped = key === 'protectivePreflight'
            ? mapBracketReadinessHttpError(result.reason?.status, result.reason?.message)
            : null;
          next.errors[key] = mapped?.blockedReason || result.reason?.message || String(result.reason || 'fetch_failed');
          if (key === 'protectivePreflight') {
            setProtectiveReadinessStatus(mapped?.status || 'error');
            setProtectiveReadinessError(mapped?.blockedReason || result.reason?.message || String(result.reason || 'fetch_failed'));
          }
        }
      });
      const loadedExecutionPreview = next.executionPreview || null;
      if (loadedExecutionPreview?.preflight?.bracketSubmissionPlanReady === true) {
        setProtectiveReadinessStatus('ready');
        setProtectiveReadinessError(null);
      } else if (loadedExecutionPreview?.preflight?.blockedReason) {
        setProtectiveReadinessStatus('blocked');
        setProtectiveReadinessError(loadedExecutionPreview.preflight.blockedReason);
      } else if (next.errors.executionPreview) {
        setProtectiveReadinessStatus('error');
        setProtectiveReadinessError(next.errors.executionPreview);
      } else {
        setProtectiveReadinessStatus('idle');
        setProtectiveReadinessError(null);
      }

      setState(next);
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      if (controller) controller.abort();
      clearInterval(timer);
    };
  }, [csrfRequired, csrfToken]);

  const {
    loading,
    errors,
    status,
    readiness,
    truth,
    preview,
    orderPreview,
    blueprint,
    scaffold,
    executionStatus,
    futuresExecutionStatus,
    executionPreview,
    gatewayHealth,
    protectivePreflight,
    armStatus,
    finalGateStatus,
  } = state;

  const hasAnyError = Boolean(errors.status || errors.readiness || errors.truth || errors.preview || errors.orderPreview || errors.blueprint || errors.scaffold || errors.executionStatus || errors.futuresExecutionStatus || errors.executionPreview || errors.gatewayHealth || errors.protectivePreflight);
  const statusView = status || {};
  const gatewayHealthView = gatewayHealth || {};
  const conn = readiness || {};
  const safety = statusView.safety || {};
  const ib = statusView.ibPaper || {};
  const nextPhase = statusView.nextPhaseLocked || {};
  const truthView = truth || {};
  const truthTopStrategies = Array.isArray(truthView?.topStrategies?.topStrategies) ? truthView.topStrategies.topStrategies : [];
  const truthAllowlist = truthView?.allowlist || {};
  const truthReadiness = truthView?.candidateReadiness || {};
  const truthExecutionStatus = truthView?.ibPaper?.executionStatus || null;
  const truthManualApproval = truthView?.ibPaper?.manualApproval || null;
  const strategies = Array.isArray(truthAllowlist?.allowlist) && truthAllowlist.allowlist.length
    ? truthAllowlist.allowlist
    : Array.isArray(preview?.approvedStrategies) ? preview.approvedStrategies : [];
  const sourceStatus = preview?.approvedStrategiesSource?.status || (errors.preview ? 'degraded' : null);
  const sourceDegraded = sourceStatus === 'degraded' || Boolean(preview?.degraded) || Boolean(errors.preview);
  const statusBlockedReason = statusView.blockedReason || EMPTY_VALUE;
  const hasStatusSnapshot = Boolean(status);
  const hasTruthSnapshot = Boolean(truth);
  const hasOrderPreviewSnapshot = Boolean(orderPreview);
  const hasScaffoldSnapshot = Boolean(scaffold);
  const hasTradeBlueprintSnapshot = Boolean(blueprint);
  const hasExecutionStatusSnapshot = Boolean(executionStatus);
  const hasFuturesExecutionStatusSnapshot = Boolean(futuresExecutionStatus);
  const hasGatewayHealthSnapshot = Boolean(gatewayHealth);
  const hasReadinessSnapshot = Boolean(readiness);
  const hasFinalGateStatusSnapshot = Boolean(finalGateStatus);
  const ibPreview = orderPreview || {};
  const previewSummary = ibPreview.summary || {};
  const previewCandidates = Array.isArray(ibPreview.candidates) ? ibPreview.candidates : [];
  const visibleAllowedCandidates = previewCandidates.filter((candidate) => candidate.allowedForIbPaperPreview === true);
  const allowedPreviewCandidates = visibleAllowedCandidates.slice(0, PREVIEW_LIMIT);
  const blockedPreviewCandidates = Array.isArray(ibPreview.blockedCandidates)
    ? ibPreview.blockedCandidates
    : previewCandidates.filter((candidate) => candidate.allowedForIbPaperPreview !== true);
  const allowedCount = numberOrNull(previewSummary.allowedCandidates);
  const blockedCount = numberOrNull(previewSummary.blockedCandidates);
  const stopLossMinPct = numberOrNull(previewSummary.requiredStopLossMinPct ?? ibPreview.requiredStopLossMinPct);
  const stopLossMinPctText = stopLossMinPct == null ? EMPTY_VALUE : `${fmtNumber(stopLossMinPct, 2)}%`;
  const stopLossPolicy = hasOrderPreviewSnapshot ? (previewSummary.stopLossPolicy || ibPreview.stopLossPolicy || EMPTY_VALUE) : EMPTY_VALUE;
  const tradeBlueprintView = blueprint || {};
  const tradeBlueprintSummary = tradeBlueprintView.summary || {};
  const tradeBlueprints = Array.isArray(tradeBlueprintView.blueprints) ? tradeBlueprintView.blueprints : [];
  const readyBlueprints = tradeBlueprints.filter((row) => row.readyForFutureIbPaper === true);
  const scaffoldView = scaffold || {};
  const scaffoldSummary = scaffoldView.summary || {};
  const scaffoldSteps = Array.isArray(scaffoldView.steps) ? scaffoldView.steps : [];
  const scaffoldPrimary = scaffoldView.primaryCandidate || null;
  const scaffoldBlueprints = Array.isArray(scaffoldView.candidateBlueprints) ? scaffoldView.candidateBlueprints : [];
  const executionStatusView = executionStatus || {};
  const futuresExecutionStatusView = futuresExecutionStatus || null;
  const executionPreviewView = executionPreview || {};
  const executionStatusBlockers = filterCurrentExecutionBlockers(executionStatusView.blockers, executionStatusView);
  const executionStatusBlockedReason = currentBlockedReason(executionStatusView.blockedReason || executionStatusView.disableReason, executionStatusView);
  const previewVerified = executionPreviewView.dryRun === true
    && executionPreviewView.mockOnly === true
    && executionPreviewView.wouldPlaceOrder === false
    && executionPreviewView.orderSent === false
    && executionPreviewView.placeOrderCalled === false
    && executionPreviewView.realSubmitAllowed === false;
  const previewPreflight = executionPreviewView?.preflight || null;
  const previewAsProtectivePreflight = previewPreflight ? {
    ok: executionPreviewView.ok === true,
    preflightOnly: true,
    dryRun: true,
    orderSent: false,
    executed: false,
    protectivePathAvailable: true,
    protectivePlanReady: previewPreflight.bracketSubmissionPlanReady === true,
    bracketSubmissionPlanReady: previewPreflight.bracketSubmissionPlanReady === true,
    bracketSubmissionRealSubmitEnabled: false,
    bracketOrderCount: numberOrNull(previewPreflight.bracketOrderCount),
    entryOnlyBlocked: previewPreflight.entryOnlyBlocked === true,
    blockedReason: previewPreflight.blockedReason || executionPreviewView.blockedReason || null,
    blockers: previewPreflight.blockers || executionPreviewView.blockers || [],
    summary: previewPreflight.summary || null,
    userMessageSv: 'Preview verifierad: bracket-helper är read-only/mock och skickar ingen order.',
    uiStatus: {
      orderButtonLocked: true,
      blockedReason: previewPreflight.blockedReason || executionPreviewView.blockedReason || null,
      userMessageSv: 'Paper-route aktiv, submit låst.',
    },
  } : null;
  const protectivePreflightView = protectivePreflight || paperPreflightResult || previewAsProtectivePreflight || null;
  const protectivePlanSummary = protectivePreflightView?.protectiveSummary || protectivePreflightView?.summary || null;
  const protectivePlan = protectivePreflightView?.protectiveOrderPlan || protectivePreflightView?.plan || null;
  const protectivePlanChecks = Array.isArray(protectivePreflightView?.protectiveOrderChecks)
    ? protectivePreflightView.protectiveOrderChecks
    : Array.isArray(protectivePreflightView?.checks) ? protectivePreflightView.checks : [];
  const protectivePlanBlockedReason = protectivePreflightView?.blockedReason || protectivePlanSummary?.blockedReason || null;
  const protectivePresentationStatus = protectivePreflightView?.uiStatus || null;
  const oneShotPresentationStatus = paperOneShotResult?.uiStatus || protectivePresentationStatus;
  const protectivePathAvailable = protectivePreflightView?.protectivePathAvailable === true;
  const protectivePlanReady = protectivePreflightView?.protectivePlanReady === true;
  const bracketSubmissionPlanReady = protectivePreflightView?.bracketSubmissionPlanReady === true;
  const bracketSubmissionRealSubmitEnabled = false;
  const bracketOrderCount = numberOrNull(protectivePreflightView?.bracketOrderCount);
  const bracketEntryOnlyBlocked = protectivePreflightView?.entryOnlyBlocked === true;
  const bracketPresentationBlockedReason = oneShotPresentationStatus?.blockedReason
    || protectivePreflightView?.bracketBlockedReason
    || protectivePlanBlockedReason
    || null;
  const bracketPresentationMessage = oneShotPresentationStatus?.userMessageSv
    || protectivePreflightView?.userMessageSv
    || (bracketSubmissionPlanReady === true
      ? '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.'
      : 'Kan inte skicka order: komplett bracket-/skyddsorder saknas.');
  const bracketPresentationButtonLocked = oneShotPresentationStatus?.orderButtonLocked !== false;
  const armStatusView = armStatus || {};
  const armCurrent = armStatusView?.currentArm || null;
  const finalGateStatusView = finalGateStatusResult || {};
  const finalGateArmView = finalGateStatusView?.oneShotArm || {};
  const blueprintLoadStatus = errors.blueprint
    ? (errors.blueprint.includes('timeout_after_') ? 'timeout' : (errors.blueprint.includes('HTTP 404') ? 'not_found' : 'error'))
    : (blueprint ? 'ok' : (loading ? 'loading' : 'idle'));
  const selectedBlueprintResolution = resolveStableSelectedIbPaperBlueprint({
    tradeBlueprint: tradeBlueprintView,
    canonicalTruth: truthView,
    preview,
    scaffold: scaffoldView,
    paperPreflightResult,
    protectivePreflight: protectivePreflightView,
    lastStableSelectedBlueprint: lastIbPaperSnapshotRef.current?.selectedBlueprint || null,
    tradeBlueprintLoadStatus: blueprintLoadStatus,
    tradeBlueprintLoadError: errors.blueprint || null,
  });
  const selectedPaperBlueprint = selectedBlueprintResolution.blueprint || null;
  useEffect(() => {
    if (!selectedPaperBlueprint?.blueprintId || selectedBlueprintResolution.safeForArm !== true) return;
    setOneShotIdempotencyKey((current) => {
      if (current) return current;
      return `ibpo_${selectedPaperBlueprint.blueprintId}_${Date.now()}`;
    });
  }, [selectedPaperBlueprint?.blueprintId, selectedBlueprintResolution.safeForArm]);
  useEffect(() => {
    if (!selectedPaperBlueprint?.blueprintId || selectedBlueprintResolution.safeForArm !== true) return;
    setArmIdempotencyKey((current) => {
      if (current) return current;
      return `ibpa_${selectedPaperBlueprint.blueprintId}_${Date.now()}`;
    });
  }, [selectedPaperBlueprint?.blueprintId, selectedBlueprintResolution.safeForArm]);
  const preflightSubmitDisabled = !selectedPaperBlueprint || paperPreflightSubmitting || confirmationText !== 'CONFIRM PAPER TRADE';
  const paperExecutionSubmitDisabled = true;
  const oneShotPanelReady = paperPreflightResult?.readyForFirstPaperOrder === true
    && protectivePlanReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3;
  const oneShotInputsReady = selectedPaperBlueprint
    && oneShotConfirmationText === 'CONFIRM PAPER TRADE'
    && oneShotSecondConfirmationText === 'CONFIRM FIRST IB PAPER ORDER'
    && Boolean(oneShotIdempotencyKey)
    && oneShotAckPaperOnly === true
    && oneShotAckNoLiveTrading === true
    && oneShotAckOneOrderOnly === true;
  const oneShotSubmitDisabled = true;
  const armPanelReady = protectivePathAvailable === true
    && protectivePlanReady === true
    && bracketSubmissionPlanReady === true
    && paperPreflightResult?.readyForFirstPaperOrder === true;
  const armInputsReady = selectedPaperBlueprint
    && armConfirmationText === 'ARM IB PAPER ONE SHOT'
    && oneShotConfirmationText === 'CONFIRM PAPER TRADE'
    && oneShotSecondConfirmationText === 'CONFIRM FIRST IB PAPER ORDER'
    && Boolean(armIdempotencyKey)
    && oneShotAckPaperOnly === true
    && oneShotAckNoLiveTrading === true
    && oneShotAckOneOrderOnly === true
    && oneShotAckBracketOrder === true
    && oneShotAckNoRetry === true;
  const armSubmitDisabled = true;
  const ibPaperSnapshot = buildIbPaperReadinessSnapshot({
    loading,
    errors,
    status: statusView,
    readiness: conn,
    truth: truthView,
    tradeBlueprint: tradeBlueprintView,
    executionStatus: executionStatusView,
    protectivePreflight: protectivePreflightView,
    paperPreflightResult,
    armStatus: armStatusView,
    paperOneShotResult,
    previousSnapshot: lastIbPaperSnapshotRef.current,
    selectedBlueprintResolution,
    protectiveReadinessStatus,
    protectiveReadinessError,
  });
  useEffect(() => {
    if (ibPaperSnapshot.loadingState === 'ready' || (!lastIbPaperSnapshotRef.current && ibPaperSnapshot.account?.paperAccountId)) {
      lastIbPaperSnapshotRef.current = ibPaperSnapshot;
    }
  }, [ibPaperSnapshot]);
  const stableIbPaperSnapshot = ibPaperSnapshot.loadingState === 'ready'
    ? ibPaperSnapshot
    : (lastIbPaperSnapshotRef.current ? {
        ...lastIbPaperSnapshotRef.current,
        loadingState: ibPaperSnapshot.loadingState,
        staleState: true,
        blockedReason: ibPaperSnapshot.blockedReason,
        userMessageSv: ibPaperSnapshot.userMessageSv,
        orderButtonLocked: true,
      } : ibPaperSnapshot);
  const manualPaperBracketSubmitState = manualPaperHelperAvailable
    ? buildManualPaperBracketSubmitState({
      selectedBlueprint: stableIbPaperSnapshot.selectedBlueprint || selectedPaperBlueprint,
      selectedBlueprintSource: selectedBlueprintResolution.source,
      safeForDisplay: selectedBlueprintResolution.safeForDisplay,
      safeForBracketPreview: selectedBlueprintResolution.safeForBracketPreview,
      safeForArm: selectedBlueprintResolution.safeForArm,
      safeForSubmit: selectedBlueprintResolution.safeForSubmit,
      blueprintLoadStatus: selectedBlueprintResolution.loadStatus,
      blueprintLoadError: selectedBlueprintResolution.loadError,
      executionStatus: executionStatusView,
      paperPreflightResult: {
        account: stableIbPaperSnapshot.account,
        protectiveExecutionReady: stableIbPaperSnapshot.helperReady === true,
        bracketSubmissionPlanReady: stableIbPaperSnapshot.bracketSubmissionPlanReady === true,
        bracketOrderCount: numberOrNull(stableIbPaperSnapshot.bracketOrderCount),
        entryOnlyBlocked: stableIbPaperSnapshot.entryOnlyBlocked === true,
      },
      realSubmitGate: stableIbPaperSnapshot.realSubmitGate || null,
      armStatus: paperOneShotResult?.armStatus || armStatusView,
      armIdempotencyKey,
      lastResult: paperOneShotResult,
      confirmationPhrase: oneShotConfirmationText,
      secondConfirmationPhrase: oneShotSecondConfirmationText,
      armConfirmationPhrase: armConfirmationText,
      finalExecutionCommand: manualFinalExecutionCommand,
      acknowledgePaperOnly: oneShotAckPaperOnly,
      acknowledgeNoLiveTrading: oneShotAckNoLiveTrading,
      acknowledgeOneOrderOnly: oneShotAckOneOrderOnly,
      acknowledgeBracketOrder: oneShotAckBracketOrder,
      acknowledgeNoRetry: oneShotAckNoRetry,
      globalSafety: safety,
      isSubmitting: paperOneShotSubmitting,
    })
    : {
      accountMode: 'ib_paper',
      account: stableIbPaperSnapshot.account?.paperAccountIdMasked || stableIbPaperSnapshot.account?.paperAccountId || 'Laddar…',
      symbol: stableIbPaperSnapshot.symbol || selectedPaperBlueprint?.symbol || '',
      strategyId: stableIbPaperSnapshot.strategyId || selectedPaperBlueprint?.strategyId || '',
      side: stableIbPaperSnapshot.side || selectedPaperBlueprint?.side || '',
      quantity: stableIbPaperSnapshot.quantity || selectedPaperBlueprint?.quantity || null,
      entryPrice: stableIbPaperSnapshot.entryPrice || selectedPaperBlueprint?.entryPrice || selectedPaperBlueprint?.entryReferencePrice || null,
      stopLoss: stableIbPaperSnapshot.stopLoss || selectedPaperBlueprint?.stopLoss || selectedPaperBlueprint?.stopLossPrice || null,
      takeProfit: stableIbPaperSnapshot.takeProfit || selectedPaperBlueprint?.takeProfit || selectedPaperBlueprint?.takeProfit1 || null,
      helperReady: false,
      safeForBracketPreview: false,
      bracketSubmissionPlanReady: false,
      bracketOrderCount: null,
      entryOnlyBlocked: false,
      gateReadyPreview: false,
      realSubmitGateReady: false,
      realSubmitGateOpensRealSubmit: false,
      safetyLocked: false,
      finalCommandMatches: false,
      phrasesReady: false,
      acknowledgementsReady: false,
      noOpenOrders: true,
      noPositions: true,
      selectedBlueprintExists: Boolean(selectedPaperBlueprint),
      armIdempotencyKey,
      blockers: ['manual_submit_helper_unavailable'],
      buttonDisabled: true,
    };
  const manualPaperHelperImportStatus = manualPaperHelperAvailable ? 'ok' : 'missing_function';
  const manualPaperGateView = paperOneShotResult?.realSubmitGate || stableIbPaperSnapshot.realSubmitGate || {
    gateReady: manualPaperBracketSubmitState.gateReadyPreview === true,
    gateSource: 'runtime_one_shot_real_submit_gate',
    gateScope: 'single_ib_paper_bracket_order',
    gateOpensRealSubmit: false,
    requiresFinalPhase: '4G-2D',
    blockers: manualPaperBracketSubmitState.blockers,
    blockedReason: manualPaperBracketSubmitState.blockers[0] || 'manual_user_initiated_required',
  };
  const manualArmStatusView = paperOneShotResult?.armStatus || armStatusView;
  const manualPaperBracketSubmitDisabled = manualPaperBracketSubmitState.buttonDisabled;
  const manualPaperLoading = stableIbPaperSnapshot.loadingState === 'loading';
  const manualPaperIdle = stableIbPaperSnapshot.loadingState === 'idle';
  const resolvedPaperAccountId = pickFirstDefined(
    conn.paperAccountId,
    executionStatusView?.paperAccountId,
    stableIbPaperSnapshot.account?.paperAccountIdMasked,
    stableIbPaperSnapshot.account?.paperAccountId,
  );
  const gatewayConnected = gatewayHealthView.connected === true || gatewayHealthView.authenticated === true;
  const gatewayStatus = !hasGatewayHealthSnapshot
    ? WAITING_BROKER
    : gatewayConnected
    ? 'Ansluten'
    : gatewayHealthView.gatewayProcessRunning === true
      ? 'Aktiv'
      : 'Inaktiv';
  const connectionStatus = hasReadinessSnapshot ? (conn.status || (conn.gatewayReachable === true ? 'reachable' : EMPTY_VALUE)) : WAITING_BROKER;
  const brokerEnabled = hasStatusSnapshot && hasOwn(safety, 'broker_enabled') ? safety.broker_enabled : null;
  const liveTradingEnabled = hasStatusSnapshot && hasOwn(safety, 'live_trading_enabled') ? safety.live_trading_enabled : null;
  const canPlaceOrders = hasStatusSnapshot && hasOwn(safety, 'can_place_orders') ? safety.can_place_orders : null;
  const safetyMode = hasStatusSnapshot && hasOwn(safety, 'mode') ? safety.mode : null;
  const kpis = [
    {
      label: 'Gateway-status',
      value: gatewayStatus,
      hint: !hasGatewayHealthSnapshot ? WAITING_BROKER : gatewayHealthView.lastCheckedAt
        ? `Kontrollerad ${new Date(gatewayHealthView.lastCheckedAt).toLocaleString('sv-SE')}`
        : 'Ingen färsk kontrolltid',
      tone: !hasGatewayHealthSnapshot ? 'warning' : gatewayConnected ? 'good' : gatewayHealthView.gatewayProcessRunning ? 'warning' : 'danger',
    },
    {
      label: 'Broker enabled',
      value: displayBooleanField(safety, 'broker_enabled', hasStatusSnapshot, WAITING_BROKER),
      hint: brokerEnabled === true ? 'Kontrollera safety' : brokerEnabled === false ? 'Broker är avstängd' : WAITING_BROKER,
      tone: brokerEnabled === true ? 'danger' : brokerEnabled === false ? 'good' : 'warning',
    },
    {
      label: 'Live trading',
      value: displayBooleanField(safety, 'live_trading_enabled', hasStatusSnapshot, WAITING_BROKER),
      hint: liveTradingEnabled === true ? 'Kontrollera safety' : liveTradingEnabled === false ? 'Live trading är avstängd' : WAITING_BROKER,
      tone: liveTradingEnabled === true ? 'danger' : liveTradingEnabled === false ? 'good' : 'warning',
    },
    {
      label: 'Paper-only status',
      value: safetyMode || WAITING_BROKER,
      hint: `orders=${displayBooleanField(safety, 'can_place_orders', hasStatusSnapshot, WAITING_BROKER)}`,
      tone: safetyMode === 'paper_only' && canPlaceOrders === false ? 'good' : 'warning',
    },
    {
      label: 'Paper account',
      value: resolvedPaperAccountId || (hasExecutionStatusSnapshot || hasReadinessSnapshot ? EMPTY_VALUE : WAITING_BROKER),
      hint: hasExecutionStatusSnapshot ? (executionStatusView.paperAccountVerified === true ? 'Verifierat paper-konto' : 'Inte verifierat') : WAITING_BROKER,
      tone: hasExecutionStatusSnapshot && executionStatusView.paperAccountVerified === true ? 'blue' : 'warning',
    },
    {
      label: 'Connection / sync',
      value: connectionStatus,
      hint: hasExecutionStatusSnapshot ? (executionStatusView.ibApiVerified === true ? 'IB API verifierat' : 'IB API ej verifierat') : WAITING_BROKER,
      tone: hasReadinessSnapshot && conn.gatewayReachable === true && hasExecutionStatusSnapshot && executionStatusView.ibApiVerified === true ? 'good' : 'warning',
    },
  ];
  const tradingEventStore = useMemo(() => createTradingEventStore({
    runtimeSnapshot: {
      ...(status || {}),
      truth,
      orderPreview,
      blueprint,
      scaffold,
      gatewayHealth,
    },
    executionSnapshot: {
      ...(executionStatus || {}),
      futuresExecutionStatus,
      executionPreview,
      protectivePreflight,
      armStatus,
      finalGateStatus,
    },
    strategyOverview: strategies,
    candidateQueue: { candidates: previewCandidates },
    events: [
      ...tradeBlueprints,
      ...scaffoldSteps,
      ...scaffoldBlueprints,
    ],
  }), [
    armStatus,
    blueprint,
    executionPreview,
    executionStatus,
    finalGateStatus,
    futuresExecutionStatus,
    gatewayHealth,
    orderPreview,
    previewCandidates,
    protectivePreflight,
    scaffold,
    scaffoldBlueprints,
    scaffoldSteps,
    status,
    strategies,
    tradeBlueprints,
    truth,
  ]);
  const tradingEventCount = tradingEventStore.getAllEvents().length;
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    runtimeSnapshot: status || {},
    executionSnapshot: executionStatus || {},
    decisions: [
      ...tradeBlueprints,
      ...scaffoldSteps,
      ...scaffoldBlueprints,
    ],
  }), [executionStatus, scaffoldBlueprints, scaffoldSteps, status, tradeBlueprints, tradingEventStore]);
  const decisionCount = decisionStore.getDecisions().length;

  async function handlePaperPreflight() {
    setPaperPreflightSubmitting(true);
    setProtectiveReadinessStatus('loading');
    setProtectiveReadinessError(null);
    try {
      const previewPayload = await fetchJsonWithTimeout('/api/interactive-brokers/paper-execution-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAFE_EXECUTION_PREVIEW_BODY),
        csrfToken,
      });
      setPaperPreflightResult(previewPayload);
      setState((current) => ({
        ...current,
        executionPreview: previewPayload,
        protectivePreflight: null,
        errors: {
          ...current.errors,
          executionPreview: null,
          protectivePreflight: null,
        },
      }));
      setProtectiveReadinessStatus(previewPayload?.preflight?.bracketSubmissionPlanReady === true ? 'ready' : 'blocked');
      setProtectiveReadinessError(null);
    } catch (err) {
      const message = err?.message || 'paper_preflight_failed';
      setPaperPreflightResult({ ok: false, error: message });
      setProtectiveReadinessStatus('error');
      setProtectiveReadinessError(message);
    } finally {
      setPaperPreflightSubmitting(false);
    }
  }

  async function handleBracketReadiness() {
    setProtectiveReadinessStatus('loading');
    setProtectiveReadinessError(null);
    try {
      const payload = await fetchJsonWithTimeout('/api/interactive-brokers/paper-execution-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAFE_EXECUTION_PREVIEW_BODY),
        csrfToken,
      });
      setState((current) => ({
        ...current,
        executionPreview: payload,
        protectivePreflight: null,
        errors: {
          ...current.errors,
          executionPreview: null,
          protectivePreflight: null,
        },
      }));
      setProtectiveReadinessStatus(payload?.preflight?.bracketSubmissionPlanReady === true ? 'ready' : 'blocked');
      setProtectiveReadinessError(null);
    } catch (err) {
      setState((current) => ({
        ...current,
        executionPreview: {
          ok: false,
          previewOnly: true,
          preflightOnly: true,
          dryRun: true,
          wouldPlaceOrder: false,
          orderSent: false,
          executed: false,
          submitted: false,
          placeOrderCalled: false,
          submitFunctionCalled: false,
          finalGateArmCreated: false,
          realSubmitAllowed: false,
          allowRealSubmit: false,
          mockOnly: true,
          httpStatus: err?.status || null,
          blockedReason: err?.message || 'preview_status_error',
          blockers: [err?.message || 'preview_status_error'],
          error: err?.message || 'preview_status_error',
        },
        errors: {
          ...current.errors,
          executionPreview: err?.message || 'preview_status_error',
        },
      }));
      setProtectiveReadinessStatus('error');
      setProtectiveReadinessError(err?.message || 'preview_status_error');
    }
  }

  async function handlePaperExecute() {
    setPaperExecutionResult({
      ok: false,
      blockedReason: 'ui_real_submit_locked',
      submitted: false,
      executed: false,
      orderSent: false,
      orderSendingBlocked: true,
    });
  }

  async function handlePaperOneShotExecute() {
    setPaperOneShotResult({
      ok: false,
      accepted: false,
      blockedReason: 'ui_real_submit_locked',
      orderSent: false,
      executed: false,
      submitted: false,
      realSubmitAllowed: false,
      finalGateArmCreated: false,
    });
  }

  async function handleArmOneShot() {
    setArmResult({
      ok: false,
      accepted: false,
      armed: false,
      blockedReason: 'ui_final_gate_arm_locked',
    });
  }

  async function handleDisarmOneShot() {
    setArmResult({
      ok: false,
      accepted: false,
      armed: false,
      blockedReason: 'ui_final_gate_arm_not_active',
    });
  }

  function formatDirection(value) {
    if (!value) return 'Okänd';
    const raw = String(value).toLowerCase();
    if (raw === 'long') return 'Lång';
    if (raw === 'short') return 'Kort';
    return value;
  }

  return (
    <DashboardShell
      title="Interactive Brokers Paper"
      subtitle="Status, gateway och befintlig IB Paper-data i ett paper-only kontrollrum. Ingen live trading aktiveras här."
      safety={safety}
      tabs={IBKR_TABS}
      activeTab={activeTab}
      onTab={setActiveTab}
      kpis={kpis}
    >
    <div className="ibkr-dashboard" data-trading-event-count={tradingEventCount} data-decision-count={decisionCount}>
      {loading && <div style={CARD_STYLE}>Laddar…</div>}
      {!loading && hasAnyError && (
        <div style={{ ...CARD_STYLE, borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.06)' }}>
          <strong style={{ color: 'var(--warning)' }}>Vissa IB-sektioner kunde inte laddas just nu. Sidan visar partiella värden där det går.</strong>
        </div>
      )}

      {!loading && (
        <>
          <div hidden={activeTab !== 'konto'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Paper-konto</h2>
            {resolvedPaperAccountId || (Array.isArray(conn.managedAccounts) && conn.managedAccounts.length) ? (
              <>
	                <Row label="Paper account">
	                  <code>{resolvedPaperAccountId || (hasReadinessSnapshot || hasExecutionStatusSnapshot ? EMPTY_VALUE : WAITING_BROKER)}</code>
	                </Row>
	                <Row label="Account mode">
	                  <code>{hasReadinessSnapshot || hasExecutionStatusSnapshot ? (stableIbPaperSnapshot.accountMode || conn.accountMode || EMPTY_VALUE) : WAITING_BROKER}</code>
	                </Row>
	                <Row label="Managed accounts">
	                  <code>{hasReadinessSnapshot ? (Array.isArray(conn.managedAccounts) && conn.managedAccounts.length ? conn.managedAccounts.join(', ') : EMPTY_VALUE) : WAITING_BROKER}</code>
                </Row>
	                <Row label="Paper account verified">
	                  <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.paperAccountVerified === true : null} labelTrue="Ja" labelFalse="Nej" />
	                </Row>
	                <Row label="Paper session verified">
	                  <Badge ok={hasReadinessSnapshot ? conn.paperModeVerified === true : null} labelTrue="Ja" labelFalse="Nej" />
	                </Row>
              </>
            ) : (
              <EmptyState text="Ingen IBKR paper-kontodata är tillgänglig ännu." />
            )}
          </div>

          <div hidden={activeTab !== 'oversikt'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>IB Paper Control Room</h2>
            {errors.status && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                API-status kunde inte laddas. Detalj: {errors.status}
              </div>
            )}
	            <Row label="IB Paper API">
	              <Badge ok={hasReadinessSnapshot && hasExecutionStatusSnapshot ? conn.gatewayReachable === true && executionStatusView.ibApiVerified === true && executionStatusView.paperAccountVerified === true && executionStatusView.readinessProfile?.sessionVerified !== false : null} labelTrue="Verifierad" labelFalse="Ej verifierad" />
	            </Row>
	            <Row label="Paper account">
	              <code>{conn.paperAccountId || executionStatusView.readinessProfile?.paperAccountId || resolvedPaperAccountId || (hasReadinessSnapshot || hasExecutionStatusSnapshot ? EMPTY_VALUE : WAITING_BROKER)}</code>
	            </Row>
	            <Row label="Gateway TCP reachable">
	              <Badge ok={hasReadinessSnapshot ? conn.gatewayReachable === true : null} labelTrue="Ja" labelFalse={conn.gatewayReachable === null ? 'Okänt' : 'Nej'} />
	            </Row>
	            <Row label="IB API verified">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.ibApiVerified === true : null} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
	            <Row label="Paper account verified">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.paperAccountVerified === true : null} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
	            <Row label="IB Paper execution feature">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.executionEnabled === true : null} labelTrue="Aktiv" labelFalse="Av" />
	            </Row>
	            <Row label="Preview">
	              <Badge ok={executionPreview ? previewVerified : null} labelTrue="Verifierad / Safe" labelFalse={errors.executionPreview ? 'Degraded' : 'Ej körd'} />
	            </Row>
            <Row label="Bracket helper">
              <Badge ok={bracketSubmissionPlanReady === true && bracketOrderCount === 3} labelTrue="Redo i mock/read-only" labelFalse="Ej redo" />
            </Row>
	            <Row label="Real submit">
	              <Badge ok={executionPreview ? executionPreviewView.realSubmitAllowed !== true && bracketSubmissionRealSubmitEnabled !== true : null} labelTrue="Låst" labelFalse="Öppen" />
	            </Row>
            <Row label="Final gate">
              <Badge ok={armStatusView.armed !== true && finalGateArmView?.armed !== true} labelTrue="Inte armerad" labelFalse={finalGateArmView?.consumedAt ? 'Förbrukad' : 'Armerad'} />
            </Row>
            <Row label="Read-Only API">
              <Badge ok={executionPreviewView.readOnlyApiRisk?.likelyBlocksRealOrder === true} labelTrue="På / kräver manuell kontroll" labelFalse="Okänt" />
            </Row>
	            <Row label="Live broker-execution">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.liveTradingEnabled === false && executionStatusView.broker_enabled === false : null} labelTrue="Av" labelFalse="På" />
	            </Row>
	            <Row label="Riktiga order">
	              <Badge ok={executionPreview ? executionPreviewView.wouldPlaceOrder === false && executionPreviewView.orderSent === false : null} labelTrue="Blockerade" labelFalse="Risk" />
	            </Row>
	            <Row label="Paper-order skickad">
	              <Badge ok={executionPreview || hasExecutionStatusSnapshot ? executionPreviewView.orderSent === false && executionStatusView.lastExecutionResult == null : null} labelTrue="Nej" labelFalse="Ja" />
	            </Row>
	            <Row label="Dry-run / läsläge">
	              <Badge ok={hasStatusSnapshot ? statusView.dryRun === true : null} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
            <p style={{ color: 'var(--muted)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              IB Paper API och preview är verifierade. Real submit är fortfarande låst bakom manuell final gate, och IB Gateway Read-Only API är inte ändrat.
            </p>
          </div>

          <div hidden={activeTab !== 'gateway'} style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IB Gateway Control</h2>
            {errors.gatewayHealth && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Gateway-status kunde inte laddas. Detalj: {errors.gatewayHealth}
              </div>
            )}
	            <Row label="Gateway">
	              <Badge ok={hasGatewayHealthSnapshot ? gatewayHealthView.gatewayProcessRunning === true : null} labelTrue="Aktiv" labelFalse="Inaktiv" />
	            </Row>
	            <Row label="API">
	              <Badge ok={hasGatewayHealthSnapshot ? gatewayHealthView.apiPortOpen === true : null} labelTrue="Svarar" labelFalse="Svarar inte" />
	            </Row>
	            <Row label="Login">
	              <Badge
	                ok={hasGatewayHealthSnapshot ? gatewayHealthView.authenticated === true || gatewayHealthView.connected === true : null}
	                labelTrue="Inloggad"
	                labelFalse={gatewayHealthView.apiPortOpen === true ? 'Kräver login' : 'Okänt'}
	              />
	            </Row>
	            <Row label="VNC">
	              <Badge ok={hasGatewayHealthSnapshot ? gatewayHealthView.vncRunning === true : null} labelTrue="Aktiv" labelFalse="Inaktiv" />
	            </Row>
            <Row label="Display">
              <code>{hasGatewayHealthSnapshot ? (gatewayHealthView.display || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="API host/port">
              <code>{hasGatewayHealthSnapshot ? `${gatewayHealthView.apiHost || EMPTY_VALUE}:${gatewayHealthView.apiPort || EMPTY_VALUE}` : WAITING_BROKER}</code>
            </Row>
            <Row label="Paper-only safety">
              <Badge
                ok={gatewayHealthView.paperOnly === true
                  && gatewayHealthView.safety?.mode === 'paper_only'
                  && gatewayHealthView.safety?.actions_allowed === false
                  && gatewayHealthView.safety?.can_place_orders === false
                  && gatewayHealthView.safety?.live_trading_enabled === false
                  && gatewayHealthView.safety?.broker_enabled === false}
                labelTrue="Aktiv"
                labelFalse="Kontrollera"
              />
            </Row>
	            <Row label="Senaste heartbeat/statuskontroll">
	              <code>{hasGatewayHealthSnapshot ? (gatewayHealthView.lastCheckedAt ? new Date(gatewayHealthView.lastCheckedAt).toLocaleString('sv-SE') : EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="Nästa åtgärd">
	              <code style={{ color: gatewayHealthView.nextActionSv === 'Allt ser OK ut' ? 'var(--success)' : 'var(--warning)' }}>
	                {hasGatewayHealthSnapshot ? (gatewayHealthView.nextActionSv || EMPTY_VALUE) : WAITING_BROKER}
	              </code>
	            </Row>
            {gatewayHealthView.gatewayProcessCommand && (
              <Row label="Gateway process">
                <code>{gatewayHealthView.gatewayProcessCommand}</code>
              </Row>
            )}
            <p style={{ color: 'var(--muted)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Trading OS kan visa och starta IB Gateway, men ska inte kringgå IBKR:s säkerhetsinloggning.
              {' '}Om login krävs öppnar du Gateway-login och godkänner med IBKR Mobile/2FA.
            </p>
          </div>

          <div hidden={activeTab !== 'futures-exec'} style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IBKR Futures Paper Execution</h2>
            {errors.futuresExecutionStatus && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Futures execution-status kunde inte laddas. Detalj: {errors.futuresExecutionStatus}
              </div>
            )}
            <Row label="Status">
              <code>{hasFuturesExecutionStatusSnapshot ? (futuresExecutionStatusView?.status || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Order submission mode">
              <code>{hasFuturesExecutionStatusSnapshot ? (futuresExecutionStatusView?.orderSubmissionMode || futuresExecutionStatusView?.flags?.orderSubmissionMode || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Paper broker enabled">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.paperBrokerExecutionEnabled != null ? String(futuresExecutionStatusView.paperBrokerExecutionEnabled) : WAITING_BROKER}</code>
            </Row>
            <Row label="Paper account verified">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.paperAccountVerified != null ? String(futuresExecutionStatusView.paperAccountVerified) : WAITING_BROKER}</code>
            </Row>
            <Row label="Live account blocked">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.liveAccountBlocked != null ? String(futuresExecutionStatusView.liveAccountBlocked) : WAITING_BROKER}</code>
            </Row>
            <Row label="Live broker execution">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.liveBrokerExecutionEnabled != null ? String(futuresExecutionStatusView.liveBrokerExecutionEnabled) : WAITING_BROKER}</code>
            </Row>
            <Row label="Gateway">
              <code>{hasFuturesExecutionStatusSnapshot ? `${futuresExecutionStatusView?.executionClient?.host || EMPTY_VALUE}:${futuresExecutionStatusView?.executionClient?.port || EMPTY_VALUE}` : WAITING_BROKER}</code>
            </Row>
            <Row label="Data clientId">
              <code>{displayCountValue(futuresExecutionStatusView?.clientIds?.dataClientId, hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Execution clientId">
              <code>{displayCountValue(futuresExecutionStatusView?.clientIds?.executionClientId ?? futuresExecutionStatusView?.executionClient?.clientId, hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Probe clientId">
              <code>{displayCountValue(futuresExecutionStatusView?.clientIds?.probeClientId, hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Execution client connected">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.executionClient?.connected != null ? String(futuresExecutionStatusView.executionClient.connected) : WAITING_BROKER}</code>
            </Row>
            <Row label="nextValidId">
              <code>{hasFuturesExecutionStatusSnapshot && futuresExecutionStatusView?.executionClient?.nextValidIdReady != null ? (futuresExecutionStatusView.executionClient.nextValidIdReady ? 'ready' : 'missing') : WAITING_BROKER}</code>
            </Row>
            <Row label="Open orders">
              <code>{displayNumberField(futuresExecutionStatusView?.reconciliation?.counts, 'openOrders', hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Executions">
              <code>{displayNumberField(futuresExecutionStatusView?.reconciliation?.counts, 'executions', hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Positions">
              <code>{displayNumberField(futuresExecutionStatusView?.reconciliation?.counts, 'positions', hasFuturesExecutionStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Reconciliation">
              <code>{hasFuturesExecutionStatusSnapshot ? (futuresExecutionStatusView?.reconciliation?.status || EMPTY_VALUE) : WAITING_BROKER}{futuresExecutionStatusView?.reconciliation?.blockedReason ? ` · ${futuresExecutionStatusView.reconciliation.blockedReason}` : ''}</code>
            </Row>
            <Row label="Kill switch">
              <code>{futuresExecutionStatusView?.killSwitch?.pauseNewEntries ? `paused · ${futuresExecutionStatusView.killSwitch.reason || 'no_reason'}` : 'pause_new_entries=false'}</code>
            </Row>
            <Row label="No-live-order capability">
              <code>{hasFuturesExecutionStatusSnapshot ? (futuresExecutionStatusView?.executionClient?.noLiveOrderCapability ? 'paper-only adapter' : 'not connected') : WAITING_BROKER}</code>
            </Row>
          </div>

          <div hidden={activeTab !== 'status'} style={{ ...CARD_STYLE, borderColor: 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Execution status</h2>
	            <Row label="Paper-route">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.executionEnabled === true : null} labelTrue="Aktiv, submit låst" labelFalse="Av" />
	            </Row>
            <Row label="Skulle skapa IB Paper-order">
              <Badge ok={executionPreviewView.wouldCreateIbPaperOrder === false} labelTrue="Nej" labelFalse="Ja" />
            </Row>
	            <Row label="gatewayReachable">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.gatewayReachable === true : null} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="ibApiVerified">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.ibApiVerified === true : null} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="paperAccountVerified">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.paperAccountVerified === true : null} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="Orsak (blockedReason)">
	              <code style={{ color: 'var(--warning)' }}>{hasExecutionStatusSnapshot || executionPreview ? (executionStatusBlockedReason || executionPreviewView.blockedReason || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="Aktuella blockers">
	              <code>{hasExecutionStatusSnapshot ? (executionStatusBlockers.length > 0 ? executionStatusBlockers.join(', ') : EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
            <p style={{ color: 'var(--muted)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Execution feature är aktiv för IB Paper-preview, men real submit är låst.
              Inga order skickas. Blueprint-blockers från äldre flaggläge visas inte som huvudorsak när aktuell execution-status är enabled.
            </p>
          </div>

          <div hidden={activeTab !== 'status'} style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IB Paper Execution Preview</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Preview skickar ingen order. UI anropar endast <code>/api/interactive-brokers/paper-execution-preview</code> med dryRun=true och mockOnly=true.
            </p>
            {errors.executionPreview && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Preview kunde inte laddas. Detalj: {errors.executionPreview}
              </div>
            )}
	            <Row label="dryRun">
	              <Badge ok={executionPreview ? executionPreviewView.dryRun === true : null} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="mockOnly">
	              <Badge ok={executionPreview ? executionPreviewView.mockOnly === true : null} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="wouldPlaceOrder">
	              <Badge ok={executionPreview ? executionPreviewView.wouldPlaceOrder === false : null} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="orderSent">
	              <Badge ok={executionPreview ? executionPreviewView.orderSent === false : null} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="placeOrderCalled">
	              <Badge ok={executionPreview ? executionPreviewView.placeOrderCalled === false : null} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="realSubmitAllowed">
	              <Badge ok={executionPreview ? executionPreviewView.realSubmitAllowed === false : null} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="blockedReason">
	              <code>{executionPreview ? (executionPreviewView.blockedReason || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="blockers">
	              <code>{executionPreview ? (Array.isArray(executionPreviewView.blockers) && executionPreviewView.blockers.length ? executionPreviewView.blockers.join(', ') : EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="requestedOrder">
	              <code>{executionPreview ? `${executionPreviewView.requestedOrder?.symbol || EMPTY_VALUE} ${executionPreviewView.requestedOrder?.action || EMPTY_VALUE} x${displayCountValue(executionPreviewView.requestedOrder?.quantity, hasValue(executionPreviewView.requestedOrder?.quantity))}` : WAITING_BROKER}</code>
	            </Row>
            <Row label="Read-Only API-risk">
              <code>{executionPreviewView.readOnlyApiRisk?.likelyBlocksRealOrder === true ? 'kan blockera verklig paper-order' : 'okänd'}</code>
            </Row>
          </div>

          <IbFuturesDataStatusCard hidden={activeTab !== 'status'} />

          <div hidden={activeTab !== 'gateway'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Anslutnings-readiness (IB Gateway/TWS)</h2>
            <div style={{ color: 'var(--muted)', marginTop: 0, marginBottom: 12, lineHeight: 1.7 }}>
              • IBKR-lösenord sparas inte i Trading OS.<br />
              • Logga in manuellt i IB Gateway/TWS med Paper-kontot.<br />
              • Connection check är endast läsning.<br />
              Trading OS gör read-only TCP-check och läsande session-/konto-verifiering mot IB Gateway. Order är fortfarande blockerade.
            </div>
            {errors.readiness && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Readiness kunde inte laddas. Detalj: {errors.readiness}
              </div>
            )}
            <Row label="Anslutningskontroll aktiverad">
              <Badge ok={conn.connectionCheckEnabled === true} labelTrue="På" labelFalse="Av" />
            </Row>
            <Row label="Connection status">
              <code>{hasReadinessSnapshot ? (conn.status || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Konfigurerad">
              <Badge ok={conn.status !== 'not_configured'} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Gateway nåbar">
              <Badge
                ok={conn.gatewayReachable === true}
                labelTrue="Nåbar"
                labelFalse={conn.gatewayReachable === null ? 'okänt (ej kontrollerad)' : 'Ej nåbar'}
              />
            </Row>
            <Row label="Gateway host">
              <code>{hasReadinessSnapshot ? (conn.host || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Gateway port">
              <code>{hasReadinessSnapshot ? (conn.portConfigured ? conn.port : 'ej konfigurerad') : WAITING_BROKER}</code>
            </Row>
            <Row label="Paper session verified">
              <Badge ok={conn.paperModeVerified === true} labelTrue="Verifierad" labelFalse="Ej verifierad" />
            </Row>
            <Row label="Paper account id">
              <code>{hasReadinessSnapshot ? (conn.paperAccountId || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
	            <Row label="Managed accounts">
	              <code>{hasReadinessSnapshot ? (Array.isArray(conn.managedAccounts) && conn.managedAccounts.length ? conn.managedAccounts.join(', ') : EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
            <Row label="Real submit">
              <Badge ok={executionPreviewView.realSubmitAllowed !== true} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
            <Row label="Orsak (blockedReason)">
              <code style={{ color: 'var(--warning)' }}>{hasReadinessSnapshot ? (conn.blockedReason || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
          </div>

          <div hidden={activeTab !== 'status'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Safety-status</h2>
            <Row label="mode">
              <code>{safetyMode || WAITING_BROKER}</code>
            </Row>
            <Row label="actions_allowed">
              <code>{displayBooleanField(safety, 'actions_allowed', hasStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="can_place_orders">
              <code>{displayBooleanField(safety, 'can_place_orders', hasStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="live_trading_enabled">
              <code>{displayBooleanField(safety, 'live_trading_enabled', hasStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="broker_enabled">
              <code>{displayBooleanField(safety, 'broker_enabled', hasStatusSnapshot, WAITING_BROKER)}</code>
            </Row>
          </div>

          <div hidden={activeTab !== 'oversikt'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Canonical truth</h2>
            <Row label="Top 3 selected">
              <code>{displayRatio(truthReadiness?.selectedCount, hasTruthSnapshot && hasValue(truthReadiness?.selectedCount), truthReadiness?.selectionCount, hasTruthSnapshot && hasValue(truthReadiness?.selectionCount), WAITING_BROKER)}</code>
            </Row>
            <Row label="Approved strategies">
              <code>{displayCountValue(truthAllowlist?.totalApproved, hasTruthSnapshot && hasValue(truthAllowlist?.totalApproved), WAITING_BROKER)}</code>
            </Row>
            <Row label="Ready for IB Paper">
              <code>{displayCountValue(truthReadiness?.readyTopStrategies, hasTruthSnapshot && hasValue(truthReadiness?.readyTopStrategies), WAITING_BROKER)}</code>
            </Row>
            <Row label="Candidate blockers">
              <code>{displayCountValue(Array.isArray(truthReadiness?.blockers) ? truthReadiness.blockers.length : (Array.isArray(truth?.blockers) ? truth.blockers.length : null), hasTruthSnapshot && (Array.isArray(truthReadiness?.blockers) || Array.isArray(truth?.blockers)), WAITING_BROKER)}</code>
            </Row>
            <Row label="Blueprint ready">
              <Badge ok={tradeBlueprintSummary.blueprintReadyCount > 0} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Manual approval ready">
              <Badge ok={tradeBlueprintSummary.manualApprovalReadyCount > 0} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Execution ready">
              <Badge ok={tradeBlueprintSummary.executionReadyCount > 0} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Selected blueprint">
              <code>
                {selectedPaperBlueprint
                  ? selectedBlueprintStrategyLabel(selectedPaperBlueprint)
                  : 'none'}
              </code>
            </Row>
            <div style={{ marginTop: 10, color: 'var(--muted)', lineHeight: 1.6 }}>
              Same read-only truth as Paper Trading. No live trading, no broker execution, no real orders.
              {' '}Blueprint, manual approval and execution status are separated.
            </div>
          </div>

          <div hidden={activeTab !== 'paper-only'} style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Godkända strategier för framtida IB Paper-preview</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Endast redan godkända strategier visas här (läses från systemets befintliga
              approval/allowlist). Ingen ny approval skapas och inga regler ändras.
            </p>
            {sourceDegraded && (
              <div style={{ color: 'var(--warning)', padding: '8px 0' }}>
                Approval/allowlist-källan är inte tillgänglig just nu — visar tom lista eller degraderad status.
              </div>
            )}
            {strategies.length === 0 ? (
              <div style={{ color: 'var(--muted)', padding: '8px 0' }}>
                Inga godkända strategier hittades. (Empty status — inte ett fel.)
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                    <th style={{ padding: '6px 8px' }}>Strategi</th>
                    <th style={{ padding: '6px 8px' }}>ID</th>
                    <th style={{ padding: '6px 8px' }}>Paper-runtime</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                      <td style={{ padding: '6px 8px' }}>{s.name}</td>
                      <td style={{ padding: '6px 8px' }}><code style={{ color: 'var(--muted)' }}>{s.id}</code></td>
                      <td style={{ padding: '6px 8px' }}>
                        <Badge ok={s.paperRuntimeReady === true} labelTrue="Redo" labelFalse={s.runtimeConnectionStatus || 'väntar'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Dagens IB Paper-preview</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Förhandsvisning endast. Inga order skickas ännu.
              {' '}Previewn bygger på Trading OS-kandidater och visar varför varje kandidat är tillåten eller blockerad.
            </p>
            <div style={{ color: 'var(--muted)', marginTop: 0, marginBottom: 12, lineHeight: 1.7 }}>
              • Max {displayNumberField(ibPreview, 'maxPerDay', hasOrderPreviewSnapshot, EMPTY_VALUE)} kandidater per dag.<br />
              • Crypto/ETF/QQQ blockerat i denna fas.<br />
              • Endast approved strategies och tydlig riktning visas som tillåtna.<br />
              • Stop loss-policy: minst {stopLossMinPctText} krävs innan framtida IB Paper-execution.
            </div>
            {errors.orderPreview && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Order-preview kunde inte laddas. Detalj: {errors.orderPreview}
              </div>
            )}
            <Row label="Preview-läge">
              <code>{hasOrderPreviewSnapshot ? (ibPreview.mode || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Total scanned">
              <code>{displayNumberField(previewSummary, 'totalScanned', hasOrderPreviewSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Tillåtna kandidater">
              <code>{displayCountValue(allowedCount, hasOrderPreviewSnapshot && hasValue(previewSummary.allowedCandidates), WAITING_BROKER)}</code>
            </Row>
            <Row label="Blockerade kandidater">
              <code>{displayCountValue(blockedCount, hasOrderPreviewSnapshot && hasValue(previewSummary.blockedCandidates), WAITING_BROKER)}</code>
            </Row>
            <Row label="Stop loss policy">
              <code>{stopLossPolicy}</code>
            </Row>
            <Row label="Order skickas ännu">
              <code>{hasOrderPreviewSnapshot && ibPreview.orderSendingBlocked != null ? (ibPreview.orderSendingBlocked === true ? 'Nej' : 'Ja') : WAITING_BROKER}</code>
            </Row>
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(59,130,246,0.22)', color: 'var(--blue)', lineHeight: 1.6 }}>
              {hasOrderPreviewSnapshot ? (previewSummary.noteSv || EMPTY_VALUE) : WAITING_BROKER}
            </div>
            {previewSummary.insufficientAllowedReason && (
              <div style={{ marginTop: 10, color: 'var(--warning)', lineHeight: 1.5 }}>
                {previewSummary.insufficientAllowedReason}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 10px 0' }}>Tillåtna kandidater</h3>
              {allowedPreviewCandidates.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>
                  Inga IB Paper-previewkandidater är tillåtna just nu.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                  {allowedPreviewCandidates.map((candidate, index) => (
                    <CandidateCard key={`${candidate.strategyId || 'unknown'}:${candidate.symbol || 'unknown'}:${index}`} candidate={candidate} />
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 10px 0' }}>Blockerade diagnoser</h3>
              {blockedPreviewCandidates.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>
                  Inga blockerade diagnoser att visa.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                  {blockedPreviewCandidates.map((candidate, index) => (
                    <CandidateCard key={`${candidate.strategyId || 'unknown'}:${candidate.symbol || 'unknown'}:blocked:${index}`} candidate={candidate} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div hidden={activeTab !== 'teknik'} style={{ ...CARD_STYLE, borderColor: 'rgba(168,85,247,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Dry-run execution scaffold</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Detta är bara en plan-/stomvy. Den sammanställer read-only preview-data till en framtida exekveringsstruktur utan att öppna broker, kö eller orderväg.
            </p>
            {errors.scaffold && (
              <div style={{ color: 'var(--warning)', marginBottom: 12 }}>
                Scaffold kunde inte laddas. Detalj: {errors.scaffold}
              </div>
            )}
            <Row label="Scaffold-läge">
              <code>{hasScaffoldSnapshot ? (scaffoldView.mode || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
            <Row label="Steg">
              <code>{displayNumberField(scaffoldSummary, 'scaffoldStepCount', hasScaffoldSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Tillåtna kandidater">
              <code>{displayNumberField(scaffoldSummary, 'allowedCount', hasScaffoldSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Blockerade kandidater">
              <code>{displayNumberField(scaffoldSummary, 'blockedCount', hasScaffoldSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Orderväg">
              <code>{hasScaffoldSnapshot && scaffoldView.orderSendingBlocked != null ? (scaffoldView.orderSendingBlocked === true ? 'Blockerad' : 'Tillåten') : WAITING_BROKER}</code>
            </Row>
            <Row label="Live broker-execution">
              <code>{hasScaffoldSnapshot && scaffoldView.liveTradingEnabled != null ? (scaffoldView.liveTradingEnabled === false ? 'Av' : 'På') : WAITING_BROKER}</code>
            </Row>
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.22)', color: 'var(--purple)', lineHeight: 1.6 }}>
              {hasScaffoldSnapshot ? (scaffoldView.note || EMPTY_VALUE) : WAITING_BROKER}
            </div>

            {scaffoldPrimary && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ margin: '0 0 10px 0' }}>Primär kandidat</h3>
                <CandidateCard candidate={scaffoldPrimary} />
              </div>
            )}

            {scaffoldBlueprints.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ margin: '0 0 10px 0' }}>Blueprints</h3>
                <div style={{ display: 'grid', gap: 12 }}>
                  {scaffoldBlueprints.map((candidate, index) => (
                    <CandidateCard key={`${candidate.strategyId || 'unknown'}:${candidate.symbol || 'unknown'}:blueprint:${index}`} candidate={candidate} />
                  ))}
                </div>
              </div>
            )}

            {scaffoldSteps.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ margin: '0 0 10px 0' }}>Scaffold-steg</h3>
                <div style={{ display: 'grid', gap: 10 }}>
                  {scaffoldSteps.map((step) => (
                    <div key={step.id} style={{ border: '1px solid rgba(148,163,184,0.14)', borderRadius: 12, padding: 12, background: 'var(--surface-2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ color: 'var(--text)' }}>{step.labelSv || step.id}</strong>
                        <Badge ok={step.status === 'ready'} labelTrue="Redo" labelFalse="Blockerad" />
                      </div>
                      <div style={{ marginTop: 8, color: 'var(--text)', lineHeight: 1.5 }}>{step.detailSv || 'Read-only step'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(14,165,233,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IB Paper Trade Blueprint</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Trade Blueprint är read-only och kan vara redo för IB Paper-preview.
              {' '}Real submit är låst och ingen order kan skickas från denna vy.
            </p>
            <div style={{ marginTop: 0, padding: '12px 14px', borderRadius: 12, background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.22)', color: 'var(--blue)', lineHeight: 1.6 }}>
              <div>Förhandsvisning endast</div>
              <div>Inga order skapas</div>
              <div>Inga order skickas</div>
              <div>Blueprint only</div>
            </div>
            {errors.blueprint && (
              <div style={{ color: 'var(--warning)', marginTop: 12 }}>
                Blueprint kunde inte laddas. Detalj: {errors.blueprint}
              </div>
            )}
            <Row label="Blueprint-läge">
              <code>{hasTradeBlueprintSnapshot ? (tradeBlueprintView.mode || EMPTY_VALUE) : WAITING_BROKER}</code>
            </Row>
	            <Row label="IB Paper execution feature">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.executionEnabled === true : null} labelTrue="Aktiv" labelFalse="Av" />
	            </Row>
            <Row label="Real submit">
              <Badge ok={executionPreviewView.realSubmitAllowed !== true} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
	            <Row label="Skulle skapa order">
	              <Badge ok={hasTradeBlueprintSnapshot ? tradeBlueprintView.wouldCreateOrder === false : null} labelTrue="Nej" labelFalse="Ja" />
	            </Row>
            <Row label="Blueprint-kandidater">
              <code>{displayNumberField(tradeBlueprintSummary, 'totalCandidates', hasTradeBlueprintSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Blueprint ready">
              <code>{displayCountValue(tradeBlueprintSummary.blueprintReadyCount ?? tradeBlueprintSummary.readyCount, hasTradeBlueprintSnapshot && (hasValue(tradeBlueprintSummary.blueprintReadyCount) || hasValue(tradeBlueprintSummary.readyCount)), WAITING_BROKER)}</code>
            </Row>
            <Row label="Manual approval ready">
              <code>{displayNumberField(tradeBlueprintSummary, 'manualApprovalReadyCount', hasTradeBlueprintSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Execution ready">
              <code>{displayNumberField(tradeBlueprintSummary, 'executionReadyCount', hasTradeBlueprintSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Blockerade blueprints">
              <code>{displayNumberField(tradeBlueprintSummary, 'blockedCount', hasTradeBlueprintSnapshot, WAITING_BROKER)}</code>
            </Row>
            <Row label="Min stop loss">
              <code>{hasTradeBlueprintSnapshot && hasValue(tradeBlueprintView.requiredStopLossMinPct) ? `${fmtNumber(tradeBlueprintView.requiredStopLossMinPct, 2)}%` : WAITING_BROKER}</code>
            </Row>
	            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.18)', color: 'var(--blue)', lineHeight: 1.6 }}>
	              {hasTradeBlueprintSnapshot ? (tradeBlueprintView.note || EMPTY_VALUE) : WAITING_BROKER}
	            </div>

            {tradeBlueprints.length === 0 ? (
              <div style={{ marginTop: 12, color: 'var(--muted)' }}>
                Inga blueprint-kandidater att visa just nu.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                {tradeBlueprints.map((blueprintRow, index) => (
                  <BlueprintCard key={`${blueprintRow.strategyId || 'unknown'}:${blueprintRow.symbol || 'unknown'}:${index}`} blueprint={blueprintRow} />
                ))}
              </div>
            )}

          <div style={{ marginTop: 16 }}>
            <ManualApprovalCard
              manualApproval={truthManualApproval || tradeBlueprintView.manualApproval}
              selectedBlueprint={selectedPaperBlueprint}
              selectedBlueprintLoadStatus={selectedBlueprintResolution.loadStatus}
            />
          </div>
        </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.34)' }}>
            <h2 style={{ marginTop: 0 }}>First IB Paper Order Preflight</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Preflight skickar ingen order. Den kontrollerar bara om systemet är redo för en framtida manuellt godkänd IB Paper-order.
            </p>
            <Row label="Selected blueprint">
              <code>{selectedPaperBlueprint ? `${selectedBlueprintStrategyLabel(selectedPaperBlueprint)} · ${formatDirection(selectedPaperBlueprint.direction)}` : 'none'}</code>
            </Row>
            <Row label="Blueprint ready">
              <Badge ok={selectedPaperBlueprint?.blueprintReady === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Manual approval ready">
              <Badge ok={selectedPaperBlueprint?.manualApprovalReady === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Execution ready">
              <Badge ok={selectedPaperBlueprint?.executionReady === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Confirmation phrase">
              <code>{truthManualApproval?.requiredConfirmationPhrase || 'CONFIRM PAPER TRADE'}</code>
            </Row>
            <input
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              placeholder="CONFIRM PAPER TRADE"
              aria-label="CONFIRM PAPER TRADE preflight"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginTop: 10,
                marginBottom: 10,
              }}
            />
            <button
              type="button"
              disabled={preflightSubmitDisabled}
              onClick={handlePaperPreflight}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid rgba(59,130,246,0.28)',
                background: preflightSubmitDisabled ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.18)',
                color: preflightSubmitDisabled ? 'var(--muted)' : 'var(--blue)',
                fontWeight: 700,
                cursor: preflightSubmitDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              {paperPreflightSubmitting ? 'Kör preflight...' : 'Kör preflight'}
            </button>
            <button
              type="button"
              disabled={preflightSubmitDisabled}
              onClick={handleBracketReadiness}
              style={{
                width: '100%',
                marginTop: 8,
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid rgba(56,189,248,0.28)',
                background: preflightSubmitDisabled ? 'rgba(56,189,248,0.08)' : 'rgba(56,189,248,0.18)',
                color: preflightSubmitDisabled ? 'var(--muted)' : 'var(--blue)',
                fontWeight: 700,
                cursor: preflightSubmitDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              {protectiveReadinessStatus === 'loading' ? 'Kör bracket-readiness...' : 'Kör bracket-readiness'}
            </button>
            {paperPreflightResult && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(148,163,184,0.16)', color: 'var(--text)', lineHeight: 1.55 }}>
                <div><strong>Status:</strong> {paperPreflightResult.ok ? 'ok' : 'blocked/error'}</div>
                <div><strong>accepted:</strong> {paperPreflightResult.accepted === true ? 'true' : 'false'}</div>
                <div><strong>readyForFirstPaperOrder:</strong> {paperPreflightResult.readyForFirstPaperOrder === true ? 'true' : 'false'}</div>
                <div><strong>preflightOnly:</strong> {paperPreflightResult.preflightOnly === true ? 'true' : 'false'}</div>
                <div><strong>dryRun:</strong> {paperPreflightResult.dryRun === true ? 'true' : 'false'}</div>
                <div><strong>totalChecks:</strong> {displayCountValue(paperPreflightResult.summary?.totalChecks ?? (Array.isArray(paperPreflightResult.checks) ? paperPreflightResult.checks.length : null), hasValue(paperPreflightResult.summary?.totalChecks) || Array.isArray(paperPreflightResult.checks))}</div>
                <div><strong>passedChecks:</strong> {displayCountValue(paperPreflightResult.summary?.passedChecks, hasValue(paperPreflightResult.summary?.passedChecks))}</div>
                <div><strong>failedHardChecks:</strong> {displayCountValue(paperPreflightResult.summary?.failedHardChecks, hasValue(paperPreflightResult.summary?.failedHardChecks))}</div>
                <div><strong>blockers:</strong> {Array.isArray(paperPreflightResult.blockers) && paperPreflightResult.blockers.length ? paperPreflightResult.blockers.join(', ') : 'none'}</div>
                <div><strong>nextRequiredAction:</strong> {paperPreflightResult.nextRequiredAction || 'none'}</div>
                <div><strong>orderSent:</strong> {paperPreflightResult.orderSent === true ? 'true' : 'false'}</div>
                <div><strong>executed:</strong> {paperPreflightResult.executed === true ? 'true' : 'false'}</div>
                <div><strong>account:</strong> {resolvedPaperAccountId || (manualPaperLoading ? 'Laddar…' : EMPTY_VALUE)}</div>
                <div><strong>sessionVerification.selectedAccount:</strong> {paperPreflightResult.sessionVerification?.selectedAccount || 'none'}</div>
                <div><strong>sessionVerification.paperAccountId:</strong> {paperPreflightResult.sessionVerification?.paperAccountId || 'none'}</div>
                <div><strong>sessionVerification.accountMatches:</strong> {paperPreflightResult.sessionVerification?.accountMatches === true ? 'true' : 'false'}</div>
                <div><strong>sessionVerification.sessionVerified:</strong> {paperPreflightResult.sessionVerification?.sessionVerified === true ? 'true' : 'false'}</div>
                <div><strong>selectedBlueprint.source:</strong> {paperPreflightResult.selectedBlueprintVerification?.source || 'none'}</div>
                <div><strong>selectedBlueprint.symbol:</strong> {paperPreflightResult.selectedBlueprintVerification?.symbol || 'none'}</div>
                <div><strong>selectedBlueprint.side:</strong> {paperPreflightResult.selectedBlueprintVerification?.side || 'none'}</div>
                <div><strong>selectedBlueprint.quantity:</strong> {paperPreflightResult.selectedBlueprintVerification?.quantity ?? 'none'}</div>
                <div><strong>selectedBlueprint.marketGroup:</strong> {paperPreflightResult.selectedBlueprintVerification?.marketGroup || 'none'}</div>
                <div><strong>selectedBlueprint.stopLossPct:</strong> {paperPreflightResult.selectedBlueprintVerification?.stopLossPct ?? 'none'}</div>
                <div><strong>selectedBlueprint.riskReward:</strong> {paperPreflightResult.selectedBlueprintVerification?.riskReward ?? 'none'}</div>
              </div>
            )}
            <Row label="Bracket readiness status">
              <Badge ok={protectiveReadinessStatus === 'ready'} labelTrue="Redo" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Inte körd')} />
            </Row>
            <Row label="Bracket readiness blocker">
              <code>{protectiveReadinessError || stableIbPaperSnapshot.blockedReason || 'none'}</code>
            </Row>
          </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.34)' }}>
            <h2 style={{ marginTop: 0 }}>Manuell IB Paper bracket-submit</h2>
            <div style={{ marginTop: -4, marginBottom: 10, color: 'var(--blue)', fontSize: 13 }}>
              IB Paper UI version: <code>{IB_PAPER_UI_VERSION}</code>
            </div>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Detta är IB Paper. Inga riktiga pengar. Exakt en bracket-order: Entry + Stop Loss + Take Profit.
              {' '}Knappen öppnas först när alla gates är gröna och användaren gör en manuell bekräftelse.
            </p>
            <Row label="Symbol">
              <code>{selectedPaperBlueprint?.symbol || (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Strategi">
              <code>{selectedPaperBlueprint ? strategyLabel(selectedPaperBlueprint, '—') : (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : '—')}</code>
            </Row>
            <Row label="Side">
              <code>{selectedPaperBlueprint?.side || (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Quantity">
              <code>{selectedPaperBlueprint?.quantity ?? (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Entry">
              <code>{selectedPaperBlueprint?.entryPrice ?? selectedPaperBlueprint?.entryReferencePrice ?? (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Stop Loss">
              <code>{selectedPaperBlueprint?.stopLoss ?? selectedPaperBlueprint?.stopLossPrice ?? (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Take Profit">
              <code>{selectedPaperBlueprint?.takeProfit ?? selectedPaperBlueprint?.takeProfit1 ?? (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Account">
              <code>{resolvedPaperAccountId || (manualPaperLoading ? 'Laddar…' : EMPTY_VALUE)}</code>
            </Row>
            <Row label="Helper import">
              <code>{manualPaperHelperImportStatus}</code>
            </Row>
            <Row label="Blueprint source">
              <code>{selectedBlueprintResolution.source || 'none'}</code>
            </Row>
            <Row label="Blueprint fallback">
              <Badge ok={selectedBlueprintResolution.isFallback !== true} labelTrue="Nej" labelFalse="Ja" />
            </Row>
            <Row label="Blueprint safety status">
              <code>{selectedBlueprintResolution.safetyStatus || 'blocked'}</code>
            </Row>
            <Row label="Blueprint blocker">
              <code>{Array.isArray(selectedBlueprintResolution.blockers) && selectedBlueprintResolution.blockers.length ? selectedBlueprintResolution.blockers.join(', ') : 'none'}</code>
            </Row>
            <Row label="Bracket preview">
              <Badge ok={selectedBlueprintResolution.safeForBracketPreview === true} labelTrue="Redo" labelFalse="Blockerad" />
            </Row>
            <Row label="Blueprint endpoint">
              <code>
                {selectedBlueprintResolution.loadStatus || 'idle'}
                {selectedBlueprintResolution.loadError ? ` · ${selectedBlueprintResolution.loadError}` : ''}
              </code>
            </Row>
            <Row label="3-leg helper status">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.helperReady === true} labelTrue="Laddar" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Inte redo')} />
            </Row>
            <Row label="Runtime arm status">
              <Badge ok={manualPaperLoading ? null : manualArmStatusView?.armed === true} labelTrue="Laddar" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Inte redo')} />
            </Row>
            <Row label="Real-submit gate status">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.realSubmitGateReady === true} labelTrue="Laddar" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Inte redo')} />
            </Row>
            <Row label="Gate opens real submit">
              <Badge ok={manualPaperLoading ? null : manualPaperGateView?.gateOpensRealSubmit === true} labelTrue="Laddar" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="Order button">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitDisabled !== true} labelTrue="Laddar" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Locked')} />
            </Row>
            <Row label="Blueprint submit-safe">
              <Badge ok={selectedBlueprintResolution.safeForSubmit === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Blueprint arm-safe">
              <Badge ok={selectedBlueprintResolution.safeForArm === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Blockers">
              <code>{manualPaperBracketSubmitState.blockers.length ? manualPaperBracketSubmitState.blockers.join(', ') : 'none'}</code>
            </Row>
            <Row label="Last result">
              <code>{manualPaperBracketSubmitState.userMessageSv || paperOneShotResult?.blockedReason || paperOneShotResult?.userMessageSv || 'none'}</code>
            </Row>
            <Row label="finalGateStatus">
              <code>{finalGateStatusView?.oneShotArm?.status || 'not_armed'}</code>
            </Row>
            <Row label="oneShotArm.blockedReason">
              <code>{finalGateArmView?.blocker || 'none'}</code>
            </Row>
            <Row label="armId">
              <code>{finalGateArmView?.armId || 'none'}</code>
            </Row>
            <Row label="selectedBlueprintId">
              <code>{selectedBlueprintResolution.safeForArm === true ? (finalGateStatusView?.selectedBlueprintId || 'none') : 'none — requires submit-safe blueprint'}</code>
            </Row>
            <Row label="armBlueprintId">
              <code>{finalGateArmView?.blueprintId || 'none'}</code>
            </Row>
            <Row label="idempotencyKey">
              <code>{selectedBlueprintResolution.safeForArm === true ? (finalGateArmView?.idempotencyKey || 'none') : 'none — requires submit-safe blueprint'}</code>
            </Row>
            <Row label="expiresAt">
              <code>{finalGateArmView?.expiresAt || 'none'}</code>
            </Row>
            <Row label="consumedAt">
              <code>{finalGateArmView?.consumedAt || 'none'}</code>
            </Row>
            <Row label="openOrders">
              <code>{displayCountValue(finalGateStatusView?.openOrders?.count, hasFinalGateStatusSnapshot && hasValue(finalGateStatusView?.openOrders?.count), WAITING_BROKER)}</code>
            </Row>
            <Row label="positions">
              <code>{displayCountValue(finalGateStatusView?.positions?.countForSymbol, hasFinalGateStatusSnapshot && hasValue(finalGateStatusView?.positions?.countForSymbol), WAITING_BROKER)}</code>
            </Row>
            <Row label="nextRequiredAction">
              <code>{finalGateStatusView?.nextRequiredAction || 'none'}</code>
            </Row>
            <Row label="Bracket ready">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.helperReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="Arm ready">
              <Badge ok={manualPaperLoading ? null : finalGateStatusView?.canArm === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="Submit ready">
              <Badge ok={manualPaperLoading ? null : finalGateStatusView?.submitReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>

            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)', color: 'var(--success)', lineHeight: 1.6 }}>
              Manuell bekräftelse krävs. Ingen automatisk submit körs från agenten.
            </div>

            <Row label="Final confirm text">
              <code>{REQUIRED_FINAL_EXECUTION_COMMAND}</code>
            </Row>
            <input
              value={manualFinalExecutionCommand}
              onChange={(e) => setManualFinalExecutionCommand(e.target.value)}
              placeholder={REQUIRED_FINAL_EXECUTION_COMMAND}
              aria-label="Final execution command"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginTop: 10,
                marginBottom: 10,
              }}
            />
            <input
              value={oneShotConfirmationText}
              onChange={(e) => setOneShotConfirmationText(e.target.value)}
              placeholder="CONFIRM PAPER TRADE"
              aria-label="Paper trade confirmation phrase"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginBottom: 10,
              }}
            />
            <input
              value={oneShotSecondConfirmationText}
              onChange={(e) => setOneShotSecondConfirmationText(e.target.value)}
              placeholder="CONFIRM FIRST IB PAPER ORDER"
              aria-label="Second paper order confirmation phrase"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginBottom: 10,
              }}
            />
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckPaperOnly} onChange={(e) => setOneShotAckPaperOnly(e.target.checked)} />
              Jag förstår att detta är IB Paper
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckNoLiveTrading} onChange={(e) => setOneShotAckNoLiveTrading(e.target.checked)} />
              Jag förstår att detta inte är live trading
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckOneOrderOnly} onChange={(e) => setOneShotAckOneOrderOnly(e.target.checked)} />
              Jag förstår att endast en bracket-order får skickas
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckBracketOrder} onChange={(e) => setOneShotAckBracketOrder(e.target.checked)} />
              Jag förstår att detta är en bracket-order med tre legs
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckNoRetry} onChange={(e) => setOneShotAckNoRetry(e.target.checked)} />
              Jag förstår att ingen retry ska göras
            </label>
            <button
              type="button"
              disabled={manualPaperBracketSubmitDisabled}
              onClick={handlePaperOneShotExecute}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid rgba(34,197,94,0.28)',
                background: manualPaperBracketSubmitDisabled ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.18)',
                color: manualPaperBracketSubmitDisabled ? 'var(--muted)' : 'var(--success)',
                fontWeight: 700,
                cursor: manualPaperBracketSubmitDisabled ? 'not-allowed' : 'pointer',
                marginTop: 8,
              }}
            >
              {paperOneShotSubmitting ? 'Skickar IB Paper bracket-order...' : 'Skicka IB Paper bracket-order'}
            </button>
            <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
              {stableIbPaperSnapshot.loadingState === 'loading'
                ? 'Laddar IB Paper-status…'
                : (manualPaperBracketSubmitState.helperReady === true
                  ? 'Real-submit gate är redo för exakt en IB Paper bracket-order, men öppnar inte submit förrän Fas 4G-2D.'
                  : 'Väntar på full IB Paper-readiness.')}
            </div>
            {paperOneShotResult && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(148,163,184,0.16)', color: 'var(--text)', lineHeight: 1.55 }}>
                <div><strong>accepted:</strong> {paperOneShotResult.accepted === true ? 'true' : 'false'}</div>
                <div><strong>helperReady:</strong> {paperOneShotResult.helperReady === true ? 'true' : 'false'}</div>
                <div><strong>bracketSubmissionPlanReady:</strong> {paperOneShotResult.bracketSubmissionPlanReady === true ? 'true' : 'false'}</div>
                <div><strong>bracketOrderCount:</strong> {displayCountValue(paperOneShotResult.bracketOrderCount, hasValue(paperOneShotResult.bracketOrderCount))}</div>
                <div><strong>entryOnlyBlocked:</strong> {paperOneShotResult.entryOnlyBlocked === true ? 'true' : 'false'}</div>
                <div><strong>runtimeBracketSubmitUnlocked:</strong> {paperOneShotResult.runtimeBracketSubmitUnlocked === true ? 'true' : 'false'}</div>
                <div><strong>realSubmitGate.gateReady:</strong> {(paperOneShotResult.realSubmitGate?.gateReady === true || manualPaperBracketSubmitState.gateReadyPreview === true) ? 'true' : 'false'}</div>
                <div><strong>realSubmitGate.gateOpensRealSubmit:</strong> {paperOneShotResult.realSubmitGate?.gateOpensRealSubmit === true ? 'true' : 'false'}</div>
                <div><strong>realSubmitGate.requiresFinalPhase:</strong> {paperOneShotResult.realSubmitGate?.requiresFinalPhase || '4G-2D'}</div>
                <div><strong>blockedReason:</strong> {paperOneShotResult.blockedReason || 'none'}</div>
                <div><strong>userMessageSv:</strong> {paperOneShotResult.userMessageSv || 'none'}</div>
                <div><strong>orderSent:</strong> {paperOneShotResult.orderSent === true ? 'true' : 'false'}</div>
                <div><strong>executed:</strong> {paperOneShotResult.executed === true ? 'true' : 'false'}</div>
                <div><strong>ibOrderId:</strong> {paperOneShotResult.ibOrderId || 'none'}</div>
                <div><strong>manualUserInitiated:</strong> {paperOneShotResult.manualUserInitiated === true ? 'true' : 'false'}</div>
                <div><strong>openRealSubmitGateForThisAttempt:</strong> {paperOneShotResult.openRealSubmitGateForThisAttempt === true ? 'true' : 'false'}</div>
                <div><strong>orderButtonLocked:</strong> {paperOneShotResult.orderButtonLocked === true ? 'true' : 'false'}</div>
                <div><strong>nextRequiredAction:</strong> {paperOneShotResult.nextRequiredAction || 'none'}</div>
              </div>
            )}
          </div>

          <div hidden={activeTab !== 'teknik'} style={{ ...CARD_STYLE, borderColor: 'rgba(56,189,248,0.34)' }}>
            <h2 style={{ marginTop: 0 }}>Protective Order / Bracket Plan</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              {stableIbPaperSnapshot.loadingState === 'loading'
                ? 'Laddar skydds-/bracket-status…'
                : '3-leg submit-helper är verifierad i mock. Riktig IB Paper submit är fortfarande låst tills Fas 4G-2.'}
            </p>
            <Row label="protectivePathAvailable">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.protectivePathAvailable === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="protectivePlanReady">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.protectivePlanReady === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="bracketSubmissionPlanReady">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.bracketSubmissionPlanReady === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="runtimeBracketSubmitUnlocked">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.gateReadyPreview === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="helperReady">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.helperReady === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="bracketOrderCount">
              <code>{manualPaperLoading ? 'Laddar…' : (manualPaperIdle ? 'Ej körd' : displayCountValue(stableIbPaperSnapshot.bracketOrderCount, hasValue(stableIbPaperSnapshot.bracketOrderCount)))}</code>
            </Row>
            <Row label="entryOnlyBlocked">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.entryOnlyBlocked === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="realSubmitEnabled">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.realSubmitGateReady === true && manualPaperGateView?.gateOpensRealSubmit === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="realSubmitGate">
              <Badge ok={manualPaperLoading ? null : manualPaperBracketSubmitState.realSubmitGateReady === true} labelTrue="Redo" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Inte redo')} />
            </Row>
            <Row label="gateOpensRealSubmit">
              <Badge ok={manualPaperLoading ? null : manualPaperGateView?.gateOpensRealSubmit === true} labelTrue="true" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'false')} />
            </Row>
            <Row label="requiresFinalPhase">
              <code>{manualPaperLoading ? 'Laddar…' : (manualPaperIdle ? 'Ej körd' : (manualPaperGateView?.requiresFinalPhase || '4G-2D'))}</code>
            </Row>
            <Row label="Statusmeddelande">
              <code>{stableIbPaperSnapshot.userMessageSv || bracketPresentationMessage}</code>
            </Row>
            <Row label="blockedReason">
              <code>{stableIbPaperSnapshot.blockedReason || bracketPresentationBlockedReason || 'none'}</code>
            </Row>
            <Row label="order model verified">
              <Badge ok={manualPaperLoading ? null : protectivePreflightView?.protectiveOrderModelVerified === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="account">
              <code>{resolvedPaperAccountId || (manualPaperLoading ? 'Laddar…' : EMPTY_VALUE)}</code>
            </Row>
            <Row label="summary">
              <code>
                {protectivePlanSummary
                  ? `${displayCountValue(protectivePlanSummary.passedChecks, hasValue(protectivePlanSummary.passedChecks))}/${displayCountValue(protectivePlanSummary.totalChecks ?? (Array.isArray(protectivePlanChecks) ? protectivePlanChecks.length : null), hasValue(protectivePlanSummary.totalChecks) || Array.isArray(protectivePlanChecks))} checks passed`
                  : 'none'}
              </code>
            </Row>
            <Row label="transmit sequence">
              <code>{Array.isArray(protectivePlan?.transmitSequence) ? protectivePlan.transmitSequence.join(' → ') : 'none'}</code>
            </Row>
            <Row label="parent/child">
              <Badge ok={protectivePlan?.parentChildPlanExists === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="entry order">
              <code>{protectivePlan?.entry ? `${protectivePlan.entry.action} ${protectivePlan.entry.quantity} @ ${protectivePlan.entry.orderType}` : 'none'}</code>
            </Row>
            <Row label="stop loss order">
              <code>{protectivePlan?.stopLoss ? `${protectivePlan.stopLoss.action} ${protectivePlan.stopLoss.quantity} STP ${protectivePlan.stopLoss.stopPrice}` : 'none'}</code>
            </Row>
            <Row label="take profit order">
              <code>{protectivePlan?.takeProfit ? `${protectivePlan.takeProfit.action} ${protectivePlan.takeProfit.quantity} LMT ${protectivePlan.takeProfit.limitPrice}` : 'none'}</code>
            </Row>
            <Row label="warning">
              <code>Ingen order skickas i denna fas.</code>
            </Row>
            {protectivePlanChecks.length > 0 && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(148,163,184,0.16)', color: 'var(--text)', lineHeight: 1.55 }}>
                <strong>Checks:</strong>
                <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
                  {protectivePlanChecks.slice(0, 8).map((check) => (
                    <li key={check.code}>
                      {check.code}: {check.ok === true ? 'ok' : `blocked (${check.blocker || 'unknown'})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(250,204,21,0.34)' }}>
            <h2 style={{ marginTop: 0 }}>Arm First IB Paper One-Shot</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              Arming skickar ingen order. Det öppnar bara ett tidsbegränsat fönster för en framtida separat godkänd IB Paper-order.
            </p>
            <Row label="selected blueprint">
              <code>{selectedPaperBlueprint ? `${selectedBlueprintStrategyLabel(selectedPaperBlueprint)} · ${formatDirection(selectedPaperBlueprint.direction)}` : (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}</code>
            </Row>
            <Row label="Blueprint source">
              <code>{selectedBlueprintResolution.source || 'none'}</code>
            </Row>
            <Row label="Blueprint fallback">
              <Badge ok={selectedBlueprintResolution.isFallback !== true} labelTrue="Nej" labelFalse="Ja" />
            </Row>
            <Row label="Blueprint endpoint">
              <code>
                {selectedBlueprintResolution.loadStatus || 'idle'}
                {selectedBlueprintResolution.loadError ? ` · ${selectedBlueprintResolution.loadError}` : ''}
              </code>
            </Row>
            <Row label="preflight ready">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.helperReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="protective plan ready">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.protectivePlanReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="bracket submission ready">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.bracketSubmissionPlanReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="bracket order count">
              <code>{manualPaperLoading ? 'Laddar…' : (manualPaperIdle ? 'Ej körd' : displayCountValue(stableIbPaperSnapshot.bracketOrderCount, hasValue(stableIbPaperSnapshot.bracketOrderCount)))}</code>
            </Row>
            <Row label="entry-only blocked">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.entryOnlyBlocked === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="real submit enabled">
              <Badge ok={manualPaperLoading ? null : stableIbPaperSnapshot.realSubmitGateReady === true} labelTrue="Ja" labelFalse={readinessFalseLabel(protectiveReadinessStatus, 'Nej')} />
            </Row>
            <Row label="current arm status">
              <Badge ok={armStatusView?.armed === true} labelTrue="armed" labelFalse="not armed" />
            </Row>
            <Row label="arm expiry">
              <code>{armCurrent?.expiresAt || armStatusView?.expiresAt || 'none'}</code>
            </Row>
            <Row label="idempotencyKey">
              <code>{armIdempotencyKey || 'none'}</code>
            </Row>
            <Row label="confirmation phrase">
              <code>CONFIRM PAPER TRADE</code>
            </Row>
            <Row label="second confirmation phrase">
              <code>CONFIRM FIRST IB PAPER ORDER</code>
            </Row>
            <Row label="arm confirmation phrase">
              <code>ARM IB PAPER ONE SHOT</code>
            </Row>
            <input
              value={armConfirmationText}
              onChange={(e) => setArmConfirmationText(e.target.value)}
              placeholder="ARM IB PAPER ONE SHOT"
              aria-label="Arm confirmation phrase"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginTop: 10,
                marginBottom: 10,
              }}
            />
            <input
              value={armIdempotencyKey}
              onChange={(e) => setArmIdempotencyKey(e.target.value)}
              placeholder="Arm idempotency key"
              aria-label="Arm idempotency key"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginBottom: 10,
              }}
            />
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckPaperOnly} onChange={(e) => setOneShotAckPaperOnly(e.target.checked)} />
              Jag förstår att detta endast gäller IB Paper
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckNoLiveTrading} onChange={(e) => setOneShotAckNoLiveTrading(e.target.checked)} />
              Jag förstår att ingen live trading används
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', marginBottom: 8 }}>
              <input type="checkbox" checked={oneShotAckOneOrderOnly} onChange={(e) => setOneShotAckOneOrderOnly(e.target.checked)} />
              Jag förstår att bara en order får skickas
            </label>
            <input
              type="number"
              min="1"
              max="300"
              value={armTtlSeconds}
              onChange={(e) => setArmTtlSeconds(Math.min(300, Math.max(1, Number(e.target.value) || 300)))}
              aria-label="Arm TTL seconds"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.24)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                marginBottom: 10,
              }}
            />
            <button
              type="button"
              disabled={armSubmitDisabled}
              onClick={handleArmOneShot}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid rgba(250,204,21,0.28)',
                background: armSubmitDisabled ? 'rgba(250,204,21,0.08)' : 'rgba(250,204,21,0.18)',
                color: armSubmitDisabled ? 'var(--muted)' : 'var(--warning)',
                fontWeight: 700,
                cursor: armSubmitDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              {armSubmitting ? 'Armar...' : 'Arma one-shot i 5 minuter'}
            </button>
            <button
              type="button"
              disabled={!armStatusView?.armed || disarmSubmitting}
              onClick={handleDisarmOneShot}
              style={{
                width: '100%',
                marginTop: 8,
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid rgba(248,113,113,0.28)',
                background: (!armStatusView?.armed || disarmSubmitting) ? 'rgba(248,113,113,0.08)' : 'rgba(248,113,113,0.18)',
                color: (!armStatusView?.armed || disarmSubmitting) ? 'var(--muted)' : 'var(--danger)',
                fontWeight: 700,
                cursor: (!armStatusView?.armed || disarmSubmitting) ? 'not-allowed' : 'pointer',
              }}
            >
              {disarmSubmitting ? 'Avbryter...' : 'Avbryt arm'}
            </button>
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(148,163,184,0.16)', color: 'var(--text)', lineHeight: 1.55 }}>
              <div><strong>armed:</strong> {armStatusView?.armed === true ? 'true' : 'false'}</div>
              <div><strong>armId:</strong> {armStatusView?.armId || 'none'}</div>
              <div><strong>expiresAt:</strong> {armStatusView?.expiresAt || 'none'}</div>
              <div><strong>blockedReason:</strong> {armStatusView?.blockedReason || 'none'}</div>
              <div><strong>nextRequiredAction:</strong> {armStatusView?.nextRequiredAction || 'none'}</div>
              <div><strong>orderSent:</strong> false</div>
              <div><strong>executed:</strong> false</div>
              <div><strong>safety:</strong> mode=paper_only, actions_allowed=false, can_place_orders=false, live_trading_enabled=false, broker_enabled=false</div>
              {armResult && (
                <div style={{ marginTop: 8 }}>
                  <div><strong>lastResult.accepted:</strong> {armResult.accepted === true ? 'true' : 'false'}</div>
                  <div><strong>lastResult.armed:</strong> {armResult.armed === true ? 'true' : 'false'}</div>
                  <div><strong>lastResult.blockedReason:</strong> {armResult.blockedReason || 'none'}</div>
                </div>
              )}
            </div>
          </div>

          <div hidden={activeTab !== 'paper-only'} style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IB Paper Execution</h2>
            <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.6 }}>
              IB Paper API och preview är verifierade. Real submit är fortfarande låst bakom manuell final gate och Read-Only API är inte ändrat.
              {' '}Ingen live trading används och ingen order skickas från denna vy.
            </p>
            <div style={{ marginTop: 0, padding: '12px 14px', borderRadius: 12, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.18)', color: 'var(--success)', lineHeight: 1.6 }}>
              <div>Förhandsvisning endast</div>
              <div>Inga live trading-åtgärder</div>
              <div>Paper-only execution</div>
              <div>Order kan inte skickas utan explicit bekräftelse</div>
            </div>
            {errors.executionStatus && (
              <div style={{ color: 'var(--warning)', marginTop: 12 }}>
                Execution-status kunde inte laddas. Detalj: {errors.executionStatus}
              </div>
            )}
            <Row label="Feature flag">
              <code>{hasExecutionStatusSnapshot && executionStatusView.executionEnabled != null ? (executionStatusView.executionEnabled === true ? 'Aktiv' : 'Av') : WAITING_BROKER}</code>
            </Row>
            <Row label="Gateway reachable">
              <code>{hasExecutionStatusSnapshot && executionStatusView.gatewayReachable != null ? (executionStatusView.gatewayReachable === true ? 'Ja' : 'Nej') : WAITING_BROKER}</code>
            </Row>
            <Row label="IB API verified">
              <code>{hasExecutionStatusSnapshot && executionStatusView.ibApiVerified != null ? (executionStatusView.ibApiVerified === true ? 'Ja' : 'Nej') : WAITING_BROKER}</code>
            </Row>
            <Row label="Paper account verified">
              <code>{hasExecutionStatusSnapshot && executionStatusView.paperAccountVerified != null ? (executionStatusView.paperAccountVerified === true ? 'Ja' : 'Nej') : WAITING_BROKER}</code>
            </Row>
            <Row label="Daily quota">
              <code>{displayRatio(executionStatusView.dailyQuota?.used, hasExecutionStatusSnapshot && hasValue(executionStatusView.dailyQuota?.used), executionStatusView.dailyQuota?.max, hasExecutionStatusSnapshot && hasValue(executionStatusView.dailyQuota?.max), WAITING_BROKER)}</code>
            </Row>
            <Row label="Open trades">
              <code>{displayCountValue(executionStatusView.openTradeCount, hasExecutionStatusSnapshot && hasValue(executionStatusView.openTradeCount), WAITING_BROKER)}</code>
            </Row>
            <Row label="Closed trades">
              <code>{displayCountValue(executionStatusView.closedTradeCount, hasExecutionStatusSnapshot && hasValue(executionStatusView.closedTradeCount), WAITING_BROKER)}</code>
            </Row>
	            <Row label="Last execution result">
	              <code>{hasExecutionStatusSnapshot || paperExecutionResult ? (executionStatusView.lastExecutionResult?.status || paperExecutionResult?.status || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="Blockers">
	              <code>{hasExecutionStatusSnapshot ? (executionStatusBlockers.length > 0 ? executionStatusBlockers.join(', ') : EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="No live trading badge">
	              <Badge ok={hasExecutionStatusSnapshot ? executionStatusView.liveTradingEnabled === false : null} labelTrue="No live trading" labelFalse="Live enabled" />
	            </Row>
	            <Row label="Feature flag key">
	              <code>{hasExecutionStatusSnapshot ? (executionStatusView.featureFlag || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="Disable reason">
	              <code>{hasExecutionStatusSnapshot ? (executionStatusBlockedReason || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
	            <Row label="Manual approval">
	              <code>{hasExecutionStatusSnapshot || hasTruthSnapshot ? (executionStatusView.manualApproval?.approvalStatus || truthManualApproval?.approvalStatus || EMPTY_VALUE) : WAITING_BROKER}</code>
	            </Row>
            <div style={{ marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.12)', paddingTop: 12 }}>
              <div style={{ color: 'var(--text)', marginBottom: 8, lineHeight: 1.5 }}>
                Selected blueprint:
                {' '}
                {selectedPaperBlueprint ? `${selectedBlueprintStrategyLabel(selectedPaperBlueprint)} · ${formatDirection(selectedPaperBlueprint.direction)}` : (selectedBlueprintResolution.loadStatus === 'loading' ? 'Laddar…' : 'none')}
              </div>
              <div style={{ color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                Blueprint source: {selectedBlueprintResolution.source || 'none'} ·
                {' '}
                Fallback: {selectedBlueprintResolution.isFallback === true ? 'Ja' : 'Nej'} ·
                {' '}
                Load: {selectedBlueprintResolution.loadStatus || 'idle'}
                {selectedBlueprintResolution.loadError ? ` (${selectedBlueprintResolution.loadError})` : ''}
              </div>
              <div style={{ color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                Blueprint ready: {selectedPaperBlueprint?.blueprintReady === true ? 'Ja' : 'Nej'} ·
                {' '}
                Manual approval ready: {selectedPaperBlueprint?.manualApprovalReady === true ? 'Ja' : 'Nej'} ·
                {' '}
                Execution ready: {selectedPaperBlueprint?.executionReady === true ? 'Ja' : 'Nej'}
              </div>
              <div style={{ color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                Approval phrase: <code>{truthManualApproval?.requiredConfirmationPhrase || 'CONFIRM PAPER TRADE'}</code>
              </div>
              <div style={{ color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                Skickeknappen är låst i UI. Använd preview för diagnos; ingen order skickas.
              </div>
              <input
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                placeholder="CONFIRM PAPER TRADE"
                aria-label="CONFIRM PAPER TRADE"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(148,163,184,0.24)',
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  marginBottom: 10,
                }}
              />
              <button
                type="button"
                disabled={paperExecutionSubmitDisabled}
                onClick={handlePaperExecute}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid rgba(34,197,94,0.28)',
                  background: paperExecutionSubmitDisabled ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.18)',
                  color: paperExecutionSubmitDisabled ? 'var(--muted)' : 'var(--success)',
                  fontWeight: 700,
                  cursor: paperExecutionSubmitDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                {paperExecutionSubmitting ? 'Skickar...' : 'IB Paper submit låst'}
              </button>
              {paperExecutionResult && (
                <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(148,163,184,0.16)', color: 'var(--text)', lineHeight: 1.55 }}>
                  <div><strong>Status:</strong> {paperExecutionResult.ok ? 'ok' : 'blocked/error'}</div>
                  <div><strong>blockedReason:</strong> {paperExecutionResult.blockedReason || 'none'}</div>
                  <div><strong>submitted:</strong> {paperExecutionResult.submitted === true ? 'true' : 'false'}</div>
                  <div><strong>executed:</strong> {paperExecutionResult.executed === true ? 'true' : 'false'}</div>
                  <div><strong>orderSent:</strong> {paperExecutionResult.orderSent === true ? 'true' : 'false'}</div>
                  <div><strong>orderSendingBlocked:</strong> {paperExecutionResult.orderSendingBlocked === true ? 'true' : 'false'}</div>
                </div>
              )}
            </div>
          </div>

          <div hidden={activeTab !== 'teknik'} style={{ ...CARD_STYLE, borderColor: 'rgba(251,191,36,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Nästa fas — låst</h2>
	            <Row label="Paper order-kö">
	              <Badge ok={hasStatusSnapshot ? nextPhase.paperOrderQueue?.locked !== false : null} labelTrue="Låst" labelFalse="Öppen" />
	            </Row>
	            <Row label="Live broker-execution">
	              <Badge ok={hasStatusSnapshot ? nextPhase.brokerExecution?.locked !== false : null} labelTrue="Låst" labelFalse="Öppen" />
	            </Row>
	            <Row label="Live trading">
	              <Badge ok={hasStatusSnapshot ? nextPhase.liveTrading?.locked !== false : null} labelTrue="Låst" labelFalse="Öppen" />
	            </Row>
	            <Row label="Manuellt godkännande krävs">
	              <Badge ok={hasStatusSnapshot ? nextPhase.manualApprovalRequired === true : null} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
            <p style={{ color: 'var(--muted)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Inga framtida steg (order-kö, broker-execution, live trading) kan aktiveras härifrån.
              Varje steg kräver explicit manuellt godkännande och en separat byggnation.
            </p>
          </div>

          <div hidden={activeTab !== 'oversikt'} style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.3)' }}>
            <h2 style={{ marginTop: 0 }}>Separation från intern paper trading</h2>
	            <Row label="Intern paper trading opåverkad">
	              <Badge ok={hasStatusSnapshot ? statusView.internalPaperTradingUnaffected === true : null} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
            <p style={{ color: 'var(--muted)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Den interna paper trading-funktionen körs helt separat och är oförändrad.
              Den här vyn läser endast status och godkända strategier.
            </p>
          </div>
        </>
      )}
    </div>
    </DashboardShell>
  );
}
