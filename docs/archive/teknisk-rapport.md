# Meridian 1.0 — Designbeslut och teknisk rapport

**Produkt:** AI-driven handelsplattform
**Version:** 1.0
**Roll:** Product Design, UX, Frontend Architecture
**Bärande princip:** *AI:n arbetar. Användaren övervakar.*

---

## Designgrunden (läs detta först)

### Produktens tes

Dagens gränssnitt i den här typen av system är byggda för den som byggt systemet. De visar köer, körningar, hashar och register — alltså maskinens inre organ. Meridian vänder på det: **maskinen får inte synas, bara dess omdöme.**

Hela produkten svarar på fyra frågor, i den här ordningen, på varje sida:

| Fråga | Var den besvaras |
|---|---|
| Vad händer? | Hero-meningen överst på varje sida |
| Varför händer det? | Alltid ett steg bort — panelen "Varför" i detaljvyn |
| Behöver jag göra något? | Zonen **Behöver dig** på Idag, samt guldfärgad vänsterskena |
| Vad blir nästa steg? | Sista raden i varje beslutskort: "Vad som händer nu" |

### Signaturelementet: Dygnsbandet

Produktens ansikte är inte ett stort tal. Det är **Dygnsbandet** — en 24-timmars remsa där varje streck är en sak AI:n gjorde. Höjd = betydelse, färg = tillstånd, riktning = normal eller avvikande. Natten ligger i ett svalare fält så att man ser att arbetet fortsatte medan man sov. Det enda strecket som pekar *nedåt* är avvikelsen kl 11:47.

Motivering: en användare som öppnar produkten på morgonen vill inte läsa en tabell över 42 testkörningar. Hen vill se formen på natten på 0,4 sekunder. Bandet gör "AI:n arbetade" till ett visuellt faktum istället för ett påstående. Det återanvänds i miniatyr på Arbetet och i strategiernas livslinje.

### Visuellt språk

**Färg — bläckblått, inte svart.** Svart bakgrund + neonaccent är den generiska "trading terminal"-looken. Meridian ligger på `#0D141C`, ett kallt bläckblått, med **mässing** `#C79A4B` som enda varma accent. Mässing betyder alltid en sak: *AI:n vill något av dig.* Det är den dyraste färgen i paletten och den används sparsammast.

| Token | Hex | Betyder — alltid, överallt |
|---|---|---|
| `--ink` | `#0D141C` | Bakgrund |
| `--ink-2` | `#121C26` | Kort och paneler |
| `--ink-3` | `#17232F` | Hover, upphöjt |
| `--ink-4` | `#1D2C3A` | Aktivt, mätarspår |
| `--line` | `#22313F` | Kanter |
| `--line-soft` | `#1A2632` | Interna avdelare |
| `--fg` | `#E7EBEF` | Primärtext |
| `--fg-2` | `#9AAABA` | Brödtext |
| `--fg-3` | `#62778A` | Etiketter, tidsstämplar |
| `--brass` | `#C79A4B` | **AI:n väntar på dig** |
| `--teal` | `#4FA8A0` | **Arbetar just nu** |
| `--green` | `#5FB98B` | **Bekräftat / skarpt** |
| `--red` | `#D9736A` | **Avvikelse / stopp** |
| `--violet` | `#8A7FC7` | **Osäkert / under prövning** |

Röd och grön används *aldrig* enbart för att bära information — statusen står alltid också i ord. Ca 8 % av männen är rödgrönblinda och det här är en produkt där en missad avvikelse kostar pengar.

**Typografi — tre roller.**

| Roll | Familj | Motivering |
|---|---|---|
| Display | **Bricolage Grotesque** 600 | Har en egen egenhet i kurvorna som ger produkten ett ansikte utan att bli dekorativ. Används bara till sidrubriker och kortrubriker. |
| Brödtext / UI | **Instrument Sans** 400–600 | Neutral, hög läsbarhet i 13–14 px, kort x-höjd som ger luft. |
| Data och etiketter | **Martian Mono** 300–400 | Ovanlig monospace med bred teckenruta. Alla siffror är tabulära, så kolumner ligger still när tal uppdateras. Även versala etiketter (`eyebrow`) sätts här — det ger produkten en instrumentkänsla utan att någon rubrik behöver skrika. |

Typskala: 38 / 26 / 18 / 14 / 12,5 px. Fem steg, inte fler. Etiketter 9,5 px med 0,16 em spärr.

**Spacing.** 4 px-bas, 8 px-rytm: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Kortens innerpadding är alltid 24. Avstånd mellan sektioner alltid 32. Inga undantag — det är därför sidorna känns lugna trots hög informationstäthet.

**Radier.** 6 (badge, knapp) / 10 (kort) / 14 (Dygnsbandet). Bandet får den största radien eftersom det är produktens enda "objekt", allt annat är ytor.

**Vänsterskenan.** Varje kort kan bära en 2 px vertikal skena i tillståndsfärg. Den kodar något sant: *vem äger nästa steg.* Guld = du. Turkos = AI:n arbetar. Grön = klart. Röd = stopp. Violett = osäkert. Ingen skena = ren information.

### Copy-principer

