---
name: deployment-pm2-nginx
description: Deploy-topologin — PM2, Nginx, statisk dist-servering, repoint-fällor, rollback. Läs FÖRE varje deploy, pm2 restart, frontend-build eller Nginx-fråga.
---

# Deployment: PM2 / Nginx

Kanoniskt dokument: `docs/RUNBOOK_DEPLOYMENT.md`.

## Topologi
PM2-app `nasdaq-scanner` → `/var/www/nasdaq-scanner-prod` (repointad + pm2 save 2026-07-07), Node på `127.0.0.1:3001`, Nginx (`nginx-aktier.conf`) proxar `/api` och serverar `client/dist` **statiskt**.

## Kritiska regler
1. **Frontend-build = omedelbar prod-deploy** (statisk dist). Bygg aldrig som bieffekt; vid parallella sessioner deployar en build deras dirty filer (t.ex. FuturesPaperDeskPage.jsx).
2. Backend-ändring: `pm2 restart nasdaq-scanner` ok inom beordrat arbete — **`pm2 save` ALDRIG utan explicit order**.
3. `.env`, Nginx-conf, PM2-repoint, cron: alltid explicit order.
4. Runtime-satta env-gates (ej i `.env`) försvinner vid reboot — dokumentera i DECISIONS.md.

## Repoint-fällor (incident-lärdomar)
- Migrera `data/`-state (paper-state.json, `market-config.json`, `HISTORICAL_DATA_ROOT`) — annars split-brain/`MARKET_CONTROL_PAPER_DISABLED`.
- CORS-allowlist kan ge blank page vid domän-/pathändringar.

## Checklista (deploy)
```
git status → safety_harness.sh (PASS) → pm2 restart → curl /api/safety/status (mode:"paper")
→ regression_harness.sh → pm2 status + pm2 logs --nostream (read-only)
```

## Rollback
Backend: repoint till föregående worktree (`deploy-2438421` hålls orörd). Frontend: dist-backup i `backups/` kopieras tillbaka. State i `data/` röres ej utan verifiering.
