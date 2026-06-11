'use strict';

const overview = require('./supervisorOverviewService');

(async () => {
  try {
    const payload = await overview.buildOverview();
    if (typeof process.send === 'function') {
      process.send({ type: 'overview_result', ok: true, payload });
    } else {
      process.stdout.write(JSON.stringify({ ok: true, payload }));
    }
    process.exit(0);
  } catch (err) {
    if (typeof process.send === 'function') {
      process.send({ type: 'overview_result', ok: false, error: err && err.message ? err.message : String(err) });
    } else {
      process.stderr.write(String(err && err.message ? err.message : err));
    }
    process.exit(1);
  }
})();
