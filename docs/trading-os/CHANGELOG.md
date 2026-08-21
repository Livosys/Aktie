# Changelog

## 2026-08-19

- Unified native futures strategy identity with canonical paper approval.
- Enabled all canonical paper strategies that are both technically ready and
  compatible with the active paper policy; the short-only incompatible strategy
  remains disabled.
- Replaced the paper-only global one-position gate with bounded MNQ/MES
  multi-trade concurrency and same-root duplicate protection.
- Added a restart-safe 100-entry futures trading-day cap.
- Added paper identity evidence to Strategy Library history and idempotent
  scheduler-driven paper learning sync.
- Kept live trading disabled and unchanged.
- Audited all 33 canonical strategies and found no additional safe
  READY_NOW activation.
- Documented producer coverage, wrong-market rows, intentional blocks and
  legacy duplicates.
- Audited the first shared producer candidate group (`low_volatility_breakout`,
  `volume_spike_momentum`) and stopped before implementation because no verified
  runtime producer or equivalent entry semantics exist.
- Completed the semantics audit for both candidates. Catalog rules and generic
  Pine pseudo-mappings were insufficient to define a safe Futures producer, so
  no producer, entry contract, approval, or Paper activation was changed.
- Added read-only versioned research specifications for
  `low_volatility_breakout` and `volume_spike_momentum`; unresolved parameters
  remain explicit and no research work is scheduled before executable identity
  and sufficient historical evidence exist.
# 2026-08-19

## IBKR historical market-data foundation

- Added a read-only dataset manifest over the canonical IB raw and derived
  candle stores.
- Included IB raw dates in the market-data availability index.
- Preserved contract keys on newly persisted current and derived Futures bars.
- Corrected IB historical UTC end-time formatting for controlled requests.
- Verified local MNQ/MES quality and stopped before multi-year backfill because
  expired 2025 contract definitions returned IB error 200.
- Verified `includeExpired=true` propagation for expired contractDetails and
  historical requests.
- Resolved and probed MNQZ5/MESZ5 plus MNQH6/MESH6 through the active Paper
  Gateway without persisting data.
- Confirmed remaining error-200 responses for older/unavailable 2025 and 2024
  contract definitions.
- Stopped the temporary two-root backfill acceptance before persistence after
  the existing UTC-midnight `1 D` request returned an incomplete session slice;
  no validation bypass was added.
- Added the canonical 17:00-17:00 America/Chicago historical request window
  with DST-aware UTC conversion and `useRth=0` Globex requests.
- Updated strict completeness validation and dataset manifest indexing to use
  canonical trading days and exclude only expected market-closed intervals.
- Verified MNQZ5 and MESZ5 single-day probes with 1,380 1m bars each, plus a
  temporary resumable two-contract persistence/deduplication acceptance.
- Added planner rejection for trading-day windows beginning after a Futures
  contract's expiry boundary.
- Added the canonical contract provenance gate and readiness states.
- Added contract-partitioned raw/2m persistence and contract-aware dedup so
  overlapping contracts cannot overwrite or collapse one another.
- Added exact-contract Historical PriceFeed reads and an explicit block for
  ambiguous root-only reads.
- Added exact provenance to new current-capture bars/candles; legacy rows
  remain readable as `manifest_only` without guessed metadata.
- Left continuous research roll policy unresolved and did not run a full
  historical backfill.
- Ran controlled full contract-specific IBKR backfill run
  `ib-controlled-full-20260819-v3` for the eight verified `BACKFILL_READY`
  contracts.
- Persisted 436 complete contract-day segments, 601,680 raw 1m bars, and
  300,840 deterministic 2m candles; 28 holiday/reduced-session segments were
  retained as permanent validation failures.
- Corrected planner date enumeration to exclude Friday and Saturday labels
  that cannot represent complete CME Globex trading days.
- Verified checkpoint resume, contract-aware deduplication, exact provenance,
  and Historical PriceFeed exact-contract reads after the full run.
- Classified the resulting approximately eleven-month dataset as useful but
  insufficient for independent out-of-sample validation. Continuous research
  stitching and research-strategy activation remain blocked.

## AI Factory Historical Research, cycle 1 attempt (2026-08-19)

- Verified both research specifications against the canonical dataset. Neither
  strategy has a resolved research variable: `low_volatility_breakout` reports
  0 of 14 resolved, `volume_spike_momentum` 0 of 16. Every variable is
  `RESEARCH_REQUIRED`.
- Verified that neither concept has an executable evaluator. The native futures
  registry exposes 29 evaluators, all descended from the eight migrated
  modules; `nativeStrategiesForOrigin` returns zero for both research
  strategies. The Native Replay Engine can only execute registry evaluators.
