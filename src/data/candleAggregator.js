'use strict';

/**
 * Normalize a bar to both long and short field names.
 * Input may have {ts,open,high,low,close,volume} or {t,o,h,l,c,v}.
 */
function normalize(b) {
  const ts    = b.ts  || b.t;
  const open  = b.open  !== undefined ? b.open  : b.o;
  const high  = b.high  !== undefined ? b.high  : b.h;
  const low   = b.low   !== undefined ? b.low   : b.l;
  const close = b.close !== undefined ? b.close : b.c;
  const vol   = b.volume !== undefined ? b.volume : b.v;
  return { ts, t: ts, o: open, h: high, l: low, c: close, v: vol };
}

/**
 * Aggregate 1m bars into 2m candles.
 *
 * Strategy: group bars into 2-minute UTC buckets (minute 0-1, 2-3, 4-5 …).
 * If a bucket has only one bar, it is marked incomplete=true.
 * Fully complete buckets have incomplete=false.
 *
 * @param {Array} bars1m - raw 1m bars (must have ts/t, o/open, h/high, l/low, c/close, v/volume)
 * @returns {Array} 2m candles sorted by timestamp
 */
function aggregate1mTo2m(bars1m) {
  if (!bars1m || bars1m.length < 1) return [];

  // Normalize and sort chronologically
  const sorted = bars1m
    .map(normalize)
    .filter((b) => b.ts)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Group into 2-minute UTC buckets
  const buckets = new Map(); // bucket-start-ISO → [normalized bars]

  for (const bar of sorted) {
    const d = new Date(bar.ts);
    const min = d.getUTCMinutes();
    const bucketMin = min - (min % 2); // round down to even minute
    d.setUTCMinutes(bucketMin, 0, 0);
    const key = d.toISOString();

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(bar);
  }

  // Build candles from buckets
  const candles = [];
  const entries = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  for (const [key, bars] of entries) {
    const first = bars[0];
    const last  = bars[bars.length - 1];
    const high  = Math.max(...bars.map((b) => b.h));
    const low   = Math.min(...bars.map((b) => b.l));
    const vol   = bars.reduce((s, b) => s + b.v, 0);
    const complete = bars.length >= 2;

    candles.push({
      ts:         key,
      t:          key,
      o:          first.o,
      h:          high,
      l:          low,
      c:          last.c,
      v:          vol,
      open:       first.o,
      high:       high,
      low:        low,
      close:      last.c,
      volume:     vol,
      incomplete: !complete,
      source:     'aggregated_1m',
    });
  }

  return candles;
}

/**
 * Filter out incomplete candles.
 */
function filterComplete(candles) {
  return candles.filter((c) => !c.incomplete);
}

/**
 * Convert already-stored 2m candles (any field format) to the short-name
 * format expected by indicators.js and narrowState.js.
 */
function toScannerFormat(candles) {
  return candles.map((c) => ({
    t:  c.t  || c.ts,
    ts: c.ts || c.t,
    o:  c.o  !== undefined ? c.o  : c.open,
    h:  c.h  !== undefined ? c.h  : c.high,
    l:  c.l  !== undefined ? c.l  : c.low,
    c:  c.c  !== undefined ? c.c  : c.close,
    v:  c.v  !== undefined ? c.v  : c.volume,
  }));
}

module.exports = { aggregate1mTo2m, filterComplete, toScannerFormat };
