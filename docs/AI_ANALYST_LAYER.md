# AI Analyst Layer

AI Analyst Layer är ett förklaringslager ovanpå befintlig backend-data. Det ska
inte skapa egna trading-signaler, ändra regler, ändra thresholds eller skriva
orderliknande språk.

Nuvarande version är rule-based. Extern AI är avsiktligt inte inkopplad.

## Syfte

AI Analyst ska:

- förklara vad Decision Monitor ser.
- sammanfatta stöd och varningar på enkel svenska.
- bedöma om läget verkar tidigt eller sent.
- visa risker och saknad bekräftelse.
- jämföra mot historisk signal quality när data finns.
- föreslå vad som behöver förbättras härnäst.

## Backend-Service

Servicefil:

`src/ai/analystService.js`

Exporterade funktioner:

- `buildSignalAnalysisContext(candidate, qualityData, candles)`
- `generateRuleBasedAnalystSummary(context)`
- `optionallyGenerateAiSummary(context)`

`optionallyGenerateAiSummary` returnerar i dag rule-based output.

## Endpoint

`GET /api/ai/signal-analysis?symbol=ETHUSDT&timeframe=2m`

Endpointen:

- hittar aktuell candidate i Decision Monitor.
- hämtar signal quality-data.
- hämtar live 2m-candles när de finns.
- bygger analyst-context.
- returnerar rule-based analyst-output.

Om symbolen saknas i Decision Monitor returneras ett saknat-data-svar, inte en
AI-gissning.

## includeAi

`GET /api/live/decision-monitor?includeAi=1`

När `includeAi=1` läggs `analyst` till på varje candidate. Responsen får även:

```json
{
  "ai": {
    "mode": "rule_based",
    "label": "AI-läge: regelbaserad analys"
  }
}
```

## Analyst-Output

Analyst-output har denna form:

```json
{
  "verdict": "Titta manuellt | Bevaka | Vänta | Jaga inte | Kan inte bedöma",
  "confidence": 0,
  "summarySv": "",
  "whatSystemSees": [],
  "whatSupports": [],
  "whatWarns": [],
  "missingConfirmation": [],
  "historicalContextSv": "",
  "timingAssessmentSv": "",
  "riskAssessmentSv": "",
  "nextImprovementSv": "",
  "suggestedStatus": "",
  "currentStatusLooksReasonable": true,
  "actionLanguageSafe": true,
  "mode": "rule_based",
  "modeLabel": "AI-läge: regelbaserad analys"
}
```

## nextImprovementSv

`nextImprovementSv` är en kort svensk text som säger vad som främst saknas.

Exempel:

- `Behöver tydligare 2m-bekräftelse.`
- `Behöver rekyl närmare bra nivå.`
- `Behöver friskare dataflöde.`
- `Behöver mindre ryckig marknad.`
- `Behöver tydligare stöd från fler tidsramar.`

Fältet är avsett för UI och ska inte användas som ny signalregel.

## Context-Fält

Analyst-context får bara använda befintlig backend-data, till exempel:

- `status`
- `nextMoveBias`
- `confidenceScore`
- `agreementCount`
- `timeframeAgreement`
- `tf2m`
- `candleScore2m`
- `twoMinuteConflict`
- `hardBlockers`
- `softBlockers`
- `extensionLevel`
- `dataFreshness`
- `dataAgeSeconds`
- `marketType`
- `primaryReason`
- `signalFamily`
- signal quality-data
- live candles

Om data saknas ska analyst-output säga att data saknas eller ge en försiktig
bedömning. Den ska inte fylla i luckor med gissningar.

## Förbjudna Ord

Analyst-output saneras mot dessa uttryck:

- `köp`
- `sälj`
- `stark köp`
- `trade now`
- `guaranteed`
- `säker vinst`

Tillåtna alternativ:

- `titta manuellt`
- `bevaka`
- `vänta`
- `jaga inte`
- `kan inte bedöma`
- `bekräftelse saknas`

## Varför Extern AI Inte Är Inkopplad

Extern AI är avstängd i nuvarande analyst-lager för att:

- undvika att modellen hittar på signaler.
- hålla all output spårbar till backendfält.
- kunna testa språk, säkerhet och UI utan API-beroende.
- undvika att hemliga nycklar eller känslig runtime-data skickas ut.
- säkra förbjudna ord och fallback-beteende först.

När extern AI kopplas in senare ska den endast användas för text/sammanfattning,
inte för signalbeslut.

## Fallback-Beteende

Om extern AI saknas eller inte är konfigurerad:

- systemet returnerar rule-based analyst-output.
- frontend visar `AI-läge: regelbaserad analys`.
- inget error ska visas bara för att extern AI saknas.
- output ska fortfarande följa samma säkra schema.

## Hybrid Agent Layer v1

`src/ai/tradingAgentsService.js` är en lokal/mockad struktur inspirerad av
TradingAgents:

- Technical Agent
- News/Sentiment Agent
- Bull Agent
- Bear Agent
- Risk Agent
- Final Commentary Agent

Den körs utan externa API-anrop i v1 och returnerar JSON med:

```json
{
  "symbol": "TSLA",
  "direction": "UP",
  "technical_view": "...",
  "bull_case": "...",
  "bear_case": "...",
  "risk_notes": "...",
  "confidence_adjustment": -5,
  "final_commentary": "...",
  "should_block_trade": false
}
```

Agentlagret får endast påverka:

- förklarande text
- `confidence_adjustment`
- riskflagga
- optional block flag

Det får inte skapa egna BUY/SELL-beslut. Paper trading kör först befintliga
regelkontroller och Market Gate. Agentanalysen kan därefter läggas på trade-
metadata eller stoppa en redan godkänd kandidat via `should_block_trade`.

Senaste analys cacheas i Redis på:

- `agent:latest-analysis`
- `agent:analysis:<SYMBOL>`
- stream `agent:analysis-stream`

## Kända Begränsningar

- Historisk jämförelse är grov och bygger på tillgänglig signal quality-data.
- `signalFamily` är inte fullt införd för alla signaltyper.
- Rule-based text kan fortfarande ärva råa blockerartexter från backend.
- Analyst-output är beslutsstöd, inte en ordermotor.
