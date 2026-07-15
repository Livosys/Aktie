'use strict';

const assert = require('assert/strict');

const {
  getNextSessionTransition,
  getCmeEquityIndexFuturesSessionState,
  _internal,
} = require('./futuresMarketHoursService');

// Sommartid i Chicago (CDT = UTC-5) i juli 2026.

// ── 1. Mitt i US RTH (onsdag 09:00 CT) → nästa byte är after hours 15:00 CT ──
const rth = getNextSessionTransition(new Date('2026-07-15T14:00:00.000Z'));
assert.equal(rth.currentSessionId, 'us_rth');
assert.equal(rth.nextSessionId, 'us_after_hours');
assert.equal(rth.minutesUntil, 6 * 60, 'från 09:00 CT till 15:00 CT = 360 min');

// ── 2. Strax före maintenance (15:59 CT) → maintenance_break om 1 min ────────
const preMaint = getNextSessionTransition(new Date('2026-07-15T20:59:00.000Z'));
assert.equal(preMaint.currentSessionId, 'us_after_hours');
assert.equal(preMaint.nextSessionId, 'maintenance_break');
assert.equal(preMaint.minutesUntil, 1);

// ── 3. I maintenance (16:30 CT) → overnight öppnar 17:00 CT ──────────────────
const maint = getNextSessionTransition(new Date('2026-07-15T21:30:00.000Z'));
assert.equal(maint.currentSessionId, 'maintenance_break');
assert.equal(maint.nextSessionId, 'overnight');
assert.equal(maint.minutesUntil, 30);

// ── 4. Fredag efter stängning (lördag 01:00 UTC = fre 20:00 CT) → helgstängt
//      tills söndag 17:00 CT (overnight) ─────────────────────────────────────
const weekend = getNextSessionTransition(new Date('2026-07-18T01:00:00.000Z'));
assert.equal(weekend.currentSessionId, 'market_closed');
assert.equal(weekend.nextSessionId, 'overnight');
// fre 20:00 CT → sön 17:00 CT = 4h + 24h + 17h = 45h = 2700 min
assert.equal(weekend.minutesUntil, 45 * 60);

// ── 5. Transitionens tidsstämpel ska matcha minutesUntil ─────────────────────
const nowRef = new Date('2026-07-15T14:00:00.000Z');
const ref = getNextSessionTransition(nowRef);
assert.equal(
  new Date(ref.nextChangeAt).getTime() - nowRef.getTime(),
  ref.minutesUntil * 60 * 1000,
);

// ── 6. classifyDayMinutes speglar full sessionsklassning ─────────────────────
const spotChecks = [
  ['2026-07-15T14:00:00.000Z'], // ons RTH
  ['2026-07-15T21:30:00.000Z'], // ons maintenance
  ['2026-07-18T14:00:00.000Z'], // lör stängt
  ['2026-07-19T23:30:00.000Z'], // sön overnight/asia
  ['2026-07-16T06:00:00.000Z'], // tors Europe (01:00 CT)
];
for (const [iso] of spotChecks) {
  const state = getCmeEquityIndexFuturesSessionState(new Date(iso));
  const local = _internal.chicagoParts(new Date(iso));
  const viaPure = _internal.classifyDayMinutes(local.day, local.minutes);
  assert.equal(viaPure, state.sessionId, `${iso}: classifyDayMinutes ska matcha sessionstate`);
}

console.log('futuresMarketHoursService.nextTransition.test.js OK');
