import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PlatformEmptyState } from '../components/PlatformControls.jsx';
import { SignalAge, TradingViewLink } from '../shared.jsx';

// ─── Data hook ────────────────────────────────────────────────────────────────

function useDaytradingData(tradeLimit = 200) {
  const requestSeq = useRef(0);
  const [state, setState] = useState({
    status: null, strategies: null, pipeline: null,
    liveTrades: null, recommendation: null, impact: null, symbols: null, runtime: null,
    cryptoScan: null, cryptoScanError: false, marketControls: null, learning: null, paperStatus: null, paperSignals: null, paperTrades: null, paperStrategyDiagnostics: null,
    autopilotStatus: null, autopilotConfig: null, candidates: null,
    loading: true, refreshing: false, refreshError: null, error: false,
  });

  const fetchAll = useCallback(async () => {
    const requestId = ++requestSeq.current;
    const isValidResponse = (value) => Boolean(value) && typeof value === 'object' && value.ok !== false;
    setState((prev) => ({
      ...prev,
      loading: prev.loading && !prev.status && !prev.liveTrades,
      refreshing: !prev.loading,
      refreshError: null,
    }));
    const get = url => fetch(url).then(r => r.json()).catch(() => null);
    const [statusD, strD, pipeD, tradesD, recD, impD, symD, runtimeD, cryptoScanD, marketControlsD, learningD, paperStatusD, paperSignalsD, paperTradesD, paperStrategyDiagnosticsD, autopilotStatusD, autopilotConfigD, candidatesD] = await Promise.all([
      get('/api/daytrading/status'), get('/api/daytrading/strategies'),
      get('/api/daytrading/pipeline'), get(`/api/daytrading/live-trades?limit=${tradeLimit}`),
      get('/api/daytrading/recommendation'), get('/api/daytrading/impact-summary'),
      get('/api/daytrading/symbols'), get('/api/daytrading/runtime-strategies'),
      get('/api/scan/crypto'),
      get('/api/daytrading/market-controls'),
      get('/api/daytrading/learning-summary?hours=48&limit=200'),
      get('/api/paper-trading/status'),
      get('/api/daytrading/paper-signals?limit=200'),
      get('/api/daytrading/paper-trades?limit=200'),
      get('/api/daytrading/paper-strategy-diagnostics'),
      get('/api/strategy-test-autopilot/status'),
      get('/api/strategy-test-autopilot/config'),
      get('/api/candidates/recent?n=50'),
    ]);
    if (requestId !== requestSeq.current) return;
    const validStatus = isValidResponse(statusD);
    const validStrategies = isValidResponse(strD);
    const validPipeline = isValidResponse(pipeD);
    const validTrades = isValidResponse(tradesD);
    const validRecommendation = isValidResponse(recD);
    const validImpact = isValidResponse(impD);
    const validSymbols = isValidResponse(symD);
    const validRuntime = isValidResponse(runtimeD);
    const validCryptoScan = isValidResponse(cryptoScanD);
    const validMarketControls = isValidResponse(marketControlsD);
    const validLearning = isValidResponse(learningD);
    const validPaperStatus = isValidResponse(paperStatusD);
    const validPaperSignals = isValidResponse(paperSignalsD);
    const validPaperTrades = isValidResponse(paperTradesD);
    const validPaperStrategyDiagnostics = isValidResponse(paperStrategyDiagnosticsD);
    const validAutopilotStatus = isValidResponse(autopilotStatusD);
    const validAutopilotConfig = isValidResponse(autopilotConfigD);
    const validCandidates = isValidResponse(candidatesD);
    const anyValid = [
      validStatus,
      validStrategies,
      validPipeline,
      validTrades,
      validRecommendation,
      validImpact,
      validSymbols,
      validRuntime,
      validCryptoScan,
      validMarketControls,
      validLearning,
      validPaperStatus,
      validPaperSignals,
      validPaperTrades,
      validPaperStrategyDiagnostics,
      validAutopilotStatus,
      validAutopilotConfig,
      validCandidates,
    ].some(Boolean);
    const refreshFailed = !validStatus || !validTrades;
    setState((prev) => {
      if (requestId !== requestSeq.current) return prev;
      return {
        ...prev,
        status: validStatus ? statusD : prev.status,
        strategies: validStrategies ? strD : prev.strategies,
        pipeline: validPipeline ? pipeD : prev.pipeline,
        liveTrades: validTrades ? tradesD : prev.liveTrades,
        recommendation: validRecommendation ? recD : prev.recommendation,
        impact: validImpact ? impD : prev.impact,
        symbols: validSymbols ? symD : prev.symbols,
        runtime: validRuntime ? runtimeD : prev.runtime,
        cryptoScan: validCryptoScan ? cryptoScanD : prev.cryptoScan,
        cryptoScanError: !validCryptoScan,
        marketControls: validMarketControls ? marketControlsD : prev.marketControls,
        learning: validLearning ? learningD : prev.learning,
        paperStatus: validPaperStatus ? paperStatusD : prev.paperStatus,
        paperSignals: validPaperSignals ? paperSignalsD : prev.paperSignals,
        paperTrades: validPaperTrades ? paperTradesD : prev.paperTrades,
        paperStrategyDiagnostics: validPaperStrategyDiagnostics ? paperStrategyDiagnosticsD : prev.paperStrategyDiagnostics,
        autopilotStatus: validAutopilotStatus ? autopilotStatusD : prev.autopilotStatus,
        autopilotConfig: validAutopilotConfig ? autopilotConfigD : prev.autopilotConfig,
        candidates: validCandidates ? candidatesD : prev.candidates,
        loading: false,
        refreshing: false,
        refreshError: refreshFailed ? 'Senaste uppdatering misslyckades – visar senaste data' : null,
        error: prev.status ? false : !validStatus,
        lastRefreshAt: anyValid ? new Date().toISOString() : prev.lastRefreshAt || null,
      };
    });
  }, [tradeLimit]);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 20000);
    return () => clearInterval(t);
  }, [fetchAll]);

  return { ...state, refresh: fetchAll };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeSince(iso) {
  if (!iso) return null;
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff} sek sedan`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min sedan`;
  return `${Math.floor(diff / 3600)} tim sedan`;
}

function fmtScore(s)  { return s != null ? Math.round(s) : '–'; }
function fmtPct(v) {
  if (v == null) return '–';
  const n = Number(v);
  return isNaN(n) ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function fmtPrice(v) {
  if (v == null || v === '') return '–';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n >= 100 ? n.toFixed(2) : n.toFixed(4);
}
function fmtTradeTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('sv-SE', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function fmtPaperAge(mins) {
  if (mins == null || Number.isNaN(Number(mins))) return '–';
  const n = Math.max(0, Math.round(Number(mins)));
  if (n < 60) return `${n} min`;
  const hours = Math.floor(n / 60);
  const rem = n % 60;
  return rem ? `${hours} h ${rem} min` : `${hours} h`;
}
function numericPnl(v) {
  if (v == null || v === '–') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function valueTone(v) {
  const n = numericPnl(v);
  if (n == null) return 'neutral';
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'neutral';
}
function fmtReason(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value || '–';
}

function fmtRiskReward(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function marketLabelSv(value) {
  const market = String(value || '').toLowerCase();
  if (market === 'crypto') return 'Krypto';
  if (market === 'stocks' || market === 'stock') return 'Aktier';
  if (market === 'nasdaq') return 'Nasdaq';
  if (market === 'etf') return 'ETF';
  if (market === 'index') return 'Index';
  return value || '–';
}

function paperSignalStatusTone(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('redo') || s.includes('öppen')) return 'good';
  if (s.includes('vänt')) return 'warning';
  if (s.includes('block')) return 'danger';
  if (s.includes('saknar')) return 'warning';
  if (s.includes('timeout')) return 'warning';
  if (s.includes('stäng') || s.includes('historik') || s.includes('inaktuell')) return 'neutral';
  return 'neutral';
}

function paperSignalStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('redo')) return 'dt-status-win';
  if (s.includes('öppen')) return 'dt-status-open';
  if (s.includes('block')) return 'dt-status-blocked';
  if (s.includes('timeout')) return 'dt-status-timeout';
  if (s.includes('saknar')) return 'dt-status-neutral';
  if (s.includes('vänt')) return 'dt-status-wait';
  if (s.includes('stäng') || s.includes('historik') || s.includes('inaktuell')) return 'dt-status-neutral';
  return 'dt-status-neutral';
}

function paperSignalRowClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('redo')) return 'dt-row-green';
  if (s.includes('öppen')) return 'dt-row-blue';
  if (s.includes('block')) return 'dt-row-red';
  if (s.includes('timeout')) return 'dt-row-yellow';
  if (s.includes('vänt')) return 'dt-row-yellow';
  if (s.includes('saknar') || s.includes('historik') || s.includes('inaktuell')) return 'dt-row-gray';
  if (s.includes('stäng')) return 'dt-row-blue';
  return '';
}

function paperSignalAction(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('redo')) return 'Skapa paper';
  if (s.includes('öppen')) return 'Följ trade';
  if (s.includes('block')) return 'Visa orsak';
  if (s.includes('timeout')) return 'Visa resultat';
  if (s.includes('saknar')) return 'Kontrollera data';
  if (s.includes('historik') || s.includes('inaktuell')) return 'Visa historik';
  return 'Väntar';
}

function paperSignalHeadline(signal = {}) {
  const reason = signal.blockerReason || signal.reason || 'Ingen tydlig orsak sparad';
  return reason;
}

function paperSignalSourceLabel(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'latest_scan') return 'Aktuell';
  if (s === 'open_trade') return 'Öppen trade';
  if (s === 'recent_closed') return 'Senast stängd';
  if (s === 'history') return 'Historik';
  return '–';
}

function paperSignalAgeLabel(signal = {}) {
  if (signal.signalAgeMinutes == null) return '–';
  return fmtPaperAge(signal.signalAgeMinutes);
}

function paperTradeStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('öppen')) return 'dt-status-open';
  if (s.includes('tp')) return 'dt-status-win';
  if (s.includes('sl')) return 'dt-status-blocked';
  if (s.includes('timeout')) return 'dt-status-timeout';
  if (s.includes('stäng')) return 'dt-status-neutral';
  return 'dt-status-neutral';
}

function paperTradeStatusTone(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('öppen')) return 'good';
  if (s.includes('tp')) return 'good';
  if (s.includes('sl')) return 'danger';
  if (s.includes('timeout')) return 'warning';
  return 'neutral';
}

function paperTradeStatusLabel(trade = {}) {
  return trade.status || trade.result || '–';
}

function paperTradeExitLabel(trade = {}) {
  return trade.exit_reason || trade.exitReason || trade.reason || '–';
}

function paperTradeLearningLabel(trade = {}) {
  return trade.sentToLearning === true ? 'Ja' : trade.sentToLearning === false ? 'Nej' : '–';
}

function textValue(value, fallback = '–') {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) {
    const parts = value.map((item) => textValue(item, '')).filter(Boolean);
    return parts.length ? parts.join(' · ') : fallback;
  }
  if (typeof value === 'object') {
    return textValue(
      value.label ?? value.name ?? value.title ?? value.text ?? value.reasonSv ?? value.reason ?? value.value,
      fallback,
    );
  }
  return String(value).trim() || fallback;
}

function candidateDirection(candidate = {}) {
  const raw = String(candidate.nextMoveBias || candidate.indexBias || candidate.direction || candidate.signal || '').toUpperCase();
  if (raw.includes('SHORT') || raw.includes('DOWN') || raw.includes('BEAR')) return 'Short';
  if (raw.includes('LONG') || raw.includes('UP') || raw.includes('BULL')) return 'Long';
  return 'Neutral';
}

function candidateStatus(candidate = {}) {
  const raw = String(candidate.status || candidate.daytradeStatus || candidate.blockerMode || candidate.signal || '').toLowerCase();
  if (candidate.paperTradeCreated === true) return 'paper trade';
  if (raw.includes('timeout')) return 'timeout';
  if (raw.includes('reject') || raw.includes('block') || (Array.isArray(candidate.wouldHaveBeenBlockedBy) && candidate.wouldHaveBeenBlockedBy.length > 0)) return 'rejected';
  if (raw.includes('active') || raw.includes('open') || raw.includes('klar') || candidate.discoveryMode === true) return 'active';
  return textValue(candidate.status || candidate.daytradeStatus || candidate.blockerMode || 'active', 'active');
}

function candidateWhy(candidate = {}) {
  const reasons = [
    ...((Array.isArray(candidate.reasons) ? candidate.reasons : [])),
    ...((Array.isArray(candidate.warnings) ? candidate.warnings : [])),
    ...((Array.isArray(candidate.wouldHaveBeenBlockedBy) ? candidate.wouldHaveBeenBlockedBy : [])),
  ].map((item) => textValue(item, '')).filter(Boolean);
  return reasons.length ? reasons.slice(0, 3).join(' · ') : 'Ingen tydlig orsak sparad';
}

function candidateSignal(candidate = {}) {
  return textValue(candidate.signalFamily || candidate.signalSubtype || candidate.signal || candidate.setupId || candidate.strategyName || candidate.strategy_name, '–');
}

function candidateEntry(candidate = {}) {
  return textValue(candidate.strategyName || candidate.strategy_name || candidate.setupId || candidate.marketGroup || candidate.market_group, '–');
}

function candidateExit(candidate = {}) {
  return textValue(candidate.exitProfile || candidate.blockerMode || candidate.discoveryMode || candidate.wouldHaveBeenBlockedBy?.[0], '–');
}

function candidateScore(candidate = {}) {
  const value = candidate.tradeScore ?? candidate.signalScore ?? candidate.priorityScore ?? candidate.score ?? candidate.confidenceScore ?? null;
  return value == null ? '–' : Math.round(Number(value));
}

function candidateTime(candidate = {}) {
  return candidate.detected_at || candidate.evaluated_at || candidate.ts || candidate.timestamp || candidate.created_at || null;
}

function tabLabel(tabKey) {
  return DAYTRADING_TABS.find((tab) => tab.key === tabKey)?.label || 'Översikt';
}

const DAYTRADING_TABS = [
  { key: 'overview', label: 'Översikt' },
  { key: 'signals', label: 'Signaler' },
  { key: 'strategies', label: 'Strategier' },
  { key: 'paper', label: 'Paper Trading' },
  { key: 'tests', label: 'Tester' },
  { key: 'learning', label: 'Learning' },
  { key: 'safety', label: 'Risk & Safety' },
];

const CRYPTO_RUNTIME_STRATEGY_IDS = [
  'crypto_momentum_scalper',
  'crypto_fast_momentum',
  'vwap_volume_breakout_long',
  'vwap_failed_breakout_short',
  'ema_pullback_continuation',
];

function cryptoToneFromState(scanCrypto, runtimeRows, scanCryptoError) {
  const feedStatus = String(scanCrypto?.feedStatus?.status || '').toUpperCase();
  const count = Number(scanCrypto?.count ?? 0);
  const scanning = scanCrypto?.scanning === true || scanCrypto?.feedStatus?.scannerRunning === true;
  if (scanCryptoError) return 'gray';
  if (feedStatus === 'BROKEN') return 'red';
  if (scanning) return 'blue';
  if (count > 0 && feedStatus !== 'BROKEN') return 'green';
  if ((runtimeRows || []).some((row) => row?.runtime_status === 'partial' || row?.runtime_status === 'disabled')) return 'yellow';
  if (count === 0) return 'yellow';
  return 'gray';
}

function buildCryptoBackendStatus(scanCrypto, runtime, paperStatus, scanCryptoError = false) {
  const feedStatus = String(scanCrypto?.feedStatus?.status || '').toUpperCase();
  const results = Array.isArray(scanCrypto?.results) ? scanCrypto.results : [];
  const symbols = [...new Set(results.map((row) => row?.symbol).filter(Boolean))];
  const runtimeRows = (runtime?.strategies || [])
    .filter((row) => CRYPTO_RUNTIME_STRATEGY_IDS.includes(row.strategy_id || row.id))
    .map((row) => ({
      strategy_id: row.strategy_id || row.id,
      strategy_name: row.strategy_name || row.name || row.strategy_id || row.id,
      runtime_status: row.runtime_status || 'okänd',
      can_create_paper_trade: row.can_create_paper_trade,
      entry_rule_implemented: row.entry_rule_implemented,
      skip_reason_sv: row.skip_reason_sv || row.reason_sv || row.runtime_comment_sv || row.comment_sv || null,
      paper_trades_48h: row.paper_trades_48h ?? 0,
      last_paper_trade_at: row.last_paper_trade_at || null,
      mapping_confidence: row.mapping_confidence || null,
    }));
  const count = Number(scanCrypto?.count ?? results.length ?? 0);
  const lastScan = scanCrypto?.lastScan || null;
  const stale = scanCrypto?.feedStatus?.stale;
  const ageSeconds = scanCrypto?.feedStatus?.ageSeconds ?? null;
  const scanning = scanCrypto?.scanning === true || scanCrypto?.feedStatus?.scannerRunning === true;
  const hasError = scanCryptoError;
  const tone = cryptoToneFromState(scanCrypto, runtimeRows, scanCryptoError);
  const statusLabel = hasError
    ? 'okänd'
    : feedStatus === 'BROKEN'
      ? 'broken'
      : count > 0
        ? 'aktiv'
        : scanning
          ? 'scannar'
          : 'tom';
  const feedMessage = scanCrypto?.feedStatus?.messageSv || null;
  const infoLines = [];
  if (hasError) {
    infoLines.push('Crypto-status kunde inte hämtas.');
  } else if (feedStatus === 'BROKEN') {
    infoLines.push('Crypto-datakälla saknas eller är nere just nu.');
  } else if (count === 0) {
    infoLines.push('Crypto live-scan ger inga färska signaler just nu.');
  }
  if (runtimeRows.some((row) => row.runtime_status === 'partial' || row.runtime_status === 'disabled')) {
    infoLines.push('Crypto-strategier finns, men vissa är partial/disabled.');
  }
  if (count === 0 && runtimeRows.length > 0) {
    infoLines.push('Paper-engine kan hantera crypto historiskt, men får inget färskt crypto-flöde just nu.');
    infoLines.push('Detta är troligen upstream: crypto-scanner/provider, inte paper-engine.');
  }
  if (paperStatus?.enabled === false) {
    infoLines.push('Paper trading är avstängt.');
  }

  return {
    tone,
    statusLabel,
    feedStatus,
    feedMessage,
    count,
    lastScan,
    stale,
    ageSeconds,
    scanning,
    symbols,
    runtimeRows,
    conclusion: infoLines.length > 0 ? infoLines.join(' ') : 'Crypto backend ser levande ut just nu.',
    hasError,
  };
}

