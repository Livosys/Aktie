'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATION_VERSION = 'fas26c_legacy_lifecycle_identity_v1';
const MIGRATION_SOURCE = 'fas26c_legacy_identity_one_shot';
const UNMIGRATABLE_STATUS = 'legacy_unmigratable';
const UNMIGRATABLE_REASON = 'missing_identity_root';

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function lifecycleIdFromSignalId(signalId) {
  const id = text(signalId);
  if (!id) return null;
  return `signal_lifecycle_${crypto.createHash('sha1').update(id).digest('hex').slice(0, 24)}`;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter((row) => row.line.trim())
    .map(({ line, lineNo }) => {
      try {
        return { row: JSON.parse(line), lineNo };
      } catch (err) {
        return { parseError: err.message, lineNo, raw: line };
      }
    });
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJsonlAtomic(file, rows) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file, suffix) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak.${suffix}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function addSet(map, key, value) {
  const k = text(key);
  const v = text(value);
  if (!k || !v) return;
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(v);
}

function objectField(row, ...keys) {
  for (const key of keys) {
    const value = text(row?.[key]);
    if (value) return value;
  }
  return null;
}

function identityCandidateId(row = {}) {
  return objectField(row, 'candidateId', 'candidate_id', 'sourceCandidateId')
    || objectField(row.candidate, 'candidateId', 'candidate_id')
    || objectField(row.details, 'candidateId', 'candidate_id')
    || objectField(row.payload, 'candidateId', 'candidate_id')
    || objectField(row.trade, 'candidateId', 'candidate_id');
}

function identitySignalId(row = {}) {
  return objectField(row, 'signalId', 'signal_id', 'originalSignalId', 'original_signal_id')
    || objectField(row.candidate, 'signalId', 'signal_id', 'originalSignalId', 'original_signal_id')
    || objectField(row.details, 'signalId', 'signal_id', 'originalSignalId', 'original_signal_id')
    || objectField(row.payload, 'signalId', 'signal_id', 'originalSignalId', 'original_signal_id')
    || objectField(row.trade, 'signalId', 'signal_id', 'originalSignalId', 'original_signal_id');
}

function identityIdempotencyKey(row = {}) {
  return objectField(row, 'idempotencyKey', 'idempotency_key')
    || objectField(row.intent, 'idempotencyKey', 'idempotency_key');
}

function identityExecutionId(row = {}) {
  return objectField(row, 'executionId', 'execution_id', 'internalExecutionId', 'executionAttemptId', 'execution_attempt_id')
    || objectField(row.execution, 'executionId', 'execution_id', 'internalExecutionId');
}

function identityOrderRef(row = {}) {
  return objectField(row, 'orderRef', 'order_ref')
    || objectField(row.order, 'orderRef', 'order_ref')
    || objectField(row.execution, 'orderRef', 'order_ref');
}

function indexCandidate(indexes, candidate = {}) {
  const candidateId = identityCandidateId(candidate);
  const signalId = identitySignalId(candidate);
  if (candidateId && signalId) addSet(indexes.candidateToSignal, candidateId, signalId);
}

function mergeIntent(primary = {}, patch = {}) {
  const next = { ...primary };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value != null && value !== '') next[key] = value;
  }
  return next;
}

