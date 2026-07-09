'use strict';

const overview = require('./supervisorOverviewService');

// process.send() over IPC is asynchronous: for large payloads (the overview is
// ~50KB+) the message is queued but may not be flushed to the parent before the
// process exits. Calling process.exit() immediately after send() truncates the
// pending write, so the parent never receives 'message' and instead sees the
// child exit — surfacing as overview_worker_exit_0 and a cache that never warms.
// Defer exit until the send callback confirms the message was handed off.
function sendThenExit(message, exitCode) {
  if (typeof process.send === 'function') {
    process.send(message, (err) => process.exit(err ? 1 : exitCode));
    return;
  }
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(message), () => process.exit(exitCode));
}

(async () => {
  try {
    const payload = await overview.buildOverview();
    sendThenExit({ type: 'overview_result', ok: true, payload }, 0);
  } catch (err) {
    sendThenExit({ type: 'overview_result', ok: false, error: err && err.message ? err.message : String(err) }, 1);
  }
})();
