import React, { useEffect, useMemo, useState } from 'react';

const REFRESH_MS = 15000;
const FETCH_TIMEOUT_MS = 6500;

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      credentials: 'include',
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      throw new Error((data && (data.error || data.reason)) || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString('sv-SE', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

function toneFor(value) {
  const key = String(value || '').toLowerCase();
  if (['ready', 'ready_for_paper', 'active', 'enabled'].includes(key)) return 'good';
  if (['blocked', 'disabled_by_user', 'needs_runtime_connector', 'needs_market_context', 'needs_mapping', 'needs_producer'].includes(key)) return 'warn';
  if (['unsupported', 'broken', 'removed'].includes(key)) return 'danger';
  return 'neutral';
}

function badgeStyle(tone = 'neutral') {
  const tones = {
    good: { color: 'var(--success)', borderColor: 'rgba(34,197,94,0.28)', background: 'rgba(34,197,94,0.08)' },
    warn: { color: 'var(--warning)', borderColor: 'rgba(245,158,11,0.28)', background: 'rgba(245,158,11,0.08)' },
    danger: { color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.28)', background: 'rgba(239,68,68,0.08)' },
    info: { color: 'var(--accent)', borderColor: 'rgba(56,189,248,0.28)', background: 'rgba(56,189,248,0.08)' },
    neutral: { color: 'var(--muted)', borderColor: 'var(--border)', background: 'var(--surface-2)' },
  };
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 22,
    padding: '2px 8px',
    borderRadius: 8,
    border: `1px solid ${tones[tone].borderColor}`,
    background: tones[tone].background,
    color: tones[tone].color,
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: 'nowrap',
  };
}

function buttonStyle(tone, disabled) {
  return {
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface-2)',
    color: tone === 'danger' ? 'var(--danger)' : 'var(--success)',
    padding: '7px 10px',
    fontSize: 12,
    fontWeight: 900,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.56 : 1,
    whiteSpace: 'nowrap',
  };
}

function thStyle() {
  return {
    textAlign: 'left',
    padding: '9px 10px',
    borderBottom: '1px solid var(--border)',
    fontSize: 11,
    color: 'var(--muted)',
    textTransform: 'uppercase',
    letterSpacing: 0,
    whiteSpace: 'nowrap',
  };
}

function tdStyle() {
  return {
    padding: '10px',
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'top',
    fontSize: 12,
    color: 'var(--text)',
  };
}

function rowBadges(row) {
  const badges = [];
  if (row.enabledForPaper) badges.push(['Aktiv i Paper', 'good']);
  else badges.push(['Avstängd av dig', 'neutral']);
  if (row.technicalReadiness === 'READY') badges.push(['Tekniskt körbar', 'good']);
  if (row.enabledForPaper && row.paperEligibility !== 'READY') badges.push(['Enabled men inte redo', 'warn']);
  if (row.replayEligibility === 'READY') badges.push(['Replay-klar', 'info']);
  if (row.producerStatus === 'none') badges.push(['Saknar producent', 'warn']);
  if (['unmapped', 'shadowed'].includes(row.mappingStatus)) badges.push(['Saknar mapping', 'warn']);
  if (String(row.technicalReadiness || '').includes('MARKET_CONTEXT')) badges.push(['Saknar marknadsdata', 'warn']);
  if (row.direction === 'short' || (row.warnings || []).includes('short_only_strategy')) badges.push(['Short-only', 'danger']);
  if (String(row.paperBlockedReason || '').startsWith('long_only')) badges.push(['Blockerad av LONG_ONLY', 'danger']);
  if (row.legacyApprovalStatus) badges.push(['Legacy approval, endast historik', 'neutral']);
  return badges;
}

function paperBlockedText(row) {
  return row.paperBlockedReason || row.runtimeBlockedReason || (Array.isArray(row.missingComponents) ? row.missingComponents[0] : null) || '-';
}

function latestCandidateText(row) {
  const latest = row.latestCandidate;
  if (!latest) return '-';
  return [latest.symbol, latest.signalSubtype, fmtTime(latest.at)].filter(Boolean).join(' · ');
}

function latestTradeText(row) {
  const trade = row.latestPaperTrade;
  if (!trade) return '-';
  return [trade.symbol, trade.result, fmtTime(trade.entryTime)].filter(Boolean).join(' · ');
}

function useManualPaperStrategies(refreshKey) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let alive = true;
    let controller = null;
    const load = () => {
      if (controller) controller.abort();
      controller = new AbortController();
      setState((prev) => ({ ...prev, loading: true }));
      fetchJson('/api/paper-trading/enabled-strategies?fresh=true', { signal: controller.signal })
        .then((data) => {
          if (alive) setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (alive) setState((prev) => ({ loading: false, error: err.message || 'unavailable', data: prev.data }));
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (controller) controller.abort();
    };
  }, [refreshKey]);

  return state;
}

