import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

const REFRESH_MS = 15000;
const FETCH_TIMEOUT_MS = 6500;

async function fetchJson(url, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS) : null;
  try {
    return await apiFetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
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
  if (row.entryContractReady) badges.push(['Entry contract klar', 'good']);
  else if (row.enabledForPaper) badges.push(['Entry contract saknas', 'danger']);
  if (row.enabledForPaper && row.paperEligibility !== 'READY') badges.push(['Enabled men inte redo', 'warn']);
  if (row.replayEligibility === 'READY') badges.push(['Replay-klar', 'info']);
  if (row.producerStatus === 'none') badges.push(['Saknar producent', 'warn']);
  if (['unmapped', 'shadowed'].includes(row.mappingStatus)) badges.push(['Saknar mapping', 'warn']);
  if (String(row.technicalReadiness || '').includes('MARKET_CONTEXT')) badges.push(['Saknar marknadsdata', 'warn']);
  if (row.direction === 'short' || (row.warnings || []).includes('short_only_strategy')) badges.push(['Short-only', 'danger']);
  if (String(row.paperBlockedReason || '').startsWith('long_only')) badges.push(['Blockerad av LONG_ONLY', 'danger']);
  const blocker = row.latestEntryContractBlock?.reasonCode || row.commonEntryContractBlocker?.reasonCode || '';
  if (blocker === 'paper_entry_watch_only') badges.push(['Väntar på bekräftelse', 'warn']);
  if (blocker === 'missing_required_confirmation' || blocker.includes('confirmation')) badges.push(['Confirmation saknas', 'warn']);
  if (blocker === 'stale_strategy_signal') badges.push(['Signal för gammal', 'warn']);
  if (blocker === 'late_extended_entry') badges.push(['Entry extended', 'warn']);
  if (row.legacyApprovalStatus) badges.push(['Legacy approval, endast historik', 'neutral']);
  return badges;
}

function reasonLabel(code) {
  const labels = {
    paper_entry_watch_only: 'Blockerad: signalen var endast observation',
    paper_entry_caution_only: 'Blockerad: caution utan entry-bekräftelse',
    paper_entry_status_not_ready: 'Blockerad: status inte entry-ready',
    missing_required_confirmation: 'Blockerad: confirmation saknas',
    missing_two_minute_confirmation: 'Blockerad: 2m-confirmation saknas',
    missing_closed_candle_confirmation: 'Blockerad: candle close saknas',
    stale_strategy_signal: 'Blockerad: signalen var för gammal',
    late_extended_entry: 'Blockerad: entryn var redan extended',
    missing_volume_confirmation: 'Blockerad: volymbekräftelse saknas',
    missing_vwap_reclaim_confirmation: 'Blockerad: VWAP reclaim saknas',
    missing_ema_pullback_confirmation: 'Blockerad: EMA reclaim saknas',
    invalid_strategy_subtype: 'Blockerad: fel subtype',
    invalid_strategy_direction: 'Blockerad: fel riktning',
    missing_market_context: 'Blockerad: marknadskontext saknas',
    invalid_session: 'Blockerad: session stängd',
    entry_contract_missing: 'Blockerad: contract saknas',
  };
  return labels[code] || code || '-';
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

function entryContractText(row) {
  const contract = row.entryContract;
  if (!contract) return 'Missing';
  const maxAge = Number(contract.maxSignalAgeMs);
  const maxAgeText = Number.isFinite(maxAge) ? `${Math.round(maxAge / 1000)}s` : '-';
  return [
    `Subtype: ${(contract.allowedSubtypes || []).join(', ') || '-'}`,
    `Status: ${(contract.allowedStatuses || []).join(', ') || '-'}`,
    `Conf: ${(contract.requiredConfirmations || []).join(', ') || '-'}`,
    `Age: ${maxAgeText}`,
  ].join(' | ');
}

function entryQualityText(row) {
  const outcomes = row.outcomeCounts || {};
  const latestBlock = row.latestEntryContractBlock?.reasonCode || row.commonEntryContractBlocker?.reasonCode || null;
  return [
    `C ${row.entryContractCandidateCount ?? 0}`,
    `P ${row.entryContractPassCount ?? 0}`,
    `B ${row.entryContractBlockCount ?? 0}`,
    `T ${row.paperTradeCount ?? 0}`,
    `W/L/TO ${outcomes.WIN ?? 0}/${outcomes.LOSS ?? 0}/${outcomes.TIMEOUT ?? 0}`,
    `TO ${row.timeoutRate == null ? '-' : `${fmtNumber(row.timeoutRate, 1)}%`}`,
    `MFE ${row.avgMfe == null ? '-' : fmtNumber(row.avgMfe, 4)}`,
    `MAE ${row.avgMae == null ? '-' : fmtNumber(row.avgMae, 4)}`,
    latestBlock ? reasonLabel(latestBlock) : null,
  ].filter(Boolean).join(' | ');
}

function listText(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function DetailItem({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0 }}>{label}</div>
      <div style={{ color: 'var(--text)', fontSize: 12, marginTop: 3, overflowWrap: 'anywhere', lineHeight: 1.45 }}>{listText(value)}</div>
    </div>
  );
}

