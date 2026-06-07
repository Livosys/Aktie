import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdvancedModeToggle, PlatformEmptyState, PlatformSafetyBar, useAdvancedMode } from '../components/PlatformControls.jsx';
import TradeReplayPanel from '../components/TradeReplayPanel.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

const TABS = [
  { key: 'oversikt',   labelKey: 'insights.overview',     label: 'Översikt',     icon: '📊' },
  { key: 'batch',      labelKey: 'insights.batchTests',   label: 'Batchtester',  icon: '🧱' },
  { key: 'replay',     labelKey: 'insights.replayTests',  label: 'Replaytester', icon: '▶️' },
  { key: 'paper',      labelKey: 'insights.paperTests',   label: 'Låtsastester', icon: '🧪' },
  { key: 'data',       labelKey: 'insights.data',         label: 'Data',         icon: '▣' },
  { key: 'ai',         labelKey: 'insights.aiSummary',    label: 'AI-slutsats',  icon: '🤖' },
  { key: 'activity',   labelKey: 'insights.activity',     label: 'Aktivitet',    icon: '◷' },
  { key: 'candidates', labelKey: 'insights.candidates',   label: 'Kandidater',   icon: '◎' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtRate(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  const pct = n > 1 ? n : n * 100;
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
}

function safeText(value, fallback = 'För lite data') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
  if (typeof value === 'object') return fallback;
  return String(value);
}

function safeNumber(value, fallback = '–') {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtActivityTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('sv-SE') : '–';
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function fmtDate(value) {
  if (!value) return '–';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtSchedule(auto) {
  if (!auto) return 'Schema saknas';
  if (auto.enabled === false) return 'Avstängd just nu';
  const minutes = Number(auto.intervalMinutes || auto.interval_minutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes === 60) return 'Varje timme';
    if (minutes % 60 === 0) return `Var ${minutes / 60}:e timme`;
    return `Var ${minutes}:e minut`;
  }
  return safeText(auto.schedule || auto.cron || auto.status, 'Schema saknas');
}

function fmtAge(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 60) return `${Math.round(n)} sek`;
  if (n < 3600) return `${Math.round(n / 60)} min`;
  if (n < 86400) return `${Math.round(n / 3600)} tim`;
  return `${Math.round(n / 86400)} dagar`;
}

function resultLabel(value, t = null) {
  const label = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
  const raw = String(value || '').toUpperCase();
  if (raw === 'WIN') return label('insights.resultWin', 'Vinst i test');
  if (raw === 'LOSS') return label('insights.resultLoss', 'Förlust i test');
  if (raw === 'STOP_HIT' || raw === 'STOP_LOSS' || raw === 'STOPLOSS') return label('insights.resultStopHit', 'Stop-nivå träffades');
  if (raw === 'EXIT_ENGINE_TARGET_HIT' || raw === 'TARGET_HIT' || raw === 'TAKE_PROFIT') return label('insights.resultTargetHit', 'Systemets mål träffades');
  if (raw === 'TIMEOUT' || raw === 'TIME_EXIT' || raw === 'TIME_LIMIT') return label('insights.resultTimeout', 'Avslutades på maxtid');
  if (raw === 'SKIPPED') return label('insights.resultSkipped', 'Hoppades över');
  if (raw === 'BLOCKED' || raw === 'SAFETY_BLOCKED') return label('insights.resultBlocked', 'Blockerades av säkerhetsregel');
  if (raw === 'MANUAL' || raw === 'MANUAL_EXIT') return 'Manuell stängning';
  if (raw === 'EXIT_ENGINE' || raw === 'EXIT_SIGNAL') return 'Exitmotor stängde';
  if (raw === 'TRAILING_STOP') return 'Trailing stop träffades';
  return safeText(value, 'Saknas');
}

function compactList(value, limit = 6) {
  const list = Array.isArray(value) ? value.filter(Boolean) : [];
  if (!list.length) return 'Saknas';
  const visible = list.slice(0, limit).join(', ');
  return list.length > limit ? `${visible} +${list.length - limit}` : visible;
}

function MetricCard({ icon, value, label, sub, color }) {
  const { tr } = useLanguage();
  const c = color === 'green' ? '#22c55e' : color === 'red' ? '#ef4444' : color === 'yellow' ? '#f59e0b' : '#93c5fd';
  return (
    <div className="res-metric-card">
      {icon && <div className="res-metric-icon">{icon}</div>}
      <div className="res-metric-value" style={{ color: c }}>{tr(value ?? '–')}</div>
      <div className="res-metric-label">{tr(label)}</div>
      {sub && <div className="res-metric-sub">{tr(sub)}</div>}
    </div>
  );
}

function WinBar({ wr }) {
  const { tr } = useLanguage();
  if (wr == null) return <span className="res-no-data">{tr('Ingen data')}</span>;
  const pct = Math.max(0, Math.min(100, wr));
  const color = pct >= 58 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div className="res-winbar">
      <div className="res-winbar-track">
        <div className="res-winbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ color, fontWeight: 600, fontSize: 12 }}>{pct}%</span>
    </div>
  );
}

function SafetyBanner() {
  const { tr } = useLanguage();
  return (
    <div className="res-safety-banner">
      <span>🔒</span>
      <span className="res-safety-green">{tr('Riktig handel är avstängd')}</span>
      <span className="res-safety-muted">{tr('· Bara analys · Inga riktiga orders')}</span>
    </div>
  );
}

function DailyReportCard({ title, rows, conclusion }) {
  const { tr } = useLanguage();
  return (
    <div className="res-daily-card">
      <div className="res-daily-card-title">{tr(title)}</div>
      <div className="res-daily-rows">
        {rows.map((row) => (
          <div key={row.label} className="res-daily-row">
            <span>{tr(row.label)}</span>
            <strong>{tr(safeText(row.value, row.fallback || 'För lite data'))}</strong>
          </div>
        ))}
      </div>
      {conclusion && <div className="res-daily-conclusion">{tr(safeText(conclusion))}</div>}
    </div>
  );
}

