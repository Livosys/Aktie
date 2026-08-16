'use strict';

// ── SimulatedFillEngine ──────────────────────────────────────────────────────
//
// Historisk fyllningsmodell för replay och batch. Tar en beslutad order plus de
// 1-minutersbarer som följde efter beslutet, och avgör vad som faktiskt hade
// hänt: när ordern fylldes, till vilket pris, om den fylldes alls.
//
// STÖDER  market · limit · stop · stopLimit
// MODELLERAR  latens · spread · slippage · partiella fills · uteblivna fills
//
// DETERMINISTISK. All variation kommer ur en hash av orderns egen identitet,
// aldrig ur Math.random. Samma order och samma barer ger samma fill varje gång,
// i dag och om ett år. Det är ett krav, inte en artighet: en AI som itererar
// mot ett brusigt mått lär sig bruset. Vill man ha spridning i stället för
// reproducerbarhet finns MonteCarloFill som en egen motor — inte som ett
// slumptal insmuget här.
//
// Tre regler som är valda med flit och som alla lutar åt det pessimistiska
// hållet, eftersom ett backtest som smickrar är värre än inget backtest:
//
//   1. En marknadsorder fylls tidigast på NÄSTA bars öppning. Beslutsbarens
//      stängning var inte handelsbar när beslutet fattades.
//   2. En bar som rör både stop och target antas ha träffat stoppen först.
//   3. Slippage går alltid emot ordern.
//
// Ren modul: ingen IO, inget nätverk, ingen klocka, ingen broker.

const iface = require('./fillEngineInterface');

const ENGINE = 'simulated_fill';

const DEFAULT_CONFIG = Object.freeze({
  tickSize: 0.25,
  // Slippage uttryckt i ticks. 0 = av.
  slippageTicks: 1,
  slippageEnabled: true,
  // Halva spreaden betalas vid varje sida. 1 tick spread är typiskt för
  // MNQ/MES i normal likviditet.
  spreadTicks: 1,
  spreadEnabled: true,
  // Latens mellan beslut och att ordern når marknaden.
  latencyMs: 250,
  latencyEnabled: true,
  // Andel av ordrar som får en partiell fill. 0 = av.
  partialFillRate: 0,
  // Andel av marknadsordrar som inte fylls alls (t.ex. halt). 0 = av.
  noFillRate: 0,
  // Hur många barer framåt en vilande order lever innan den räknas som ofylld.
  maxBarsToFill: 120,
});

// ── deterministisk pseudoslump ───────────────────────────────────────────────
// FNV-1a över orderns identitet, sedan xorshift. Ger ett tal i [0,1) som är
// stabilt över körningar, processer och maskiner.

