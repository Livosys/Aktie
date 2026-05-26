'use strict';

const FORBIDDEN_PATTERNS = [
  /\bköp\b/gi,
  /\bsälj\b/gi,
  /stark köp/gi,
  /trade now/gi,
  /guaranteed/gi,
  /säker vinst/gi,
];

const VERDICTS = new Set([
  'Titta manuellt',
  'Bevaka',
  'Vänta',
  'Jaga inte',
  'Kan inte bedöma',
]);

function clamp(n, min, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function safeText(value) {
  let out = String(value ?? '');
  for (const pattern of FORBIDDEN_PATTERNS) {
    out = out.replace(pattern, 'titta manuellt');
  }
  return out;
}

function safeList(items) {
  return asArray(items).map(safeText).filter(Boolean);
}

function sanitizeAnalyst(analyst) {
  const verdict = VERDICTS.has(analyst.verdict) ? analyst.verdict : 'Kan inte bedöma';
  return {
    verdict,
    confidence: clamp(analyst.confidence, 0, 100),
    summarySv: safeText(analyst.summarySv),
    whatSystemSees: safeList(analyst.whatSystemSees),
    whatSupports: safeList(analyst.whatSupports),
    whatWarns: safeList(analyst.whatWarns),
    missingConfirmation: safeList(analyst.missingConfirmation),
    historicalContextSv: safeText(analyst.historicalContextSv),
    timingAssessmentSv: safeText(analyst.timingAssessmentSv),
    riskAssessmentSv: safeText(analyst.riskAssessmentSv),
    nextImprovementSv: safeText(analyst.nextImprovementSv),
    suggestedStatus: safeText(analyst.suggestedStatus || verdict),
    currentStatusLooksReasonable: analyst.currentStatusLooksReasonable !== false,
    actionLanguageSafe: true,
    mode: analyst.mode || 'rule_based',
    modeLabel: analyst.modeLabel || 'AI-läge: regelbaserad analys',
  };
}

function directed(value) {
  return value === 'bullish' || value === 'bearish';
}

function directionSv(value) {
  if (value === 'bullish') return 'uppåt';
  if (value === 'bearish') return 'nedåt';
  if (value === 'neutral') return 'neutral';
  return 'okänd';
}

function biasSv(value) {
  if (value === 'UP') return 'uppåt';
  if (value === 'DOWN') return 'nedåt';
  if (value === 'NEUTRAL') return 'neutral';
  return 'osäker';
}

function candleOpposes(tf2m, candleScore2m) {
  const dir = candleScore2m?.scoreDirection || 'unknown';
  return (tf2m === 'bullish' && dir === 'bearish') ||
    (tf2m === 'bearish' && dir === 'bullish');
}

function candleAlignsBias(nextMoveBias, candleScore2m) {
  const dir = candleScore2m?.scoreDirection || 'unknown';
  return (nextMoveBias === 'UP' && dir === 'bullish') ||
    (nextMoveBias === 'DOWN' && dir === 'bearish');
}

function dataFreshness(candidate) {
  if (candidate?.dataFreshness) return candidate.dataFreshness;
  const hasStaleBlocker = [...asArray(candidate?.hardBlockers), ...asArray(candidate?.softBlockers), ...asArray(candidate?.blockers)]
    .some((b) => /gammal|stale|feed/i.test(String(b)));
  if (hasStaleBlocker) return 'STALE';
  const age = Number(candidate?.dataAgeSeconds);
  if (Number.isFinite(age)) {
    const marketType = candidate.marketType || candidate.market;
    const maxAge = marketType === 'crypto' ? 20 * 60 : 24 * 60 * 60;
    return age > maxAge ? 'STALE' : 'FRESH';
  }
  return 'UNKNOWN';
}

function latestMoveFromCandles(candles) {
  const clean = (candles || [])
    .map((c) => ({
      close: Number(c.close ?? c.c),
      timestamp: c.timestamp || c.ts || c.t,
    }))
    .filter((c) => Number.isFinite(c.close));
  if (clean.length < 2) return null;
  const first = clean[0].close;
  const last = clean[clean.length - 1].close;
  if (!first) return null;
  return Number((((last - first) / first) * 100).toFixed(3));
}

function summarizeQuality(qualityData, symbol, status) {
  if (!qualityData?.summary && !qualityData?.bySymbol?.length) {
    return 'Historisk quality-data saknas för den här bedömningen.';
  }
  const symbolRow = (qualityData.bySymbol || []).find((r) => r.symbol === symbol);
  const statusRow = qualityData.byStatus?.[status];
  const bestStatus = qualityData.summary?.bestStatus;
  const goodBlocks = qualityData.summary?.goodBlockCount || 0;
  const badBlocks = qualityData.summary?.badBlockCount || 0;

  if (status === 'avoid' && goodBlocks + badBlocks > 0) {
    return goodBlocks >= badBlocks
      ? 'Historiskt har liknande blockeringar ofta skyddat mot svag rörelse.'
      : 'Historiken visar att vissa blockeringar också kan missa rörelse. Granska grafen manuellt.';
  }
  const statusSv = (value) => ({
    active: 'titta manuellt',
    caution: 'försiktig bevakning',
    watch: 'bevaka',
    wait: 'vänta',
    avoid: 'jaga inte',
  }[value] || value || 'okänd status');

  if (symbolRow?.count) {
    if (bestStatus) {
      return `Historiskt har liknande lägen oftast fungerat bäst som ${statusSv(bestStatus)}. ${symbol} har ${symbolRow.count} historiska utfall.`;
    }
    return `${symbol} har ${symbolRow.count} historiska utfall, men bästa historiska status saknas.`;
  }
  if (statusRow?.count) {
    return `Historiskt har liknande lägen för ${statusSv(status)} ${statusRow.count} utfall. Bästa historiska status saknas.`;
  }
  return 'Quality-data finns, men saknar tydlig historik för symbolen och statusen.';
}

function suggestedStatusFromVerdict(verdict) {
  if (verdict === 'Titta manuellt') return 'active';
  if (verdict === 'Bevaka') return 'watch';
  if (verdict === 'Vänta') return 'wait';
  if (verdict === 'Jaga inte') return 'avoid';
  return 'unknown';
}

function statusLooksReasonable(status, suggestedStatus, context) {
  if (context.dataFreshness === 'MARKET_CLOSED') return ['wait', 'watch', 'unknown'].includes(status);
  if (context.dataFreshness === 'STALE') return status === 'unknown' || status === 'stale' || status === 'avoid';
  if (context.hardBlockers.length) return status === 'avoid';
  if (context.twoMinuteConflict) return status === 'wait' || status === 'watch' || status === 'caution';
  if (suggestedStatus === 'active') return status === 'active' || status === 'watch' || status === 'caution';
  if (suggestedStatus === 'watch') return status === 'watch' || status === 'caution';
  return status === suggestedStatus;
}

function buildSignalAnalysisContext(candidate, qualityData = null, candles = []) {
  const tfAgreement = candidate?.timeframeAgreement || candidate?.timeframes || {};
  const tf2m = candidate?.tf2m || tfAgreement.tf2m || 'unknown';
  const candleScore2m = candidate?.candleScore2m || candidate?.tfDebug?.candleScore2m || null;
  const freshness = dataFreshness(candidate);

  return {
    symbol: candidate?.symbol || null,
    status: candidate?.status || candidate?.priority || 'unknown',
    nextMoveBias: candidate?.nextMoveBias || 'UNCERTAIN',
    confidenceScore: clamp(candidate?.confidenceScore, 0, 100),
    agreementCount: Number(candidate?.agreementCount || 0),
    timeframeAgreement: tfAgreement,
    tf2m,
    candleScore2m,
    twoMinuteConflict: candidate?.twoMinuteConflict === true || candleOpposes(tf2m, candleScore2m),
    hardBlockers: asArray(candidate?.hardBlockers),
    softBlockers: asArray(candidate?.softBlockers),
    extensionLevel: candidate?.extensionLevel || 'none',
    dataFreshness: freshness,
    dataAgeSeconds: candidate?.dataAgeSeconds ?? candidate?.tfDebug?.dataAgeSeconds ?? null,
    marketType: candidate?.marketType || candidate?.market || null,
    primaryReason: candidate?.primaryReason || candidate?.decisionTextSv || candidate?.explanationSv?.sees || '',
    signalFamily: candidate?.signalFamily || candidate?.signal || 'NO_SIGNAL',
    signalSubtype: candidate?.signalSubtype || null,
    qualityData,
    candles: candles || [],
    latestMovePct: latestMoveFromCandles(candles),
    currentDecisionTextSv: candidate?.decisionTextSv || '',
  };
}

function candleScoreText(candleScore2m) {
  const dir = candleScore2m?.scoreDirection || 'unknown';
  if (dir === 'bullish') return 'Senaste 2m-candles visar kort styrka.';
  if (dir === 'bearish') return 'Senaste 2m-candles visar kort svaghet.';
  if (dir === 'neutral') return 'Senaste 2m-candles är blandade.';
  return null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function baseAnalyst(context) {
  const support = [];
  const warns = [];
  const missing = [];
  const sees = [];

  sees.push(`Status: ${context.status}.`);
  sees.push(`Bias: ${biasSv(context.nextMoveBias)}.`);
  sees.push(`Timeframe-stöd: ${context.agreementCount}/6.`);
  sees.push(`2m-riktning: ${directionSv(context.tf2m)}.`);
  if (context.signalFamily) sees.push(`Signalfamilj: ${context.signalFamily}.`);
  if (context.signalSubtype) sees.push(`Subtype: ${context.signalSubtype}.`);
  if (context.dataAgeSeconds != null) sees.push(`Dataålder: ${context.dataAgeSeconds} sekunder.`);
  if (context.primaryReason) sees.push(context.primaryReason);

  if (context.agreementCount >= 5) support.push('Flera tidsramar håller med.');
  if (directed(context.tf2m)) support.push(`2m är riktad ${directionSv(context.tf2m)}.`);
  const candleText = candleScoreText(context.candleScore2m);
  if (candleText) sees.push(candleText);
  if (candleText && candleAlignsBias(context.nextMoveBias, context.candleScore2m)) {
    support.push(candleText);
  } else if (context.candleScore2m?.scoreDirection === 'neutral' || candleOpposes(context.tf2m, context.candleScore2m)) {
    warns.push(candleText);
  }
  if (context.candleScore2m?.reasonSv && candleAlignsBias(context.nextMoveBias, context.candleScore2m)) {
    support.push(context.candleScore2m.reasonSv);
  } else if (context.candleScore2m?.reasonSv && (context.candleScore2m?.scoreDirection === 'neutral' || candleOpposes(context.tf2m, context.candleScore2m))) {
    warns.push(context.candleScore2m.reasonSv);
  }

  if (context.agreementCount <= 3) warns.push('Tidsramarna är splittrade.');
  if (context.hardBlockers.length) warns.push(...context.hardBlockers);
  if (context.softBlockers.length) warns.push(...context.softBlockers);
  if (context.twoMinuteConflict) warns.push('Senaste 2m-candles säger emot riktningen.');
  if (['medium', 'extreme'].includes(context.extensionLevel)) warns.push('Rörelsen är sen eller utsträckt.');
  if (context.dataFreshness === 'MARKET_CLOSED') warns.push('Aktiemarknaden är stängd. Ingen livebedömning görs.');
  else if (context.dataFreshness === 'STALE') warns.push('Data är gammal.');

  if (!directed(context.tf2m)) missing.push('2m ger inte tydlig bekräftelse.');
  if (context.agreementCount < 4) missing.push('Mer stöd från högre tidsramar saknas.');
  if (!context.candles?.length) missing.push('Live candles saknas.');
  if (!missing.length) missing.push('Bekräftelse saknas inte tydligt, men grafen bör granskas manuellt.');

  return {
    sees: unique(sees),
    support: unique(support),
    warns: unique(warns),
    missing: unique(missing),
  };
}

function verdictForStrongContext(context) {
  const statusAllowsManual = context.status === 'active' || context.confidenceScore >= 75;
  const riskIsLow = !context.softBlockers.length && context.extensionLevel === 'none';
  return riskIsLow && statusAllowsManual ? 'Titta manuellt' : 'Bevaka';
}

function buildSpecificSummary(context, verdict) {
  if (context.dataFreshness === 'MARKET_CLOSED') {
    return 'Aktiemarknaden är stängd. Systemet visar senaste handelspass men gör ingen livebedömning.';
  }
  if (context.dataFreshness === 'STALE') {
    return 'Datan är gammal. Systemet kan inte göra en livebedömning förrän dataflödet är friskt.';
  }
  if (context.hardBlockers.length || context.extensionLevel === 'extreme') {
    const reason = context.hardBlockers[0] || 'rörelsen är för långt gången';
    return `Systemet stoppar läget: ${reason}.`;
  }
  if (context.twoMinuteConflict) {
    return 'Större tidsramar håller med, men senaste 2m-candles säger emot. Vänta på ny 2m-bekräftelse.';
  }
  const candleText = candleScoreText(context.candleScore2m);
  if (verdict === 'Bevaka' || verdict === 'Titta manuellt') {
    const riskPart = context.softBlockers.length
      ? ` Varning finns: ${context.softBlockers[0]}.`
      : '';
    return `${context.agreementCount}/6 tidsramar håller med och 2m är ${directionSv(context.tf2m)}.${candleText ? ` ${candleText}` : ''}${riskPart}`;
  }
  if (context.agreementCount <= 3) {
    return `Tidsramarna är splittrade (${context.agreementCount}/6) och 2m är ${directionSv(context.tf2m)}. Vänta på renare stöd.`;
  }
  if (!directed(context.tf2m)) {
    return `Större bild räcker inte ensam: 2m är ${directionSv(context.tf2m)} och bekräftelse saknas.`;
  }
  if (context.softBlockers.length) {
    return `Läget har visst stöd, men varningen "${context.softBlockers[0]}" gör att systemet väntar.`;
  }
  return `Systemet väntar: ${context.agreementCount}/6 tidsramar håller med och senaste 2m-läget är inte tillräckligt rent.`;
}

function buildTimingAssessment(context) {
  if (context.extensionLevel === 'mild') return 'Rörelsen har gått en bit, men är inte extremt utsträckt.';
  if (context.extensionLevel === 'medium') return 'Rörelsen är långt gången. Tajmingen är känslig.';
  if (context.extensionLevel === 'extreme') return 'Rörelsen är för långt gången. Systemet vill inte jaga.';

  const latestMove = context.latestMovePct;
  if (latestMove == null) {
    return 'Live candles saknas, så tajming kan inte bedömas från senaste candles.';
  }
  const moveText = `Senaste candles visar ${latestMove >= 0 ? '+' : ''}${latestMove}%.`;
  if (Math.abs(latestMove) > 0.8) return `${moveText} Rörelsen har redan gått en bit.`;
  return `${moveText} Tajmingen ser inte extrem ut, men kräver manuell grafgranskning.`;
}

function buildRiskAssessment(context) {
  if (context.dataFreshness === 'MARKET_CLOSED') {
    return 'Ingen livebedömning görs när aktiemarknaden är stängd.';
  }
  if (context.hardBlockers.length) {
    return `Primär risk: ${context.hardBlockers[0]}.`;
  }
  if (context.softBlockers.length) {
    return `Risk finns, men den är inte klassad som hård blockering. Första varning: ${context.softBlockers[0]}.`;
  }
  if (context.dataFreshness === 'UNKNOWN') {
    return 'Ingen hård blockerare syns, men datafräschhet är okänd.';
  }
  return 'Ingen hård blockerare syns i analyst-context.';
}

function buildNextImprovement(context) {
  const blockers = [...context.hardBlockers, ...context.softBlockers].join(' ').toLowerCase();
  if (context.dataFreshness === 'MARKET_CLOSED') return 'Vänta tills marknaden öppnar och dataflödet är live.';
  if (context.dataFreshness === 'STALE') return 'Behöver friskare dataflöde.';
  if (!directed(context.tf2m) || context.twoMinuteConflict) return 'Behöver tydligare 2m-bekräftelse.';
  if (['mild', 'medium', 'extreme'].includes(context.extensionLevel) || /långt|gått en bit|nivå|price/.test(blockers)) {
    return 'Behöver rekyl närmare bra nivå.';
  }
  if (/ryckig|chopp/.test(blockers)) return 'Behöver mindre ryckig marknad.';
  if (context.agreementCount <= 3) return 'Behöver tydligare stöd från fler tidsramar.';
  return 'Behöver tydligare 2m-bekräftelse.';
}

function generateRuleBasedAnalystSummary(context) {
  const { sees, support, warns, missing } = baseAnalyst(context);
  let verdict = 'Kan inte bedöma';
  let summarySv = 'Data saknas eller läget är oklart.';
  let confidence = Math.min(context.confidenceScore || 0, 45);

  if (context.dataFreshness === 'STALE') {
    verdict = 'Kan inte bedöma';
    confidence = 10;
  } else if (context.dataFreshness === 'MARKET_CLOSED') {
    verdict = 'Kan inte bedöma';
    confidence = 10;
  } else if (context.hardBlockers.length || context.extensionLevel === 'extreme') {
    verdict = 'Jaga inte';
    confidence = Math.max(55, Math.min(context.confidenceScore, 80));
  } else if (context.twoMinuteConflict) {
    verdict = 'Vänta';
    confidence = Math.max(45, Math.min(context.confidenceScore, 70));
  } else if (context.agreementCount >= 5 && directed(context.tf2m) && !candleOpposes(context.tf2m, context.candleScore2m)) {
    verdict = verdictForStrongContext(context);
    confidence = Math.max(60, Math.min(context.confidenceScore, 88));
  } else {
    verdict = 'Vänta';
    confidence = Math.max(context.status === 'avoid' ? 50 : 35, Math.min(context.confidenceScore, context.status === 'avoid' ? 78 : 65));
  }

  summarySv = buildSpecificSummary(context, verdict);
  const timingAssessmentSv = buildTimingAssessment(context);
  const riskAssessmentSv = buildRiskAssessment(context);
  const nextImprovementSv = buildNextImprovement(context);

  const analyst = {
    verdict,
    confidence,
    summarySv,
    whatSystemSees: sees.slice(0, 5),
    whatSupports: support.length ? support.slice(0, 5) : ['Inget tydligt extra stöd i context.'],
    whatWarns: warns.length ? warns.slice(0, 5) : ['Ingen stor varning syns i context.'],
    missingConfirmation: missing.slice(0, 5),
    historicalContextSv: summarizeQuality(context.qualityData, context.symbol, context.status),
    timingAssessmentSv,
    riskAssessmentSv,
    nextImprovementSv,
    suggestedStatus: context.dataFreshness === 'MARKET_CLOSED' ? 'wait' : suggestedStatusFromVerdict(verdict),
    currentStatusLooksReasonable: statusLooksReasonable(
      context.status,
      context.dataFreshness === 'MARKET_CLOSED' ? 'wait' : suggestedStatusFromVerdict(verdict),
      context,
    ),
    actionLanguageSafe: true,
    mode: 'rule_based',
    modeLabel: 'AI-läge: regelbaserad analys',
  };

  return sanitizeAnalyst(analyst);
}

async function optionallyGenerateAiSummary(context) {
  return generateRuleBasedAnalystSummary(context);
}

module.exports = {
  buildSignalAnalysisContext,
  generateRuleBasedAnalystSummary,
  optionallyGenerateAiSummary,
};
