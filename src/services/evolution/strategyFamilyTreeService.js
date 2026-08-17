'use strict';

// ── Strategy Family Tree ─────────────────────────────────────────────────────
//
// Det genetiska släktträdet. Varje genom vet var det kom ifrån:
//
//   Momentum V1 → Momentum ATR → Momentum ATR Filter → Momentum Hybrid
//
// ── Varför trädet är sitt eget minne och inte en del av Strategy Library ────
//
// Biblioteket är posten över REGISTRERADE strategier — de som finns som kod och
// kan köras i paper och live. Det seedas ur Strategy Registry och får aldrig
// innehålla något registret inte känner till.
//
// Ett muterat genom är inte kod. Det finns bara som DNA, det har aldrig
// registrerats, och det kanske aldrig blir en strategi. Att lägga in det i
// biblioteket vore att fylla posten över körbara strategier med hypoteser.
//
// Trädet är därför sitt eget register — men det PEKAR in i biblioteket: en nod
// vars genom motsvarar en registrerad strategi bär dess strategyId, och när en
// sådan ska pensioneras är det biblioteket som gör det. Trädet uppfinner ingen
// egen livscykel.
//
// ── Pensionera en gren ──────────────────────────────────────────────────────
//
// En hel gren kan pensioneras på en gång. Det är poängen med grenar: visar sig
// en mutationsriktning vara en återvändsgränd ska hela riktningen kunna stängas
// utan att någon plockar noder en och en. Pensioneringen TAR INTE BORT något —
// noderna ligger kvar, märkta, så att AI kan läsa vad som prövades och varför
// det övergavs.
//
// Append-only via den delade händelseloggen. Gallras aldrig.

const path = require('path');

const { createEventLog } = require('../../data/eventLog');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'strategy_family_tree',
});

const TREE_VERSION = 'strategy-family-tree-v1';
const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/ai-memory/lineage.jsonl');

