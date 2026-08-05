# Next Action

Status:
AKTUELLT HUVUDUPPDRAG ÄR MINI FUTURES HARNESS-TEST

Mål:
Skydda, observera och verifiera det tre dagar långa Mini Futures harness-testet för Trading OS egna strategier genom hela IBKR Paper-kedjan.

Scope:
Observation, verifiering och dokumentation av harness-testets resultat. Ingen generell PineScript-, TradingView- eller frontendombyggnad är godkänd.

Huvudfrågor:

1. Kommer färsk marknadsdata fram?
2. Producerar egna strategier signaler och kandidater?
3. Vilken gate blockerar varje stoppad kandidat?
4. Passerar giltiga kandidater Entry Contract, Guard och Risk?
5. Skickas paper-order till IBKR Paper?
6. Registreras fills och brokerpositioner korrekt?
7. Fungerar exits, PnL och reconciliation?
8. Fungerar reconnect och omstart utan dubbelorder?
9. Vilka strategier är tekniskt körbara efter testperioden?

Tillåtna filer:
Inga kodfiler är generellt godkända genom detta dokument. Varje implementation eller korrigering kräver ett separat uttryckligt uppdrag med exakt filscope.

Förbjudet:

- PineScript-automation
- TradingView-forwarding
- generell frontendredesign
- live trading
- live broker
- riskrelaxering
- gate-bypass
- godtycklig strategiaktivering
- orelaterade Mini Futures-ändringar
- commit, push, restart eller deploy utan separat godkännande

Commit tillåten:
NEJ

Push tillåten:
NEJ

Restart tillåten:
NEJ

Dokumenterad nästa åtgärd är inte samma sak som godkänd implementation.
