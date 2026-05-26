# TradingAgents Runtime — Read-Only Research Layer

## What this is

TradingAgents is a **read-only AI research layer** layered on top of the
nasdaq-scanner pipeline. It analyses signal context and returns bull/bear cases,
risk notes, confidence adjustments, and a market narrative. It **never** creates
trades, places orders, or touches live state.

## Safety contract

| Property | Value |
|---|---|
| `can_place_orders` | always `false` |
| `actions_allowed` | always `false` |
| `live_trading_enabled` | always `false` |
| Max recommendation | `BUY / SELL / HOLD / OBSERVE` |
| Forbidden actions | `BUY_NOW`, `EXECUTE`, `PLACE_ORDER`, `MARKET_*` → normalised to `OBSERVE` |

## v1 mode (current)

v1 runs a **mock/rule-based adapter** (`src/services/tradingAgentsAdapterService.js`).
No external Python runtime is required. The adapter derives bull/bear/risk analysis
from the signal context already present in the scanner.

## Future: Python runtime

When a real TradingAgents Python runtime is available, set:

```env
TRADING_AGENTS_ENABLED=true
TRADING_AGENTS_ENDPOINT=http://localhost:7860
TRADING_AGENTS_API_KEY=<key>
```

The adapter will then forward the context to the Python service and normalise
the response into the standard output format before returning it to the pipeline.

## Redis keys

| Key | TTL | Purpose |
|---|---|---|
| `tradingagents:latest:{SYMBOL}` | 300 s | Latest analysis per symbol |
| `tradingagents:status` | 60 s | Adapter status |
| `tradingagents:narrative:latest` | 300 s | Latest market narrative |

## Pipeline position

```
Scanner → Market Gate → AI Agent → Historical Memory
  → TradingAgents (this) → Risk Engine → Execution Safety
  → Paper Entry → Exit Engine
```