function CryptoBackendStatusPanel({ scanCrypto, scanCryptoError, runtime, paperStatus }) {
  const model = buildCryptoBackendStatus(scanCrypto, runtime, paperStatus, scanCryptoError);
  const statusClass = `dt-crypto-panel dt-crypto-${model.tone}`;
  const lastScanLabel = model.lastScan ? fmtTradeTime(model.lastScan) : '–';

  return (
    <div className={statusClass}>
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Crypto backend-status</h3>
        <span className={`dt-count-badge dt-crypto-pill-${model.tone}`}>{model.statusLabel}</span>
      </div>

      <div className="dt-crypto-summary-grid">
        <div className="dt-crypto-stat">
          <strong>{model.count}</strong>
          <span>live-signal(er)</span>
        </div>
        <div className="dt-crypto-stat">
          <strong>{lastScanLabel}</strong>
          <span>lastScan</span>
        </div>
        <div className="dt-crypto-stat">
          <strong>{model.feedStatus || 'okänd'}</strong>
          <span>feedStatus</span>
        </div>
        <div className="dt-crypto-stat">
          <strong>{model.scanning ? 'Ja' : 'Nej'}</strong>
          <span>scannerRunning</span>
        </div>
      </div>

      <div className="dt-crypto-note">
        {model.feedMessage && <span>{model.feedMessage}</span>}
        {model.stale != null && <span>stale: {String(model.stale)}</span>}
        {model.ageSeconds != null && <span>ageSeconds: {model.ageSeconds}</span>}
      </div>

      <div className="dt-crypto-block">
        <strong>Senaste crypto-symboler</strong>
        {model.symbols.length > 0 ? (
          <div className="dt-crypto-symbols">
            {model.symbols.map((symbol) => (
              <span key={symbol} className="dt-crypto-symbol-pill">{symbol}</span>
            ))}
          </div>
        ) : (
          <div className="dt-crypto-empty">Inga crypto-symboler från live scan just nu.</div>
        )}
      </div>

      <div className="dt-crypto-block">
        <strong>Crypto runtime</strong>
        <div className="dt-crypto-runtime-list">
          {model.runtimeRows.map((row) => (
            <div key={row.strategy_id} className="dt-crypto-runtime-row">
              <div className="dt-crypto-runtime-head">
                <span>{row.strategy_name}</span>
                <span className={`dt-crypto-runtime-pill dt-crypto-runtime-${String(row.runtime_status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown'}`}>
                  {row.runtime_status}
                </span>
              </div>
              <div className="dt-crypto-runtime-meta">
                <span>can_create_paper_trade: {row.can_create_paper_trade === true ? 'true' : row.can_create_paper_trade === 'partial' ? 'partial' : 'false'}</span>
                <span>entry_rule_implemented: {row.entry_rule_implemented === true ? 'true' : 'false'}</span>
                <span>paper_trades_48h: {row.paper_trades_48h ?? 0}</span>
                <span>mapping: {row.mapping_confidence || '–'}</span>
              </div>
              <div className="dt-crypto-runtime-reason">
                {row.skip_reason_sv || 'Ingen skip reason'}
              </div>
            </div>
          ))}
          {!model.runtimeRows.length && <div className="dt-crypto-empty">Ingen crypto-runtime-data hittades.</div>}
        </div>
      </div>

      <div className="dt-crypto-conclusion">
        <strong>Slutsats</strong>
        <span>{model.conclusion}</span>
      </div>

      <div className="dt-crypto-safety">Detta är read-only status. Ingen tradinglogik ändras.</div>
    </div>
  );
}

function friendlySkipReason(reason) {
  const text = String(reason || '').trim();
  const lower = text.toLowerCase();
  if (!text) return 'Okänd orsak';
  if (lower.includes('market closed') || lower.includes('market is closed') || (lower.includes('market') && lower.includes('closed'))) {
    return 'Market closed';
  }
  if (lower.includes('no entry') || lower.includes('entry rule') || lower.includes('saknar entry')) {
    return 'No entry rule';
  }
  if (lower.includes('weak volume') || lower.includes('svag volym') || lower.includes('låg volym')) {
    return 'Weak volume';
  }
  if (lower.includes('partial') || lower.includes('delvis')) {
    return 'Runtime partial';
  }
  if (lower.includes('conservative') || lower.includes('konservativ')) {
    return 'Conservative mode';
  }
  return text;
}

function sanitizePipeText(text) {
  if (!text) return text;
  if (text.includes('Ingen strategi') && text.endsWith('matchade.')) return 'Ingen strategi har matchat ännu.';
  return text;
}

function stepTone(status) {
  const s = String(status || '').toLowerCase();
  if (['klar', 'allow', 'allowed', 'active', 'aktiv', 'ok', 'godkänd'].includes(s)) return 'green';
  if (['kor', 'running', 'scanning', 'analyzing', 'processing', 'partial'].includes(s)) return 'blue';
  if (['vantar', 'waiting', 'observe_only', 'watch', 'caution', 'observe'].includes(s)) return 'yellow';
  if (['blockerad', 'blocked', 'error', 'fel', 'stoppad'].includes(s)) return 'red';
  return 'gray';
}

function stepLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'green') return 'Godkänd';
  if (s === 'blue') return 'Analyserar';
  if (s === 'yellow') return 'Väntar';
  if (s === 'red') return 'Stoppad';
  return 'Okänd';
}

function extractStepSymbol(text) {
  const match = String(text || '').match(/^(\S+)\s/);
  return match?.[1] || null;
}

function extractStepStrategy(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.includes('Ingen strategi')) return null;
  const match = clean.match(/^(.+?)\s+matchade/);
  return (match?.[1] || clean.replace(/\.$/, '') || '').trim() || null;
}

function formatTopReason(item) {
  if (!item) return null;
  const raw = typeof item === 'string' ? item : (item.reason || item.key || item.label || '');
  const text = friendlySkipReason(raw);
  return text || null;
}

function classifyStopStage(text, latestTrade = null) {
  const t = String(text || '').toLowerCase();
  const status = String(latestTrade?.runtime_status || '').toLowerCase();
  if (status === 'partial' || status === 'paused' || status === 'disabled' || status === 'not_connected') return 'runtime';
  if (t.includes('runtime partial') || t.includes('delvis koppl') || t.includes('saknar entry') || t.includes('no entry')) return 'runtime';
  if (t.includes('cooldown')) return 'cooldown';
  if (t.includes('duplicate')) return 'duplicate';
  if (t.includes('max trades')) return 'max_trades';
  if (t.includes('market closed') || t.includes('vänta') || t.includes('jaga inte') || t.includes('status=wait') || t.includes('status=avoid')) return 'entry';
  if (t.includes('conservative') || t.includes('gate') || t.includes('volym') || t.includes('score') || t.includes('observe-only') || t.includes('safety')) return 'gate';
  return null;
}

function requirementTextForStage(stage, { latestTrade, marketControls, status, runtime, paperStatus, liveTrades }) {
  const filters = marketControls?.filters || {};
  const minScore = filters.min_score ?? filters.minScore;
  const minConfidence = filters.min_confidence ?? filters.minConfidence;
  const cooldownMinutes = filters.cooldown_minutes ?? filters.cooldownMinutes;
  const maxTradesPerHour = filters.max_trades_per_hour ?? filters.maxTradesPerHour;
  const runtimeActiveCount = runtime?.summary?.can_create_paper_trade_count ?? 0;
  const parts = [];

  if (stage === 'runtime') {
    parts.push('Strategin måste bli runtime active.');
    parts.push('can_create_paper_trade måste vara true.');
  } else if (stage === 'entry') {
    const candidateStatus = String(latestTrade?.status || '').toLowerCase();
    if (candidateStatus === 'wait' || candidateStatus === 'avoid') {
      parts.push('Signal måste gå från wait till watch/caution.');
    } else {
      parts.push('Entry-regeln måste godkänna signalen.');
    }
    if (latestTrade?.volumeState && String(latestTrade.volumeState).toLowerCase() !== 'strong') {
      parts.push('Volym behöver bli strong.');
    }
  } else if (stage === 'cooldown') {
    parts.push(`Cooldown ${cooldownMinutes ?? 5} min måste löpa ut.`);
    parts.push('Samma symbol får inte vara i cooldown.');
  } else if (stage === 'duplicate') {
    parts.push('SignalId måste vara unik.');
  } else if (stage === 'max_trades') {
    parts.push(`Max trades/h ${maxTradesPerHour ?? 10} får inte vara nådd.`);
    parts.push('En ledig trade-plats måste finnas.');
  } else if (stage === 'gate') {
    if (paperStatus?.conservativeMode || paperStatus?.safetyAlert?.conservativeModeActive || liveTrades?.summary_48h?.conservativeModeActive) {
      parts.push('Conservative mode kräver högre score.');
    }
    if (minScore != null) parts.push(`Score måste över ${minScore}.`);
    if (minConfidence != null) parts.push(`Confidence måste över ${minConfidence}.`);
    if (latestTrade?.volumeState && String(latestTrade.volumeState).toLowerCase() !== 'strong') {
      parts.push('Volym behöver bli strong.');
    }
    parts.push('Market gate måste ge allow.');
  } else if (stage === 'safety') {
    parts.push('Safety låser riktig order.');
  } else {
    if (runtimeActiveCount > 0) {
      parts.push('Market gate måste ge allow.');
    } else {
      parts.push('Systemet behöver en aktiv strategi med entry-regel.');
    }
  }

  if (parts.length === 0) parts.push('Market gate måste ge allow.');
  return parts.slice(0, 3);
}

function buildCurrentDecisionState({ status, pipeline, liveTrades, runtime, marketControls, learning, paperStatus, refreshing, refreshError }) {
  const steps = pipeline?.pipeline || [];
  const latestTrade = Array.isArray(liveTrades?.trades) && liveTrades.trades.length > 0 ? liveTrades.trades[0] : null;
  const dataStep = steps.find((step) => step.id === 'data') || null;
  const scannerStep = steps.find((step) => step.id === 'scanner') || null;
  const symbolStep = steps.find((step) => step.id === 'symbol') || null;
  const strategyStep = steps.find((step) => step.id === 'strategy') || null;
  const paperStep = steps.find((step) => step.id === 'paper') || null;
  const runtimeSummary = runtime?.summary || {};
  const openCount = paperStatus?.openCount ?? paperStatus?.openTrades?.length ?? liveTrades?.summary?.open ?? 0;
  const topStopReason = liveTrades?.stoppage_summary_48h?.top_reasons?.[0] || learning?.data?.skip_reasons?.[0] || null;
  const topStopText = formatTopReason(topStopReason);
  const candidateSymbol = latestTrade?.symbol || extractStepSymbol(symbolStep?.text) || null;
  const candidateRawSignal = latestTrade?.raw_signal || latestTrade?.raw_strategy || latestTrade?.signal_subtype || latestTrade?.signalFamily || null;
  const candidateStrategy = latestTrade?.strategy_name || latestTrade?.strategy || extractStepStrategy(strategyStep?.text) || null;
  const candidateDecision = latestTrade?.status || sanitizePipeText(paperStep?.text) || null;
  const hasFreshCandidate = Boolean(candidateSymbol || candidateRawSignal || candidateStrategy || candidateDecision);
  const candidateLine = hasFreshCandidate
    ? [candidateSymbol, candidateRawSignal, candidateStrategy].filter(Boolean).join(' · ')
    : 'Systemet söker. Ingen färsk kandidat ännu.';

  const stopStage = classifyStopStage(
    topStopText || latestTrade?.block_reason || latestTrade?.risk_reason || latestTrade?.reason || paperStep?.text || '',
    latestTrade,
  );
  const stopStageLabel = {
    runtime: 'Runtime',
    entry: 'Entry-regel',
    gate: 'Market Gate',
    cooldown: 'Cooldown',
    duplicate: 'Duplicate',
    max_trades: 'Max trades',
    safety: 'Safety',
  }[stopStage] || (openCount > 0 ? 'Paper trade' : 'Market Gate');
  const stopReasonText = topStopText
    || (openCount > 0 ? 'En paper trade är redan öppen och följs.' : null)
    || latestTrade?.block_reason
    || latestTrade?.risk_reason
    || latestTrade?.reason
    || 'Ingen färsk kandidat ännu.';
  const latestStageStatus = {
    data: stepTone(dataStep?.status || (status?.backend_connected ? 'klar' : 'fel')),
    scanner: stepTone(scannerStep?.status || (status?.scanner_active ? 'kor' : 'vantar')),
    signal: hasFreshCandidate ? 'green' : 'yellow',
    strategy: candidateStrategy ? 'green' : 'yellow',
    runtime: stepTone(latestTrade?.runtime_status || runtimeSummary.runtime_status || (runtimeSummary.can_create_paper_trade_count > 0 ? 'active' : 'partial')),
    entry: stepTone(stopStage === 'entry' ? 'blockerad' : stopStage === 'runtime' ? 'vantar' : (candidateDecision ? 'klar' : 'vantar')),
    gate: stepTone(stopStage === 'gate' ? 'blockerad' : (openCount > 0 ? 'klar' : 'vantar')),
    paper: stepTone(openCount > 0 ? 'klar' : (candidateDecision && !stopStage ? 'vantar' : 'blockerad')),
  };
  const requirements = requirementTextForStage(stopStage || (openCount > 0 ? 'paper' : 'gate'), {
    latestTrade,
    marketControls,
    status,
    runtime,
    paperStatus,
    liveTrades,
  });

  const pipelineState = [
    {
      id: 'data',
      label: 'Data hämtad',
      text: status?.latest_scan ? `Senaste scan: ${timeSince(status.latest_scan)}` : 'Data väntar på nästa scan.',
      tone: latestStageStatus.data,
    },
    {
      id: 'scanner',
      label: 'Scanner kör',
      text: status?.scanner_active ? 'Scanner analyserar senaste data.' : 'Scanner väntar på nästa körning.',
      tone: latestStageStatus.scanner,
    },
    {
      id: 'signal',
      label: 'Signal hittad',
      text: candidateSymbol ? candidateLine : 'Systemet söker. Ingen färsk kandidat ännu.',
      tone: latestStageStatus.signal,
    },
    {
      id: 'strategy',
      label: 'Strategi matchad',
      text: candidateStrategy ? `${candidateStrategy} matchade.` : 'Ingen strategi matchad ännu.',
      tone: latestStageStatus.strategy,
    },
    {
      id: 'runtime',
      label: 'Runtime',
      text: latestTrade?.runtime_comment_sv || latestTrade?.catalog_mapping_note || runtime?.strategies?.find((s) => s.runtime_status === 'active')?.runtime_comment_sv || 'Runtime kontrolleras mot aktiva strategier.',
      tone: latestStageStatus.runtime,
    },
    {
      id: 'entry',
      label: 'Entry-regel',
      text: latestTrade?.reason || latestTrade?.catalog_mapping_note || topStopText || 'Entry-regeln bedöms mot status, volym och riktning.',
      tone: latestStageStatus.entry,
    },
    {
      id: 'gate',
      label: 'Market Gate',
      text: candidateDecision && stopStage !== 'gate'
        ? candidateDecision
        : stopReasonText,
      tone: latestStageStatus.gate,
    },
    {
      id: 'paper',
      label: 'Paper trade',
      text: openCount > 0
        ? `${openCount} paper trade${openCount === 1 ? '' : 's'} öppen${openCount === 1 ? '' : 'a'}`
        : 'Ingen paper trade skapades.',
      tone: latestStageStatus.paper,
    },
  ];

  return {
    latestTrade,
    candidateSymbol,
    candidateRawSignal,
    candidateStrategy,
    candidateDecision,
    candidateLine,
    hasFreshCandidate,
    stopStage,
    stopStageLabel,
    stopReasonText,
    requirements,
    openCount,
    runtimeSummary,
    topStopReason,
    topStopText,
    pipelineState,
    refreshing,
    refreshError,
  };
}

function CurrentDecisionCard({ status, pipeline, liveTrades, runtime, marketControls, learning, paperStatus, refreshing, refreshError }) {
  const current = buildCurrentDecisionState({ status, pipeline, liveTrades, runtime, marketControls, learning, paperStatus, refreshing, refreshError });
  const activeCount = current.runtimeSummary.can_create_paper_trade_count ?? 0;
  const partialCount = current.runtimeSummary.runtime_partial ?? 0;
  const selectedCount = current.runtimeSummary.enabled_by_user ?? 0;

  return (
    <div className="dt-panel dt-now-panel">
      <div className="dt-now-head">
        <div>
          <h2 className="dt-now-title">Vad händer just nu?</h2>
          <p className="dt-now-sub">Systemet kan analysera och paper-trada, men inte lägga riktiga ordrar.</p>
        </div>
        <div className="dt-now-head-badges">
          {refreshing && <span className="dt-badge dt-badge-blue">Uppdaterar</span>}
          {refreshError && <span className="dt-badge dt-badge-yellow">Senaste uppdatering misslyckades</span>}
          <span className="dt-badge dt-badge-gray">Safety låst</span>
        </div>
      </div>

      <div className="dt-now-summary-grid">
        <div className={`dt-now-summary-card dt-now-summary-card-${current.hasFreshCandidate ? 'blue' : 'yellow'}`}>
          <div className="dt-now-summary-lbl">Söker just nu</div>
          <div className="dt-now-summary-val">{current.candidateLine}</div>
          <div className="dt-now-summary-sub">
            {current.candidateRawSignal ? `Raw signal: ${current.candidateRawSignal}` : 'Ingen färsk raw signal ännu.'}
          </div>
          {current.candidateSymbol && (
            <div className="dt-now-summary-meta">
              <SignalAge timestamp={current.latestTrade?.time || current.latestTrade?.opened_at || current.latestTrade?.created_at || status?.latest_scan} />
              <TradingViewLink symbol={current.candidateSymbol} marketType={current.latestTrade?.marketType} label="TradingView" size="sm" />
            </div>
          )}
        </div>
        <div className={`dt-now-summary-card dt-now-summary-card-${current.stopStage === 'runtime' ? 'blue' : current.stopStage === 'gate' || current.stopStage === 'safety' ? 'red' : 'yellow'}`}>
          <div className="dt-now-summary-lbl">Stopporsak</div>
          <div className="dt-now-summary-val">{current.stopStageLabel}</div>
          <div className="dt-now-summary-sub">{current.stopReasonText}</div>
        </div>
        <div className="dt-now-summary-card dt-now-summary-card-green">
          <div className="dt-now-summary-lbl">Nästa krav</div>
          <div className="dt-now-summary-val">{current.requirements[0]}</div>
          <div className="dt-now-summary-sub">{current.requirements.slice(1).join(' ')}</div>
        </div>
        <div className="dt-now-summary-card dt-now-summary-card-gray">
          <div className="dt-now-summary-lbl">Lägesbild</div>
          <div className="dt-now-summary-val">{status?.scanner_active ? 'Scanner kör' : 'Scanner pausad'}</div>
          <div className="dt-now-summary-sub">
            {`Runtime active: ${activeCount} · selected: ${selectedCount} · partial: ${partialCount} · öppna paper: ${current.openCount}`}
          </div>
        </div>
      </div>

      <div className="dt-now-pipeline">
        {current.pipelineState.map((step) => (
          <div key={step.id} className={`dt-now-step dt-now-step-${step.tone}`}>
            <div className="dt-now-step-head">
              <div className="dt-now-step-title">
                <span className="dt-now-step-dot" />
                <span>{step.label}</span>
              </div>
              <span className={`dt-badge dt-badge-${step.tone}`}>{stepLabel(step.tone)}</span>
            </div>
            <div className="dt-now-step-text">{sanitizePipeText(step.text)}</div>
          </div>
        ))}
      </div>

      <div className="dt-now-note">
        <strong>Vad det betyder:</strong> {current.stopReasonText} {current.requirements.length ? `För att öppna en trade krävs att ${current.requirements.join(' ')}` : ''}
      </div>
    </div>
  );
}

function badgeColor(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'aktiv') return 'dt-badge-green';
  if (s === 'pausad') return 'dt-badge-yellow';
  if (s.includes('undvik') || s.includes('blockerad')) return 'dt-badge-red';
  if (s === 'testas') return 'dt-badge-blue';
  return 'dt-badge-gray';
}

function runtimeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'aktiv') return 'dt-runtime-active';
  if (s === 'partial' || s === 'delvis') return 'dt-runtime-partial';
  if (s === 'paused' || s === 'pausad') return 'dt-runtime-paused';
  if (s === 'disabled' || s.includes('avstängd')) return 'dt-runtime-paused';
  if (s === 'no_entry_rule' || s.includes('entry')) return 'dt-runtime-data';
  if (s === 'needs_data' || s.includes('behöver')) return 'dt-runtime-data';
  return 'dt-runtime-unlinked';
}

