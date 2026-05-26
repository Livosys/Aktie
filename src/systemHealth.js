'use strict';

const fs = require('fs');
const path = require('path');

const { getLatestResults, getScanStatus, getGroups, getStockFeedStatus } = require('./scanner/scheduler');
const { getCryptoResults, getCryptoStatus, getCryptoFeedStatus } = require('./scanner/cryptoScheduler');
const { loadLearningSummary } = require('./scanner/learningEngine');
const { loadRuleMemory } = require('./scanner/ruleMemoryEngine');
const { loadSymbolProfiles } = require('./scanner/symbolPersonalityEngine');
const { loadRegimeProfiles } = require('./scanner/regimeProfileEngine');
const { loadScoreCalibration } = require('./scanner/scoreCalibrationEngine');
const { loadPersonality } = require('./scanner/marketPersonalityEngine');
const { loadMomentumBacktest } = require('./history/momentumBacktestAnalyzer');
const { getStatus: getAutoMachineStatus, isRunning: autoMachineRunning } = require('./jobs/autoMachine');
const { buildProviderStatus, providerErrorSv } = require('./providerStatus');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SIGNALS = path.join(DATA, 'signals');

function minutesSince(isoOrMs) {
  if (!isoOrMs) return null;
  const ms = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}

function isoFromMs(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function statFile(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const st = fs.statSync(fp);
    return { path: fp, mtimeMs: st.mtimeMs, mtime: isoFromMs(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}

function latestFile(dir, filter = () => true) {
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter(filter)
      .map((f) => statFile(path.join(dir, f)))
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0] || null;
  } catch {
    return null;
  }
}

function latestNestedFile(dir, filter = () => true) {
  const found = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory()) walk(fp);
      else if (filter(name, fp)) found.push({ path: fp, mtimeMs: st.mtimeMs, mtime: isoFromMs(st.mtimeMs), size: st.size });
    }
  }
  try { walk(dir); } catch { return null; }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function component({ name, area, status, lastUpdated = null, messageSv, severity, details = null, suggestedActionSv = null }) {
  const ageMinutes = minutesSince(lastUpdated);
  return {
    name,
    area,
    status,
    lastUpdated,
    ageMinutes,
    messageSv,
    severity: severity || (status === 'ON' ? 'ok' : status === 'STALE' ? 'warning' : status === 'DISABLED' ? 'warning' : 'critical'),
    details,
    suggestedActionSv,
  };
}

function fileComponent(name, relPath, staleMinutes = 24 * 60, area = 'Data Files') {
  const fp = path.join(ROOT, relPath);
  const st = statFile(fp);
  if (!st) {
    return component({
      name, area, status: 'BROKEN',
      messageSv: `${name} saknas.`,
      suggestedActionSv: 'Kör Machine för att återskapa filen.',
    });
  }
  const age = minutesSince(st.mtimeMs);
  const stale = age !== null && age > staleMinutes;
  return component({
    name, area, status: stale ? 'STALE' : 'ON',
    lastUpdated: st.mtime,
    messageSv: stale ? `${name} finns men är ${age} minuter gammal.` : `${name} finns och är uppdaterad.`,
    severity: stale ? 'warning' : 'ok',
    details: { path: relPath, size: st.size },
    suggestedActionSv: stale ? 'Kör Machine för att uppdatera learning/data.' : null,
  });
}

function latestDirComponent(name, relDir, staleMinutes, area, filter = (f) => f.endsWith('.jsonl'), nested = false) {
  const dir = path.join(ROOT, relDir);
  const st = nested ? latestNestedFile(dir, filter) : latestFile(dir, filter);
  if (!st) {
    return component({
      name, area, status: 'BROKEN',
      messageSv: `${name} saknar filer.`,
      suggestedActionSv: 'Kör Machine/backfill för att skapa data.',
    });
  }
  const age = minutesSince(st.mtimeMs);
  const stale = age !== null && age > staleMinutes;
  return component({
    name, area, status: stale ? 'STALE' : 'ON',
    lastUpdated: st.mtime,
    messageSv: stale ? `${name} senaste fil är ${age} minuter gammal.` : `${name} har färska filer.`,
    severity: stale ? 'warning' : 'ok',
    details: { path: path.relative(ROOT, st.path), size: st.size },
    suggestedActionSv: stale ? 'Kör Machine eller vänta på nästa schemalagda körning.' : null,
  });
}

