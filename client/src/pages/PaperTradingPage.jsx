import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const REFRESH_MS = 15_000;

function usePaperTrading() {
  const [status,          setStatus]          = useState(null);
  const unified = useUnifiedConfig('results');
  const perf = unified.test.paperPerformance;
  const [trades,          setTrades]          = useState(null);
  const [events,          setEvents]          = useState(null);
  const [calibration,     setCalibration]     = useState(null);
  const [gateStatus,      setGateStatus]      = useState(null);
  const [gateDecisions,   setGateDecisions]   = useState(null);
  const [decisionPipeline, setDecisionPipeline] = useState(null);
  const [gateEffectiveness, setGateEffectiveness] = useState(null);
  const [redisStatus,     setRedisStatus]      = useState(null);
  const [agentAnalysis,   setAgentAnalysis]    = useState(null);
  const [busy,            setBusy]            = useState(false);
  const refreshShared = unified.refresh;

  const fetchAll = useCallback(() => {
    fetch('/api/paper-trading/status').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setStatus(d); }).catch(() => {});
    refreshShared('paperPerformance');
    fetch('/api/paper-trading/trades').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setTrades(d); }).catch(() => {});
    fetch('/api/paper-trading/events').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setEvents(d); }).catch(() => {});
    fetch('/api/paper-trading/calibration-report').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setCalibration(d); }).catch(() => {});
    fetch('/api/paper-trading/gate-status').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setGateStatus(d); }).catch(() => {});
    fetch('/api/paper-trading/gate-decisions').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setGateDecisions(d); }).catch(() => {});
    fetch('/api/paper-trading/decision-pipeline').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setDecisionPipeline(d); }).catch(() => {});
    fetch('/api/paper-trading/gate-effectiveness').then(r => r.ok ? r.json() : null).then(d => { if (d?.report) setGateEffectiveness(d.report); }).catch(() => {});
    fetch('/api/system/redis-status').then(r => r.ok ? r.json() : null).then(d => { if (d?.ok) setRedisStatus(d); }).catch(() => {});
    fetch('/api/agent/latest-analysis').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.ok) setAgentAnalysis(d.analysis || (d.symbol ? d : null));
    }).catch(() => {});
  }, [refreshShared]);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchAll]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const url = status?.enabled ? '/api/paper-trading/stop' : '/api/paper-trading/start';
    try {
      await fetch(url, { method: 'POST' });
      fetchAll();
    } finally {
      setBusy(false);
    }
  }, [busy, status, fetchAll]);

  const analyzeLatestSignal = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/agent/analyze-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = res.ok ? await res.json() : null;
      if (data?.analysis || data?.symbol) setAgentAnalysis(data.analysis || data);
      fetchAll();
    } finally {
      setBusy(false);
    }
  }, [busy, fetchAll]);

  return { status, perf, trades, events, calibration, gateStatus, gateDecisions, decisionPipeline, gateEffectiveness, redisStatus, agentAnalysis, analyzeLatestSignal, toggle, refresh: fetchAll, busy };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPnl(v) {
  if (v == null) return '–';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function pnlColor(v) {
  return v == null ? '#64748b' : v >= 0 ? '#22c55e' : '#ef4444';
}

function fmtTime(iso) {
  return iso ? iso.slice(11, 16) : '–';
}

function fmtDate(iso) {
  if (!iso) return '–';
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

function fmtPct(v) {
  if (v == null) return '–';
  return `${Number(v).toFixed(1)}%`;
}

function fmtNum(v, decimals = 0) {
  if (v == null) return '–';
  return Number(v).toFixed(decimals);
}

function resultTag(t) {
  if (t.result === 'WIN')     return { label: '✅ Plus',           color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)' };
  if (t.result === 'LOSS')    return { label: '❌ Minus',          color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)' };
  if (t.result === 'TIMEOUT') return { label: '⏱ Tiden tog slut', color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.2)' };
  return                             { label: '🟡 Öppen',          color: '#eab308', bg: 'rgba(234,179,8,0.08)',   border: 'rgba(234,179,8,0.25)' };
}

function eventTone(event) {
  if (event.type === 'TRADE_OPENED') {
    return { color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' };
  }
  if (event.type === 'TRADE_CLOSED' && /plus/i.test(event.reasonSv || '')) {
    return { color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' };
  }
  if (event.type === 'TRADE_CLOSED' && /minus/i.test(event.reasonSv || '')) {
    return { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)' };
  }
  if (/EMA pausad/i.test(event.reasonSv || '')) {
    return { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' };
  }
  if (/marknaden är stängd/i.test(event.reasonSv || '')) {
    return { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)' };
  }
  if (event.decision === 'skipped') {
    return { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.2)' };
  }
  return { color: '#475569', bg: 'rgba(71,85,105,0.08)', border: 'rgba(71,85,105,0.2)' };
}

function eventDecisionLabel(event) {
  if (event.type === 'TRADE_OPENED') return 'Öppnad';
  if (event.type === 'TRADE_CLOSED') {
    if (/minus/i.test(event.reasonSv || ''))          return 'Minus';
    if (/plus/i.test(event.reasonSv || ''))           return 'Plus';
    if (/timeout|tiden/i.test(event.reasonSv || '')) return 'Timeout';
    return 'Stängd';
  }
  if (event.decision === 'skipped') {
    if (/EMA pausad/i.test(event.reasonSv || ''))                return 'EMA';
    if (/marknaden är stängd/i.test(event.reasonSv || ''))       return 'Stängd';
    if (/status var/i.test(event.reasonSv || ''))                return 'Status';
    return 'Skippad';
  }
  if (event.type === 'AGENT_STARTED') return 'Startad';
  if (event.type === 'AGENT_STOPPED') return 'Stoppad';
  return 'Info';
}

// ── Sub-components ────────────────────────────────────────────────────────────

const ROW_EVEN = { background: 'rgba(255,255,255,0.015)' };
const ROW_ODD  = { background: 'transparent' };

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 130,
      background: 'var(--surface-2, #1e2740)',
      border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px',
    }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: color || 'var(--text)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ByFamilyTable({ bySignalFamily }) {
  const entries = Object.entries(bySignalFamily || {});
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Per signaltyp</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {entries.map(([family, d], i) => (
          <div key={family} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 14px', fontSize: 12,
            ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
            borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>{family.replace(/_/g, ' ')}</span>
            <span style={{ color: '#64748b' }}>
              {d.wins}W / {d.losses}L / {d.timeouts}T · <span style={{ color: pnlColor(d.pnlSum), fontWeight: 700 }}>{fmtPnl(d.pnlSum)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsBlock({ title, subtitle, stats, bySignalFamily, highlightBorder, messageSv }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${highlightBorder || 'var(--border)'}`,
      borderRadius: 12, padding: '16px 20px',
    }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: '#64748b' }}>{subtitle}</div>}
      </div>

      {messageSv ? (
        <div style={{ color: '#64748b', fontSize: 13, padding: '6px 0' }}>{messageSv}</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <StatCard label="Trades"     value={stats.totalTrades ?? 0} />
            <StatCard label="✅ Wins"     value={stats.wins ?? 0}    color="#22c55e" />
            <StatCard label="❌ Losses"   value={stats.losses ?? 0}  color="#ef4444" />
            <StatCard label="⏱ Timeouts" value={stats.timeouts ?? 0} color="#94a3b8" />
            <StatCard
              label="Win rate"
              value={stats.winRate != null ? `${stats.winRate}%` : '–'}
              color={stats.winRate != null ? (stats.winRate >= 50 ? '#22c55e' : '#ef4444') : '#64748b'}
            />
            <StatCard label="Snitt P/L" value={fmtPnl(stats.avgPnlPct)} color={pnlColor(stats.avgPnlPct)} />
          </div>
          {bySignalFamily && Object.keys(bySignalFamily).length > 0 && (
            <ByFamilyTable bySignalFamily={bySignalFamily} />
          )}
        </>
      )}
    </div>
  );
}

function OpenPositions({ openTrades }) {
  if (!openTrades?.length) return null;
  return (
    <div className="sec">
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
        Öppna testpositioner — {openTrades.length} st
      </div>
      {openTrades.map(t => (
        <div key={t.tradeId} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '10px 14px', marginBottom: 6,
          background: 'rgba(234,179,8,0.06)',
          border: '1px solid rgba(234,179,8,0.22)', borderRadius: 8,
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{t.symbol}</span>
            <span style={{ color: t.direction === 'UP' ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 600 }}>
              {t.direction === 'UP' ? '▲ Uppåt' : '▼ Nedåt'}
            </span>
            <span style={{ fontSize: 11, color: '#64748b' }}>{t.signalFamily?.replace(/_/g, ' ')}</span>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: pnlColor(t.unrealizedPct) }}>
              {t.unrealizedPct != null ? fmtPnl(t.unrealizedPct) : '–'} orealiserat
            </span>
            <span style={{ fontSize: 11, color: '#475569' }}>Inne {t.ageMin ?? '?'} min</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentTrades({ allTrades }) {
  const visible = (allTrades || []).slice(0, 10);
  if (!visible.length) return null;
  return (
    <div className="sec">
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
        Senaste trades
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {visible.map((t, i) => {
          const tag = resultTag(t);
          return (
            <div key={t.tradeId} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6,
              padding: '9px 14px',
              ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
              borderBottom: i < visible.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)', fontSize: 13, flexShrink: 0 }}>{t.symbol}</span>
                <span style={{ color: t.direction === 'UP' ? '#22c55e' : '#ef4444', fontSize: 11, flexShrink: 0 }}>
                  {t.direction === 'UP' ? '▲' : '▼'}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: tag.color,
                  background: tag.bg, border: `1px solid ${tag.border}`,
                  borderRadius: 4, padding: '1px 7px', flexShrink: 0,
                }}>
                  {tag.label}
                </span>
                <span style={{ fontSize: 10, color: '#475569', flexShrink: 0 }}>{t.signalFamily?.replace(/_/g, ' ')}</span>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: pnlColor(t.result !== 'OPEN' ? t.pnlPct : t.unrealizedPct) }}>
                  {t.result !== 'OPEN' ? fmtPnl(t.pnlPct) : (t.unrealizedPct != null ? fmtPnl(t.unrealizedPct) + '*' : '–')}
                </span>
                <span style={{ fontSize: 10, color: '#475569' }}>{fmtTime(t.entryTime)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {visible.some(t => t.result === 'OPEN') && (
        <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>* = orealiserat P/L</div>
      )}
    </div>
  );
}

function RecentEvents({ events }) {
  const visible = (events?.events || []).slice(0, 12);
  if (!visible.length) return null;
  const mostCommon = events?.summary?.mostCommonSkipReason;
  return (
    <div className="sec">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          Senaste testbeslut
        </div>
        {mostCommon && (
          <div style={{ fontSize: 11, color: '#475569', maxWidth: 260, textAlign: 'right' }}>
            Vanligast just nu: <span style={{ color: '#64748b' }}>{mostCommon}</span>
          </div>
        )}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {visible.map((event, i) => {
          const tone = eventTone(event);
          return (
            <div key={event.eventId || `${event.timestamp}-${i}`} style={{
              display: 'grid',
              gridTemplateColumns: '48px minmax(58px, 90px) minmax(70px, 88px) 1fr',
              gap: 10,
              alignItems: 'center',
              padding: '9px 14px',
              ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
              borderBottom: i < visible.length - 1 ? '1px solid var(--border)' : 'none',
              fontSize: 12,
            }}>
              <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11 }}>{fmtTime(event.timestamp)}</span>
              <span style={{ color: 'var(--text)', fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{event.symbol || 'SYSTEM'}</span>
              <span style={{
                color: tone.color,
                background: tone.bg,
                border: `1px solid ${tone.border}`,
                borderRadius: 4,
                padding: '2px 6px',
                fontWeight: 700,
                textAlign: 'center',
                fontSize: 10,
              }}>
                {eventDecisionLabel(event)}
              </span>
              <span style={{ color: '#94a3b8', minWidth: 0, fontSize: 11 }}>{event.reasonSv || 'Ingen orsak sparad.'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MARKET_GROUP_LABELS = {
  US_STOCKS:      'US Aktier',
  INDEX_ETFS:     'Index ETF',
  LEVERAGED_ETFS: 'Leveraged ETF',
  CRYPTO_MAJOR:   'Crypto Major',
  CRYPTO_SECONDARY: 'Crypto Secondary',
  UNKNOWN:        'Okänd',
};

const MARKET_GROUP_ORDER = [
  'CRYPTO_MAJOR', 'CRYPTO_SECONDARY', 'US_STOCKS', 'INDEX_ETFS', 'LEVERAGED_ETFS',
];

function CompassBadge({ compass }) {
  if (!compass?.available) return null;
  const color  = compass.riskOn ? '#22c55e' : compass.riskOff ? '#ef4444' : '#f59e0b';
  const bg     = compass.riskOn ? 'rgba(34,197,94,0.08)' : compass.riskOff ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';
  const border = compass.riskOn ? 'rgba(34,197,94,0.3)'  : compass.riskOff ? 'rgba(239,68,68,0.3)'  : 'rgba(245,158,11,0.3)';
  return (
    <div style={{
      padding: '12px 16px',
      background: bg, border: `1px solid ${border}`, borderRadius: 8,
      fontSize: 12, color, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 700 }}>
        Marknadskompassen: {compass.bias?.replace('_', ' ')}
      </span>
      <span style={{ color: '#94a3b8', fontWeight: 400 }}>
        QQQ {compass.qqqTrend} · SPY {compass.spyTrend}
      </span>
      <span style={{ color: '#94a3b8' }}>{compass.messageSv}</span>
    </div>
  );
}

function MarketGroupRow({ group, label, data, paperOnly }) {
  if (!data) return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid var(--border)', opacity: 0.4, fontSize: 12 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      {paperOnly && <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700 }}>PAPER ONLY</span>}
      <span style={{ color: '#475569', fontFamily: 'monospace' }}>Inga tester ännu</span>
    </div>
  );

  const { trades, wins, losses, timeouts, winRate, avgPnlPct } = data;
  const color = winRate != null ? (winRate >= 50 ? '#22c55e' : '#ef4444') : '#64748b';
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      padding: '9px 14px', borderBottom: '1px solid var(--border)', fontSize: 12,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 130 }}>
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{label}</span>
        {paperOnly && (
          <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 800, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 3, padding: '1px 5px' }}>
            PAPER
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontFamily: 'monospace' }}>
        <span style={{ color: '#64748b' }}>{trades} trades</span>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>{wins}W/{losses}L/{timeouts}T</span>
        <span style={{ color, fontWeight: 700 }}>{winRate != null ? `${winRate}%` : '–'}</span>
        <span style={{ color: pnlColor(avgPnlPct), fontWeight: 700 }}>{fmtPnl(avgPnlPct)}</span>
      </div>
    </div>
  );
}

function MarketGroupBreakdown({ perf }) {
  const byGroup = perf?.byMarketGroup || {};
  const hasAny  = Object.keys(byGroup).length > 0;
  const marketGroupPaperOnly = {
    LEVERAGED_ETFS: true,
    CRYPTO_SECONDARY: true,
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>
          Vilken marknad fungerar bäst?
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Jämförelse per marknadsgrupp — alla i paper trading
        </div>
      </div>

      {!hasAny ? (
        <div style={{ color: '#475569', fontSize: 13 }}>
          Inga stängda tester ännu. Starta testläget för att samla in data per marknad.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {MARKET_GROUP_ORDER.map((g, i) => (
            <MarketGroupRow
              key={g}
              group={g}
              label={MARKET_GROUP_LABELS[g] || g}
              data={byGroup[g] || null}
              paperOnly={marketGroupPaperOnly[g] || false}
            />
          ))}
          {Object.keys(byGroup).filter(g => !MARKET_GROUP_ORDER.includes(g)).map(g => (
            <MarketGroupRow
              key={g}
              group={g}
              label={MARKET_GROUP_LABELS[g] || g}
              data={byGroup[g]}
              paperOnly={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Calibration components ────────────────────────────────────────────────────

function VersionCompareCard({ label, stats, highlight }) {
  if (!stats) return (
    <div style={{
      flex: '1 1 220px', padding: '14px 18px',
      background: 'var(--surface-2, #1e2740)',
      border: `1px solid ${highlight ? 'rgba(99,102,241,0.3)' : 'var(--border)'}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 800, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 12, color: '#475569' }}>Ingen data ännu.</div>
    </div>
  );
  const { trades: n, wins, losses, timeouts, winRate, avgPnlPct, timeoutRate, avgMaxFavorablePct, avgMaxAdversePct } = stats;
  return (
    <div style={{
      flex: '1 1 220px', padding: '14px 18px',
      background: 'var(--surface-2, #1e2740)',
      border: `1px solid ${highlight ? 'rgba(99,102,241,0.4)' : 'var(--border)'}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, color: highlight ? '#818cf8' : '#64748b', fontWeight: 800, marginBottom: 10 }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12 }}>
        <span style={{ color: '#475569' }}>Trades</span>         <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)' }}>{n}</span>
        <span style={{ color: '#475569' }}>Win rate</span>       <span style={{ fontFamily: 'monospace', fontWeight: 700, color: winRate >= 50 ? '#22c55e' : '#ef4444' }}>{winRate}%</span>
        <span style={{ color: '#475569' }}>Avg PnL</span>        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: pnlColor(avgPnlPct) }}>{fmtPnl(avgPnlPct)}</span>
        <span style={{ color: '#475569' }}>Timeout-rate</span>   <span style={{ fontFamily: 'monospace', fontWeight: 700, color: timeoutRate > 70 ? '#ef4444' : '#94a3b8' }}>{timeoutRate}%</span>
        <span style={{ color: '#475569' }}>W/L/TO</span>         <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>{wins}/{losses}/{timeouts}</span>
        {avgMaxFavorablePct != null && <>
          <span style={{ color: '#475569' }}>Max fav.</span>     <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#22c55e' }}>{fmtPnl(avgMaxFavorablePct)}</span>
        </>}
        {avgMaxAdversePct != null && <>
          <span style={{ color: '#475569' }}>Max adv.</span>     <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#ef4444' }}>{fmtPnl(avgMaxAdversePct)}</span>
        </>}
      </div>
    </div>
  );
}

function IntrabarRow({ t, i, total }) {
  const tag = resultTag(t);
  const hasFav = t.maxFavorablePct != null;
  const targetPct = t.targetPct || 0.25;
  const isV3 = t.paperRulesVersion === 'v3' || t.ruleVersion === 'v3';
  const isV2 = t.paperRulesVersion === 'v2';
  const versionColor = isV3 ? '#22c55e' : isV2 ? '#818cf8' : '#475569';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '80px 64px 56px 60px 1fr 80px 80px',
      gap: 8, alignItems: 'center', padding: '7px 14px', fontSize: 11,
      ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
      borderBottom: i < total - 1 ? '1px solid var(--border)' : 'none',
    }}>
      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)', fontSize: 12 }}>{t.symbol}</span>
      <span style={{
        color: tag.color, background: tag.bg, border: `1px solid ${tag.border}`,
        borderRadius: 4, padding: '1px 6px', fontWeight: 700, textAlign: 'center', fontSize: 10,
      }}>{tag.label}</span>
      <span style={{ fontFamily: 'monospace', color: pnlColor(t.pnlPct), fontWeight: 700 }}>{fmtPnl(t.pnlPct)}</span>
      <span style={{
        fontSize: 9, fontWeight: 700, color: versionColor,
        background: isV3 ? 'rgba(34,197,94,0.1)' : isV2 ? 'rgba(99,102,241,0.1)' : 'rgba(71,85,105,0.1)',
        border: `1px solid ${isV3 ? 'rgba(34,197,94,0.3)' : isV2 ? 'rgba(99,102,241,0.3)' : 'rgba(71,85,105,0.2)'}`,
        borderRadius: 4, padding: '1px 5px', textAlign: 'center',
      }}>{t.paperRulesVersion || t.ruleVersion || 'v1'}</span>
      <span style={{ color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.signalSubtype?.replace(/_/g,' ')}</span>
      {hasFav ? (
        <span style={{ fontFamily: 'monospace', color: '#22c55e', fontWeight: 600 }}>
          ▲{fmtPnl(t.maxFavorablePct)}
          {t.maxFavorablePct >= targetPct * 0.75 && <span style={{ color: '#f59e0b', marginLeft: 3 }}>★</span>}
        </span>
      ) : <span style={{ color: '#334155' }}>–</span>}
      {t.maxAdversePct != null ? (
        <span style={{ fontFamily: 'monospace', color: '#ef4444', fontWeight: 600 }}>▼{fmtPnl(t.maxAdversePct)}</span>
      ) : <span style={{ color: '#334155' }}>–</span>}
    </div>
  );
}

function CalibrationSection({ calibration }) {
  const [open, setOpen] = useState(false);
  if (!calibration) return null;

  const { v1, v2, v3, recentTrades, topBlockedReasons, nearMisses, safetyAlert, conservativeMode } = calibration;
  const hasData = (v1?.trades || 0) + (v2?.trades || 0) + (v3?.trades || 0) > 0;

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 20px', marginBottom: 20,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Kalibrering v3</span>
          <span style={{
            fontSize: 9, fontWeight: 700, color: '#22c55e',
            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: 4, padding: '1px 6px',
          }}>Regler v3</span>
          {conservativeMode && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: '#f59e0b',
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 4, padding: '1px 6px',
            }}>KONSERVATIVT LÄGE</span>
          )}
        </div>
        <span style={{ color: '#475569', fontSize: 14 }}>{open ? '▼' : '▶'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Safety alert */}
          {safetyAlert?.triggered && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 12,
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)',
              color: '#fca5a5',
            }}>
              <strong>Säkerhetsvarning:</strong> v3 timeout-rate {safetyAlert.timeoutRate}% · avg PnL {fmtPnl(safetyAlert.avgPnl)}
              {safetyAlert.recommendation && <div style={{ marginTop: 4, color: '#94a3b8' }}>{safetyAlert.recommendation}</div>}
            </div>
          )}

          {/* v1 vs v2 vs v3 */}
          {hasData && (
            <div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                v1 vs v2 vs v3 — regelversion per trade
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <VersionCompareCard label="v1 (target 0.40% / stop 0.25%)" stats={v1} />
                <VersionCompareCard label="v2 (target 0.25% / stop 0.20%)" stats={v2} highlight />
                <VersionCompareCard label="v3 crypto VWAP stark volym (target 0.20% / stop 0.18% / 12m)" stats={v3} highlight />
              </div>
            </div>
          )}

          {/* Recent 20 trades with intrabar */}
          {recentTrades?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Senaste 20 trades — intrabar max / min (★ = nära target)
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '80px 64px 56px 60px 1fr 80px 80px',
                  gap: 8, padding: '5px 14px', fontSize: 9, color: '#475569', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)',
                }}>
                  <span>Symbol</span><span>Utfall</span><span>PnL</span><span>Ver</span>
                  <span>Signaltyp</span><span>Max fav.</span><span>Max adv.</span>
                </div>
                {recentTrades.map((t, i) => (
                  <IntrabarRow key={t.tradeId || i} t={t} i={i} total={recentTrades.length} />
                ))}
              </div>
            </div>
          )}

          {/* Top blocked reasons */}
          {topBlockedReasons?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Vanligaste skip-orsaker
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {topBlockedReasons.slice(0, 8).map((r, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '7px 14px', fontSize: 11,
                    ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
                    borderBottom: i < Math.min(topBlockedReasons.length, 8) - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ color: '#94a3b8', flex: 1, marginRight: 12 }}>{r.reason}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#64748b', flexShrink: 0 }}>{r.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Near-misses */}
          {nearMisses?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#f59e0b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Nästan nådde target — föll tillbaka (★)
              </div>
              <div style={{ border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, overflow: 'hidden' }}>
                {nearMisses.map((t, i) => (
                  <div key={t.tradeId || i} style={{
                    display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
                    padding: '7px 14px', fontSize: 11,
                    ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
                    borderBottom: i < nearMisses.length - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)', minWidth: 72 }}>{t.symbol}</span>
                    <span style={{ color: '#475569', flexShrink: 0 }}>{t.signalSubtype?.replace(/_/g,' ')}</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>max {fmtPnl(t.maxFavorablePct)}</span>
                    <span style={{ color: '#64748b', fontSize: 10 }}>target {fmtPnl(t.targetPct)}</span>
                    <span style={{ fontFamily: 'monospace', color: pnlColor(t.pnlAtExit) }}>exit {fmtPnl(t.pnlAtExit)}</span>
                    <span style={{ fontSize: 9, color: '#64748b' }}>{t.entryTime?.slice(0,16)?.replace('T',' ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

// ── Gate components ───────────────────────────────────────────────────────────

function GateScoreBadge({ score, threshold, mode }) {
  const allowed = score >= threshold && mode !== 'blocked';
  const color   = mode === 'blocked' ? '#ef4444'
                : mode === 'observe_only' ? '#f59e0b'
                : allowed ? '#22c55e' : '#ef4444';
  return (
    <span style={{
      fontFamily: 'monospace', fontWeight: 800, fontSize: 11,
      color,
      background: `${color}15`,
      border: `1px solid ${color}40`,
      borderRadius: 4, padding: '1px 7px',
    }}>
      {score}/{threshold}
    </span>
  );
}

function GateModeBadge({ mode }) {
  const cfg = {
    blocked:      { label: 'BLOCKERAD', color: '#ef4444' },
    observe_only: { label: 'BEVAKA',    color: '#f59e0b' },
    conservative: { label: 'KONSERV.',  color: '#a78bfa' },
    normal:       { label: 'NORMAL',    color: '#22c55e' },
  }[mode] || { label: mode?.toUpperCase() || '–', color: '#64748b' };
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, color: cfg.color,
      background: `${cfg.color}15`,
      border: `1px solid ${cfg.color}40`,
      borderRadius: 4, padding: '1px 6px',
    }}>
      {cfg.label}
    </span>
  );
}

function GateDecisionRow({ d, i, total }) {
  const allowed = d.allowed;
  const isObserveOnly = d.mode === 'observe_only';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '80px 56px 72px 1fr auto',
      gap: 8, alignItems: 'center', padding: '7px 14px', fontSize: 11,
      ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
      borderBottom: i < total - 1 ? '1px solid var(--border)' : 'none',
    }}>
      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)', fontSize: 12 }}>
        {d.signal?.symbol || '–'}
      </span>
      <GateModeBadge mode={d.mode} />
      <GateScoreBadge score={d.gateScore} threshold={d.threshold} mode={d.mode} />
      <span style={{ color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>
        {allowed
          ? (d.boosts?.[0] || d.signal?.signalSubtype?.replace(/_/g,' ') || '–')
          : (d.reasons?.[0] || d.penalties?.[0] || '–')}
      </span>
      <span style={{
        fontSize: 9, color: isObserveOnly ? '#f59e0b' : allowed ? '#22c55e' : '#ef4444', fontWeight: 700,
      }}>
        {isObserveOnly ? 'OBS' : allowed ? 'OK' : 'NEJ'}
      </span>
    </div>
  );
}

function PipelineBar({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.3s' }} />
    </div>
  );
}

function PipelinePanel({ pipeline, summary, topRejectionReasons, topGateBlockReasons }) {
  if (!pipeline) return null;

  const {
    scannerCandidatesToday: cands,
    qualifiesCheckedToday:  checked,
    qualifiesPassedToday:   passed,
    qualifiesRejectedToday: rejected,
    marketGateEvaluatedToday: gateEval,
    marketGateAllowedToday:   gateAllow,
    marketGateBlockedToday:   gateBlock,
    marketGateObserveOnlyToday: gateObs,
    tradesOpenedToday:        opened,
    last60m, conversionRates,
  } = pipeline;

  const steps = [
    { label: 'Scanner candidates',    value: cands,    color: '#64748b' },
    { label: 'Passerade första filter', value: passed,  color: '#818cf8' },
    { label: 'Nådde Market Gate',      value: gateEval, color: '#f59e0b' },
    { label: 'Gate godkänd',           value: gateAllow,color: '#22c55e' },
    { label: 'Gate blockerad',         value: gateBlock, color: '#ef4444' },
    { label: 'Bevakningsläge',         value: gateObs,  color: '#f59e0b' },
    { label: 'Trades öppnade',         value: opened,   color: '#22c55e' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Swedish summary */}
      {summary && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: 12,
          background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)',
          color: '#93c5fd', lineHeight: 1.5,
        }}>
          {summary}
        </div>
      )}

      {/* Pipeline funnel */}
      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Pipeline idag
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {steps.map(({ label, value, color }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 10, color: '#64748b', minWidth: 155, flexShrink: 0 }}>{label}</span>
              <PipelineBar value={value} max={cands || 1} color={color} />
              <span style={{
                fontFamily: 'monospace', fontWeight: 800, fontSize: 12,
                color, minWidth: 28, textAlign: 'right', flexShrink: 0,
              }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Conversion rates */}
      {conversionRates && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            { label: 'Första filter', value: conversionRates.qualifiesPassRate, suffix: '%' },
            { label: 'Gate pass-rate', value: conversionRates.gateAllowRate,    suffix: '%' },
            { label: 'Trade open rate', value: conversionRates.tradeOpenRate,   suffix: '%' },
          ].map(({ label, value, suffix }) => value != null && (
            <div key={label} style={{
              background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '6px 12px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 9, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: value >= 50 ? '#22c55e' : value >= 20 ? '#f59e0b' : '#ef4444' }}>
                {value}{suffix}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Senaste 60 min */}
      {last60m && (
        <div>
          <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
            Senaste 60 min
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[
              { k: 'candidatesLast60m',    label: 'Kandidater',  color: '#64748b' },
              { k: 'qualifiesPassedLast60m', label: 'Filter OK', color: '#818cf8' },
              { k: 'gateEvaluatedLast60m', label: 'Gate eval',  color: '#f59e0b' },
              { k: 'gateAllowedLast60m',   label: 'Gate OK',    color: '#22c55e' },
              { k: 'gateBlockedLast60m',   label: 'Blockerade', color: '#ef4444' },
              { k: 'tradesOpenedLast60m',  label: 'Trades',     color: '#22c55e' },
            ].map(({ k, label, color }) => (
              <div key={k} style={{
                background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ fontSize: 10, color: '#475569' }}>{label}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 12, color }}>{last60m[k] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top rejection reasons */}
      {(topRejectionReasons?.length > 0 || topGateBlockReasons?.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {topRejectionReasons?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                Varför stoppas signaler? (första filter)
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {topRejectionReasons.slice(0, 6).map((r, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 12px', fontSize: 11,
                    ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
                    borderBottom: i < Math.min(topRejectionReasons.length, 6) - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ color: '#94a3b8', flex: 1, marginRight: 10, fontSize: 10 }}>{r.reason}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#64748b', flexShrink: 0 }}>{r.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topGateBlockReasons?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                Gate-blockeringsorsaker
              </div>
              <div style={{ border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, overflow: 'hidden' }}>
                {topGateBlockReasons.slice(0, 6).map((r, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 12px', fontSize: 11,
                    ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
                    borderBottom: i < Math.min(topGateBlockReasons.length, 6) - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ color: '#fca5a5', flex: 1, marginRight: 10, fontSize: 10 }}>{r.reason}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#ef4444', flexShrink: 0 }}>{r.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniAnalysisTable({ columns, rows, emptyText }) {
  if (!rows?.length) {
    return <div style={{ color: '#64748b', fontSize: 12, padding: '8px 0' }}>{emptyText || 'Det finns ännu för lite data för säker analys.'}</div>;
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: columns.map(c => c.width || '1fr').join(' '),
        gap: 8, padding: '6px 12px', fontSize: 9, color: '#475569', fontWeight: 800,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)',
      }}>
        {columns.map(c => <span key={c.key}>{c.label}</span>)}
      </div>
      {rows.map((row, i) => (
        <div key={row.key || row.bucket || row.decisionCode || row.marketGroup || row.compassBias || String(row.compassConflict) || i} style={{
          display: 'grid', gridTemplateColumns: columns.map(c => c.width || '1fr').join(' '),
          gap: 8, alignItems: 'center', padding: '7px 12px', fontSize: 11,
          ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
          borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
        }}>
          {columns.map(c => {
            const cellColor = typeof c.color === 'function' ? c.color(row[c.key], row) : c.color;
            return (
              <span key={c.key} style={{
                color: cellColor || '#94a3b8',
                fontFamily: c.mono ? 'monospace' : undefined,
                fontWeight: c.bold ? 700 : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '–')}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function GateEffectivenessPanel({ report }) {
  if (!report) return null;
  const s = report.summary || {};
  const dq = report.dataQuality || {};
  const hasAnalysis = (dq.openedTradesCount || 0) > 0 || (dq.gateDecisionCount || 0) > 0;
  const recommendations = report.recommendations || [];
  const sourceLabel = dq.gateDecisionSource === 'disk' ? 'Diskhistorik' : 'Minne';

  const bucketRows = (report.byGateScoreBucket || []).map(r => ({
    ...r,
    winRateFmt: fmtPct(r.winRate),
    timeoutRateFmt: fmtPct(r.timeoutRate),
    avgPnlFmt: fmtPnl(r.avgPnlPct),
    avgFavFmt: fmtPnl(r.avgMaxFavorablePct),
  }));
  const decisionRows = (report.byDecisionCode || []).slice(0, 8).map(r => ({
    ...r,
    modeBreakdown: `${r.modes?.allow || 0}/${r.modes?.block || 0}/${r.modes?.observe_only || 0}`,
    reason: r.exampleReasonSv || '–',
  }));
  const marketRows = (report.byMarketGroup || []).slice(0, 8).map(r => ({
    ...r,
    winRateFmt: fmtPct(r.winRate),
    timeoutRateFmt: fmtPct(r.timeoutRate),
    avgPnlFmt: fmtPnl(r.avgPnlPct),
  }));
  const compassBiasRows = (report.byCompassBias || []).slice(0, 6).map(r => ({
    ...r,
    winRateFmt: fmtPct(r.winRate),
    timeoutRateFmt: fmtPct(r.timeoutRate),
    avgPnlFmt: fmtPnl(r.avgPnlPct),
  }));
  const compassConflictRows = (report.byCompassConflict || []).map(r => ({
    ...r,
    conflictLabel: r.compassConflict ? 'Ja' : 'Nej',
    winRateFmt: fmtPct(r.winRate),
    timeoutRateFmt: fmtPct(r.timeoutRate),
    avgPnlFmt: fmtPnl(r.avgPnlPct),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Gate effectiveness v1.3
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <StatCard label="Gate evaluated" value={s.totalGateEvaluated ?? 0} />
          <StatCard label="Persisted decisions" value={dq.persistedGateDecisionCount ?? 0} sub={sourceLabel} />
          <StatCard label="Allowed" value={s.allowed ?? 0} color="#22c55e" />
          <StatCard label="Blocked" value={s.blocked ?? 0} color="#ef4444" />
          <StatCard label="Observe only" value={s.observeOnly ?? 0} color="#f59e0b" />
          <StatCard label="Trades opened" value={s.openedTrades ?? 0} />
          <StatCard label="Gate allow rate" value={fmtPct(s.gateAllowRate)} color={s.gateAllowRate >= 50 ? '#22c55e' : '#f59e0b'} />
          <StatCard label="Trade open rate" value={fmtPct(s.tradeOpenRate)} />
          <StatCard label="Avg PnL opened" value={fmtPnl(s.avgPnlOpened)} color={pnlColor(s.avgPnlOpened)} />
        </div>
      </div>

      <div style={{
        padding: '10px 14px', borderRadius: 8, fontSize: 12,
        background: hasAnalysis ? 'rgba(99,102,241,0.06)' : 'rgba(245,158,11,0.07)',
        border: `1px solid ${hasAnalysis ? 'rgba(99,102,241,0.18)' : 'rgba(245,158,11,0.22)'}`,
        color: hasAnalysis ? '#93c5fd' : '#fbbf24',
      }}>
        {dq.noteSv || 'Det finns ännu för lite data för säker analys.'}
        <span style={{ display: 'block', marginTop: 4, color: '#94a3b8' }}>
          Gate decisions läses från {sourceLabel.toLowerCase()}. Senaste persistade beslut: {fmtDate(dq.latestPersistedGateDecisionAt)}.
        </span>
      </div>

      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Gate score buckets
        </div>
        <MiniAnalysisTable
          rows={bucketRows}
          columns={[
            { key: 'bucket', label: 'Bucket', width: '72px', mono: true, bold: true },
            { key: 'count', label: 'Count', width: '54px', mono: true },
            { key: 'openedTrades', label: 'Opened', width: '58px', mono: true },
            { key: 'winRateFmt', label: 'Win', width: '58px', mono: true },
            { key: 'timeoutRateFmt', label: 'Timeout', width: '72px', mono: true },
            { key: 'avgPnlFmt', label: 'Avg PnL', width: '72px', mono: true, color: (_, row) => pnlColor(row.avgPnlPct) },
            { key: 'avgFavFmt', label: 'Max fav.', width: '72px', mono: true, color: '#22c55e' },
          ]}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Top decision codes
          </div>
          <MiniAnalysisTable
            rows={decisionRows}
            columns={[
              { key: 'decisionCode', label: 'Code', width: 'minmax(120px, 1fr)', mono: true, bold: true },
              { key: 'count', label: 'Count', width: '48px', mono: true },
              { key: 'modeBreakdown', label: 'A/B/O', width: '58px', mono: true },
              { key: 'reason', label: 'Reason', width: 'minmax(120px, 1.4fr)' },
            ]}
          />
        </div>

        <div>
          <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Market groups
          </div>
          <MiniAnalysisTable
            rows={marketRows}
            columns={[
              { key: 'marketGroup', label: 'Group', width: 'minmax(110px, 1fr)', mono: true, bold: true },
              { key: 'gateEvaluated', label: 'Gate', width: '48px', mono: true },
              { key: 'openedTrades', label: 'Trades', width: '54px', mono: true },
              { key: 'winRateFmt', label: 'Win', width: '54px', mono: true },
              { key: 'timeoutRateFmt', label: 'TO', width: '54px', mono: true },
              { key: 'avgPnlFmt', label: 'PnL', width: '64px', mono: true, color: (_, row) => pnlColor(row.avgPnlPct) },
            ]}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: '#818cf8', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Compass bias
          </div>
          <MiniAnalysisTable
            rows={compassBiasRows}
            columns={[
              { key: 'compassBias', label: 'Bias', width: 'minmax(100px, 1fr)', mono: true, bold: true },
              { key: 'gateEvaluated', label: 'Gate', width: '48px', mono: true },
              { key: 'openedTrades', label: 'Trades', width: '54px', mono: true },
              { key: 'winRateFmt', label: 'Win', width: '54px', mono: true },
              { key: 'avgPnlFmt', label: 'PnL', width: '64px', mono: true, color: (_, row) => pnlColor(row.avgPnlPct) },
            ]}
          />
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#f59e0b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Compass conflict
          </div>
          <MiniAnalysisTable
            rows={compassConflictRows}
            columns={[
              { key: 'conflictLabel', label: 'Conflict', width: '72px', bold: true },
              { key: 'openedTrades', label: 'Trades', width: '54px', mono: true },
              { key: 'winRateFmt', label: 'Win', width: '54px', mono: true },
              { key: 'timeoutRateFmt', label: 'TO', width: '54px', mono: true },
              { key: 'avgPnlFmt', label: 'PnL', width: '64px', mono: true, color: (_, row) => pnlColor(row.avgPnlPct) },
            ]}
          />
        </div>
      </div>

      <div>
        <div style={{ fontSize: 10, color: '#f59e0b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Rekommendationer
        </div>
        {recommendations.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recommendations.map((rec, i) => (
              <div key={i} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.22)',
                color: '#fbbf24',
              }}>{rec}</div>
            ))}
          </div>
        ) : (
          <div style={{ color: '#64748b', fontSize: 12 }}>Det finns ännu för lite data för säker analys.</div>
        )}
      </div>
    </div>
  );
}

function GateSection({ gateStatus, gateDecisions, decisionPipeline, gateEffectiveness }) {
  const [open, setOpen] = useState(false);
  if (!gateStatus) return null;

  const { thresholds, conservativeMode, compassBias, compassAvailable, calibrationStats } = gateStatus;
  const decisions = gateDecisions?.decisions || [];
  const blocked   = gateDecisions?.blocked ?? 0;
  const allowed   = gateDecisions?.allowed ?? 0;
  const observeOnly = gateDecisions?.observeOnly ?? 0;
  const total     = blocked + allowed + observeOnly;
  const pipeline  = decisionPipeline?.pipeline || gateStatus?.pipeline || null;

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 20px', marginBottom: 20,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Market Gate v3</span>
          {conservativeMode && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: '#a78bfa',
              background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
              borderRadius: 20, padding: '2px 10px',
            }}>Konservativt läge</span>
          )}
          {pipeline?.scannerCandidatesToday > 0 && (
            <span style={{ fontSize: 11, color: '#64748b' }}>
              {pipeline.scannerCandidatesToday} kandidater · {pipeline.tradesOpenedToday} öppnade idag
            </span>
          )}
          {total > 0 && (
            <span style={{ fontSize: 11, color: '#64748b' }}>
              | gate: {allowed} OK / {blocked} blockerade / {observeOnly} observe only
            </span>
          )}
        </div>
        <span style={{ color: '#64748b', fontSize: 16 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Decision Pipeline */}
          <PipelinePanel
            pipeline={pipeline}
            summary={decisionPipeline?.summary}
            topRejectionReasons={decisionPipeline?.topRejectionReasons}
            topGateBlockReasons={decisionPipeline?.topGateBlockReasons}
          />

          <GateEffectivenessPanel report={gateEffectiveness} />

          {/* Thresholds */}
          <div>
            <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
              Trösklar (gate-poäng / 100)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[
                { label: 'Normal',         value: thresholds?.normal,          color: '#22c55e' },
                { label: 'Konservativt',   value: thresholds?.conservative,    color: '#a78bfa' },
                { label: 'Hävstångs-ETF',  value: thresholds?.LEVERAGED_ETFS,  color: '#f97316' },
                { label: 'Sek. krypto',    value: thresholds?.CRYPTO_SECONDARY, color: '#f59e0b' },
                { label: 'Bevakningsläge', value: thresholds?.observeOnly,     color: '#94a3b8' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{
                  background: 'var(--surface-2, #1e2740)',
                  border: '1px solid var(--border)', borderRadius: 8,
                  padding: '8px 14px', textAlign: 'center', minWidth: 90,
                }}>
                  <div style={{ fontSize: 9, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace', color }}>{value ?? '–'}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Status row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <div style={{
              padding: '8px 14px', borderRadius: 8, fontSize: 12,
              background: conservativeMode ? 'rgba(167,139,250,0.08)' : 'rgba(34,197,94,0.07)',
              border: `1px solid ${conservativeMode ? 'rgba(167,139,250,0.3)' : 'rgba(34,197,94,0.2)'}`,
              color: conservativeMode ? '#a78bfa' : '#22c55e',
              fontWeight: 700,
            }}>
              {conservativeMode ? 'Konservativt läge aktivt — tröskel 80' : 'Normalt läge — tröskel 70'}
            </div>
            {compassAvailable && (
              <div style={{
                padding: '8px 14px', borderRadius: 8, fontSize: 12,
                background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
                color: '#818cf8', fontWeight: 700,
              }}>
                Kompass: {compassBias || 'UNKNOWN'}
              </div>
            )}
          </div>

          {/* Recent gate decisions */}
          {decisions.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Senaste gate-beslut (in-memory, max 50)
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '80px 56px 72px 1fr auto',
                  gap: 8, padding: '5px 14px', fontSize: 9, color: '#475569', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)',
                }}>
                  <span>Symbol</span><span>Läge</span><span>Poäng</span>
                  <span>Orsak / Boost</span><span>OK</span>
                </div>
                {decisions.slice(0, 20).map((d, i) => (
                  <GateDecisionRow key={i} d={d} i={i} total={Math.min(decisions.length, 20)} />
                ))}
              </div>
            </div>
          )}

          {/* Rule list */}
          <div>
            <div style={{ fontSize: 10, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
              Aktiva regler
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(gateStatus.activeRules || []).map(r => (
                <span key={r} style={{
                  fontSize: 10, fontWeight: 700, color: '#64748b',
                  background: 'rgba(100,116,139,0.1)', border: '1px solid rgba(100,116,139,0.2)',
                  borderRadius: 4, padding: '2px 8px',
                }}>
                  {r.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

function AgentReasoningPanel({ analysis, redisStatus, onAnalyze, busy }) {
  const redisColor = redisStatus?.redisAvailable ? '#22c55e' : '#f59e0b';
  const adj = analysis?.confidence_adjustment;
  const adjColor = adj == null ? '#64748b' : adj >= 0 ? '#22c55e' : '#ef4444';

  const rows = [
    ['Symbol', analysis?.symbol],
    ['Riktning', analysis?.direction === 'UP' ? 'Uppåt' : analysis?.direction === 'DOWN' ? 'Nedåt' : analysis?.direction],
    ['Teknisk vy', analysis?.technical_view],
    ['Bull-case', analysis?.bull_case],
    ['Bear-case', analysis?.bear_case],
    ['Riskkommentar', analysis?.risk_notes],
    ['Riskflaggor', (analysis?.risk_flags || []).length ? analysis.risk_flags.join(', ') : 'Inga'],
    ['Blockera trade', analysis?.should_block_trade ? 'Ja' : 'Nej'],
    ['Slutkommentar', analysis?.final_commentary],
    ['Källa', analysis?.source],
    ['Timestamp', fmtDate(analysis?.timestamp)],
  ];

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '16px 20px', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>AI Agent Reasoning</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {analysis?.symbol ? `${analysis.symbol} · ${analysis.direction}` : 'Ingen analys cachead ännu'}
          </div>
        </div>
        <button
          onClick={onAnalyze}
          disabled={busy}
          style={{
            borderRadius: 6, padding: '7px 14px', fontSize: 12, fontWeight: 700,
            background: 'var(--surface-2, #1e2740)', color: '#94a3b8',
            border: '1px solid var(--border)', cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Analysera senaste signal
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div style={{
          background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <div style={{ fontSize: 9, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Redis</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: redisColor }}>{redisStatus?.mode || 'fallback'}</div>
        </div>
        <div style={{
          background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <div style={{ fontSize: 9, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Confidence</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: adjColor, fontFamily: 'monospace' }}>
            {adj == null ? '–' : `${adj > 0 ? '+' : ''}${adj}`}
          </div>
        </div>
        <div style={{
          background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <div style={{ fontSize: 9, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Senaste analys</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', fontFamily: 'monospace' }}>{fmtDate(analysis?.timestamp)}</div>
        </div>
        {analysis?.should_block_trade && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '8px 12px', color: '#ef4444', fontWeight: 800, fontSize: 12,
          }}>
            Blockerar enligt riskflagga
          </div>
        )}
      </div>

      {analysis ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {rows.map(([label, value], i) => (
            <div key={label} style={{
              display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12,
              padding: '9px 14px', fontSize: 12,
              ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
              borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <span style={{ color: '#64748b', fontWeight: 800 }}>{label}</span>
              <span style={{ color: '#94a3b8', lineHeight: 1.45 }}>{value || '–'}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: '#64748b', fontSize: 12 }}>
          Kör en analys när Decision Monitor har en aktuell kandidat.
        </div>
      )}
    </div>
  );
}

function HistoricalPatternMemoryPanel({ analysis }) {
  const summary = analysis?.memory_summary || null;
  const matches = Array.isArray(analysis?.memory_matches) ? analysis.memory_matches.slice(0, 5) : [];
  const adj = summary?.memory_confidence_adjustment ?? analysis?.memory_confidence_adjustment;
  const adjColor = adj == null ? '#64748b' : adj >= 0 ? '#22c55e' : '#ef4444';

  const statItems = [
    ['Liknande historik', summary ? fmtNum(summary.sample_size) : '–'],
    ['Träffsäkerhet', fmtPct(summary?.win_rate)],
    ['Snittrörelse', fmtPnl(summary?.avg_move_15m_pct)],
    ['Historisk risk', summary ? `MFE ${fmtPnl(summary.avg_mfe_pct)} · MAE ${fmtPnl(summary.avg_mae_pct)}` : '–'],
    ['Minnesjustering', adj == null ? '–' : `${adj > 0 ? '+' : ''}${adj}`],
  ];

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '16px 20px', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>Historical Pattern Memory</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {analysis?.symbol ? `${analysis.symbol} · ${analysis.memory_storage_provider || analysis.memory_provider || 'memory'}` : 'Ingen minnesanalys cachead ännu'}
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{fmtDate(analysis?.timestamp)}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
        {statItems.map(([label, value]) => (
          <div key={label} style={{
            background: 'var(--surface-2, #1e2740)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '9px 12px', minHeight: 58,
          }}>
            <div style={{ fontSize: 9, color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: label === 'Minnesjustering' ? adjColor : '#94a3b8', marginTop: 5 }}>{value}</div>
          </div>
        ))}
      </div>

      {summary?.memory_warning && (
        <div style={{
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)',
          borderRadius: 8, padding: '9px 12px', color: '#f59e0b', fontSize: 12, fontWeight: 750,
          marginBottom: 12,
        }}>
          {summary.memory_warning}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, fontSize: 12, marginBottom: 10 }}>
        <span style={{ color: '#64748b', fontWeight: 800 }}>Provider</span>
        <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{analysis?.memory_provider || '–'}</span>
      </div>

      {matches.length ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {matches.map((m, i) => (
            <div key={`${m.id || i}-${m.symbol}`} style={{
              display: 'grid', gridTemplateColumns: '90px 72px 84px 1fr', gap: 10,
              padding: '9px 12px', fontSize: 12, alignItems: 'center',
              ...(i % 2 === 0 ? ROW_EVEN : ROW_ODD),
              borderBottom: i < matches.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <span style={{ color: 'var(--text)', fontWeight: 850 }}>{m.symbol || '–'}</span>
              <span style={{ color: '#94a3b8' }}>{m.similarity_score ?? 0}%</span>
              <span style={{ color: m.outcome_type === 'win' ? '#22c55e' : m.outcome_type === 'loss' ? '#ef4444' : '#f59e0b', fontWeight: 800 }}>
                {m.outcome_type || 'unknown'}
              </span>
              <span style={{ color: '#94a3b8' }}>
                {m.state || '–'} · {fmtPnl(m.move_after_15m_pct)} · MAE {fmtPnl(m.max_adverse_excursion_pct)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: '#64748b', fontSize: 12 }}>Inga liknande historiska setups hittades ännu.</div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PaperTradingPage() {
  const { status, perf, trades, events, calibration, gateStatus, gateDecisions, decisionPipeline, gateEffectiveness, redisStatus, agentAnalysis, analyzeLatestSignal, toggle, refresh, busy } = usePaperTrading();

  const enabled     = status?.enabled   ?? false;
  const openTrades  = status?.openTrades ?? [];
  const openCount   = status?.openCount  ?? 0;
  const emaIsPaused = status?.filters?.allowEmaPaperTrades === false;
  const hasTrades   = (perf?.totalTrades ?? 0) > 0;
  const af          = perf?.afterFilter;
  const observeOnlyToday = decisionPipeline?.pipeline?.marketGateObserveOnlyToday
    ?? gateStatus?.pipeline?.marketGateObserveOnlyToday
    ?? 0;

  const todayStr    = new Date().toISOString().slice(0, 10);
  const todayClosed = (trades?.trades || []).filter(t =>
    t.result !== 'OPEN' && (t.exitTime || t.entryTime)?.startsWith(todayStr),
  );
  const todayPnl = todayClosed.length
    ? todayClosed.reduce((s, t) => s + (t.pnlPct || 0), 0)
    : null;

  const btnBase = {
    borderRadius: 6, padding: '7px 18px', fontSize: 12, fontWeight: 700,
    cursor: busy ? 'wait' : 'pointer', border: 'none',
  };

  return (
    <div className="page-wrap">

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">Paper trading</div>
          <div className="hero-sub">Testläge — ingen riktig handel.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={refresh}
            disabled={busy}
            style={{ ...btnBase, background: 'var(--surface)', color: '#64748b', border: '1px solid var(--border)' }}
          >
            ↻ Uppdatera
          </button>
          <button
            onClick={toggle}
            disabled={busy}
            style={enabled
              ? { ...btnBase, background: 'var(--surface)', color: '#94a3b8', border: '1px solid var(--border)' }
              : { ...btnBase, background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.4)' }
            }
          >
            {busy ? '…' : enabled ? 'Stoppa test' : 'Starta test'}
          </button>
        </div>
      </div>

      {/* ── Info-banner ──────────────────────────────────────────────────── */}
      <div className="sec">
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '12px 16px',
          background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8,
          fontSize: 12, color: '#93c5fd',
        }}>
          <span style={{ fontSize: 16 }}>🧪</span>
          <span><strong>Ingen riktig handel.</strong> Systemet simulerar bara trades.</span>
        </div>
      </div>

      {/* ── Status-rad ───────────────────────────────────────────────────── */}
      <div className="sec">
        <div style={{
          background: 'var(--surface)',
          border: `1px solid ${enabled ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
          borderRadius: 12, padding: '16px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: (enabled || hasTrades) ? 16 : 0 }}>
            <span style={{
              background: enabled ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.1)',
              color: enabled ? '#22c55e' : '#64748b',
              border: `1px solid ${enabled ? 'rgba(34,197,94,0.4)' : '#334155'}`,
              borderRadius: 20, padding: '4px 14px', fontSize: 12, fontWeight: 700,
            }}>
              {enabled ? '● Testläge på hela tiden' : '○ Testläge av'}
            </span>

            {emaIsPaused && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: '#f59e0b',
                background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)',
                borderRadius: 20, padding: '4px 12px',
              }}>
                EMA pausad i paper test
              </span>
            )}

            {enabled && openCount > 0 && (
              <span style={{ fontSize: 12, color: '#eab308', fontWeight: 600 }}>
                {openCount} öppen{openCount !== 1 ? 'a' : ''} position{openCount !== 1 ? 'er' : ''}
              </span>
            )}
          </div>

          {(enabled || hasTrades) ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <StatCard
                label="Testläge"
                value={enabled ? 'På' : 'Av'}
                sub={enabled ? 'Persistent mode' : 'Starta test'}
                color={enabled ? '#22c55e' : '#64748b'}
              />
              <StatCard
                label="Öppna positioner"
                value={openCount}
                sub={openCount > 0 ? 'Aktiva nu' : enabled ? 'Agenten väntar på stark volym' : '–'}
                color={openCount > 0 ? '#eab308' : '#64748b'}
              />
              <StatCard
                label="Observe only"
                value={observeOnlyToday}
                sub="idag"
                color="#f59e0b"
              />
              <StatCard
                label="Dagens P/L"
                value={fmtPnl(todayPnl != null ? Math.round(todayPnl * 100) / 100 : null)}
                sub={`${todayClosed.length} stängda idag`}
                color={pnlColor(todayPnl)}
              />
              <StatCard
                label="Win rate"
                value={perf?.winRate != null ? `${perf.winRate}%` : '–'}
                sub={`${perf?.wins ?? 0}W / ${perf?.losses ?? 0}L / ${perf?.timeouts ?? 0}T`}
                color={perf?.winRate != null ? (perf.winRate >= 50 ? '#22c55e' : '#ef4444') : '#64748b'}
              />
              <StatCard
                label="Snitt per trade"
                value={fmtPnl(perf?.avgPnlPct)}
                sub="realiserat"
                color={pnlColor(perf?.avgPnlPct)}
              />
            </div>
          ) : (
            <div style={{ color: '#475569', fontSize: 13 }}>
              Starta testläget för att se hur systemets signaler presterar i realtid.
            </div>
          )}
        </div>
      </div>

      {/* ── Väntar på signal ─────────────────────────────────────────────── */}
      {enabled && openCount === 0 && (
        <div className="sec">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px',
            background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 8,
            color: '#eab308', fontSize: 13,
          }}>
            <span style={{ fontSize: 16 }}>◌</span>
            Agenten väntar på stark volym.
          </div>
        </div>
      )}

      {/* ── Marknadskompassen ───────────────────────────────────────────── */}
      {status?.marketCompass?.available && (
        <div className="sec">
          <CompassBadge compass={status.marketCompass} />
        </div>
      )}

      <AgentReasoningPanel
        analysis={agentAnalysis}
        redisStatus={redisStatus}
        onAnalyze={analyzeLatestSignal}
        busy={busy}
      />

      <HistoricalPatternMemoryPanel analysis={agentAnalysis} />

      {/* ── Statistik: Alla tester + Efter EMA-paus ──────────────────────── */}
      {hasTrades && (
        <div className="sec">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>

            <StatsBlock
              title="Alla tester"
              subtitle={`Totalt ${perf?.totalTrades ?? 0} trades sedan start`}
              stats={{
                totalTrades: perf?.totalTrades ?? 0,
                wins:        perf?.wins ?? 0,
                losses:      perf?.losses ?? 0,
                timeouts:    perf?.timeouts ?? 0,
                winRate:     perf?.winRate,
                avgPnlPct:   perf?.avgPnlPct,
              }}
              bySignalFamily={perf?.bySignalFamily}
            />

            {af?.enabled && (
              <StatsBlock
                title="Efter EMA-paus"
                subtitle={
                  af.startedAt
                    ? `Så går testet efter att EMA pausades · från ${fmtDate(af.startedAt)}`
                    : 'Ingen efter-EMA-data ännu.'
                }
                stats={{
                  totalTrades: af.totalTrades ?? 0,
                  wins:        af.wins ?? 0,
                  losses:      af.losses ?? 0,
                  timeouts:    af.timeouts ?? 0,
                  winRate:     af.winRate,
                  avgPnlPct:   af.avgPnlPct,
                }}
                bySignalFamily={af.bySignalFamily}
                highlightBorder="rgba(245,158,11,0.3)"
                messageSv={af.messageSv}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Per marknad ─────────────────────────────────────────────────── */}
      <MarketGroupBreakdown perf={perf} />

      {/* ── Senaste testbeslut ───────────────────────────────────────────── */}
      {(events?.events || []).length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
          <RecentEvents events={events} />
        </div>
      )}

      {/* ── Öppna positioner ─────────────────────────────────────────────── */}
      {openCount > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
          <OpenPositions openTrades={openTrades} />
        </div>
      )}

      {/* ── Senaste trades ───────────────────────────────────────────────── */}
      {(trades?.trades || []).length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
          <RecentTrades allTrades={trades?.trades} />
        </div>
      )}

      {/* ── Kalibrering v3 ───────────────────────────────────────────────── */}
      <CalibrationSection calibration={calibration} />

      {/* ── Market Gate v3 ───────────────────────────────────────────────── */}
      <GateSection gateStatus={gateStatus} gateDecisions={gateDecisions} decisionPipeline={decisionPipeline} gateEffectiveness={gateEffectiveness} />

    </div>
  );
}
