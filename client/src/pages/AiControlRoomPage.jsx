import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ActivityList,
  BarChart,
  ChartCard,
  DashboardShell,
} from '../components/dashboard/DashboardKit.jsx';
import {
  AiDecisionCenter,
  createDecisionStore,
  createTradingEventStore,
} from '../components/trading/index.js';
import {
  createStrategyStore,
  resolveKnownStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import { EMPTY_VALUE, fmtNumber as formatNumber, numberOrNull } from '../utils/tradingFormatters.js';

// ── AI Control Room ───────────────────────────────────────────────────────────
// Read-only översikt över systemets AI-delar: vad de gör, vad de lärt sig och
// vad de föreslår härnäst. Sidan visar och förklarar — den startar inga tester,
// ändrar ingen risk och kan aldrig lägga order. Safety visas alltid.

const SAFETY_FLAGS = [
  { key: 'mode', label: 'mode', expect: 'paper_only' },
  { key: 'actions_allowed', label: 'actions_allowed', expect: false },
  { key: 'can_place_orders', label: 'can_place_orders', expect: false },
  { key: 'live_trading_enabled', label: 'live_trading_enabled', expect: false },
  { key: 'broker_enabled', label: 'broker_enabled', expect: false },
];

const SECTIONS = [
  { id: 'oversikt', path: '/ai', label: 'AI Översikt' },
  { id: 'learning', path: '/ai/learning', label: 'Lärdomar' },
  { id: 'agents', path: '/ai/agents', label: 'AI-agenter' },
  { id: 'improvements', path: '/ai/improvements', label: 'Förbättringar' },
  { id: 'pipeline', path: '/ai/pipeline', label: 'Pipeline' },
  { id: 'batch-replay', path: '/ai/batch-replay', label: 'Batch & Replay' },
  { id: 'recommendations', path: '/ai/recommendations', label: 'Rekommendationer' },
  { id: 'risks', path: '/ai/risks', label: 'Risker' },
];

const PIPELINE_STEPS = [
  { id: 'market', label: 'Marknadsdata', desc: 'Kurser och volym samlas in för aktier och krypto.' },
  { id: 'batch', label: 'Batch-test', desc: 'Strategier testas i stora svep över historiska fönster.' },
  { id: 'replay', label: 'Replay-test', desc: 'Lovande resultat spelas upp candle för candle för verifiering.' },
  { id: 'paper', label: 'Paper-observation', desc: 'Godkända strategier observeras i simulerad handel (aldrig riktiga order).' },
  { id: 'learning', label: 'Learning Engine', desc: 'Resultaten jämförs: vad fungerar, var och när?' },
  { id: 'agents', label: 'AI-agenter', desc: 'Agenterna analyserar, prioriterar och formulerar förslag.' },
  { id: 'supervisor', label: 'Supervisor-sammanfattning', desc: 'Allt vägs ihop till en helhetsbild.' },
  { id: 'recommendation', label: 'Rekommenderat nästa test', desc: 'AI föreslår nästa batch/replay-test med motivering.' },
  { id: 'review', label: 'Manuell granskning', desc: 'Du beslutar. Ingenting appliceras automatiskt.' },
];

function fetchJson(url) {
  return fetch(url, { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data) => ({ ok: true, data }))
    .catch((err) => ({ ok: false, error: err.message || String(err) }));
}

function useAiData() {
  const [state, setState] = useState({ loading: true, sources: {} });

  useEffect(() => {
    let cancelled = false;
    const endpoints = {
      supervisor: '/api/supervisor/overview',
      narrowPerformance: '/api/learning/narrow-performance',
      narrowAutopilot: '/api/autopilot/narrow/status',
      learningSummary: '/api/daytrading/learning-summary',
      analyst: '/api/ai/analyst/status',
      allowlist: '/api/automation/paper-allowlist/status',
    };
    Promise.all(
      Object.entries(endpoints).map(([key, url]) => fetchJson(url).then((result) => [key, result])),
    ).then((entries) => {
      if (cancelled) return;
      setState({ loading: false, sources: Object.fromEntries(entries) });
    });
    return () => { cancelled = true; };
  }, []);

  return state;
}

function sourceData(sources, key) {
  const entry = sources[key];
  return entry && entry.ok ? entry.data : null;
}

function aiStrategyModel(row = {}) {
  return resolveKnownStrategy(row);
}

function aiStrategyLabel(row = {}, fallback = '—') {
  return strategyDisplayName(aiStrategyModel(row), fallback);
}

function displayNumber(value, fallback = EMPTY_VALUE) {
  const n = numberOrNull(value);
  return n === null ? fallback : formatNumber(n);
}

function displayPercent(value, digits = 1, fallback = EMPTY_VALUE) {
  const n = numberOrNull(value);
  return n === null ? fallback : `${formatNumber(n, digits)}%`;
}

// ── Stilhjälpare (samma konventioner som Lab/Paper Trading) ──────────────────

const sectionStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  marginBottom: 16,
};

const mutedStyle = { color: 'var(--muted)' };

const PILL_TONES = {
  ok:      { bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.30)', fg: 'var(--success)' },
  warn:    { bg: 'rgba(245,158,11,0.14)', border: 'rgba(245,158,11,0.30)', fg: 'var(--warning)' },
  bad:     { bg: 'rgba(239,68,68,0.14)', border: 'rgba(239,68,68,0.30)', fg: 'var(--danger)' },
  info:    { bg: 'rgba(56,189,248,0.14)', border: 'rgba(56,189,248,0.30)', fg: 'var(--accent)' },
  neutral: { bg: 'var(--surface-2)', border: 'var(--border)', fg: 'var(--muted)' },
};

