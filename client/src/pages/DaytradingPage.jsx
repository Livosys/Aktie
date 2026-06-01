import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PlatformEmptyState } from '../components/PlatformControls.jsx';
import { SignalAge, TradingViewLink } from '../shared.jsx';

// ─── Data hook ────────────────────────────────────────────────────────────────

function useDaytradingData(tradeLimit = 200) {
  const requestSeq = useRef(0);
  const [state, setState] = useState({
    status: null, strategies: null, pipeline: null,
    liveTrades: null, recommendation: null, impact: null, symbols: null, runtime: null,
    cryptoScan: null, cryptoScanError: false, marketControls: null, learning: null, paperStatus: null,
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
    const [statusD, strD, pipeD, tradesD, recD, impD, symD, runtimeD, cryptoScanD, marketControlsD, learningD, paperStatusD] = await Promise.all([
      get('/api/daytrading/status'), get('/api/daytrading/strategies'),
      get('/api/daytrading/pipeline'), get(`/api/daytrading/live-trades?limit=${tradeLimit}`),
      get('/api/daytrading/recommendation'), get('/api/daytrading/impact-summary'),
      get('/api/daytrading/symbols'), get('/api/daytrading/runtime-strategies'),
      get('/api/scan/crypto'),
      get('/api/daytrading/market-controls'),
      get('/api/daytrading/learning-summary?hours=48&limit=200'),
      get('/api/paper-trading/status'),
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

// ─── F) Filter bar ───────────────────────────────────────────────────────────

const MARKETS   = [{ id:'all',label:'Alla'},{id:'stocks',label:'Aktier'},{id:'nasdaq',label:'Nasdaq'},{id:'crypto',label:'Krypto'},{id:'etf',label:'ETF'}];
const DIRECTIONS= [{ id:'all',label:'Alla'},{id:'long',label:'Long'},{id:'short',label:'Short'}];
const SCORES    = [{ id:0,label:'Alla'},{id:50,label:'50+'},{id:60,label:'60+'},{id:70,label:'70+'},{id:80,label:'80+'}];

function Pills({ options, value, onChange }) {
  return (
    <div className="dt-pills">
      {options.map(o => (
        <button key={o.id} type="button"
          className={`dt-pill${value === o.id ? ' dt-pill-active' : ''}`}
          onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

function FilterBar({ filters, onChange, onScan, scanning, symbols }) {
  const symRows = (symbols?.symbols || []).filter(s => s.enabled && !s.paused);
  const selectedSym = symRows.find(s => s.symbol === filters.symbol);

  return (
    <div className="dt-filter-bar-wrap">
      <div className="dt-filter-bar">
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Marknad</span>
          <Pills options={MARKETS} value={filters.market}    onChange={v => onChange({...filters, market: v, _dirty: true})} />
        </div>
        <div className="dt-filter-bar-sep" />
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Riktning</span>
          <Pills options={DIRECTIONS} value={filters.direction} onChange={v => onChange({...filters, direction: v, _dirty: true})} />
        </div>
        <div className="dt-filter-bar-sep" />
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Score</span>
          <Pills options={SCORES} value={filters.minScore}   onChange={v => onChange({...filters, minScore: v, _dirty: true})} />
        </div>
        {symRows.length > 0 && (
          <>
            <div className="dt-filter-bar-sep" />
            <div className="dt-filter-bar-group">
              <span className="dt-filter-bar-lbl">Symbol</span>
              <select className="dt-filter-select dt-filter-select-sm" value={filters.symbol || ''}
                onChange={e => onChange({...filters, symbol: e.target.value, _dirty: true})}>
                <option value="">Alla</option>
                {symRows.map(s => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
              </select>
              {selectedSym?.data_status_sv && (
                <span className={`dt-sym-inline ${selectedSym.has_data ? 'dt-sym-ok' : 'dt-sym-warn'}`}>
                  {selectedSym.data_status_sv}
                </span>
              )}
            </div>
          </>
        )}
        <button type="button"
          className={`dt-scan-btn dt-scan-btn-sm${scanning ? ' dt-scan-btn-loading' : ''}`}
          onClick={onScan} disabled={scanning}>
          {scanning ? 'Söker...' : 'Kör ny scan'}
        </button>
      </div>
      {filters._dirty && <div className="dt-filter-hint">Filter ändrat – kör ny scan för att uppdatera resultat</div>}
    </div>
  );
}

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

const MARKET_RISK_LABELS = {
  normal: 'Normal',
  high: 'Hög',
  extreme: 'Mycket hög',
};

const MARKET_SCOPE_FIELDS = [
  ['enabled_for_paper', 'Paper-runtime'],
  ['enabled_for_scanner', 'Scanner'],
  ['enabled_for_replay', 'Replay'],
  ['enabled_for_batch', 'Batch'],
];

function MarketToggle({ value, label, disabled, onClick }) {
  return (
    <button
      type="button"
      className={`dt-market-toggle${value ? ' dt-market-toggle-on' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      <strong>{value ? 'Aktiv' : 'Av'}</strong>
    </button>
  );
}

function MarketControlCard({ control, busy, onToggle }) {
  const risk = control.risk_class || 'normal';
  return (
    <div className={`dt-market-card dt-market-risk-${risk}`}>
      <div className="dt-market-card-head">
        <div>
          <h4>{control.group_name || control.group_id}</h4>
          <div className="dt-market-meta">
            <span>Connected: {control.connected === false ? 'Nej' : 'Ja'}</span>
            <span>{control.symbol_count ?? 0} symboler</span>
            {(control.unverified_symbol_count ?? 0) > 0 && <span>{control.unverified_symbol_count} ej verifierade</span>}
          </div>
        </div>
        <span className={`dt-market-risk-badge dt-market-risk-badge-${risk}`}>{MARKET_RISK_LABELS[risk] || risk}</span>
      </div>
      <div className="dt-market-toggle-grid">
        {MARKET_SCOPE_FIELDS.map(([field, label]) => (
          <MarketToggle
            key={field}
            label={label}
            value={control[field] !== false}
            disabled={busy}
            onClick={() => onToggle(control.group_id, field, control[field] === false)}
          />
        ))}
        <div className="dt-market-live-lock">
          <span>Live</span>
          <strong>Låst Av</strong>
        </div>
      </div>
      <p className="dt-market-reason">{control.restricted_reason || control.warning_sv || 'Endast paper/test. Riktig handel är låst.'}</p>
      {(control.unverified_symbol_count ?? 0) > 0 && (
        <p className="dt-market-unverified">Symbol ej verifierad - kan endast observeras tills datakälla finns.</p>
      )}
    </div>
  );
}

function MarketSlider({ label, value, min, max, step = 1, suffix = '', onChange }) {
  return (
    <label className="dt-market-slider">
      <span>{label}: <strong>{value}{suffix}</strong></span>
      <input className="dt-slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  );
}

function MarketControlsSection({ marketControls, onUpdate }) {
  const controls = marketControls?.controls || [];
  const [localControls, setLocalControls] = useState(controls);
  const [filters, setFilters] = useState(marketControls?.filters || {
    min_score: 60,
    min_confidence: 70,
    max_risk_class: 'extreme',
    max_trades_per_hour: 10,
    cooldown_minutes: 5,
    max_spread_percent: 0.5,
    max_leverage: 10,
  });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setLocalControls(controls);
    if (marketControls?.filters) setFilters(marketControls.filters);
  }, [marketControls]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyResponse(res) {
    if (Array.isArray(res?.controls)) setLocalControls(res.controls);
    if (res?.filters) setFilters(res.filters);
    if (res?.message_sv) setMessage(res.message_sv);
    onUpdate?.();
  }

  async function post(path, body, busyKey) {
    setBusy(busyKey);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(r => r.json()).catch(() => null);
      if (res?.ok === false) setError(res.error || 'Kunde inte uppdatera marknadskontroll.');
      else applyResponse(res || {});
    } finally {
      setBusy(null);
    }
  }

  function toggle(groupId, field, value) {
    post(`/api/daytrading/market-controls/${encodeURIComponent(groupId)}/toggle`, { [field]: value }, `${groupId}:${field}`);
  }

  function saveFilters() {
    post('/api/daytrading/market-controls/sliders', filters, 'filters');
  }

  return (
    <div className="dt-panel dt-market-controls-panel">
      <div className="dt-panel-head">
        <div>
          <h3 className="dt-panel-title">Marknader &amp; riskinstrument</h3>
          <p className="dt-market-note">Riskinstrument kan aktiveras för scanner, paper, replay och batch. Riktig handel är fortfarande låst.</p>
        </div>
        <span className="dt-count-badge">{localControls.length} grupper</span>
      </div>

      <div className="dt-market-warning">
        Certifikat och mini futures kan ge missvisande testresultat om spread, hävstång eller knock-out saknas i datan.
      </div>

      <div className="dt-market-bulk-actions">
        <button type="button" className="dt-btn dt-btn-ok" disabled={!!busy} onClick={() => post('/api/daytrading/market-controls/enable-all-risk', null, 'risk-on')}>Slå på alla riskinstrument i paper test</button>
        <button type="button" className="dt-btn dt-btn-warn" disabled={!!busy} onClick={() => post('/api/daytrading/market-controls/disable-all-risk', null, 'risk-off')}>Pausa alla riskinstrument</button>
        <button type="button" className="dt-btn dt-btn-sec" disabled={!!busy} onClick={() => post('/api/daytrading/market-controls/enable-all', null, 'all-on')}>Slå på alla marknader</button>
        <button type="button" className="dt-btn dt-btn-sec" disabled={!!busy} onClick={() => post('/api/daytrading/market-controls/disable-all', null, 'all-off')}>Pausa alla marknader</button>
      </div>

      {error && <div className="dt-inline-error">{error}</div>}
      {message && <div className="dt-inline-ok">{message}</div>}

      {!localControls.length ? (
        <PlatformEmptyState title="Inga marknadskontroller kunde läsas" text="Daytrading fortsätter i säkert paperläge. Försök uppdatera sidan." />
      ) : (
        <div className="dt-market-grid">
          {localControls.map((control) => (
            <MarketControlCard
              key={control.group_id}
              control={control}
              busy={!!busy}
              onToggle={toggle}
            />
          ))}
        </div>
      )}

      <div className="dt-market-filter-panel">
        <div className="dt-market-filter-head">
          <h4>Paper/scanner-filter</h4>
          <button type="button" className="dt-btn dt-btn-pri" disabled={!!busy} onClick={saveFilters}>
            {busy === 'filters' ? 'Sparar...' : 'Spara filter'}
          </button>
        </div>
        <div className="dt-market-sliders">
          <MarketSlider label="Min score" value={filters.min_score ?? 60} min={0} max={100} onChange={v => setFilters(f => ({ ...f, min_score: v }))} />
          <MarketSlider label="Min confidence" value={filters.min_confidence ?? 70} min={0} max={100} suffix="%" onChange={v => setFilters(f => ({ ...f, min_confidence: v }))} />
          <label className="dt-market-slider">
            <span>Max riskklass: <strong>{MARKET_RISK_LABELS[filters.max_risk_class] || 'Mycket hög'}</strong></span>
            <select className="dt-filter-select" value={filters.max_risk_class || 'extreme'} onChange={e => setFilters(f => ({ ...f, max_risk_class: e.target.value }))}>
              <option value="normal">Normal</option>
              <option value="high">Hög</option>
              <option value="extreme">Mycket hög</option>
            </select>
          </label>
          <MarketSlider label="Max trades per timme" value={filters.max_trades_per_hour ?? 10} min={0} max={50} onChange={v => setFilters(f => ({ ...f, max_trades_per_hour: v }))} />
          <MarketSlider label="Cooldown minuter" value={filters.cooldown_minutes ?? 5} min={0} max={120} onChange={v => setFilters(f => ({ ...f, cooldown_minutes: v }))} />
          <MarketSlider label="Max spread" value={filters.max_spread_percent ?? 0.5} min={0} max={5} step={0.1} suffix="%" onChange={v => setFilters(f => ({ ...f, max_spread_percent: v }))} />
          <MarketSlider label="Max hävstång" value={filters.max_leverage ?? 10} min={1} max={100} onChange={v => setFilters(f => ({ ...f, max_leverage: v }))} />
        </div>
      </div>
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

export default function DaytradingPage() {
  const [tradeLimit, setTradeLimit] = useState(200);
  const { status, strategies, pipeline, liveTrades, recommendation, impact, symbols, runtime, cryptoScan, cryptoScanError, marketControls, learning, paperStatus, loading, refreshing, refreshError, error, refresh } = useDaytradingData(tradeLimit);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  // Hide floating AI fab on this page — in-pipeline button provides same function
  useEffect(() => {
    const fab = document.querySelector('.ai-fab');
    if (!fab) return;
    const prev = fab.style.display;
    fab.style.display = 'none';
    return () => { fab.style.display = prev; };
  }, []);

  function handleFilterChange(next) {
    setFilters(next);
    fetch('/api/daytrading/filters', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({market:next.market, symbols:next.symbol?[next.symbol]:[]}),
    }).catch(()=>{});
  }

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

      {/* A) Header */}
      <div className="dt-page-head">
        <div>
          <h1 className="dt-page-title">Daytrading Control Center</h1>
          <p className="dt-page-sub">Operativ sida och source of truth för runtime, paper trading, skipped signals och öppna paper trades. Historik visas separat.</p>
        </div>
        <button type="button" className="dt-btn dt-btn-sec" onClick={refresh}>Uppdatera</button>
      </div>

      {/* A) Status */}
      <StatusBar status={status} />

      {/* Ny: Vad händer just nu */}
      <CurrentDecisionCard
        status={status}
        pipeline={pipeline}
        liveTrades={liveTrades}
        runtime={runtime}
        marketControls={marketControls}
        learning={learning}
        paperStatus={paperStatus}
        refreshing={refreshing}
        refreshError={refreshError}
      />

      {/* B) Safety */}
      <SafetyBanner status={status} />
      <LivePaperBanner paperStatus={paperStatus} />

      <div className="dt-page-runtime-summary">
        <div className="dt-panel-head">
          <h3 className="dt-panel-title">Runtime-sammanfattning</h3>
          <span className="dt-count-badge">{runtime?.summary?.total_catalog_strategies ?? 0} strategier</span>
        </div>
        <RuntimeSummary runtime={runtime} />
      </div>

      {/* Scan result */}
      {scanResult && (
        <div className={`dt-scan-result ${scanResult.ok?'dt-scan-ok':'dt-scan-err'}`}>
          <span>{scanResult.message_sv}</span>
          {scanResult.candidates?.length>0 && <span> · {scanResult.candidates.length} kandidater hittades</span>}
          <button type="button" className="dt-scan-close" onClick={()=>setScanResult(null)}>✕</button>
        </div>
      )}

      {/* C) Process just nu */}
      <ProcessCard status={status} pipeline={pipeline} paperStatus={paperStatus} />

      {/* Market & risk controls */}
      <MarketControlsSection marketControls={marketControls} onUpdate={refresh} />

      {/* D) Pipeline — fullbredd, prominent */}
      <PipelineSection pipeline={pipeline} />

      {/* E) Rekommendation */}
      <RecommendationBar rec={recommendation} />

      {/* F) Filter bar */}
      <FilterBar
        filters={filters}
        onChange={handleFilterChange}
        onScan={()=>handleScan()}
        scanning={scanning}
        symbols={symbols}
      />

      {/* G) Strategikontroll — collapsible groups */}
      {!visibleStrategies.length ? (
        <div className="dt-panel">
          <PlatformEmptyState title="Inga strategier matchar filter" text="Ändra filter för att se fler strategier." />
        </div>
      ) : (
        <StrategiesSection
          strategies={visibleStrategies}
          total={allStrategies.length}
          runtime={runtime}
          liveTrades={liveTrades}
          paperStatus={paperStatus}
          cryptoScan={cryptoScan}
          cryptoScanError={cryptoScanError}
          onUpdate={refresh}
          onScan={handleScan}
        />
      )}

      {/* H) Kandidater & paper trades */}
      <LiveTradesSection
        liveTrades={liveTrades}
        tradeLimit={tradeLimit}
        onTradeLimitChange={setTradeLimit}
        refreshing={refreshing}
        refreshError={refreshError}
      />

      {/* I) Learning Engine v1 */}
      <LearningEngineSection learning={learning} />

      {/* J) Effekt av senaste ändring */}
      <ImpactPanel impact={impact} onScan={()=>handleScan()} />

    </div>
  );
}
