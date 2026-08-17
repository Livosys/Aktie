'use strict';

// ── Append-only händelselogg ─────────────────────────────────────────────────
//
// Mekaniken bakom varje permanent minne i systemet: Strategy Library, AI Memory
// och Strategy Family Tree. Alla tre har samma krav — historik får aldrig
// skrivas över, allt ska gå att följa kronologiskt, och nuet räknas fram genom
// att vika ihop det som hänt.
//
// Strategy Library byggde först sin egen. När AI Memory och släktträdet skulle
// ha samma sak fanns det tre val: kopiera koden två gånger till, låta dem dela
// Library (vilket hade gjort en bokföringsmodul till infrastruktur), eller
// lyfta ut mekaniken. Det här är det tredje.
//
// ── Två tider, och de är inte samma sak ─────────────────────────────────────
//
//   at          när det som händelsen beskriver INTRÄFFADE
//   recordedAt  när loggen FICK VETA det — sätts alltid här och kan aldrig
//               skrivas över av den som anropar
//
// Skillnaden spelar roll så fort gammal historik läses in: utan den ligger
// juli-händelser efter augusti-händelser i filen och revisionsordningen är
// bruten. Ordningen som räknar för revision är recordedAt, och den är monoton
// eftersom filen bara skrivs i slutet.
//
// Loggen gallras ALDRIG. En logg med retention är en logg som skriver över
// historik, bara långsammare.

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

/**
 * @param {string}   options.file        JSONL-fil
 * @param {string}   options.keyField    fältet som identifierar entiteten (t.ex. strategyId)
 * @param {string[]} options.eventTypes  tillåtna händelsetyper
 * @param {Function} [options.now]       klocka, injicerbar för test
 */
function createEventLog(options = {}) {
  const file = options.file;
  const keyField = options.keyField || 'id';
  const allowedTypes = new Set(options.eventTypes || []);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const label = options.label || path.basename(file || 'event-log');

  if (!file) throw new Error('event_log_requires_file');

  function ensureDir() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Alla händelser i skrivordning. En trasig rad hoppas över, aldrig hela filen. */
  function read() {
    try {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter((row) => row && row[keyField] && row.type);
    } catch (_) {
      return [];
    }
  }

  /**
   * Skriver en händelse. Enda skrivvägen.
   *
   * Identitetsfälten sätts EFTER payloaden och kan därför inte skrivas över av
   * den. En payload med `at: null` skulle annars ge en händelse utan tid, och
   * en händelse utan tid går inte att följa.
   */
  function append(key, type, payload = {}) {
    const id = text(key);
    if (!id) throw new Error(`${label}_requires_${keyField}`);
    if (allowedTypes.size && !allowedTypes.has(type)) {
      throw new Error(`${label}_unknown_event_type:${type}`);
    }
    const recordedAt = new Date(clock()).toISOString();
    const event = {
      ...payload,
      at: new Date(payload.at || recordedAt).toISOString(),
      recordedAt,
      [keyField]: id,
      type,
    };
    ensureDir();
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  /**
   * Viker ihop loggen till aktuellt tillstånd per entitet.
   *
   * @param {Function} blank   (key) => tom post
   * @param {Function} apply   (record, event) => ny post
   */
  function project(blank, apply, events = null) {
    const rows = events || read();
    const byKey = new Map();
    for (const event of rows) {
      const current = byKey.get(event[keyField]) || blank(event[keyField]);
      byKey.set(event[keyField], apply(current, event));
    }
    return byKey;
  }

  /** Loggen för en entitet, i skrivordning. */
  function historyFor(key, { types = null } = {}) {
    const id = text(key);
    return read()
      .filter((event) => event[keyField] === id)
      .filter((event) => !types || types.includes(event.type));
  }

  /**
   * Hela loggen. Ordningen är filens, alltså recordedAt — den ordning loggen
   * fick veta sakerna, och den är monoton.
   */
  function auditTrail({ since = null, types = null, limit = null } = {}) {
    const sinceMs = since ? Date.parse(since) : null;
    let rows = read();
    if (Number.isFinite(sinceMs)) {
      rows = rows.filter((e) => Date.parse(e.recordedAt || e.at) >= sinceMs);
    }
    if (types) rows = rows.filter((e) => types.includes(e.type));
    return limit ? rows.slice(-Math.abs(limit)) : rows;
  }

  function stats() {
    const rows = read();
    const byType = {};
    for (const row of rows) byType[row.type] = (byType[row.type] || 0) + 1;
    return {
      file,
      events: rows.length,
      entities: new Set(rows.map((row) => row[keyField])).size,
      byType,
      firstRecordedAt: rows[0]?.recordedAt || null,
      lastRecordedAt: rows[rows.length - 1]?.recordedAt || null,
    };
  }

  return { SAFETY, file, keyField, read, append, project, historyFor, auditTrail, stats };
}

module.exports = { SAFETY, createEventLog };
