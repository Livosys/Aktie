#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { parseArgs, runImport } = require('../src/services/alpacaHistorical2mImportService');

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const result = await runImport(input);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    dryRun: !process.argv.includes('--execute'),
    executed: false,
    error: err.message,
    safety: {
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    },
  }, null, 2));
  process.exit(1);
});
