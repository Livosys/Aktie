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
const writeGuard = require('./productionWriteGuard');

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

  // ── Läscache på filens avtryck ────────────────────────────────────────────
  //
  // Loggen är APPEND-ONLY. Ingen rad ändras någonsin, och filen växer bara i
  // slutet. Därför räcker (storlek, mtime) som avtryck: två läsningar med
  // samma avtryck kan omöjligt ge olika innehåll, och varje tillägg — vårt
  // eget eller en barnprocess — flyttar bägge.
  //
  // Utan den här cachen läses och JSON-parsas hela loggen om vid VARJE anrop.
  // Strategy Library gör 16 000 rader / 10 MB per fråga, och en enda
  // fabrikssida ställer dussintals frågor. Det var den enskilt största
  // orsaken till att event-loopen stod stilla i minuter.
  //
  // Cachen är per loggobjekt, inte global: två instanser mot samma fil har var
  // sitt avtryck och kan inte förgifta varandra.
  let cachedFingerprint = null;
  let cachedRows = null;
  let cachedProjection = null;

  function fingerprint() {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch (_) {
      return 'missing';
    }
  }

  /** Tvinga nästa läsning att gå till disk igen. */
  function invalidate() {
    cachedFingerprint = null;
    cachedRows = null;
    cachedProjection = null;
  }

  function parseFile() {
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

  function rows() {
    const current = fingerprint();
    if (cachedRows && cachedFingerprint === current) return cachedRows;
    cachedRows = parseFile();
    cachedProjection = null;
    cachedFingerprint = current;
    return cachedRows;
  }

  /**
   * Alla händelser i skrivordning. En trasig rad hoppas över, aldrig hela filen.
   *
   * Returnerar en egen array så att en anropare som sorterar eller splittar
   * inte rör cachen. Raderna själva delas — ingen läsare skriver i dem.
   */
  function read() {
    return rows().slice();
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
    // En sandlåda får aldrig lägga rader i driftens permanenta minne. Se
    // productionWriteGuard: loggen är append-only, så en felaktig rad går inte
    // att ta bort i efterhand.
    writeGuard.assertWritable(file, label);
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
    // Avtrycket räcker nästan alltid, men två tillägg inom samma millisekund
    // på ett filsystem med grov mtime skulle kunna se identiska ut. Vi vet att
    // vi just skrev, så vi gissar inte.
    invalidate();
    return event;
  }

  /**
   * Viker ihop loggen till aktuellt tillstånd per entitet.
   *
   * @param {Function} blank   (key) => tom post
   * @param {Function} apply   (record, event) => ny post
   */
  function project(blank, apply, events = null) {
    // Explicit inskickade händelser cachas aldrig — då är det inte loggens
    // tillstånd som efterfrågas utan anroparens egen mängd.
    if (events) return fold(events, blank, apply);
    const source = rows();
    if (cachedProjection && cachedProjection.blank === blank && cachedProjection.apply === apply) {
      return cachedProjection.value;
    }
    const value = fold(source, blank, apply);
    cachedProjection = { blank, apply, value };
    return value;
  }

  function fold(events, blank, apply) {
    const byKey = new Map();
    for (const event of events) {
      const current = byKey.get(event[keyField]) || blank(event[keyField]);
      byKey.set(event[keyField], apply(current, event));
    }
    return byKey;
  }

  /** Loggen för en entitet, i skrivordning. */
  function historyFor(key, { types = null } = {}) {
    const id = text(key);
    return rows()
      .filter((event) => event[keyField] === id)
      .filter((event) => !types || types.includes(event.type));
  }

  /**
   * Hela loggen. Ordningen är filens, alltså recordedAt — den ordning loggen
   * fick veta sakerna, och den är monoton.
   */
  function auditTrail({ since = null, types = null, limit = null } = {}) {
    const sinceMs = since ? Date.parse(since) : null;
    let out = rows();
    if (Number.isFinite(sinceMs)) {
      out = out.filter((e) => Date.parse(e.recordedAt || e.at) >= sinceMs);
    }
    if (types) out = out.filter((e) => types.includes(e.type));
    return limit ? out.slice(-Math.abs(limit)) : out.slice();
  }

  function stats() {
    const all = rows();
    const byType = {};
    for (const row of all) byType[row.type] = (byType[row.type] || 0) + 1;
    return {
      file,
      events: all.length,
      entities: new Set(all.map((row) => row[keyField])).size,
      byType,
      firstRecordedAt: all[0]?.recordedAt || null,
      lastRecordedAt: all[all.length - 1]?.recordedAt || null,
    };
  }

  return { SAFETY, file, keyField, read, append, project, historyFor, auditTrail, stats, invalidate };
}

module.exports = { SAFETY, createEventLog };
