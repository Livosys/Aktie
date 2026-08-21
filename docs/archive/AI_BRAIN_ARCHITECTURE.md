# AI Brain Architecture

## Syfte

Detta dokument beskriver AI Brain för Trading OS.

AI Brain är en framtida styr- och kunskapsdel. Den ska hjälpa systemet att se vad som händer, analysera data, föreslå bättre strategier, hitta fel och skriva journal.

Detta är endast dokumentation. Det är inte kod, backend, frontend eller scheduler.

## Vision

Visionen är ett Trading OS där AI arbetar som ett lugnt och begränsat beslutsstöd.

AI Brain ska kunna:

- följa systemets data, strategier, loggar och resultat
- hitta mönster, risker och svagheter
- föreslå förbättringar i research och paper-läge
- skriva tydliga förklaringar på enkel svenska
- spara lärdomar i minne och journal
- skydda live trading, Interactive Brokers och trade-godkända strategier

AI Brain ska hjälpa människan. Den ska inte bli en fri handlare.

## Mål

AI Brain ska byggas för dessa mål:

- Ge bättre översikt över Trading OS.
- Upptäcka fel, gammal data och svaga flöden tidigare.
- Göra kontrollerad research på icke-godkända strategier.
- Förklara observationer och förslag med enkel svenska.
- Spara beslut, lärdomar och testresultat i journal och Knowledge Base.
- Kunna arbeta 24/7 via framtida scheduler eller autopilot.
- Hålla tydlig gräns mellan research, paper testing och live trading.

## Grundprincip

AI Brain får titta, analysera, föreslå och dokumentera.

AI Brain får inte placera order, aktivera live trading, styra broker eller själv godkänna strategier för handel med riktiga pengar.

Alla beslut som kan påverka riktiga pengar ska kräva manuell kontroll.

## AI-roller

### Observer

Observer ser vad som händer i systemet.

Observer läser tillåtna signaler, scanner-resultat, strategiresultat, journaler, systemstatus och felmeddelanden. Rollen ska samla läget och hitta saker som behöver granskas.

Exempel:

- En strategi ger många svaga signaler.
- En datakälla verkar sakna nya värden.
- Ett testresultat skiljer sig från tidigare resultat.
- Ett systemflöde har slutat uppdateras.

### Analyst

Analyst tolkar det Observer har hittat.

Analyst jämför resultat, risk, win rate, drawdown, trade count, signalstyrka och marknadsläge. Rollen ska hitta rimliga orsaker och visa vad som är viktigt.

Förklaringarna ska vara enkla, till exempel:

"Strategin tar för många trades när volymen är låg. Det kan göra resultatet svagare."

### Planner

Planner gör en försiktig plan för nästa steg.

Planner får föreslå tester, datakontroller, strategiändringar och research-spår. Rollen får inte ändra skyddade delar.

Planen ska visa:

- vad som ska testas
- varför det ska testas
- vilken data som behövs
- vilken risk som finns
- hur resultatet ska mätas

### Researcher

Researcher arbetar med strategiutveckling och research.

Researcher får undersöka icke-godkända strategier, skapa hypoteser, föreslå parameterändringar, jämföra testresultat och hitta nya idéer.

Researcher får bara arbeta i research, backtest eller paper-läge. Rollen får inte flytta en strategi till live trading.

### Reviewer

Reviewer granskar AI-förslag innan de betraktas som användbara.

Reviewer letar efter svaga antaganden, overfitting, för få trades, dataluckor, hög risk, oklar logik och resultat som verkar för bra.

Reviewer ska vara skeptisk. Om något är osäkert ska det markeras tydligt.

### Doctor

Doctor bevakar systemets hälsa.

Doctor tittar på fel, gammal data, trasiga jobb, lång svarstid, misslyckade tester, saknade loggar och andra systemproblem.

Doctor får föreslå åtgärder, men får inte själv starta om drift, deploya kod eller ändra broker-kopplingar.

### Librarian

Librarian ansvarar för AI Memory och Knowledge Base.

Librarian organiserar lärdomar, journaler, strategiresultat, beslut, varningar och förklaringar. Rollen ska hjälpa systemet att komma ihåg vad som har testats och varför ett beslut togs.

Librarian ska minska dubbelarbete. Om en strategi redan har testats och underkänts ska orsaken vara lätt att hitta.

### Loop Engine

Loop Engine driver AI Loop.

Loop Engine ser till att arbetet sker i rätt ordning:

observe -> analyze -> plan -> test -> learn -> improve -> journal -> repeat

Loop Engine får bara arbeta inom tillåtna gränser. Om en uppgift rör broker, live trading eller trade-godkända strategier ska loopen stoppa eller pausa.

### Supervisor

Supervisor är den högsta kontrollrollen inne i AI Brain.

