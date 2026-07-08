---
description: Säker commit-procedur — safety-granskning + pathspec-commit (kör ENDAST på explicit användarorder)
---

Förbered och (endast om användaren i denna session uttryckligen beordrat commit) genomför en säker commit. Regler: ingen push, ingen pm2 save, aldrig `git add -A`/`git add .`.

$ARGUMENTS anger vad som ska committas (filer + meddelande-ämne).

1. **Bekräfta ordern:** om användaren INTE uttryckligen bett om commit i denna session — stanna här, rapportera vad som skulle committas, committa inte.
2. **Inventera:** `git status --short` + `git diff --stat`. Identifiera vilka filer som tillhör detta arbete och vilka som kan tillhöra en **parallell session** (rör aldrig deras dirty filer).
3. **Safety-granska diffen:** `git diff <filer>` — grep efter `placeOrder|submitOrder|live_trading_enabled|broker_enabled|actions_allowed|can_place_orders|mode.*live|SUBMIT.*true`. Träff = STOPP, rapportera fil:rad, committa inte utan användarens uttryckliga ok.
4. **Kör harness:** `bash scripts/harness/safety_harness.sh` (+ `regression_harness.sh` om rimligt). FAIL = STOPP.
5. **Stagea med pathspec, aldrig svepande:** `git add <exakt fil> <exakt fil> ...`. Verifiera med `git status --short` att inget annat stageats.
6. **Committa:** kort svensk beskrivning i konventionellt format (`feat:`/`fix:`/`docs:` ...), avsluta med `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
7. **Rapportera:** commit-sha, filer, harness-resultat, samt explicit: **push = nej, pm2 save = nej**.
