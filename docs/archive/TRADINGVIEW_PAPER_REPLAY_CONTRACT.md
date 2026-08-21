# TradingView → Paper/Replay Contract

## Status

Detta är endast en spec.

Ingen kod ska byggas från denna fil utan separat godkännande.

TradingView → paper/replay är framtida arbete och ska hanteras som ett eget, noggrant granskat goal.

## Nuvarande princip

TradingView-signaler får inte bli riktiga order.

TradingView-signaler får inte aktivera broker.

TradingView-signaler får inte ändra risk.

TradingView-signaler får inte auto-apply:a strategier.

## Absoluta safety-regler

Följande ska alltid gälla:

```text
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

## Nuvarande flöde

TradingView webhook tar emot signaler.

Signaler normaliseras och loggas.

De stannar vid candidate/event log.

De skapar inte paper trades.

De skickas inte till broker.

De lägger inga order.

## Framtida säkert flöde

Målet senare:

```text
TradingView signal
→ validation/safety
→ normalized candidate
→ dry-run preview
→ paper/replay test queue
→ learning result
→ Supervisor summary
```

## Feature flags

Alla ska vara off som default.

```text
TRADINGVIEW_PAPER_PREVIEW_ENABLED=false
TRADINGVIEW_PAPER_FORWARDING_ENABLED=false
TRADINGVIEW_REPLAY_QUEUE_ENABLED=false
```

Ingen forwarding får ske om flaggan inte uttryckligen är aktiverad.

## Idempotens och dedup

Varje signal ska få ett stabilt id baserat på:

- source
- symbol
- timeframe
- strategy id
- timestamp
- alert id om det finns

Systemet ska deduplicera signaler inom ett tidsfönster.

Mål:

- ingen dubbel paper-test
- ingen dubbel replay-test
- ingen spam-loop
- tydlig blockedReason vid duplicate

## Validation

Innan en signal får bli preview eller testkö ska systemet kontrollera:

- secret/auth ok
- symbol tillåten
- timeframe tillåten
- strategy id mappad
- signalen inte för gammal
- market/session ok
- safety false
- mode paper_only
- ingen broker
- ingen live trading
- ingen orderväg

## Dry-run preview

Första kodsteg senare ska endast vara preview.

Preview ska visa:

- vad signalen skulle bli
- vilken strategi den matchar
- om den skulle accepteras eller blockeras
- varför
- vilket paper/replay-test den skulle skapa
- utan att skapa trade
- utan att skicka till queue
- utan att ändra risk

Preview-response bör innehålla:

```json
{
  "accepted": false,
  "dryRun": true,
  "wouldCreatePaperTest": false,
  "wouldCreateReplayTest": false,
  "blockedReason": "feature_flag_disabled",
  "safety": {
    "mode": "paper_only",
    "actions_allowed": false,
    "can_place_orders": false,
    "live_trading_enabled": false,
    "broker_enabled": false
  }
}
```

## Paper/replay queue senare

När preview är stabil kan nästa steg vara en testkö.

Kön får endast skapa:

- paper-test
- replay-test

Aldrig live order.

Kön ska ha:

- idempotens
- dedup
- cooldown
- max per dag
- max per symbol
- explicit feature flag
- tydlig status
- Supervisor-summary

## Supervisor-visning senare

Supervisor ska kunna visa:

- mottagna TradingView-signaler
- accepterade signaler
- blockerade signaler
- preview-resultat
- paper/replay-resultat
- learning-effekt
- senaste rekommendation

Det ska alltid stå tydligt:

```text
TradingView används endast för säkra tester. Inga riktiga order kan läggas.
```

## Risker

Risker att hantera:

- duplicerade signaler
- fel symbol
- fel timeframe
- spam från TradingView
- gammal signal
- fel strategy id
- oklar mapping till Strategy Catalog
- preview blandas ihop med execution
- queue växer okontrollerat
- användaren tror att live trading sker

## Byggordning senare

1. Spec och kontrakt
2. Dry-run preview endpoint
3. UI read-only preview
4. Replay queue
5. Paper queue
6. Learning integration
7. Supervisor summary
8. End-to-end tests

## Förbud

Bygg inte detta samtidigt som Supervisor-unifieringen.

Bygg inte forwarding nu.

Bygg inte live trading.

Bygg inte broker.

Bygg inte orderläggning.

Bygg inte riskändring.
