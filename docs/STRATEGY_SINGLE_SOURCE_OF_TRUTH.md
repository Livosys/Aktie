# Strategy Single Source of Truth

> Status: foundation (read-only). Inget runtime är omkopplat. Ingen automation,
> ingen execution, ingen TradingView-forwarding, ingen risk/live-ändring.

## Lagermodell

| Lager | Service | Roll |
|---|---|---|
| **Canonical truth** | `daytradingStrategyCatalogService` | Enda sanningen för riktiga runtime-strategier (33 canonical `strategy_id`). |
| **Overlay/adapter** | `strategyRegistryService` | Lägger status (TradingView/manual/supervisor) ovanpå canonical katalogen. Ändrar inte sanningen. |
| **Legacy/preset** | `strategyCatalogService` | Gammal preset-/UI-katalog (18 konceptnycklar). **Inte** runtime-sanning längre — endast legacy/preset-vy. |
| **Read-only bridge** | `strategyIdNormalizerService` | Översätter `legacy_key → canonical_strategy_id`. Ändrar ingen data. |

## Principer

- `daytradingStrategyCatalogService` är canonical truth. All ny kod som behöver en
  riktig strategi ska referera canonical `strategy_id`.
- `strategyRegistryService` förblir overlay/adapter — den beskriver status, inte
  identitet.
- `strategyCatalogService` betraktas som legacy/preset. Den får visas i UI men
  ska inte tolkas som runtime-sanning.
- `strategyIdNormalizerService` är en **read-only** brygga. Den:
  - returnerar `canonical` för exakt canonical id,
  - returnerar `legacy_alias` när en legacy-nyckel mappar entydigt,
  - returnerar `ambiguous=true` med `possibleCanonicalIds` när flera matchar,
  - returnerar `unknown` för okänd eller tom indata.
- **Ambiguous mapping får ALDRIG auto-väljas.** Ingen tyst gissning — en människa
  väljer bland `possibleCanonicalIds`.

## Read-only endpoint

`GET /api/strategies/normalization-report` returnerar canonical-inventering,
legacy-mappningar och olösta legacy-nycklar. Den registrerar inget, ändrar ingen
allowlist och startar inga tester.

## Safety (oförändrat)

```
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

Detta steg ändrar inte broker, live trading, order, risk, scheduler-execution,
TradingView-forwarding eller allowlist-beslut. Runtime-koppling (scanner/paper/
learning ska använda normalizern) kommer som ett separat, verifierat steg senare.
