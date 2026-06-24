'use strict';

// ---------------------------------------------------------------------------
// Read-only CLI: forward-validate the "skip caution + REGULAR_PULLBACK" filter.
//   node scripts/validateEntryFilterForward.js
//   node scripts/validateEntryFilterForward.js --since=2026-06-24T00:00:00Z
//   node scripts/validateEntryFilterForward.js --json
//
// Observe-only. Never blocks entries, never reads/sets the gate, never writes
// state/orders/config/env. Re-run over coming days to accumulate forward data
// (freeze a start point with --since to keep the forward window stable).
// ---------------------------------------------------------------------------

const svc = require('../src/services/entryFilterForwardValidationService');

const sinceArg = (process.argv.find((a) => a.startsWith('--since=')) || '').split('=')[1];
const result = svc.runForwardValidation(sinceArg ? { since: sinceArg } : {});

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(svc.formatReport(result) + '\n');
}
