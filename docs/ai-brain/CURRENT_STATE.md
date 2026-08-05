# Current State

Senast verifierat: 2026-08-05T07:21:18Z under Fas 1, baserat på godkänd Fas 0-inventering och read-only preflight.

Denna status är tidsbunden. Branch, HEAD, upstream, runtime och dirty worktree måste verifieras om vid varje ny session innan arbete fortsätter.

## Repo och runtime

- Projektmapp: `/var/www/nasdaq-scanner-prod`
- Git-root: `/var/www/nasdaq-scanner-prod`
- Alternativ mapp `/var/www/nasdaq-scanner`: saknades vid Fas 0
- Branch vid Fas 0: `lab-batch-runnability-ui`
- HEAD vid Fas 0: `14a7265`
- Upstream vid Fas 0: `origin-disabled/lab-batch-runnability-ui`
- Ahead/behind vid Fas 0: `ahead 64`, `behind 0`
- PM2-process: `nasdaq-scanner`
- Runtime working directory: `/var/www/nasdaq-scanner-prod`
- Runtime status vid Fas 0: `online`

## Dirty worktree

Dirty worktree fanns vid Fas 0 och får inte röras utan uttryckligt uppdrag. Index var tomt efter den senaste verifieringen.

Sammanfattade dirty arbetsomraden:

- Futures Paper
- IBKR Paper execution
- market data
- frontend
- strategy store
- release verification
- tester

Kopiera inte hela dirty fillistan mellan Second Brain-filer. Kör i stället ny Git-preflight när aktuell filnivå krävs.

## Pågående läge

- Frontend 2.0 Fas 1-commit `14a7265` fanns lokalt på aktuell branch vid Fas 0.
- Git-publicering var stoppad.
- Branchen låg 64 commits före upstream.
- Mini Futures-pipelinen och dirty worktree skulle bevaras.

## Verifierad systemmodell

Trading OS är en lokal produktionskörd research-, strategi-, paper-execution- och learning-plattform.

Verifierad huvudkedja:

```text
data
-> signal
-> kandidat
-> strategi
-> entry contract
-> guard
-> risk
-> test eller paper execution
-> resultat
-> learning
-> Supervisor
-> nästa rekommendation
```

Futures Paper execution beskrivs som IBKR Paper enligt aktuell runtime-dokumentation och verifierad kod. Paper broker är inte live broker.

Intern futures-simulator är pensionerad enligt verifierad kod och får inte behandlas som aktiv utan ny evidens.

## Viktiga statuspunkter

- Faktisk IB Gateway-anslutning: EJ VERIFIERAT i Fas 0.
- Live trading aktiverat: EJ VERIFIERAT och får inte antas.
- Intern futures-simulator: pensionerad enligt verifierad kod.
- Futures Paper execution: IBKR Paper enligt aktuell runtime-dokumentation och kod.
- TradingView-signal: får inte behandlas som order.
- Dokumenterad plan eller nästa åtgärd: är inte godkänd implementation.

## Dokumentkonflikter

Följande konflikter identifierades i Fas 0 och kräver försiktighet:

- Äldre dokument pekar på `/var/www/nasdaq-scanner`, men verifierad aktiv mapp är `/var/www/nasdaq-scanner-prod`.
- Äldre Supervisor-plan beskriver `/overview` och `/supervisor` annorlunda än aktuell frontend-routing.
- Äldre Futures Paper-platformdokument beskriver intern simulator som aktiv plattform, medan verifierad kod markerar den som pensionerad.
- IBKR Paper-submit har nyare runtime- och safety-dokumentation än vissa äldre fas-texter.
- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md` och `docs/tradingview-paper-replay-contract.md` är dubbletter som skiljer sig.

## Inte verifierat i Fas 0

- Faktiskt IB Gateway-tillstånd via broker.
- Live-värden för secrets eller env-konfiguration.
- Nginx/static serving direkt.
- Full korrekthet i varje frontend-action.
- Fullständig API-karta mot alla routes.

## Auktoritativa läsningar

Läs främst:

- `docs/TRADING_OS_SAFETY.md`
- `docs/FUTURES_PAPER_RUNTIME.md`
- `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`
- `docs/DECISIONS.md`
- `docs/RUNBOOK_DEPLOYMENT.md`
- `docs/TRADING_OS_WORK_RULES.md`