const RUNTIME_FILTERS = [
  { id: 'all', label: 'Alla' },
  { id: 'runtime_ready', label: 'Kan köra paper trades' },
  { id: 'selected_blocked', label: 'Valda men kan inte köra' },
  { id: 'missing_entry', label: 'Saknar entry-regel' },
  { id: 'partial', label: 'Delvis kopplade' },
  { id: 'disabled', label: 'Av' },
  { id: 'catalog_only', label: 'Lab-only' },
];

const LIST_LIMIT_OPTIONS = [
  { id: 10, label: '10' },
  { id: 25, label: '25' },
  { id: 50, label: '50' },
  { id: 0, label: 'Alla' },
];

const MAX_ACTIVE_OPTIONS = [
  { id: 1, label: '1' },
  { id: 3, label: '3' },
  { id: 5, label: '5' },
  { id: 10, label: '10' },
  { id: 0, label: 'Alla Runtime Ready' },
];

function runtimeStatusLabel(state) {
  return {
    RUNTIME_READY: '✅ Kan köra paper trades',
    PARTIAL_RUNTIME: '🟡 Delvis kopplad',
    MISSING_ENTRY: '🔴 Saknar entry-regel',
    CATALOG_ONLY: '⚪ Endast katalog/test',
    DISABLED: 'Av',
  }[state] || 'Av';
}

function strategyRuntimeState(strategy) {
  const cfg = strategy.config || {};
  const runtime = strategy.runtime || {};
  const enabled = strategy.enabled_by_user ?? cfg.enabled_by_user ?? (cfg.active !== false);
  const connected = strategy.connected ?? runtime.connected ?? false;
  const entryRuleImplemented = strategy.entry_rule_implemented ?? runtime.entry_rule_implemented ?? false;
  const runtimeStatus = strategy.runtime_status || runtime.runtime_status || 'not_connected';
  const rawSignals = strategy.runtime_raw_signals || runtime.runtime_raw_signals || [];
  const canCreatePaperTrade = strategy.can_create_paper_trade ?? runtime.can_create_paper_trade ?? false;
  let state = 'CATALOG_ONLY';
  if (!enabled) state = 'DISABLED';
  else if (!connected) state = 'CATALOG_ONLY';
  else if (!entryRuleImplemented) state = 'MISSING_ENTRY';
  else if (runtimeStatus === 'partial' || canCreatePaperTrade === 'partial') state = 'PARTIAL_RUNTIME';
  else if (runtimeStatus === 'active' && canCreatePaperTrade === true) state = 'RUNTIME_READY';
  else if (runtimeStatus === 'paused' || runtimeStatus === 'disabled') state = 'DISABLED';
  else state = 'PARTIAL_RUNTIME';
  return {
    state,
    enabled,
    connected,
    entryRuleImplemented,
    runtimeStatus,
    rawSignals,
    canCreatePaperTrade,
  };
}

function runtimeReasonText(strategy, runtimeState) {
  if (!runtimeState.enabled) return 'Av för paper-runtime.';
  if (!runtimeState.connected) return 'Signal inte kopplad till katalogstrategi.';
  if (!runtimeState.entryRuleImplemented) {
    return runtimeState.state === 'MISSING_ENTRY'
      ? 'Vald men saknar entry-regel.'
      : 'Entry-regel saknas.';
  }
  if (runtimeState.state === 'PARTIAL_RUNTIME') {
    return strategy.runtime_comment_sv || strategy.runtime?.comment_sv || 'Vald men kan inte köra ännu.';
  }
  if (runtimeState.state === 'RUNTIME_READY') return 'Kan skapa paper trades.';
  return 'Vald men kan inte köra ännu.';
}

function pipeClass(status) {
  if (status === 'klar') return 'dt-pipe-klar';
  if (status === 'kor')  return 'dt-pipe-kor';
  if (status === 'blockerad') return 'dt-pipe-blockerad';
  if (status === 'fel')  return 'dt-pipe-fel';
  return 'dt-pipe-vantar';
}

const PIPE_SV = { klar: 'Klar', kor: 'Kör', vantar: 'Väntar', blockerad: 'Blockerad', fel: 'Fel' };
const PIPE_ICONS = {
  data: '⬇', scanner: '⊙', symbol: '◎', strategy: '⬡',
  risk: '⊘', safety: '🔒', paper: '◉', follow: '◷', exit: '↗', result: '▣', learning: '⟳',
};

// ─── A) Status chips ──────────────────────────────────────────────────────────

function Chip({ label, value, color }) {
  return (
    <div className={`dt-chip dt-chip-${color || 'gray'}`}>
      <span className="dt-chip-dot" />
      <span className="dt-chip-label">{label}</span>
      {value && <span className="dt-chip-value">{value}</span>}
    </div>
  );
}

function StatusBar({ status }) {
  if (!status) return null;
  const liveOn = status.live_trading === true || status.live_trading_enabled === true;
  return (
    <div className="dt-status-bar">
      <Chip label="Backend"       value={status.backend_connected ? 'Ansluten' : 'Ej ansluten'} color={status.backend_connected ? 'green' : 'red'} />
      <Chip label="Scanner"       value={status.scanner_active ? 'Aktiv' : 'Pausad'}             color={status.scanner_active ? 'green' : 'yellow'} />
      <Chip label="Data"          value={status.data_active ? 'Aktiv' : 'Saknas'}                color={status.data_active ? 'green' : 'yellow'} />
      <Chip label="Inlärning"     value={status.learning_active ? 'Aktiv' : 'Av'}                color={status.learning_active ? 'green' : 'yellow'} />
      {status.latest_scan && <Chip label="Senaste scan" value={timeSince(status.latest_scan)} color="blue" />}
      <Chip label="Paper trading" value={status.paper_trading ? 'Aktiv' : 'Av'}                  color={status.paper_trading ? 'green' : 'gray'} />
      {liveOn
        ? <Chip label="Live trading" value="Aktiv — kontrollera backend" color="red" />
        : <Chip label="Live trading" value="AV" color="gray" />
      }
    </div>
  );
}

// ─── B) Safety banner ─────────────────────────────────────────────────────────

function SafetyBanner({ status }) {
  const liveOn = status?.live_trading === true || status?.live_trading_enabled === true;
  const paperOn = status?.paper_trading !== false;
  if (liveOn) {
    return (
      <div className="dt-safety-banner dt-safety-warn">
        <span>⚠️</span>
        <div><strong>Varning: live trading verkar vara aktiverat.</strong><span>Kontrollera backend innan du fortsätter.</span></div>
      </div>
    );
  }
  return (
    <div className="dt-safety-banner dt-safety-ok">
      <span>🔒</span>
      <div>
        <div className="dt-safety-title-row">
          <span className="dt-safety-pill dt-safety-pill-paper">🧪 Paper trading: {paperOn ? 'Aktiv' : 'Av'}</span>
          <span className="dt-safety-pill dt-safety-pill-locked">🔒 Riktig order: Låst</span>
          <span className="dt-safety-pill dt-safety-pill-live">Live trading: Av</span>
        </div>
        <strong>Systemet testar bara. Inga riktiga ordrar skickas.</strong>
        <div className="dt-safety-flags">
          <code>actions_allowed=false</code>
          <code>can_place_orders=false</code>
          <code>live_trading_enabled=false</code>
        </div>
      </div>
    </div>
  );
}

