'use strict';
// READ-ONLY torrkörning av FAS 18-regeln mot skarp produktionsdata.
const fs = require('fs');
const recon = require('../src/services/ibPaperBrokerReconciliationService');

const index = JSON.parse(fs.readFileSync('data/futures-paper/ibkr-execution/intent-index.json', 'utf8'));
const live = JSON.parse(fs.readFileSync('scratchpad/execstatus.json', 'utf8'));

const intents = Object.values(index)
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  .slice(0, 250);

const byStatus = {};
for (const i of intents) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
console.log('intents:', intents.length, JSON.stringify(byStatus));

const openOrders = live.reconciliation.openOrders || [];
const executions = live.reconciliation.executions || [];
const positions = (live.reconciliation.positions || []).map((p) => ({ ...p, position: p.signedQuantity ?? p.position }));

console.log('broker: openOrders', openOrders.length, '| executions', executions.length, '| positions', positions.length);

const nonTerminal = intents.filter((i) => recon.NON_TERMINAL_INTENT_STATUSES.includes(i.status));
console.log('icke-terminala:', nonTerminal.length, nonTerminal.map((i) => `${i.executionId}(${i.status}, ${i.updatedAt})`).join('\n  '));

const resolvable = recon.findResolvableStaleIntents({ intents, openOrders, executions, positions });
console.log('\nSKULLE LÄKAS:', resolvable.length);
for (const i of resolvable) console.log('  ', i.executionId, i.status, i.updatedAt, '| root', i.root);

const before = recon.compareSnapshots({ intents, openOrders, executions, positions, orderStatuses: live.reconciliation.orderStatuses || [] });
const healedKeys = new Set(resolvable.map((i) => i.idempotencyKey));
const after = recon.compareSnapshots({
  intents: intents.map((i) => (healedKeys.has(i.idempotencyKey) ? { ...i, status: 'expired' } : i)),
  openOrders, executions, positions, orderStatuses: live.reconciliation.orderStatuses || [],
});
console.log('\ndiskrepanser före:', JSON.stringify(before.discrepancies));
console.log('diskrepanser efter:', JSON.stringify(after.discrepancies));