function runtimeComponents() {
  const scanStatus = getScanStatus();
  const cryptoStatus = getCryptoStatus();
  const mem = process.memoryUsage();
  return [
    component({
      name: 'Node process',
      area: 'Runtime',
      status: 'ON',
      lastUpdated: new Date().toISOString(),
      messageSv: 'Node-processen svarar.',
      severity: 'ok',
      details: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        pm2: process.env.pm_id != null ? { id: process.env.pm_id, name: process.env.name || process.env.pm_exec_path } : null,
      },
    }),
    scannerComponent('Stock scanner', 'Scanner', scanStatus, getLatestResults().filter((r) => (getGroups().stocks || []).includes(r.symbol)), 3),
    scannerComponent('Crypto scanner', 'Scanner', cryptoStatus, getCryptoResults(), 3),
  ];
}

function providerComponents() {
  const providers = buildProviderStatus();
  const stockFeed = getStockFeedStatus();
  const cryptoFeed = getCryptoFeedStatus();

  return [
    providerComponent(providers.alpaca, stockFeed),
    providerComponent(providers.binance, cryptoFeed),
  ];
}

function providerComponent(provider, feed) {
  if (!provider) {
    return component({
      name: 'Provider status',
      area: 'Providers',
      status: 'BROKEN',
      messageSv: 'Providerstatus saknas.',
      suggestedActionSv: 'Kontrollera provider-konfigurationen.',
    });
  }

  const disabled = !provider.enabled || !provider.configured;
  const stale = feed?.stale;
  const broken = feed?.status === 'BROKEN';
  const marketClosed = feed?.status === 'MARKET_CLOSED';
  const warning = feed?.status === 'WARNING' || feed?.status === 'STALE' || provider.ok === false;
  const status = disabled ? 'DISABLED' : broken ? 'BROKEN' : stale ? 'STALE' : warning ? 'STALE' : 'ON';
  const stockProviderIssue = provider.group === 'stocks' && status === 'BROKEN';
  const messageSv = disabled
    ? provider.group === 'stocks'
      ? 'API-nyckel för aktier saknas eller är ogiltig.'
      : `${provider.label} är inte fullt konfigurerad eller är avstängd.`
    : broken
      ? provider.group === 'stocks'
        ? providerErrorSv(feed?.latestProviderError || provider)
        : `${provider.label} saknar användbar live-data.`
      : stale
        ? provider.group === 'stocks'
          ? 'Aktiedata är gammal — kontrollera provider/scanner.'
          : `${provider.label} har gammal ${feed.group}-data (${feed.ageMinutes} minuter).`
        : provider.ok === false
          ? `${provider.label} hade senast ett providerfel (${provider.lastErrorType}).`
          : marketClosed
            ? feed.messageSv
          : `${provider.label} matar ${feed?.group || provider.group}-data.`;

  return component({
    name: `${provider.label} provider`,
    area: 'Providers',
    status,
    lastUpdated: feed?.lastUpdated || provider.lastSuccessAt || provider.lastErrorAt,
    messageSv,
    severity: status === 'ON' ? 'ok' : status === 'DISABLED' || status === 'STALE' || stockProviderIssue ? 'warning' : 'critical',
    details: {
      provider: provider.provider,
      group: provider.group,
      configured: provider.configured,
      enabled: provider.enabled,
      ok: provider.ok,
      feedStatus: feed?.status || null,
      lastScan: feed?.lastScan || null,
      latestTimestamp: feed?.latestTimestamp || null,
      ageSeconds: feed?.ageSeconds ?? null,
      marketOpen: feed?.marketOpen ?? null,
      stale: !!feed?.stale,
      staleAfterMinutes: feed?.staleAfterMinutes || null,
      latestProviderError: feed?.latestProviderError || null,
    },
    suggestedActionSv: status === 'ON' ? null : provider.group === 'stocks'
      ? 'Kontrollera Alpaca-nycklar, datakälla och senaste PM2-loggar.'
      : 'Kontrollera providerstatus, credentials och senaste PM2-loggar.',
  });
}

