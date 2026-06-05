'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Narrow Test Autopilot — safe CLI runner
//
//   node scripts/runNarrowAutopilotOnce.js            → DRY RUN (default)
//        creates a plan, validates it, writes history, prints the recommended
//        next test. Does NOT run any batch/replay.
//
//   node scripts/runNarrowAutopilotOnce.js --execute  → runs ONE small, safe
//        paper/batch test (only if safety validation passes). Never live.
//
// If --execute is missing, dryRun stays true. The autopilot can never place
// real orders, enable a broker, or change live trading.
// ────────────────────────────────────────────────────────────────────────────

const autopilot = require('../src/services/narrowTestAutopilotService');

function parseArgs(argv) {
  const args = { dryRun: true };
  for (const raw of argv.slice(2)) {
    const arg = String(raw).trim();
    if (arg === '--execute') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--max-runs=')) args.maxRuns = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-symbols=')) args.maxSymbols = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-timeframes=')) args.maxTimeframes = Number(arg.split('=')[1]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const result = autopilot.runNarrowAutopilotOnce(args);

  const out = {
    mode: result.mode,
    dryRun: result.dryRun,
    ok: result.ok,
    blocked: Boolean(result.blocked),
    executed: Boolean(result.executed),
    reasons: result.reasons || [],
    message_sv: result.message_sv || null,
    plan: result.plan ? {
      id: result.plan.id,
      strategy_id: result.plan.strategy_id,
      testType: result.plan.testType,
      symbols: result.plan.symbols,
      timeframes: result.plan.timeframes,
      requestedTimeframes: result.plan.requestedTimeframes,
      availableTimeframes: result.plan.availableTimeframes,
      missingTimeframes: result.plan.missingTimeframes,
      requestedNarrowScoreBand: result.plan.requestedNarrowScoreBand,
      selectedNarrowScoreBand: result.plan.selectedNarrowScoreBand,
      bandSelection: result.plan.bandSelection,
      bandAvailability: result.plan.bandAvailability,
      bandSelectionWarnings: result.plan.bandSelectionWarnings,
      filters: result.plan.filters,
      filterEnforcement: result.plan.filterEnforcement,
      limits: result.plan.limits,
      priority: result.plan.priority,
      reason: result.plan.reason,
      status: result.plan.status,
      warnings: result.plan.warnings,
    } : null,
    runStatus: result.runStatus || null,
    summary: result.summary || null,
    safety: {
      actions_allowed: result.actions_allowed,
      can_place_orders: result.can_place_orders,
      live_trading_enabled: result.live_trading_enabled,
      broker_enabled: result.broker_enabled,
    },
  };

  console.log(JSON.stringify(out, null, 2));
  if (!result.ok && result.blocked) process.exitCode = 0; // a blocked plan is a safe, expected outcome
  else if (!result.ok) process.exitCode = 1;
}

main();
