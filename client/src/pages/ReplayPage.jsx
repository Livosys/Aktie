import React, { useState, useEffect, useCallback } from 'react';
import { SectionHeader, ReplayRunRating } from '../shared.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortRunId(runId) {
  if (!runId) return '–';
  return runId.slice(-10).toUpperCase();
}

function regimeSv(regime) {
  const map = {
    BULLISH_TREND:  'Stark upptrend',
    BEARISH_TREND:  'Stark nedtrend',
    CHOPPY:         'Stökig marknad',
    RANGE_DAY:      'Sidledsdag',
    TREND_DAY_UP:   'Trenddag uppåt',
    TREND_DAY_DOWN: 'Trenddag nedåt',
    HIGH_VOLATILITY:'Hög volatilitet',
    PANIC:          'Panik',
    BULLISH:        'Upptrend',
    BEARISH:        'Nedtrend',
    HIGH_RISK:      'Hög risk',
    UNKNOWN:        'Okänt',
  };
  return map[regime] ?? regime ?? '–';
}

function signalSv(signal) {
  const map = {
    LONG_TRIGGERED:      'Möjlig uppgång – triggrad',
    LONG_WATCH:          'Möjlig uppgång – bevaka',
    SHORT_TRIGGERED:     'Möjlig nedgång – triggrad',
    SHORT_WATCH:         'Möjlig nedgång – bevaka',
    WAIT:                'Vänta',
    WAIT_PULLBACK:       'Rörelsen har börjat',
    WIDE_REVERSAL_WATCH: 'Möjlig reversal',
    NO_TRADE:            'Ingen trade',
  };
  return map[signal] ?? signal ?? '–';
}

function stateSv(state) {
  const map = {
    HIGH_QUALITY_NARROW:       'Bästa narrow',
    MEDIUM_NARROW:             'Okej narrow',
    REGULAR_TREND:             'Trend',
    WIDE_AVOID:                'För långt',
    THREE_FINGER_SPREAD_AVOID: 'Jaga ej',
    BREAKOUT_ALREADY_OCCURRED: 'Redan brutet',
    NO_TRADE:                  'Ingen trade',
  };
  return map[state] ?? state ?? '–';
}

function modeSv(mode) {
  if (mode === 'scan_only')    return 'Analys';
  if (mode === 'with_outcomes') return 'Med utfall';
  if (mode === 'debug')        return 'Debug';
  return mode ?? '–';
}

function signalBadgeCls(signal) {
  if (!signal) return 'badge-gray';
  if (signal.startsWith('LONG'))         return 'badge-green';
  if (signal.startsWith('SHORT'))        return 'badge-red';
  if (signal === 'WIDE_REVERSAL_WATCH')  return 'badge-orange';
  return 'badge-yellow';
}

function scoreBadgeCls(score) {
  if (score == null) return '';
  if (score >= 60) return 'score-strong';
  if (score >= 35) return 'score-watch';
  if (score >= 15) return 'score-weak';
  return 'score-avoid';
}

function regimeBadgeCls(regime) {
  if (!regime) return 'badge-gray';
  if (regime === 'BULLISH_TREND' || regime === 'TREND_DAY_UP' || regime === 'BULLISH') return 'badge-green';
  if (regime === 'BEARISH_TREND' || regime === 'TREND_DAY_DOWN' || regime === 'PANIC' || regime === 'BEARISH') return 'badge-red';
  if (regime === 'HIGH_VOLATILITY' || regime === 'HIGH_RISK') return 'badge-purple';
  if (regime === 'CHOPPY' || regime === 'RANGE_DAY') return 'badge-yellow';
  return 'badge-gray';
}

// ── Data hooks ─────────────────────────────────────────────────────────────────

function useRuns() {
  const [runs, setRuns]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/replay/runs');
      const json = res.ok ? await res.json() : { runs: [] };
      setRuns(json.runs || []);
    } catch (e) {
      setError(e.message);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);
  return { runs, loading, error, refresh: fetchRuns };
}

function useRunDetail(runId) {
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!runId) { setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/replay/runs/${runId}`)
      .then(r => r.ok ? r.json() : { ok: false })
      .then(json => { if (!cancelled) setDetail(json.ok ? json : null); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId]);

  return { detail, loading, error };
}

function useRunEvents(runId) {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId) { setEvents([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/replay/runs/${runId}/events?limit=500`)
      .then(r => r.ok ? r.json() : { events: [] })
      .then(json => { if (!cancelled) setEvents(json.events || []); })
      .catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId]);

  return { events, loading };
}