- Stopped before generating experiments. Producing historical evidence would
  have required inventing strategy semantics and building a runtime producer,
  both of which are out of scope and stop conditions.
- Confirmed no silent continuous-contract stitching: Historical PriceFeed
  returns `dataQuality: 'ambiguous'` with `ambiguous_contract_ownership` when a
  root-level read spans more than one contract, and exact single-contract reads
  succeed across Z5, H6, M6, and U6.
- Recorded a dataset access asymmetry: `loadRawBars` reads the root directory
  in addition to the contract directories when no `contractKey` is supplied.
  MNQ and MES each have 218 contract-partitioned days plus 13 root-level days,
  four of which (2026-08-07, -14, -18, -19) have no contract-partitioned
  counterpart. Root-level reads therefore see 222 complete shared days while
  contract-specific reads see 218.
- Recorded that no futures spread source exists. Raw bars carry
  `ts, open, high, low, close, volume, tradeCount, source, conId, localSymbol,
  expiry` and no bid/ask/spread field. The `spreadMeasure` dimension of
  `volume_spike_momentum` is BLOCKED.
- Corrected `strategyResearchSpecificationService` coverage reporting, which
  still claimed 13 calendar dates and 9 complete trading days. Coverage,
  out-of-sample availability, and multi-year span are now computed from the
  store instead of hardcoded.
- Corrected the AI Memory availability probe, which tested for a
  `checkBeforeRun` method that has never existed on `aiMemoryService` and
  therefore always reported `memoryAvailable: false`.
- Added `AI_MEMORY_EVENTS_FILE`, matching the existing overrides for the
  strategy library and family tree. Without it a sandboxed run writes
  experiment identities into the production memory log.
- Root-caused three replay framework failures to policy drift rather than an
  engine defect. Paper policy is one position per allowlisted root with
  `maxOpenPositions: 2`, not a single global position. The tests asserted the
  superseded single-position rule and now assert per-root exclusivity plus the
  configured cap, read from `ibPaperExecutionConfigService`.
- No experiments were executed, no strategy lifecycle changed, and no strategy
  was activated. Both remain `RESEARCH_SPECIFIED`, `executable=false`,
  `runtimeEligible=false`.

## 2026-08-20 — AI Memory reconciliation + Executable Research Hypothesis

**AI Memory incident, closed.** The 472 events / 93 experiments written into
production `data/ai-memory/experiments.jsonl` on 2026-08-19 (07:17–09:55) by
chain-verification runs are inventoried, classified and excluded — not deleted.
Root cause: `aiMemoryService` had no env override, so a replay child process
built its recorder with the default memory even while Strategy Library and the
family tree were redirected. `AI_MEMORY_EVENTS_FILE` now exists and is tested
through a real child process.

Also disclosed from the same runs: 10 events appended to
`data/learning-connector/events.jsonl` and 2 run directories under
`data/replay/runs/`. Nothing was deleted.

**New:** `EXPERIMENT_EXCLUDED` in AI Memory with a closed reason set, and
`validForLearning` as the single definition of what counts as knowledge. An
excluded experiment can no longer block a legitimate run through duplicate
protection.

**New:** `researchHypothesisService` (lifecycle, gates, hypothesis identity,
source marking), `researchHypothesisEvaluatorService` (one research-only
evaluator driven by a hypothesis profile) and `researchDatasetBoundaryService`
(exact-contract boundary, contract-adjusted split, trading-day window).

**Fixed — exact-contract replay was completely non-functional.** Two defects,
both found by running the mandated `exact_contract` path for the first time:

1. `nativeFuturesSignalContract.expiryIsValid` read the first eight characters
   of the expiry. The contract-partitioned backfill writes ISO dates
   (`2026-09-18`); the legacy root capture writes IB's `20260918`. Every signal
   on contract-partitioned data was rejected as `contract_expired_or_invalid`.
2. `historicalPriceFeedService.getBarsBetween` scanned only the files named by
   the calendar range, while contract files are partitioned by CME trading day.
   Every entry returned `no_bars_after_order`.

Together these meant the entire 218-day contract-partitioned store — the point
of the IBKR backfill — could not produce a single replay trade. Root-level
reading masked it.

**Registry:** `listStrategyEvaluators` / `listNativeStrategies` gained
`includeResearch` (off by default) and `includeBase` (on by default). The paper
path calls with no flags and is unchanged: eight modules, no research.

## 2026-08-20 — AI Factory Historical Research Cycle 2

Smal cykel, grundad på cykel 1:s mätningar i stället för på bredare sökning.
Tio hypoteser (H1xx), samma exact-contract-gräns och samma kontraktsjusterade
split. Ingen grid search.