function DailySystemReport() {
  const { t, tr } = useLanguage();
  const [advancedMode, setAdvancedMode] = useAdvancedMode();
  const [overview, setOverview] = useState(null);
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);
  const [batchStatus, setBatchStatus] = useState(null);
  const [batchAuto, setBatchAuto] = useState(null);
  const [replayAuto, setReplayAuto] = useState(null);
  const [replayStatus, setReplayStatus] = useState(null);
  const [dataJobs, setDataJobs] = useState(null);
  const [paperStatus, setPaperStatus] = useState(null);
  const [liveActivity, setLiveActivity] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiLatest, setAiLatest] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/supervisor/overview').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/results/daily-intelligence').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipeline/daily/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipeline/daily/recent?limit=5').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/batches').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/batch-autopilot').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/replay-autopilot').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/replay').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/data-jobs').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/paper-trading').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/live-activity?limit=20').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ai/analyst/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ai/analyst/latest').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([supervisor, daily, st, rec, batches, batchAutoStatus, replayAutoStatus, replayReadOnly, jobs, paperTrading, activity, analystStatus, analystLatest]) => {
      setOverview(supervisor);
      setReport(daily);
      setStatus(st);
      setRecent(rec?.runs || []);
      setBatchStatus(batches);
      setBatchAuto(batchAutoStatus);
      setReplayAuto(replayAutoStatus);
      setReplayStatus(replayReadOnly);
      setDataJobs(jobs);
      setPaperStatus(paperTrading);
      setLiveActivity(activity);
      setAiStatus(analystStatus);
      setAiLatest(analystLatest);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="res-loading">{tr('Laddar daglig systemrapport...')}</div>;
  const data = report || {};
  const cfg = status?.config || {};
  const dataFetch = data.data_fetch || {};
  const replay = data.replay || {};
  const batch = data.batch || {};
  const paper = data.paper || {};
  const ai = data.ai_summary || {};
  const safety = data.safety || {};
  const latestBatch = batchStatus?.latestBatch || batchStatus?.latestCompletedBatch || overview?.batchSummary?.latestBatch || null;
  const bestOutcome = batchStatus?.bestOutcome || latestBatch?.bestOutcome || {};
  const hourlyImport = dataJobs?.hourlyImport || {};
  const weeklyBackfill = dataJobs?.weeklyBackfill || {};
  const latestImport = hourlyImport.latestImport || {};
  const latestBackfill = weeklyBackfill.latestBackfill || {};
  const cache = dataJobs?.cacheStatus || {};
  const quality = dataJobs?.dataQuality || {};
  const provider = dataJobs?.providerStatus?.alpaca?.provider || latestImport.provider || 'Alpaca';
  const latestPaper = paperStatus?.latestPaperTrade && paperStatus.latestPaperTrade.id ? paperStatus.latestPaperTrade : null;
  const paperSummary = paperStatus?.summary || {};
  const latestAiOutput = aiLatest?.latest?.output || aiLatest?.output || aiLatest?.latest || {};
  const analystProvider = aiStatus?.provider === 'anthropic' ? 'Claude' : aiStatus?.provider === 'openai' ? 'OpenAI' : 'Disabled';
  const replayWithActivity = (replayStatus?.recentReplays || []).find((item) => Number(item?.totalEvents) > 0) || replayStatus?.latestReplay || overview?.replaySummary?.latestReplay || null;
  const replayPeriod = replayWithActivity?.period || {};
  const latestImportPeriod = latestImport.from && latestImport.to ? `${fmtDate(latestImport.from)} - ${fmtDate(latestImport.to)}` : 'Saknas';
  const aiRisks = Array.isArray(latestAiOutput.risks) ? latestAiOutput.risks.slice(0, 2).join(' · ') : '';
  const aiNext = Array.isArray(latestAiOutput.next_recommended_tests) ? latestAiOutput.next_recommended_tests.slice(0, 2).join(' · ') : '';

  return (
    <div className="res-daily-panel">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('Riktiga resultat just nu')}</h2>
          <p className="res-section-sub">{tr('Senaste riktiga resultat från batch, låtsastester, replay, data och AI. Resultat först — systemrapport och pipeline ligger längre ner.')}</p>
        </div>
        <div className="res-daily-actions">
          <button className="res-mini-action" type="button" onClick={load}>{tr('Uppdatera')}</button>
        </div>
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Bästa batchresultat"
          rows={[
            { label: 'Strategi', value: bestOutcome.strategy || 'För lite data' },
            { label: 'Symbol', value: bestOutcome.symbol || 'För lite data' },
            { label: 'Timeframe', value: bestOutcome.timeframe || latestBatch?.timeframe || 'För lite data' },
            { label: 'Score', value: bestOutcome.score ?? 'För lite data' },
            { label: 'Win rate', value: bestOutcome.winRate != null ? fmtRate(bestOutcome.winRate) : 'För lite data' },
            { label: 'Avg P/L', value: bestOutcome.avgResult != null ? fmtPct(bestOutcome.avgResult) : 'För lite data' },
            { label: 'Total P/L', value: bestOutcome.totalPnl != null ? fmtPct(bestOutcome.totalPnl) : 'För lite data' },
            { label: 'Antal trades', value: safeNumber(bestOutcome.trades, 'För lite data') },
            { label: 'Senaste batch', value: latestBatch?.id || 'Saknas' },
            { label: 'Batchstatus', value: latestBatch?.status || batchStatus?.status || 'Saknas' },
            { label: 'Schema', value: `${fmtSchedule(batchAuto)}${batchAuto?.intervalMinutes ? ` (intervalMinutes=${batchAuto.intervalMinutes})` : ''}` },
            { label: 'Idag / nästa', value: `${safeNumber(batchAuto?.todayRunCount, 0)} / ${fmtActivityTime(batchAuto?.nextRun)}` },
          ]}
          conclusion="Batch kör just nu var 6:e timme. Ingen riktig handel sker."
        />
        <DailyReportCard
          title="Senaste låtsastest / paper-resultat"
          rows={[
            { label: 'Antal tester', value: safeNumber(paperStatus?.count || paperSummary.totalTrades, 0) },
            { label: 'Win rate', value: paperSummary.winRate != null ? fmtRate(paperSummary.winRate) : 'För lite data' },
            { label: 'Decisive win rate', value: paperSummary.decisiveWinRate != null ? fmtRate(paperSummary.decisiveWinRate) : 'För lite data' },
            { label: 'Snitt P/L', value: paperSummary.avgPnl != null ? fmtPct(paperSummary.avgPnl) : 'För lite data' },
            { label: 'Total P/L', value: paperSummary.totalPnl != null ? fmtPct(paperSummary.totalPnl) : 'För lite data' },
            { label: 'Bästa strategi', value: paperSummary.bestStrategy?.strategy || 'För lite data' },
            { label: 'Senaste symbol', value: latestPaper?.symbol || 'Saknas' },
            { label: 'Senaste strategi', value: latestPaper?.strategyLabel || latestPaper?.strategy || 'Saknas' },
            { label: 'Senaste resultat', value: resultLabel(latestPaper?.result, t) },
            { label: 'P/L', value: latestPaper?.pnl != null ? fmtPct(latestPaper.pnl) : 'Saknas' },
            { label: 'Exit reason', value: resultLabel(latestPaper?.exitReason, t) },
            { label: 'Lärdom', value: latestPaper?.lesson || 'För lite data' },
          ]}
          conclusion="Låtsastester är simulering. Inga riktiga pengar används."
        />
        <DailyReportCard
          title="Replay med aktivitet"
          rows={[
            { label: 'Run id', value: replayWithActivity?.runId || 'Saknas' },
            { label: 'Period', value: replayPeriod.from && replayPeriod.to ? `${fmtDate(replayPeriod.from)} - ${fmtDate(replayPeriod.to)}` : 'Saknas' },
            { label: 'Symboler', value: compactList(replayWithActivity?.symbols, 8) },
            { label: 'Timeframe', value: replayWithActivity?.timeframe || compactList(replayStatus?.timeframes, 3) },
            { label: 'Total candles', value: safeNumber(replayWithActivity?.totalCandles, 0) },
            { label: 'Total events', value: safeNumber(replayWithActivity?.totalEvents, 0) },
            { label: 'Avg trade score', value: safeNumber(replayWithActivity?.avgTradeScore, 0) },
            { label: 'Bästa symbol', value: replayWithActivity?.bestSymbol?.symbol || 'För lite data' },
            { label: 'Replaystatus', value: replayStatus?.status || 'Saknas' },
            { label: 'Kunde inte läsa', value: safeNumber(replayStatus?.unreadableRuns, 0) },
          ]}
          conclusion={replayStatus?.status === 'degraded'
            ? `Replay är degraded eftersom vissa körningar inte kunde läsas${replayStatus?.unreadableRuns != null ? ` (${replayStatus.unreadableRuns})` : ''}, men replay-data med aktivitet finns.`
            : 'Replay visar historisk testaktivitet. Ingen riktig handel sker.'}
        />
        <DailyReportCard
          title="Alpaca-data"
          rows={[
            { label: 'Provider', value: 'Alpaca' },
            { label: 'Configured', value: dataJobs?.alpacaConfigured === true ? 'true' : 'false' },
            { label: 'Senaste importtid', value: fmtActivityTime(hourlyImport.lastRun || latestImport.completedAt) },
            { label: 'Importperiod', value: latestImportPeriod },
            { label: 'Timeframe', value: latestImport.timeframe || 'För lite data' },
            { label: 'Symbols updated', value: compactList(hourlyImport.symbolsUpdated, 8) },
            { label: 'Candles imported', value: safeNumber(hourlyImport.candlesImported || latestImport.candlesImported, 0) },
            { label: 'Latest symbol import', value: latestImport.symbol || 'Saknas' },
            { label: 'Backfill status', value: weeklyBackfill.status || 'Saknas' },
            { label: 'Missing data count', value: safeNumber(weeklyBackfill.missingDataCount || quality.missingCandles, 0) },
            { label: 'Cache exists', value: cache.cacheExists === true ? 'true' : 'false' },
            { label: 'Cache age', value: fmtAge(cache.cacheAgeSeconds) },
            { label: 'Cached symbols', value: safeNumber(cache.symbolsCached, 0) },
            { label: 'Files seen', value: safeNumber(cache.filesSeen, 0) },
          ]}
          conclusion="10 års historisk täckning är inte exponerad i status-API ännu."
        />
        <DailyReportCard
          title="AI-slutsats"
          rows={[
            { label: 'Provider', value: analystProvider },
            { label: 'Model', value: aiStatus?.model || 'Saknas' },
            { label: 'Status', value: aiStatus?.status || aiStatus?.readiness || 'Saknas' },
            { label: 'Senaste analys', value: fmtActivityTime(aiLatest?.latest?.generatedAt || aiLatest?.latest?.createdAt || aiStatus?.latestTimestamp) },
            { label: 'Summary', value: latestAiOutput.summary || 'För lite data' },
            { label: 'Bästa strategi', value: latestAiOutput.best_strategy || 'För lite data' },
            { label: 'Risker', value: aiRisks || 'För lite data' },
            { label: 'Nästa rekommenderade test', value: aiNext || 'För lite data' },
          ]}
          conclusion="AI kan bara läsa och sammanfatta. Den kan inte handla, ändra risk eller aktivera strategier."
        />
        <DailyReportCard
          title="Safety"
          rows={[
            { label: 'Inga riktiga orders', value: 'Ja' },
            { label: 'actions_allowed', value: String(safety.actions_allowed === true) },
            { label: 'can_place_orders', value: String(safety.can_place_orders === true) },
            { label: 'live_trading_enabled', value: String(safety.live_trading_enabled === true) },
          ]}
          conclusion="All automation är test, replay, batch, paper och analys only. Inga riktiga order läggs."
        />
      </div>

      <div className="res-section-header res-daily-report-header">
        <div>
          <h2 className="res-section-h2">Daglig systemrapport</h2>
          <p className="res-section-sub">Historik och analys för data, replay, batch och lärande. Arkivet visar vad som hänt, inte operativa kontroller.</p>
        </div>
        <div className="res-daily-actions">
          <AdvancedModeToggle value={advancedMode} onChange={setAdvancedMode} />
        </div>
      </div>

      {advancedMode && <div className="res-daily-control">
        <div>
          <div className="res-subsection-title">Avancerad pipeline / datajobb</div>
          <div className="res-daily-muted">Read-only i Resultatarkiv. Pipelinekontroller är avstängda här för att huvudvyn ska vara historik och lärdomar.</div>
        </div>
        <div className="res-daily-status">
          <span className={status?.enabled ? 'res-daily-on' : 'res-daily-off'}>{status?.enabled ? 'På' : 'Av'}</span>
          <span>Senaste: {fmtActivityTime(status?.last_run_at || data.last_run_at)}</span>
          <span>Nästa: {fmtActivityTime(status?.next_run_at)}</span>
        </div>
        <div className="res-daily-actions">
          <button type="button" disabled title="Read-only i Resultatarkiv">
            Visa pipeline-status
          </button>
          <button type="button" disabled title="Read-only i Resultatarkiv">Automatik visas bara</button>
          <button type="button" disabled title="Read-only i Resultatarkiv">Inga ändringar här</button>
        </div>
      </div>}

      <div className="res-daily-grid">
        <DailyReportCard
          title="Datahämtning"
          rows={[
            { label: 'Senaste körning', value: fmtActivityTime(data.last_run_at) },
            { label: 'Symboler hämtade', value: `${safeNumber(dataFetch.symbols_loaded, 0)}/${safeNumber(dataFetch.symbols_requested, 0)}` },
            { label: 'Candles hämtade', value: safeNumber(dataFetch.candles_loaded, 0) },
            { label: 'Dataproblem', value: (dataFetch.warnings || []).slice(0, 2).join(' · ') || 'Inga dataproblem' },
          ]}
          conclusion={dataFetch.conclusion_sv || (dataFetch.status === 'missing' ? 'Ingen prisdata' : 'För lite data')}
        />
        <DailyReportCard
          title="Auto Replay"
          rows={[
            { label: 'Senaste replay', value: replay.session_id || 'Ingen replay körd' },
            { label: 'Händelser', value: safeNumber(replay.events_total, 0) },
            { label: 'Simulerade testhändelser', value: safeNumber(replay.trades_total, 0) },
            { label: 'P/L', value: replay.pnl === '' ? 'För lite data' : fmtPct(replay.pnl) },
            { label: 'Win rate', value: replay.win_rate === '' ? 'För lite data' : `${safeNumber(replay.win_rate, 0)}%` },
          ]}
          conclusion={replay.conclusion_sv || 'Ingen replay körd'}
        />
        <DailyReportCard
          title="Auto Batch-test"
          rows={[
            { label: 'Senaste batch', value: batch.batch_id || 'Ingen batch körd' },
            { label: 'Kombinationer', value: `${safeNumber(batch.completed_total, 0)}/${safeNumber(batch.combinations_total, 0)}` },
            { label: 'Bästa strategi', value: batch.best_strategy || 'Ingen batch körd' },
            { label: 'Bästa symbol', value: batch.best_symbol || 'För lite data' },
            { label: 'Score', value: safeNumber(batch.best_score, 0) },
          ]}
          conclusion={batch.conclusion_sv || 'Ingen batch körd'}
        />
        <DailyReportCard
          title="Paper Trading"
          rows={[
            { label: 'Låtsastester idag', value: safeNumber(paper.trades_today, 0) },
            { label: 'Total win rate', value: paper.win_rate === '' ? 'Inga låtsastester ännu' : `${safeNumber(paper.win_rate, 0)}%` },
            { label: 'Snitt P/L', value: paper.avg_pnl === '' ? 'Inga låtsastester ännu' : fmtPct(paper.avg_pnl) },
            { label: 'Öppna positioner', value: safeNumber(paper.open_positions, 0) },
          ]}
          conclusion={paper.conclusion_sv || 'Inga låtsastester ännu'}
        />
        <DailyReportCard
          title="AI-slutsats"
          rows={[
            { label: 'Vad fungerade bäst', value: (ai.recommended_strategies || []).join(', ') || ai.main_conclusion_sv || 'För lite data' },
            { label: 'Vad bör undvikas', value: (ai.strategies_to_avoid || []).join(', ') || 'För lite data' },
            { label: 'Nästa test', value: (ai.next_test_plan || []).slice(0, 2).join(' · ') || 'För lite data' },
          ]}
          conclusion={ai.main_conclusion_sv || 'För lite data'}
        />
        <DailyReportCard
          title="Safety"
          rows={[
            { label: 'Inga riktiga orders', value: 'Ja' },
            { label: 'actions_allowed', value: String(safety.actions_allowed === true ? true : false) },
            { label: 'can_place_orders', value: String(safety.can_place_orders === true ? true : false) },
            { label: 'live_trading_enabled', value: String(safety.live_trading_enabled === true ? true : false) },
          ]}
          conclusion="All automation är test, replay, batch, paper och analys only."
        />
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Automatiska batchtester"
          rows={[
            { label: 'Status', value: batchStatus?.status || batchAuto?.status || 'Saknas' },
            { label: 'Schema', value: fmtSchedule(batchAuto) },
            { label: 'Nästa batch', value: fmtActivityTime(batchAuto?.nextRun || batchAuto?.next_run_at) },
            { label: 'Idag', value: safeNumber(batchAuto?.todayRunCount, 0) },
            { label: 'Totalt', value: safeNumber(batchStatus?.totalBatches, 0) },
            { label: 'Klara / misslyckade / pågår', value: `${safeNumber(batchStatus?.completedBatches, 0)} / ${safeNumber(batchStatus?.failedBatches, 0)} / ${safeNumber(batchStatus?.runningBatches, 0)}` },
            { label: 'Bästa strategi', value: bestOutcome.strategy || batch.best_strategy || 'För lite data' },
            { label: 'Bästa symbol', value: bestOutcome.symbol || batch.best_symbol || 'För lite data' },
            { label: 'Score', value: bestOutcome.score ?? batch.best_score ?? 'För lite data' },
            { label: 'Timeframe', value: bestOutcome.timeframe || latestBatch?.timeframe || 'För lite data' },
          ]}
          conclusion="Visar bara aktuell batchstatus och schedule. Ingen scheduler ändras här."
        />
        <DailyReportCard
          title="Historisk Alpaca-data"
          rows={[
            { label: 'Provider', value: provider },
            { label: 'Tidigaste data', value: fmtDate(weeklyBackfill.dateRange?.from || latestBackfill.dateRange?.from || data.date_range?.first_date) },
            { label: 'Senaste data', value: fmtDate(latestImport.to || weeklyBackfill.dateRange?.to || latestBackfill.dateRange?.to || data.date_range?.latest_date) },
            { label: 'Candles', value: safeNumber(hourlyImport.candlesImported || latestImport.candlesImported || dataFetch.candles_loaded, 0) },
            { label: 'Symboler', value: safeNumber(hourlyImport.symbolsUpdated || latestImport.symbolsUpdated || dataFetch.symbols_loaded, 0) },
            { label: 'Timeframes', value: latestImport.timeframe || hourlyImport.timeframes?.join?.(', ') || 'För lite data' },
            { label: 'Backfill', value: weeklyBackfill.status || 'Saknas' },
            { label: 'Saknad data', value: safeNumber(quality.missingDataCount || quality.missingCandles || weeklyBackfill.missingDataCount, 0) },
            { label: 'Cache age', value: fmtAge(cache.cacheAgeSeconds) },
          ]}
          conclusion="Data hämtas och sparas för tester. Inga datajobb startas från Resultat & Learning."
        />
        <DailyReportCard
          title="Live testing / låtsastester"
          rows={[
            { label: 'Senaste simulerade test', value: latestPaper ? fmtActivityTime(latestPaper.exitTime || latestPaper.timestamp || latestPaper.createdAt) : 'Saknas' },
            { label: 'Antal låtsastester', value: safeNumber(paperStatus?.count || paperSummary.totalTrades || paper.trades_today, 0) },
            { label: 'Win rate', value: paperSummary.winRate != null ? fmtRate(paperSummary.winRate) : (paper.win_rate === '' ? 'För lite data' : fmtRate(paper.win_rate)) },
            { label: 'Snitt P/L', value: paperSummary.avgPnl != null ? fmtPct(paperSummary.avgPnl) : (paper.avg_pnl === '' ? 'För lite data' : fmtPct(paper.avg_pnl)) },
            { label: 'Öppna positioner', value: safeNumber(paperSummary.openPositions || paper.open_positions, 0) },
            { label: 'Senaste resultat', value: resultLabel(latestPaper?.result, t) },
            { label: 'Avslutades därför att', value: resultLabel(latestPaper?.exitReason || latestPaper?.reason, t) },
            { label: 'Lärdom', value: latestPaper?.lesson || latestPaper?.reason || paper.conclusion_sv || 'För lite data' },
          ]}
          conclusion="Låtsastester är simulering. Ingen riktig handel sker."
        />
        <DailyReportCard
          title="Fråga systemet"
          rows={[
            { label: 'AI-provider', value: analystProvider },
            { label: 'Model', value: aiStatus?.model || 'Saknas' },
            { label: 'Status', value: aiStatus?.status || aiStatus?.readiness || 'Saknas' },
            { label: 'Senaste analys', value: fmtActivityTime(aiLatest?.latest?.createdAt || aiLatest?.createdAt || aiLatest?.latestTimestamp) },
            { label: 'Senaste slutsats', value: latestAiOutput.summary || latestAiOutput.main_conclusion_sv || ai.main_conclusion_sv || 'För lite data' },
          ]}
          conclusion="Ställ frågor om systemets tester, data, strategier och resultat. AI kan bara läsa och sammanfatta. Den kan inte handla, ändra risk eller aktivera strategier. Chat-backend byggs inte i detta steg."
        />
      </div>

      {recent.length > 0 && (
        <div className="res-daily-recent">
          <div className="res-subsection-title">Senaste resultat</div>
          {recent.map((run) => (
            <div key={run.run_id} className="res-activity-row">
              <span>{fmtActivityTime(run.completed_at || run.started_at)}</span>
              <strong>{run.pipeline_status}</strong>
              <span>{run.data_fetch?.symbols_loaded ?? 0} symboler · {run.replay?.events_total ?? 0} replay-events</span>
              <em>{run.error_count ?? 0} fel</em>
            </div>
          ))}
        </div>
      )}
      <div className="res-daily-muted">Config: {cfg.cron || '0 2 * * *'} · {cfg.timezone || 'Europe/Stockholm'} · aviseringar av · riktig handel av</div>
    </div>
  );
}

