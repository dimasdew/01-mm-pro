# 01-mm-pro

Production-grade market maker for **01 Exchange** on Solana.

A risk-managed market maker built for real capital — proper risk layer, smarter quoting (inventory skew, dynamic spread, funding bias), drawdown kill switch, auto-flatten on halt, and a backtest harness.

> ⚠️ **Reality check on "100% winrate":** this is a *market maker*, not a directional trading bot. It earns the bid/ask spread and carries **inventory risk**. In a calm, ranging market it can look like it "never loses" — but in a strong trend it accumulates an adverse position and **can lose more than many small spread wins**. There is no 100% winrate strategy. This bot's job is to *manage* that risk, not eliminate it. Backtest and start tiny.

## Features

| Area | Baseline MM | 01-mm-pro |
|---|---|---|
| **Drawdown protection** | none | Kill switch: halt + cancel all orders when session PnL ≤ `-MAX_DRAWDOWN_USD` |
| **Auto-flatten on halt** | none | On halt, closes the residual position with a reduce-only IOC (taker) — no manual close needed |
| **Inventory cap** | soft close-mode only | Hard `MAX_INVENTORY_USD` — blocks the side that grows the position past the cap |
| **Inventory skew** | none (just disables one side) | Shifts fair price against inventory so the bot actively mean-reverts its position |
| **Spread** | fixed 8 bps | Dynamic: widens with realized volatility (`VOL_SPREAD_MULT`, capped at `MAX_SPREAD_BPS`) |
| **Take-profit** | 0.1 bps (often < fees) | 3 bps default — actually covers costs |
| **Funding** | ignored | Polls Binance funding, biases quotes to avoid paying funding (`FUNDING_AWARE`) |
| **Stale feeds** | 60 s reconnect only | Quoting halts if any feed is older than `STALE_FEED_MS` (default 5 s) |
| **Error handling** | logs & retries | Halts after `MAX_CONSECUTIVE_ERRORS` to avoid blind hammering |
| **Defaults** | `orderSize=3000`, `closeThreshold=10` (1 fill → instant close mode) | Sane, fully `.env`-driven |
| **Backtesting** | none | `npm run backtest` against Binance 1m klines |
| **Node version** | requires Node ≥ 25 | Runs on Node ≥ 22 via a small hex polyfill |

## How it works

1. Builds a **fair price** = `binance_mid + median(01_mid − binance_mid)` over a rolling window.
2. Applies **inventory skew** and **funding skew** to that fair price.
3. Quotes bid = `fair − halfSpread`, ask = `fair + halfSpread`, where `halfSpread` grows with volatility.
4. As inventory builds, skew leans the bot toward reducing; past `CLOSE_THRESHOLD_USD` it goes close-only; at `MAX_INVENTORY_USD` it hard-blocks the growing side.
5. The **RiskManager** tracks realized PnL, feed staleness, and errors — and halts + flattens when any limit is breached.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — set PRIVATE_KEY (base58 Solana key with a funded 01.xyz account)
```

## Backtest first (always)

```bash
npm run backtest -- BTC 1500 200
#                    ^sym ^bars ^orderSizeUsd
```

Outputs fills, realized PnL, max drawdown, and whether the risk halt engaged. Tune `.env`, re-run, repeat. **Maker-only fill model, no queue/slippage — directional sanity check only, not a profit guarantee.**

## Run live

```bash
npm run bot -- BTC
```

`Ctrl+C` cancels all open orders and exits cleanly.

## Run 24/7 with Docker

For a server that keeps the bot alive across crashes and reboots. **Note: use a restart policy, NOT cron** — this bot must run continuously (live WebSocket fills, real-time quote refresh, always-on risk halt). Cron would kill it between ticks and leave positions unmonitored.

```bash
cp .env.example .env   # set PRIVATE_KEY etc.

# Option A — docker compose (recommended on a VPS):
docker compose up -d --build    # start in background, auto-restart on crash/reboot
docker compose logs -f          # tail logs
docker compose down             # stop (graceful: cancels resting orders)

# Option B — plain docker (no compose plugin):
docker build -t 01-mm-pro .
docker run -d --name 01-mm-pro \
  --restart=unless-stopped \
  --memory=512m \
  --stop-timeout=15 \
  --env-file .env \
  01-mm-pro
docker logs -f 01-mm-pro
docker stop 01-mm-pro            # graceful shutdown
```

`--restart=unless-stopped` is the real "24/7": auto-restarts on crash or VPS reboot, but stays down if you stop it deliberately. `tini` (PID 1) forwards SIGTERM so the bot cancels resting orders before exit. The image typechecks at build time, so a broken build never ships.

## Config

Every knob is an env var — see [`.env.example`](.env.example). Key safety ones:

- `MAX_DRAWDOWN_USD` — your hard stop. Start small.
- `MAX_INVENTORY_USD` — biggest position you'll tolerate.
- `ORDER_SIZE_USD` — per-side notional. Start tiny.

## Risk disclaimer

Market making on a perp DEX can lose money, especially in trending or illiquid markets, during feed outages, or on liquidations. This software is provided as-is, no warranty. You are responsible for your own funds. Test on small size first.

## License

MIT