**Cykel 1:s identiteter frystes.** Att lägga till cykel 2 gav semantikobjektet
nya fält, vilket ändrade varje cykel-1-hash — och därmed hade cykel 1:s redan
bokförda experiment blivit oigenkännliga för AI Memory. Nya fält skrivs nu bara
ut när de bär ett värde, och `researchHypothesis.acceptance.test.js` låser alla
tolv cykel-1-hasharna med hårdkodade tal så att glidningen inte kan återkomma.

**Nytt:** forskningscykel som filter (`researchCycle`), tre nya
breakout-kvalificeringar, volymbekräftelse som avstängbar (`volumeRule: none`),
och en pullback-baserad entrymodell som är en signalregel — inte en ordertyp och
inte en ändring i motorn eller i Broker Risk.

**Rättat:** volymkontrollen låg före breakout-kontrollen. Båda krävs, så inget
utfall ändrades, men en bar som aldrig bröt sitt intervall rapporterades som
"volymen saknades" — och det var den siffran cykel 1:s trattanalys läste.

**Resultat:** ingen kandidat överlevde. Fem pre-deklarerade VSM-kandidater, alla
nettonegativa på valideringen. Fem LVB-hypoteser, samtliga med PF under 1 på
research. Ingen strategi befordrad, ingen Paper-aktivering.

## 2026-08-20 — Backfill av netPnlUsd för cykel 1 och 2

44 periodposter (`REPLAY_COST_BACKFILLED`) skrivna, en per hypotes och period.
Källa: originalkörningarnas egna utdata från `summarizeTrades`. **Ingen replay
kördes om.** De 16 169 ursprungliga biblioteksraderna är byte-identiska; nya
rader lades till efter dem. Skriptet är idempotent — en period som redan har en
backfill får ingen till.

**Upplösningen är period, inte dygn, och det är inte ett val.** Courtaget är
exakt rekonstruerbart (2,44 USD per round trip, identiskt MNQ/MES ur
`futuresContractCatalogService`), men exekveringskostnaden per dygn finns inte
bevarad i något artefakt. Enligt regeln skrevs därför inget uppskattat
dygnsvärde. Policyn behöver bara periodsumman, så upplösningen är tillräcklig —
och `netResolution` står i svaret så ingen läsare kan tro annat.

De 3 353 per-dygnsraderna för cykel 1 och 2 saknar fortfarande `netPnlUsd` och
kommer att fortsätta göra det. Ledgern faller tillbaka på periodposten och
märker källan `period_backfill`.

**Tre defekter som backfillen exponerade:**

1. **Ledgern blandade timeframes.** Cykel 1:s första research-pass körde H006 på
   2m trots att hypotesen deklarerar 5m, och de raderna summerades ihop med de
   riktiga. `timeframe` bokförs nu på `REPLAY_RECORDED` — värdet fanns redan i
   körningens konfiguration — och ledgern filtrerar på det när båda sidor är
   kända.
2. **Uteslutningar filtrerades på runId ensamt.** En körning omfattar samtliga
   hypoteser i passet, så filtret tog bort hela passet för alla. Nyckeln är nu
   paret strategi och körning.
3. **AI Memory lästes bara via `libraryRef`**, som per konstruktion pekar ut den
   FÖRSTA körningen. Härkomsten bär varje observation, och det är den som ska
   läsas.

**Kvarstående, och det går inte att lösa i efterhand:** experimentnyckeln bär
hypotesens *deklarerade* timeframe, inte den som faktiskt kördes. 37 uteslutna
H006-experiment delar därför identitet mellan 2m- och 5m-passet, och AI Memory
kan inte skilja dem åt. Den biblioteksbaserade klassificeringen av
`volume_spike_momentum__H006` ger därför `INSUFFICIENT_EVIDENCE` i stället för
`REJECTED_BY_HISTORICAL_EVIDENCE`. Den auktoritativa klassificeringen — ur
originalkörningarnas aggregat — är oförändrad och fryst i
`cycle12Evidence.fixture.json`.

## 2026-08-20 — AI Memory experiment identity v2 (executedTimeframe)

`ai-memory-v1` saknade timeframe. Följden var osynlig tills den inte var det:
cykel 1 körde två hypoteser som deklarerar 5m på 2m av misstag, och eftersom
timeframe inte ingick i nyckeln fick den felaktiga och den riktiga körningen
**samma experimentidentitet**. 37 experiment spänner över båda passen.

`ai-memory-v2` lägger till två fält som svarar på olika frågor:

- `declaredTimeframe` — vad hypotesen säger sig kräva
- `executedTimeframe` — vad replay **faktiskt** stegade i, hämtat ur
  `runResult.config.timeframe` och aldrig ur strategins metadata

Båda behövs. Med bara den deklarerade hade felet varit lika osynligt: det var
just skillnaden mellan dem som var felet.

