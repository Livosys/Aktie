# RUNBOOK_TESTING — Tester och harness

## Testlager

| Lager | Verktyg | Körning |
|---|---|---|
| Enhetstester | `node --test` (filer `src/services/*.test.js`) | `node --test src/services/<fil>.test.js` eller `npm test` om definierat |
| Harness (read-only integrationskoll) | `scripts/harness/*.sh` | `bash scripts/harness/<namn>.sh` |
| Manuell API-koll | `curl GET http://127.0.0.1:3001/api/...` | endast GET mot status-endpoints |

## Harness-katalogen

Alla harness är read-only: de läser status, kör curl GET, kontrollerar safety-flaggor och rapporterar PASS/FAIL. **Exit 1 vid farlig status eller FAIL.** De får aldrig aktivera live/broker, skicka order, pusha, köra pm2 save, ändra env eller Nginx.

| Script | Kontrollerar |
|---|---|
| `safety_harness.sh` | `/api/safety/status` (mode=paper, live_trading_enabled=false, kill switch), farliga env-gates, inga submit-flaggor på |
| `batch_replay_harness.sh` | batch-/replay-status-endpoints svarar, autopilot-gates rapporterar säkert läge |
| `paper_trading_harness.sh` | paper-trading status/runtime svarar, mode paper_only |
| `futures_paper_harness.sh` | futures-paper runtime/scanner/account svarar, paper-only |
| `agents_harness.sh` | 9 agentfiler finns i `.claude/agents/`, agent-endpoints svarar |
| `pinescript_harness.sh` | `pine/`-struktur finns, webhook-route finns i koden, inga frikopplade pine-filer |
| `mini_future_harness.sh` | Mini Future är i research/paper-fas, inga ordervägar i mini-future-kod |
| `regression_harness.sh` | kör övriga harness + git status + relevanta enhetstester |

## Standardsvit efter ändringar

```bash
cd /var/www/nasdaq-scanner-prod
git status
bash scripts/harness/safety_harness.sh
bash scripts/harness/batch_replay_harness.sh
bash scripts/harness/agents_harness.sh
bash scripts/harness/futures_paper_harness.sh
bash scripts/harness/regression_harness.sh
pm2 status          # endast läsning
```

Ingen commit, ingen push, ingen pm2 save — utan explicit order.

## Regler för nya tester

1. Tester som skapar trades/signaler måste märka dem `engine_test` och städa efter sig (eller använda tmp-kataloger via env-övertäckning som service-testerna gör).
2. Tester får aldrig POST:a mot start/stop/order-endpoints i prod utan användarens uttryckliga instruktion.
3. Replay-baserade tester märks som replay och jämförs aldrig med live-resultat.
4. Vid parallella sessioner i samma worktree: kör tester på specifika filer, inte hela sviten, om andra sessioners dirty filer kan påverka.