function Pill({ tone = 'neutral', children }) {
  const colors = PILL_TONES[tone] || PILL_TONES.neutral;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      color: colors.fg,
      whiteSpace: 'nowrap',
    }}
    >
      {children}
    </span>
  );
}

function SafetyRow({ sources }) {
  // Läser safety-flaggor från valfri lyckad källa; alla endpoints returnerar dem.
  const source = ['allowlist', 'narrowAutopilot', 'narrowPerformance', 'supervisor']
    .map((key) => sourceData(sources, key))
    .find(Boolean) || {};
  const safety = source.safety && typeof source.safety === 'object' ? { ...source, ...source.safety } : source;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 14 }}>
      <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', ...mutedStyle }}>Safety</span>
      {SAFETY_FLAGS.map((flag) => {
        const value = safety[flag.key];
        const hasFlag = value !== null && value !== undefined && value !== '';
        const asExpected = hasFlag && value === flag.expect;
        const shown = hasFlag ? String(value) : EMPTY_VALUE;
        return (
          <Pill key={flag.key} tone={asExpected ? 'ok' : 'bad'}>
            {flag.label}={shown}
          </Pill>
        );
      })}
      <span style={{ fontSize: 11, ...mutedStyle }}>Read-only — inga riktiga order kan läggas härifrån.</span>
    </div>
  );
}

