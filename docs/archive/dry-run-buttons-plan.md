# Backend-plan: Dry-run-knappar för Batch & Replay

> Status: **FÖRSLAG — ej implementerat.** Skriven 2026-06-11.
> Skapad i dev-worktree `/var/www/nasdaq-scanner` (prod körs från `/var/www/nasdaq-scanner-prod`).

## 0. Mål & safety-invariant
Lägg till två knappar i Supervisor som manuellt triggar **en dry-run plan-preview** av
batch- resp. replay-autopilot. Inget annat. Måste bevara:

```
mode=paper_only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false · broker_enabled=false
```

Knapparna får **aldrig** trigga order, broker, livehandel eller riskändring. Allt additivt.

## 1. Vad som redan finns (= minimalt återstår)
Båda services är redan byggda dry-run-only — **ingen ny affärslogik behövs**:

- `src/services/batchAutopilotService.js` → `runOnce({ trigger })` →
  `{ ok, executed:false, planned, blocked, blockedReason, plan, ...SAFETY }`.
  Kommentar i fil: *"Real execution is intentionally NOT implemented."*
- `src/services/replayAutopilotService.js` → identiskt mönster.
- `evaluateGate()` returnerar `blocked` med `execution_not_supported_safe_mode` om
  `dryRunOnly=false`, samt cooldown/maxPerDay-gating (`todayRunCount`).
- Skyddsmönstret finns redan i `/api/autopilot/narrow/run-once`:
  `narrowTestAutopilot.findBlockedIntent(body)` + `AUTOPILOT_SAFETY`-spread + tvingad `dryRun:true`.

**Slutsats:** detta är ~30 rader backend + 2 knappar. Ingen ny service, ingen broker-väg, ingen exekvering.

## 2. Backend — två nya POST-routes (`src/routes/api.js`)
Lägg precis efter `/api/autopilot/narrow/run-once` (ca rad 2540), med samma defensiva mönster:

```js
// ── Manual dry-run triggers (test only — never executes, never places orders) ──
router.post('/batch-autopilot/dry-run', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Reuse the narrow guard to reject any sneaked-in live/order intent.
    const blockedIntent = narrowTestAutopilot.findBlockedIntent(body);
    if (blockedIntent) {
      return res.json({
        ok: false, blocked: true, executed: false, dryRun: true,
        ...AUTOPILOT_SAFETY,
        reasons: [`blocked_intent:${blockedIntent}`],
        message_sv: 'Förfrågan innehöll otillåten live/order-intent och blockerades.',
      });
    }
    const result = batchAutopilotService.runOnce({ trigger: 'manual_dry_run_button' });
    res.json({
      ok: result.ok,
      ...AUTOPILOT_SAFETY,           // hard-override: ignore anything the service returned
      dryRun: true,
      executed: false,               // invariant — never true on this route
      blocked: Boolean(result.blocked),
      blockedReason: result.blockedReason || null,
      plan: result.plan || null,
      note: 'Endast test. Ingen batch startas. Inga riktiga order.',
    });
  } catch (err) {
    res.json({ ok: false, executed: false, error: err.message, ...AUTOPILOT_SAFETY });
  }
});

// Identical route for replay:
router.post('/replay-autopilot/dry-run', (req, res) => {
  // same body, replayAutopilotService.runOnce({ trigger: 'manual_dry_run_button' })
  // note: 'Endast test. Ingen replay startas. Inga riktiga order.'
});
```

**Krav på require:** `batchAutopilotService` / `replayAutopilotService` måste importeras högst upp
i `api.js` om de inte redan är det (verifiera; annars
`const batchAutopilotService = require('../services/batchAutopilotService');`).

**Tre lager av skydd:**
1. `findBlockedIntent` avvisar live/order-intent i body.
2. service-`evaluateGate` blockerar om inte dryRunOnly.
3. route spreadar `AUTOPILOT_SAFETY` + hårdkodar `executed:false` sist så inget service-svar
   kan läcka ett sant exekveringsflagg.

## 3. Tester (additivt, `*.test.js`)
- Utöka `batchAutopilotService.test.js` / `replayAutopilotService.test.js`:
  - `runOnce()` returnerar alltid `executed:false` (redan sant — lägg explicit assert).
  - Ny route-test (lättviktig, kalla handlern eller via supertest om det finns):
    POST utan body → `executed:false`, `...SAFETY` alla false.
  - POST med `{ live:true }` / `{ placeOrder:true }` → `blocked:true`,
    `reasons` innehåller `blocked_intent:*`, `executed:false`.
  - POST när `dryRunOnly=false` (env) → `blocked:true`,
    `blockedReason:'execution_not_supported_safe_mode'`.

## 4. Frontend — två knappar (`client/src/pages/SupervisorBrainPage.jsx`, Control Room)
Additivt i ett nytt litet kort eller i `ResearchAutomationCard`. POST via befintlig `apiJson`-helper:

```jsx
<button type="button" className="tos-btn tos-btn-test"
  onClick={() => apiJson('/api/batch-autopilot/dry-run', { method: 'POST' }).then(setBatchDryRun)}>
  Kör test-batch (dry-run)
</button>
<p className="tos-muted">Endast test. Inga riktiga order.</p>
```

- Visa svaret (`plan` / `blockedReason`) i en read-only ruta.
- Knapptext + hjälptext måste säga **"Endast test. Inga riktiga order."**
- Disabla knappen medan request pågår (undvik dubbeltryck → cooldown-spam).
- Ingen ny CSS krävs om `tos-btn` finns; annars minimal additiv klass.

## 5. Verifiering före leverans
- `npm --prefix client run build` (i dev-worktree — rör ej prod)
- `node src/services/batchAutopilotService.test.js`, `…/replayAutopilotService.test.js`,
  `…/narrowTestAutopilotService.test.js`, `…/supervisorOverviewService.test.js`
- `git diff --check`
- Safety-grep på ändrade rader: inga `placeOrder/submitOrder/broker/buy/sell/execute`,
  inga `*_enabled: true`, ingen ny broker-import.
  `executed`/`SAFETY` ska bara förekomma som `false`/spread.
- Manuell rök-test: POST mot båda routes → bekräfta `executed:false` + safety-block i svaret.

## 6. Rollback
- Allt i två filer (`api.js` + `SupervisorBrainPage.jsx`). Backup före edit (som tidigare).
  Rollback = återställ backuperna eller ta bort de två route-blocken + knapparna.
  Ingen migrering, ingen state-ändring (`runOnce` skriver bara
  `data/*-autopilot-status.json` med plan-preview, vilket schemat redan gör).

## 7. Uttryckliga icke-mål (bygger INTE)
- Ingen "kör på riktigt"-väg, ingen `executed:true`, ingen broker/order-integration.
- Ingen ändring av `dryRunOnly`-default, env-gating, eller `ENABLE_NARROW_AUTOPILOT_EXECUTE`.
- Ingen auto-apply, ingen schemaändring, ingen risk-/safety-konfig.

---

**Uppskattning:** ~25–35 rader backend (2 routes), ~20 rader frontend (2 knappar + svarsruta),
~30 rader tester. Noll ny affärslogik — bara säkra omslag kring befintliga `runOnce`.
