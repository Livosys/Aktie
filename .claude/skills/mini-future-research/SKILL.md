---
name: mini-future-research
description: Mini Future-sidan — research/paper-fas, produktbegrepp (hävstång, knock-out, finansieringsnivå, spread), mappningsregler och real-money-låset. Läs vid allt Mini Future-arbete.
---

# Mini Future Research

Kanoniskt dokument: `docs/MINI_FUTURE_RESEARCH.md`.

## HÅRD REGEL
**Mini Future real-money trading requires separate explicit human approval.** Fasen är research/preparation/paper/simulation/product mapping/risk control. Inga ordervägar (`placeOrder`/`submitOrder`), inga emittent-API-nycklar för orderläggning, inga order-knappar utan PAPER/SIMULATION-märkning.

## Flöde
Trading OS approved signal → Mini Future Agent → product matching → risk check → paper/simulation → manual review → [LÅST] senare eventuell riktig order.

## Mappningsregler (utkast, se docs för detaljer)
1. Underliggande matchar strategins symbol/index.
2. Knock-out bortom strategins SL med marginal ≥ 1,5 × (entry→SL) — strategins SL ska alltid exekvera före knock-out.
3. Hävstång väljs efter risk per trade (~0,3 % av equity), inte max tillgänglig.
4. Spread + finansiering ≤ 20 % av förväntad TP.
5. Signal utanför produktens öppettider → skip, loggas.

## Produktbegrepp att alltid räkna på
Hävstång = pris/(pris − finansieringsnivå); finansieringsnivån justeras dagligen (räntekostnad); knock-out = produktdöd med litet/inget restvärde; spread = kostnad per round trip; emittentrisk.

## Byggfaser
R1 dokumentation (nu) → R2 read-only produktkatalog → R3 paper-sim med spread/finansiering (resultat separerade) → R4 manual review → LIVE (låst, byggs endast på explicit order).

## Verifiering
`bash scripts/harness/mini_future_harness.sh`; command `/mini-future-check`.