// ── Tab: Översikt ─────────────────────────────────────────────────────────────
function OversiktTab() {
  const { tr } = useLanguage();
  const { test } = useUnifiedConfig('results');
  const perf = test.setupPerformance;
  const paper = test.paperPerformance;
  const [ls, setLs] = useState(null);
  const [replay, setReplay] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/history/learning-summary').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/replay/latest').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([l, rp]) => {
      setLs(l);
      setReplay(rp);
    });
  }, []);

  const topSetups = perf?.topSetups?.length ?? 0;
  const poorSetups = perf?.poorSetups?.length ?? 0;
  const overallWR = ls?.overallWinRate != null ? Math.round(ls.overallWinRate * 100) : null;
  const totalSignals = ls?.totalSignals ?? 0;
  const paperTrades = paper?.totalTrades ?? 0;
  const paperWR = paper?.winRate != null ? Math.round(paper.winRate * 100) : null;
  const paperPnl = paper?.totalPnlPct ?? null;

  return (
    <div className="res-tab-content">
      <DailySystemReport />
      <h2 className="res-section-h2">{tr('Systemöversikt')}</h2>
      <div className="res-metrics-row">
        <MetricCard icon="📊" value={overallWR != null ? `${overallWR}%` : '–'} label="Total träffsäkerhet" sub={`${totalSignals} signaler totalt`} color={overallWR >= 55 ? 'green' : overallWR >= 45 ? 'yellow' : 'red'} />
        <MetricCard icon="🎯" value={topSetups} label="Bra mönster" sub="Historiskt lönsamma" color="green" />
        <MetricCard icon="⚠️" value={poorSetups} label="Svaga mönster" sub="Undvik just nu" color="red" />
        <MetricCard icon="🧪" value={paperTrades} label="Låtsastester" sub="Simulerade resultat totalt" color="blue" />
        {paperWR != null && <MetricCard icon="💰" value={`${paperWR}%`} label="Paper träffsäkerhet" sub={paperPnl != null ? fmtPct(paperPnl) + ' snitt P/L' : ''} color={paperWR >= 55 ? 'green' : 'yellow'} />}
      </div>

      <div className="res-quick-links">
        <Link to="/daytrading" className="res-quick-btn">◉ DAYTRADING — operativ kontroll</Link>
        <Link to="/lab" className="res-quick-btn">🧪 LAB — analys &amp; test</Link>
        <Link to="/system?tab=safety" className="res-quick-btn">🛡️ SYSTEM — safety &amp; skyddsstatus</Link>
        <Link to="/insikter?tab=data" className="res-quick-btn">▣ Data — all historik</Link>
      </div>
    </div>
  );
}

