'use strict';

const assert = require('assert/strict');
const svc = require('./exitEngineService');

{
  const v2 = svc.applyExitProfileOverrides({}, svc.PAPER_QUALITY_V2_PROFILE);
  assert.equal(v2.trailing_distance_pct, 0.10);
  assert.equal(v2.break_even_after_profit_pct, 0.15);
  assert.equal(v2.near_target_min_profit_pct, 0.15);
}

{
  const stop = svc.calculateTrailingStop(
    {
      entry_price: 100,
      current_price: 100.25,
      max_favorable_pct: 0.25,
      exitProfile: svc.PAPER_QUALITY_V2_PROFILE,
    },
    {},
    svc.applyExitProfileOverrides({}, svc.PAPER_QUALITY_V2_PROFILE),
  );
  assert.equal(stop, 0.15);
}

{
  const profile = svc.normalizeExitProfile('paper_quality_v2');
  assert.equal(profile, 'paper_quality_v2');
  assert.equal(svc.normalizeExitProfile('anything_else'), 'exit_engine_v1');
}

console.log('# exitEngineService tests passed.');