function StatCard({ label, value, tone = 'neutral', note }) {
  const colors = { ok: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', neutral: 'var(--text)', info: 'var(--accent)' };
  return (
    <div style={{ flex: '1 1 150px', minWidth: 150, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', ...mutedStyle }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: colors[tone] || colors.neutral, marginTop: 2 }}>{value}</div>
      {note ? <div style={{ fontSize: 11, ...mutedStyle, marginTop: 2, lineHeight: 1.4 }}>{note}</div> : null}
    </div>
  );
}

function TechDetails({ label = 'Tekniska detaljer', data }) {
  if (data == null) return null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5, ...mutedStyle }}>{label}</summary>
      <pre style={{ fontSize: 10.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, overflowX: 'auto', maxHeight: 260, marginTop: 6 }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function MiniBar({ label, value, max, suffix = '' }) {
  const n = numberOrNull(value);
  const maxValue = numberOrNull(max);
  const pct = n !== null && maxValue !== null && maxValue > 0 ? Math.max(2, Math.min(100, Math.round((n / maxValue) * 100))) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={mutedStyle}>{n === null ? EMPTY_VALUE : displayNumber(n)}{n === null ? '' : suffix}</span>
      </div>
      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
      </div>
    </div>
  );
}

function fmtTime(value) {
  if (!value) return '–';
  try { return new Date(value).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(value); }
}

function fmtPct(value) {
  return value == null || Number.isNaN(Number(value)) ? '–' : `${Number(value).toFixed(1)}%`;
}

function statusTone(status) {
  const key = String(status || '').toLowerCase();
  if (['ok', 'ready', 'active', 'online'].includes(key)) return 'ok';
  if (['degraded', 'partial', 'pending', 'needs_more_data', 'planned', 'empty'].includes(key)) return 'warn';
  if (['error', 'failed', 'blocked', 'offline'].includes(key)) return 'bad';
  return 'neutral';
}

// ── Agentkatalog (statisk beskrivning + status från live-data) ───────────────

function buildAgents(sources) {
  const supervisor = sourceData(sources, 'supervisor') || {};
  const np = sourceData(sources, 'narrowPerformance') || {};
  const autopilotSource = sourceData(sources, 'narrowAutopilot');
  const autopilot = autopilotSource || {};
  const analyst = sourceData(sources, 'analyst') || {};
  const scheduler = autopilot.scheduler || {};
  const hasSchedulerSnapshot = Boolean(autopilotSource && autopilot.scheduler && typeof autopilot.scheduler === 'object');
  const npSummary = np.summary || {};

  const s = (obj, fallback = 'unavailable') => obj?.status || fallback;

  return [
    {
      name: 'Learning Engine',
      icon: '📚',
      purpose: 'Lär sig av batch-, replay- och paper-resultat: vilka strategier som fungerar, var och när.',
      source: 'GET /api/daytrading/learning-summary',
      status: sourceData(sources, 'learningSummary') ? 'ok' : 'no_data',
      lastActivity: npSummary.status === 'ready' ? 'Har jämförelsedata' : null,
      lastOutput: npSummary.message || null,
      benefit: 'Gör att systemet prioriterar de test som ger mest ny kunskap.',
      limitation: 'Lär sig bara av data som finns — få tester ger osäkra slutsatser.',
    },
    {
      name: 'Narrow Performance Learning',
      icon: '📊',
      purpose: 'Jämför narrow-strategierna mot varandra per score-band och bekräftelse.',
      source: 'GET /api/learning/narrow-performance',
      status: s(npSummary),
      lastActivity: np.generatedAt ? fmtTime(np.generatedAt) : null,
      lastOutput: npSummary.bestStrategy ? `Bäst just nu: ${aiStrategyLabel(npSummary.bestStrategy)}` : null,
      benefit: 'Pekar ut vilken narrow-strategi som är mest lovande.',
      limitation: `Datakonfidens: ${npSummary.dataConfidence || 'okänd'} — paper-data saknas ännu i jämförelsen.`,
    },
    {
      name: 'Narrow Test Autopilot',
      icon: '🧭',
      purpose: 'Planerar nästa narrow-test (symboler, band, tidsfönster) utifrån lärdomarna.',
      source: 'GET /api/autopilot/narrow/status',
      status: hasSchedulerSnapshot ? (scheduler.enabled ? (scheduler.dryRunOnly ? 'dry-run' : 'ok') : 'av') : 'no_data',
      lastActivity: scheduler.lastRunAt ? fmtTime(scheduler.lastRunAt) : null,
      lastOutput: autopilot.autopilot?.recommendedNextTest?.title || 'Plan skapas var 6:e timme (dry-run).',
      benefit: 'Föreslår genomtänkta tester i stället för slumpvisa.',
      limitation: 'Kör endast dry-run — exekvering kräver ett separat, manuellt beslut.',
    },
    {
      name: 'Batch Autopilot',
      icon: '🧪',
      purpose: 'Planerar större batch-svep över strategier och symboler.',
      source: 'GET /api/supervisor/overview → batchAutopilotSummary',
      status: s(supervisor.batchAutopilotSummary),
      lastActivity: null,
      lastOutput: supervisor.batchAutopilotSummary?.message || null,
      benefit: 'Håller testtakten uppe utan manuellt arbete.',
      limitation: 'Dry-run/plan-läge — startar inga körningar själv.',
    },
    {
      name: 'Replay Autopilot',
      icon: '🔁',
      purpose: 'Planerar replay-verifiering av lovande batch-resultat.',
      source: 'GET /api/supervisor/overview → replayAutopilotSummary',
      status: s(supervisor.replayAutopilotSummary),
      lastActivity: null,
      lastOutput: supervisor.replayAutopilotSummary?.message || null,
      benefit: 'Verifierar att batch-fynd håller candle för candle.',
      limitation: 'Dry-run/plan-läge — startar inga körningar själv.',
    },
    {
      name: 'AI Analyst',
      icon: '🔎',
      purpose: 'Analyserar signaler och lägen i naturligt språk (extern LLM, read-only).',
      source: 'GET /api/ai/analyst/status',
      status: analyst.status || 'no_data',
      lastActivity: analyst.latestTimestamp ? fmtTime(analyst.latestTimestamp) : null,
      lastOutput: analyst.message || null,
      benefit: 'Sätter ord på vad datat visar.',
      limitation: 'Rådgivande text — fattar inga beslut och rör aldrig ordervägar.',
    },
    {
      name: 'Supervisor Overview',
      icon: '🧠',
      purpose: 'Väger ihop scanner, paper, batch, replay och learning till en helhetsbild.',
      source: 'GET /api/supervisor/overview',
      status: supervisor.ok ? 'ok' : 'no_data',
      lastActivity: supervisor.generatedAt ? fmtTime(supervisor.generatedAt) : null,
      lastOutput: Array.isArray(supervisor.nextRecommendedActions) && supervisor.nextRecommendedActions.length
        ? `${supervisor.nextRecommendedActions.length} föreslagna nästa steg`
        : 'Inga öppna förslag just nu.',
      benefit: 'En plats för hela systemets status.',
      limitation: 'Cachear delar av datat — kan visa "laddas" direkt efter omstart.',
    },
    {
      name: 'Operations Advisor',
      icon: '🗺️',
      purpose: 'Föreslår nästa operativa steg (vad som är värt att titta på).',
      source: 'GET /api/supervisor/operations-advisor',
      status: supervisor.ok ? 'ok' : 'no_data',
      lastActivity: null,
      lastOutput: null,
      benefit: 'Prioriterar din uppmärksamhet.',
      limitation: 'Endast förslag — utför ingenting.',
    },
    {
      name: 'Agent Debate & Reasoning',
      icon: '⚖️',
      purpose: 'Väger argument för och emot en kandidat innan den rekommenderas.',
      source: 'src/services/agentDebateEngineService.js (intern)',
      status: 'intern',
      lastActivity: null,
      lastOutput: null,
      benefit: 'Minskar risken att en enskild signal övertolkas.',
      limitation: 'Ingen egen endpoint ännu — syns via supervisor-sammanfattningen.',
    },
    {
      name: 'System Intelligence Agent',
      icon: '🩺',
      purpose: 'Övervakar datakvalitet och systemhälsa som underlag för AI-delarna.',
      source: 'src/services/systemIntelligenceAgentService.js (intern)',
      status: 'intern',
      lastActivity: null,
      lastOutput: null,
      benefit: 'Flaggar när slutsatser vilar på svagt data.',
      limitation: 'Ingen egen endpoint ännu — syns via System-sidan.',
    },
  ];
}

function agentTone(status) {
  const key = String(status || '').toLowerCase();
  if (['ok', 'ready', 'active'].includes(key)) return 'ok';
  if (['dry-run', 'intern'].includes(key)) return 'info';
  if (['degraded', 'no_data', 'empty', 'av'].includes(key)) return 'warn';
  return 'neutral';
}

// ── Sektioner ─────────────────────────────────────────────────────────────────

function OverviewSection({ sources }) {
  const agents = buildAgents(sources);
  const np = sourceData(sources, 'narrowPerformance') || {};
  const autopilot = sourceData(sources, 'narrowAutopilot') || {};
  const active = agents.filter((a) => ['ok', 'ready', 'dry-run'].includes(String(a.status).toLowerCase())).length;
  const degraded = agents.filter((a) => ['degraded', 'no_data', 'empty', 'av'].includes(String(a.status).toLowerCase())).length;
  const latestLearning = np.summary?.message || 'Ingen lärdom tillgänglig ännu.';
  const latestRec = np.recommendedNextTest?.title || autopilot.autopilot?.recommendedNextTest?.title || 'Ingen rekommendation ännu.';
  const scheduler = autopilot.scheduler || {};
  const hasSchedulerSnapshot = Boolean(autopilot.scheduler && typeof autopilot.scheduler === 'object');
  const pipelineValue = hasSchedulerSnapshot ? (scheduler.enabled ? 'Dry-run' : 'Paus') : EMPTY_VALUE;

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <StatCard label="AI-delar" value={agents.length} note="beskrivna i systemet" />
        <StatCard label="Aktiva" value={active} tone="ok" note="levererar data nu" />
        <StatCard label="Degraded / no data" value={degraded} tone={degraded ? 'warn' : 'ok'} note="väntar på data eller endpoint" />
        <StatCard label="Pipeline" value={pipelineValue} tone={hasSchedulerSnapshot ? (scheduler.enabled ? 'info' : 'warn') : 'neutral'} note={hasSchedulerSnapshot ? (scheduler.nextRunAt ? `nästa plan ${fmtTime(scheduler.nextRunAt)}` : 'ingen schemalagd plan') : EMPTY_VALUE} />
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Senaste lärdom</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{latestLearning}</div>
        {np.summary?.bestStrategy ? (
          <div style={{ fontSize: 12.5, marginTop: 6, ...mutedStyle }}>
            Mest lovande strategi just nu: <strong style={{ color: 'var(--text)' }}>{aiStrategyLabel(np.summary.bestStrategy)}</strong>{' '}
            ({np.summary.bestStrategy.trades} tester, {fmtPct(np.summary.bestStrategy.winRate)} vinst).
          </div>
        ) : null}
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Senaste rekommendation</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{latestRec}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Pill tone="info">dryRun=true</Pill>
          <Pill tone="info">executed=false</Pill>
          <Pill tone="ok">endast förslag</Pill>
        </div>
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Vad den här sidan är</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, ...mutedStyle }}>
          AI:n i Trading OS analyserar, jämför, lär sig och föreslår — den lägger aldrig riktiga order,
          aktiverar aldrig broker och ändrar aldrig risk automatiskt. Alla förslag stannar i
          paper/replay-miljön tills du själv granskar och beslutar.
        </div>
      </div>
    </>
  );
}

