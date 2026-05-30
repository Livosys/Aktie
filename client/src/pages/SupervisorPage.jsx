import React, { useEffect, useMemo, useState } from 'react';

const SAFETY_FLAGS = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const ENDPOINTS = [
  { key: 'status', url: '/api/status', label: 'Backend status' },
  { key: 'systemHealth', url: '/api/system/health', label: 'System health' },
  { key: 'safety', url: '/api/safety/status', label: 'Safety' },
  { key: 'pipelineStatus', url: '/api/pipeline/daily/status', label: 'Daily pipeline' },
  { key: 'dailyResults', url: '/api/results/daily-intelligence', label: 'Daily intelligence' },
  { key: 'priority', url: '/api/priority/summary', label: 'Priority summary' },
  { key: 'marketRegime', url: '/api/market-regime/status', label: 'Market regime' },
  { key: 'intelligenceStatus', url: '/api/intelligence/status', label: 'Intelligence status' },
  { key: 'intelligenceRecommendations', url: '/api/intelligence/recommendations', label: 'AI recommendations' },
  { key: 'learningSummary', url: '/api/learning/latest-summary', label: 'Learning summary' },
  { key: 'optimization', url: '/api/optimization/summary', label: 'Optimization summary' },
  { key: 'paperStatus', url: '/api/paper-trading/status', label: 'Paper trading status' },
  { key: 'paperPerformance', url: '/api/paper-trading/performance', label: 'Paper trading performance' },
  { key: 'replayLatest', url: '/api/replay/latest', label: 'Latest replay' },
  { key: 'candidates', url: '/api/candidates/recent?n=10', label: 'Recent candidates' },
];

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function toText(value, fallback = 'saknas') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return value ? 'ja' : 'nej';
  if (Array.isArray(value)) {
    const items = value.map((item) => toText(item, '')).filter(Boolean);
    return items.length ? items.join(' · ') : fallback;
  }
  if (isObject(value)) {
    return toText(
      value.label ??
      value.name ??
      value.title ??
      value.symbol ??
      value.message ??
      value.summary_sv ??
      value.summary ??
      value.conclusion_sv ??
      value.main_conclusion_sv ??
      value.note_sv ??
      value.text ??
      value.value,
      fallback,
    );
  }
  return fallback;
}

