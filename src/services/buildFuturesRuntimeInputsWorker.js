'use strict';

// Barnprocess som gör de tunga, rent filbaserade läsningarna för
// /api/futures-paper/runtime. Mätning 2026-07-29: ledger 5,9s +
// closed trades 6,3s + strategilistan 4,8s = i praktiken hela bygget på ~13s,
// medan resten av bygget kostar ~46ms. De läsningarna är synkrona, så i
// serverprocessen frös de event-loopen (och därmed hela UI:t) varje gång
// cachen byggdes om.
//
// Workern räknar ALDRIG ut den färdiga runtime-payloaden. Broker-, quote- och
// kontotillståndet är in-memory-state som bara finns i serverprocessen
// (getCachedReconciliation/getStatus/getCachedSummary ~0-1ms där, tomt här),
// så ett bygge här hade tyst gett noll positioner och fel feed-status.
// Parenten sätter ihop payloaden med sitt eget levande tillstånd.

const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const paperEnabledStrategiesService = require('./paperEnabledStrategiesService');
const futuresPaperScannerService = require('./futuresPaperScannerService');

// process.send() är asynkront och nyttolasten här är ~1MB: exit direkt efter
// send() trunkerar skrivningen så parenten aldrig får 'message' utan bara ser
// exit-koden. Samma fälla som buildOverviewWorker.js dokumenterar — vänta på
// send-callbacken innan vi avslutar.
function sendThenExit(message, exitCode) {
  if (typeof process.send === 'function') {
    process.send(message, (err) => process.exit(err ? 1 : exitCode));
    return;
  }
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(message), () => process.exit(exitCode));
}

// Limits speglar exakt vad buildFuturesPaperDeskRuntime skulle ha använt:
// ledger `options.limit || 50` och closed trades
// `scannerRuntime?.engineConfig?.closedTradesLimit || 100`. Scanner-runtimen
// kostar ~4ms och läses här så parenten slipper allt filarbete.
function buildRuntimeInputs({ now = new Date() } = {}) {
  const ledger = futuresPaperLedgerService.defaultFuturesPaperLedgerService;
  let closedTradesLimit = 100;
  try {
    const scannerRuntime = futuresPaperScannerService.defaultFuturesPaperScannerService.getScannerRuntime({ now });
    closedTradesLimit = scannerRuntime?.engineConfig?.closedTradesLimit || 100;
  } catch (_) { /* samma fallback som bygget */ }
  return {
    legacyLedger: ledger.getFuturesPaperLedger({ limit: 50 }),
    legacyClosedTrades: ledger.getRecentClosedTrades({ limit: closedTradesLimit }),
    paperStrategies: paperEnabledStrategiesService.buildPaperStrategyList({ fresh: false }),
  };
}

if (require.main === module) {
  try {
    const payload = buildRuntimeInputs({ now: new Date() });
    sendThenExit({ type: 'futures_runtime_inputs', ok: true, payload }, 0);
  } catch (err) {
    sendThenExit({
      type: 'futures_runtime_inputs',
      ok: false,
      error: err && err.message ? err.message : String(err),
    }, 1);
  }
}

module.exports = { buildRuntimeInputs };