1. **Rubriker är påståenden, inte etiketter.** "Nordisk Momentum håller", inte "Backtest-resultat".
2. **Ingen siffra utan omdöme.** −7,1 % står aldrig ensamt; bredvid står "Största nedgång" och i texten "återhämtade sig på nio veckor".
3. **Knapptexten är löftet.** "Godkänn provhandel" → toast "Provhandel godkänd". Samma verb hela vägen.
4. **Tomlägen är inbjudningar**, aldrig ursäkter: "Ingen ännu. En strategi behöver 60 dagars provhandel utan avvikelser. Sektorbalans är närmast — 30 dagar kvar."
5. **Fel förklarar orsak och konsekvens.** "Marknadsdata dröjde 22 minuter. AI:n väntade istället för att testa på ofullständig historik. Inga resultat påverkades."

---

# 1. Vilka sidor skapades

| # | Sida | Route | Sidans enda jobb |
|---|---|---|---|
| 1 | **Idag** | `/` | Svara på *behöver jag göra något?* innan användaren hinner fråga |
| 2 | **Arbetet** | `/arbetet` | Göra AI:ns arbete begripligt utan att avslöja maskineriet |
| 3 | **Strategier** | `/strategier` | Visa var varje strategi står i sin livscykel |
| 4 | **Utvärderingar** | `/utvarderingar` | Ge ett *omdöme* om en strategi, inte en datadump |
| 5 | **Provhandel** | `/provhandel` | Visa hur strategierna beter sig mot dagens marknad |
| 6 | **Journal** | `/journal` | Produktens minne: varje beslut och varför |
| 7 | **System** | `/system` | Svara på *kan jag lita på det jag ser?* |

Sju sidor. Det är taket. Sju objekt är gränsen för vad en människa kan hålla i huvudet som en karta, och navigationen ska kunna läras utantill första dagen.

**Sidan Idag i detalj**

- *Först:* datum, en hero-mening i två rader ("AI:n arbetar. / Två saker väntar på dig."), sedan Dygnsbandet.
- *Viktigast:* zonen **Behöver dig**. Den ligger direkt under bandet och innehåller 0–3 kort. Är den tom skrivs "Ingenting väntar på dig" — och det är ett *bra* besked, inte ett tomläge.
- *Döljs:* alla siffror som inte kräver handling. Ingen kontobalans i hero, ingen körningslogg, ingen kölängd.
- *Klickbart:* de två besluts-CTA:erna, "Visa underlaget" (detaljpanel), tre lägeskort (leder vidare), händelserader (leder till Journal).
- *Arbetsflöde:* öppna → läs meningen → läs bandet → agera på 0–2 kort → stäng. Median 40 sekunder.

**Sidan Arbetet i detalj**

- *Först:* "Sju uppgifter pågår" och en fyrstegs-pipeline: Söker idéer → Prövar mot historik → Granskar → Rekommenderar.
- *Viktigast:* pipelinen. Den ersätter fem interna begrepp med fyra ord en människa kan uttala.
- *Döljs:* jobb-ID:n, worker-namn, retry-antal, kölogik, minnesåtgång.
- *Klickbart:* varje pipeline-steg filtrerar tabellen; varje tabellrad öppnar detaljpanel.
- *Arbetsflöde:* besöks sällan och frivilligt. Sidan avslutas med hjälprutan "Du kan stänga den här sidan. Inget stannar för att du tittar bort." — det är sidans egentliga budskap.

**Sidan Strategier i detalj**

- *Först:* fem stadiekort som också är filter: Under prövning → Godkänd i historik → Väntar på dig → I provhandel → Skarp.
- *Viktigast:* stadiet. En strategis viktigaste egenskap är inte dess avkastning utan hur långt den kommit i att bevisa sig.
- *Döljs:* parametrar, versionshashar, kodrepresentation, generationsträd.
- *Klickbart:* stadiekort (filter), rad (detaljpanel med livslinje).
- *Arbetsflöde:* används när användaren vill *förstå sin portfölj av idéer*, inte när något brådskar.

**Sidan Utvärderingar i detalj**

- *Först:* senaste utvärderingen i helfigur — rubrik som omdöme, ett stycke prosa, kapitalkurva mot marknaden, fyra nyckeltal.
- *Viktigast:* prosastycket. Det är AI:ns motivering, och det står *före* diagrammet.
- *Döljs:* rådata, parameterlistor, körningsloggar, per-affär-tabeller (finns i detaljpanel för den som vill).
- *Klickbart:* "Så testade AI:n" (fyrastegspanelen), historiska rader.
- *Arbetsflöde:* hit går man när man vill kontrollera AI:n. Sidan är byggd för misstro — därför visas alltid perioden som gick sämst, och därför finns fliken "Underkända".

**Sidan Provhandel i detalj**

- *Först:* "inga riktiga pengar" som etikett över rubriken. Det får aldrig gå att missförstå vilket läge man är i.
- *Viktigast:* kolumnen **Stämmer med test**. Provhandelns syfte är inte avkastning — det är att upptäcka glappet mellan historik och verklighet.
- *Döljs:* orderdjup, exekveringsdetaljer, per-tick-data.
- *Klickbart:* strategirader, "Ta ställning" på pausad strategi, "Visa alla 86".
- *Arbetsflöde:* snabb kontroll ett par gånger i veckan, plus när Idag pekar hit.

