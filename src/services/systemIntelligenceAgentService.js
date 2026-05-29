'use strict';

const redisService = require('./redisService');
const riskEngineService = require('./riskEngineService');
const exitEngineService = require('./exitEngineService');
const exitCalibrationService = require('./exitCalibrationService');
const executionSafetyService = require('./executionSafetyService');
const strategyLabService = require('./strategyLabService');
const agentReasoningService = require('./agentReasoningService');
const vectorMemoryService = require('./vectorMemoryService');
const notificationEngineV2 = require('../alerts/notificationEngineV2');
const paperTrading = require('../paperTrading/paperTradingAgent');
const { buildSystemHealth } = require('../systemHealth');
const llmAdapter = require('./llmAnalysisAdapter');

const SOURCE = 'system_intelligence_agent_v1';

const KEYS = Object.freeze({
  context: 'intelligence:context:latest',
  analysis: 'intelligence:analysis:latest',
  recommendations: 'intelligence:recommendations:latest',
  explainPrefix: 'intelligence:explain:',
});

const TTL = Object.freeze({
  context: 60,
  analysis: 300,
  recommendations: 300,
  explain: 300,
});

// In-memory fallback when Redis is unavailable
const memCache = new Map();

function nowIso() { return new Date().toISOString(); }
function round(n, d = 2) { const f = 10 ** d; return Math.round(Number(n) * f) / f; }

