# MINI_FUTURE_RESEARCH — Mini Future-sidan

## Status: RESEARCH / PREPARATION / PAPER — ingen riktig handel

Långsiktigt mål: handla Mini Futures med riktiga pengar baserat på godkända Trading OS-strategier. Just nu är Mini Future-sidan uteslutande research, preparation, paper/simulation, product mapping och risk control.

**Säkerhetsregel (kanonisk):** *Mini Future real-money trading requires separate explicit human approval.* Ingen kod i denna fas får innehålla en riktig ordervägg mot emittent/mäklare. Mini Future Agent får aldrig aktivera riktig order.

## Nuläge (inventering 2026-07-08)

Ingen dedikerad Mini Future-kod finns i repot ännu (grep på mini-future ger endast orelaterade träffar). Sidan ska byggas som konsument av Trading OS-signaler — aldrig med egen strategilogik.

## Vad Mini Future-sidan ska förstå

| Begrepp | Betydelse för oss |
|---|---|
| Mini Future Long/Short | riktningsprodukt med inbyggd hävstång |
| Hävstång | pris / (pris − finansieringsnivå); ändras löpande |
| Finansieringsnivå | emittentens lånedel; justeras dagligen (räntekostnad) |
| Stop loss / knock-out | produktens SL-nivå — träffas den dör produkten (restvärde ≈ 0–litet) |
| Spread | emittentens köp/sälj-diff; kostnad per round trip |
| Öppettider | produktens handelstider (ofta 08:00–22:00 CET) vs underliggandes |
| Emittent | utgivare (t.ex. bank); motpartsrisk + produktvillkor |
| Courtage/avgifter | mäklaravgift + spread + finansieringskostnad |
| Position sizing | risk per trade i SEK utifrån avstånd till produkt-SL, inte bara hävstång |

## Arkitektur (planerad)

```
Trading OS approved signal (strategyId + direction + entry/SL/TP)
  → Mini Future Agent
  → product matching   (rätt underliggande, riktning, hävstångsband,
                        knock-out tillräckligt långt från strategins SL)
  → risk check         (knock-out-marginal ≥ X × ATR; spreadkostnad vs TP;
                        max risk per trade; produktens öppettider täcker signalen)
  → paper/simulation   (simulerad fill med spread + finansiering)
  → manual review      (människa granskar varje steg)
  → [LÅST] senare eventuell riktig order — separat explicit mänskligt godkännande
```

### Mappningsregler strategi → produkt (utkast)

1. Underliggande matchar strategins symbol/index (Nasdaq-strategi → Mini på NDX/QQQ-ekvivalent).
2. Produktens knock-out ska ligga **bortom** strategins stop loss med säkerhetsmarginal (förslag: ≥ 1,5 × avståndet entry→SL) så att strategins SL alltid hinner exekvera före knock-out.
3. Effektiv hävstång i en **framtida real-money-mappning** väljs efter strategins risk per trade (t.ex. 0,3 % av equity), inte max tillgänglig. I **research/paper** gäller i stället hävstångstestet nedan: 10x/15x/20x körs medvetet för att hitta vilka strategier som klarar nära stop/knock-out.
4. Spread + finansiering får inte äta upp mer än en definierad andel av förväntad TP (förslag: ≤ 20 %).
5. Signal utanför produktens öppettider → ingen mappning (skip, loggas).

## Hävstångstest: 10x / 15x / 20x (research/paper/simulation)

**Ny regel:** vi ska inte bara undvika hög hävstång — vi ska aktivt **testa** hög hävstång i simulation för att hitta vilka strategier som klarar att arbeta nära stop/knock-out. Allt i denna sektion är research/paper/simulation. Ingen riktig order, ingen broker, ingen live trading.

### Testmodell

```
leverageTestLevels = [10, 15, 20]
```

Varje godkänd strategi ska kunna testas på alla tre nivåerna. Testerna körs i paper/replay/simulation (Fas R3) med simulerad spread, finansiering och knock-out-logik.

### Risknivåer per hävstång

| Hävstång | riskLevel | Regel |
|---|---|---|
| 10x | `high` | tillåten i research |
| 15x | `very_high` | tillåten i research |
| 20x | `extreme` | **blockeras INTE i research** — men märks alltid som mycket hög risk och lyfts tydligt i UI/rapporter |

