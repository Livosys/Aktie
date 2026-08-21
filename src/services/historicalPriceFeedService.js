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

// ── quote-källa ──────────────────────────────────────────────────────────────
// Historiken innehåller idag barer, inte quotes. Priset härleds därför ur
// senast stängda candle och märks derivedFromCandle, med bid och ask null i
// stället för påhittade.
//
// När IB-quotes börjar sparas byts BARA den här funktionen ut — feeden,
// motorn, replay och batch är oförändrade. Kontraktet är avsiktligt smalt:
// (root, now, lastCandle) in, quote eller null ut.
function derivedFromCandleQuoteSource({ root, now, lastCandle }) {
  if (!lastCandle) return null;
  return {
    instrument: root,
    root,
    symbol: root,
    localSymbol: lastCandle.localSymbol,
    conId: lastCandle.conId,
    expiry: lastCandle.expiry,
    exchange: lastCandle.exchange,
    currency: lastCandle.currency,
    last: lastCandle.close,
    bid: null,
    ask: null,
    close: lastCandle.close,
    timestamp: lastCandle.timestamp,
    staleAgeMs: new Date(now).getTime() - new Date(lastCandle.timestamp).getTime(),
    connected: true,
    derivedFromCandle: true,
    quoteSource: 'derived_from_candle',
    source: candleWindow.buildSourceMeta({ delayed: false }, 'historical'),
    safety: SAFETY,
  };
}