function hashString(value) {
  let hash = 0x811c9dc5;
  const str = String(value);
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function deterministicUnit(seedKey) {
  let x = hashString(seedKey) || 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5; x >>>= 0;
  return (x >>> 0) / 4294967296;
}

function roundToTick(price, tickSize) {
  if (!(tickSize > 0) || !Number.isFinite(price)) return price;
  return Math.round(price / tickSize) * tickSize;
}

function barTime(bar) {
  return new Date(bar.ts || bar.t || bar.timestamp).getTime();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function createSimulatedFillEngine(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  // Riktningen slippage och spread går: alltid emot ordern.
  const adverse = (side) => (side === 'buy' ? 1 : -1);

  function costsFor(order) {
    const tick = config.tickSize;
    const slippage = config.slippageEnabled && config.slippageTicks > 0
      ? config.slippageTicks * tick
      : 0;
    const spread = config.spreadEnabled && config.spreadTicks > 0
      ? (config.spreadTicks * tick) / 2
      : 0;
    return { slippage, spread, direction: adverse(order.side) };
  }

  // Barer som är relevanta efter beslutet, med latensen inräknad.
  function barsAfter(order, bars) {
    const decidedMs = new Date(order.timestamp).getTime();
    const latency = config.latencyEnabled ? Number(config.latencyMs) || 0 : 0;
    const readyMs = decidedMs + latency;
    return bars
      .filter((bar) => Number.isFinite(barTime(bar)) && barTime(bar) >= readyMs)
      .slice(0, Math.max(1, config.maxBarsToFill));
  }

  // ── per ordertyp ───────────────────────────────────────────────────────────

  // Marknadsorder: fylls på första tillgängliga bars öppning.
  function fillMarket(order, bars) {
    const bar = bars[0];
    if (!bar) return { reason: 'no_bars_after_order' };
    const base = num(bar.open ?? bar.o);
    if (base == null) return { reason: 'bar_missing_open' };
    return { bar, basePrice: base };
  }

  // Limit: fylls först när priset handlas genom limiten. Fyllningspriset sätts
  // konservativt till limiten även om baren öppnade bättre — man får sällan
  // det bästa priset i kön.
  function fillLimit(order, bars, limitPrice) {
    for (const bar of bars) {
      const low = num(bar.low ?? bar.l);
      const high = num(bar.high ?? bar.h);
      if (low == null || high == null) continue;
      const touched = order.side === 'buy' ? low <= limitPrice : high >= limitPrice;
      if (touched) return { bar, basePrice: limitPrice, atLimit: true };
    }
    return { reason: 'limit_never_touched' };
  }

  // Stop: utlöses när priset passerar stoppnivån, fylls sedan som marknad
  // från stoppnivån. Det är där slippage gör mest skada i verkligheten.
  function fillStop(order, bars, stopPrice) {
    for (const bar of bars) {
      const low = num(bar.low ?? bar.l);
      const high = num(bar.high ?? bar.h);
      if (low == null || high == null) continue;
      const triggered = order.side === 'buy' ? high >= stopPrice : low <= stopPrice;
      if (triggered) return { bar, basePrice: stopPrice };
    }
    return { reason: 'stop_never_triggered' };
  }

  // StopLimit: stoppen utlöser, därefter gäller limitregeln från samma bar.
  function fillStopLimit(order, bars, stopPrice, limitPrice) {
    const triggerIndex = bars.findIndex((bar) => {
      const low = num(bar.low ?? bar.l);
      const high = num(bar.high ?? bar.h);
      if (low == null || high == null) return false;
      return order.side === 'buy' ? high >= stopPrice : low <= stopPrice;
    });
    if (triggerIndex === -1) return { reason: 'stop_never_triggered' };
    const after = bars.slice(triggerIndex);
    const limitResult = fillLimit(order, after, limitPrice);
    if (limitResult.reason) return { reason: 'stop_triggered_limit_not_filled' };
    return limitResult;
  }

  // ── huvudingång ────────────────────────────────────────────────────────────

  function fill(order, { bars = [] } = {}) {
    const validation = iface.validateOrder(order);
    if (!validation.ok) {
      return iface.emptyResult(order, {
        status: iface.FILL_STATUS.REJECTED,
        reason: validation.errors.join(','),
        engine: ENGINE,
      });
    }

    const usable = barsAfter(order, bars);
    if (!usable.length) {
      return iface.emptyResult(order, { reason: 'no_bars_after_order', engine: ENGINE });
    }

    // Utebliven fill modelleras deterministiskt per order, inte per körning.
    const seed = `${order.orderId}|${order.symbol}|${order.side}|${order.type}|${order.timestamp}`;
    if (config.noFillRate > 0 && deterministicUnit(`${seed}|nofill`) < config.noFillRate) {
      return iface.emptyResult(order, { reason: 'modelled_no_fill', engine: ENGINE });
    }

    const limitPrice = num(order.limitPrice);
    const stopPrice = num(order.stopPrice);
    let outcome;
    if (order.type === 'market') outcome = fillMarket(order, usable);
    else if (order.type === 'limit') outcome = fillLimit(order, usable, limitPrice);
    else if (order.type === 'stop') outcome = fillStop(order, usable, stopPrice);
    else outcome = fillStopLimit(order, usable, stopPrice, limitPrice);

    if (outcome.reason) {
      return iface.emptyResult(order, { reason: outcome.reason, engine: ENGINE });
    }

    const { slippage, spread, direction } = costsFor(order);
    // En limitorder får per definition inte fyllas sämre än limiten — den
    // betalar spread men inte slippage.
    const appliedSlippage = outcome.atLimit ? 0 : slippage;
    const rawPrice = outcome.basePrice + direction * (appliedSlippage + spread);
    const executedPrice = roundToTick(rawPrice, config.tickSize);

    const requested = Number(order.quantity);
    let filledQuantity = requested;
    let status = iface.FILL_STATUS.FILLED;
    if (config.partialFillRate > 0 && requested > 1
        && deterministicUnit(`${seed}|partial`) < config.partialFillRate) {
      filledQuantity = Math.max(1, Math.floor(requested / 2));
      status = iface.FILL_STATUS.PARTIAL;
    }

    const fillMs = barTime(outcome.bar);
    const decidedMs = new Date(order.timestamp).getTime();
    const expectedPrice = num(order.expectedPrice);
    const priceDifference = expectedPrice == null ? null
      : Number((executedPrice - expectedPrice).toFixed(6));

    // Execution cost räknas i prisenheter TIMES kvantitet och alltid som en
    // kostnad: positivt tal = sämre än förväntat.
    const executionCost = expectedPrice == null ? null
      : Number((direction * (executedPrice - expectedPrice) * filledQuantity).toFixed(6));

    return {
      status,
      orderId: order.orderId,
      fills: [{
        price: executedPrice,
        quantity: filledQuantity,
        timestamp: new Date(fillMs).toISOString(),
        delayMs: fillMs - decidedMs,
      }],
      filledQuantity,
      requestedQuantity: requested,
      expectedPrice,
      executedPrice,
      priceDifference,
      fillDelayMs: fillMs - decidedMs,
      slippage: appliedSlippage,
      spread,
      executionCost,
      reason: null,
      engine: ENGINE,
    };
  }

  function describe() {
    return {
      engine: ENGINE,
      deterministic: true,
      simulates: ['slippage', 'spread', 'latency', 'partial_fills', 'no_fills'],
      orderTypes: [...iface.ORDER_TYPES],
      config: { ...config },
      note: 'Deterministisk historisk fyllningsmodell. All variation härleds ur orderns identitet — ingen slumpgenerator används.',
      ...iface.SAFETY,
    };
  }

  return { fill, describe, _internal: { deterministicUnit, roundToTick, barsAfter } };
}

module.exports = {
  ENGINE,
  DEFAULT_CONFIG,
  createSimulatedFillEngine,
  defaultSimulatedFillEngine: createSimulatedFillEngine(),
};
