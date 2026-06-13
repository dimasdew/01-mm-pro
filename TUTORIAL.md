# 01-mm-pro — Tutorial Dari Nol Sampai Jalan

Panduan lengkap setup & jalanin market maker di **01 Exchange** (Solana).
Ditulis buat dijalanin di cmux / terminal apa pun.

> ⚠️ **Baca dulu:** ini *market maker*, bukan bot directional. Dia ngambil spread bid/ask
> dan punya **inventory risk**. Bisa profit di market sideways, bisa rugi gede di market trending.
> **Backtest dulu, mulai dengan size kecil.** Gak ada strategi 100% winrate.

---

## 0. Prasyarat

| Yang dibutuhin | Cara cek |
|---|---|
| **Node.js ≥ 22** | `node -v` (harus v22 atau lebih tinggi) |
| **npm** | `npm -v` |
| **git** | `git --version` |
| **Wallet Solana** (private key base58) | Phantom / Solflare / dll |
| **Akun 01.xyz yang udah di-fund** | Login ke https://01.xyz, deposit USDC |

Kalau Node masih < 22, install dulu:
```bash
# pakai nvm (recommended)
nvm install 22 && nvm use 22
```

---

## 1. Clone repo

```bash
git clone https://github.com/dimasdew/01-mm-pro.git
cd 01-mm-pro
```

---

## 2. Install dependencies

```bash
npm install
```

Tunggu sampai selesai (sekitar 120 package). Kalau ada warning vuln, abaikan dulu — gak ngeblok.

---

## 3. Cek semua kebuild bener (typecheck)

```bash
npm run typecheck
```

Harus **0 error**. Kalau error, stop di sini — jangan lanjut.

---

## 4. Lihat tampilan log dulu (tanpa duit, tanpa order)

Biar lo tau output-nya kayak apa sebelum konek wallet:

```bash
npm run logdemo
```

Bakal muncul status box simulasi:
```
╔══════════════════════════════════════════╗
║   01-mm-pro · risk-managed market maker   ║
╚══════════════════════════════════════════╝
┌─ BTC-PERP ─ 0s uptime ─
│ mark  $64260.00   quotes $64248.00 / $64272.00   vol 5.1bps
│ pos   LONG 0.0040 @ $64190.00
│ pnl   realized +$0.59  unrealized +$0.28
│ TOTAL +$0.87   7 fills · $1412 vol
└────────────────────────────────────────
```
**Ini cuma demo — gak ada order beneran yang dipasang.** Aman.

---

## 5. Backtest DULU (WAJIB sebelum live)

Test strategi lawan data historis Binance 1m sebelum risiko duit beneran:

```bash
npm run backtest -- BTC 1500 200
#                    ^sym ^bars ^orderSizeUsd
```

- `BTC` = simbol
- `1500` = jumlah candle 1-menit (= 25 jam data)
- `200` = order size USD per side

Output: jumlah fills, realized PnL, max drawdown, dan apakah risk halt sempet kepicu.

> ⚠️ **Penting:** backtest pakai maker-only fill model, **tanpa queue/slippage**.
> Ini cuma sanity check arah, **BUKAN jaminan profit**. Hasil live bakal beda.

Tune `.env` (step berikutnya), re-run backtest, ulangi sampai keliatan masuk akal.

---

## 6. Setup `.env` (config + wallet)

```bash
cp .env.example .env
```

Edit `.env`, **WAJIB isi `PRIVATE_KEY`** (private key base58 wallet Solana yang udah punya akun 01.xyz ter-fund):

```env
PRIVATE_KEY=<base58_private_key_lo>
```

### Cara ambil private key base58:
- **Phantom**: Settings → Manage Account → Show Private Key → (formatnya udah base58)
- **Solflare**: Settings → Export Private Key
- Jangan share key ini ke siapa pun. File `.env` udah di-`.gitignore`, gak bakal ke-push.

### Knob penting buat pemula (mulai KECIL):

```env
SYMBOLS=BTC,ETH,SOL      # market yang dijalanin bareng dalam 1 proses
MARGIN_PER_ENTRY_USD=2   # margin per entry (USD). Notional = margin / imf, auto per-coin
MAX_INVENTORY_USD=200    # posisi maks yang lo toleransi
MAX_DRAWDOWN_USD=10      # KILL SWITCH: stop + cancel kalau rugi sesi capai ini
SPREAD_BPS=8             # half-spread dari fair price
TAKE_PROFIT_BPS=3        # half-spread di close mode (harus nutup fee)
```

