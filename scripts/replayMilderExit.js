'use strict';

// ---------------------------------------------------------------------------
// Read-only CLI: compare current recorded exits vs milder exit profiles.
//   node scripts/replayMilderExit.js            # full text report
//   node scripts/replayMilderExit.js --json     # machine-readable JSON
//
// Pure read of data/paper-trading/trades.jsonl. Writes nothing, no orders,
// no state/config/env changes. Safe to run repeatedly.
// ---------------------------------------------------------------------------

const svc = require('../src/services/milderExitReplayService');

const result = svc.runComparison();

if (process.argv.includes('--json')) {
  // drop heavy per-trade rows for compact output
  const compact = JSON.parse(JSON.stringify(result));
  for (const id of compact.profileOrder) delete compact.profiles[id].rows;
  process.stdout.write(JSON.stringify(compact, null, 2) + '\n');
} else {
  process.stdout.write(svc.formatReport(result) + '\n');
}