function LivePaperBanner({ paperStatus }) {
  const openTrades = paperStatus?.openTrades || [];
  if (!paperStatus?.ok || (paperStatus?.openCount ?? openTrades.length) <= 0) return null;
  const openCount = paperStatus.openCount ?? openTrades.length;
  return (
    <div className="dt-live-paper-banner">
      <div className="dt-live-paper-head">
        <div className="dt-live-paper-kicker">LIVE PAPER TRADE</div>
        <div className="dt-live-paper-title">
          {openCount === 1 ? '1 aktiv paper trade kör just nu' : `${openCount} aktiva paper trades kör just nu`}
        </div>
        <div className="dt-live-paper-sub">Detta är fortfarande paper-only. Du kan följa öppna positioner live här utan att riktiga ordrar skickas.</div>
      </div>
      <div className="dt-live-paper-grid">
        {openTrades.map((trade, i) => {
          const symbol = trade.symbol || '–';
          const direction = trade.direction || '–';
          const strategy = trade.strategy_name || trade.strategy_id || trade.strategy || '–';
          const openedAt = trade.opened_at || trade.entryTime || trade.openedAt || trade.time || null;
          const entry = trade.entryPrice ?? trade.entry ?? trade.entry_price ?? null;
          const current = trade.currentPrice ?? trade.current_price ?? null;
          const pnl = trade.unrealizedPct ?? trade.unrealized_pct ?? trade.pnl ?? null;
          return (
            <div key={`${symbol}-${i}`} className="dt-live-paper-card">
              <div className="dt-live-paper-card-top">
                <div>
                  <div className="dt-live-paper-symbol">{symbol}</div>
                  <div className="dt-live-paper-meta">{direction} · {strategy}</div>
                </div>
                <span className={`dt-live-paper-pnl ${valueTone(pnl)}`}>{fmtPct(pnl)}</span>
              </div>
              {trade.symbol && (
                <div className="dt-live-paper-tv">
                  {openedAt && <SignalAge timestamp={openedAt} />}
                  <TradingViewLink symbol={trade.symbol} marketType={trade.marketType} label="TradingView" size="sm" />
                </div>
              )}
              <div className="dt-live-paper-grid-mini">
                <div><span>Öppnad</span><strong>{openedAt ? fmtTradeTime(openedAt) : '–'}</strong></div>
                <div><span>Ålder</span><strong>{fmtPaperAge(trade.ageMin)}</strong></div>
                <div><span>Entry</span><strong>{fmtPrice(entry)}</strong></div>
                <div><span>Nu</span><strong>{fmtPrice(current)}</strong></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── C) Process just nu ───────────────────────────────────────────────────────

function ProcessCard({ status, pipeline, paperStatus }) {
  const steps = pipeline?.pipeline || [];
  const symStep   = steps.find(s => s.id === 'symbol');
  const stratStep = steps.find(s => s.id === 'strategy');
  const decStep   = steps.find(s => s.id === 'paper');
  const openCount = paperStatus?.openCount ?? paperStatus?.openTrades?.length ?? 0;

  const symbol   = symStep?.text?.match(/^(\S+)\s/)?.[1] ?? '–';
  const stratTxt = stratStep?.text || '';
  const strategy = !stratTxt.includes('Ingen')
    ? (stratTxt.match(/^(.+?)\s+matchade/)?.[1] ?? stratTxt.replace(/\.$/, ''))
    : '–';

  const items = [
    { label: 'Senaste symbol',   value: symbol },
    { label: 'Senaste strategi', value: strategy },
    { label: 'Senaste beslut',   value: sanitizePipeText(decStep?.text) || '–' },
    { label: 'Safety',           value: '🔒 Aktiv',                              cls: 'dt-pv-green' },
    { label: 'Senaste scan',     value: status?.latest_scan ? timeSince(status.latest_scan) : '–' },
    { label: 'Paper trading',    value: status?.paper_trading ? `Aktiv${openCount ? ` · ${openCount} öppen${openCount === 1 ? '' : 'a'}` : ''}` : 'Av',  cls: status?.paper_trading ? 'dt-pv-green' : '' },
    { label: 'Live trading',     value: 'AV',                                    cls: 'dt-pv-gray' },
  ];

  return (
    <div className="dt-process-card">
      <div className="dt-process-title">Process just nu</div>
      <div className="dt-process-grid">
        {items.map(({ label, value, cls }) => (
          <div key={label} className="dt-process-item">
            <div className="dt-process-label">{label}</div>
            <div className={`dt-process-value${cls ? ` ${cls}` : ''}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── D) Pipeline ──────────────────────────────────────────────────────────────

function PipelineSection({ pipeline }) {
  const steps = pipeline?.pipeline || [];
  const activeStep = steps.find(s => s.status === 'kor')
    || [...steps].reverse().find(s => s.status === 'klar' || s.status === 'blockerad');

  function openAi() { document.querySelector('.ai-fab')?.click(); }

  return (
    <div className="dt-panel dt-pipeline-panel">
      <div className="dt-pipeline-header">
        <div>
          <h2 className="dt-pipeline-title">Process från signal till resultat</h2>
          <p className="dt-pipeline-sub">Så går en signal från scan till paper trade, exit, resultat och lärande.</p>
        </div>
        <button type="button" className="dt-ai-hint" onClick={openAi}>Fråga AI om denna pipeline</button>
      </div>

      {!steps.length ? (
        <PlatformEmptyState
          title="Ingen pipeline aktiv just nu"
          text="Pipeline visas när scanner hittar eller analyserar en signal. Kör ny scan."
        />
      ) : (
        <>
          <div className="dt-pipeline-flow">
            {steps.map((step, i) => (
              <React.Fragment key={step.id}>
                {i > 0 && <div className="dt-pipe-arrow">›</div>}
                <div className={`dt-pipe-node ${pipeClass(step.status)}`}>
                  <div className="dt-pipe-node-box">
                    <span className="dt-pipe-node-icon">{PIPE_ICONS[step.id] || '○'}</span>
                    <span className="dt-pipe-node-status">{PIPE_SV[step.status] || '–'}</span>
                  </div>
                  <div className="dt-pipe-node-lbl">{step.label}</div>
                </div>
              </React.Fragment>
            ))}
          </div>
          {activeStep && (
            <div className={`dt-pipe-active-text dt-pipe-text-${pipeClass(activeStep.status).replace('dt-pipe-', '')}`}>
              <strong>{activeStep.label}:</strong> {sanitizePipeText(activeStep.text)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── E) Rekommendation ───────────────────────────────────────────────────────

function RecommendationBar({ rec }) {
  if (!rec?.ok) return null;
  return (
    <div className="dt-rec-bar">
      {rec.best_strategy && (
        <div className="dt-rec-bar-item dt-rec-bar-best">
          <span className="dt-rec-bar-icon">★</span>
          <div>
            <div className="dt-rec-bar-role">Bäst att testa just nu</div>
            <div className="dt-rec-bar-name">{rec.best_strategy.strategy_name}</div>
            {rec.best_strategy.win_rate != null && (
              <div className="dt-rec-bar-sub">{rec.best_strategy.win_rate.toFixed(1)}% WR · score {fmtScore(rec.best_strategy.score)}</div>
            )}
          </div>
        </div>
      )}
      {rec.avoid_strategy && (
        <div className="dt-rec-bar-item dt-rec-bar-avoid">
          <span className="dt-rec-bar-icon">⚠</span>
          <div>
            <div className="dt-rec-bar-role">Undvik i test just nu</div>
            <div className="dt-rec-bar-name">{rec.avoid_strategy.strategy_name}</div>
          </div>
        </div>
      )}
      {rec.recommendation_sv && <p className="dt-rec-bar-text">{rec.recommendation_sv}</p>}
    </div>
  );
}

// ─── F) Marknadskonstanter (för strategi-modal) ──────────────────────────────

const MARKETS   = [{ id:'all',label:'Alla'},{id:'stocks',label:'Aktier'},{id:'nasdaq',label:'Nasdaq'},{id:'crypto',label:'Krypto'},{id:'etf',label:'ETF'}];

// ─── G) Strategikontroll ─────────────────────────────────────────────────────

function StrategyDetailModal({ strategy, onClose, onSave, saving }) {
  const cfg = strategy.config || {};
  const [form, setForm] = useState({
    active: cfg.active !== false, market: cfg.market || 'all',
    direction: cfg.direction || 'both', timeframe: cfg.timeframe || '2m',
    min_score: cfg.min_score ?? 50, min_confidence: cfg.min_confidence ?? 65,
    stop_loss: cfg.stop_loss ?? 0.2, take_profit: cfg.take_profit ?? 1.5,
    max_trades: cfg.max_trades ?? 3, hide_avoid: cfg.hide_avoid || false,
  });
  const set = (k, v) => setForm(f => ({...f, [k]: v}));

  return (
    <div className="dt-modal-overlay" onClick={onClose}>
      <div className="dt-modal" onClick={e => e.stopPropagation()}>
        <div className="dt-modal-head">
          <h3>{strategy.name}</h3>
          <button type="button" className="dt-modal-close" onClick={onClose}>✕</button>
        </div>
        <p className="dt-modal-desc">{strategy.simple_explanation_sv || strategy.description_sv || strategy.explanation}</p>
        <div className="dt-modal-form">
          <div className="dt-form-row"><label>Status</label>
            <div className="dt-pills">
              <button type="button" className={`dt-pill${form.active?' dt-pill-active':''}`} onClick={()=>set('active',true)}>Aktiv</button>
              <button type="button" className={`dt-pill${!form.active?' dt-pill-active':''}`} onClick={()=>set('active',false)}>Pausad</button>
            </div>
          </div>
          <div className="dt-form-row"><label>Marknad</label>
            <select className="dt-filter-select" value={form.market} onChange={e=>set('market',e.target.value)}>
              {MARKETS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div className="dt-form-row"><label>Riktning</label>
            <div className="dt-pills">
              {[['both','Båda'],['long','Long'],['short','Short']].map(([id,lbl])=>(
                <button key={id} type="button" className={`dt-pill${form.direction===id?' dt-pill-active':''}`} onClick={()=>set('direction',id)}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="dt-form-row"><label>Timeframe</label>
            <select className="dt-filter-select" value={form.timeframe} onChange={e=>set('timeframe',e.target.value)}>
              {['1m','2m','5m','15m','30m','1h'].map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="dt-form-row"><label>Min score: <strong>{form.min_score}</strong></label>
            <input type="range" min={0} max={90} step={5} value={form.min_score} onChange={e=>set('min_score',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Min confidence: <strong>{form.min_confidence}%</strong></label>
            <input type="range" min={0} max={100} step={5} value={form.min_confidence} onChange={e=>set('min_confidence',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Stop loss: <strong>{form.stop_loss}%</strong></label>
            <input type="range" min={0.05} max={1} step={0.05} value={form.stop_loss} onChange={e=>set('stop_loss',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Take profit: <strong>{form.take_profit}R</strong></label>
            <input type="range" min={0.5} max={5} step={0.1} value={form.take_profit} onChange={e=>set('take_profit',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Max trades/dag: <strong>{form.max_trades}</strong></label>
            <input type="range" min={1} max={10} step={1} value={form.max_trades} onChange={e=>set('max_trades',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Dölj undvik-signaler</label>
            <div className="dt-pills">
              <button type="button" className={`dt-pill${form.hide_avoid?' dt-pill-active':''}`} onClick={()=>set('hide_avoid',!form.hide_avoid)}>
                {form.hide_avoid ? 'Ja – dolda' : 'Nej – visas'}
              </button>
            </div>
          </div>
        </div>
        <div className="dt-modal-foot">
          <div className="dt-modal-safety">🔒 Ändringar påverkar bara strategi, scanner och paper trading. Riktig handel är avstängd.</div>
          <div className="dt-modal-btns">
            <button type="button" className="dt-btn dt-btn-sec" onClick={onClose}>Avbryt</button>
            <button type="button" className="dt-btn dt-btn-pri" onClick={()=>onSave(form)} disabled={saving}>
              {saving ? 'Sparar...' : 'Spara testinställning'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StrategyCard({ strategy, onUpdate, onScan, paperLimit, activeRuntimeReadyCount }) {
  const [showDetail, setShowDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const cfg = strategy.config || {};
  const enabledByUser = strategy.enabled_by_user ?? cfg.enabled_by_user ?? (cfg.active !== false);
  const runtime = strategy.runtime || {};
  const runtimeState = strategyRuntimeState(strategy);
  const runtimeStatus = strategy.runtime_status || runtime.runtime_status || runtimeState.runtimeStatus || 'not_connected';
  const runtimeSignals = runtimeState.rawSignals;
  const runtimeComment = runtimeReasonText(strategy, runtimeState);
  const paperTrades48h = strategy.paper_trades_48h ?? runtime.paper_trades_48h ?? 0;
  const lastPaperTradeAt = strategy.last_paper_trade_at || runtime.last_paper_trade_at || null;
  const catalogBadges = strategy.catalog_badges || ['Katalog', runtimeStatusLabel(runtimeState.state)];
  const connected = strategy.connected ?? runtime.connected ?? false;
  const entryRuleImplemented = strategy.entry_rule_implemented ?? runtime.entry_rule_implemented ?? false;
  const canCreatePaperTrade = strategy.can_create_paper_trade ?? runtime.can_create_paper_trade ?? false;
  const canActuallyRun = runtimeState.state === 'RUNTIME_READY';
  const runtimeBadge = (() => {
    if (runtimeState.state === 'RUNTIME_READY') return { label: '✅ Kan köra paper trades', tone: 'green' };
    if (runtimeState.state === 'PARTIAL_RUNTIME') return { label: '🟡 Delvis kopplad', tone: 'yellow' };
    if (runtimeState.state === 'MISSING_ENTRY') {
      return {
        label: enabledByUser ? '🔴 Vald men saknar entry-regel' : '🔴 Saknar entry-regel',
        tone: 'red',
      };
    }
    if (runtimeState.state === 'CATALOG_ONLY') {
      return {
        label: enabledByUser ? '⚪ Vald men kan inte köra' : '⚪ Endast katalog/test',
        tone: 'gray',
      };
    }
    return { label: 'Av', tone: 'gray' };
  })();
  const paperButtonLabel = (() => {
    if (enabledByUser) return 'Ta bort från paper';
    if (runtimeState.state === 'MISSING_ENTRY') return 'Kan inte köra — entry saknas';
    if (runtimeState.state === 'PARTIAL_RUNTIME') return 'Kan inte köra — delvis kopplad';
    if (runtimeState.state === 'CATALOG_ONLY') return 'Kan inte köra — endast katalog/test';
    return 'Kan inte köra';
  })();
  const paperButtonDisabled = runtimeSaving || (!enabledByUser && !canActuallyRun);
  const hitRuntimeLimit = canActuallyRun
    && enabledByUser !== true
    && paperLimit > 0
    && activeRuntimeReadyCount >= paperLimit;

  function showToast(msg) { setToast(msg); setTimeout(()=>setToast(null), 2500); }

  async function postUpdate(patch) {
    return fetch(`/api/daytrading/strategies/${strategy.id}/update`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch),
    }).then(r=>r.json()).catch(()=>null);
  }

  async function handleSave(form) {
    setSaving(true);
    const res = await postUpdate(form);
    setSaving(false);
    if (res?.ok) { showToast('Strategin uppdaterad'); setShowDetail(false); onUpdate?.(); }
    else showToast(res?.error || 'Kunde inte spara');
  }

  async function handleToggle(active) {
    if (runtimeSaving) return;
    if (active === true && canActuallyRun && hitRuntimeLimit) {
      showToast(`Max aktiva paper-strategier nått (${paperLimit}).`);
      return;
    }
    setRuntimeSaving(true);
    const res = await fetch(`/api/daytrading/runtime-strategies/${encodeURIComponent(strategy.id)}/toggle`, { method: 'POST' })
      .then(r=>r.json()).catch(()=>null);
    setRuntimeSaving(false);
    if (res?.ok) {
      if (active && runtimeState.state !== 'RUNTIME_READY') {
        showToast(runtimeState.state === 'MISSING_ENTRY'
          ? 'Kan inte aktivera för paper trades. Orsak: Entry-regel saknas.'
          : 'Vald för paper, men strategin är inte runtime-ready ännu.');
      } else {
        showToast(active ? 'Vald för paper' : 'Av från paper');
      }
      onUpdate?.();
    }
    else showToast(res?.error || 'Kunde inte uppdatera strategi-runtime. Försök igen.');
  }

  return (
    <div className={`dt-strategy-card dt-strategy-card-compact ${runtimeBadge.tone === 'green' ? 'dt-card-green' : runtimeBadge.tone === 'yellow' ? 'dt-card-yellow' : runtimeBadge.tone === 'red' ? 'dt-card-red' : 'dt-card-gray'}`}>
      {toast && <div className="dt-toast">{toast}</div>}

      <div className="dt-strategy-head">
        <div className="dt-strategy-title-wrap">
          <div className="dt-strategy-name">{strategy.name}</div>
        </div>
        <span className={`dt-badge dt-badge-${runtimeBadge.tone}`}>{runtimeBadge.label}</span>
      </div>

      <div className="dt-catalog-badges">
        {catalogBadges.map((badge) => (
          <span key={badge} className="dt-catalog-badge">{badge}</span>
        ))}
      </div>

      <div className="dt-strategy-meta">
        <span>{strategy.market_label || cfg.market || '–'}</span>
        <span className="dt-meta-sep">·</span>
        <span>{cfg.direction==='long'?'Long':cfg.direction==='short'?'Short':'Båda'}</span>
        <span className="dt-meta-sep">·</span>
        <span>{cfg.timeframe||'2m'}</span>
      </div>

      <div className="dt-strategy-metrics">
        <div className="dt-metric">
          <div className="dt-metric-val">{strategy.win_rate!=null?`${Number(strategy.win_rate).toFixed(1)}%`:'–'}</div>
          <div className="dt-metric-lbl">Win rate</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val">{fmtPct(strategy.avg_pnl)}</div>
          <div className="dt-metric-lbl">Snitt P/L</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val">{strategy.trades||0}</div>
          <div className="dt-metric-lbl">Trades</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val dt-score">{fmtScore(strategy.score)}</div>
          <div className="dt-metric-lbl">Score</div>
        </div>
      </div>

      <div className={`dt-runtime-box ${runtimeClass(runtimeStatus)}`}>
        <div className="dt-runtime-row">
          <span>Connected</span>
          <strong>{connected ? 'Ja' : 'Nej'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Vald för paper</span>
          <strong>{enabledByUser ? 'Ja' : 'Nej'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Kan köra paper trades</span>
          <strong>{canActuallyRun ? 'Ja' : 'Nej'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Entry-regel</span>
          <strong>{entryRuleImplemented ? (canCreatePaperTrade === 'partial' ? 'Delvis' : 'Implementerad') : 'Saknas'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Rå signal</span>
          <strong>{runtimeSignals.length ? runtimeSignals.join(', ') : '–'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Paper trades 48h</span>
          <strong>{paperTrades48h}</strong>
        </div>
        {lastPaperTradeAt && (
          <div className="dt-runtime-row">
            <span>Senast</span>
            <strong>{new Date(lastPaperTradeAt).toLocaleString('sv-SE',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</strong>
          </div>
        )}
        <div className="dt-runtime-comment">{runtimeComment}</div>
      </div>

      <div className="dt-strategy-actions">
        {enabledByUser
          ? <button type="button" className="dt-btn-sm dt-btn-warn" disabled={runtimeSaving} onClick={()=>handleToggle(false)}>{runtimeSaving ? 'Sparar...' : 'Ta bort från paper'}</button>
          : <button type="button" className="dt-btn-sm dt-btn-ok" disabled={paperButtonDisabled || (canActuallyRun && hitRuntimeLimit)} onClick={()=>handleToggle(true)}>{runtimeSaving ? 'Sparar...' : paperButtonLabel}</button>
        }
        <button type="button" className="dt-btn-sm dt-btn-sec" onClick={()=>onScan?.(strategy.id)}>Kör scan</button>
        <button type="button" className="dt-btn-sm dt-btn-pri" onClick={()=>setShowDetail(true)}>Detaljer</button>
      </div>
      <div className="dt-strategy-mode-note">Vald för paper är inte samma sak som kan köra paper trades. Runtime-status avgör om strategin faktiskt kan skapa paper trades.</div>

      {showDetail && (
        <StrategyDetailModal strategy={strategy} onClose={()=>setShowDetail(false)} onSave={handleSave} saving={saving} />
      )}
    </div>
  );
}

function CollapsibleGroup({ label, colorClass, items, defaultOpen, onUpdate, onScan, paperLimit, activeRuntimeReadyCount }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!items.length) return null;
  return (
    <div className="dt-collapsible-group">
      <button type="button" className="dt-group-toggle" onClick={()=>setOpen(v=>!v)}>
        <span className={`dt-group-chip ${colorClass}`}>{label}</span>
        <span className="dt-group-count-badge">{items.length}</span>
        <span className="dt-group-chevron">{open?'▲':'▼'}</span>
      </button>
      {open && (
        <div className="dt-strategy-grid">
          {items.map(s=><StrategyCard key={s.id} strategy={s} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />)}
        </div>
      )}
    </div>
  );
}

function RuntimeSummary({ runtime }) {
  const summary = runtime?.summary || {};
  return (
    <div className="dt-runtime-summary">
      <div><strong>{summary.total_catalog_strategies ?? 0}</strong><span>Strategier totalt</span></div>
      <div><strong>{summary.enabled_by_user ?? 0}</strong><span>Valda för paper</span></div>
      <div><strong>{summary.can_create_paper_trade_count ?? 0}</strong><span>Kan faktiskt köra</span></div>
      <div><strong>{summary.runtime_no_entry_rule ?? 0}</strong><span>Saknar entry-regel</span></div>
      <div><strong>{summary.runtime_partial ?? 0}</strong><span>Delvis kopplade</span></div>
      <div><strong>{summary.runtime_disabled ?? 0}</strong><span>Av</span></div>
      <div><strong>{summary.runtime_not_connected ?? 0}</strong><span>Lab-only</span></div>
    </div>
  );
}

function StrategiesSection({ strategies, total, runtime, liveTrades, paperStatus, cryptoScan, cryptoScanError, onUpdate, onScan }) {
  const [visibleCount, setVisibleCount] = useState(25);
  const [paperLimit, setPaperLimit] = useState(5);
  const [runtimeFilter, setRuntimeFilter] = useState('all');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState(null);

  async function bulk(path) {
    setBulkBusy(true);
    setRuntimeError(null);
    try {
      const res = await fetch(path, { method: 'POST' }).then(r => r.json()).catch(() => null);
      if (res?.ok) onUpdate?.();
      else setRuntimeError(res?.error || 'Kunde inte uppdatera strategi-runtime. Försök igen.');
    } finally {
      setBulkBusy(false);
    }
  }

  const rows = strategies.map((strategy) => ({
    ...strategy,
    runtimeView: strategyRuntimeState(strategy),
  }));

  const summary = runtime?.summary || {};
  const activeRuntimeReadyCount = summary.can_create_paper_trade_count ?? rows.filter((row) => row.runtimeView.state === 'RUNTIME_READY' && row.runtimeView.enabled).length;
  const selectedCount = summary.enabled_by_user ?? rows.filter((row) => row.runtimeView.enabled).length;
  const selectedBlockedCount = Math.max(0, selectedCount - activeRuntimeReadyCount);
  const missingEntryCount = summary.runtime_no_entry_rule ?? rows.filter((row) => row.runtimeView.state === 'MISSING_ENTRY').length;
  const partialCount = summary.runtime_partial ?? rows.filter((row) => row.runtimeView.state === 'PARTIAL_RUNTIME').length;
  const disabledCount = summary.runtime_disabled ?? rows.filter((row) => row.runtimeView.state === 'DISABLED').length;
  const catalogOnlyCount = rows.filter((row) => row.runtimeView.state === 'CATALOG_ONLY').length;

  const filteredRows = rows.filter((row) => {
    const { state, enabled } = row.runtimeView;
    if (runtimeFilter === 'runtime_ready') return state === 'RUNTIME_READY';
    if (runtimeFilter === 'selected_blocked') return enabled && state !== 'RUNTIME_READY';
    if (runtimeFilter === 'missing_entry') return state === 'MISSING_ENTRY';
    if (runtimeFilter === 'partial') return state === 'PARTIAL_RUNTIME';
    if (runtimeFilter === 'disabled') return state === 'DISABLED';
    if (runtimeFilter === 'catalog_only') return state === 'CATALOG_ONLY';
    return true;
  }).sort((a, b) => {
    const order = { RUNTIME_READY: 0, PARTIAL_RUNTIME: 1, MISSING_ENTRY: 2, CATALOG_ONLY: 3, DISABLED: 4 };
    const oa = order[a.runtimeView.state] ?? 9;
    const ob = order[b.runtimeView.state] ?? 9;
    if (oa !== ob) return oa - ob;
    return (Number(b.score ?? 0) - Number(a.score ?? 0)) || (Number(b.trades ?? 0) - Number(a.trades ?? 0));
  });

  const visibleRows = visibleCount > 0 ? filteredRows.slice(0, visibleCount) : filteredRows;
  const activeReadyRows = visibleRows.filter((row) => row.runtimeView.state === 'RUNTIME_READY');
  const selectedBlockedRows = visibleRows.filter((row) => row.runtimeView.enabled && row.runtimeView.state !== 'RUNTIME_READY');
  const missingEntryRows = visibleRows.filter((row) => row.runtimeView.state === 'MISSING_ENTRY');
  const partialRows = visibleRows.filter((row) => row.runtimeView.state === 'PARTIAL_RUNTIME');
  const catalogRows = visibleRows.filter((row) => row.runtimeView.state === 'CATALOG_ONLY');
  const disabledRows = visibleRows.filter((row) => row.runtimeView.state === 'DISABLED');

  const stoppageTopReasons = liveTrades?.stoppage_summary_48h?.top_reasons || [];
  const topSkipReasons = stoppageTopReasons.slice(0, 5).map((row) => ({
    label: friendlySkipReason(row.reason),
    raw: row.reason || '',
    value: row.count || 0,
  }));
  const explainReasons = [
    { label: 'No entry rule', value: missingEntryCount },
    { label: 'Raw signal saknas', value: rows.filter((row) => row.runtimeView.rawSignals.length === 0).length },
    { label: 'Market closed', value: stoppageTopReasons.find((r) => /stopp|closed|market/i.test(r.reason || ''))?.count || 0 },
    { label: 'Weak volume', value: stoppageTopReasons.find((r) => /svag|weak|low/i.test(r.reason || ''))?.count || 0 },
    { label: 'Runtime partial', value: partialCount },
    { label: 'Conservative mode', value: stoppageTopReasons.find((r) => /conservative|försikt/i.test(r.reason || ''))?.count || 0 },
    { label: 'Strategi pausad', value: disabledCount },
    { label: 'Riskfilter stoppar', value: stoppageTopReasons.find((r) => /risk|block/i.test(r.reason || ''))?.count || 0 },
    { label: 'Signal inte kopplad till katalogstrategi', value: catalogOnlyCount },
  ].filter((item) => item.value > 0);

  return (
    <div className="dt-panel dt-strategies-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Strategi-runtime och paper trades</h3>
        <span className="dt-count-badge">{strategies.length} st</span>
      </div>
      <div className="dt-strategy-bulk-actions">
        <button type="button" className="dt-btn dt-btn-ok" disabled={bulkBusy} onClick={()=>bulk('/api/daytrading/runtime-strategies/enable-all')}>
          Välj alla för paper
        </button>
        <button type="button" className="dt-btn dt-btn-warn" disabled={bulkBusy} onClick={()=>bulk('/api/daytrading/runtime-strategies/disable-all')}>
          Ta bort alla från paper
        </button>
      </div>
      {runtimeError && <div className="dt-inline-error">{runtimeError}</div>}
      <RuntimeSummary runtime={runtime} />
      <CryptoBackendStatusPanel
        scanCrypto={cryptoScan}
        scanCryptoError={cryptoScanError}
        runtime={runtime}
        paperStatus={paperStatus}
      />
      <div className="dt-strategy-explainer">
        <strong>Source of Truth för runtime och paper trading.</strong>
        <span><b>Vald för paper</b> = strategin är markerad i UI.</span>
        <span><b>Runtime active</b> = strategin är tekniskt redo att skapa paper trades.</span>
        <span><b>Kan skapa paper trade</b> = signal + runtime + entry-regler räcker.</span>
        <span><b>Har skapat paper trade</b> = en faktisk trade finns i historiken.</span>
        <div className="dt-strategy-explainer-badges">
          <span>🟢 Active</span>
          <span>🟡 Partial</span>
          <span>🔵 Skipped</span>
          <span>✅ Paper Trade</span>
        </div>
      </div>
      <div className="dt-strategy-explainer">
        <strong>Crypto-routing</strong>
        <span>Historiska crypto-trades kan visas som <b>Crypto Momentum Scalper</b>.</span>
        <span>Nya crypto-VWAP-signaler routas till <b>VWAP Volume Breakout Long</b> eller <b>VWAP Failed Breakout Short</b>.</span>
        <span>Detta påverkar endast nya trades.</span>
      </div>

      <div className="dt-runtime-controls">
        <label className="dt-limit-control">
          <span>Visa antal strategier</span>
          <select value={visibleCount} onChange={e => setVisibleCount(Number(e.target.value))}>
            {LIST_LIMIT_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
          </select>
        </label>
        <label className="dt-limit-control">
          <span>Max aktiva paper-strategier</span>
          <select value={paperLimit} onChange={e => setPaperLimit(Number(e.target.value))}>
            {MAX_ACTIVE_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
          </select>
        </label>
        <label className="dt-limit-control">
          <span>Filter</span>
          <select value={runtimeFilter} onChange={e => setRuntimeFilter(e.target.value)}>
            {RUNTIME_FILTERS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
          </select>
        </label>
      </div>

      <div className="dt-runtime-control-note">
        Visar {visibleRows.length} av {filteredRows.length} strategier. Runtime-ready aktiva: {activeRuntimeReadyCount}. Valda men kan inte köra: {selectedBlockedCount}.
      </div>

      {paperLimit > 0 && activeRuntimeReadyCount > paperLimit && (
        <div className="dt-inline-error">
          Max aktiva paper-strategier är satt till {paperLimit}. {activeRuntimeReadyCount} runtime-ready strategier är valda.
        </div>
      )}

      <div className="dt-runtime-why-panel">
        <div className="dt-runtime-why-title">Topporsaker till att signaler stoppas</div>
        <div className="dt-runtime-why-grid">
          {explainReasons.map((item) => (
            <div key={item.label} className="dt-runtime-why-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
          {topSkipReasons.map((item) => (
            <div key={`${item.label}-${item.raw}`} className="dt-runtime-why-item">
              <span>{item.label}</span>
              {item.raw && item.raw !== item.label && <small>{item.raw}</small>}
              <strong>{item.value}</strong>
            </div>
          ))}
          {explainReasons.length === 0 && (
            <div className="dt-runtime-why-empty">Inga tydliga stopporsaker hittades i de senaste 48 timmarna.</div>
          )}
        </div>
      </div>

      <CollapsibleGroup label="✅ Kan köra paper trades" colorClass="dt-group-green" items={activeReadyRows} defaultOpen={true} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />
      <CollapsibleGroup label="🟡 Delvis kopplade" colorClass="dt-group-yellow" items={partialRows} defaultOpen={false} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />
      <CollapsibleGroup label="🔴 Saknar entry-regel" colorClass="dt-group-red" items={missingEntryRows} defaultOpen={false} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />
      <CollapsibleGroup label="⚪ Lab-only" colorClass="dt-group-gray" items={catalogRows} defaultOpen={false} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />
      <CollapsibleGroup label="Av" colorClass="dt-group-gray" items={disabledRows} defaultOpen={false} onUpdate={onUpdate} onScan={onScan} paperLimit={paperLimit} activeRuntimeReadyCount={activeRuntimeReadyCount} />

      {selectedBlockedRows.length > 0 && (
        <div className="dt-runtime-blocked-note">
          {selectedBlockedRows.length} valda strategier kan inte köra paper trades ännu. Entry-regel eller runtime-koppling saknas.
        </div>
      )}

      {visibleCount > 0 && filteredRows.length > visibleCount && (
        <div className="dt-show-all-wrap">
          <button type="button" className="dt-btn dt-btn-sec" onClick={() => setVisibleCount(0)}>
            Visa alla {filteredRows.length} strategier
          </button>
        </div>
      )}
    </div>
  );
}

// ─── H) Kandidater & paper trades ────────────────────────────────────────────

function tradeRowColor(status) {
  const s = String(status||'').toLowerCase();
  if (s.includes('vinst')||s.includes('paper trade öppnad')) return 'dt-row-green';
  if (s.includes('förlust')) return 'dt-row-red';
  if (s.includes('timeout')) return 'dt-row-yellow';
  if (s.includes('blockerad')) return 'dt-row-gray';
  if (s.includes('pågående')) return 'dt-row-blue';
  return '';
}

function tradeStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('vinst')) return 'dt-status-win';
  if (s.includes('förlust')) return 'dt-status-loss';
  if (s.includes('timeout')) return 'dt-status-timeout';
  if (s.includes('pågående') || s.includes('öppnad')) return 'dt-status-open';
  if (s.includes('block')) return 'dt-status-blocked';
  return 'dt-status-neutral';
}

function runtimeStatusText(trade) {
  return trade.runtime_label || trade.runtime_status || '–';
}

function localTradeSummary(trades) {
  const rows = trades || [];
  const wins = rows.filter(t => String(t.status || '').toLowerCase().includes('vinst') || String(t.result || '').toUpperCase() === 'WIN').length;
  const losses = rows.filter(t => String(t.status || '').toLowerCase().includes('förlust') || String(t.result || '').toUpperCase() === 'LOSS').length;
  const timeout = rows.filter(t => String(t.status || '').toLowerCase().includes('timeout') || String(t.result || '').toUpperCase() === 'TIMEOUT').length;
  const open = rows.filter(t => String(t.status || '').toLowerCase().includes('pågående') || String(t.result || '').toUpperCase() === 'OPEN').length;
  const closed = rows.length - open;
  const pnl = rows.map(t => numericPnl(t.pnl)).filter(v => v != null);
  const total = pnl.reduce((sum, v) => sum + v, 0);
  return {
    total: rows.length,
    wins,
    losses,
    timeout,
    open,
    closed,
    win_rate: closed ? (wins / closed) * 100 : null,
    avg_pl: pnl.length ? total / pnl.length : null,
    total_pl: pnl.length ? total : null,
    best_pl: pnl.length ? Math.max(...pnl) : null,
    worst_pl: pnl.length ? Math.min(...pnl) : null,
    long_up: rows.filter(t => ['UP','LONG'].includes(String(t.direction || '').toUpperCase())).length,
    short_down: rows.filter(t => ['DOWN','SHORT'].includes(String(t.direction || '').toUpperCase())).length,
  };
}

function StatCard({ label, value, tone = 'neutral', sub }) {
  return (
    <div className={`dt-trade-stat dt-trade-stat-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function TradeStats({ summary }) {
  const s = summary || {};
  return (
    <div className="dt-trade-stats">
      <StatCard label="Trades" value={s.total ?? 0} />
      <StatCard label="Vinnare" value={s.wins ?? 0} tone="positive" />
      <StatCard label="Förlorare" value={s.losses ?? 0} tone="negative" />
      <StatCard label="Timeout" value={s.timeout ?? 0} tone="warning" />
      <StatCard label="Pågående" value={s.open ?? 0} tone="info" />
      <StatCard label="Win rate" value={s.win_rate == null ? '–' : `${Number(s.win_rate).toFixed(1)}%`} tone={Number(s.win_rate) >= 50 ? 'positive' : 'neutral'} />
      <StatCard label="Snitt P/L" value={fmtPct(s.avg_pl)} tone={valueTone(s.avg_pl)} />
      <StatCard label="Total P/L" value={fmtPct(s.total_pl)} tone={valueTone(s.total_pl)} />
      <StatCard label="Bästa trade" value={fmtPct(s.best_pl)} tone="positive" />
      <StatCard label="Sämsta trade" value={fmtPct(s.worst_pl)} tone="negative" />
      <StatCard label="Long/up" value={s.long_up ?? 0} tone="info" />
      <StatCard label="Short/down" value={s.short_down ?? 0} tone="neutral" />
    </div>
  );
}

function PaperSignalsSection({ paperSignals, refreshing, refreshError, loading = false }) {
  const status = paperSignals?.status || {};
  const safety = paperSignals?.safety || {};
  const signals = Array.isArray(paperSignals?.signals) ? paperSignals.signals : [];
  const history = Array.isArray(paperSignals?.history) ? paperSignals.history : [];
  const blocked = Array.isArray(paperSignals?.blocked) ? paperSignals.blocked : [];
  const openTrades = Array.isArray(paperSignals?.openTrades) ? paperSignals.openTrades : [];
  const closedTrades = Array.isArray(paperSignals?.closedTrades) ? paperSignals.closedTrades : [];
  const emptyState = paperSignals?.emptyState || {};
  const topBlocked = Array.isArray(emptyState.topBlockedCandidates) && emptyState.topBlockedCandidates.length > 0
    ? emptyState.topBlockedCandidates
    : blocked.slice(0, 5);
  const paperEnabled = status.paperTradingEnabled !== false;
  const latestScanAt = paperSignals?.latestScanAt || status.lastScanAt || null;
  const freshnessWindow = paperSignals?.freshnessWindow?.label || '24h';
  const featuredSignals = signals.slice(0, 5);
  const newestSignal = signals[0] || null;
  const hasFreshSignals = signals.length > 0;

  return (
    <div className="dt-panel">
      <div className="dt-panel-head">
        <div>
          <h3 className="dt-panel-title">Paper Trading Köpsignaler</h3>
          <p className="dt-paper-panel-sub">
            Endast aktuella signaler från senaste scan, eller max 24h, visas i huvudlistan. Gamla signaler och stängda trades hamnar i historik.
          </p>
        </div>
        <div className="dt-paper-status-pills">
          <span className={`dt-paper-pill ${paperEnabled ? 'dt-paper-pill-on' : 'dt-paper-pill-off'}`}>
            Paper Trading: {paperEnabled ? 'På' : 'Av'}
          </span>
          <span className="dt-paper-pill dt-paper-pill-off">Live Trading: AV</span>
          <span className="dt-paper-pill dt-paper-pill-off">Riktiga ordrar: Blockerade</span>
        </div>
      </div>

      <div className="dt-overview-grid dt-paper-status-grid">
        <SummaryTile label="Paper Trading" value={paperEnabled ? 'På' : 'Av'} note={paperEnabled ? 'Paper-läge är aktivt' : 'Paper trade-flödet är avstängt'} tone={paperEnabled ? 'good' : 'warning'} />
        <SummaryTile label="Live Trading" value="AV" note="actions_allowed=false · can_place_orders=false · live_trading_enabled=false" tone="danger" />
        <SummaryTile label="Riktiga ordrar" value="Blockerade" note="Broker används inte" tone="danger" />
        <SummaryTile label="Senaste scan" value={latestScanAt ? timeSince(latestScanAt) : '–'} note={latestScanAt ? fmtTradeTime(latestScanAt) : 'Ingen scan-tid hittad'} />
        <SummaryTile label="Signalens ålder" value={newestSignal ? paperSignalAgeLabel(newestSignal) : '–'} note={newestSignal ? `${fmtTradeTime(newestSignal.signalTimestamp || newestSignal.createdAt)} · ${paperSignalSourceLabel(newestSignal.source)}` : `Fönster: ${freshnessWindow}`} />
        <SummaryTile label="Köpsignaler just nu" value={status.totalSignals ?? signals.length ?? 0} note="Färska kandidater i senaste scannerflödet" />
        <SummaryTile label="Redo för paper trade" value={status.readySignals ?? signals.filter((signal) => signal.status === 'Redo för paper trade').length} note="Kan gå vidare direkt" tone="good" />
        <SummaryTile label="Öppna paper trades" value={status.openPaperTrades ?? openTrades.length} note="Simulerade positioner som fortfarande följs" tone="neutral" />
      </div>

      {refreshing && <div className="dt-paper-note"><strong>Uppdaterar.</strong> Visar senaste kända paper-signaler medan nya svar hämtas.</div>}
      {refreshError && !refreshing && <div className="dt-paper-note"><strong>Senaste uppdatering misslyckades.</strong> Visar senaste data.</div>}

      <div className="dt-paper-rail-grid">
        <div className="dt-paper-rail">
          <div className="dt-paper-rail-head">
            <h4>Öppna paper trades</h4>
            <span>{openTrades.length}</span>
          </div>
          {openTrades.length > 0 ? openTrades.slice(0, 5).map((trade) => (
            <div key={trade.tradeId || `${trade.symbol}-${trade.createdAt}`} className="dt-paper-mini-row">
              <strong>{trade.symbol || '–'}</strong>
              <span>{trade.strategy || 'Paper-strategi'}</span>
              <small>{fmtTradeTime(trade.createdAt || trade.tradeTimestamp)} · {paperSignalAgeLabel(trade)} · {paperSignalSourceLabel(trade.source)}</small>
            </div>
          )) : (
            <div className="dt-paper-mini-empty">Inga öppna paper trades just nu.</div>
          )}
        </div>

        <div className="dt-paper-rail">
          <div className="dt-paper-rail-head">
            <h4>Historik</h4>
            <span>{history.length}</span>
          </div>
          {history.length > 0 ? history.slice(0, 5).map((item) => (
            <div key={item.tradeId || `${item.symbol}-${item.signalTimestamp || item.tradeTimestamp || item.createdAt || item.status}`} className="dt-paper-mini-row">
              <strong>{item.symbol || '–'}</strong>
              <span>{paperSignalSourceLabel(item.source)} · {item.status || 'Historik'}</span>
              <small>{fmtTradeTime(item.signalTimestamp || item.tradeTimestamp || item.createdAt)} · {paperSignalAgeLabel(item)}</small>
            </div>
          )) : (
            <div className="dt-paper-mini-empty">Ingen historik att visa ännu.</div>
          )}
        </div>

        <div className="dt-paper-rail">
          <div className="dt-paper-rail-head">
            <h4>Blockerade signaler</h4>
            <span>{blocked.length}</span>
          </div>
          {blocked.length > 0 ? blocked.slice(0, 5).map((row) => (
            <div key={`${row.symbol}-${row.strategy}-${row.reason}`} className="dt-paper-mini-row">
              <strong>{row.symbol || '–'}</strong>
              <span>{row.reason || 'Blockerad'}</span>
              <small>{row.requiredFix || 'Kontrollera blockeringsorsaken'}</small>
            </div>
          )) : (
            <div className="dt-paper-mini-empty">Inga blockerade signaler just nu.</div>
          )}
        </div>
      </div>

      {loading && !paperSignals ? (
        <div className="dt-paper-empty">
          <div className="dt-loading-inline">
            <span className="spinner" style={{ width: 16, height: 16 }} />
            <span>Hämtar paper trading-signaler…</span>
          </div>
        </div>
      ) : hasFreshSignals ? (
        <>
          <div className="dt-paper-signal-cards">
            {featuredSignals.map((signal, index) => (
              <article key={`${signal.symbol || 'signal'}-${signal.signalTimestamp || signal.createdAt || signal.tradeId || index}`} className={`dt-paper-signal-card ${paperSignalRowClass(signal.status)}`}>
                <div className="dt-paper-signal-card-head">
                  <div>
                    <div className="dt-paper-signal-symbol">{signal.symbol || '–'}</div>
                    <div className="dt-paper-signal-meta">
                      {marketLabelSv(signal.market)} · {signal.strategy || '–'}
                    </div>
                  </div>
                  <div className="dt-paper-signal-head-right">
                    <span className={`dt-status-tag ${paperSignalStatusClass(signal.status)}`}>{signal.status || '–'}</span>
                    <span className="dt-paper-signal-side">{signal.side || 'Vänta'}</span>
                  </div>
                </div>

                <div className="dt-paper-signal-primary">
                  {paperSignalHeadline(signal)}
                </div>

                <div className="dt-paper-signal-metrics">
                  <div className="dt-paper-signal-metric">
                    <span>Score</span>
                    <strong>{signal.score != null ? fmtScore(signal.score) : '–'}</strong>
                  </div>
                  <div className="dt-paper-signal-metric">
                    <span>Confidence</span>
                    <strong>{signal.confidence != null ? `${fmtScore(signal.confidence)}%` : '–'}</strong>
                  </div>
                  <div className="dt-paper-signal-metric">
                    <span>Entry</span>
                    <strong className="dt-mono-cell">{fmtPrice(signal.entry)}</strong>
                  </div>
                  <div className="dt-paper-signal-metric">
                    <span>Risk/reward</span>
                    <strong className="dt-mono-cell">{fmtRiskReward(signal.riskReward)}</strong>
                  </div>
                </div>

                <div className="dt-paper-signal-meta-row">
                  <span>{fmtTradeTime(signal.signalTimestamp || signal.createdAt)} · {paperSignalAgeLabel(signal)} · {paperSignalSourceLabel(signal.source)}</span>
                  <span>{paperSignalAction(signal.status)}</span>
                </div>
              </article>
            ))}
          </div>

          <div className="dt-table-wrap">
            <div className="dt-paper-note" style={{ marginBottom: 10 }}>
              <strong>Detaljvy.</strong> Tabellen visar bara färska signaler. Gamla signaler finns i historiken längre ned.
            </div>
            <table className="dt-table dt-paper-signals-table">
              <thead>
                <tr>
                  <th>Tid</th>
                  <th>Ålder</th>
                  <th>Symbol</th>
                  <th>Marknad</th>
                  <th>Signal</th>
                  <th>Strategi</th>
                  <th>Score</th>
                  <th>Confidence</th>
                  <th>Entry</th>
                  <th>Stop loss</th>
                  <th>Take profit</th>
                  <th>Risk/reward</th>
                  <th>Status</th>
                  <th>Källa</th>
                  <th>Orsak</th>
                  <th>Åtgärd</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal, index) => (
                  <tr key={`${signal.symbol || 'signal'}-${signal.signalTimestamp || signal.createdAt || signal.tradeId || index}`} className={paperSignalRowClass(signal.status)}>
                    <td className="dt-td-time">{signal.signalTimestamp || signal.createdAt ? fmtTradeTime(signal.signalTimestamp || signal.createdAt) : '–'}</td>
                    <td>{paperSignalAgeLabel(signal)}</td>
                    <td className="dt-td-sym"><strong>{signal.symbol || '–'}</strong></td>
                    <td>{marketLabelSv(signal.market)}</td>
                    <td>{signal.side || 'Vänta'}</td>
                    <td className="dt-td-strategy">{signal.strategy || '–'}</td>
                    <td>{signal.score != null ? fmtScore(signal.score) : '–'}</td>
                    <td>{signal.confidence != null ? `${fmtScore(signal.confidence)}%` : '–'}</td>
                    <td className="dt-mono-cell">{fmtPrice(signal.entry)}</td>
                    <td className="dt-mono-cell">{fmtPrice(signal.stopLoss)}</td>
                    <td className="dt-mono-cell">{fmtPrice(signal.takeProfit)}</td>
                    <td className="dt-mono-cell">{fmtRiskReward(signal.riskReward)}</td>
                    <td><span className={`dt-status-tag ${paperSignalStatusClass(signal.status)}`}>{signal.status || '–'}</span></td>
                    <td>{paperSignalSourceLabel(signal.source)}</td>
                    <td className="dt-signal-reason">{signal.blockerReason || signal.reason || '–'}</td>
                    <td><span className="dt-paper-action">{paperSignalAction(signal.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="dt-paper-empty">
          <h4>Inga färska paper trading-köpsignaler just nu</h4>
          <p>{emptyState.waitingFor || 'Väntar på nästa scan eller nya kandidater inom 24h.'}</p>
          <div className="dt-paper-empty-meta">
            <span>Senaste scan: {latestScanAt ? fmtTradeTime(latestScanAt) : '–'}</span>
            <span>Kandidater kontrollerade: {status.candidatesChecked ?? 0}</span>
            <span>Blockerade: {status.blockedSignals ?? blocked.length ?? 0}</span>
          </div>
          <div className="dt-paper-empty-blocks">
            {topBlocked.length > 0 ? topBlocked.map((candidate, index) => (
              <div key={`${candidate.symbol || 'blocked'}-${candidate.strategy || index}`} className="dt-paper-empty-block">
                <strong>{candidate.symbol || '–'} — blockerad</strong>
                <span>{candidate.reason || 'Blockerad'}</span>
                <small>{candidate.score != null ? `score ${candidate.score}` : 'score saknas'}{candidate.requiredFix ? ` · ${candidate.requiredFix}` : ''}</small>
              </div>
            )) : (
              <div className="dt-paper-empty-block">
                <strong>Inga blockerade kandidater sparade</strong>
                <span>Systemet väntar på ny scannerdata eller nästa bekräftade entry.</span>
              </div>
            )}
          </div>
        </div>
      )}

      <DetailsBlock summary="Visa mer om tekniska detaljer">
        <div className="dt-overview-grid">
          <SummaryTile label="Kandidater kontrollerade" value={status.candidatesChecked ?? 0} note="Senaste scannerflödet" />
          <SummaryTile label="Väntar" value={status.waitingSignals ?? 0} note="Saknar bekräftad entry eller kompletterande data" />
          <SummaryTile label="Stängda paper trades" value={status.closedPaperTrades ?? closedTrades.length} note="Historik från paper-trading" />
          <SummaryTile label="Systemets väntan" value={emptyState.waitingFor || '–'} note="Vad flödet väntar på just nu" wide text />
        </div>
      </DetailsBlock>
    </div>
  );
}

function TodayPaperTradesSection({ paperTrades, paperStatus, paperSignals, loading = false }) {
  const todayTrades = Array.isArray(paperTrades?.todayTrades) ? paperTrades.todayTrades : [];
  const todayOpenTrades = Array.isArray(paperTrades?.todayOpenTrades) ? paperTrades.todayOpenTrades : [];
  const todayClosedTrades = Array.isArray(paperTrades?.todayClosedTrades) ? paperTrades.todayClosedTrades : [];
  const historicalTrades = Array.isArray(paperTrades?.historicalTrades) ? paperTrades.historicalTrades : [];
  const todayStats = paperTrades?.todayStats || {};
  const paperEnabled = paperStatus?.enabled !== false;
  const latestScanAt = paperSignals?.status?.lastScanAt || paperSignals?.latestScanAt || null;
  const todayDate = new Date().toISOString().slice(0, 10);
  const latestScanIsToday = latestScanAt ? String(latestScanAt).slice(0, 10) === todayDate : false;
  const checkedToday = latestScanIsToday ? (paperSignals?.status?.candidatesChecked ?? 0) : 0;
  const blockedToday = latestScanIsToday ? (paperSignals?.status?.blockedSignals ?? 0) : 0;
  const whyNone = paperSignals?.emptyState?.waitingFor
    || paperSignals?.emptyState?.topBlockedCandidates?.[0]?.reason
    || (paperEnabled ? 'Paper-tradingreglerna skapade inga nya trades idag.' : 'Paper Trading är avstängt.');
  const newestTrade = todayTrades[0] || null;
  const sortedTodayTrades = [...todayTrades].sort((a, b) => {
    const aTime = new Date(a.time || a.opened_at || a.entryTime || a.createdAt || 0).getTime() || 0;
    const bTime = new Date(b.time || b.opened_at || b.entryTime || b.createdAt || 0).getTime() || 0;
    return bTime - aTime;
  });
  const sortedHistory = [...historicalTrades].sort((a, b) => {
    const aTime = new Date(a.time || a.opened_at || a.entryTime || a.closed_at || a.exitTime || a.createdAt || 0).getTime() || 0;
    const bTime = new Date(b.time || b.opened_at || b.entryTime || b.closed_at || b.exitTime || b.createdAt || 0).getTime() || 0;
    return bTime - aTime;
  });
  const hasTodayTrades = sortedTodayTrades.length > 0;

  return (
    <div className="dt-panel">
      <div className="dt-panel-head">
        <div>
          <h3 className="dt-panel-title">Dagens Paper Trades</h3>
          <p className="dt-paper-panel-sub">
            Visar bara trades som hör till idag. Öppna trades ligger kvar här, stängda trades från andra dagar flyttas till historik.
          </p>
        </div>
        <div className="dt-paper-status-pills">
          <span className={`dt-paper-pill ${paperEnabled ? 'dt-paper-pill-on' : 'dt-paper-pill-off'}`}>
            Paper Trading: {paperEnabled ? 'På' : 'Av'}
          </span>
          <span className="dt-paper-pill dt-paper-pill-off">Live Trading: AV</span>
          <span className="dt-paper-pill dt-paper-pill-off">Riktiga ordrar: Blockerade</span>
        </div>
      </div>

      <div className="dt-overview-grid dt-paper-status-grid">
        <SummaryTile label="Antal trades idag" value={todayStats.totalTrades ?? sortedTodayTrades.length ?? 0} note={`Datum: ${todayStats.date || new Date().toISOString().slice(0, 10)}`} />
        <SummaryTile label="Öppna trades idag" value={todayStats.openTrades ?? todayOpenTrades.length ?? 0} note="Öppna paper trades som fortfarande följs" tone="good" />
        <SummaryTile label="Stängda trades idag" value={todayStats.closedTrades ?? todayClosedTrades.length ?? 0} note="Trades som avslutats under dagens datum" />
        <SummaryTile label="Vinst/förlust idag" value={todayStats.pnlPercent != null ? fmtPct(todayStats.pnlPercent) : '–'} note={`Wins: ${todayStats.wins ?? 0} · Losses: ${todayStats.losses ?? 0}`} tone={Number(todayStats.pnlPercent) > 0 ? 'good' : Number(todayStats.pnlPercent) < 0 ? 'danger' : 'neutral'} />
        <SummaryTile label="Win rate idag" value={todayStats.winRate != null ? `${Number(todayStats.winRate).toFixed(1)}%` : '–'} note="Bara stängda trades används i win rate" tone={Number(todayStats.winRate) >= 50 ? 'good' : 'neutral'} />
        <SummaryTile label="Senaste paper trade" value={todayStats.latestTradeAt ? timeSince(todayStats.latestTradeAt) : '–'} note={todayStats.latestTradeAt ? fmtTradeTime(todayStats.latestTradeAt) : 'Ingen trade ännu'} />
        <SummaryTile label="Senaste stängda trade" value={todayStats.latestClosedTradeAt ? timeSince(todayStats.latestClosedTradeAt) : '–'} note={todayStats.latestClosedTradeAt ? fmtTradeTime(todayStats.latestClosedTradeAt) : 'Ingen stängd trade idag'} />
        <SummaryTile label="Senaste scan" value={latestScanAt ? timeSince(latestScanAt) : '–'} note={latestScanAt ? fmtTradeTime(latestScanAt) : 'Ingen scan-tid hittad'} />
      </div>

      {loading && !paperTrades ? (
        <div className="dt-paper-empty">
          <div className="dt-loading-inline">
            <span className="spinner" style={{ width: 16, height: 16 }} />
            <span>Hämtar dagens paper trades…</span>
          </div>
        </div>
      ) : hasTodayTrades ? (
        <div className="dt-table-wrap">
          <div className="dt-paper-note" style={{ marginBottom: 10 }}>
            <strong>Dagens trades.</strong> Öppna trades visas alltid. Stängda trades från idag visas tillsammans med dem, och äldre trades hamnar i historik.
          </div>
          <table className="dt-table dt-paper-signals-table">
            <thead>
              <tr>
                <th>Tid</th>
                <th>Symbol</th>
                <th>Strategi</th>
                <th>Long/Short</th>
                <th>Entry</th>
                <th>Nuvarande pris / exit</th>
                <th>P/L %</th>
                <th>P/L kr</th>
                <th>Status</th>
                <th>Exit reason</th>
                <th>Trade age</th>
                <th>Learning</th>
              </tr>
            </thead>
            <tbody>
              {sortedTodayTrades.map((trade, index) => (
                <tr key={trade.trade_id || `${trade.symbol}-${trade.time || trade.opened_at || trade.entryTime || index}`} className={paperTradeStatusClass(trade.status)}>
                  <td className="dt-td-time">{fmtTradeTime(trade.time || trade.opened_at || trade.entryTime || trade.createdAt)}</td>
                  <td className="dt-td-sym"><strong>{trade.symbol || '–'}</strong></td>
                  <td className="dt-td-strategy">{trade.strategy || 'Paper-strategi'}</td>
                  <td>{trade.direction || '–'}</td>
                  <td className="dt-mono-cell">{fmtPrice(trade.entry)}</td>
                  <td className="dt-mono-cell">{fmtPrice(trade.current_price ?? trade.exit)}</td>
                  <td className={valueTone(trade.pnl) === 'positive' ? 'dt-positive' : valueTone(trade.pnl) === 'negative' ? 'dt-negative' : ''}>{fmtPct(trade.pnl)}</td>
                  <td className={trade.pnlKr != null ? (trade.pnlKr >= 0 ? 'dt-positive' : 'dt-negative') : ''}>{trade.pnlKr != null ? `${trade.pnlKr >= 0 ? '+' : ''}${trade.pnlKr.toFixed(2)} kr` : '–'}</td>
                  <td><span className={`dt-status-tag ${paperTradeStatusClass(trade.status)}`}>{trade.status || '–'}</span></td>
                  <td>{paperTradeExitLabel(trade)}</td>
                  <td>{trade.age_minutes != null ? fmtPaperAge(trade.age_minutes) : '–'}</td>
                  <td>{paperTradeLearningLabel(trade)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dt-paper-empty">
          <h4>Inga paper trades idag ännu</h4>
          <p>{whyNone}</p>
          <div className="dt-paper-empty-meta">
            <span>Paper Trading: {paperEnabled ? 'På' : 'Av'}</span>
            <span>Senaste scan: {latestScanAt ? fmtTradeTime(latestScanAt) : '–'}</span>
            <span>Antal signaler kontrollerade idag: {checkedToday}</span>
            <span>Antal blockerade idag: {blockedToday}</span>
          </div>
          <div className="dt-paper-empty-blocks">
            <div className="dt-paper-empty-block">
              <strong>Varför inga paper trades skapades</strong>
              <span>{whyNone}</span>
              <small>{newestTrade ? `Senaste möjliga trade: ${newestTrade.symbol || '–'} · ${paperTradeStatusLabel(newestTrade)}` : 'Ingen trade skapades idag.'}</small>
            </div>
          </div>
        </div>
      )}

      <DetailsBlock summary="Visa historik" defaultOpen={false}>
        <div className="dt-paper-note" style={{ marginBottom: 10 }}>
          <strong>Historik.</strong> Gamla trades visas här för referens, inte som dagens trades.
        </div>
        {sortedHistory.length > 0 ? (
          <div className="dt-table-wrap">
            <table className="dt-table dt-paper-signals-table">
              <thead>
                <tr>
                  <th>Tid</th>
                  <th>Symbol</th>
                  <th>Strategi</th>
                  <th>Status</th>
                  <th>Exit reason</th>
                  <th>P/L %</th>
                  <th>Learning</th>
                </tr>
              </thead>
              <tbody>
                {sortedHistory.slice(0, 25).map((trade, index) => (
                  <tr key={trade.trade_id || `${trade.symbol}-${trade.time || trade.opened_at || trade.closed_at || index}`} className={paperTradeStatusClass(trade.status)}>
                    <td className="dt-td-time">{fmtTradeTime(trade.time || trade.opened_at || trade.entryTime || trade.closed_at || trade.exitTime)}</td>
                    <td className="dt-td-sym"><strong>{trade.symbol || '–'}</strong></td>
                    <td className="dt-td-strategy">{trade.strategy || 'Paper-strategi'}</td>
                    <td><span className={`dt-status-tag ${paperTradeStatusClass(trade.status)}`}>{trade.status || '–'}</span></td>
                    <td>{paperTradeExitLabel(trade)}</td>
                    <td>{fmtPct(trade.pnl)}</td>
                    <td>{paperTradeLearningLabel(trade)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <PlatformEmptyState title="Ingen historik ännu" text="När trades från tidigare dagar finns, visas de här utan att blandas in i dagens lista." />
        )}
      </DetailsBlock>
    </div>
  );
}

function StrategyDiagnosticsSection({ paperStrategyDiagnostics, loading = false }) {
  const summary = paperStrategyDiagnostics?.summary || {};
  const allStrategies = Array.isArray(paperStrategyDiagnostics?.strategies) ? paperStrategyDiagnostics.strategies : [];
  const tradedStrategies = Array.isArray(paperStrategyDiagnostics?.tradedStrategies) ? paperStrategyDiagnostics.tradedStrategies : [];
  const blockedStrategies = Array.isArray(paperStrategyDiagnostics?.blockedStrategies) ? paperStrategyDiagnostics.blockedStrategies : [];
  const neverTriggeredStrategies = Array.isArray(paperStrategyDiagnostics?.neverTriggeredStrategies) ? paperStrategyDiagnostics.neverTriggeredStrategies : [];
  const blockerReasons = Array.isArray(paperStrategyDiagnostics?.blockerReasons) ? paperStrategyDiagnostics.blockerReasons : [];
  const activeStrategies = allStrategies.filter((row) => row.enabled_by_user === true).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  return (
    <div className="dt-panel">
      <div className="dt-panel-head">
        <div>
          <h3 className="dt-panel-title">Strategier i Paper Trading</h3>
          <p className="dt-paper-panel-sub">
            Read-only diagnostik som visar vilka strategier som är aktiva, vilka som faktiskt har tradat, vilka som blockeras och vilka som aldrig triggas.
          </p>
        </div>
        <div className="dt-paper-status-pills">
          <span className="dt-paper-pill dt-paper-pill-off">Live Trading: AV</span>
          <span className="dt-paper-pill dt-paper-pill-off">actions_allowed=false</span>
          <span className="dt-paper-pill dt-paper-pill-off">can_place_orders=false</span>
        </div>
      </div>

      <div className="dt-overview-grid dt-paper-status-grid">
        <SummaryTile label="Totalt strategier" value={summary.totalStrategies ?? allStrategies.length ?? 0} note="Alla registrerade i katalogen" />
        <SummaryTile label="Aktiva strategier" value={summary.enabledStrategies ?? activeStrategies.length ?? 0} note="enabled_by_user=true" tone="good" />
        <SummaryTile label="Strategier med paper trades" value={summary.strategiesWithPaperTrades ?? tradedStrategies.length ?? 0} note="Har minst en trade i historiken" />
        <SummaryTile label="Strategier med signaler" value={summary.strategiesWithSignals ?? 0} note="Har fått kandidater eller trades" />
        <SummaryTile label="Strategier blockerade" value={summary.strategiesBlocked ?? blockedStrategies.length ?? 0} note="Har kandidater som stoppats" tone="warning" />
        <SummaryTile label="Aldrig triggat" value={summary.strategiesNeverTriggered ?? neverTriggeredStrategies.length ?? 0} note="Aktiva men utan signal/trade" tone="danger" />
      </div>

      {loading && !paperStrategyDiagnostics ? (
        <div className="dt-paper-empty">
          <div className="dt-loading-inline">
            <span className="spinner" style={{ width: 16, height: 16 }} />
            <span>Hämtar strategi-diagnostik…</span>
          </div>
        </div>
      ) : (
        <>
          <div className="dt-paper-rail-grid">
            <div className="dt-paper-rail">
              <div className="dt-paper-rail-head">
                <h4>Aktiva strategier</h4>
                <span>{activeStrategies.length}</span>
              </div>
              {activeStrategies.length > 0 ? activeStrategies.slice(0, 8).map((row) => (
                <div key={row.id} className="dt-paper-mini-row">
                  <strong>{row.name || row.id}</strong>
                  <span>{row.market_group || '–'} · {row.runtime_status || '–'} · {row.enabled_by_user ? 'på' : 'av'}</span>
                  <small>{row.entry_rule_implemented ? 'entry OK' : 'saknar entry'} · {row.exit_rule_implemented ? 'exit OK' : 'saknar exit'} · trades {row.paper_trades_total ?? 0}</small>
                </div>
              )) : (
                <div className="dt-paper-mini-empty">Inga aktiva strategier hittades.</div>
              )}
            </div>

            <div className="dt-paper-rail">
              <div className="dt-paper-rail-head">
                <h4>Traded idag</h4>
                <span>{tradedStrategies.filter((row) => (row.paper_trades_today ?? 0) > 0).length}</span>
              </div>
              {tradedStrategies.length > 0 ? tradedStrategies.filter((row) => (row.paper_trades_today ?? 0) > 0).slice(0, 8).map((row) => (
                <div key={row.id} className="dt-paper-mini-row">
                  <strong>{row.name}</strong>
                  <span>{row.paper_trades_today ?? 0} idag · {row.paper_trades_total ?? 0} totalt</span>
                  <small>W/L/T: {row.wins ?? 0}/{row.losses ?? 0}/{row.timeouts ?? 0} · {row.runtime_status || '–'}</small>
                </div>
              )) : (
                <div className="dt-paper-mini-empty">Inga strategier har skapat trades idag.</div>
              )}
            </div>

            <div className="dt-paper-rail">
              <div className="dt-paper-rail-head">
                <h4>Strategier blockerade</h4>
                <span>{blockedStrategies.length}</span>
              </div>
              {blockedStrategies.length > 0 ? blockedStrategies.slice(0, 8).map((row) => (
                <div key={row.id} className="dt-paper-mini-row">
                  <strong>{row.name}</strong>
                  <span>{row.blocked_count ?? 0} blockerade kandidater</span>
                  <small>{row.top_reasons?.[0]?.reason || 'Ingen blockeringsorsak sparad'}</small>
                </div>
              )) : (
                <div className="dt-paper-mini-empty">Inga blockerade strategier i senaste kandidatlogg.</div>
              )}
            </div>
          </div>

          <DetailsBlock summary="Visa strategier som aldrig triggas" defaultOpen={false}>
            {neverTriggeredStrategies.length > 0 ? (
              <div className="dt-table-wrap">
                <table className="dt-table dt-paper-signals-table">
                  <thead>
                    <tr>
                      <th>Strategi</th>
                      <th>Market</th>
                      <th>Status</th>
                      <th>Entry</th>
                      <th>Exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {neverTriggeredStrategies.slice(0, 20).map((row) => (
                      <tr key={row.id}>
                        <td><strong>{row.name}</strong><div className="dt-table-sub">{row.id}</div></td>
                        <td>{row.market_group || '–'}</td>
                        <td>{row.runtime_status || '–'}</td>
                        <td>{row.entry_rule_implemented ? 'Ja' : 'Nej'}</td>
                        <td>{row.exit_rule_implemented ? 'Ja' : 'Nej'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <PlatformEmptyState title="Inga strategier i never-triggered-listan" text="Alla aktiva strategier har åtminstone fått en signal eller trade i senaste datan." />
            )}
          </DetailsBlock>

          <DetailsBlock summary="Visa top blockeringsorsaker" defaultOpen={false}>
            {blockerReasons.length > 0 ? (
              <div className="dt-paper-rail-grid">
                <div className="dt-paper-rail">
                  <div className="dt-paper-rail-head">
                    <h4>Orsaker</h4>
                    <span>{blockerReasons.length}</span>
                  </div>
                  {blockerReasons.slice(0, 10).map((row) => (
                    <div key={row.reason} className="dt-paper-mini-row">
                      <strong>{row.reason}</strong>
                      <span>{row.count} gånger</span>
                      <small>{row.strategies?.length ? `${row.strategies.length} strategier` : 'Ingen strategikoppling'}</small>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <PlatformEmptyState title="Inga blockeringsorsaker funna" text="Kandidatloggen gav inga blockerade strategier i senaste fönstret." />
            )}
          </DetailsBlock>
        </>
      )}
    </div>
  );
}

function TradeModal({ trade, onClose }) {
  return (
    <div className="dt-modal-overlay" onClick={onClose}>
      <div className="dt-modal dt-modal-sm" onClick={e=>e.stopPropagation()}>
        <div className="dt-modal-head">
          <h3>Analys: {trade.symbol}</h3>
          <button type="button" className="dt-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="dt-analyze">
          {[
            ['Symbol',trade.symbol],['Strategi',trade.strategy],['Riktning',trade.direction],
            ['Rå signal',trade.raw_signal],['Katalogstrategi',trade.catalog_strategy],
            ['Mapping',trade.catalog_mapping_confidence],['Runtime',runtimeStatusText(trade)],
            ['Status',trade.status],['Anledning',trade.reason],
            ['Entry',fmtPrice(trade.entry)],['Exit',fmtPrice(trade.exit)],
            ['Stop loss',trade.stop_loss!=null?`${trade.stop_loss}%`:null],
            ['Take profit',trade.take_profit!=null?`${trade.take_profit}R`:null],
            ['P/L',fmtPct(trade.pnl)],['Confidence',trade.confidence!=null?`${trade.confidence}%`:null],
            ['Risk/block',fmtReason(trade.risk_reason || trade.block_reason)],
            ['Exit reason',trade.exit_reason],['Duration',trade.duration],
          ].map(([lbl,val])=>val!=null?(
            <div key={lbl} className="dt-analyze-row"><span>{lbl}</span><span>{val}</span></div>
          ):null)}
          {trade.catalog_mapping_note && (
            <div className="dt-analyze-row"><span>Kommentar</span><span>{trade.catalog_mapping_note}</span></div>
          )}
          <div className="dt-analyze-row dt-analyze-safety">
            <span>Safety</span><span>🔒 Riktiga ordrar är blockerade · endast paper/test</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const TRADE_LIMITS = [50, 100, 200];

function LiveTradesSection({ liveTrades, tradeLimit, onTradeLimitChange, refreshing, refreshError }) {
  const [selected, setSelected] = useState(null);
  const hasLiveTrades = Boolean(liveTrades) && typeof liveTrades === 'object' && Array.isArray(liveTrades.trades);
  const trades = hasLiveTrades ? liveTrades.trades : [];
  const summaryStats = liveTrades?.summary || localTradeSummary(trades);
  const summary = liveTrades?.summary_48h || {};
  const stoppage = liveTrades?.stoppage_summary_48h || {};
  const source = liveTrades?.source_of_truth || {};
  const runtimeSummary = liveTrades?.runtime_summary || {};
  const runtimeStrategies = liveTrades?.runtime_strategies || [];
  const strategiesWithTrades = runtimeStrategies
    .filter(s => (s.paper_trades_48h ?? 0) > 0)
    .sort((a, b) => (b.paper_trades_48h ?? 0) - (a.paper_trades_48h ?? 0));
  const selectedZeroTrade = runtimeStrategies.filter(s => (s.enabled_by_user === true) && (s.paper_trades_48h ?? 0) === 0);
  const noTradeReason = summary.other_strategies === 0
    ? 'Valda strategier saknar aktiv entry-regel eller stoppas innan paper trade.'
    : stoppage.text_sv || 'Signal hittades men reglerna stoppade entry innan paper trade skapades.';
  return (
    <div className="dt-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Kandidater &amp; paper trades</h3>
        <div className="dt-panel-actions">
          <label className="dt-limit-control">
            <span>Visa senaste</span>
            <select value={tradeLimit} onChange={e=>onTradeLimitChange(Number(e.target.value))}>
              {TRADE_LIMITS.map(limit => <option key={limit} value={limit}>{limit}</option>)}
            </select>
          </label>
          <span className="dt-count-badge">{trades.length} st</span>
        </div>
      </div>
      <div className="dt-paper-note"><strong>Paper-only.</strong> Detta är test-/paper trades. Inga riktiga ordrar skickas.</div>
      <div className="dt-paper-note"><strong>Historik.</strong> Listan nedan visar trades som redan skapats eller stängts. Öppna trades visas i live-bannern ovan.</div>
      {refreshing && (
        <div className="dt-paper-note"><strong>Uppdaterar.</strong> Visar senaste data medan nya svar hämtas.</div>
      )}
      {refreshError && !refreshing && (
        <div className="dt-paper-note"><strong>Senaste uppdatering misslyckades.</strong> Visar senaste data.</div>
      )}
      <TradeStats summary={summaryStats} />
      <div className="dt-paper-analysis">
        <div className="dt-paper-summary">
          <div className="dt-paper-summary-head">Senaste 48h</div>
          <div className="dt-paper-summary-grid">
            <div><strong>{summary.total ?? 0}</strong><span>Totalt paper trades</span></div>
            <div><strong>{summary.vwap_reclaim_up ?? 0}</strong><span>VWAP_RECLAIM_UP</span></div>
            <div><strong>{summary.vwap_rejection_down ?? 0}</strong><span>VWAP_REJECTION_DOWN</span></div>
            <div><strong>{summary.other_strategies ?? 0}</strong><span>Övriga strategier</span></div>
          </div>
          <p>{summary.text_sv || 'TODO: Kunde inte läsa paper trading history. Kontrollera data/paper-trading/trades.jsonl.'}</p>
        </div>

        <div className="dt-paper-info-grid">
          <div className="dt-paper-info-box">
            <div className="dt-paper-info-title">Raw signals som skapade trades</div>
            <ul>
              {(summary.by_raw_signal || []).slice(0, 5).map((row) => (
                <li key={row.raw_signal}><span>{row.raw_signal}</span><strong>{row.count}</strong></li>
              ))}
              {(summary.by_raw_signal || []).length === 0 && <li><span>Inga signaler</span><strong>0</strong></li>}
            </ul>
          </div>
          <div className="dt-paper-info-box">
            <div className="dt-paper-info-title">Strategier som skapade trades</div>
            <ul>
              {strategiesWithTrades.slice(0, 5).map((row) => (
                <li key={row.strategy_id || row.id}><span>{row.strategy_name || row.name || row.strategy_id}</span><strong>{row.paper_trades_48h}</strong></li>
              ))}
              {strategiesWithTrades.length === 0 && <li><span>Inga strategier</span><strong>0</strong></li>}
            </ul>
          </div>
          <div className="dt-paper-info-box">
            <div className="dt-paper-info-title">Valda strategier med 0 trades</div>
            <ul>
              {selectedZeroTrade.slice(0, 5).map((row) => (
                <li key={row.strategy_id || row.id}><span>{row.strategy_name || row.name || row.strategy_id}</span><strong>0</strong></li>
              ))}
              {selectedZeroTrade.length === 0 && <li><span>Inga valda strategier med 0 trades</span><strong>0</strong></li>}
            </ul>
          </div>
        </div>

        <div className="dt-paper-info-grid">
          <div className="dt-paper-info-box">
            <div className="dt-paper-info-title">Varför skapades inte fler paper trades?</div>
            <p>{noTradeReason}</p>
            {stoppage.top_reasons?.length > 0 && (
              <ul>
                {stoppage.top_reasons.slice(0, 5).map((row) => (
                  <li key={row.reason}><span>{row.reason}</span><strong>{row.count}</strong></li>
                ))}
              </ul>
            )}
          </div>
          <div className="dt-paper-info-box">
            <div className="dt-paper-info-title">Vad betyder siffrorna?</div>
            <ul>
              <li><span>{source.strategy_control || 'Strategikontroll = katalog + teststatistik + historik'}</span></li>
              <li><span>{source.candidates_paper || 'Kandidater & paper trades = faktiska paper trades från scanner'}</span></li>
              <li><span>{source.safety || 'Safety = live trading är avstängt'}</span></li>
              <li><span>{runtimeSummary.can_create_paper_trade_count != null ? `Runtime-ready kan köra: ${runtimeSummary.can_create_paper_trade_count}` : 'Runtime summary saknas'}</span></li>
            </ul>
          </div>
        </div>
      </div>
      {!hasLiveTrades ? (
        <PlatformEmptyState title="Kunde inte läsa paper trades" text="Visar senaste data när backend svarar igen." />
      ) : !trades.length ? (
        <PlatformEmptyState title="Inga paper trades att visa" text={`Det finns inga trades inom senaste ${tradeLimit}. Kör ny scan eller välj ett lägre antal.`} />
      ) : (
        <div className="dt-table-wrap">
          <table className="dt-table">
            <thead><tr><th>Tid</th><th>Symbol</th><th>Marknad</th><th>Rå signal</th><th>Katalogstrategi</th><th>Rikt.</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Status</th><th>Confidence</th><th>Risk/block</th><th>Runtime</th><th></th></tr></thead>
            <tbody>
              {trades.map((trade,i)=>(
                <tr key={trade.trade_id||i} className={tradeRowColor(trade.status)}>
                  <td className="dt-td-time">{fmtTradeTime(trade.time)}</td>
                  <td className="dt-td-sym"><strong>{trade.symbol}</strong></td>
                  <td>{trade.market||'–'}</td>
                  <td className="dt-td-raw">{trade.raw_signal||'–'}</td>
                  <td className="dt-td-strategy">
                    <div>{trade.catalog_strategy||'Ej kopplad'}</div>
                    {trade.strategy_id && <div className="dt-table-sub">{trade.strategy_id}</div>}
                    {trade.catalog_mapping_confidence === 'low' && <span className="dt-uncertain">låg säkerhet</span>}
                  </td>
                  <td>{trade.direction||'–'}</td>
                  <td className="dt-mono-cell">{fmtPrice(trade.entry)}</td>
                  <td className="dt-mono-cell">{fmtPrice(trade.exit)}</td>
                  <td className={trade.pnl>0?'dt-pos':trade.pnl<0?'dt-neg':''}>{fmtPct(trade.pnl)}</td>
                  <td><span className={`dt-status-tag ${tradeStatusClass(trade.status)}`}>{trade.status||'–'}</span></td>
                  <td>{trade.confidence!=null?`${trade.confidence}%`:'–'}</td>
                  <td className="dt-td-reason">{fmtReason(trade.risk_reason || trade.block_reason)}</td>
                  <td><span className={`dt-runtime-tag ${runtimeClass(trade.runtime_status)}`}>{runtimeStatusText(trade)}</span></td>
                  <td><button type="button" className="dt-btn-xs" onClick={()=>setSelected(trade)}>Analysera</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <TradeModal trade={selected} onClose={()=>setSelected(null)} />}
    </div>
  );
}

// ─── I) Impact ────────────────────────────────────────────────────────────────

function ImpactPanel({ impact, onScan }) {
  if (!impact?.ok||!impact?.generated_at) {
    return (
      <div className="dt-panel dt-impact-panel">
        <h3 className="dt-panel-title">Effekt av senaste ändring</h3>
        <PlatformEmptyState title="Ingen ändring analyserad ännu" text="Ändra ett filter eller en strategi och kör ny scan." />
      </div>
    );
  }
  const {before,after,changed_symbols,summary_sv,generated_at} = impact;
  return (
    <div className="dt-panel dt-impact-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Effekt av senaste ändring</h3>
        <span className="dt-muted">{timeSince(generated_at)}</span>
      </div>
      <p className="dt-impact-summary">{summary_sv}</p>
      <div className="dt-impact-cols">
        <div className="dt-impact-col">
          <div className="dt-impact-col-title">Före</div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.candidates??0}</span><span>kandidater</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.signals??0}</span><span>signaler</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.blocked??0}</span><span>blockerade</span></div>
        </div>
        <div className="dt-impact-arrow">→</div>
        <div className="dt-impact-col">
          <div className="dt-impact-col-title">Efter</div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.candidates??0}</span><span>kandidater</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.signals??0}</span><span>signaler</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.blocked??0}</span><span>blockerade</span></div>
        </div>
      </div>
      {changed_symbols?.length>0 && <div className="dt-impact-syms">Symboler: {changed_symbols.slice(0,10).join(', ')}</div>}
      <button type="button" className="dt-btn dt-btn-sec" onClick={onScan}>Kör ny scan</button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = { market:'all', direction:'all', minScore:0, symbol:'', _dirty:false };

// ─── Learning Engine v1 ─────────────────────────────────────────────────────

function learnStatusLabel(s) {
  return {
    strong: 'Stark', promising: 'Lovande', needs_more_data: 'Behöver mer data',
    weak: 'Svag', avoid: 'Undvik', needs_review: 'Granska', unknown: 'Okänd',
  }[s] || s || 'Okänd';
}
function learnStatusClass(s) {
  if (s === 'strong') return 'dt-learn-strong';
  if (s === 'promising') return 'dt-learn-promising';
  if (s === 'weak') return 'dt-learn-weak';
  if (s === 'avoid') return 'dt-learn-avoid';
  if (s === 'needs_review') return 'dt-learn-review';
  return 'dt-learn-neutral';
}
function fmtPl(v) {
  if (v == null || isNaN(v)) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(3)}%`;
}

function LearnTable({ rows, keyLabel }) {
  if (!rows?.length) return <div className="dt-learn-empty">Behöver mer data innan säker slutsats.</div>;
  return (
    <div className="dt-learn-table-wrap">
      <table className="dt-learn-table">
        <thead>
          <tr>
            <th>{keyLabel}</th><th>Trades</th><th>Stängda</th><th>Win%</th>
            <th>Snitt P/L</th><th>Total P/L</th><th>Skippade</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="dt-learn-key">{r.label || r.key}</td>
              <td>{r.trades}</td>
              <td>{r.closed}</td>
              <td>{r.win_rate != null ? `${r.win_rate}%` : '–'}</td>
              <td className={numericPnl(r.avg_pl) > 0 ? 'dt-pos' : numericPnl(r.avg_pl) < 0 ? 'dt-neg' : ''}>{fmtPl(r.avg_pl)}</td>
              <td className={numericPnl(r.total_pl) > 0 ? 'dt-pos' : numericPnl(r.total_pl) < 0 ? 'dt-neg' : ''}>{fmtPl(r.total_pl)}</td>
              <td>{r.skipped || 0}{r.top_skip_reason ? ` · ${r.top_skip_reason}` : ''}</td>
              <td><span className={`dt-learn-badge ${learnStatusClass(r.status)}`}>{learnStatusLabel(r.status)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LearningEngineSection({ learning }) {
  const [tab, setTab] = useState('strategy');
  const data = learning?.data || null;
  const s = data?.summary || null;

  const TABS = [
    ['strategy', 'Per strategi'],
    ['market', 'Per marknadsgrupp'],
    ['risk', 'Per riskklass'],
    ['symbol', 'Per symbol'],
    ['signal', 'Per signal'],
    ['skip', 'Skip reasons'],
  ];

  const hasData = s && (s.trades_total > 0 || s.skipped_total > 0);

  return (
    <div className="dt-panel dt-learn-panel">
      <div className="dt-panel-head">
        <h2 className="dt-panel-title">🧠 Learning Engine</h2>
        <span className="dt-learn-window">Senaste {data?.window?.hours ?? 48}h</span>
      </div>
      <p className="dt-learn-note">
        Systemet lär sig bara från paper/test. Inga riktiga order skickas.
      </p>

      {!hasData ? (
        <div className="dt-learn-empty">Behöver mer data innan säker slutsats. Learning-loopen samlar in paper trades och skippade signaler löpande.</div>
      ) : (
        <>
          <div className="dt-learn-cards">
            <div className="dt-learn-card"><span className="dt-learn-num">{s.trades_total}</span><span className="dt-learn-lbl">Trades total</span></div>
            <div className="dt-learn-card"><span className="dt-learn-num">{s.win_rate}%</span><span className="dt-learn-lbl">Win rate</span></div>
            <div className="dt-learn-card"><span className={`dt-learn-num ${numericPnl(s.avg_pl) >= 0 ? 'dt-pos' : 'dt-neg'}`}>{fmtPl(s.avg_pl)}</span><span className="dt-learn-lbl">Snitt P/L</span></div>
            <div className="dt-learn-card"><span className={`dt-learn-num ${numericPnl(s.total_pl) >= 0 ? 'dt-pos' : 'dt-neg'}`}>{fmtPl(s.total_pl)}</span><span className="dt-learn-lbl">Total P/L</span></div>
            <div className="dt-learn-card"><span className="dt-learn-num">{s.skipped_total}</span><span className="dt-learn-lbl">Skippade signaler</span></div>
            <div className="dt-learn-card"><span className="dt-learn-num">{s.risk_blocks_total}</span><span className="dt-learn-lbl">Risk blocks</span></div>
          </div>

          <div className="dt-learn-best">
            <div className="dt-learn-best-item"><span className="dt-learn-best-lbl">Bästa strategi</span><strong>{s.best_strategy?.label || '–'}</strong>{s.best_strategy && <span className="dt-learn-best-meta">{s.best_strategy.win_rate}% · {fmtPl(s.best_strategy.avg_pl)} · {s.best_strategy.closed} trades</span>}</div>
            <div className="dt-learn-best-item"><span className="dt-learn-best-lbl">Sämsta strategi</span><strong>{s.worst_strategy?.label || '–'}</strong>{s.worst_strategy && <span className="dt-learn-best-meta">{s.worst_strategy.win_rate}% · {fmtPl(s.worst_strategy.avg_pl)} · {s.worst_strategy.closed} trades</span>}</div>
            <div className="dt-learn-best-item"><span className="dt-learn-best-lbl">Bästa marknadsgrupp</span><strong>{s.best_market_group?.label || '–'}</strong>{s.best_market_group && <span className="dt-learn-best-meta">{s.best_market_group.win_rate}% · {fmtPl(s.best_market_group.avg_pl)}</span>}</div>
            <div className="dt-learn-best-item"><span className="dt-learn-best-lbl">Bästa riskklass</span><strong>{s.best_risk_class?.label || '–'}</strong>{s.best_risk_class && <span className="dt-learn-best-meta">{s.best_risk_class.win_rate}% · {fmtPl(s.best_risk_class.avg_pl)}</span>}</div>
          </div>

          <div className="dt-learn-tabs">
            {TABS.map(([id, lbl]) => (
              <button key={id} type="button" className={`dt-learn-tab ${tab === id ? 'dt-learn-tab-active' : ''}`} onClick={() => setTab(id)}>{lbl}</button>
            ))}
          </div>

          {tab === 'strategy' && <LearnTable rows={data.by_strategy} keyLabel="Strategi" />}
          {tab === 'market' && <LearnTable rows={data.by_market_group} keyLabel="Marknadsgrupp" />}
          {tab === 'risk' && <LearnTable rows={data.by_risk_class} keyLabel="Riskklass" />}
          {tab === 'symbol' && <LearnTable rows={data.by_symbol} keyLabel="Symbol" />}
          {tab === 'signal' && <LearnTable rows={data.by_raw_signal} keyLabel="Signal" />}
          {tab === 'skip' && (
            !data.skip_reasons?.length ? <div className="dt-learn-empty">Inga skippade signaler i fönstret ännu.</div> : (
              <div className="dt-learn-table-wrap">
                <table className="dt-learn-table">
                  <thead><tr><th>Orsak</th><th>Antal</th><th>Andel</th></tr></thead>
                  <tbody>
                    {data.skip_reasons.map((r) => (
                      <tr key={r.key}><td className="dt-learn-key">{r.key}</td><td>{r.count}</td><td>{r.share}%</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, note, tone = 'neutral', wide = false, text = false }) {
  return (
    <div className={`dt-summary-tile dt-summary-${tone}${wide ? ' dt-summary-tile-wide' : ''}`}>
      <span className="dt-summary-label">{label}</span>
      <strong className={`dt-summary-value${text ? ' dt-summary-value-text' : ''}`}>{value}</strong>
      {note && <span className="dt-summary-note">{note}</span>}
    </div>
  );
}

function TabStrip({ activeTab, onChange }) {
  return (
    <div className="dt-tab-strip" role="tablist" aria-label="Daytrading tabs">
      {DAYTRADING_TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`dt-tab-btn${activeTab === tab.key ? ' dt-tab-btn-active' : ''}`}
          onClick={() => onChange(tab.key)}
          role="tab"
          aria-selected={activeTab === tab.key}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function DetailsBlock({ summary, children, defaultOpen = false }) {
  return (
    <details className="dt-details" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="dt-details-body">{children}</div>
    </details>
  );
}

function OverviewTab({ status, pipeline, liveTrades, recommendation, impact, runtime, paperStatus, paperSignals, learning, candidates, loading, refreshing, refreshError }) {
  const latestScan = status?.latest_scan || null;
  const paperEnabled = paperStatus?.enabled !== false && status?.paper_trading !== false;
  const summary = liveTrades?.summary_48h || {};
  const candidateRows = Array.isArray(candidates?.candidates) ? candidates.candidates : Array.isArray(candidates) ? candidates : [];
  const bestSignal = candidateRows
    .slice()
    .sort((a, b) => Number(candidateScore(b) || 0) - Number(candidateScore(a) || 0))[0]
    || recommendation?.best_strategy
    || liveTrades?.runtime_strategies?.[0]
    || null;
  const bestStrategy = recommendation?.best_strategy || liveTrades?.runtime_strategies?.find((row) => (row.paper_trades_48h ?? 0) > 0) || runtime?.strategies?.find((row) => row.can_create_paper_trade) || null;
  const riskLabel = paperStatus?.conservativeMode || liveTrades?.summary_48h?.conservativeModeActive
    ? 'Försiktigt'
    : status?.safety?.active === false
      ? 'Okänt'
      : 'Normal';
  const aiRecommendation = recommendation?.recommendation_sv || impact?.summary_sv || 'Fortsätt observera dagens läge och kör en ny scan när filter eller marknad ändras.';

  return (
    <div className="dt-tab-panel">
      <PaperSignalsSection paperSignals={paperSignals} refreshing={refreshing} refreshError={refreshError} loading={loading} />
      <StatusBar status={status} />
      <div className="dt-overview-grid">
        <SummaryTile label="Systemstatus" value={status?.scanner_active ? 'Scanner aktiv' : 'Scanner pausad'} note={status?.data_active ? 'Data flödar in' : 'Väntar på data'} tone={status?.scanner_active ? 'good' : 'warning'} />
        <SummaryTile label="Senaste scan" value={latestScan ? timeSince(latestScan) : 'Ingen ännu'} note={status?.paper_trading ? 'Scan kan användas i paper/test' : 'Paper trading avstängt'} />
        <SummaryTile label="Paper trading status" value={paperEnabled ? 'På' : 'Av'} note={paperEnabled ? `Öppna: ${paperStatus?.openCount ?? liveTrades?.summary?.open ?? 0}` : 'Endast analys'} tone={paperEnabled ? 'good' : 'neutral'} />
        <SummaryTile label="Live trading" value="AV" note="actions_allowed=false · can_place_orders=false" tone="danger" />
        <SummaryTile label="Dagens bästa signal" value={textValue(bestSignal?.strategy_name || bestSignal?.strategyName || bestSignal?.strategy || bestSignal?.signalFamily, 'Ingen ännu')} note={bestSignal?.symbol ? `${bestSignal.symbol} · ${candidateDirection(bestSignal)}` : 'Väntar på kandidat'} />
        <SummaryTile label="Dagens bästa strategi" value={textValue(bestStrategy?.strategy_name || bestStrategy?.name || bestStrategy?.strategy_id, 'Ingen ännu')} note={bestStrategy?.paper_trades_48h != null ? `${bestStrategy.paper_trades_48h} paper trades` : 'Kräver mer data'} />
        <SummaryTile label="Dagens riskläge" value={riskLabel} note={status?.safety?.message_sv || 'Säkerhetslager är aktivt'} tone={riskLabel === 'Försiktigt' ? 'warning' : 'neutral'} />
        <SummaryTile label="AI:s korta rekommendation" value={aiRecommendation} note={impact?.generated_at ? `Senast uppdaterad ${timeSince(impact.generated_at)}` : 'AI-förklaring från senaste läget'} tone="good" wide text />
      </div>

      <div className="dt-overview-secondary">
        <div className="dt-overview-block">
          <div className="dt-overview-block-title">Snabb status</div>
          <div className="dt-overview-block-text">
            {status?.safety?.message_sv || 'Systemet kan analysera och paper-trada men aldrig lägga riktiga ordrar.'}
          </div>
        </div>
        <div className="dt-overview-block">
          <div className="dt-overview-block-title">Senaste 48h</div>
          <div className="dt-overview-block-text">
            Paper trades: {summary.total ?? 0} · öppna: {summary.open ?? 0} · win rate: {summary.win_rate != null ? `${Number(summary.win_rate).toFixed(1)}%` : '–'} · total P/L: {fmtPct(summary.total_pl)}
          </div>
        </div>
      </div>

      <DetailsBlock summary="Visa mer om process och pipeline">
        <CurrentDecisionCard
          status={status}
          pipeline={pipeline}
          liveTrades={liveTrades}
          runtime={runtime}
          marketControls={null}
          learning={learning}
          paperStatus={paperStatus}
          refreshing={false}
          refreshError={null}
        />
      </DetailsBlock>

      <DetailsBlock summary="Visa mer om dagens paper trades" defaultOpen={false}>
        <LivePaperBanner paperStatus={paperStatus} />
      </DetailsBlock>

      <DetailsBlock summary="Visa mer om rekommendationer" defaultOpen={false}>
        <RecommendationBar rec={recommendation} />
      </DetailsBlock>
    </div>
  );
}

function SignalsTab({ pipeline, scanResult, status, candidates }) {
  const recent = Array.isArray(candidates?.candidates) ? candidates.candidates : Array.isArray(candidates) ? candidates : [];
  const activeCandidateCount = recent.filter((row) => candidateStatus(row) === 'active').length;
  const rejectedCount = recent.filter((row) => candidateStatus(row) === 'rejected').length;
  const paperTradeCount = recent.filter((row) => candidateStatus(row) === 'paper trade').length;

  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Signaler</h2>
          <p className="dt-tab-sub">Kandidater, status och varför signalerna blev aktiva, avvisade eller gick vidare till paper trade.</p>
        </div>
        <div className="dt-tab-meta">
          <span>{activeCandidateCount} aktiva</span>
          <span>{rejectedCount} avvisade</span>
          <span>{paperTradeCount} paper trades</span>
        </div>
      </div>

      <CurrentDecisionCard
        status={status}
        pipeline={pipeline}
        liveTrades={null}
        runtime={null}
        marketControls={null}
        learning={null}
        paperStatus={null}
        refreshing={false}
        refreshError={null}
      />

      <div className="dt-panel">
        <div className="dt-panel-head">
          <h3 className="dt-panel-title">Signal-tabell</h3>
          <span className="dt-count-badge">{recent.length} kandidater</span>
        </div>
        {!recent.length ? (
          <PlatformEmptyState title="Inga kandidater ännu" text="Kandidatloggen fylls när scanner hittar nya lägen." />
        ) : (
          <div className="dt-table-wrap">
            <table className="dt-table dt-signal-table">
              <thead>
                <tr>
                  <th>Tid</th>
                  <th>Symbol</th>
                  <th>Signal</th>
                  <th>Long/short</th>
                  <th>Score/conf.</th>
                  <th>Entry/exit</th>
                  <th>Varför</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((candidate, index) => {
                  const statusLabel = candidateStatus(candidate);
                  return (
                    <tr key={`${candidate.symbol || 'candidate'}-${candidateTime(candidate) || index}`}>
                      <td>{candidateTime(candidate) ? fmtTradeTime(candidateTime(candidate)) : '–'}</td>
                      <td><strong>{candidate.symbol || '–'}</strong></td>
                      <td>{candidateSignal(candidate)}</td>
                      <td>{candidateDirection(candidate)}</td>
                      <td>{candidateScore(candidate)}</td>
                      <td>{candidateEntry(candidate)} · {candidateExit(candidate)}</td>
                      <td className="dt-signal-reason">{candidateWhy(candidate)}</td>
                      <td><span className={`dt-status-tag ${statusLabel === 'paper trade' ? 'dt-status-win' : statusLabel === 'rejected' ? 'dt-status-blocked' : statusLabel === 'timeout' ? 'dt-status-timeout' : 'dt-status-open'}`}>{statusLabel}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DetailsBlock summary="Visa mer om pipeline och senaste scan">
        <PipelineSection pipeline={pipeline} />
        {scanResult && (
          <div className={`dt-scan-result ${scanResult.ok ? 'dt-scan-ok' : 'dt-scan-err'}`}>
            <span>{scanResult.message_sv}</span>
            {scanResult.candidates?.length > 0 && <span> · {scanResult.candidates.length} kandidater hittades</span>}
          </div>
        )}
      </DetailsBlock>
    </div>
  );
}

function StrategiesTab({ strategies, runtime, liveTrades, paperStatus, cryptoScan, cryptoScanError, onUpdate, onScan }) {
  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Strategier</h2>
          <p className="dt-tab-sub">Här styrs vilka strategier som kan bli paper-ready. Själva handlingslogiken är fortfarande låst till test/paper.</p>
        </div>
      </div>
      <StrategiesSection
        strategies={strategies}
        total={strategies.length}
        runtime={runtime}
        liveTrades={liveTrades}
        paperStatus={paperStatus}
        cryptoScan={cryptoScan}
        cryptoScanError={cryptoScanError}
        onUpdate={onUpdate}
        onScan={onScan}
      />
    </div>
  );
}

function PaperTradingTab({ liveTrades, tradeLimit, onTradeLimitChange, refreshing, refreshError, paperStatus, paperSignals, paperTrades, paperStrategyDiagnostics, loading }) {
  const summary = liveTrades?.summary_48h || {};
  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Paper Trading</h2>
          <p className="dt-tab-sub">Öppna och stängda paper trades, win rate och P/L. Inga riktiga ordrar skickas.</p>
        </div>
        <div className="dt-tab-meta">
          <span>Win rate: {summary.win_rate != null ? `${Number(summary.win_rate).toFixed(1)}%` : '–'}</span>
          <span>Total P/L: {fmtPct(summary.total_pl)}</span>
          <span>Öppna: {summary.open ?? paperStatus?.openCount ?? 0}</span>
        </div>
      </div>
      <PaperSignalsSection paperSignals={paperSignals} refreshing={refreshing} refreshError={refreshError} loading={loading} />
      <TodayPaperTradesSection paperTrades={paperTrades} paperStatus={paperStatus} paperSignals={paperSignals} loading={loading} />
      <StrategyDiagnosticsSection paperStrategyDiagnostics={paperStrategyDiagnostics} loading={loading} />
      <DetailsBlock summary="Visa mer om paper trade-historik">
        <LivePaperBanner paperStatus={paperStatus} />
        <LiveTradesSection
          liveTrades={liveTrades}
          tradeLimit={tradeLimit}
          onTradeLimitChange={onTradeLimitChange}
          refreshing={refreshing}
          refreshError={refreshError}
        />
      </DetailsBlock>
    </div>
  );
}

function TestsTab({ status, pipeline, recommendation, impact, autopilotStatus, autopilotConfig, scanResult, onScan }) {
  const recentRuns = Array.isArray(autopilotStatus?.recent_runs) ? autopilotStatus.recent_runs : [];
  const latestRun = recentRuns[recentRuns.length - 1] || null;
  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Tester</h2>
          <p className="dt-tab-sub">Replay, batch och autopilot samlas här. Detta är fortsatt test- och analysläge, aldrig live trading.</p>
        </div>
        <div className="dt-tab-meta">
          <span>Autopilot: {autopilotStatus?.enabled ? 'På' : 'Av'}</span>
          <span>Mode: {textValue(autopilotConfig?.mode, 'paper/replay/batch-only')}</span>
        </div>
      </div>

      <div className="dt-overview-grid">
        <SummaryTile label="Senaste test" value={latestRun?.summary_sv || latestRun?.message_sv || (status?.latest_scan ? timeSince(status.latest_scan) : 'Ingen ännu')} note="Senaste autopilot- eller scan-händelse" />
        <SummaryTile label="Nästa rekommenderade test" value={recommendation?.recommendation_sv || impact?.summary_sv || 'Ingen tydlig rekommendation'} note="Bygger på senaste data" tone="good" wide text />
        <SummaryTile label="Replay tester" value="Visa i LAB" note="Öppna `/lab?tab=replay` för replay" />
        <SummaryTile label="Batch tester" value="Visa i LAB" note="Öppna `/lab?tab=batch` för batch" />
      </div>

      <DetailsBlock summary="Visa mer om testflödet">
        <ProcessCard status={status} pipeline={pipeline} paperStatus={{ openCount: 0, openTrades: [] }} />
        <PipelineSection pipeline={pipeline} />
      </DetailsBlock>

      <DetailsBlock summary="Visa mer om autopilot och testresultat">
        <div className="dt-panel">
          <div className="dt-panel-head">
            <h3 className="dt-panel-title">Autopilot</h3>
            <span className="dt-count-badge">{autopilotStatus?.enabled ? 'Aktiv' : 'Av'}</span>
          </div>
          <div className="dt-test-grid">
            <div className="dt-test-block">
              <strong>Senaste körning</strong>
              <span>{latestRun?.summary_sv || latestRun?.message_sv || 'Ingen ännu'}</span>
            </div>
            <div className="dt-test-block">
              <strong>Senaste testresultat</strong>
              <span>{impact?.summary_sv || 'Ingen ändring analyserad ännu'}</span>
            </div>
          </div>
        </div>
        <ImpactPanel impact={impact} onScan={onScan} />
      </DetailsBlock>

      {scanResult && (
        <div className={`dt-scan-result ${scanResult.ok ? 'dt-scan-ok' : 'dt-scan-err'}`}>
          <span>{scanResult.message_sv}</span>
          {scanResult.candidates?.length > 0 && <span> · {scanResult.candidates.length} kandidater hittades</span>}
        </div>
      )}
    </div>
  );
}

function LearningTab({ learning }) {
  const data = learning?.data || null;
  const s = data?.summary || {};
  const bestStrategy = s.best_strategy || null;
  const worstStrategy = s.worst_strategy || null;
  const bestMarketGroup = s.best_market_group || null;
  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Learning</h2>
          <p className="dt-tab-sub">Vad systemet lärde sig idag, vilka strategier som fungerade bäst och vad som ska förbättras nästa.</p>
        </div>
      </div>
      <div className="dt-overview-grid">
        <SummaryTile label="Vad systemet lärde sig idag" value={s.conclusion_sv || 'Ingen tydlig slutsats ännu'} note={s.next_action_sv || 'Vänta på mer data'} tone="good" wide text />
        <SummaryTile label="Bästa strategier" value={bestStrategy?.label || '–'} note={bestStrategy ? `${bestStrategy.win_rate}% · ${fmtPl(bestStrategy.avg_pl)} · ${bestStrategy.closed} trades` : 'Behöver mer data'} />
        <SummaryTile label="Sämsta strategier" value={worstStrategy?.label || '–'} note={worstStrategy ? `${worstStrategy.win_rate}% · ${fmtPl(worstStrategy.avg_pl)} · ${worstStrategy.closed} trades` : 'Behöver mer data'} tone="warning" />
        <SummaryTile label="Market regime" value={data?.summary?.best_market_group?.label || data?.summary?.market_regime || '–'} note={data?.summary?.market_context || 'Senaste läge'} />
      </div>
      <LearningEngineSection learning={learning} />
    </div>
  );
}

function SafetyTab({ status, paperStatus, marketControls, runtime, onUpdate }) {
  const safetyFlags = [
    ['actions_allowed', status?.actions_allowed],
    ['can_place_orders', status?.can_place_orders],
    ['live_trading_enabled', status?.live_trading_enabled],
  ];
  const controls = Array.isArray(marketControls?.controls) ? marketControls.controls : [];
  const blockedActions = [
    'Riktiga ordrar',
    'Broker live execution',
    'Live trading',
    'Automatisk orderläggning',
  ];
  const safetyWarnings = [
    status?.safety?.message_sv,
    paperStatus?.conservativeMode ? 'Paper trading kör i försiktigt läge.' : '',
    runtime?.summary?.runtime_no_entry_rule > 0 ? 'Vissa strategier saknar entry-regel.' : '',
  ].filter(Boolean);

  return (
    <div className="dt-tab-panel">
      <div className="dt-tab-topline">
        <div>
          <h2 className="dt-tab-title">Risk &amp; Safety</h2>
          <p className="dt-tab-sub">All analys sker i test/paper-only. Systemet kan aldrig lägga riktiga ordrar.</p>
        </div>
      </div>
      <div className="dt-overview-grid">
        {safetyFlags.map(([label, value]) => (
          <SummaryTile key={label} label={label} value={String(value === undefined ? false : value)} note="Ska vara false" tone="danger" />
        ))}
        <SummaryTile label="Broker status" value="Ej aktiv" note="Ingen broker används i live-läge" tone="warning" />
        <SummaryTile label="Blockerade actions" value={blockedActions.length} note={blockedActions.join(' · ')} />
        <SummaryTile label="Riskvarningar" value={safetyWarnings.length} note={safetyWarnings.join(' · ') || 'Inga aktuella varningar'} />
      </div>
      <div className="dt-panel">
        <div className="dt-panel-head">
          <h3 className="dt-panel-title">Safety-banner</h3>
        </div>
        <SafetyBanner status={status} />
      </div>
      <DetailsBlock summary="Visa mer om marknads- och riskkontroller">
        <div className="dt-overview-grid">
          {controls.slice(0, 6).map((control) => (
            <div key={control.group_id || control.group_name} className="dt-summary-tile">
              <span className="dt-summary-label">{control.group_name || control.group_id}</span>
              <strong className="dt-summary-value">{control.connected === false ? 'Frånkopplad' : 'Aktiv'}</strong>
              <span className="dt-summary-note">
                Paper {control.enabled_for_paper === false ? 'av' : 'på'} · Scanner {control.enabled_for_scanner === false ? 'av' : 'på'} · Replay {control.enabled_for_replay === false ? 'av' : 'på'}
              </span>
              <span className="dt-summary-note">{control.restricted_reason || control.warning_sv || 'Endast paper/test. Riktig handel är låst.'}</span>
            </div>
          ))}
          {controls.length === 0 && (
            <PlatformEmptyState title="Inga marknadskontroller kunde läsas" text="Daytrading fortsätter i säkert paperläge. Försök uppdatera sidan." />
          )}
        </div>
      </DetailsBlock>
      <div className="dt-safety-note">
        Systemet kan analysera och paper-trada men aldrig lägga riktiga ordrar.
      </div>
    </div>
  );
}

export default function DaytradingPage() {
  const [tradeLimit, setTradeLimit] = useState(200);
  const { status, strategies, pipeline, liveTrades, recommendation, impact, symbols, runtime, cryptoScan, cryptoScanError, marketControls, learning, paperStatus, paperSignals, paperTrades, paperStrategyDiagnostics, autopilotStatus, autopilotConfig, candidates, loading, refreshing, refreshError, error, refresh } = useDaytradingData(tradeLimit);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Hide floating AI fab on this page — in-pipeline button provides same function
  useEffect(() => {
    const fab = document.querySelector('.ai-fab');
    if (!fab) return;
    const prev = fab.style.display;
    fab.style.display = 'none';
    return () => { fab.style.display = prev; };
  }, []);

  async function handleScan(strategyId) {
    setScanning(true);
    try {
      const res = await fetch('/api/daytrading/scan', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          market: filters.market,
          symbols: filters.symbol?[filters.symbol]:[],
          ...(strategyId?{strategy_id:strategyId}:{}),
        }),
      }).then(r=>r.json());
      setScanResult(res);
      setFilters(f=>({...f, _dirty:false}));
      refresh();
    } catch {
      setScanResult({ok:false, message_sv:'Kunde inte nå backend. Kontrollera att servern är igång.'});
    } finally {
      setScanning(false);
    }
  }

  const allStrategies = strategies?.strategies || [];
  const visibleStrategies = allStrategies.filter(s => {
    const cfg = s.config || {};
    if (filters.market !== 'all') {
      const m = cfg.market || s.market || 'all';
      if (m !== 'all' && m !== filters.market) return false;
    }
    if (filters.direction !== 'all') {
      const d = cfg.direction || s.direction || 'both';
      if (d !== 'both' && d !== filters.direction) return false;
    }
    if (filters.minScore > 0 && Number(s.score??0) < filters.minScore) return false;
    return true;
  });

  if (loading) return <div className="dt-page"><div className="dt-loading">Laddar Daytrading Control Center...</div></div>;

  if (error && !status) {
    return (
      <div className="dt-page">
        <h1 className="dt-page-title">Daytrading Control Center</h1>
        <div className="dt-backend-down">
          <span>⚠️</span><strong>Backend svarar inte just nu.</strong>
          <span>Kontrollera att servern är igång och försök igen om en stund.</span>
          <button type="button" className="dt-btn dt-btn-pri" onClick={refresh}>Försök igen</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dt-page">
      <div className="dt-page-head">
        <div>
          <h1 className="dt-page-title">Daytrading Control Center</h1>
          <p className="dt-page-sub">Operativ sida för analys, paper trading, replay, batch, learning och safety. Live trading är alltid avstängt.</p>
        </div>
        <button type="button" className="dt-btn dt-btn-sec" onClick={refresh}>Uppdatera</button>
      </div>

      <TabStrip activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <OverviewTab
          status={status}
          pipeline={pipeline}
          liveTrades={liveTrades}
          recommendation={recommendation}
          impact={impact}
          runtime={runtime}
          paperStatus={paperStatus}
          paperSignals={paperSignals}
          learning={learning}
          candidates={candidates}
          loading={loading}
          refreshing={refreshing}
          refreshError={refreshError}
        />
      )}

      {activeTab === 'signals' && (
        <SignalsTab
          pipeline={pipeline}
          scanResult={scanResult}
          status={status}
          candidates={candidates}
        />
      )}

      {activeTab === 'strategies' && (
        <StrategiesTab
          strategies={visibleStrategies}
          runtime={runtime}
          liveTrades={liveTrades}
          paperStatus={paperStatus}
          cryptoScan={cryptoScan}
          cryptoScanError={cryptoScanError}
          onUpdate={refresh}
          onScan={handleScan}
        />
      )}

      {activeTab === 'paper' && (
        <PaperTradingTab
          liveTrades={liveTrades}
          tradeLimit={tradeLimit}
          onTradeLimitChange={setTradeLimit}
          refreshing={refreshing}
          refreshError={refreshError}
          paperStatus={paperStatus}
          paperSignals={paperSignals}
          paperTrades={paperTrades}
          paperStrategyDiagnostics={paperStrategyDiagnostics}
          loading={loading}
        />
      )}

      {activeTab === 'tests' && (
        <TestsTab
          status={status}
          pipeline={pipeline}
          recommendation={recommendation}
          impact={impact}
          autopilotStatus={autopilotStatus}
          autopilotConfig={autopilotConfig}
          scanResult={scanResult}
          onScan={() => handleScan()}
        />
      )}

      {activeTab === 'learning' && <LearningTab learning={learning} />}

      {activeTab === 'safety' && (
        <SafetyTab
          status={status}
          paperStatus={paperStatus}
          marketControls={marketControls}
          runtime={runtime}
          onUpdate={refresh}
        />
      )}

    </div>
  );
}
