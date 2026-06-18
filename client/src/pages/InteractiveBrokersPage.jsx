import React, { useEffect, useState } from 'react';

// Interactive Brokers Paper — Phase 1 read-only preview page.
//
// This page is purely informational. It renders the IB Paper preview status and
// the already-approved strategies. There are NO execute / order / buy / sell
// buttons here — order sending is blocked in Phase 1.

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 6_500;

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

const CARD_STYLE = {
  border: '1px solid rgba(148,163,184,0.18)',
  borderRadius: 16,
  padding: 20,
  background: 'rgba(15, 23, 42, 0.35)',
  marginBottom: 16,
};

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

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', gap: 12 }}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export default function InteractiveBrokersPage() {
  const [state, setState] = useState({ loading: true, error: null, status: null, preview: null });

  useEffect(() => {
    let alive = true;
    let controller = null;
    const load = async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        const [status, preview] = await Promise.all([
          fetchJsonWithTimeout('/api/interactive-brokers/status', { signal: controller.signal }),
          fetchJsonWithTimeout('/api/interactive-brokers/approved-strategies-preview', { signal: controller.signal }),
        ]);
        if (!alive) return;
        setState({ loading: false, error: null, status, preview });
      } catch (err) {
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

  const { loading, error, status, preview } = state;
  const ib = status?.ibPaper || {};
  const safety = status?.safety || {};
  const strategies = preview?.approvedStrategies || status?.approvedStrategies || [];

  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto', padding: '32px 24px' }}>
      <div className="page-head" style={{ marginBottom: 16 }}>
        <h1>Interactive Brokers Paper</h1>
        <p style={{ color: '#94a3b8', lineHeight: 1.6 }}>
          Interactive Brokers Paper är separat från intern paper trading.
          {' '}Inga order skickas i denna fas. Endast godkända strategier visas här.
        </p>
      </div>

      {loading && <div style={CARD_STYLE}>Laddar…</div>}
      {error && (
        <div style={{ ...CARD_STYLE, borderColor: 'rgba(248,113,113,0.4)' }}>
          Kunde inte ladda IB Paper-status: {error}
        </div>
      )}

      {!loading && (
        <>
          {/* IB Paper status */}
          <div style={CARD_STYLE}>
            <h2 style={{ marginTop: 0 }}>IB Paper-status</h2>
            <Row label="IB Paper aktiverad">
              <Badge ok={!ib.enabled} labelTrue="Inaktiverad" labelFalse="Aktiverad" />
            </Row>
            <Row label="Preview aktiverad (feature flag)">
              <Badge ok={ib.previewEnabled === true} labelTrue="På" labelFalse="Av" />
            </Row>
            <Row label="Order queue">
              <Badge ok={!ib.orderQueueEnabled} labelTrue="Av" labelFalse="På" />
            </Row>
            <Row label="Execution">
              <Badge ok={!ib.executionEnabled} labelTrue="Av" labelFalse="På" />
            </Row>
            <Row label="Dry-run">
              <Badge ok={status?.dryRun === true} labelTrue="Ja" labelFalse="Nej" />
            </Row>
          </div>

          {/* Order sending blocked */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Order är blockerat</h2>
            <Row label="Order sending blockerad">
              <Badge ok={status?.orderSendingBlocked === true} labelTrue="Blockerad" labelFalse="Tillåten" />
            </Row>
            <Row label="Skulle skapa IB Paper-order">
              <Badge ok={status?.wouldCreateIbPaperOrder === false} labelTrue="Nej" labelFalse="Ja" />
            </Row>
            <Row label="Orsak (blockedReason)">
              <code style={{ color: '#fbbf24' }}>{status?.blockedReason || 'unknown'}</code>
            </Row>
            <p style={{ color: '#94a3b8', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
              I denna fas (Phase 1) byggs ingen order submission, ingen broker-anslutning
              och ingen execution. Inga order skickas.
            </p>
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
              Endast strategier som redan är godkända i systemets approval/allowlist visas här.
              Ingen ny approval skapas.
            </p>
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

          {/* Separation note */}
          <div style={{ ...CARD_STYLE, borderColor: 'rgba(34,197,94,0.3)' }}>
            <h2 style={{ marginTop: 0 }}>Separation från intern paper trading</h2>
            <Row label="Intern paper trading opåverkad">
              <Badge ok={status?.internalPaperTradingUnaffected === true} labelTrue="Ja" labelFalse="Nej" />
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