function stockFeedHealth() {
  const feed = getStockFeedStatus();
  const statusMap = {
    ON: 'LIVE',
    MARKET_CLOSED: 'MARKET_CLOSED',
    STALE: 'STALE',
    WARNING: 'STALE',
    BROKEN: 'BROKEN',
    DISABLED: 'BROKEN',
  };
  return {
    status: statusMap[feed?.status] || 'UNKNOWN',
    latestTimestamp: feed?.latestTimestamp || feed?.lastUpdated || null,
    ageSeconds: feed?.ageSeconds ?? null,
    provider: 'Alpaca',
    reasonSv: feed?.messageSv || 'Aktiedatans status är okänd.',
  };
}

function scannerComponent(name, area, status, rows, staleMinutes) {
  const hasData = Array.isArray(rows) && rows.length > 0;
  const age = minutesSince(status?.lastScan);
  const isStockScanner = /stock/i.test(name);
  const feed = status?.feedStatus || null;
  if (!hasData) {
    return component({
      name,
      area,
      status: status?.scanning ? 'STALE' : 'BROKEN',
      lastUpdated: status?.lastScan || null,
      messageSv: isStockScanner
        ? (feed?.messageSv || 'Aktiedata saknas just nu.')
        : `${name} saknar live-resultat.`,
      severity: isStockScanner ? 'warning' : (status?.scanning ? 'warning' : 'critical'),
      details: { scanning: !!status?.scanning, error: status?.error || null, feedStatus: feed },
      suggestedActionSv: isStockScanner
        ? 'Kontrollera Alpaca-provider, API-nycklar och scanner-loggar.'
        : 'Kontrollera scanner-loggar och datakällor.',
    });
  }
  const stale = age !== null && age > staleMinutes;
  const marketClosed = isStockScanner && feed?.status === 'MARKET_CLOSED';
  return component({
    name, area, status: stale ? 'STALE' : 'ON', lastUpdated: status?.lastScan || null,
    messageSv: marketClosed
      ? feed.messageSv
      : stale
        ? isStockScanner ? 'Senaste aktiescan är för gammal.' : `${name} har data men senaste scan är ${age} minuter gammal.`
      : isStockScanner ? `Aktiescanner kör och har ${rows.length} resultat.` : `${name} kör och har ${rows.length} resultat.`,
    severity: stale ? 'warning' : 'ok',
    details: { count: rows.length, scanning: !!status?.scanning, error: status?.error || null, feedStatus: feed },
    suggestedActionSv: stale ? 'Kontrollera PM2 och scanner-loggar.' : null,
  });
}

function apiComponents() {
  const stocks = getLatestResults().filter((r) => (getGroups().stocks || []).includes(r.symbol));
  const crypto = getCryptoResults();
  return [
    apiCheck('/api/scan/stocks', 'APIs', () => stocks.length > 0, `${stocks.length} aktieresultat tillgängliga.`, 'warning', 'Aktiedata saknas just nu.'),
    apiCheck('/api/scan/crypto', 'APIs', () => crypto.length > 0, `${crypto.length} kryptoreultat tillgängliga.`),
    apiCheck('/api/history/learning-summary', 'APIs', () => !!loadLearningSummary(), 'Learning summary kan läsas.'),
    apiCheck('/api/history/rule-memory', 'APIs', () => !!loadRuleMemory(), 'Rule memory kan läsas.'),
    apiCheck('/api/history/symbol-profiles', 'APIs', () => !!loadSymbolProfiles(), 'Symbol profiles kan läsas.'),
    apiCheck('/api/history/regime-profiles', 'APIs', () => !!loadRegimeProfiles(), 'Regime profiles kan läsas.'),
    apiCheck('/api/history/score-calibration', 'APIs', () => !!loadScoreCalibration(), 'Score calibration kan läsas.'),
    apiCheck('/api/history/momentum-backtest', 'APIs', () => !!loadMomentumBacktest(), 'Momentum backtest kan läsas.'),
    apiCheck('/api/market/personality', 'APIs', () => !!(loadPersonality('stocks') || loadPersonality('crypto')), 'Market personality kan läsas.'),
  ];
}

