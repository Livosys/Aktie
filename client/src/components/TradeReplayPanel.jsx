import React, { useEffect, useState } from 'react';

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00%';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function text(value, fallback = 'saknas') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function resultSv(result) {
  if (result === 'win') return 'vinst';
  if (result === 'loss') return 'förlust';
  if (result === 'timeout') return 'timeout';
  if (result === 'open') return 'öppen';
  return text(result, 'okänt');
}

function ReplayList({ title, items, empty }) {
  return (
    <section className="trp-section">
      <h3>{title}</h3>
      {items?.length ? (
        <ul className="trp-list">
          {items.map((item, i) => <li key={`${title}-${i}`}>{text(item)}</li>)}
        </ul>
      ) : (
        <p className="trp-muted">{empty || 'Inget att visa ännu.'}</p>
      )}
    </section>
  );
}

export default function TradeReplayPanel({ tradeId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tradeId) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/trade-replay/${encodeURIComponent(tradeId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ ok: false, error: 'Kunde inte hämta trade replay.' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tradeId]);

  if (!tradeId) return null;
  const trade = data?.trade || {};
  const goodAlternatives = (data?.alternative_exits || []).filter((a) => a.result === 'hade blivit bättre').slice(0, 3);

  return (
    <div className="trp-panel" role="dialog" aria-label="Trade Replay">
      <div className="trp-head">
        <div>
          <span className="trp-kicker">Trade Replay</span>
          <h2>{text(trade.symbol, 'Trade')} {trade.pnl_pct !== undefined ? fmtPct(trade.pnl_pct) : ''}</h2>
        </div>
        <button className="trp-close" type="button" onClick={onClose} aria-label="Stäng">×</button>
      </div>

      {loading && <div className="trp-loading">Laddar trade replay...</div>}
      {!loading && data?.ok === false && <div className="trp-error">{text(data.error, 'Trade saknas.')}</div>}

      {!loading && data?.ok && (
        <>
          <section className="trp-section">
            <h3>Vad hände?</h3>
            <div className="trp-summary">{text(data.summary?.what_happened)}</div>
            <div className="trp-metrics">
              <span><b>Resultat</b>{resultSv(trade.result)}</span>
              <span><b>P/L</b>{fmtPct(trade.pnl_pct)}</span>
              <span><b>Hålltid</b>{text(trade.duration_label)}</span>
              <span><b>Entry</b>{text(trade.entry_price)}</span>
              <span><b>Exit</b>{text(trade.exit_price)}</span>
              <span><b>Strategi</b>{text(trade.strategy_id)}</span>
              <span><b>Setup</b>{text(trade.setup_id)}</span>
              <span><b>Confidence</b>{text(trade.confidence)}</span>
            </div>
          </section>

          <ReplayList
            title="Varför öppnades traden?"
            items={data.entry_explanation?.supports}
            empty={data.entry_explanation?.summary}
          />

          {data.entry_explanation?.warnings?.length > 0 && (
            <ReplayList title="Varningar vid entry" items={data.entry_explanation.warnings} />
          )}

          <ReplayList
            title="Varför stängdes den?"
            items={data.exit_explanation?.reasons}
            empty={data.exit_explanation?.summary}
          />

          <section className="trp-section">
            <h3>Timeline</h3>
            <div className="trp-timeline">
              {(data.timeline || []).map((event, i) => (
                <div key={`${event.timestamp}-${event.type}-${i}`} className="trp-time-row">
                  <time>{text(event.time_label)}</time>
                  <span>{text(event.label || event.message)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="trp-section">
            <h3>Hade vi kunnat göra bättre?</h3>
            <div className="trp-summary">{text(data.missed_opportunity?.message)}</div>
            <div className="trp-alt-grid">
              {(data.alternative_exits || []).map((alt) => (
                <div key={alt.label} className={`trp-alt trp-alt-${String(alt.result || '').replace(/\s+/g, '-')}`}>
                  <strong>{text(alt.label)}</strong>
                  <span>{text(alt.result)}</span>
                  <em>{alt.data_status === 'ok' ? fmtPct(alt.pnl_pct) : 'för lite data'}</em>
                </div>
              ))}
            </div>
            {goodAlternatives.length > 0 && (
              <div className="trp-note">
                Bättre exit: {goodAlternatives.map((a) => `${a.label} (${fmtPct(a.pnl_pct)})`).join(', ')}
              </div>
            )}
          </section>

          <ReplayList
            title="Vad lärde systemet sig?"
            items={data.learned}
            empty="Systemet behöver fler paper trades för att dra en slutsats."
          />

          <div className="trp-safety">
            actions_allowed=false · can_place_orders=false · live_trading_enabled=false
          </div>
        </>
      )}
    </div>
  );
}