function deepPick(source, keys) {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function pickText(source, paths, fallback = 'saknas') {
  for (const path of paths) {
    const value = deepPick(source, path);
    if (value !== undefined && value !== null && value !== '') {
      const text = toText(value, '');
      if (text) return text;
    }
  }
  return fallback;
}

function ageText(iso) {
  if (!iso) return 'saknas';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'saknas';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'nyss';
  if (mins < 60) return `${mins} min sedan`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h sedan`;
  const days = Math.round(hours / 24);
  return `${days} d sedan`;
}

function formatDateTime(iso) {
  if (!iso) return 'saknas';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'saknas';
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function endpointState(entry) {
  if (!entry) return { label: 'saknas', tone: 'missing' };
  if (entry.missing) return { label: 'saknas', tone: 'missing' };
  if (entry.error) return { label: 'fel', tone: 'bad' };
  return { label: 'ok', tone: 'good' };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 404) {
      return { ok: false, missing: true, status: 404, url };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error || `API ${res.status}`,
        data,
        url,
      };
    }
    return { ok: true, status: res.status, data, url };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Nätverksfel',
      url,
    };
  }
}

function statusTone(ok, missing) {
  if (missing) return 'missing';
  return ok ? 'good' : 'bad';
}

function StatusPill({ label, value, tone = 'missing' }) {
  return (
    <div className={`sup-pill sup-pill-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoBlock({ title, value, note, tone = 'neutral' }) {
  return (
    <article className={`sup-block sup-block-${tone}`}>
      <span className="sup-block-title">{title}</span>
      <strong className="sup-block-value">{value}</strong>
      {note && <span className="sup-block-note">{note}</span>}
    </article>
  );
}

function summarizeSignal(item) {
  if (!item) return 'saknas';
  const pieces = [
    item.strategyName || item.strategy_name || item.strategy || '',
    item.signal || item.signalType || item.signalSubtype || '',
    item.marketGroup || item.market_group || '',
  ].filter(Boolean);
  if (pieces.length) return pieces.join(' · ');
  const positiveReasons = normalizeArray(item.reasons?.positive || item.reasons?.positives || item.reasons?.good || item.reasons);
  if (positiveReasons.length) return positiveReasons.slice(0, 2).map((reason) => toText(reason, '')).filter(Boolean).join(' · ');
  return pickText(item, [
    ['reason'],
    ['label'],
    ['summary'],
    ['conclusion_sv'],
    ['message'],
    ['marketContext', 'strategyLabel'],
    ['marketContext', 'strategyStrength'],
  ]);
}

function bestSummaryLine(resource) {
  if (!resource) return 'saknas';
  return pickText(resource, [
    ['ai_summary', 'main_conclusion_sv'],
    ['summary', 'main_conclusion_sv'],
    ['summary', 'summary_sv'],
    ['summary', 'conclusion_sv'],
    ['summary'],
    ['recommendation'],
    ['conclusion_sv'],
    ['note_sv'],
    ['text'],
    ['message'],
  ]);
}

function meaningfulText(value) {
  return value && value !== 'saknas' ? value : '';
}

function buildFallbackAiAnswer(question, view) {
  const q = String(question || '').toLowerCase();
  const top = view.topFocus[0];
  const avoid = view.avoid[0];
  const watch = view.watchlist[0];
  const learning = meaningfulText(view.learningText);
  const optimization = meaningfulText(view.optimizationText);
  const pipeline = meaningfulText(view.pipelineText);
  const safety = meaningfulText(view.safetyText);
  const regime = meaningfulText(view.regimeText);
  const topReason = top ? pickText(top, [
    ['reasonText'],
    ['reason'],
    ['summary'],
    ['marketContext', 'strategyLabel'],
    ['marketContext', 'strategyStrength'],
    ['marketContext', 'timeoutRisk'],
  ], 'Det finns ingen extra förklaring ännu.') : '';
  const avoidReason = avoid ? pickText(avoid, [
    ['reasonText'],
    ['reason'],
    ['summary'],
    ['marketContext', 'strategyStrength'],
    ['marketContext', 'timeoutRisk'],
  ], 'Den är markerad som svag eller mindre intressant just nu.') : '';

  if (q.includes('nvda') && q.includes('top focus') && top?.symbol === 'NVDA') {
    return `NVDA är top focus eftersom systemet just nu prioriterar den signalen. ${topReason}`.trim();
  }

  if (q.includes('bästa setup') || q.includes('bast setup') || q.includes('best setup')) {
    if (top) {
      return `Bästa setup just nu är att titta på ${top.symbol}. ${topReason || 'Den ligger högst i prioriteringen.'}`.trim();
    }
    if (watch) {
      return `Bästa setup just nu är att bevaka ${watch.symbol}. Systemet ser den som intressant men inte först i kön.`.trim();
    }
    return 'Jag ser ingen tydlig setup ännu. Vänta tills fler data kommer in.';
  }

  if (q.includes('undvika') || q.includes('avoid')) {
    if (avoid) {
      return `Undvik ${avoid.symbol}. ${avoidReason}`.trim();
    }
    return 'Jag ser ingen tydlig avoid-signal just nu.';
  }

  if (q.includes('lärde') || q.includes('larde') || q.includes('senaste dygnet') || q.includes('dygnet')) {
    return learning || 'Systemet har inte ett tydligt learning-svar ännu.';
  }

  if (q.includes('säker') || q.includes('saker')) {
    return `Ja. ${safety || 'Systemet är i testläge och ingen riktig order kan läggas.'}`.trim();
  }

  if (q.includes('regime') || q.includes('marknad')) {
    return regime || 'Marknadsregimen saknas just nu.';
  }

  if (q.includes('pipeline')) {
    return pipeline || 'Pipeline-status saknas just nu.';
  }

  if (q.includes('optimiz') || q.includes('optimer')) {
    return optimization || 'Optimeringsrekommendation saknas just nu.';
  }

  return [
    top ? `Top focus: ${top.symbol}.` : 'Top focus saknas.',
    watch ? `Watchlist: ${watch.symbol}.` : 'Watchlist saknas.',
    avoid ? `Avoid: ${avoid.symbol}.` : 'Avoid saknas.',
    learning ? `Lärande: ${learning}` : 'Lärande saknas.',
  ].join(' ');
}

function buildAssistantAnswer(question, view) {
  const normalized = String(question || '').trim();
  if (!normalized) return 'Skriv en fråga först.';

  const top = view.topFocus[0];
  const avoid = view.avoid[0];
  const regime = meaningfulText(view.regimeText);
  const learning = meaningfulText(view.learningText);
  const optimization = meaningfulText(view.optimizationText);
  const pipeline = meaningfulText(view.pipelineText);
  const safety = meaningfulText(view.safetyText);
  const topReason = top ? pickText(top, [
    ['reasonText'],
    ['reason'],
    ['summary'],
    ['marketContext', 'strategyLabel'],
    ['marketContext', 'strategyStrength'],
    ['marketContext', 'timeoutRisk'],
  ], 'Det är den signal som ligger högst i systemets prioritering.') : '';
  const avoidReason = avoid ? pickText(avoid, [
    ['reasonText'],
    ['reason'],
    ['summary'],
    ['marketContext', 'strategyStrength'],
    ['marketContext', 'timeoutRisk'],
  ], 'Den är markerad som svag i dagens läge.') : '';

  if (top && /nvda/i.test(normalized) && /top focus/i.test(normalized)) {
    return `NVDA är top focus just nu. ${topReason}`.trim();
  }

  if ((/bästa setup/i.test(normalized) || /best setup/i.test(normalized)) && top) {
    return `Bästa setup just nu är ${top.symbol}. ${topReason}`.trim();
  }

  if ((/undvika/i.test(normalized) || /avoid/i.test(normalized)) && avoid) {
    return `Du bör undvika ${avoid.symbol}. ${avoidReason}`.trim();
  }

  if ((/lärde|larde|senaste dygnet|dygnet/i).test(normalized) && learning) {
    return learning;
  }

  if ((/säker|saker/i).test(normalized)) {
    return safety || 'Systemet är i testläge och ingen riktig order kan läggas.';
  }

  if (/regime|marknad/i.test(normalized) && regime) {
    return regime;
  }

  if (/pipeline/i.test(normalized) && pipeline) {
    return pipeline;
  }

  if (/optimiz|optimer/i.test(normalized) && optimization) {
    return optimization;
  }

  return buildFallbackAiAnswer(normalized, view);
}

export default function SupervisorPage() {
  const [resources, setResources] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerSource, setAnswerSource] = useState('fallback');
  const [askLoading, setAskLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      const entries = await Promise.all(
        ENDPOINTS.map(async (spec) => [spec.key, await fetchJson(spec.url)]),
      );
      if (cancelled) return;
      setResources(Object.fromEntries(entries));
      setLastUpdated(new Date().toISOString());
      setLoading(false);
      setRefreshing(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    const entries = await Promise.all(
      ENDPOINTS.map(async (spec) => [spec.key, await fetchJson(spec.url)]),
    );
    setResources(Object.fromEntries(entries));
    setLastUpdated(new Date().toISOString());
    setRefreshing(false);
  }

  const view = useMemo(() => {
    const status = resources.status?.data || null;
    const health = resources.systemHealth?.data || null;
    const safety = resources.safety?.data || null;
    const pipelineStatus = resources.pipelineStatus?.data || null;
    const dailyResults = resources.dailyResults?.data || null;
    const priority = resources.priority?.data || null;
    const regime = resources.marketRegime?.data || null;
    const intelligence = resources.intelligenceRecommendations?.data || null;
    const intelligenceStatus = resources.intelligenceStatus?.data || null;
    const learning = resources.learningSummary?.data || null;
    const optimization = resources.optimization?.data || null;
    const paperStatus = resources.paperStatus?.data || null;
    const paperPerformance = resources.paperPerformance?.data || null;
    const replayLatest = resources.replayLatest?.data || null;
    const candidates = resources.candidates?.data || null;

    const topFocus = normalizeArray(priority?.topFocus || priority?.signals || []);
    const watchlist = normalizeArray(priority?.watchlist || []);
    const avoid = normalizeArray(priority?.avoid || []);
    const candidateRows = normalizeArray(candidates?.candidates || candidates?.entries || candidates?.signals || []);
    const replayRows = normalizeArray(replayLatest?.entries || []);
    const pipelineLatest = dailyResults || pipelineStatus || null;
    const latestSignal = topFocus[0] || candidateRows[0] || replayRows[0] || null;
    const latestScan = pickText(status, [
      ['lastScan'],
      ['last_scan_at'],
      ['lastScanAt'],
      ['scan', 'lastScan'],
      ['generatedAt'],
    ]);
    const latestAiSummary = [
      bestSummaryLine(dailyResults),
      bestSummaryLine(intelligence),
      bestSummaryLine(learning),
    ].find((item) => item && item !== 'saknas') || 'saknas';
    const pipelineText = [
      pickText(pipelineLatest, [
        ['pipeline_status'],
        ['status'],
        ['latest', 'pipeline_status'],
      ], ''),
      bestSummaryLine(pipelineLatest),
      bestSummaryLine(dailyResults?.ai_summary),
    ].filter((item) => item && item !== 'saknas').join(' · ') || 'saknas';
    const paperText = [
      resources.paperStatus?.missing ? '' : paperStatus?.enabled ? 'På' : 'Av',
      bestSummaryLine(paperPerformance),
    ].filter((item) => item && item !== 'saknas').join(' · ') || 'saknas';
    const optimizationText = [
      pickText(optimization, [['dataAdequacySv'], ['note_sv']], ''),
      normalizeArray(optimization?.recommendations || []).map((item) => toText(item, '')).filter(Boolean)[0] || '',
    ].filter(Boolean).join(' · ') || 'saknas';
    const learningText = bestSummaryLine(learning) || 'saknas';
    const safetyText = [
      pickText(safety, [
        ['summarySv'],
        ['status'],
        ['mode'],
      ], ''),
      pickText(health, [
        ['summarySv'],
        ['overallStatus'],
      ], ''),
    ].filter(Boolean).join(' · ') || 'Systemet är i testläge och ingen riktig order kan läggas.';
    const regimeText = [
      pickText(regime, [['regimeLabelSv'], ['regime'], ['volatilityLabelSv']], ''),
      pickText(regime, [['riskEnvLabelSv'], ['trendLabelSv']], ''),
    ].filter(Boolean).join(' · ') || 'saknas';
    const actionItems = [];
    if (!resources.status?.data && !resources.systemHealth?.data) {
      actionItems.push('Data saknas');
    }
    if (latestSignal) {
      actionItems.push(`Titta på denna signal: ${latestSignal.symbol || latestSignal.name || 'okänd'}`);
    } else {
      actionItems.push('Vänta');
    }
    actionItems.push('Systemet är i testläge');
    actionItems.push('Kör replay/pipeline om du vill uppdatera analysen');

    return {
      status,
      health,
      safety,
      pipelineStatus,
      dailyResults,
      priority,
      regime,
      intelligence,
      intelligenceStatus,
      learning,
      optimization,
      paperStatus,
      paperPerformance,
      replayLatest,
      candidates,
      topFocus,
      watchlist,
      avoid,
      candidateRows,
      replayRows,
      latestSignal,
      latestScan,
      latestAiSummary,
      pipelineText,
      paperText,
      optimizationText,
      learningText,
      safetyText,
      regimeText,
      actionItems,
      backendOk: !!(status?.ok || health?.ok),
      scannerActive: Boolean(
        status?.running ||
        status?.scannerActive ||
        deepPick(health, ['components'])?.some?.((component) => component?.status === 'ON' || component?.status === 'OK' || component?.status === 'RUNNING') ||
        deepPick(status, ['scanner'])?.running,
      ),
      paperEnabled: paperStatus?.enabled === true,
      dailyPipelineActive: Boolean(pipelineStatus?.daily_pipeline_running || pipelineStatus?.scheduler_active || pipelineStatus?.running),
      safetyActive: safety?.enabled !== false,
      safetySafe: safety?.overall_safe !== false && safety?.kill_switch_active !== true,
      systemMode: resources.paperStatus?.missing ? 'saknas' : paperStatus?.enabled ? 'På' : 'Av',
    };
  }, [resources]);

  async function askAi(nextQuestion = question) {
    const prompt = String(nextQuestion || '').trim();
    if (!prompt || askLoading) return;

    setQuestion(prompt);
    setAskLoading(true);
    setAnswer('');
    setAnswerSource('fallback');

    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          question: prompt,
          page: 'supervisor',
        }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && json?.answer) {
        setAnswer(json.answer);
        setAnswerSource('api');
        return;
      }
      setAnswer(buildAssistantAnswer(prompt, view));
      setAnswerSource('fallback');
    } catch (_) {
      setAnswer(buildAssistantAnswer(prompt, view));
      setAnswerSource('fallback');
    } finally {
      setAskLoading(false);
    }
  }

  const endpointRows = useMemo(() => ENDPOINTS.map((spec) => {
    const entry = resources[spec.key];
    const state = endpointState(entry);
    return {
      ...spec,
      state,
      ok: !!entry?.ok,
      missing: !!entry?.missing,
      error: entry?.error || '',
      last: entry?.data || null,
    };
  }), [resources]);

  const aiExamples = [
    'Varför är NVDA top focus?',
    'Vad är bästa setup just nu?',
    'Varför ska jag undvika denna signal?',
    'Vad lärde sig systemet senaste dygnet?',
    'Är systemet säkert just nu?',
  ];

  const canRenderCore = !loading;

  return (
    <div className="sup-page">
      <div className="sup-hero">
        <div className="sup-hero-copy">
          <div className="sup-kicker">Kör bilen</div>
          <h1>Trading OS Supervisor</h1>
          <p>
            En enkel huvudvy som visar vad systemet gör, vad som är viktigast och vad du kan göra härnäst.
          </p>
          <div className="sup-safety-copy">
            Systemet analyserar och paper-tradar. Ingen riktig order kan läggas.
          </div>
        </div>
        <div className="sup-hero-actions">
          <button type="button" className="btn sup-refresh" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Uppdaterar...' : 'Uppdatera'}
          </button>
          <div className="sup-last-updated">Senast uppdaterad: {formatDateTime(lastUpdated)}</div>
        </div>
      </div>

      <section className="sup-section">
        <div className="sup-section-head">
          <div>
            <h2>Systemläge</h2>
            <p>Snabb översikt över om backend, scanner, paper trading, pipeline och safety är tillgängliga.</p>
          </div>
        </div>

        <div className="sup-pill-grid">
          <StatusPill label="Backend OK?" value={resources.status?.missing && resources.systemHealth?.missing ? 'saknas' : view.backendOk ? 'Ja' : 'Nej'} tone={statusTone(view.backendOk, resources.status?.missing && resources.systemHealth?.missing)} />
          <StatusPill label="Scanner aktiv?" value={resources.status?.missing ? 'saknas' : view.scannerActive ? 'Ja' : 'Nej'} tone={statusTone(view.scannerActive, resources.status?.missing)} />
          <StatusPill label="Paper trading" value={resources.paperStatus?.missing ? 'saknas' : view.paperEnabled ? 'På' : 'Av'} tone={statusTone(view.paperEnabled, resources.paperStatus?.missing)} />
          <StatusPill label="Daily pipeline" value={resources.pipelineStatus?.missing ? 'saknas' : view.dailyPipelineActive ? 'Aktiv' : 'Av'} tone={statusTone(view.dailyPipelineActive, resources.pipelineStatus?.missing)} />
          <StatusPill label="Safety" value={resources.safety?.missing ? 'saknas' : view.safetyActive ? 'Aktiv' : 'Av'} tone={statusTone(view.safetyActive && view.safetySafe, resources.safety?.missing)} />
        </div>

        <div className="sup-grid sup-grid-5">
          <InfoBlock title="actions_allowed" value="false" note="Låst i UI" tone="danger" />
          <InfoBlock title="can_place_orders" value="false" note="Låst i UI" tone="danger" />
          <InfoBlock title="live_trading_enabled" value="false" note="Låst i UI" tone="danger" />
          <InfoBlock title="Systemläge" value={view.systemMode} note="Paper only" tone="ok" />
          <InfoBlock title="Senaste scan" value={view.latestScan || 'saknas'} note={ageText(view.latestScan)} tone="neutral" />
        </div>
      </section>

      <div className="sup-grid sup-grid-2">
        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Vad händer nu?</h2>
              <p>Det här är det senaste som systemet ser just nu.</p>
            </div>
          </div>

          <div className="sup-stack">
            <InfoBlock
              title="Senaste signal"
              value={view.latestSignal ? (view.latestSignal.symbol || 'signal') : 'saknas'}
              note={view.latestSignal ? summarizeSignal(view.latestSignal) : 'Ingen signal hittades'}
              tone={view.latestSignal ? 'ok' : 'neutral'}
            />
            <InfoBlock
              title="Senaste AI summary"
              value={view.latestAiSummary || 'saknas'}
              note={view.dailyResults?.ai_summary?.main_conclusion_sv || view.intelligence?.answer || 'Ingen AI-sammanfattning ännu'}
              tone={view.latestAiSummary && view.latestAiSummary !== 'saknas' ? 'ok' : 'neutral'}
            />
            <InfoBlock
              title="Senaste pipeline-resultat"
              value={view.pipelineText}
              note={pickText(view.pipelineStatus, [['last_run_at'], ['next_run_at']], 'saknas')}
              tone="neutral"
            />
            <InfoBlock
              title="Senaste paper-resultat"
              value={view.paperText}
              note={pickText(view.paperPerformance, [['conclusion_sv'], ['latest_trade', 'symbol']], 'saknas')}
              tone="neutral"
            />
          </div>
        </section>

        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Vad är viktigast?</h2>
              <p>Det som bör få mest uppmärksamhet just nu.</p>
            </div>
          </div>

          <div className="sup-focus-box">
            <div className="sup-focus-title">Top Focus</div>
            {view.topFocus.length ? (
              view.topFocus.slice(0, 3).map((item, index) => (
                <div key={`${item.symbol || index}-${index}`} className="sup-focus-item">
                  <strong>{item.symbol || item.name || 'okänd'}</strong>
                  <span>{summarizeSignal(item)}</span>
                  <small>{pickText(item, [['reasonText'], ['reason'], ['summary'], ['score']], 'saknas')}</small>
                </div>
              ))
            ) : (
              <div className="sup-empty">saknas</div>
            )}
          </div>

          <div className="sup-columns">
            <div>
              <h3>Watchlist</h3>
              <div className="sup-chip-row">
                {view.watchlist.length ? view.watchlist.slice(0, 6).map((item, index) => (
                  <span key={`${item.symbol || index}-watch`} className="sup-chip sup-chip-blue">
                    {item.symbol || item.name || 'okänd'}
                  </span>
                )) : <span className="sup-muted">saknas</span>}
              </div>
            </div>
            <div>
              <h3>Avoid</h3>
              <div className="sup-chip-row">
                {view.avoid.length ? view.avoid.slice(0, 6).map((item, index) => (
                  <span key={`${item.symbol || index}-avoid`} className="sup-chip sup-chip-red">
                    {item.symbol || item.name || 'okänd'}
                  </span>
                )) : <span className="sup-muted">saknas</span>}
              </div>
            </div>
            <div>
              <h3>Market regime</h3>
              <div className="sup-regime">
                <strong>{pickText(view.regime, [['regimeLabelSv'], ['regime']], 'saknas')}</strong>
                <span>{pickText(view.regime, [['volatilityLabelSv'], ['trendLabelSv']], 'saknas')}</span>
                <small>{pickText(view.regime, [['riskEnvLabelSv'], ['computedAt'], ['computed_at']], 'saknas')}</small>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="sup-grid sup-grid-2">
        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Vad rekommenderar systemet?</h2>
              <p>En enkel tolkning av AI, optimering, lärande och risk.</p>
            </div>
          </div>

          <div className="sup-stack">
            <InfoBlock title="AI Summary" value={view.latestAiSummary || 'saknas'} note="Kort sammanfattning av läget" tone="ok" />
            <InfoBlock title="Optimization recommendation" value={view.optimizationText} note="Förbättringar eller förslag från optimeringen" tone="neutral" />
            <InfoBlock title="Learning summary" value={view.learningText} note="Vad systemet lärde sig nyligen" tone="neutral" />
            <InfoBlock
              title="Risk/status"
              value={view.safetyText}
              note="Safety och systemhälsa"
              tone={!resources.safety?.missing && view.safetySafe ? 'ok' : resources.safety?.missing ? 'neutral' : 'danger'}
            />
          </div>
        </section>

        <section className="sup-section">
          <div className="sup-section-head">
            <div>
              <h2>Vad ska användaren göra?</h2>
              <p>Tydliga nästa steg i enkel svenska.</p>
            </div>
          </div>

          <div className="sup-next-grid">
            {view.actionItems.slice(0, 4).map((item, index) => (
              <div key={`${item}-${index}`} className="sup-next-item">
                <span className="sup-next-index">{index + 1}</span>
                <strong>{item.includes('Titta på denna signal') ? 'Titta på denna signal' : item}</strong>
                <p>
                  {index === 0 && !view.latestSignal ? 'Systemet har ingen tydlig signal just nu.' : ''}
                  {index === 0 && view.latestSignal ? 'Följ den signal som ligger högst i prioriteringen.' : ''}
                  {index === 1 ? 'Det här är ett testläge, inte live trading.' : ''}
                  {index === 2 ? 'Ingen riktig order kan läggas från denna sida.' : ''}
                  {index === 3 ? 'Kör en ny replay eller pipeline om du vill fräscha upp analysen.' : ''}
                </p>
              </div>
            ))}
          </div>

          <div className="sup-note">Systemet visar status. Det finns inga köp-, sälj- eller execution-knappar här.</div>
        </section>
      </div>

      <section className="sup-section sup-ask-section">
        <div className="sup-section-head">
          <div>
            <h2>Ask AI</h2>
            <p>Ställ en fråga i enkel svenska. Om AI-svaret inte finns använder sidan en säker fallback-sammanfattning.</p>
          </div>
          <div className={`sup-ask-badge sup-ask-${answerSource === 'api' ? 'api' : 'fallback'}`}>
            {answerSource === 'api' ? 'AI-svar' : 'Fallback'}
          </div>
        </div>

        <div className="sup-ai-examples">
          {aiExamples.map((example) => (
            <button key={example} type="button" className="sup-example-btn" onClick={() => askAi(example)} disabled={askLoading}>
              {example}
            </button>
          ))}
        </div>

        <label className="sup-ai-label" htmlFor="supervisor-question">Fråga systemet</label>
        <textarea
          id="supervisor-question"
          className="sup-ai-input"
          rows={4}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Exempel: Varför är NVDA top focus?"
        />

        <div className="sup-ai-actions">
          <button type="button" className="btn sup-ai-submit" onClick={() => askAi()} disabled={askLoading || !question.trim()}>
            {askLoading ? 'Tänker...' : 'Skicka fråga'}
          </button>
        </div>

        {answer && (
          <div className="sup-ai-answer">
            {answer}
          </div>
        )}

        <div className="sup-ai-foot">
          AI-vyn är read-only. Den kan bara läsa status och sammanfatta data.
        </div>
      </section>

      <details className="sup-advanced">
        <summary>Detaljer</summary>
        <div className="sup-advanced-grid">
          {endpointRows.map((row) => (
            <div key={row.key} className="sup-advanced-row">
              <strong>{row.label}</strong>
              <span>{row.url}</span>
              <em>{row.state.label}</em>
            </div>
          ))}
        </div>
        <pre className="sup-json">{JSON.stringify({
          safety_flags: SAFETY_FLAGS,
          backend_ok: view.backendOk,
          scanner_active: view.scannerActive,
          paper_enabled: view.paperEnabled,
          daily_pipeline_active: view.dailyPipelineActive,
          latest_scan: view.latestScan,
          latest_signal: view.latestSignal?.symbol || null,
          top_focus_count: view.topFocus.length,
          watchlist_count: view.watchlist.length,
          avoid_count: view.avoid.length,
          pipeline_status: view.pipelineStatus?.data?.pipeline_status || view.pipelineStatus?.data?.status || 'saknas',
          paper_status: view.paperStatus?.data?.enabled ?? 'saknas',
          intelligence_status: view.intelligenceStatus?.data?.ok ?? 'saknas',
          last_updated: lastUpdated,
        }, null, 2)}</pre>
      </details>

      {!canRenderCore && (
        <div className="sup-loading">Laddar Supervisor...</div>
      )}

      {error && <div className="sup-error">{error}</div>}
    </div>
  );
}