**Sidan Journal i detalj**

- *Först:* dagens beslut i omvänd kronologi. AI:ns och användarens beslut i **samma** flöde, åtskilda bara av badge.
- *Viktigast:* varje kort har alltid tre stycken — *Varför*, *Vad som händer nu*, och vid behov *Din motivering*.
- *Döljs:* ingenting. Journalen är produktens enda sida som aldrig döljer något — och som aldrig får redigeras i efterhand.
- *Klickbart:* "Se underlaget", "Skriv en kommentar", "Hantera lärdomar".
- *Arbetsflöde:* används retroaktivt — på söndagen, eller när något gått fel.
- *Kortet "Dina beslut i siffror"* innehåller raden "Avvisade som senare visade sig bra: 2". Den är avsiktligt obekväm. En produkt där AI:n arbetar måste ge användaren ett sätt att kalibrera sitt eget omdöme.

**Sidan System i detalj**

- *Först:* rubriken "Allt fungerar" — sidan svarar på sin fråga i tre ord.
- *Viktigast:* tabellen **Kontroller som körs automatiskt**, där varje rad har kolumnen "Vad den skyddar mot". Framtidsläckage skyddar mot "att AI:n råkar se morgondagen".
- *Döljs:* uptime-procent, CPU, latens, versionsnummer, loggnivåer.
- *Klickbart:* "Ändra gränser".
- *Arbetsflöde:* besöks nästan aldrig — statuspillret i topbaren är sidans egentliga gränssnitt. Man klickar sig hit bara när pillret inte är grönt.

---

# 2. Vilka sidor togs bort

| Borttagen | Varför | Vart innehållet tog vägen |
|---|---|---|
| **Labs** | Ett labb är en utvecklarmetafor. Användaren experimenterar inte — AI:n gör det. | Stadiet "Under prövning" på Strategier + fliken "Underkända" på Utvärderingar |
| **Replay Queue** | Ren maskinvy. Kölängd är inte ett användarproblem förrän den blir ett problem. | Kapacitetsmätaren på Arbetet; larm om kön växer |
| **Experiment Registry** | Ett register är en databasvy, inte en sida. | Tabellen "Tidigare utvärderingar" |
| **Factory Director** | Namnet beskriver arkitekturen, inte nyttan. | Pipelinen på Arbetet |
| **Strategy Runtime** | Sammanfaller helt med Provhandel + Strategier. | Kolumnen "Läge" på Provhandel |
| **Batch Runner** | Batch är ett schemaläggningsbegrepp. | "Just nu"-tabellen på Arbetet |
| **Marknad** (egen sida) | En hel sida marknadsdata gör användaren till analytiker. Produktens tes är motsatsen. | Kortet "Marknaden idag" på Idag + panelen "Vad betyder det?" |
| **Inställningar** (egen sida) | 12 inställningar motiverar ingen sida. | Kortet "Gränser du satt" på System |

---

# 3. Vilka sidor slogs ihop

| Nya sidan | Består av | Motivering |
|---|---|---|
| **Idag** | Gammal Dashboard + Notifieringar + delar av Marknad + översta lagret av Systemhälsa | En användare som "övervakar" behöver **en** sida som är sann. Allt annat är fördjupning. |
| **Arbetet** | AI Dashboard + Replay Queue + Batch + Factory Director + Runtime-status | Fem vyer av samma sak: *vad gör maskinen just nu.* |
| **Strategier** | Strategibibliotek + Labs + DNA-vyn | Ett labb och ett bibliotek är samma lista i olika stadier. Stadiet blir kolumn, inte sida. |
| **Utvärderingar** | Historiska tester + Experiment Registry + Rapportvyn | Ett test utan omdöme är inte färdigt. Rapporten *är* testet. |
| **Journal** | Beslutsjournal + Lärdomar + Aktivitetslogg | Ett beslut och lärdomen av det hör ihop kronologiskt. |
| **System** | Systemhälsa + Datastatus + Anslutningar + Inställningar | Allt som svarar på "kan jag lita på det här?" |

---

# 4. Ny navigation

Vänsterkolumn, 236 px, tre namngivna grupper. Grupperingen speglar användarens mentala modell, inte systemets moduler.

```
MERIDIAN
────────────────
ÖVERSIKT
  ● Idag                 [prick = något väntar på dig]
  ● Arbetet          7   [siffra = pågående uppgifter]
KAPITAL
  ● Strategier      24
  ● Utvärderingar
  ● Provhandel       4
MINNE
  ● Journal
  ● System
────────────────
◉ AI:n arbetar
  Sedan 05:00 · 7 uppgifter
```

**Regler**

- **Prick vs siffra.** En guldprick betyder alltid *något kräver dig*. En siffra är bara information. De blandas aldrig i samma post.
- **Ikonen färgas mässing** endast på aktiv sida.
- **Sidfoten är permanent.** Pulsen i AI-statusen är produktens hjärtslag och syns på alla sidor, även när användaren är djupt inne i en detaljpanel. Den är designens svar på "arbetar systemet fortfarande?" — en fråga som annars ställs genom att ladda om sidan.
- **Topbar** innehåller: sidtitel, systempill ("Allt fungerar", klickbart → System), klocka. Ingen global sökruta i 1.0 — det finns inte tillräckligt att söka i än.
- Under 1024 px kollapsar sidebaren till ikonrad; under 720 px blir den en bottenflik med de fyra första posterna, resten under "Mer".