Supervisor kontrollerar att alla andra roller följer reglerna. Rollen ska stoppa förslag som bryter mot safety-regler, försöker styra broker, försöker handla live eller försöker ändra skyddade strategier.

Supervisor ska alltid kunna säga nej.

## AI Loop

AI Brain arbetar i denna loop:

1. observe
2. analyze
3. plan
4. test
5. learn
6. improve
7. journal
8. repeat

Kort form:

observe -> analyze -> plan -> test -> learn -> improve -> journal -> repeat

### Observe

AI tittar på systemets läge.

AI samlar information från tillåtna källor, till exempel paper-resultat, research-resultat, loggar, strategiutkast och systemstatus.

### Analyze

AI försöker förstå vad informationen betyder.

AI letar efter svagheter, mönster, risker, fel och möjliga förbättringar.

### Plan

AI skapar en enkel plan för nästa test eller kontroll.

Planen ska visa vad som ska testas och hur resultatet ska bedömas.

### Test

AI får bara testa i tillåtna miljöer.

Tester ska vara paper-only, backtest eller annan skyddad research. Tester får inte placera order och får inte styra live broker-flöden.

### Learn

AI sammanfattar vad testet visade.

AI ska skilja mellan fakta, antaganden och osäkerhet.

### Improve

AI föreslår förbättringar.

För icke-godkända strategier kan AI föreslå nya regler, filter eller parametrar. För trade-godkända strategier får AI bara föreslå manuell granskning.

### Journal

AI skriver vad den gjorde, såg, lärde sig och föreslog.

Journalen ska vara tydlig, sparbar och enkel att läsa.

### Repeat

AI kan fortsätta loopen via framtida scheduler eller autopilot.

Varje ny loop ska börja med safety-kontroll.

## AI Memory / Knowledge Base

AI Memory är systemets längre minne.

Knowledge Base ska lagra:

- strategiidéer
- testresultat
- underkända hypoteser
- godkända slutsatser
- kända systemproblem
- viktiga beslut
- riskvarningar
- enkla användarförklaringar
- tidigare journalposter

Knowledge Base ska göra det lätt att se:

- vad som redan har testats
- vad som fungerade
- vad som inte fungerade
- varför ett beslut togs
- om en strategi är idea, research, paper_test, review, trade_approved, rejected eller archived

AI Memory får aldrig användas för att kringgå safety-regler.

## AI Journal

AI Journal är den löpande dagboken för AI Brain.

Varje viktig AI-händelse ska kunna journalföras:

- datum och tid
- vilken AI-roll som arbetade
- vilken strategi eller systemdel som berördes
- vad AI observerade
- vilken analys AI gjorde
- vilken plan AI föreslog
- vilket test som kördes
- vad AI lärde sig
- vilka risker som finns
- om manuell granskning behövs

Journalen ska skrivas på enkel svenska. En användare ska kunna förstå vad som hänt utan att läsa kod.

AI Journal ska inte innehålla hemligheter som broker-nycklar, lösenord eller privata tokens.

## Strategy Research Control

Strategy Research Control styr vad AI får göra med strategier.

Strategier ska ha tydlig status:

- idea
- research
- paper_test
- review
- trade_approved
- rejected
- archived

AI får arbeta inom idea, research, paper_test, rejected och archived, så länge arbetet är säkert och inte kopplat till riktiga order.

AI får föreslå att en strategi flyttas till review.

AI får inte själv sätta en strategi till trade_approved.

AI får inte själv ändra en strategi som redan är trade_approved.

## System Health Control

System Health Control bevakar att Trading OS mår bra.

AI Brain får kontrollera:

- om data är gammal eller saknas
- om scanner-flöden fungerar
- om paper-resultat uppdateras
- om loggar visar fel
- om scheduler eller autopilot har misslyckats
- om testmiljöer beter sig konstigt

AI Brain får föreslå:

- datakontroll
- testomkörning
- manuell granskning
- isolering av en trasig research-del
- journalpost om risk

AI Brain får inte:

- starta om production-processer
- deploya kod
- aktivera broker
- aktivera live trading
- placera order
- ändra skyddade production-inställningar

## Vad AI får styra

AI Brain får styra eller skapa förslag inom dessa områden:

- research-planer
- paper-only tester
- backtest-hypoteser
- analys av icke-godkända strategier
- förslag på strategi-filter för research
- riskkommentarer
- journalposter
- Knowledge Base-poster
- system health-observationer
- förslag till manuell åtgärd

All styrning ska ske i säkert läge.

## Vad AI aldrig får styra

AI Brain får aldrig styra:

- live orderläggning
- riktiga köp och sälj
- Interactive Brokers-konto
- broker-sessioner
- broker-nycklar
- live trading-läge
- production-deploy
- pm2 restart
- scheduler som kan påverka live trading
- trade-godkända strategier utan manuell process
- kapitalstorlek
- position sizing för riktiga pengar
- stop loss eller take profit för live-positioner
- regler som direkt påverkar riktiga order

