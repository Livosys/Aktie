'use strict';
const fs   = require('fs');
const path = require('path');
const { getDatesInRange } = require('../data/marketDataStore');

const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const MIN_RECORDS_FOR_FAMILY_CONCLUSION = 50;

const AVOID_STATES = new Set([
  'THREE_FINGER_SPREAD_AVOID', 'WIDE_AVOID', 'BREAKOUT_ALREADY_OCCURRED', 'NO_TRADE',
]);

// ── Derive priority from historical outcome row ────────────────────────────────
function derivePriority(o) {
  if (o.status) return o.status;
  if (o.priority) return o.priority;
  const state  = o.state  || '';
  const signal = o.signal || '';
  const score  = o.tradeScore || 0;

  if (AVOID_STATES.has(state) || signal === 'NO_TRADE') return 'avoid';
  // score≥70 triggered → active (dc5%≈39%). 60–69 maps to watch (dc5%≈33%) — two distinct quality bands.
  if ((signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') && score >= 70) return 'active';
  if ((signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') && score >= 50) return 'watch';
  if (score >= 30 || signal.includes('WATCH')) return 'watch';
  return 'wait';
}

// ── Derive expected direction from signal + marketDirection ───────────────────
function deriveBias(o) {
  if (o.nextMoveBias === 'UP' || o.nextMoveBias === 'DOWN' || o.nextMoveBias === 'UNCERTAIN') return o.nextMoveBias;
  if (o.direction === 'UP' || o.direction === 'DOWN') return o.direction;
  const signal = o.signal || '';
  const dir    = o.marketDirection || '';

  if (signal.startsWith('LONG'))  return 'UP';
  if (signal.startsWith('SHORT')) return 'DOWN';
  if (dir === 'bullish') return 'UP';
  if (dir === 'bearish') return 'DOWN';
  return 'UNCERTAIN';
}

// ── Was the direction correct? ────────────────────────────────────────────────
function directionCorrect(bias, pct, threshold) {
  if (bias === 'UP')   return typeof pct === 'number' ? pct >  threshold : null;
  if (bias === 'DOWN') return typeof pct === 'number' ? pct < -threshold : null;
  return null;
}

// ── Quality label ─────────────────────────────────────────────────────────────
function computeQualityLabel(o, priority, bias) {
  const o5  = o.outcome5;
  const o10 = o.outcome10;

  if (!o5 || (o5.candlesAvail ?? 0) < 3) return 'Data saknas';

  const move5  = o5.priceChangePct  ?? 0;
  const move10 = (o10?.priceChangePct) ?? 0;

  // Signal came too late — breakout already happened
  if (o.state === 'BREAKOUT_ALREADY_OCCURRED') return 'Kom för sent';

  // Avoid-class signals: was the blockering protective or did price move anyway?
  if (priority === 'avoid' && AVOID_STATES.has(o.state || '')) {
    const inDir5  = (bias === 'UP' && move5 > 0.18) || (bias === 'DOWN' && move5 < -0.18);
    const inDir10 = (bias === 'UP' && move10 > 0.28) || (bias === 'DOWN' && move10 < -0.28);
    if (bias !== 'UNCERTAIN' && (inDir5 || inDir10)) return 'Missad möjlighet';
    return 'Bra blockering';
  }

  if (bias === 'UNCERTAIN') return 'Osäker';

  if (directionCorrect(bias, move5, 0.08) === true) return 'Träffade riktning';

  return 'Osäker';
}

// ── Human-readable summary sentences ─────────────────────────────────────────
function buildNarrativeSv(summary, byStatus) {
  const lines = [];
  const total = summary.totalAnalyzed;
  if (!total) return ['Ingen signaldata att analysera ännu.'];

  const pct5 = summary.directionalCorrectPct5;
  if (pct5 > 0) {
    lines.push(
      pct5 >= 60
        ? `Systemet träffade riktningen ${pct5}% av gångerna (efter 5 min).`
        : `Systemet träffade riktningen ${pct5}% av gångerna (efter 5 min) — det är under 60%.`,
    );
  }

  if (summary.goodBlockCount > 0) {
    const total_ = summary.goodBlockCount + summary.badBlockCount;
    lines.push(
      `${summary.goodBlockCount} av ${total_} blockeringar skyddade mot svag rörelse.`,
    );
  }
  if (summary.badBlockCount > 0) {
    lines.push(`${summary.badBlockCount} blockerade signaler hade kunnat ge rörelse — möjliga missar.`);
  }
  if (summary.lateSignalCount > 0) {
    lines.push(`${summary.lateSignalCount} signaler kom för sent efter en redan stark rörelse.`);
  }

  const avoidStatus = byStatus.avoid;
  if (avoidStatus && avoidStatus.count >= 5) {
    const prot = avoidStatus.goodBlock;
    const miss = avoidStatus.badBlock;
    if (prot > miss) {
      lines.push(`Systemet var ofta försiktigt. ${prot} av ${prot + miss} blockeringar skyddade mot svag rörelse.`);
    }
  }

  const waitStatus = byStatus.wait;
  const watchStatus = byStatus.watch;
  if (waitStatus && watchStatus) {
    const waitDc = waitStatus.count > 0 ? Math.round((waitStatus.dc5 / waitStatus.count) * 100) : 0;
    const watchDc = watchStatus.count > 0 ? Math.round((watchStatus.dc5 / watchStatus.count) * 100) : 0;
    if (watchDc > waitDc + 10) {
      lines.push(`Watch-signaler träffade riktning ${watchDc}% vs wait-signaler ${waitDc}% — watch-nivån verkar bättre kalibrerat.`);
    }
  }

  return lines.length ? lines : ['Inte tillräckligt med data för slutsatser ännu.'];
}

function emptyGroup(key) {
  return {
    key,
    count: 0,
    dc5: 0,
    dc10: 0,
    dc20: 0,
    goodBlock: 0,
    badBlock: 0,
    late: 0,
    noData: 0,
    uncertain: 0,
    totalMovePct5: 0,
    totalMovePct10: 0,
    totalMovePct20: 0,
    biasCount: 0,
    symbolStats: {},
    statusCounts: {},
    subtypeCounts: {},
    reasonCounts: {},
  };
}

function addToGroup(group, row) {
  group.count++;
  if (row.directionCorrect5 === true) group.dc5++;
  if (row.directionCorrect10 === true) group.dc10++;
  if (row.directionCorrect20 === true) group.dc20++;
  if (row.wasGoodBlock) group.goodBlock++;
  if (row.wasBadBlock) group.badBlock++;
  if (row.wasLate) group.late++;
  if (row.qualityLabel === 'Data saknas') group.noData++;
  if (row.qualityLabel === 'Osäker') group.uncertain++;
  if (row.nextMoveBias !== 'UNCERTAIN' && row.movePct5 !== null) {
    group.totalMovePct5 += row.movePct5;
    group.totalMovePct10 += row.movePct10 ?? 0;
    group.totalMovePct20 += row.movePct20 ?? 0;
    group.biasCount++;
  }

  const symbol = row.symbol || 'unknown';
  if (!group.symbolStats[symbol]) group.symbolStats[symbol] = { symbol, count: 0, biasCount: 0, dc5: 0, totalMovePct5: 0 };
  const sym = group.symbolStats[symbol];
  sym.count++;
  if (row.nextMoveBias !== 'UNCERTAIN' && row.movePct5 !== null) {
    sym.biasCount++;
    sym.totalMovePct5 += row.movePct5;
    if (row.directionCorrect5 === true) sym.dc5++;
  }

  const status = row.status || 'unknown';
  group.statusCounts[status] = (group.statusCounts[status] || 0) + 1;
  const subtype = row.signalSubtype || 'UNKNOWN';
  group.subtypeCounts[subtype] = (group.subtypeCounts[subtype] || 0) + 1;
  const reason = row.primaryReason || 'unknown';
  group.reasonCounts[reason] = (group.reasonCounts[reason] || 0) + 1;
}

function mostCommon(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }))[0] || null;
}

function bestWorstSymbol(symbolStats) {
  const ranked = Object.values(symbolStats)
    .filter((s) => s.biasCount > 0)
    .map((s) => ({
      symbol: s.symbol,
      count: s.count,
      biasCount: s.biasCount,
      dc5Pct: Math.round((s.dc5 / s.biasCount) * 100),
      avgMove5: parseFloat((s.totalMovePct5 / s.biasCount).toFixed(4)),
    }))
    .sort((a, b) => {
      if (b.dc5Pct !== a.dc5Pct) return b.dc5Pct - a.dc5Pct;
      return b.avgMove5 - a.avgMove5;
    });
  return {
    bestSymbol: ranked[0] || null,
    worstSymbol: ranked[ranked.length - 1] || null,
  };
}

function finalizeGroup(group) {
  const { bestSymbol, worstSymbol } = bestWorstSymbol(group.symbolStats);
  const commonStatus = mostCommon(group.statusCounts);
  const commonSubtype = mostCommon(group.subtypeCounts);
  const commonPrimaryReason = mostCommon(group.reasonCounts);
  const { symbolStats, statusCounts, subtypeCounts, reasonCounts, ...publicGroup } = group;

  return {
    ...publicGroup,
    directionalCorrect5: group.dc5,
    directionalCorrect10: group.dc10,
    directionalCorrect20: group.dc20,
    dc5Pct: group.biasCount > 0 ? Math.round((group.dc5 / group.biasCount) * 100) : null,
    dc10Pct: group.biasCount > 0 ? Math.round((group.dc10 / group.biasCount) * 100) : null,
    dc20Pct: group.biasCount > 0 ? Math.round((group.dc20 / group.biasCount) * 100) : null,
    avgMovePct5: group.biasCount > 0 ? parseFloat((group.totalMovePct5 / group.biasCount).toFixed(4)) : null,
    avgMovePct10: group.biasCount > 0 ? parseFloat((group.totalMovePct10 / group.biasCount).toFixed(4)) : null,
    avgMovePct20: group.biasCount > 0 ? parseFloat((group.totalMovePct20 / group.biasCount).toFixed(4)) : null,
    avgMove5: group.biasCount > 0 ? parseFloat((group.totalMovePct5 / group.biasCount).toFixed(4)) : null,
    avgMove10: group.biasCount > 0 ? parseFloat((group.totalMovePct10 / group.biasCount).toFixed(4)) : null,
    avgMove20: group.biasCount > 0 ? parseFloat((group.totalMovePct20 / group.biasCount).toFixed(4)) : null,
    bestSymbol,
    worstSymbol,
    mostCommonStatus: commonStatus?.key || null,
    mostCommonSubtype: commonSubtype?.key || null,
    mostCommonPrimaryReason: commonPrimaryReason?.key || null,
    hasEnoughDataForConclusion: group.count >= MIN_RECORDS_FOR_FAMILY_CONCLUSION,
    dataSufficiencySv: group.count >= MIN_RECORDS_FOR_FAMILY_CONCLUSION
      ? 'Datamängden räcker för en första slutsats.'
      : 'För lite data för säker slutsats.',
  };
}

function aggregateBy(rows, keyFn, { limit = null } = {}) {
  const map = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    if (!map[key]) map[key] = emptyGroup(key);
    addToGroup(map[key], row);
  }
  const arr = Object.values(map)
    .map(finalizeGroup)
    .sort((a, b) => b.count - a.count);
  return limit ? arr.slice(0, limit) : arr;
}