async function cacheGet(key) {
  try {
    const val = await redisService.getJson(key, null);
    if (val) return val;
  } catch (_) {}
  const entry = memCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

async function cacheSet(key, value, ttl) {
  try { await redisService.setJson(key, value, ttl); } catch (_) {}
  memCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

async function tryRead(label, fn, warnings) {
  try { return await fn(); } catch (err) {
    warnings.push(`${label}: ${err.message}`);
    return null;
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

async function buildSystemContext() {
  const cached = await cacheGet(KEYS.context);
  if (cached) return cached;

  const warnings = [];

  const [
    paperStatus,
    paperPerf,
    paperTrades,
    riskStatus,
    exitStatus,
    exitCalib,
    safetyStatus,
    agentAnalysis,
    memStatus,
    notifStatus,
    notifRecent,
    slConfig,
    slResults,
    slPresets,
    healthRaw,
  ] = await Promise.all([
    tryRead('paper.status',        () => paperTrading.getStatus(),                    warnings),
    tryRead('paper.performance',   () => paperTrading.getPerformance(),               warnings),
    tryRead('paper.trades',        () => paperTrading.getTrades(),                    warnings),
    tryRead('risk.status',         () => riskEngineService.getRiskStatus(),           warnings),
    tryRead('exit.status',         () => exitEngineService.getExitEngineStatus(),     warnings),
    tryRead('exit.calibration',    () => exitCalibrationService.getCalibration(),     warnings),
    tryRead('safety.status',       () => executionSafetyService.getSafetyStatus(),    warnings),
    tryRead('agent.analysis',      () => agentReasoningService.getLatestAnalysis(),   warnings),
    tryRead('memory.status',       () => vectorMemoryService.getMemoryStatus(),       warnings),
    tryRead('notif.status',        () => notificationEngineV2.getStatus(),            warnings),
    tryRead('notif.recent',        () => notificationEngineV2.getRecentAlerts(),      warnings),
    tryRead('strategy_lab.config', () => strategyLabService.getStrategyConfig(),      warnings),
    tryRead('strategy_lab.results',() => strategyLabService.getResults(),             warnings),
    tryRead('strategy_lab.presets',() => strategyLabService.listPresets(),            warnings),
    tryRead('health',              () => buildSystemHealth({}),                       warnings),
  ]);

  const redisStatus = redisService.status();

  // Paper trading summary
  const paper = paperStatus ? {
    enabled: paperStatus.enabled,
    open_count: paperStatus.openCount || 0,
    open_trades: (paperStatus.openTrades || []).map(t => ({
      symbol: t.symbol, subtype: t.subtype || t.signalSubtype,
      unrealized_pct: t.unrealizedPct, age_min: t.ageMin,
    })),
    win_rate: paperPerf?.win_rate ?? null,
    total_trades: paperPerf?.total ?? null,
    timeout_rate: paperPerf?.timeout_rate ?? null,
    avg_pl_pct: paperPerf?.avg_pl ?? null,
    recent_trade_count: (paperTrades?.trades || []).slice(0, 10).length,
  } : null;

  // Gate analysis from paper status if available
  const gate = paperStatus?.marketGroups ? {
    groups: paperStatus.marketGroups.map(g => ({ name: g.groupName, symbols: g.symbols })),
    compass: paperStatus.marketCompass || null,
  } : null;

  // Risk summary
  const risk = riskStatus ? {
    enabled: riskStatus.enabled,
    pause_trading: riskStatus.pause_trading,
    pause_reasons: riskStatus.pause_reasons || [],
    blocks_today_count: riskStatus.blocks_today_count || 0,
    config_min_confidence: riskStatus.config?.min_confidence ?? null,
    config_max_trades: riskStatus.config?.max_trades_per_day ?? null,
    config_risk_per_trade: riskStatus.config?.risk_per_trade_pct ?? null,
  } : null;

  // Exit summary
  const exit = exitStatus ? {
    enabled: exitStatus.enabled,
    mode: exitStatus.mode,
    config: exitStatus.config || {},
    calibration_available: !!exitCalib,
    timeout_rate_pct: exitCalib?.timeout_rate_pct ?? null,
    avg_hold_minutes: exitCalib?.avg_hold_minutes ?? null,
  } : null;

  // Safety summary
  const safety = safetyStatus ? {
    enabled: safetyStatus.enabled,
    kill_switch_active: safetyStatus.kill_switch_active || false,
    checks: safetyStatus.checks || {},
    overall_safe: safetyStatus.overall_safe ?? true,
  } : null;

  // Agent reasoning summary
  const agent = agentAnalysis ? {
    symbol: agentAnalysis.symbol,
    final_commentary: agentAnalysis.finalCommentary || agentAnalysis.final_commentary,
    blocking_risk: agentAnalysis.blockingRisk || agentAnalysis.isBlockingRisk,
    score: agentAnalysis.score,
    confidence: agentAnalysis.confidence,
    timestamp: agentAnalysis.timestamp,
  } : null;

  // Memory summary
  const memory = memStatus ? {
    provider: memStatus.provider || memStatus.PROVIDER,
    entry_count: memStatus.entry_count || memStatus.entryCount,
    redis_available: memStatus.redis_available ?? true,
  } : null;

  // Notification summary
  const notifications = notifStatus ? {
    enabled: notifStatus.enabled,
    dry_run: notifStatus.config?.dry_run,
    recent_count: Array.isArray(notifRecent?.alerts) ? notifRecent.alerts.length : 0,
    last_sent: notifRecent?.alerts?.[0]?.sentAt || null,
  } : null;

  // Strategy lab summary
  const strategy_lab = slConfig ? {
    active_preset: slConfig.active_preset,
    replay_mode: slConfig.replay_mode,
    paper_only: slConfig.paper_only,
    live_trading_enabled: false,
    preset_count: Array.isArray(slPresets) ? slPresets.length : 0,
    latest_run: slResults?.latest ? {
      id: slResults.latest.id,
      win_rate: slResults.latest.summary?.win_rate,
      total_trades: slResults.latest.summary?.total_trades,
      avg_pl_pct: slResults.latest.summary?.avg_pl_pct,
    } : null,
  } : null;

  // Health
  const health = healthRaw ? {
    ok: healthRaw.ok ?? true,
    issues: (healthRaw.issues || healthRaw.errors || []).slice(0, 5),
    warnings: (healthRaw.warnings || []).slice(0, 5),
  } : null;

  // System summary
  const system_summary = {
    redis: { ok: redisStatus.connected || redisStatus.mode === 'connected', mode: redisStatus.mode },
    paper_active: paper?.enabled ?? false,
    open_trades: paper?.open_count ?? 0,
    risk_paused: risk?.pause_trading ?? false,
    safety_ok: safety?.overall_safe ?? true,
    kill_switch: safety?.kill_switch_active ?? false,
    warning_count: warnings.length,
    live_trading_enabled: false,
    source: SOURCE,
  };

  const ctx = {
    ok: true,
    timestamp: nowIso(),
    system_summary,
    paper,
    gate,
    agent,
    memory,
    risk,
    exit,
    safety,
    replay: null,
    strategy_lab,
    notifications,
    health,
    warnings,
    source: SOURCE,
  };

  await cacheSet(KEYS.context, ctx, TTL.context);
  return ctx;
}

// ── Rule-based analysis engine ────────────────────────────────────────────────

function matchesQuestion(q, patterns) {
  const lower = q.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

const MODIFY_PATTERNS = [
  'ändra', 'sätt', 'aktivera', 'inaktivera', 'stäng av', 'slå på', 'öka', 'minska',
  'uppdatera config', 'uppdatera konfiguration', 'byt preset',
];

function isModifyRequest(q) {
  return matchesQuestion(q, MODIFY_PATTERNS);
}

function buildReadOnlyDenyResponse(question) {
  return buildResponse(question, {
    answer: 'Jag är en read-only agent och kan inte ändra systemet. Jag kan bara analysera och rekommendera.',
    findings: [
      'Agenten saknar skrivbehörighet.',
      'Konfigurationsändringar görs i respektive UI-sektion: Strategy Lab, Risk Engine, Exit Engine eller Execution Safety.',
    ],
    recommendations: [
      'Öppna Strategy Lab för att justera metoder och presets.',
      'Öppna Risk Engine-sidan för att justera riskregler.',
      'Öppna Exit Engine-sidan för att justera exitkonfiguration.',
    ],
    confidence: 100,
  });
}

function buildResponse(question, { answer, findings = [], recommendations = [], confidence = 70, engine = 'rule_based_v1' }) {
  return {
    ok: true,
    question,
    answer_sv: answer,
    key_findings: findings,
    recommendations,
    confidence,
    actions_allowed: false,
    can_modify_system: false,
    engine,
    source: SOURCE,
    timestamp: nowIso(),
  };
}

// ── Diagnosis functions ───────────────────────────────────────────────────────

async function diagnoseNoTrades() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 60;

  const paper = ctx.paper;
  const risk = ctx.risk;
  const safety = ctx.safety;

  if (!paper?.enabled) {
    findings.push('Paper trading är inaktiverat — inga trades kan öppnas.');
    recommendations.push('Starta paper trading på Paper Trading-sidan.');
    confidence = 95;
  }

  if (risk?.pause_trading) {
    findings.push(`Riskmotorn har pausat handel. Orsaker: ${(risk.pause_reasons || ['okänd']).join(', ')}.`);
    recommendations.push('Kontrollera Risk Engine-sidan och åtgärda blockeringsorsaken.');
    confidence = Math.max(confidence, 90);
  }

  if (safety?.kill_switch_active) {
    findings.push('Kill switch är aktiverad — all handel är blockerad.');
    recommendations.push('Inaktivera kill switch på Execution Safety-sidan om det är säkert.');
    confidence = 98;
  }

  if (risk?.config_min_confidence && risk.config_min_confidence > 75) {
    findings.push(`Min confidence är satt till ${risk.config_min_confidence} — detta är högt och kan blockera många signaler.`);
    recommendations.push('Sänk min_confidence i Risk Engine om signalkvaliteten är god.');
    confidence = Math.max(confidence, 75);
  }

  if (risk?.blocks_today_count > 0) {
    findings.push(`${risk.blocks_today_count} trades blockerades idag av riskmotorn.`);
    confidence = Math.max(confidence, 80);
  }

  if (!safety?.overall_safe) {
    findings.push('Execution Safety rapporterar att systemet inte är säkert för handel.');
    recommendations.push('Kontrollera Execution Safety för detaljer.');
    confidence = Math.max(confidence, 85);
  }

  if (findings.length === 0) {
    findings.push('Inga uppenbara blockeringsorsaker hittades.');
    findings.push('Möjliga orsaker: inga signaler uppfyller tröskelvärdena, marknadsdata saknas eller marknaden är stängd.');
    recommendations.push('Kontrollera Scanner-sidan för aktiva signaler.');
    recommendations.push('Verifiera att marknadsdata är uppdaterad.');
    confidence = 50;
  }

  return buildResponse('Varför öppnas inga trades?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function diagnoseTimeouts() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 65;

  const paper = ctx.paper;
  const exit = ctx.exit;
  const sl = ctx.strategy_lab;

  const timeoutRate = paper?.timeout_rate ?? sl?.latest_run?.timeout_rate ?? null;
  if (timeoutRate !== null) {
    findings.push(`Timeout-rate: ${round(timeoutRate)}%.`);
    if (timeoutRate > 60) {
      findings.push('Timeout-rate är hög (>60%). Prismålen nås sällan inom maxtid.');
      recommendations.push('Sänk exit-målet (max_target_pct) i Exit Engine eller Strategy Lab.');
      recommendations.push('Öka max_hold_minutes_default för att ge trades mer tid.');
      confidence = 85;
    } else if (timeoutRate > 40) {
      findings.push('Timeout-rate är måttlig (40-60%). Kan förbättras.');
      recommendations.push('Testa att minska trailing_distance_pct för snabbare exit.');
      confidence = 75;
    } else {
      findings.push('Timeout-rate är acceptabel (<40%).');
      confidence = 80;
    }
  }

  if (exit?.avg_hold_minutes) {
    findings.push(`Genomsnittlig hålltid: ${round(exit.avg_hold_minutes)} minuter.`);
    if (exit.config?.max_hold_minutes_default && exit.avg_hold_minutes >= exit.config.max_hold_minutes_default * 0.9) {
      findings.push('Trades hålls nära maxtiden — targets nås ofta inte i tid.');
      recommendations.push('Justera near_target_ratio för att ta profit tidigare nära målet.');
    }
  }

  if (sl?.latest_run) {
    const run = sl.latest_run;
    if (run.win_rate !== null) {
      findings.push(`Senaste Strategy Lab-körning: win rate ${round(run.win_rate)}%, ${run.total_trades} trades.`);
    }
  }

  if (findings.length === 0) {
    findings.push('Ingen timeout-data tillgänglig ännu.');
    recommendations.push('Kör ett Strategy Lab-test för att se timeout-analys.');
    confidence = 40;
  }

  return buildResponse('Varför blir det timeout?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function explainRiskBlocks() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 70;

  const risk = ctx.risk;

  if (!risk) {
    return buildResponse('Varför blockar riskmotorn?', {
      answer: 'Riskmotorn kunde inte nås just nu.', findings: ['Risk Engine svarar inte.'],
      recommendations: ['Kontrollera systemhälsan.'], confidence: 30,
    });
  }

  if (risk.pause_trading) {
    findings.push(`Handel är pausad. Orsaker: ${(risk.pause_reasons || ['okänd']).join(', ')}.`);
    confidence = 95;
  }

  if (risk.blocks_today_count > 0) {
    findings.push(`${risk.blocks_today_count} trades blockerades idag.`);
    confidence = Math.max(confidence, 85);
  }

  findings.push(`Min confidence: ${risk.config_min_confidence ?? 'okänd'}.`);
  findings.push(`Max trades/dag: ${risk.config_max_trades ?? 'okänd'}.`);
  findings.push(`Risk per trade: ${risk.config_risk_per_trade ?? 'okänd'}%.`);

  if (risk.config_min_confidence > 70) {
    recommendations.push('Min confidence verkar högt satt — sänk om signalkvaliteten är god.');
  }
  if (risk.config_max_trades && risk.blocks_today_count >= risk.config_max_trades) {
    recommendations.push('Dagsgränsen för trades kan ha nåtts — kontrollera i Risk Engine.');
  }

  return buildResponse('Varför blockar riskmotorn?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function recommendStrategyAdjustments() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 65;

  const sl = ctx.strategy_lab;
  const paper = ctx.paper;

  if (sl?.latest_run) {
    const run = sl.latest_run;
    findings.push(`Senaste Strategy Lab-körning: win rate ${round(run.win_rate ?? 0)}%, ${run.total_trades ?? 0} trades, avg P/L ${round(run.avg_pl_pct ?? 0)}%.`);

    if ((run.win_rate ?? 0) < 45) {
      recommendations.push('Win rate är låg — testa att öka min_confidence-tröskeln.');
      recommendations.push('Prova preset "crypto_conservative" eller "stocks_conservative" i Strategy Lab.');
      confidence = 78;
    } else if ((run.win_rate ?? 0) > 60) {
      findings.push('Win rate är god (>60%) — strategin verkar fungera bra.');
      recommendations.push('Optimera trailing_distance_pct för att fånga mer vinst per trade.');
      confidence = 85;
    }

    if ((run.avg_pl_pct ?? 0) < 0) {
      recommendations.push('Genomsnittlig P/L är negativ — sänk risk per trade och öka confidence-kravet.');
      confidence = Math.max(confidence, 82);
    }
  } else {
    findings.push('Ingen Strategy Lab-körning hittades.');
    recommendations.push('Kör ett test i Strategy Lab för att få personliga rekommendationer.');
    confidence = 40;
  }

  if (sl?.active_preset) {
    findings.push(`Aktivt preset: ${sl.active_preset}.`);
  }

  if (paper?.total_trades > 10) {
    findings.push(`${paper.total_trades} paper trades totalt, win rate ${round(paper.win_rate ?? 0)}%.`);
    if ((paper.timeout_rate ?? 0) > 60) {
      recommendations.push('Hög timeout-rate i paper trading — justera exit-targets neråt.');
    }
  }

  return buildResponse('Vilken strategi fungerar bäst?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function explainLatestDecision(symbol) {
  const cacheKey = `${KEYS.explainPrefix}${(symbol || 'ANY').toUpperCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const findings = [];
  const recommendations = [];
  let confidence = 60;

  const analysis = symbol
    ? await tryRead('agent.symbol', () => agentReasoningService.getAnalysisForSymbol(symbol), [])
    : await tryRead('agent.latest', () => agentReasoningService.getLatestAnalysis(), []);

  if (analysis) {
    const sym = analysis.symbol || symbol || 'okänd';
    findings.push(`Symbol: ${sym}.`);
    if (analysis.finalCommentary || analysis.final_commentary) {
      findings.push(analysis.finalCommentary || analysis.final_commentary);
    }
    if (analysis.blockingRisk || analysis.isBlockingRisk) {
      findings.push('AI-agenten identifierade en blockerande risk för denna signal.');
      recommendations.push('Granska AI-agentens riskanalys på Intelligens-sidan.');
    }
    if (analysis.score !== undefined) {
      findings.push(`Score: ${round(analysis.score)}, Confidence: ${round(analysis.confidence ?? 0)}.`);
    }
    confidence = 80;
  } else {
    findings.push(`Ingen agentanalys hittad för ${symbol || 'senaste signal'}.`);
    recommendations.push('Kontrollera att scanner kör och genererar signaler.');
    confidence = 35;
  }

  const result = buildResponse(`Förklara senaste beslut för ${symbol || 'signal'}`, { answer: buildAnswer(findings), findings, recommendations, confidence });
  await cacheSet(cacheKey, result, TTL.explain);
  return result;
}

async function explainExitPerformance() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 65;

  const exit = ctx.exit;

  if (!exit) {
    return buildResponse('Vad säger Exit Engine?', {
      answer: 'Exit Engine kunde inte nås just nu.',
      findings: ['Exit Engine svarar inte.'], recommendations: ['Kontrollera systemhälsan.'], confidence: 25,
    });
  }

  findings.push(`Exit Engine: ${exit.enabled ? 'aktiverad' : 'inaktiverad'}, mode: ${exit.mode || 'okänd'}.`);

  if (exit.timeout_rate_pct !== null) {
    findings.push(`Timeout-rate: ${round(exit.timeout_rate_pct)}%.`);
    if (exit.timeout_rate_pct > 60) {
      recommendations.push('Timeout-rate är hög — sänk max_target_pct eller öka max_hold_minutes_default.');
      confidence = 82;
    }
  }

  if (exit.avg_hold_minutes) {
    findings.push(`Genomsnittlig hålltid: ${round(exit.avg_hold_minutes)} min.`);
  }

  const cfg = exit.config;
  if (cfg) {
    if (cfg.trailing_distance_pct) findings.push(`Trailing stop: ${cfg.trailing_distance_pct}%.`);
    if (cfg.near_target_ratio) findings.push(`Near-target exit: ${cfg.near_target_ratio * 100}% av mål.`);
  }

  if (!exit.calibration_available) {
    recommendations.push('Ingen kalibrering hittad — kör exit-kalibrering för bättre data.');
  }

  return buildResponse('Vad säger Exit Engine?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function explainStrategyLabResults() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];
  let confidence = 60;

  const sl = ctx.strategy_lab;

  if (!sl) {
    return buildResponse('Vad säger Strategy Lab?', {
      answer: 'Strategy Lab data saknas.',
      findings: ['Strategy Lab kunde inte nås.'], recommendations: ['Öppna Strategy Lab-sidan.'], confidence: 20,
    });
  }

  findings.push(`Aktivt preset: ${sl.active_preset || 'okänt'}.`);
  findings.push(`${sl.preset_count} presets tillgängliga.`);

  if (sl.latest_run) {
    const run = sl.latest_run;
    findings.push(`Senaste körning: ${run.total_trades} trades, win rate ${round(run.win_rate ?? 0)}%, avg P/L ${round(run.avg_pl_pct ?? 0)}%.`);
    if ((run.win_rate ?? 0) > 55) {
      findings.push('Win rate är god för senaste körningen.');
      confidence = 82;
    } else {
      recommendations.push('Testa ett mer defensivt preset i Strategy Lab.');
      confidence = 72;
    }
  } else {
    findings.push('Ingen Strategy Lab-körning gjord ännu.');
    recommendations.push('Kör ett test i Strategy Lab.');
    confidence = 40;
  }

  return buildResponse('Vad säger Strategy Lab?', { answer: buildAnswer(findings), findings, recommendations, confidence });
}

async function summarizePipeline() {
  const ctx = await buildSystemContext();
  const findings = [];
  const recommendations = [];

  const s = ctx.system_summary;
  findings.push(`Redis: ${s.redis.ok ? 'ansluten' : 'fallback-läge'}.`);
  findings.push(`Paper trading: ${s.paper_active ? 'aktivt' : 'inaktivt'}, ${s.open_trades} öppna trades.`);
  findings.push(`Risk Engine: ${s.risk_paused ? 'PAUSAD' : 'aktiv'}.`);
  findings.push(`Safety: ${s.safety_ok ? 'OK' : 'VARNING'}, Kill switch: ${s.kill_switch ? 'aktiv' : 'inaktiv'}.`);
  findings.push(`Live trading: alltid inaktiverat (${SOURCE}).`);

  if (ctx.warnings.length) {
    findings.push(`${ctx.warnings.length} systemproblem rapporterade.`);
    recommendations.push('Granska system_summary.warnings för detaljer.');
  }

  return buildResponse('Sammanfatta systemet', { answer: buildAnswer(findings), findings, recommendations, confidence: 90 });
}

function buildAnswer(findings) {
  return findings.join(' ');
}

// ── Route analysis ────────────────────────────────────────────────────────────

async function analyzeSystem(question, options = {}) {
  const q = String(question || '').trim();
  if (!q) {
    return buildResponse('', { answer: 'Ange en fråga.', findings: [], recommendations: [], confidence: 0 });
  }

  // Safety: deny modification requests
  if (isModifyRequest(q)) {
    return buildReadOnlyDenyResponse(q);
  }

  // Try LLM first if enabled
  if (llmAdapter.isEnabled()) {
    try {
      const ctx = await buildSystemContext();
      const llmResult = await llmAdapter.analyze(q, ctx);
      if (llmResult.ok) return { ...llmResult, actions_allowed: false, can_modify_system: false };
    } catch (_) {}
  }

  // Rule-based routing
  if (matchesQuestion(q, ['inga trades', 'öppnas inte', 'öppnar inga', 'varför inga', 'inga signaler', 'inga order'])) {
    return diagnoseNoTrades();
  }
  if (matchesQuestion(q, ['timeout', 'time out', 'når inte målet', 'tid ut', 'hinner inte'])) {
    return diagnoseTimeouts();
  }
  if (matchesQuestion(q, ['risk', 'blockar', 'blockeras', 'riskmotorn', 'risk engine', 'blockar risken'])) {
    return explainRiskBlocks();
  }
  if (matchesQuestion(q, ['bäst', 'bästa strategi', 'vilken strategi', 'fungerar bäst', 'rekommendera strategi'])) {
    return recommendStrategyAdjustments();
  }
  if (matchesQuestion(q, ['justera', 'vad ska jag', 'nästa steg', 'förbättra', 'optimera', 'vad gör jag'])) {
    return recommendStrategyAdjustments();
  }
  if (matchesQuestion(q, ['säkert', 'säker', 'safety', 'kill switch', 'är systemet', 'systemstatus'])) {
    const ctx = await buildSystemContext();
    const s = ctx.system_summary;
    const findings = [
      `Safety: ${s.safety_ok ? 'OK' : 'PROBLEM DETEKTERAT'}.`,
      `Kill switch: ${s.kill_switch ? 'AKTIV — handel blockerad' : 'inaktiv'}.`,
      `Live trading: alltid inaktiverat av ${SOURCE}.`,
      `Risk Engine: ${s.risk_paused ? 'PAUSAD' : 'aktiv'}.`,
    ];
    const warnings = ctx.warnings;
    if (warnings.length) findings.push(`${warnings.length} service-varningar: ${warnings.slice(0, 2).join('; ')}.`);
    return buildResponse(q, {
      answer: buildAnswer(findings), findings,
      recommendations: s.safety_ok ? ['Systemet ser säkert ut.'] : ['Granska Execution Safety-sidan omedelbart.'],
      confidence: 90,
    });
  }
  if (matchesQuestion(q, ['exit', 'exitmotor', 'exit engine', 'vad säger exit'])) {
    return explainExitPerformance();
  }
  if (matchesQuestion(q, ['strategy lab', 'strategilabb', 'labb', 'preset'])) {
    return explainStrategyLabResults();
  }
  if (matchesQuestion(q, ['metod', 'stäng av metod', 'vilken metod', 'method'])) {
    const ctx = await buildSystemContext();
    const sl = ctx.strategy_lab;
    const findings = ['Metod-toggles styr vilka filter som används i Strategy Lab.'];
    const recommendations = [
      'Öppna Strategy Lab-sidan och justera toggles för varje metod.',
      'Stäng av EMA om signaler ofta blockeras av EMA-alignment.',
      'Prova att stänga av ema_filter och se om trades ökar.',
    ];
    if (sl?.active_preset) findings.push(`Aktivt preset: ${sl.active_preset}.`);
    return buildResponse(q, { answer: buildAnswer(findings), findings, recommendations, confidence: 70 });
  }
  if (matchesQuestion(q, ['symbol', 'vilken symbol', 'bästa symbol', 'fungerar'])) {
    const ctx = await buildSystemContext();
    const paper = ctx.paper;
    const findings = [];
    if (paper?.open_trades?.length) {
      findings.push(`Öppna trades: ${paper.open_trades.map(t => t.symbol).join(', ')}.`);
    } else {
      findings.push('Inga öppna trades för tillfället.');
    }
    findings.push('Symbolanalys finns på MachinePage under Intelligens.');
    return buildResponse(q, {
      answer: buildAnswer(findings), findings,
      recommendations: ['Se Intelligens-sidan för detaljerad symbolanalys.'], confidence: 65,
    });
  }
  if (matchesQuestion(q, ['sammanfatta', 'status', 'läget', 'systempipeline', 'pipeline'])) {
    return summarizePipeline();
  }

  // Fallback
  const ctx = await buildSystemContext();
  return buildResponse(q, {
    answer: 'Jag hittar ingen specifik diagnostik för den frågan. Här är en systemoversikt.',
    findings: [
      `Paper trading: ${ctx.paper?.enabled ? 'aktivt' : 'inaktivt'}, ${ctx.paper?.open_count ?? 0} öppna trades.`,
      `Risk Engine: ${ctx.risk?.pause_trading ? 'pausad' : 'aktiv'}.`,
      `Safety: ${ctx.system_summary.safety_ok ? 'OK' : 'VARNING'}.`,
    ],
    recommendations: [
      'Prova en av snabbknapparna för vanliga frågor.',
      'Se Strategy Lab för detaljerad prestandaanalys.',
    ],
    confidence: 45,
  });
}

// ── Recommendation engine ─────────────────────────────────────────────────────

async function getRecommendations() {
  const cached = await cacheGet(KEYS.recommendations);
  if (cached) return cached;

  const ctx = await buildSystemContext();
  const items = [];

  // Risk blocks
  if (ctx.risk?.pause_trading) {
    items.push({ priority: 'high', area: 'risk', message: `Riskmotorn är pausad: ${(ctx.risk.pause_reasons || []).join(', ')}.`, action: 'Kontrollera Risk Engine-sidan.' });
  }

  // Kill switch
  if (ctx.safety?.kill_switch_active) {
    items.push({ priority: 'high', area: 'safety', message: 'Kill switch är aktiv — all handel är blockerad.', action: 'Inaktivera kill switch på Execution Safety-sidan.' });
  }

  // Paper trading disabled
  if (ctx.paper && !ctx.paper.enabled) {
    items.push({ priority: 'medium', area: 'paper', message: 'Paper trading är inaktiverat.', action: 'Starta paper trading om du vill simulera trades.' });
  }

  // High timeout rate
  const timeoutRate = ctx.paper?.timeout_rate ?? ctx.strategy_lab?.latest_run?.timeout_rate ?? null;
  if (timeoutRate !== null && timeoutRate > 60) {
    items.push({ priority: 'medium', area: 'exit', message: `Hög timeout-rate: ${round(timeoutRate)}%.`, action: 'Sänk exit-målet i Exit Engine eller Strategy Lab.' });
  }

  // Low win rate
  const winRate = ctx.paper?.win_rate ?? ctx.strategy_lab?.latest_run?.win_rate ?? null;
  if (winRate !== null && winRate < 45) {
    items.push({ priority: 'medium', area: 'strategy', message: `Låg win rate: ${round(winRate)}%.`, action: 'Prova ett mer defensivt preset i Strategy Lab.' });
  }

  // Service warnings
  for (const w of (ctx.warnings || []).slice(0, 3)) {
    items.push({ priority: 'low', area: 'system', message: `Servicevarning: ${w}.`, action: 'Kontrollera systemhälsan.' });
  }

  if (items.length === 0) {
    items.push({ priority: 'info', area: 'system', message: 'Inga kritiska problem hittades.', action: 'Systemet verkar fungera normalt.' });
  }

  const result = {
    ok: true,
    timestamp: nowIso(),
    recommendations: items,
    actions_allowed: false,
    can_modify_system: false,
    source: SOURCE,
  };

  await cacheSet(KEYS.recommendations, result, TTL.recommendations);
  return result;
}

// ── Agent status ──────────────────────────────────────────────────────────────

function getAgentStatus() {
  return {
    ok: true,
    source: SOURCE,
    version: 'v1',
    mode: 'rule_based_v1',
    llm_enabled: llmAdapter.isEnabled(),
    llm_provider: llmAdapter.provider(),
    actions_allowed: false,
    can_modify_system: false,
    capabilities: [
      'buildSystemContext', 'analyzeSystem', 'summarizePipeline',
      'diagnoseNoTrades', 'diagnoseTimeouts', 'recommendStrategyAdjustments',
      'explainLatestDecision', 'explainRiskBlocks', 'explainExitPerformance',
      'explainStrategyLabResults', 'getAgentStatus',
    ],
    redis_keys: Object.values(KEYS),
    ttl: TTL,
    timestamp: nowIso(),
  };
}

module.exports = {
  KEYS,
  buildSystemContext,
  analyzeSystem,
  summarizePipeline,
  diagnoseNoTrades,
  diagnoseTimeouts,
  recommendStrategyAdjustments,
  explainLatestDecision,
  explainRiskBlocks,
  explainExitPerformance,
  explainStrategyLabResults,
  getRecommendations,
  getAgentStatus,
};
