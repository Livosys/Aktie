# Prod Deploy Checklist — TDZ-fix + replayEngine→learning-koppling

> Två oberoende backend-patchar för prod (`/var/www/nasdaq-scanner-prod`).
> Rör **endast** backend-`src/` (ingen client-build, ingen .env, ingen Nginx).
> Kräver **ett** PM2-restart för att ladda ny kod. Inga ordrar/broker/livehandel berörs.

---

## 0. Patchar som ska appliceras

| # | Patch | Rör fil | Effekt |
|---|-------|---------|--------|
| 1 | `/var/www/nasdaq-scanner-prod/backups/prod-tdz-replaysummary-fix-20260609-181518.patch` | `src/services/supervisorOverviewService.js` | `replaySummary` speglar `replayStatus` (TDZ-bugg borta) |
| 2 | `/var/www/nasdaq-scanner-prod/backups/prod-replayengine-learning-connector-20260609-181740.patch` | `src/scanner/replayEngine.js` | replay-runs matar `learningConnector.recordReplayResult` |

Patcharna är oberoende (olika filer) — ordningen spelar ingen roll. Båda är validerade med `git apply --check` mot prod.

---

## 1. För-flight (read-only, skriver inget)

- [ ] Rätt server och katalog:
  ```bash
  cd /var/www/nasdaq-scanner-prod && pwd
  ```
- [ ] Ren arbetskopia (inga oväntade ändringar):
  ```bash
  git status --short        # förväntat: tomt
  git rev-parse --short HEAD
  ```
- [ ] Notera nuvarande PM2-process (namn/id) för restart + ev. rollback:
  ```bash
  pm2 list
  ```
- [ ] Baseline av nuläget (för efter-jämförelse):
  ```bash
  node -e "require('dotenv').config({path:'.env'});const o=require('./src/services/supervisorOverviewService');o.buildOverview().then(x=>console.log('replayStatus',x.replayStatus.status,'| replaySummary',x.replaySummary.status));"
  # Förväntat FÖRE: replayStatus ok | replaySummary error  (TDZ-buggen)
  node -e "const s=require('./data/learning-connector/status.json');console.log('connector replay:',s.by_source.replay);"
  # Förväntat FÖRE: connector replay: 0
  ```
- [ ] Ta en säkerhetskopia av de två filerna (extra skydd utöver git):
  ```bash
  cp src/services/supervisorOverviewService.js src/services/supervisorOverviewService.js.pre-deploy.bak
  cp src/scanner/replayEngine.js src/scanner/replayEngine.js.pre-deploy.bak
  ```

---

## 2. Dry-run av patcharna (skriver inget)

- [ ] Båda ska rapportera rent:
  ```bash
  git apply --check --verbose /var/www/nasdaq-scanner-prod/backups/prod-tdz-replaysummary-fix-20260609-181518.patch
  git apply --check --verbose /var/www/nasdaq-scanner-prod/backups/prod-replayengine-learning-connector-20260609-181740.patch
  ```
  ✋ **STOPP** om någon säger `patch does not apply` — fortsätt inte. (Kan betyda att prod-koden ändrats sedan patchen byggdes.)

---

## 3. Applicera

- [ ] Patch 1 (TDZ):
  ```bash
  git apply /var/www/nasdaq-scanner-prod/backups/prod-tdz-replaysummary-fix-20260609-181518.patch
  ```
- [ ] Patch 2 (replay-koppling):
  ```bash
  git apply /var/www/nasdaq-scanner-prod/backups/prod-replayengine-learning-connector-20260609-181740.patch
  ```
- [ ] Bekräfta att båda landade:
  ```bash
  grep -c "NOTE: replaySummary is derived" src/services/supervisorOverviewService.js   # => 1
  grep -c "recordReplayResult" src/scanner/replayEngine.js                              # => 2
  git status --short    # => M på de två filerna
  ```

---

## 4. Sanity före restart (skriver inget i runtime)

- [ ] Syntax:
  ```bash
  node -c src/services/supervisorOverviewService.js
  node -c src/scanner/replayEngine.js
  ```
- [ ] Funktionell torrkörning (laddar ny kod i en separat process, ej PM2):
  ```bash
  node -e "require('dotenv').config({path:'.env'});const o=require('./src/services/supervisorOverviewService');o.buildOverview().then(x=>console.log('replayStatus',x.replayStatus.status,'| replaySummary',x.replaySummary.status));"
  # Förväntat EFTER: replayStatus ok | replaySummary ok   (speglar nu)
  ```
  ✋ **STOPP** om `replaySummary` fortfarande är `error`.

---

## 5. Ladda ny kod i runtime

- [ ] Vid godkänd deploy är `pm2 restart nasdaq-scanner` tillåtet (krävs — annars kör den gamla koden i minnet):
  ```bash
  pm2 restart nasdaq-scanner
  ```
- [ ] `pm2 save` får **INTE** köras.
- [ ] Kör alltid status och loggkontroll direkt efter restart för att verifiera att processen är `online` och felfri:
  ```bash
  pm2 status
  pm2 logs nasdaq-scanner --lines 40 --nostream
  ```

---

## 6. Efter-deploy verifiering

- [ ] **TDZ-fix:** `replaySummary` speglar `replayStatus` via live-API:t (justera port/route):
  ```bash
  curl -s localhost:3000/api/supervisor/overview | \
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log('replayStatus',o.replayStatus.status,'replaySummary',o.replaySummary.status);});"
  # Förväntat: replayStatus ok / replaySummary ok (eller samma icke-error status)
  ```
- [ ] **Replay-koppling:** kör en replay och se att connectorns replay-kanal ökar:
  ```bash
  node -e "const s=require('./data/learning-connector/status.json');console.log('replay FÖRE:',s.by_source.replay);"
  # kör en liten replay (scan_only):
  node -e "require('dotenv').config({path:'.env'});const {runReplay}=require('./src/scanner/replayEngine');runReplay({symbols:['AAPL'],start:'2026-05-10',end:'2026-06-09',mode:'scan_only'}).then(r=>console.log('run',r.runId));"
  node -e "const s=require('./data/learning-connector/status.json');console.log('replay EFTER:',s.by_source.replay);"
  # Förväntat: EFTER = FÖRE + 1
  ```
- [ ] Inga nya fel i `pm2 logs`.

---

## 7. Rollback (om något fallerar)

- [ ] Återställ koden (välj en):
  ```bash
  git checkout -- src/services/supervisorOverviewService.js src/scanner/replayEngine.js
  # eller från backup:
  mv src/services/supervisorOverviewService.js.pre-deploy.bak src/services/supervisorOverviewService.js
  mv src/scanner/replayEngine.js.pre-deploy.bak src/scanner/replayEngine.js
  ```
- [ ] Ladda om gamla koden:
  ```bash
  pm2 restart <app-namn|id>
  pm2 status
  ```
- [ ] Patcharna kan återanvändas senare — de ligger kvar i `backups/`.

---

## 8. Städning

- [ ] Ta bort `.pre-deploy.bak`-filerna när deployen verifierats stabil.
- [ ] Notera deploy-tidpunkt + HEAD-commit i ev. driftlogg.

---

## Säkerhet / scope
- Båda patcharna är paper/read-only-statuslogik resp. learning-ingestion. Inga `placeOrder`/broker/order/live-vägar berörs (safety-flaggor `false`).
- replay-kopplingen är fault-isolerad (lazy-require + try/catch, deduppad per runId) → kan inte krascha en replay-run.
- Ingen client-build, ingen `.env`-, ingen Nginx-ändring krävs.