async function mutateStrategy(strategyId, action) {
  return fetchJson(`/api/paper-trading/enabled-strategies/${encodeURIComponent(strategyId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    }),
  });
}

export default function PaperStrategyListPanel({ refreshKey = 0, onRefresh }) {
  const [localRefresh, setLocalRefresh] = useState(0);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState(null);
  const state = useManualPaperStrategies(`${refreshKey}:${localRefresh}`);
  const data = state.data || {};
  const strategies = Array.isArray(data.strategies) ? data.strategies : [];
  const summary = data.summary || {};

  const rows = useMemo(() => strategies.slice().sort((a, b) => {
    const enabledDiff = Number(b.enabledForPaper === true) - Number(a.enabledForPaper === true);
    if (enabledDiff) return enabledDiff;
    const familyDiff = String(a.family || '').localeCompare(String(b.family || ''));
    if (familyDiff) return familyDiff;
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  }), [strategies]);

  async function run(action, row) {
    if (!row?.strategyId || busyId) return;
    setBusyId(row.strategyId);
    setMessage(null);
    try {
      const result = await mutateStrategy(row.strategyId, action);
      setMessage({
        tone: result.changed ? 'good' : 'neutral',
        text: result.changed ? `${row.strategyId} uppdaterad.` : `${row.strategyId} var redan i det läget.`,
      });
      setLocalRefresh((value) => value + 1);
      onRefresh?.();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Kunde inte uppdatera strategin.' });
    } finally {
      setBusyId('');
    }
  }

  return (
    <section style={{ display: 'grid', gap: 14 }}>
      <div style={{
        border: '1px solid rgba(56,189,248,0.28)',
        borderRadius: 8,
        background: 'var(--surface-2)',
        padding: 14,
        color: 'var(--text)',
        fontSize: 13,
        lineHeight: 1.55,
      }}>
        Du väljer manuellt vilka strategier som får delta i Paper Trading. Aktivering innebär inte att en trade automatiskt öppnas; alla data-, entry-, risk- och säkerhetskontroller gäller fortfarande.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Totalt</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{summary.total ?? strategies.length}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Aktiva</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{summary.enabled ?? 0}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Redo</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{summary.ready ?? summary.paperReady ?? 0}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Runtime gate</div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{data.runtimeGateMode || '-'}</div>
        </div>
      </div>

      {state.error ? (
        <div style={{ border: '1px solid rgba(239,68,68,0.28)', borderRadius: 8, padding: 12, color: 'var(--danger)', background: 'var(--surface-2)' }}>
          {state.error}
        </div>
      ) : null}

      {message ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, color: message.tone === 'danger' ? 'var(--danger)' : 'var(--text)', background: 'var(--surface-2)' }}>
          {message.text}
        </div>
      ) : null}

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ padding: 14, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900 }}>Strategier</div>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
              {data.manualListControlsRuntime ? 'Manual list styr runtime' : 'Manual list visas, legacy gate styr runtime tills flaggan aktiveras'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLocalRefresh((value) => value + 1)}
            disabled={state.loading}
            style={buttonStyle('good', state.loading)}
          >
            Uppdatera
          </button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1280 }}>
            <thead>
              <tr>
                <th style={thStyle()}>Strategi</th>
                <th style={thStyle()}>Familj</th>
                <th style={thStyle()}>Direction</th>
                <th style={thStyle()}>Teknisk readiness</th>
                <th style={thStyle()}>Aktiv i Paper</th>
                <th style={thStyle()}>Replay</th>
                <th style={thStyle()}>Senaste signal</th>
                <th style={thStyle()}>Senaste trade</th>
                <th style={thStyle()}>Trades</th>
                <th style={thStyle()}>Win rate</th>
                <th style={thStyle()}>Avg PnL</th>
                <th style={thStyle()}>Blockerad anledning</th>
                <th style={thStyle()}>Warnings</th>
                <th style={{ ...thStyle(), textAlign: 'right' }}>Åtgärd</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyId === row.strategyId;
                const badges = rowBadges(row);
                return (
                  <tr key={row.strategyId}>
                    <td style={tdStyle()}>
                      <div style={{ fontWeight: 900 }}>{row.displayName || row.strategyId}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono, monospace)', marginTop: 3 }}>{row.strategyId}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                        {badges.map(([label, tone]) => <span key={label} style={badgeStyle(tone)}>{label}</span>)}
                      </div>
                    </td>
                    <td style={tdStyle()}>{row.family || '-'}</td>
                    <td style={tdStyle()}><span style={badgeStyle(row.direction === 'short' ? 'danger' : row.direction === 'long' ? 'good' : 'neutral')}>{row.direction || '-'}</span></td>
                    <td style={tdStyle()}><span style={badgeStyle(toneFor(row.technicalReadiness))}>{row.technicalReadiness || '-'}</span></td>
                    <td style={tdStyle()}><span style={badgeStyle(row.enabledForPaper ? 'good' : 'neutral')}>{row.enabledForPaper ? 'Ja' : 'Nej'}</span></td>
                    <td style={tdStyle()}>{row.replayEligibility || '-'}</td>
                    <td style={tdStyle()}>{latestCandidateText(row)}</td>
                    <td style={tdStyle()}>{latestTradeText(row)}</td>
                    <td style={tdStyle()}>{row.paperTradeCount ?? 0}</td>
                    <td style={tdStyle()}>{row.winRate == null ? '-' : `${fmtNumber(row.winRate, 1)}%`}</td>
                    <td style={tdStyle()}>{row.avgPnl == null ? '-' : fmtNumber(row.avgPnl, 4)}</td>
                    <td style={tdStyle()}>{paperBlockedText(row)}</td>
                    <td style={tdStyle()}>{Array.isArray(row.warnings) && row.warnings.length ? row.warnings.slice(0, 3).join(', ') : '-'}</td>
                    <td style={{ ...tdStyle(), textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          disabled={busy || row.enabledForPaper}
                          onClick={() => run('enable', row)}
                          style={buttonStyle('good', busy || row.enabledForPaper)}
                        >
                          Lägg till i Paper
                        </button>
                        <button
                          type="button"
                          disabled={busy || !row.enabledForPaper}
                          onClick={() => run('disable', row)}
                          style={buttonStyle('danger', busy || !row.enabledForPaper)}
                        >
                          Ta bort från Paper
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td style={tdStyle()} colSpan={14}>{state.loading ? 'Hämtar strategier...' : 'Inga strategier hittades.'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
