'use strict';

const assert = require('assert/strict');

const {
  getWeekendEntryCutoffState,
  DEFAULT_WEEKEND_ENTRY_CUTOFF_MINUTES,
} = require('./futuresMarketHoursService');

// Sommartid i Chicago (CDT = UTC-5) i juli/augusti 2026.
// CME:s veckostängning är fredag 16:00 CT = 21:00 UTC under CDT.
// Varje fall asserterar exchangeLocalTime så att DST-antagandet verifierar sig självt.

// ── 0. Defaulten är 90 minuter ───────────────────────────────────────────────
assert.equal(DEFAULT_WEEKEND_ENTRY_CUTOFF_MINUTES, 90);
assert.equal(getWeekendEntryCutoffState(new Date('2026-07-31T19:00:00.000Z')).cutoffMinutes, 90);

// ── 1. Fredag, TIDIGARE än 90 min före stängning → tillåts ───────────────────
// 14:29 CT = 91 min kvar.
const justOutside = getWeekendEntryCutoffState(new Date('2026-07-31T19:29:00.000Z'));
assert.equal(justOutside.exchangeLocalTime, '14:29');
assert.equal(justOutside.minutesUntilWeeklyClose, 91);
assert.equal(justOutside.entryBlocked, false, '91 min kvar ligger utanför cutoffen');
assert.equal(justOutside.reason, null);

// Tidigt på fredagen, 10:00 CT = 360 min kvar.
const fridayMorning = getWeekendEntryCutoffState(new Date('2026-07-31T15:00:00.000Z'));
assert.equal(fridayMorning.exchangeLocalTime, '10:00');
assert.equal(fridayMorning.minutesUntilWeeklyClose, 360);
assert.equal(fridayMorning.entryBlocked, false);

// ── 2. Fredag, INOM 90 min före stängning → blockeras ────────────────────────
// Exakt på gränsen: 14:30 CT = 90 min kvar. Gränsen är inklusive.
const atBoundary = getWeekendEntryCutoffState(new Date('2026-07-31T19:30:00.000Z'));
assert.equal(atBoundary.exchangeLocalTime, '14:30');
assert.equal(atBoundary.minutesUntilWeeklyClose, 90);
assert.equal(atBoundary.entryBlocked, true, 'exakt 90 min kvar ska blockeras');
assert.equal(atBoundary.reason, 'weekend_entry_cutoff');

// Det faktiska produktionsfallet: fxp_1d7d8c85a6922fd6 öppnades
// 2026-07-31T20:02:30Z = 15:02 CT, 57 min före stängning, och stoppades ut
// först i söndagens återöppningsgap till 1,91x avsedd risk.
const realIncident = getWeekendEntryCutoffState(new Date('2026-07-31T20:02:30.000Z'));
assert.equal(realIncident.exchangeLocalTime, '15:02');
assert.equal(realIncident.minutesUntilWeeklyClose, 58);
assert.equal(realIncident.entryBlocked, true, 'den observerade helgaffären ska blockeras');

// Sista minuten före stängning: 15:59 CT = 1 min kvar.
const lastMinute = getWeekendEntryCutoffState(new Date('2026-07-31T20:59:00.000Z'));
assert.equal(lastMinute.minutesUntilWeeklyClose, 1);
assert.equal(lastMinute.entryBlocked, true);

// ── 3. Övriga handelsdagar påverkas inte ─────────────────────────────────────
// Samma klockslag som incidenten, men torsdag.
const thursday = getWeekendEntryCutoffState(new Date('2026-07-30T20:02:30.000Z'));
assert.equal(thursday.exchangeLocalTime, '15:02');
assert.equal(thursday.minutesUntilWeeklyClose, null, 'bara fredagen har veckostängning');
assert.equal(thursday.entryBlocked, false);
assert.equal(thursday.reason, null);

// Måndag strax före den DAGLIGA underhållspausen (15:50 CT). Pausen är 1h och
// ska inte trigga helggrinden.
const mondayPreMaintenance = getWeekendEntryCutoffState(new Date('2026-07-27T20:50:00.000Z'));
assert.equal(mondayPreMaintenance.exchangeLocalTime, '15:50');
assert.equal(mondayPreMaintenance.entryBlocked, false);

// Onsdag kväll (17:30 CT, overnight) — guardens bas-tidpunkt i testsviten.
const wednesday = getWeekendEntryCutoffState(new Date('2026-07-15T22:30:00.000Z'));
assert.equal(wednesday.entryBlocked, false);

// Söndagens återöppning 17:01 CT — nya entries ska släppas direkt.
const sundayReopen = getWeekendEntryCutoffState(new Date('2026-08-02T22:01:30.000Z'));
assert.equal(sundayReopen.exchangeLocalTime, '17:01');
assert.equal(sundayReopen.minutesUntilWeeklyClose, null);
assert.equal(sundayReopen.entryBlocked, false);

// ── 4. Efter fredagsstängningen är det session-grinden som gäller, inte denna ─
const afterClose = getWeekendEntryCutoffState(new Date('2026-07-31T21:30:00.000Z'));
assert.equal(afterClose.exchangeLocalTime, '16:30');
assert.equal(afterClose.minutesUntilWeeklyClose, null);
assert.equal(afterClose.entryBlocked, false, 'helgstängt hanteras av session_allows_order');

// Lördag.
assert.equal(getWeekendEntryCutoffState(new Date('2026-08-01T18:00:00.000Z')).entryBlocked, false);

// ── 5. cutoffMinutes styr fönstret och klampas ───────────────────────────────
// 15:02 CT med 30 min cutoff → utanför.
assert.equal(
  getWeekendEntryCutoffState(new Date('2026-07-31T20:02:30.000Z'), { cutoffMinutes: 30 }).entryBlocked,
  false,
);
// ... men 15:45 CT ligger innanför samma 30-minutersfönster.
assert.equal(
  getWeekendEntryCutoffState(new Date('2026-07-31T20:45:00.000Z'), { cutoffMinutes: 30 }).entryBlocked,
  true,
);
// 0 stänger av grinden helt (fredagssessionen har alltid > 0 min kvar).
assert.equal(
  getWeekendEntryCutoffState(new Date('2026-07-31T20:59:00.000Z'), { cutoffMinutes: 0 }).entryBlocked,
  false,
);
// Skräpvärden faller tillbaka på defaulten; negativa och orimliga värden klampas.
assert.equal(getWeekendEntryCutoffState(new Date('2026-07-31T19:00:00.000Z'), { cutoffMinutes: 'abc' }).cutoffMinutes, 90);
assert.equal(getWeekendEntryCutoffState(new Date('2026-07-31T19:00:00.000Z'), { cutoffMinutes: -5 }).cutoffMinutes, 0);
assert.equal(getWeekendEntryCutoffState(new Date('2026-07-31T19:00:00.000Z'), { cutoffMinutes: 99999 }).cutoffMinutes, 24 * 60);

// ── 6. Vintertid: CST = UTC-6, stängning 16:00 CT = 22:00 UTC ────────────────
// Fredag 2026-12-04, 15:02 CST = 21:02 UTC → 58 min kvar, ska blockeras.
const winter = getWeekendEntryCutoffState(new Date('2026-12-04T21:02:00.000Z'));
assert.equal(winter.exchangeLocalTime, '15:02');
assert.equal(winter.minutesUntilWeeklyClose, 58);
assert.equal(winter.entryBlocked, true);

console.log('futuresMarketHoursService.weekendCutoff.test.js: OK');