function LearningSection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const summary = np.summary || {};
  const counts = summary.sourceCounts || null;
  const batchCount = numberOrNull(counts?.batch);
  const replayCount = numberOrNull(counts?.replay);
  const paperCount = numberOrNull(counts?.paper);
  const maxCount = Math.max(batchCount ?? 0, replayCount ?? 0, paperCount ?? 0, 1);
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <StatCard label="Jämförda tester" value={displayNumber(summary.totalTrades)} note={`${displayNumber(summary.strategiesCompared)} strategier jämförda`} />
        <StatCard label="Datakonfidens" value={summary.dataConfidence || '–'} tone={summary.dataConfidence === 'high' ? 'ok' : 'warn'} />
        <StatCard label="Status" value={summary.status || EMPTY_VALUE} tone={statusTone(summary.status)} />
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Vad systemet har lärt sig</div>
        {summary.bestStrategy ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <Pill tone="ok">Bästa strategi</Pill>
              <div style={{ fontWeight: 700, marginTop: 6 }}>{aiStrategyLabel(summary.bestStrategy)}</div>
              <div style={{ fontSize: 12, ...mutedStyle }}>{displayPercent(summary.bestStrategy.winRate)} vinst · {displayNumber(summary.bestStrategy.trades)} tester · snitt {displayPercent(summary.bestStrategy.avgPnl)}</div>
            </div>
            {summary.worstStrategy ? (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <Pill tone="warn">Svagaste strategi</Pill>
                <div style={{ fontWeight: 700, marginTop: 6 }}>{aiStrategyLabel(summary.worstStrategy)}</div>
                <div style={{ fontSize: 12, ...mutedStyle }}>{displayPercent(summary.worstStrategy.winRate)} vinst · {displayNumber(summary.worstStrategy.trades)} tester</div>
              </div>
            ) : null}
            {summary.bestScoreBand ? (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <Pill tone="info">Bästa marknadsläge</Pill>
                <div style={{ fontWeight: 700, marginTop: 6 }}>Band: {summary.bestScoreBand.band} ({summary.bestScoreBand.scoreRange})</div>
                <div style={{ fontSize: 12, ...mutedStyle }}>{fmtPct(summary.bestScoreBand.winRate)} vinst i det bandet</div>
              </div>
            ) : null}
            {summary.strongestConfirmation ? (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <Pill tone="info">Starkaste bekräftelse</Pill>
                <div style={{ fontWeight: 700, marginTop: 6 }}>{summary.strongestConfirmation.confirmation}</div>
                <div style={{ fontSize: 12, ...mutedStyle }}>
                  {displayPercent(summary.strongestConfirmation.withWinRate)} med · {displayPercent(summary.strongestConfirmation.withoutWinRate)} utan
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ fontSize: 13, ...mutedStyle }}>Ingen jämförelsedata ännu — kör batch/replay-tester så byggs lärdomarna upp här.</div>
        )}
        <div style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>{summary.message || ''}</div>
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Varifrån kommer lärdomarna?</div>
        <MiniBar label="Batch-tester" value={batchCount} max={maxCount} />
        <MiniBar label="Replay-tester" value={replayCount} max={maxCount} />
        <MiniBar label="Paper-observationer" value={paperCount} max={maxCount} />
        {paperCount === 0 ? (
          <div style={{ fontSize: 12, ...mutedStyle }}>Paper-data saknas ännu i jämförelsen — slutsatserna vilar på batch/replay.</div>
        ) : null}
        <TechDetails data={summary} />
      </div>
    </>
  );
}

