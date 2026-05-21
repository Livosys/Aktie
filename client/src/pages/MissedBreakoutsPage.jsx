import React, { useState, useEffect, useCallback } from 'react';
import { SectionHeader } from '../shared.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}

function CopyButton({ text, label, title: titleProp }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <button className="hist-action-btn hist-copy-btn" onClick={handleCopy} title={titleProp ?? 'Kopiera till urklipp'}>
      {copied ? '✓ Kopierat' : label}
    </button>
  );
}

function pctFmt(v) {
  if (v === null || v === undefined) return '–';
  const n = Number(v);
  const color = n >= 0 ? 'var(--green)' : 'var(--red)';
  return <span style={{ color, fontFamily: 'var(--mono)', fontWeight: 700 }}>{n >= 0 ? '+' : ''}{n.toFixed(2)}%</span>;
}

const MISSED_TYPE_LABEL = {
  BULLISH_EXTENDED:     'Kraftig bullish',
  LATE_CONTINUATION:    'Sen continuation',
  TREND_PERSISTENCE:    'Trend persistence',
  BULLISH_CONTINUATION: 'Bullish continuation',
  BEARISH_CONTINUATION: 'Bearish continuation',
};

const MISSED_TYPE_CLS = {
  BULLISH_EXTENDED:     'badge-green',
  LATE_CONTINUATION:    'badge-green',
  TREND_PERSISTENCE:    'badge-blue',
  BULLISH_CONTINUATION: 'badge-green',
  BEARISH_CONTINUATION: 'badge-red',
};

function regimeBadgeCls(regime) {
  if (!regime) return 'badge-gray';
  if (regime.includes('BULL'))    return 'badge-green';
  if (regime.includes('BEAR'))    return 'badge-red';
  if (regime.includes('CHOPPY'))  return 'badge-yellow';
  if (regime.includes('PANIC'))   return 'badge-red';
  if (regime.includes('HIGH_VOL')) return 'badge-orange';
  return 'badge-gray';
}

// ── Stats panel ───────────────────────────────────────────────────────────────

function StatsPanel({ items }) {
  if (!items || items.length === 0) return null;

  const avgCont = items.reduce((a, i) => a + (i.maxUpPct || 0), 0) / items.length;

  // Most common block reason (first reason string keyword)
  const reasonCounts = {};
  items.forEach((i) => {
    const reasons = Array.isArray(i.reasonSv) ? i.reasonSv : (i.reasonSv ? [i.reasonSv] : []);
    if (reasons.length) {
      const key = reasons[0].slice(0, 40);
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  });
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];

  // Most common symbol
  const symCounts = {};
  items.forEach((i) => { symCounts[i.symbol] = (symCounts[i.symbol] || 0) + 1; });
  const topSym = Object.entries(symCounts).sort((a, b) => b[1] - a[1])[0];

  // Most common regime
  const regimeCounts = {};
  items.forEach((i) => { if (i.marketRegime) regimeCounts[i.marketRegime] = (regimeCounts[i.marketRegime] || 0) + 1; });
  const topRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0];

  const continuationCount = items.filter((i) => i.maxUpPct >= 1.0).length;

  return (
    <div className="mb-stats-panel">
      <div className="mb-stat">
        <span className="mb-stat-val">{items.length}</span>
        <span className="mb-stat-label">Missed moves</span>
      </div>
      <div className="mb-stat">
        <span className="mb-stat-val" style={{ color: 'var(--green)' }}>{continuationCount}</span>
        <span className="mb-stat-label">≥1% continuation</span>
      </div>
      <div className="mb-stat">
        <span className="mb-stat-val" style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>+{avgCont.toFixed(2)}%</span>
        <span className="mb-stat-label">Avg continuation</span>
      </div>
      {topSym && (
        <div className="mb-stat">
          <span className="mb-stat-val" style={{ fontFamily: 'var(--mono)' }}>{topSym[0]}</span>
          <span className="mb-stat-label">Vanligaste symbol</span>
        </div>
      )}
      {topRegime && (
        <div className="mb-stat">
          <span className="mb-stat-val" style={{ fontSize: 11 }}>{topRegime[0]}</span>
          <span className="mb-stat-label">Vanligaste regime</span>
        </div>
      )}
      {topReason && (
        <div className="mb-stat mb-stat-wide">
          <span className="mb-stat-label">Vanligaste block-anledning</span>
          <span className="mb-stat-reason">"{topReason[0]}…" ({topReason[1]}×)</span>
        </div>
      )}
    </div>
  );
}

