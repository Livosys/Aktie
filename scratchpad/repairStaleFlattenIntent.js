'use strict';
// Engångsreparation: emergency_flatten_ms52m5gk7175 fastnade på 'submitted'
// 2026-07-28 för att legFromOrderRef inte kände igen '-flatten'-benet då.
// Fixen finns i adaptern sedan dess (ibPaperExecutionAdapterService.js:413/452/481);
// den här posten är kvarlämnad från före fixen och degraderar reconciliation
// varje gång en MNQ-position är öppen — vilket hårdblockerar guarden.
//
// Skriver EXAKT det adaptern hade skrivit via intentService.updateStatus():
// samma fält i index-posten, samma status_change-rad i intents.jsonl.
// Rör ingen annan post. Idempotent: kör om utan effekt om status redan är 'filled'.

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '../data/futures-paper/ibkr-execution');
const INDEX_FILE = path.join(DIR, 'intent-index.json');
const INTENTS_FILE = path.join(DIR, 'intents.jsonl');

const KEY = 'flatten:793356225:emergency_flatten_ms52m5gk7175';

// Bevisen, från pm2-loggen 2026-07-28: en NY execId 33 s efter att flatten
// lades, positionen gick platt i samma ögonblick, och ingen intent har någonsin
// gjort anspråk på den (0 träffar i intents.jsonl).
const EVIDENCE = {
  reconciliationRequired: false,
  filledOrderId: 39,
  filledLeg: 'flatten',
  filledAt: '2026-07-28T19:51:12.637Z',
  filledPrice: 27940.75,
  filledExecId: '0000e1a7.6a75ac30.01.01',
  filledSide: 'BOT',
  filledQuantity: 1,
  repairedAt: new Date().toISOString(),
  repairNote: 'stale_flatten_terminal_status_restored_from_broker_evidence',
};

const EXECUTION_SAFETY = {
  mode: 'ibkr_paper',
  paper_trading_enabled: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  paperOnly: true,
  source: 'ib_paper_execution_intent',
};

const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const record = index[KEY];
if (!record) throw new Error(`intent_not_found: ${KEY}`);

console.log('FÖRE :', JSON.stringify({ status: record.status, updatedAt: record.updatedAt }));

if (record.status === 'filled') {
  console.log('Redan reparerad — ingen ändring.');
  process.exit(0);
}
if (record.status !== 'submitted') {
  throw new Error(`unexpected_status: ${record.status} (förväntade 'submitted')`);
}

const before = Object.keys(index).length;
record.status = 'filled';
record.updatedAt = new Date().toISOString();
Object.assign(record, EVIDENCE);

// Index skrivs atomiskt (tmp + rename), samma mönster som saveIndex().
const tmp = path.join(DIR, `.intent-index.repair.${process.pid}.tmp`);
const fd = fs.openSync(tmp, 'w');
try {
  fs.writeSync(fd, `${JSON.stringify(index, null, 2)}\n`);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(tmp, INDEX_FILE);

fs.appendFileSync(INTENTS_FILE, `${JSON.stringify({
  type: 'status_change',
  idempotencyKey: KEY,
  executionId: record.executionId,
  status: 'filled',
  ...EVIDENCE,
  at: new Date().toISOString(),
  ...EXECUTION_SAFETY,
})}\n`, 'utf8');

const after = Object.keys(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))).length;
console.log('EFTER:', JSON.stringify({ status: record.status, updatedAt: record.updatedAt }));
console.log(`Poster i index: ${before} → ${after} (ska vara oförändrat)`);