---

# 5. Alla komponenter som används

**Primitiver**

| Komponent | Props | Anmärkning |
|---|---|---|
| `Card` | `rail?: 'brass'\|'teal'\|'green'\|'red'\|'violet'`, `as`, `children` | Bärande yta. Skenan kodar ägarskap av nästa steg. |
| `Badge` | `tone`, `children` | Alltid VERSAL Martian Mono 9,5 px. Max ett ord + siffra. |
| `Button` | `variant: 'primary'\|'default'\|'ghost'`, `size: 'md'\|'sm'` | Exakt **en** primary per vy. |
| `Metric` | `value`, `label`, `tone?` | Tabulära siffror, etikett under, aldrig tvärtom. |
| `Eyebrow` | `children` | Versal etikett över rubrik. Bär kontext, aldrig innehåll. |
| `Table` | `columns`, `rows`, `onRowClick` | Sista kolumnen alltid högerställd. Rad = klickbar. |
| `RowItem` | `time?`, `title`, `body`, `trailing?` | Händelserad. Används i fyra sammanhang. |
| `Segmented` | `options`, `value`, `onChange` | Tidsfilter. Max fyra alternativ. |
| `Hint` | `children` | Grå informationsruta. Aldrig fler än en per skärm. |
| `EmptyState` | `title`, `body`, `action?` | Streckad kant. Måste innehålla nästa steg. |
| `Skeleton` | `w`, `h` | Shimmer 1,4 s. Används bara där data verkligen strömmar in. |
| `Drawer` | `open`, `onClose`, `children` | Höger panel, 560 px. **All** fördjupning sker här — aldrig via sidbyte. |

**Sammansatta**

| Komponent | Var |
|---|---|
| `DayBand` | Idag (full), Arbetet (mini) |
| `DecisionCard` | Idag (Behöver dig), Journal |
| `StageFilterRow` | Strategier |
| `PipelineRow` | Arbetet |
| `EquityChart` | Utvärderingar, detaljpaneler |
| `Sparkline` | Idag, Strategier |
| `DriftMeter` | Avvikelsepanelen, Provhandel |
| `HealthCard` | System |
| `LessonList` | Journal |
| `AiStatusFooter` | Sidebar (global) |

---

# 6. Alla nya komponenter

| Ny komponent | Varför den behövs |
|---|---|
| **`DayBand`** | Produktens signatur. Gör 24 timmars autonomt arbete läsbart på under en sekund. Ersätter en aktivitetslogg på 200 rader. |
| **`DecisionCard`** | Standardiserar det enda kravet produkten ställer på användaren. Har alltid samma fyra delar: vad, varför, siffror, tre val. Tre val — aldrig två. Det tredje är alltid "gör inget än", eftersom en produkt som tvingar fram ja/nej får fler dåliga ja. |
| **`DriftMeter`** | Visar *skillnad* mellan test och verklighet, inte absolutvärden. Kärnan i förtroendet: strategin är inte fel för att den förlorar, den är fel för att den beter sig annorlunda. |
| **`StageFilterRow`** | Fem kort som är både överblick och filter. Livscykeln blir navigering. |
| **`PipelineRow`** | Fyra begripliga steg som ersätter fem interna system. |
| **`AiStatusFooter`** | Permanent hjärtslag. Tar bort behovet av att ladda om för att se om systemet lever. |
| **`ProsePanel`** | Prosastycket i utvärderingar. AI:ns motivering i löpande text, med tvingande fält: *slutsats*, *svagaste perioden*, *vad som talar emot*. |
| **`LessonList`** | Gör AI:ns inlärning till ett objekt användaren kan se och ändra. Utan detta blir "AI:n lär sig" ett tomt påstående. |

---

# 7. Vilka komponenter återanvänds

Följande antas finnas och behålls med ny styling men samma API-yta:

- `Card`, `Badge`, `Button`, `Table`, `Skeleton`, `EmptyState`
- `Drawer` / `Sheet` — utökas med tangentbordsfälla och Escape
- `EquityChart` — behålls, men får ny standard: marknadsjämförelse alltid på, streckad grå; sämsta perioden alltid skuggad röd
- `Sparkline` — behålls, ny fast höjd 34 px
- Toast/notifieringssystem — behålls, ny copy-regel (verbet från knappen)
- Datum- och talformatering — behålls, tvingas till `sv-SE` och tabulära siffror

---

# 8. Vilka komponenter bör tas bort