**Versionen härleds ur specen.** En spec som bär `executedTimeframe` är v2, en
utan är v1. Äldre anropare — optimeraren bygger sina specar utan timeframe —
fortsätter därför fungera oförändrat i stället för att kasta, medan skrivvägen
(Strategy Library-recordern) alltid lämnar uppgiften och alltså alltid skriver
v2. `getStatus().byIdentityVersion` gör en tyst tillbakagång synlig.

**v2 faller aldrig tillbaka på v1.** En v1-post vet inte vilken timeframe den
kördes i och kan därför inte besvara en fråga om den. Att låta en v2-uppslagning
träffa en v1-post hade blandat 2m och 5m igen — hela anledningen till att v2
finns. Konsekvensen är att cykel 1 och 2:s kunskap inte uppfyller ett
v2-dubblettskydd. Det är rätt: den kunskapen **är** tvetydig i den dimensionen.

**H006:s kontamination repareras inte.** Den dokumenteras här och lämnas i
loggen. Att skriva om historiken för att göra den entydig hade varit att hitta
på ett förflutet som inte inträffade. Alla 3 825 befintliga
`EXPERIMENT_RECORDED`-händelser räknas fortfarande om till exakt sina lagrade
nycklar; ingen rad ändrades.

En post utan versionsfält **är** v1 — frånvaron är svaret, och projektionen
härleder det i stället för att historiken skrivs om för att bli
självbeskrivande.

## 2026-08-20 — Optimeraren kopplad till AI Memory v2

Optimeraren byggde alltid v1-identiteter, och det var inte ett val:
`normalizeContext` vitlistade en fast uppsättning fält och timeframe fanns inte
bland dem. Genomsläppet längre ned var därför **död kod** — ingen anropare kunde
nå v2 hur kontexten än fylldes. Följden hade varit att evolutionens experiment
inte skilde 2m från 5m, alltså exakt det fel v2 stänger, en nivå upp.

**En definition, tre läsare.** `replaySchedulerService.resolveJobTimeframe`
äger nu frågan "vilken timeframe kommer jobbet att köras i". Uttrycket stod
tidigare på tre ställen — två i `replayQueueRunnerService` och ett i
schemaläggaren — och tre kopior av samma regel är hur två delar av ett system
börjar köra i olika timeframes utan att någon märker det.

**Motorns förval hör hemma vid exekveringen, inte vid förslaget.**
`resolveJobTimeframe` returnerar `null` när ingenting anger en timeframe;
`2m` läggs på först i `replayQueueRunnerService` när jobbet faktiskt körs. Ett
förval som slår till vid exekvering är inte kunskap som finns vid
förslagstillfället, och att bokföra det som `executedTimeframe` hade varit att
hävda något ingen observerat. Den som inte vet får en v1-identitet.

`declaredTimeframe` är det enda fält som får komma ur strategins metadata — det
är vad fältet betyder. `executedTimeframe` kommer alltid ur körkonfigurationen.

## 2026-08-20 — Determinismtesterna väljer ett stängt dygn

`findCompleteDay` ger det nyaste dygnet med full täckning — och det är precis
det dygn den löpande IB-infångningen fortfarande skriver till. Mätt 2026-08-20
skrevs fyra dygn (2026-08-17 till -20) om inom samma sekund, medan alla äldre
dygn hade legat orörda i drygt femton timmar. Att bara hoppa över det nyaste
hade alltså inte räckt.

Två tester kör motorn två gånger och jämför utfallen. När lagret ändras mellan
körningarna blir svaret olika, och testet rapporterar då MOTORN som
icke-deterministisk fast det var indata som rörde sig — observerat 2026-08-20
med 245 signaler i den ena körningen och 244 i den andra.

**Nytt:** `marketDataStore.lastModifiedMs` och
`marketDataCoverage.findClosedCompleteDay`. Ett dygn räknas som stängt när
lagret legat stilla om det i minst en timme — sextio gånger den längsta uppmätta
körningen av testet, och en gräns som rent skiljer de aktivt infångade dygnen
(noll timmar) från alla andra.

`listCompleteDays` fick också `fromUtcTime`, av som standard. Utan den godkändes
söndagen 2026-08-16: sessionen öppnar 22:00 och den kontraktspartitionerade
filen sträcker sig in i måndagen, så dygnet ser komplett ut — men mellan 13:00
och 17:00 den söndagen finns ingenting att replaya.

**Inte åtgärdat, och medvetet så:** `priceFeedParity.goldenMaster` läser också
samma dygn två gånger, men ett stängt dygn löser inte det testet. Det faller på
VARJE äldre dygn, vid 06:00 och inte i fönstrets kanter. Skillnaden är att den
kontraktspartitionerade backfillen slutar 2026-08-17: för de nyaste dygnen läses
bara rotfilen och vägarna är eniga, medan ett äldre dygn läses sammanslaget
root + kontrakt och då skiljer sig utfallet. Det är inte dagvalet som är fel
utan hur historiken slår ihop två källor för samma dygn — en kanonisk
datapolicyfråga som inte ska avgöras i en testrad.

