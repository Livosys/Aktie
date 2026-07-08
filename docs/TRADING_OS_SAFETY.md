# TRADING_OS_SAFETY — Safety-flaggor och order-risk

> Kompletterar `docs/SAFETY_RULES.md`. Detta dokument är den kanoniska checklistan för Claude/agenter.

## Absoluta regler (nu-läget)

| Regel | Status |
|---|---|
| Live trading | FÖRBJUDEN — får ej aktiveras |
| Broker (riktig) | FÖRBJUDEN — `broker_enabled=false` |
| IBKR submit | LÅST — submit-vägar rörs ej (`IB_PAPER_SUBMIT_ROUTES_ENABLED=false`) |
| Riktig order (alla slag) | FÖRBJUDEN |
| Mini Future riktig order | FÖRBJUDEN — kräver separat explicit mänskligt godkännande |
| Hög hävstång (10x/15x/20x) | TILLÅTEN endast i research/paper/simulation (`leverageTestLevels`, se `docs/MINI_FUTURE_RESEARCH.md`); riskmärks high/very_high/extreme; **all real-money med hög hävstång kräver separat explicit mänskligt godkännande** |
| `git push` / `git commit` | Endast på explicit order |
| `pm2 save` | Endast på explicit order |
| Ändring i live execution | Endast på explicit order |

## Flaggor som alltid ska hållas falska/paper

- `mode=paper` (paper_only där det gäller paper-ytor)
- `live_trading_enabled=false`
- `broker_enabled=false`
- `actions_allowed=false`
- `can_place_orders=false`

## Var skyddet sitter (verifierbart i kod)

1. **`src/services/executionSafetyService.js`** — hårdkodad v1-policy:
   - `mode: 'live'` avvisas med `live_not_allowed`; endast `paper` accepteras.
   - `live_trading_enabled: true` avvisas med `live_trading_not_allowed_v1`.
   - Normalisering tvingar alltid tillbaka `mode='paper'`, `live_trading_enabled=false`.
   - Replay-kontext blockeras från exekvering (`replay_mode_blocked`).
   - Kill switch finns (`kill_switch_active`).
2. **Env-gates** (`.env`): `IB_PAPER_SUBMIT_ROUTES_ENABLED=false` (submit-routes av). `IB_PAPER_EXECUTION_ENABLED=true` avser IBKR **paper**-konto, inte live. Reserverad, ej byggd: `IB_FUTURES_SUBMIT_ROUTES_ENABLED`.
3. **Batch/Replay-autopiloter** — `batchAutopilotService.js` fryser `SAFETY = { mode: 'paper_only', actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false }` och har ingen implementerad exekveringsväg; replay-scheduler är dry-run/plan-only.
4. **Server-bindning** — `server.js` binder till `127.0.0.1:3001`; extern åtkomst endast via Nginx.

## Verifiering

```bash
bash scripts/harness/safety_harness.sh        # exit 1 vid farlig status
curl -s http://127.0.0.1:3001/api/safety/status   # mode måste vara "paper"
```

Förväntad status: `mode:"paper"`, `live_trading_enabled:false`, `manual_armed:false`, `kill_switch_active:false`.

## Farliga mönster som aldrig får introduceras utan explicit order

- Nya anrop till `placeOrder`/`submitOrder`/IBKR submit-kedjan.
- Env-ändringar som sätter `*_SUBMIT_*=true`, `live_trading_enabled=true`, `broker_enabled=true`.
- Kod som sätter `actions_allowed=true` eller `can_place_orders=true`.
- Ordervägar i Mini Future-koden (får inte existera i denna fas).
- Att kringgå `executionSafetyService` (t.ex. egen order-klient).

## Vid upptäckt farlig status

1. Avbryt pågående ändring. 2. Kör `safety_harness.sh` och dokumentera output. 3. Rapportera till användaren överst i svaret. 4. Ändra ingenting i live-läget utan explicit order (kill switch-aktivering får föreslås).
