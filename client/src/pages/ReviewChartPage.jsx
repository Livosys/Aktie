import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers,
} from 'lightweight-charts';

// ── Constants ─────────────────────────────────────────────────────────────────

const TV_EXCHANGE_MAP = {
  BTCUSDT: 'BINANCE', ETHUSDT: 'BINANCE', SOLUSDT: 'BINANCE',
  AAPL: 'NASDAQ', NVDA: 'NASDAQ', TSLA: 'NASDAQ', AMD: 'NASDAQ',
  MSFT: 'NASDAQ', META: 'NASDAQ', AMZN: 'NASDAQ', QQQ: 'NASDAQ',
};
const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const isCrypto = s => CRYPTO_SYMBOLS.has(s) || s.endsWith('USDT');

function buildTVUrl(symbol) {
  const exchange = TV_EXCHANGE_MAP[symbol] || 'NASDAQ';
  return `https://www.tradingview.com/chart/di3qlKNB/?symbol=${encodeURIComponent(`${exchange}:${symbol}`)}&interval=2`;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtTz(isoOrUnixSecs, tz, includeLabel = true) {
  const d = typeof isoOrUnixSecs === 'number'
    ? new Date(isoOrUnixSecs * 1000)
    : new Date(isoOrUnixSecs);
  const str = d.toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: tz,
  });
  if (!includeLabel) return str;
  const labels = { 'UTC': 'UTC', 'Europe/Stockholm': 'Sverige', 'America/New_York': 'New York' };
  return `${str} ${labels[tz] || tz}`;
}

function fmtPrice(v) {
  if (v == null) return '–';
  const n = Number(v);
  return n >= 100 ? n.toFixed(2) : n.toFixed(4);
}

function signalToSv(signal) {
  const map = {
    LONG_WATCH: 'Möjlig uppgång – bevaka', LONG_TRIGGERED: 'Möjlig uppgång – triggrad',
    SHORT_WATCH: 'Möjlig nedgång – bevaka', SHORT_TRIGGERED: 'Möjlig nedgång – triggrad',
    WAIT: 'Vänta', WAIT_PULLBACK: 'Vänta på pullback', WIDE_REVERSAL_WATCH: 'Möjlig reversal',
  };
  return map[signal] ?? signal ?? '–';
}

// ── Outcome calculator ────────────────────────────────────────────────────────

function calcOutcome(candles, signalIdx, n) {
  if (signalIdx < 0 || signalIdx + n >= candles.length) return null;
  const base  = candles[signalIdx].close;
  const after = candles[signalIdx + n].close;
  if (!base || !after) return null;
  const pct = ((after - base) / base) * 100;
  let maxUp = 0, maxDown = 0;
  for (let i = signalIdx + 1; i <= signalIdx + n && i < candles.length; i++) {
    const up   = ((candles[i].high - base) / base) * 100;
    const down = ((candles[i].low  - base) / base) * 100;
    if (up   > maxUp)   maxUp   = up;
    if (down < maxDown) maxDown = down;
  }
  return { pct, maxUp, maxDown };
}

// ── Chart ─────────────────────────────────────────────────────────────────────

