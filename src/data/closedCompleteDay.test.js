'use strict';

// ── Ett stängt dygn är inte samma sak som ett tyst dygn ──────────────────────
//
// `quietForMs` svarar bara på om lagret slutat skriva, och det gör det av två
// helt olika skäl: antingen är handelsdagen över, eller så dog infångningen
// mitt i den. Efter en timme ser de likadana ut.
//
// 2026-08-20 stannade infångningen 17:33 när en annan process tog över porten.
// En timme senare passerade dygnet tystnadskontrollen, hade 240 barer i
// RTH-fönstret och valdes som "stängt komplett dygn" — trots att halva
// sessionen saknades. Testet som mätte exekveringskostnad föll då på att
// kostnaden blev noll, och det såg ut som ett resultat.
//
// Kravet är därför att dygnets data NÅR FRAM till sessionens slut.

const test = require('node:test');
const assert = require('node:assert/strict');

const coverage = require('./marketDataCoverage');

const HOUR = 60 * 60 * 1000;

/**
 * Ett lager med två dygn: ett färdigt och ett avhugget.
 *
 * Bägge är tysta och bägge har hela RTH-fönstret. Det enda som skiljer dem är
 * hur långt in på dygnet datan räcker — precis den skillnad som saknades.
 */
function storeWith({ truncatedLastUtc = '17:33', completeLastUtc = '23:59' } = {}) {
  const bars = (date, lastUtc) => {
    const end = new Date(`${date}T${lastUtc}:00.000Z`).getTime();
    const rows = [];
    // 700 barer bakåt från sista, en per minut. Räcker för minBars och täcker
    // 13:00–17:00 på dygn som slutar sent.
    for (let i = 700; i >= 0; i -= 1) rows.push({ ts: new Date(end - i * 60 * 1000).toISOString() });
    return rows;
  };
  const byDate = {
    '2026-08-20': bars('2026-08-20', truncatedLastUtc),
    '2026-08-19': bars('2026-08-19', completeLastUtc),
  };
  return {
    listAvailableDates: () => ({ raw: Object.keys(byDate), '2m': Object.keys(byDate) }),
    loadRawBars: (root, from) => byDate[from] || [],
    // Bägge dygnen är tysta sedan länge.
    lastModifiedMs: () => Date.now() - 5 * HOUR,
  };
}

const OPTIONS = Object.freeze({
  roots: ['MNQ'],
  minBars: 600,
  windowFromUtc: '13:00',
  windowToUtc: '17:00',
});

test('ett avhugget dygn väljs inte, även om det är tyst och har hela fönstret', () => {
  const dataStore = storeWith();
  const chosen = coverage.findClosedCompleteDay({ ...OPTIONS, dataStore });
  assert.equal(chosen, '2026-08-19', 'det avhuggna dygnet 2026-08-20 valdes');
});

test('kravet gäller sessionens slut, inte bara tystnad', () => {
  // Samma lager, men nu räcker även "det avhuggna" dygnet till sessionens slut.
  const dataStore = storeWith({ truncatedLastUtc: '23:00' });
  assert.equal(coverage.findClosedCompleteDay({ ...OPTIONS, dataStore }), '2026-08-20',
    'ett dygn som når sessionens slut ska väljas, och det nyaste vinner');
});

test('anroparens throughUtcTime kan skärpa kravet', () => {
  // 23:30 är strängare än stängningskravet: bara dygnet som går till 23:59 klarar det.
  const dataStore = storeWith({ truncatedLastUtc: '23:00' });
  assert.equal(
    coverage.findClosedCompleteDay({ ...OPTIONS, dataStore, throughUtcTime: '23:30' }),
    '2026-08-19',
  );
});

test('anroparens throughUtcTime kan INTE sänka kravet', () => {
  // 15:30 är svagare än stängningskravet. Utan skyddet hade det avhuggna dygnet
  // sluppit igenom — det var precis så felet uppstod.
  const dataStore = storeWith();
  assert.equal(
    coverage.findClosedCompleteDay({ ...OPTIONS, dataStore, throughUtcTime: '15:30' }),
    '2026-08-19',
  );
});

test('finns inget stängt dygn svaras null, inte ett halvt dygn', () => {
  const dataStore = storeWith({ truncatedLastUtc: '17:33', completeLastUtc: '18:00' });
  assert.equal(coverage.findClosedCompleteDay({ ...OPTIONS, dataStore }), null);
});

test('stängningströskeln ligger efter RTH-stängning', () => {
  const [hours] = String(coverage.CLOSED_DAY_THROUGH_UTC).split(':').map(Number);
  assert.ok(hours >= 20, 'tröskeln måste ligga efter RTH-stängning 20:00Z');
});