| Tas bort | Varför |
|---|---|
| `JsonViewer` / `RawPayloadPanel` | Rå data i UI är en utvecklarvana. Flyttas till exportfunktion. |
| `DnaHashChip`, `RunIdChip`, `CandidateIdBadge` | Exponerar interna identifierare. Ersätts av strateginamn. |
| `QueueDepthGauge`, `WorkerHealthGrid` | Ersätts av en enda kapacitetsmätare i procent. |
| `LogStreamConsole` | Ersätts av "Vad AI:n lärde sig idag" och Journal. |
| `ParameterGridEditor` | Användaren ska inte ställa parametrar — då är det ett utvecklarverktyg. Ersätts av "Gränser du satt". |
| `AdvancedFilterBar` (12 fält) | Ersätts av `StageFilterRow` + `Segmented`. |
| `MetricGrid` med 20+ nyckeltal | Ersätts av fyra `Metric`. De övriga finns i detaljpanel. |
| `TabsWithSubTabs` | Nästlade flikar döljer information bakom två klick. Ersätts av drawer. |
| `ConfirmModal` för rutinåtgärder | Modaler avbryter. Ersätts av toast med "Ångra" i 8 sekunder. |

---

# 9. Exakt vilka filer som skulle behöva ändras

> Antagande: Next.js App Router + TypeScript + CSS-variabler. Justera prefix om projektet använder Vite/React Router — strukturen är densamma.

**Nya filer**

```
app/(app)/layout.tsx                      ← skal: Sidebar + Topbar + Drawer-provider
app/(app)/page.tsx                        ← Idag
app/(app)/arbetet/page.tsx
app/(app)/strategier/page.tsx
app/(app)/utvarderingar/page.tsx
app/(app)/utvarderingar/[id]/page.tsx
app/(app)/provhandel/page.tsx
app/(app)/journal/page.tsx
app/(app)/system/page.tsx

styles/tokens.css                         ← hela tokentabellen i sektion "Designgrunden"
styles/base.css                           ← typskala, fokusring, reduced-motion

components/shell/Sidebar.tsx
components/shell/Topbar.tsx
components/shell/AiStatusFooter.tsx
components/shell/DrawerHost.tsx

components/ui/Card.tsx
components/ui/Badge.tsx
components/ui/Button.tsx
components/ui/Metric.tsx
components/ui/Eyebrow.tsx
components/ui/DataTable.tsx
components/ui/RowItem.tsx
components/ui/Segmented.tsx
components/ui/Hint.tsx
components/ui/EmptyState.tsx
components/ui/Skeleton.tsx
components/ui/Drawer.tsx

components/domain/DayBand.tsx
components/domain/DecisionCard.tsx
components/domain/DriftMeter.tsx
components/domain/StageFilterRow.tsx
components/domain/PipelineRow.tsx
components/domain/ProsePanel.tsx
components/domain/LessonList.tsx
components/domain/EquityChart.tsx
components/domain/Sparkline.tsx
components/domain/HealthCard.tsx

lib/vocabulary.ts                         ← ENDA stället där internt→mänskligt språk översätts
lib/format.ts                             ← sv-SE tal, procent, datum, relativ tid
lib/stage.ts                              ← livscykelns fem stadier + tillåtna övergångar
```

**Ändrade filer**

```
app/layout.tsx                            ← fontinladdning, lang="sv"
tailwind.config.ts / theme.css            ← ersätt hela palett- och typskalan
components/charts/*                       ← ny standardstil, marknadslinje på som default
components/Notifications.tsx              ← ny copy-regel, "Ångra"-mönster
lib/api/*.ts                              ← endpoints grupperas per SIDA, inte per subsystem
middleware.ts                             ← redirects i sektion 10
```

**Borttagna filer**

```
app/labs/**
app/replay-queue/**
app/experiment-registry/**
app/factory-director/**
app/runtime/**
app/market/**
app/settings/**
components/JsonViewer.tsx
components/DnaHashChip.tsx
components/QueueDepthGauge.tsx
components/WorkerHealthGrid.tsx
components/LogStreamConsole.tsx
components/ParameterGridEditor.tsx
components/AdvancedFilterBar.tsx
```

---

# 10. Vilka routes som påverkas

**Nya**

| Route | Sida |
|---|---|
| `/` | Idag |
| `/arbetet` | Arbetet |
| `/arbetet/[uppgiftId]` | Öppnar Arbetet med detaljpanel (delbar länk) |
| `/strategier` | Strategier |
| `/strategier/[slug]` | Strategier med detaljpanel |
| `/utvarderingar` | Utvärderingar |
| `/utvarderingar/[id]` | Enskild utvärdering |
| `/provhandel` | Provhandel |
| `/provhandel/affarer` | Alla affärer |
| `/journal` | Journal |
| `/journal/lardomar` | Journal, fliken Lärdomar |
| `/system` | System |

**Permanenta redirects (301)**

```
/dashboard              → /
/ai-dashboard           → /arbetet
/replay-queue           → /arbetet
/batch                  → /arbetet
/factory-director       → /arbetet
/runtime                → /provhandel
/labs                   → /strategier?stadium=provning
/strategy-library       → /strategier
/experiment-registry    → /utvarderingar
/backtests              → /utvarderingar
/backtests/:id          → /utvarderingar/:id
/paper-trading          → /provhandel
/decisions              → /journal
/lessons                → /journal/lardomar
/health                 → /system
/settings               → /system
/market                 → /
```

**Designregel för routing:** en detaljpanel byter URL men inte sida. Öppnas URL:en direkt renderas sidan bakom panelen i sitt normala läge. Ingen vy i produkten är oåtkomlig utan panel.

