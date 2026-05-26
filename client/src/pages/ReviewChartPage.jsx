import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers,
} from 'lightweight-charts';
import { getTradingViewUrl } from '../utils/tradingView.js';
import { familyCalibrationMeta, signalFamilyMeta } from '../utils/signalFamilyLabels.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const isCrypto = s => CRYPTO_SYMBOLS.has(s) || s.endsWith('USDT');
const TV_SYMBOL_MAP = {
  ETHUSDT: 'BINANCE:ETHUSDT',
  BTCUSDT: 'BINANCE:BTCUSDT',
  SOLUSDT: 'BINANCE:SOLUSDT',
  MSFT: 'NASDAQ:MSFT',
  AMD: 'NASDAQ:AMD',
  AAPL: 'NASDAQ:AAPL',
  TSLA: 'NASDAQ:TSLA',
  NVDA: 'NASDAQ:NVDA',
  META: 'NASDAQ:META',
  AMZN: 'NASDAQ:AMZN',
  QQQ: 'NASDAQ:QQQ',
};

function buildTVUrl(symbol) {
  return getTradingViewUrl(symbol);
}

function tradingViewSymbol(symbol, marketType) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (TV_SYMBOL_MAP[raw]) return TV_SYMBOL_MAP[raw];
  if (marketType === 'crypto' || isCrypto(raw)) return `BINANCE:${raw}`;
  return `NASDAQ:${raw}`;
}

function tradingViewEmbedUrl(symbol, marketType, timeframe) {
  const interval = timeframe === '2m' || timeframe === '2' ? '2' : timeframe === '5m' ? '5' : '1';
  const qs = new URLSearchParams({
    symbol: tradingViewSymbol(symbol, marketType),
    interval,
    theme: 'dark',
    style: '1',
    timezone: 'Etc/UTC',
    withdateranges: '1',
    hide_side_toolbar: '0',
    allow_symbol_change: '0',
    save_image: '0',
  });
  return `https://www.tradingview.com/widgetembed/?${qs.toString()}`;
}

function normalizeMarketType(symbol, marketType) {
  if (marketType) return marketType;
  return isCrypto(symbol) ? 'crypto' : 'stock';
}

function liveCandlesToChartData(json) {
  const candles = (json?.candles || [])
    .map((c) => ({
      time: Math.floor(new Date(c.timestamp).getTime() / 1000),
      ts: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0),
    }))
    .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite));

  return {
    ok: true,
    symbol: json.symbol,
    candles,
    signalCandleIdx: -1,
    hasSMA200: false,
    latestTimestamp: json.latestTimestamp,
    noExactSignal: true,
    softNoticeSv: 'Ingen exakt signal-tid vald. Visar senaste tillgängliga 2m-data.',
  };
}

