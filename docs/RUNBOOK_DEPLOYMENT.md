# RUNBOOK_DEPLOYMENT — PM2 / Nginx / deploy

## Topologi

- **App:** `nasdaq-scanner` under PM2, `ecosystem.config.js`, Node på `127.0.0.1:3001`.
- **PM2 pekar på:** `/var/www/nasdaq-scanner-prod` (repointad + `pm2 save` gjord 2026-07-07; dump verifierad). Äldre deploy-worktrees (t.ex. `deploy-2438421`) behålls som rollback.
- **Nginx:** `nginx-aktier.conf` → aktier.livosys.se, proxar `/api` till 3001 och serverar `client/dist` **statiskt**.
- **Kritiskt:** eftersom dist serveras statiskt är `npm run build` i `client/` = **omedelbar prod-deploy** av frontend, utan restart. Bygg aldrig som bieffekt. Vid parallella sessioner kan en build deploya deras dirty filer.

## Deploy-regler

| Ändring | Åtgärd | Kräver explicit order? |
|---|---|---|
| Backend-kod | `pm2 restart nasdaq-scanner` | restart ok inom beordrat arbete; **`pm2 save` alltid explicit order** |
| Frontend | `cd client && npm run build` (= direkt live) | ja — bygg bara när deploy är avsikten |
| `.env` | redigera + restart | ja, alltid |
| Nginx-conf | redigera + `nginx -t` + reload | ja, alltid |
| PM2-repoint (cwd/script-path) | uppdatera process + restart | ja, alltid + migrera state-filer (se nedan) |

## PM2-repoint-fällor (lärda av incidenter)

1. **State-filer följer inte med:** `data/`-state (paper-trading state.json, `market-config.json`, `HISTORICAL_DATA_ROOT`) måste migreras/pekas om — annars split-brain (paper-trading dog 4 jul p.g.a. detta).
2. Saknad `market-config.json` → crypto default AV → `MARKET_CONTROL_PAPER_DISABLED`.
3. Runtime-satta env-gates (satta via PM2 utan `.env`) försvinner vid reboot — dokumentera i DECISIONS.md vilka gates som är runtime-only.

## Säker deploy-checklista

```bash
# 1. Före
git status                                   # inga oväntade dirty filer (parallell session?)
bash scripts/harness/safety_harness.sh       # PASS krävs

# 2. Deploy (backend)
pm2 restart nasdaq-scanner                   # INGEN pm2 save utan order

# 3. Efter
curl -s http://127.0.0.1:3001/api/safety/status | head -c 300   # mode:"paper"
bash scripts/harness/regression_harness.sh
pm2 status                                   # read-only
pm2 logs nasdaq-scanner --lines 30 --nostream
```

## Rollback

- Backend: `pm2 restart` mot föregående worktree/commit (repoint tillbaka); `deploy-2438421` hålls orörd som rollback-punkt.
- Frontend: äldre dist-backuper i `backups/` (mönster `_backup_*_<timestamp>Z`), kopiera tillbaka och klart (statisk servering).
- State: rör aldrig `data/` vid rollback utan att verifiera vilken state som är sanning.

## Förbud

Ingen `pm2 save`, ingen push, ingen env/Nginx-ändring, ingen ny PM2-process — utan explicit order. GitHub-origin har varit avstängd i perioder (`origin-disabled`); verifiera remote innan någon beordrad push.