function CandleChart({ candles, signalCandleIdx, signalType, showSMA }) {
  const containerRef = useRef(null);
  const sma20Ref     = useRef(null);
  const sma200Ref    = useRef(null);

  // Toggle visibility without recreating the chart
  useEffect(() => {
    if (sma20Ref.current)  sma20Ref.current.applyOptions({ visible: showSMA });
    if (sma200Ref.current) sma200Ref.current.applyOptions({ visible: showSMA });
  }, [showSMA]);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const isLong  = signalType?.startsWith('LONG');
    const isShort = signalType?.startsWith('SHORT');
    const markerColor = isLong ? '#22c55e' : isShort ? '#ef4444' : '#f97316';

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0f172a' },
        textColor: '#94a3b8',
        fontFamily: 'monospace',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        vertLine: { color: '#475569', labelBackgroundColor: '#334155' },
        horzLine: { color: '#475569', labelBackgroundColor: '#334155' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#334155',
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: { borderColor: '#334155' },
      width:  containerRef.current.clientWidth,
      height: 420,
      localization: {
        timeFormatter: ts => fmtTz(ts, 'UTC', false).slice(0, 16),
      },
    });

    // ── Candles ──────────────────────────────────────────────────────────────
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });

    const candleData = candles.map((c, i) => {
      const isSignal = i === signalCandleIdx;
      return isSignal
        ? { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
            color: markerColor, borderColor: markerColor, wickColor: markerColor }
        : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    });
    candleSeries.setData(candleData);

    // ── Volume ───────────────────────────────────────────────────────────────
    const volSeries = chart.addSeries(HistogramSeries, {
      color: '#334155',
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.setData(candles.map(c => ({
      time: c.time,
      value: c.volume ?? 0,
      color: c.close >= c.open ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)',
    })));

    // ── SMA20 ─────────────────────────────────────────────────────────────────
    const sma20Data = candles
      .filter(c => c.sma20 != null)
      .map(c => ({ time: c.time, value: c.sma20 }));

    const sma20Series = chart.addSeries(LineSeries, {
      color: '#eab308',
      lineWidth: 1,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'SMA20',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      visible: showSMA,
    });
    if (sma20Data.length > 0) sma20Series.setData(sma20Data);
    sma20Ref.current = sma20Series;

    // ── SMA200 ────────────────────────────────────────────────────────────────
    const sma200Data = candles
      .filter(c => c.sma200 != null)
      .map(c => ({ time: c.time, value: c.sma200 }));

    const sma200Series = chart.addSeries(LineSeries, {
      color: '#818cf8',
      lineWidth: 2,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'SMA200',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      visible: showSMA,
    });
    if (sma200Data.length > 0) sma200Series.setData(sma200Data);
    sma200Ref.current = sma200Series;

    // ── Signal marker + price line ────────────────────────────────────────────
    if (signalCandleIdx >= 0 && signalCandleIdx < candles.length) {
      const sig = candles[signalCandleIdx];
      createSeriesMarkers(candleSeries, [{
        time:     sig.time,
        position: isLong ? 'belowBar' : isShort ? 'aboveBar' : 'aboveBar',
        color:    markerColor,
        shape:    isLong ? 'arrowUp' : isShort ? 'arrowDown' : 'circle',
        text:     'Signal',
        size:     2,
      }]);
      candleSeries.createPriceLine({
        price: sig.close, color: markerColor,
        lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: 'Signal-pris',
      });
    }

    // ── Resize observer ───────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      sma20Ref.current  = null;
      sma200Ref.current = null;
      chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, signalCandleIdx, signalType]);

  return (
    <div ref={containerRef}
      style={{ width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #1e293b' }}
    />
  );
}

// ── Timezone strip ────────────────────────────────────────────────────────────

function TimezoneStrip({ timestamp, symbol }) {
  const crypto = isCrypto(symbol);
  const zones = [
    { tz: 'UTC',               label: 'UTC' },
    { tz: 'Europe/Stockholm',  label: 'Sverige' },
    ...(!crypto ? [{ tz: 'America/New_York', label: 'New York' }] : []),
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
      {zones.map(({ tz, label }) => (
        <div key={tz} style={{ background: '#1e293b', borderRadius: 6, padding: '5px 12px', fontSize: 12 }}>
          <span style={{ color: '#64748b', marginRight: 8 }}>{label}</span>
          <span style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>
            {fmtTz(timestamp, tz, false)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── SMA legend ────────────────────────────────────────────────────────────────

function SMALegend({ showSMA, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '6px 0' }}>
      <button
        onClick={onToggle}
        style={{
          background: showSMA ? '#1e293b' : 'transparent',
          border: '1px solid #334155',
          borderRadius: 6,
          color: showSMA ? '#e2e8f0' : '#475569',
          cursor: 'pointer',
          fontSize: 11,
          padding: '4px 10px',
          transition: 'all 0.15s',
        }}
      >
        {showSMA ? '● Dölj SMA-linjer' : '○ Visa SMA-linjer'}
      </button>
      {showSMA && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <div style={{ width: 20, height: 2, background: '#eab308' }} />
            <span style={{ color: '#eab308' }}>SMA20</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <div style={{ width: 20, height: 3, background: '#818cf8' }} />
            <span style={{ color: '#818cf8' }}>SMA200</span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Outcome row ───────────────────────────────────────────────────────────────

function OutcomeRow({ label, outcome, isLong }) {
  const style = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1e293b', fontSize: 12, flexWrap: 'wrap', gap: 4 };
  if (!outcome) return (
    <div style={style}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#475569' }}>–</span>
    </div>
  );
  const { pct, maxUp, maxDown } = outcome;
  const win = isLong ? pct >= 0 : pct <= 0;
  return (
    <div style={style}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ color: win ? '#22c55e' : '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>
          {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
        </span>
        <span style={{ color: '#475569', fontFamily: 'monospace', fontSize: 11 }}>
          ↑+{maxUp.toFixed(2)}% ↓{maxDown.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

// ── Info row helper ───────────────────────────────────────────────────────────

function InfoRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e293b', fontSize: 12 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: color || '#e2e8f0' }}>{value}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReviewChartPage() {
  const [searchParams] = useSearchParams();
  const symbol      = (searchParams.get('symbol') || '').toUpperCase();
  const timestamp   = searchParams.get('timestamp') || '';
  const signalParam = searchParams.get('signal') || '';
  const tradeScore  = searchParams.get('tradeScore');
  const narrowScore = searchParams.get('narrowScore');
  const priceParam  = searchParams.get('price');

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [showSMA, setShowSMA] = useState(true);

  useEffect(() => {
    if (!symbol || !timestamp) {
      setError('symbol och timestamp krävs i URL-parametrar');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const qs = `symbol=${encodeURIComponent(symbol)}&timestamp=${encodeURIComponent(timestamp)}&windowBefore=80&windowAfter=40`;
    fetch(`/api/review/chart-data?${qs}`)
      .then(r => r.json())
      .then(json => {
        if (!json.ok) throw new Error(json.error || 'Okänt fel');
        setData(json);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, timestamp]);

  const candles     = data?.candles ?? [];
  const signalIdx   = data?.signalCandleIdx ?? -1;
  const hasSMA200   = data?.hasSMA200 ?? false;
  const sigCandle   = signalIdx >= 0 ? candles[signalIdx] : null;

  const isLong  = signalParam?.startsWith('LONG');
  const isShort = signalParam?.startsWith('SHORT');
  const accentColor = isLong ? '#22c55e' : isShort ? '#ef4444' : '#f97316';

  const outcome10 = calcOutcome(candles, signalIdx, 10);
  const outcome20 = calcOutcome(candles, signalIdx, 20);

  const displayPrice = sigCandle?.close ?? (priceParam ? Number(priceParam) : null);
  const sma20AtSignal  = sigCandle?.sma20;
  const sma200AtSignal = sigCandle?.sma200;

  const smaGapPct = sma20AtSignal != null && sma200AtSignal != null
    ? ((sma20AtSignal - sma200AtSignal) / sma200AtSignal * 100)
    : null;

  const scoreColor = s => {
    const n = Number(s);
    return n >= 70 ? '#22c55e' : n >= 40 ? '#eab308' : '#ef4444';
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 0 40px' }}>
      {/* Header */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title" style={{ color: accentColor }}>
            🔍 Review Chart — {symbol || '…'}
          </div>
          <div className="hero-sub">Exakt candle från signalhistoriken · 2m · candles + SMA20 + SMA200</div>
        </div>
        <div className="status-bar-v2">
          <Link to="/historik" className="btn" style={{ fontSize: 11, padding: '3px 10px' }}>← Historik</Link>
          {symbol && (
            <a href={buildTVUrl(symbol)} target="_blank" rel="noopener noreferrer"
               className="btn" style={{ fontSize: 11, padding: '3px 10px' }}>
              📈 TradingView
            </a>
          )}
        </div>
      </div>

      {loading && <div className="empty"><span className="spinner" /> Hämtar candle-data…</div>}

      {error && (
        <div className="market-banner" style={{ borderColor: '#ef4444', color: '#ef4444', background: 'rgba(239,68,68,0.08)' }}>
          ✗ {error}
        </div>
      )}

      {!loading && !error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          <TimezoneStrip timestamp={timestamp} symbol={symbol} />

          {/* SMA legend / toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <SMALegend showSMA={showSMA} onToggle={() => setShowSMA(v => !v)} />
            {!hasSMA200 && (
              <span style={{ fontSize: 11, color: '#f97316', background: 'rgba(249,115,22,0.1)', borderRadius: 5, padding: '3px 8px' }}>
                ⚠ SMA200 saknas — för lite warmup-data
              </span>
            )}
          </div>

          {/* Chart */}
          {candles.length > 0
            ? <CandleChart
                candles={candles}
                signalCandleIdx={signalIdx}
                signalType={signalParam}
                showSMA={showSMA}
              />
            : <div className="empty">Inga candles att visa</div>
          }

          {/* Signal info + Outcomes */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>

            {/* Signal info */}
            <div style={{ background: '#0f172a', border: `1px solid ${accentColor}40`, borderRadius: 10, padding: 18 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: accentColor, fontSize: 13 }}>Signal-info</div>
              <InfoRow label="Symbol" value={symbol} />
              {signalParam && <InfoRow label="Signal" value={signalToSv(signalParam)} color={accentColor} />}
              {displayPrice != null && <InfoRow label="Pris vid signal" value={`$${fmtPrice(displayPrice)}`} />}
              {tradeScore  != null && <InfoRow label="Tradebetyg"  value={tradeScore}  color={scoreColor(tradeScore)} />}
              {narrowScore != null && <InfoRow label="Narrowbetyg" value={narrowScore} />}

              {/* SMA values at signal */}
              {sma20AtSignal != null && (
                <InfoRow label="SMA20 vid signal" value={`$${fmtPrice(sma20AtSignal)}`} color="#eab308" />
              )}
              {sma200AtSignal != null && (
                <InfoRow label="SMA200 vid signal" value={`$${fmtPrice(sma200AtSignal)}`} color="#818cf8" />
              )}
              {smaGapPct != null && (
                <InfoRow
                  label="SMA-gap (20 vs 200)"
                  value={`${smaGapPct >= 0 ? '+' : ''}${smaGapPct.toFixed(2)}%`}
                  color={smaGapPct >= 0 ? '#22c55e' : '#ef4444'}
                />
              )}
              {!hasSMA200 && (
                <div style={{ fontSize: 11, color: '#f97316', marginTop: 8 }}>
                  SMA200 saknas — för lite warmup-data
                </div>
              )}
              {signalIdx < 0 && (
                <div style={{ fontSize: 11, color: '#f97316', marginTop: 8 }}>
                  ⚠ Ingen exakt candle hittades för angiven tid
                </div>
              )}

              <a href={buildTVUrl(symbol)} target="_blank" rel="noopener noreferrer"
                 style={{ display: 'block', marginTop: 14, textAlign: 'center', padding: '7px 0', borderRadius: 6, background: '#1e293b', color: '#94a3b8', fontSize: 12, textDecoration: 'none' }}>
                📈 Öppna i TradingView (fallback)
              </a>
            </div>

            {/* Outcomes */}
            <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#94a3b8', fontSize: 13 }}>Vad hände efteråt?</div>
              <OutcomeRow label="Efter 10 candles (20 min)" outcome={outcome10} isLong={isLong} />
              <OutcomeRow label="Efter 20 candles (40 min)" outcome={outcome20} isLong={isLong} />
              {outcome10 == null && outcome20 == null && signalIdx >= 0 && (
                <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>
                  Inte tillräckligt med candles efter signalen.
                </div>
              )}
              {signalIdx < 0 && (
                <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>
                  Outcome kräver att exakt signal-candle hittas.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
