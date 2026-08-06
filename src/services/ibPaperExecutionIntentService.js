'use strict';

// IBKR Paper Execution — intent-store med idempotens och statusmaskin.
//
// Varje execution intent (candidate → möjlig broker-order) persisteras här
// INNAN någon submit får ske. Idempotency key är stabil över restart och
// gör dubbelorder tekniskt omöjlig: en intent per nyckel, oavsett hur många
// gånger samma candidate/signal dyker upp.
//
// Detta lager rör ALDRIG IB. Det är ren state/persistens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXECUTION_SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  paper_trading_enabled: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  paperOnly: true,
  source: 'ib_paper_execution_intent',
});

// Statusmaskin (§14): väldefinierade lägen, inga tysta övergångar.
const INTENT_STATUSES = Object.freeze([
  'intent_created',
  'guard_blocked',
  'guard_passed',
  'shadow_logged',
  'submit_started',
  'submitted',
  'acknowledged',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'reconciliation_required',
  'unknown',
]);

const DEFAULT_DIR = path.resolve(__dirname, '../../data/futures-paper/ibkr-execution');

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

// Stabil idempotency key (§14): strategi + instrument + kontrakt + riktning +
// candidate + signal-timestamp + konto + environment.
function buildIdempotencyKey({
  strategyId,
  root,
  conId,
  direction,
  candidateId,
  signalTimestamp,
  accountIdMasked,
  environment = 'paper',
}) {
  const parts = [
    String(strategyId || ''),
    String(root || '').toUpperCase(),
    String(conId || ''),
    String(direction || '').toLowerCase(),
    String(candidateId || ''),
    String(signalTimestamp || ''),
    String(accountIdMasked || ''),
    String(environment),
  ];
  if (parts.some((p) => !p)) return null; // ofullständig identitet → ingen nyckel, ingen submit
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function createIbPaperExecutionIntentService(options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const intentsFile = path.join(dir, 'intents.jsonl');
  const indexFile = path.join(dir, 'intent-index.json');
  let index = null; // idempotencyKey -> {executionId, status, updatedAt}

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function loadIndex() {
    if (index) return index;
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (_) {
      index = {};
    }
    return index;
  }

  function saveIndex() {
    ensureDir();
    const tmp = path.join(dir, `.intent-index.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(index, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, indexFile);
  }

  function appendEvent(row) {
    ensureDir();
    fs.appendFileSync(intentsFile, `${JSON.stringify(row)}\n`, 'utf8');
  }

  function hasIntent(idempotencyKey) {
    if (!idempotencyKey) return false;
    return Boolean(loadIndex()[idempotencyKey]);
  }

  function getIntent(idempotencyKey) {
    if (!idempotencyKey) return null;
    return loadIndex()[idempotencyKey] || null;
  }

  // Skapa intent idempotent. Returnerar {created:false, existing} om nyckeln
  // redan finns — anroparen får ALDRIG skapa en ny order då.
	  function createIntent({ idempotencyKey, executionId, intent }) {
    if (!idempotencyKey) {
      return { created: false, error: 'idempotency_key_missing' };
    }
    const idx = loadIndex();
    if (idx[idempotencyKey]) {
      return { created: false, duplicate: true, existing: idx[idempotencyKey] };
    }
	    const record = {
      executionId: executionId || `exec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      idempotencyKey,
      status: 'intent_created',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      strategyId: intent?.strategyId || null,
      candidateId: intent?.candidateId || null,
      root: intent?.root || null,
      conId: intent?.conId || null,
      direction: intent?.direction || null,
	      executionTarget: intent?.executionTarget || 'shadow',
	      signalTimestamp: intent?.signalTimestamp || null,
	      orderType: intent?.orderType || null,
	      quantity: intent?.quantity ?? null,
	      paperAccountIdMasked: intent?.paperAccountIdMasked || null,
	      localSymbol: intent?.localSymbol || null,
	      contractFingerprint: intent?.contractFingerprint || null,
	    };
    idx[idempotencyKey] = record;
    // Index skrivs FÖRE eventloggen så att en krasch aldrig kan lämna en
    // "osynlig" intent som senare dubbleras.
    index = idx;
    saveIndex();
    appendEvent({ type: 'intent_created', ...record, intent: intent || null, ...EXECUTION_SAFETY });
    return { created: true, record };
  }

	  function updateStatus(idempotencyKey, status, extra = {}) {
    if (!INTENT_STATUSES.includes(status)) {
      return { ok: false, error: `unknown_status_${status}` };
    }
    const idx = loadIndex();
    const record = idx[idempotencyKey];
    if (!record) return { ok: false, error: 'intent_not_found' };
    record.status = status;
    record.updatedAt = nowIso();
	    if (extra.ibOrderId != null) record.ibOrderId = extra.ibOrderId;
	    if (extra.permId != null) record.permId = extra.permId;
	    if (extra.orderRef) record.orderRef = extra.orderRef;
	    for (const key of [
	      'submitStartedAt',
	      'expectedAccountMasked',
	      'expectedOrderIds',
	      'expectedBracketLegs',
	      'contractFingerprint',
	      'evidenceFingerprint',
	      'side',
	      'quantity',
	      'parentOrderId',
	      'orderRefs',
	      'reconciliationRequired',
	      'blocker',
	      'ibErrorCode',
	      'ibErrorMessage',
	      'rejectedOrderId',
	      'rejectedReason',
	      'cancelledOrderId',
	      'cancelReason',
	      'protectiveOrderCancelledId',
	      'protectiveOrderCancelReason',
	      'entryFilledOrderId',
	      'entryFilledAt',
	      'entryFilledPrice',
	      'entryAvgFillPrice',
	      'entryLastFillPrice',
	      'entryExecId',
	      'entryExecutionTime',
	      'entrySide',
	      'entryQuantity',
	      'entryCommission',
	      'entryCommissionCurrency',
	      'filledOrderId',
	      'filledLeg',
	      'filledAt',
	      'filledPrice',
	      'filledAvgPrice',
	      'filledLastPrice',
	      'filledExecId',
	      'filledExecutionTime',
	      'filledSide',
	      'filledQuantity',
	      'filledCommission',
	      'filledCommissionCurrency',
	      'filledRealizedPNL',
	    ]) {
	      if (Object.prototype.hasOwnProperty.call(extra, key)) record[key] = extra[key];
	    }
	    index = idx;
    saveIndex();
    appendEvent({ type: 'status_change', idempotencyKey, executionId: record.executionId, status, ...extra, at: nowIso(), ...EXECUTION_SAFETY });
    return { ok: true, record };
  }

  function listIntents({ limit = 50 } = {}) {
    const idx = loadIndex();
    return Object.values(idx)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, limit));
  }

  function listEvents({ limit = 100 } = {}) {
    try {
      const lines = fs.readFileSync(intentsFile, 'utf8').trim().split('\n');
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function countByStatus() {
    const counts = {};
    for (const record of Object.values(loadIndex())) {
      counts[record.status] = (counts[record.status] || 0) + 1;
    }
    return counts;
  }

  function resetForTests() {
    index = {};
    ensureDir();
    saveIndex();
    try { fs.unlinkSync(intentsFile); } catch (_) { /* ok */ }
  }

  return {
    EXECUTION_SAFETY,
    INTENT_STATUSES,
    dir,
    buildIdempotencyKey,
    hasIntent,
    getIntent,
    createIntent,
    updateStatus,
    listIntents,
    listEvents,
    countByStatus,
    resetForTests,
  };
}

const defaultIbPaperExecutionIntentService = createIbPaperExecutionIntentService();

module.exports = {
  EXECUTION_SAFETY,
  INTENT_STATUSES,
  buildIdempotencyKey,
  createIbPaperExecutionIntentService,
  defaultIbPaperExecutionIntentService,
};