---

# 11. Vilka komponenter flyttas

| Komponent | Från | Till | Varför |
|---|---|---|---|
| `EquityChart` | Backtest-sidan | `components/domain/` — används på Utvärderingar och i tre drawers | Samma diagram, tre sammanhang |
| `HealthGrid` → `HealthCard` | Egen systemsida | Tre kort på System + statuspill i Topbar | Hälsa ska synas överallt, förklaras på ett ställe |
| Marknadsblocket | Egen Marknad-sida | Kort på Idag + drawer | Marknadsläge är kontext, inte destination |
| Lärdomslistan | Under AI Dashboard | Sidopanel på Journal | Lärdom hör ihop med beslut, inte med körningar |
| Aktivitetsloggen | Egen sida | "Medan du var borta" (Idag) + Journal | Samma data, två tidsperspektiv |
| Kapacitetsmätaren | Replay Queue | Sidopanel på Arbetet | Kapacitet är ett attribut, inte en sida |
| Inställningar | Egen sida | Kortet "Gränser du satt" på System | Gränser är en del av förtroendet |

---

# 12. Vilka komponenter byter namn

Namnbytet är inte kosmetiskt. **Om ett komponentnamn läcker in i UI ska det vara ett ord användaren känner igen.**

| Före | Efter |
|---|---|
| `FactoryDirectorPanel` | `PipelineRow` |
| `ReplayQueueTable` | `ActiveWorkTable` |
| `BatchProgressBar` | `TaskProgress` |
| `DnaCard` | `StrategyCard` |
| `CandidateRow` | `StrategyRow` |
| `RuntimeStatusChip` | `LiveModeBadge` |
| `ExperimentRow` | `EvaluationRow` |
| `BacktestReport` | `EvaluationVerdict` |
| `DecisionLogEntry` | `JournalEntry` |
| `SystemHealthWidget` | `HealthCard` |
| `PaperTradeRow` | `TradeRow` |
| `DriftAlert` | `DriftMeter` |
| `KpiGrid` | `MetricRow` |
| `ActivityFeed` | `DayBand` (visuell) + `EventList` (textuell) |

---

# 13. Vilka API-anrop sidan använder

> Principen: **ett anrop per sida.** Backend komponerar. Frontend ska aldrig behöva veta att det finns fem subsystem — det är just den kunskapen som läckt ut i dagens UI.

**`GET /api/idag`**
```jsonc
{
  "greeting": { "state": "working", "waitingCount": 2, "since": "05:00" },
  "band": [ { "t": "2026-08-18T03:12:00Z", "kind": "test|proposal|idea|drift",
              "weight": 0.0-1.0, "label": "Testkörning" } ],
  "needsYou": [ { "id", "type": "proposal|drift", "title", "why",
                  "metrics": [{label, value, tone}], "actions": [{id, label, variant}] } ],
  "status": { "paper": {...}, "work": {...}, "market": {...} },
  "recent": [ { "time", "title", "body", "tag" } ]
}
```

| Sida | Anrop |
|---|---|
| Idag | `GET /api/idag` · `POST /api/beslut` (godkänn/avvakta/stoppa) |
| Arbetet | `GET /api/arbetet` · `GET /api/arbetet/:id` · SSE `GET /api/arbetet/stream` |
| Strategier | `GET /api/strategier?stadium=` · `GET /api/strategier/:slug` |
| Utvärderingar | `GET /api/utvarderingar?omdome=` · `GET /api/utvarderingar/:id` |
| Provhandel | `GET /api/provhandel?period=30d` · `GET /api/provhandel/affarer` · `POST /api/beslut` |
| Journal | `GET /api/journal?filter=` · `POST /api/journal/kommentar` · `GET|PATCH /api/lardomar` |
| System | `GET /api/system` · `PATCH /api/granser` |

**Realtid:** endast Arbetet och Provhandel öppnar SSE. Idag pollar `/api/idag` var 60:e sekund — startsidan får inte flimra. Dygnsbandet uppdateras med en mjuk övergång, aldrig med hopp.

**Kontraktskrav mot backend:** varje objekt som visas för användaren måste ha ett `label` (mänskligt) och ett `why` (en mening, max 200 tecken) som backend genererar. Frontend uppfinner aldrig motiveringar.

---

# 14. Vilka API-anrop som INTE längre behövs

| Endpoint | Varför den utgår |
|---|---|
| `GET /api/replay-queue` | Ersatt av `arbetet.capacity` |
| `GET /api/replay-queue/depth` | Ersatt av en procentsiffra |
| `GET /api/batch/:id/status` | Ersatt av `arbetet.tasks[].progress` |
| `GET /api/factory-director/state` | Uppgår i `/api/arbetet` |
| `GET /api/dna/:hash` | Interna identifierare visas inte |
| `GET /api/candidates?dnaHash=` | Ersatt av `/api/strategier` |
| `GET /api/library-runs/:libraryRunId` | Ersatt av `/api/utvarderingar/:id` |
| `GET /api/experiments/registry` | Ersatt av `/api/utvarderingar` |
| `GET /api/runtime/heartbeat` | Uppgår i `/api/system` |
| `GET /api/workers` | Visas inte |
| `GET /api/logs/stream` | Ersatt av lärdomar och journal |
| `GET /api/market/ohlc` | Idag behöver inte prisserier, bara ett klimatomdöme |
| `GET /api/settings` | Ersatt av `/api/granser` |
| `POST /api/candidates/:id/promote` | Ersatt av `POST /api/beslut` — **alla** användarbeslut går genom ett endpoint, så journalen aldrig kan få hål |

