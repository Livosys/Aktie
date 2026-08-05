# Trading OS Second Brain

## Syfte

Detta är en lokal, repo-baserad Second Brain för Trading OS. Den ska ge samma verifierade projektkontext till ChatGPT, Claude, Codex och framtida AI-agenter utan att ersätta befintliga auktoritativa projektdokument.

Second Brain är ett navigations- och nulägeslager. Den dokumenterar vad en agent ska läsa, vad som är senast verifierat och vad som uttryckligen är tillåtet. Den är inte i sig ett godkännande att implementera, deploya, starta om runtime eller publicera Git-ändringar.

## Läsordning för ny session

1. Läs `docs/ai-brain/README.md`.
2. Läs `docs/ai-brain/CURRENT_STATE.md`.
3. Läs `docs/ai-brain/WORK_RULES.md`.
4. Läs `docs/ai-brain/NEXT_ACTION.md`.
5. Läs relevanta auktoritativa projektdokument.
6. Kör Git-preflight i aktuell repo-root.
7. Kontrollera att repo, runtime och dokumentation fortfarande matchar nuläget.

Stoppa och rapportera om projektmapp, branch, HEAD, runtime, dirty worktree eller safety-dokumentation avviker väsentligt från dokumenterat nuläge.

## Source-of-truth-princip

Second Brain ska länka till befintliga auktoritativa dokument i stället för att duplicera deras fulla innehåll. Samma status ska inte kopieras till flera filer.

Stabila regler och safety finns främst i:

- `docs/TRADING_OS_SAFETY.md`
- `docs/TRADING_OS_WORK_RULES.md`
- `docs/SAFETY_RULES.md`
- `AGENTS.md`
- `CLAUDE.md`

Beständiga beslut finns främst i:

- `docs/DECISIONS.md`

Aktuell Futures Paper-runtime finns främst i:

- `docs/FUTURES_PAPER_RUNTIME.md`
- `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`

Ops och deployment-regler finns främst i:

- `docs/RUNBOOK_DEPLOYMENT.md`

TradingView/Pine-kontrakt finns främst i:

- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md`

Följande dokument är äldre eller historiska referenser och får inte behandlas som aktuell source of truth utan ny verifiering:

- `docs/TRADING_OS_AI_CONTEXT.md`
- `docs/SUPERVISOR_UNIFICATION_PLAN.md`
- `docs/FUTURES_PAPER_PLATFORM.md`
- `README.md`
- `docs/API_MAP.md`

## Start av session

Varje ny session ska börja med read-only verifiering:

- aktuell projektmapp och Git-root
- aktuell branch, HEAD och upstream
- staged ändringar och dirty worktree
- PM2-processens namn och working directory när runtime är relevant
- att `NEXT_ACTION.md` fortfarande beskriver ett godkänt uppdrag

Om `NEXT_ACTION.md` saknar explicit implementationstillstånd är inget implementationsarbete godkänt.

## Avslut av session

Efter godkänt arbete ska agenten rapportera:

- vilka filer som lästes eller ändrades
- verifieringar som kördes
- om kod, backend, frontend, API, runtime, Git-index eller tradingstatus påverkades
- kvarvarande dirty filer eller blockerare
- rekommenderat nästa steg

Second Brain-filer får uppdateras endast när användaren uttryckligen godkänner ett docs-uppdrag.

## Single-writer-regel

Endast agenten med uttryckligt docs-uppdrag får skriva i `docs/ai-brain/`.

Agenten måste först kontrollera Git-status för dessa filer. En annan agents dirty handoff får inte skrivas över. Git är versionshistoriken. Ingen databas eller autonom låstjänst ska byggas för detta nu.

## Viktig gräns

Dokumenterad nästa åtgärd är inte samma sak som godkänd implementation. En plan, roadmap, handoff eller rekommendation ger aldrig automatiskt tillstånd att ändra kod, stage:a, committa, pusha, bygga, deploya, starta om PM2 eller påverka trading.
