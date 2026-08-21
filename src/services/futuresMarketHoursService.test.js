'use strict';

const assert = require('assert/strict');

const {
  buildFuturesSessionMetadata,
  getCanonicalTradingDayWindow,
  getCmeEquityIndexFuturesSessionState,
} = require('./futuresMarketHoursService');

function assertState(iso, expected) {
  const state = getCmeEquityIndexFuturesSessionState(iso);
  assert.equal(state.timezone, 'America/Chicago', `${iso} timezone`);
  assert.equal(state.exchangeTimezone, 'America/Chicago', `${iso} exchangeTimezone`);
  assert.equal(state.maintenanceWindow, '16:00-17:00 CT', `${iso} maintenanceWindow`);
  assert.equal(state.session, 'Globex', `${iso} session`);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(state[key], value, `${iso} ${key}`);
  }
  return state;
}

// Summer time in Chicago: maintenance is 21:00-22:00 UTC, not 22:00-23:00 UTC.
assertState('2026-07-13T20:59:59.000Z', {
  isOpen: true,
  sessionId: 'us_after_hours',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-13T21:00:00.000Z', {
  isOpen: false,
  sessionId: 'maintenance_break',
  isRth: false,
  isGlobex: false,
  closedReason: 'daily_maintenance',
});
assertState('2026-07-13T22:00:00.000Z', {
  isOpen: true,
  sessionId: 'overnight',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});

// Winter time in Chicago: maintenance is 22:00-23:00 UTC.
assertState('2026-01-12T21:59:59.000Z', {
  isOpen: true,
  sessionId: 'us_after_hours',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-01-12T22:30:00.000Z', {
  isOpen: false,
  sessionId: 'maintenance_break',
  isRth: false,
  isGlobex: false,
  closedReason: 'daily_maintenance',
});
assertState('2026-01-12T23:00:00.000Z', {
  isOpen: true,
  sessionId: 'overnight',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});

// Weekend boundary: Sunday 17:00 CT open, Friday 16:00 CT close.
assertState('2026-07-11T17:00:00.000Z', {
  isOpen: false,
  sessionId: 'market_closed',
  isRth: false,
  isGlobex: false,
  closedReason: 'weekend',
});
assertState('2026-07-12T21:59:59.000Z', {
  isOpen: false,
  sessionId: 'market_closed',
  isRth: false,
  isGlobex: false,
  closedReason: 'weekend',
});
assertState('2026-07-12T22:00:00.000Z', {
  isOpen: true,
  sessionId: 'overnight',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-17T20:59:59.000Z', {
  isOpen: true,
  sessionId: 'us_after_hours',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-17T21:00:00.000Z', {
  isOpen: false,
  sessionId: 'market_closed',
  isRth: false,
  isGlobex: false,
  closedReason: 'weekend',
});

// Read-only Futures Paper session labels, all calculated in America/Chicago.
assertState('2026-07-14T01:30:00.000Z', {
  isOpen: true,
  sessionId: 'asia',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-14T07:30:00.000Z', {
  isOpen: true,
  sessionId: 'europe',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-14T12:30:00.000Z', {
  isOpen: true,
  sessionId: 'us_premarket',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-14T13:30:00.000Z', {
  isOpen: true,
  sessionId: 'us_rth',
  isRth: true,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-14T20:30:00.000Z', {
  isOpen: true,
  sessionId: 'us_after_hours',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-07-14T22:30:00.000Z', {
  isOpen: true,
  sessionId: 'overnight',
  isRth: false,
  isGlobex: true,
  closedReason: null,
});

// Weeks where Sweden and the US have different DST offsets.
assertState('2026-03-16T13:30:00.000Z', {
  isOpen: true,
  sessionId: 'us_rth',
  isRth: true,
  isGlobex: true,
  closedReason: null,
});
assertState('2026-10-26T21:30:00.000Z', {
  isOpen: false,
  sessionId: 'maintenance_break',
  isRth: false,
  isGlobex: false,
  closedReason: 'daily_maintenance',
});

const metadata = buildFuturesSessionMetadata('2026-07-14T12:45:00.000Z');
assert.equal(metadata.session, 'Globex');
assert.equal(metadata.sessionId, 'us_premarket');
assert.equal(metadata.sessionLabel, 'US Premarket');
assert.equal(metadata.exchangeTimezone, 'America/Chicago');
assert.equal(metadata.exchangeLocalDate, '2026-07-14');
assert.equal(metadata.exchangeLocalTime, '07:45');
assert.equal(metadata.isRth, false);
assert.equal(metadata.isMarketOpen, true);

assert.equal(buildFuturesSessionMetadata(null), null);
assert.equal(buildFuturesSessionMetadata('not-a-date'), null);

const winterWindow = getCanonicalTradingDayWindow('2025-12-18');
assert.deepEqual(winterWindow, {
  tradingDay: '2025-12-18',
  timezone: 'America/Chicago',
  startLocal: '2025-12-18T17:00:00',
  endLocal: '2025-12-19T17:00:00',
  startUtc: '2025-12-18T23:00:00.000Z',
  endUtc: '2025-12-19T23:00:00.000Z',
});

const summerWindow = getCanonicalTradingDayWindow('2026-07-13');
assert.equal(summerWindow.startUtc, '2026-07-13T22:00:00.000Z');
assert.equal(summerWindow.endUtc, '2026-07-14T22:00:00.000Z');

const springTransitionWindow = getCanonicalTradingDayWindow('2026-03-08');
assert.equal(springTransitionWindow.startUtc, '2026-03-08T22:00:00.000Z');
assert.equal(springTransitionWindow.endUtc, '2026-03-09T22:00:00.000Z');

const fallTransitionWindow = getCanonicalTradingDayWindow('2026-11-01');
assert.equal(fallTransitionWindow.startUtc, '2026-11-01T23:00:00.000Z');
assert.equal(fallTransitionWindow.endUtc, '2026-11-02T23:00:00.000Z');
assert.equal(getCanonicalTradingDayWindow('2026-02-30'), null);

console.log('futuresMarketHoursService.test.js passed');
