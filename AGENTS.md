# AGENTS.md — Generella regler för alla agenter

Gäller alla 9 agenter i `.claude/agents/` och all agentliknande automation i Trading OS. Detaljroller: `docs/AI_AGENTS.md`.

## Grundprincip

Trading OS är hjärnan. Agenter analyserar, förbättrar och rapporterar — de skapar aldrig frikopplade strategier och de handlar aldrig. En agent som "hittar" en ny idé lämnar den som **förslag** till Strategy Research Agent-flödet; den blir en riktig strategi först när den finns i Trading OS strategikatalog med strategyId.

## Alla agenter FÅR

- Läsa kod, data, loggar, `data/`-filer och read-only GET-endpoints på `http://127.0.0.1:3001/api/...`.
- Köra säkra harness: `scripts/harness/*.sh`.
- Skriva rapporter/analyser till `docs/` eller `data/agent-reports/` (märkta med agentnamn + datum).
- Föreslå kodändringar (som diff/förslag — implementation sker i huvudsessionen enligt CLAUDE.md-reglerna).

## Ingen agent FÅR

- Aktivera live trading, broker, orders: `live_trading_enabled`, `broker_enabled`, `actions_allowed`, `can_place_orders` ska förbli `false`; `mode` förblir `paper`.
- Röra IBKR submit-vägar eller skapa nya ordervägar.
- Skapa/skicka riktiga Mini Future-order (kräver separat explicit mänskligt godkännande).
- Köra `git push`, `git commit`, `pm2 save`, ändra `.env`, ändra Nginx — utan explicit order från användaren.
- Presentera replay/simulering/`engine_test`-resultat som riktig performance.
- Uppfinna strategier utan koppling till Trading OS strategyId (märk annars tydligt `engine_test`).

## Output-format (alla agenter)

Varje agentrapport ska innehålla:

```
Agent: <namn>
Datum: <ISO-datum>
Datakällor: <endpoints/filer som lästs>
Fynd: <punktlista, grundad i data>
Förslag: <konkreta, testbara förbättringar med strategyId>
Risker: <vad som kan gå fel>
Safety-bekräftelse: ingen live/broker/order-väg rörd
```

## Eskalering

Om en agent upptäcker farlig status (safety-flagga sann, orderväg öppen, live-läge) ska den avbryta sitt arbete, rapportera det överst i sin output och rekommendera `bash scripts/harness/safety_harness.sh`.
