import React, { useEffect, useMemo, useState } from 'react';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import FuturesTechnicalInfoPanel from '../components/futures/FuturesTechnicalInfoPanel.jsx';
import FuturesPaperStrategyApprovalPanel from '../components/futures/FuturesPaperStrategyApprovalPanel.jsx';

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 7_000;

const STATUS_COPY = 'Futures Paper använder IBKR Paper Trading som enda execution-miljö. Systemet är nu i shadow mode: strategier och orderplaner valideras, men faktisk ordersändning är avstängd tills säkerhetsgranskningen och första pilotordern har godkänts. Livekonton och riktiga pengar är blockerade.';

const TABS = [
  { id: 'oversikt', label: 'Översikt' },
  { id: 'konto', label: 'IBKR Paper-konto' },
  { id: 'positioner', label: 'Brokerpositioner' },
  { id: 'ordrar', label: 'Ordrar' },
  { id: 'fills', label: 'Fills & trades' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'ibkr', label: 'IBKR Paper Execution' },
  { id: 'godkannande', label: 'Godkännande' },
  { id: 'teknik', label: 'Teknisk info' },
  { id: 'arkiv', label: 'Historiskt sim-arkiv' },
];

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

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtNumber(value, digits = 0) {
  const n = numberOrNull(value);
  if (n == null) return 'Ej tillgängligt';
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function fmtMoney(value, currency = 'USD', digits = 0) {
  const n = numberOrNull(value);
  if (n == null) return 'Ej tillgängligt';
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function fmtTime(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return 'Ej tillgängligt';
  return new Date(ms).toLocaleString('sv-SE');
}

function fmtAge(ms) {
  const n = numberOrNull(ms);
  if (n == null || n < 0) return 'Ej tillgängligt';
  if (n < 1000) return '<1 s';
  if (n < 60_000) return `${Math.round(n / 1000)} s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)} min`;
  return `${Math.round(n / 3_600_000)} h`;
}

function sectionStyle(extra = {}) {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 16,
    boxShadow: 'var(--shadow-1, none)',
    ...extra,
  };
}

function pillTone(tone) {
  const tones = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text)', border: 'var(--border)' },
    success: { bg: 'rgba(34,197,94,0.12)', fg: 'var(--success)', border: 'rgba(34,197,94,0.30)' },
    warning: { bg: 'rgba(245,158,11,0.12)', fg: 'var(--warning)', border: 'rgba(245,158,11,0.30)' },
    danger: { bg: 'rgba(239,68,68,0.12)', fg: 'var(--danger)', border: 'rgba(239,68,68,0.30)' },
    info: { bg: 'rgba(59,130,246,0.12)', fg: 'var(--accent)', border: 'rgba(59,130,246,0.30)' },
  };
  return tones[tone] || tones.neutral;
}

function Pill({ tone = 'neutral', children }) {
  const style = pillTone(tone);
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 9px',
      borderRadius: 999,
      border: `1px solid ${style.border}`,
      background: style.bg,
      color: style.fg,
      fontSize: 11,
      fontWeight: 800,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function MetricCard({ label, value, hint, tone = 'neutral' }) {
  const style = pillTone(tone);
  return (
    <div style={{
      border: `1px solid ${style.border}`,
      background: style.bg,
      borderRadius: 8,
      padding: '12px 14px',
      minHeight: 82,
      display: 'grid',
      gap: 8,
      alignContent: 'space-between',
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>{label}</div>
      <div style={{ color: style.fg, fontSize: 22, fontWeight: 900, lineHeight: 1.05 }}>{value}</div>
      {hint ? <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.35 }}>{hint}</div> : null}
    </div>
  );
}

function SectionHeader({ eyebrow, title, summary, action }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{eyebrow}</div> : null}
        <h2 style={{ margin: '4px 0 0', fontSize: 18, lineHeight: 1.2 }}>{title}</h2>
        {summary ? <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{summary}</p> : null}
      </div>
      {action}
    </div>
  );
}