// ── Tab: AI-slutsats ──────────────────────────────────────────────────────────
function AiTab() {
  const { tr } = useLanguage();
  const [status, setStatus] = useState(null);
  const [latest, setLatest] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/ai/analyst/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ai/analyst/latest').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, l]) => {
      setStatus(s);
      setLatest(l);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">{tr('Laddar AI-slutsats...')}</div>;

  const out = latest?.latest?.output || latest?.output || latest?.latest || {};
  const provider = status?.provider === 'anthropic' ? 'Claude'
    : status?.provider === 'openai' ? 'OpenAI'
    : (status?.provider || 'Disabled');
  const risks = Array.isArray(out.risks) ? out.risks.join(' · ') : '';
  const next = Array.isArray(out.next_recommended_tests) ? out.next_recommended_tests.join(' · ') : '';
  const lastAnalysis = fmtActivityTime(latest?.latest?.generatedAt || latest?.latest?.createdAt || status?.latestTimestamp);

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('AI-slutsats')}</h2>
          <p className="res-section-sub">{tr('Senaste AI-analys av tester och data. AI kan bara läsa och sammanfatta — inte handla, ändra risk eller aktivera strategier.')}</p>
        </div>
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Senaste AI-analys"
          rows={[
            { label: 'Provider', value: provider },
            { label: 'Model', value: status?.model || 'Saknas' },
            { label: 'Status', value: status?.status || status?.readiness || 'Saknas' },
            { label: 'Senaste analys', value: lastAnalysis },
            { label: 'Summary', value: out.summary || 'För lite data' },
            { label: 'Bästa strategi', value: out.best_strategy || 'För lite data' },
            { label: 'Risker', value: risks || 'För lite data' },
            { label: 'Nästa rekommenderade test', value: next || 'För lite data' },
          ]}
          conclusion="AI kan bara läsa och sammanfatta. Den kan inte handla, ändra risk eller aktivera strategier."
        />
        <DailyReportCard
          title="Fråga systemet"
          rows={[
            { label: 'Status', value: 'Inte aktiv ännu' },
            { label: 'Senaste AI-analys', value: lastAnalysis },
          ]}
          conclusion="Kommer senare som read-only system-QA. Chat-backend byggs inte i detta steg."
        />
      </div>

      {!status && !latest?.latest && (
        <div className="res-empty">
          {tr('AI-slutsats visas här när systemet har kört en analys. AI kan bara läsa och sammanfatta, inte handla eller ändra risk.')}
        </div>
      )}
    </div>
  );
}