function apiCheck(name, area, fn, okMsg, failureSeverity = 'critical', failureMsg = null) {
  try {
    const ok = !!fn();
    return component({
      name, area, status: ok ? 'ON' : 'BROKEN',
      lastUpdated: new Date().toISOString(),
      messageSv: ok ? okMsg : (failureMsg || `${name} returnerar ingen användbar data.`),
      severity: ok ? 'ok' : failureSeverity,
      suggestedActionSv: ok ? null : 'Kontrollera bakomliggande datafil och serverloggar.',
    });
  } catch (err) {
    return component({
      name, area, status: 'BROKEN',
      lastUpdated: new Date().toISOString(),
      messageSv: `${name} kastade fel: ${err.message}`,
      severity: failureSeverity,
      suggestedActionSv: 'Kontrollera serverloggar.',
    });
  }
}

function dataComponents() {
  return [
    fileComponent('Learning summary', 'data/signals/learning-summary.json', 24 * 60),
    fileComponent('Rule memory', 'data/signals/rule-memory.json', 24 * 60),
    fileComponent('Symbol profiles', 'data/signals/symbol-profiles.json', 24 * 60),
    fileComponent('Regime profiles', 'data/signals/regime-profiles.json', 24 * 60),
    fileComponent('Score calibration', 'data/signals/score-calibration.json', 24 * 60),
    fileComponent('Momentum backtest', 'data/signals/momentum-backtest.json', 24 * 60),
    latestDirComponent('History latest file', 'data/signals/history', 24 * 60, 'Data Files'),
    latestDirComponent('Outcomes latest file', 'data/signals/outcomes', 24 * 60, 'Data Files'),
    latestDirComponent('State graph files', 'data/signals/state-graph', 10, 'Data Files', (f) => f.endsWith('.json')),
    latestDirComponent('Decay state files', 'data/signals/decay-state', 10, 'Data Files', (f) => f.endsWith('.json')),
  ];
}

function backgroundComponents() {
  const status = getAutoMachineStatus();
  const last = status?.lastResult || null;
  const finishedAt = last?.finishedAt || status?.finishedAt || null;
  const step = (key, label, suggested = 'Kör Machine manuellt eller vänta på scheduler.') => {
    const s = last?.steps?.[key];
    if (!last) {
      return component({ name: label, area: 'Machine', status: 'STALE', messageSv: `${label} har ingen sparad körning.`, suggestedActionSv: suggested });
    }
    if (!s) {
      return component({ name: label, area: 'Machine', status: 'DISABLED', lastUpdated: finishedAt, messageSv: `${label} finns inte i senaste pipeline-körningen.`, severity: 'warning', suggestedActionSv: suggested });
    }
    return component({
      name: label,
      area: 'Machine',
      status: s.ok === false ? 'BROKEN' : 'ON',
      lastUpdated: finishedAt,
      messageSv: s.ok === false ? `${label} misslyckades i senaste körningen.` : `${label} kördes i senaste pipeline.`,
      severity: s.ok === false ? 'critical' : 'ok',
      details: s,
      suggestedActionSv: s.ok === false ? suggested : null,
    });
  };

  return [
    component({
      name: 'Auto Machine',
      area: 'Machine',
      status: autoMachineRunning() ? 'ON' : finishedAt ? 'ON' : 'STALE',
      lastUpdated: finishedAt,
      messageSv: autoMachineRunning() ? 'Auto Machine kör just nu.' : finishedAt ? 'Auto Machine har en sparad senaste körning.' : 'Auto Machine har inte kört ännu.',
      severity: 'ok',
      details: { running: autoMachineRunning(), error: status?.error || null },
    }),
    step('backfill', 'Backfill last run'),
    step('replay', 'Replay last run'),
    step('analyzeOutcomes', 'Analyze Outcomes last run'),
    step('updateLearning', 'Update Learning last run'),
    step('analyzeMomentumIntelligence', 'Momentum Backtest last run'),
    step('invalidateCaches', 'Cache invalidation last run'),
  ];
}

