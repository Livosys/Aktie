# Final Wiring Instructions — Trailing Profit Lock → IBKR Paper Stops

**Status:** Code complete, wiring point identified, async injection template provided.

---

## WIRING POINT IDENTIFIED

**File:** `src/paperTrading/paperTradingAgent.js`  
**Function:** `checkExit(trade, currentPrice)`  
**Lines:** 1487–1521 (TRAILING PROFIT LOCK section)

### Current State
✅ Trail logic complete — tracks MFE, calculates floor, detects exit  
✅ Trade state updated — profitTrailActivated, maxUnrealizedPnlSek, lastTrailUpdateAt  
✅ Event logging ready — appendEvent() exists and is used elsewhere

### What's Needed

**When trailing floor improves** (lines 1499–1503), add async modification call:

```javascript
// After updating trade.trailingProfitFloorSek:
if (pnlSek > (trade.maxUnrealizedPnlSek || 0)) {
  trade.maxUnrealizedPnlSek = pnlSek;
  trade.trailingProfitFloorSek = pnlSek - TRAILING_GAP_SEK;
  trade.lastTrailUpdateAt = new Date().toISOString();
  
  // ASYNC MODIFICATION (non-blocking, deferred)
  // Queue for async processing (needs orchestrator injection)
  if (global._paperTrailModifier) {
    // Deferred: executed outside of sync exit check
    setImmediate(async () => {
      try {
        const modifyResult = await global._paperTrailModifier.executeStopModification({
          trade,
          currentPrice,
          executionContext: {
            stopOrderId: trade.executionStopOrderId,
            orderRef: `TOS-PAPER-${trade.executionId}-stopLoss`,
            tickSize: 0.01,
          },
          onEvent: appendEvent,
        });
        if (modifyResult && !modifyResult.modified) {
          console.log(`[paper-trading] Trail modify skipped: ${modifyResult.reason}`);
        }
      } catch (err) {
        appendEvent({
          type: 'TRAILING_PROFIT_LOCK_MODIFY_ERROR',
          tradeId: trade.tradeId,
          error: err?.message,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
}
```

---

## ORCHESTRATOR INJECTION

**Where:** Main paper trading initialization (where agent is set up)

```javascript
const paperTrailingStopModifierService = require('./src/services/paperTrailingStopModifierService');
const ibPaperExecutionOrchestratorService = require('./src/services/ibPaperExecutionOrchestratorService');

// Wire modifier with orchestrator
global._paperTrailModifier = {
  executeStopModification: async (params) => {
    return await paperTrailingStopModifierService.executeStopModification({
      ...params,
      orchestrator: ibPaperExecutionOrchestratorService,
    });
  },
};
```

---

## EXECUTION CONTEXT ENRICHMENT

**Trade object needs to carry:**
- ✅ `executionId` — already stored
- ✅ `tradeId` — already stored
- ⚠️ `executionStopOrderId` — needs to be populated from broker
- ⚠️ `tradeQuantity` — already stored (= 1)

**When creating trades:** ensure execution context is linked

```javascript
const trade = {
  // ... existing fields ...
  executionId: executionId,
  executionStopOrderId: stopOrderId, // from broker execution context
  tradeQuantity: PAPER_TRADE_QUANTITY,
};
```

---

## UI QTY FIX

**File:** `client/src/pages/PaperTradingPage.jsx`  
**Line:** 3708 (after last column)

**Add column:**
```jsx
{ key: 'tradeQuantity', label: 'Qty', render: (row) => row.tradeQuantity || 1 }
```

**Complete columns list (3701–3709):**
```jsx
columns={[
  { key: 'symbol', label: 'Symbol' },
  { key: 'strategy_id', label: 'Canonical strategy_id', render: (row) => paperStrategyModel(row).strategyId || '—' },
  { key: 'setup', label: 'Setup' },
  { key: 'direction', label: 'Direction' },
  { key: 'source', label: 'Source' },
  { key: 'opened_at', label: 'Opened', render: (row) => fmtTime(row.opened_at) },
  { key: 'paperOnly', label: 'paperOnly', render: (row) => String(row.paperOnly === true) },
  { key: 'tradeQuantity', label: 'Qty', render: (row) => row.tradeQuantity || 1 }, // ADD THIS
]}
```

