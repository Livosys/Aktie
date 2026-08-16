'use strict';

// ── Historical PriceFeed ─────────────────────────────────────────────────────
//
// Andra implementationen av PriceFeed-kontraktet (se priceFeedInterface.js).
// Live-feeden håller 1-minutersbarer i minnet; den här läser SAMMA barer ur
// marknadsdatalagret, dit IB-importen skriver dem. Därefter går båda genom
// candleWindow.buildCandleWindow — så fönstren är identiska av konstruktion,
// inte av tillfällighet.
//
// Vad den medvetet INTE gör:
//   · aggregerar inte själv (candleWindow äger det)
//   · läser inte candles-2m (det vore en andra aggregeringsväg)
//   · läser inte Date.now() (klockan skickas alltid in)
//   · rör ingen broker, ingen order, ingen risk
//
// Read-only. Inget skrivs någonstans.

const store = require('../data/marketDataStore');
const candleWindow = require('../data/candleWindow');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'historical_price_feed',
});

const DEFAULT_SOURCE = 'ib';
const BARS_PER_DAY_ESTIMATE = 1260; // CME-dygn i 1m-barer, mätt på MNQ/MES
const MAX_LOOKBACK_DAYS = 30;

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function barTimestamp(bar) {
  return bar && (bar.ts || bar.t || bar.timestamp) || null;
}

// Kontraktet står på varje rå rad (conId, localSymbol, expiry skrivs av
// persistBars). Vi tar det från den SENASTE baren i fönstret, så att en
// kontraktsrullning mitt i perioden ger det kontrakt som faktiskt gällde sist.
function contractFromBars(bars, root) {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    if (bar && (bar.conId || bar.localSymbol)) {
      return {
        conId: bar.conId || null,
        localSymbol: bar.localSymbol || null,
        expiry: bar.expiry || null,
        exchange: bar.exchange || 'CME',
        currency: bar.currency || 'USD',
      };
    }
  }
  return { conId: null, localSymbol: null, expiry: null, exchange: 'CME', currency: 'USD' };
}

function createHistoricalPriceFeedService(options = {}) {
  const dataStore = options.store || store;
  const source = options.source || DEFAULT_SOURCE;
  // Replay anropar per tick. Utan dagcache skulle varje tick läsa om samma
  // JSONL-filer från disk, vilket gör en dags replay till tiotusentals läsningar.
  const dayCache = new Map();

  function loadDay(root, date) {
    const key = `${root}|${date}`;
    if (!dayCache.has(key)) {
      let bars = [];
      try {
        bars = dataStore.loadRawBars(root, date, date, source) || [];
      } catch (_) {
        bars = [];
      }
      dayCache.set(key, bars);
    }
    return dayCache.get(key);
  }

  function clearCache() {
    dayCache.clear();
  }

  // Läser bakåt dag för dag tills det finns tillräckligt med barer för det
  // begärda fönstret. Stannar vid MAX_LOOKBACK_DAYS så en saknad historik ger
  // ett ärligt tomt svar i stället för att skanna hela lagret.
  function loadBarsBefore(root, now, neededBars) {
    const endDate = dateKey(now);
    const nowMs = new Date(now).getTime();
    const collected = [];
    let daysBack = 0;

    while (collected.length < neededBars && daysBack < MAX_LOOKBACK_DAYS) {
      const date = shiftDate(endDate, -daysBack);
      const bars = loadDay(root, date);
      // Endast barer som stängt före `now`. Ett enda framtida ljus här gör
      // hela körningen oreproducerbar.
      const usable = bars.filter((bar) => {
        const ts = barTimestamp(bar);
        return ts && new Date(ts).getTime() < nowMs;
      });
      collected.unshift(...usable);
      daysBack += 1;
      // En dag utan data efter att vi redan hittat något betyder helg eller
      // lucka — fortsätt bakåt, det är inte ett fel.
    }
    return { bars: collected, daysScanned: daysBack };
  }

  function getCandles(root, { now = new Date(), timeframe = '1m', limit = 50 } = {}) {
    const key = upper(root);
    const minutes = candleWindow.timeframeMinutes(timeframe);
    if (!minutes) {
      return {
        candles: [], openCandle: null, source: 'historical_unavailable',
        dataQuality: 'missing', contract: null,
        warnings: [`unsupported_timeframe_${timeframe}`],
      };
    }

    // Marginal: aggregeringen kan behöva fler 1m-barer än limit×minutes när
    // det finns luckor i serien.
    const neededBars = Math.min(
      Math.max(1, limit) * minutes * 2 + minutes,
      BARS_PER_DAY_ESTIMATE * MAX_LOOKBACK_DAYS,
    );
    const { bars, daysScanned } = loadBarsBefore(key, now, neededBars);

    if (!bars.length) {
      return {
        candles: [], openCandle: null, source: 'ib_historical_store',
        dataQuality: 'missing', contract: null,
        warnings: ['no_historical_bars_in_store'],
      };
    }

    const contract = contractFromBars(bars, key);
    const window = candleWindow.buildCandleWindow({
      root: key,
      bars1m: bars.map((bar) => ({
        ts: barTimestamp(bar),
        t: barTimestamp(bar),
        open: bar.open ?? bar.o,
        high: bar.high ?? bar.h,
        low: bar.low ?? bar.l,
        close: bar.close ?? bar.c,
        volume: bar.volume ?? bar.v ?? null,
        tradeCount: bar.tradeCount ?? null,
      })),
      timeframe,
      limit,
      now,
      contract,
    });

    const warnings = [];
    if (window.candles.length < limit) warnings.push('window_shorter_than_requested');
    if (daysScanned >= MAX_LOOKBACK_DAYS) warnings.push('lookback_limit_reached');

    return {
      candles: window.candles,
      openCandle: window.openCandle,
      source: 'ib_historical_store',
      dataQuality: window.candles.length ? 'ib' : 'missing',
      contract: window.candles.length ? {
        root: key,
        conId: contract.conId,
        localSymbol: contract.localSymbol,
        expiry: contract.expiry,
      } : null,
      warnings,
    };
  }

  // Historiken har inga quotes — bara barer. Priset härleds därför ur det
  // senast stängda candlet och märks som härlett. Att hitta på en spread här
  // vore att ljuga för strategierna om vad som var känt vid tidpunkten.
  function getQuote(root, now = new Date()) {
    const key = upper(root);
    const result = getCandles(key, { now, timeframe: '1m', limit: 1 });
    const last = result.candles[result.candles.length - 1];
    if (!last) return null;
    const ts = last.timestamp;
    return {
      instrument: key,
      root: key,
      symbol: key,
      localSymbol: last.localSymbol,
      conId: last.conId,
      expiry: last.expiry,
      exchange: last.exchange,
      currency: last.currency,
      last: last.close,
      bid: null,
      ask: null,
      close: last.close,
      timestamp: ts,
      staleAgeMs: new Date(now).getTime() - new Date(ts).getTime(),
      connected: true,
      derivedFromCandle: true,
      source: candleWindow.buildSourceMeta({ delayed: false }, 'historical'),
      safety: SAFETY,
    };
  }

  return { SAFETY, getCandles, getQuote, clearCache, _internal: { loadBarsBefore, contractFromBars } };
}

const defaultHistoricalPriceFeedService = createHistoricalPriceFeedService();

module.exports = {
  SAFETY,
  createHistoricalPriceFeedService,
  defaultHistoricalPriceFeedService,
  getCandles: defaultHistoricalPriceFeedService.getCandles,
  getQuote: defaultHistoricalPriceFeedService.getQuote,
};
