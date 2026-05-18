'use strict';

const MEMORY_PER_SYMBOL = 50;

// Map<symbol, Array<memoryEntry>>  — lives in process RAM, reset on restart
const _history = new Map();

const WAIT_SIGNALS    = new Set(['WAIT', 'NO_TRADE', 'NARROW_WAIT', null, undefined]);
const TRIGGER_SIGNALS = new Set(['LONG_TRIGGERED', 'SHORT_TRIGGERED']);

// Snapshot the fields we need for transition detection
function cloneSnapshot(r) {
  return {
    timestamp:               new Date().toISOString(),
    symbol:                  r.symbol,
    price:                   r.price                    ?? null,
    state:                   r.state                    ?? null,
    signal:                  r.signal                   ?? null,
    eventType:               r.eventType                ?? null,
    narrowType:              r.narrowType               ?? 'none',
    narrowScore:             r.narrowScore              ?? null,
    tradeScore:              r.tradeScore               ?? 0,
    scoreLabel:              r.scoreLabel               ?? null,
    marketRegime:            r.marketRegime             ?? null,
    marketDirection:         r.marketDirection          ?? null,
    actionSv:                r.actionSv                 ?? null,
    reasonSv:                r.reasonSv                 ?? null,
    scoreExplanationSv:      r.scoreExplanationSv       ?? null,
    scores:                  r.scores                   ?? null,
    priceToZoneAtr:          r.priceToZoneAtr           ?? null,
    smaGapAtr:               r.smaGapAtr                ?? null,
    tfsActive:               !!(r.threeFingerSpread || {}).active,
    breakoutAlreadyOccurred: !!r.breakoutAlreadyOccurred,
  };
}

function calcTransition(prev, cur) {
  const prevScore  = prev.tradeScore                 ?? 0;
  const curScore   = cur.tradeScore                  ?? 0;
  const scoreDelta = curScore - prevScore;
  const prevNarrow = prev.narrowType                 ?? 'none';
  const curNarrow  = cur.narrowType                  ?? 'none';
  const prevSignal = prev.signal                     ?? null;
  const curSignal  = cur.signal                      ?? null;
  const boc        = cur.breakoutAlreadyOccurred     || false;
  const tfsActive  = cur.tfsActive                   || false;

  // NEW_TRIGGER — was waiting, now a trigger signal fired (and score is decent)
  if (WAIT_SIGNALS.has(prevSignal) && TRIGGER_SIGNALS.has(curSignal) && curScore >= 40) {
    return {
      transition:          'NEW_TRIGGER',
      transitionLabelSv:   'Ny signal',
      transitionReasonSv:  `Priset har brutit triggnivå (${curSignal}).`,
    };
  }

  // TOO_LATE_NOW — score was decent but now breakout or TFS
  if (prevScore >= 40 && (boc || tfsActive)) {
    return {
      transition:          'TOO_LATE_NOW',
      transitionLabelSv:   'För sent nu',
      transitionReasonSv:  boc
        ? 'Utbrottet har redan hänt — vänta på ny setup.'
        : 'Priset är för långt från zonen (3-finger spread).',
    };
  }

  // ENTERED_NARROW — moved into a narrow zone
  if (prevNarrow === 'none' && curNarrow !== 'none') {
    return {
      transition:          'ENTERED_NARROW',
      transitionLabelSv:   'Gick in i narrow-zon',
      transitionReasonSv:  `Narrow-typ: ${curNarrow}.`,
    };
  }

  // LEFT_NARROW — moved out of a narrow zone
  if (prevNarrow !== 'none' && curNarrow === 'none') {
    return {
      transition:          'LEFT_NARROW',
      transitionLabelSv:   'Lämnade narrow-zon',
      transitionReasonSv:  'Priset rörde sig ut ur narrow-zonen.',
    };
  }

  // NEW_SETUP — score jumped from below 30 to above 40
  if (prevScore < 30 && curScore > 40) {
    return {
      transition:          'NEW_SETUP',
      transitionLabelSv:   'Nytt intressant läge',
      transitionReasonSv:  `Betyget gick från ${prevScore} till ${curScore}.`,
    };
  }

  // SETUP_IMPROVING — score increased by ≥15
  if (scoreDelta >= 15) {
    return {
      transition:          'SETUP_IMPROVING',
      transitionLabelSv:   'Läget blir bättre',
      transitionReasonSv:  `Betyget ökade med ${scoreDelta} (${prevScore} → ${curScore}).`,
    };
  }

  // SETUP_WEAKENING — score dropped by ≥15
  if (scoreDelta <= -15) {
    return {
      transition:          'SETUP_WEAKENING',
      transitionLabelSv:   'Läget blir sämre',
      transitionReasonSv:  `Betyget minskade med ${Math.abs(scoreDelta)} (${prevScore} → ${curScore}).`,
    };
  }

  return {
    transition:          'STILL_WAITING',
    transitionLabelSv:   'Fortfarande vänta',
    transitionReasonSv:  'Inga viktiga förändringar sedan förra scan.',
  };
}

const FALLBACK_TRANSITION = {
  transition:          'STILL_WAITING',
  transitionLabelSv:   'Fortfarande vänta',
  transitionReasonSv:  'Inte tillräckligt med historik än.',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Push current scan results into in-memory history.
 * Call this BEFORE attachMemory so history includes the current entry.
 */
function updateSignalMemory(scanResults) {
  for (const r of scanResults) {
    if (!r || !r.symbol) continue;
    if (!_history.has(r.symbol)) _history.set(r.symbol, []);
    const hist = _history.get(r.symbol);
    hist.push(cloneSnapshot(r));
    if (hist.length > MEMORY_PER_SYMBOL) hist.shift();
  }
}

function getSignalHistory(symbol) {
  return _history.get(symbol) || [];
}

function getPreviousResult(symbol) {
  const hist = _history.get(symbol) || [];
  return hist.length >= 2 ? hist[hist.length - 2] : null;
}

function getSignalTransition(symbol) {
  const hist = _history.get(symbol) || [];
  if (hist.length < 2) return FALLBACK_TRANSITION;
  return calcTransition(hist[hist.length - 2], hist[hist.length - 1]);
}

/**
 * Attach a `memory` object to each result.
 * Must be called AFTER updateSignalMemory.
 */
function attachMemory(results) {
  return results.map((r) => {
    try {
      const prev      = getPreviousResult(r.symbol);
      const prevScore = prev ? (prev.tradeScore ?? null) : null;
      const curScore  = r.tradeScore ?? 0;
      const trans     = getSignalTransition(r.symbol);

      return {
        ...r,
        memory: {
          previousTradeScore: prevScore,
          scoreChange:        prevScore !== null ? curScore - prevScore : null,
          transition:         trans.transition,
          transitionLabelSv:  trans.transitionLabelSv,
          transitionReasonSv: trans.transitionReasonSv,
        },
      };
    } catch (_) {
      return {
        ...r,
        memory: {
          previousTradeScore: null,
          scoreChange:        null,
          transition:         'STILL_WAITING',
          transitionLabelSv:  '–',
          transitionReasonSv: '–',
        },
      };
    }
  });
}

module.exports = { updateSignalMemory, getSignalHistory, getPreviousResult, getSignalTransition, attachMemory };
