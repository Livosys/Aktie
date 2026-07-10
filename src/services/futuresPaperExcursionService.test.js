'use strict';

const assert = require('assert/strict');
const svc = require('./futuresPaperExcursionService');

// MNQ-liknande: pointValue 2, contracts 1, fx 10.5 → 1 punkt = 21 SEK.
const PV = 2; const SIZE = 1; const FX = 10.5;
const ctx = (side, entryPrice) => ({ entryPrice, side, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });

// 1. Long MFE korrekt (pris upp = favorable).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, takeProfit: 110, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 108, ...ctx('long', 100) });
  assert.equal(t.maximumFavorableExcursionPoints, 8, 'long MFE points');
  assert.equal(t.maximumFavorableExcursionSek, 168, 'long MFE SEK gross (8*2*1*10.5)');
  assert.equal(t.maximumAdverseExcursionPoints, 0, 'no adverse yet');
}

// 2. Long MAE korrekt (pris ner = adverse).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 96, ...ctx('long', 100) });
  assert.equal(t.maximumAdverseExcursionPoints, 4, 'long MAE points');
  assert.equal(t.maximumAdverseExcursionSek, 84, 'long MAE SEK gross');
  assert.equal(t.maximumFavorableExcursionPoints, 0);
}

// 3. Short MFE korrekt (pris ner = favorable för short).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'short', stopLoss: 105, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 93, ...ctx('short', 100) });
  assert.equal(t.maximumFavorableExcursionPoints, 7, 'short MFE points');
  assert.equal(t.maximumAdverseExcursionPoints, 0);
}

// 4. Short MAE korrekt (pris upp = adverse för short).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'short', stopLoss: 105, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 103, ...ctx('short', 100) });
  assert.equal(t.maximumAdverseExcursionPoints, 3, 'short MAE points');
  assert.equal(t.maximumFavorableExcursionPoints, 0);
}

// 5. highest/lowest uppdateras monotont över flera tick.
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 90, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 105, ...ctx('long', 100) });
  t = svc.applyPriceObservation(t, { price: 102, ...ctx('long', 100) }); // lägre än 105
  t = svc.applyPriceObservation(t, { price: 98, ...ctx('long', 100) });  // ny lägsta
  t = svc.applyPriceObservation(t, { price: 101, ...ctx('long', 100) });
  assert.equal(t.highestPriceWhileOpen, 105, 'monotonic high');
  assert.equal(t.lowestPriceWhileOpen, 98, 'monotonic low');
  assert.equal(t.maximumFavorableExcursionPoints, 5, 'MFE from peak 105');
  assert.equal(t.maximumAdverseExcursionPoints, 2, 'MAE from trough 98');
}

// 6. gaveBackFromPeak korrekt: peak 168 SEK, exit gross 84 SEK → giveback 84.
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 108, ...ctx('long', 100) }); // MFE 168 SEK
  t = svc.finalizeExcursion(t, { exitPrice: 104, exitReason: 'take_profit_hit', grossPnlSek: 84, ...ctx('long', 100) });
  assert.equal(t.peakUnrealizedPnlSek, 168);
  assert.equal(t.gaveBackFromPeakSek, 84, 'gave back 168-84');
  assert.equal(t.exitType, 'take_profit');
}

// 7. Initial stop/target fryses vid open och finalStopPrice = initial (ingen trailing).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, takeProfit: 110, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  assert.equal(t.initialStopPrice, 95);
  assert.equal(t.initialTargetPrice, 110);
  assert.equal(t.initialRiskPoints, 5);
  assert.equal(t.initialRiskSek, 5 * PV * SIZE * FX);
  t = svc.finalizeExcursion(t, { exitPrice: 96, exitReason: 'stop_loss_hit', grossPnlSek: -84, ...ctx('long', 100) });
  assert.equal(t.finalStopPrice, 95, 'no trailing → final = initial');
  assert.equal(t.initialStopPrice, 95, 'initial unchanged');
  assert.equal(t.exitType, 'initial_stop_loss');
}

// 8. exitType-klassificering för alla koder.
{
  assert.equal(svc.classifyExitType('stop_loss_hit'), 'initial_stop_loss');
  assert.equal(svc.classifyExitType('take_profit_hit'), 'take_profit');
  assert.equal(svc.classifyExitType('max_holding_time'), 'max_holding_time');
  assert.equal(svc.classifyExitType('manual_close'), 'system_close');
  assert.equal(svc.classifyExitType('curl_test_close'), 'system_close');
  assert.equal(svc.classifyExitType(''), 'unknown_legacy');
  assert.equal(svc.classifyExitType(null), 'unknown_legacy');
}

// 9. R-multiplar: MFE/MAE i R relativt initial risk.
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 96, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX }); // risk 4
  t = svc.applyPriceObservation(t, { price: 108, ...ctx('long', 100) }); // +8 pts = 2R
  t = svc.applyPriceObservation(t, { price: 98, ...ctx('long', 100) });  // -2 pts = 0.5R
  assert.equal(t.maximumFavorableExcursionR, 2, 'MFE 2R');
  assert.equal(t.maximumAdverseExcursionR, 0.5, 'MAE 0.5R');
}

// 10. Provenance: simulated_fallback → measurementQuality 'simulated'.
{
  const t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, dataSource: 'simulated_fallback', usedFallbackPrice: true });
  assert.equal(t.mfeMaeSource, 'runtime_price_updates');
  assert.equal(t.priceFeedSource, 'simulated_fallback');
  assert.equal(t.measurementQuality, 'simulated');
}

// 11. Provenance: riktig data → 'real'.
{
  const t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, dataSource: 'databento_replay', usedFallbackPrice: false });
  assert.equal(t.priceFeedSource, 'databento_replay');
  assert.equal(t.measurementQuality, 'real');
}