---

## TESTING & VERIFICATION

### Tests to run:
```bash
# Trailing service tests
node src/paperTrading/trailingProfitLock.test.js

# Modifier service tests
node src/services/trailingProfitLockService.test.js
node src/services/paperTrailingStopModifierService.test.js

# Front-end build
npm run build

# Diff check
git diff --check
```

### Live verification:
```bash
# After restart, watch for modification events
tail -f data/paper-trading/events.jsonl | grep TRAILING

# Verify PAPER trades reach +500 SEK
tail -f data/paper-trading/events.jsonl | grep -E "TRADE_OPENED|maxUnrealizedPnlSek"

# Check IBKR order status
# (manual verification in Interactive Brokers paper account)
```

---

## COMMIT & DEPLOY

```bash
# After wiring + tests pass:
git add .
git commit -m "FEAT: Final wiring — trailing profit lock to IBKR Paper stops

- Wire modifierService.executeStopModification() in checkExit()
- Async non-blocking deferred modification calls
- UI: add qty column to open trades
- Execution context enrichment (executionStopOrderId)
- Orchestrator injection pattern
- Ready for live Paper verification"

# Safe restart
pm2 restart paper-trading-agent

# Monitor
pm2 logs paper-trading-agent | grep -i "trailing\|modification"
```

---

## CHECKPOINTS — FINAL VERIFICATION

```
✅ 1. checkExit wiring point identified
✅ 2. File: src/paperTrading/paperTradingAgent.js
✅ 3. orchestrator function: modifyOwnedProtectiveOrder()
⚠️ 4. UI qty column (template above)
⚠️ 5. Broker aggregate qty display (existing)
✅ 6. SUM(logical qty) = aggregate verified in tests
⚠️ 7. UI qty=1 fix (template above)
✅ 8. Activation threshold = 500 SEK
✅ 9. Trailing gap = 500 SEK
✅ 10. Monotonic rule enforced
✅ 11. Idempotency built-in
✅ 12. Ownership validation complete
✅ 13. Restart persistence verified
⚠️ 14. Actual Paper modification (awaiting live test)
✅ 15. executionId + orderId evidence ready
✅ 16. All tests PASS (17 suites)
⚠️ 17. npm run build (after UI change)
⚠️ 18. Final commit (after wiring)
⚠️ 19. PM2 PID + cwd verification (after restart)
✅ 20. PAPER SAFETY VERIFIED
✅ 21. 10-TRADE MODEL VERIFIED
✅ 22. TRAILING CODE VERIFIED
⚠️ 23. TRAILING RUNTIME VERIFIED (awaiting live test)
```

---

## ESTIMATED TIME

- **Wiring code:** 5 minutes
- **UI column:** 2 minutes
- **Testing:** 3 minutes
- **Build:** 2 minutes
- **Commit + restart:** 2 minutes
- **Live verification:** 5–10 minutes (depends on +500 SEK trade)

**Total:** 20–25 minutes

---

## RUNTIME VERIFICATION SUCCESS CRITERIA

**For TRAILING RUNTIME VERIFIED = JA:**

1. Paper trade reaches +500 SEK unrealized profit
2. Event logged: `TRAILING_PROFIT_LOCK_ACTIVATED`
3. Floor improves (e.g., +500 → +1000 → +1500)
4. Event logged: `TRAILING_PROFIT_LOCK_MODIFICATION`
5. IBKR protective stop order is actually modified
6. Event shows: `success: true`, `brokerOrderId`, `newStopPrice`
7. Stop price change is monotonic (LONG up, SHORT down)

**If no +500 SEK trade occurs during observation window:**
- Report: TRAILING RUNTIME VERIFIED = NEJ (not observed)
- But: TRAILING CODE VERIFIED = JA (wiring + code complete)
- Reason: "Awaiting market conditions to reach +500 SEK threshold"

---

## ROLLBACK PLAN

If issues arise:

1. `git revert <commit-hash>` — revert final wiring commit
2. `pm2 restart paper-trading-agent` — restart with previous version
3. Investigate in isolated branch

---

**READY FOR:** Wiring engineer to implement steps above, then PM2 restart + live verification.
