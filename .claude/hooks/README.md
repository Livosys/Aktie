# .claude/hooks — Safety-hooks (EJ AUTO-AKTIVERADE)

`pretooluse-safety-guard.sh` är en PreToolUse-hook som blockerar farliga Bash-kommandon innan de körs:

- `git push`, `pm2 save`
- aktivering av `live_trading_enabled` / `broker_enabled` / `actions_allowed` / `can_place_orders` = true
- `mode=live`, `*SUBMIT_ROUTES_ENABLED=true`
- `placeOrder` / `submitOrder`, curl POST/PUT mot submit/order/arm-endpoints
- riktiga Mini Future-order

Hooken är **skapad men inte aktiverad** (beslut: aktivera försiktigt, manuellt). Blockering sker med exit 2; meddelandet på stderr visas för Claude som då måste be användaren om explicit order.

## Aktivering (manuellt beslut)

Lägg till i `.claude/settings.json` (projekt, delas via git) eller `.claude/settings.local.json` (bara denna maskin):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /var/www/nasdaq-scanner-prod/.claude/hooks/pretooluse-safety-guard.sh"
          }
        ]
      }
    ]
  }
}
```

Starta om Claude Code-sessionen (hooks läses vid start). Testa sedan ofarligt:

```
! echo "pm2 save"        # ska gå igenom (bara text)
```
och be Claude köra `pm2 save` — hooken ska blockera med tydligt meddelande.

## Avaktivering

Ta bort hooks-blocket ur settings-filen och starta om sessionen.

## Begränsningar

- Hooken granskar bara Bash-verktygets kommandosträng — den ersätter inte reglerna i CLAUDE.md/AGENTS.md, den är ett extra skyddsnät.
- Falska positiva kan förekomma (t.ex. `grep placeOrder` blockeras). Vid behov: kör grep via Grep-verktyget i stället, eller justera mönstren medvetet och dokumentera i docs/DECISIONS.md.
- Kräver `node` i PATH (finns på denna server).