Detta gäller även om AI tror att en åtgärd är bra.

## Interactive Brokers som skyddad zon

Interactive Brokers är en skyddad zon.

AI Brain får inte:

- logga in mot Interactive Brokers
- läsa eller skriva broker-nycklar
- starta broker-anslutning
- placera order
- ändra order
- stänga positioner
- ändra konto- eller riskinställningar
- använda broker-data för automatisk styrning av order

AI Brain får bara ge textbaserade förslag som en människa kan granska.

Alla broker-nära åtgärder ska ske utanför AI Brain och kräva manuell kontroll.

## Trade-godkända strategier som skyddad zon

Trade-godkända strategier är skyddade.

AI Brain får inte själv:

- ändra regler i en trade-godkänd strategi
- byta parametrar i en trade-godkänd strategi
- pausa eller aktivera en trade-godkänd strategi
- koppla en trade-godkänd strategi till broker
- flytta pengar eller risk mellan strategier
- godkänna en ny version för live trading

AI Brain får:

- observera resultat
- skriva riskkommentarer
- föreslå manuell granskning
- skapa en separat research-kopia för analys, om den manuella processen tillåter det

Originalet ska vara skyddat.

## Icke-godkända strategier som AI får förbättra

AI Brain får arbeta mer aktivt med strategier som inte är trade-godkända.

Det gäller till exempel:

- nya idéer
- research-strategier
- paper-only strategier
- förkastade strategier som ska omprövas
- arkiverade strategier som kan analyseras igen

AI får föreslå:

- nya filter
- nya regler
- bättre riskbegränsningar för paper-test
- borttagning av svaga signaler
- andra tidsfönster
- tydligare testkriterier
- ny journalförklaring

AI ska alltid markera att detta är research eller paper-only.

## Enkel svenska i användarförklaringar

Alla förklaringar till användaren ska skrivas på enkel svenska.

Regler:

- Använd korta meningar.
- Skriv vad som hände.
- Skriv varför det spelar roll.
- Skriv vad AI föreslår.
- Skriv om något är osäkert.
- Undvik onödiga tekniska ord.
- Förklara tekniska ord kort när de behövs.

Exempel:

"Strategin fungerar sämre när volymen är låg. AI föreslår att vi testar ett volymfilter i paper-läge. Det påverkar inte live trading."

## 24/7-arbete via framtida scheduler/autopilot

AI Brain ska kunna arbeta 24/7 i framtiden via scheduler eller autopilot.

Det betyder att AI kan:

- läsa tillåtna dataflöden
- hitta problem
- köra paper-only analyser
- skapa research-förslag
- skriva journal
- uppdatera Knowledge Base
- markera saker som behöver manuell granskning

Men 24/7-arbete får aldrig betyda fri kontroll.

Varje automatisk loop ska starta med safety-kontroll. Om en uppgift rör broker, live trading eller trade-godkända strategier ska AI stoppa och skriva en journalpost.

## Safety-regler

AI Brain ska alltid starta i säkert läge.

Obligatoriska safety-värden:

- mode=paper_only
- actions_allowed=false
- can_place_orders=false
- live_trading_enabled=false
- broker_enabled=false

Dessa värden betyder:

- AI får bara arbeta i paper-only eller research.
- AI får inte utföra skarpa åtgärder.
- AI får inte lägga order.
- AI får inte aktivera live trading.
- AI får inte aktivera broker.

Om någon del av systemet visar andra värden ska AI Brain stoppa sin loop och skriva en varning i journalen.

## Beslutsgräns

AI Brain kan skapa förslag.

Människan eller en separat manuell godkännandeprocess fattar beslut om:

- live trading
- broker-aktivering
- trade approval
- production-deploy
- restart av drift
- kapital och risk för riktiga pengar

Denna gräns ska vara enkel att förstå och svår att kringgå.

## Minsta krav innan framtida implementation

Innan AI Brain byggs i kod ska följande finnas beskrivet:

- var AI Memory ska lagras
- hur AI Journal ska skrivas
- hur strategiers status ska markeras
- hur safety-värden ska kontrolleras
- hur skyddade zoner blockeras tekniskt
- hur manuell granskning ska fungera
- hur scheduler/autopilot får starta loopar
- hur AI-förslag ska visas för användaren

Ingen implementation ska göra avsteg från safety-reglerna i detta dokument.

## Sammanfattning

AI Brain ska göra Trading OS smartare, tydligare och mer självgranskande.

Den ska arbeta med observation, analys, planering, test, lärande, förbättring och journalföring.

Den ska hjälpa till med research och systemhälsa.

Den ska inte styra live trading, Interactive Brokers eller trade-godkända strategier.

Grundläget är alltid:

- mode=paper_only
- actions_allowed=false
- can_place_orders=false
- live_trading_enabled=false
- broker_enabled=false