// ── Missed card ───────────────────────────────────────────────────────────────

function MissedCard({ item }) {
  const [chartToast, setChartToast] = useState(false);

  const isBullish   = !item.missedType?.includes('BEARISH');
  const accentColor = isBullish ? 'var(--green)' : 'var(--red)';
  const borderColor = isBullish ? 'var(--green-border)' : 'var(--red-border)';

  const sweDate = item.signalTidSverige?.split(' ')[0] || '';
  const sweTime = item.signalTidSverige?.split(' ')[1] || '';

  const reasonArr = Array.isArray(item.reasonSv)
    ? item.reasonSv
    : (item.reasonSv ? [item.reasonSv] : []);

  function handleOpenChart() {
    window.open(item.tradingView, '_blank', 'noopener,noreferrer');
    copyToClipboard(sweDate);
    setChartToast(true);
    setTimeout(() => setChartToast(false), 3500);
  }

  return (
    <div className="mb-card" style={{ borderColor }}>
      <div className="mb-card-accent" style={{ background: accentColor }} />

      {/* Header */}
      <div className="mb-card-header">
        <span className="mb-card-sym">{item.symbol}</span>
        <span className={`badge ${MISSED_TYPE_CLS[item.missedType] || 'badge-gray'}`}>
          {MISSED_TYPE_LABEL[item.missedType] || item.missedType}
        </span>
        {item.blocked && <span className="badge badge-red">Blockerad</span>}
        {item.marketRegime && (
          <span className={`badge ${regimeBadgeCls(item.marketRegime)}`} style={{ fontSize: 10 }}>
            {item.marketRegime}
          </span>
        )}
      </div>

      {/* Time */}
      <div className="mb-time-row">
        <span className="mb-time-label">UTC:</span>
        <span className="mb-time-val">{item.signalTidUTC}</span>
      </div>
      <div className="mb-tv-goto">
        <span className="hist-tv-goto-label">Go to date:</span>
        <strong className="hist-tv-goto-date">{sweDate}</strong>
        <span className="hist-tv-goto-sep">→ kl.</span>
        <strong className="hist-tv-goto-time">{sweTime}</strong>
      </div>

      {/* What system said */}
      <div className="mb-system-said">
        <div className="mb-section-label">Systemet sa</div>
        <div className="mb-action">{item.actionSv || item.signal || '–'}</div>
        {reasonArr.slice(0, 2).map((r, i) => (
          <div key={i} className="mb-reason">• {r}</div>
        ))}
      </div>

      {/* What happened */}
      <div className="mb-happened">
        <div className="mb-section-label">Vad hände efter signal</div>
        <div className="mb-happened-row">
          <span className="mb-happened-label">10 candles (20 min):</span>
          {pctFmt(item.movedPct10)}
          <span className="mb-happened-max"> max {pctFmt(item.outcome10?.maxMoveUp)}</span>
        </div>
        <div className="mb-happened-row">
          <span className="mb-happened-label">20 candles (40 min):</span>
          {pctFmt(item.movedPct20)}
        </div>
        <div className="mb-continuation-bar-wrap">
          <span className="mb-cont-label">Continuation strength</span>
          <div className="mb-cont-bar-bg">
            <div
              className="mb-cont-bar-fill"
              style={{
                width: `${item.continuationStrength || 0}%`,
                background: accentColor,
              }}
            />
          </div>
          <span className="mb-cont-val">{item.continuationStrength}</span>
        </div>
      </div>

      {/* Scores */}
      <div className="mb-scores">
        <div className="mb-score-item">
          <span className="mb-score-label">Tradebetyg</span>
          <span className="mb-score-val" style={{ color: (item.tradeScore ?? 0) >= 50 ? 'var(--green)' : 'var(--muted)' }}>
            {item.tradeScore ?? '–'}
          </span>
        </div>
        <div className="mb-score-item">
          <span className="mb-score-label">Narrowbetyg</span>
          <span className="mb-score-val">{item.narrowScore ?? '–'}</span>
        </div>
        {item.distanceFromZone !== null && item.distanceFromZone !== undefined && (
          <div className="mb-score-item">
            <span className="mb-score-label">Avst. zon (ATR)</span>
            <span className="mb-score-val" style={{ fontFamily: 'var(--mono)' }}>
              {Number(item.distanceFromZone).toFixed(2)}
            </span>
          </div>
        )}
        {item.relVol20 !== null && item.relVol20 !== undefined && (
          <div className="mb-score-item">
            <span className="mb-score-label">relVol20</span>
            <span className="mb-score-val" style={{ fontFamily: 'var(--mono)' }}>
              {Number(item.relVol20).toFixed(2)}x
            </span>
          </div>
        )}
      </div>

      {/* Review summary */}
      <div className="mb-review-summary">{item.reviewSummarySv}</div>

      {/* Actions */}
      <div className="hist-card-actions" style={{ marginTop: 8 }}>
        <button
          className="hist-action-btn hist-tv-btn"
          onClick={handleOpenChart}
          title={`Öppna ${item.symbol} i TradingView – klistra in ${sweDate} i Go to date`}
        >
          {chartToast ? `✓ Klistra in i Go to date: ${sweDate}` : '📈 Öppna chart + kopiera datum'}
        </button>
        <CopyButton text={sweDate} label={`📅 ${sweDate}`} title="Kopiera datum för Go to date" />
        <CopyButton text={sweTime} label={`🕐 kl. ${sweTime}`} title="Kopiera klocktid" />
        <CopyButton text={item.copyReviewText} label="📋 Review-text" title="Kopiera review-text" />
      </div>
      <div className="hist-tv-help">
        TradingView öppnar ibland vid aktuell tid. Klicka <strong>Go to date</strong> och klistra in den kopierade tiden.
      </div>
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const ALL_SYMBOLS = ['', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAPL', 'NVDA', 'TSLA', 'AMD', 'MSFT', 'META', 'AMZN', 'QQQ'];
const DAY_OPTIONS = [1, 3, 7, 14, 30];

function FilterBar({ params, onChange }) {
  return (
    <div className="mb-filter-bar">
      <div className="mb-filter-group">
        <label className="mb-filter-label">Dagar</label>
        <div className="mb-filter-pills">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              className={`mb-pill${params.days === d ? ' mb-pill-active' : ''}`}
              onClick={() => onChange({ ...params, days: d })}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      <div className="mb-filter-group">
        <label className="mb-filter-label">Symbol</label>
        <select
          className="mb-select"
          value={params.symbol}
          onChange={(e) => onChange({ ...params, symbol: e.target.value })}
        >
          {ALL_SYMBOLS.map((s) => (
            <option key={s} value={s}>{s || 'Alla'}</option>
          ))}
        </select>
      </div>
      <div className="mb-filter-group">
        <label className="mb-filter-label">Typ</label>
        <label className="mb-checkbox-label">
          <input
            type="checkbox"
            checked={params.onlyBlocked}
            onChange={(e) => onChange({ ...params, onlyBlocked: e.target.checked })}
          />
          Bara blockerade
        </label>
      </div>
      <div className="mb-filter-group">
        <label className="mb-filter-label">Limit</label>
        <select
          className="mb-select"
          value={params.limit}
          onChange={(e) => onChange({ ...params, limit: parseInt(e.target.value, 10) })}
        >
          {[50, 100, 200, 500].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MissedBreakoutsPage() {
  const [params, setParams]   = useState({ days: 7, symbol: '', onlyBlocked: false, limit: 200 });
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        days:        params.days,
        limit:       params.limit,
        onlyBlocked: params.onlyBlocked,
        ...(params.symbol ? { symbol: params.symbol } : {}),
      });
      const r = await fetch(`/api/history/missed-breakouts?${qs}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'API error');
      setItems(d.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="page-wrap">
      <SectionHeader
        title="🧠 Missed Moves"
        subtitle="Setups systemet blockerade men där priset fortsatte starkt"
      />

      <FilterBar params={params} onChange={setParams} />

      {loading && <div className="empty">Laddar missed moves…</div>}
      {error   && <div className="empty" style={{ color: 'var(--red)' }}>Fel: {error}</div>}

      {!loading && !error && (
        <>
          <StatsPanel items={items} />
          {items.length === 0
            ? <div className="empty">Inga missed moves hittades för valda filter.</div>
            : (
              <div className="mb-grid">
                {items.map((item) => (
                  <MissedCard key={item.signalId || item.timestamp + item.symbol} item={item} />
                ))}
              </div>
            )
          }
        </>
      )}
    </div>
  );
}
