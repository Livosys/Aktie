'use strict';

// Barnprocess som kör hela autoMachine-pipelinen.
//
// Pipelinen är synkron filbearbetning från början till slut. Mätt i drift
// 2026-07-30T20:38:32Z blockerade den serverns event-loop i 22,6s — hela
// körningen. Här kostar samma arbete ingenting för serverprocessen.
//
// Workern gör INTE något eget urval av steg: den anropar exakt samma
// runAutoMachineInProcess som tidigare kördes i servern, så beteendet och
// statusfilen är identiska. Skillnaden är bara vilken process som betalar.
//
// Föräldern sköter det som är bundet till serverprocessens minne — isRunning()
// och invalidateCache() på historicalEdge. Se kommentaren i autoMachine.js.

const { runAutoMachineInProcess } = require('./autoMachine');

// process.send() är asynkront; att avsluta direkt efter send() trunkerar
// skrivningen så föräldern aldrig får 'message' utan bara ser exit-koden.
// Samma fälla som buildOverviewWorker.js och buildFuturesRuntimeInputsWorker.js
// dokumenterar — vänta på send-callbacken innan vi avslutar.
function sendThenExit(message, exitCode) {
  if (typeof process.send === 'function') {
    process.send(message, (err) => process.exit(err ? 1 : exitCode));
    return;
  }
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(message), () => process.exit(exitCode));
}

async function handleRun({ lookbackDays, groups }) {
  try {
    const payload = await runAutoMachineInProcess({ lookbackDays, groups });
    sendThenExit({ type: 'auto_machine_result', ok: true, payload }, 0);
  } catch (err) {
    sendThenExit({
      type: 'auto_machine_result',
      ok: false,
      error: err && err.message ? err.message : String(err),
    }, 1);
  }
}

if (require.main === module) {
  process.on('message', (msg) => {
    if (!msg || msg.type !== 'auto_machine_run') return;
    handleRun({
      lookbackDays: msg.lookbackDays,
      groups: Array.isArray(msg.groups) ? msg.groups : [],
    });
  });
}

module.exports = { handleRun };