**Soal size & leverage:** lo cukup set `MARGIN_PER_ENTRY_USD` (default $2). Bot
auto-hitung notional order per market dari `imf` (initial-margin fraction):
`notional = margin / imf`. Contoh imf BTC 2% (50x) → $2 = $100 notional; imf SOL
5% (20x) → $2 = $40 notional. Bot **gak** ngeset leverage — 01.xyz cross-margin,
leverage fixed per market (maks = 1/imf), ikut setting akun lo apa adanya.

Default lain udah sane, biarin aja sampe lo paham. Detail tiap knob ada di `.env.example`.

---

## 7. Jalankan LIVE (taruh order beneran)

Tinggal `npm run bot` — bakal muncul **wizard** yang nanya 3 hal:

```
Mau berapa pair?            -> jumlah, mis. 2
Pair apa aja?               -> BTC ETH  (BTC-PERP / ethusdt juga kebaca)
Margin per entry berapa $?  -> $ sebelum leverage, mis. 5
```

Abis itu recap + konfirmasi `y/n`. Leverage GAK ditanya — 01.xyz cross-margin,
leverage = rata kanan (max per market = `1/imf`). Bot cuma ngitung
`notional = margin / imf` per coin otomatis.

```bash
npm run bot                 # wizard interaktif (default kalau di terminal)
```

Mau skip wizard (buat Docker / scripted)? Kasih symbol langsung atau set
`NON_INTERACTIVE=1`, margin diambil dari `MARGIN_PER_ENTRY_USD` di `.env`:

```bash
npm run bot -- BTC ETH SOL     # pilih sendiri, no wizard
npm run bot -- BTC             # 1 market, no wizard
NON_INTERACTIVE=1 npm run bot  # baca SYMBOLS env / default, no wizard
```

- Multi-symbol jalan bareng dalam **1 proses**, share 1 wallet session.
- `Ctrl+C` cancel SEMUA order di semua market, exit aman.
- Bot bakal konek wallet → fund → mulai quoting bid/ask.
- Status box update real-time (kayak demo di step 4, tapi ini beneran).

### Stop bot dengan aman:
```
Ctrl + C
```
Ini **cancel semua open order** lalu exit bersih. Jangan force-kill (`kill -9`) — bisa ninggalin order nyangkut.

---

## 8. Cara kerja singkat (biar paham yang dilihat)

1. **Fair price** = `binance_mid + median(01_mid − binance_mid)` (rolling window).
2. Kena **inventory skew** + **funding skew** → fair price digeser.
3. Quote: bid = `fair − halfSpread`, ask = `fair + halfSpread`. Spread melebar pas volatil.
4. Pas inventory numpuk → bot condong nutup. Lewat `CLOSE_THRESHOLD_USD` → close-only.
   Di `MAX_INVENTORY_USD` → hard-block sisi yang nambah posisi.
5. **RiskManager** pantau PnL, feed staleness, error. Kalau limit kelewat → **halt + auto-flatten**
   (tutup posisi sisa pakai reduce-only IOC, gak perlu tutup manual).

---

## 9. Jalan 24/7 di server (opsional, Docker)

Buat VPS yang harus nyala terus walau crash/reboot. **Pakai restart policy, BUKAN cron** —
MM harus jalan nonstop (WebSocket fill live, refresh quote real-time, risk halt always-on).

```bash
cp .env.example .env   # set PRIVATE_KEY dll

# Opsi A — docker compose (recommended VPS):
docker compose up -d --build    # start background, auto-restart
docker compose logs -f          # tail log
docker compose down             # stop (graceful: cancel order)

# Opsi B — plain docker:
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

---

## 10. Troubleshooting

| Masalah | Solusi |
|---|---|
| `Missing required environment variable: PRIVATE_KEY` | Belum isi `PRIVATE_KEY` di `.env`, atau lupa `cp .env.example .env` |
| Typecheck error | Node < 22? Cek `node -v`, upgrade ke 22+ |
| Bot halt langsung "drawdown" | `MAX_DRAWDOWN_USD` kekecilan buat size lo, atau market lagi trending kenceng |
| Order gak kepasang | Akun 01.xyz belum di-fund, atau saldo USDC kurang |
| "stale feed" halt | Koneksi internet/WS ke 01 atau Binance putus-putus |

---

## Urutan singkat (TL;DR)

```bash
git clone https://github.com/dimasdew/01-mm-pro.git && cd 01-mm-pro
npm install
npm run typecheck          # harus 0 error
npm run logdemo            # lihat tampilan (aman, no order)
npm run backtest -- BTC 1500 200   # test dulu
cp .env.example .env       # isi PRIVATE_KEY + margin kecil
npm run bot                # LIVE BTC,ETH,SOL — Ctrl+C buat stop aman
```

**Mulai dengan `MARGIN_PER_ENTRY_USD` kecil (default $2). Naikin pelan-pelan kalau udah paham perilakunya.**
