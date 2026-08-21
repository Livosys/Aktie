# AI Strategy Control

Status: aktiv regel for AI-arbete. Interactive Brokers, trade-godkanda
strategier, order, broker och risk ar skyddad zon.

## Malbild

AI ska vara systemets 24/7 strategi- och systemforbattrare.

AI far jobba sjalvstandigt med icke-trade-strategier for att:

- analysera strategier
- skapa nya testvarianter
- foresla parametrar
- kora replay/batch/dry-run nar flodet redan ar sakert byggt
- markera strategier som lovande
- markera strategier som svaga
- foresla framtida kandidater for manuell granskning
- forklara varfor en strategi ar bra eller dalig
- skriva enkla sammanfattningar till anvandaren

Detta ar research. Det far inte bli trade, order, broker eller riskandring.

## AI Far Arbeta Med

- nya strategier
- teststrategier
- icke-godkanda strategier
- svaga strategier
- strategier som behover mer data
- replay-resultat
- batch-resultat
- learning-resultat
- parameterforslag
- forbattrningsforslag
- testplaner
- jamforelser mellan strategier

## Tillatna Ytor

AI far overvaka och forbattra icke-trade-ytor:

- `/ai`
- `/supervisor`
- `/overview`
- `/narrow`
- `/paper-trading`, endast read-only/testanalys
- labb
- replay
- batch tester
- learning engine
- strategiresultat
- system health

## Skyddad Zon

AI far inte rora:

- `/interactive-brokers`
- IB-komponenter
- IB-services
- IB-submit
- IB-paper/manual execution
- broker settings
- order routes
- account routes
- trade-godkanda strategier
- order/trade/broker/risk

Interactive Brokers ar alltid skyddad trade-zon.

## AI Far Inte

- andra godkanda trade-strategier utan separat beslut
- flytta strategi till trade-godkand lista
- auto-godkanna strategi for trading
- rora Interactive Brokers-sidan
- andra broker-installningar
- skapa ordervag
- paverka live trading
- andra risk automatiskt
- anvanda buy/sell/execution

## Sma Sakra Andringar Som Inte Behover Fraga

AI behover inte fraga for sma, sakra andringar inom icke-trade-strategier:

- forbattrad copy
- forbattrad strategi-analys
- read-only rapporter
- testplaner
- scoringforklaringar
- battre forklaringar
- markera strategier som "behover mer test"
- UI for AI/systemstatus
- diagnostik

## Fraga Alltid Innan

AI maste fraga innan:

- commit
- push
- `pm2 restart`
- merge
- deploy
- delete av filer
- andring i Interactive Brokers
- andring i trade-godkanda strategier
- andring som paverkar order/trade/broker/risk
- storre backendflode
- schedulerandring som kor nagot nytt automatiskt

## Rekommendationsformat

Varje AI-rekommendation ska visa:

- vad AI sag
- varfor det spelar roll
- vad AI vill forbattra
- riskniva
- om det paverkar trading: nej
- nasta steg i enkel svenska

Maskinlasbart kontrakt finns i:

```text
src/services/aiStrategyControlPolicyService.js
```

Det kontraktet ska anvandas av AI-/strategitjanster som bygger
rekommendationer.
