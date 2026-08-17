'use strict';

// ── Bracket-utgång ───────────────────────────────────────────────────────────
//
// En öppen position har två utgångar som konkurrerar: stop loss och target.
// Vilken som träffas först avgör affärens resultat, och den frågan hör varken
// hemma i Fill Engine (som fyller EN order) eller i strategin (som redan är
// klar när positionen öppnats).
//
// Modulen talar bara FillEngine-kontraktet. Byter man ut fyllningsmotorn —
// simulerad, Monte Carlo, en framtida IB-baserad — fungerar den oförändrad.
//
// Tre regler, alla åt det pessimistiska hållet:
//
//   1. Träffar samma bar både stop och target antas STOPPEN först. Bardata
//      säger inte i vilken ordning priset rörde sig inom minuten, och att
//      gissa till sin egen fördel är hur ett backtest börjar ljuga.
//   2. Fyller ingen av dem inom fönstret stängs positionen på sista baren.
//      En affär som "fortfarande är öppen" när datan tar slut får inte
//      räknas som en vinst.
//   3. Förväntat utgångspris är den NIVÅ strategin satte (stopLoss eller
//      takeProfit), aldrig priset ordern råkade fyllas på. Det är den
//      åtskillnaden som gör Strategy Edge mätbar skilt från Execution Edge.
//
// Ren modul: ingen IO, ingen klocka, ingen broker.

const iface = require('./fillEngineInterface');

const EXIT_REASONS = Object.freeze({
  STOP_LOSS: 'stop_loss',
  TAKE_PROFIT: 'take_profit',
  WINDOW_END: 'window_end',
  NO_DATA: 'no_data',
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fillTimeMs(result) {
  const stamp = result?.fills?.[0]?.timestamp;
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function barTime(bar) {
  return new Date(bar.ts || bar.t || bar.timestamp).getTime();
}

/**
 * Löser ut en öppen bracket-position mot efterföljande barer.
 *
 * @param {object}   position   { tradeId, symbol, side ('long'|'short'), contracts,
 *                               stopLoss, takeProfit, openedAt }
 * @param {object[]} bars       1m-barer EFTER entry, i tidsordning
 * @param {object}   fillEngine valfri implementation av FillEngine-kontraktet
 * @returns {{reason: string, exit: object}} exit i fillReportens form
 */
function resolveBracketExit(position = {}, { bars = [], fillEngine } = {}) {
  iface.assertFillEngine(fillEngine, 'bracketExitResolver.fillEngine');

  const side = String(position.side || '').toLowerCase() === 'short' ? 'short' : 'long';
  // Utgångsordern går åt motsatt håll mot positionen.
  const exitSide = side === 'short' ? 'buy' : 'sell';
  const stop = num(position.stopLoss);
  const target = num(position.takeProfit);
  const quantity = num(position.contracts) || 1;
  const timestamp = position.openedAt;

  if (!bars.length) {
    return { reason: EXIT_REASONS.NO_DATA, exit: null };
  }

  const base = {
    symbol: position.symbol,
    side: exitSide,
    quantity,
    timestamp,
  };

  const stopResult = stop == null ? null : fillEngine.fill({
    ...base,
    orderId: `${position.tradeId}:stop`,
    type: 'stop',
    stopPrice: stop,
    // Förväntat pris är NIVÅN, inte fyllningen.
    expectedPrice: stop,
  }, { bars });

  const targetResult = target == null ? null : fillEngine.fill({
    ...base,
    orderId: `${position.tradeId}:target`,
    type: 'limit',
    limitPrice: target,
    expectedPrice: target,
  }, { bars });

  const stopFilled = stopResult?.status === iface.FILL_STATUS.FILLED;
  const targetFilled = targetResult?.status === iface.FILL_STATUS.FILLED;
  const stopMs = stopFilled ? fillTimeMs(stopResult) : null;
  const targetMs = targetFilled ? fillTimeMs(targetResult) : null;

  // Regel 1: lika tid, eller bara stoppen fylld → stoppen.
  if (stopFilled && (!targetFilled || stopMs == null || targetMs == null || stopMs <= targetMs)) {
    return { reason: EXIT_REASONS.STOP_LOSS, exit: toExit(stopResult) };
  }
  if (targetFilled) {
    return { reason: EXIT_REASONS.TAKE_PROFIT, exit: toExit(targetResult) };
  }

  // Regel 2: fönstret tog slut med positionen öppen. Stäng på sista baren, och
  // låt förväntat och verkligt pris vara samma — det finns ingen nivå
  // strategin syftade på här, så ingen exekveringskostnad ska tillskrivas.
  const lastBar = bars[bars.length - 1];
  const closePrice = num(lastBar.close ?? lastBar.c);
  return {
    reason: EXIT_REASONS.WINDOW_END,
    exit: {
      expectedPrice: closePrice,
      executedPrice: closePrice,
      timestamp: new Date(barTime(lastBar)).toISOString(),
      fillDelayMs: 0,
      slippage: 0,
      spread: 0,
      status: iface.FILL_STATUS.FILLED,
      engine: fillEngine.describe?.().engine || null,
    },
  };
}

function toExit(result) {
  return {
    expectedPrice: result.expectedPrice,
    executedPrice: result.executedPrice,
    timestamp: result.fills?.[0]?.timestamp || null,
    fillDelayMs: result.fillDelayMs,
    slippage: result.slippage,
    spread: result.spread,
    status: result.status,
    engine: result.engine,
  };
}

module.exports = {
  EXIT_REASONS,
  resolveBracketExit,
};
