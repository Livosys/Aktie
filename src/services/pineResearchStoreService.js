'use strict';

const fs = require('fs');
const path = require('path');

const model = require('./pineResearchModelService');

const DEFAULT_ROOT = path.resolve(__dirname, '../../data/research/pine-factory');

const COLLECTIONS = Object.freeze({
  candidates: { file: 'candidates.json', id: 'candidateId', normalize: model.normalizeCandidate },
  versions: { file: 'versions.json', id: 'pineVersionId', normalize: model.normalizeVersion },
  testRuns: { file: 'test-runs.json', id: 'testRunId', normalize: model.normalizeTestRun },
  evaluations: { file: 'evaluations.json', id: 'evaluationId', normalize: model.normalizeEvaluation },
  validations: { file: 'validations.json', id: 'validationId', normalize: model.normalizeValidation },
  queue: { file: 'research-queue.json', id: 'queueId', normalize: (value) => value },
});

function nowIso() {
  return model.nowIso();
}

function createPineResearchStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.PINE_RESEARCH_DIR || DEFAULT_ROOT);
  const eventsFile = path.join(rootDir, 'research-events.jsonl');
  const artifactsDir = path.join(rootDir, 'artifacts');
  const importsDir = path.join(rootDir, 'imports');
  const exportsDir = path.join(rootDir, 'exports');

  function assertInside(file) {
    const resolved = path.resolve(file);
    if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error('pine_research_path_outside_store');
    }
    return resolved;
  }

  function ensureStorage() {
    for (const dir of [rootDir, artifactsDir, importsDir, exportsDir]) {
      fs.mkdirSync(assertInside(dir), { recursive: true });
    }
  }

  function collectionPath(name) {
    const spec = COLLECTIONS[name];
    if (!spec) throw new Error(`unknown_collection_${name}`);
    return assertInside(path.join(rootDir, spec.file));
  }

  function readJsonFile(file, fallback) {
    try {
      if (!fs.existsSync(file)) return { status: 'empty', value: fallback, error: null };
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return { status: 'empty', value: fallback, error: null };
      return { status: 'ok', value: JSON.parse(raw), error: null };
    } catch (err) {
      return {
        status: 'degraded',
        value: fallback,
        error: err?.message || String(err),
      };
    }
  }

  function atomicWriteJson(file, value) {
    ensureStorage();
    const resolved = assertInside(file);
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, resolved);
  }

  function readCollection(name) {
    const spec = COLLECTIONS[name];
    const fallback = [];
    const result = readJsonFile(collectionPath(name), fallback);
    const value = Array.isArray(result.value) ? result.value : fallback;
    return {
      status: result.status,
      items: value,
      error: result.error,
      collection: name,
    };
  }

  function writeCollection(name, items) {
    if (!Array.isArray(items)) throw new Error('collection_must_be_array');
    atomicWriteJson(collectionPath(name), items);
    return { ok: true, status: 'ok', collection: name, count: items.length };
  }

  function upsert(name, input) {
    const spec = COLLECTIONS[name];
    if (!spec) throw new Error(`unknown_collection_${name}`);
    const normalized = spec.normalize(input);
    const id = normalized[spec.id] || input[spec.id];
    if (!id) throw new Error(`${spec.id}_is_required`);
    const current = readCollection(name).items;
    const idx = current.findIndex((item) => item && item[spec.id] === id);
    const existing = idx >= 0 ? current[idx] : null;
    const value = {
      ...(existing || {}),
      ...normalized,
      createdAt: existing?.createdAt || normalized.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    if (idx >= 0) current[idx] = value;
    else current.unshift(value);
    writeCollection(name, current);
    appendEvent({ type: `${name}.upsert`, id, at: nowIso() });
    return value;
  }

  function findById(name, id) {
    const spec = COLLECTIONS[name];
    if (!spec) throw new Error(`unknown_collection_${name}`);
    return readCollection(name).items.find((item) => item && item[spec.id] === id) || null;
  }

  function list(name, filter = {}) {
    const items = readCollection(name).items;
    return items.filter((item) => {
      for (const [key, value] of Object.entries(filter || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (item[key] !== value) return false;
      }
      return true;
    });
  }

  function dedupeVersion(input) {
    const version = model.normalizeVersion(input);
    const existing = readCollection('versions').items.find((item) => (
      item.candidateId === version.candidateId
      && item.sourceHash
      && item.parameterHash
      && item.sourceHash === version.sourceHash
      && item.parameterHash === version.parameterHash
    ));
    return { duplicate: Boolean(existing), existing, version };
  }

  function saveCandidate(input) { return upsert('candidates', input); }
  function saveVersion(input, { dedupe = true } = {}) {
    if (dedupe) {
      const result = dedupeVersion(input);
      if (result.duplicate) {
        appendEvent({ type: 'versions.deduped', id: result.existing.pineVersionId, at: nowIso() });
        return result.existing;
      }
      return upsert('versions', result.version);
    }
    return upsert('versions', input);
  }
  function saveTestRun(input) { return upsert('testRuns', input); }
  function saveEvaluation(input) { return upsert('evaluations', input); }
  function saveValidation(input) { return upsert('validations', input); }

  function appendEvent(event) {
    try {
      ensureStorage();
      const safe = model.withSafety({
        eventId: event.eventId || model.makeId('event', [event.type || 'event', event.id || '', event.at || nowIso()]),
        at: event.at || nowIso(),
        type: String(event.type || 'event'),
        id: event.id || null,
        details: event.details || {},
      });
      model.assertSafeIntent(safe);
      fs.appendFileSync(assertInside(eventsFile), `${JSON.stringify(safe)}\n`, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function eventStatus() {
    try {
      if (!fs.existsSync(eventsFile)) return { status: 'empty', count: 0 };
      const raw = fs.readFileSync(eventsFile, 'utf8');
      return { status: 'ok', count: raw.split('\n').filter(Boolean).length };
    } catch (err) {
      return { status: 'degraded', count: 0, error: err?.message || String(err) };
    }
  }

  function safeName(value, fallback = 'artifact') {
    return model.slug(value, fallback).slice(0, 120);
  }

  function writeArtifact(kind, id, content, extension = 'json') {
    const dirs = { artifacts: artifactsDir, imports: importsDir, exports: exportsDir };
    const dir = dirs[kind] || artifactsDir;
    const ext = safeName(extension, 'json').replace(/^_+/, '') || 'json';
    const file = assertInside(path.join(dir, `${safeName(id, 'artifact')}.${ext}`));
    ensureStorage();
    fs.writeFileSync(file, String(content ?? ''), 'utf8');
    return {
      ok: true,
      artifact: path.relative(rootDir, file).split(path.sep).join('/'),
      bytes: Buffer.byteLength(String(content ?? ''), 'utf8'),
    };
  }

  function readArtifact(relativePath) {
    const file = assertInside(path.join(rootDir, String(relativePath || '')));
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }

  function blockStatus() {
    const blocks = {};
    for (const name of Object.keys(COLLECTIONS)) {
      const result = readCollection(name);
      blocks[name] = {
        status: result.status,
        count: result.items.length,
        error: result.error || null,
      };
    }
    blocks.events = eventStatus();
    return blocks;
  }

  function getOverview() {
    const candidates = list('candidates');
    const versions = list('versions');
    const testRuns = list('testRuns');
    const evaluations = list('evaluations');
    const validations = list('validations');
    const queue = list('queue');
    const runningTests = testRuns.filter((run) => run.status === 'running');
    const rejectedVersions = versions.filter((version) => version.status === 'rejected' || version.compileStatus === 'static_invalid');
    const latestEvaluation = evaluations.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    const bestEvaluation = evaluations
      .filter((item) => Number.isFinite(Number(item.score)))
      .sort((a, b) => Number(b.score) - Number(a.score))[0] || null;
    const bestCandidate = bestEvaluation
      ? candidates.find((candidate) => candidate.candidateId === bestEvaluation.candidateId) || null
      : null;
    const warnings = [
      ...versions.flatMap((version) => version.validationWarnings || []),
      ...testRuns.filter((run) => run.parityStatus === 'unsupported').map((run) => run.blockedReason || 'unsupported_parity'),
      ...evaluations.flatMap((evaluation) => evaluation.dataQualityWarnings || []),
    ].slice(0, 25);
    return model.withSafety({
      ok: true,
      status: candidates.length ? 'ok' : 'empty',
      generatedAt: nowIso(),
      summary: {
        candidates: candidates.length,
        versions: versions.length,
        testRuns: testRuns.length,
        evaluations: evaluations.length,
        validations: validations.length,
        queueItems: queue.length,
        runningTests: runningTests.length,
        rejectedVersions: rejectedVersions.length,
      },
      bestCandidate,
      bestEvaluation,
      latestEvaluation,
      runningTests,
      rejectedVersions: rejectedVersions.slice(0, 8),
      nextRecommendedExperiment: latestEvaluation?.recommendedChanges?.[0] || null,
      dataQualityWarnings: warnings,
      parityWarnings: testRuns.filter((run) => run.parityStatus && run.parityStatus !== 'supported').slice(0, 12),
      store: {
        rootDir,
        blocks: blockStatus(),
      },
      provider: {
        provider: process.env.AI_ANALYST_PROVIDER || process.env.AI_PROVIDER || 'disabled',
        model: process.env.AI_ANALYST_MODEL || process.env.AI_MODEL || 'gpt-4o-mini',
        configured: Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY),
      },
    });
  }

  return {
    rootDir,
    ensureStorage,
    readCollection,
    writeCollection,
    list,
    findById,
    saveCandidate,
    saveVersion,
    saveTestRun,
    saveEvaluation,
    saveValidation,
    dedupeVersion,
    appendEvent,
    writeArtifact,
    readArtifact,
    blockStatus,
    getOverview,
  };
}

const defaultStore = createPineResearchStore();

module.exports = {
  createPineResearchStore,
  defaultStore,
  get rootDir() { return defaultStore.rootDir; },
  ensureStorage: (...args) => defaultStore.ensureStorage(...args),
  readCollection: (...args) => defaultStore.readCollection(...args),
  writeCollection: (...args) => defaultStore.writeCollection(...args),
  list: (...args) => defaultStore.list(...args),
  findById: (...args) => defaultStore.findById(...args),
  saveCandidate: (...args) => defaultStore.saveCandidate(...args),
  saveVersion: (...args) => defaultStore.saveVersion(...args),
  saveTestRun: (...args) => defaultStore.saveTestRun(...args),
  saveEvaluation: (...args) => defaultStore.saveEvaluation(...args),
  saveValidation: (...args) => defaultStore.saveValidation(...args),
  dedupeVersion: (...args) => defaultStore.dedupeVersion(...args),
  appendEvent: (...args) => defaultStore.appendEvent(...args),
  writeArtifact: (...args) => defaultStore.writeArtifact(...args),
  readArtifact: (...args) => defaultStore.readArtifact(...args),
  blockStatus: (...args) => defaultStore.blockStatus(...args),
  getOverview: (...args) => defaultStore.getOverview(...args),
};