## 2026-08-20 — Replay-kön väljer stängda dygn med data i fönstret

`nativeWindowForJob` valde dygn med `listCompleteDays` utan krav på att lagret
slutat skriva till dem. Replayar kön ett sådant dygn bokförs evidens på data som
fortfarande växer — resultatet blir inte fel på ett synligt sätt, det blir ett
riktigt utseende resultat räknat på halva dagen, och det skrivs in i Strategy
Library som om det vore hela. Nästa körning av samma dygn hade gett ett annat
svar, och AI Memory hade sett två oense observationer av ett experiment.

Tystnadskravet ensamt räckte inte. Med de tre nyaste dygnen bortfiltrerade blev
nästa val söndagen 2026-08-16, vars fönster 13:00–17:00 är tomt.

**Det avslöjade något större.** Den kontraktspartitionerade backfillen
partitionerar på CME:s handelsdag, som börjar kvällen före: filen märkt D
innehåller D 22:00 till D+1 20:59. Köns fönster byggs på KALENDERdatumet D och
träffar därför ingenting. Mätt 2026-08-20: **212 av 222 kompletta dygn har noll
barer mellan 13:00 och 17:00 på sitt eget datum.** Kön har bara hunnit rotera
genom fem dygn — alla nyliga, alla med en rotfil på kalenderdatum — och därför
har det aldrig visat sig.

`coverageFor` räknar nu barer inom ett givet fönster (barerna är ändå laddade),
och `listCompleteDays` kan kräva ett minsta antal där. Fördelningen är binär —
ett dygn har antingen 0 eller hela fönstret på 240 minutbarer — så nivån bär
ingen vikt; den finns för att fånga ett genuint stympat dygn.

Kön ser nu 7 dygn i stället för 222. Det är ingen förlust av data utan en ärlig
räkning av hur många dygn den här fönsterlogiken kan köra. **Resten av lagret
nås genom handelsdagsmappningen som research-vägen redan använder**
(`researchDatasetBoundaryService.rthWindowFor`, etikett + 1 dygn) tillsammans med
kontraktsnycklar — att byta kön till den är en egen uppgift och görs inte här.

## 2026-08-20 — Replay-kön kör på handelsdagsmappningen

`nativeWindowForJob` byggde sitt fönster som `${dygn}T13:00–17:00` på ett
KALENDERdatum ur `listCompleteDays`. Historiken ligger inte så: den
kontraktspartitionerade backfillen partitionerar på CME:s handelsdag, som börjar
kvällen före, så filen märkt D innehåller D 22:00 till D+1 20:59. **212 av 222
kompletta dygn hade noll barer mellan 13:00 och 17:00 på sitt eget datum.**

Kön läser nu mappningen handelsdag → RTH-datum (etikett + 1) ur
`researchDatasetBoundaryService` — samma definition som research-vägen, inte en
andra uträkning som kan peka på ett annat dygn. Mätt över hela lagret lägger
218 av 218 filer sitt fönster på etikett + 1, med 240 minutbarer i varje.

| | före | efter |
|---|---|---|
| valbara dygn | 7 | **217** |
| dygnsval | 5,6 s | **0,29 s** |
| dataAccessMode | sammanslagen rotläsning | **exact_contract** |

**Kontraktsnycklarna följer med till motorn.** Dygnen kommer ur
kontraktskatalogen, så körningen måste läsa den katalogen; utan
`contractKeyByRoot` faller motorn tillbaka på rotläsningen och kan få
`ambiguous_contract_ownership` — noll barer, och ett tomt resultat som ser ut som
en marknad utan signaler.

Tre grindar behållna eller tillagda, alla mot samma sorts tysta fel:

- dygnet måste ligga stilla (tystnaden mäts på både rot- och kontraktsfil)
- båda rötterna måste ha ett kontrakt för dygnet — hälften av en marknad är
  inte en marknad
- fönstret måste innehålla barer, läst med samma kontraktsnyckel som motorn
  använder. Kontrollen görs på det dygn som ska köras och inte på alla 218: att
  läsa fönstret kostar en filläsning per rot, och mätningen säger att grinden
  aldrig utlöser — men ett tomt fönster som bokförs är precis felet ovan.

`dataStore` och `feedService` är nu injicerbara i kön, av samma skäl som
`boundaryService`: dygnsvalet ställer frågor till lagret och feeden, och de måste
gå att besvara utan riktiga filer i ett test.

Verifierat end-to-end: handelsdag 2026-08-16 → RTH 2026-08-17, 548 signaler,
28 affärer, noll kontraktsavvisningar.

