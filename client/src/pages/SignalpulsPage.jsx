import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { enrichWithDecisions, getBestSignal, getTopN, isAvoidSignal } from '../decisionEngine.js';
import { SignalAge, SignalImportanceTimes, TradingViewLink } from '../shared.jsx';
import { AdvancedModeToggle, ConfigScopeBadge, PlatformEmptyState, PlatformSafetyBar, useAdvancedMode } from '../components/PlatformControls.jsx';
import TradeReplayPanel from '../components/TradeReplayPanel.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const REFRESH_MS = 15_000;

// ── Signal → strategy key mapper (mirrors backend) ────────────────────────────
function signalToStrategyKey(r) {
  const f = (r?.signalFamily || '').toUpperCase();
  const s = (r?.signalSubtype  || '').toUpperCase();
  if (f.includes('VWAP')) {
    if (s.includes('UP') || s.includes('RECLAIM'))  return 'vwap_reclaim';
    if (s.includes('DOWN') || s.includes('REJECT')) return 'vwap_rejection';
    return 'vwap_reclaim';
  }
  if (f.includes('EMA'))       return 'ema_trend';
  if (f.includes('NARROW'))    return 'narrow_state';
  if (f.includes('BREAKOUT'))  return 'breakout';
  if (f.includes('MOMENTUM'))  return 'momentum';
  if (f.includes('REVERSION') || f.includes('REVERSAL')) return 'mean_reversion';
  return null;
}

const STRATEGY_LABELS_FE = {
  vwap_reclaim:           'VWAP-återtagning',
  vwap_rejection:         'VWAP-avvisning',
  ema_trend:              'EMA-trend',
  ema_pullback:           'EMA-rekyl',
  narrow_state:           'Narrow State',
  breakout:               'Utbrott',
  momentum:               'Stark rörelse',
  mean_reversion:         'Återgång',
  volume_spike:           'Volymtopp',
  vwap_momentum:          'VWAP Stark rörelse',
  opening_range_breakout: 'Opening Range',
  pullback_continuation:  'Pullback',
  mean_reversion_vwap:    'MR VWAP',
  volume_spike_momentum:  'Volym+Stark rörelse',
  index_trend_mode:       'Index-trend',
  sector_confirmation:    'Sektorkonfirmation',
  news_volatility_watch:  'Nyhets-vola',
};

// ── Signal Pulse Score 0-100 ──────────────────────────────────────────────────
function computePulseScore(r, learningSummary, regimeSummary, adaptiveMode) {
  if (!r) return 0;
  const base = r.tradeScore ?? 0;
  const ls = learningSummary || {};
  const symStats = ls.bySymbol?.[r.symbol];
  const symWR = symStats?.winRate != null ? Math.round(symStats.winRate * 100) : null;

  let score = base * 0.7;

  // Narrow state bonus
  if (r.state === 'HIGH_QUALITY_NARROW') score += 12;
  else if (r.state === 'MEDIUM_NARROW') score += 6;

  // Volume bonus
  const rv = r.relVol20 ?? 0;
  if (rv >= 2) score += 8;
  else if (rv >= 1.5) score += 5;
  else if (rv >= 1) score += 2;

  // History bonus
  if (symWR !== null) {
    if (symWR >= 60) score += 8;
    else if (symWR >= 50) score += 4;
    else if (symWR < 40) score -= 5;
  }

  // AI/agent boost
  if (r.aiAnalysis?.confidence >= 0.7 || r.agentScore >= 70) score += 5;
  if (r.strategy_performance?.priority_adjustment) score += Number(r.strategy_performance.priority_adjustment) || 0;

  // Penalties
  if (['CHOPPY', 'HIGH_VOLATILITY', 'PANIC'].includes(r.marketRegime)) score -= 10;
  if ((r.relVol20 ?? 1) < 0.7) score -= 5;
  if (isAvoidSignal(r)) score -= 30;
  if (r.fakeoutProbability >= 70) score -= 10;

  // Adaptive regime bonus (when adaptive mode enabled)
  if (adaptiveMode && regimeSummary?.strategyWeights?.weights) {
    const stratKey = signalToStrategyKey(r);
    if (stratKey) {
      const sw = regimeSummary.strategyWeights.weights.find(w => w.key === stratKey);
      if (sw) score += Math.round(sw.regimeAdj * 0.65);
    }
    // Index confirmation
    const sig = r.signal || '';
    const isLong = sig.startsWith('LONG') || r.momentumBias === 'bullish';
    const ibOverall = regimeSummary.indexBias?.overall;
    if (ibOverall === 'bullish' && isLong) score += 5;
    if (ibOverall === 'bearish' && !isLong) score += 5;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

function pulseStatus(r) {
  if (!r) return 'VÄNTA';
  const sig = r.signal || '';
  if (isAvoidSignal(r)) return 'VARNING';
  if (sig.startsWith('LONG_TRIGGERED')) return 'KÖP';
  if (sig.startsWith('SHORT_TRIGGERED')) return 'SÄLJ';
  if (sig.startsWith('LONG') || r.momentumBias === 'bullish') return 'BULLISH';
  if (sig.startsWith('SHORT') || r.momentumBias === 'bearish') return 'BEARISH';
  return 'VÄNTA';
}

function pulseStatusClass(status) {
  if (status === 'KÖP') return 'sp-buy';
  if (status === 'SÄLJ') return 'sp-sell';
  if (status === 'BULLISH') return 'sp-bullish';
  if (status === 'BEARISH') return 'sp-bearish';
  if (status === 'VARNING') return 'sp-warning';
  return 'sp-wait';
}

function marketTypeSv(r) {
  if (!r) return '';
  const mt = r.marketType || r.market || '';
  if (mt === 'crypto') return 'Krypto';
  if (mt === 'stocks' || mt === 'stock') return 'Aktier';
  if (mt === 'nasdaq') return 'Nasdaq';
  if (mt === 'etf') return 'ETF';
  return mt;
}

function mainMethodSv(r) {
  if (!r) return '–';
  if (r.strategy_name) return r.strategy_name;
  if (r.state === 'HIGH_QUALITY_NARROW') return 'Narrow State';
  if (r.state === 'MEDIUM_NARROW') return 'Narrow';
  if (r.narrowType === 'coil_flat') return 'Coil/Flat';
  if (r.narrowType === 'attack_200') return 'Attack 200';
  const sf = r.signalFamily || r.eventType || '';
  return sf.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '–';
}

function shortExplanation(r, ls) {
  if (!r) return '';
  const factors = [];
  if (r.state === 'HIGH_QUALITY_NARROW') factors.push('Narrow state');
  if ((r.relVol20 ?? 0) >= 1.5) factors.push('Stark volym');
  const symStats = ls?.bySymbol?.[r.symbol];
  const symWR = symStats?.winRate != null ? Math.round(symStats.winRate * 100) : null;
  if (symWR !== null && symWR >= 55) factors.push(`${symWR}% historisk träffsäkerhet`);
  if (r.strategy_performance_message) factors.push(r.strategy_performance_message);
  if (r.signal?.includes('TRIGGERED')) factors.push('Signal triggrad');
  if (factors.length) return factors.join(' · ');
  return r.actionSv || r.scoreExplanationSv?.[0] || 'Systemet bevakar läget.';
}

function directionSv(r) {
  const sig = r?.signal || '';
  if (sig.startsWith('LONG') || r?.momentumBias === 'bullish') return '▲ Uppåt';
  if (sig.startsWith('SHORT') || r?.momentumBias === 'bearish') return '▼ Nedåt';
  return '→ Neutral';
}

function warningsSv(r) {
  const ws = [];
  if (isAvoidSignal(r)) ws.push('Blockerad');
  if ((r?.fakeoutProbability ?? 0) >= 60) ws.push('Fakeout-risk');
  if (['CHOPPY', 'PANIC'].includes(r?.marketRegime)) ws.push('Stökig marknad');
  if ((r?.relVol20 ?? 1) < 0.7) ws.push('Svag volym');
  return ws;
}

// ── Data hooks ────────────────────────────────────────────────────────────────
function useAllSignals() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);
  // Rå svarsmetadata per marknad (lastScan, feedStatus, scanning) — bevaras så att UI kan visa
  // datakällans VERKLIGA ålder, inte bara klientens refresh-klocka.
  const [meta, setMeta] = useState({ stocks: null, crypto: null, nasdaq: null });

  const fetchAll = useCallback(async () => {
    try {
      const [s, c, n] = await Promise.all([
        fetch('/api/scan/stocks').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/scan/crypto').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/scan/nasdaq').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const all = [
        ...(s?.results || []),
        ...(c?.results || []),
        ...(n?.results || []),
      ];
      setSignals(all);
      setMeta({ stocks: s, crypto: c, nasdaq: n });
      setLastFetch(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchAll]);

  return { signals, loading, lastFetch, meta, refresh: fetchAll };
}

function useLearningSummary() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/learning-summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);
  return data;
}

function useSetupPerformance() {
  return useUnifiedConfig('results').test.setupPerformance;
}

function useMarketRegime() {
  return useUnifiedConfig('marketRegime').test.marketRegime;
}

function useAuditSummary() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/audit/summary')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (alive && d?.ok) setSummary(d); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return summary;
}

function fmtAuditTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function secondsLabel(seconds) {
  if (seconds == null) return '–';
  if (seconds < 60) return `${seconds} sek sedan`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min sedan`;
  return `${Math.floor(minutes / 60)} h sedan`;
}

function AuditActivityPanel({ summary }) {
  const [selectedTradeId, setSelectedTradeId] = useState('');
  const latest = summary?.latest || {};
  const rows = [
    latest.signal,
    latest.candidate,
    latest.paper_trade_opened,
    latest.paper_trade_closed,
    latest.batch,
    latest.blocker,
  ].filter(Boolean);

  function replayIdForEvent(event) {
    return event?.details?.trade_id || event?.details?.tradeId || event?.details?.paper_event_id || event?.event_id || '';
  }

  function isPaperTradeEvent(event) {
    return ['PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED'].includes(String(event?.type || '').toUpperCase());
  }

  return (
    <div className="sp-activity-panel">
      <div className="sp-activity-head">
        <div>
          <h2>Senaste aktivitet</h2>
          <span>Paper/replay audit</span>
        </div>
        <ConfigScopeBadge scope="test" />
      </div>

      <div className="sp-work-status">
        <strong>Systemet jobbar</strong>
        <span>Senaste scan: {secondsLabel(summary?.last_scan_seconds_ago)}</span>
        <span>Kandidater senaste 15 min: {summary?.candidates_last_15m ?? 0}</span>
        <span>Trades senaste 15 min: {summary?.trades_last_15m ?? 0}</span>
        <span>Batchar idag: {summary?.batches_today ?? 0}</span>
        <span>Senaste trade-tid: {summary?.latest_trade_at ? fmtAuditTime(summary.latest_trade_at) : '–'}</span>
      </div>

      {rows.length > 0 ? (
        <div className="sp-activity-list">
          {rows.map((event) => (
            <div key={event.event_id} className="sp-activity-row">
              <span>{fmtAuditTime(event.timestamp)}</span>
              <strong>{event.symbol || event.details?.batch_id || 'System'}</strong>
              <em>{event.message || event.type}</em>
              {isPaperTradeEvent(event) && (
                <button className="sp-mini-action" type="button" onClick={() => setSelectedTradeId(replayIdForEvent(event))}>
                  Visa trade
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="sp-activity-empty">Inga nya trades ännu. Systemet väntar på bättre signaler.</div>
      )}
      <TradeReplayPanel tradeId={selectedTradeId} onClose={() => setSelectedTradeId('')} />
    </div>
  );
}

// ── Market Bias Panel ─────────────────────────────────────────────────────────
function MarketBiasPanel({ regimeSummary, adaptiveMode, onToggleAdaptive, advancedMode }) {
  if (!regimeSummary) return null;
  const {
    regimeMeta, regimeLabelSv, regimeIcon, volatilityLabelSv,
    trendLabelSv, riskEnvLabelSv, indexBias, strategyWeights, regimeScore,
    recommendations, heatmap,
  } = regimeSummary;

  const [showDetail, setShowDetail] = useState(false);
  const overallColor = indexBias?.overall === 'bullish' ? '#22c55e'
    : indexBias?.overall === 'bearish' ? '#ef4444' : '#f59e0b';

  return (
    <div className="ami-panel">
      {/* Header row */}
      <div className="ami-header-row">
        <div className="ami-header-left">
          <span className="ami-globe">🌍</span>
          <span className="ami-header-title">Marknadsläge just nu</span>
          <ConfigScopeBadge scope="test" />
          <span className={`ami-conf ami-conf-${regimeScore?.confidence}`}>
            {regimeScore?.confidence === 'high' ? 'Hög säkerhet' : regimeScore?.confidence === 'medium' ? 'Medium' : 'Låg säkerhet'}
          </span>
        </div>
        <div className="ami-header-right">
          {advancedMode && (
            <button
              className={`ami-adaptive-toggle${adaptiveMode ? ' ami-toggle-on' : ''}`}
              onClick={onToggleAdaptive}
              title="Slå på/av dynamisk prioritering"
              type="button"
            >
              🧠 Dynamisk prioritering {adaptiveMode ? 'PÅ' : 'AV'}
            </button>
          )}
          <button className="ami-detail-btn" onClick={() => setShowDetail(v => !v)} type="button">
            {showDetail ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Regime badge */}
      <div className="ami-regime-strip">
        <span className="ami-regime-icon">{regimeIcon}</span>
        <div className="ami-regime-info">
          <span className="ami-regime-name" style={{ color: regimeMeta?.color || '#fff' }}>{regimeLabelSv}</span>
          <span className="ami-regime-desc">{regimeMeta?.descSv}</span>
        </div>
        <div className="ami-regime-score-badge">
          <div className="ami-rs-num" style={{ color: regimeMeta?.color || '#fff' }}>{regimeScore?.score}</div>
          <div className="ami-rs-lbl">/ 100</div>
        </div>
      </div>

      {/* Index row */}
      <div className="ami-index-row">
        {[
          { key: 'nasdaq', label: 'QQQ',    d: indexBias?.nasdaq },
          { key: 'sp500',  label: 'S&P',    d: indexBias?.sp500 },
          { key: 'crypto', label: 'Krypto', d: indexBias?.crypto },
        ].map(({ key, label, d }) => d && (
          <div key={key} className={`ami-idx-chip ami-idx-${d.bullish ? 'bull' : 'bear'}`}>
            <span className="ami-idx-label">{label}</span>
            <span className="ami-idx-arrow">{d.bullish ? '▲' : '▼'}</span>
          </div>
        ))}
        <div className="ami-idx-chip" style={{ borderColor: overallColor + '50', color: overallColor }}>
          <span>{riskEnvLabelSv}</span>
        </div>
        <div className="ami-vol-chip">
          <span className="ami-vol-label">{volatilityLabelSv}</span>
        </div>
      </div>

      {/* Strategy bias */}
      {strategyWeights && (
        <div className="ami-strat-row">
          {advancedMode && strategyWeights.topStrategies?.length > 0 && (
            <div className="ami-strat-group">
              <span className="ami-strat-group-label ami-up-lbl">Prioriterade:</span>
              {strategyWeights.topStrategies.slice(0, 3).map(k => (
                <span key={k} className="ami-chip ami-chip-up">{STRATEGY_LABELS_FE[k] || k}</span>
              ))}
            </div>
          )}
          {advancedMode && strategyWeights.bottomStrategies?.length > 0 && (
            <div className="ami-strat-group">
              <span className="ami-strat-group-label ami-down-lbl">Nedviktade:</span>
              {strategyWeights.bottomStrategies.slice(0, 3).map(k => (
                <span key={k} className="ami-chip ami-chip-down">{STRATEGY_LABELS_FE[k] || k}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Detail panel */}
      {(showDetail || advancedMode) && (
        <div className="ami-detail">
          {/* Heatmap */}
          {heatmap?.length > 0 && (
            <div className="ami-heatmap">
              <div className="ami-sub-title">Marknadsheatmap</div>
              <div className="ami-heatmap-grid">
                {heatmap.map(h => (
                  <div
                    key={h.market}
                    className={`ami-hm-cell ami-hm-${h.bias}`}
                  >
                    <div className="ami-hm-icon">{h.icon}</div>
                    <div className="ami-hm-name">{h.market}</div>
                    <div className="ami-hm-bias">{h.bias === 'bullish' ? '▲' : h.bias === 'bearish' ? '▼' : '→'}</div>
                    <div className="ami-hm-vol">{h.volatility === 'high' ? 'Hög vola' : h.volatility === 'low' ? 'Låg vola' : 'Normal'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Recommendations */}
          {recommendations?.length > 0 && (
            <div className="ami-recs">
              <div className="ami-sub-title">Adaptiva insikter</div>
              <div className="ami-rec-list">
                {recommendations.slice(0, 5).map((rec, i) => (
                  <div key={i} className={`ami-rec ami-rec-${rec.priority}`}>
                    <span className="ami-rec-icon">{rec.icon}</span>
                    <span className="ami-rec-text">{rec.textSv}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Regime score details */}
          <div className="ami-detail-meta">
            <span className="ami-meta-chip">Trend: {trendLabelSv}</span>
            <span className="ami-meta-chip">Vola: {volatilityLabelSv}</span>
            <span className="ami-meta-chip">Risk: {riskEnvLabelSv}</span>
            {regimeScore?.staleMins > 10 && (
              <span className="ami-meta-chip ami-meta-stale">Data {regimeScore.staleMins}m gammal</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Regime fit badge for signal rows ──────────────────────────────────────────
function getRegimeFitBadge(signal, regimeSummary) {
  if (!regimeSummary?.strategyWeights?.weights) return null;
  const stratKey = signalToStrategyKey(signal);
  if (!stratKey) return null;
  const sw = regimeSummary.strategyWeights.weights.find(w => w.key === stratKey);
  if (!sw || Math.abs(sw.regimeAdj) < 6) return null;
  if (sw.regimeAdj >= 8)  return { cls: 'ami-fit-good',  label: '🟢 Passar läget' };
  if (sw.regimeAdj <= -8) return { cls: 'ami-fit-bad',   label: '🔴 Svag idag' };
  return { cls: 'ami-fit-mixed', label: '🟡 Blandad' };
}

// ── Pulse Score Gauge ─────────────────────────────────────────────────────────
function PulseGauge({ score }) {
  const color = score >= 70 ? '#22c55e' : score >= 50 ? '#f59e0b' : score >= 30 ? '#3b82f6' : '#94a3b8';
  const r2 = 36, cx = 50, cy = 50;
  const circ = 2 * Math.PI * r2;
  const pct = score / 100;
  const dash = circ * pct;
  return (
    <div className="sp-gauge-wrap">
      <svg width="100" height="100" viewBox="0 0 100 100" className="sp-gauge-svg">
        <circle cx={cx} cy={cy} r={r2} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
        <circle
          cx={cx} cy={cy} r={r2}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * 0.25}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s ease', filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div className="sp-gauge-inner">
        <div className="sp-gauge-score" style={{ color }}>{score}</div>
        <div className="sp-gauge-label">poäng</div>
      </div>
    </div>
  );
}

// ── Pulsating heart ───────────────────────────────────────────────────────────
function PulsingHeart({ active }) {
  return (
    <span className={`sp-heart${active ? ' sp-heart-active' : ''}`}>❤️</span>
  );
}

// ── Live dot ──────────────────────────────────────────────────────────────────
function LiveDot() {
  return <span className="sp-live-dot" title="Live data" />;
}

function DataCoverageBadge({ coverage }) {
  if (!coverage) return null;
  const quality = coverage.data_quality;
  const tone = quality === 'good' ? 'green' : quality === 'missing' || quality === 'missing_provider' ? 'red' : 'yellow';
  const label = quality === 'good' ? 'Data stark' : quality === 'missing' || quality === 'missing_provider' ? 'Saknar historik' : 'Lite historik';
  return <span className={`sp-data-badge sp-data-${tone}`}>{label}</span>;
}

// ── Hero Card ─────────────────────────────────────────────────────────────────
function HeroSignal({ signal, score, ls, coverage, timeline }) {
  if (!signal) {
    return (
      <div className="sp-hero sp-hero-empty">
        <div className="sp-hero-empty-content">
          <PulsingHeart active={false} />
          <div className="sp-hero-empty-title">Inga starka signaler just nu</div>
          <div className="sp-hero-empty-sub">Systemet skannar kontinuerligt — kom tillbaka snart.</div>
        </div>
      </div>
    );
  }

  const status = pulseStatus(signal);
  const statusCls = pulseStatusClass(status);
  const explanation = shortExplanation(signal, ls);
  const direction = directionSv(signal);
  const market = marketTypeSv(signal);
  const strategyBadge = signal.strategy_performance_badge;

  return (
    <div className={`sp-hero ${statusCls}`}>
      <div className="sp-hero-glow" />
      <div className="sp-hero-content">
        <div className="sp-hero-top">
          <div className="sp-hero-label">
            <PulsingHeart active={true} />
            <span>Hetaste signalen just nu</span>
            <LiveDot />
          </div>
          <div className="sp-hero-badge-row">
            <span className={`sp-status-badge ${statusCls}`}>{status}</span>
            {market && <span className="sp-market-badge">{market}</span>}
            <DataCoverageBadge coverage={coverage} />
            {strategyBadge && <span className={`sp-strategy-badge sp-strategy-${strategyBadge.tone}`}>{strategyBadge.label}</span>}
            <span className="sp-paper-badge">Paper</span>
          </div>
        </div>

        <div className="sp-hero-main">
          <div className="sp-hero-left">
            <div className="sp-hero-symbol">{signal.symbol}</div>
            <div className="sp-hero-direction">{direction}</div>
            <div className="sp-hero-why">{explanation}</div>
            <div className="sp-hero-meta-row">
              <SignalAge timestamp={signal.lastUpdate} />
              <TradingViewLink symbol={signal.symbol} marketType={signal.marketType} size="sm" showHint />
            </div>
            <SignalImportanceTimes
              mode="top"
              created={tlFor(timeline, signal.symbol).firstSeen}
              becameTop={tlFor(timeline, signal.symbol).topSeen}
              lastUpdate={signal.lastUpdate}
              marketClosed={signal.marketType !== 'crypto'}
            />
          </div>
          <PulseGauge score={score} />
        </div>
      </div>
    </div>
  );
}

// ── Top 20 signal row ─────────────────────────────────────────────────────────
const MG_COLORS = { crypto: '#f7931a', stocks: '#3b82f6', nasdaq: '#8b5cf6', index: '#06b6d4', leveraged_etf: '#f59e0b', etf: '#06b6d4' };
const MG_LABELS = { crypto: 'Krypto', stocks: 'Aktier', nasdaq: 'Nasdaq', index: 'Index', leveraged_etf: 'Leveraged', etf: 'ETF' };

function SignalRow({ rank, signal, score, ls, regimeSummary, coverage }) {
  const status = pulseStatus(signal);
  const statusCls = pulseStatusClass(status);
  const warnings = warningsSv(signal);
  const method = mainMethodSv(signal);
  const explanation = shortExplanation(signal, ls);
  const direction = directionSv(signal);
  const mg = signal._marketGroup || 'stocks';
  const regimeBadge = getRegimeFitBadge(signal, regimeSummary);
  const priorityReasons = signal._priorityReasons;
  const strategyBadge = signal.strategy_performance_badge;

  return (
    <div className={`sp-row ${statusCls}-row`}>
      <div className="sp-row-rank">#{rank}</div>
      <div className="sp-row-main">
        <div className="sp-row-top">
          <span className="sp-row-symbol">{signal.symbol}</span>
          <span className={`sp-status-badge ${statusCls} sp-status-sm`}>{status}</span>
          <span className="sp-row-direction">{direction}</span>
          <span className="sp-mg-badge" style={{ color: MG_COLORS[mg], borderColor: MG_COLORS[mg] + '40' }}>
            {MG_LABELS[mg] || mg}
          </span>
          <DataCoverageBadge coverage={coverage} />
          {regimeBadge && (
            <span className={`ami-row-badge ${regimeBadge.cls}`}>{regimeBadge.label}</span>
          )}
          {warnings.map(w => (
            <span key={w} className="sp-row-warning">{w}</span>
          ))}
          {strategyBadge && (
            <span className={`sp-strategy-badge sp-strategy-${strategyBadge.tone}`}>{strategyBadge.label}</span>
          )}
          <span className="sp-paper-badge sp-paper-sm">Paper</span>
        </div>
        <div className="sp-row-sub">
          <span className="sp-row-method">{method}</span>
          <span className="sp-row-sep">·</span>
          <span className="sp-row-why">{explanation}</span>
          {signal.strategy_priority_score != null && (
            <>
              <span className="sp-row-sep">·</span>
              <span className="sp-row-why">Strategy priority {signal.strategy_priority_score}</span>
            </>
          )}
          <span className="sp-row-sep">·</span>
          <SignalAge timestamp={signal.lastUpdate} />
          <TradingViewLink symbol={signal.symbol} marketType={signal.marketType} label="TradingView" size="sm" />
        </div>
        {priorityReasons && (
          <div className="sp-row-priority-reasons">
            {(priorityReasons.positive || []).slice(0, 2).map((reason) => <span key={reason}>+ {reason}</span>)}
            {(priorityReasons.negative || []).slice(0, 2).map((reason) => <span key={reason} className="bad">- {reason}</span>)}
          </div>
        )}
      </div>
      <div className="sp-row-score">{signal._priorityScore ?? score}</div>
    </div>
  );
}

// ── Win rate bar ──────────────────────────────────────────────────────────────
function WinBar({ wr }) {
  if (wr == null) return <span className="sp-no-data">Ingen data</span>;
  const pct = Math.max(0, Math.min(100, wr));
  const color = pct >= 58 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div className="sp-winbar">
      <div className="sp-winbar-track">
        <div className="sp-winbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="sp-winbar-label" style={{ color }}>{pct}%</span>
    </div>
  );
}

// ── Setup card (mini) ─────────────────────────────────────────────────────────
function MiniSetupCard({ setup }) {
  const isGood = setup.category === 'top';
  const isBad  = setup.category === 'poor' || setup.category === 'pause';
  const borderColor = isGood ? 'rgba(34,197,94,0.3)' : isBad ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.07)';

  return (
    <div className="sp-setup-card" style={{ borderColor }}>
      <div className="sp-setup-header">
        <div className="sp-setup-label">{setup.label}</div>
        <div className={`sp-setup-pnl ${(setup.avg_pnl_pct ?? 0) >= 0 ? 'sp-pnl-pos' : 'sp-pnl-neg'}`}>
          {(setup.avg_pnl_pct ?? 0) >= 0 ? '+' : ''}{(setup.avg_pnl_pct ?? 0).toFixed(2)}%
        </div>
      </div>
      <WinBar wr={setup.win_rate} />
      <div className="sp-setup-meta">
        <span>{setup.total_trades} trades</span>
        <span className="sp-setup-wins">{setup.wins}v</span>
        <span className="sp-setup-losses">{setup.losses}f</span>
        <span className="sp-setup-ties">{setup.ties ?? 0}t</span>
      </div>
    </div>
  );
}

// ── Safety Banner ─────────────────────────────────────────────────────────────
function SafetyBanner() {
  return (
    <div className="sp-safety-banner">
      <span>🔒</span>
      <span className="sp-safety-green">Riktig handel är avstängd</span>
      <span className="sp-safety-muted">· Bara analys · Inga orders · Paper &amp; Replay only</span>
    </div>
  );
}

// ── Market group helper ───────────────────────────────────────────────────────
const CRYPTO_SYMS  = new Set(['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT']);
const INDEX_SYMS   = new Set(['QQQ','SPY','IWM','DIA']);
const LEVERAGED    = new Set(['TQQQ','SQQQ','SOXL','SOXS','UPRO','SPXU','FNGU','FNGD']);

function getMarketGroup(r) {
  const sym = (r?.symbol || '').toUpperCase();
  if (r?.marketType === 'crypto' || CRYPTO_SYMS.has(sym) || sym.endsWith('USDT') || sym.endsWith('BTC')) return 'crypto';
  if (LEVERAGED.has(sym)) return 'leveraged_etf';
  if (INDEX_SYMS.has(sym) || r?.marketType === 'etf') return 'index';
  if (r?.marketType === 'nasdaq' || r?.market === 'nasdaq') return 'nasdaq';
  return 'stocks';
}

const MARKET_FILTERS = [
  { key: 'all',          label: 'Alla',         icon: '🌍' },
  { key: 'focus',        label: 'Högsta fokus', icon: '🎯' },
  { key: 'stocks',       label: 'Aktier',        icon: '📈' },
  { key: 'crypto',       label: 'Krypto',        icon: '₿'  },
  { key: 'etf',          label: 'ETF',           icon: '▣'  },
  { key: 'nasdaq',       label: 'Nasdaq',        icon: '⚡' },
  { key: 'index',        label: 'Index',         icon: '📊' },
  { key: 'bullish',      label: 'Bullish',       icon: '▲'  },
  { key: 'bearish',      label: 'Bearish',       icon: '▼'  },
  { key: 'low_timeout',  label: 'Låg timeout-risk', icon: '⏱' },
  { key: 'strong_setup', label: 'Starka setups', icon: '◆' },
  { key: 'strength',     label: 'Hög styrka',    icon: '◆'  },
  { key: 'volatility',   label: 'Hög volatilitet', icon: '≈' },
  { key: 'discovery',    label: 'Discovery mode', icon: '◎' },
];

function MarketFilterBar({ filter, onChange }) {
  return (
    <div className="sp-filter-bar">
      {MARKET_FILTERS.map(f => (
        <button
          key={f.key}
          className={`sp-filter-btn${filter === f.key ? ' sp-filter-active' : ''}`}
          onClick={() => onChange(f.key)}
          type="button"
        >
          <span>{f.icon}</span>
          <span>{f.label}</span>
        </button>
      ))}
    </div>
  );
}

function QuickActions({ onFilter, topSetups }) {
  return (
    <div className="sp-quick-actions" aria-label="Snabba filter">
      <button type="button" onClick={() => onFilter('focus')}>Visa bara högsta fokus</button>
      <button type="button" onClick={() => onFilter('bullish')}>Visa bara bullish</button>
      <button type="button" onClick={() => onFilter('bearish')}>Visa bara bearish</button>
      <button type="button" onClick={() => onFilter('low_timeout')}>Visa låg timeout-risk</button>
      <button type="button" onClick={() => onFilter('nasdaq')}>Visa bara Nasdaq</button>
      <button type="button" onClick={() => onFilter('crypto')}>Visa bara krypto</button>
      <button type="button" onClick={() => onFilter('strong_setup')}>Visa starka setups</button>
      <button type="button" onClick={() => onFilter('volatility')}>Visa timeout-problem</button>
      <Link to="/insikter?tab=setups">Visa starkaste mönster</Link>
      <Link to="/insikter?tab=setups">Visa svaga strategier</Link>
      {topSetups?.[0] && <Link to={`/lab?tab=strategier&setup=${encodeURIComponent(topSetups[0].setup_id || topSetups[0].label)}`}>Öppna LAB med detta mönster</Link>}
    </div>
  );
}

function QuickInsights({ regimeSummary, topSetups, poorSetups }) {
  const insights = [];
  if (regimeSummary?.strategyWeights?.topStrategies?.[0]) {
    const key = regimeSummary.strategyWeights.topStrategies[0];
    insights.push(`${STRATEGY_LABELS_FE[key] || key} fungerar bäst idag`);
  }
  if (regimeSummary?.riskEnvLabelSv) insights.push(regimeSummary.riskEnvLabelSv);
  if (poorSetups?.some(s => /mean|reversion|åter/i.test(`${s.label} ${s.setup_id}`))) insights.push('Återgång är svag idag');
  if (!insights.length && topSetups?.[0]) insights.push(`${topSetups[0].label} är starkast historiskt`);
  if (!insights.length) insights.push('Systemet väntar på tydligare signaldata');

  return (
    <div className="sp-insight-grid">
      {insights.slice(0, 3).map(text => <div key={text} className="sp-insight-card">🧠 {text}</div>)}
    </div>
  );
}

function MarketSnapshot({ regimeSummary, signals }) {
  const groups = ['nasdaq', 'crypto', 'etf', 'index'].map(group => {
    const rows = signals.filter(s => s._marketGroup === group || (group === 'etf' && s._marketGroup === 'leveraged_etf'));
    const avg = rows.length ? Math.round(rows.reduce((sum, r) => sum + (r._pulseScore || 0), 0) / rows.length) : 0;
    const bull = rows.filter(r => r.momentumBias === 'bullish' || r.signal?.startsWith('LONG')).length;
    const bear = rows.filter(r => r.momentumBias === 'bearish' || r.signal?.startsWith('SHORT')).length;
    return { group, avg, bull, bear, count: rows.length };
  });
  const strongest = [...groups].sort((a, b) => b.avg - a.avg)[0];
  const weakest = [...groups].sort((a, b) => a.avg - b.avg)[0];

  return (
    <div className="sp-market-grid">
      <div className="sp-market-card">
        <span>Marknadsläge</span>
        <strong>{regimeSummary?.regimeLabelSv || 'Väntar på data'}</strong>
        <small>{regimeSummary?.volatilityLabelSv || 'Volatilitet saknas'}</small>
      </div>
      <div className="sp-market-card">
        <span>Starkast</span>
        <strong>{MG_LABELS[strongest?.group] || '–'}</strong>
        <small>{strongest?.avg || 0} puls</small>
      </div>
      <div className="sp-market-card">
        <span>Svagast</span>
        <strong>{MG_LABELS[weakest?.group] || '–'}</strong>
        <small>{weakest?.avg || 0} puls</small>
      </div>
      {groups.map(g => (
        <div key={g.group} className="sp-heat-cell">
          <span>{MG_LABELS[g.group] || g.group}</span>
          <strong>{g.avg}</strong>
          <small>{g.bull} bullish · {g.bear} bearish</small>
        </div>
      ))}
    </div>
  );
}

function QuickWarnings({ signals, regimeSummary }) {
  const weakVolume = signals.filter(s => (s.relVol20 ?? 1) < 0.7).length;
  const mixed = regimeSummary?.indexBias?.overall === 'mixed' || regimeSummary?.regimeScore?.confidence === 'low';
  const stale = (regimeSummary?.regimeScore?.staleMins || 0) > 10;
  const warnings = [
    mixed && 'Blandad marknad',
    weakVolume > 0 && `Svag volym i ${weakVolume} kandidater`,
    stale && 'Provider eller marknadsdata börjar bli gammal',
    signals.length === 0 && 'Väntar på scannerdata',
  ].filter(Boolean);

  if (!warnings.length) warnings.push('Inga akuta varningar');
  return (
    <div className="sp-warning-strip">
      {warnings.map(w => <span key={w}>{w}</span>)}
    </div>
  );
}

function ReasonList({ item }) {
  const positive = item?.reasons?.positive || item?.priorityReasons?.positive || [];
  const negative = item?.reasons?.negative || item?.priorityReasons?.negative || [];
  return (
    <div className="sp-priority-reasons">
      {positive.slice(0, 4).map((reason) => <span key={`p-${reason}`} className="sp-reason-good">+ {reason}</span>)}
      {negative.slice(0, 4).map((reason) => <span key={`n-${reason}`} className="sp-reason-bad">- {reason}</span>)}
    </div>
  );
}

function PriorityCard({ item, rank, tone = 'focus', timeline, lastUpdate }) {
  if (!item) return null;
  const ctx = item.marketContext || {};
  const score = item.priorityScore ?? 0;
  const tl = tlFor(timeline, item.symbol);
  const lu = item.lastUpdate || lastUpdate;
  return (
    <div className={`sp-priority-card sp-priority-${tone}`}>
      <div className="sp-priority-top">
        <div>
          <div className="sp-priority-rank">{rank}</div>
          <div className="sp-priority-symbol">{item.symbol}</div>
          <div className="sp-priority-strategy">{item.strategyLabel || item.signalFamily || 'Signal'}</div>
          <div className="sp-priority-meta-row">
            {(item.lastUpdate || item.timestamp) && <SignalAge timestamp={item.lastUpdate || item.timestamp} />}
            <TradingViewLink symbol={item.symbol} marketType={item.marketType} label="TradingView" size="sm" />
          </div>
        </div>
        <div className="sp-priority-score">
          <strong>{score}</strong>
          <span>Priority Score</span>
        </div>
      </div>
      <div className="sp-priority-context">
        <span>{ctx.regimeFit === 'stark' ? 'Marknaden stödjer' : ctx.regimeFit === 'svag' ? 'Svagt marknadsläge' : 'Blandad marknad'}</span>
        <span>{ctx.timeoutRisk ? `Timeout-risk ${ctx.timeoutRisk}` : 'Timeout-risk okänd'}</span>
        <span>{ctx.strategyStrength || 'Strategistyrka saknas'}</span>
        <span>{ctx.historicalConsistency || 'Historik saknas'}</span>
      </div>
      <ReasonList item={item} />
      {tone !== 'avoid' && (
        <SignalImportanceTimes
          mode={tone === 'watch' ? 'good' : 'top'}
          created={tl.firstSeen}
          becameTop={tl.topSeen}
          becameGood={tl.goodSeen}
          lastUpdate={lu}
          marketClosed={(item.marketType || item.market) !== 'crypto'}
        />
      )}
    </div>
  );
}

function PrioritySections({ priority, timeline, lastUpdateBySymbol = {} }) {
  if (!priority) return (
    <div className="sp-priority-loading">
      <div className="sp-loading-dot" />
      <span>Prioriterar signaler...</span>
    </div>
  );

  const focus = priority.topFocus || [];
  const watch = priority.watchlist || [];
  const avoid = priority.avoid || [];
  const clusters = priority.clusters || [];

  return (
    <div className="sp-priority-panel">
      <div className="sp-priority-head">
        <div>
          <h2>🎯 Fokus just nu</h2>
          <p>Max 1-3 signaler med bäst kvalitet, marknadsstöd och låg timeout-risk.</p>
        </div>
        <ConfigScopeBadge scope="test" />
      </div>

      {clusters.length > 0 && (
        <div className="sp-cluster-strip">
          {clusters.slice(0, 3).map((cluster) => <span key={cluster.key}>{cluster.label}</span>)}
        </div>
      )}

      {focus.length > 0 ? (
        <div className="sp-priority-grid sp-priority-grid-focus">
          {focus.slice(0, 3).map((item, i) => (
            <PriorityCard key={`${item.symbol}-${item.strategyKey}-${i}`} item={item} rank={i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} tone="focus" timeline={timeline} lastUpdate={lastUpdateBySymbol[String(item.symbol || '').toUpperCase()]} />
          ))}
        </div>
      ) : (
        <PlatformEmptyState title="Ingen högsta fokus-signal just nu" text="Systemet väntar på tydligare kvalitet, volym och marknadsstöd." />
      )}

      <div className="sp-priority-columns">
        <div className="sp-priority-column">
          <div className="sp-priority-subhead">👀 Watchlist</div>
          {watch.slice(0, 4).map((item, i) => (
            <PriorityCard key={`${item.symbol}-watch-${i}`} item={item} rank={`#${i + 1}`} tone="watch" timeline={timeline} lastUpdate={lastUpdateBySymbol[String(item.symbol || '').toUpperCase()]} />
          ))}
          {!watch.length && <div className="sp-priority-empty">Inga nästan-starka signaler.</div>}
        </div>
        <div className="sp-priority-column">
          <div className="sp-priority-subhead">⚠️ Undvik just nu</div>
          {avoid.slice(0, 4).map((item, i) => (
            <PriorityCard key={`${item.symbol}-avoid-${i}`} item={item} rank={`#${i + 1}`} tone="avoid" />
          ))}
          {!avoid.length && <div className="sp-priority-empty">Inga tydliga undvik-signaler.</div>}
        </div>
      </div>
    </div>
  );
}