function StrategyDetails({ row }) {
  const contract = row.entryContract || {};
  const outcomes = row.outcomeCounts || {};
  const latestBlock = row.latestEntryContractBlock?.reasonCode || row.commonEntryContractBlocker?.reasonCode || null;
  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      padding: '12px 14px 14px',
      display: 'grid',
      gap: 12,
      background: 'var(--surface-2)',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <DetailItem label="Family" value={row.family} />
        <DetailItem label="Strategy ID" value={row.strategyId} />
        <DetailItem label="Producer" value={row.producerStatus} />
        <DetailItem label="Mapping" value={row.mappingStatus} />
        <DetailItem label="Runtime connector" value={row.runtimeConnectorStatus} />
        <DetailItem label="Senaste blocker" value={reasonLabel(latestBlock) || paperBlockedText(row)} />
        <DetailItem label="Allowed subtypes" value={contract.allowedSubtypes} />
        <DetailItem label="Allowed statuses" value={contract.allowedStatuses} />
        <DetailItem label="Required confirmations" value={contract.requiredConfirmations} />
        <DetailItem label="Max signal age" value={contract.maxSignalAgeMs ? `${Math.round(Number(contract.maxSignalAgeMs) / 1000)}s` : '-'} />
        <DetailItem label="Senaste signal" value={latestCandidateText(row)} />
        <DetailItem label="Senaste trade" value={latestTradeText(row)} />
        <DetailItem label="Candidates/pass/block" value={`${row.entryContractCandidateCount ?? 0}/${row.entryContractPassCount ?? 0}/${row.entryContractBlockCount ?? 0}`} />
        <DetailItem label="W/L/TIMEOUT" value={`${outcomes.WIN ?? 0}/${outcomes.LOSS ?? 0}/${outcomes.TIMEOUT ?? 0}`} />
        <DetailItem label="MFE/MAE" value={`${row.avgMfe == null ? '-' : fmtNumber(row.avgMfe, 4)} / ${row.avgMae == null ? '-' : fmtNumber(row.avgMae, 4)}`} />
        <DetailItem label="Timeout-rate" value={row.timeoutRate == null ? '-' : `${fmtNumber(row.timeoutRate, 1)}%`} />
        <DetailItem label="Legacy approval" value={row.legacyApprovalStatus ? `${row.legacyApprovalStatus}${row.legacySelectedInFamily ? ' · selected' : ''}` : '-'} />
        <DetailItem label="Warnings" value={row.warnings} />
        <DetailItem label="Missing components" value={row.missingComponents} />
        <DetailItem label="Entry quality" value={entryQualityText(row)} />
      </div>
    </div>
  );
}

