import React, { useState, useEffect, useCallback } from 'react';

const REFRESH_MS = 60_000;

// ── Safety banner ─────────────────────────────────────────────────────────────
function SafetyBanner() {
  return (
    <div style={{
      background: '#0d3321', border: '1px solid #1a6640', borderRadius: 8,
      padding: '10px 16px', marginBottom: 20, display: 'flex',
      alignItems: 'center', gap: 10, fontSize: 13,
    }}>
      <span style={{ fontSize: 16 }}>🔒</span>
      <span style={{ color: '#4ade80', fontWeight: 600 }}>Riktig handel är avstängd</span>
      <span style={{ color: '#6b7280', marginLeft: 4 }}>· Bara analys · Inga orders kan skapas</span>
    </div>
  );
}

// ── Summary metric card ───────────────────────────────────────────────────────
function MetricCard({ value, label, sub, color }) {
  const c = color === 'green' ? '#4ade80' : color === 'red' ? '#f87171' : color === 'yellow' ? '#fbbf24' : '#93c5fd';
  return (
    <div style={{
      background: '#111827', border: '1px solid #1f2937', borderRadius: 10,
      padding: '16px 20px', flex: '1 1 140px', minWidth: 130,
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: c, lineHeight: 1.1 }}>{value ?? '–'}</div>
      <div style={{ fontSize: 13, color: '#e5e7eb', marginTop: 4, fontWeight: 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Win rate bar ──────────────────────────────────────────────────────────────
function WinBar({ wr, decisive }) {
  if (wr === null || wr === undefined) {
    return <div style={{ fontSize: 11, color: '#6b7280' }}>Ingen data ännu</div>;
  }
  const pct   = Math.max(0, Math.min(100, wr));
  const color = pct >= 58 ? '#4ade80' : pct >= 45 ? '#fbbf24' : '#f87171';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: '#9ca3af' }}>
        <span>Vinstprocent</span>
        <span style={{ color, fontWeight: 600 }}>{pct}%</span>
      </div>
      <div style={{ background: '#1f2937', borderRadius: 99, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99, transition: 'width 0.4s' }} />
      </div>
      {decisive !== undefined && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
          {decisive} avgörande trades (vinn + förlust)
        </div>
      )}
    </div>
  );
}

// ── Category badge ────────────────────────────────────────────────────────────
function CatBadge({ category, label_sv }) {
  const styles = {
    top:          { bg: '#0d3321', border: '#1a6640', text: '#4ade80' },
    poor:         { bg: '#3b1515', border: '#7f1d1d', text: '#f87171' },
    pause:        { bg: '#450a0a', border: '#991b1b', text: '#fca5a5' },
    explore:      { bg: '#1c1a0a', border: '#854d0e', text: '#fbbf24' },
    neutral:      { bg: '#1c1a0a', border: '#854d0e', text: '#fbbf24' },
    insufficient: { bg: '#111827', border: '#374151', text: '#9ca3af' },
  };
  const s = styles[category] || styles.insufficient;
  return (
    <span style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.text,
      borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 600,
      display: 'inline-block',
    }}>
      {label_sv}
    </span>
  );
}