## 2026-08-20 — Handelsdagslogiken flyttad till src/data

`researchDatasetBoundaryService` ägde två sorters kunskap: **fakta om lagret**
(vilka handelsdagar som finns, vilket kontrakt som äger dem, vilket
kalenderfönster de motsvarar) och ett **metodval** (hur historiken delas i
research och validation). Bara det andra är research.

Skillnaden blev praktisk när replay-kön behövde samma mappning: en produktionsväg
importerade en modul kallad "research". Att duplicera mappningen hade varit
värre — två uträkningar av samma sak pekar förr eller senare på olika dygn.

**Nytt:** `src/data/tradingDayCalendar.js` med `sharedDays`, `listContracts`,
`contractKeyForDay`, `contractKeyByRootForDay`, `rthDateFor`, `rthWindowFor`,
`describeCalendar` och `RTH_WINDOW`.

`researchDatasetBoundaryService` gick från 232 till 135 rader och äger nu bara
`buildSplit` och `describeBoundary` — den senare lägger research-lagrets
märkning på kalenderns beskrivning i stället för att räkna om talen.

Ren refaktorering, ingen beteendeändring. Verifierat före och efter:
`sharedDays`, `rthWindowFor` och `contractKeyByRootForDay` ger identiska svar;
splitten är oförändrad (119 research / 99 validation, noll dygns- och
kontraktsöverlapp); cykel 1 och 2:s klassificering står still på 19 förkastade
och 3 otillräckliga; kön väljer samma dygn (handelsdag 2026-08-16 → RTH
2026-08-17) bland samma 217.

Ett acceptanstest låser gränsen: primitiverna ska finnas i kalendern och INTE i
research-modulen, och replay-kön får inte importera research.

## 2026-08-20 — Nettofrågan besvarad: evidenspolicy v2

`thresholdsStatus` har stått på `approved` sedan v1, men en fråga var öppen i
fyra faser: nettokravet gäller båda perioderna, och med fast courtage på 2,44
USD per affär kräver det i praktiken en betydligt högre bruttoedge av en frekvent
hypotes än av en selektiv.

Cykel 1 och 2 visade vad v1 kostade. **Sju hypoteser hade profit factor över 1 i
BÅDA perioderna** — signalen bar alltså både in-sample och out-of-sample — men
negativt netto. Alla sju kallades förkastade, och därmed slängdes slutsatsen
"den här signalen har edge, kostnaden bär den inte" bort tillsammans med
hypotesen. Det är två olika svar som leder till olika arbete: det ena "sök
vidare", det andra "angrip kostnaden". Cykel 2 bevisade att den andra vägen är
verklig — pullback-entryn sänkte exekveringskostnaden från 5,44 till 1,69 USD
per affär.

**v2 ändrar inte vad som får befordras.** Nettokravet står kvar oförändrat bland
teckentesten; en hypotes som förlorar pengar blir aldrig kandidat. Det som ändras
är vad ett misslyckande KALLAS när bruttoedgen håller i båda perioderna:
`INSUFFICIENT_EVIDENCE` med skälet `gross_edge_holds_but_costs_are_not_carried`
i stället för `REJECTED_BY_HISTORICAL_EVIDENCE`.

v1 finns kvar och `classify` tar `policyVersion`. Cykel 1 och 2:s domar
avkunnades under v1 och räknas inte om — att göra det hade varit att ändra ett
protokoll. Under v2 blir samma material 12 förkastade och 10 otillräckliga,
fortfarande **noll kandidater**.

## 2026-08-20 — Flera samtidiga paper-trades

Mätt 2026-08-19/20: **2 078 av 2 098 kandidater avvisades på
`max_open_broker_positions`**, 20 släpptes igenom. Tre grindar samverkade:

| grind | effekt |
|---|---|
| `quantity_exactly_one_micro` | 1 kontrakt per order |
| `maxOpenPositions`, hårdkapat till `HARD_MAX_ALLOWLIST.length` | 2 totalt |
| `same_root_open_paper_position` | aldrig två i samma instrument |

Resultatet var högst en MNQ och en MES — och i praktiken oftast bara en, eftersom
båda rötterna sällan signalerar samtidigt.

**Ändrat:** taket står nu för sig självt i `HARD_MAX_OPEN_POSITIONS = 4` i
stället för att härledas ur allowlistens längd. Hur många INSTRUMENT som är
tillåtna säger ingenting om hur många positioner kontot bör bära — det var fel
storhet. `same_root_open_paper_position` och `same_root_pending_paper_entry` är
borttagna.

**Oförändrat:** 1 kontrakt per order, stop loss obligatorisk, 100 entries/timme,
100 nya trades/dag, allowlist MNQ + MES, och live hårdkapat till 1 position.

