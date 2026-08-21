'use strict';

// ── Kanonisk läspolicy för historiken ───────────────────────────────────────
//
// Lagret innehåller samma barer i TVÅ partitioneringsscheman:
//
//   rotkatalogen        partitionerad på KALENDERDYGN, skriven av den löpande
//                       IB-infångningen. Raderna bär conId men ingen
//                       contractKey.
//
//   kontraktskatalogen  partitionerad på CME:s HANDELSDAG, skriven av den
//                       kontrollerade backfillen. Raderna bär contractKey,
//                       tradingDay, session och provenanceQuality.
//
// Policyn, i tre meningar:
//
//   1. exact_contract är kanoniskt. All research och all replay läser med
//      contractKey, och då läses BARA den katalogen.
//   2. Sammanslagen rotläsning är legacy. Den returnerar unionen av två
//      scheman och spänner därför över ~44 timmar för ett "dygn". Den får
//      aldrig användas där reproducerbarhet spelar roll.
//   3. Inom en sammanslagen läsning identifieras en bar av KONTRAKTET plus
//      tidsstämpeln, och raden med exakt härkomst vinner.
//
// Punkt 3 är den här filens innehåll. Punkterna 1 och 2 bevakas av
// researchHypothesis.acceptance (dataAccessMode) och av att replay-kön skickar
// contractKeyByRoot.

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('./marketDataStore');

const { contractIdentityOf, provenanceRank, dedupeByTimestamp } = store._internal;

const TS = '2026-08-17T22:00:00.000Z';
// Samma fysiska bar, som den ser ut i de två katalogerna.
const rootRow = { ts: TS, open: 1, high: 2, low: 0, close: 30082, conId: 793356225, localSymbol: 'MNQU6' };
const contractRow = {
  ts: TS, open: 1, high: 2, low: 0, close: 30082,
  conId: '793356225', localSymbol: 'MNQU6',
  contractKey: 'MNQ:793356225:2026-09-18', tradingDay: '2026-08-17',
  session: 'overnight', provenanceQuality: 'exact_provenance',
};

test('1. identiteten är kontraktet, inte katalogen raden kom ur', () => {
  // conId finns i båda formerna — som tal i roten, som sträng i kontraktsfilen.
  assert.equal(contractIdentityOf(rootRow), contractIdentityOf(contractRow));
  assert.equal(contractIdentityOf(rootRow), 'conid:793356225');

  // Utan conId faller nyckeln tillbaka på contractKey, och sist på ingenting —
  // det gamla beteendet för rader utan kontraktsidentitet.
  assert.equal(contractIdentityOf({ contractKey: 'MNQ:1:2026-09-18' }), 'contract:MNQ:1:2026-09-18');
  assert.equal(contractIdentityOf({}), 'legacy');
});

test('2. samma bar ur två kataloger blir EN rad', () => {
  // Nyckeln skilde tidigare på `contract:` och `legacy:`, så den här baren
  // returnerades två gånger i två olika fältformer med identiska priser. Mätt
  // för MNQ 2026-08-17: 2 760 rader där lagret innehåller 1 380 barer.
  const merged = dedupeByTimestamp([rootRow, contractRow]);
  assert.equal(merged.length, 1);
  // Och ordningen får inte avgöra utfallet.
  assert.equal(dedupeByTimestamp([contractRow, rootRow]).length, 1);
});

test('3. raden med exakt härkomst vinner, oavsett läsordning', () => {
  assert.ok(provenanceRank(contractRow) > provenanceRank(rootRow));
  for (const order of [[rootRow, contractRow], [contractRow, rootRow]]) {
    const [kept] = dedupeByTimestamp(order);
    assert.equal(kept.contractKey, 'MNQ:793356225:2026-09-18',
      'kontraktsraden bär tradingDay, session och provenanceQuality — rotraden gör det inte');
    assert.equal(kept.provenanceQuality, 'exact_provenance');
  }
});

test('4. två OLIKA kontrakt på samma sekund är två barer', () => {
  // MNQ och MES handlas samtidigt, och ett rullfönster har två kontrakt i
  // samma rot. Att slå ihop dem på tidsstämpeln hade tappat halva marknaden.
  const other = { ...contractRow, conId: '793356217', localSymbol: 'MESU6', contractKey: 'MES:793356217:2026-09-18' };
  assert.equal(dedupeByTimestamp([contractRow, other]).length, 2);
});

test('5. exakt kontraktsläsning påverkas inte av sammanslagningen', () => {
  // Kanoniska vägen läser en katalog och har inget att deduplicera mot.
  const rows = store.loadRawBars('MNQ', '2026-08-17', '2026-08-17', 'ib', {
    contractKey: 'MNQ:793356225:2026-09-18',
  });
  if (!rows.length) return; // lagret saknar dygnet i den här miljön
  assert.equal(rows.every((row) => row.contractKey === 'MNQ:793356225:2026-09-18'), true);
  const stamps = rows.map((row) => row.ts);
  assert.equal(new Set(stamps).size, stamps.length, 'kanoniska vägen får aldrig ge dubbletter');
});

console.log('marketDataStoreMerge.test.js loaded');