function rowMatchesFilter(row, filter) {
  if (filter === 'active') return row.enabledForPaper === true;
  if (filter === 'disabled') return row.enabledForPaper !== true;
  if (filter === 'ready') return row.technicalReadiness === 'READY';
  if (filter === 'producer') return row.producerStatus === 'none';
  if (filter === 'short') return row.direction === 'short' || (row.warnings || []).includes('short_only_strategy');
  if (filter === 'blocked') return row.paperEligibility !== 'READY' || Boolean(row.paperBlockedReason || row.runtimeBlockedReason);
  return true;
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
  const [expandedId, setExpandedId] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
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

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (!rowMatchesFilter(row, filter)) return false;
      if (!q) return true;
      return String(row.strategyId || '').toLowerCase().includes(q)
        || String(row.displayName || '').toLowerCase().includes(q)
        || String(row.family || '').toLowerCase().includes(q);
    });
  }, [rows, filter, query]);

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
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Entry contracts</div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{summary.entryContractsReady ?? 0}/{summary.total ?? strategies.length}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800 }}>Contract blocks</div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{summary.entryContractBlock ?? 0}</div>
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
              {data.manualListControlsRuntime ? 'Manual list styr runtime' : 'Manual list visas, legacy gate styr runtime tills flaggan aktiveras'} · {visibleRows.length}/{rows.length}
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

        <div style={{ padding: '0 14px 14px', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              ['all', 'Alla'],
              ['active', 'Aktiva'],
              ['disabled', 'Avstängda'],
              ['ready', 'Tekniskt klara'],
              ['producer', 'Saknar producent'],
              ['short', 'Short-only'],
              ['blocked', 'Blockerade'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                style={{
                  ...buttonStyle(filter === id ? 'good' : 'neutral', false),
                  color: filter === id ? 'var(--success)' : 'var(--muted)',
                }}
              >
                {label}
              </button>
            ))}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Sök strategyId eller namn"
              aria-label="Sök strategier"
              style={{
                flex: '1 1 220px',
                minWidth: 0,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface-2)',
                color: 'var(--text)',
                padding: '8px 10px',
                fontSize: 12,
              }}
            />
          </div>

          <div className="paper-strategy-main-grid paper-strategy-grid-header" style={{
            display: 'grid',
            gap: 10,
            padding: '8px 10px',
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: 0,
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
          }}>
            <div>Strategi</div>
            <div>Riktning</div>
            <div>Readiness</div>
            <div>Aktiv</div>
            <div>Entry Contract</div>
            <div style={{ textAlign: 'right' }}>Åtgärd</div>
          </div>

          {visibleRows.map((row) => {
            const busy = busyId === row.strategyId;
            const badges = rowBadges(row);
            const expanded = expandedId === row.strategyId;
            return (
              <div key={row.strategyId} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)' }}>
                <div style={{
                  display: 'grid',
                  gap: 10,
                  alignItems: 'start',
                  padding: 12,
                }} className="paper-strategy-main-grid">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 900, overflowWrap: 'anywhere' }}>{row.displayName || row.strategyId}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono, monospace)', marginTop: 3, overflowWrap: 'anywhere' }}>{row.strategyId}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                      {badges.slice(0, 4).map(([label, tone]) => <span key={label} style={badgeStyle(tone)}>{label}</span>)}
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? '' : row.strategyId)}
                      style={{ ...buttonStyle('neutral', false), marginTop: 8, color: 'var(--accent)' }}
                    >
                      {expanded ? 'Dölj detaljer' : 'Visa detaljer'}
                    </button>
                  </div>
                  <div><span style={badgeStyle(row.direction === 'short' ? 'danger' : row.direction === 'long' ? 'good' : 'neutral')}>{row.direction || '-'}</span></div>
                  <div><span style={badgeStyle(toneFor(row.technicalReadiness))}>{row.technicalReadiness || '-'}</span></div>
                  <div><span style={badgeStyle(row.enabledForPaper ? 'good' : 'neutral')}>{row.enabledForPaper ? 'Ja' : 'Nej'}</span></div>
                  <div style={{ minWidth: 0 }}>
                    <span style={badgeStyle(row.entryContractReady ? 'good' : 'warn')}>{row.entryContractStatus || '-'}</span>
                    <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                      {row.entryContractReady ? 'Klar' : 'Saknas'}
                    </div>
                  </div>
                  <div className="paper-strategy-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      disabled={busy || row.enabledForPaper}
                      onClick={() => run('enable', row)}
                      style={buttonStyle('good', busy || row.enabledForPaper)}
                    >
                      {busy ? 'Skickar…' : 'Lägg till i Paper'}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !row.enabledForPaper}
                      onClick={() => run('disable', row)}
                      style={buttonStyle('danger', busy || !row.enabledForPaper)}
                    >
                      {busy ? 'Skickar…' : 'Ta bort från Paper'}
                    </button>
                  </div>
                </div>
                {expanded ? <StrategyDetails row={row} /> : null}
              </div>
            );
          })}

          {!visibleRows.length ? (
            <div style={{ padding: 14, color: 'var(--muted)' }}>
              {state.loading ? 'Hämtar strategier...' : 'Inga strategier matchar filtret.'}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