**Varför det är säkert nu men inte i augusti.** Incidenten 2026-08-14 byggde 19
kontrakt på 18 minuter. Orsaken var inte taket utan att `getPositionCount`
räknade positionsRADER: IB:s `reqPositions` ger en rad per conId med signerad
nettokvantitet, så varje ny entry lade ett kontrakt på en befintlig rad utan att
radantalet steg. Räknaren summerar nu `|kvantitet|`, vilket är verifierat: en
enda rad med 4 kontrakt blockerar lika hårt som fyra rader, och taket gäller
totalen oavsett hur kontrakten fördelar sig mellan rötterna.

Scannern bar en egen kopia av taket (`const MAX_OPEN_POSITIONS = 2`). Den läser
nu konfigurationen — två kopior av samma gräns är hur ett system börjar
rapportera en siffra och tillämpa en annan.

## 2026-08-20 — Kanonisk läspolicy för historiken

Lagret innehåller samma barer i **två partitioneringsscheman**: rotkatalogen på
kalenderdygn (löpande IB-infångning, rader utan `contractKey`) och
kontraktskatalogen på CME:s handelsdag (kontrollerad backfill, rader med
`contractKey`, `tradingDay`, `session`, `provenanceQuality`).

Policyn, i tre meningar:

1. **`exact_contract` är kanoniskt.** All research och all replay läser med
   `contractKey`, och då läses bara den katalogen.
2. **Sammanslagen rotläsning är legacy.** Den returnerar unionen av två scheman
   och spänner därför över ~44 timmar för ett "dygn". Den får aldrig användas
   där reproducerbarhet spelar roll.
3. **Inom en sammanslagen läsning identifieras en bar av kontraktet plus
   tidsstämpeln**, och raden med exakt härkomst vinner.

Punkt 3 var trasig. `dedupeByTimestamp` nycklade på `contract:<key>|<ts>`
respektive `legacy:<ts>` — alltså på vilken KATALOG raden kom ur, inte på vilket
kontrakt den beskriver. Samma fysiska bar returnerades därför två gånger i två
olika fältformer med identiska priser. Mätt för MNQ 2026-08-17: **2 760 rader
där lagret innehåller 1 380 barer**, varav 120 tidsstämplar dubbla.

Nyckeln är nu `conId` (finns i båda formerna — tal i roten, sträng i
kontraktsfilen) plus tidsstämpel, och vid krock vinner raden med `contractKey`.
Utfall: 2 760 → 2 640 rader, noll dubbla tidsstämplar, exakt kontraktsläsning
oförändrad på 1 380.

**Kvarstår, och policyn är svaret:** `priceFeedParity.goldenMaster` jämför live-
och historikvägen på sammanslagen data och faller fortfarande på äldre dygn.
Det beror inte på dubbletter utan på att en sammanslagen läsning per definition
spänner över två scheman — vilket är exakt varför punkt 1 och 2 finns. Testet
mäter live-vägens paritet, och live har ingen kontraktspartitionering; att
flytta det till `exact_contract` hade ändrat vad det testar.

## 2026-08-20 — Fabriken rullar hela vägen

Verifierat end-to-end mot verklig biblioteks- och minnesdata, med isolerade
skrivningar: alla sex steg producerar, ingen hoppas över.

```
PLAN → SELECT_KNOWLEDGE_GAP → CREATE_DNA_GENERATION
     → SCHEDULE_REPLAY → EXECUTE_QUEUE → COMPLETE
```

**Ett steg stod still.** `CREATE_DNA_GENERATION` föll på `market_dna_required`
varje cykel, och evolutionen skapade därför aldrig ett enda nytt genom —
replayen kördes, men parameterrymden utforskades inte.

Orsaken är inbyggd i uppdraget: hjärnan pekar per definition ut den MINST kända
strategin, och den saknar oftast market DNA eftersom den aldrig körts.
Optimeraren kräver market DNA för att kunna bilda en experimentidentitet. Den
befintliga reservvägen läste `recommendations.optimize`, men hjärnan lämnade den
tom.

Reservvägen är nu hjärnans egen rangordning: högst rankade strategi som faktiskt
har market DNA (33 av 196 hade det). Deterministiskt, och det är fortfarande
hjärnan som prioriterar — orchestratorn väljer bara den bäst rankade av dem som
går att arbeta på. Listan är runtime-data, så hjärnan förblir generisk och
nämner fortfarande inget strateginamn.

Efter fixen: `parent=1d8e46bccb08edef created=1`, jobb schemalagt, replay körd på
2026-08-17 via handelsdagsmappningen, `memoryRecorded: true`.

## 2026-08-20 — Paper max 10 samtidiga trades

