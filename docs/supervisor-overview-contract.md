# Contract — `GET /api/supervisor/overview`

Read-only aggregation endpoint. Makes the Supervisor the brain of the whole
system by collecting the already-existing system-wide endpoints into one
fault-tolerant response. It **only reads** — never writes, never places orders,
never enables a broker, never changes risk.

## Safety invariant
Every response includes, and the server guarantees:
```
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

## Top-level shape
```jsonc
{
  "ok": true,
  "generatedAt": "ISO-8601",
  "mode": "paper_only",
  "actions_allowed": false,
  "can_place_orders": false,
  "live_trading_enabled": false,
  "broker_enabled": false,

  // Canonical headline numbers (single source of truth = tradeStatsService).
  "canonicalStats": {
    "totalTrades": 423,
    "winRate": 47.99,          // WIN / total (TIMEOUT counts against)
    "decisiveWinRate": 58.5,   // WIN / (WIN+LOSS) (TIMEOUT excluded)
    "timeoutRate": 17.97,
    "avgPnl": -0.0095
  },

  // Each block is independent and fault-isolated.
  "blocks": {
    "system_health":      { "status": "...", "scope": "system_wide", "source": "...", "summary": {…} },
    "learning":           { … },
    "strategies":         { … },
    "narrow":             { … "scope": "narrow_only" },
    "autopilot":          { … "scope": "narrow_only" },
    "market_regime":      { … },
    "priority":           { … },
    "daily_pipeline":     { … },
    "ai_optimization":    { … },
    "operations_advisor": { … }
  },

  "risks": [ { "level": "info|warning|critical", "code": "…", "message_sv": "…" } ],
  "actionPlan": [ { "priority": "low|medium|high", "title_sv": "…", "detail_sv": "…", "source": "…" } ]
}
```

## Block status values
- `ok` — produced data
- `empty` — produced nothing yet (no data / needs_more_data) — NOT an error
- `degraded` — partial data
- `error` — the source threw; `error` field holds the message; the overview
  still returns 200 so one broken block never blanks the page.

## Block sources (all already exist)
| Block | Scope | Backing call |
|---|---|---|
| system_health | system_wide | `systemHealth.buildSystemHealth()` |
| learning | system_wide | `learningConnectorService.loadLatestSummary()` + `tradeStatsService` |
| strategies | system_wide | `strategyPerformanceReadService.getTopStrategies/getWorstStrategies` |
| narrow | narrow_only | `narrowPerformanceLearningService.buildSupervisorNarrowLearning()` |
| autopilot | narrow_only | `narrowTestAutopilotService.getNarrowAutopilotStatus()` + scheduler status |
| market_regime | system_wide | `marketRegimeService.buildRegimeSummary()` |
| priority | system_wide | `priorityEngineService.buildPrioritySummary()` (async) |
| daily_pipeline | system_wide | `dailyIntelligencePipelineService.status()` |
| ai_optimization | system_wide | `aiOptimizationAgentService.getCachedSummary()` |
| operations_advisor | system_wide | `supervisorOperationsAdvisorService.getOperationsAdvisor()` |

## Questions the Supervisor must answer (mapping)
- 🟢 Hur mår systemet? → `blocks.system_health`
- 🧠 Vad lärde sig AI? → `blocks.learning` + `canonicalStats`
- 📈 Bästa strategier? → `blocks.strategies.summary.top`
- 📉 Sämsta strategier? → `blocks.strategies.summary.worst`
- 🔬 Vad testas? → `blocks.autopilot` + `blocks.daily_pipeline`
- 🎯 Nästa test? → `actionPlan` (from narrow recommendedNextTest)
- ⚠ Risker? → `risks`
- 📋 Vad fokusera på idag? → `actionPlan`

UI is built only AFTER this backend is stable (separate step).