function learningComponents() {
  const all = [...getLatestResults(), ...getCryptoResults()];
  const hasMtf = all.some((r) => r.mtfStatus || r.mtfAlignment);
  const hasMomentum = all.some((r) => r.momentumContinuationScore != null && r.fakeoutProbability != null);
  const hasStateGraph = all.some((r) => r.stateGraph);
  const hasOrch = all.some((r) => r.orchestrator);
  const hasDecay = all.some((r) => r.decayContext);
  return [
    engineFile('Rule Memory', 'data/signals/rule-memory.json', !!loadRuleMemory()),
    engineFile('Symbol Personality', 'data/signals/symbol-profiles.json', !!loadSymbolProfiles()),
    engineFile('Regime Profile', 'data/signals/regime-profiles.json', !!loadRegimeProfiles()),
    engineFile('Score Calibration', 'data/signals/score-calibration.json', !!loadScoreCalibration()),
    engineLive('Real MTF', hasMtf, 'MTF syns i live-resultat.'),
    engineLive('Momentum Intelligence', hasMomentum, 'Momentum Intelligence syns i live-resultat.'),
    engineLive('Market State Graph', hasStateGraph, 'State Graph syns i live-resultat.'),
    engineLive('Learning Orchestrator', hasOrch, 'Learning Orchestrator syns i live-resultat.'),
    engineLive('Confidence Decay', hasDecay, 'Confidence Decay syns i live-resultat.'),
  ];
}

function engineFile(name, relPath, loaded) {
  const st = statFile(path.join(ROOT, relPath));
  if (!loaded || !st) {
    return component({ name, area: 'Learning', status: 'BROKEN', messageSv: `${name} är inte laddad.`, suggestedActionSv: 'Kör Machine → Update Learning.' });
  }
  const age = minutesSince(st.mtimeMs);
  const stale = age !== null && age > 24 * 60;
  return component({
    name, area: 'Learning', status: stale ? 'STALE' : 'ON', lastUpdated: st.mtime,
    messageSv: stale ? `${name} är laddad men gammal.` : `${name} är ON.`,
    severity: stale ? 'warning' : 'ok',
    suggestedActionSv: stale ? 'Kör Machine → Update Learning.' : null,
  });
}

function engineLive(name, ok, okMsg) {
  return component({
    name, area: 'Learning', status: ok ? 'ON' : 'BROKEN',
    lastUpdated: new Date().toISOString(),
    messageSv: ok ? okMsg : `${name} saknas i live-resultat.`,
    severity: ok ? 'ok' : 'critical',
    suggestedActionSv: ok ? null : 'Kontrollera scanner pipeline och PM2-loggar.',
  });
}

function prepareSystemAlerts(components) {
  return components
    .filter((c) => c.status === 'BROKEN' || c.severity === 'critical')
    .map((c) => ({
      type: c.area || 'system',
      severity: c.severity,
      titleSv: `${c.name}: ${c.status}`,
      messageSv: c.messageSv,
      suggestedActionSv: c.suggestedActionSv || 'Kontrollera systemets loggar.',
      createdAt: new Date().toISOString(),
    }));
}

function buildSystemHealth() {
  const components = [
    ...runtimeComponents(),
    ...providerComponents(),
    ...apiComponents(),
    ...dataComponents(),
    ...backgroundComponents(),
    ...learningComponents(),
  ];

  const alerts = prepareSystemAlerts(components);
  const critical = components.some((c) => c.severity === 'critical');
  const warning = components.some((c) => c.severity === 'warning' || c.status === 'STALE' || c.status === 'DISABLED');
  const overallStatus = critical ? 'CRITICAL' : warning ? 'WARNING' : 'HEALTHY';
  const brokenCount = components.filter((c) => c.status === 'BROKEN').length;
  const staleCount = components.filter((c) => c.status === 'STALE').length;
  const warningCount = components.filter((c) => c.status === 'STALE' || c.status === 'DISABLED' || c.severity === 'warning').length;

  const summarySv = overallStatus === 'HEALTHY'
    ? 'Systemet är ON. Alla kärnkomponenter ser friska ut.'
    : overallStatus === 'WARNING'
      ? `Varning: ${warningCount} komponent(er) är gamla eller avstängda.`
      : `Kritiskt fel: ${brokenCount} komponent(er) behöver åtgärdas.`;

  return {
    ok: !critical,
    overallStatus,
    generatedAt: new Date().toISOString(),
    summarySv,
    providers: buildProviderStatus(),
    feeds: {
      stocks: getStockFeedStatus(),
      crypto: getCryptoFeedStatus(),
    },
    stockFeed: stockFeedHealth(),
    components,
    alerts,
  };
}

module.exports = { buildSystemHealth, prepareSystemAlerts };
