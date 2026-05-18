import React, { useState, useEffect, useCallback } from 'react';
import { SectionHeader } from '../shared.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtPct(v) {
  if (v === null || v === undefined) return '–';
  const n = Number(v);
  const color = n >= 0 ? 'var(--green)' : 'var(--red)';
  return <span style={{ color, fontFamily: 'var(--mono)', fontWeight: 700 }}>{n >= 0 ? '+' : ''}{n.toFixed(2)}%</span>;
}

function signalToSv(signal) {
  const map = {
    LONG_WATCH:      'Möjlig uppgång – bevaka',
    LONG_TRIGGERED:  'Möjlig uppgång – triggrad',
    SHORT_WATCH:     'Möjlig nedgång – bevaka',
    SHORT_TRIGGERED: 'Möjlig nedgång – triggrad',
    WAIT:            'Vänta',
    WAIT_PULLBACK:   'Vänta på pullback',
    WIDE_REVERSAL_WATCH: 'Möjlig reversal',
  };
  return map[signal] ?? signal ?? '–';
}

function signalBadgeCls(signal) {
  if (signal?.startsWith('LONG'))  return 'badge-green';
  if (signal?.startsWith('SHORT')) return 'badge-red';
  return 'badge-yellow';
}

function scoreBadgeCls(score) {
  if (score >= 70) return 'score-strong';
  if (score >= 40) return 'score-watch';
  return 'score-weak';
}

function dateLabel(days) {
  if (days === 1) return 'Senaste dagen';
  if (days === 3) return '3 dagar';
  if (days === 7) return '7 dagar';
  return 'Alla';
}

function subtractDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const ALL_SYMBOLS = ['AAPL', 'NVDA', 'TSLA', 'AMD', 'MSFT', 'AMZN', 'META', 'QQQ', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ── Data fetching ─────────────────────────────────────────────────────────────

function useHistoryData(filters) {
  const [signals,  setSignals]  = useState([]);
  const [outcomes, setOutcomes] = useState({});
  const [learning, setLearning] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const { symbol, days } = filters;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const start = days === 0 ? '2020-01-01' : subtractDays(days);
      const end   = new Date().toISOString().slice(0, 10);
      const qs    = `start=${start}&end=${end}&limit=500${symbol ? `&symbol=${symbol}` : ''}`;

      const [sigRes, outRes, lrnRes] = await Promise.all([
        fetch(`/api/history/signals?${qs}`),
        fetch(`/api/history/outcomes?${qs}`),
        fetch('/api/history/learning-summary'),
      ]);

      const [sigJson, outJson, lrnJson] = await Promise.all([
        sigRes.ok ? sigRes.json() : { signals: [] },
        outRes.ok ? outRes.json() : { outcomes: [] },
        lrnRes.ok ? lrnRes.json() : { summary: null },
      ]);

      setSignals(sigJson.signals || []);

      const outcomeMap = {};
      for (const o of (outJson.outcomes || [])) {
        outcomeMap[o.signalId] = o;
      }
      setOutcomes(outcomeMap);
      setLearning(lrnJson.summary || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  return { signals, outcomes, learning, loading, error, refresh: fetchAll };
}

// ── Stats strip ───────────────────────────────────────────────────────────────

function StatsStrip({ signals, outcomes }) {
  const total = signals.length;
  const withOutcome = signals.filter(s => outcomes[s.signalId]);
  const successful  = withOutcome.filter(s => outcomes[s.signalId]?.success === true);
  const winRate     = withOutcome.length > 0
    ? Math.round((successful.length / withOutcome.length) * 100)
    : null;

  const bySymbol = {};
  for (const s of successful) {
    bySymbol[s.symbol] = (bySymbol[s.symbol] || 0) + 1;
  }
  const bestSymbol = Object.entries(bySymbol).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const lastTs = signals.length > 0
    ? signals[signals.length - 1].timestamp
    : null;

  return (
    <div className="hist-stats-strip">
      <div className="hist-stat">
        <div className="hist-stat-val">{total}</div>
        <div className="hist-stat-label">Sparade signaler</div>
      </div>
      <div className="hist-stat">
        <div className="hist-stat-val" style={{ color: 'var(--green)' }}>{successful.length}</div>
        <div className="hist-stat-label">Lyckade signaler</div>
      </div>
      <div className="hist-stat">
        <div className="hist-stat-val" style={{ color: winRate !== null && winRate >= 50 ? 'var(--green)' : 'var(--red)' }}>
          {winRate !== null ? `${winRate}%` : '–'}
        </div>
        <div className="hist-stat-label">Träffsäkerhet</div>
      </div>
      <div className="hist-stat">
        <div className="hist-stat-val" style={{ color: 'var(--yellow)' }}>{bestSymbol ?? '–'}</div>
        <div className="hist-stat-label">Bästa symbol</div>
      </div>
      <div className="hist-stat">
        <div className="hist-stat-val" style={{ fontSize: 12 }}>{lastTs ? fmtDateTime(lastTs) : '–'}</div>
        <div className="hist-stat-label">Senast uppdaterad</div>
      </div>
    </div>
  );
}

// ── Filters ───────────────────────────────────────────────────────────────────

function Filters({ filters, onChange }) {
  const { symbol, signalType, result, days } = filters;

  function set(key, val) {
    onChange({ ...filters, [key]: val });
  }

  return (
    <div className="hist-filters">
      <div className="hist-filter-group">
        <label className="hist-filter-label">Symbol</label>
        <select className="hist-select" value={symbol} onChange={e => set('symbol', e.target.value)}>
          <option value="">Alla</option>
          {ALL_SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Signaltyp</label>
        <select className="hist-select" value={signalType} onChange={e => set('signalType', e.target.value)}>
          <option value="">Alla</option>
          <option value="LONG">Möjlig uppgång</option>
          <option value="SHORT">Möjlig nedgång</option>
          <option value="WAIT">Vänta</option>
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Resultat</label>
        <select className="hist-select" value={result} onChange={e => set('result', e.target.value)}>
          <option value="">Alla</option>
          <option value="success">Lyckad</option>
          <option value="fail">Misslyckad</option>
          <option value="none">Ej analyserad</option>
        </select>
      </div>
      <div className="hist-filter-group">
        <label className="hist-filter-label">Datum</label>
        <select className="hist-select" value={days} onChange={e => set('days', Number(e.target.value))}>
          <option value={1}>Senaste dagen</option>
          <option value={3}>3 dagar</option>
          <option value={7}>7 dagar</option>
          <option value={0}>Alla</option>
        </select>
      </div>
    </div>
  );
}

// ── Outcome section ───────────────────────────────────────────────────────────

function OutcomeRow({ label, data, isLong }) {
  if (!data) return null;
  const pct = data.priceChangePct;
  const win  = isLong ? pct >= 0 : pct <= 0;
  return (
    <div className="hist-outcome-row">
      <span className="hist-outcome-label">{label}:</span>
      <span style={{ color: win ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)', fontWeight: 700 }}>
        {pct >= 0 ? '+' : ''}{pct?.toFixed(2)}%
      </span>
      <span className="hist-outcome-sub">
        max upp: <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>+{data.maxMoveUp?.toFixed(2)}%</span>
        {' '}max ned: <span style={{ color: 'var(--red)', fontFamily: 'var(--mono)' }}>{data.maxMoveDown?.toFixed(2)}%</span>
      </span>
    </div>
  );
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({ signal, outcome }) {
  const isLong  = signal.signal?.startsWith('LONG');
  const isShort = signal.signal?.startsWith('SHORT');
  const hasOutcome = !!outcome;
  const won = hasOutcome && outcome.success === true;
  const lost = hasOutcome && outcome.success === false;

  let resultBadge = null;
  if (won)  resultBadge = <span className="badge badge-green">Lyckad</span>;
  if (lost) resultBadge = <span className="badge badge-red">Misslyckad</span>;
  if (!hasOutcome) resultBadge = <span className="badge badge-gray">Ej analyserad</span>;

  const borderColor = won ? 'var(--green-border)' : lost ? 'var(--red-border)' : 'var(--border)';
  const accentColor = won ? 'var(--green)' : lost ? 'var(--red)' : isLong ? 'var(--green)' : isShort ? 'var(--red)' : 'var(--muted)';

  return (
    <div className="hist-signal-card" style={{ borderColor }}>
      <div className="hist-card-accent" style={{ background: accentColor }} />
      <div className="hist-card-header">
        <div className="hist-card-sym">{signal.symbol}</div>
        <div className="hist-card-time">{fmtDateTime(signal.timestamp)}</div>
      </div>
      <div className="hist-card-badges">
        <span className={`badge ${signalBadgeCls(signal.signal)}`}>{signalToSv(signal.signal)}</span>
        {resultBadge}
      </div>
      <div className="hist-card-scores">
        <div className="hist-score-item">
          <span className="hist-score-label">Tradebetyg</span>
          <span className={`score-badge ${scoreBadgeCls(signal.tradeScore)}`}>{signal.tradeScore ?? '–'}</span>
        </div>
        <div className="hist-score-item">
          <span className="hist-score-label">Narrowbetyg</span>
          <span className={`score-badge ${scoreBadgeCls(signal.narrowScore)}`}>{signal.narrowScore ?? '–'}</span>
        </div>
        <div className="hist-score-item">
          <span className="hist-score-label">Pris vid signal</span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
            {signal.price ? `$${Number(signal.price).toFixed(2)}` : '–'}
          </span>
        </div>
      </div>
      {signal.actionSv && (
        <div className="hist-card-forklaring">"{signal.actionSv}"</div>
      )}
      {hasOutcome && (
        <div className="hist-outcomes">
          <div className="hist-outcome-title">Vad hände efteråt?</div>
          <OutcomeRow label="Efter 3 candles"  data={outcome.outcome3}  isLong={isLong} />
          <OutcomeRow label="Efter 5 candles"  data={outcome.outcome5}  isLong={isLong} />
          <OutcomeRow label="Efter 10 candles" data={outcome.outcome10} isLong={isLong} />
          <OutcomeRow label="Efter 20 candles" data={outcome.outcome20} isLong={isLong} />
          {outcome.failureReason && (
            <div className="hist-failure-reason">
              Varför det gick fel: <strong>{outcome.failureReason === 'stopped_out' ? 'Stoppades ut' : outcome.failureReason}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Learning summary ──────────────────────────────────────────────────────────

function ProgressBar({ value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: 'var(--border2)', borderRadius: 3, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, background: color || 'var(--blue)', height: '100%', borderRadius: 3, transition: 'width 0.5s' }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 36, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

function WinRateBar({ winRate }) {
  const pct = Math.round((winRate ?? 0) * 100);
  const color = pct >= 60 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div className="hist-winrate-bar">
      <div className="hist-winrate-label">Träffsäkerhet (totalt)</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, background: 'var(--border2)', borderRadius: 4, height: 14, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.5s' }} />
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color, fontSize: 16, minWidth: 44 }}>{pct}%</span>
      </div>
    </div>
  );
}

function ScoreRangeTable({ scoreRanges }) {
  if (!scoreRanges || scoreRanges.length === 0) return null;
  const max = Math.max(...scoreRanges.map(r => r.samples));
  const colors = { '0-30': 'var(--red)', '31-50': 'var(--orange)', '51-70': 'var(--yellow)', '60-75': 'var(--yellow)', '71-100': 'var(--green)', '76-100': 'var(--green)' };
  return (
    <div className="hist-score-ranges">
      <div className="hist-sub-title">Träffsäkerhet per betygsgrupp</div>
      {scoreRanges.map(r => (
        <div key={r.range} className="hist-score-range-row">
          <span className="hist-range-label">{r.range}</span>
          <div style={{ flex: 1 }}>
            <ProgressBar value={r.samples} max={max} color={colors[r.range] || 'var(--blue)'} />
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 80, textAlign: 'right' }}>
            {r.samples} signaler · {Math.round((r.winRate ?? 0) * 100)}% träff
          </span>
        </div>
      ))}
    </div>
  );
}

function LearningSummary({ learning }) {
  if (!learning) return null;
  const g = learning._global || {};
  const symbols = Object.entries(learning)
    .filter(([k]) => !k.startsWith('_'))
    .map(([sym, d]) => ({ sym, ...d }))
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

  const best    = symbols[0] ?? null;
  const worst   = symbols[symbols.length - 1] ?? null;

  const bestSignalType = (g.byEventType || []).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
  const commonFail     = (g.commonFailures || [])[0];
  const bestScoreRange = (g.scoreRanges || []).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];

  return (
    <div className="hist-learning">
      <div className="hist-learning-bullets">
        {best && (
          <div className="hist-bullet">
            <span className="hist-bullet-icon" style={{ color: 'var(--green)' }}>✓</span>
            <span><strong>{best.sym}</strong> har haft bäst träffsäkerhet ({Math.round((best.winRate ?? 0) * 100)}%) under perioden.</span>
          </div>
        )}
        {worst && worst.sym !== best?.sym && (
          <div className="hist-bullet">
            <span className="hist-bullet-icon" style={{ color: 'var(--red)' }}>✗</span>
            <span><strong>{worst.sym}</strong> hade lägst träffsäkerhet ({Math.round((worst.winRate ?? 0) * 100)}%) under perioden.</span>
          </div>
        )}
        {bestScoreRange && (
          <div className="hist-bullet">
            <span className="hist-bullet-icon" style={{ color: 'var(--yellow)' }}>◎</span>
            <span>Signaler med betygsgrupp <strong>{bestScoreRange.range}</strong> fungerade bäst ({Math.round((bestScoreRange.winRate ?? 0) * 100)}% träff).</span>
          </div>
        )}
        {bestSignalType && (
          <div className="hist-bullet">
            <span className="hist-bullet-icon" style={{ color: 'var(--blue)' }}>→</span>
            <span>Bästa signaltyp: <strong>{bestSignalType.eventType || bestSignalType.type || '–'}</strong> ({Math.round((bestSignalType.winRate ?? 0) * 100)}% träff).</span>
          </div>
        )}
        {commonFail && (
          <div className="hist-bullet">
            <span className="hist-bullet-icon" style={{ color: 'var(--muted)' }}>!</span>
            <span>Vanligaste felorsak: <strong>{commonFail.reason === 'stopped_out' ? 'Stoppades ut' : commonFail.reason}</strong> ({commonFail.count} gånger).</span>
          </div>
        )}
      </div>

      {g.overallWinRate !== undefined && (
        <WinRateBar winRate={g.overallWinRate} />
      )}

      <ScoreRangeTable scoreRanges={g.scoreRanges} />

      {symbols.length > 0 && (
        <div className="hist-symbol-ranking">
          <div className="hist-sub-title">Symboler sorterade efter träffsäkerhet</div>
          {symbols.map((s, i) => (
            <div key={s.sym} className="hist-sym-rank-row">
              <span className="hist-sym-rank-pos" style={{ color: i === 0 ? 'var(--yellow)' : 'var(--muted)' }}>#{i + 1}</span>
              <span className="hist-sym-rank-name">{s.sym}</span>
              <ProgressBar value={Math.round((s.winRate ?? 0) * 100)} max={100} color={s.winRate >= 0.6 ? 'var(--green)' : s.winRate >= 0.4 ? 'var(--yellow)' : 'var(--red)'} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 80, textAlign: 'right' }}>
                {s.samples} st · {Math.round((s.winRate ?? 0) * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="hist-empty">
      <div className="hist-empty-icon">📭</div>
      <div className="hist-empty-title">Det finns ingen historik ännu</div>
      <div className="hist-empty-desc">
        Först behöver vi köra backfill från Alpaca och sedan historisk scan. När det är gjort visas gamla signaler här.
      </div>
      <div className="hist-dev-box">
        <div className="hist-dev-title">Så här startar du historisk analys:</div>
        <code>POST /api/data/backfill</code>
        <code>POST /api/history/scan</code>
        <code>POST /api/history/analyze</code>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [filters, setFilters] = useState({ symbol: '', signalType: '', result: '', days: 7 });
  const { signals, outcomes, learning, loading, error, refresh } = useHistoryData({
    symbol: filters.symbol,
    days: filters.days,
  });

  const filtered = signals.filter(s => {
    if (filters.signalType === 'LONG'  && !s.signal?.startsWith('LONG'))  return false;
    if (filters.signalType === 'SHORT' && !s.signal?.startsWith('SHORT')) return false;
    if (filters.signalType === 'WAIT'  && (s.signal?.startsWith('LONG') || s.signal?.startsWith('SHORT'))) return false;
    if (filters.result === 'success' && outcomes[s.signalId]?.success !== true)  return false;
    if (filters.result === 'fail'    && outcomes[s.signalId]?.success !== false) return false;
    if (filters.result === 'none'    && outcomes[s.signalId])                    return false;
    return true;
  }).slice().reverse();

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-purple">Historik &amp; gamla signaler</div>
          <div className="hero-sub">
            Här ser du vilka signaler systemet hittade tidigare och vad som hände efteråt.
          </div>
        </div>
        <div className="status-bar-v2">
          <span className="status-pill" style={{ color: 'var(--purple)' }}>📚 Historik</span>
          <span className="status-pill">{signals.length} signaler</span>
          <button className="btn" onClick={refresh} style={{ fontSize: 11, padding: '3px 10px' }}>↻ Uppdatera</button>
        </div>
      </div>

      <div className="hist-disclaimer">
        Historiken visar inte framtiden, men hjälper oss förstå vilka signaler som fungerade bäst tidigare.
      </div>

      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Fel: {error}
        </div>
      )}

      {loading && <div className="empty"><span className="spinner" /> Hämtar historik…</div>}

      {!loading && signals.length === 0 && <EmptyState />}

      {!loading && signals.length > 0 && (
        <>
          <StatsStrip signals={signals} outcomes={outcomes} />

          <Filters filters={filters} onChange={setFilters} />

          {learning && (
            <div className="sec">
              <SectionHeader
                icon="🧠"
                title="Vad har systemet lärt sig?"
                desc="Sammanfattning baserad på analyserade signaler och deras resultat."
              />
              <LearningSummary learning={learning} />
            </div>
          )}

          <div className="sec">
            <SectionHeader
              icon="📋"
              title="Gamla signaler"
              count={filtered.length}
              desc={`Visar ${filtered.length} signaler — ${dateLabel(filters.days).toLowerCase()}.`}
            />
            {filtered.length === 0 ? (
              <div className="hist-empty-filter">
                Inga signaler matchar de valda filtren.
              </div>
            ) : (
              <div className="hist-signal-grid">
                {filtered.map(s => (
                  <SignalCard key={s.signalId || `${s.symbol}_${s.timestamp}`} signal={s} outcome={outcomes[s.signalId]} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