// ── Tab: Replaytester ─────────────────────────────────────────────────────────
function ReplayTab() {
  const { tr } = useLanguage();
  const [replayStatus, setReplayStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/status/replay')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setReplayStatus(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">{tr('Laddar replaytester...')}</div>;

  const recent = Array.isArray(replayStatus?.recentReplays) ? replayStatus.recentReplays : [];
  const withActivity = recent.find((item) => Number(item?.totalEvents) > 0) || replayStatus?.latestReplay || null;
  const latest = replayStatus?.latestReplay || recent[0] || null;
  const period = withActivity?.period || {};
  const totalReplays = replayStatus?.totalReplays ?? replayStatus?.totalRuns ?? recent.length;
  const isDegraded = replayStatus?.status === 'degraded';

  if (!replayStatus || (!recent.length && !latest)) {
    return (
      <div className="res-tab-content">
        <div className="res-section-header">
          <h2 className="res-section-h2">{tr('Replaytester')}</h2>
          <Link to="/replay" className="res-nav-link">{tr('Öppna Replay')} →</Link>
        </div>
        <div className="res-empty">{tr('Inga replaytester med data ännu. Replay-historik visas här när körningar finns.')}</div>
      </div>
    );
  }

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('Replaytester')}</h2>
          <p className="res-section-sub">{tr('Historiska replay-körningar. Bara läsning — inga riktiga order.')}</p>
        </div>
        <Link to="/replay" className="res-nav-link">{tr('Öppna Replay')} →</Link>
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Replaystatus"
          rows={[
            { label: 'Status', value: replayStatus?.status || 'Saknas' },
            { label: 'Total replay', value: safeNumber(totalReplays, 0) },
            { label: 'Senaste replay', value: latest?.runId || 'Saknas' },
            { label: 'Senaste replay med aktivitet', value: withActivity?.runId || 'För lite data' },
            { label: 'Kunde inte läsa (unreadableRuns)', value: safeNumber(replayStatus?.unreadableRuns, 0) },
          ]}
          conclusion={isDegraded
            ? `Replay är degraded eftersom vissa körningar inte kunde läsas${replayStatus?.unreadableRuns != null ? ` (${replayStatus.unreadableRuns} st)` : ''}. Replay-data med aktivitet visas ändå nedan.`
            : 'Replay visar historisk testaktivitet. Ingen riktig handel sker.'}
        />
        <DailyReportCard
          title="Senaste replay med aktivitet"
          rows={[
            { label: 'Run id', value: withActivity?.runId || 'Saknas' },
            { label: 'Period', value: period.from && period.to ? `${fmtDate(period.from)} - ${fmtDate(period.to)}` : 'Saknas' },
            { label: 'Symboler', value: compactList(withActivity?.symbols, 8) },
            { label: 'Timeframe', value: withActivity?.timeframe || compactList(replayStatus?.timeframes, 3) },
            { label: 'Total events', value: safeNumber(withActivity?.totalEvents, 0) },
            { label: 'Total candles', value: safeNumber(withActivity?.totalCandles, 0) },
            { label: 'Avg trade score', value: safeNumber(withActivity?.avgTradeScore, 0) },
            { label: 'Bästa symbol', value: withActivity?.bestSymbol?.symbol || 'För lite data' },
          ]}
          conclusion="Replay simulerar historik. Inga riktiga pengar och inga riktiga order."
        />
      </div>
    </div>
  );
}

// ── Tab: Låtsastester ─────────────────────────────────────────────────────────
function PaperTab() {
  const { t, tr } = useLanguage();
  const [paperStatus, setPaperStatus] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTradeId, setSelectedTradeId] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/status/paper-trading').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/paper-trading/trades').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([status, tr]) => {
      setPaperStatus(status);
      const list = tr?.trades || tr || [];
      setTrades(Array.isArray(list) ? list.slice(0, 20) : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">{tr('Laddar låtsastester...')}</div>;

  const summary = paperStatus?.summary || {};
  const latest = paperStatus?.latestPaperTrade && paperStatus.latestPaperTrade.id ? paperStatus.latestPaperTrade : null;
  const total = paperStatus?.count ?? summary.totalTrades ?? 0;
  // Normalisera win rate till procent oavsett om källan ger 0-1 eller 0-100 (fixar "4800%"-buggen).
  const wrNorm = summary.winRate != null ? (summary.winRate > 1 ? summary.winRate : summary.winRate * 100) : null;

  if (!total && !trades.length) {
    return (
      <div className="res-tab-content">
        <div className="res-section-header">
          <h2 className="res-section-h2">{tr('Låtsastester')}</h2>
          <Link to="/paper-trading" className="res-nav-link">{tr('Gå till Låtsastrading')} →</Link>
        </div>
        <div className="res-empty">Inga låtsastester ännu. Simulerade testhändelser visas här när de skapats.</div>
      </div>
    );
  }

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('Låtsastester')}</h2>
          <p className="res-section-sub">{tr('Simulerade testhändelser. Inga riktiga pengar, inga riktiga order.')}</p>
        </div>
        <Link to="/paper-trading" className="res-nav-link">{tr('Gå till Låtsastrading')} →</Link>
      </div>

      <div className="res-metrics-row">
        <MetricCard value={safeNumber(total, 0)} label="Antal tester" />
        {wrNorm != null && (
          <MetricCard value={fmtRate(summary.winRate)} label="Win rate" color={wrNorm >= 55 ? 'green' : wrNorm >= 45 ? 'yellow' : 'red'} />
        )}
        {summary.decisiveWinRate != null && (
          <MetricCard value={fmtRate(summary.decisiveWinRate)} label="Decisive win rate" sub="Exkl. timeout" />
        )}
        {summary.avgPnl != null && (
          <MetricCard value={fmtPct(summary.avgPnl)} label="Snitt P/L" color={summary.avgPnl >= 0 ? 'green' : 'red'} />
        )}
        {summary.totalPnl != null && (
          <MetricCard value={fmtPct(summary.totalPnl)} label="Total P/L" color={summary.totalPnl >= 0 ? 'green' : 'red'} />
        )}
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Sammanfattning"
          rows={[
            { label: 'Antal tester', value: safeNumber(total, 0) },
            { label: 'Win rate', value: summary.winRate != null ? fmtRate(summary.winRate) : 'För lite data' },
            { label: 'Decisive win rate', value: summary.decisiveWinRate != null ? fmtRate(summary.decisiveWinRate) : 'För lite data' },
            { label: 'Snitt P/L', value: summary.avgPnl != null ? fmtPct(summary.avgPnl) : 'För lite data' },
            { label: 'Total P/L', value: summary.totalPnl != null ? fmtPct(summary.totalPnl) : 'För lite data' },
            { label: 'Bästa strategi', value: summary.bestStrategy?.strategy || 'För lite data' },
          ]}
          conclusion="Win rate räknar alla tester. Decisive win rate exkluderar timeout."
        />
        <DailyReportCard
          title="Senaste låtsastest"
          rows={[
            { label: 'Symbol', value: latest?.symbol || 'Saknas' },
            { label: 'Strategi', value: latest?.strategyLabel || latest?.strategy || 'Saknas' },
            { label: 'Resultat', value: resultLabel(latest?.result, t) },
            { label: 'P/L', value: latest?.pnl != null ? fmtPct(latest.pnl) : 'Saknas' },
            { label: 'Exit reason', value: resultLabel(latest?.exitReason || latest?.reason, t) },
            { label: 'Lärdom', value: latest?.lesson || 'För lite data' },
          ]}
          conclusion="Låtsastester är simulering. Ingen riktig handel sker."
        />
      </div>

      {trades.length > 0 && (
        <>
          <div className="res-subsection-title">Senaste tester</div>
          <div className="res-trade-list">
            {trades.map((trade, i) => (
              <div key={trade.tradeId || i} className="res-trade-row">
                <span className="res-trade-sym">{trade.symbol || '–'}</span>
                <span className={`res-trade-type ${['LONG', 'UP', 'BUY'].includes(trade.direction || trade.type) ? 'res-long' : 'res-short'}`}>
                  {trade.direction || trade.type || '–'}
                </span>
                <span className={`res-trade-pnl ${(trade.pnlPct ?? trade.pnl ?? 0) >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}`}>
                  {fmtPct(trade.pnlPct ?? trade.pnl)}
                </span>
                <span>{resultLabel(trade.exitReason || trade.reason, t)}</span>
                <span className="res-trade-date">
                  {fmtActivityTime(trade.closed_at || trade.closedAt || trade.exitTime || trade.opened_at || trade.entryTime)}
                </span>
                <button className="res-mini-action" type="button" onClick={() => setSelectedTradeId(trade.tradeId || trade.trade_id)}>
                  Visa simulerat test
                </button>
              </div>
            ))}
          </div>
          <TradeReplayPanel tradeId={selectedTradeId} onClose={() => setSelectedTradeId('')} />
        </>
      )}
    </div>
  );
}