Nettoeffekt: från ~28 endpoints till 14, varav 7 är sid-anrop.

---

# 15. Vilka tekniska ord som göms från användaren

Översättningen bor i **`lib/vocabulary.ts`** och är enkelriktad. Interna ord får aldrig nå DOM.

| Internt | I gränssnittet |
|---|---|
| Replay | Test mot historik |
| Replay Queue | *(visas inte — blir "Klart om 6 min")* |
| Batch | Uppgift |
| Batch job | Uppgift |
| DNA | Strategi |
| `candidateDnaHash` | *(visas aldrig)* |
| `libraryRunId` | *(visas aldrig)* |
| Candidate | Strategi under prövning |
| Runtime | Provhandel / Skarpt läge |
| Strategy Runtime | Läge |
| Factory Director | *(visas inte — blir pipelinen)* |
| Experiment Registry | Utvärderingar |
| Backtest | Utvärdering |
| Walk-forward | Perioder AI:n aldrig sett |
| Out-of-sample | Undanhållen period |
| Parameter sweep | Varianter av samma idé |
| Overfitting | Anpassad i efterhand |
| Look-ahead bias | Framtidsläckage → *"att AI:n råkar se morgondagen"* |
| Sharpe ratio | Avkastning per risk |
| Max drawdown | Största nedgång |
| CAGR | Per år, i snitt |
| Win rate | Andel vinstaffärer |
| Slippage | Glidning *(bara i underlagspanelen)* |
| Regime | Marknadsklimat |
| Volatility | Rörlighet |
| Drift detection | Beter sig inte som i testet |
| Promotion | Släpps in i provhandel |
| Kill switch | Stoppa strategin |
| Paper trading | Provhandel |
| Live trading | Skarpt läge |
| Worker / node / pod | *(visas aldrig)* |
| Model confidence | AI:ns tillit |

**Regel:** ett internt ord får förekomma i UI endast i en fördjupningspanel, endast en gång, och endast direkt efter sin svenska motsvarighet. Exempel: "avkastning per risk (Sharpe) 1,62". Aldrig i en rubrik, aldrig i en knapp, aldrig i en kolumnhuvud.

---

# 16. Vilka UX-principer som används

1. **Progressiv avslöjning i exakt tre lager.** Omdöme → motivering → underlag. Aldrig fyra. Lager 1 är sidan, lager 2 är drawern, lager 3 är exporten.
2. **Systemet ska bevisa att det arbetar, inte påstå det.** Dygnsbandet, pulsen och tidsstämplarna är produktens trovärdighetsapparat.
3. **En sida = en fråga.** Kan en sida inte sammanfattas i en fråga ska den delas eller tas bort.
4. **Endast en primärhandling per vy.** Guld används sparsamt just för att det ska betyda något.
5. **Tre val, aldrig två.** Varje beslut har alltid ett "gör inget än". Ett gränssnitt som tvingar fram binära beslut producerar dåliga ja.
6. **Färg är aldrig ensam informationsbärare.** Statusen står alltid också i ord.
7. **Frånvaro av larm är också information.** "Ingenting väntar på dig" skrivs ut, som ett besked.
8. **Ingen modal för rutinåtgärder.** Toast med "Ångra" i 8 sekunder istället. Modaler avbryter en övervakare som inte behöver avbrytas.
9. **Tal är alltid tabulära.** Kolumner får inte hoppa när siffror uppdateras — annars ser produkten nervös ut.
10. **Journalen är oföränderlig.** Förtroende för en autonom AI kräver en logg som inte kan skrivas om.
11. **Obekväma siffror visas frivilligt.** Sämsta perioden, avvisade förslag som visade sig bra. En produkt som bara visar sina segrar tappar sin användares omdöme.
12. **Kvalitetsgolv utan att skryta om det.** Synlig tangentbordsfokus, Escape stänger, `prefers-reduced-motion` respekteras, allt användbart ner till 380 px.

---

# 17. Hur användarens arbetsflöde ser ut från morgon till kväll

**07:10 — Frukost, telefon (~40 sekunder)**
Öppnar Idag. Läser meningen: "AI:n arbetar. Två saker väntar på dig." Ögat går till Dygnsbandet och ser nattens täta turkosa fält, det höga guldstrecket vid 06:14, och det enda nedåtriktade röda vid 11:47 — nej, det är från igår. Läser rubrikerna på de två korten. Bestämmer sig för att titta närmare senare. Stänger.

**08:45 — Vid datorn (~4 minuter)**
Öppnar förslaget om Nordisk Momentum. Klickar "Visa underlaget". Drawern visar prövningen i tre steg och — avgörande — rubriken **"Det här talar emot"**: strategin gör 26 affärer i månaden av användarens gräns på 40. Hen väger, godkänner. Toast: "Provhandel godkänd. Ångra." Strategin flyttar sig till stadium 4.

