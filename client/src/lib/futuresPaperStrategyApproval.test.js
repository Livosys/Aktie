'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

(async () => {
  const m = await import('./futuresPaperStrategyApproval.mjs');
  const libSource = fs.readFileSync(path.join(__dirname, 'futuresPaperStrategyApproval.mjs'), 'utf8');
  const componentSource = fs.readFileSync(path.join(__dirname, '../components/futures/FuturesPaperStrategyApprovalPanel.jsx'), 'utf8');
  const testCredentials = { username: 'operator', password: String.fromCharCode(116, 101, 115, 116, 95, 118, 97, 108, 117, 101) };

  // Byggare för strategi-vyer i backendens form.
  function strat({
    id = 's1',
    status = null,
    compat = 'READY',
    replacement = null,
    blockingReasons = [],
    producerStatus = 'verified',
    producerEvidence = 'scanner_emitter',
    adapterStatus = 'supported',
    riskMappingStatus = 'supported',
    symbolMappingStatus = 'supported',
    roots = ['MNQ', 'MES'],
    market = 'stocks',
    catalogStatus = 'active',
    signalRules = ['rule_a'],
    test = {},
    perf = null,
  } = {}) {
    return {
      catalog: { strategyId: id, displayName: id, family: null, direction: 'long', market, catalogStatus, status: catalogStatus, signalRules },
      compatibility: {
        compatibility: compat,
        producerStatus,
        producerEvidence,
        adapterStatus,
        riskMappingStatus,
        symbolMappingStatus,
        roots,
        allowedRoots: roots,
        canonicalReplacementId: replacement,
        blockingReasons,
      },
      approval: { status, degraded: false },
      currentTest: Object.assign({ currentTestClosedTrades: 0, currentTestTargetTrades: 10, currentTestStatus: 'in_progress' }, test),
      historicalPerformance: perf,
    };
  }

  // ── Safety-vakt ────────────────────────────────────────────────────────────
  assert.equal(m.SAFETY_BODY.actions_allowed, false);
  assert.equal(m.SAFETY_BODY.can_place_orders, false);
  assert.equal(m.SAFETY_BODY.live_trading_enabled, false);
  assert.equal(m.SAFETY_BODY.broker_enabled, false);
  assert.equal(m.SAFETY_BODY.mode, 'paper_only');

  // ── availableActions: Lägg till ────────────────────────────────────────────
  // READY + ingen status → Lägg till.
  assert.deepEqual(m.availableActions(strat({ status: null, compat: 'READY' })), ['add']);
  // READY + removed → Lägg till (åter).
  assert.deepEqual(m.availableActions(strat({ status: 'removed', compat: 'READY' })), ['add']);
  // NEEDS_MAPPING + ingen status → inga åtgärder (ej Lägg till).
  assert.deepEqual(m.availableActions(strat({ status: null, compat: 'NEEDS_MAPPING' })), []);
  // UNSUPPORTED → inga åtgärder.
  assert.deepEqual(m.availableActions(strat({ status: null, compat: 'UNSUPPORTED' })), []);

  // ── availableActions: Pausa / Ta bort ──────────────────────────────────────
  assert.deepEqual(m.availableActions(strat({ status: 'approved', compat: 'READY' })), ['pause', 'remove']);

  // ── availableActions: Återuppta / Ta bort ──────────────────────────────────
  assert.deepEqual(m.availableActions(strat({ status: 'paused', compat: 'READY' })), ['resume', 'remove']);

  // Pausad strategi som inte längre är READY visar ändå Återuppta/Ta bort (statusstyrt).
  assert.deepEqual(m.availableActions(strat({ status: 'paused', compat: 'NEEDS_MAPPING' })), ['resume', 'remove']);
  // Godkänd men ej READY: ingen Lägg till, men Pausa/Ta bort finns kvar.
  assert.deepEqual(m.availableActions(strat({ status: 'approved', compat: 'NEEDS_MAPPING' })), ['pause', 'remove']);

  // ── Dubletter: aldrig valbara ──────────────────────────────────────────────
  const dupById = strat({ id: m.DUPLICATE_FAKEOUT_ID, status: null, compat: 'NEEDS_MAPPING' });
  assert.equal(m.isDuplicate(dupById), true);
  assert.deepEqual(m.availableActions(dupById), []);
  assert.equal(m.duplicateReason(dupById), 'Dublett. Använd narrow_fakeout_reversal_v1.');

  const dupByReplacement = strat({ id: 'x', compat: 'NEEDS_MAPPING', replacement: 'narrow_fakeout_reversal_v1' });
  assert.equal(m.isDuplicate(dupByReplacement), true);
  assert.deepEqual(m.availableActions(dupByReplacement), []);
  assert.equal(m.duplicateReason(dupByReplacement), 'Dublett. Använd narrow_fakeout_reversal_v1.');

  // Den canonical fakeout-strategin är INTE dublett och kan godkännas.
  const canonical = strat({ id: m.CANONICAL_FAKEOUT_ID, status: null, compat: 'READY' });
  assert.equal(m.isDuplicate(canonical), false);
  assert.deepEqual(m.availableActions(canonical), ['add']);

  // ── Progress / klar ────────────────────────────────────────────────────────
  assert.deepEqual(m.progress(strat({ test: { currentTestClosedTrades: 3, currentTestTargetTrades: 10 } })), { current: 3, target: 10 });
  assert.equal(m.isTestComplete(strat({ test: { currentTestClosedTrades: 10, currentTestTargetTrades: 10, currentTestStatus: 'completed' } })), true);
  assert.equal(m.isTestComplete(strat({ test: { currentTestClosedTrades: 4, currentTestTargetTrades: 10, currentTestStatus: 'in_progress' } })), false);

  // ── Resultat-sammanfattning ────────────────────────────────────────────────
  const withPerf = strat({
    status: 'approved',
    test: { currentTestClosedTrades: 6, currentTestTargetTrades: 10 },
    perf: { closedTrades: 8, wins: 5, losses: 3, winRatePct: 62.5, netPnlSek: 1234.5 },
  });
  const summary = m.resultSummary(withPerf);
  assert.equal(summary.closedTrades, 8);
  assert.equal(summary.wins, 5);
  assert.equal(summary.losses, 3);
  assert.equal(summary.winRatePct, 62.5);
  assert.equal(summary.netPnlSek, 1234.5);
  assert.equal(summary.progressCurrent, 6);
  assert.equal(summary.progressTarget, 10);
  assert.equal(summary.hasData, true);

  const noPerf = m.resultSummary(strat({ perf: null }));
  assert.equal(noPerf.closedTrades, null);
  assert.equal(noPerf.winRatePct, null);
  assert.equal(noPerf.netPnlSek, null);
  assert.equal(noPerf.hasData, false);

  const missingCurrentTest = m.progress({ currentTest: {} });
  assert.deepEqual(missingCurrentTest, { current: null, target: null });

  // ── Filter ─────────────────────────────────────────────────────────────────
  const list = [
    strat({ id: 'a', status: 'approved', compat: 'READY', test: { currentTestClosedTrades: 2, currentTestTargetTrades: 10 } }),
    strat({ id: 'b', status: 'paused', compat: 'READY' }),
    strat({ id: 'c', status: 'removed', compat: 'READY' }),
    strat({ id: 'd', status: 'approved', compat: 'READY', test: { currentTestClosedTrades: 10, currentTestTargetTrades: 10, currentTestStatus: 'completed' } }),
    strat({ id: 'e', status: null, compat: 'NEEDS_MAPPING' }),
    strat({ id: m.DUPLICATE_FAKEOUT_ID, status: null, compat: 'NEEDS_MAPPING' }),
    { strategyId: 'err', error: true }, // felrad ignoreras
  ];
  assert.deepEqual(m.applyFilter(list, 'all').map((s) => m.strategyId(s)), ['a', 'b', 'c', 'd', 'e', m.DUPLICATE_FAKEOUT_ID]);
  assert.deepEqual(m.applyFilter(list, 'active').map((s) => m.strategyId(s)), ['a', 'd']);
  assert.deepEqual(m.applyFilter(list, 'paused').map((s) => m.strategyId(s)), ['b']);
  assert.deepEqual(m.applyFilter(list, 'completed').map((s) => m.strategyId(s)), ['d']);
  assert.deepEqual(m.applyFilter(list, 'removed').map((s) => m.strategyId(s)), ['c']);
  assert.deepEqual(m.applyFilter(list, 'needs_mapping').map((s) => m.strategyId(s)), ['e', m.DUPLICATE_FAKEOUT_ID]);

  const counts = m.filterCounts(list);
  assert.equal(counts.all, 6);
  assert.equal(counts.active, 2);
  assert.equal(counts.needs_mapping, 2);

  // ── Endpoint-byggare ───────────────────────────────────────────────────────
  assert.equal(m.mutationEndpoint('narrow_breakout', 'add'), '/api/futures-paper/strategies/narrow_breakout/approve');
  assert.equal(m.mutationEndpoint('narrow_breakout', 'pause'), '/api/futures-paper/strategies/narrow_breakout/pause');
  assert.equal(m.mutationEndpoint('narrow_breakout', 'resume'), '/api/futures-paper/strategies/narrow_breakout/resume');
  assert.equal(m.mutationEndpoint('narrow_breakout', 'remove'), '/api/futures-paper/strategies/narrow_breakout/remove');
  // id saneras (encodeURIComponent).
  assert.equal(m.mutationEndpoint('a/b', 'add'), '/api/futures-paper/strategies/a%2Fb/approve');

  const req = m.buildMutationRequest('narrow_breakout', 'add');
  assert.equal(req.url, '/api/futures-paper/strategies/narrow_breakout/approve');
  assert.equal(req.options.method, 'POST');
  assert.equal(req.options.credentials, 'include');
  assert.equal(m.isFuturesPaperMutationEndpoint(req.url), true);
  assert.equal(Object.prototype.hasOwnProperty.call(req.options.headers, 'Authorization'), false);
  const sentBody = JSON.parse(req.options.body);
  assert.equal(sentBody.actions_allowed, false);
  assert.equal(sentBody.can_place_orders, false);
  assert.equal(sentBody.live_trading_enabled, false);
  assert.equal(sentBody.broker_enabled, false);

  const authReq = m.buildMutationRequest('narrow_breakout', 'add', testCredentials);
  assert.equal(Object.prototype.hasOwnProperty.call(authReq.options.headers, 'Authorization'), false, 'session auth never sends Basic Authorization');
  assert.equal(m.isFuturesPaperMutationEndpoint(authReq.url), true);
  const nextReqAfterSuccess = m.buildMutationRequest('narrow_breakout', 'pause', m.emptyOperatorCredentials());
  assert.equal(Object.prototype.hasOwnProperty.call(nextReqAfterSuccess.options.headers, 'Authorization'), false, 'Authorization cannot be reused after one-shot cleanup');

  const externalLookingReq = m.buildMutationRequest('https://evil.example/steal', 'add', testCredentials);
  assert.equal(/^https?:\/\//i.test(externalLookingReq.url), false, 'mutation builder never targets external origins');
  assert.equal(m.isFuturesPaperMutationEndpoint(externalLookingReq.url), true);
  assert.equal(Object.prototype.hasOwnProperty.call(externalLookingReq.options.headers, 'Authorization'), false, 'auth header is never attached');

  assert.equal(m.isFuturesPaperMutationEndpoint('/api/paper-trading/runtime'), false);
  assert.equal(m.isFuturesPaperMutationEndpoint('https://evil.example/api/futures-paper/strategies/x/approve'), false);
  assert.match(componentSource, /fetch\(url, \{ signal: controller\.signal, credentials: 'include' \}\)/, 'GET list fetch includes session credentials');
  assert.doesNotMatch(componentSource, /Authorization['"]?\s*:/, 'component does not hard-code Authorization on GET');

  const anonPreflight = m.operatorMutationPreflight(null);
  assert.equal(anonPreflight.ok, true);
  assert.equal(anonPreflight.authRequired, false);

  const authedPreflight = m.operatorMutationPreflight(testCredentials);
  assert.equal(authedPreflight.ok, true);
  assert.equal(authedPreflight.authRequired, false);
  assert.equal(Object.prototype.hasOwnProperty.call(authedPreflight, 'authHeader'), false, 'preflight does not create a Basic token');

  assert.equal(m.passwordInputType(false), 'password', 'password input is hidden by default');
  assert.equal(m.passwordInputType(true), 'text', 'password reveal toggles input type');
  assert.equal(m.passwordToggleLabel(false), 'Visa lösenord');
  assert.equal(m.passwordToggleLabel(true), 'Dölj lösenord');

  const emptyCredentials = m.emptyOperatorCredentials();
  assert.deepEqual(emptyCredentials, { username: '', password: '' });
  assert.equal(m.operatorMutationPreflight(emptyCredentials).ok, true, 'session auth does not require one-shot credentials');
  assert.doesNotMatch(componentSource, /Operatörsinloggning/, 'approval panel no longer exposes Basic Auth operator login');
  assert.doesNotMatch(componentSource, /Logga in och fortsätt/, 'operator credential dialog is removed');
  assert.match(componentSource, /finally \{[\s\S]*setBusyId\(null\)/, 'all completed mutation attempts clear busy state');
  const refetchIndex = componentSource.indexOf('if (followUp.refetch) await load();');
  assert.ok(refetchIndex > -1, 'success path refetches after session mutation');
  assert.match(componentSource, /catch \(e\) \{[\s\S]*interpretMutationResult\(res, data, err\)[\s\S]*finally \{[\s\S]*setBusyId\(null\)/, 'network/error paths clear busy state');
  assert.match(componentSource, /onClick=\{\(\) => runSessionMutation\(s, actionId\)\}/, 'row actions mutate through the authenticated session');

  const originalLocalStorage = global.localStorage;
  const originalSessionStorage = global.sessionStorage;
  let localWrites = 0;
  let sessionWrites = 0;
  global.localStorage = { setItem() { localWrites += 1; }, getItem() { return null; }, removeItem() {}, clear() {} };
  global.sessionStorage = { setItem() { sessionWrites += 1; }, getItem() { return null; }, removeItem() {}, clear() {} };
  try {
    m.operatorMutationPreflight(testCredentials);
    m.buildMutationRequest('narrow_breakout', 'add', testCredentials);
    assert.equal(localWrites, 0, 'credentials are never written to localStorage');
    assert.equal(sessionWrites, 0, 'credentials are never written to sessionStorage');
  } finally {
    global.localStorage = originalLocalStorage;
    global.sessionStorage = originalSessionStorage;
  }
  assert.doesNotMatch(libSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(componentSource, /localStorage|sessionStorage/);

  // Ta bort kräver bekräftelse-text; övriga inte.
  assert.equal(typeof m.ACTION_META.remove.confirm, 'string');
  assert.ok(m.ACTION_META.remove.confirm.includes('Ta bort strategin från Futures Paper?'));
  assert.equal(m.ACTION_META.add.confirm, null);

  // ── Tolkning av backendsvar (aldrig optimistisk) ───────────────────────────
  const okRes = m.interpretMutationResult({ ok: true }, { ok: true, changed: true, status: 'approved' }, null);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.changed, true);
  assert.equal(okRes.status, 'approved');
  assert.equal(okRes.message, null);
  assert.deepEqual(m.mutationFollowUp(okRes), { refetch: true, optimisticStatus: null });

  const noopRes = m.interpretMutationResult({ ok: true }, { ok: true, changed: false, status: 'approved', reason: 'already_approved' }, null);
  assert.equal(noopRes.ok, true);
  assert.equal(noopRes.changed, false);

  const errRes = m.interpretMutationResult({ ok: false, status: 422 }, { ok: false, reason: 'not_approvable_needs_mapping' }, null);
  assert.equal(errRes.ok, false);
  assert.equal(errRes.changed, false);
  assert.equal(errRes.message, 'Strategin behöver Futures-anpassning innan den kan läggas till.');
  assert.equal(errRes.httpStatus, 422);
  assert.ok(errRes.technicalDetail.includes('HTTP 422'));
  assert.deepEqual(m.mutationFollowUp(errRes), { refetch: false, optimisticStatus: null });

  const dupErr = m.interpretMutationResult({ ok: false, status: 422 }, { ok: false, reason: 'duplicate_strategy', canonicalReplacementId: 'narrow_fakeout_reversal_v1' }, null);
  assert.ok(dupErr.message.includes('narrow_fakeout_reversal_v1'));
  assert.ok(dupErr.technicalDetail.includes('canonicalReplacementId=narrow_fakeout_reversal_v1'));

  const authErr = m.interpretMutationResult({ ok: false, status: 401 }, { ok: false, error: 'Autentisering krävs' }, null);
  assert.equal(authErr.message, 'Sessionen har gått ut. Logga in igen.');
  assert.equal(authErr.authRequired, true);
  assert.ok(authErr.technicalDetail.includes('HTTP 401'));
  assert.deepEqual(m.emptyOperatorCredentials(), { username: '', password: '' });

  const forbiddenErr = m.interpretMutationResult({ ok: false, status: 403 }, { ok: false, reason: 'forbidden' }, null);
  assert.equal(forbiddenErr.message, 'Du har inte behörighet att ändra strategier.');
  assert.equal(forbiddenErr.forbidden, true);

  const conflictErr = m.interpretMutationResult({ ok: false, status: 409 }, { ok: false, reason: 'cannot_pause_removed' }, null);
  assert.equal(conflictErr.message, 'Kan inte pausa en borttagen strategi.');

  const validationErr = m.interpretMutationResult({ ok: false, status: 422 }, { ok: false, reason: 'not_approvable_needs_mapping' }, null);
  assert.equal(validationErr.message, 'Strategin behöver Futures-anpassning innan den kan läggas till.');

  const netErr = m.interpretMutationResult(null, null, new TypeError('Failed to fetch'));
  assert.equal(netErr.ok, false);
  assert.equal(netErr.message, 'Kunde inte nå servern. Kontrollera anslutningen.');
  assert.equal(netErr.networkError, true);
  assert.equal(netErr.authRequired, false);

  const degraded = m.interpretMutationResult({ ok: false, status: 503 }, { ok: false, reason: 'futures_approval_state_degraded' }, null);
  assert.equal(degraded.message, 'Approval-status är degraded. Ändringar är tillfälligt blockerade.');

  const leakedPassword = String.fromCharCode(114, 101, 100, 97, 99, 116, 95, 109, 101);
  const leakyErr = m.interpretMutationResult(
    { ok: false, status: 500 },
    { ok: false, error: `username=operator password=${leakedPassword} authorization=Basic abc123` },
    null,
  );
  assert.doesNotMatch(`${leakyErr.message} ${leakyErr.technicalDetail}`, new RegExp(`operator|${leakedPassword}|abc123|Basic abc123`));
  assert.match(leakyErr.technicalDetail, /\[redacted\]/);

  // ── Etiketter ──────────────────────────────────────────────────────────────
  assert.equal(m.statusLabel(strat({ status: null })), 'Ej tillagd');
  assert.equal(m.statusLabel(strat({ status: 'approved' })), 'Godkänd');
  assert.equal(m.statusLabel(strat({ status: 'approved', test: { currentTestClosedTrades: 10, currentTestTargetTrades: 10, currentTestStatus: 'completed' } })), 'Godkänd · klar');
  assert.equal(m.statusLabel(strat({ status: 'paused' })), 'Pausad');
  assert.equal(m.statusLabel(strat({ status: 'removed' })), 'Borttagen');
  assert.equal(m.compatibilityLabel(strat({ compat: 'READY' })), 'Redo');
  assert.equal(m.compatibilityLabel(strat({ compat: 'NEEDS_MAPPING' })), 'Behöver anpassning');

  // ── Radexpansion och verkliga kompatibilitetsdetaljer ──────────────────────
  assert.equal(m.toggleExpandedStrategyId(null, 's1'), 's1');
  assert.equal(m.toggleExpandedStrategyId('s1', 's1'), null);
  assert.equal(m.toggleExpandedStrategyId('s1', 's2'), 's2');

  const readyExplanation = m.compatibilityExplanation(strat({ compat: 'READY' }));
  assert.equal(readyExplanation.title, 'Redo');
  assert.ok(readyExplanation.lines.includes('En verifierad signalproducent finns.'));
  assert.ok(readyExplanation.lines.includes('Strategin kan mappas till MNQ/MES.'));
  assert.ok(readyExplanation.lines.includes('Stop och mål kan översättas till Futures Paper.'));

  const needsMapping = strat({
    compat: 'NEEDS_MAPPING',
    producerStatus: 'missing',
    blockingReasons: ['no_verified_signal_producer'],
  });
  const needsMappingExplanation = m.compatibilityExplanation(needsMapping);
  assert.equal(needsMappingExplanation.title, 'Behöver Futures-anpassning');
  assert.ok(needsMappingExplanation.lines.includes('Ingen verifierad signalproducent når Futures Paper-scannern.'));

  const duplicateExplanation = m.compatibilityExplanation(strat({
    id: 'narrow_state_fakeout_reversal',
    compat: 'NEEDS_MAPPING',
    replacement: 'narrow_fakeout_reversal_v1',
    blockingReasons: ['duplicate_strategy'],
  }));
  assert.equal(duplicateExplanation.title, 'Dublett');
  assert.ok(duplicateExplanation.lines.includes('Den här strategin ersätts av narrow_fakeout_reversal_v1.'));

  const cryptoExplanation = m.compatibilityExplanation(strat({
    id: 'crypto_momentum_scalper',
    compat: 'UNSUPPORTED',
    market: 'crypto',
    symbolMappingStatus: 'unsupported',
    roots: [],
    blockingReasons: ['no_safe_futures_mapping'],
  }));
  assert.equal(cryptoExplanation.title, 'Ej stödd');
  assert.ok(cryptoExplanation.lines.includes('Strategin är byggd för crypto och saknar säker mappning till MNQ/MES.'));
  assert.equal(m.blockingReasonLabel('no_safe_futures_mapping'), 'Strategin saknar säker mappning till MNQ/MES.');

  const genericUnsupported = m.compatibilityExplanation(strat({
    id: 'unknown_market_mapping',
    compat: 'UNSUPPORTED',
    market: 'stocks',
    blockingReasons: ['no_safe_futures_mapping'],
  }));
  assert.ok(genericUnsupported.lines.includes('Strategin saknar säker mappning till MNQ/MES.'));

  const pausedExplanation = m.compatibilityExplanation(strat({
    id: 'news_volatility_watch',
    compat: 'BLOCKED',
    catalogStatus: 'paused',
    blockingReasons: ['catalog_status_paused'],
  }));
  assert.equal(pausedExplanation.title, 'Blockerad');
  assert.ok(pausedExplanation.lines.includes('Strategin är pausad i canonical katalog och kan inte godkännas.'));

  const detailFields = m.strategyDetailFields(strat({ compat: 'READY', signalRules: ['price_breaks_above_vwap'] }));
  assert.deepEqual(detailFields.find((f) => f.label === 'allowedRoots').value, ['MNQ', 'MES']);
  assert.equal(detailFields.find((f) => f.label === 'producerEvidence').value, 'scanner_emitter');
  assert.deepEqual(detailFields.find((f) => f.label === 'catalog.signalRules').value, ['price_breaks_above_vwap']);
  assert.equal(detailFields.find((f) => f.label === 'approval.status').value, null);

  // ── Utökad resultat-sammanfattning (breakeven/avg/profitFactor/provenance) ──
  const richPerf = strat({
    status: 'approved',
    test: { currentTestClosedTrades: 0, currentTestTargetTrades: 10, totalHistoricalClosedTrades: 8 },
    perf: { closedTrades: 8, wins: 5, losses: 2, breakevenTrades: 1, winRatePct: 62.5, netPnlSek: 1234.5, avgNetPnlSek: 154.31, profitFactor: 2.4, profitFactorNote: null, pnlProvenance: 'mixed' },
  });
  const rs = m.resultSummary(richPerf);
  assert.equal(rs.breakevenTrades, 1);
  assert.equal(rs.avgNetPnlSek, 154.31);
  assert.equal(rs.profitFactor, 2.4);
  assert.equal(rs.pnlProvenance, 'mixed');
  // Historiskt totalt separeras från aktuell testomgång (0 nu, 8 historiskt).
  assert.equal(rs.progressCurrent, 0);
  assert.equal(rs.totalHistoricalClosedTrades, 8);

  // profitFactor noll-förluster → null + note bevaras.
  const pfNull = m.resultSummary(strat({ perf: { closedTrades: 3, wins: 3, losses: 0, netPnlSek: 30, profitFactor: null, profitFactorNote: 'no_losing_trades' } }));
  assert.equal(pfNull.profitFactor, null);
  assert.equal(pfNull.profitFactorNote, 'no_losing_trades');

  assert.equal(m.provenanceLabel('stored_net'), 'Lagrad netto');
  assert.equal(m.provenanceLabel('mixed'), 'Blandad');

  // ── Leaders ─────────────────────────────────────────────────────────────────
  const leaders = {
    highestNetPnl: { strategyId: 'a', displayName: 'A', value: 3970.26, closedTrades: 6 },
    highestWinRate: { strategyId: 'a', displayName: 'A', value: 66.7, closedTrades: 6 },
    mostWins: { strategyId: 'b', displayName: 'B', value: 4, closedTrades: 10 },
    highestAverageNetPnl: { strategyId: 'a', displayName: 'A', value: 661.71, closedTrades: 6 },
  };
  const rows = m.leaderRows(leaders);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.label), ['Högst nettoresultat', 'Högst win rate', 'Flest vinster', 'Högst snitt per trade']);
  assert.deepEqual(rows.map((r) => r.unit), ['money', '%', 'V', 'money']);
  assert.equal(rows[0].strategyId, 'a');
  assert.equal(rows[0].value, 3970.26);
  assert.equal(rows[2].strategyId, 'b');
  // Saknad leader → hasLeader false, inga kastade fel.
  const emptyRows = m.leaderRows(null);
  assert.equal(emptyRows.length, 4);
  assert.equal(emptyRows[0].hasLeader, false);

  console.log('futuresPaperStrategyApproval.test.js: ALL PASS');
})().catch((err) => {
  console.error('TEST FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
