# 01-mm-pro

Production-grade market maker for **01 Exchange** on Solana.

A risk-managed market maker built for real capital — proper risk layer, smarter quoting (inventory skew, dynamic spread, funding bias), drawdown kill switch, auto-flatten on halt, and a backtest harness.

> ⚠️ **Reality check on "100% winrate":** this is a *market maker*, not a directional trading bot. It earns the bid/ask spread and carries **inventory risk**. In a calm, ranging market it can look like it "never loses" — but in a strong trend it accumulates an adverse position and **can lose more than many small spread wins**. There is no 100% winrate strategy. This bot's job is to *manage* that risk, not eliminate it. Backtest and start tiny.

## Features

| Area | Baseline MM | 01-mm-pro |
|---|---|---|
| **Drawdown protection** | none | Kill switch: halt + cancel all orders when session PnL ≤ `-MAX_DRAWDOWN_USD` |
| **Auto-flatten on halt** | none | On a **latched** halt (drawdown / manual), closes the residual position with a reduce-only IOC (taker) — no manual close needed. Transient halts pause instead (see below) |
| **Inventory cap** | soft close-mode only | Hard `MAX_INVENTORY_USD` — blocks the side that grows the position past the cap |
| **Inventory skew** | none (just disables one side) | Shifts fair price against inventory so the bot actively mean-reverts its position |
| **Spread** | fixed 8 bps | Dynamic: widens with realized volatility (`VOL_SPREAD_MULT`, capped at `MAX_SPREAD_BPS`) |
| **Take-profit** | 0.1 bps (often < fees) | 3 bps default — actually covers costs |
| **Funding** | ignored | Polls Binance funding, biases quotes to avoid paying funding (`FUNDING_AWARE`) |
| **Anti-trend guard** | none | Detects signed directional drift; widens then **pauses** the against-trend side so it stops feeding a falling knife / selling into a rocket (`ANTI_TREND_GUARD`) |
| **Stale feeds** | 60 s reconnect only | Pauses quoting if any feed is older than `STALE_FEED_MS` (default 5 s), then **auto-resumes** once feeds are fresh again — no manual restart |
| **Error handling** | logs & retries | Benign exchange rejects (post-only would-cross, cancel-of-gone, min-size) are treated as **transient** and ignored. Real failures halt after `MAX_CONSECUTIVE_ERRORS` and **auto-recover** on the next clean cycle |
| **Defaults** | `orderSize=3000`, `closeThreshold=10` (1 fill → instant close mode) | Sane, fully `.env`-driven |
| **Backtesting** | none | `npm run backtest` — multi-day Binance 1m klines (paginated, 7–30+ d) + trend-stress metrics |
| **Node version** | requires Node ≥ 25 | Runs on Node ≥ 22 via a small hex polyfill |

## How it works

