import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, createChart, createSeriesMarkers } from 'lightweight-charts';
import {
  EMPTY_VALUE,
  fmtMoney,
  hasValue,
} from '../utils/tradingFormatters.js';

function fmtTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toUnixSeconds(value) {
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  return Math.floor(time / 1000);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizePrice(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatPnl(value, currency) {
  if (!hasValue(value)) return EMPTY_VALUE;
  return fmtMoney(value, currency, 0);
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueSymbols({ instruments = [], openPositions = [], closedTrades = [] }) {
  const candidates = [
    ...safeArray(instruments).map((row) => normalizeSymbol(row.symbol || row.root)),
    ...safeArray(openPositions).map((row) => normalizeSymbol(row.symbol || row.root)),
    ...safeArray(closedTrades).map((row) => normalizeSymbol(row.symbol || row.root)),
  ].filter(Boolean);
  const deduped = Array.from(new Set(candidates));
  return deduped;
}

function buildPreviewSeries({ symbol, openPositions = [], closedTrades = [] }) {
  const selected = normalizeSymbol(symbol);
  const positions = safeArray(openPositions).filter((row) => normalizeSymbol(row.symbol || row.root) === selected);
  const trades = safeArray(closedTrades).filter((row) => normalizeSymbol(row.symbol || row.root) === selected);

  const events = [];
  positions.forEach((position) => {
    const openedAt = toUnixSeconds(position.openedAt);
    const entryPrice = normalizePrice(position.entryPrice);
    if (openedAt && entryPrice) {
      events.push({
        time: openedAt,
        price: entryPrice,
        kind: 'entry',
        label: 'Entry',
        side: position.side,
        tradeId: position.tradeId,
      });
    }
    const stopLoss = normalizePrice(position.stopLoss);
    if (openedAt && stopLoss) {
      events.push({
        time: openedAt + 30,
        price: stopLoss,
        kind: 'stop_loss',
        label: 'Stop Loss',
        side: position.side,
        tradeId: position.tradeId,
      });
    }
    const takeProfit = normalizePrice(position.takeProfit);
    if (openedAt && takeProfit) {
      events.push({
        time: openedAt + 60,
        price: takeProfit,
        kind: 'take_profit',
        label: 'Take Profit',
        side: position.side,
        tradeId: position.tradeId,
      });
    }
    const currentPrice = normalizePrice(position.currentPrice);
    if (openedAt && currentPrice && currentPrice !== entryPrice) {
      events.push({
        time: openedAt + 90,
        price: currentPrice,
        kind: 'current',
        label: 'Current',
        side: position.side,
        tradeId: position.tradeId,
      });
    }
    if (openedAt && position.strategyId) {
      events.push({
        time: openedAt + 1,
        price: entryPrice ?? currentPrice,
        kind: 'strategy',
        label: `Strategy: ${position.strategyId}`,
        side: position.side,
        tradeId: position.tradeId,
      });
    }
  });

  trades.forEach((trade) => {
    const openedAt = toUnixSeconds(trade.openedAt);
    const closedAt = toUnixSeconds(trade.closedAt);
    const entryPrice = normalizePrice(trade.entryPrice);
    const exitPrice = normalizePrice(trade.exitPrice ?? trade.currentPrice);
    const rawSide = String(trade.side || '').toLowerCase();
    const side = rawSide === 'short' ? 'short' : rawSide === 'long' ? 'long' : null;
    if (openedAt && entryPrice) {
      events.push({
        time: openedAt,
        price: entryPrice,
        kind: 'entry',
        label: 'Entry',
        side,
        tradeId: trade.tradeId,
      });
    }
    if (closedAt && exitPrice) {
      events.push({
        time: closedAt,
        price: exitPrice,
        kind: 'exit',
        label: 'Exit',
        side,
        tradeId: trade.tradeId,
      });
    }
    const stopLoss = normalizePrice(trade.stopLoss);
    if (openedAt && stopLoss) {
      events.push({
        time: openedAt + 30,
        price: stopLoss,
        kind: 'stop_loss',
        label: 'Stop Loss',
        side,
        tradeId: trade.tradeId,
      });
    }
    const takeProfit = normalizePrice(trade.takeProfit);
    if (openedAt && takeProfit) {
      events.push({
        time: openedAt + 60,
        price: takeProfit,
        kind: 'take_profit',
        label: 'Take Profit',
        side,
        tradeId: trade.tradeId,
      });
    }
    if (openedAt && trade.strategyId) {
      events.push({
        time: openedAt + 1,
        price: entryPrice ?? exitPrice,
        kind: 'strategy',
        label: `Strategy: ${trade.strategyId}`,
        side,
        tradeId: trade.tradeId,
      });
    }
  });

  const sortedEvents = events
    .filter((event) => Number.isFinite(event.time) && Number.isFinite(event.price))
    .sort((a, b) => a.time - b.time || String(a.kind).localeCompare(String(b.kind)));

  if (!sortedEvents.length) {
    return {
      selected,
      candles: [],
      markers: [],
      mode: 'empty',
    };
  }

  return { selected, candles: [], markers: [], mode: 'events_only' };
}

function badgeStyle(tone = 'neutral') {
  const tones = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text)', border: 'var(--border)' },
    success: { bg: 'rgba(34,197,94,0.12)', fg: 'var(--success)', border: 'rgba(34,197,94,0.30)' },
    warning: { bg: 'rgba(245,158,11,0.12)', fg: 'var(--warning)', border: 'rgba(245,158,11,0.30)' },
    danger: { bg: 'rgba(239,68,68,0.12)', fg: 'var(--danger)', border: 'rgba(239,68,68,0.30)' },
    info: { bg: 'rgba(59,130,246,0.12)', fg: 'var(--accent)', border: 'rgba(59,130,246,0.30)' },
  };
  return tones[tone] || tones.neutral;
}

function Badge({ tone = 'neutral', children }) {
  const style = badgeStyle(tone);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.fg,
        fontSize: 11,
        fontWeight: 800,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function ListItem({ title, subtitle, meta, onView, actionLabel = 'Visa' }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: 12,
      background: 'var(--surface-2)',
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          {subtitle ? <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>{subtitle}</div> : null}
        </div>
        {onView ? <button type="button" className="btn" onClick={onView} style={{ padding: '6px 10px', fontSize: 12 }}>{actionLabel}</button> : null}
      </div>
      {meta ? <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45 }}>{meta}</div> : null}
    </div>
  );
}