// ── Run card ──────────────────────────────────────────────────────────────────

function RunCard({ run, selected, onSelect }) {
  const isSelected = selected === run.runId;
  const score = run.avgTradeScore;
  const scoreColor = score >= 50 ? 'var(--green)' : score >= 30 ? 'var(--yellow)' : 'var(--muted)';

  return (
    <div
      className={`rpl-run-card${isSelected ? ' rpl-run-card-active' : ''}`}
      onClick={() => onSelect(run.runId)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onSelect(run.runId)}
    >
      <div className="rpl-run-id">{shortRunId(run.runId)}</div>
      <div className="rpl-run-date">{run.start} → {run.end}</div>
      <div className="rpl-run-syms">{(run.symbols || []).join(', ')}</div>
      <div className="rpl-run-stats">
        <span className="rpl-run-stat">
          <span className="rpl-run-stat-val">{run.totalEvents ?? '–'}</span>
          <span className="rpl-run-stat-label">händelser</span>
        </span>
        <span className="rpl-run-stat">
          <span className="rpl-run-stat-val" style={{ color: scoreColor }}>{score ?? '–'}</span>
          <span className="rpl-run-stat-label">snitt betyg</span>
        </span>
      </div>
      <ReplayRunRating summary={{ totalEvents: run.totalEvents, avgTradeScore: run.avgTradeScore }} />
      <div className="rpl-run-created">{fmtDateTime(run.createdAt)}</div>
    </div>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ summary, insights }) {
  const topRegime = insights?.regimeStats
    ? Object.entries(insights.regimeStats).sort((a, b) => b[1] - a[1])[0]?.[0]
    : null;

  const bestSym   = summary.bestSymbols?.[0];
  const scoreColor = (summary.avgTradeScore ?? 0) >= 50 ? 'var(--green)' : 'var(--yellow)';

  return (
    <div className="rpl-summary-strip">
      <div className="rpl-sum-card">
        <div className="rpl-sum-icon">📋</div>
        <div className="rpl-sum-val">{summary.totalEvents ?? 0}</div>
        <div className="rpl-sum-label">Händelser</div>
      </div>
      <div className="rpl-sum-card">
        <div className="rpl-sum-icon">🕯️</div>
        <div className="rpl-sum-val">{summary.totalCandles ?? 0}</div>
        <div className="rpl-sum-label">Candles</div>
      </div>
      <div className="rpl-sum-card">
        <div className="rpl-sum-icon">📊</div>
        <div className="rpl-sum-val" style={{ color: scoreColor }}>{summary.avgTradeScore ?? '–'}</div>
        <div className="rpl-sum-label">Snitt lägesbetyg</div>
      </div>
      <div className="rpl-sum-card">
        <div className="rpl-sum-icon">🏆</div>
        <div className="rpl-sum-val" style={{ color: 'var(--yellow)', fontSize: '1.1rem' }}>
          {bestSym?.symbol ?? '–'}
        </div>
        <div className="rpl-sum-label">Bästa symbol</div>
      </div>
      <div className="rpl-sum-card">
        <div className="rpl-sum-icon">🌍</div>
        <div className="rpl-sum-val" style={{ fontSize: '0.85rem' }}>
          {topRegime ? regimeSv(topRegime) : '–'}
        </div>
        <div className="rpl-sum-label">Vanligaste marknadsläge</div>
      </div>
    </div>
  );
}

// ── Best/worst symbols ────────────────────────────────────────────────────────