function AgentsSection({ sources }) {
  const agents = buildAgents(sources);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
      {agents.map((agent) => (
        <div key={agent.name} style={{ ...sectionStyle, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 800 }}>{agent.icon} {agent.name}</div>
            <Pill tone={agentTone(agent.status)}>{agent.status}</Pill>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{agent.purpose}</div>
          <div style={{ fontSize: 11.5, ...mutedStyle }}>
            <div>Datakälla: <code style={{ fontSize: 10.5 }}>{agent.source}</code></div>
            {agent.lastActivity ? <div>Senaste aktivitet: {agent.lastActivity}</div> : null}
            {agent.lastOutput ? <div>Senaste output: {agent.lastOutput}</div> : null}
          </div>
          <div style={{ fontSize: 11.5, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div><span style={{ color: 'var(--success)', fontWeight: 700 }}>Nytta:</span> {agent.benefit}</div>
            <div style={{ marginTop: 3 }}><span style={{ color: 'var(--warning)', fontWeight: 700 }}>Begränsning:</span> {agent.limitation}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ImprovementsSection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const summary = np.summary || {};
  const rec = np.recommendedNextTest || null;
  // Förbättringsförslag härleds read-only ur learning-datat. Statusarna är
  // beskrivande etiketter för var i flödet förslaget befinner sig — inget
  // appliceras automatiskt.
  const improvements = [];
  if (summary.strongestConfirmation && summary.strongestConfirmation.impact === 'positive') {
    improvements.push({
      title: `Kräv ${summary.strongestConfirmation.confirmation}-bekräftelse oftare`,
      why: `Vinstfrekvensen är ${fmtPct(summary.strongestConfirmation.withWinRate)} med bekräftelsen mot ${fmtPct(summary.strongestConfirmation.withoutWinRate)} utan.`,
      status: 'proposed',
      evidence: summary.strongestConfirmation.evidenceQuality || 'okänd',
    });
  }
  if (summary.bestScoreBand) {
    improvements.push({
      title: `Prioritera tester i band "${summary.bestScoreBand.band}"`,
      why: `Det bandet visar ${fmtPct(summary.bestScoreBand.winRate)} vinstfrekvens i jämförelsen.`,
      status: 'testing',
      evidence: summary.dataConfidence || 'okänd',
    });
  }
  if (rec) {
    improvements.push({
      title: rec.title,
      why: rec.reason,
      status: 'replay_check',
      evidence: rec.source || 'batch',
    });
  }
  if (summary.bestStrategy) {
    improvements.push({
      title: `Granska "${aiStrategyLabel(summary.bestStrategy)}" för fortsatt paper-observation`,
      why: 'Bästa strategin i jämförelsen — nästa steg är manuell granskning av om den ska följas tätare i paper.',
      status: 'manual_review',
      evidence: `${summary.bestStrategy.trades} tester`,
    });
  }
  const toneByStatus = { proposed: 'info', testing: 'warn', replay_check: 'warn', manual_review: 'ok', rejected: 'bad' };
  return (
    <>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Förbättringar från Learning Engine</div>
        <div style={{ fontSize: 12.5, ...mutedStyle, marginBottom: 12 }}>
          Förslag härledda ur testdatat. Ingenting auto-appliceras — varje förslag kräver manuell granskning och beslut.
        </div>
        {improvements.length === 0 ? (
          <div style={{ fontSize: 13, ...mutedStyle }}>Inga förslag ännu — det byggs upp när fler tester körts.</div>
        ) : improvements.map((improvement) => (
          <div key={improvement.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <Pill tone={toneByStatus[improvement.status] || 'neutral'}>{improvement.status}</Pill>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{improvement.title}</div>
              <div style={{ fontSize: 12, ...mutedStyle, marginTop: 2, lineHeight: 1.5 }}>{improvement.why}</div>
              <div style={{ fontSize: 11, ...mutedStyle, marginTop: 2 }}>Evidens: {improvement.evidence}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PipelineSection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const autopilot = sourceData(sources, 'narrowAutopilot') || {};
  const hasAutopilotScheduler = Boolean(autopilot.scheduler && typeof autopilot.scheduler === 'object');
  const counts = np.summary?.sourceCounts || null;
  const scheduler = autopilot.scheduler || {};
  const notes = {
    batch: `${displayNumber(counts?.batch)} batch-rader i learning-datat`,
    replay: `${displayNumber(counts?.replay)} replay-rader i learning-datat`,
    paper: `${displayNumber(counts?.paper)} paper-rader i learning-datat`,
    recommendation: np.recommendedNextTest ? `Aktivt förslag: ${np.recommendedNextTest.title}` : 'Inget aktivt förslag',
    agents: scheduler.dryRunOnly ? 'Autopiloter i dry-run — planerar men exekverar inte' : null,
  };
  return (
    <div style={sectionStyle}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Så flödar kunskapen genom systemet</div>
      <div style={{ fontSize: 12.5, ...mutedStyle, marginBottom: 14 }}>
        Varje steg är paper/replay-only. Sista steget är alltid du — ingen förändring sker utan manuell granskning.
      </div>
      <div>
        {PIPELINE_STEPS.map((step, index) => (
          <div key={step.id} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: index === PIPELINE_STEPS.length - 1 ? 'rgba(34,197,94,0.16)' : 'var(--surface-2)',
                border: `1px solid ${index === PIPELINE_STEPS.length - 1 ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 800,
              }}
              >
                {index + 1}
              </div>
              {index < PIPELINE_STEPS.length - 1 ? <div style={{ width: 2, flex: 1, minHeight: 18, background: 'var(--border)' }} /> : null}
            </div>
            <div style={{ paddingBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{step.label}</div>
              <div style={{ fontSize: 12, ...mutedStyle, lineHeight: 1.5 }}>{step.desc}</div>
              {notes[step.id] ? <div style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 2 }}>{notes[step.id]}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BatchReplaySection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const supervisor = sourceData(sources, 'supervisor') || {};
  const summary = np.summary || {};
  const counts = summary.sourceCounts || null;
  const replayCount = numberOrNull(counts?.replay);
  const paperCount = numberOrNull(counts?.paper);
  const rankings = Array.isArray(np.rankings) ? np.rankings.slice(0, 8) : [];
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <StatCard label="Batch-rader" value={displayNumber(counts?.batch)} note="i learning-underlaget" />
        <StatCard label="Replay-rader" value={displayNumber(replayCount)} tone={replayCount === 0 ? 'warn' : 'neutral'} note={replayCount === 0 ? 'behöver fler replay-verifieringar' : ''} />
        <StatCard label="Paper-rader" value={displayNumber(paperCount)} tone={paperCount === 0 ? 'warn' : 'neutral'} note={paperCount === 0 ? 'paper-observation pågår' : ''} />
        <StatCard label="Dubbletter rensade" value={displayNumber(summary.duplicateBatchRowsSkipped)} note="skippade batch-rader" />
      </div>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Strategijämförelse (från batch/replay)</div>
        {rankings.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr>
                  {['Strategi', 'Tester', 'Vinst %', 'Snitt-PnL', 'Bedömning'].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)', ...mutedStyle }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((row) => (
                  <tr key={row.strategy_id || row.name}>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5, fontWeight: 600 }}>{aiStrategyLabel(row)}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>{row.trades ?? '–'}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>{fmtPct(row.winRate)}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>{row.avgPnl ?? '–'}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                      <Pill tone={row.verdict === 'promising' ? 'ok' : row.verdict === 'weak' ? 'bad' : 'neutral'}>{row.verdict || 'okänd'}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 13, ...mutedStyle }}>Inga rankningar ännu.</div>
        )}
        <div style={{ fontSize: 12, ...mutedStyle, marginTop: 10 }}>
          Vill du köra fler tester? Gå till <Link to="/lab" style={{ color: 'var(--accent)' }}>Lab</Link> — batch och replay startas alltid manuellt därifrån.
        </div>
        <TechDetails label="Tekniska detaljer (supervisor batch/replay-status)" data={{ batch: supervisor.batchSummary, replay: supervisor.replaySummary }} />
      </div>
    </>
  );
}

function RecommendationsSection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const autopilot = sourceData(sources, 'narrowAutopilot') || {};
  const supervisor = sourceData(sources, 'supervisor') || {};
  const rec = np.recommendedNextTest || autopilot.autopilot?.recommendedNextTest || null;
  const lastEvent = autopilot.autopilot?.lastEvent || null;
  const blockedReason = lastEvent && lastEvent.event === 'run_blocked'
    ? (Array.isArray(lastEvent.warnings) && lastEvent.warnings.length ? lastEvent.warnings.join(', ') : lastEvent.status)
    : null;
  const extraActions = Array.isArray(supervisor.nextRecommendedActions) ? supervisor.nextRecommendedActions.slice(0, 5) : [];
  return (
    <>
      <div style={sectionStyle}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Nästa rekommenderade test</div>
        {rec ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{rec.title || aiStrategyLabel(rec, '—')}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>{rec.reason || 'Ingen motivering angiven.'}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {rec.priority ? <Pill tone={rec.priority === 'high' ? 'warn' : 'neutral'}>prioritet: {rec.priority}</Pill> : null}
              {rec.source ? <Pill tone="info">källa: {rec.source}</Pill> : null}
              <Pill tone="info">dryRun=true</Pill>
              <Pill tone="info">executed=false</Pill>
            </div>
            {blockedReason ? (
              <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--warning)' }}>
                Senaste körförsök blockerades: {blockedReason}
              </div>
            ) : null}
            <div style={{ fontSize: 12, ...mutedStyle, marginTop: 10 }}>
              Förslaget exekveras inte automatiskt. Autopiloten planerar i dry-run; en körning startas endast manuellt från Lab.
            </div>
            <TechDetails data={rec} />
          </>
        ) : (
          <div style={{ fontSize: 13, ...mutedStyle }}>Ingen rekommendation just nu — den skapas när learning-datat räcker.</div>
        )}
      </div>
      {extraActions.length ? (
        <div style={sectionStyle}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Övriga föreslagna nästa steg (Supervisor)</div>
          {extraActions.map((action, index) => (
            <div key={index} style={{ fontSize: 12.5, padding: '7px 0', borderTop: index ? '1px solid var(--border)' : 'none', lineHeight: 1.5 }}>
              {typeof action === 'string' ? action : (action.title || action.message || action.label || JSON.stringify(action))}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function RisksSection({ sources }) {
  const np = sourceData(sources, 'narrowPerformance') || {};
  const supervisor = sourceData(sources, 'supervisor') || {};
  const autopilot = sourceData(sources, 'narrowAutopilot') || {};
  const summary = np.summary || {};
  const counts = summary.sourceCounts || null;
  const paperCount = numberOrNull(counts?.paper);
  const replayCount = numberOrNull(counts?.replay);
  const scheduler = autopilot.scheduler || {};

  const degradedSources = Object.entries(sources)
    .filter(([, entry]) => entry && !entry.ok)
    .map(([key, entry]) => `${key}: ${entry.error}`);
  ['aiRecommendations', 'learningStatus', 'batchAutopilotSummary', 'replayAutopilotSummary'].forEach((key) => {
    if (supervisor[key]?.status === 'degraded') degradedSources.push(`supervisor.${key}: degraded`);
  });

  const risks = [
    {
      title: 'Paper-data saknas i learning-underlaget',
      active: paperCount === 0,
      tone: 'warn',
      desc: 'Slutsatserna bygger än så länge på batch/replay. Paper-observationer stärker eller försvagar dem över tid.',
    },
    {
      title: 'Replay-verifiering saknas',
      active: replayCount === 0,
      tone: 'warn',
      desc: 'Batch-fynd är inte replay-verifierade ännu — kör replay innan slutsatser väger tungt.',
    },
    {
      title: 'Degraded datakällor',
      active: degradedSources.length > 0,
      tone: 'warn',
      desc: degradedSources.length ? degradedSources.join(' · ') : '',
    },
    {
      title: 'Osäkra strategier',
      active: Boolean(summary.worstStrategy),
      tone: 'neutral',
      desc: summary.worstStrategy ? `${aiStrategyLabel(summary.worstStrategy)} är svagast i jämförelsen (${fmtPct(summary.worstStrategy.winRate)} vinst).` : '',
    },
    {
      title: 'Autopilot-cooldown',
      active: Boolean(scheduler.cooldownMinutes),
      tone: 'neutral',
      desc: scheduler.cooldownMinutes ? `Planer skapas som tätast var ${scheduler.cooldownMinutes}:e minut, nästa ${fmtTime(scheduler.nextRunAt)}.` : '',
    },
    {
      title: 'Live trading är avstängt',
      active: true,
      tone: 'ok',
      desc: 'Medvetet och permanent i detta läge: inga riktiga order, ingen broker, ingen automatisk riskändring.',
    },
    {
      title: 'Broker är inaktiverad',
      active: true,
      tone: 'ok',
      desc: 'broker_enabled=false — ingen ordersubmit-väg är aktiv från AI-delarna.',
    },
  ].filter((risk) => risk.active);

  return (
    <div style={sectionStyle}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Risker och begränsningar</div>
      <div style={{ fontSize: 12.5, ...mutedStyle, marginBottom: 12 }}>
        Ärlig lista över vad som begränsar AI-slutsatserna just nu — och vilka skydd som är på med flit.
      </div>
      {risks.map((risk) => (
        <div key={risk.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
          <Pill tone={risk.tone}>{risk.tone === 'ok' ? 'skydd' : 'begränsning'}</Pill>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{risk.title}</div>
            {risk.desc ? <div style={{ fontSize: 12, ...mutedStyle, marginTop: 2, lineHeight: 1.5 }}>{risk.desc}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Sida ──────────────────────────────────────────────────────────────────────

export default function AiControlRoomPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const activeId = SECTIONS.some((s) => s.id === section) ? section : 'oversikt';
  const { loading, sources } = useAiData();
  const strategyStore = useMemo(() => {
    const supervisor = sourceData(sources, 'supervisor') || {};
    const allowlist = sourceData(sources, 'allowlist') || {};
    const learning = sourceData(sources, 'narrowPerformance') || {};
    return createStrategyStore({
      runtimeSnapshot: supervisor,
      strategyOverview: supervisor.strategyOverview || [],
      strategyStatus: supervisor.strategyStatus || [],
      strategyPulse: supervisor.strategyPulse || [],
      strategies: [
        ...(Array.isArray(allowlist.allowlist) ? allowlist.allowlist : []),
        ...(Array.isArray(learning.summary?.strategies) ? learning.summary.strategies : []),
        learning.summary?.bestStrategy,
        learning.summary?.worstStrategy,
      ].filter(Boolean),
    });
  }, [sources]);
  const tradingEventStore = useMemo(() => {
    const supervisor = sourceData(sources, 'supervisor') || {};
    const narrowPerformance = sourceData(sources, 'narrowPerformance') || {};
    const narrowAutopilot = sourceData(sources, 'narrowAutopilot') || {};
    return createTradingEventStore({
      supervisorSnapshot: supervisor,
      aiSources: sources,
      analyticsSnapshot: narrowPerformance,
      automationPlan: narrowAutopilot,
      strategyStore,
    });
  }, [sources, strategyStore]);
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    aiSources: sources,
  }), [sources, tradingEventStore]);
  const safetySource = ['allowlist', 'narrowAutopilot', 'narrowPerformance', 'supervisor']
    .map((key) => sourceData(sources, key))
    .find(Boolean) || {};
  const dashboardSafety = safetySource.safety && typeof safetySource.safety === 'object'
    ? { ...safetySource, ...safetySource.safety }
    : safetySource;
  const agents = buildAgents(sources);
  const activeAgents = agents.filter((agent) => ['ok', 'ready', 'dry-run'].includes(String(agent.status).toLowerCase())).length;
  const degradedAgents = agents.filter((agent) => ['degraded', 'no_data', 'unavailable', 'empty', 'av'].includes(String(agent.status).toLowerCase())).length;
  const learning = sourceData(sources, 'narrowPerformance') || {};
  const sourceCounts = learning.summary?.sourceCounts || null;
  const batchCount = numberOrNull(sourceCounts?.batch);
  const replayCount = numberOrNull(sourceCounts?.replay);
  const paperCount = numberOrNull(sourceCounts?.paper);
  const autopilot = sourceData(sources, 'narrowAutopilot') || {};
  const hasAutopilotScheduler = Boolean(autopilot.scheduler && typeof autopilot.scheduler === 'object');
  const learningBars = learning.summary?.sourceCounts
    ? [
        { label: 'Batch', value: batchCount, tone: 'purple' },
        { label: 'Replay', value: replayCount, tone: 'warning' },
        { label: 'Paper', value: paperCount, tone: 'good' },
      ]
    : [];
  const recommendedTest = learning.recommendedNextTest || autopilot.autopilot?.recommendedNextTest || null;
  const lastAutopilotEvent = autopilot.autopilot?.lastEvent || null;
  const aiActivity = [
    recommendedTest ? {
      id: 'recommended-test',
      title: recommendedTest.title || aiStrategyLabel(recommendedTest, 'Rekommenderat test'),
      meta: recommendedTest.reason || 'Ingen motivering angiven.',
      time: recommendedTest.createdAt ? fmtTime(recommendedTest.createdAt) : null,
      tone: 'blue',
    } : null,
    lastAutopilotEvent ? {
      id: 'autopilot-event',
      title: lastAutopilotEvent.event || lastAutopilotEvent.status || 'Autopilot-status',
      meta: Array.isArray(lastAutopilotEvent.warnings) && lastAutopilotEvent.warnings.length
        ? lastAutopilotEvent.warnings.join(', ')
        : (lastAutopilotEvent.message || 'Dry-run status uppdaterad.'),
      time: lastAutopilotEvent.timestamp ? fmtTime(lastAutopilotEvent.timestamp) : null,
      tone: lastAutopilotEvent.event === 'run_blocked' ? 'warning' : 'good',
    } : null,
  ].filter(Boolean);
  const kpis = [
    { label: 'AI-delar', value: agents.length, hint: `${activeAgents} aktiva`, tone: 'blue' },
    { label: 'Degraded / no data', value: degradedAgents, hint: 'Datakällor som behöver underlag', tone: degradedAgents ? 'warning' : 'good' },
    { label: 'Batch-rader', value: displayNumber(batchCount), hint: 'Learning-underlag', tone: 'neutral' },
    { label: 'Replay-rader', value: displayNumber(replayCount), hint: 'Learning-underlag', tone: replayCount === null ? 'neutral' : replayCount > 0 ? 'good' : 'warning' },
    { label: 'Paper-rader', value: displayNumber(paperCount), hint: 'Learning-underlag', tone: paperCount === null ? 'neutral' : paperCount > 0 ? 'good' : 'warning' },
    { label: 'Autopilot', value: hasAutopilotScheduler ? (autopilot.scheduler?.dryRunOnly ? 'Dry-run' : (autopilot.scheduler?.enabled ? 'Aktiv' : 'Paus')) : EMPTY_VALUE, hint: hasAutopilotScheduler ? 'Planerar men auto-applicerar inte' : EMPTY_VALUE, tone: hasAutopilotScheduler ? (autopilot.scheduler?.dryRunOnly ? 'good' : 'warning') : 'neutral' },
  ];

  const body = useMemo(() => {
    if (loading) return <div style={{ ...mutedStyle, padding: 20 }}>Hämtar AI-status…</div>;
    switch (activeId) {
      case 'learning': return <LearningSection sources={sources} />;
      case 'agents': return <AgentsSection sources={sources} />;
      case 'improvements': return <ImprovementsSection sources={sources} />;
      case 'pipeline': return <PipelineSection sources={sources} />;
      case 'batch-replay': return <BatchReplaySection sources={sources} />;
      case 'recommendations': return <RecommendationsSection sources={sources} />;
      case 'risks': return <RisksSection sources={sources} />;
      default: return <OverviewSection sources={sources} />;
    }
  }, [loading, sources, activeId]);

  return (
    <DashboardShell
      title="AI Control Room"
      subtitle="Analyserar, jämför, lär sig och föreslår i read-only-läge. Ingenting auto-appliceras."
      safety={dashboardSafety}
      tabs={SECTIONS}
      activeTab={activeId}
      onTab={(id) => navigate(SECTIONS.find((item) => item.id === id)?.path || '/ai')}
      kpis={kpis}
    >
      {activeId === 'oversikt' ? (
        <div className="dash-grid-2">
          <ChartCard title="Learning-underlag" subtitle="Verkliga rader per befintlig datakälla" tone="purple">
            <BarChart bars={learningBars} emptyText="Learning-underlag saknas ännu." />
          </ChartCard>
          <ChartCard title="Senaste AI-aktivitet" subtitle="Rekommendation och autopilot, read-only" tone="warning">
            <ActivityList items={aiActivity} emptyText="Ingen AI-aktivitet finns ännu." />
          </ChartCard>
        </div>
      ) : null}
      {activeId === 'oversikt' ? (
        <AiDecisionCenter
          sources={sources}
          strategyStore={strategyStore}
          eventStore={tradingEventStore}
          decisionStore={decisionStore}
          waiting={loading}
        />
      ) : null}
      {body}
    </DashboardShell>
  );
}
