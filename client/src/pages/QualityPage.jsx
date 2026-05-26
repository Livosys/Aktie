import React, { useState, useEffect, useCallback } from 'react';
import { signalFamilyLabel, signalSubtypeLabel } from '../utils/signalFamilyLabels.js';

const LABEL_META = {
  'Träffade riktning': { color: '#22c55e', bg: 'rgba(34,197,94,0.12)', icon: '✓' },
  'Bra blockering':    { color: '#22c55e', bg: 'rgba(34,197,94,0.12)', icon: '🛡' },
  'Missad möjlighet':  { color: '#f97316', bg: 'rgba(249,115,22,0.12)', icon: '⚠' },
  'Kom för sent':      { color: '#eab308', bg: 'rgba(234,179,8,0.12)',  icon: '⏰' },
  'Osäker':            { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', icon: '~' },
  'Data saknas':       { color: '#475569', bg: 'rgba(71,85,105,0.1)',   icon: '-' },
};

const STATUS_LABEL = {
  active:  'Titta manuellt',
  caution: 'Nära men försiktig',
  watch:   'Bevaka',
  wait:    'Vänta',
  avoid:   'Jaga inte',
};

const BIAS_ICON = { UP: '▲', DOWN: '▼', UNCERTAIN: '?' };

function fmtPct(v) {
  if (v === null || v === undefined) return '–';
  return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function fmtPctRound(v) {
  if (v === null || v === undefined) return '–';
  return `${Number(v)}%`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('sv-SE', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).replace(' ', ' ');
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '14px 16px', minWidth: 110 }}>
      <div style={{ color: '#64748b', fontSize: 10, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ color: color || '#e2e8f0', fontSize: 22, fontWeight: 800, fontFamily: 'monospace', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: '#475569', fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Label distribution bar ─────────────────────────────────────────────────────

function LabelBar({ labelCounts, total }) {
  const items = Object.entries(LABEL_META)
    .map(([label, meta]) => ({ label, count: labelCounts[label] || 0, meta }))
    .filter(i => i.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 14, fontSize: 13 }}>Fördelning — signalkvalitet</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(({ label, count, meta }) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: meta.color, fontSize: 12, width: 14, textAlign: 'center' }}>{meta.icon}</span>
              <span style={{ color: '#94a3b8', fontSize: 12, minWidth: 140 }}>{label}</span>
              <div style={{ flex: 1, background: '#1e293b', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: meta.color, borderRadius: 4, transition: 'width 0.4s' }} />
              </div>
              <span style={{ color: meta.color, fontSize: 11, fontFamily: 'monospace', width: 60, textAlign: 'right' }}>
                {count.toLocaleString('sv-SE')} ({Math.round(pct)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Narrative insight box ──────────────────────────────────────────────────────

function NarrativeBox({ lines }) {
  if (!lines || !lines.length) return null;
  return (
    <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 12, fontSize: 13 }}>Systemets slutsatser</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
            <span style={{ color: '#6366f1', fontWeight: 800 }}>→</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalibrationInsightsBox() {
  const insights = [
    'VWAP_RECLAIM_UP i aktier ser starkast ut i senaste kalibreringen.',
    'VWAP-lägen i crypto är svagare och ska inte lyftas automatiskt.',
    'EMA_PULLBACK_DOWN har fungerat bättre än EMA_PULLBACK_UP i senaste perioden.',
    'REGULAR_PULLBACK i stocks är intressant men bör analyseras senare.',
  ];
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 12, fontSize: 13 }}>Kalibreringsinsikter</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {insights.map((insight) => (
          <div key={insight} style={{ border: '1px solid #1e293b', background: 'rgba(255,255,255,0.025)', borderRadius: 8, padding: '9px 10px', color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>
            {insight}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── By-status table ────────────────────────────────────────────────────────────

function ByStatusTable({ byStatus }) {
  const rows = Object.entries(byStatus)
    .sort((a, b) => {
      const order = { active: 0, caution: 1, watch: 2, wait: 3, avoid: 4 };
      return (order[a[0]] ?? 5) - (order[b[0]] ?? 5);
    });

  if (!rows.length) return null;

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 14, fontSize: 13 }}>Per beslutsstatus</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {['Status', 'Antal', 'Riktning rätt 5m', 'Riktning rätt 10m', 'Bra block', 'Missade', 'Sent'].map(h => (
                <th key={h} style={{ color: '#64748b', fontWeight: 850, textAlign: 'left', padding: '6px 10px', fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([status, v]) => {
              const statusColor = status === 'active' ? '#22c55e' : status === 'avoid' ? '#ef4444' : status === 'watch' ? '#6366f1' : '#94a3b8';
              return (
                <tr key={status} style={{ borderBottom: '1px solid #0f172a' }}>
                  <td style={{ padding: '7px 10px', color: statusColor, fontWeight: 700 }}>{STATUS_LABEL[status] || status}</td>
                  <td style={{ padding: '7px 10px', color: '#e2e8f0', fontFamily: 'monospace' }}>{v.count.toLocaleString('sv-SE')}</td>
                  <td style={{ padding: '7px 10px', color: v.dc5Pct != null ? (v.dc5Pct >= 55 ? '#22c55e' : v.dc5Pct >= 40 ? '#eab308' : '#94a3b8') : '#475569', fontFamily: 'monospace' }}>
                    {status === 'avoid' ? '–' : v.dc5Pct != null ? `${v.dc5Pct}%` : '–'}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>
                    {status === 'avoid' ? '–' : v.dc5Pct != null ? `${v.biasCount > 0 ? Math.round((v.dc10 / v.biasCount) * 100) : '?'}%` : '–'}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#22c55e', fontFamily: 'monospace' }}>{v.goodBlock || '–'}</td>
                  <td style={{ padding: '7px 10px', color: v.badBlock > 0 ? '#f97316' : '#475569', fontFamily: 'monospace' }}>{v.badBlock || '–'}</td>
                  <td style={{ padding: '7px 10px', color: '#475569', fontFamily: 'monospace' }}>{v.late || '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── By-symbol table ────────────────────────────────────────────────────────────

function BySymbolTable({ bySymbol }) {
  if (!bySymbol || !bySymbol.length) return null;

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 14, fontSize: 13 }}>Per symbol</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {['Symbol', 'Signaler', 'Riktning rätt 5m', 'Snittrörelse 5m', 'Bra block', 'Missade'].map(h => (
                <th key={h} style={{ color: '#64748b', fontWeight: 850, textAlign: 'left', padding: '6px 10px', fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bySymbol.map(s => (
              <tr key={s.symbol} style={{ borderBottom: '1px solid #0f172a' }}>
                <td style={{ padding: '7px 10px', color: '#e2e8f0', fontWeight: 700 }}>{s.symbol}</td>
                <td style={{ padding: '7px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>{s.count.toLocaleString('sv-SE')}</td>
                <td style={{ padding: '7px 10px', color: s.dc5Pct != null ? (s.dc5Pct >= 55 ? '#22c55e' : s.dc5Pct >= 40 ? '#eab308' : '#94a3b8') : '#475569', fontFamily: 'monospace' }}>
                  {s.dc5Pct != null ? `${s.dc5Pct}%` : '–'}
                </td>
                <td style={{ padding: '7px 10px', color: s.avgMove5 != null ? (s.avgMove5 > 0 ? '#22c55e' : s.avgMove5 < 0 ? '#ef4444' : '#94a3b8') : '#475569', fontFamily: 'monospace' }}>
                  {s.avgMove5 != null ? fmtPct(s.avgMove5) : '–'}
                </td>
                <td style={{ padding: '7px 10px', color: '#22c55e', fontFamily: 'monospace' }}>{s.goodBlock || '–'}</td>
                <td style={{ padding: '7px 10px', color: s.badBlock > 0 ? '#f97316' : '#475569', fontFamily: 'monospace' }}>{s.badBlock || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function metricColor(v) {
  if (v == null) return '#475569';
  return v >= 55 ? '#22c55e' : v >= 40 ? '#eab308' : '#94a3b8';
}

function moveColor(v) {
  if (v == null) return '#475569';
  return v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#94a3b8';
}

function FamilyTrackingTable({ title, rows, type }) {
  if (!rows || !rows.length) return null;
  const isFamily = type === 'family';

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 14, fontSize: 13 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {[
                isFamily ? 'Signaltyp' : 'Undertyp',
                'Nyckel',
                'Antal',
                'Rätt 5',
                'Rätt 10',
                'Rätt 20',
                'Avg 5',
                'Avg 10',
                'Avg 20',
                'Vanligaste status',
                'Datamängd',
                ...(isFamily ? ['Vanligaste undertyp'] : []),
              ].map(h => (
                <th key={h} style={{ color: '#64748b', fontWeight: 850, textAlign: 'left', padding: '6px 10px', fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = isFamily ? signalFamilyLabel(r.key) : signalSubtypeLabel(r.key);
              return (
                <tr key={r.key} style={{ borderBottom: '1px solid #0f172a' }}>
                  <td style={{ padding: '7px 10px', color: '#e2e8f0', fontWeight: 750, whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.key}</td>
                  <td style={{ padding: '7px 10px', color: '#e2e8f0', fontFamily: 'monospace' }}>{r.count.toLocaleString('sv-SE')}</td>
                  <td style={{ padding: '7px 10px', color: metricColor(r.dc5Pct), fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.directionalCorrect5 ?? 0} ({fmtPctRound(r.dc5Pct)})</td>
                  <td style={{ padding: '7px 10px', color: metricColor(r.dc10Pct), fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.directionalCorrect10 ?? 0} ({fmtPctRound(r.dc10Pct)})</td>
                  <td style={{ padding: '7px 10px', color: metricColor(r.dc20Pct), fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.directionalCorrect20 ?? 0} ({fmtPctRound(r.dc20Pct)})</td>
                  <td style={{ padding: '7px 10px', color: moveColor(r.avgMove5), fontFamily: 'monospace' }}>{fmtPct(r.avgMove5)}</td>
                  <td style={{ padding: '7px 10px', color: moveColor(r.avgMove10), fontFamily: 'monospace' }}>{fmtPct(r.avgMove10)}</td>
                  <td style={{ padding: '7px 10px', color: moveColor(r.avgMove20), fontFamily: 'monospace' }}>{fmtPct(r.avgMove20)}</td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{STATUS_LABEL[r.mostCommonStatus] || r.mostCommonStatus || '–'}</td>
                  <td style={{ padding: '7px 10px', color: r.hasEnoughDataForConclusion ? '#94a3b8' : '#eab308', whiteSpace: 'nowrap' }}>
                    {r.dataSufficiencySv || (r.count < 50 ? 'För lite data för säker slutsats.' : '–')}
                  </td>
                  {isFamily && (
                    <td style={{ padding: '7px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {r.mostCommonSubtype ? signalSubtypeLabel(r.mostCommonSubtype) : '–'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Recent signals table ───────────────────────────────────────────────────────

function RecentTable({ recent }) {
  const last20 = (recent || []).slice(0, 20);
  if (!last20.length) return null;

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 14, fontSize: 13 }}>Senaste 20 analyserade signaler</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {['Tid', 'Symbol', 'Status', 'Riktning', 'Rörelse 5m', 'Rörelse 10m', 'Rörelse 20m', 'Kvalitet'].map(h => (
                <th key={h} style={{ color: '#64748b', fontWeight: 850, textAlign: 'left', padding: '5px 8px', fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {last20.map((r, i) => {
              const meta = LABEL_META[r.qualityLabel] || LABEL_META['Osäker'];
              const move5Color = r.movePct5 != null ? (r.movePct5 > 0.08 ? '#22c55e' : r.movePct5 < -0.08 ? '#ef4444' : '#94a3b8') : '#475569';
              const statusColor = r.status === 'active' ? '#22c55e' : r.status === 'avoid' ? '#ef4444' : r.status === 'watch' ? '#6366f1' : '#94a3b8';
              return (
                <tr key={`${r.signalId || r.timestamp}-${i}`} style={{ borderBottom: '1px solid #0f172a' }}>
                  <td style={{ padding: '5px 8px', color: '#64748b', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtTime(r.timestamp)}</td>
                  <td style={{ padding: '5px 8px', color: '#e2e8f0', fontWeight: 700 }}>{r.symbol}</td>
                  <td style={{ padding: '5px 8px', color: statusColor, whiteSpace: 'nowrap' }}>{STATUS_LABEL[r.status] || r.status}</td>
                  <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{BIAS_ICON[r.nextMoveBias] || '?'} {r.nextMoveBias}</td>
                  <td style={{ padding: '5px 8px', color: move5Color, fontFamily: 'monospace' }}>{r.movePct5 != null ? fmtPct(r.movePct5) : '–'}</td>
                  <td style={{ padding: '5px 8px', color: '#64748b', fontFamily: 'monospace' }}>{r.movePct10 != null ? fmtPct(r.movePct10) : '–'}</td>
                  <td style={{ padding: '5px 8px', color: '#64748b', fontFamily: 'monospace' }}>{r.movePct20 != null ? fmtPct(r.movePct20) : '–'}</td>
                  <td style={{ padding: '5px 8px' }}>
                    <span style={{ color: meta.color, background: meta.bg, borderRadius: 5, padding: '2px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {meta.icon} {r.qualityLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
      <div style={{ color: '#e2e8f0', fontWeight: 800, marginBottom: 8 }}>Ingen signaldata att analysera ännu</div>
      <div style={{ color: '#64748b', fontSize: 13, lineHeight: 1.5 }}>
        Kör historisk scan eller vänta på att systemet samlar in fler signaler.
        <br />Outcomes sparas automatiskt när live-scan kör med candle-data.
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function QualityPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [days, setDays]       = useState(7);

  const load = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/history/signal-quality?days=${d}&limit=100`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'API-fel');
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const summary  = data?.summary  || {};
  const byStatus = data?.byStatus || {};
  const bySymbol = data?.bySymbol || [];
  const bySignalFamily = data?.bySignalFamily || [];
  const bySignalSubtype = data?.bySignalSubtype || [];
  const recent   = data?.recent   || [];
  const total    = summary.totalAnalyzed || 0;
  const hasData  = total > 0;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 0 40px' }}>
      {/* Header */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Signalkvalitet</div>
          <div className="hero-sub">
            Rapport över senaste signalernas riktning, blockeringar och utfall.
            Systemet mäter — inte bedömer. Inga handelsorder ges.
          </div>
        </div>
        <div className="status-bar-v2">
          {[3, 7, 14].map(d => (
            <button key={d}
              className={`btn${days === d ? ' btn-active' : ''}`}
              style={{ fontSize: 11, padding: '3px 10px', opacity: days === d ? 1 : 0.65 }}
              onClick={() => setDays(d)}
            >
              {d} dagar
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="empty"><span className="spinner" /> Analyserar signaler…</div>}
      {error && (
        <div className="market-banner" style={{ borderColor: '#ef4444', color: '#ef4444', background: 'rgba(239,68,68,0.08)' }}>
          ✗ {error}
        </div>
      )}

      {!loading && !error && !hasData && <EmptyState />}

      {!loading && !error && hasData && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Narrative */}
          <NarrativeBox lines={summary.narrativeSv} />
          <CalibrationInsightsBox />

          {/* Top stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
            <StatCard label="Analyserade" value={total.toLocaleString('sv-SE')} sub={`${data.analyzedDays} dagar`} />
            <StatCard
              label="Riktning rätt 5m"
              value={`${summary.directionalCorrectPct5 ?? 0}%`}
              sub={`${summary.directionalCorrect5} av ${summary.withDirectionalBias}`}
              color={summary.directionalCorrectPct5 >= 55 ? '#22c55e' : summary.directionalCorrectPct5 >= 40 ? '#eab308' : '#94a3b8'}
            />
            <StatCard
              label="Riktning rätt 10m"
              value={`${summary.directionalCorrectPct10 ?? 0}%`}
              sub={`${summary.directionalCorrect10} av ${summary.withDirectionalBias}`}
              color={summary.directionalCorrectPct10 >= 55 ? '#22c55e' : '#94a3b8'}
            />
            <StatCard
              label="Riktning rätt 20m"
              value={`${summary.directionalCorrectPct20 ?? 0}%`}
              sub={`${summary.directionalCorrect20} av ${summary.withDirectionalBias}`}
              color={summary.directionalCorrectPct20 >= 55 ? '#22c55e' : '#94a3b8'}
            />
            <StatCard label="Bra blockeringar" value={summary.goodBlockCount ?? 0} color="#22c55e" />
            <StatCard label="Missade möjl." value={summary.badBlockCount ?? 0} color={summary.badBlockCount > 0 ? '#f97316' : '#22c55e'} />
            <StatCard label="För sent" value={summary.lateSignalCount ?? 0} color={summary.lateSignalCount > 0 ? '#eab308' : '#475569'} />
          </div>

          {/* Snittrörelse */}
          <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ fontWeight: 700, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Genomsnittlig rörelse (alla signaler med bias)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
              {[
                ['5 min',  summary.avgMove5],
                ['10 min', summary.avgMove10],
                ['20 min', summary.avgMove20],
              ].map(([label, val]) => (
                <div key={label}>
                  <span style={{ color: '#64748b', fontSize: 11 }}>{label}: </span>
                  <span style={{ color: val > 0 ? '#22c55e' : val < 0 ? '#ef4444' : '#94a3b8', fontFamily: 'monospace', fontWeight: 700 }}>
                    {fmtPct(val)}
                  </span>
                </div>
              ))}
              {summary.bestStatus && (
                <div>
                  <span style={{ color: '#64748b', fontSize: 11 }}>Bästa status: </span>
                  <span style={{ color: '#22c55e', fontWeight: 700 }}>{STATUS_LABEL[summary.bestStatus] || summary.bestStatus}</span>
                </div>
              )}
              {summary.worstStatus && (
                <div>
                  <span style={{ color: '#64748b', fontSize: 11 }}>Sämsta status: </span>
                  <span style={{ color: '#ef4444', fontWeight: 700 }}>{STATUS_LABEL[summary.worstStatus] || summary.worstStatus}</span>
                </div>
              )}
            </div>
          </div>

          {/* Label distribution */}
          <LabelBar labelCounts={summary.labelCounts || {}} total={total} />

          {/* By status */}
          <ByStatusTable byStatus={byStatus} />

          {/* By signal family/subtype */}
          <FamilyTrackingTable title="Per signaltyp" rows={bySignalFamily} type="family" />
          <FamilyTrackingTable title="Per undertyp" rows={bySignalSubtype} type="subtype" />

          {/* By symbol */}
          <BySymbolTable bySymbol={bySymbol} />

          {/* Recent */}
          <RecentTable recent={recent} />

          {/* Disclaimer */}
          <div style={{ color: '#475569', fontSize: 11, textAlign: 'center', padding: '4px 0' }}>
            Rapporten är ett analysstöd. Systemet ger aldrig handelsorder.
            Riktning mäts mot 0.08%-tröskel. Datan är historisk och kan innehålla inaktiva marknadsperioder.
          </div>
        </div>
      )}
    </div>
  );
}