// ── Main export ───────────────────────────────────────────────────────────────
function analyzeSignalQuality({ days = 7, limit = 200 } = {}) {
  const end   = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const dates = getDatesInRange(start, end);

  // Load raw outcomes
  const raw = [];
  for (const date of dates) {
    const fp = path.join(OUTCOMES_DIR, `${date}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try { raw.push(JSON.parse(l)); } catch { /* skip bad lines */ }
      }
    } catch { /* skip unreadable file */ }
  }

  if (!raw.length) {
    return {
      ok: true,
      analyzedDays: days,
      totalAnalyzed: 0,
      summary: {
        totalAnalyzed: 0,
        withDirectionalBias: 0,
        directionalCorrect5: 0, directionalCorrect10: 0, directionalCorrect20: 0,
        directionalCorrectPct5: 0, directionalCorrectPct10: 0, directionalCorrectPct20: 0,
        avgMove5: 0, avgMove10: 0, avgMove20: 0,
        lateSignalCount: 0, goodBlockCount: 0, badBlockCount: 0,
        uncertainCount: 0, hitCount: 0, noDataCount: 0,
        labelCounts: {},
        bestStatus: null, worstStatus: null,
        narrativeSv: ['Ingen signaldata att analysera ännu.'],
      },
      byStatus: {},
      bySymbol: [],
      recent: [],
    };
  }

  // Enrich each outcome
  const analyzed = raw.map(o => {
    const priority = derivePriority(o);
    const bias     = deriveBias(o);
    const label    = computeQualityLabel(o, priority, bias);

    const o5  = o.outcome5  || {};
    const o10 = o.outcome10 || {};
    const o20 = o.outcome20 || {};
    const move5  = o5.priceChangePct  ?? null;
    const move10 = o10.priceChangePct ?? null;
    const move20 = o20.priceChangePct ?? null;

    return {
      signalId:       o.signalId,
      symbol:         o.symbol,
      timestamp:      o.timestamp,
      status:         priority,
      priority,
      nextMoveBias:   bias,
      signalFamily:   o.signalFamily || 'UNKNOWN',
      signalSubtype:  o.signalSubtype || 'UNKNOWN',
      extensionLevel: o.extensionLevel || 'unknown',
      dataFreshness:  o.dataFreshness || 'unknown',
      primaryReason:  o.primaryReason || 'unknown',
      twoMinuteConflict: typeof o.twoMinuteConflict === 'boolean' ? o.twoMinuteConflict : null,
      tradeScore:     o.tradeScore || 0,
      score:          o.score ?? o.tradeScore ?? 0,
      confidenceScore: o.confidenceScore ?? null,
      narrowScore:    o.narrowScore || 0,
      state:          o.state,
      signal:         o.signal,
      marketDirection: o.marketDirection,
      priceAtSignal:  o.entryPrice ?? null,
      movePct5:       move5  !== null ? parseFloat(move5.toFixed(4))  : null,
      movePct10:      move10 !== null ? parseFloat(move10.toFixed(4)) : null,
      movePct20:      move20 !== null ? parseFloat(move20.toFixed(4)) : null,
      directionCorrect5:  directionCorrect(bias, move5,  0.08),
      directionCorrect10: directionCorrect(bias, move10, 0.08),
      directionCorrect20: directionCorrect(bias, move20, 0.08),
      wasLate:      label === 'Kom för sent',
      wasGoodBlock: label === 'Bra blockering',
      wasBadBlock:  label === 'Missad möjlighet',
      qualityLabel: label,
    };
  });

  analyzed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // ── Aggregate stats ────────────────────────────────────────────────────────
  const withBias = analyzed.filter(a => a.nextMoveBias !== 'UNCERTAIN' && a.movePct5 !== null);
  const dc5  = withBias.filter(a => a.directionCorrect5  === true).length;
  const dc10 = withBias.filter(a => a.directionCorrect10 === true).length;
  const dc20 = withBias.filter(a => a.directionCorrect20 === true).length;
  const avg5  = withBias.length ? withBias.reduce((s, a) => s + (a.movePct5  || 0), 0) / withBias.length : 0;
  const avg10 = withBias.length ? withBias.reduce((s, a) => s + (a.movePct10 || 0), 0) / withBias.length : 0;
  const avg20 = withBias.length ? withBias.reduce((s, a) => s + (a.movePct20 || 0), 0) / withBias.length : 0;

  // Label counts
  const labelCounts = {};
  for (const a of analyzed) labelCounts[a.qualityLabel] = (labelCounts[a.qualityLabel] || 0) + 1;

  // ── By status ──────────────────────────────────────────────────────────────
  const byStatus = {};
  for (const a of analyzed) {
    const s = a.status;
    if (!byStatus[s]) byStatus[s] = { count: 0, dc5: 0, dc10: 0, goodBlock: 0, badBlock: 0, late: 0, uncertain: 0, noData: 0, totalMovePct5: 0, biasCount: 0 };
    byStatus[s].count++;
    if (a.directionCorrect5  === true) byStatus[s].dc5++;
    if (a.directionCorrect10 === true) byStatus[s].dc10++;
    if (a.wasGoodBlock)  byStatus[s].goodBlock++;
    if (a.wasBadBlock)   byStatus[s].badBlock++;
    if (a.wasLate)       byStatus[s].late++;
    if (a.qualityLabel === 'Osäker')      byStatus[s].uncertain++;
    if (a.qualityLabel === 'Data saknas') byStatus[s].noData++;
    if (a.nextMoveBias !== 'UNCERTAIN' && a.movePct5 !== null) {
      byStatus[s].totalMovePct5 += a.movePct5;
      byStatus[s].biasCount++;
    }
  }
  // Add hit/pct fields
  for (const s of Object.keys(byStatus)) {
    const v = byStatus[s];
    v.hitCount = labelCounts['Träffade riktning'] || 0;
    v.dc5Pct   = v.biasCount > 0 ? Math.round((v.dc5 / v.biasCount) * 100) : null;
    v.avgMovePct5 = v.biasCount > 0 ? parseFloat((v.totalMovePct5 / v.biasCount).toFixed(4)) : null;
  }

  // ── By symbol ──────────────────────────────────────────────────────────────
  const symMap = {};
  for (const a of analyzed) {
    if (!symMap[a.symbol]) symMap[a.symbol] = {
      symbol: a.symbol, count: 0, dc5: 0, withBias: 0, goodBlock: 0, badBlock: 0, late: 0, totalMove: 0,
    };
    const m = symMap[a.symbol];
    m.count++;
    if (a.wasGoodBlock) m.goodBlock++;
    if (a.wasBadBlock)  m.badBlock++;
    if (a.wasLate)      m.late++;
    if (a.nextMoveBias !== 'UNCERTAIN' && a.movePct5 !== null) {
      m.withBias++;
      m.totalMove += a.movePct5;
      if (a.directionCorrect5 === true) m.dc5++;
    }
  }
  const bySymbol = Object.values(symMap)
    .map(s => ({
      ...s,
      dc5Pct:   s.withBias > 0 ? Math.round((s.dc5 / s.withBias) * 100) : null,
      avgMove5: s.withBias > 0 ? parseFloat((s.totalMove / s.withBias).toFixed(4)) : null,
    }))
    .sort((a, b) => b.count - a.count);

  const bySignalFamily = aggregateBy(analyzed, a => a.signalFamily || 'UNKNOWN');
  const bySignalSubtype = aggregateBy(analyzed, a => a.signalSubtype || 'UNKNOWN');
  const byExtensionLevel = aggregateBy(analyzed, a => a.extensionLevel || 'unknown');
  const byDataFreshness = aggregateBy(analyzed, a => a.dataFreshness || 'unknown');
  const byPrimaryReason = aggregateBy(analyzed, a => a.primaryReason || 'unknown', { limit: 25 });
  const byTwoMinuteConflict = aggregateBy(analyzed, (a) => {
    if (a.twoMinuteConflict === true) return 'true';
    if (a.twoMinuteConflict === false) return 'false';
    return 'unknown';
  });

  // ── Best / worst status ────────────────────────────────────────────────────
  const statusDc5 = Object.entries(byStatus)
    .filter(([, v]) => v.biasCount >= 5)
    .map(([status, v]) => ({ status, rate: v.dc5 / v.biasCount }))
    .sort((a, b) => b.rate - a.rate);

  const summary = {
    totalAnalyzed: analyzed.length,
    withDirectionalBias: withBias.length,
    directionalCorrect5: dc5, directionalCorrect10: dc10, directionalCorrect20: dc20,
    directionalCorrectPct5:  withBias.length > 0 ? Math.round((dc5  / withBias.length) * 100) : 0,
    directionalCorrectPct10: withBias.length > 0 ? Math.round((dc10 / withBias.length) * 100) : 0,
    directionalCorrectPct20: withBias.length > 0 ? Math.round((dc20 / withBias.length) * 100) : 0,
    avgMove5:  parseFloat(avg5.toFixed(4)),
    avgMove10: parseFloat(avg10.toFixed(4)),
    avgMove20: parseFloat(avg20.toFixed(4)),
    lateSignalCount:  labelCounts['Kom för sent']     || 0,
    goodBlockCount:   labelCounts['Bra blockering']   || 0,
    badBlockCount:    labelCounts['Missad möjlighet']  || 0,
    uncertainCount:   labelCounts['Osäker']           || 0,
    hitCount:         labelCounts['Träffade riktning'] || 0,
    noDataCount:      labelCounts['Data saknas']       || 0,
    labelCounts,
    bestStatus:  statusDc5[0]?.status || null,
    worstStatus: statusDc5[statusDc5.length - 1]?.status || null,
    narrativeSv: buildNarrativeSv({
      totalAnalyzed: analyzed.length,
      directionalCorrectPct5: withBias.length > 0 ? Math.round((dc5 / withBias.length) * 100) : 0,
      goodBlockCount:   labelCounts['Bra blockering']   || 0,
      badBlockCount:    labelCounts['Missad möjlighet']  || 0,
      lateSignalCount:  labelCounts['Kom för sent']     || 0,
    }, byStatus),
  };

  return {
    ok: true,
    analyzedDays: days,
    totalAnalyzed: analyzed.length,
    summary,
    byStatus,
    bySymbol,
    bySignalFamily,
    bySignalSubtype,
    byExtensionLevel,
    byDataFreshness,
    byPrimaryReason,
    byTwoMinuteConflict,
    recent: analyzed.slice(0, limit),
  };
}

module.exports = { analyzeSignalQuality };