function createHistoricalPriceFeedService(options = {}) {
  const dataStore = options.store || store;
  const source = options.source || DEFAULT_SOURCE;
  // Byt den här mot en läsare av lagrade IB-quotes när de finns. Inget annat
  // i systemet behöver ändras.
  const quoteSource = typeof options.quoteSource === 'function'
    ? options.quoteSource
    : derivedFromCandleQuoteSource;
  // Replay anropar per tick. Utan dagcache skulle varje tick läsa om samma
  // JSONL-filer från disk, vilket gör en dags replay till tiotusentals läsningar.
  const dayCache = new Map();

  function loadDay(root, date, contractKey = null) {
    const key = `${root}|${date}|${contractKey || 'root'}`;
    if (!dayCache.has(key)) {
      let bars = [];
      try {
        bars = dataStore.loadRawBars(root, date, date, source, contractKey ? { contractKey } : {}) || [];
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
  function loadBarsBefore(root, now, neededBars, contractKey = null) {
    const endDate = dateKey(now);
    const nowMs = new Date(now).getTime();
    const collected = [];
    let daysBack = 0;

    while (collected.length < neededBars && daysBack < MAX_LOOKBACK_DAYS) {
      const date = shiftDate(endDate, -daysBack);
      const bars = loadDay(root, date, contractKey);
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

  function getCandles(root, { now = new Date(), timeframe = '1m', limit = 50, contractKey = null } = {}) {
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
    const { bars, daysScanned } = loadBarsBefore(key, now, neededBars, contractKey);

    if (!bars.length) {
      return {
        candles: [], openCandle: null, source: 'ib_historical_store',
        dataQuality: 'missing', contract: null,
        warnings: ['no_historical_bars_in_store'],
      };
    }

    const contracts = [...new Set(bars.map((bar) => bar.contractKey).filter(Boolean))];
    if (!contractKey && contracts.length > 1) {
      return {
        candles: [], openCandle: null, source: 'historical_unavailable',
        dataQuality: 'ambiguous', contract: null,
        warnings: ['ambiguous_contract_ownership', ...contracts.sort()],
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

  // ── exekveringssidans barer ────────────────────────────────────────────────
  //
  // getCandles svarar på "vad visste strategin vid `now`" och lämnar därför
  // aldrig ut framtiden. En fyllningsmodell ställer den motsatta frågan: "vad
  // hände SEDAN med ordern". Båda behövs, och de får aldrig blandas ihop —
  // därför är det ett eget, tydligt namngivet anrop.
  //
  // Får ENDAST anropas av exekveringslagret, efter att beslutet är fattat.
  // Native Engine ser aldrig den här metoden.
  function getBarsBetweenResult(root, from, to, { contractKey = null } = {}) {
    const key = upper(root);
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      return { ok: false, reason: 'historical_window_invalid', bars: [] };
    }

    // ── Filnamnet är inte samma sak som barens kalenderdatum ──────────────────
    //
    // Den kontraktspartitionerade backfillen partitionerar på CME:s HANDELSDAG,
    // och en handelsdag börjar kvällen före: filen 2026-01-15.jsonl innehåller
    // barer från 2026-01-15T23:00Z till 2026-01-16T21:59Z. Den äldre
    // rotinfångningen partitionerar på kalenderdatum.
    //
    // Skanningen läste tidigare bara filerna [from..to] och missade därför
    // varje bar vars handelsdag hette något annat än dess kalenderdatum. Utfallet
    // var no_bars_after_order på ALLA entries i kontraktsläge — signalerna gick
    // igenom och ingen affär kunde fyllas.
    //
    // Ett dygns marginal åt vardera hållet täcker båda konventionerna. Urvalet
    // görs ändå av tidsfiltret nedan, så marginalen kan inte släppa in en bar
    // utanför fönstret.
    const out = [];
    const scanFrom = shiftDate(dateKey(fromMs), -1);
    const scanTo = shiftDate(dateKey(toMs), 1);
    for (let cursorDate = scanFrom; cursorDate <= scanTo; cursorDate = shiftDate(cursorDate, 1)) {
      for (const bar of loadDay(key, cursorDate, contractKey)) {
        const ts = barTimestamp(bar);
        const barMs = ts ? new Date(ts).getTime() : NaN;
        if (Number.isFinite(barMs) && barMs >= fromMs && barMs <= toMs) {
          out.push({
            ts,
            t: ts,
            timestamp: ts,
            open: bar.open ?? bar.o,
            high: bar.high ?? bar.h,
            low: bar.low ?? bar.l,
            close: bar.close ?? bar.c,
            volume: bar.volume ?? bar.v ?? null,
            contractKey: bar.contractKey || null,
            conId: bar.conId || null,
            localSymbol: bar.localSymbol || null,
            expiry: bar.expiry || null,
            tradingDay: bar.tradingDay || null,
            session: bar.session || null,
          });
        }
      }
    }
    // Marginalen ovan läser en dagfil extra i vardera änden. Skulle samma bar
    // någonsin ligga i två dagfiler — vilket den inte gör idag, men vilket
    // marginalen gör MÖJLIGT — hade den räknats två gånger, och en dubblerad
    // bar i exekveringsvägen är en påhittad affärsmöjlighet. Nyckeln är
    // kontrakt plus tidsstämpel, samma nyckel som marketDataStore använder:
    // två kontrakt får ha en bar på samma sekund, samma kontrakt får inte.
    const seen = new Set();
    const unique = out.filter((bar) => {
      const key = `${bar.contractKey || 'root'}|${bar.ts}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const identities = [...new Set(unique.map((bar) => bar.contractKey).filter(Boolean))];
    if (!contractKey && identities.length > 1) {
      return { ok: false, reason: 'ambiguous_contract_ownership', contracts: identities.sort(), bars: [] };
    }
    return { ok: true, reason: null, contracts: identities.sort(), bars: unique.sort((a, b) => new Date(a.ts) - new Date(b.ts)) };
  }

  function getBarsBetween(root, from, to, options = {}) {
    return getBarsBetweenResult(root, from, to, options).bars;
  }

  // Delegerar till quote-källan. Feeden avgör VILKEN bar som är den sista
  // kända vid `now`; källan avgör hur en quote ser ut.
  function getQuote(root, now = new Date(), options = {}) {
    const key = upper(root);
    const result = getCandles(key, { now, timeframe: '1m', limit: 1, ...options });
    const lastCandle = result.candles[result.candles.length - 1] || null;
    return quoteSource({ root: key, now, lastCandle, store: dataStore, source }) || null;
  }

  return {
    SAFETY,
    getCandles,
    getQuote,
    getBarsBetween,
    getBarsBetweenResult,
    clearCache,
    quoteSourceName: quoteSource === derivedFromCandleQuoteSource ? 'derived_from_candle' : 'custom',
  _internal: { loadBarsBefore, contractFromBars, getBarsBetweenResult },
  };
}

const defaultHistoricalPriceFeedService = createHistoricalPriceFeedService();

module.exports = {
  SAFETY,
  derivedFromCandleQuoteSource,
  createHistoricalPriceFeedService,
  defaultHistoricalPriceFeedService,
  getCandles: defaultHistoricalPriceFeedService.getCandles,
  getQuote: defaultHistoricalPriceFeedService.getQuote,
};
