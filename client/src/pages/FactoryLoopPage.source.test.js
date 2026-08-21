import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'FactoryLoopPage.jsx'), 'utf8');

// ── Sidan får rita, inte räkna ──────────────────────────────────────────────
//
// Backend är källan. En frontend som räknar om policy, härleder loopstatus
// eller duplicerar hjärnlogik blir ett andra ställe som räknar samma sak — och
// två svar på samma fråga är i praktiken noll svar.

test('sidan återanvänder befintliga dashboard-komponenter', () => {
  for (const component of ['DashboardShell', 'ChartCard', 'EmptyState']) {
    assert.ok(source.includes(component), `${component} saknas`);
  }
});

test('sidan läser ETT backend-svar och skriver ingenting', () => {
  assert.ok(source.includes("'/api/factory/loop'"), 'endpointen saknas');
  // Read-only: inga muterande anrop.
  assert.doesNotMatch(source, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(source, /\.post\(|\.put\(|\.delete\(/);
});

test('sidan räknar inte om policy och duplicerar ingen AI-logik', () => {
  // Utfallsnamnen får FÖREKOMMA (de ska visas) men aldrig avgöras här.
  for (const forbidden of [
    'profitFactor', 'netPnlUsd', 'maxDrawdown', 'knowledgeValue',
    'classify', 'evaluateBrokerRisk', 'THRESHOLD', 'policyVersion:',
  ]) {
    assert.ok(!source.includes(forbidden), `sidan innehåller ${forbidden} — det hör hemma i backend`);
  }
  // Ingen egen härledning av loopens läge.
  assert.doesNotMatch(source, /if\s*\(\s*steps\.(some|every|filter)/,
    'loopens läge härleds i backend, inte här');
});

test('saknad data visas som okänt, aldrig som noll', () => {
  assert.match(source, /return\s+typeof value === 'number' && Number\.isFinite\(value\)/);
  assert.ok(source.includes("'–'"), 'okänt värde ska visas som tankstreck');
});

test('sidan har laddnings-, fel- och tomtillstånd', () => {
  assert.ok(source.includes('setLoading'), 'laddningstillstånd saknas');
  assert.ok(source.includes('setError'), 'feltillstånd saknas');
  assert.ok(source.includes('EmptyState'), 'tomtillstånd saknas');
  // Ett fel får inte tömma sidan.
  assert.match(source, /visar senast kända läge/);
});

test('sidan hittar inte på status när backend är tyst', () => {
  // Inga hårdkodade fallbackvärden för de fält som beskriver AI:ns arbete.
  assert.doesNotMatch(source, /state:\s*['"](running|idle|blocked)['"]/,
    'läget kommer från backend, inte från en default här');
});

// ── De operativa sektionerna ────────────────────────────────────────────────
//
// Sidan finns för att någon ska kunna FÖLJA den autonoma loopen i drift. Går
// någon av de här sektionerna förlorad blir sidan en statusrad utan innehåll,
// och det är inte tillräckligt för att se vad fabriken faktiskt gör.

test('statusen svarar på vad som pågår, vad som blev klart och vad som blockerar', () => {
  for (const field of ['currentStrategy', 'currentAction', 'lastCompletedAction', 'nextAction', 'lastError', 'blockedReason']) {
    assert.ok(source.includes(`status.${field}`), `status.${field} visas inte`);
  }
});

test('senaste research-resultat visar mätningen bakom domen', () => {
  for (const field of [
    'researchTrades', 'validationTrades',
    'researchProfitFactor', 'validationProfitFactor',
    'researchNetPnlUsd', 'validationNetPnlUsd',
    'researchMaxDrawdownUsd', 'outcome', 'reason',
  ]) {
    assert.ok(source.includes(field), `${field} visas inte i research-resultatet`);
  }
});

test('AI:s beslut besvarar de tre frågorna sidan finns för', () => {
  assert.ok(source.includes('Vad lärde sig AI?'));
  assert.ok(source.includes('Vad ändrar AI nästa gång?'));
  assert.ok(source.includes('Vad testar den härnäst?'));
  for (const decision of ['PROMOTE', 'IMPROVE', 'INSUFFICIENT_EVIDENCE', 'REJECT', 'WAITING_FOR_MORE_DATA']) {
    assert.ok(source.includes(decision), `beslutet ${decision} har ingen etikett`);
  }
});

test('beslutet redovisar vilken evidens det vilar på', () => {
  assert.ok(source.includes('decision.evidence'), 'evidensen bakom beslutet visas inte');
  assert.ok(source.includes('parentDnaHash'), 'förälder-DNA visas inte');
});

test('AI Memory och Strategy Library visar sitt senaste liv', () => {
  for (const field of ['latestExperimentAt', 'excludedExperiments', 'duplicateSkips']) {
    assert.ok(source.includes(field), `memory.${field} visas inte`);
  }
  for (const field of ['latestChangeAt', 'latestEvidence']) {
    assert.ok(source.includes(field), `library.${field} visas inte`);
  }
});

test('ett 401 visas som utloggad, aldrig som tomt resultat', () => {
  assert.match(source, /res\.status === 401/, 'auth-läget särskiljs inte');
  assert.ok(source.includes('Du är utloggad'), 'utloggad-texten saknas');
});

console.log('FactoryLoopPage.source.test.js loaded');
