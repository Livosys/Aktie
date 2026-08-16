'use strict';

// ── Gemensamt candle-fönster ─────────────────────────────────────────────────
//
// Det här är den ENDA platsen där 1-minutersbarer blir det candle-fönster som
// Native Engine ser. Live-feeden matar in sina barer ur minnesringen, den
// historiska feeden matar in samma barer ur marknadsdatalagret, och båda får
// tillbaka byte-identiska rader.
//
// Modulen fanns tidigare bara som privata funktioner inuti
// futuresMarketDataService. Så länge den låg där kunde en andra feed bara
// efterlikna beteendet, aldrig dela det — och en efterlikning som glider isär
// är precis det som gör ett backtest oreproducerbart.
//
// Rent och tidlöst: ingen fil-IO, inget nätverk, ingen egen klocka. `now`
// skickas alltid in av anroparen, vilket är det som gör replay möjlig.

const candleAggregator = require('./candleAggregator');

const DATA_SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SUPPORTED_TIMEFRAMES = Object.freeze({ '1m': 1, '2m': 2, '5m': 5 });

function timeframeMinutes(timeframe) {
  return SUPPORTED_TIMEFRAMES[timeframe] || null;
}

function buildSourceMeta(quoteOrBar, mode) {
  const delayed = quoteOrBar?.delayed === true;
  return {
    provider: 'ibkr',
    mode: delayed && mode === 'realtime' ? 'delayed' : mode,
    realTime: mode === 'realtime' && !delayed,
    delayed,
    historical: mode === 'historical',
    simulated: false,
    fixture: false,
    replay: false,
  };
}

function buildQuality({
  staleAgeMs,
  timestampValid,
  contractValid,
  closedCandleValid = true,
  volumeValid = true,
  reasons = [],
}) {
  const status = reasons.length ? 'degraded' : 'ok';
  return { status, reasons, staleAgeMs: staleAgeMs ?? null, timestampValid, contractValid, closedCandleValid, volumeValid };
}

function normalizeBar(root, bar, { timeframe, isClosed, contract }) {
  return {
    instrument: root,
    localSymbol: contract?.localSymbol || null,
    conId: contract?.conId || null,
    expiry: contract?.expiry || null,
    exchange: contract?.exchange || 'CME',
    currency: contract?.currency || 'USD',
    timeframe,
    timestamp: bar.ts || bar.t || bar.timestamp,
    ts: bar.ts || bar.t || bar.timestamp,
    t: bar.ts || bar.t || bar.timestamp,
    open: bar.open ?? bar.o,
    high: bar.high ?? bar.h,
    low: bar.low ?? bar.l,
    close: bar.close ?? bar.c,
    volume: bar.volume ?? bar.v ?? null,
    tradeCount: bar.tradeCount ?? null,
    isClosed,
    dataSource: 'ib',
    source: buildSourceMeta({ delayed: false }, 'historical'),
    quality: buildQuality({
      staleAgeMs: null,
      timestampValid: Boolean(bar.ts || bar.t || bar.timestamp),
      contractValid: Boolean(contract?.conId),
      closedCandleValid: isClosed,
      volumeValid: (bar.volume ?? bar.v) != null,
      reasons: [],
    }),
    safety: DATA_SAFETY,
  };
}

// Bringar 1-minutersbarer till fönsterform. Anroparen äger sina egna
// statusfält (lastRefreshAt, lastError) och lägger dem ovanpå.
//
//   bars1m   redan normaliserade { ts, t, open, high, low, close, volume, tradeCount }
//   now      simulerad eller verklig klocka — avgör vad som är stängt
//   limit    antal STÄNGDA candles som returneras, senast först i tid
function buildCandleWindow({ root, bars1m = [], timeframe = '1m', limit = 500, now = new Date(), contract = null } = {}) {
  const key = String(root || '').trim().toUpperCase();
  const minutes = timeframeMinutes(timeframe);
  if (!minutes) {
    return { ok: false, error: `unsupported_timeframe_${timeframe}`, root: key, candles: [], openCandle: null };
  }

  const nowMs = new Date(now).getTime();
  const tfMs = minutes * 60 * 1000;

  // Ett fönster "som det såg ut vid now" får aldrig se en bar från efter now.
  // I drift är detta en nolloperation — minnesringen innehåller ändå bara
  // förfluten tid. I replay är det skillnaden mellan ett reproducerbart
  // resultat och ett som tjuvkikar in i framtiden, och den skillnaden syns
  // inte i något utfall förrän strategin möter verkligheten.
  const usable = Number.isFinite(nowMs)
    ? bars1m.filter((bar) => {
      const ts = new Date(bar.ts || bar.t || bar.timestamp).getTime();
      return Number.isFinite(ts) && ts < nowMs;
    })
    : bars1m;

  // Aggregeringen görs ALLTID med candleAggregator. Ingen feed får ha en egen.
  const aggregated = minutes === 1
    ? usable.map((b) => ({ ...b, incomplete: false }))
    : candleAggregator.aggregateBars(usable, minutes);

  const rows = aggregated.map((bar) => {
    const startMs = new Date(bar.ts || bar.t).getTime();
    // Ett candle är stängt först när hela perioden har passerat.
    const isClosed = Number.isFinite(startMs) && (startMs + tfMs) <= nowMs && bar.incomplete !== true;
    return normalizeBar(key, bar, { timeframe, isClosed, contract });
  });

  const closed = rows.filter((r) => r.isClosed);
  const openCandles = rows.filter((r) => !r.isClosed);
  const openCandle = openCandles.length ? openCandles[openCandles.length - 1] : null;
  const limited = closed.slice(Math.max(0, closed.length - Math.max(1, limit)));
  const latest = limited[limited.length - 1] || null;

  return {
    ok: true,
    root: key,
    timeframe,
    candles: limited,
    openCandle,
    count: limited.length,
    firstTimestamp: limited[0]?.timestamp || null,
    latestClosedTimestamp: latest?.timestamp || null,
    staleAgeMs: latest ? nowMs - new Date(latest.timestamp).getTime() - tfMs : null,
    dataQuality: limited.length ? 'ib_historical' : 'missing',
    source: buildSourceMeta({ delayed: false }, 'historical'),
    safety: DATA_SAFETY,
  };
}

module.exports = {
  DATA_SAFETY,
  SUPPORTED_TIMEFRAMES,
  timeframeMinutes,
  buildSourceMeta,
  buildQuality,
  normalizeBar,
  buildCandleWindow,
};