// 12. Ingen stop → initialRisk null och R-mått null (ingen division med noll).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: null, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  assert.equal(t.initialRiskPoints, null);
  assert.equal(t.initialRiskSek, null);
  t = svc.applyPriceObservation(t, { price: 108, ...ctx('long', 100) });
  assert.equal(t.maximumFavorableExcursionR, null, 'R null utan risk');
  assert.equal(t.maximumFavorableExcursionPoints, 8, 'points ändå mätt');
}

// 13. finalize viker in exit-priset som extrem om det överskrider tidigare topp.
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 103, ...ctx('long', 100) }); // MFE 3
  // markPrice/exitPrice 106 ligger bortom → ny topp 6.
  t = svc.finalizeExcursion(t, { exitPrice: 106, exitReason: 'take_profit_hit', grossPnlSek: 84, ...ctx('long', 100) });
  assert.equal(t.maximumFavorableExcursionPoints, 6, 'exit-pris fångas i extremen');
  assert.equal(t.highestPriceWhileOpen, 106);
}

// 14. applyPriceObservation muterar inte input-objektet.
{
  const t0 = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  const t1 = svc.applyPriceObservation(t0, { price: 108, ...ctx('long', 100) });
  assert.equal(t0.maximumFavorableExcursionPoints, 0, 'original oförändrad');
  assert.equal(t1.maximumFavorableExcursionPoints, 8, 'ny kopia uppdaterad');
  assert.notEqual(t0, t1);
}

// 15. Ogiltigt/nollpris ignoreras (ingen NaN, ingen extrem-förändring).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 0, ...ctx('long', 100) });
  t = svc.applyPriceObservation(t, { price: NaN, ...ctx('long', 100) });
  assert.equal(t.highestPriceWhileOpen, 100, 'oförändrad vid ogiltigt pris');
  assert.equal(t.maximumFavorableExcursionPoints, 0);
}

// 16. gaveBackFromPeak = 0 när ingen gynnsam excursion funnits (bara förlust).
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 97, ...ctx('long', 100) }); // bara adverse
  t = svc.finalizeExcursion(t, { exitPrice: 96, exitReason: 'stop_loss_hit', grossPnlSek: -84, ...ctx('long', 100) });
  assert.equal(t.peakUnrealizedPnlSek, 0);
  assert.equal(t.gaveBackFromPeakSek, 0, 'ingen topp → 0 giveback');
}

// 17. Strikt null-normalisering: saknat värde blir ALDRIG 0, men äkta 0/"0" gäller.
{
  const n = svc.normalizeExcursionNumber;
  assert.equal(n(null), null, 'null → null (ej 0)');
  assert.equal(n(undefined), null, 'undefined → null');
  assert.equal(n(''), null, 'tom sträng → null');
  assert.equal(n(0), 0, 'talet 0 → 0');
  assert.equal(n('0'), 0, 'strängen "0" → 0');
  assert.equal(n(29910.5), 29910.5, 'finit tal passerar');
  assert.equal(n(NaN), null, 'NaN → null');
  assert.equal(n('abc'), null, 'icke-numerisk sträng → null');
}

// 18. isInstrumented: bara positioner med mfeMaeSource räknas som instrumenterade.
{
  assert.equal(svc.isInstrumented({ mfeMaeSource: 'runtime_price_updates' }), true);
  assert.equal(svc.isInstrumented({ mfeMaeSource: null }), false, 'legacy null');
  assert.equal(svc.isInstrumented({}), false, 'saknar fältet');
  assert.equal(svc.isInstrumented(null), false, 'null-position');
}

// 19. Legacy-guard: applyPriceObservation gör INGEN excursionberäkning utan
// mfeMaeSource (returnerar {} → ledgern lämnar fälten orörda).
{
  // Legacy-position med skräpfält (som live-buggen skapade): low=0.
  const legacy = { highestPriceWhileOpen: 29962.75, lowestPriceWhileOpen: 0, mfeMaeSource: undefined };
  const out = svc.applyPriceObservation(legacy, { price: 29860, ...ctx('short', 29910.5) });
  assert.deepEqual(out, {}, 'legacy → tomt objekt, ingen falsk MFE');
  assert.equal(legacy.lowestPriceWhileOpen, 0, 'input orörd');
}

// 20. Legacy-guard: finalizeExcursion sätter inga excursion-slutvärden utan
// mfeMaeSource (exitType lämnas åt läsvyn).
{
  const legacy = { highestPriceWhileOpen: 29962.75, lowestPriceWhileOpen: 0 };
  const out = svc.finalizeExcursion(legacy, { exitPrice: 29835.75, exitReason: 'take_profit_hit', grossPnlSek: 500, ...ctx('short', 29910.5) });
  assert.deepEqual(out, {}, 'legacy close → inga falska excursion-fält');
}

// 21. Instrumenterad long med legitimt nollvärde (MFE 0 vid ren förlust) förstörs ej.
{
  let t = svc.initExcursion({ entryPrice: 100, side: 'long', stopLoss: 95, pointValueUsd: PV, contracts: SIZE, fxUsdSek: FX });
  t = svc.applyPriceObservation(t, { price: 98, ...ctx('long', 100) }); // aldrig över entry
  assert.equal(t.maximumFavorableExcursionPoints, 0, 'äkta 0 MFE bevaras');
  assert.equal(t.maximumFavorableExcursionSek, 0);
  assert.equal(t.mfeMaeSource, 'runtime_price_updates', 'fortsatt instrumenterad');
}

console.log('futuresPaperExcursionService.test.js passed');
