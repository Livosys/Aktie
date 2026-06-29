import React, { useEffect, useState } from 'react';

// Interactive Brokers Paper — Phase 1 read-only preview page.
//
// This page is purely informational. It renders the IB Paper preview status and
// the already-approved strategies. There are NO execute / order / buy / sell
// buttons here — order sending is blocked in Phase 1.

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 6_500;
const SAFE_EXECUTION_PREVIEW_BODY = Object.freeze({
  symbol: 'QQQ',
  action: 'BUY',
  quantity: 1,
  orderType: 'MKT',
  dryRun: true,
  mockOnly: true,
  reason: 'ui_preview_status_no_order',
});

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal, ...fetchOptions } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      credentials: fetchOptions.credentials || 'include',
    });
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

// The multi-strategy plan is the slowest IB read and, when bundled into the
// same 9-request burst as the other panels, was the request most likely to trip
// a transient timeout or the per-IP rate limit (it fired last). Fetch it on its
// own with a longer timeout and one retry so a single blip does not blank the
// panel for a whole 20s refresh cycle. Read-only GET — never sends an order.
const PLAN_TIMEOUT_MS = 12_000;

async function fetchMultiStrategyPlan(signal) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchJsonWithTimeout('/api/interactive-brokers/paper-multi-strategy-test-plan', {
        timeoutMs: PLAN_TIMEOUT_MS,
        signal,
      });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

const CARD_STYLE = {
  border: '1px solid rgba(148,163,184,0.18)',
  borderRadius: 16,
  padding: 20,
  background: 'rgba(15, 23, 42, 0.35)',
  marginBottom: 16,
};

const PAPER_SESSION_NOT_VERIFIED_TEXT = 'Ej verifierad via API ännu';
const PREVIEW_LIMIT = 3;

const SAFE_FALLBACK_ORDER_PREVIEW = Object.freeze({
  ok: false,
  mode: 'preview_only',
  maxPerDay: PREVIEW_LIMIT,
  cryptoBlocked: true,
  etfBlocked: true,
  qqqBlocked: true,
  executionEnabled: false,
  orderQueueEnabled: false,
  brokerExecutionEnabled: false,
  liveTradingEnabled: false,
  orderSendingBlocked: true,
  wouldCreateIbPaperOrder: false,
  candidates: [],
  generatedAt: null,
  summary: {
    totalCandidates: 0,
    allowedCandidates: 0,
    blockedCandidates: 0,
    availableAllowedCandidates: 0,
    availableBlockedCandidates: 0,
    previewSource: 'safe_fallback',
    noteSv: 'Förhandsvisning är inte tillgänglig just nu. Inga order skickas ännu.',
    blockerCounts: {},
    cryptoBlocked: true,
    etfBlocked: true,
    qqqBlocked: true,
  },
});

// Safe blocked fallback used whenever the API fails (error / 404 / timeout).
// Every value here is the SAFE / blocked state. It must NEVER imply that any
// action, order, broker, or live trading is allowed.
const SAFE_FALLBACK_STATUS = Object.freeze({
  ok: false,
  dryRun: true,
  ibPaper: { enabled: false, previewEnabled: false, orderQueueEnabled: false, executionEnabled: false },
  safety: { mode: 'paper_only', actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false },
  orderSendingBlocked: true,
  orderQueueBlocked: true,
  executionBlocked: true,
  wouldCreateIbPaperOrder: false,
  blockedReason: 'api_unavailable_safe_fallback',
  nextPhaseLocked: {
    paperOrderQueue: { locked: true },
    brokerExecution: { locked: true },
    liveTrading: { locked: true },
    manualApprovalRequired: true,
  },
  approvedStrategies: [],
  approvedStrategiesCount: 0,
  approvedStrategiesSource: { available: false, status: 'degraded' },
  internalPaperTradingUnaffected: true,
  connection: {
    connectionCheckEnabled: false,
    gatewayReachable: false,
    host: '127.0.0.1',
    port: null,
    portConfigured: false,
    clientIdConfigured: false,
    paperMode: 'unknown',
    paperModeVerified: false,
    blockedReason: 'ib_connection_check_disabled',
  },
});

// Safe fallback for /execution-status. Every value is the SAFE/blocked state.
// Used when that endpoint fails so the Control Room never renders a dangerous
// "Live broker-execution: På" from an absent payload.
const SAFE_FALLBACK_EXECUTION_STATUS = Object.freeze({
  ok: false,
  executionEnabled: false,
  liveTradingEnabled: false,
  broker_enabled: false,
  can_place_orders: false,
  actions_allowed: false,
  orderSendingBlocked: true,
  blockedReason: 'api_unavailable_safe_fallback',
  readinessProfile: {},
});

