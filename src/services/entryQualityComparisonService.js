'use strict';

// Entry Quality Comparison v1
// Read-only paper/replay analysis of CLOSED paper trades. It NEVER creates
// trades, changes config, places orders, or touches broker/live paths. It only
// reads data/paper-trading/trades.jsonl and reports how a set of entry-quality
// filter profiles would have reshaped the historical paper trade set.
//
// The same per-trade signal derivation also powers a NON-BLOCKING preview used
// by the paper runtime (see evaluateEntryQuality). The optional runtime gate is
// guarded by PAPER_ENTRY_QUALITY_GATE_ENABLED (default false) and may only ever
// affect the paper agent — never live trading, broker, or order placement.

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  replay_mode: true,
  paper_only: true,
  read_only: true,
});

const DATA_DIR = path.resolve(__dirname, '../../data');
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading/trades.jsonl');

// Caution trades lose this many confidence points in confidence_penalty_caution.
const CAUTION_CONFIDENCE_PENALTY = 8;
// Fallback confidence floor used when a trade has no gate threshold recorded.
const CONFIDENCE_FLOOR = 50;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function lower(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

function ts(value) {
  if (!value) return 0;
  const d = new Date(value).getTime();
  return Number.isFinite(d) ? d : 0;
}

function durationSeconds(trade) {
  const explicit = num(trade.duration_seconds ?? trade.durationSeconds);
  if (explicit != null && explicit >= 0) return explicit;
  const a = ts(trade.opened_at || trade.openedAt || trade.entryTime);
  const b = ts(trade.closed_at || trade.closedAt || trade.exitTime);
  if (!a || !b) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function durationLabel(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

// Entry text that explicitly tells the runtime to wait for a fresh 2m confirmation
// (i.e. the trade was taken WITHOUT a clear new 2m confirmation).
function needsTwoMinuteConfirmation(reasonText) {
  const value = lower(reasonText);
  return /ny 2m-?bekr(ä|a)ftelse|bevaka rekyl|v(ä|a)nta på.*bekr(ä|a)ftelse|2m sade emot/.test(value);
}

// Entry text / extension signals that the move was already extended at entry.
function isExtendedHint(reasonText) {
  const value = lower(reasonText);
  return /r(ö|o)relsen har g(å|a)tt en bit|redan extended|f(ö|o)r l(å|a)ngt g(å|a)ngen|str(ä|a)ckt|late entry|sent entry/.test(value);
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Derive the entry-quality signals we filter on from a raw trade/candidate or a
// normalized trade (which keeps the original row under .raw). Tolerant of both
// snake_case and camelCase field names seen across the codebase.
function deriveEntrySignals(input = {}) {
  const raw = input.raw && typeof input.raw === 'object' ? input.raw : input;

  const statusAtEntry = lower(
    raw.statusAtEntry
    ?? raw.runtime_status
    ?? raw.runtimeStatus
    ?? input.statusAtEntry
    ?? input.status
    ?? '',
  ) || 'unknown';

  const setupBlob = [
    raw.setup, raw.signalSubtype, raw.signalFamily, raw.signal_subtype,
    raw.subtypeLabelSv, raw.familyLabelSv, raw.strategyName, raw.strategy_name,
    input.setup,
  ].map((v) => lower(v)).join(' ');
  const isRegularPullback = /regular_pullback|regular pullback|trend continuation|rekyl/.test(setupBlob);

  const extensionLevel = lower(raw.extensionLevel ?? input.extensionLevel ?? '');
  const reasonText = [
    raw.entryReasonSv, raw.entryReason, raw.entry_reason, raw.decisionTextSv,
    input.entryReasonSv, input.entryReason,
  ].filter(Boolean).join(' | ');
  const isExtended = ['mild', 'medium', 'high', 'extended', 'extreme'].includes(extensionLevel)
    || isExtendedHint(reasonText);

  const needs2m = needsTwoMinuteConfirmation(reasonText);

  const result = String(
    raw.result ?? input.result ?? raw.outcome ?? '',
  ).trim().toUpperCase() || 'UNKNOWN';

  const confidenceScore = num(
    raw.confidenceScore ?? raw.confidence ?? input.confidenceScore ?? input.confidence,
  );
  const gateThreshold = num(
    raw.gateThreshold ?? raw.originalGateThreshold ?? input.gateThreshold,
  );

  const seconds = durationSeconds(raw);

  return {
    symbol: String(raw.symbol || input.symbol || '').toUpperCase() || null,
    strategy: String(
      raw.strategyName || raw.strategy_name || raw.strategyId || raw.strategy_id
      || raw.signalSubtype || raw.signalFamily || input.strategyId || 'unknown',
    ),
    statusAtEntry,
    isCaution: statusAtEntry === 'caution',
    isRegularPullback,
    isExtended,
    extensionLevel: extensionLevel || 'none',
    needs2mConfirmation: needs2m,
    has2mConfirmation: !needs2m,
    result,
    isWin: result === 'WIN',
    isLoss: result === 'LOSS',
    pnlPct: num(raw.pnlPct ?? raw.pnl_pct ?? raw.pnl ?? input.pnlPct),
    mfePct: num(raw.maxFavorablePct ?? raw.mfePct ?? raw.max_favorable_pct ?? input.mfePct),
    maePct: num(raw.maxAdversePct ?? raw.maePct ?? raw.max_adverse_pct ?? input.maePct),
    durationSeconds: seconds,
    confidenceScore,
    gateThreshold,
  };
}

// ── Profiles ──────────────────────────────────────────────────────────────────
// Each profile keeps a trade when keep() returns true. baseline keeps everything.
// All profiles are pure functions of the derived signals — additive, paper-only.

const PROFILES = [
  {
    key: 'baseline',
    labelSv: 'Baseline (alla trades)',
    keep: () => true,
  },
  {
    key: 'skip_caution_regular_pullback',
    labelSv: 'Hoppa över caution + REGULAR_PULLBACK',
    keep: (s) => !(s.isCaution && s.isRegularPullback),
  },
  {
    key: 'require_2m_confirmation_for_caution_regular_pullback',
    labelSv: 'Kräv 2m-confirmation för caution + REGULAR_PULLBACK',
    keep: (s) => !(s.isCaution && s.isRegularPullback && s.needs2mConfirmation),
  },
  {
    key: 'skip_extended_caution',
    labelSv: 'Hoppa över caution när rörelsen redan är extended',
    keep: (s) => !(s.isCaution && s.isExtended),
  },
  {
    key: 'confidence_penalty_caution',
    labelSv: 'Confidence-straff på caution-entries',
    keep: (s) => {
      if (!s.isCaution) return true;
      if (s.confidenceScore == null) return true; // can't penalize without a score → keep
      const floor = s.gateThreshold != null ? s.gateThreshold : CONFIDENCE_FLOOR;
      return (s.confidenceScore - CAUTION_CONFIDENCE_PENALTY) >= floor;
    },
  },
];

function topCounts(items, max = 3) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([label, count]) => ({ label, count }));
}

function summarizeKept(signals) {
  const wins = signals.filter((s) => s.isWin).length;
  const losses = signals.filter((s) => s.isLoss).length;
  const decided = wins + losses;
  const winRate = decided ? round((wins / decided) * 100, 1) : null;
  const durations = signals.map((s) => s.durationSeconds).filter((v) => Number.isFinite(v));
  const medianDur = median(durations);
  return {
    trades: signals.length,
    wins,
    losses,
    timeouts: signals.filter((s) => s.result === 'TIMEOUT').length,
    winRate,
    avgPnlPct: round(avg(signals.map((s) => s.pnlPct)) ?? 0, 4),
    medianPnlPct: round(median(signals.map((s) => s.pnlPct)) ?? 0, 4),
    medianDurationSeconds: medianDur,
    medianDurationLabel: durationLabel(medianDur),
    avgMfePct: round(avg(signals.map((s) => s.mfePct)) ?? 0, 4),
    avgMaePct: round(avg(signals.map((s) => s.maePct)) ?? 0, 4),
  };
}

function recommendationFor(profile, kept, filtered, baseline) {
  if (profile.key === 'baseline') {
    return `Baseline: ${kept.trades} trades, winrate ${kept.winRate ?? '–'}%, snitt-PnL ${kept.avgPnlPct}%.`;
  }
  if (!filtered.count) {
    return 'Ingen trade filtrerades bort i historiken — profilen ändrar inget på nuvarande data.';
  }
  const winDelta = (kept.winRate ?? 0) - (baseline.winRate ?? 0);
  const pnlDelta = round((kept.avgPnlPct ?? 0) - (baseline.avgPnlPct ?? 0), 4);
  const baselineWinRate = baseline.winRate ?? 0;
  const parts = [];
  parts.push(`Filtrerar bort ${filtered.count} trades (${filtered.wins} WIN / ${filtered.losses} LOSS, winrate ${filtered.winRate ?? '–'}%).`);
  if (winDelta > 0.4) parts.push(`Kvarvarande winrate förbättras ${round(winDelta, 1)} p.e.`);
  else if (winDelta < -0.4) parts.push(`Kvarvarande winrate försämras ${round(Math.abs(winDelta), 1)} p.e.`);
  else parts.push('Kvarvarande winrate i stort sett oförändrad.');
  if (pnlDelta > 0.005) parts.push(`snitt-PnL +${pnlDelta}%.`);
  else if (pnlDelta < -0.005) parts.push(`snitt-PnL ${pnlDelta}%.`);
  // Compare the filtered set's own winrate to baseline: if it is >= baseline we
  // are cutting better-than-average flow; if it is below baseline we are mostly
  // cutting the weaker trades (the desirable direction).
  if (filtered.winRate != null && filtered.winRate >= baselineWinRate) {
    parts.push(`Varning: bortfiltrerade hade ${filtered.winRate}% winrate (≥ baseline ${round(baselineWinRate, 1)}%) — profilen tar bort för mycket bra flöde.`);
  } else if (filtered.winRate != null) {
    parts.push(`Bortfiltrerade var svagare än snittet (${filtered.winRate}% vs baseline ${round(baselineWinRate, 1)}%), men ${filtered.wins} WIN-trades skulle ändå ha missats.`);
  }
  return parts.join(' ');
}

function buildProfileResult(profile, allSignals, baselineSummary) {
  const kept = [];
  const filtered = [];
  for (const s of allSignals) {
    if (profile.keep(s)) kept.push(s);
    else filtered.push(s);
  }
  const keptSummary = summarizeKept(kept);
  const fWins = filtered.filter((s) => s.isWin).length;
  const fLosses = filtered.filter((s) => s.isLoss).length;
  const fDecided = fWins + fLosses;
  const filteredSummary = {
    count: filtered.length,
    wins: fWins,
    losses: fLosses,
    timeouts: filtered.filter((s) => s.result === 'TIMEOUT').length,
    winRate: fDecided ? round((fWins / fDecided) * 100, 1) : null,
    topSymbols: topCounts(filtered.map((s) => s.symbol)),
    topStrategies: topCounts(filtered.map((s) => s.strategy)),
  };
  return {
    profile: profile.key,
    labelSv: profile.labelSv,
    kept: keptSummary,
    filtered: filteredSummary,
    recommendationSv: recommendationFor(profile, keptSummary, filteredSummary, baselineSummary),
  };
}

function pickBestProfile(results, baseline) {
  let best = null;
  for (const r of results) {
    if (r.profile === 'baseline') continue;
    if (!r.filtered.count) continue; // a profile that changes nothing can't "win"
    const winDelta = (r.kept.winRate ?? 0) - (baseline.winRate ?? 0);
    const pnlDelta = (r.kept.avgPnlPct ?? 0) - (baseline.avgPnlPct ?? 0);
    // Reward winrate + PnL gains. Penalise only when the filtered set's own
    // winrate is at/above baseline (i.e. we are cutting better-than-average flow).
    const baselineWinRate = baseline.winRate ?? 0;
    const overcut = Math.max(0, (r.filtered.winRate ?? 0) - baselineWinRate);
    const score = winDelta + pnlDelta * 20 - overcut * 0.5;
    if (!best || score > best.score) best = { profile: r.profile, labelSv: r.labelSv, score: round(score, 3), winDelta: round(winDelta, 1), pnlDelta: round(pnlDelta, 4) };
  }
  return best;
}

function variantClass(profileKey) {
  if (profileKey.startsWith('skip')) return 'skip';
  if (profileKey.startsWith('require_2m')) return 'require_2m_confirmation';
  if (profileKey.startsWith('confidence')) return 'confidence_penalty';
  return 'unknown';
}

function buildEntryQualityComparison(options = {}) {
  const file = options.tradesFile || PAPER_TRADES_FILE;
  const rows = Array.isArray(options.trades) ? options.trades : readJsonl(file);
  const closed = rows.filter((t) => {
    const result = String(t.result || t.outcome || '').trim().toUpperCase();
    return ['WIN', 'LOSS', 'TIMEOUT'].includes(result);
  });
  const allSignals = closed.map(deriveEntrySignals);

  const baselineResult = buildProfileResult(PROFILES[0], allSignals, { winRate: null, avgPnlPct: 0 });
  const baselineSummary = baselineResult.kept;
  const profiles = [
    baselineResult,
    ...PROFILES.slice(1).map((p) => buildProfileResult(p, allSignals, baselineSummary)),
  ];

  const best = pickBestProfile(profiles, baselineSummary);
  const beatsBaseline = Boolean(
    best
    && profiles.find((p) => p.profile === best.profile)
    && (best.winDelta > 0.4 || best.pnlDelta > 0.005),
  );

  const summarySv = (() => {
    if (!baselineSummary.trades) {
      return 'Inga stängda paper trades ännu — kör paper-runtime mer innan entry-quality kan jämföras.';
    }
    if (!best) {
      return `Ingen entry-filter-profil ändrar utfallet på nuvarande ${baselineSummary.trades} closed trades.`;
    }
    const bestRes = profiles.find((p) => p.profile === best.profile);
    if (beatsBaseline) {
      return `Bäst just nu: "${best.labelSv}" — ${bestRes.recommendationSv} Entry-filter verkar mer lovande än trailing stop i senaste replayen.`;
    }
    return `Ingen profil slår baseline tydligt ännu. Närmast: "${best.labelSv}" (${bestRes.recommendationSv}).`;
  })();

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    tradesAnalyzed: baselineSummary.trades,
    baseline: baselineSummary,
    profiles,
    best,
    bestVariantClass: best ? variantClass(best.profile) : null,
    beatsBaseline,
    summarySv,
    notesSv: [
      'Detta är bara analys. Runtime ändras inte.',
      'Entry-filter verkar mer lovande än trailing stop i senaste replayen.',
      'Nästa säkra test är att kräva 2m-confirmation för caution + REGULAR_PULLBACK.',
    ],
    ...SAFETY,
  };
}

// ── Per-trade preview (Del B) ───────────────────────────────────────────────
// Pure, non-blocking decision used both by the UI closed-trade detail and the
// paper runtime preview. NEVER places orders or touches broker/live state.
function evaluateEntryQuality(input = {}) {
  const s = deriveEntrySignals(input);
  const isCautionPullback = s.isCaution && s.isRegularPullback;
  const isExtendedCaution = s.isCaution && s.isExtended;

  const wouldSkipByEntryFilter = isCautionPullback || isExtendedCaution;
  const wouldRequire2mConfirmation = isCautionPullback && s.needs2mConfirmation;

  let entryQualityDecision = 'allow';
  let reasonSv = 'Entry såg ok ut för entry-filtret.';
  if (wouldRequire2mConfirmation) {
    entryQualityDecision = 'require_2m_confirmation';
    reasonSv = '2m-confirmation saknades';
  } else if (isCautionPullback) {
    entryQualityDecision = 'skip';
    reasonSv = 'Entry var caution + REGULAR_PULLBACK';
  } else if (isExtendedCaution) {
    entryQualityDecision = 'skip';
    reasonSv = 'Rörelsen var redan extended';
  }
  if (s.statusAtEntry === 'unknown' && !s.isRegularPullback) {
    entryQualityDecision = 'unknown';
    reasonSv = 'Data saknas för att bedöma entry-kvalitet.';
  }

  return {
    entryQualityDecision,
    wouldSkipByEntryFilter,
    wouldRequire2mConfirmation,
    reasonSv,
    recommendedTestSv: wouldRequire2mConfirmation
      ? 'Vänta på ny 2m-confirmation'
      : isCautionPullback
        ? 'Testa att kräva 2m-confirmation för caution + REGULAR_PULLBACK'
        : isExtendedCaution
          ? 'Testa att hoppa över caution när rörelsen redan är extended'
          : null,
    signals: {
      statusAtEntry: s.statusAtEntry,
      isRegularPullback: s.isRegularPullback,
      isExtended: s.isExtended,
      extensionLevel: s.extensionLevel,
      needs2mConfirmation: s.needs2mConfirmation,
    },
    ...SAFETY,
  };
}

// Feature flag (default OFF). When OFF the runtime must only show preview/wouldSkip
// and never block a paper trade. When ON it may ONLY affect the paper agent.
function isGateEnabled() {
  return String(process.env.PAPER_ENTRY_QUALITY_GATE_ENABLED || 'false').toLowerCase() === 'true';
}

module.exports = {
  SAFETY,
  PROFILES,
  deriveEntrySignals,
  evaluateEntryQuality,
  buildEntryQualityComparison,
  isGateEnabled,
  _internal: {
    needsTwoMinuteConfirmation,
    isExtendedHint,
    median,
    avg,
    durationLabel,
  },
};