**08:52 — Avvikelsen (~6 minuter)**
Öppnar Volatilitetsskörd-kortet, klickar "Se vad som ändrats". Två mätare glider isär, en är normal. Läser AI:ns tolkning: rörligheten har fallit under nivån strategin byggdes för, liknar sommaren 2019. Väljer "Håll pausen tills rörligheten stiger — AI:n återupptar automatiskt". Idag är nu tomt. Rubriken byts till "AI:n arbetar. Ingenting väntar på dig."

**11:00 — Nyfikenhet (~90 sekunder)**
Klickar Arbetet. Ser pipelinen, läser en rad: "Utbrott Norden — prövar mot nedgångsperioder, klart om 22 min." Stänger. Ingen handling.

**14:30 — Kontroll (~2 minuter)**
Provhandel. Ser +4,7 %, tre gröna "Stämmer med test", en röd som nu är pausad enligt hens eget beslut. Läser att Sektorbalans har 30 dagar kvar till skarpt läge. Stänger.

**17:00 — Ingenting**
Ingen inloggning. Systempillret är grönt. Det är produktens mest värdefulla ögonblick: den kräver ingen uppmärksamhet.

**21:15 — Reflektion, söndagsvana (~5 minuter)**
Journal. Läser dagens fyra poster i kronologi. Ser raden "Avvisade som senare visade sig bra: 2". Klickar in, läser de två fallen, skriver en kommentar på det ena: "Jag var för försiktig med små positionsstorlekar." AI:n sparar det som en lärdom.

**Total aktiv tid: cirka 19 minuter.** Det är måttet produkten optimerar mot. Om siffran växer har designen misslyckats.

---

# 18. Vilka förbättringar som skulle kunna göras i Version 2

**Förtroende och förklaring**

1. **Motfrågan.** En knapp "Vad skulle få dig att ändra dig?" på varje AI-förslag. AI:n svarar med de tre observationer som skulle vända dess rekommendation. Ingenting bygger förtroende för en autonom part som att den kan beskriva sitt eget felläge.
2. **Kontrafaktisk journal.** "Om du hade godkänt allt AI:n föreslog de senaste 12 månaderna hade resultatet blivit +X %." Både bekvämt och obekvämt — och exakt det en övervakare behöver för att kalibrera sitt eget omdöme.
3. **Tillitshistorik.** Visa hur AI:ns tillit till en strategi förändrats över tid som en linje, inte som ett aktuellt värde.

**Automatisering med grind**

4. **Delegeringsgrader.** Användaren sätter en gräns: "Godkänn provhandel automatiskt när tilliten är hög och affärerna understiger 20 per månad." Produkten rör sig då från *övervakning* mot *förvaltning* — men bara i den takt användaren väljer.
5. **Skarpt läge med rampning.** Kapital släpps in i steg om 10 % med automatisk återgång vid avvikelse.

**Överblick**

6. **Portföljvy.** Idag saknas frågan "hur samspelar mina strategier?" Version 2 behöver en korrelationsvy — men uttryckt som "Tre av dina fyra strategier tjänar pengar på samma sak", inte som en korrelationsmatris.
7. **Veckobrev.** En genererad sammanfattning måndag morgon, läsbar i mejl utan att öppna produkten. För en produkt vars mål är att kräva lite uppmärksamhet är e-post rätt gränssnitt.

**Hantverk**

8. **Kommandopalett** (`⌘K`) när det finns tillräckligt många strategier att söka bland. För tidigt i 1.0.
9. **Ljust läge.** Bläckblå bakgrund är rätt för övervakning men fel i solljus på en telefon.
10. **Ljud, sparsamt.** En enda ton när något går från "AI:n arbetar" till "något väntar på dig". Ingen annan ljudhändelse.
11. **Anteckningar direkt på Dygnsbandet.** Låt användaren markera en punkt i tiden med en kommentar — bandet blir då ett delat minne mellan människa och AI, inte bara en avläsning.

---

## Implementationsordning för Codex

1. `styles/tokens.css` + `styles/base.css` — hela paletten och typskalan ur avsnittet Designgrunden.
2. `components/ui/*` — de tolv primitiverna. Bygg mot mockupens CSS-klasser, klass för klass.
3. `components/shell/*` + `app/(app)/layout.tsx` — skalet med sidebar, topbar, drawer-host.
4. `lib/vocabulary.ts`, `lib/format.ts`, `lib/stage.ts` — innan någon sida byggs, så att inget internt ord hinner läcka in.
5. `GET /api/idag` + sidan Idag inklusive `DayBand` och `DecisionCard`.
6. Övriga sex sidor i ordningen Arbetet → Provhandel → Strategier → Utvärderingar → Journal → System.
7. Redirects enligt sektion 10.
8. Avveckla endpoints enligt sektion 14 först när alla sidor är i produktion.

Mockupen (`meridian-mockup.html`) är normativ för färg, spacing, typografi och interaktionsmönster. Där rapport och mockup skiljer sig gäller mockupen för utseende och rapporten för struktur.