export default function FuturesPaperChart({
  instruments = [],
  openPositions = [],
  closedTrades = [],
  accountCurrency = null,
  onClosePosition = null,
}) {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const symbols = useMemo(() => uniqueSymbols({ instruments, openPositions, closedTrades }), [instruments, openPositions, closedTrades]);
  const [selectedSymbol, setSelectedSymbol] = useState(symbols[0] || '');
  const [closeDrafts, setCloseDrafts] = useState({});
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);

  useEffect(() => {
    if (!symbols.includes(selectedSymbol)) {
      setSelectedSymbol(symbols[0] || '');
    }
  }, [symbols, selectedSymbol]);

  const chartData = useMemo(() => buildPreviewSeries({
    symbol: selectedSymbol,
    openPositions,
    closedTrades,
  }), [selectedSymbol, openPositions, closedTrades]);

  const selectedOpenPositions = useMemo(() => safeArray(openPositions).filter((row) => normalizeSymbol(row.symbol || row.root) === selectedSymbol), [openPositions, selectedSymbol]);
  const selectedClosedTrades = useMemo(() => safeArray(closedTrades).filter((row) => normalizeSymbol(row.symbol || row.root) === selectedSymbol), [closedTrades, selectedSymbol]);
  const isStacked = viewportWidth < 1100;
  const chartHeight = viewportWidth < 768 ? 320 : 420;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize, { passive: true });
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setCloseDrafts((current) => {
      const next = { ...current };
      selectedOpenPositions.forEach((position) => {
        if (next[position.tradeId] == null) {
          next[position.tradeId] = String(normalizePrice(position.currentPrice ?? position.entryPrice) ?? '');
        }
      });
      return next;
    });
  }, [selectedOpenPositions]);

  useEffect(() => {
    if (!containerRef.current || !chartData.candles.length) {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
      }
      return undefined;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: 'var(--text)',
        fontFamily: 'inherit',
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.14)' },
        horzLines: { color: 'rgba(148,163,184,0.14)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(148,163,184,0.5)', labelBackgroundColor: '#0f172a' },
        horzLine: { color: 'rgba(148,163,184,0.5)', labelBackgroundColor: '#0f172a' },
      },
      timeScale: {
        borderColor: 'var(--border)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: 'var(--border)' },
      width: containerRef.current.clientWidth,
      height: chartHeight,
      localization: {
        timeFormatter: (time) => fmtTime(Number.isFinite(time) ? time * 1000 : time),
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceLineVisible: true,
      lastValueVisible: true,
    });

    candleSeries.setData(chartData.candles);
    const lastCandle = chartData.candles[chartData.candles.length - 1];
    candleSeries.createPriceLine({
      price: lastCandle?.close,
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'Preview-serie',
    });

    if (chartData.markers.length) {
      createSeriesMarkers(candleSeries, chartData.markers);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chart) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    return () => {
      ro.disconnect();
      candleSeriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [chartData, chartHeight]);

  const centeredSelection = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  };

  const currentTone = chartData.mode === 'events_only' ? 'info' : 'warning';

  return (
    <section style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 16,
      padding: 16,
      boxShadow: 'var(--shadow-1, none)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Trading Chart</div>
          <h2 style={{ margin: '4px 0 0', fontSize: 20, lineHeight: 1.2 }}>Paper-simulation</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>
            Endast paper-simulation. Charten kan inte skicka order.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone="neutral">Symboler {symbols.length ? symbols.length : EMPTY_VALUE}</Badge>
          <Badge tone={currentTone}>{chartData.mode === 'events_only' ? 'Backend saknar candles' : 'Ingen chartdata ännu'}</Badge>
          <button type="button" className="btn" onClick={centeredSelection} disabled={!chartData.candles.length}>Centrera chart</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {symbols.map((symbol) => (
          <button
            key={symbol}
            type="button"
            className="btn"
            onClick={() => setSelectedSymbol(symbol)}
            style={{
              padding: '8px 12px',
              fontSize: 12,
              opacity: symbol === selectedSymbol ? 1 : 0.7,
              borderColor: symbol === selectedSymbol ? 'var(--accent)' : undefined,
            }}
          >
            {symbol}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Badge tone="info">Entry</Badge>
        <Badge tone="success">Exit</Badge>
        <Badge tone="warning">Stop Loss</Badge>
        <Badge tone="neutral">Take Profit</Badge>
        <Badge tone="info">Strategy</Badge>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isStacked ? '1fr' : 'minmax(0, 1.45fr) minmax(280px, 0.85fr)', gap: 14, marginTop: 14 }}>
        <div style={{ minHeight: chartHeight + 40, display: 'grid', alignItems: 'stretch' }}>
          {chartData.candles.length ? (
            <div ref={containerRef} style={{ width: '100%', minHeight: chartHeight, borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--surface-2)' }} />
          ) : (
            <div style={{
              minHeight: chartHeight,
              borderRadius: 14,
              border: '1px dashed var(--border)',
              background: 'var(--surface-2)',
              display: 'grid',
              placeItems: 'center',
              padding: 24,
              textAlign: 'center',
            }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>Ingen chartdata ännu</div>
                <div style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, lineHeight: 1.5, maxWidth: 480 }}>
                  Backend levererar inte en marknadsserie till denna panel. Öppna positioner och stängda trades visas i listorna utan syntetiska candles.
                </div>
              </div>
            </div>
          )}
        </div>

        <aside style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
              <strong>Öppna positioner</strong>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{selectedOpenPositions.length}</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {selectedOpenPositions.length ? selectedOpenPositions.slice(0, 4).map((position) => (
                <div
                  key={position.tradeId}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: 12,
                    background: 'var(--surface-2)',
                    display: 'grid',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{`${position.symbol || position.root || EMPTY_VALUE} · ${position.side || EMPTY_VALUE}`}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
                        Entry {normalizePrice(position.entryPrice)?.toFixed(2) || '–'} · Current {normalizePrice(position.currentPrice)?.toFixed(2) || '–'}
                      </div>
                    </div>
                    <button type="button" className="btn" onClick={() => setSelectedSymbol(normalizeSymbol(position.symbol || position.root))} style={{ padding: '6px 10px', fontSize: 12 }}>
                      Visa position
                    </button>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45 }}>
                    SL {normalizePrice(position.stopLoss)?.toFixed(2) || '–'} · TP {normalizePrice(position.takeProfit)?.toFixed(2) || '–'} · PnL {formatPnl(position.unrealizedPnlSek, accountCurrency)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>Stängningspris</span>
                      <input
                        type="number"
                        min="0"
                        step="0.25"
                        value={closeDrafts[position.tradeId] ?? ''}
                        onChange={(event) => setCloseDrafts((current) => ({ ...current, [position.tradeId]: event.target.value }))}
                        style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onClosePosition && onClosePosition(position.tradeId, closeDrafts[position.tradeId])}
                      disabled={!onClosePosition}
                    >
                      Stäng simulerad position
                    </button>
                  </div>
                </div>
              )) : (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>Inga öppna positioner för vald symbol.</div>
              )}
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
              <strong>Senaste stängda trades</strong>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{selectedClosedTrades.length}</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {selectedClosedTrades.length ? selectedClosedTrades.slice(-4).reverse().map((trade) => (
                <ListItem
                  key={trade.tradeId}
                  title={`${trade.symbol || trade.root || EMPTY_VALUE} · ${trade.side || EMPTY_VALUE}`}
                  subtitle={`Entry ${normalizePrice(trade.entryPrice)?.toFixed(2) || '–'} · Exit ${normalizePrice(trade.exitPrice ?? trade.currentPrice)?.toFixed(2) || '–'}`}
                  meta={`PnL ${formatPnl(trade.realizedPnlSek, accountCurrency)} · ${fmtTime(trade.closedAt || trade.openedAt)}`}
                  onView={() => setSelectedSymbol(normalizeSymbol(trade.symbol || trade.root))}
                  actionLabel="Visa trade"
                />
              )) : (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>Inga stängda trades för vald symbol.</div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
