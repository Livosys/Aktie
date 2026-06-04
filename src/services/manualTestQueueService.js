'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

const VALID_STATUSES = new Set(['pending', 'cancelled', 'completed', 'failed']);
const VALID_TEST_TYPES = new Set(['replay', 'batch', 'paper_observation', 'history_review']);
const DEFAULT_QUEUE_FILE = path.resolve(__dirname, '../../data/manual-test-queue.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch (_) {
    return {};
  }
}

function safeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `queue_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function normalizeRecommendation(input = {}) {
  const recommendation = input?.recommendation && typeof input.recommendation === 'object'
    ? input.recommendation
    : input;
  const now = nowIso();

  return {
    id: safeString(recommendation.id),
    strategy_id: safeString(recommendation.strategy_id || recommendation.strategyId),
    test_type: safeString(recommendation.test_type || recommendation.testType).toLowerCase(),
    source: safeString(recommendation.source || 'planner').toLowerCase() || 'planner',
    priority: safeNumber(recommendation.priority, 0),
    reason: safeString(recommendation.reason),
    suggested_scope: safeString(recommendation.suggested_scope),
    expected_learning_value: safeString(recommendation.expected_learning_value),
    safety_note: safeString(recommendation.safety_note),
    mode: 'paper_only',
    created_by: 'user',
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
}

function queueKey(item) {
  return safeString(item?.id);
}

function foldQueue(records) {
  const byId = new Map();
  for (const record of records) {
    const id = queueKey(record);
    if (!id) continue;
    const prev = byId.get(id) || null;
    if (!prev) {
      byId.set(id, { ...record });
      continue;
    }
    byId.set(id, {
      ...prev,
      ...record,
      created_at: prev.created_at || record.created_at || null,
      updated_at: record.updated_at || prev.updated_at || null,
      cancelled_at: record.cancelled_at || prev.cancelled_at || null,
      completed_at: record.completed_at || prev.completed_at || null,
      failed_at: record.failed_at || prev.failed_at || null,
    });
  }

  return [...byId.values()].sort((a, b) => {
    const statusWeight = (value) => {
      const status = safeString(value.status).toLowerCase();
      if (status === 'pending') return 0;
      if (status === 'completed') return 1;
      if (status === 'cancelled') return 2;
      if (status === 'failed') return 3;
      return 4;
    };
    return statusWeight(a) - statusWeight(b)
      || String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || String(a.strategy_id || '').localeCompare(String(b.strategy_id || ''));
  });
}

function summarizeQueue(items) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    completed: items.filter((item) => item.status === 'completed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };
}

function createManualTestQueueService(options = {}) {
  const queueFile = options.queueFile || DEFAULT_QUEUE_FILE;

  function loadRawRecords() {
    return readJsonl(queueFile);
  }

  function listQueueItems() {
    return foldQueue(loadRawRecords());
  }

  function getQueueItem(id) {
    const key = safeString(id);
    if (!key) return null;
    return listQueueItems().find((item) => item.id === key) || null;
  }

  function getStatus() {
    const items = listQueueItems();
    return {
      ok: true,
      queue_file: queueFile,
      items,
      summary: summarizeQueue(items),
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function addFromRecommendation(input = {}) {
    const recommendation = normalizeRecommendation(input);
    if (!recommendation.strategy_id) {
      return { ok: false, error: 'strategy_id_required', ...SAFETY };
    }
    if (!VALID_TEST_TYPES.has(recommendation.test_type)) {
      return { ok: false, error: 'invalid_test_type', ...SAFETY };
    }

    const now = nowIso();
    const item = {
      id: safeId(),
      created_at: now,
      updated_at: now,
      status: 'pending',
      source: 'planner',
      strategy_id: recommendation.strategy_id,
      test_type: recommendation.test_type,
      priority: recommendation.priority,
      reason: recommendation.reason,
      suggested_scope: recommendation.suggested_scope,
      expected_learning_value: recommendation.expected_learning_value,
      safety_note: recommendation.safety_note,
      mode: 'paper_only',
      created_by: 'user',
    };
    appendJsonl(queueFile, item);

    return {
      ok: true,
      created: true,
      item,
      ...SAFETY,
    };
  }

  function cancelQueueItem(id) {
    const key = safeString(id);
    if (!key) {
      return { ok: false, error: 'queue_id_required', ...SAFETY };
    }
    const current = getQueueItem(key);
    if (!current) {
      return { ok: false, error: 'queue_item_not_found', ...SAFETY };
    }
    if (current.status !== 'pending') {
      return { ok: false, error: 'queue_item_not_pending', current, ...SAFETY };
    }

    const now = nowIso();
    const cancelled = {
      ...current,
      status: 'cancelled',
      updated_at: now,
      cancelled_at: now,
      mode: 'paper_only',
      source: 'planner',
      created_by: current.created_by || 'user',
    };
    appendJsonl(queueFile, cancelled);

    return {
      ok: true,
      cancelled: true,
      item: getQueueItem(key),
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    queueFile,
    getStatus,
    listQueueItems,
    getQueueItem,
    addFromRecommendation,
    cancelQueueItem,
  };
}

const defaultManualTestQueueService = createManualTestQueueService();

module.exports = {
  SAFETY,
  VALID_STATUSES,
  VALID_TEST_TYPES,
  DEFAULT_QUEUE_FILE,
  createManualTestQueueService,
  defaultManualTestQueueService,
};