function CompactTable({ rows, columns, emptyText = 'Inga data.' }) {
  if (!rows.length) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{emptyText}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ textAlign: 'left', padding: '10px 12px', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)' }}>
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
                  {typeof col.render === 'function' ? col.render(row) : row[col.key] ?? 'Ej tillgängligt'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusTone(value) {
  const text = String(value || '').toLowerCase();
  if (['ok', 'shadow', 'shadow_ready', 'ready_waiting_for_signal', 'connected'].includes(text)) return 'success';
  if (['degraded', 'blocked', 'paused', 'pending'].includes(text)) return 'warning';
  if (['disabled', 'unknown'].includes(text)) return 'neutral';
  return 'info';
}

function yesNo(value) {
  return value === true ? 'Ja' : 'Nej';
}

export default function FuturesPaperDeskPage() {
  const [activeTab, setActiveTab] = useState('oversikt');
  const [refreshToken, setRefreshToken] = useState(0);
  const runtime = useJson('/api/futures-paper/runtime', refreshToken);
  const execution = useJson('/api/futures-paper/ibkr-paper-execution/status?connect=false', refreshToken);

  const data = runtime.data || {};
  const executionData = execution.data || {};
  const account = data.account || {};
  const currency = account.currency || executionData.account?.currency || 'USD';
  const brokerPositions = Array.isArray(data.brokerPositions) ? data.brokerPositions : [];
  const brokerOrders = Array.isArray(data.brokerOrders) ? data.brokerOrders : [];
  const brokerFills = Array.isArray(data.brokerFills || data.brokerExecutions) ? (data.brokerFills || data.brokerExecutions) : [];
  const brokerCommissions = Array.isArray(data.brokerCommissions) ? data.brokerCommissions : [];
  const reconciliation = data.brokerReconciliation || executionData.reconciliation || {};
  const legacy = data.legacyInternalSimulation || {};
  const scanner = data.scanner || {};
  const candidateQueue = data.candidateQueue || {};
  const queueCandidates = Array.isArray(candidateQueue.candidates) ? candidateQueue.candidates : [];
  const scanHistory = Array.isArray(data.scanHistory) ? data.scanHistory : [];
  const strategyOverview = Array.isArray(data.strategyOverview) ? data.strategyOverview : [];
  const statusReasons = Array.isArray(data.statusReasons) ? data.statusReasons : [];
  const flags = executionData.flags || {};
  const safety = executionData.safety || {};
  const executionClient = executionData.executionClient || {};
  const market = data.market || {};

  const dailyBrokerPnl = account.dailyPnl ?? account.realizedPnl ?? null;
  const degraded = account.degraded === true || reconciliation.degraded === true;

  const kpis = useMemo(() => [
    { label: 'Execution target', value: 'ibkr_paper', tone: 'good' },
    { label: 'Net Liquidation', value: fmtMoney(account.netLiquidation, currency), tone: account.netLiquidation == null ? 'warning' : 'blue' },
    { label: 'Available Funds', value: fmtMoney(account.availableFunds, currency), tone: account.availableFunds == null ? 'warning' : 'blue' },
    { label: 'Buying Power', value: fmtMoney(account.buyingPower, currency), tone: account.buyingPower == null ? 'warning' : 'blue' },
    { label: 'Open broker positions', value: fmtNumber(brokerPositions.length), tone: brokerPositions.length ? 'blue' : 'good' },
    { label: 'Reconciliation', value: reconciliation.status || 'unknown', tone: degraded ? 'warning' : 'good' },
  ], [account, brokerPositions.length, currency, degraded, reconciliation.status]);

  const refreshButton = (
    <button type="button" className="btn" onClick={() => setRefreshToken((value) => value + 1)}>Uppdatera</button>
  );

  return (
    <DashboardShell
      title="Futures Paper Desk"
      subtitle="IBKR Paper Trading är enda aktiva execution-miljö för Futures Paper. Intern futures-simulering är avvecklad."
      safety={data}
      tabs={TABS}
      activeTab={activeTab}
      onTab={setActiveTab}
      kpis={kpis}
    >
      <section style={{ ...sectionStyle({ marginBottom: 14, borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.08)' }) }}>
        <strong>{STATUS_COPY}</strong>
      </section>

      {runtime.error ? (
        <section style={{ ...sectionStyle({ marginBottom: 14, borderColor: 'rgba(239,68,68,0.35)' }) }}>
          <strong style={{ color: 'var(--danger)' }}>Runtime kunde inte läsas</strong>
          <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13 }}>{runtime.error}</div>
        </section>
      ) : null}

      {activeTab === 'oversikt' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 14 }}>
            <MetricCard label="Net Liquidation" value={fmtMoney(account.netLiquidation, currency)} hint={account.accountIdMasked || account.unavailableReason || 'IBKR Paper'} tone={account.netLiquidation == null ? 'warning' : 'info'} />
            <MetricCard label="Available Funds" value={fmtMoney(account.availableFunds, currency)} hint="IBKR Paper" tone={account.availableFunds == null ? 'warning' : 'neutral'} />
            <MetricCard label="Buying Power" value={fmtMoney(account.buyingPower, currency)} hint="IBKR Paper" tone={account.buyingPower == null ? 'warning' : 'neutral'} />
            <MetricCard label="Unrealized PnL" value={fmtMoney(account.unrealizedPnl, currency)} hint="IBKR Paper" />
            <MetricCard label="Realized PnL" value={fmtMoney(account.realizedPnl, currency)} hint="IBKR Paper" />
            <MetricCard label="Daily broker PnL" value={fmtMoney(dailyBrokerPnl, currency)} hint="Från brokerdata när tillgängligt" />
            <MetricCard label="Open broker positions" value={fmtNumber(brokerPositions.length)} hint="source=ibkr_paper" />
            <MetricCard label="Open broker orders" value={fmtNumber(brokerOrders.length)} hint="source=ibkr_paper" />
            <MetricCard label="Reconciliation status" value={reconciliation.status || 'unknown'} hint={reconciliation.blockedReason || 'Broker mirror'} tone={degraded ? 'warning' : 'success'} />
          </div>

          <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
            <SectionHeader
              eyebrow="Execution"
              title="IBKR Paper shadow"
              summary="Nya kandidater reserveras för IBKR Paper. Submission är avstängd tills hardening-review, shadow-verifiering och första pilotorder är godkända."
              action={refreshButton}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Pill tone={flags.executionEnabled ? 'success' : 'warning'}>IBKR_PAPER_EXECUTION_ENABLED={String(flags.executionEnabled === true)}</Pill>
              <Pill tone={flags.shadowMode ? 'success' : 'warning'}>IBKR_PAPER_EXECUTION_SHADOW_MODE={String(flags.shadowMode === true)}</Pill>
              <Pill tone={flags.submissionEnabled ? 'danger' : 'success'}>IBKR_PAPER_ORDER_SUBMISSION_ENABLED={String(flags.submissionEnabled === true)}</Pill>
              <Pill tone="success">IBKR_LIVE_EXECUTION_ENABLED=false</Pill>
              <Pill tone="success">internal_futures_simulation_enabled=false</Pill>
            </div>
          </section>
        </>
      )}

      {activeTab === 'konto' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="IBKR Paper-konto" title="Brokerkonto" summary="Alla aktiva konto-KPI:er kommer från IBKR Paper. Saknade värden visas som Ej tillgängligt." action={refreshButton} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            <MetricCard label="Account" value={account.accountIdMasked || 'Ej tillgängligt'} hint="Maskerat paper-konto" tone={account.accountIdMasked ? 'success' : 'warning'} />
            <MetricCard label="Net Liquidation" value={fmtMoney(account.netLiquidation, currency)} />
            <MetricCard label="Total Cash" value={fmtMoney(account.totalCashValue, currency)} />
            <MetricCard label="Available Funds" value={fmtMoney(account.availableFunds, currency)} />
            <MetricCard label="Buying Power" value={fmtMoney(account.buyingPower, currency)} />
            <MetricCard label="Unrealized PnL" value={fmtMoney(account.unrealizedPnl, currency)} />
            <MetricCard label="Realized PnL" value={fmtMoney(account.realizedPnl, currency)} />
            <MetricCard label="Snapshot" value={account.stale ? 'Stale' : (account.degraded ? 'Degraded' : 'OK')} hint={account.unavailableReason || fmtTime(account.updatedAt)} tone={account.degraded ? 'warning' : 'success'} />
          </div>
        </section>
      )}

      {activeTab === 'positioner' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="source=ibkr_paper" title="Brokerpositioner" summary="Aktiva positioner kommer från IBKR Paper positions API eller reconciliation mirror. Ingen intern fallback används." />
          <CompactTable
            rows={brokerPositions}
            emptyText={degraded ? `Brokerpositioner är osäkra: ${reconciliation.blockedReason || 'reconciliation_degraded'}` : 'Inga öppna brokerpositioner.'}
            columns={[
              { key: 'accountMasked', label: 'Account', render: (row) => row.accountMasked || 'Ej tillgängligt' },
              { key: 'root', label: 'Root', render: (row) => row.root || row.symbol || 'Ej tillgängligt' },
              { key: 'localSymbol', label: 'LocalSymbol' },
              { key: 'conId', label: 'conId' },
              { key: 'expiry', label: 'Expiry' },
              { key: 'side', label: 'Side' },
              { key: 'quantity', label: 'Qty', render: (row) => fmtNumber(row.quantity) },
              { key: 'averageCost', label: 'Avg cost', render: (row) => fmtNumber(row.averageCost ?? row.avgCost, 2) },
              { key: 'marketPrice', label: 'Market price', render: (row) => fmtNumber(row.marketPrice, 2) },
              { key: 'unrealizedPnl', label: 'Unrealized PnL', render: (row) => fmtMoney(row.unrealizedPnl, currency) },
              { key: 'realizedPnl', label: 'Realized PnL', render: (row) => fmtMoney(row.realizedPnl, currency) },
              { key: 'source', label: 'Source', render: () => <Pill tone="success">ibkr_paper</Pill> },
              { key: 'reconciliationTimestamp', label: 'Reconciled', render: (row) => fmtTime(row.reconciliationTimestamp) },
              { key: 'protectiveOrderStatus', label: 'Protection', render: (row) => row.protectiveOrderStatus || 'unknown' },
            ]}
          />
        </section>
      )}

      {activeTab === 'ordrar' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="source=ibkr_paper" title="Open broker orders" summary="Orderstatus kommer från IBKR Paper order lifecycle och reconciliation mirror." />
          <CompactTable
            rows={brokerOrders}
            emptyText="Inga öppna brokerorders."
            columns={[
              { key: 'orderId', label: 'OrderId' },
              { key: 'permId', label: 'PermId' },
              { key: 'orderRef', label: 'OrderRef' },
              { key: 'accountMasked', label: 'Account' },
              { key: 'localSymbol', label: 'LocalSymbol' },
              { key: 'conId', label: 'conId' },
              { key: 'action', label: 'Action' },
              { key: 'quantity', label: 'Qty', render: (row) => fmtNumber(row.quantity) },
              { key: 'orderType', label: 'Type' },
              { key: 'limitPrice', label: 'Limit', render: (row) => fmtNumber(row.limitPrice, 2) },
              { key: 'stopPrice', label: 'Stop', render: (row) => fmtNumber(row.stopPrice, 2) },
              { key: 'status', label: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status || 'unknown'}</Pill> },
              { key: 'updatedAt', label: 'Updated', render: (row) => fmtTime(row.updatedAt) },
            ]}
          />
        </section>
      )}

      {activeTab === 'fills' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="source=ibkr_paper" title="Fills & trades" summary="Nya trades skapas från execDetails, commissionReport och broker reconciliation. Legacy-resultat ingår inte i totalsiffror." />
          <CompactTable
            rows={brokerFills}
            emptyText="Inga brokerfills i reconciliation-mirrorn."
            columns={[
              { key: 'ibOrderId', label: 'IB orderId' },
              { key: 'permId', label: 'permId' },
              { key: 'execId', label: 'execId' },
              { key: 'orderRef', label: 'orderRef' },
              { key: 'strategyId', label: 'strategyId' },
              { key: 'candidateId', label: 'candidateId' },
              { key: 'conId', label: 'conId' },
              { key: 'localSymbol', label: 'localSymbol' },
              { key: 'side', label: 'side' },
              { key: 'quantity', label: 'qty', render: (row) => fmtNumber(row.quantity) },
              { key: 'fillPrice', label: 'fill price', render: (row) => fmtNumber(row.fillPrice, 2) },
              { key: 'commission', label: 'commission', render: (row) => row.commission == null ? 'Ej tillgängligt' : `${fmtNumber(row.commission, 2)} ${row.commissionCurrency || ''}` },
              { key: 'realizedResult', label: 'realized result', render: (row) => fmtMoney(row.realizedResult, currency) },
              { key: 'source', label: 'source', render: () => <Pill tone="success">ibkr_paper</Pill> },
            ]}
          />
          {brokerCommissions.length ? (
            <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12 }}>Commission reports: {fmtNumber(brokerCommissions.length)}</div>
          ) : null}
        </section>
      )}

      {activeTab === 'runtime' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="Runtime" title="Scanner och kandidater" summary="Scannern skapar server-side kandidater för IBKR Paper shadow. Intern execution är blockerad." />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <Pill tone="success">onlyActiveExecutionTarget=ibkr_paper</Pill>
            <Pill tone="success">candidate queue={fmtNumber(queueCandidates.length)}</Pill>
            <Pill tone={market.isMarketOpen || market.isOpen ? 'success' : 'warning'}>session={market.sessionLabel || market.session || 'unknown'}</Pill>
            <Pill tone={degraded ? 'warning' : 'success'}>reconciliation={reconciliation.status || 'unknown'}</Pill>
          </div>
          <CompactTable
            rows={queueCandidates}
            emptyText="Inga kandidater väntar på IBKR Paper shadow."
            columns={[
              { key: 'candidateId', label: 'Candidate' },
              { key: 'strategyId', label: 'Strategy' },
              { key: 'symbol', label: 'Root' },
              { key: 'direction', label: 'Side' },
              { key: 'executionTarget', label: 'Target', render: (row) => <Pill tone="success">{row.executionTarget || 'ibkr_paper'}</Pill> },
              { key: 'status', label: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status || 'READY_WAITING_FOR_SIGNAL'}</Pill> },
              { key: 'timestamp', label: 'Signal time', render: (row) => fmtTime(row.signalTimestamp || row.timestamp || row.createdAt) },
            ]}
          />
          <div style={{ marginTop: 14 }}>
            <SectionHeader eyebrow="Blockers" title="Status reasons" />
            <div style={{ display: 'grid', gap: 6 }}>
              {statusReasons.length ? statusReasons.map((row) => (
                <div key={row.code} style={{ color: 'var(--muted)', fontSize: 13 }}>{row.code}: {row.message}</div>
              )) : <div style={{ color: 'var(--muted)', fontSize: 13 }}>Inga runtime-reasons.</div>}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <SectionHeader eyebrow="Scan history" title="Senaste scans" />
            <CompactTable
              rows={scanHistory.map((row) => ({ ...row, id: row.scanId }))}
              emptyText="Inga scans ännu."
              columns={[
                { key: 'startedAt', label: 'Tidpunkt', render: (row) => fmtTime(row.startedAt) },
                { key: 'tradingOsSignalsRead', label: 'OS-signaler', render: (row) => fmtNumber(row.tradingOsSignalsRead ?? 0) },
                { key: 'candidatesCreated', label: 'Kandidater', render: (row) => fmtNumber(row.candidatesCreated ?? 0) },
                { key: 'executionTarget', label: 'Target', render: (row) => row.executionTarget || 'ibkr_paper' },
                { key: 'blockedByExecutionTarget', label: 'Target block', render: (row) => fmtNumber(row.blockedByExecutionTarget?.length ?? 0) },
                { key: 'status', label: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status || 'unknown'}</Pill> },
              ]}
            />
          </div>
        </section>
      )}

      {activeTab === 'ibkr' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="IBKR Paper Execution" title="Execution status" summary="Shadow mode är på, actual submit är av. Livekonto och riktiga pengar är blockerade." action={refreshButton} />
          {execution.error ? <div style={{ color: 'var(--warning)', marginBottom: 10 }}>{execution.error}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <MetricCard label="Status" value={executionData.status || 'unknown'} hint={executionData.orderSubmissionMode || safety.orderSubmissionMode || 'unknown'} tone={statusTone(executionData.status)} />
            <MetricCard label="Execution client" value={executionClient.connected ? 'Ansluten' : 'Ej ansluten'} hint={`${executionClient.host || '127.0.0.1'}:${executionClient.port || 4002}`} tone={executionClient.connected ? 'success' : 'warning'} />
            <MetricCard label="Paper account" value={executionData.paperAccountVerified ? 'Verifierat' : 'Blockerat'} hint={executionData.account?.accountIdMasked || executionData.account?.blocker || 'Ej tillgängligt'} tone={executionData.paperAccountVerified ? 'success' : 'warning'} />
            <MetricCard label="Reconciliation" value={reconciliation.status || 'unknown'} hint={reconciliation.blockedReason || 'no blocker'} tone={degraded ? 'warning' : 'success'} />
            <MetricCard label="Open orders" value={fmtNumber(reconciliation.counts?.openOrders ?? brokerOrders.length)} hint="IBKR Paper" />
            <MetricCard label="Executions" value={fmtNumber(reconciliation.counts?.executions ?? brokerFills.length)} hint="IBKR Paper" />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <Pill tone={flags.executionEnabled ? 'success' : 'warning'}>executionEnabled={String(flags.executionEnabled === true)}</Pill>
            <Pill tone={flags.shadowMode ? 'success' : 'warning'}>shadowMode={String(flags.shadowMode === true)}</Pill>
            <Pill tone={flags.submissionEnabled ? 'danger' : 'success'}>submissionEnabled={String(flags.submissionEnabled === true)}</Pill>
            <Pill tone={safety.liveAccountBlocked !== false ? 'success' : 'danger'}>liveAccountBlocked={String(safety.liveAccountBlocked !== false)}</Pill>
            <Pill tone="success">paperOnly={String(executionData.paperOnly !== false)}</Pill>
          </div>
        </section>
      )}

      {activeTab === 'godkannande' && (
        <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
          <SectionHeader eyebrow="Godkännande" title="Strategigodkännande" summary="Approval, entry contracts, session eligibility och riskregler styr om en candidate får nå IBKR Paper shadow execution." />
          <FuturesPaperStrategyApprovalPanel />
        </section>
      )}

      {activeTab === 'teknik' && (
        <>
          <section style={{ ...sectionStyle({ marginTop: 14 }) }}>
            <SectionHeader eyebrow="Tekniskt" title="Aktiva källor" summary="Aktiv konto-, positions- och fill-state kommer från IBKR Paper. Replay och Batch är separata forskningsmotorer." />
            <CompactTable
              rows={[
                { key: 'Execution target', value: 'ibkr_paper', detail: 'Enda aktiva target' },
                { key: 'Account source', value: data.technical?.accountSource || 'ibPaperAccountSummaryService', detail: 'NetLiquidation, AvailableFunds, BuyingPower' },
                { key: 'Position source', value: data.technical?.activePositionSource || 'ibPaperBrokerReconciliationService', detail: 'IBKR Paper positions API / mirror' },
                { key: 'Trade source', value: data.technical?.activeTradeSource || 'ibPaperBrokerReconciliationService', detail: 'execDetails + commissionReport' },
                { key: 'Replay', value: data.dataPipeline?.replay?.ready ? 'Redo' : (data.dataPipeline?.replay?.blocker || 'Ej tillgängligt'), detail: 'Offline research, skriver inte broker mirror' },
                { key: 'Batch', value: data.dataPipeline?.batch?.ready ? 'Redo' : (data.dataPipeline?.batch?.blocker || 'Ej tillgängligt'), detail: 'Offline research, skriver inte broker mirror' },
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
            <MetricCard label="Legacy open" value={fmtNumber(legacy.positions?.totalOpen ?? legacy.openPositions?.length ?? 0)} hint="Ej aktiv positionskälla" tone="warning" />
            <MetricCard label="Legacy closed" value={fmtNumber(legacy.positions?.totalClosed ?? legacy.closedTrades?.length ?? 0)} hint="Ej aktiv tradekälla" tone="warning" />
            <MetricCard label="Legacy account" value={legacy.account ? 'Arkiverat' : 'Ej tillgängligt'} hint="Ej aktivt saldo" tone="warning" />
          </div>
          <CompactTable
            rows={Array.isArray(legacy.recentClosedTrades) ? legacy.recentClosedTrades : []}
            emptyText="Inga legacy-trades i arkivvyn."
            columns={[
              { key: 'closedAt', label: 'Stängd', render: (row) => fmtTime(row.closedAt) },
              { key: 'symbol', label: 'Symbol', render: (row) => row.symbol || row.root || 'Ej tillgängligt' },
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
