import React, { useEffect, useState } from 'react';
import {
  resolveStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import { EMPTY_VALUE, numberOrNull } from '../utils/tradingFormatters.js';
import { normalizeSignalForChart } from '../utils/chartSignalUtils.js';
import { getTheme } from './ThemeToggle.jsx';

// Read-only intern chart-panel för /live.
// Visar TradingView-widget + exakt signalpunkt (tid/pris) bredvid.
// Ingen trading-, order-, broker- eller risklogik. live=false alltid.

const DIRECTION_SV = {
  long: '🟢 Lång (upp)',
  up: '🟢 Upp',
  short: '🔴 Kort (ner)',
  down: '🔴 Ner',
};

function tvInterval(timeframe) {
  if (timeframe === null || timeframe === undefined || timeframe === '') return null;
  const tf = String(timeframe || '').toLowerCase();
  if (tf === '1m' || tf === '1') return '1';
  if (tf === '2m' || tf === '2') return '2';
  if (tf === '5m' || tf === '5') return '5';
  if (tf === '15m' || tf === '15') return '15';
  return null;
}

function embedUrl(tvSymbol, timeframe, theme) {
  const interval = tvInterval(timeframe);
  if (!tvSymbol || !interval) return null;
  const qs = new URLSearchParams({
    symbol: tvSymbol,
    interval,
    theme: theme === 'light' ? 'light' : 'dark',
    style: '1',
    timezone: 'Europe/Stockholm',
    withdateranges: '1',
    hide_side_toolbar: '0',
    allow_symbol_change: '0',
    save_image: '0',
  });
  return `https://www.tradingview.com/widgetembed/?${qs.toString()}`;
}

function priceText(price) {
  const n = numberOrNull(price);
  if (n === null) return EMPTY_VALUE;
  const dec = n > 100 ? 2 : n > 1 ? 3 : 5;
  return n.toFixed(dec);
}

function marketLabel(marketType) {
  if (marketType === 'crypto') return 'Krypto';
  if (marketType === 'stock') return 'Aktie';
  return EMPTY_VALUE;
}

function Row({ label, value }) {
  return (
    <div className="tvsp-row">
      <span className="tvsp-row-label">{label}</span>
      <span className="tvsp-row-value">{value ?? EMPTY_VALUE}</span>
    </div>
  );
}

export default function TradingViewSignalPanel({ signal, onClose }) {
  const [theme, setTheme] = useState(getTheme);

  useEffect(() => {
    function handler(e) { setTheme(e.detail || 'dark'); }
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  // Stäng med Escape.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!signal) return null;
  // Acceptera både normaliserad och rå signal (idempotent).
  const sig = signal.tvSymbol ? signal : normalizeSignalForChart(signal);
  const direction = DIRECTION_SV[sig.direction] || (sig.direction ? String(sig.direction) : EMPTY_VALUE);
  const chartUrl = embedUrl(sig.tvSymbol, sig.timeframe, theme);

  return (
    <div className="tvsp-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tvsp-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tvsp-header">
          <div className="tvsp-title">
            <span className="tvsp-title-main">Chart — {sig.symbol || EMPTY_VALUE}</span>
            <span className="tvsp-title-sub">{sig.tvSymbol || EMPTY_VALUE} · {sig.timeframe || EMPTY_VALUE}</span>
          </div>
          <button className="tvsp-close" onClick={onClose} aria-label="Stäng chart">✕</button>
        </div>

        <div className="tvsp-body">
          {/* Chart */}
          <div className="tvsp-chart">
            {chartUrl ? (
              <iframe
                key={`${sig.tvSymbol}-${sig.timeframe}-${theme}`}
                title={`TradingView ${sig.tvSymbol}`}
                src={chartUrl}
                className="tvsp-iframe"
                loading="lazy"
              />
            ) : (
              <div className="tvsp-iframe" style={{ display: 'grid', placeItems: 'center', color: 'var(--muted)', background: 'var(--surface-2)' }}>
                TradingView-data saknar symbol eller timeframe.
              </div>
            )}
            <div className="tvsp-chart-note">
              TradingView visar symbolen. Exakt signalpunkt visas i panelen.
            </div>
          </div>

          {/* Signalpunkt */}
          <div className="tvsp-signal">
            <div className="tvsp-signal-head">Här kom signalen</div>

            <div className={`tvsp-marker ${sig.markerReady ? 'tvsp-marker-ok' : 'tvsp-marker-missing'}`}>
              {sig.markerReady
                ? 'Exakt signalpunkt finns — tid + pris.'
                : (sig.markerMissingReason ? `Exakt signalpunkt saknas eftersom: ${sig.markerMissingReason}` : 'Exakt signalpunkt saknas.')}
            </div>

            <Row label="Tid" value={sig.displayTime} />
            <Row label="Pris" value={priceText(sig.price)} />
            <Row label="Strategi" value={strategyDisplayName(resolveStrategy(sig), '—')} />
            <Row label="Riktning" value={direction} />
            <Row label="Score" value={sig.score ?? sig.confidence} />
            <Row label="Timeframe" value={sig.timeframe} />
            <Row label="Symbol" value={sig.symbol} />
            <Row label="TradingView-symbol" value={sig.tvSymbol} />
            <Row label="Marknad" value={marketLabel(sig.marketType)} />

            {sig.exchangeAssumed && sig.exchangeAssumedText && (
              <div className="tvsp-assumed">{sig.exchangeAssumedText}</div>
            )}

            {sig.reason && (
              <div className="tvsp-reason">
                <div className="tvsp-reason-label">Varför signalen kom</div>
                <div className="tvsp-reason-text">{sig.reason}</div>
              </div>
            )}

            {sig.externalTradingViewUrl ? (
              <a
                className="tvsp-external"
                href={sig.externalTradingViewUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Öppna på tradingview.com ↗
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