// ── Crypto 24/7-status: ärlig färskhet + senaste crypto-kandidat ──────────────
function agoLabel(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 90) return `${sec}s sedan`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h sedan`;
  return `${Math.round(h / 24)} dygn sedan`;
}

// Datakällans VERKLIGA ålder per marknad (inte klientens refresh-klocka)
function feedAgeInfo(resp) {
  const fs = resp?.feedStatus || {};
  const iso = fs.latestTimestamp || fs.lastUpdated || resp?.lastScan || null;
  const ageMin = Number(fs.ageMinutes);
  const stale = fs.stale === true || (Number.isFinite(ageMin) && ageMin > 30);
  return { label: agoLabel(iso) || '–', stale };
}

const CRYPTO_TRIGGERED = /TRIGGERED/;

function pickCryptoCandidate(cryptoResp) {
  const rows = (cryptoResp?.results || []).filter(r => {
    const s = String(r?.symbol || '').toUpperCase();
    return r?.marketType === 'crypto' || s.endsWith('USDT') || s.endsWith('BTC');
  });
  if (!rows.length) return { best: null, hasStrong: false, count: 0 };
  const triggered = rows
    .filter(r => CRYPTO_TRIGGERED.test(String(r.signal || '')))
    .sort((a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0));
  const byScore = [...rows].sort((a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0));
  const strong = triggered.find(r =>
    (r.tradeScore ?? 0) >= 60 && r.scoreLabel !== 'Avoid' && r.daytradeStatus !== 'Undvik'
  ) || null;
  return { best: strong || triggered[0] || byScore[0] || null, hasStrong: !!strong, count: rows.length };
}

function cryptoDecisionLabel(r) {
  const sig = String(r?.signal || '');
  if (sig.startsWith('LONG_TRIGGERED')) return { text: 'Köp-läge (long triggad)', cls: 'sp-buy' };
  if (sig.startsWith('SHORT_TRIGGERED')) return { text: 'Sälj-läge (short triggad)', cls: 'sp-sell' };
  if (sig === 'NO_TRADE' || r?.scoreLabel === 'Avoid') return { text: 'Undvik', cls: 'sp-warning' };
  if (sig.startsWith('LONG')) return { text: 'Bevakar long', cls: 'sp-bullish' };
  if (sig.startsWith('SHORT')) return { text: 'Bevakar short', cls: 'sp-bearish' };
  return { text: 'Väntar på setup', cls: 'sp-wait' };
}

function Crypto247Status({ cryptoResp }) {
  const status = cryptoResp || {};
  const { best, hasStrong, count } = pickCryptoCandidate(status);
  const scanAge = agoLabel(status.lastScan);
  const scanning = status.scanning;
  const dec = best ? cryptoDecisionLabel(best) : null;
  const stopReason = best ? (best.daytradeWarnings?.[0] || best.reasonSv?.[0] || best.actionSv || null) : null;
  const sig = String(best?.signal || '');
  const nextLevel = best
    ? (sig.startsWith('SHORT') && best.shortTrigger != null
        ? `Short under ${best.shortTrigger}`
        : best.longTrigger != null ? `Long över ${best.longTrigger}` : null)
    : null;

  return (
    <div className="sp-crypto247">
      <div className="sp-crypto247-head">
        <span className="sp-crypto247-title">₿ Krypto 24/7-status</span>
        <span className={`sp-crypto247-livedot${scanning ? ' scanning' : ''}`}>
          {scanning ? 'Skannar nu…' : `Senaste scan ${scanAge || '–'}`}
        </span>
      </div>

      {best ? (
        <>
          <div className="sp-crypto247-row">
            <div className="sp-crypto247-sym">
              <strong>{best.symbol}</strong>
              <span>{count} symboler skannas dygnet runt</span>
            </div>
            <span className={`sp-crypto247-decision ${dec.cls}`}>{dec.text}</span>
            <div className="sp-crypto247-score"><strong>{best.tradeScore ?? '–'}</strong><span>Score</span></div>
          </div>

          {!hasStrong && (
            <div className="sp-crypto247-note">Krypto scannas, men inga starka kandidater hittades just nu.</div>
          )}

          <div className="sp-crypto247-meta">
            <div><span>Senaste signal</span><strong>{best.signal || '–'}</strong></div>
            <div><span>Senaste crypto-tid</span><strong>{agoLabel(best.lastUpdate) || '–'}</strong></div>
            {stopReason && <div className="wide"><span>Stopporsak / varning</span><strong>{stopReason}</strong></div>}
            {nextLevel && <div className="wide"><span>Nästa krav</span><strong>{nextLevel} · score ≥ 60 för bekräftad</strong></div>}
          </div>
        </>
      ) : (
        <div className="sp-crypto247-note">
          {count === 0 ? 'Ingen crypto-data ännu — väntar på första scan.' : 'Krypto scannas, men inga starka kandidater hittades just nu.'}
        </div>
      )}
    </div>
  );
}

// ── Signal-tidslinje (frontend-only, sessionsbaserad) ─────────────────────────
// Backend saknar firstSeen/topSeen på live-signaler (endast lastUpdate finns), så
// "dök upp som topp" / "bra läge sedan" / "legat i topp" spåras i klienten och
// sparas i localStorage per dag. Ingen backend-, trading- eller rankinglogik rörs.
const TL_PREFIX = 'sp-sig-timeline-';
function tlKey() { return TL_PREFIX + new Date().toISOString().slice(0, 10); }
function tlLoad() {
  try {
    const key = tlKey();
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith(TL_PREFIX) && k !== key) localStorage.removeItem(k); // städa gamla dagar
    });
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function tlSave(tl) { try { localStorage.setItem(tlKey(), JSON.stringify(tl)); } catch { /* ignore */ } }

// Spårar när varje symbol först dök upp (firstSeen, ej nollställd), och kontinuerligt
// hur länge den legat som topp (topSeen) respektive bra läge (goodSeen).
function useSignalTimeline(topSymbols, goodSymbols) {
  const ref = useRef(undefined);
  if (ref.current === undefined) ref.current = tlLoad();
  const [, force] = useState(0);
  const topKey = (topSymbols || []).join(',');
  const goodKey = (goodSymbols || []).join(',');
  useEffect(() => {
    const tl = ref.current;
    const now = Date.now();
    const top = new Set((topSymbols || []).map((s) => String(s || '').toUpperCase()).filter(Boolean));
    const good = new Set((goodSymbols || []).map((s) => String(s || '').toUpperCase()).filter(Boolean));
    let changed = false;
    [...top, ...good].forEach((sym) => {
      if (!tl[sym]) tl[sym] = {};
      if (tl[sym].firstSeen == null) { tl[sym].firstSeen = now; changed = true; }
    });
    Object.keys(tl).forEach((sym) => {
      if (top.has(sym)) { if (tl[sym].topSeen == null) { tl[sym].topSeen = now; changed = true; } }
      else if (tl[sym].topSeen != null) { tl[sym].topSeen = null; changed = true; }
      if (good.has(sym)) { if (tl[sym].goodSeen == null) { tl[sym].goodSeen = now; changed = true; } }
      else if (tl[sym].goodSeen != null) { tl[sym].goodSeen = null; changed = true; }
    });
    if (changed) { tlSave(tl); force((n) => n + 1); }
  }, [topKey, goodKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref.current;
}

function tlFor(timeline, symbol) {
  return timeline?.[String(symbol || '').toUpperCase()] || {};
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SignalpulsPage() {
  const [params, setParams] = useSearchParams();
  const { signals, loading, lastFetch, meta } = useAllSignals();
  const ls = useLearningSummary();
  const setupData = useSetupPerformance();
  const regimeSummary = useMarketRegime();
  const unifiedConfig = useUnifiedConfig('lab');
  const prioritySummary = unifiedConfig.test.prioritySummary;
  const auditSummary = useAuditSummary();
  const [advancedMode, setAdvancedMode] = useAdvancedMode();
  const [dataCoverageMap, setDataCoverageMap] = useState({});
  const adaptiveMode = unifiedConfig.test.adaptiveConfig.enabled;
  const globalFilters = unifiedConfig.ui.globalFilters;
  const marketFilter = globalFilters.market || 'all';

  useEffect(() => {
    fetch('/api/data-coverage/symbols')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const map = {};
        (d?.symbols || []).forEach((row) => { map[row.symbol] = row; });
        setDataCoverageMap(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const next = params.get('filter') || 'all';
    if (MARKET_FILTERS.some(f => f.key === next) && next !== marketFilter) {
      unifiedConfig.setGlobalFilters({ market: next });
    }
  }, [params, marketFilter, unifiedConfig]);

  function setMarketFilter(next) {
    unifiedConfig.setGlobalFilters({ market: next });
    setParams(next === 'all' ? {} : { filter: next });
  }

  function toggleAdaptive() {
    unifiedConfig.setAdaptiveEnabled(!adaptiveMode);
  }

  // Enrich signals and compute pulse scores
  const enriched = useMemo(() => {
    if (!signals.length) return [];
    const priorityBySymbol = new Map([
      ...(prioritySummary?.topFocus || []),
      ...(prioritySummary?.watchlist || []),
      ...(prioritySummary?.avoid || []),
      ...(prioritySummary?.ranked || []),
    ].map((item) => [String(item.symbol || '').toUpperCase(), item]));
    return enrichWithDecisions(signals, ls).map(r => ({
      ...r,
      _pulseScore: computePulseScore(r, ls, regimeSummary, adaptiveMode),
      _priorityScore: priorityBySymbol.get(String(r.symbol || '').toUpperCase())?.priorityScore ?? null,
      _priorityReasons: priorityBySymbol.get(String(r.symbol || '').toUpperCase())?.reasons ?? null,
      _priorityContext: priorityBySymbol.get(String(r.symbol || '').toUpperCase())?.marketContext ?? null,
      _marketGroup: getMarketGroup(r),
    }));
  }, [signals, ls, regimeSummary, adaptiveMode, prioritySummary]);

  const sorted = useMemo(() => {
    return [...enriched]
      .filter(r => (globalFilters.hideAvoid ? !isAvoidSignal(r) : true))
      .sort((a, b) => (b._priorityScore ?? b._pulseScore) - (a._priorityScore ?? a._pulseScore));
  }, [enriched, globalFilters.hideAvoid]);

  const filtered = useMemo(() => {
    let rows = sorted;
    if (globalFilters.symbol) {
      const needle = globalFilters.symbol.toUpperCase();
      rows = rows.filter(r => String(r.symbol || '').toUpperCase().includes(needle));
    }
    if (globalFilters.direction === 'long') rows = rows.filter(r => r.momentumBias === 'bullish' || r.signal?.startsWith('LONG'));
    if (globalFilters.direction === 'short') rows = rows.filter(r => r.momentumBias === 'bearish' || r.signal?.startsWith('SHORT'));
    if (globalFilters.minScore > 0) rows = rows.filter(r => (r._priorityScore ?? r._pulseScore ?? 0) >= globalFilters.minScore);
    if (marketFilter === 'all') return rows;
    if (marketFilter === 'focus') {
      const focusSymbols = new Set((prioritySummary?.topFocus || []).map((item) => item.symbol));
      return rows.filter(r => focusSymbols.has(r.symbol));
    }
    if (marketFilter === 'bullish') return rows.filter(r => r.momentumBias === 'bullish' || r.signal?.startsWith('LONG'));
    if (marketFilter === 'bearish') return rows.filter(r => r.momentumBias === 'bearish' || r.signal?.startsWith('SHORT'));
    if (marketFilter === 'low_timeout') return rows.filter(r => r._priorityContext?.timeoutRisk === 'låg');
    if (marketFilter === 'strong_setup') return rows.filter(r => r._priorityContext?.strategyStrength === 'strategin fungerar bra' || (r._priorityScore ?? 0) >= 72);
    if (marketFilter === 'strength') return rows.filter(r => (r._pulseScore ?? 0) >= 70);
    if (marketFilter === 'volatility') return rows.filter(r => (r.atrPct ?? r.volatilityPct ?? 0) >= 2 || ['HIGH_VOLATILITY', 'PANIC'].includes(r.marketRegime));
    if (marketFilter === 'discovery') return rows.filter(r => (r._pulseScore ?? 0) >= 35 && (r._pulseScore ?? 0) < 70);
    if (marketFilter === 'etf') return rows.filter(r => ['etf', 'leveraged_etf'].includes(r._marketGroup));
    return rows.filter(r => r._marketGroup === marketFilter);
  }, [sorted, marketFilter, prioritySummary, globalFilters]);

  const bestSignal = filtered[0] || null;
  const top20 = filtered.slice(0, 20);

  // Tidslinje: vilka är topp ("topp/fokus") resp. bra läge ("watchlist") just nu.
  const topSymbols = useMemo(
    () => [
      ...top20.map((s) => s.symbol),
      ...(prioritySummary?.topFocus || []).map((i) => i.symbol),
    ],
    [top20, prioritySummary],
  );
  const goodSymbols = useMemo(
    () => (prioritySummary?.watchlist || []).map((i) => i.symbol),
    [prioritySummary],
  );
  const timeline = useSignalTimeline(topSymbols, goodSymbols);
  // Senast uppdaterad per symbol (backend lastUpdate) — för prioritetskort utan eget fält.
  const lastUpdateBySymbol = useMemo(() => {
    const m = {};
    enriched.forEach((r) => {
      const s = String(r.symbol || '').toUpperCase();
      if (s && r.lastUpdate) m[s] = r.lastUpdate;
    });
    return m;
  }, [enriched]);

  // Setup performance
  const allSetups = useMemo(() => {
    if (!setupData) return [];
    return [
      ...(setupData.topSetups || []),
      ...(setupData.poorSetups || []),
      ...(setupData.neutralSetups || []),
    ].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0));
  }, [setupData]);

  const topSetups   = useMemo(() => allSetups.filter(s => s.category === 'top').slice(0, 6), [allSetups]);
  const poorSetups  = useMemo(() => allSetups.filter(s => s.category === 'poor' || s.category === 'pause').slice(0, 4), [allSetups]);

  const bestScore = bestSignal?._pulseScore ?? 0;

  return (
    <div className="sp-page">
      <PlatformSafetyBar />

      {/* Page header */}
      <div className="sp-page-header">
        <h1 className="sp-page-title">
          <PulsingHeart active={!loading && !!bestSignal} />
          LIVE
        </h1>
        <div className="sp-page-meta">
          <ConfigScopeBadge scope="ui" />
          <AdvancedModeToggle value={advancedMode} onChange={setAdvancedMode} />
          {lastFetch && (
            <span className="sp-last-update">
              Uppdaterad {lastFetch.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {/* Ärlig datakälle-ålder per marknad (skiljer på fryst aktie-helg vs färsk crypto) */}
          {(meta.stocks || meta.crypto) && (
            <span className="sp-feed-ages">
              {meta.stocks && (() => { const a = feedAgeInfo(meta.stocks); return (
                <span className={`sp-feed-chip${a.stale ? ' stale' : ''}`} title="Aktiernas datakälla">Aktier: {a.label}</span>
              ); })()}
              {meta.crypto && (() => { const a = feedAgeInfo(meta.crypto); return (
                <span className={`sp-feed-chip${a.stale ? ' stale' : ''}`} title="Kryptons datakälla">Krypto: {a.label}</span>
              ); })()}
            </span>
          )}
          <LiveDot />
        </div>
      </div>

      {/* Krypto 24/7-status: visar att crypto lever även när aktiemarknaden är stängd */}
      <Crypto247Status cryptoResp={meta.crypto} />

      {/* Market Bias Panel */}
      <MarketBiasPanel
        regimeSummary={regimeSummary}
        adaptiveMode={adaptiveMode}
        onToggleAdaptive={toggleAdaptive}
        advancedMode={advancedMode}
      />

      <PrioritySections priority={prioritySummary} timeline={timeline} lastUpdateBySymbol={lastUpdateBySymbol} />
      <AuditActivityPanel summary={auditSummary} />

      {/* DEL 1: Vad händer just nu */}
      <div className="sp-section-label">
        <span>DEL 1</span>
        <span className="sp-section-title">Vad händer JUST NU?</span>
      </div>

      {/* Hero signal */}
      {loading ? (
        <div className="sp-loading">
          <div className="sp-loading-dot" />
          <span>Hämtar signaler...</span>
        </div>
      ) : (
        <HeroSignal signal={bestSignal} score={bestScore} ls={ls} coverage={dataCoverageMap[String(bestSignal?.symbol || '').toUpperCase()]} timeline={timeline} />
      )}

      <QuickInsights regimeSummary={regimeSummary} topSetups={topSetups} poorSetups={poorSetups} />
      <MarketSnapshot regimeSummary={regimeSummary} signals={sorted} />
      <QuickWarnings signals={sorted} regimeSummary={regimeSummary} />
      <QuickActions onFilter={setMarketFilter} topSetups={topSetups} />

      {/* Market filter */}
      <MarketFilterBar filter={marketFilter} onChange={setMarketFilter} />

      {/* Top 20 */}
      <div className="sp-top20-header">
        <h2 className="sp-section-h2">
          {marketFilter === 'all' ? 'Top 20 signaler just nu' : `Top 20 — ${MARKET_FILTERS.find(f => f.key === marketFilter)?.label}`}
        </h2>
        <span className="sp-top20-count">{top20.length} st</span>
      </div>

      {top20.length === 0 && !loading ? (
        <PlatformEmptyState title="Inga starka signaler just nu" text="Systemet bevakar marknaden och visar kandidater när styrka, volym och marknadsläge räcker." />
      ) : (
        <div className="sp-signal-list">
          {top20.map((s, i) => (
            <SignalRow
              key={s.symbol + (s.timestamp || i)}
              rank={i + 1}
              signal={s}
              score={s._priorityScore ?? s._pulseScore}
              ls={ls}
              regimeSummary={advancedMode ? regimeSummary : null}
              coverage={dataCoverageMap[String(s.symbol || '').toUpperCase()]}
            />
          ))}
        </div>
      )}

      {/* DEL 2: Historisk performance */}
      <div className="sp-divider" />

      <div className="sp-section-label">
        <span>DEL 2</span>
        <span className="sp-section-title">Vad fungerar HISTORISKT?</span>
      </div>

      <div className="sp-perf-header">
        <h2 className="sp-section-h2">Mönsterhistorik</h2>
        <Link to="/insikter" className="sp-perf-link">Se alla resultat →</Link>
      </div>

      {advancedMode && setupData ? (
        <>
          {topSetups.length > 0 && (
            <div className="sp-setup-section">
              <div className="sp-setup-section-label">Bästa mönster</div>
              <div className="sp-setup-grid">
                {topSetups.map(s => <MiniSetupCard key={s.setup_id} setup={s} />)}
              </div>
            </div>
          )}
          {poorSetups.length > 0 && (
            <div className="sp-setup-section">
              <div className="sp-setup-section-label sp-poor-label">Undvik för tillfället</div>
              <div className="sp-setup-grid">
                {poorSetups.map(s => <MiniSetupCard key={s.setup_id} setup={s} />)}
              </div>
            </div>
          )}
          {allSetups.length === 0 && <PlatformEmptyState title="Inget historiskt minne ännu" text="Kör replay eller historisk analys för att fylla på mönsterdata." />}
        </>
      ) : advancedMode ? (
        <div className="sp-loading">
          <div className="sp-loading-dot" />
          <span>Laddar historik...</span>
        </div>
      ) : (
        <div className="sp-compact-history">
          Historik och detaljerad mönsterstatistik visas i Advanced Mode eller på Resultat-sidan.
        </div>
      )}

      {/* Quick nav */}
      <div className="sp-quick-nav">
        <Link to="/lab" className="sp-quick-btn sp-qb-lab">🧪 LAB</Link>
        <Link to="/insikter" className="sp-quick-btn sp-qb-results">📊 INSIKTER</Link>
        <Link to="/system?tab=safety" className="sp-quick-btn sp-qb-safety">🛡️ SYSTEM Safety</Link>
      </div>
    </div>
  );
}