// Safe fallback for the POST /paper-execution-preview probe. These are the
// exact safe values required when the preview cannot be loaded: nothing is
// ever sent, nothing would be placed, real submit stays disallowed.
const SAFE_FALLBACK_EXECUTION_PREVIEW = Object.freeze({
  ok: false,
  dryRun: true,
  mockOnly: true,
  wouldPlaceOrder: false,
  orderSent: false,
  placeOrderCalled: false,
  realSubmitAllowed: false,
  wouldCreateIbPaperOrder: false,
  finalGateArmCreated: false,
  requestedOrder: null,
  blockers: ['api_unavailable_safe_fallback'],
  blockedReason: 'api_unavailable_safe_fallback',
  preflight: {},
  readOnlyApiRisk: {},
});

function Badge({ ok, labelTrue, labelFalse }) {
  const good = ok === true;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: good ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.15)',
        color: good ? '#4ade80' : '#f87171',
        border: `1px solid ${good ? 'rgba(34,197,94,0.4)' : 'rgba(248,113,113,0.4)'}`,
      }}
    >
      {good ? labelTrue : labelFalse}
    </span>
  );
}

// Guard badge for the multi-strategy plan. When the plan endpoint itself did
// not load, render "Okänt" rather than a misleading "Nej"/"Öppna" guard value.
function PlanGuardBadge({ loaded, ok, labelTrue, labelFalse }) {
  if (!loaded) return <span style={{ color: '#94a3b8' }}>Okänt</span>;
  return <Badge ok={ok} labelTrue={labelTrue} labelFalse={labelFalse} />;
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', gap: 12 }}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export default function InteractiveBrokersPage() {
  const [state, setState] = useState({
    loading: true,
    error: null,
    status: null,
    readiness: null,
    preview: null,
    orderPreview: null,
    executionStatus: null,
    executionPreview: null,
    tradeBlueprint: null,
    readOnlyState: null,
    multiStrategyPlan: null,
  });

  useEffect(() => {
    let alive = true;
    let controller = null;
    const load = async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        // Fetch every panel independently with allSettled. One slow/failing
        // endpoint must NOT blank the whole page or force a global fallback —
        // each panel renders from its own result (or its own safe fallback).
        // Only a failed primary /status drives the page-level banner; e.g. the
        // multi-strategy plan still renders if its own endpoint succeeds even
        // when /status or any other endpoint times out.
        // Plan fetched on its own (own timeout + retry), in parallel with the
        // other panels but outside their burst, so it is not the request that
        // gets starved by the per-IP rate limit / shared 6.5s timeout.
        const planPromise = fetchMultiStrategyPlan(controller.signal).then(
          (v) => v,
          () => null,
        );
        const [settled, multiStrategyPlan] = await Promise.all([
          Promise.allSettled([
            fetchJsonWithTimeout('/api/interactive-brokers/status', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/connection-readiness', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/approved-strategies-preview', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/order-preview', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/execution-status', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/paper-execution-preview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(SAFE_EXECUTION_PREVIEW_BODY),
              signal: controller.signal,
            }),
            fetchJsonWithTimeout('/api/interactive-brokers/trade-blueprint', { signal: controller.signal }),
            fetchJsonWithTimeout('/api/interactive-brokers/paper-readonly-state', { signal: controller.signal }),
          ]),
          planPromise,
        ]);
        if (!alive) return;
        const valueOf = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
        const reasonOf = (i) => (settled[i].status === 'rejected' ? (settled[i].reason?.message || String(settled[i].reason)) : null);
        const status = valueOf(0);
        setState({
          loading: false,
          // The banner reflects only the primary status endpoint. Other panels
          // own their safe fallbacks and must not trip the global blocked banner.
          error: status ? null : (reasonOf(0) || 'status_unavailable'),
          status,
          readiness: valueOf(1),
          preview: valueOf(2),
          orderPreview: valueOf(3),
          executionStatus: valueOf(4),
          executionPreview: valueOf(5),
          tradeBlueprint: valueOf(6),
          readOnlyState: valueOf(7),
          multiStrategyPlan,
        });
      } catch (err) {
        // Defensive: allSettled should never throw, but never leave the page in
        // a non-safe state.
        if (!alive) return;
        setState((s) => ({ ...s, loading: false, error: err.message || String(err) }));
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      if (controller) controller.abort();
      clearInterval(timer);
    };
  }, []);

  const { loading, error, status, readiness, preview, orderPreview, executionStatus, executionPreview, tradeBlueprint, readOnlyState, multiStrategyPlan } = state;

  // On ANY error (404 / timeout / network) fall back to the safe blocked state.
  // Never derive values from an absent payload — that could accidentally render
  // a non-blocked state. Always use explicit safe fallback values instead.
  const usingFallback = !!error || (!loading && !status);
  const eff = usingFallback ? SAFE_FALLBACK_STATUS : (status || SAFE_FALLBACK_STATUS);

  const ib = eff.ibPaper || {};
  const safety = eff.safety || {};
  const nextPhase = eff.nextPhaseLocked || {};
  // Each panel renders from its own endpoint result (or its own safe fallback),
  // independent of whether the primary /status endpoint succeeded. A missing
  // payload must always resolve to the SAFE/blocked state, never a dangerous one.
  const conn = readiness || eff.connection || SAFE_FALLBACK_STATUS.connection;
  const strategies = preview?.approvedStrategies || eff.approvedStrategies || [];
  const ibPreview = orderPreview || SAFE_FALLBACK_ORDER_PREVIEW;
  const executionStatusView = executionStatus || SAFE_FALLBACK_EXECUTION_STATUS;
  const previewLoaded = executionPreview != null;
  const executionPreviewView = executionPreview || SAFE_FALLBACK_EXECUTION_PREVIEW;
  const tradeBlueprintView = tradeBlueprint;
  const readOnlyStateView = readOnlyState;
  const readOnlyStateLoaded = readOnlyState != null;
  const multiPlanView = (multiStrategyPlan && multiStrategyPlan.ok === true) ? multiStrategyPlan : null;
  const multiPlanLoaded = multiPlanView != null;
  const multiPlanLimits = multiPlanView?.limits || {};
  const multiPlanCandidates = Array.isArray(multiPlanView?.candidates) ? multiPlanView.candidates : [];
  const multiPlanCurrentBlockers = Array.isArray(multiPlanView?.currentBlockers) ? multiPlanView.currentBlockers : [];
  const currentBlueprint = tradeBlueprintView?.selectedBlueprint || tradeBlueprintView?.previewBlueprint || null;
  const firstOrderReady = tradeBlueprintView?.selectedBlueprintSafety?.safeForArm === true
    && currentBlueprint?.blueprintReady === true
    && currentBlueprint?.manualApprovalReady === true;
  const blueprintBlockers = [
    ...(Array.isArray(tradeBlueprintView?.selectedBlueprintSafety?.blockers) ? tradeBlueprintView.selectedBlueprintSafety.blockers : []),
    ...(Array.isArray(currentBlueprint?.blockers) ? currentBlueprint.blockers : []),
  ].filter(Boolean);
  const uniqueBlueprintBlockers = [...new Set(blueprintBlockers)];
  const readOnlyOpenOrderCount = Array.isArray(readOnlyStateView?.openOrders) ? readOnlyStateView.openOrders.length : 0;
  const readOnlyPositionCount = Array.isArray(readOnlyStateView?.positions) ? readOnlyStateView.positions.length : 0;
  const readOnlyExecutionCount = Array.isArray(readOnlyStateView?.executions) ? readOnlyStateView.executions.length : 0;
  const aaplCheck = readOnlyStateView?.aaplCheck || {};
  const previewSafe = previewLoaded
    && executionPreviewView?.dryRun === true
    && executionPreviewView?.mockOnly === true
    && executionPreviewView?.wouldPlaceOrder === false
    && executionPreviewView?.orderSent === false
    && executionPreviewView?.placeOrderCalled === false
    && executionPreviewView?.realSubmitAllowed === false;
  const sourceStatus = usingFallback
    ? 'degraded'
    : ((preview?.approvedStrategiesSource || eff.approvedStrategiesSource || {}).status || 'unknown');
  const sourceDegraded = sourceStatus === 'degraded' || preview?.degraded === true;
  const blockedReason = usingFallback ? 'api_unavailable_safe_fallback' : (eff.blockedReason || 'unknown');
  const previewSummary = ibPreview.summary || SAFE_FALLBACK_ORDER_PREVIEW.summary;
  const previewCandidates = Array.isArray(ibPreview.candidates) ? ibPreview.candidates : [];

  function formatDirection(value) {
    if (!value) return 'Okänd';
    const raw = String(value).toLowerCase();
    if (raw === 'long') return 'Lång';
    if (raw === 'short') return 'Kort';
    return value;
  }

  function formatConfidence(candidate) {
    if (candidate == null) return '–';
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? String(candidate) : '–';
    return String(candidate);
  }

  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto', padding: '32px 24px' }}>
      <div className="page-head" style={{ marginBottom: 16 }}>
        <h1>Interactive Brokers Paper</h1>
        <p style={{ color: '#94a3b8', lineHeight: 1.6 }}>
	          Interactive Brokers Paper är separat från intern paper trading.
	          {' '}IB Paper API-status och safe preview läses read-only.
	          {' '}Real submit är låst och inga order skickas från denna vy.
        </p>
      </div>

      {loading && <div style={CARD_STYLE}>Laddar…</div>}

      {!loading && (
        <>
          {usingFallback && (
            <div style={{ ...CARD_STYLE, borderColor: 'rgba(248,113,113,0.5)', background: 'rgba(248,113,113,0.08)' }}>
              <strong style={{ color: '#f87171' }}>API-status kunde inte laddas. Sidan visar säkra blockerade fallback-värden.</strong>
              {error && (
                <div style={{ color: '#94a3b8', marginTop: 8, fontSize: 13 }}>Detalj: {error}</div>
              )}
            </div>
          )}

          {/* IB Paper status */}
          <div style={CARD_STYLE}>
	            <h2 style={{ marginTop: 0 }}>IB Paper Control Room</h2>
	            <Row label="IB Paper API">
	              <Badge ok={conn.gatewayReachable === true} labelTrue="Verifierad" labelFalse="Ej verifierad" />
	            </Row>
	            <Row label="Paper account">
	              <code>{executionStatusView?.readinessProfile?.paperAccountId || conn.paperAccountId || 'Saknas'}</code>
	            </Row>
	            <Row label="IB Paper execution feature">
	              <Badge ok={executionStatusView?.executionEnabled === true} labelTrue="Aktiv" labelFalse="Av" />
	            </Row>
	            <Row label="Preview">
	              <Badge ok={previewSafe} labelTrue="Verifierad / Safe" labelFalse="Ej körd" />
	            </Row>
	            <Row label="Bracket helper">
	              <Badge ok={executionPreviewView?.preflight?.bracketSubmissionPlanReady === true} labelTrue="Redo i mock/read-only" labelFalse="Ej redo" />
	            </Row>
	            <Row label="Real submit">
	              <Badge ok={executionPreviewView?.realSubmitAllowed !== true} labelTrue="Låst" labelFalse="Öppen" />
	            </Row>
	            <Row label="Final gate">
	              <Badge ok={executionPreviewView?.finalGateArmCreated !== true} labelTrue="Inte armerad" labelFalse="Armerad" />
	            </Row>
	            <Row label="Read-Only API">
	              <Badge ok={executionPreviewView?.readOnlyApiRisk?.likelyBlocksRealOrder === true} labelTrue="På / kräver manuell kontroll" labelFalse="Okänt" />
	            </Row>
	            <Row label="Live broker-execution">
	              <Badge ok={executionStatusView?.liveTradingEnabled === false && executionStatusView?.broker_enabled === false} labelTrue="Av" labelFalse="På" />
	            </Row>
	            <Row label="Riktiga order">
	              <Badge ok={executionPreviewView?.wouldPlaceOrder === false && executionPreviewView?.orderSent === false} labelTrue="Blockerade" labelFalse="Risk" />
	            </Row>
	            <Row label="Paper-order skickad">
	              <Badge ok={executionPreviewView?.orderSent === false} labelTrue="Nej" labelFalse="Ja" />
	            </Row>
	            <Row label="Dry-run / läsläge">
	              <Badge ok={eff.dryRun === true} labelTrue="Ja" labelFalse="Nej" />
	            </Row>
          </div>

          {/* Order sending blocked */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Order är blockerat</h2>
	            <Row label="Paper-route">
	              <Badge ok={executionStatusView?.executionEnabled === true} labelTrue="Aktiv, submit låst" labelFalse="Av" />
	            </Row>
	            <Row label="Skulle skapa IB Paper-order">
	              <Badge ok={executionPreviewView?.wouldCreateIbPaperOrder === false} labelTrue="Nej" labelFalse="Ja" />
	            </Row>
	            <Row label="Orsak (blockedReason)">
	              <code style={{ color: '#fbbf24' }}>{executionStatusView?.blockedReason || executionPreviewView?.blockedReason || blockedReason}</code>
	            </Row>
	            <p style={{ color: '#94a3b8', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
	              Execution feature är aktiv för IB Paper-preview, men real submit är låst.
	              Inga order skickas.
	            </p>
	          </div>

	          <div style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.35)' }}>
	            <h2 style={{ marginTop: 0 }}>IB Paper Execution Preview</h2>
	            <p style={{ color: '#94a3b8', marginTop: 0, lineHeight: 1.6 }}>
	              Preview skickar ingen order. UI anropar endast <code>/api/interactive-brokers/paper-execution-preview</code> med dryRun=true och mockOnly=true.
	            </p>
	            <Row label="dryRun">
	              <Badge ok={executionPreviewView?.dryRun === true} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="mockOnly">
	              <Badge ok={executionPreviewView?.mockOnly === true} labelTrue="true" labelFalse="false" />
	            </Row>
	            <Row label="wouldPlaceOrder">
	              <Badge ok={executionPreviewView?.wouldPlaceOrder === false} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="orderSent">
	              <Badge ok={executionPreviewView?.orderSent === false} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="placeOrderCalled">
	              <Badge ok={executionPreviewView?.placeOrderCalled === false} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="realSubmitAllowed">
	              <Badge ok={executionPreviewView?.realSubmitAllowed === false} labelTrue="false" labelFalse="true" />
	            </Row>
	            <Row label="requestedOrder">
	              <code>{previewLoaded && executionPreviewView?.requestedOrder ? `${executionPreviewView.requestedOrder.symbol} ${executionPreviewView.requestedOrder.action} x${executionPreviewView.requestedOrder.quantity}` : '–'}</code>
	            </Row>
	            <Row label="blockers">
	              <code>{Array.isArray(executionPreviewView?.blockers) && executionPreviewView.blockers.length ? executionPreviewView.blockers.join(', ') : 'none'}</code>
	            </Row>
	          </div>

          <div style={{ ...CARD_STYLE, borderColor: firstOrderReady ? 'rgba(34,197,94,0.35)' : 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Första IB Paper-order readiness</h2>
            <p style={{ color: '#94a3b8', marginTop: 0, lineHeight: 1.6 }}>
              Read-only sammanställning från <code>trade-blueprint</code> och <code>paper-readonly-state</code>.
            </p>
            <Row label="Redo för första IB Paper-order">
              <Badge ok={firstOrderReady} labelTrue="JA" labelFalse="NEJ" />
            </Row>
            <Row label="selectedBlueprint">
              <code>{tradeBlueprintView?.selectedBlueprint ? tradeBlueprintView.selectedBlueprint.blueprintId : 'saknas'}</code>
            </Row>
            <Row label="Preview blueprint">
              <code>{currentBlueprint?.symbol || '–'} {currentBlueprint?.strategyId || ''}</code>
            </Row>
            <Row label="Side">
              <code>{currentBlueprint?.side || '–'}</code>
            </Row>
            <Row label="Original quantity">
              <code>{currentBlueprint?.originalQuantity ?? currentBlueprint?.quantity ?? '–'}</code>
            </Row>
            <Row label="Effective quantity">
              <code>{currentBlueprint?.effectiveQuantity ?? currentBlueprint?.quantity ?? '–'}</code>
            </Row>
            <Row label="Stop loss % / min">
              <code>{currentBlueprint?.stopLossPct ?? '–'} / {currentBlueprint?.minStopLossPct ?? tradeBlueprintView?.requiredStopLossMinPct ?? '–'}</code>
            </Row>
            <Row label="blueprintReady">
              <Badge ok={currentBlueprint?.blueprintReady === true} labelTrue="true" labelFalse="false" />
            </Row>
            <Row label="manualApprovalReady">
              <Badge ok={currentBlueprint?.manualApprovalReady === true} labelTrue="true" labelFalse="false" />
            </Row>
            <Row label="Manual approval">
              <code>{tradeBlueprintView?.manualApproval?.approvalStatus || 'unknown'}</code>
            </Row>
            <Row label="Open orders / positions / executions">
              <code>{readOnlyOpenOrderCount} / {readOnlyPositionCount} / {readOnlyExecutionCount}</code>
            </Row>
            <Row label="AAPL finns i IB">
              {readOnlyStateLoaded ? (
                <Badge
                  ok={aaplCheck.hasAaplOpenOrder !== true && aaplCheck.hasAaplPosition !== true && (!Array.isArray(aaplCheck.matchingExecutions) || aaplCheck.matchingExecutions.length === 0)}
                  labelTrue="Nej"
                  labelFalse="Ja"
                />
              ) : (
                <span style={{ color: '#94a3b8' }}>Okänt (read-only state ej laddad)</span>
              )}
            </Row>
            <Row label="Blockers">
              <code style={{ color: uniqueBlueprintBlockers.length ? '#fbbf24' : '#4ade80' }}>
                {uniqueBlueprintBlockers.length ? uniqueBlueprintBlockers.join(', ') : 'none'}
              </code>
            </Row>
          </div>

          {/* Connection readiness (read-only) */}
          <div style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Anslutnings-readiness (IB Gateway/TWS)</h2>
            <div style={{ color: '#94a3b8', marginTop: 0, marginBottom: 12, lineHeight: 1.7 }}>
              • IBKR-lösenord sparas inte i Trading OS.<br />
              • Logga in manuellt i IB Gateway/TWS med Paper-kontot.<br />
              • Connection check är endast läsning.<br />
              Trading OS gör endast en TCP-readiness-check mot IB Gateway. Paper-läge bekräftas inte via IB API i denna fas. Order är fortfarande blockerade.
            </div>
            <Row label="Anslutningskontroll aktiverad">
              <Badge ok={conn.connectionCheckEnabled === true} labelTrue="På" labelFalse="Av" />
            </Row>
            <Row label="Connection status">
              <code>{conn.status || 'unknown'}</code>
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
              <code>{conn.host || '127.0.0.1'}</code>
            </Row>
            <Row label="Gateway port">
              <code>{conn.portConfigured ? conn.port : 'ej konfigurerad'}</code>
            </Row>
            <Row label="Paper session">
              <span style={{ color: '#dbeafe' }}>
                {conn.paperModeVerified === true ? (conn.paperMode || 'verifierad') : PAPER_SESSION_NOT_VERIFIED_TEXT}
              </span>
            </Row>
	            <Row label="Real submit">
	              <Badge ok={executionPreviewView?.realSubmitAllowed !== true} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
            <Row label="Orsak (blockedReason)">
              <code style={{ color: '#fbbf24' }}>{conn.blockedReason || 'unknown'}</code>
            </Row>
          </div>

          {/* Safety status */}
          <div style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Safety-status</h2>
            <Row label="mode">
              <code>{safety.mode || 'paper_only'}</code>
            </Row>
            <Row label="actions_allowed">
              <Badge ok={safety.actions_allowed === false} labelTrue="false" labelFalse="true" />
            </Row>
            <Row label="can_place_orders">
              <Badge ok={safety.can_place_orders === false} labelTrue="false" labelFalse="true" />
            </Row>
            <Row label="live_trading_enabled">
              <Badge ok={safety.live_trading_enabled === false} labelTrue="false" labelFalse="true" />
            </Row>
            <Row label="broker_enabled">
              <Badge ok={safety.broker_enabled === false} labelTrue="false" labelFalse="true" />
            </Row>
          </div>

          {/* Approved strategies */}
          <div style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>Godkända strategier för framtida IB Paper-preview</h2>
            <p style={{ color: '#94a3b8', marginTop: 0, lineHeight: 1.6 }}>
              Endast redan godkända strategier visas här (läses från systemets befintliga
              approval/allowlist). Ingen ny approval skapas och inga regler ändras.
            </p>
            {sourceDegraded && (
              <div style={{ color: '#fbbf24', padding: '8px 0' }}>
                Approval/allowlist-källan är inte tillgänglig just nu — visar tom lista.
                Detta är inte ett fel (degraded status).
              </div>
            )}
            {strategies.length === 0 ? (
              <div style={{ color: '#94a3b8', padding: '8px 0' }}>
                Inga godkända strategier hittades. (Empty status — inte ett fel.)
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#94a3b8' }}>
                    <th style={{ padding: '6px 8px' }}>Strategi</th>
                    <th style={{ padding: '6px 8px' }}>ID</th>
                    <th style={{ padding: '6px 8px' }}>Paper-runtime</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                      <td style={{ padding: '6px 8px' }}>{s.name}</td>
                      <td style={{ padding: '6px 8px' }}><code style={{ color: '#94a3b8' }}>{s.id}</code></td>
                      <td style={{ padding: '6px 8px' }}>
                        <Badge ok={s.paperRuntimeReady === true} labelTrue="Redo" labelFalse={s.runtimeConnectionStatus || 'väntar'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* IB Paper preview only */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Dagens IB Paper-preview</h2>
            <p style={{ color: '#94a3b8', marginTop: 0, lineHeight: 1.6 }}>
              Förhandsvisning endast. Inga order skickas ännu.
              {' '}Previewn bygger på Trading OS-kandidater och visar varför varje kandidat är tillåten eller blockerad.
            </p>
            <div style={{ color: '#94a3b8', marginTop: 0, marginBottom: 12, lineHeight: 1.7 }}>
              • Max {ibPreview.maxPerDay || PREVIEW_LIMIT} kandidater per dag.<br />
              • Crypto/ETF/QQQ blockerat i denna fas.<br />
              • Endast approved strategies och tydlig riktning visas som tillåtna.
            </div>
            <Row label="Preview-läge">
              <code>{ibPreview.mode || 'preview_only'}</code>
            </Row>
            <Row label="Tillåtna kandidater">
              <code>{previewSummary.allowedCandidates || 0}</code>
            </Row>
            <Row label="Blockerade kandidater">
              <code>{previewSummary.blockedCandidates || 0}</code>
            </Row>
            <Row label="Order skickas ännu">
              <Badge ok={ibPreview.orderSendingBlocked === true} labelTrue="Nej" labelFalse="Ja" />
            </Row>
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(59,130,246,0.22)', color: '#dbeafe', lineHeight: 1.6 }}>
              {previewSummary.noteSv || 'Förhandsvisning endast. Inga order skickas ännu.'}
            </div>
            <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
              {previewCandidates.length === 0 ? (
                <div style={{ color: '#94a3b8' }}>
                  Inga preview-kandidater just nu. Inga order skickas ännu.
                </div>
              ) : previewCandidates.map((candidate, index) => {
                const ok = candidate.allowedForIbPaperPreview === true;
                const chips = Array.isArray(candidate.blockers) ? candidate.blockers : [];
                return (
                  <div
                    key={`${candidate.strategyId || 'unknown'}:${candidate.symbol || 'unknown'}:${index}`}
                    style={{
                      border: `1px solid ${ok ? 'rgba(34,197,94,0.28)' : 'rgba(248,113,113,0.35)'}`,
                      borderRadius: 14,
                      padding: 14,
                      background: ok ? 'rgba(34,197,94,0.06)' : 'rgba(248,113,113,0.06)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <strong style={{ color: '#e2e8f0' }}>
                        {candidate.symbol || '–'} · {candidate.strategyName || candidate.strategyId || 'Okänd strategi'}
                      </strong>
                      <Badge ok={ok} labelTrue="Tillåten" labelFalse="Blockerad" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10, fontSize: 14 }}>
                      <div><span style={{ color: '#94a3b8' }}>Strategi:</span> {candidate.strategyId || '–'}</div>
                      <div><span style={{ color: '#94a3b8' }}>Riktning:</span> {formatDirection(candidate.direction)}</div>
                      <div><span style={{ color: '#94a3b8' }}>Källa:</span> {candidate.source || '–'}</div>
                      <div><span style={{ color: '#94a3b8' }}>Confidence/score:</span> {formatConfidence(candidate.confidence ?? candidate.gateScore)}</div>
                    </div>
                    <div style={{ marginTop: 10, color: '#cbd5e1', lineHeight: 1.55 }}>
                      {candidate.reasonSv || 'Förhandsvisning endast. Inga order skickas ännu.'}
                    </div>
                    {chips.length > 0 && (
                      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {chips.map((chip) => (
                          <span
                            key={chip}
                            style={{
                              display: 'inline-block',
                              padding: '2px 10px',
                              borderRadius: 999,
                              fontSize: 12,
                              color: '#fca5a5',
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
              })}
            </div>
          </div>

          {/* Next phase locked */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(251,191,36,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Nästa fas — låst</h2>
            <Row label="Paper order-kö">
              <Badge ok={nextPhase.paperOrderQueue?.locked !== false} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
	            <Row label="Live broker-execution">
	              <Badge ok={nextPhase.brokerExecution?.locked !== false} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
            <Row label="Live trading">
              <Badge ok={nextPhase.liveTrading?.locked !== false} labelTrue="Låst" labelFalse="Öppen" />
            </Row>
            <Row label="Manuellt godkännande krävs">
              <Badge ok={nextPhase.manualApprovalRequired === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <p style={{ color: '#94a3b8', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Inga framtida steg (order-kö, broker-execution, live trading) kan aktiveras härifrån.
              Varje steg kräver explicit manuellt godkännande och en separat byggnation.
            </p>
          </div>

          {/* IB Paper Multi-Strategy Test Plan (read-only, Phase 1) */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(59,130,246,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>IB Paper Multi-Strategy Test Plan</h2>
            <p style={{ color: '#fbbf24', marginTop: 0, marginBottom: 12, lineHeight: 1.6, fontSize: 13 }}>
              Detta är endast en read-only plan. Den skickar inga order. För att skicka
              IB Paper-orders krävs en separat manuell submit-process.
            </p>
            {!multiPlanLoaded && (
              <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 10, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', fontSize: 13 }}>
                Planen kunde inte laddas just nu. Guard-värden visas som Okänt (aldrig falska Nej). Inga order skickas.
              </div>
            )}
            <Row label="Läge">
              <span style={{ color: '#cbd5e1' }}>Read-only plan</span>
            </Row>
            <Row label="Multi-Strategy Test Mode aktivt">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanView?.enabled === true} labelTrue="På" labelFalse="Av" />
            </Row>
            <Row label="Submit-routes aktiva">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanView?.submitRoutesEnabled !== true} labelTrue="Låsta" labelFalse="Öppna" />
            </Row>
            <Row label="Max kandidater">
              <span style={{ color: '#cbd5e1' }}>{multiPlanLimits.maxCandidates ?? '–'}</span>
            </Row>
            <Row label="Global daily cap">
              <span style={{ color: '#cbd5e1' }}>{multiPlanLimits.globalDailyCap ?? '–'}</span>
            </Row>
            <Row label="Per-strategy daily cap">
              <span style={{ color: '#cbd5e1' }}>{multiPlanLimits.perStrategyDailyCap ?? '–'}</span>
            </Row>
            <Row label="Force quantity">
              <span style={{ color: '#cbd5e1' }}>{multiPlanLimits.forceQuantity ?? '–'}</span>
            </Row>
            <Row label="Bracket required">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanLimits.bracketRequired === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Entry-only blockerat">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanLimits.entryOnlyBlocked === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Open order/position guard">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanLimits.openOrderPositionGuard === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Duplicate guard (min)">
              <span style={{ color: '#cbd5e1' }}>{multiPlanLimits.duplicateGuardMinutes ?? '–'}</span>
            </Row>
            <Row label="ETF/QQQ tillåtet">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanView?.etfAllowed === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Krypto blockerat">
              <PlanGuardBadge loaded={multiPlanLoaded} ok={multiPlanLimits.cryptoBlocked !== false} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <Row label="Kandidater (count/allowed/blocked)">
              <span style={{ color: '#cbd5e1' }}>
                {(multiPlanView?.counts?.candidateCount ?? 0)} / {(multiPlanView?.counts?.allowedCount ?? 0)} / {(multiPlanView?.counts?.blockedCount ?? 0)}
              </span>
            </Row>
            <Row label="IB Paper-konto">
              <span style={{ color: '#cbd5e1' }}>{multiPlanView?.ibState?.account || 'DUQ565596'}</span>
            </Row>

            {multiPlanCurrentBlockers.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 13, color: '#94a3b8' }}>
                Aktuella blockerare:{' '}
                <span style={{ color: '#f87171' }}>{multiPlanCurrentBlockers.join(', ')}</span>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ color: '#94a3b8', marginBottom: 8, fontSize: 13 }}>
                Kandidater ({multiPlanView?.summary?.allowedCount ?? 0} allowed / {multiPlanView?.summary?.blockedCount ?? 0} blocked):
              </div>
              {multiPlanCandidates.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: 13 }}>
                  Inga IB Paper-kandidater tillgängliga just nu (read-only plan speglar nuvarande data).
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>Symbol</th>
                        <th style={{ padding: '6px 8px' }}>Strategi</th>
                        <th style={{ padding: '6px 8px' }}>Riktning</th>
                        <th style={{ padding: '6px 8px' }}>Status</th>
                        <th style={{ padding: '6px 8px' }}>Force qty</th>
                        <th style={{ padding: '6px 8px' }}>Bracket</th>
                        <th style={{ padding: '6px 8px' }}>Open order</th>
                        <th style={{ padding: '6px 8px' }}>Position</th>
                        <th style={{ padding: '6px 8px' }}>Duplicate</th>
                        <th style={{ padding: '6px 8px' }}>Cap</th>
                        <th style={{ padding: '6px 8px' }}>Blockers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {multiPlanCandidates.map((c, i) => (
                        <tr key={c.blueprintId || `${c.symbol}:${c.strategyId}:${i}`} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                          <td style={{ padding: '6px 8px' }}>{c.symbol || '–'}</td>
                          <td style={{ padding: '6px 8px' }}>{c.strategyId || '–'}</td>
                          <td style={{ padding: '6px 8px' }}>{formatDirection(c.direction)}</td>
                          <td style={{ padding: '6px 8px' }}>
                            <Badge ok={c.allowed === true} labelTrue="Allowed" labelFalse="Blocked" />
                          </td>
                          <td style={{ padding: '6px 8px' }}>{c.wouldForceQuantity ?? '–'}</td>
                          <td style={{ padding: '6px 8px' }}>{c.wouldRequireBracket ? 'Ja' : 'Nej'}</td>
                          <td style={{ padding: '6px 8px', color: c.openOrderConflict ? '#f87171' : '#cbd5e1' }}>{c.openOrderConflict ? 'Ja' : 'Nej'}</td>
                          <td style={{ padding: '6px 8px', color: c.positionConflict ? '#f87171' : '#cbd5e1' }}>{c.positionConflict ? 'Ja' : 'Nej'}</td>
                          <td style={{ padding: '6px 8px', color: c.duplicateConflict ? '#f87171' : '#cbd5e1' }}>{c.duplicateConflict ? 'Ja' : 'Nej'}</td>
                          <td style={{ padding: '6px 8px', color: (c.perStrategyCapReached || c.globalCapReached) ? '#f87171' : '#cbd5e1' }}>{(c.perStrategyCapReached || c.globalCapReached) ? 'Ja' : 'Nej'}</td>
                          <td style={{ padding: '6px 8px', color: '#f87171' }}>{Array.isArray(c.blockers) && c.blockers.length ? c.blockers.join(', ') : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p style={{ color: '#94a3b8', marginBottom: 0, marginTop: 12, lineHeight: 1.6, fontSize: 13 }}>
              Källa: <code>/api/interactive-brokers/paper-multi-strategy-test-plan</code> (read-only).
              Inga nya orderknappar. Safety: actions_allowed=false, can_place_orders=false,
              live_trading_enabled=false, broker_enabled=false.
            </p>
          </div>

          {/* Separation note */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.3)' }}>
            <h2 style={{ marginTop: 0 }}>Separation från intern paper trading</h2>
            <Row label="Intern paper trading opåverkad">
              <Badge ok={eff.internalPaperTradingUnaffected === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
            <p style={{ color: '#94a3b8', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              Den interna paper trading-funktionen körs helt separat och är oförändrad.
              Den här vyn läser endast status och godkända strategier.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
