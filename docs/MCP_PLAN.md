# MCP_PLAN — Plan för read-only MCP-servrar

Mål: ge Claude Code strukturerad, **read-only** åtkomst till systemets data utan att öppna skriv-/order-vägar. Inget här är aktiverat ännu — planen implementeras stegvis på explicit order.

## Princip

Alla MCP-servrar i detta system ska vara read-only i fas 1. Ingen MCP får exponera verktyg som kan skapa order, ändra safety-flaggor, pusha kod eller ändra state. Skrivande MCP-verktyg kräver samma explicita godkännande som motsvarande manuell åtgärd.

## Planerade servrar

### 1. Filesystem (read-only)
- **Syfte:** läsa `data/` (trades, batch-resultat, agent-rapporter, state) utan Bash.
- **Scope:** `/var/www/nasdaq-scanner-prod/{data,logs,docs,pine}` — läsning enbart.
- **Implementation:** officiell `@modelcontextprotocol/server-filesystem` med read-only-rot.

### 2. Databas read-only
- **Nuläge:** systemet är fil-/JSON-baserat (ingen central SQL-db). Om/när SQLite/Postgres införs för trades/score:
- **Krav:** anslutning med READ ONLY-användare; endast SELECT; query-timeout.

### 3. Playwright/browser
- **Syfte:** verifiera UI på aktier.livosys.se (sidorna renderar, badges/safety-lås syns) efter frontend-deploy.
- **Krav:** navigering + screenshot + DOM-läsning. Inga formulär-submits mot start/stop/order-knappar utan explicit order i sessionen.

### 4. GitHub read-only
- **Nuläge:** origin har varit disabled i perioder; `gh` CLI används för PR-läsning när remote finns.
- **Krav:** endast läsning (PR-status, diffar, issues). Push/merge förblir manuella användarbeslut.

### 5. Custom Trading OS MCP (read-only)
- **Syfte:** typade verktyg ovanpå befintliga GET-endpoints i stället för råa curl-anrop:
  - `safety_status()` → `/api/safety/status`
  - `batch_status()` / `replay_status()` → `/api/status/batches`, `/api/status/replay`, autopilot-status
  - `paper_status()` → `/api/paper-trading/status|runtime`
  - `futures_paper_status()` → `/api/futures-paper/runtime|scanner|trades`
  - `strategy_scores()` → score/ranking-data
  - `recent_trades(source)` → med obligatorisk source-märkning (paper/replay/engine_test separerade)
- **Krav:** enbart GET; svaren märker alltid datakälla (live-paper vs replay vs test); ingen mutation.
- **Implementation:** liten Node MCP-server i `scripts/mcp/` som proxar `127.0.0.1:3001` GET-endpoints.

## Aktiveringsordning (förslag)

1. Filesystem read-only (lägst risk, störst nytta).
2. Custom Trading OS MCP (ersätter curl-gymnastik i harness/commands).
3. Playwright (UI-verifiering efter deploys).
4. GitHub read-only (när remote-strategin är avgjord).
5. Databas — först när en riktig databas finns.

Varje aktivering: dokumentera i `docs/DECISIONS.md`, konfigurera i `.mcp.json`/Claude-settings, kör `safety_harness.sh` efteråt.
