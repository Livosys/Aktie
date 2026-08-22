import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiFactoryDecision,
  uiFactoryReason,
  uiFactorySafeText,
  uiStatus,
  uiStrategyName,
} from './uiTerminologyService.js';

const FALLBACKS = Object.freeze({
  waiting: 'AI väntar på mer information.',
  noLearnings: 'Inga nya lärdomar ännu.',
  noTests: 'Inga tester pågår just nu.',
  noApproval: 'AI behöver inget godkännande just nu.',
  noResult: 'AI väntar på mer information.',
  noAction: 'Inget nytt att göra.',
  noStrategy: 'strategin',
  noMarket: 'marknaden',
  noSystem: 'Systemet visar inget nytt ännu.',
});

function clean(value, fallback = '') {
  const text = uiFactorySafeText(value);
  return text || fallback;
}

function clause(value) {
  const text = clean(value);
  if (!text) return '';
  return text.replace(/[.。！？!?]+$/g, '').trim();
}

function sentence(text, fallback = FALLBACKS.waiting) {
  const cleanText = clean(text, '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return fallback;
  return /[.。!?]$/.test(cleanText) ? cleanText : `${cleanText}.`;
}

function strategyLabel(value, fallback = FALLBACKS.noStrategy) {
  return clean(uiStrategyName(value, ''), fallback);
}

function marketLabel(value, fallback = FALLBACKS.noMarket) {
  if (!value) return fallback;
  if (typeof value === 'string') return clean(value, fallback);
  if (typeof value === 'object') {
    return clean(
      value.regimeKey
      || value.marketDnaHash
      || value.marketType
      || value.classification
      || value.symbol
      || value.name,
      fallback,
    );
  }
  return fallback;
}

function reasonText(value, fallback = FALLBACKS.waiting) {
  const text = clean(uiFactoryReason(value), '');
  if (!text) return fallback;
  return sentence(text, fallback);
}

function actionNext(action, fallback = FALLBACKS.noAction) {
  const text = clean(uiFactoryDecision(action)?.next, '');
  return text || fallback;
}

function statusName(status) {
  return uiStatus(status || FACTORY_STATUS_KEYS.WAITING) || uiStatus(FACTORY_STATUS_KEYS.WAITING);
}

export function aiStoryWaiting(reason) {
  return sentence(
    reason ? `AI väntar eftersom ${clause(reason)}` : FALLBACKS.waiting,
    FALLBACKS.waiting,
  );
}

export function aiStoryNoLearnings() {
  return FALLBACKS.noLearnings;
}

export function aiStoryNoTests() {
  return FALLBACKS.noTests;
}

export function aiStoryNoApproval() {
  return FALLBACKS.noApproval;
}

export function aiStoryNoResult() {
  return FALLBACKS.noResult;
}

export function aiStoryCannotContinue(reason) {
  return sentence(
    reason ? `AI kunde inte fortsätta därför att ${clause(reason)}` : 'AI kunde inte fortsätta därför att något saknas',
    FALLBACKS.waiting,
  );
}

export function aiStoryMarketChanged(value) {
  const market = marketLabel(value);
  return sentence(
    market && market !== FALLBACKS.noMarket
      ? `Marknaden förändrades. Nu ser vi ${market}`
      : 'Marknaden förändrades',
    FALLBACKS.waiting,
  );
}

export function aiStoryLearned(value) {
  const text = clause(value);
  return sentence(
    text ? `AI lärde sig ${text}` : FALLBACKS.noLearnings,
    FALLBACKS.noLearnings,
  );
}

export function aiStoryImproved(value, strategy) {
  const strategyText = strategyLabel(strategy);
  const reason = clause(value);
  if (!reason && strategyText === FALLBACKS.noStrategy) return sentence('Strategin förbättrades');
  return sentence(`Strategin förbättrades${reason ? ` eftersom ${reason}` : ''}${strategyText ? ` för ${strategyText}` : ''}`, FALLBACKS.waiting);
}

export function aiStorySentForward(value) {
  const text = strategyLabel(value);
  return sentence(text && text !== FALLBACKS.noStrategy ? `AI skickar vidare ${text}` : 'AI skickar vidare nästa steg', FALLBACKS.waiting);
}

export function aiStoryNeedsApproval(value) {
  const text = strategyLabel(value);
  return sentence(text && text !== FALLBACKS.noStrategy ? `AI behöver ditt godkännande för ${text}` : 'AI behöver ditt godkännande', FALLBACKS.waiting);
}

export function aiStoryTesting(value) {
  const text = strategyLabel(value);
  return sentence(text && text !== FALLBACKS.noStrategy ? `AI testar nu ${text}` : 'AI testar nu nästa strategi', FALLBACKS.waiting);
}

export function aiStoryPaperStarted(value) {
  const text = strategyLabel(value);
  return sentence(text && text !== FALLBACKS.noStrategy ? `${text} går nu i Paper Trading` : 'Paper Trading startade', FALLBACKS.waiting);
}

export function aiStoryApproved(value) {
  const text = strategyLabel(value);
  return sentence(text && text !== FALLBACKS.noStrategy ? `${text} är godkänd` : 'Strategin är godkänd', FALLBACKS.waiting);
}

export function aiStoryStrategySummary(strategy = {}) {
  const name = strategyLabel(strategy.strategyId || strategy.id || strategy.name);
  const status = statusName(strategy.status || strategy.lifecycle);
  const result = clean(strategy.latestResult || strategy.summary || strategy.result, '');
  const next = clean(strategy.nextStep || strategy.next || '', '');
  const learning = clean(strategy.learning || strategy.insight || '', '');

  return {
    title: name,
    summary: result ? sentence(`${name} är ${status.toLowerCase()}. ${result}`) : sentence(`${name} är ${status.toLowerCase()}`),
    detail: learning || FALLBACKS.noLearnings,
    next: next || (status === uiStatus(FACTORY_STATUS_KEYS.COMPLETED) ? 'AI följer resultatet vidare.' : FALLBACKS.waiting),
    story: result ? sentence(`${name} fungerar så här: ${result}`) : sentence(`${name} väntar på mer information`),
  };
}

export function aiStoryTestSummary(test = {}) {
  const strategy = strategyLabel(test.strategyId || test.strategy || test.name);
  const result = clean(test.result || test.latestResult || test.summary || '', '');
  const learning = clean(test.learning || test.note || '', '');
  const next = clean(test.nextStep || test.next || '', '');
  const status = statusName(test.status || test.state || test.lifecycle);

  return {
    title: strategy,
    summary: result ? sentence(`Testet för ${strategy} är ${status.toLowerCase()}. ${result}`) : sentence(`Testet för ${strategy} är ${status.toLowerCase()}`),
    detail: learning || FALLBACKS.noLearnings,
    next: next || FALLBACKS.waiting,
    story: result ? sentence(`AI lärde sig ${result.toLowerCase ? result.toLowerCase() : result}`) : FALLBACKS.noTests,
  };
}

export function aiStoryJournalRow(row = {}) {
  const strategy = strategyLabel(row.strategyId || row.strategy);
  const market = marketLabel(row.marketDnaHash || row.market || row.marketId);
  const result = clean(row.result || row.learning || row.recommendation, '');
  const reason = clean(row.why || row.reason, '');
  const next = clean(row.next || row.nextStep, '');
  const action = row.action || row.recommendationAction || null;

  return {
    title: strategy,
    summary: result ? sentence(`AI valde ${strategy}. ${result}`) : sentence(`AI valde ${strategy}`),
    detail: reason ? sentence(reason) : FALLBACKS.waiting,
    next: next || actionNext(action, FALLBACKS.noAction),
    story: market && market !== FALLBACKS.noMarket ? sentence(`AI såg ${market} när ${strategy} granskades`) : sentence(`AI granskade ${strategy}`),
  };
}

export function aiStoryPaperStatus(context = {}) {
  const strategy = strategyLabel(context.strategyId || context.strategy);
  const result = clean(context.result || context.dailyResult || context.pnl, '');
  const reason = clean(context.reason || context.blocker || context.status, '');
  const waiting = Boolean(context.waiting);
  const approval = Number(context.approvalCount || 0);

  if (reason && !waiting && context.degraded) {
    return {
      headline: aiStoryCannotContinue(reason),
      why: aiStoryCannotContinue(reason),
      next: 'Kontrollera brokerstatus.',
      state: 'Problem',
    };
  }
  if (approval > 0) {
    return {
      headline: aiStoryNeedsApproval(strategy),
      why: sentence(`Det finns ${approval} saker att granska`),
      next: 'Öppna godkännande.',
      state: 'Väntar',
    };
  }
  if (waiting) {
    return {
      headline: aiStoryWaiting(reason || FALLBACKS.waiting),
      why: aiStoryWaiting(reason || FALLBACKS.waiting),
      next: FALLBACKS.waiting,
      state: 'Väntar',
    };
  }
  if (result) {
    return {
      headline: sentence(`AI följde ${strategy} och resultatet blev ${result}`),
      why: sentence(`Dagens läge sammanfattar ${strategy}`),
      next: 'Följ nästa steg.',
      state: 'Körs',
    };
  }
  return {
    headline: FALLBACKS.noResult,
    why: FALLBACKS.noResult,
    next: FALLBACKS.noAction,
    state: 'Redo',
  };
}

export function aiStorySystemStatus(system = {}) {
  const overall = clean(system.overallStatus || system.status || '', '');
  const summary = clean(system.summarySv || system.summary || '', '');
  const components = Array.isArray(system.components) ? system.components : [];
  const broken = components.filter((item) => String(item?.status || '').toUpperCase() === 'BROKEN').length;
  const warning = components.filter((item) => String(item?.status || '').toUpperCase() === 'STALE' || String(item?.status || '').toUpperCase() === 'DISABLED').length;

  if (broken > 0) {
    return {
      headline: sentence(`AI kunde inte fortsätta därför att ${broken} delar behöver ses över`),
      subline: summary || FALLBACKS.noSystem,
      why: sentence(`Det finns ${broken} fel att granska`),
      next: 'Öppna systemet.',
    };
  }
  if (warning > 0) {
    return {
      headline: sentence(`AI väntar eftersom ${warning} delar är långsamma`),
      subline: summary || FALLBACKS.noSystem,
      why: sentence(`Det finns ${warning} varningar i systemet`),
      next: 'Öppna systemet.',
    };
  }
  return {
    headline: sentence(overall ? `AI arbetar och systemet är ${overall.toLowerCase()}` : 'AI arbetar'),
    subline: summary || 'Systemet visar ett stabilt läge.',
    why: summary || FALLBACKS.noSystem,
    next: 'Fortsätt till nästa steg.',
  };
}

export function aiStoryEventText(kind, input = {}) {
  const strategy = strategyLabel(input.strategy || input.strategyId || input.name || input.title);
  const market = marketLabel(input.market || input.marketPeriod || input.marketId || input.marketDnaHash);
  const reason = clause(input.reason || input.detail || input.message || input.summary || input.why);
  const result = clean(input.result || input.learning || input.outcome || input.summary, '');

  switch (kind) {
    case 'historyImported':
      return market && market !== FALLBACKS.noMarket ? sentence(`Marknaden förändrades. Nu ser vi ${market}`) : sentence('Marknaden förändrades');
    case 'opportunityFound':
      return sentence(strategy && strategy !== FALLBACKS.noStrategy ? `AI hittade en möjlighet för ${strategy}` : 'AI hittade en möjlighet');
    case 'testStarted':
      return aiStoryTesting(strategy);
    case 'testCompleted':
      return result ? sentence(`Historiskt test klart: ${result}`) : sentence(`Historiskt test klart för ${strategy || 'senaste testet'}`);
    case 'learned':
      return result ? sentence(`AI lärde sig ${result}`) : FALLBACKS.noLearnings;
    case 'improved':
      return aiStoryImproved(reason || result || input.change, strategy);
    case 'promoted':
      return aiStorySentForward(strategy);
    case 'approved':
      return aiStoryApproved(strategy);
    case 'paperStarted':
      return aiStoryPaperStarted(strategy);
    case 'waiting':
      return aiStoryWaiting(reason);
    case 'cannotContinue':
      return aiStoryCannotContinue(reason);
    default:
      return sentence(reason || result || input.text || FALLBACKS.waiting);
  }
}

export function aiStoryFactory(snapshot = {}) {
  const strategy = strategyLabel(
    snapshot.strategyId
    || snapshot.nextReplay?.strategyId
    || snapshot.latestRunningJob?.strategyId
    || snapshot.latestRunningJob?.strategy?.id
    || snapshot.latestWaitingJob?.strategyId
    || snapshot.latestWaitingJob?.strategy?.id
    || snapshot.candidateEntry?.row?.strategyId
    || snapshot.paperEntry?.row?.strategyId,
  );
  const market = marketLabel(
    snapshot.marketPeriod?.row
    || snapshot.nextReplay?.targetRegime
    || snapshot.nextReplay?.marketDnaHash
    || snapshot.decision?.evidence?.marketDnaHash
    || snapshot.decision?.evidence?.nextReplay?.targetRegime
    || snapshot.decision?.evidence?.nextReplay?.marketDnaHash,
  );
  const reason = clean(
    snapshot.decision?.reason
    || snapshot.latestWaitingJob?.reason
    || snapshot.latestRunningJob?.reason
    || snapshot.nextReplay?.reason
    || snapshot.brain?.reason
    || snapshot.brain?.nextReason
    || '',
    '',
  );
  const factoryState = snapshot.factoryStatus || FACTORY_STATUS_KEYS.WAITING;
  const running = Boolean(snapshot.latestRunningJob);
  const waiting = Boolean(snapshot.latestWaitingJob);
  const approval = Boolean(snapshot.candidateEntry?.row || snapshot.decision?.action === 'REQUEST_APPROVAL_SERVICE' || snapshot.paperEntry?.row);
  const learning = Boolean(snapshot.latestLearning?.row);
  const failed = factoryState === FACTORY_STATUS_KEYS.FAILED || factoryState === FACTORY_STATUS_KEYS.PAUSED;

  if (failed) {
    return {
      headline: aiStoryCannotContinue(reason || snapshot.decision?.reason || FALLBACKS.noSystem),
      subline: market && market !== FALLBACKS.noMarket ? sentence(`Marknaden ser ${market}`) : FALLBACKS.waiting,
      why: reasonText(reason || snapshot.decision?.reason || FALLBACKS.noSystem),
      next: 'Kontrollera systemet.',
      state: uiStatus(factoryState),
      tone: 'warning',
      updatedAt: snapshot.refreshTime || '',
    };
  }

  if (running) {
    return {
      headline: aiStoryTesting(strategy),
      subline: market && market !== FALLBACKS.noMarket ? sentence(`Marknaden ser ${market}`) : 'AI använder befintlig historik.',
      why: reason ? reasonText(reason) : FALLBACKS.waiting,
      next: learning ? 'AI lär sig av resultatet.' : 'AI väntar på resultat.',
      state: uiStatus(factoryState),
      tone: 'info',
      updatedAt: snapshot.refreshTime || '',
    };
  }

  if (approval) {
    return {
      headline: aiStoryNeedsApproval(strategy),
      subline: market && market !== FALLBACKS.noMarket ? sentence(`Marknaden ser ${market}`) : 'AI har hittat en möjlig strategi.',
      why: reason ? reasonText(reason) : 'AI vill att du granskar underlaget.',
      next: 'Öppna godkännande.',
      state: uiStatus(factoryState),
      tone: 'warning',
      updatedAt: snapshot.refreshTime || '',
    };
  }

  if (waiting) {
    return {
      headline: aiStoryWaiting(reason || FALLBACKS.waiting),
      subline: market && market !== FALLBACKS.noMarket ? sentence(`Marknaden ser ${market}`) : FALLBACKS.waiting,
      why: reason ? reasonText(reason) : FALLBACKS.waiting,
      next: 'AI väntar på mer information.',
      state: uiStatus(factoryState),
      tone: 'neutral',
      updatedAt: snapshot.refreshTime || '',
    };
  }

  if (learning) {
    return {
      headline: sentence(`AI lärde sig något av ${strategy}`),
      subline: sentence(`Senaste resultatet är klart`),
      why: aiStoryLearned(snapshot.latestLearning?.row?.why?.summary || snapshot.latestLearning?.row?.reason || snapshot.latestLearning?.row?.recommendedNextAction || snapshot.latestLearning?.row?.action || FALLBACKS.noLearnings),
      next: snapshot.paperEntry?.row ? 'Strategin kan nu granskas.' : 'AI letar vidare.',
      state: uiStatus(factoryState),
      tone: 'success',
      updatedAt: snapshot.refreshTime || '',
    };
  }

  return {
    headline: FALLBACKS.waiting,
    subline: market && market !== FALLBACKS.noMarket ? sentence(`Marknaden ser ${market}`) : FALLBACKS.noLearnings,
    why: FALLBACKS.waiting,
    next: FALLBACKS.noAction,
    state: uiStatus(factoryState),
    tone: 'neutral',
    updatedAt: snapshot.refreshTime || '',
  };
}

export function aiStoryFactoryActivity(snapshot = {}) {
  return [
    snapshot.latestRunningJob ? {
      id: 'running',
      title: aiStoryEventText('testStarted', { strategyId: snapshot.latestRunningJob?.strategyId || snapshot.latestRunningJob?.strategy?.id }),
      detail: aiStoryEventText('testStarted', {
        strategyId: snapshot.latestRunningJob?.strategyId || snapshot.latestRunningJob?.strategy?.id,
        reason: snapshot.latestRunningJob?.reason,
      }),
      time: snapshot.latestRunningJob.started_at || snapshot.latestRunningJob.updated_at || snapshot.latestRunningJob.created_at || snapshot.lastRefreshAt || '',
      href: '/factory/replay',
      tone: 'info',
    } : null,
    snapshot.latestReplay?.row ? {
      id: 'replay',
      title: aiStoryEventText('testCompleted', {
        strategyId: snapshot.latestReplay?.row?.strategyId,
        result: snapshot.latestReplay?.row?.result || snapshot.latestReplay?.row?.summary,
      }),
      detail: aiStoryEventText('testCompleted', {
        result: snapshot.latestReplay?.row?.result || snapshot.latestReplay?.row?.summary,
      }),
      time: snapshot.latestReplay.stamp?.value || '',
      href: '/factory/replay',
      tone: 'success',
    } : null,
    snapshot.candidateEntry?.row ? {
      id: 'candidate',
      title: aiStorySentForward(snapshot.candidateEntry?.row?.strategyId),
      detail: aiStorySentForward(snapshot.candidateEntry?.row?.strategyId),
      time: snapshot.candidateEntry.stamp?.value || '',
      href: '/factory/library',
      tone: 'warning',
    } : null,
    snapshot.paperEntry?.row ? {
      id: 'paper',
      title: aiStoryPaperStarted(snapshot.paperEntry?.row?.strategyId),
      detail: aiStoryPaperStarted(snapshot.paperEntry?.row?.strategyId),
      time: snapshot.paperEntry.stamp?.value || '',
      href: '/futures-paper',
      tone: 'success',
    } : null,
    snapshot.marketPeriod?.row ? {
      id: 'market',
      title: aiStoryEventText('historyImported', { market: snapshot.marketPeriod?.row }),
      detail: aiStoryMarketChanged(snapshot.marketPeriod?.row),
      time: snapshot.marketPeriod.stamp?.value || '',
      href: '/system?tab=providers',
      tone: 'success',
    } : null,
    snapshot.latestLearning?.row ? {
      id: 'learning',
      title: aiStoryLearned(snapshot.latestLearning?.row?.reason || snapshot.latestLearning?.row?.recommendedNextAction || snapshot.latestLearning?.row?.action),
      detail: aiStoryLearned(snapshot.latestLearning?.row?.reason || snapshot.latestLearning?.row?.recommendedNextAction || snapshot.latestLearning?.row?.action),
      time: snapshot.latestLearning.stamp?.value || '',
      href: '/decision-journal',
      tone: 'success',
    } : null,
    snapshot.latestImprovement?.row ? {
      id: 'improvement',
      title: aiStoryImproved(snapshot.latestImprovement?.row?.reason || snapshot.latestImprovement?.row?.mutationType, snapshot.latestImprovement?.row?.strategyId),
      detail: aiStoryImproved(snapshot.latestImprovement?.row?.reason || snapshot.latestImprovement?.row?.mutationType, snapshot.latestImprovement?.row?.strategyId),
      time: snapshot.latestImprovement.stamp?.value || '',
      href: '/factory/library',
      tone: 'info',
    } : null,
  ].filter(Boolean).map((item) => ({
    ...item,
    kind: item.id,
    title: clean(item.title, FALLBACKS.noAction),
    detail: clean(item.detail, FALLBACKS.noAction),
    badge: item.tone === 'success' ? 'Klar' : item.tone === 'warning' ? 'Väntar' : 'AI',
    time: item.time,
  }));
}
