import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import FuturesPaperChart from '../components/FuturesPaperChart.jsx';

const REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 7_000;

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

function useFuturesDeskRuntime(refreshToken = 0) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;

    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout('/api/futures-paper/runtime', { signal: activeController.signal })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: err?.message || 'futures_paper_runtime_unavailable',
            data: prev.data || null,
          }));
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (activeController) activeController.abort();
    };
  }, [refreshToken]);

  return state;
}

function useFuturesDeskAccount(refreshToken = 0) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;

    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout('/api/futures-paper/account', { signal: activeController.signal })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: err?.message || 'futures_paper_account_unavailable',
            data: prev.data || null,
          }));
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (activeController) activeController.abort();
    };
  }, [refreshToken]);

  return state;
}

function fmtNumber(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '–';
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(num);
}

function fmtMoney(value, currency = 'SEK', digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '–';
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(num);
}

function fmtPct(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '–';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(digits)}%`;
}

function sectionStyle() {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: 16,
    boxShadow: 'var(--shadow-1, none)',
  };
}

function pillStyle(tone = 'neutral') {
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
  const style = pillStyle(tone);
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
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
  const style = pillStyle(tone);
  return (
    <div style={{
      border: `1px solid ${style.border}`,
      background: style.bg,
      borderRadius: 14,
      padding: '12px 14px',
      minHeight: 84,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      gap: 8,
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>{label}</div>
      <div style={{ color: style.fg, fontSize: 24, fontWeight: 900, lineHeight: 1 }}>{value}</div>
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

function CompactTable({ rows, columns, emptyText = 'Inga data ännu.' }) {
  if (!rows.length) {
    return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{emptyText}</div>;
  }
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
            <tr key={row.id || rowIndex}>
              {columns.map((col) => (
                <td key={col.key} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 13, verticalAlign: 'top' }}>
                  {typeof col.render === 'function' ? col.render(row) : row[col.key] ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SafetyStrip({ safety }) {
  return (
    <div style={{ ...sectionStyle(), display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Pill tone="success">Bara paper</Pill>
      <Pill tone="neutral">live off</Pill>
      <Pill tone="neutral">broker off</Pill>
      <Pill tone="warning">real orders blocked</Pill>
      <Pill tone="info">mode={String(safety?.mode || 'paper_only')}</Pill>
      <Pill tone="info">actions_allowed={String(safety?.actions_allowed === true)}</Pill>
      <Pill tone="info">can_place_orders={String(safety?.can_place_orders === true)}</Pill>
      <Pill tone="info">live_trading_enabled={String(safety?.live_trading_enabled === true)}</Pill>
      <Pill tone="info">broker_enabled={String(safety?.broker_enabled === true)}</Pill>
    </div>
  );
}

function ReadinessCard({ title, status, tone = 'neutral', children }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 14,
      padding: 14,
      display: 'grid',
      gap: 10,
      alignContent: 'start',
      minHeight: 160,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        {status ? <Pill tone={tone}>{status}</Pill> : null}
      </div>
      <div style={{ display: 'grid', gap: 8, color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>
        {children}
      </div>
    </div>
  );
}

function ReadinessRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
      <span>{label}</span>
      <strong style={{ color: 'var(--text)', textAlign: 'right', fontSize: 12 }}>{value}</strong>
    </div>
  );
}

function MiniList({ items, emptyText }) {
  if (!items.length) return <div>{emptyText}</div>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {items.map((item, index) => (
        <div key={item.key || index} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
          <span style={{ color: 'var(--text)', fontWeight: 700 }}>{item.label}</span>
          <span style={{ fontSize: 12 }}>{item.meta}</span>
        </div>
      ))}
    </div>
  );
}

export default function FuturesPaperDeskPage() {
  const [refreshToken, setRefreshToken] = useState(0);
  const runtime = useFuturesDeskRuntime(refreshToken);
  const accountState = useFuturesDeskAccount(refreshToken);
  const data = runtime.data;
  const account = accountState.data?.account || data?.account || {};
  const accountConfig = accountState.data?.config || data?.accountConfig || {};
  const instruments = Array.isArray(data?.instruments) ? data.instruments : [];
  const strategies = Array.isArray(data?.strategyPulse) ? data.strategyPulse : [];
  const positions = data?.positions || { open: [], closed: [] };
  const openPositions = Array.isArray(data?.openPositions) ? data.openPositions : Array.isArray(positions.open) ? positions.open : [];
  const closedTrades = Array.isArray(data?.closedTrades) ? data.closedTrades : Array.isArray(positions.closed) ? positions.closed : [];
  const latestEvents = Array.isArray(data?.latestEvents) ? data.latestEvents : [];
  const market = data?.market || {};
  const scanner = data?.scanner || {};
  const autoSimulation = data?.autoSimulation || {};
  const candidateQueue = data?.candidateQueue || {};
  const dataFeed = data?.dataFeed || {};
  const statusReasons = Array.isArray(data?.statusReasons) ? data.statusReasons : [];
  const queueCandidates = Array.isArray(candidateQueue.candidates) ? candidateQueue.candidates : [];
  const autoSimOn = autoSimulation.enabled === true;
  const scanHistory = Array.isArray(data?.scanHistory) ? data.scanHistory : [];
  const strategyStatus = Array.isArray(data?.strategyStatus) ? data.strategyStatus : [];
  const recentClosedTrades = Array.isArray(data?.recentClosedTrades) ? data.recentClosedTrades : [];
  const lastScan = scanner.lastScanSummary || null;
  const lastScanBlocked = [
    ...(lastScan?.blockedByCooldown || []).map((row) => ({ ...row, label: 'cooldown' })),
    ...(lastScan?.blockedByMaxTrades || []).map((row) => ({ ...row, label: 'max trades' })),
  ];
  const accountCurrency = account.currency || account.baseCurrency || 'SEK';
  const totalPnl = Number(account.totalPnlSek || 0);
  const balance = Number(account.equitySek || account.cashSek || 0);
  const base = Number(account.startingBalanceSek || 0);
  const pnlTone = totalPnl > 0 ? 'success' : totalPnl < 0 ? 'danger' : 'neutral';
  const positionsCount = Number(positions.totalOpen || openPositions.length || 0) + Number(positions.totalClosed || closedTrades.length || 0);
  const readyText = market.isOpen ? 'Marknaden är öppen' : 'Marknaden är stängd';
  const chartTradeCount = openPositions.length + closedTrades.length;
  const readinessInstruments = ['MNQ', 'MES'].map((symbol) => {
    const row = instruments.find((item) => String(item.symbol || item.root || '').toUpperCase() === symbol) || {};
    return {
      key: symbol,
      label: symbol,
      meta: `${row.name || (symbol === 'MNQ' ? 'Nasdaq 100 Micro E-mini Futures' : 'S&P 500 Micro E-mini Futures')} · tick ${row.tickSize ?? '0.25'} · ${fmtMoney(row.tickValueUsd ?? (symbol === 'MNQ' ? 0.5 : 1.25), 'USD', 2)} · planned`,
    };
  });
  const strategyPreviewItems = strategies.slice(0, 3).map((row) => ({
    key: row.strategyId || row.strategyName,
    label: row.strategyName || row.strategyId || 'Okänd strategi',
    meta: `${row.strategyId || 'strategy'} · kandidatkälla`,
  }));
  const [balanceDraft, setBalanceDraft] = useState(String(account.startingBalanceSek ?? accountConfig.startingBalanceSek ?? 250000));
  const [accountActionError, setAccountActionError] = useState('');
  const [accountActionMessage, setAccountActionMessage] = useState('');
  const [openDraft, setOpenDraft] = useState({
    root: 'MNQ',
    side: 'long',
    contracts: '1',
    entryPrice: '',
    stopLoss: '',
    takeProfit: '',
    strategyId: strategies[0]?.strategyId || 'trend_continuation',
    strategyName: strategies[0]?.strategyName || 'Trend Continuation',
    entryReason: 'Intern paper-simulering',
  });
  const [closeDrafts, setCloseDrafts] = useState({});

  useEffect(() => {
    const next = account.startingBalanceSek ?? accountConfig.startingBalanceSek ?? 250000;
    setBalanceDraft(String(next));
  }, [account.startingBalanceSek, accountConfig.startingBalanceSek]);

  useEffect(() => {
    setOpenDraft((current) => {
      const strategy = strategies[0] || {};
      const nextRoot = current.root || 'MNQ';
      return {
        ...current,
        root: nextRoot,
        strategyId: current.strategyId || strategy.strategyId || 'trend_continuation',
        strategyName: current.strategyName || strategy.strategyName || 'Trend Continuation',
      };
    });
  }, [strategies]);

  useEffect(() => {
    setCloseDrafts((current) => {
      const next = { ...current };
      openPositions.forEach((position) => {
        if (next[position.tradeId] == null) {
          next[position.tradeId] = String(position.currentPrice ?? position.entryPrice ?? '');
        }
      });
      return next;
    });
  }, [openPositions]);

  async function mutateAccount(endpoint, body) {
    setAccountActionError('');
    setAccountActionMessage('');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    setRefreshToken((value) => value + 1);
    return json;
  }

  async function mutateLedger(endpoint, body) {
    setAccountActionError('');
    setAccountActionMessage('');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    setRefreshToken((value) => value + 1);
    return json;
  }

  async function handleResetAccount() {
    try {
      await mutateAccount('/api/futures-paper/account/reset', { reason: 'manual_reset_from_ui' });
      setAccountActionMessage('Simulerat konto återställt.');
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte återställa simulerat konto.');
    }
  }

  async function handleSetBalance() {
    try {
      await mutateAccount('/api/futures-paper/account/set-balance', {
        startingBalanceSek: Number(balanceDraft),
        reason: 'manual_set_balance_from_ui',
      });
      setAccountActionMessage('Falskt kapital uppdaterat.');
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte sätta falskt kapital.');
    }
  }

  async function handleOpenPosition() {
    try {
      const strategy = strategies[0] || {};
      const result = await mutateLedger('/api/futures-paper/manual/open', {
        root: openDraft.root,
        symbol: openDraft.root,
        side: openDraft.side,
        contracts: Number(openDraft.contracts),
        entryPrice: Number(openDraft.entryPrice),
        stopLoss: openDraft.stopLoss === '' ? undefined : Number(openDraft.stopLoss),
        takeProfit: openDraft.takeProfit === '' ? undefined : Number(openDraft.takeProfit),
        strategyId: openDraft.strategyId || strategy.strategyId || 'trend_continuation',
        strategyName: openDraft.strategyName || strategy.strategyName || 'Trend Continuation',
        entryReason: openDraft.entryReason || 'Intern paper-simulering',
      });
      setAccountActionMessage(
        result.marketHoursWarning
          ? `Simulerad position öppnad. ${result.marketHoursWarning}`
          : 'Simulerad position öppnad.'
      );
      setOpenDraft((current) => ({
        ...current,
        contracts: '1',
        entryPrice: '',
        stopLoss: '',
        takeProfit: '',
      }));
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte öppna simulerad position.');
    }
  }

  async function handleClosePosition(tradeId) {
    try {
      const closePrice = Number(closeDrafts[tradeId]);
      const result = await mutateLedger('/api/futures-paper/manual/close', {
        tradeId,
        exitPrice: closePrice,
        exitReason: 'manual_close_from_ui',
      });
      setAccountActionMessage(
        result.marketHoursWarning
          ? `Simulerad position stängd. ${result.marketHoursWarning}`
          : 'Simulerad position stängd.'
      );
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte stänga simulerad position.');
    }
  }

  async function handleRunScannerOnce() {
    try {
      const result = await mutateLedger('/api/futures-paper/scanner/run-once', {});
      setAccountActionMessage(`Scanner körd: ${result.scan?.candidatesAdded ?? 0} nya kandidater (simulerad fallback-data).`);
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte köra futures-scannern.');
    }
  }

  async function handleSimulateCandidate() {
    try {
      const result = await mutateLedger('/api/futures-paper/candidates/simulate', {});
      setAccountActionMessage(`Simulerad position öppnad från kandidat: ${result.position?.symbol} ${result.position?.side}.`);
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte simulera kandidat.');
    }
  }

  async function handleToggleAutoSimulation() {
    try {
      const result = await mutateLedger('/api/futures-paper/auto-simulation', { enabled: !autoSimOn });
      setAccountActionMessage(result.autoSimulation?.enabled
        ? 'Auto simulation PÅ (endast intern paper-simulation).'
        : 'Auto simulation AV.');
    } catch (err) {
      setAccountActionError(err?.message || 'Kunde inte ändra auto simulation.');
    }
  }

  const nextStep = useMemo(() => {
    if (!data) return 'Läser runtime...';
    if (openPositions.length > 0) return 'Följ öppna positioner och chart-markers.';
    if (market.isOpen) return 'Nästa steg är att koppla in simulatorn för MNQ/MES.';
    return 'Nästa öppning följer Globex-sessionen.';
  }, [data, market.isOpen, openPositions.length]);

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto', padding: '20px 18px 28px' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <Pill tone="info">Paper Futures</Pill>
          <Pill tone="neutral">MNQ först</Pill>
          <Pill tone="neutral">MES först</Pill>
          <Pill tone="success">paper_only</Pill>
          <Pill tone="warning">ingen broker</Pill>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.1 }}>Futures Paper Desk</h1>
            <p style={{ margin: '8px 0 0', color: 'var(--muted)', maxWidth: 860, fontSize: 14, lineHeight: 1.5 }}>
              Separat paper-only desk för MNQ och MES med simulerat kapital, framtida manuella trades och chart-markers.
              Inga riktiga order, ingen broker och ingen live-execution.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/paper-trading" className="btn">Till Paper Trading</Link>
            <Link to="/live" className="btn">Till Live</Link>
            <Link to="/lab" className="btn">Till Lab</Link>
          </div>
        </div>
      </div>

      {runtime.error ? (
        <div style={{ ...sectionStyle(), marginBottom: 16, borderColor: 'rgba(239,68,68,0.35)' }}>
          <strong style={{ color: 'var(--danger)' }}>Runtime kunde inte läsas</strong>
          <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13 }}>{runtime.error}</div>
        </div>
      ) : null}

      <SafetyStrip safety={data} />

      <section style={{ ...sectionStyle(), marginTop: 14 }}>
        <SectionHeader
          eyebrow="Read-only"
          title="Scanner och strategi-kontroll"
          summary="Statuspanelen visar vad futures-desken kan göra just nu. Den aktiverar ingen automation, broker eller riktig orderväg."
          action={<Pill tone={autoSimOn ? 'success' : 'warning'}>{autoSimOn ? 'Auto simulation PÅ' : 'Auto simulation är avstängd'}</Pill>}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <ReadinessCard title="Scannerstatus" status={scanner.connected ? 'Inkopplad' : 'Futures scanner saknas'} tone={scanner.connected ? 'success' : 'warning'}>
            <ReadinessRow label="Futures scanner" value={scanner.connected ? 'Paper-only scanner aktiv' : 'Futures scanner saknas'} />
            <ReadinessRow label="Senaste scan" value={scanner.lastScanAt ? new Date(scanner.lastScanAt).toLocaleString('sv-SE') : 'Ingen futures-scan ännu'} />
            <ReadinessRow label="Datakälla" value={dataFeed.simulated ? 'Simulated data (fallback)' : dataFeed.source || 'Ingen separat MNQ/MES-feed ännu'} />
            <div>Paper-only scanner för MNQ/MES. Priserna är simulerad fallback-data, inte riktig marknadsdata. Ingen broker eller riktig orderväg.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={handleRunScannerOnce}>Kör scanner en gång</button>
            </div>
          </ReadinessCard>

          <ReadinessCard title="Auto paper-simulation" status={autoSimOn ? 'PÅ' : 'AV'} tone={autoSimOn ? 'success' : 'warning'}>
            <ReadinessRow label="Mode" value="paper_only" />
            <ReadinessRow label="Broker" value="off" />
            <ReadinessRow label="Real orders" value="blocked" />
            <ReadinessRow label="Intervall" value={autoSimulation.intervalMs ? `${Math.round(autoSimulation.intervalMs / 1000)} s` : '–'} />
            <div>{autoSimOn
              ? 'Auto simulation kör scanner → kandidat → paper simulation internt. Inga riktiga order kan skickas.'
              : 'Auto simulation är avstängd. Slå på för intern paper-simulation, eller kör scannern manuellt.'}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={handleToggleAutoSimulation}>
                {autoSimOn ? 'Stäng av auto simulation' : 'Slå på auto simulation (paper)'}
              </button>
            </div>
          </ReadinessCard>

          <ReadinessCard title="Futures-symboler" status="MNQ / MES" tone="info">
            <MiniList items={readinessInstruments} emptyText="MNQ och MES är planerade som första futures-symboler." />
          </ReadinessCard>

          <ReadinessCard title="Strategier" status="Kandidatkälla" tone="info">
            <MiniList items={strategyPreviewItems} emptyText="Strategier visas när historisk strategy performance finns i runtime." />
            <div>Strategier är kandidater, inte aktiva futures-auto-trades. Ingen futures allowlist är inkopplad ännu. Källa: historisk strategy performance.</div>
          </ReadinessCard>

          <ReadinessCard title="Senaste kandidater/signaler" status={candidateQueue.connected ? `${queueCandidates.length} i kö` : 'Candidate queue saknas'} tone={queueCandidates.length > 0 ? 'info' : 'neutral'}>
            <ReadinessRow label="Kö" value={candidateQueue.connected ? 'Inkopplad (paper-only)' : 'Candidate queue saknas'} />
            <MiniList
              items={queueCandidates.slice(0, 3).map((row) => ({
                key: row.candidateId,
                label: `${row.symbol} ${row.direction}`,
                meta: `${row.strategyName || row.strategyId}${row.testOnly ? ' · test/simulation' : ''}`,
              }))}
              emptyText="Inga futures-kandidater i kön. Kör scannern för att skapa nya."
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={handleSimulateCandidate} disabled={queueCandidates.length === 0}>Simulera nästa kandidat</button>
            </div>
          </ReadinessCard>

          <ReadinessCard title="Senaste blockerade signaler" status={lastScanBlocked.length > 0 ? `${lastScanBlocked.length} blockerade` : 'Info'} tone={lastScanBlocked.length > 0 ? 'warning' : 'neutral'}>
            <ReadinessRow label="Cooldown-blockerade" value={String(lastScan?.blockedByCooldown?.length ?? 0)} />
            <ReadinessRow label="Max-limit-blockerade" value={String(lastScan?.blockedByMaxTrades?.length ?? 0)} />
            <ReadinessRow label="Skippade strategier" value={String(lastScan?.skippedStrategies?.length ?? 0)} />
            <MiniList
              items={[
                ...lastScanBlocked.slice(0, 3).map((row, index) => ({
                  key: `blocked_${row.strategyId}_${index}`,
                  label: row.strategyId,
                  meta: row.reason,
                })),
                ...(lastScan?.skippedStrategies || []).slice(0, 2).map((row, index) => ({
                  key: `skipped_${row.strategyId}_${index}`,
                  label: row.strategyId,
                  meta: row.reason,
                })),
              ]}
              emptyText="Inga blockerade eller skippade strategier i senaste scan."
            />
          </ReadinessCard>

          <ReadinessCard title="Varför ingen trade togs" status="Förklaring" tone={statusReasons.length > 1 ? 'warning' : 'success'}>
            {statusReasons.length > 0
              ? statusReasons.map((reason) => <div key={reason.code}>{reason.message}</div>)
              : <div>Inga blockerande orsaker just nu.</div>}
            <div>Broker/order är alltid blockerade i den här desken.</div>
          </ReadinessCard>

          <ReadinessCard title="Chart-status" status={chartTradeCount > 0 ? 'Preview-serie' : 'Ingen chartdata ännu'} tone={chartTradeCount > 0 ? 'info' : 'warning'}>
            <ReadinessRow label="Chart mode" value="trade-preview" />
            <ReadinessRow label="OHLC-feed" value={dataFeed.simulated ? 'Simulated data (fallback)' : 'Inte inkopplad'} />
            <ReadinessRow label="Markers" value="När MNQ/MES har simulerade trades" />
            <ReadinessRow label="Nuvarande orsak" value={chartTradeCount > 0 ? 'Simulerade trades finns' : 'Inga öppna/stängda trades'} />
          </ReadinessCard>
        </div>
      </section>

      <section style={{ ...sectionStyle(), marginTop: 14 }}>
        <SectionHeader
          eyebrow="Scan history"
          title="Senaste 10 scans"
          summary="Varje scan kontrollerar alla godkända strategier mot MNQ/MES med max trades- och cooldown-regler. Endast intern paper-simulation."
        />
        <CompactTable
          rows={scanHistory.map((row) => ({ ...row, id: row.scanId }))}
          emptyText="Inga scans ännu. Kör scannern eller slå på auto simulation."
          columns={[
            { key: 'startedAt', label: 'Tidpunkt', render: (row) => row.startedAt ? new Date(row.startedAt).toLocaleString('sv-SE') : '–' },
            { key: 'strategiesChecked', label: 'Strategier', render: (row) => fmtNumber(row.strategiesChecked || 0) },
            { key: 'candidatesCreated', label: 'Kandidater', render: (row) => fmtNumber(row.candidatesCreated || 0) },
            { key: 'tradesOpened', label: 'Trades öppnade', render: (row) => fmtNumber(row.tradesOpened || 0) },
            { key: 'blockedByCooldown', label: 'Cooldown-block', render: (row) => fmtNumber(row.blockedByCooldown?.length || 0) },
            { key: 'blockedByMaxTrades', label: 'Max-block', render: (row) => fmtNumber(row.blockedByMaxTrades?.length || 0) },
            { key: 'skippedStrategies', label: 'Skippade', render: (row) => fmtNumber(row.skippedStrategies?.length || 0) },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'completed' ? 'success' : 'warning'}>{row.status || '–'}</Pill> },
          ]}
        />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 14 }}>
        <MetricCard label="Saldo" value={fmtMoney(balance, accountCurrency)} hint={`Startkapital ${fmtMoney(base, accountCurrency)}`} tone={pnlTone} />
        <MetricCard label="PnL" value={fmtMoney(totalPnl, accountCurrency)} hint={`Dagens saldo just nu`} tone={pnlTone} />
        <MetricCard label="Öppna" value={fmtNumber(positions.totalOpen || 0)} hint="Simulerade öppna positioner" />
        <MetricCard label="Stängda" value={fmtNumber(positions.totalClosed || 0)} hint="Simulerade stängda positioner" />
        <MetricCard label="Fokus" value="MNQ / MES" hint={readyText} tone={market.isOpen ? 'success' : 'warning'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 14, marginTop: 14 }}>
        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Konto"
            title="Simulerat kapital"
            summary="Ett separat futures-konto som senare kan växlas mellan olika startnivåer."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <MetricCard label="Startkapital" value={fmtMoney(account.startingBalanceSek || 0, accountCurrency)} hint="Endast paper money" />
            <MetricCard label="Equity" value={fmtMoney(account.equitySek || 0, accountCurrency)} hint="Falskt kontovärde" />
            <MetricCard label="Cash" value={fmtMoney(account.cashSek || 0, accountCurrency)} hint="Tillgängligt saldo" />
            <MetricCard label="Realiserad PnL" value={fmtMoney(account.realizedPnlSek || 0, accountCurrency)} hint="Stängda simuleringar" />
            <MetricCard label="Orealiserad PnL" value={fmtMoney(account.unrealizedPnlSek || 0, accountCurrency)} hint="Öppna simuleringar" />
            <MetricCard label="Total PnL" value={fmtMoney(account.totalPnlSek || 0, accountCurrency)} hint="Realiserad + orealiserad" tone={pnlTone} />
            <MetricCard label="Drawdown" value={fmtMoney(account.drawdownSek || 0, accountCurrency)} hint={fmtPct(account.drawdownPct || 0)} tone={pnlTone === 'danger' ? 'danger' : 'neutral'} />
            <MetricCard label="Buying Power" value={fmtMoney(account.buyingPowerSek || 0, accountCurrency)} hint="Simulerad köpkraft" />
            <MetricCard label="Used Margin" value={fmtMoney(account.usedMarginSek || 0, accountCurrency)} hint="Använd marginal" />
            <MetricCard label="Available Margin" value={fmtMoney(account.availableMarginSek || 0, accountCurrency)} hint="Kvar i simuleringen" />
            <MetricCard label="FX USD/SEK" value={fmtNumber(account.fxUsdSek || 0, 2)} hint={`Uppdaterad ${account.updatedAt ? 'nu' : '–'}`} />
          </div>
          <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <strong>Kontostatus</strong>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{nextStep}</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: 'rgba(148,163,184,0.18)', overflow: 'hidden' }}>
              <div style={{ width: '100%', height: '100%', background: 'linear-gradient(90deg, rgba(59,130,246,0.70), rgba(34,197,94,0.65))' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
              <span>Paper only · inga riktiga pengar</span>
              <span>{market.description || 'Globex-session används som ram.'}</span>
            </div>
          </div>
          <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <strong>Kontoåtgärder</strong>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Endast simulerat konto</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto auto', gap: 10, alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Falskt kapital (SEK)</span>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={balanceDraft}
                  onChange={(event) => setBalanceDraft(event.target.value)}
                  style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
                />
              </label>
              <button type="button" className="btn" onClick={handleResetAccount}>Återställ simulerat konto</button>
              <button type="button" className="btn" onClick={handleSetBalance}>Sätt falskt kapital</button>
            </div>
            {(accountActionMessage || accountActionError) && (
              <div style={{ marginTop: 10, color: accountActionError ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>
                {accountActionError || accountActionMessage}
              </div>
            )}
          </div>
        </section>

        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Session"
            title="Marknadsläge"
            summary="Ett enkelt läs-läge för futures-sessionen och fokusinstrumenten."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <MetricCard label="Session" value={market.session || 'Globex'} hint={market.timezone || 'UTC'} />
            <MetricCard label="Öppet" value={market.isOpen ? 'Ja' : 'Nej'} hint={market.maintenanceWindow || '22:00-23:00 UTC'} tone={market.isOpen ? 'success' : 'warning'} />
            <MetricCard label="Nästa steg" value={market.isOpen ? 'Aktiv' : 'Vänta'} hint={market.nextChangeHint || '–'} tone={market.isOpen ? 'success' : 'neutral'} />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, marginBottom: 10 }}>Fokusinstrument</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {instruments.map((instrument) => (
                <div key={instrument.symbol} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                    <strong>{instrument.symbol}</strong>
                    <Pill tone={instrument.universeStatus === 'active' ? 'success' : 'warning'}>{instrument.universeStatus}</Pill>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{instrument.name}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    <Pill tone="neutral">Tick {instrument.tickSize}</Pill>
                    <Pill tone="neutral">Tick värde {fmtMoney(instrument.tickValueUsd, 'USD', 2)}</Pill>
                    <Pill tone="neutral">Kontrakt {instrument.contractSize}</Pill>
                    <Pill tone="neutral">{instrument.exchange}</Pill>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14, marginTop: 14 }}>
        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Strategier"
            title="Strategy status (godkända för paper-test)"
            summary="Alla godkända strategier från paper-allowlisten med max trades- och cooldown-status. Endast intern paper-simulation, ingen broker."
          />
          <CompactTable
            rows={strategyStatus.map((row) => ({ ...row, id: row.strategyId }))}
            emptyText="Inga godkända strategier hittades i paper-allowlisten."
            columns={[
              { key: 'strategyName', label: 'Strategi', render: (row) => (
                <div>
                  <div style={{ fontWeight: 700 }}>{row.strategyName}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{row.strategyId}{row.approved ? '' : ' · ej godkänd'}</div>
                </div>
              ) },
              { key: 'tradesUsed', label: 'Trades', render: (row) => `${fmtNumber(row.tradesUsed || 0)} / ${fmtNumber(row.maxTrades || 10)}` },
              { key: 'cooldown', label: 'Cooldown', render: (row) => row.cooldownActive ? `${fmtNumber(row.cooldownMinutesRemaining || 0)} min kvar` : '–' },
              { key: 'lastTradeAt', label: 'Senaste trade', render: (row) => row.lastTradeAt ? new Date(row.lastTradeAt).toLocaleString('sv-SE') : '–' },
              { key: 'nextAllowedAt', label: 'Nästa tillåten', render: (row) => row.canTradeNow ? 'Nu' : (row.nextAllowedAt ? new Date(row.nextAllowedAt).toLocaleString('sv-SE') : '–') },
              { key: 'canTradeNow', label: 'Kan trada', render: (row) => (
                <Pill tone={row.canTradeNow ? 'success' : 'warning'}>{row.canTradeNow ? 'Ja' : (row.blockReason || 'Nej')}</Pill>
              ) },
              { key: 'totalPnlSek', label: 'PnL', render: (row) => fmtMoney(row.totalPnlSek || 0, 'SEK') },
              { key: 'winRate', label: 'Win rate', render: (row) => row.winRate == null ? '–' : fmtPct(row.winRate) },
            ]}
          />
        </section>

        <FuturesPaperChart
          instruments={instruments}
          openPositions={openPositions}
          closedTrades={closedTrades}
          accountCurrency={accountCurrency}
          onClosePosition={handleClosePosition}
        />

        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Trades"
            title="Senaste 100 closed trades"
            summary="Stängda simulerade futures paper trades, nyast först. Endast paper money."
          />
          <CompactTable
            rows={recentClosedTrades.map((row) => ({ ...row, id: row.tradeId }))}
            emptyText="Inga stängda simulerade trades ännu."
            columns={[
              { key: 'closedAt', label: 'Stängd', render: (row) => row.closedAt ? new Date(row.closedAt).toLocaleString('sv-SE') : '–' },
              { key: 'symbol', label: 'Symbol' },
              { key: 'direction', label: 'Riktning' },
              { key: 'strategyName', label: 'Strategi', render: (row) => row.strategyName || row.strategyId || '–' },
              { key: 'entryPrice', label: 'Entry', render: (row) => fmtNumber(row.entryPrice, 2) },
              { key: 'exitPrice', label: 'Exit', render: (row) => fmtNumber(row.exitPrice, 2) },
              { key: 'realizedPnlSek', label: 'PnL', render: (row) => (
                <strong style={{ color: (row.realizedPnlSek || 0) > 0 ? 'var(--success)' : (row.realizedPnlSek || 0) < 0 ? 'var(--danger)' : 'var(--text)' }}>
                  {fmtMoney(row.realizedPnlSek || 0, 'SEK')}
                </strong>
              ) },
              { key: 'durationMinutes', label: 'Duration', render: (row) => row.durationMinutes == null ? '–' : `${fmtNumber(row.durationMinutes, 1)} min` },
              { key: 'closeReason', label: 'Orsak', render: (row) => row.closeReason || '–' },
            ]}
          />
        </section>

        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Manuell simulation"
            title="Öppna simulerad position"
            summary="Paper-only intern simulation för MNQ/MES. Inga riktiga order eller broker-anrop."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Root</span>
              <select
                value={openDraft.root}
                onChange={(event) => setOpenDraft((current) => ({ ...current, root: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              >
                <option value="MNQ">MNQ</option>
                <option value="MES">MES</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Riktning</span>
              <select
                value={openDraft.side}
                onChange={(event) => setOpenDraft((current) => ({ ...current, side: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              >
                <option value="long">long</option>
                <option value="short">short</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Kontrakt</span>
              <input
                type="number"
                min="1"
                step="1"
                value={openDraft.contracts}
                onChange={(event) => setOpenDraft((current) => ({ ...current, contracts: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Entry price</span>
              <input
                type="number"
                min="0"
                step="0.25"
                value={openDraft.entryPrice}
                onChange={(event) => setOpenDraft((current) => ({ ...current, entryPrice: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Stop loss</span>
              <input
                type="number"
                min="0"
                step="0.25"
                value={openDraft.stopLoss}
                onChange={(event) => setOpenDraft((current) => ({ ...current, stopLoss: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Take profit</span>
              <input
                type="number"
                min="0"
                step="0.25"
                value={openDraft.takeProfit}
                onChange={(event) => setOpenDraft((current) => ({ ...current, takeProfit: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Strategy ID</span>
              <input
                value={openDraft.strategyId}
                onChange={(event) => setOpenDraft((current) => ({ ...current, strategyId: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Strategy name</span>
              <input
                value={openDraft.strategyName}
                onChange={(event) => setOpenDraft((current) => ({ ...current, strategyName: event.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
          </div>
          <label style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Entry reason</span>
            <textarea
              rows={3}
              value={openDraft.entryReason}
              onChange={(event) => setOpenDraft((current) => ({ ...current, entryReason: event.target.value }))}
              style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)', resize: 'vertical' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            <button type="button" className="btn" onClick={handleOpenPosition}>Öppna simulerad position</button>
            <Pill tone="warning">Paper-only · inga riktiga order</Pill>
          </div>
        </section>

        <section style={sectionStyle()}>
          <SectionHeader
            eyebrow="Tekniskt"
            title="Runtime och dataflöde"
            summary="En tunn, läsbar startyta för den nya futures-desken."
          />
          <CompactTable
            rows={[
              { key: 'Runtime', value: 'futuresPaperDeskService', detail: data?.technical?.runtimeSource || '–' },
              { key: 'Universe', value: 'marketUniverseService', detail: data?.technical?.universeSource || '–' },
              { key: 'Strategier', value: 'strategyPerformanceReadService', detail: data?.technical?.strategySource || '–' },
              { key: 'Session', value: market.session || 'Globex', detail: market.description || '–' },
            ]}
            columns={[
              { key: 'key', label: 'Källa' },
              { key: 'value', label: 'Värde' },
              { key: 'detail', label: 'Detalj' },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
