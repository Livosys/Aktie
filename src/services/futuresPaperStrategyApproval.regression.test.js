'use strict';

// Regression: dagens sex passerar gate efter migration, och vanliga Paper
// Trading-allowlisten (automation-approvals.json via paperAllowlistService)
// påverkas ALDRIG av futures-mutationer.
// `node src/services/futuresPaperStrategyApproval.regression.test.js`

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-approval-regress-'));
process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE = path.join(TMP_DIR, 'strategy-approvals.json');

const approval = require('./futuresPaperStrategyApprovalService');
const paperAllowlistService = require('./paperAllowlistService');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.message}`); process.exitCode = 1; }
}

// A) Migration bevarar unionen av dagens Futures-runtime; alla passerar gaten
//    (ny testomgång startar 0/10 → inget target-block).
test('runtime union migrates and passes approval gate', () => {
  approval.ensureMigrated();
  const union = approval.computeMigrationUnion();
  // dagens tre extra måste ingå (de har verkliga futures-trades)
  for (const id of ['low_volatility_breakout', 'ema_breakdown', 'resistance_rejection']) {
    assert.ok(union.includes(id), `${id} must be in migration union`);
  }
  // Live closedTs (default): kompatibilitet ser verkliga trades (READY), och
  // ny testomgång (startedAt = migrationstid) ger 0/10 → inget target-block.
  for (const id of union) {
    const g = approval.evaluateFuturesApprovalGate({ strategyId: id });
    assert.strictEqual(g.allowed, true, `${id} blocked by ${g.blockedReason}`);
  }
});

// B) Vanliga Paper Trading-allowlisten ändras inte av futures-mutationer.
test('normal paper allowlist is not mutated by futures actions', () => {
  let before;
  try { before = JSON.stringify(paperAllowlistService.getPaperAllowlistStatus().allowlist || []); }
  catch (err) { before = 'ERR'; }
  approval.pause('narrow_breakout');
  approval.remove('trend_continuation');
  approval.approve('narrow_breakout'); // resume-liknande via approve
  let after;
  try { after = JSON.stringify(paperAllowlistService.getPaperAllowlistStatus().allowlist || []); }
  catch (err) { after = 'ERR'; }
  assert.strictEqual(before, after, 'shared paper allowlist changed — must be isolated');
});

// C) Futures approval-store ligger på en annan fil än automation-approvals.json.
test('futures store is a separate file from automation-approvals', () => {
  assert.ok(!approval.STORE_FILE.includes('automation-approvals'), 'must not reuse automation-approvals.json');
  // Produktionsdefault (utan env-override) ligger under data/futures-paper.
  const child = require('child_process');
  const out = child.execSync(
    `node -e "delete process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE; console.log(require('${path.resolve(__dirname, 'futuresPaperStrategyApprovalService.js')}').STORE_FILE)"`,
    { encoding: 'utf8', env: { ...process.env, FUTURES_PAPER_STRATEGY_APPROVALS_FILE: '' } },
  ).trim();
  assert.ok(out.includes(path.join('data', 'futures-paper')), `default store under data/futures-paper, got ${out}`);
  assert.ok(!out.includes('automation-approvals'));
});

process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* noop */ } });

if (process.exitCode) console.error(`\nregression: FAILURES (passed ${passed})`);
else console.log(`\nregression: all ${passed} tests passed`);
