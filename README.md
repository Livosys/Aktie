# Nasdaq 2M Scanner

Realtids-scanner för Nasdaq-aktier baserad på Oliver Velez 2-minuters narrow state-logik.

## Sidor

| Sida | URL |
|------|-----|
| Aktier | https://aktier.livosys.se/aktier |
| Nasdaq | https://aktier.livosys.se/nasdaq |
| Krypto | https://aktier.livosys.se/krypto |

## Inloggning

Dashboarden skyddas med HTTP Basic Auth.

Konfigurera i `.env`:

```
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=ditt_lösenord_här
```

Byt lösenord genom att uppdatera `.env` och sedan köra:

```bash
pm2 restart nasdaq-scanner --update-env
```

## Miljövariabler

Kopiera `.env.example` till `.env` och fyll i värden:

```bash
cp .env.example .env
```

| Variabel | Beskrivning |
|----------|-------------|
| `ALPACA_API_KEY_ID` | Alpaca API-nyckel |
| `ALPACA_API_SECRET_KEY` | Alpaca API-hemlighet |
| `ALPACA_DATA_FEED` | `iex` (gratis) eller `sip` (betald) |
| `ALPACA_BASE_URL` | Paper eller live API-URL |
| `PORT` | Serverport (standard 3001) |
| `NODE_ENV` | `production` eller `development` |
| `DASHBOARD_USER` | Användarnamn för dashboard-login |
| `DASHBOARD_PASSWORD` | Lösenord för dashboard-login |

## API-endpoints

Alla endpoints utom `/health` kräver Basic Auth.

| Endpoint | Beskrivning |
|----------|-------------|
| `GET /health` | Hälsokontroll (öppen) |
| `GET /api/scan` | Alla symboler |
| `GET /api/scan/stocks` | Aktier (NVDA, AMD, TSLA...) |
| `GET /api/scan/nasdaq` | Nasdaq-proxy (QQQ) |
| `GET /api/status` | Scanner-status |
| `GET /api/symbols` | Watchlist |
| `GET /api/groups` | Symbol-grupper |

Exempel med curl:

```bash
curl -u admin:LÖSENORD https://aktier.livosys.se/api/scan
```

## Starta/stoppa

```bash
pm2 start nasdaq-scanner
pm2 restart nasdaq-scanner --update-env
pm2 stop nasdaq-scanner
pm2 logs nasdaq-scanner
```

## Bygga frontend

```bash
cd client
npm install
npm run build
pm2 restart nasdaq-scanner
```

## Signaler

| Signal | Betydelse |
|--------|-----------|
| LONG_TRIGGERED | Breakout-läge — bevaka long |
| SHORT_TRIGGERED | Breakdown-läge — bevaka short |
| LONG_WATCH / SHORT_WATCH | Nära trigger |
| WIDE_REVERSAL_WATCH | Sträckt trend + elephant bar mot trenden |
| WAIT / WAIT_PULLBACK | Vänta på bättre läge |
| NO_TRADE | Undvik |

## Event-typer

| Event | Betydelse |
|-------|-----------|
| NARROW_WAIT | High/Medium narrow — väntar på trigger |
| BULLISH_ELEPHANT_BREAKOUT | Stor bullish candle — möjlig breakout |
| BEARISH_ELEPHANT_BREAKDOWN | Stor bearish candle — möjlig breakdown |
| REGULAR_PULLBACK | Normal pullback mot SMA-zonen |
| THREE_FINGER_SPREAD_AVOID | Priset för långt från SMA20/SMA200 — jaga inte |
| WIDE_REVERSAL_WATCH | Möjlig vändning i sträckt trend |
| NO_TRADE | Ingen handel |
