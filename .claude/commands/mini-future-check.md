---
description: Kontrollera Mini Future-sidan — fas, real-money-lås, produktmapping, risk (read-only)
---

Kontrollera Mini Future-sidan enligt docs/MINI_FUTURE_RESEARCH.md. Allt read-only — skicka aldrig order.

1. **Status/fas:** vilken byggfas är sidan i (R1 dokumentation / R2 produktkatalog / R3 paper-sim / R4 manual review)? Sök mini-future-kod: `grep -rli "miniFuture\|mini-future\|mini_future" src client/src --include="*.js" --include="*.jsx"` och bedöm vad som faktiskt är mini-future-specifikt. Rapportera: research / paper / live.
2. **Real-money-lås (kritiskt):** bekräfta att real-money trading är disabled — inga ordervägar (`placeOrder|submitOrder`) i mini-future-kod, inga emittent-/mäklar-API-nycklar för orderläggning, och att regeln "Mini Future real-money trading requires separate explicit human approval" finns i docs.
3. **Product mapping:** visa mappningstabellen (strategyId → produkt, hävstång, knock-out-marginal, kostnadsandel) om den byggts; annars rapportera "ingen mappning ännu — fas R1".
4. **Riskstatus:** kontrollera mappningsreglerna (KO-marginal ≥ 1,5× entry→SL, spread+finansiering ≤ 20 % av TP, öppettider) mot ev. befintliga mappningar; flagga brott.
5. `bash scripts/harness/mini_future_harness.sh` — PASS/FAIL.

Rapport: fas, real-money-lås bekräftat (ja/nej med evidens), mappnings-läge, riskflaggor. Ingen order, ingen ändring.