20x får aldrig tystas ner till en lägre risknivå. **All real-money trading med hög hävstång kräver separat explicit human approval** — risknivåerna ovan gäller enbart märkning i research, aldrig ett godkännande för riktig handel.

### Märkning av varje testresultat

Varje resultat (per trade och per aggregat) ska bära:

| Fält | Innehåll |
|---|---|
| `leverageLevel` | 10, 15 eller 20 — vilken hävstång resultatet gäller |
| `riskLevel` | `high` / `very_high` / `extreme` enligt tabellen ovan |
| `knockOutDistancePct` | avstånd entry→knock-out i % — **om produktdata finns**, annars `null` |
| `spreadPct` | emittentens spread i % — **om produktdata finns**, annars `null` |
| `mode` | alltid `research`/`paper`/`simulation` — aldrig live |

### Per-strategi-rapportering (Strategy Score)

Strategy-score ska kunna visa hävstångsbrutna fält:

```
winRate10x   winRate15x   winRate20x
pnl10x       pnl15x       pnl20x
maxDrawdown10x  maxDrawdown15x  maxDrawdown20x
bestLeverageLevel        — nivån med bäst riskjusterat utfall
leverageRecommendation   — motivering: varför den nivån, och vilka nivåer strategin INTE klarar
```

`bestLeverageLevel` väljs inte på PnL ensamt: knock-out-frekvens, stop loss hits, max drawdown och stabilitet vägs in. En strategi som tjänar mest på 20x men knockas ofta ska normalt rekommenderas en lägre nivå.

### UI-plan: Mini Future-sidan

Sidan ska alltid **visa vilken hävstång som används** och visa:

- aktiv testhävstång (10x / 15x / 20x)
- resultat per hävstång, per strategi: win rate, PnL, drawdown, stop loss hits, knock-out-risk (inkl. `knockOutDistancePct` och `spreadPct` när produktdata finns)
- rekommenderad hävstång (`bestLeverageLevel` + `leverageRecommendation`)
- om strategin klarar 10x / 15x / 20x (klarar/klarar inte-badge per nivå)
- risknivå-badge per resultat (`high` / `very_high` / `extreme`)
- tydlig `RESEARCH/PAPER/SIMULATION`-märkning — inga order-knappar

### Säkerhetsregler för hävstångstestet

- Endast research/paper/simulation — ingen riktig Mini Future-order, ingen broker, ingen live trading, ingen IBKR submit.
- 20x blockeras inte i research men får aldrig presenteras utan `extreme`-märkning.
- Hävstångstestresultat får aldrig blandas med riktig performance; de märks alltid med `leverageLevel` + simulation-flaggor.
- All real-money trading med hög hävstång kräver separat explicit human approval — utöver det generella LIVE-låset.

## Byggfaser

1. **Fas R1 (nu):** dokumentation + datamodell för produkt (emittent, KO-nivå, finansieringsnivå, spread, hävstång, öppettider).
2. **Fas R2:** read-only produktkatalog + mappnings-preview i UI (inga order-knappar).
3. **Fas R3:** paper-simulering med spread/finansiering; resultat till Learning & Scoring, separerat från övriga paper-resultat. Inkluderar hävstångstestet: varje strategi körs på 10x/15x/20x (`leverageTestLevels`), resultat märks med `leverageLevel`/`riskLevel` och aggregeras till `winRate/pnl/maxDrawdown` per nivå + `bestLeverageLevel`.
4. **Fas R4:** manual review-flöde och rapportering, inkl. hävstångsrekommendation per strategi (`leverageRecommendation`).
5. **Fas LIVE:** LÅST. Kräver separat explicit mänskligt godkännande, egen safety-design, egen granskning. Byggs inte förrän användaren uttryckligen beordrar det.

## Förbud i alla faser före LIVE

- Inga API-nycklar till mäklare/emittent för orderläggning.
- Inga `placeOrder`/`submitOrder`-funktioner i Mini Future-kod.
- Ingen UI-knapp som ens ser ut som riktig orderläggning utan `PAPER/SIMULATION`-märkning.

Verifiering: `bash scripts/harness/mini_future_harness.sh`, command `/mini-future-check`.