`HARD_MAX_OPEN_POSITIONS` 4 → **10**. Oförändrat: 1 kontrakt per entry, stop
loss obligatorisk, 100 entries/timme, 100 trades/dag, allowlist MNQ + MES, live
hårdkapat till 1.

**Att tio betyder tio hänger inte på taket utan på ägarskapet.** IB aggregerar:
tio MNQ-entries blir EN positionsrad med tio kontrakt. Varje logisk trade bär
sitt eget `executionId` i `orderRef` (`TOS-PAPER-<executionId>-<ben>`) på entry,
stop och target, och reconciliation matchar intent mot broker på **orderRef** —
aldrig på conId eller positionsrad. Det var precis D1-buggen 2026-08-14, där
entryfill nycklad på conId gav dagens första fill och därmed fel entry och fel
tecken på resultatet.

Verifierat i `futuresPaperTenConcurrent.acceptance.test.js`: tio logiska trades
på samma rot mot en aggregerad brokerrad ger **noll diskrepanser**, en saknad
trade syns ändå, och helt oskyddad exponering flaggas fortfarande.

**Två strypningar i schemaläggaren togs bort.** `tickLimit` satt i
`Math.min(2, ...)` — en kvarleva från när paper bar en position per rot — så
högst två inskickningar per tick kunde ske och tio kunde aldrig nås. Och roten
spärrades efter första kandidaten i ticken, med blockeraren
`same_symbol_pending_paper_entry` som inte längre finns i Broker Risk. Gränsen
är nu taket självt; exponeringen kontrolleras där den hör hemma, per order.

**Känd övervakningslucka, medvetet inte ändrad.** `unprotected_position` flaggar
bara när det finns positioner och NOLL aktiva stops. Med tio kontrakt och sju
stops är tre oskyddade utan att kontrollen säger något. Att jämföra kontrakt mot
stops i stället hade varit rätt mått — men varje diskrepans sätter
`degraded: true` och blockerar alla nya entries, och en kontroll som slår under
en normal övergång (entry fylld, stop inte placerad än) hade stoppat all handel.
Rätt fix är en observation med respit, inte en blockerande diskrepans.

## 2026-08-20 — AI Fabrikens loop i UI

Ny läsvy på `/factory/loop`, nådd från fabrikens startsida. **Ingen egen
menypost**: V1-menyn har en huvudväg per produktområde, och loopen tillhör
fabriksområdet — `navigation.test.js` upprätthåller det beslutet.

Nytt: `aiFactoryLoopStatusService` + `GET /api/factory/loop`. Tjänsten **räknar
ingenting eget** — den läser orchestratorns revisionsspår, AI Memory, Strategy
Library, replay-kön, evidenspolicyn och handelsdagskalendern och sätter ihop
dem. Varje siffra har en ägare någon annanstans.

**Factory Director anropas medvetet inte.** Den persisterar inget beslut utan
räknar om hela fabriksbeslutet vid varje anrop — mätt 13–15 sekunder, eftersom
den kör hjärnan över hela biblioteket. Nästa åtgärd härleds i stället ur
orchestratorns eget spår: 883 ms i stället för 14 220 ms, och den beskriver vad
som FAKTISKT hänt i stället för en ny beräkning.

Frontend är read-only och ritar bara svaret. Ett källtest förbjuder
policyuträkning, egen härledning av loopstatus och muterande anrop, och kräver
att okänt visas som tankstreck — inte som noll.

## 2026-08-20 — Ytterligare tre sandlådeläckage tätade

Verifieringen av fabrikens loop skrev i driftens filer trots att bibliotek,
minne och släktträd var omdirigerade. Tre tjänster saknade env-överstyrning:

| fil | omfattning | ny env |
|---|---|---|
| `data/replay-queue/events.jsonl` | ny fil, 6 händelser, 2 jobb (båda COMPLETED) | `REPLAY_QUEUE_EVENTS_FILE` |
| `data/ai-factory/orchestrator-events.jsonl` | ny fil, 120 händelser | `AI_FACTORY_ORCHESTRATOR_EVENTS_FILE` |
| `data/learning-connector/events.jsonl` | +2 rader | `LEARNING_CONNECTOR_DIR` |

Samma defektklass som AI Memory-läckan 2026-08-19: en tjänst utan env-väg skrivs
av barnprocessen med sin default. Strategy Library, AI Memory och släktträdet var
korrekt isolerade — deras mtime rördes inte. Inget raderat; kön står i terminalt
läge utan väntande jobb.

**Fjärde instansen av samma flakighet.** `fillEngineSignalIsolation` mäter
exekveringskostnad över sextio signaler och valde nyaste kompletta dygn — som
under den här sessionen blev 2026-08-20, dagen som just då fångades in.
Assertionen "den simulerade motorn ska kosta något" föll. Samma fix som i
determinismtesterna: `findClosedCompleteDay`.