function SymbolRanking({ summary }) {
  const best  = summary.bestSymbols  || [];
  const worst = summary.worstSymbols || [];
  if (best.length === 0 && worst.length === 0) return null;

  return (
    <div className="rpl-sym-ranking">
      {best.length > 0 && (
        <div className="rpl-sym-group">
          <div className="rpl-sym-group-title" style={{ color: 'var(--green)' }}>↑ Bästa symboler</div>
          {best.map((s, i) => (
            <div key={s.symbol} className="rpl-sym-row">
              <span className="rpl-sym-pos" style={{ color: i === 0 ? 'var(--yellow)' : 'var(--muted)' }}>#{i + 1}</span>
              <span className="rpl-sym-name">{s.symbol}</span>
              <span className={`score-badge ${scoreBadgeCls(s.avgScore)}`}>{s.avgScore}</span>
              <span className="rpl-sym-events">{s.events} händelser</span>
            </div>
          ))}
        </div>
      )}
      {worst.length > 0 && (
        <div className="rpl-sym-group">
          <div className="rpl-sym-group-title" style={{ color: 'var(--muted)' }}>↓ Lägsta betyg</div>
          {worst.map((s, i) => (
            <div key={s.symbol} className="rpl-sym-row">
              <span className="rpl-sym-pos" style={{ color: 'var(--muted)' }}>{i + 1}</span>
              <span className="rpl-sym-name">{s.symbol}</span>
              <span className={`score-badge ${scoreBadgeCls(s.avgScore)}`}>{s.avgScore}</span>
              <span className="rpl-sym-events">{s.events} händelser</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Insights bullets ──────────────────────────────────────────────────────────

function InsightsBullets({ insights }) {
  if (!insights?.textInsights || insights.textInsights.length === 0) return null;
  return (
    <div className="rpl-insights">
      <div className="rpl-insights-title">💡 Automatisk sammanfattning</div>
      <ul className="rpl-insights-list">
        {insights.textInsights.map((txt, i) => (
          <li key={i}>{txt}</li>
        ))}
      </ul>
    </div>
  );
}

// ── Run Conclusion ────────────────────────────────────────────────────────────

function RunConclusion({ summary, insights }) {
  if (!summary) return null;

  const lines = [];
  const avg = summary.avgTradeScore ?? 0;
  const total = summary.totalEvents ?? 0;

  // Quality verdict
  if (total < 5) {
    lines.push('För få händelser för att dra säkra slutsatser från denna körning.');
  } else if (avg >= 55) {
    lines.push(`Körningen visar generellt starka signaler (snitt betyg: ${avg}). Upplägget fungerade väl under denna period.`);
  } else if (avg >= 35) {
    lines.push(`Körningen visar blandade signaler (snitt betyg: ${avg}). Några lägen var starka, andra svagare.`);
  } else {
    lines.push(`Körningen visar generellt svaga signaler (snitt betyg: ${avg}). Marknadsläget var troligen inte optimalt.`);
  }

  // Best symbol
  const bestSym  = summary.bestSymbols?.[0];
  const worstSym = summary.worstSymbols?.[0];
  if (bestSym)  lines.push(`${bestSym.symbol} presterade bäst med snittbetyg ${bestSym.avgScore} på ${bestSym.events} händelser.`);
  if (worstSym && worstSym.symbol !== bestSym?.symbol) lines.push(`${worstSym.symbol} hade lägst betyg (${worstSym.avgScore}).`);

  // Regime
  const regimeStats = insights?.regimeStats || {};
  const topRegimes = Object.entries(regimeStats).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (topRegimes.length > 0) {
    const rmap = { BULLISH_TREND: 'stark upptrend', BEARISH_TREND: 'stark nedtrend', CHOPPY: 'stökig marknad', RANGE_DAY: 'sidledsdag', TREND_DAY_UP: 'trenddag uppåt', TREND_DAY_DOWN: 'trenddag nedåt', HIGH_VOLATILITY: 'hög volatilitet', PANIC: 'panik', BULLISH: 'upptrend', BEARISH: 'nedtrend', UNKNOWN: 'okänt läge' };
    const regStr = topRegimes.map(([k, v]) => `${rmap[k] || k} (${v} händelser)`).join(' och ');
    lines.push(`Vanligaste marknadsläget under körningen var ${regStr}.`);
  }

  return (
    <div style={{ background: '#0d1829', border: '1px solid #1e3a5f', borderRadius: 10, padding: '16px 20px', margin: '16px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', marginBottom: 10, letterSpacing: '0.06em' }}>📝 AUTOMATISK SLUTSATS</div>
      {lines.map((l, i) => (
        <p key={i} style={{ fontSize: 13, color: '#94a3b8', margin: i > 0 ? '6px 0 0' : 0, lineHeight: 1.5 }}>{l}</p>
      ))}
    </div>
  );
}

// ── Event filters ─────────────────────────────────────────────────────────────

function EventFilters({ filters, onChange, availableSymbols, availableRegimes }) {
  function set(key, val) { onChange({ ...filters, [key]: val }); }

  return (
    <div className="hist-filters">
      <div className="hist-filter-group">
        <label className="hist-filter-label">Symbol</label>
        <select className="hist-select" value={filters.symbol} onChange={e => set('symbol', e.target.value)}>
          <option value="">Alla</option>
          {availableSymbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Signaltyp</label>
        <select className="hist-select" value={filters.signalType} onChange={e => set('signalType', e.target.value)}>
          <option value="">Alla</option>
          <option value="LONG">Möjlig uppgång</option>
          <option value="SHORT">Möjlig nedgång</option>
          <option value="WAIT">Vänta</option>
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Läge</label>
        <select className="hist-select" value={filters.state} onChange={e => set('state', e.target.value)}>
          <option value="">Alla</option>
          <option value="HIGH_QUALITY_NARROW">Bästa narrow</option>
          <option value="MEDIUM_NARROW">Okej narrow</option>
          <option value="REGULAR_TREND">Trend</option>
          <option value="BREAKOUT_ALREADY_OCCURRED">Redan brutet</option>
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Marknadsläge</label>
        <select className="hist-select" value={filters.regime} onChange={e => set('regime', e.target.value)}>
          <option value="">Alla</option>
          {availableRegimes.map(r => <option key={r} value={r}>{regimeSv(r)}</option>)}
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Min lägesbetyg</label>
        <select className="hist-select" value={filters.minScore} onChange={e => set('minScore', Number(e.target.value))}>
          <option value={0}>Alla</option>
          <option value={30}>30+</option>
          <option value={50}>50+</option>
          <option value={70}>70+</option>
        </select>
      </div>
    </div>
  );
}

// ── Flag chip ─────────────────────────────────────────────────────────────────

function FlagChip({ active, label, color }) {
  if (!active) return null;
  return (
    <span className="rpl-flag-chip" style={{ borderColor: color || 'var(--border2)', color: color || 'var(--muted)' }}>
      {label}
    </span>
  );
}

// ── Event card ────────────────────────────────────────────────────────────────

function EventCard({ event }) {
  const [open, setOpen] = useState(false);
  const flags  = event.flags || {};
  const regime = event.marketContext?.regime;
  const isLong  = event.signal?.startsWith('LONG');
  const isShort = event.signal?.startsWith('SHORT');
  const accentColor = isLong ? 'var(--green)' : isShort ? 'var(--red)' : 'var(--border2)';
  const hasDetails = event.scoreExplanationSv && event.scoreExplanationSv.length > 0;
  const hasFlags = flags.threeFingerSpread || flags.breakoutAlreadyOccurred || flags.elephantBar || flags.colorChange || flags.pullback;

  return (
    <div className="rpl-event-card">
      <div className="rpl-event-accent" style={{ background: accentColor }} />

      <div className="rpl-event-top">
        <div className="rpl-event-left">
          <div className="rpl-event-sym">{event.symbol}</div>
          <div className="rpl-event-time">{fmtTime(event.timestamp)}</div>
        </div>
        <div className="rpl-event-right">
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14 }}>
            {event.price != null ? `$${Number(event.price).toFixed(2)}` : '–'}
          </span>
        </div>
      </div>

      <div className="rpl-event-badges">
        <span className={`badge ${signalBadgeCls(event.signal)}`}>{signalSv(event.signal)}</span>
        <span className="badge badge-gray">{stateSv(event.state)}</span>
        {regime && regime !== 'UNKNOWN' && (
          <span className={`badge ${regimeBadgeCls(regime)}`}>{regimeSv(regime)}</span>
        )}
      </div>

      <div className="rpl-event-scores">
        <div className="rpl-score-item">
          <span className="rpl-score-label">Lägesbetyg</span>
          <span className={`score-badge ${scoreBadgeCls(event.tradeScore)}`}>{event.tradeScore ?? '–'}</span>
        </div>
        {event.narrowScore != null && (
          <div className="rpl-score-item">
            <span className="rpl-score-label">Basbetyg</span>
            <span className={`score-badge ${scoreBadgeCls(event.narrowScore)}`}>{event.narrowScore}</span>
          </div>
        )}
        {event.narrowType && event.narrowType !== 'none' && (
          <div className="rpl-score-item">
            <span className="rpl-score-label">Typ</span>
            <span className="badge badge-yellow" style={{ fontSize: 10 }}>
              {event.narrowType === 'coil_flat' ? 'Coil' : 'A200'}
            </span>
          </div>
        )}
      </div>

      {event.actionSv && (
        <div className="rpl-event-action">"{event.actionSv}"</div>
      )}

      {hasFlags && (
        <div className="rpl-flags">
          <FlagChip active={flags.threeFingerSpread}       label="3FS"          color="var(--purple)" />
          <FlagChip active={flags.breakoutAlreadyOccurred} label="Redan brutet" color="var(--orange)" />
          <FlagChip active={flags.elephantBar}             label="Stor candle"  color="var(--blue)" />
          <FlagChip active={flags.colorChange}             label="Färgbyte"     color="var(--yellow)" />
          <FlagChip active={flags.pullback}                label="Pullback"     color="var(--green)" />
        </div>
      )}

      {hasDetails && (
        <button className="rpl-detail-toggle" onClick={() => setOpen(o => !o)}>
          {open ? 'Dölj detaljer ▲' : 'Visa detaljer ▼'}
        </button>
      )}

      {open && (
        <div className="rpl-detail">
          <div className="rpl-detail-title">Varför säger systemet så?</div>
          <ul className="rpl-detail-list">
            {event.scoreExplanationSv.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Event timeline ─────────────────────────────────────────────────────────────

function EventTimeline({ events, filters }) {
  const filtered = events.filter(e => {
    if (filters.symbol && e.symbol !== filters.symbol)                                           return false;
    if (filters.signalType === 'LONG'  && !e.signal?.startsWith('LONG'))                        return false;
    if (filters.signalType === 'SHORT' && !e.signal?.startsWith('SHORT'))                       return false;
    if (filters.signalType === 'WAIT'  && (e.signal?.startsWith('LONG') || e.signal?.startsWith('SHORT'))) return false;
    if (filters.state  && e.state !== filters.state)                                             return false;
    if (filters.regime && e.marketContext?.regime !== filters.regime)                            return false;
    if (filters.minScore > 0 && (e.tradeScore ?? 0) < filters.minScore)                         return false;
    return true;
  });

  if (filtered.length === 0) {
    return <div className="hist-empty-filter">Inga händelser matchar de valda filtren.</div>;
  }

  return (
    <div className="rpl-timeline">
      {filtered.map((event, i) => (
        <EventCard key={`${event.symbol}_${event.timestamp}_${i}`} event={event} />
      ))}
    </div>
  );
}

// ── Run form ──────────────────────────────────────────────────────────────────

function isoDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function RunForm({ onSuccess }) {
  const [symbols,    setSymbols]    = useState('NVDA,QQQ');
  const [start,      setStart]      = useState(() => isoDate(14));
  const [end,        setEnd]        = useState(() => isoDate(1));
  const [mode,       setMode]       = useState('scan_only');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);
  const [lastRunId,  setLastRunId]  = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLastRunId(null);

    const syms = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (syms.length === 0)    { setError('Ange minst en symbol, t.ex. NVDA eller BTCUSDT.'); return; }
    if (!start || !end)       { setError('Ange start- och slutdatum.'); return; }
    if (start >= end)         { setError('Startdatum måste vara före slutdatum.'); return; }
    if (end > isoDate(0))     { setError('Slutdatum kan inte vara i framtiden.'); return; }

    setSubmitting(true);
    try {
      const res  = await fetch('/api/replay/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbols: syms, start, end, mode }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt serverfel');
      setLastRunId(json.runId);
      onSuccess(json.runId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rpl-form">
      <div className="rpl-form-header">
        <div className="rpl-form-title">▶ Starta ny uppspelning</div>
        <div className="rpl-form-desc">
          Uppspelningen kör motorn på gammal data, candle för candle, och sparar alla intressanta händelser.
          Kräver backfillad data — se <strong>POST /api/data/backfill</strong> för aktier eller Binance-integrationen för krypto.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="rpl-form-body">
        <div className="rpl-form-grid">
          <div className="rpl-form-group rpl-form-group-wide">
            <label className="rpl-form-label">Symboler <span className="rpl-form-hint">(kommaseparerade)</span></label>
            <input
              className="rpl-form-input"
              type="text"
              value={symbols}
              onChange={e => setSymbols(e.target.value)}
              placeholder="NVDA,QQQ,TSLA eller BTCUSDT,ETHUSDT"
              disabled={submitting}
            />
          </div>

          <div className="rpl-form-group">
            <label className="rpl-form-label">Startdatum</label>
            <input
              className="rpl-form-input"
              type="date"
              value={start}
              max={isoDate(1)}
              onChange={e => setStart(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="rpl-form-group">
            <label className="rpl-form-label">Slutdatum</label>
            <input
              className="rpl-form-input"
              type="date"
              value={end}
              max={isoDate(0)}
              onChange={e => setEnd(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="rpl-form-group">
            <label className="rpl-form-label">Läge</label>
            <select
              className="rpl-form-input"
              value={mode}
              onChange={e => setMode(e.target.value)}
              disabled={submitting}
            >
              <option value="scan_only">Analys (scan_only)</option>
              <option value="with_outcomes">Med utfall (with_outcomes)</option>
              <option value="debug">Debug</option>
            </select>
          </div>
        </div>

        <div className="rpl-form-actions">
          <button
            className={`rpl-btn-submit${submitting ? ' rpl-btn-submitting' : ''}`}
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Kör uppspelning…</>
              : '▶ Starta uppspelning'}
          </button>

          {lastRunId && !error && (
            <span className="rpl-form-success">
              ✓ Klar — körning {lastRunId.slice(-8).toUpperCase()} vald
            </span>
          )}
        </div>

        {error && (
          <div className="rpl-form-error">
            ✗ {error}
          </div>
        )}
      </form>
    </div>
  );
}

// ── No-candles warning ────────────────────────────────────────────────────────

function NoCandlesWarn({ symbols }) {
  const symList = (symbols || []).join(', ');
  return (
    <div className="rpl-no-candles">
      <div className="rpl-no-candles-icon">⚠️</div>
      <div className="rpl-no-candles-body">
        <strong>Det saknas historiska candles för {symList || 'dessa symboler'}.</strong>
        {' '}Öppna panelen <em>Hämta historisk data</em> ovan och kör backfill för rätt symboler och datumintervall.
        Aktier hämtas via Alpaca, krypto via Binance.
      </div>
    </div>
  );
}

// ── Empty state (no runs at all) ──────────────────────────────────────────────

function NoRunsYet() {
  return (
    <div className="rpl-no-runs">
      <div className="rpl-no-runs-icon">📂</div>
      <div className="rpl-no-runs-text">Inga körningar ännu — fyll i formuläret ovan och klicka <strong>Starta uppspelning</strong>.</div>
    </div>
  );
}

// ── Backfill panel ────────────────────────────────────────────────────────────

function parseSyms(str) {
  return str.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

function useDataStatus() {
  const [status,  setStatus]  = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('/api/data/status');
      const json = res.ok ? await res.json() : null;
      setStatus(json);
    } catch (_) { setStatus(null); }
    finally { setLoading(false); }
  }, []);

  return { status, loading, refresh: load };
}

function DataStatusTable({ data }) {
  const rows = Object.entries(data);
  if (rows.length === 0) return null;
  return (
    <div className="bfp-status-table">
      <div className="bfp-status-header">
        <span>Symbol</span>
        <span>Datumintervall</span>
        <span>2m-candles</span>
        <span>Råa dagar</span>
      </div>
      {rows.map(([sym, d]) => (
        <div key={sym} className="bfp-status-row">
          <span className="bfp-status-sym">{sym}</span>
          <span className="bfp-status-range">
            {d.dateRange ? `${d.dateRange.from} → ${d.dateRange.to}` : '–'}
          </span>
          <span className="bfp-status-candles" style={{ color: d.totalCandles2m > 0 ? 'var(--green)' : 'var(--muted)' }}>
            {d.totalCandles2m}
          </span>
          <span className="bfp-status-raw">{d.datesRaw} dagar</span>
        </div>
      ))}
    </div>
  );
}

function SourceBadge({ source }) {
  if (!source) return null;
  const isBinance = source === 'binance';
  return (
    <span
      className="bfp-source-badge"
      style={isBinance
        ? { borderColor: 'var(--yellow-border)', background: 'var(--yellow-dim)', color: 'var(--yellow)' }
        : undefined
      }
    >
      {isBinance ? 'Binance' : 'Alpaca'}
    </span>
  );
}

function BackfillResult({ result }) {
  const entries   = Object.entries(result.result || {});
  const succeeded = entries.filter(([, v]) => !v.error && !v.warning);
  const warned    = entries.filter(([, v]) =>  v.warning && !v.error);
  const failed    = entries.filter(([, v]) =>  v.error);

  return (
    <div className="bfp-result">
      <div className="bfp-result-title">Resultat — {result.start} → {result.end}</div>
      <div className="bfp-result-rows">
        {succeeded.map(([sym, v]) => (
          <div key={sym} className="bfp-result-row bfp-row-ok">
            <span className="bfp-row-sym">{sym}</span>
            <SourceBadge source={v.source} />
            <span className="bfp-row-icon">✓</span>
            <span>{v.rawBars} bars hämtade · {v.candles2m} 2m-candles skapade</span>
          </div>
        ))}
        {warned.map(([sym, v]) => (
          <div key={sym} className="bfp-result-row bfp-row-warn">
            <span className="bfp-row-sym">{sym}</span>
            <SourceBadge source={v.source} />
            <span className="bfp-row-icon">⚠</span>
            <span>{v.warning}</span>
          </div>
        ))}
        {failed.map(([sym, v]) => (
          <div key={sym} className="bfp-result-row bfp-row-fail">
            <span className="bfp-row-sym">{sym}</span>
            <SourceBadge source={v.source} />
            <span className="bfp-row-icon">✗</span>
            <span>{v.error}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BackfillPanel() {
  const [open,       setOpen]       = useState(false);
  const [symbols,    setSymbols]    = useState('NVDA,QQQ,AAPL');
  const [start,      setStart]      = useState(() => isoDate(30));
  const [end,        setEnd]        = useState(() => isoDate(1));
  const [submitting, setSubmitting] = useState(false);
  const [result,     setResult]     = useState(null);
  const [error,      setError]      = useState(null);

  const { status, loading: statusLoading, refresh: refreshStatus } = useDataStatus();

  useEffect(() => { if (open) refreshStatus(); }, [open, refreshStatus]);

  const syms = parseSyms(symbols);

  async function handleBackfill(e) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (syms.length === 0)  { setError('Ange minst en symbol, t.ex. NVDA eller BTCUSDT.'); return; }
    if (!start || !end)     { setError('Ange start- och slutdatum.'); return; }
    if (start >= end)       { setError('Startdatum måste vara före slutdatum.'); return; }
    if (end > isoDate(0))   { setError('Slutdatum kan inte vara i framtiden.'); return; }

    setSubmitting(true);
    try {
      const res  = await fetch('/api/data/backfill', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbols: syms, start, end }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt serverfel');
      setResult(json);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const storedCount = Object.keys(status?.data || {}).length;

  return (
    <div className="bfp-wrap">
      <button className="bfp-toggle" onClick={() => setOpen(o => !o)}>
        <span className="bfp-toggle-left">
          <span>📥</span>
          <span>Hämta historisk data</span>
          {storedCount > 0 && (
            <span className="bfp-toggle-pill">{storedCount} {storedCount === 1 ? 'symbol' : 'symboler'} lagrade</span>
          )}
        </span>
        <span className="bfp-toggle-arrow">{open ? '▲ Dölj' : '▼ Visa'}</span>
      </button>

      {open && (
        <div className="bfp-body">
          <p className="bfp-desc">
            Hämtar 1-minutersdata och bygger 2-minuterscandles som sparas lokalt.
            Aktier hämtas via <strong>Alpaca</strong>. Krypto (BTCUSDT, ETHUSDT, SOLUSDT) hämtas via <strong>Binance</strong>.
            Candles behövs för att köra replay och historisk signalanalys.
          </p>

          <form onSubmit={handleBackfill} className="bfp-form">
            <div className="bfp-form-grid">
              <div className="bfp-field bfp-field-wide">
                <label className="bfp-label">Symboler <span className="bfp-hint">(kommaseparerade)</span></label>
                <input
                  className="rpl-form-input"
                  type="text"
                  value={symbols}
                  onChange={e => setSymbols(e.target.value)}
                  placeholder="NVDA,AAPL,QQQ eller BTCUSDT,ETHUSDT"
                  disabled={submitting}
                />
              </div>
              <div className="bfp-field">
                <label className="bfp-label">Startdatum</label>
                <input
                  className="rpl-form-input"
                  type="date"
                  value={start}
                  max={isoDate(1)}
                  onChange={e => setStart(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="bfp-field">
                <label className="bfp-label">Slutdatum</label>
                <input
                  className="rpl-form-input"
                  type="date"
                  value={end}
                  max={isoDate(0)}
                  onChange={e => setEnd(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="bfp-actions">
              <button
                className={`rpl-btn-submit${submitting ? ' rpl-btn-submitting' : ''}`}
                type="submit"
                disabled={submitting}
                style={{ background: 'var(--blue)' }}
              >
                {submitting
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Hämtar…</>
                  : '📥 Hämta data'}
              </button>
              <span className="bfp-meta">1Min → aggregeras till 2Min · Aktier: Alpaca · Krypto: Binance</span>
            </div>

            {error && <div className="rpl-form-error">✗ {error}</div>}
          </form>

          {result && (
            <BackfillResult result={result} />
          )}

          <div className="bfp-status-section">
            <div className="bfp-status-title">
              Lagrad data
              <button className="bfp-refresh-btn" onClick={refreshStatus} disabled={statusLoading} title="Uppdatera">
                {statusLoading ? '…' : '↻'}
              </button>
            </div>
            {statusLoading ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>
                <span className="spinner" /> Laddar…
              </div>
            ) : storedCount > 0 ? (
              <DataStatusTable data={status.data} />
            ) : (
              <div className="bfp-no-data">
                Ingen data lagrad ännu. Hämta data ovan för att komma igång.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReplayPage() {
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [filters, setFilters] = useState({ symbol: '', signalType: '', state: '', regime: '', minScore: 0 });

  const { runs, loading: runsLoading, error: runsError, refresh } = useRuns();
  const { detail, loading: detailLoading }                        = useRunDetail(selectedRunId);
  const { events, loading: eventsLoading }                        = useRunEvents(selectedRunId);

  // Auto-select latest run on first load
  useEffect(() => {
    if (runs.length > 0 && !selectedRunId) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  // Reset filters when switching run
  useEffect(() => {
    setFilters({ symbol: '', signalType: '', state: '', regime: '', minScore: 0 });
  }, [selectedRunId]);

  // Called by RunForm on success — refresh list, select new run
  async function handleFormSuccess(newRunId) {
    await refresh();
    setSelectedRunId(newRunId);
  }

  const summary  = detail?.summary  || null;
  const insights = detail?.insights || null;
  const noCandles = summary && summary.totalCandles === 0;

  const availableSymbols = [...new Set(events.map(e => e.symbol).filter(Boolean))].sort();
  const availableRegimes = [...new Set(
    events.map(e => e.marketContext?.regime).filter(r => r && r !== 'UNKNOWN')
  )].sort();

  return (
    <div>
      {/* Hero */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">
            <span className="hero-accent-green">Replay</span>
            {' '}&amp; signalanalys
          </div>
          <div className="hero-sub">
            Spela upp gamla marknadsdagar och se vad motorn såg vid varje candle.
          </div>
        </div>
        <div className="status-bar-v2">
          <span className="status-pill" style={{ color: 'var(--green)' }}>▶️ Uppspelning</span>
          <span className="status-pill">{runs.length} körningar</span>
          <button className="btn" onClick={refresh} style={{ fontSize: 11, padding: '3px 10px' }}>↻ Uppdatera</button>
        </div>
      </div>

      {runsError && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Fel: {runsError}
        </div>
      )}

      {/* Backfill panel — always visible, collapsible */}
      <BackfillPanel />

      {/* New-run form — always visible */}
      <RunForm onSuccess={handleFormSuccess} />

      {runsLoading && <div className="empty"><span className="spinner" /> Hämtar körningar…</div>}

      {!runsLoading && runs.length === 0 && <NoRunsYet />}

      {!runsLoading && runs.length > 0 && (
        <>
          {/* Run selector */}
          <div className="sec">
            <SectionHeader
              icon="📂"
              title="Körningar"
              count={runs.length}
              desc="Klicka på en körning för att se detaljer och händelseflöde."
            />
            <div className="rpl-runs-list">
              {runs.map(run => (
                <RunCard
                  key={run.runId}
                  run={run}
                  selected={selectedRunId}
                  onSelect={setSelectedRunId}
                />
              ))}
            </div>
          </div>

          {/* No run selected */}
          {!selectedRunId && (
            <div className="empty" style={{ padding: '40px 0' }}>
              Välj en körning ovan för att se detaljer och händelser.
            </div>
          )}

          {/* Run detail loading */}
          {selectedRunId && detailLoading && (
            <div className="empty"><span className="spinner" /> Laddar körning…</div>
          )}

          {selectedRunId && !detailLoading && summary && (
            <>
              {/* No-candles warning */}
              {noCandles && <NoCandlesWarn symbols={summary.symbols} />}

              {/* Overview */}
              <div className="sec">
                <SectionHeader
                  icon="📊"
                  title="Körningsöversikt"
                  desc={`${summary.start} → ${summary.end} · ${(summary.symbols || []).join(', ')} · Läge: ${modeSv(summary.mode)}`}
                />
                <SummaryCards summary={summary} insights={insights} />

                {(summary.bestSymbols?.length > 0 || summary.worstSymbols?.length > 0) && (
                  <SymbolRanking summary={summary} />
                )}

                {insights && <InsightsBullets insights={insights} />}
                <RunConclusion summary={detail?.summary} insights={detail?.insights} />
              </div>

              {/* Event timeline — only when there are candles */}
              {!noCandles && (
                <div className="sec">
                  <SectionHeader
                    icon="📋"
                    title="Händelseflöde"
                    count={events.length}
                    desc="Alla intressanta händelser i tidsordning. Filtrera för att hitta specifika lägen."
                  />

                  {eventsLoading ? (
                    <div className="empty"><span className="spinner" /> Laddar händelser…</div>
                  ) : events.length === 0 ? (
                    <div className="hist-empty-filter">
                      Inga händelser sparades för den här körningen.
                    </div>
                  ) : (
                    <>
                      <EventFilters
                        filters={filters}
                        onChange={setFilters}
                        availableSymbols={availableSymbols}
                        availableRegimes={availableRegimes}
                      />
                      <EventTimeline events={events} filters={filters} />
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
