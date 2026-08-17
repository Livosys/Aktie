'use strict';

// ── Strategy Score v1 ────────────────────────────────────────────────────────
//
// Betygsätter en strategi utifrån vad dess LOGIK presterade, mätt på affärer.
//
// Två avgränsningar som är medvetna:
//
//   · Räknas ENBART på strategyPnl, alltså expectedPrice i båda ändar. Vad
//     exekveringen kostade mäts av Execution Score och får inte blanda sig in
//     här. Annars skulle en strategi kunna se sämre ut för att spreaden var
//     bred den dagen, och en optimering mot det måttet lär sig undvika breda
//     spreadar i stället för att hitta edge.
//
//   · 65 % träffsäkerhet är en GRÄNS, inte ett betyg. Den rapporteras som en
//     egen flagga och sänker aldrig och höjer aldrig poängen på egen hand. En
//     strategi med 60 % träff och 3:1 i risk/reward är bättre än en med 70 %
//     och 1:3, och ett mått som inte kan säga det är oanvändbart.
//
// Detta är v1: fem komponenter, grova vikter, inga marknadsberoenden. Sharpe,
// återhämtning, konsistens över marknadsregimer och AI-rankning hör till v2.
// Poängen är att replay ska ha ETT mått nu, inte det slutgiltiga.
//
// Ren beräkning: ingen IO, ingen klocka.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SCORE_VERSION = 'strategy_score_v1';

const SCORE_MAX = Object.freeze({
  winRate: 30,      // hur ofta strategin har rätt
  profitFactor: 25, // hur mycket vinsterna väger mot förlusterna
  expectancy: 20,   // förväntat utfall per affär
  sample: 15,       // hur mycket vi vet — få affärer är inte ett bevis
  drawdown: 10,     // hur djupt det gick ner på vägen
});

// Golvet från beslut D2. Rapporteras, avgör inte.
const WIN_RATE_FLOOR = 65;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Poängsätter en uppsättning stängda affärer.
 *
 * @param {object[]} trades  ledger-rader med strategyPnlUsd
 */
function scoreTrades(trades = [], { strategyId = null } = {}) {
  const scored = trades.filter((row) => num(row.strategyPnlUsd) != null);

  if (!scored.length) {
    return {
      strategyId,
      total: 0,
      components: Object.fromEntries(Object.keys(SCORE_MAX).map((k) => [k, 0])),
      max: { ...SCORE_MAX },
      band: 'insufficient_data',
      stats: { trades: 0 },
      meetsWinRateFloor: false,
      winRateFloor: WIN_RATE_FLOOR,
      reason: 'no_scored_trades',
      version: SCORE_VERSION,
      ...SAFETY,
    };
  }

  const pnls = scored.map((row) => Number(row.strategyPnlUsd));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const total = pnls.reduce((a, b) => a + b, 0);
  const winRate = (wins.length / scored.length) * 100;
  const expectancy = total / scored.length;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const components = {
    // 40 % träff ger 0, 80 % ger full poäng. Skalan är linjär däremellan.
    winRate: round(SCORE_MAX.winRate * clamp((winRate - 40) / 40, 0, 1)),
    // 1,0 är break-even, 2,5 är utmärkt.
    profitFactor: round(SCORE_MAX.profitFactor * clamp(
      (Number.isFinite(profitFactor) ? profitFactor : 3) - 1,
      0, 1.5,
    ) / 1.5),
    // Förväntat utfall normerat mot genomsnittsförlusten: hur mycket tjänar
    // strategin per affär, mätt i sin egen risk.
    expectancy: round(SCORE_MAX.expectancy * clamp(
      avgLoss > 0 ? expectancy / avgLoss : (expectancy > 0 ? 1 : 0),
      0, 1,
    )),
    // 50 affärer räknas som full säkerhet. Under det vet vi mindre än vi tror.
    sample: round(SCORE_MAX.sample * clamp(scored.length / 50, 0, 1)),
    // Drawdown mätt mot bruttovinsten. Noll fall = full poäng.
    drawdown: round(SCORE_MAX.drawdown * (1 - clamp(
      grossWin > 0 ? maxDrawdown / grossWin : (maxDrawdown > 0 ? 1 : 0),
      0, 1,
    ))),
  };

  const totalScore = round(Object.values(components).reduce((a, b) => a + b, 0));

  return {
    strategyId,
    total: totalScore,
    components,
    max: { ...SCORE_MAX },
    band: totalScore >= 75 ? 'strong'
      : totalScore >= 55 ? 'promising'
        : totalScore >= 35 ? 'weak' : 'failing',
    stats: {
      trades: scored.length,
      wins: wins.length,
      losses: losses.length,
      winRate: round(winRate),
      strategyPnlUsd: round(total),
      expectancyUsd: round(expectancy),
      profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 3) : null,
      avgWinUsd: round(avgWin),
      avgLossUsd: round(avgLoss),
      maxDrawdownUsd: round(maxDrawdown),
    },
    // Gränsen från D2. Informerar, avgör inte.
    meetsWinRateFloor: winRate >= WIN_RATE_FLOOR,
    winRateFloor: WIN_RATE_FLOOR,
    reason: null,
    version: SCORE_VERSION,
    ...SAFETY,
  };
}

/** Poängsätter varje strategi för sig plus körningen som helhet. */
function scoreByStrategy(tradesByStrategy = new Map(), allTrades = []) {
  const perStrategy = [...tradesByStrategy.entries()]
    .map(([strategyId, trades]) => scoreTrades(trades, { strategyId }))
    .sort((a, b) => b.total - a.total);
  return {
    run: scoreTrades(allTrades, { strategyId: null }),
    perStrategy,
    version: SCORE_VERSION,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  SCORE_VERSION,
  SCORE_MAX,
  WIN_RATE_FLOOR,
  scoreTrades,
  scoreByStrategy,
};
