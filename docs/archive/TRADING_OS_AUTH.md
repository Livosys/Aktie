# Trading OS Session Auth

Trading OS browser access is protected by server-side admin sessions when
`TRADING_OS_AUTH_ENABLED=true`.

## Runtime Model

- Public: `/login`, `/api/auth/login`, `/api/auth/session`, `/health`, static assets.
- Protected: Trading OS API routes under `/api`, except the existing TradingView webhook path.
- Mutations require an authenticated admin session and `X-CSRF-Token`.
- Session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production.
- Login regenerates the session ID. Logout destroys the server-side session and clears the cookie.
- Admin session auth does not grant broker, live trading, order, or risk-changing capability.

## Environment

Required in production:

```text
TRADING_OS_AUTH_ENABLED=true
TRADING_OS_ADMIN_USERNAME=<admin username>
TRADING_OS_ADMIN_PASSWORD_HASH=<scrypt hash>
TRADING_OS_SESSION_SECRET=<high entropy secret>
TRADING_OS_SESSION_MAX_AGE_MS=28800000
```

Generate a password hash on the server without printing the password:

```bash
node -e "require('dotenv').config(); const auth=require('./src/services/tradingOsAuthService'); process.stdout.write(auth.hashPassword(process.env.DASHBOARD_PASSWORD || ''))"
```

Do not commit `.env`, plaintext passwords, password hashes, or session secrets.

## Rollback

Preferred rollback is to revert the auth commits. For a temporary runtime
fallback, `TRADING_OS_AUTH_ENABLED=false` returns API mutation auth to the legacy
Basic Auth path. Manual Paper Strategy List, LONG_ONLY, and entry contracts are
unchanged.

Never run `pm2 save` as part of auth rollback unless explicitly approved.