function buildIndexes(dataDir) {
  const futuresDir = path.join(dataDir, 'futures-paper');
  const intentsFile = path.join(futuresDir, 'ibkr-execution', 'intents.jsonl');
  const intentIndexFile = path.join(futuresDir, 'ibkr-execution', 'intent-index.json');
  const eventsFile = path.join(futuresDir, 'events.jsonl');

  const indexes = {
    candidateToSignal: new Map(),
    idempotencyToIntent: new Map(),
    executionToIdempotency: new Map(),
    orderRefToIdempotency: new Map(),
  };

  for (const entry of readJsonl(eventsFile)) {
    if (entry.parseError) continue;
    const row = entry.row;
    if (Array.isArray(row.candidates)) row.candidates.forEach((candidate) => indexCandidate(indexes, candidate));
    ['candidate', 'details', 'payload', 'trade'].forEach((key) => {
      if (row[key] && typeof row[key] === 'object') indexCandidate(indexes, row[key]);
    });
    indexCandidate(indexes, row);
  }

  const intentIndex = readJson(intentIndexFile, {});
  Object.entries(intentIndex || {}).forEach(([key, row]) => {
    const idempotencyKey = identityIdempotencyKey(row) || key;
    if (!idempotencyKey) return;
    indexes.idempotencyToIntent.set(idempotencyKey, { ...row, idempotencyKey });
    const executionId = identityExecutionId(row);
    const orderRef = identityOrderRef(row);
    if (executionId) addSet(indexes.executionToIdempotency, executionId, idempotencyKey);
    if (orderRef) addSet(indexes.orderRefToIdempotency, orderRef, idempotencyKey);
  });

  for (const entry of readJsonl(intentsFile)) {
    if (entry.parseError) continue;
    const row = entry.row;
    const idempotencyKey = identityIdempotencyKey(row);
    if (!idempotencyKey) continue;
    indexes.idempotencyToIntent.set(
      idempotencyKey,
      mergeIntent(indexes.idempotencyToIntent.get(idempotencyKey), row),
    );
    const executionId = identityExecutionId(row);
    const orderRef = identityOrderRef(row);
    if (executionId) addSet(indexes.executionToIdempotency, executionId, idempotencyKey);
    if (orderRef) addSet(indexes.orderRefToIdempotency, orderRef, idempotencyKey);
  }

  return indexes;
}

function setValues(values) {
  return Array.from(values || []).filter(Boolean);
}

function resolveCandidate(indexes, candidateId, paths, signals, broken) {
  const id = text(candidateId);
  if (!id) return;
  const values = setValues(indexes.candidateToSignal.get(id));
  if (values.length > 1) {
    broken.push({ type: 'candidateId_duplicate_roots', candidateId: id, roots: values });
    return;
  }
  if (values.length === 1) {
    signals.add(values[0]);
    paths.add('candidateId');
  }
}

function resolveIntent(indexes, intent, paths, signals, broken, source) {
  if (!intent) return;
  const signalId = identitySignalId(intent);
  if (signalId) {
    signals.add(signalId);
    paths.add(`${source}:signalId`);
  }
  resolveCandidate(indexes, identityCandidateId(intent), paths, signals, broken);
}

function resolveBySingleIntentKey(indexes, map, key, paths, signals, broken, source, field) {
  const id = text(key);
  if (!id) return;
  const values = setValues(map.get(id));
  if (values.length > 1) {
    broken.push({ type: `${field}_duplicate_intents`, value: id, idempotencyKeys: values });
    return;
  }
  if (values.length === 1) {
    resolveIntent(indexes, indexes.idempotencyToIntent.get(values[0]), paths, signals, broken, source);
  }
}

function resolveLifecycle(indexes, row = {}) {
  const signals = new Set();
  const paths = new Set();
  const broken = [];

  const directSignalId = identitySignalId(row);
  if (directSignalId) {
    signals.add(directSignalId);
    paths.add('signalId');
  }

  resolveCandidate(indexes, identityCandidateId(row), paths, signals, broken);

  const idempotencyKey = identityIdempotencyKey(row);
  if (idempotencyKey) {
    resolveIntent(indexes, indexes.idempotencyToIntent.get(idempotencyKey), paths, signals, broken, 'idempotencyKey');
  }

  resolveBySingleIntentKey(
    indexes,
    indexes.executionToIdempotency,
    identityExecutionId(row),
    paths,
    signals,
    broken,
    'executionId',
    'executionId',
  );

  resolveBySingleIntentKey(
    indexes,
    indexes.orderRefToIdempotency,
    identityOrderRef(row),
    paths,
    signals,
    broken,
    'orderRef',
    'orderRef',
  );

  const uniqueSignals = setValues(signals);
  const lifecycleIds = setValues(new Set(uniqueSignals.map(lifecycleIdFromSignalId)));
  if (lifecycleIds.length > 1) {
    broken.push({ type: 'identity_roots_conflict', signalIds: uniqueSignals, lifecycleIds });
  }

  return {
    lifecycleId: lifecycleIds.length === 1 ? lifecycleIds[0] : null,
    signalId: uniqueSignals.length === 1 ? uniqueSignals[0] : null,
    paths: setValues(paths),
    broken,
  };
}

