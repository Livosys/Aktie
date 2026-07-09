'use strict';

const assert = require('assert');
const svc = require('./consecutiveLossWindowService');

// Helper to build a closed trade with an ISO exit time.
function trade(result, iso) {
  return { result, exitTime: iso, ts: iso };
}

const NOW = new Date('2026-07-09T12:00:00.000Z');
const yday = (hhmm) => `2026-07-08T${hhmm}:00.000Z`;
const today = (hhmm) => `2026-07-09T${hhmm}:00.000Z`;

(function run() {
  // ── mode 'off' (default): trailing losses until a WIN, no ageing ─────────────
  const fiveLossesSpanningDays = [
    trade('WIN', yday('02:00')),
    trade('LOSS', yday('20:00')),
    trade('LOSS', yday('21:00')),
    trade('LOSS', today('08:00')),
    trade('LOSS', today('09:00')),
    trade('LOSS', today('10:00')),
  ];
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveLossesSpanningDays, { now: NOW }).consecutive_losses,
    5, 'off: counts all 5 trailing losses',
  );
  // default (no options) is 'off'
  assert.strictEqual(svc.computeConsecutiveLosses(fiveLossesSpanningDays).consecutive_losses, 5);
  // WIN breaks the streak
  assert.strictEqual(
    svc.computeConsecutiveLosses([trade('LOSS', today('08:00')), trade('WIN', today('09:00')), trade('LOSS', today('10:00'))], { now: NOW }).consecutive_losses,
    1, 'off: WIN breaks — only the trailing loss counts',
  );
  // last_loss_at is the newest loss (using the getTime accessor)
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveLossesSpanningDays, { now: NOW }).last_loss_at,
    today('10:00'),
  );

  // ── mode 'daily' (UTC): only losses on the current UTC day count ─────────────
  // 5 losses yesterday + 0 today => 0
  const fiveYesterdayNoneToday = [
    trade('LOSS', yday('10:00')),
    trade('LOSS', yday('12:00')),
    trade('LOSS', yday('14:00')),
    trade('LOSS', yday('16:00')),
    trade('LOSS', yday('18:00')),
  ];
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveYesterdayNoneToday, { mode: 'daily', now: NOW }).consecutive_losses,
    0, 'daily: yesterday-only losses do not count today',
  );
  // 5 losses today => 5
  const fiveToday = [
    trade('LOSS', today('06:00')),
    trade('LOSS', today('07:00')),
    trade('LOSS', today('08:00')),
    trade('LOSS', today('09:00')),
    trade('LOSS', today('10:00')),
  ];
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveToday, { mode: 'daily', now: NOW }).consecutive_losses,
    5, 'daily: 5 losses today => 5',
  );
  // 2 yesterday + 3 today => 3
  const twoYdayThreeToday = [
    trade('LOSS', yday('20:00')),
    trade('LOSS', yday('22:00')),
    trade('LOSS', today('08:00')),
    trade('LOSS', today('09:00')),
    trade('LOSS', today('10:00')),
  ];
  assert.strictEqual(
    svc.computeConsecutiveLosses(twoYdayThreeToday, { mode: 'daily', now: NOW }).consecutive_losses,
    3, 'daily: only today\'s 3 losses count',
  );
  // WIN today still breaks within the day
  assert.strictEqual(
    svc.computeConsecutiveLosses([trade('LOSS', today('06:00')), trade('WIN', today('07:00')), trade('LOSS', today('10:00'))], { mode: 'daily', now: NOW }).consecutive_losses,
    1,
  );

  // ── mode 'rolling_hours': losses older than the window do not count ──────────
  // NOW = 12:00Z. Window 6h → boundary 06:00Z today. Losses at 04:00 (out) and 08,10 (in).
  const rolling = [
    trade('LOSS', today('04:00')), // outside 6h window
    trade('LOSS', today('08:00')), // inside
    trade('LOSS', today('10:00')), // inside
  ];
  assert.strictEqual(
    svc.computeConsecutiveLosses(rolling, { mode: 'rolling_hours', windowHours: 6, now: NOW }).consecutive_losses,
    2, 'rolling_hours: only losses within the last 6h count',
  );
  // Wide window (48h) counts the cross-day losses
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveLossesSpanningDays.slice(1), { mode: 'rolling_hours', windowHours: 48, now: NOW }).consecutive_losses,
    5,
  );
  // Default window (24h) when windowHours omitted
  assert.strictEqual(
    svc.computeConsecutiveLosses([trade('LOSS', yday('11:00')), trade('LOSS', today('10:00'))], { mode: 'rolling_hours', now: NOW }).consecutive_losses,
    1, 'rolling_hours default 24h: 25h-old loss aged out',
  );

  // ── unknown mode falls back to 'off' ─────────────────────────────────────────
  assert.strictEqual(svc.resolveMode('bogus'), 'off');
  assert.strictEqual(
    svc.computeConsecutiveLosses(fiveLossesSpanningDays, { mode: 'bogus', now: NOW }).consecutive_losses,
    5,
  );

  // ── TIMEOUT/BREAKEVEN neither count nor break (legacy behavior) ──────────────
  assert.strictEqual(
    svc.computeConsecutiveLosses([trade('LOSS', today('06:00')), trade('TIMEOUT', today('07:00')), trade('LOSS', today('10:00'))], { now: NOW }).consecutive_losses,
    2, 'timeout is skipped, both losses count',
  );

  // ── empty / non-array input ──────────────────────────────────────────────────
  assert.deepStrictEqual(svc.computeConsecutiveLosses([]), { consecutive_losses: 0, last_loss_at: null });
  assert.deepStrictEqual(svc.computeConsecutiveLosses(null), { consecutive_losses: 0, last_loss_at: null });

  // ── startOfUtcDayMs sanity ───────────────────────────────────────────────────
  assert.strictEqual(svc.startOfUtcDayMs(NOW), Date.parse('2026-07-09T00:00:00.000Z'));

  console.log('# consecutiveLossWindowService tests passed.');
}());