const EVENT_TYPES = Object.freeze({
  NODE_CREATED: 'NODE_CREATED',
  NODE_RETIRED: 'NODE_RETIRED',
  BRANCH_RETIRED: 'BRANCH_RETIRED',
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function blankNode(dnaHash) {
  return {
    dnaHash,
    parent: null,
    generation: 0,
    mutationType: null,
    branch: null,
    rootStrategyId: null,
    // Sätts bara när genomet motsvarar en registrerad strategi.
    strategyId: null,
    parameterHash: null,
    createdAt: null,
    retired: false,
    retiredAt: null,
    retiredReason: null,
    retiredWithBranch: false,
    mutation: null,
  };
}

function applyEvent(node, event) {
  const next = { ...node };
  switch (event.type) {
    case EVENT_TYPES.NODE_CREATED:
      next.parent = text(event.parent);
      next.generation = Number.isFinite(Number(event.generation)) ? Number(event.generation) : 0;
      next.mutationType = text(event.mutationType);
      next.branch = text(event.branch);
      next.rootStrategyId = text(event.rootStrategyId);
      next.strategyId = text(event.strategyId);
      next.parameterHash = text(event.parameterHash);
      next.mutation = event.mutation || null;
      next.createdAt = next.createdAt || event.recordedAt;
      break;
    case EVENT_TYPES.NODE_RETIRED:
    case EVENT_TYPES.BRANCH_RETIRED:
      next.retired = true;
      next.retiredAt = event.recordedAt;
      next.retiredReason = text(event.reason);
      next.retiredWithBranch = event.type === EVENT_TYPES.BRANCH_RETIRED;
      break;
    default:
      break;
  }
  return next;
}

function createStrategyFamilyTree(options = {}) {
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'dnaHash',
    eventTypes: Object.values(EVENT_TYPES),
    now: options.now,
    label: 'strategy_family_tree',
  });

  function nodes() {
    return log.project(blankNode, applyEvent);
  }

  function listNodes() {
    return [...nodes().values()];
  }

  function getNode(dnaHash) {
    return nodes().get(text(dnaHash)) || null;
  }

  /**
   * Registrerar ett genom i trädet.
   *
   * Generationen HÄRLEDS ur föräldern när en sådan finns, i stället för att tas
   * på tro från anroparen. Två källor till samma tal glider isär, och ett
   * släktträd där generationen ljuger är värdelöst.
   */
  function addNode({
    dnaHash,
    parent = null,
    mutationType = null,
    branch = null,
    rootStrategyId = null,
    strategyId = null,
    parameterHash = null,
    mutation = null,
    at = null,
  } = {}) {
    const hash = text(dnaHash);
    if (!hash) return { ok: false, reason: 'node_requires_dna_hash' };
    const existing = getNode(hash);
    if (existing && existing.createdAt) {
      // Samma genom två gånger är inte ett fel — det betyder att två vägar ledde
      // till samma arvsmassa. Noden behålls som den är; att skriva om dess
      // förälder skulle förfalska historien.
      return { ok: true, node: existing, alreadyPresent: true };
    }

    const parentHash = text(parent);
    const parentNode = parentHash ? getNode(parentHash) : null;
    if (parentHash && !parentNode?.createdAt) {
      return { ok: false, reason: `unknown_parent:${parentHash}` };
    }

    const event = log.append(hash, EVENT_TYPES.NODE_CREATED, {
      parent: parentHash,
      generation: parentNode ? parentNode.generation + 1 : 0,
      mutationType,
      // En gren utan namn ärver förälderns. Roten heter 'root'.
      branch: text(branch) || parentNode?.branch || 'root',
      rootStrategyId: text(rootStrategyId) || parentNode?.rootStrategyId || text(strategyId),
      strategyId,
      parameterHash,
      mutation,
      at,
    });
    return { ok: true, node: getNode(hash), event, alreadyPresent: false };
  }

  function childrenOf(dnaHash) {
    const hash = text(dnaHash);
    return listNodes().filter((node) => node.parent === hash);
  }

  /** Vägen från roten till en nod. */
  function ancestryOf(dnaHash) {
    const all = nodes();
    const chain = [];
    let current = all.get(text(dnaHash));
    const guard = new Set();
    while (current && !guard.has(current.dnaHash)) {
      guard.add(current.dnaHash);
      chain.unshift(current);
      current = current.parent ? all.get(current.parent) : null;
    }
    return chain;
  }

  /** Noden och allt som härstammar från den. */
  function descendantsOf(dnaHash) {
    const out = [];
    const queue = [text(dnaHash)];
    const seen = new Set();
    while (queue.length) {
      const hash = queue.shift();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      for (const child of childrenOf(hash)) {
        out.push(child);
        queue.push(child.dnaHash);
      }
    }
    return out;
  }

  function listBranches() {
    const branches = new Map();
    for (const node of listNodes()) {
      const key = node.branch || 'root';
      if (!branches.has(key)) branches.set(key, { branch: key, nodes: 0, retired: 0, generations: new Set() });
      const entry = branches.get(key);
      entry.nodes += 1;
      if (node.retired) entry.retired += 1;
      entry.generations.add(node.generation);
    }
    return [...branches.values()].map((entry) => ({
      branch: entry.branch,
      nodes: entry.nodes,
      retired: entry.retired,
      active: entry.nodes - entry.retired,
      maxGeneration: Math.max(...entry.generations),
      fullyRetired: entry.retired === entry.nodes,
    }));
  }

  function retireNode(dnaHash, { reason, at = null } = {}) {
    if (!text(reason)) return { ok: false, reason: 'retirement_requires_reason' };
    const node = getNode(dnaHash);
    if (!node?.createdAt) return { ok: false, reason: 'unknown_node' };
    if (node.retired) return { ok: true, node, alreadyRetired: true };
    log.append(node.dnaHash, EVENT_TYPES.NODE_RETIRED, { reason, at });
    return { ok: true, node: getNode(dnaHash) };
  }

  /**
   * Pensionerar en hel gren.
   *
   * Varje nod får sin egen händelse — inte en enda "grenen är död"-rad. Utan
   * det skulle en nods tillstånd bero på en annan posts existens, och frågan
   * "är det här genomet pensionerat?" hade krävt att man först räknade ut
   * vilken gren den tillhörde vid vilken tidpunkt.
   */
  function retireBranch(branch, { reason, at = null } = {}) {
    if (!text(reason)) return { ok: false, reason: 'retirement_requires_reason' };
    const key = text(branch);
    const members = listNodes().filter((node) => (node.branch || 'root') === key && !node.retired);
    if (!members.length) return { ok: false, reason: 'no_active_nodes_in_branch', branch: key };
    for (const node of members) {
      log.append(node.dnaHash, EVENT_TYPES.BRANCH_RETIRED, { reason, branch: key, at });
    }
    return { ok: true, branch: key, retired: members.map((node) => node.dnaHash) };
  }

  /** Pensionerar en nod och allt som härstammar från den. */
  function retireSubtree(dnaHash, { reason, at = null } = {}) {
    if (!text(reason)) return { ok: false, reason: 'retirement_requires_reason' };
    const root = getNode(dnaHash);
    if (!root?.createdAt) return { ok: false, reason: 'unknown_node' };
    const targets = [root, ...descendantsOf(dnaHash)].filter((node) => !node.retired);
    for (const node of targets) {
      log.append(node.dnaHash, EVENT_TYPES.NODE_RETIRED, { reason, subtreeRoot: root.dnaHash, at });
    }
    return { ok: true, retired: targets.map((node) => node.dnaHash) };
  }

  function getStatus() {
    const rows = listNodes();
    return {
      ok: true,
      treeVersion: TREE_VERSION,
      nodes: rows.length,
      roots: rows.filter((node) => !node.parent).length,
      retired: rows.filter((node) => node.retired).length,
      maxGeneration: rows.length ? Math.max(...rows.map((node) => node.generation)) : 0,
      branches: listBranches(),
      log: log.stats(),
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    TREE_VERSION,
    EVENT_TYPES,
    eventsFile: log.file,
    addNode,
    getNode,
    listNodes,
    childrenOf,
    ancestryOf,
    descendantsOf,
    listBranches,
    retireNode,
    retireBranch,
    retireSubtree,
    getHistory: (dnaHash) => log.historyFor(dnaHash),
    getAuditTrail: (query) => log.auditTrail(query),
    getStatus,
    _internal: { log, nodes, applyEvent, blankNode },
  };
}

module.exports = {
  SAFETY,
  TREE_VERSION,
  EVENT_TYPES,
  DEFAULT_EVENTS_FILE,
  createStrategyFamilyTree,
  defaultStrategyFamilyTree: createStrategyFamilyTree(),
};