// ── Setup card ────────────────────────────────────────────────────────────────
function SetupCard({ setup, focusSetups, poorSetups }) {
  const [open, setOpen] = useState(false);
  const isFocused = focusSetups?.includes(setup.setup_id);
  const isPoor    = poorSetups?.includes(setup.setup_id);
  const borderColor = isFocused ? '#1a6640' : isPoor ? '#7f1d1d' : {
    top: '#1a6640', poor: '#7f1d1d', pause: '#991b1b',
    explore: '#854d0e', neutral: '#374151', insufficient: '#1f2937',
  }[setup.category] || '#1f2937';

  return (
    <div style={{
      background: '#0f172a', border: `1px solid ${borderColor}`, borderRadius: 10,
      padding: 16, marginBottom: 12,
    }}>
      {/* Focus / warn badges */}
      {isFocused && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ background: '#0d3321', border: '1px solid #166534', color: '#4ade80', borderRadius: 99, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>
            🎯 Focus Mode — prioriterad setup
          </span>
        </div>
      )}
      {isPoor && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ background: '#3b1515', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 99, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>
            ⚠️ Varning: detta mönster har gått dåligt
          </span>
        </div>
      )}

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e5e7eb', marginBottom: 6, lineHeight: 1.4 }}>
            {setup.label}
          </div>
          <CatBadge category={setup.category} label_sv={setup.label_sv} />
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: setup.avg_pnl_pct >= 0 ? '#4ade80' : '#f87171' }}>
            {setup.avg_pnl_pct >= 0 ? '+' : ''}{setup.avg_pnl_pct?.toFixed(2)}%
          </div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>snitt P/L</div>
        </div>
      </div>

      <WinBar wr={setup.win_rate} decisive={setup.decisive} />

      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
        <span><span style={{ color: '#e5e7eb', fontWeight: 600 }}>{setup.total_trades}</span> trades totalt</span>
        <span><span style={{ color: '#4ade80', fontWeight: 600 }}>{setup.wins}</span> vinn</span>
        <span><span style={{ color: '#f87171', fontWeight: 600 }}>{setup.losses}</span> förlust</span>
        <span><span style={{ color: '#9ca3af', fontWeight: 600 }}>{setup.ties}</span> timeout</span>
      </div>

      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 11, cursor: 'pointer', marginTop: 10, padding: 0 }}
      >
        {open ? '▲ Dölj detaljer' : '▼ Visa detaljer'}
      </button>

      {open && (
        <div style={{ marginTop: 12, borderTop: '1px solid #1f2937', paddingTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, fontSize: 12 }}>
            <DetailRow label="Totalt P/L" value={`${setup.total_pnl_pct >= 0 ? '+' : ''}${setup.total_pnl_pct?.toFixed(2)}%`} />
            <DetailRow label="Bästa utfall" value={`+${setup.best_pnl_pct?.toFixed(2)}%`} />
            <DetailRow label="Sämsta utfall" value={`${setup.max_drawdown_pct?.toFixed(2)}%`} />
            {setup.best_symbol  && <DetailRow label="Bästa symbol" value={setup.best_symbol} />}
            {setup.worst_symbol && <DetailRow label="Sämsta symbol" value={setup.worst_symbol} />}
            {setup.common_loss_reason && <DetailRow label="Vanligaste förlust" value={setup.common_loss_reason.replace(/_/g, ' ')} />}
          </div>
          {setup.symbols?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Symboler: </span>
              {setup.symbols.map(s => (
                <span key={s} style={{ background: '#1f2937', borderRadius: 4, padding: '1px 6px', fontSize: 11, color: '#93c5fd', marginRight: 4 }}>{s}</span>
              ))}
            </div>
          )}
          {setup.last_trade_at && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#4b5563' }}>
              Senaste trade: {new Date(setup.last_trade_at).toLocaleString('sv-SE')}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 10, color: '#374151' }}>Setup ID: {setup.setup_id}</div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div>
      <div style={{ color: '#6b7280', marginBottom: 1 }}>{label}</div>
      <div style={{ color: '#e5e7eb', fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
function Section({ title, icon, sub, setups, empty, focusSetups, poorSetups }) {
  if (!setups?.length) {
    return (
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 20 }}>{icon}</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#e5e7eb' }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: '#6b7280' }}>{sub}</div>}
          </div>
        </div>
        <div style={{ color: '#4b5563', fontSize: 13, padding: '12px 0' }}>{empty}</div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#e5e7eb' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: '#6b7280' }}>{sub}</div>}
        </div>
        <span style={{ background: '#1f2937', borderRadius: 99, padding: '2px 8px', fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>
          {setups.length}
        </span>
      </div>
      {setups.map(s => (
        <SetupCard key={s.setup_id} setup={s} focusSetups={focusSetups} poorSetups={poorSetups} />
      ))}
    </div>
  );
}

// ── Focus Mode Panel ──────────────────────────────────────────────────────────
function FocusModePanel() {
  const [status, setStatus]         = useState(null);
  const [rec,    setRec]            = useState(null);
  const [busy,   setBusy]           = useState(false);
  const [msg,    setMsg]            = useState(null);

  const loadFocus = useCallback(async () => {
    try {
      const [sr, rr] = await Promise.all([
        fetch('/api/setups/focus/status').then(r => r.ok ? r.json() : null),
        fetch('/api/setups/focus/recommendation').then(r => r.ok ? r.json() : null),
      ]);
      if (sr?.ok)  setStatus(sr);
      if (rr?.ok)  setRec(rr);
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadFocus();
    const t = setInterval(loadFocus, REFRESH_MS);
    return () => clearInterval(t);
  }, [loadFocus]);

  const toggle = useCallback(async () => {
    if (busy || !status) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/setups/focus/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      const d = await res.json();
      if (d.ok) {
        setMsg(d.config.enabled ? 'Focus Mode aktiverat ✓' : 'Focus Mode avstängt ✓');
        await loadFocus();
      } else {
        setMsg('Fel: ' + d.error);
      }
    } catch (e) {
      setMsg('Fel: ' + e.message);
    } finally {
      setBusy(false);
    }
  }, [busy, status, loadFocus]);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fetch('/api/setups/performance?refresh=true');
      await loadFocus();
      setMsg('Topp 3 uppdaterat ✓');
    } catch (_) {} finally {
      setBusy(false);
    }
  }, [busy, loadFocus]);

  const isOn = status?.enabled === true;

  const dqColor = rec?.data_quality === 'high' ? '#4ade80' : rec?.data_quality === 'medium' ? '#fbbf24' : '#9ca3af';
  const dqLabel = rec?.data_quality === 'high' ? 'God datakvalitet' : rec?.data_quality === 'medium' ? 'Måttlig datakvalitet' : 'Lite data';

  return (
    <div style={{
      background: '#0f172a',
      border: `1px solid ${isOn ? '#1a6640' : '#1f2937'}`,
      borderRadius: 12, padding: 20, marginBottom: 32,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>🎯</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#f9fafb' }}>Top 3 Focus Mode</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Fokuserar testningen på de setup-mönster som hittills fungerat bäst</div>
          </div>
        </div>
        <div style={{
          background: isOn ? '#0d3321' : '#1f2937',
          border: `1px solid ${isOn ? '#166534' : '#374151'}`,
          color: isOn ? '#4ade80' : '#9ca3af',
          borderRadius: 99, padding: '4px 12px', fontSize: 12, fontWeight: 700,
        }}>
          {isOn ? '● PÅ' : '○ AV'}
        </div>
      </div>

      {/* Safety text */}
      <div style={{
        background: '#111827', border: '1px solid #374151', borderRadius: 6,
        padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#6b7280',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>🔒</span>
        <span>Gäller bara paper/replay. Focus Mode ger rekommendationer. Det pausar inte strategier automatiskt. Ingen riktig order kan läggas. actions_allowed=false · can_place_orders=false</span>
      </div>

      {/* Recommendation text */}
      {rec?.focus_recommendation && (
        <div style={{ fontSize: 13, color: '#d1d5db', marginBottom: 16, fontStyle: 'italic' }}>
          "{rec.focus_recommendation}"
        </div>
      )}

      {/* Data quality */}
      {rec?.data_quality && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 11, color: dqColor, fontWeight: 600 }}>● {dqLabel}</span>
          {rec.data_warning && <span style={{ fontSize: 11, color: '#fbbf24' }}>— {rec.data_warning}</span>}
          <span style={{ fontSize: 11, color: '#4b5563', marginLeft: 'auto' }}>
            {rec.total_trades} trades · {rec.overall_win_rate}% global WR
          </span>
        </div>
      )}

      {/* Top setups */}
      {rec?.top?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', marginBottom: 8 }}>
            Topp {rec.top.length} fokussetups
          </div>
          {rec.top.map((s, i) => (
            <div key={s.setup_id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8,
              background: '#111827', borderRadius: 8, padding: '10px 12px',
              border: '1px solid #1a6640',
            }}>
              <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 14, minWidth: 20 }}>#{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', marginBottom: 2 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{s.reason}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', flexShrink: 0 }}>{s.win_rate}%</div>
            </div>
          ))}
        </div>
      )}

      {rec?.top?.length === 0 && (
        <div style={{ background: '#111827', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: '#6b7280' }}>
          Inga setups uppfyller kraven ännu (min 5 avgörande trades · min 55% WR). Fortsätt samla paper trades.
        </div>
      )}

      {/* Poor setups warning */}
      {rec?.poor?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f87171', marginBottom: 8 }}>
            Var försiktig med dessa ({rec.poor.length} st)
          </div>
          {rec.poor.map(s => (
            <div key={s.setup_id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6,
              background: '#1a0a0a', borderRadius: 8, padding: '8px 12px',
              border: '1px solid #7f1d1d',
            }}>
              <span style={{ color: '#f87171', fontWeight: 700, fontSize: 13 }}>⚠</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fca5a5', marginBottom: 1 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.reason}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f87171', flexShrink: 0 }}>{s.win_rate}%</div>
            </div>
          ))}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <button
          onClick={toggle}
          disabled={busy}
          style={{
            background: isOn ? '#7f1d1d' : '#0d3321',
            border: `1px solid ${isOn ? '#991b1b' : '#166534'}`,
            color: isOn ? '#fca5a5' : '#4ade80',
            borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '…' : isOn ? 'Stäng av Focus Mode' : 'Aktivera Focus Mode'}
        </button>
        <button
          onClick={refresh}
          disabled={busy}
          style={{
            background: '#111827', border: '1px solid #374151', color: '#9ca3af',
            borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Uppdatera topp 3
        </button>
      </div>

      {msg && (
        <div style={{ marginTop: 10, fontSize: 12, color: msg.startsWith('Fel') ? '#f87171' : '#4ade80' }}>
          {msg}
        </div>
      )}

      {rec?.discovery_note && (
        <div style={{ marginTop: 12, fontSize: 11, color: '#374151', fontStyle: 'italic' }}>
          ℹ {rec.discovery_note}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SetupPerformancePage() {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastAt,     setLastAt]     = useState(null);
  const [focusState, setFocusState] = useState({ focus_setups: [], poor_setups: [] });

  const load = useCallback(async (force = false) => {
    try {
      const url = force ? '/api/setups/performance?refresh=true' : '/api/setups/performance';
      const [perfRes, focusRes] = await Promise.all([
        fetch(url),
        fetch('/api/setups/focus/status'),
      ]);
      if (!perfRes.ok) throw new Error(`HTTP ${perfRes.status}`);
      const d = await perfRes.json();
      if (!d.ok) throw new Error(d.error || 'Okänt fel');
      setData(d);
      setLastAt(new Date().toLocaleTimeString('sv-SE'));
      setError(null);
      if (focusRes.ok) {
        const fs = await focusRes.json();
        if (fs?.ok) setFocusState(fs);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const setups       = data?.setups || [];
  const top          = setups.filter(s => s.category === 'top');
  const poor         = setups.filter(s => s.category === 'poor');
  const pause        = setups.filter(s => s.category === 'pause');
  const explore      = setups.filter(s => s.category === 'explore' || s.category === 'neutral');
  const insufficient = setups.filter(s => s.category === 'insufficient');

  const focusSetups = focusState.focus_setups || [];
  const poorSetups  = focusState.poor_setups  || [];

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#f9fafb' }}>Setup-resultat</h1>
        <p style={{ color: '#9ca3af', marginTop: 6, fontSize: 14 }}>
          Vilka mönster fungerar i paper trading? Baserat på {data?.total_trades ?? '…'} avslutade trades.
        </p>
        {lastAt && (
          <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>
            Uppdaterad {lastAt} ·{' '}
            <button onClick={() => load(true)} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 11, padding: 0 }}>
              Ladda om nu
            </button>
          </div>
        )}
      </div>

      <SafetyBanner />

      {loading && (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: 40 }}>Laddar setup-data…</div>
      )}

      {error && !loading && (
        <div style={{
          background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 8,
          padding: 16, color: '#f87171', fontSize: 13, marginBottom: 20,
        }}>
          Kunde inte hämta data: {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 32 }}>
            <MetricCard value={data.total_trades} label="Totalt trades" sub="paper trading" color="blue" />
            <MetricCard
              value={data.overall_win_rate !== null ? `${data.overall_win_rate}%` : '–'}
              label="Vinstprocent" sub="exkl. timeouts"
              color={data.overall_win_rate >= 58 ? 'green' : data.overall_win_rate >= 45 ? 'yellow' : 'red'}
            />
            <MetricCard value={data.summary?.top_count ?? 0} label="Fungerar bra" sub="≥58% win rate" color="green" />
            <MetricCard value={data.summary?.insufficient_count ?? 0} label="Behöver mer data" sub="<3 trades" color="yellow" />
          </div>

          {/* Focus Mode Panel */}
          <FocusModePanel />

          {/* Top setups */}
          <Section icon="✅" title="Det bästa just nu" sub="Mönster med hög vinstprocent och tillräcklig data"
            setups={top} empty="Inga toppsetups ännu — fortsätt samla paper trades."
            focusSetups={focusSetups} poorSetups={poorSetups} />

          {/* Pause setups */}
          <Section icon="⛔" title="Bör pausas" sub="Låg vinstprocent — kräver analys innan fler trades"
            setups={pause} empty="Inga setups flaggade för paus."
            focusSetups={focusSetups} poorSetups={poorSetups} />

          {/* Poor setups */}
          <Section icon="⚠️" title="Förlorar mer än vinner" sub="Underpresterar — bevaka noga"
            setups={poor} empty="Inga underpresterande setups."
            focusSetups={focusSetups} poorSetups={poorSetups} />

          {/* Explore */}
          <Section icon="🔬" title="Testa mer innan beslut" sub="För lite data för säker bedömning"
            setups={explore} empty="Inga setups i utforskningsfas."
            focusSetups={focusSetups} poorSetups={poorSetups} />

          {/* Insufficient */}
          <Section icon="📭" title="För lite data ännu" sub="Färre än 3 trades — inget svar ännu"
            setups={insufficient} empty="Alla setups har tillräcklig data."
            focusSetups={focusSetups} poorSetups={poorSetups} />

          {/* Footer */}
          <div style={{
            borderTop: '1px solid #1f2937', paddingTop: 20, marginTop: 8,
            fontSize: 11, color: '#374151', display: 'flex', flexWrap: 'wrap', gap: 16,
          }}>
            <span>actions_allowed: false</span>
            <span>can_place_orders: false</span>
            <span>live_trading_enabled: false</span>
            <span>källa: setup_performance_v1 + setup_focus_mode_v1</span>
            <span>byggt: {data.built_at ? new Date(data.built_at).toLocaleTimeString('sv-SE') : '–'}</span>
          </div>
        </>
      )}
    </div>
  );
}