function apiUrl(path) {
  return new URL(path, window.location.origin).toString();
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

function biasSv(bias) {
  const map = { UP: 'UP', DOWN: 'DOWN', UNCERTAIN: 'UNCERTAIN', NEUTRAL: 'UNCERTAIN' };
  return map[String(bias || '').toUpperCase()] || 'UNCERTAIN';
}

function riskSv(risk) {
  const map = { low: 'Låg', normal: 'Normal', medium: 'Medel', elevated: 'Förhöjd', high: 'Hög' };
  return map[String(risk || '').toLowerCase()] || '–';
}

// ── Outcome calculator ────────────────────────────────────────────────────────

function calcOutcome(candles, signalIdx, n, nextMoveBias) {
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
  const bias = biasSv(nextMoveBias);
  const directionMatched = bias === 'UP' ? pct > 0.03 : bias === 'DOWN' ? pct < -0.03 : null;
  const fakeout = bias === 'UP'
    ? maxUp > 0.15 && pct < -0.03
    : bias === 'DOWN'
      ? maxDown < -0.15 && pct > 0.03
      : Math.abs(maxUp) > 0.25 && Math.abs(maxDown) > 0.25 && Math.abs(pct) < 0.05;
  let summary = 'osäkert';
  if (directionMatched === true && Math.abs(pct) >= 0.2) summary = 'rörelsen höll';
  else if (directionMatched === true) summary = 'riktningen stämde';
  else if (directionMatched === false) summary = fakeout ? 'möjlig fakeout' : 'riktningen stämde inte';
  return { pct, maxUp, maxDown, directionMatched, fakeout, summary };
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

    const markerColor = '#f97316';

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
        fixRightEdge: false,
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
        position: 'aboveBar',
        color:    markerColor,
        shape:    'circle',
        text:     'Signal upptäckt här',
        size:     2,
      }]);
      candleSeries.createPriceLine({
        price: sig.close, color: markerColor,
        lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: 'Signalpris',
      });
    }

    // ── Centered signal view: 30 candles before, 30 after ────────────────────
    // to may exceed candles.length — lightweight-charts shows whitespace, which
    // keeps the signal visually centered when future candles are missing.
    if (signalCandleIdx >= 0 && signalCandleIdx < candles.length) {
      const from = Math.max(0, signalCandleIdx - 30);
      const to   = signalCandleIdx + 30;
      chart.timeScale().setVisibleLogicalRange({ from, to });
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

function OutcomeRow({ label, outcome }) {
  const style = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1e293b', fontSize: 12, flexWrap: 'wrap', gap: 4 };
  if (!outcome) return (
    <div style={style}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#475569' }}>väntar på fler candles</span>
    </div>
  );
  const { pct, maxUp, maxDown, fakeout, summary } = outcome;
  const color = fakeout ? '#f97316' : outcome.directionMatched === true ? '#22c55e' : outcome.directionMatched === false ? '#ef4444' : '#eab308';
  return (
    <div style={style}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <span style={{ color, fontFamily: 'monospace', fontWeight: 700 }}>
          {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
        </span>
        <span style={{ color, fontSize: 11 }}>{summary}</span>
        <span style={{ color: '#475569', fontFamily: 'monospace', fontSize: 11 }}>
          ↑+{maxUp.toFixed(2)}% ↓{maxDown.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

function TradingViewPanel({ symbol, marketType, timeframe }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderBottom: '1px solid #1e293b', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#e2e8f0' }}>TradingView</div>
          <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{tradingViewSymbol(symbol, marketType)} · {timeframe}</div>
        </div>
        <a href={buildTVUrl(symbol)} target="_blank" rel="noopener noreferrer" className="btn" style={{ fontSize: 11, padding: '3px 10px' }}>
          Öppna extern graf
        </a>
      </div>
      <iframe
        title={`TradingView ${symbol}`}
        src={tradingViewEmbedUrl(symbol, marketType, timeframe)}
        style={{ width: '100%', height: 460, border: 0, display: 'block' }}
        loading="lazy"
      />
    </div>
  );
}

function CalibrationHintBox({ hints }) {
  if (!hints) return null;
  const calibration = familyCalibrationMeta(hints);
  const border = calibration.edgeTone === 'strong'
    ? '#22c55e'
    : calibration.edgeTone === 'weak'
      ? '#eab308'
      : '#64748b';
  return (
    <div style={{ border: `1px solid ${border}55`, background: 'rgba(148,163,184,0.06)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Historisk edge</span>
        <strong style={{ color: '#e2e8f0', fontSize: 13 }}>{calibration.edgeLabel}</strong>
      </div>
      <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>{calibration.reasonSv}</div>
      <div style={{ marginTop: 7, color: '#94a3b8', fontSize: 11, fontWeight: 750 }}>{calibration.priorityBiasLabel}</div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ color: '#64748b', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>Tekniska kalibreringsfält</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, marginTop: 7 }}>
          {[
            ['historicalEdge', calibration.historicalEdge],
            ['suggestedPriorityBias', calibration.suggestedPriorityBias],
            ['source', calibration.source],
          ].map(([label, value]) => (
            <div key={label} style={{ border: '1px solid #1e293b', borderRadius: 6, padding: '6px 8px' }}>
              <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800 }}>{label}</div>
              <div style={{ color: '#e2e8f0', fontSize: 11, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{value}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function MarketClosedNotice({ dataFreshness, reasonSv }) {
  if (dataFreshness !== 'MARKET_CLOSED') return null;
  return (
    <div style={{ border: '1px solid rgba(234,179,8,0.35)', background: 'rgba(234,179,8,0.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, color: '#facc15', fontSize: 12, lineHeight: 1.45 }}>
      {reasonSv || 'Visar senaste handelspass. Ingen aktiv live-signal just nu.'}
    </div>
  );
}

function SignalHeader({ symbol, marketType, timeframe, timestamp, matchedTimestamp, signalPrice, currentPrice, decisionTextSv, nextMoveBias, confidence, risk, signalFamilyInfo, familyCalibrationHints, dataFreshness, stockFeedReasonSv }) {
  const detectedAt = matchedTimestamp || timestamp;
  const rows = [
    ['Symbol', symbol],
    ['Marknadstyp', marketType || (isCrypto(symbol) ? 'crypto' : 'stocks')],
    ['Timeframe', timeframe],
    ['signalFamily', signalFamilyInfo.family],
    ['signalSubtype', signalFamilyInfo.subtype],
    ['Signaltyp', signalFamilyInfo.familyLabel],
    ['Undertyp', signalFamilyInfo.subtypeLabel],
    ['Signal upptäckt', detectedAt ? fmtTz(detectedAt, 'UTC') : '–'],
    ['Signalpris', signalPrice != null ? `$${fmtPrice(signalPrice)}` : '–'],
    ['Nuvarande pris', currentPrice != null ? `$${fmtPrice(currentPrice)}` : '–'],
    ['Beslut vid signal', decisionTextSv || '–'],
    ['Nästa 2–5 min', biasSv(nextMoveBias)],
    ['Confidence', confidence ?? '–'],
    ['Risk', riskSv(risk)],
  ];
  const familyBorder = signalFamilyInfo.tone === 'neutral' ? '#475569' : '#6366f1';
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 12 }}>Signalöversikt</div>
      <MarketClosedNotice dataFreshness={dataFreshness} reasonSv={stockFeedReasonSv || 'Visar senaste handelspass. Ingen aktiv live-signal just nu.'} />
      <div style={{ border: `1px solid ${familyBorder}66`, background: signalFamilyInfo.tone === 'neutral' ? 'rgba(148,163,184,0.07)' : 'rgba(99,102,241,0.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Signaltyp</span>
          <strong style={{ color: '#e2e8f0', fontSize: 13 }}>{signalFamilyInfo.familyLabel}</strong>
        </div>
        {signalFamilyInfo.subtype !== 'UNKNOWN' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Undertyp</span>
            <strong style={{ color: '#e2e8f0', fontSize: 13 }}>{signalFamilyInfo.subtypeLabel}</strong>
          </div>
        )}
        <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>{signalFamilyInfo.description}</div>
        {signalFamilyInfo.debugReason && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ color: '#64748b', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>Tekniska detaljer</summary>
            <div style={{ color: '#94a3b8', fontSize: 11, lineHeight: 1.45, marginTop: 6 }}>{signalFamilyInfo.debugReason}</div>
          </details>
        )}
      </div>
      <CalibrationHintBox hints={familyCalibrationHints} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ border: '1px solid #1e293b', background: 'rgba(255,255,255,0.025)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: '#64748b', fontSize: 10, textTransform: 'uppercase', fontWeight: 800, marginBottom: 4 }}>{label}</div>
            <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function analyzeSignalTiming(candles, signalIdx, nextMoveBias) {
  if (signalIdx < 0 || !candles[signalIdx]) return 'Kan inte bedöma om signalen var tidig eller sen.';
  const start = Math.max(0, signalIdx - 30);
  const before = candles.slice(start, signalIdx + 1);
  const first = before[0]?.close;
  const sig = candles[signalIdx]?.close;
  if (!first || !sig) return 'Kan inte bedöma om signalen var tidig eller sen.';
  const prePct = ((sig - first) / first) * 100;
  const bias = biasSv(nextMoveBias);
  if ((bias === 'UP' && prePct > 0.8) || (bias === 'DOWN' && prePct < -0.8)) {
    return `Systemet såg ${bias}, men signalen kom efter en stor rörelse (${prePct >= 0 ? '+' : ''}${prePct.toFixed(2)}%). Därför var risken att jaga hög.`;
  }
  if (Math.abs(prePct) < 0.25) return `Systemet såg ${bias}, och signalen kom innan någon stor rörelse hade hunnit gå.`;
  return `Systemet såg ${bias}. Före signalen hade priset rört sig ${prePct >= 0 ? '+' : ''}${prePct.toFixed(2)}%, vilket gör läget värt att granska manuellt.`;
}

// ── No-signal summary box ─────────────────────────────────────────────────────

function NoSignalSummaryBox({ symbol, timeframe }) {
  const tf = timeframe || '2m';
  return (
    <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
      <div style={{ color: '#f97316', fontWeight: 800, fontSize: 13, marginBottom: 14 }}>
        Senaste grafdata visas. Ingen exakt signalpunkt är vald.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 14 }}>
        {[
          ['Symbol',      symbol || '–'],
          ['Timeframe',   tf],
          ['Visar',       `Senaste ${tf}-data`],
          ['Signalpunkt', 'Saknas'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 10px', border: '1px solid #1e293b' }}>
            <div style={{ color: '#64748b', fontSize: 10, textTransform: 'uppercase', fontWeight: 800, marginBottom: 4 }}>{label}</div>
            <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ background: 'rgba(148,163,184,0.08)', borderRadius: 8, padding: '10px 14px', color: '#94a3b8', fontSize: 12, lineHeight: 1.55 }}>
        Använd grafen för manuell granskning.{' '}
        <strong style={{ color: '#cbd5e1' }}>Öppna från en signal</strong> för att se exakt signalpunkt.
      </div>
    </div>
  );
}

// ── Signal found banner ────────────────────────────────────────────────────────

function SignalFoundBanner({ timestamp, signalPrice, symbol }) {
  return (
    <div style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.4)', borderRadius: 10, padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#f97316' }}>Signal upptäckt här</div>
      {signalPrice != null && (
        <div style={{ fontSize: 12, color: '#e2e8f0' }}>
          Signalpris: <strong style={{ fontFamily: 'monospace', color: '#f97316' }}>${fmtPrice(signalPrice)}</strong>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        Titta på "Vad hände efteråt?" nedan för att se rörelsen efter 5/10/20 min.
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

function AnalystPanel({ analyst, loading, error, outcomeText }) {
  const list = (items) => Array.isArray(items) ? items : items ? [items] : [];
  const Section = ({ title, items }) => {
    const rows = list(items);
    return (
      <div style={{ border: '1px solid #1e293b', background: 'rgba(255,255,255,0.025)', borderRadius: 8, padding: '9px 10px' }}>
        <div style={{ color: '#64748b', fontSize: 10, textTransform: 'uppercase', fontWeight: 800, marginBottom: 6 }}>{title}</div>
        {rows.length ? rows.map((item) => (
          <div key={item} style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45, marginBottom: 4 }}>{item}</div>
        )) : <div style={{ color: '#475569', fontSize: 12 }}>Data saknas.</div>}
      </div>
    );
  };

  if (loading) {
    return (
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
        <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 8 }}>AI-analytiker</div>
        <div style={{ color: '#64748b', fontSize: 12 }}>Hämtar AI-analys...</div>
      </div>
    );
  }

  if (!analyst) {
    return (
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
        <div style={{ fontWeight: 800, color: '#e2e8f0', marginBottom: 8 }}>AI-analytiker</div>
        <div style={{ color: '#64748b', fontSize: 12 }}>{error || 'AI-läge: regelbaserad analys. Signaldata saknas för den här symbolen.'}</div>
      </div>
    );
  }

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 800, color: '#e2e8f0' }}>AI-analytiker</div>
          <div style={{ color: '#64748b', fontSize: 11 }}>{analyst.modeLabel || 'AI-läge: regelbaserad analys'}</div>
        </div>
        <div style={{ color: '#f97316', fontWeight: 800, fontSize: 13 }}>{analyst.verdict} · {analyst.confidence}%</div>
      </div>
      <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{analyst.summarySv}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
        <InfoRow label="Föreslagen status" value={analyst.suggestedStatus || 'unknown'} color="#93c5fd" />
        <InfoRow label="Nuvarande rimlig" value={analyst.currentStatusLooksReasonable ? 'Ja' : 'Nej'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <Section title="Vad systemet såg" items={analyst.whatSystemSees} />
        <Section title="Varför signalen kom" items={analyst.whatSupports} />
        <Section title="Tidigt eller sent" items={analyst.timingAssessmentSv} />
        <Section title="Varningar" items={analyst.whatWarns} />
        <Section title="Bekräftelse saknas" items={analyst.missingConfirmation} />
        <Section title="Historik" items={analyst.historicalContextSv} />
        <Section title="Nästa förbättring" items={analyst.nextImprovementSv} />
        <Section title="Vad hände efteråt" items={outcomeText} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReviewChartPage() {
  const [searchParams] = useSearchParams();
  const symbol      = (searchParams.get('symbol') || '').toUpperCase();
  const timestamp   = searchParams.get('timestamp') || '';
  const signalParam = searchParams.get('signal') || '';
  const signalId    = searchParams.get('signalId') || '';
  const signalFamily = searchParams.get('signalFamily') || '';
  const signalSubtype = searchParams.get('signalSubtype') || '';
  const signalFamilyReasonSv = searchParams.get('signalFamilyReasonSv') || '';
  const dataFreshnessParam = searchParams.get('dataFreshness') || '';
  const stockFeedReasonSvParam = searchParams.get('stockFeedReasonSv') || '';
  const calibrationHistoricalEdge = searchParams.get('calibrationHistoricalEdge') || '';
  const calibrationReasonSv = searchParams.get('calibrationReasonSv') || '';
  const calibrationPriorityBias = searchParams.get('calibrationPriorityBias') || '';
  const calibrationSource = searchParams.get('calibrationSource') || '';
  const timeframe   = searchParams.get('timeframe') || '2m';
  const marketType  = searchParams.get('marketType') || '';
  const tradeScore  = searchParams.get('tradeScore');
  const narrowScore = searchParams.get('narrowScore');
  const priceParam  = searchParams.get('price');
  const decisionTextSv = searchParams.get('decisionTextSv') || '';
  const nextMoveBias = searchParams.get('nextMoveBias') || '';
  const confidence = searchParams.get('confidence');
  const risk = searchParams.get('risk') || '';

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [showSMA, setShowSMA] = useState(true);
  const [analyst, setAnalyst] = useState(null);
  const [analystLoading, setAnalystLoading] = useState(false);
  const [analystError, setAnalystError] = useState(null);
  const [liveSignalMeta, setLiveSignalMeta] = useState(null);

  useEffect(() => {
    if (!symbol) {
      setError('Välj en signal från historiken för att öppna en graf.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    if (!timestamp) {
      const type = normalizeMarketType(symbol, marketType);
      const qs = new URLSearchParams({ symbol, marketType: type, timeframe, limit: '100' });
      fetch(apiUrl(`/api/debug/live-candles?${qs.toString()}`))
        .then(r => r.json())
        .then(json => {
          if (!json.ok) throw new Error(json.error || 'Live candles saknas.');
          setData(liveCandlesToChartData(json));
        })
        .catch(e => {
          setData({
            ok: true,
            symbol,
            candles: [],
            signalCandleIdx: -1,
            hasSMA200: false,
            noExactSignal: true,
            softNoticeSv: e.message || 'Ingen exakt signal-tid vald. Live candles saknas just nu.',
          });
        })
        .finally(() => setLoading(false));
      return;
    }

    const qs = `symbol=${encodeURIComponent(symbol)}&timestamp=${encodeURIComponent(timestamp)}&windowBefore=80&windowAfter=40`;
    fetch(apiUrl(`/api/review/chart-data?${qs}`))
      .then(r => r.json())
      .then(json => {
        if (!json.ok) throw new Error(json.error || 'Okänt fel');
        setData(json);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, timestamp, timeframe, marketType]);

  useEffect(() => {
    if (!symbol) {
      setAnalyst(null);
      return;
    }
    setAnalystLoading(true);
    setAnalystError(null);
    const qs = new URLSearchParams({ symbol, timeframe: '2m' });
    fetch(apiUrl(`/api/ai/signal-analysis?${qs.toString()}`))
      .then(r => r.json().then(json => ({ ok: r.ok, json })))
      .then(({ ok, json }) => {
        if (!ok || !json.ok) {
          setAnalyst(null);
          setAnalystError(json.error || 'AI-data saknas för symbolen.');
          return;
        }
        setAnalyst(json.analyst || null);
      })
      .catch(() => {
        setAnalyst(null);
        setAnalystError('AI-data saknas för symbolen.');
      })
      .finally(() => setAnalystLoading(false));
  }, [symbol]);

  useEffect(() => {
    if (!symbol) {
      setLiveSignalMeta(null);
      return;
    }
    fetch(apiUrl('/api/live/decision-monitor?includeAi=1&familyDebug=1'))
      .then(r => r.json())
      .then(json => {
        if (!json.ok) {
          setLiveSignalMeta(null);
          return;
        }
        const candidate = (json.candidates || []).find(c => String(c.symbol || '').toUpperCase() === symbol);
        setLiveSignalMeta(candidate || null);
      })
      .catch(() => setLiveSignalMeta(null));
  }, [symbol]);

  const candles     = data?.candles ?? [];
  const signalIdx   = data?.signalCandleIdx ?? -1;
  const hasSMA200   = data?.hasSMA200 ?? false;
  const sigCandle   = signalIdx >= 0 ? candles[signalIdx] : null;
  const displayTimestamp = timestamp || data?.latestTimestamp || candles[candles.length - 1]?.ts || '';

  const accentColor = '#f97316';

  const outcome5 = calcOutcome(candles, signalIdx, 3, nextMoveBias);
  const outcome10 = calcOutcome(candles, signalIdx, 5, nextMoveBias);
  const outcome20 = calcOutcome(candles, signalIdx, 10, nextMoveBias);

  const displayPrice = sigCandle?.close ?? (priceParam ? Number(priceParam) : null);
  const currentPrice = priceParam ? Number(priceParam) : null;
  const sma20AtSignal  = sigCandle?.sma20;
  const sma200AtSignal = sigCandle?.sma200;
  const comparisonText = analyzeSignalTiming(candles, signalIdx, nextMoveBias);
  const signalFamilyInfo = signalFamilyMeta({
    signalFamily: signalFamily || liveSignalMeta?.signalFamily,
    signalSubtype: signalSubtype || liveSignalMeta?.signalSubtype,
    signalFamilyReasonSv: signalFamilyReasonSv || liveSignalMeta?.signalFamilyReasonSv,
    familyDebug: liveSignalMeta?.familyDebug,
  });
  const familyCalibrationHints = liveSignalMeta?.familyCalibrationHints || (
    calibrationHistoricalEdge || calibrationReasonSv || calibrationPriorityBias
      ? {
          historicalEdge: calibrationHistoricalEdge || 'unknown',
          reasonSv: calibrationReasonSv,
          suggestedPriorityBias: calibrationPriorityBias || 'keep',
          source: calibrationSource || 'Signal Family Calibration v2',
        }
      : null
  );
  const dataFreshness = liveSignalMeta?.dataFreshness || dataFreshnessParam || '';
  const stockFeedReasonSv = liveSignalMeta?.stockFeedStatus?.reasonSv || stockFeedReasonSvParam || '';
  const analystOutcomeText = signalIdx >= 0
    ? [
      outcome5 ? `Efter 5 min: ${outcome5.summary}, ${outcome5.pct.toFixed(2)}%.` : 'Efter 5 min: data saknas.',
      outcome10 ? `Efter 10 min: ${outcome10.summary}, ${outcome10.pct.toFixed(2)}%.` : 'Efter 10 min: data saknas.',
      outcome20 ? `Efter 20 min: ${outcome20.summary}, ${outcome20.pct.toFixed(2)}%.` : 'Efter 20 min: data saknas.',
    ]
    : 'Vad som hände efteråt kan inte bedömas utan exakt signal-candle.';

  const smaGapPct = sma20AtSignal != null && sma200AtSignal != null
    ? ((sma20AtSignal - sma200AtSignal) / sma200AtSignal * 100)
    : null;

  const scoreColor = s => {
    const n = Number(s);
    return n >= 70 ? '#22c55e' : n >= 40 ? '#eab308' : '#ef4444';
  };

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', padding: '0 0 40px' }}>
      {/* Header */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title" style={{ color: accentColor }}>
            🔍 Granska graf — {symbol || '…'}
          </div>
          <div className="hero-sub">
            {timestamp
              ? 'Visar exakt candle från historiken, så du kan se vad som hände efter signalen.'
              : symbol
                ? 'Ingen exakt signal-tid vald. Visar senaste tillgängliga 2m-data.'
                : 'Välj en signal från historiken eller ange symbol i URL.'}
          </div>
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
          <div className="ux-help-text">Tips: öppna grafen från Historik så följer symbol och tid med automatiskt.</div>
        </div>
      )}

      {!loading && !error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {data.noExactSignal
            ? <NoSignalSummaryBox symbol={symbol} timeframe={timeframe} />
            : <SignalFoundBanner timestamp={displayTimestamp} signalPrice={displayPrice} symbol={symbol} />
          }

          {displayTimestamp && <TimezoneStrip timestamp={displayTimestamp} symbol={symbol} />}

          <SignalHeader
            symbol={symbol}
            marketType={normalizeMarketType(symbol, marketType)}
            timeframe={timeframe}
            timestamp={displayTimestamp}
            matchedTimestamp={data.matchedTimestamp}
            signalPrice={displayPrice}
            currentPrice={currentPrice}
            decisionTextSv={decisionTextSv || signalToSv(signalParam)}
            nextMoveBias={nextMoveBias}
            confidence={confidence}
            risk={risk}
            signalFamilyInfo={signalFamilyInfo}
            familyCalibrationHints={familyCalibrationHints}
            dataFreshness={dataFreshness}
            stockFeedReasonSv={stockFeedReasonSv}
          />

          <div className="review-ai-layout">
            <TradingViewPanel symbol={symbol} marketType={normalizeMarketType(symbol, marketType)} timeframe={timeframe} />
            <AnalystPanel
              analyst={analyst}
              loading={analystLoading}
              error={analystError}
              outcomeText={analystOutcomeText}
            />
          </div>

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
            ? (
              <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ color: '#e2e8f0', fontWeight: 800, fontSize: 13 }}>Intern signalgraf</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>
                  {signalIdx >= 0 ? 'Vår backend-data med markeringen “Signal upptäckt här”.' : 'Vår backend-data utan exakt signalmarkering.'}
                </div>
                  </div>
                  {displayPrice != null && <span style={{ color: '#f97316', fontSize: 12, fontFamily: 'monospace' }}>Signalpris ${fmtPrice(displayPrice)}</span>}
                </div>
                <CandleChart
                  candles={candles}
                  signalCandleIdx={signalIdx}
                  signalType={signalParam}
                  showSMA={showSMA}
                />
              </div>
            )
            : <div className="empty">Ingen grafdata att visa för den här signalen.</div>
          }

          {/* Signal info + Outcomes */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>

            {/* Signal info */}
            <div style={{ background: '#0f172a', border: `1px solid ${accentColor}40`, borderRadius: 10, padding: 18 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: accentColor, fontSize: 13 }}>Signal-info</div>
              <InfoRow label="Symbol" value={symbol} />
              <InfoRow label="Timeframe" value={timeframe} />
              {marketType && <InfoRow label="Market type" value={marketType} />}
              {signalId && <InfoRow label="Signal-id" value={signalId} />}
              <InfoRow label="Signaltyp" value={signalFamilyInfo.familyLabel} />
              {signalFamilyInfo.subtype !== 'UNKNOWN' && <InfoRow label="Undertyp" value={signalFamilyInfo.subtypeLabel} />}
              <InfoRow label="signalFamily" value={signalFamilyInfo.family} />
              <InfoRow label="signalSubtype" value={signalFamilyInfo.subtype} />
              {signalParam && <InfoRow label="Signal" value={signalToSv(signalParam)} color={accentColor} />}
              {decisionTextSv && <InfoRow label="Beslut vid signal" value={decisionTextSv} color={accentColor} />}
              {nextMoveBias && <InfoRow label="Nästa 2–5 min" value={biasSv(nextMoveBias)} color={accentColor} />}
              {confidence != null && <InfoRow label="Confidence" value={confidence} color={scoreColor(confidence)} />}
              {risk && <InfoRow label="Risk" value={riskSv(risk)} />}
              {displayPrice != null && <InfoRow label="Pris vid signal" value={`$${fmtPrice(displayPrice)}`} />}
              {currentPrice != null && <InfoRow label="Nuvarande pris" value={`$${fmtPrice(currentPrice)}`} />}
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
              {data.timestampFallback && data.matchedTimestamp && (
                <div style={{ fontSize: 11, color: '#f97316', marginTop: 8 }}>
                  Exakt tid saknades i sparad data. Visar närmaste tillgängliga 2m-candle: {fmtTz(data.matchedTimestamp, 'UTC', false)} UTC.
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
              <OutcomeRow label="Efter 5 min" outcome={outcome5} />
              <OutcomeRow label="Efter 10 min" outcome={outcome10} />
              <OutcomeRow label="Efter 20 min" outcome={outcome20} />
              <div style={{ marginTop: 12, padding: 10, border: '1px solid #1e293b', borderRadius: 8, color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>
                <strong style={{ color: '#e2e8f0' }}>Jämförelse:</strong> {comparisonText}
              </div>
              {outcome5 == null && outcome10 == null && outcome20 == null && signalIdx >= 0 && (
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