function ActivityTab() {
  const { t } = useLanguage();
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTradeId, setSelectedTradeId] = useState('');
  const filters = [
    { key: 'all', label: 'Alla' },
    { key: 'trades', label: 'Testhändelser' },
    { key: 'batches', label: 'Batch' },
    { key: 'candidates', label: t('insights.candidates', 'Kandidater') },
    { key: 'blockers', label: 'Blockers' },
  ];

  useEffect(() => {
    setLoading(true);
    const url = filter === 'all' ? '/api/audit/recent?limit=80'
      : filter === 'trades' ? '/api/audit/trades/recent?limit=80'
      : filter === 'batches' ? '/api/audit/batches/recent?limit=80'
      : filter === 'candidates' ? '/api/audit/candidates/recent?limit=80'
      : '/api/audit/recent?category=blockers&limit=80';
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setEvents(d?.events || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filter]);

  function replayIdForEvent(event) {
    return event?.details?.trade_id || event?.details?.tradeId || event?.details?.paper_event_id || event?.event_id || '';
  }

  function isPaperTradeEvent(event) {
    return ['PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED'].includes(String(event?.type || '').toUpperCase());
  }

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Aktivitet</h2>
        <span className="res-count">{events.length} events</span>
      </div>

      <div className="res-activity-filters">
        {filters.map(item => (
          <button key={item.key} type="button" className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="res-loading">Laddar aktivitet...</div>
      ) : events.length > 0 ? (
        <div className="res-activity-list">
          {events.map(event => (
            <div key={event.event_id} className={`res-activity-row res-activity-${String(event.type || '').toLowerCase()}`}>
              <span className="res-activity-time">{fmtActivityTime(event.timestamp)}</span>
              <strong>{event.symbol || event.details?.batch_id || 'System'}</strong>
              <span>{event.message || event.type}</span>
              <em>{event.details?.duration_label || (event.details?.progress?.pct != null ? `${event.details.progress.pct}%` : event.source)}</em>
              {isPaperTradeEvent(event) && (
                <button className="res-mini-action" type="button" onClick={() => setSelectedTradeId(replayIdForEvent(event))}>
                  Visa simulerat test
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="res-empty">Ingen aktivitet i audit-loggen ännu.</div>
      )}
      <TradeReplayPanel tradeId={selectedTradeId} onClose={() => setSelectedTradeId('')} />
    </div>
  );
}

function CandidatesTab() {
  const { t, tr } = useLanguage();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/candidates/stats').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/candidates/recent?n=20').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(r?.candidates || []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="res-loading">Laddar kandidatstatistik...</div>;

  return (
    <div className="res-tab-content">
      <h2 className="res-section-h2">{t('insights.candidates', 'Kandidater')}</h2>
      <div className="res-metrics-row">
        <MetricCard value={stats?.total ?? recent.length} label={t('insights.candidates', 'Kandidater')} />
        <MetricCard value={stats?.last24h ?? '–'} label="Kandidater senaste 24h" />
        <MetricCard value="Nej" label="Kan lägga order" color="red" />
      </div>
      {recent.length === 0 ? (
        <PlatformEmptyState title="Inga kandidater loggade" text="Kandidater visas när scanner, riskmotor och låtsastrading har testdata." />
      ) : (
        <>
        <div className="res-subsection-title">Senaste kandidater</div>
        <div className="res-trade-list">
          {recent.map((c, i) => (
            <div key={`${c.symbol || 'candidate'}-${c.timestamp || i}`} className="res-trade-row">
              <span className="res-trade-sym">{c.symbol || '–'}</span>
              <span>{c.signalFamily || c.setup || c.eventType || 'Mönster saknas'}</span>
              <span>{c.tradeScore ?? c.score ?? '–'} styrka</span>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Batchtester ──────────────────────────────────────────────────────────
function BatchTab() {
  const { tr } = useLanguage();
  const [batchStatus, setBatchStatus] = useState(null);
  const [batchAuto, setBatchAuto] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/status/batches').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/status/batch-autopilot').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([b, a]) => {
      setBatchStatus(b);
      setBatchAuto(a);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">{tr('Laddar batchtester...')}</div>;

  const latestBatch = batchStatus?.latestBatch || batchStatus?.latestCompletedBatch || null;
  const bestOutcome = batchStatus?.bestOutcome || latestBatch?.bestOutcome || {};
  const maxPerDay = batchAuto?.maxPerDay ?? batchAuto?.maxRunsPerDay ?? batchAuto?.maxRuns ?? null;

  if (!batchStatus && !batchAuto) {
    return (
      <div className="res-tab-content">
        <div className="res-section-header">
          <h2 className="res-section-h2">{tr('Batchtester')}</h2>
          <Link to="/lab" className="res-nav-link">{tr('Öppna Lab')} →</Link>
        </div>
        <div className="res-empty">Inga batchtester ännu. Batchresultat visas här när autopiloten kört.</div>
      </div>
    );
  }

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('Batchtester')}</h2>
          <p className="res-section-sub">{tr('Automatiska batchkörningar och bästa resultat. Bara läsning — schemat ändras inte här.')}</p>
        </div>
        <Link to="/lab" className="res-nav-link">{tr('Öppna Lab')} →</Link>
      </div>

      <div className="res-daily-grid">
        <DailyReportCard
          title="Batch-autopilot"
          rows={[
            { label: 'Status', value: batchAuto?.status || batchStatus?.status || 'Saknas' },
            { label: 'Schema', value: fmtSchedule(batchAuto) },
            { label: 'Körningar idag', value: safeNumber(batchAuto?.todayRunCount, 0) },
            { label: 'Max per dag', value: maxPerDay != null ? safeNumber(maxPerDay, '–') : 'Saknas' },
            { label: 'Nästa körning', value: fmtActivityTime(batchAuto?.nextRun || batchAuto?.next_run_at) },
            { label: 'Totalt antal batchar', value: safeNumber(batchStatus?.totalBatches, 0) },
            { label: 'Klara / misslyckade', value: `${safeNumber(batchStatus?.completedBatches, 0)} / ${safeNumber(batchStatus?.failedBatches, 0)}` },
            { label: 'Pågår / pausade', value: `${safeNumber(batchStatus?.runningBatches, 0)} / ${safeNumber(batchStatus?.pausedBatches, 0)}` },
          ]}
          conclusion="Batch kör just nu var 6:e timme. Visar bara status och schema — ingen scheduler ändras."
        />
        <DailyReportCard
          title="Bästa batchresultat"
          rows={[
            { label: 'Strategi', value: bestOutcome.strategy || 'För lite data' },
            { label: 'Symbol', value: bestOutcome.symbol || 'För lite data' },
            { label: 'Timeframe', value: bestOutcome.timeframe || latestBatch?.timeframe || 'För lite data' },
            { label: 'Score', value: bestOutcome.score ?? 'För lite data' },
            { label: 'Win rate', value: bestOutcome.winRate != null ? fmtRate(bestOutcome.winRate) : 'För lite data' },
            { label: 'Avg P/L', value: bestOutcome.avgResult != null ? fmtPct(bestOutcome.avgResult) : 'För lite data' },
            { label: 'Total P/L', value: bestOutcome.totalPnl != null ? fmtPct(bestOutcome.totalPnl) : 'För lite data' },
            { label: 'Trades', value: safeNumber(bestOutcome.trades, 'För lite data') },
            { label: 'Senaste batch-id', value: latestBatch?.id || 'Saknas' },
            { label: 'Batchstatus', value: latestBatch?.status || batchStatus?.status || 'Saknas' },
          ]}
          conclusion="Bästa batchresultat hittills. Detta är testdata, inte bevisad trading-edge."
        />
      </div>
    </div>
  );
}

// ── Tab: Data ─────────────────────────────────────────────────────────────────
function AlpacaStatusPanel() {
  const [dataJobs, setDataJobs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/status/data-jobs')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setDataJobs(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">Laddar Alpaca-data...</div>;

  const hourlyImport = dataJobs?.hourlyImport || {};
  const weeklyBackfill = dataJobs?.weeklyBackfill || {};
  const latestImport = hourlyImport.latestImport || {};
  const cache = dataJobs?.cacheStatus || {};
  const quality = dataJobs?.dataQuality || {};
  const importPeriod = latestImport.from && latestImport.to ? `${fmtDate(latestImport.from)} - ${fmtDate(latestImport.to)}` : 'Saknas';

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">Data</h2>
          <p className="res-section-sub">Alpaca-status och historisk datatäckning. Bara läsning — inga datajobb startas härifrån.</p>
        </div>
      </div>
      <div className="res-daily-grid">
        <DailyReportCard
          title="Alpaca-data"
          rows={[
            { label: 'Provider', value: 'Alpaca' },
            { label: 'Configured', value: dataJobs?.alpacaConfigured === true ? 'true' : 'false' },
            { label: 'Senaste import', value: fmtActivityTime(hourlyImport.lastRun || latestImport.completedAt) },
            { label: 'Importperiod', value: importPeriod },
            { label: 'Timeframe', value: latestImport.timeframe || 'För lite data' },
            { label: 'Symbols updated', value: compactList(hourlyImport.symbolsUpdated, 8) },
            { label: 'Candles imported', value: safeNumber(hourlyImport.candlesImported || latestImport.candlesImported, 0) },
            { label: 'Backfill status', value: weeklyBackfill.status || 'Saknas' },
            { label: 'Missing data', value: safeNumber(weeklyBackfill.missingDataCount || quality.missingCandles, 0) },
            { label: 'Cache age', value: fmtAge(cache.cacheAgeSeconds) },
            { label: 'Cached symbols', value: safeNumber(cache.symbolsCached, 0) },
            { label: 'Files seen', value: safeNumber(cache.filesSeen, 0) },
          ]}
          conclusion="10 års historisk täckning är inte exponerad i status-API ännu."
        />
      </div>
    </div>
  );
}

function DataTab() {
  const { tr } = useLanguage();
  return (
    <>
      <AlpacaStatusPanel />
      <DataCenterTab />
    </>
  );
}

function DataTone({ tone, label }) {
  const text = label || (tone === 'green' ? 'Bra data' : tone === 'yellow' ? 'Lite data' : 'Saknar data');
  return <span className={`dc-tone dc-tone-${tone || 'yellow'}`}>{text}</span>;
}

function DataCenterCard({ label, value, sub, tone = 'green' }) {
  return (
    <div className={`dc-card dc-card-${tone}`}>
      <div className="dc-card-label">{label}</div>
      <div className="dc-card-value">{value ?? '–'}</div>
      {sub && <div className="dc-card-sub">{sub}</div>}
    </div>
  );
}

function DataCenterList({ rows, empty, render }) {
  if (!rows?.length) return <div className="res-empty">{empty || 'Ingen data hittad.'}</div>;
  return <div className="dc-list">{rows.map(render)}</div>;
}

function DataCenterTab() {
  const [data, setData] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [storage, setStorage] = useState(null);
  const [missing, setMissing] = useState(null);
  const [coverageStatus, setCoverageStatus] = useState(null);
  const [coverageSymbols, setCoverageSymbols] = useState([]);
  const [coverageMarkets, setCoverageMarkets] = useState([]);
  const [backfillPlan, setBackfillPlan] = useState([]);
  const [backfillJobs, setBackfillJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      fetch('/api/data-center/summary').then(r => r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))),
      fetch('/api/data-center/symbols').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-center/storage').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-center/missing').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/symbols').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/markets').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/plan').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/backfill').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([summary, syms, store, miss, covStatus, covSymbols, covMarkets, plan, jobs]) => {
      setData(summary);
      setSymbols(syms?.symbols || []);
      setStorage(store?.storage || null);
      setMissing(miss?.missing || null);
      setCoverageStatus(covStatus || null);
      setCoverageSymbols(covSymbols?.symbols || []);
      setCoverageMarkets(covMarkets?.markets || []);
      setBackfillPlan(plan?.plan || []);
      setBackfillJobs(jobs?.jobs || []);
      setLoading(false);
    }).catch((err) => {
      setError(err.message || 'Kunde inte hämta Data Center.');
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="res-empty">
        Data Center kommer senare. Just nu visas historisk Alpaca-data i Översikt.
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="res-empty">
        Data Center kommer senare. Just nu visas historisk Alpaca-data i Översikt.
      </div>
    );
  }

  const counts = data.counts || {};
  const health = data.health || {};
  const redis = data.redis_usage || {};
  const mem = data.memory_usage || {};
  const markets = data.markets || [];
  const replay = data.replay_coverage || {};
  const strategy = data.strategy_coverage || {};
  const storageRows = storage?.paths || [];
  const missingRows = (missing?.symbols_missing || []).slice(0, 14);
  const weakRows = (missing?.symbols_weak || []).slice(0, 10);
  const topSymbols = [...symbols].slice(0, 18);
  const coverageRows = coverageSymbols.slice(0, 28);
  const weakMarkets = coverageMarkets.filter((m) => m.missing_count > 0 || m.weak_count > 0).slice(0, 6);
  const activeJobs = backfillJobs.filter((job) => ['created', 'running', 'paused'].includes(job.status)).slice(0, 8);

  return (
    <div className="res-tab-content dc-panel">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">{tr('Detaljerad historik & täckning')}</h2>
          <p className="res-section-sub">{tr('All historisk data systemet hittar i storage. Bara läsning.')}</p>
        </div>
        <button className="res-mini-action" type="button" onClick={load}>Uppdatera</button>
      </div>

      <div className="dc-health">
        <DataTone tone={health.tone} label={health.message_sv} />
        <span>{fmtInt(health.good_symbols)} bra symboler</span>
        <span>{fmtInt(health.weak_symbols)} med lite data</span>
        <span>{fmtInt(health.missing_symbols)} saknar data</span>
        <span>Uppdaterad {fmtActivityTime(data.generated_at)}</span>
      </div>

      <div className="dc-card-grid">
        <DataCenterCard label="Replay candles" value={fmtInt(counts.replay_candles)} sub={`${fmtInt(replay.runs)} replay-runs`} tone={counts.replay_candles > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Låtsastester" value={fmtInt(counts.paper_trades)} sub="Simulerade resultat totalt" tone={counts.paper_trades > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Audit events" value={fmtInt(counts.audit_events)} sub="Audit trail" tone={counts.audit_events > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Batch tests" value={fmtInt(counts.batch_tests)} sub={`${fmtInt(counts.strategy_batch_result_rows)} resultat-rader`} tone={counts.batch_tests > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Strategy tests" value={fmtInt(counts.strategy_tests)} sub={`${fmtInt(strategy.unique_strategies)} strategier`} tone={counts.strategy_tests > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Signaler" value={fmtInt(counts.signals)} sub={`${fmtInt(counts.signal_outcomes)} utfall`} tone={counts.signals > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Kandidater" value={fmtInt(counts.candidates)} sub="Candidate log" tone={counts.candidates > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="AI lessons" value={fmtInt(counts.ai_lessons)} sub="Signalminne" tone={counts.ai_lessons > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Symboler med historik" value={fmtInt(counts.symbols_with_history)} sub={`${fmtInt(counts.markets_with_data)} marknader`} tone={counts.symbols_with_history > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Första datum" value={fmtDate(data.date_range?.first_date)} sub="Äldsta historik" tone={data.date_range?.first_date ? 'green' : 'red'} />
        <DataCenterCard label="Senaste datum" value={fmtDate(data.date_range?.latest_date)} sub="Nyaste historik" tone={data.date_range?.latest_date ? 'green' : 'red'} />
      </div>

      <div className="dc-coverage-box">
        <div className="res-section-header">
          <div>
            <h2 className="res-section-h2">Data Coverage</h2>
            <p className="res-section-sub">Visar om symboler är redo för replay, batch-test och AI-inlärning.</p>
          </div>
          <DataTone tone={(coverageStatus?.total_coverage_score || 0) >= 70 ? 'green' : (coverageStatus?.total_coverage_score || 0) >= 35 ? 'yellow' : 'red'} label={`${fmtInt(coverageStatus?.total_coverage_score)} / 100`} />
        </div>
        <div className="dc-card-grid">
          <DataCenterCard label="Coverage score" value={`${fmtInt(coverageStatus?.total_coverage_score)} / 100`} sub="Total datatäckning" tone={(coverageStatus?.total_coverage_score || 0) >= 70 ? 'green' : 'yellow'} />
          <DataCenterCard label="Redo för replay" value={fmtInt(coverageStatus?.symbols_ready_for_replay)} sub="Symboler" tone="green" />
          <DataCenterCard label="Redo för batch-test" value={fmtInt(coverageStatus?.symbols_ready_for_batch)} sub="Symboler" tone="green" />
          <DataCenterCard label="Saknar data" value={fmtInt(coverageStatus?.symbols_missing_data)} sub="Symboler" tone={(coverageStatus?.symbols_missing_data || 0) > 0 ? 'red' : 'green'} />
        </div>
        {weakMarkets.length > 0 && (
          <>
            <div className="res-subsection-title">Marknader med svag data</div>
            <div className="dc-list">
              {weakMarkets.map((m) => (
                <div key={m.market_group} className="dc-row">
                  <strong>{m.label_sv}</strong>
                  <span>{fmtInt(m.good_count)} bra</span>
                  <span>{fmtInt(m.weak_count)} lite</span>
                  <span>{fmtInt(m.missing_count)} saknar</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="res-subsection-title">Symbol coverage</div>
      <div className="dc-table">
        <div className="dc-table-head">
          <span>Symbol</span><span>Marknad</span><span>Dagar</span><span>Candles</span><span>Status</span><span>Replay</span><span>Batch</span><span>Åtgärd</span>
        </div>
        {coverageRows.map((row) => (
          <div key={row.symbol} className="dc-table-row">
            <strong>{row.symbol}</strong>
            <span>{row.market_group}</span>
            <span>{fmtInt(row.days_covered)}</span>
            <span>{fmtInt(row.candles_count)}</span>
            <DataTone tone={row.data_quality === 'good' ? 'green' : row.data_quality === 'missing' || row.data_quality === 'missing_provider' ? 'red' : 'yellow'} label={row.status_sv || 'Lite data'} />
            <span>{row.usable_for_replay ? 'Ja' : 'Nej'}</span>
            <span>{row.usable_for_batch ? 'Ja' : 'Nej'}</span>
            <button type="button" className="res-mini-action" disabled title="Read-only i Resultatarkiv">Visa datalucka</button>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Prioriterad backfill-plan</div>
          <div className="dc-info-box">
            <strong>Systemet föreslår att fylla på dessa först</strong>
            {(backfillPlan || []).slice(0, 10).map((row, i) => (
              <span key={row.symbol}>{i + 1}. {row.symbol} · {row.status_sv || 'Behöver backfill'} · {row.reason}</span>
            ))}
            <button type="button" className="res-mini-action" disabled title="Read-only i Resultatarkiv">Visa backfill-förslag</button>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Datajobb / backfill</div>
          <DataCenterList
            rows={activeJobs}
            empty="Inga aktiva backfill-jobb."
            render={(job) => (
              <div key={job.job_id} className="dc-job-row">
                <strong>{job.symbols?.slice(0, 4).join(', ') || 'Backfill'}</strong>
                <span>{job.status}</span>
                <span>{fmtInt(job.progress?.pct)}%</span>
                <span>{fmtInt(job.candles_downloaded)} candles</span>
                <span>{fmtInt(job.errors?.length)} fel</span>
                <div className="dc-job-actions">
                  <button type="button" disabled title="Read-only i Resultatarkiv">Visa jobb</button>
                  <button type="button" disabled title="Read-only i Resultatarkiv">Paus ej tillgänglig här</button>
                  <button type="button" disabled title="Read-only i Resultatarkiv">Stopp ej tillgängligt här</button>
                </div>
              </div>
            )}
          />
        </div>
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Marknader med mest data</div>
          <DataCenterList
            rows={markets.slice(0, 8)}
            render={(row) => (
              <div key={row.market_group} className="dc-row">
                <strong>{row.label_sv || row.market_group}</strong>
                <span>{fmtInt(row.total_candle_count)} candles</span>
                <span>{fmtInt(row.symbol_count)} symboler</span>
                <DataTone tone={row.good_symbols > 0 ? 'green' : row.weak_symbols > 0 ? 'yellow' : 'red'} />
              </div>
            )}
          />
        </div>
        <div>
          <div className="res-subsection-title">Mest testade symboler</div>
          <DataCenterList
            rows={data.top_traded_symbols || []}
            empty="Inga låtsastester ännu."
            render={(row) => (
              <div key={row.symbol} className="dc-row">
                <strong>{row.symbol}</strong>
                <span>{fmtInt(row.count)} testhändelser</span>
              </div>
            )}
          />
          <div className="res-subsection-title dc-subtitle-gap">Top replayed symbols</div>
          <DataCenterList
            rows={data.top_replayed_symbols || []}
            empty="Ingen replay-symbol hittad."
            render={(row) => (
              <div key={row.symbol} className="dc-row">
                <strong>{row.symbol}</strong>
                <span>{fmtInt(row.count)} events</span>
              </div>
            )}
          />
        </div>
      </div>

      <div className="res-subsection-title">Data coverage per symbol</div>
      <div className="dc-symbol-grid">
        {topSymbols.map((row) => (
          <div key={row.symbol} className={`dc-symbol dc-symbol-${row.tone}`}>
            <div className="dc-symbol-head">
              <strong>{row.symbol}</strong>
              <DataTone tone={row.tone} />
            </div>
            <div className="dc-symbol-meta">
              <span>{row.market_group}</span>
              <span>{fmtInt(row.candles_2m_count)} 2m candles</span>
              <span>{fmtInt(row.candles_2m_days)} dagar</span>
              <span>{fmtDate(row.first_date)} - {fmtDate(row.latest_date)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title res-poor-label">Saknar data</div>
          <DataCenterList
            rows={missingRows}
            empty="Inga saknade symboler hittades."
            render={(row) => (
              <div key={row.symbol} className="dc-row dc-row-red">
                <strong>{row.symbol}</strong>
                <span>{row.market_group}</span>
                <em>{row.reason_sv}</em>
              </div>
            )}
          />
        </div>
        <div>
          <div className="res-subsection-title">Lite data</div>
          <DataCenterList
            rows={weakRows}
            empty="Inga svaga symboler hittades."
            render={(row) => (
              <div key={row.symbol} className="dc-row dc-row-yellow">
                <strong>{row.symbol}</strong>
                <span>{row.market_group}</span>
                <em>{row.reason_sv}</em>
              </div>
            )}
          />
        </div>
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Replay coverage</div>
          <div className="dc-info-box">
            <strong>{replay.coverage_sv || 'Ingen replay coverage hittad'}</strong>
            <span>Events: {fmtInt(replay.replay_events)}</span>
            <span>Period: {fmtDate(replay.first_date)} - {fmtDate(replay.latest_date)}</span>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Strategy coverage</div>
          <div className="dc-info-box">
            <strong>{strategy.coverage_sv || 'Ingen strategy coverage hittad'}</strong>
            <span>Batcher: {fmtInt(strategy.batch_tests)}</span>
            <span>Tester: {fmtInt(strategy.strategy_tests)}</span>
            <span>Period: {fmtDate(strategy.first_date)} - {fmtDate(strategy.latest_date)}</span>
          </div>
        </div>
      </div>

      <div className="res-subsection-title">Storage paths</div>
      <div className="dc-storage">
        {storageRows.map((row) => (
          <div key={row.key} className="dc-storage-row">
            <strong>{row.label}</strong>
            <code>{row.rel}</code>
            <span>{fmtBytes(row.bytes)}</span>
            <span>{fmtInt(row.files)} filer</span>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Redis usage</div>
          <div className="dc-info-box">
            <strong>{redis.mode || 'fallback'}</strong>
            <span>Status: {redis.clientStatus || 'unknown'}</span>
            <span>Keys: {fmtInt(redis.dbsize ?? redis.memoryFallbackKeys)}</span>
            <span>Memory: {redis.used_memory_human || fmtBytes(redis.used_memory_bytes)}</span>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Memory usage</div>
          <div className="dc-info-box">
            <strong>Node process</strong>
            <span>RSS: {fmtBytes(mem.rss_bytes)}</span>
            <span>Heap used: {fmtBytes(mem.heap_used_bytes)}</span>
            <span>Heap total: {fmtBytes(mem.heap_total_bytes)}</span>
          </div>
        </div>
      </div>

      <div className="batch-safety">Safety: actions_allowed=false · can_place_orders=false · live_trading_enabled=false · read-only.</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ResultatPage() {
  const [params, setParams] = useSearchParams();
  const { t } = useLanguage();
  const requested = params.get('tab') || 'oversikt';
  const tab = TABS.some(t => t.key === requested) ? requested : 'oversikt';

  function changeTab(next) {
    setParams(next === 'oversikt' ? {} : { tab: next });
  }

  return (
    <div className="res-page">
      <PlatformSafetyBar />

      <div className="res-page-header">
        <h1 className="res-page-title">📊 {t('insights.title', 'Resultat & Learning')}</h1>
        <p className="res-page-sub">{t('insights.subtitle', 'Huvudplats för resultat, learning, batch, replay, historisk data, låtsastester och AI-frågor. Sidan är read-only.')}</p>
        <div className="res-daily-muted">{t('insights.readOnlyNote', 'Ingen riktig handel sker. Historiska testhändelser kan visa äldre strateginamn och äldre routingregler, men arkivet ändrar inte runtime eller val för låtsashandel.')}</div>
      </div>

      <div className="res-tabs">
        {TABS.map(tabItem => (
          <button
            key={tabItem.key}
            className={`res-tab${tab === tabItem.key ? ' res-tab-active' : ''}`}
            onClick={() => changeTab(tabItem.key)}
            type="button"
          >
            <span>{tabItem.icon}</span>
            <span>{t(tabItem.labelKey, tabItem.label)}</span>
          </button>
        ))}
      </div>

      {tab === 'oversikt'  && <OversiktTab />}
      {tab === 'batch'     && <BatchTab />}
      {tab === 'replay'    && <ReplayTab />}
      {tab === 'paper'     && <PaperTab />}
      {tab === 'data'      && <DataTab />}
      {tab === 'ai'        && <AiTab />}
      {tab === 'activity'  && <ActivityTab />}
      {tab === 'candidates' && <CandidatesTab />}
    </div>
  );
}
