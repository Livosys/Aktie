'use strict';

const assert = require('assert/strict');

(async () => {
  const m = await import('./futuresPaperStrategyApproval.mjs');

  // Byggare för strategi-vyer i backendens form.
  function strat({ id = 's1', status = null, compat = 'READY', replacement = null, test = {}, perf = null } = {}) {
    return {
      catalog: { strategyId: id, displayName: id, family: null, direction: 'long', market: 'stocks', catalogStatus: 'active' },
      compatibility: { compatibility: compat, canonicalReplacementId: replacement, blockingReasons: [] },
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
  assert.equal(noPerf.closedTrades, 0);
  assert.equal(noPerf.winRatePct, null);
  assert.equal(noPerf.hasData, false);

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
  const sentBody = JSON.parse(req.options.body);
  assert.equal(sentBody.actions_allowed, false);
  assert.equal(sentBody.can_place_orders, false);
  assert.equal(sentBody.live_trading_enabled, false);
  assert.equal(sentBody.broker_enabled, false);

  // Ta bort kräver bekräftelse-text; övriga inte.
  assert.equal(typeof m.ACTION_META.remove.confirm, 'string');
  assert.ok(m.ACTION_META.remove.confirm.includes('Ta bort strategin från Futures Paper?'));
  assert.equal(m.ACTION_META.add.confirm, null);

  // ── Tolkning av backendsvar (aldrig optimistisk) ───────────────────────────
  const okRes = m.interpretMutationResult({ ok: true }, { ok: true, changed: true, status: 'approved' }, null);
  assert.deepEqual(okRes, { ok: true, changed: true, status: 'approved', message: null });

  const noopRes = m.interpretMutationResult({ ok: true }, { ok: true, changed: false, status: 'approved', reason: 'already_approved' }, null);
  assert.equal(noopRes.ok, true);
  assert.equal(noopRes.changed, false);

  const errRes = m.interpretMutationResult({ ok: false }, { ok: false, reason: 'not_approvable_needs_mapping' }, null);
  assert.equal(errRes.ok, false);
  assert.equal(errRes.changed, false);
  assert.equal(errRes.message, 'Strategin behöver Futures-anpassning innan den kan läggas till.');

  const dupErr = m.interpretMutationResult({ ok: false }, { ok: false, reason: 'duplicate_strategy' }, null);
  assert.ok(dupErr.message.includes('narrow_fakeout_reversal_v1'));

  const netErr = m.interpretMutationResult(null, null, new Error('boom'));
  assert.equal(netErr.ok, false);
  assert.equal(netErr.message, 'boom');

  const degraded = m.interpretMutationResult({ ok: false }, { ok: false, reason: 'futures_approval_state_degraded' }, null);
  assert.ok(degraded.message.includes('degraderat'));

  // ── Etiketter ──────────────────────────────────────────────────────────────
  assert.equal(m.statusLabel(strat({ status: null })), 'Ej tillagd');
  assert.equal(m.statusLabel(strat({ status: 'approved' })), 'Godkänd');
  assert.equal(m.statusLabel(strat({ status: 'approved', test: { currentTestClosedTrades: 10, currentTestTargetTrades: 10, currentTestStatus: 'completed' } })), 'Godkänd · klar');
  assert.equal(m.statusLabel(strat({ status: 'paused' })), 'Pausad');
  assert.equal(m.statusLabel(strat({ status: 'removed' })), 'Borttagen');
  assert.equal(m.compatibilityLabel(strat({ compat: 'READY' })), 'Redo');
  assert.equal(m.compatibilityLabel(strat({ compat: 'NEEDS_MAPPING' })), 'Behöver anpassning');

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
