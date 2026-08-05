# Work Rules

Detta är en kort Second Brain-sammanfattning. Fulla regler och safety ska läsas i de auktoritativa dokumenten, inte dupliceras här.

Primära referenser:

- `docs/TRADING_OS_SAFETY.md`
- `docs/TRADING_OS_WORK_RULES.md`
- `docs/SAFETY_RULES.md`
- `docs/RUNBOOK_DEPLOYMENT.md`
- `AGENTS.md`
- `CLAUDE.md`

## Git-preflight

Börja varje session med read-only kontroll av:

- `pwd`
- Git-root
- branch
- HEAD
- upstream
- staged diff
- dirty worktree
- relevanta dirty filer inom scope

En dirty worktree är inte automatiskt stopp, men den får inte röras utan uttryckligt scope.

## Scope-isolering

Ändra bara filer som uttryckligen ingår i uppdraget. Rör inte orelaterade dirty filer. Formatera inte, flytta inte och strukturera inte om befintlig kod om det inte krävs och är godkänt.

Read-only är standard tills användaren uttryckligen godkänner ändringar.

## Git och runtime

Följande kräver separat uttryckligt godkännande:

- `git add`
- commit
- push
- merge
- rebase
- stash
- reset
- checkout eller branchbyte
- build som deployar eller skriver produktionsartefakter
- PM2 restart, reload, stop, start eller save
- deploy

Gör aldrig force push utan uttryckligt godkännande och separat safety-kontroll.

## Secrets

Visa aldrig lösenord, tokens, API-nycklar, cookies, session secrets eller andra hemliga värden. Env-namn får rapporteras när det behövs, men inte värdena.

## Trading-safety

Live och paper får aldrig blandas ihop.

Paper broker är inte samma sak som live broker.

En signal är inte en order. En kandidat är inte en order. En preview är inte en order. Dokumenterad plan är inte godkänd implementation.

Live trading får inte antas vara aktivt. Brokerstatus, orderstatus, account, symbol, contract, quantity, session, market data freshness, guard och risk måste verifieras i rätt scope innan någon paper-execution-relaterad slutsats dras.

## Tester och verifiering

Efter godkända ändringar ska verifiering matcha risk och scope. Kör inte tester eller builds som skriver data om uppdraget förbjuder det.

Rapportera alltid om verifiering inte kunde köras.

## Single-writer-regel för Second Brain

Endast agenten med uttryckligt docs-uppdrag får skriva i `docs/ai-brain/`.

Agenten måste först kontrollera Git-status för dessa filer.

En annan agents dirty handoff får inte skrivas över.

Git är versionshistoriken.