function migrationFields(migratedAt, migrationSource) {
  return {
    migrationVersion: MIGRATION_VERSION,
    migratedAt,
    migrationSource,
  };
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function migrateObject(row, indexes, stats, migratedAt, context) {
  if (!isObject(row)) return row;
  const resolved = resolveLifecycle(indexes, row);
  if (resolved.broken.length) {
    stats.brokenJoins.push({ context, broken: resolved.broken });
    return row;
  }

  const existingLifecycleId = text(row.lifecycleId);
  if (existingLifecycleId) {
    stats.alreadyHadLifecycleId += 1;
    if (resolved.lifecycleId && existingLifecycleId !== resolved.lifecycleId) {
      stats.brokenJoins.push({
        context,
        broken: [{ type: 'existing_lifecycle_mismatch', existingLifecycleId, resolvedLifecycleId: resolved.lifecycleId }],
      });
    }
    return row;
  }

  stats.legacyRows += 1;
  if (resolved.lifecycleId) {
    stats.migrated += 1;
    return {
      ...row,
      lifecycleId: resolved.lifecycleId,
      ...migrationFields(migratedAt, `${MIGRATION_SOURCE}:${resolved.paths.join('+') || 'resolved'}`),
    };
  }

  stats.unmigratable += 1;
  return {
    ...row,
    identityStatus: UNMIGRATABLE_STATUS,
    migrationReason: UNMIGRATABLE_REASON,
    ...migrationFields(migratedAt, MIGRATION_SOURCE),
  };
}

function migrateKnownNestedObjects(row, indexes, stats, migratedAt, context) {
  let next = migrateObject(row, indexes, stats, migratedAt, context);
  if (!isObject(next)) return next;

  if (Array.isArray(next.candidates)) {
    next = {
      ...next,
      candidates: next.candidates.map((candidate, index) => (
        migrateObject(candidate, indexes, stats, migratedAt, `${context}.candidates[${index}]`)
      )),
    };
  }

  for (const key of ['candidate', 'details', 'payload', 'trade', 'intent', 'order', 'execution']) {
    if (isObject(next[key])) {
      next = {
        ...next,
        [key]: migrateObject(next[key], indexes, stats, migratedAt, `${context}.${key}`),
      };
    }
  }

  return next;
}

function createStats(name) {
  return {
    name,
    alreadyHadLifecycleId: 0,
    legacyRows: 0,
    migrated: 0,
    unmigratable: 0,
    brokenJoins: [],
  };
}

function migrateJsonlDataset({ name, file, indexes, migratedAt, write, backupSuffix }) {
  const entries = readJsonl(file);
  const stats = createStats(name);
  const migratedRows = [];
  for (const entry of entries) {
    if (entry.parseError) {
      stats.brokenJoins.push({ context: `${name}:${entry.lineNo}`, broken: [{ type: 'json_parse_error', error: entry.parseError }] });
      continue;
    }
    migratedRows.push(migrateKnownNestedObjects(entry.row, indexes, stats, migratedAt, `${name}:${entry.lineNo}`));
  }
  if (!stats.brokenJoins.length && write) {
    backupFile(file, backupSuffix);
    writeJsonlAtomic(file, migratedRows);
  }
  return stats;
}

function migrateIntentIndex({ file, indexes, migratedAt, write, backupSuffix }) {
  const stats = createStats('intent-index.json');
  const input = readJson(file, {});
  const output = {};
  Object.entries(input || {}).forEach(([key, row]) => {
    output[key] = migrateKnownNestedObjects(
      { ...row, idempotencyKey: row.idempotencyKey || key },
      indexes,
      stats,
      migratedAt,
      `intent-index.json:${key}`,
    );
  });
  if (!stats.brokenJoins.length && write) {
    backupFile(file, backupSuffix);
    writeJsonAtomic(file, output);
  }
  return stats;
}

function migratePositions({ file, indexes, migratedAt, write, backupSuffix }) {
  const stats = createStats('ledger positions.json');
  const input = readJson(file, {});
  const output = { ...input };
  for (const key of ['open', 'closed']) {
    if (!Array.isArray(input[key])) continue;
    output[key] = input[key].map((row, index) => (
      migrateKnownNestedObjects(row, indexes, stats, migratedAt, `positions.json:${key}[${index}]`)
    ));
  }
  if (!stats.brokenJoins.length && write) {
    backupFile(file, backupSuffix);
    writeJsonAtomic(file, output);
  }
  return stats;
}

function summarize(statsList) {
  const totals = statsList.reduce((acc, stats) => {
    acc.alreadyHadLifecycleId += stats.alreadyHadLifecycleId;
    acc.legacyRows += stats.legacyRows;
    acc.migrated += stats.migrated;
    acc.unmigratable += stats.unmigratable;
    acc.brokenJoins += stats.brokenJoins.length;
    return acc;
  }, {
    alreadyHadLifecycleId: 0,
    legacyRows: 0,
    migrated: 0,
    unmigratable: 0,
    brokenJoins: 0,
  });
  totals.migratable = totals.migrated;
  totals.coveragePct = totals.legacyRows > 0
    ? Number(((totals.migrated / totals.legacyRows) * 100).toFixed(4))
    : 100;
  totals.identityPreservationPct = totals.migrated > 0 && totals.brokenJoins === 0 ? 100 : (totals.migrated === 0 ? 100 : 0);
  return totals;
}

function parseArgs(argv) {
  const args = { dataDir: path.resolve(__dirname, '../data'), write: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--dry-run') args.write = false;
    else if (arg === '--data-dir') {
      args.dataDir = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function run(argv = process.argv) {
  const args = parseArgs(argv);
  const migratedAt = new Date().toISOString();
  const backupSuffix = `${MIGRATION_VERSION}.${migratedAt.replace(/[:.]/g, '-')}`;
  const indexes = buildIndexes(args.dataDir);
  const futuresDir = path.join(args.dataDir, 'futures-paper');
  const ibDir = path.join(args.dataDir, 'interactive-brokers');
  const datasets = [
    () => migrateJsonlDataset({
      name: 'intents.jsonl',
      file: path.join(futuresDir, 'ibkr-execution', 'intents.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateIntentIndex({
      file: path.join(futuresDir, 'ibkr-execution', 'intent-index.json'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateJsonlDataset({
      name: 'trades.jsonl',
      file: path.join(futuresDir, 'trades.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migratePositions({
      file: path.join(futuresDir, 'positions.json'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateJsonlDataset({
      name: 'futures-paper/events.jsonl',
      file: path.join(futuresDir, 'events.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateJsonlDataset({
      name: 'broker events paper-execution-events.jsonl',
      file: path.join(ibDir, 'paper-execution-events.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateJsonlDataset({
      name: 'fills/execution events paper-executions.jsonl',
      file: path.join(ibDir, 'paper-executions.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
    () => migrateJsonlDataset({
      name: 'execution events paper-one-shot-arm-events.jsonl',
      file: path.join(ibDir, 'paper-one-shot-arm-events.jsonl'),
      indexes,
      migratedAt,
      write: args.write,
      backupSuffix,
    }),
  ];

  const stats = datasets.map((migrate) => migrate());
  const broken = stats.flatMap((entry) => entry.brokenJoins.map((brokenJoin) => ({ dataset: entry.name, ...brokenJoin })));
  const result = {
    ok: broken.length === 0,
    mode: args.write ? 'write' : 'dry-run',
    migrationVersion: MIGRATION_VERSION,
    migrationSource: MIGRATION_SOURCE,
    migratedAt,
    dataDir: args.dataDir,
    stats,
    totals: summarize(stats),
    brokenJoins: broken,
    duplicateRoots: broken.filter((row) => /duplicate_roots|duplicate_intents|conflict/.test(String(row.broken?.[0]?.type || ''))).length,
    orphanRows: stats.reduce((acc, entry) => acc + entry.unmigratable, 0),
    brokerOrderIdRootUsed: false,
    heuristicJoins: 0,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  MIGRATION_VERSION,
  MIGRATION_SOURCE,
  lifecycleIdFromSignalId,
  buildIndexes,
  resolveLifecycle,
  run,
};