1. Builds a **fair price** = `binance_mid + median(01_mid − binance_mid)` over a rolling window.
2. Applies **inventory skew** and **funding skew** to that fair price.
3. Quotes bid = `fair − halfSpread`, ask = `fair + halfSpread`, where `halfSpread` grows with volatility.
4. **Anti-trend guard**: measures signed directional drift (least-squares slope over `VOL_WINDOW_SEC`). Above `TREND_DRIFT_THRESHOLD_BPS` it widens the against-trend side; above `TREND_PAUSE_DRIFT_BPS` it stops quoting that side entirely — so the bot never keeps buying a falling knife or selling into a rocket. Chop (high vol, no net drift) is ignored, so it doesn't kill normal market making.
5. As inventory builds, skew leans the bot toward reducing; past `CLOSE_THRESHOLD_USD` it goes close-only; at `MAX_INVENTORY_USD` it hard-blocks the growing side.
6. The **RiskManager** tracks realized PnL, feed staleness, and errors. **Latched** halts (drawdown, manual) cancel orders **and flatten** the position, then stay down until restart. **Transient** halts (stale feed, error burst) just pause quoting and **auto-recover** once the cause clears — no position dump, no manual restart.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — set PRIVATE_KEY (base58 Solana key with a funded 01.xyz account)
```

## Backtest first (always)

```bash
npm run backtest -- BTC 7 200
#                    ^sym ^days ^orderSizeUsd
```

The 2nd arg is now **days of 1m history** (`≤ 90`). It paginates Binance klines
backwards (1500-bar cap per call) so you can stress-test **7–30+ day windows**, not
just a single 25-hour slice. A raw bar count `> 90` still works for backwards compat.

```bash
npm run backtest -- BTC 7 200    # ~7 days  (10,080 bars)
npm run backtest -- SOL 14 200   # ~14 days (20,160 bars)
npm run backtest -- BTC 30 200   # ~30 days (43,200 bars)
```

**Why multi-day matters:** a market maker bleeds in *trends*, not chop. A 1-day backtest
is usually chop → false comfort. A 14-day window that contains a real selloff/rally is
where you find out whether the anti-trend guard + inventory cap actually hold.

Output adds a **TREND STRESS** block:

- `peak inventory` — largest |position| reached (vs your cap). The real trend-risk number.
- `worst unrealized` — deepest the open position went underwater (mark-to-market).
- `guard-paused` / `at inv cap` — how often the defenses engaged.

> ⚠️ **Read the right number.** The `guard-paused %` is **inflated in backtest** — it
> feeds 1m closes into a 60s vol window (1 sample/min), so the drift slope is far noisier
> than the per-second ticks the live bot sees. Judge trend risk by **peak inventory,
> worst unrealized, and whether the halt fired** — not the pause %.

Tune `.env`, re-run, repeat. **Maker-only fill model, no queue/slippage — directional sanity check only, not a profit guarantee.**

## Run live

Run `npm run bot` in a terminal and an **interactive setup wizard** asks you:

1. how many pairs to market-make
2. which pairs (defaults offered, `BTC-PERP` / `ethusdt` style accepted)
3. margin per entry in USD (before leverage)

```bash
npm run bot                 # interactive wizard (TTY)
```

Leverage is never asked: 01.xyz is cross-margin and leverage is fixed per market
(max = `1/imf`, "rata kanan"). The bot only sizes orders as `notional = margin / imf`.

**Skip the wizard** (Docker/CI/scripted) — pass symbols or set `NON_INTERACTIVE=1`,
and margin comes from `MARGIN_PER_ENTRY_USD` in `.env`:

```bash
npm run bot -- BTC ETH SOL        # explicit list, no wizard
npm run bot -- BTC                # single market, no wizard
NON_INTERACTIVE=1 npm run bot     # SYMBOLS env / default, no wizard
SYMBOLS=BTC,ETH NON_INTERACTIVE=1 npm run bot
```


**Sizing:** each entry commits `MARGIN_PER_ENTRY_USD` (default **$2**) of margin.
The order notional is auto-derived per market from its initial-margin fraction
(`imf`): `notional = margin / imf`. Example: imf 2% (50x) → $2 margin = $100
notional; imf 5% (20x) → $2 margin = $40 notional. The bot does **not** set
leverage — 01.xyz is cross-margin and leverage is fixed per market (max = 1/imf).

`Ctrl+C` cancels all open orders across every market and exits cleanly.

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
- `MARGIN_PER_ENTRY_USD` — margin committed per entry (default $2). Notional auto-derived per market via `notional = margin / imf`.
- `ORDER_SIZE_USD` — fallback per-side notional, used only when `MARGIN_PER_ENTRY_USD=0`.
- `SYMBOLS` — comma-separated markets to run in one process (default `BTC,ETH,SOL`).

## Risk disclaimer

Market making on a perp DEX can lose money, especially in trending or illiquid markets, during feed outages, or on liquidations. This software is provided as-is, no warranty. You are responsible for your own funds. Test on small size first.

## License

MIT
