#!/usr/bin/env bash
# pretooluse-safety-guard.sh — PreToolUse-hook för Claude Code (Bash-verktyget).
# EJ AKTIVERAD BY DEFAULT — se .claude/hooks/README.md för aktivering.
#
# Blockerar (exit 2 = block, stderr visas för Claude):
#   git push, pm2 save, aktivering av live/broker/order-flaggor, mode=live,
#   IBKR submit, placeOrder/submitOrder-anrop, riktiga Mini Future-order.
# Läser hook-input (JSON) på stdin enligt Claude Code hooks-kontraktet.
set -u

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{const j=JSON.parse(d);process.stdout.write(String((j.tool_input&&(j.tool_input.command||""))||""));}
  catch(e){process.stdout.write("");}
})' 2>/dev/null || true)"

[ -z "$CMD" ] && exit 0  # inget Bash-kommando att granska

block() { echo "BLOCKERAT av trading-os safety-hook: $1 — kräver explicit användarorder (se docs/TRADING_OS_SAFETY.md)" >&2; exit 2; }

echo "$CMD" | grep -Eq '(^|[;&| ])git +push' && block "git push"
echo "$CMD" | grep -Eq '(^|[;&| ])pm2 +save' && block "pm2 save"
echo "$CMD" | grep -Eq 'live_trading_enabled[^a-z_]*(=|:) *true' && block "live_trading_enabled=true"
echo "$CMD" | grep -Eq 'broker_enabled[^a-z_]*(=|:) *true' && block "broker_enabled=true"
echo "$CMD" | grep -Eq 'actions_allowed[^a-z_]*(=|:) *true' && block "actions_allowed=true"
echo "$CMD" | grep -Eq 'can_place_orders[^a-z_]*(=|:) *true' && block "can_place_orders=true"
echo "$CMD" | grep -Eq 'mode[^a-z_]*(=|:) *["'"'"']?live' && block "mode=live"
echo "$CMD" | grep -Eq 'SUBMIT_ROUTES_ENABLED *= *true' && block "submit-routes-gate=true"
echo "$CMD" | grep -Eq 'placeOrder|submitOrder' && block "placeOrder/submitOrder"
echo "$CMD" | grep -Eqi 'curl[^|;&]*-X *(POST|PUT)[^|;&]*(submit|order|arm)[^|;&]*' && block "POST/PUT mot submit/order/arm-endpoint"
echo "$CMD" | grep -Eqi 'mini[-_ ]?future[^|;&]*(order|buy|sell|submit)' && block "Mini Future-order (real-money kräver separat mänskligt godkännande)"

exit 0
