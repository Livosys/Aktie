'use strict';

/**
 * Engine v3 — Del 2: Multi-Timeframe Confirmation
 *
 * Current status: STUB — only 2m data is available.
 * The Alpaca feed provides 1-minute bars that are aggregated to 2-minute candles.
 * 5m and 15m require either separate API calls or re-aggregation from 1m bars.
 *
 * TODO (v3.1): Implement full MTF by one of these approaches:
 *   (a) Fetch Alpaca 5Min and 15Min bars directly in alpacaClient.js
 *       — add fetch5mBars() and fetch15mBars() functions
 *       — pass candles5m and candles15m into classifyNarrowState or engineV3
 *   (b) Re-aggregate the 410 1m bars into 5m (82 bars) and 15m (27 bars)
 *       — add aggregate1mTo5m() and aggregate1mTo15m() in alpacaClient.js
 *       — compute indicators on each timeframe
 *
 * Until implemented: mtfStatus = 'limited', mtfScore = 50 (neutral — no help, no hurt).
 *
 * Rules (for when 5m/15m are available):
 *   - Long becomes stronger if 5m and 15m are not bearish.
 *   - Short becomes stronger if 5m and 15m are not bullish.
 *   - If 2m trigger conflicts with both 5m and 15m → strong penalty in scoreBreakdown.
 *   - If MTF data is missing → neutral score 50.
 */
function calcMtf(v2result) {
  // ── 2m Direction (derived from v2 result) ─────────────────────────────────
  // Use price vs SMA20 as the 2m trend proxy.
  let tf2mDirection = 'neutral';
  const { price, sma20, positionCode } = v2result || {};

  if (price && sma20) {
    if (price > sma20) tf2mDirection = 'bullish';
    else if (price < sma20) tf2mDirection = 'bearish';
  }

  // Position-code refinement: in_zone is genuinely neutral
  if (positionCode === 'in_zone') tf2mDirection = 'neutral';

  return {
    mtfStatus:      'limited',
    tf2mDirection,
    tf5mDirection:  'unknown',  // TODO: fetch 5m bars from Alpaca
    tf15mDirection: 'unknown',  // TODO: fetch 15m bars from Alpaca
    mtfAlignment:   'limited',
    mtfScore:       50,         // neutral — no confirmation or contradiction
    mtfReasonSv: [
      'Enbart 2m-data tillgänglig. 5m och 15m bekräftelse saknas (TODO v3.1).',
      `2m-riktning: ${tf2mDirection === 'bullish' ? 'uppåt' : tf2mDirection === 'bearish' ? 'nedåt' : 'neutral'} (pris vs SMA20).`,
      'Neutral MTF-score (50) tillämpas — varken förstärker eller sänker signalen.',
    ],
  };
}

module.exports = { calcMtf };
