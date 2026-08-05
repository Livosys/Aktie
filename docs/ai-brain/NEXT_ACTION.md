# Next Action

Status:
AKTUELLT HUVUDUPPDRAG ÄR CANONICAL SHADOW HARNESS

Mål:
Samla 2-3 hela RTH-dagar av evidens som visar att Canonical Execution Readiness Engine ger exakt samma beslut och reasonCodes som den befintliga produktionslogiken.

Daglig procedur:

1. Låt systemet samla kandidater under hela RTH-sessionen.
2. Gör inga kodändringar under sessionen.
3. Kör efter RTH-stängning:

   ```bash
   node scripts/shadowReadinessCompare.js --day YYYY-MM-DD
   ```

4. Granska:
   - antal kandidater
   - identical %
   - beslutsskillnader
   - reasonCode-skillnader
   - nya reasonCodes
   - första avvikande kandidat

Beslutsregel:

- Vid 100 % identitet: ändra ingenting och upprepa nästa handelsdag.
- Vid avvikelse: enda tekniska uppgiften är att förklara den första avvikande kandidaten.
- Ingen routing eller migration godkänns innan evidensperioden är klar och separat beslut har fattats.

Tillåtna handlingar:

- read-only observation
- köra det befintliga shadowReadinessCompare-scriptet
- läsa resultatrapporter
- jämföra kandidater, beslut och reasonCodes
- dokumentera evidens

Förbjudet:

- ändra Canonical Engine
- ändra produktionslogik
- byta routing
- migrera scheduler
- migrera IBKR execution
- ändra Entry Contract
- ändra Guard eller Risk
- aktivera live trading
- ändra order submission
- PineScript-arbete
- Batch-/Replay-migration
- frontendredesign
- orelaterad felsökning
- commit, push, restart eller deploy utan separat godkännande

Commit tillåten:
NEJ

Push tillåten:
NEJ

Restart tillåten:
NEJ

Dokumenterad nästa åtgärd är inte samma sak som godkänd implementation.
