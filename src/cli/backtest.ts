// Backtest harness — simulates the PRO market-maker strategy against historical
// Binance Futures 1m klines. This is an APPROXIMATION, not a guarantee:
//   - Fill model: a resting quote at price P fills if the bar's high/low crosses P.
//   - We assume maker fills (no taker fee) and ignore queue position / partial fills.
//   - Fair price = bar close (proxy; live uses 01-vs-Binance offset).
// Purpose: sanity-check that risk guards engage and that the strategy isn't
// obviously bleeding before risking real funds. Treat results as directional only.
//
// Usage: npm run backtest -- BTC 30 200
//   args: <symbol> <days> <orderSizeUsd>
//   <days> = how many days of 1m history to fetch (paginated, ~1440 bars/day).
//   Use a long window (7-30d) to stress-test trend/inventory risk — a single
//   day is usually chop and hides how the bot behaves in a sustained trend.

import { loadConfig } from "../bots/mm/config.js";
import { RiskManager } from "../bots/mm/risk.js";
import { VolatilityEstimator } from "../pricing/volatility.js";

interface Kline {
	open: number;
	high: number;
	low: number;
	close: number;
	ts: number;
}

const BINANCE_MAX_LIMIT = 1500; // per-request hard cap
const MINUTE_MS = 60_000;

// Fetch up to `totalBars` of 1m klines, paginating backwards via endTime since
// Binance caps a single response at 1500 candles. Returns chronological order.
async function fetchKlines(
	symbol: string,
	totalBars: number,
): Promise<Kline[]> {
	const sym = symbol.toUpperCase();
	const out: Kline[] = [];
	let endTime: number | null = null; // ms; null = now
	let remaining = totalBars;

	while (remaining > 0) {
		const limit = Math.min(remaining, BINANCE_MAX_LIMIT);
		let url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&limit=${limit}`;
		if (endTime !== null) url += `&endTime=${endTime}`;

		const res = await fetch(url);
		if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
		const raw = (await res.json()) as unknown[][];
		if (raw.length === 0) break; // no more history

		const batch: Kline[] = raw.map((k) => ({
			ts: Number(k[0]),
			open: Number(k[1]),
			high: Number(k[2]),
			low: Number(k[3]),
			close: Number(k[4]),
		}));

		// Prepend older batch ahead of what we already have.
		out.unshift(...batch);
		remaining -= batch.length;

		// Next page ends just before this batch's oldest candle.
		const oldestTs = batch[0].ts;
		endTime = oldestTs - MINUTE_MS;

		if (batch.length < limit) break; // exchange ran out of history
		// Gentle pacing to stay well under Binance weight limits.
		await new Promise((r) => setTimeout(r, 120));
	}

	// De-dup by timestamp (endTime windows can overlap by one candle) + sort.
	const seen = new Set<number>();
	const deduped = out.filter((k) => {
		if (seen.has(k.ts)) return false;
		seen.add(k.ts);
		return true;
	});
	deduped.sort((a, b) => a.ts - b.ts);
	return deduped;
}

interface SimResult {
	bars: number;
	fills: number;
	finalPnl: number;
	maxDrawdown: number;
	halted: string | null;
	finalInvBase: number;
	feesPaid: number;
	// trend-stress metrics
	peakInventoryUsd: number; // largest |inventory| reached (USD) — trend risk proxy
	worstUnrealizedUsd: number; // most negative mark-to-market on open inventory
	guardPauseBars: number; // bars where the anti-trend guard paused a side
	capHitBars: number; // bars where inventory sat at the hard cap
}

function simulate(
	klines: Kline[],
	cfg: ReturnType<typeof loadConfig>,
): SimResult {
	const vol = new VolatilityEstimator(cfg.volWindowSec * 1000);
	const risk = new RiskManager({
		maxInventoryUsd: cfg.maxInventoryUsd,
		maxDrawdownUsd: cfg.maxDrawdownUsd,
		staleFeedMs: cfg.staleFeedMs,
		maxConsecutiveErrors: cfg.maxConsecutiveErrors,
	});

	let invBase = 0;
	let avgEntry = 0;
	let realizedPnl = 0;
	let fills = 0;
	let feesPaid = 0;
	let peakPnl = 0;
	let maxDrawdown = 0;
	let peakInventoryUsd = 0;
	let worstUnrealizedUsd = 0;
	let guardPauseBars = 0;
	let capHitBars = 0;

	// 01.xyz: maker ~0bps. Close-mode exits cross the book (taker IOC) so model a
	// small taker cost on closing fills to avoid overstating PnL.
	const makerFeeBps = 0;
	const takerFeeBps = Number(process.env.BACKTEST_TAKER_FEE_BPS ?? 2);

	for (const bar of klines) {
		vol.addSample(bar.close);
		if (risk.isHalted()) break;

		const fair = bar.close;
		const invUsd = invBase * fair;

		// Dynamic spread
		const volBps = vol.getVolBps();
		const baseHalf = cfg.dynamicSpread
			? Math.min(cfg.spreadBps + volBps * cfg.volSpreadMult, cfg.maxSpreadBps)
			: cfg.spreadBps;

		// Inventory skew (mirror of quoter)
		const invFrac =
			cfg.maxInventoryUsd > 0
				? Math.max(-1, Math.min(1, invUsd / cfg.maxInventoryUsd))
				: 0;
		const skewBps = -invFrac * cfg.inventorySkewBps;
		const skewedFair = fair * (1 + skewBps / 10000);

		const inCloseMode = Math.abs(invUsd) >= cfg.closeThresholdUsd;
		const half = inCloseMode ? cfg.takeProfitBps : baseHalf;

		// Anti-trend guard (mirror of quoter.trendGuard). Disabled in close mode.
		// Up-trend (drift>0) adversely selects the ASK => widen/pause ASK.
		// Down-trend (drift<0) adversely selects the BID => widen/pause BID.
		const driftBps = vol.getDriftBps();
		let extraBidBps = 0;
		let extraAskBps = 0;
		let pauseBid = false;
		let pauseAsk = false;
		if (cfg.antiTrendGuard && !inCloseMode) {
			const mag = Math.abs(driftBps);
			if (mag >= cfg.trendDriftThresholdBps) {
				const pause = mag >= cfg.trendPauseDriftBps;
				const extra = Math.min(
					(mag - cfg.trendDriftThresholdBps) * cfg.trendSpreadMult,
					cfg.maxSpreadBps,
				);
				if (driftBps > 0) {
					extraAskBps = extra;
					pauseAsk = pause;
				} else {
					extraBidBps = extra;
					pauseBid = pause;
				}
			}
		}

		const bidHalf = Math.min(half + extraBidBps, cfg.maxSpreadBps);
		const askHalf = Math.min(half + extraAskBps, cfg.maxSpreadBps);
		const bidPrice = skewedFair * (1 - bidHalf / 10000);
		const askPrice = skewedFair * (1 + askHalf / 10000);

		const atCap = Math.abs(invUsd) >= cfg.maxInventoryUsd;
		const isLong = invBase > 0;

		// allowed sides — guard pause gates a side independently of inventory state
		const allowBid = !pauseBid && (inCloseMode ? !isLong : !(atCap && isLong));
		const allowAsk = !pauseAsk && (inCloseMode ? isLong : !(atCap && !isLong));

		const sizeBase = cfg.orderSizeUsd / fair;
		const closeSize = Math.abs(invBase);

		// Fill model: bid fills if bar low <= bidPrice; ask fills if bar high >= askPrice.
		// Process the side that improves inventory first to be conservative.
		const tryFill = (side: "bid" | "ask", price: number, size: number) => {
			if (size <= 0) return;
			const filled = side === "bid" ? bar.low <= price : bar.high >= price;
			if (!filled) return;

			fills++;
			// Maker fee on normal quotes; taker fee on close-mode exits (cross IOC).
			const feeBps = inCloseMode ? takerFeeBps : makerFeeBps;
			feesPaid += price * size * (feeBps / 10000);
			const signed = side === "bid" ? size : -size;
			const prev = invBase;
			const newBase = prev + signed;
			const sameDir = prev === 0 || Math.sign(prev) === Math.sign(signed);
			if (sameDir) {
				const tot = Math.abs(prev) + Math.abs(signed);
				if (tot > 0)
					avgEntry =
						(Math.abs(prev) * avgEntry + Math.abs(signed) * price) / tot;
			} else {
				const closedAbs = Math.min(Math.abs(prev), Math.abs(signed));
				const dir = Math.sign(prev);
				realizedPnl += dir * (price - avgEntry) * closedAbs;
				if (Math.abs(signed) > Math.abs(prev)) avgEntry = price;
			}
			invBase = newBase;
			if (Math.abs(invBase) < 1e-12) {
				invBase = 0;
				avgEntry = 0;
			}
			risk.applyFill(side, size, price);
		};

		if (inCloseMode) {
			if (allowBid) tryFill("bid", bidPrice, closeSize);
			if (allowAsk) tryFill("ask", askPrice, closeSize);
		} else {
			if (allowBid) tryFill("bid", bidPrice, sizeBase);
			if (allowAsk) tryFill("ask", askPrice, sizeBase);
		}

		// Mark-to-market drawdown tracking (realized only, conservative)
		const totalPnl = realizedPnl - feesPaid;
		peakPnl = Math.max(peakPnl, totalPnl);
		maxDrawdown = Math.max(maxDrawdown, peakPnl - totalPnl);

		// Trend-stress metrics: how big inventory got and how deep the open
		// position went underwater (mark-to-market vs avg entry).
		const invUsdNow = invBase * fair;
		peakInventoryUsd = Math.max(peakInventoryUsd, Math.abs(invUsdNow));
		if (invBase !== 0 && avgEntry > 0) {
			const unrealized = (fair - avgEntry) * invBase; // long: + if up
			worstUnrealizedUsd = Math.min(worstUnrealizedUsd, unrealized);
		}
		if (pauseBid || pauseAsk) guardPauseBars++;
		if (atCap) capHitBars++;
	}

	return {
		bars: klines.length,
		fills,
		finalPnl: realizedPnl - feesPaid,
		maxDrawdown,
		halted: risk.getHaltReason(),
		finalInvBase: invBase,
		feesPaid,
		peakInventoryUsd,
		worstUnrealizedUsd,
		guardPauseBars,
		capHitBars,
	};
}

async function main(): Promise<void> {
	const symbol = (process.argv[2] ?? "BTC").toUpperCase();
	// arg can be days (<=90) or a raw bar count for backwards compat (>90).
	const arg = Number(process.argv[3] ?? 7);
	const days = arg <= 90 ? arg : Math.ceil(arg / 1440);
	const totalBars = arg <= 90 ? Math.round(arg * 1440) : Math.round(arg);
	const orderSize = process.argv[4];
	if (orderSize) process.env.ORDER_SIZE_USD = orderSize;

	const binanceSymbol = `${symbol}USDT`;
	const cfg = loadConfig(symbol);

	console.log(
		`\n=== Backtest: ${symbol} (~${days}d / ${totalBars} 1m bars) ===`,
	);
	console.log(
		`config: spread=${cfg.spreadBps}bps dyn=${cfg.dynamicSpread} tp=${cfg.takeProfitBps}bps size=$${cfg.orderSizeUsd} maxInv=$${cfg.maxInventoryUsd} maxDD=$${cfg.maxDrawdownUsd} skew=${cfg.inventorySkewBps}bps guard=${cfg.antiTrendGuard}`,
	);

	const klines = await fetchKlines(binanceSymbol, totalBars);
	if (klines.length === 0) {
		console.error("No klines fetched — check symbol.");
		process.exit(1);
	}
	const spanDays = (
		(klines[klines.length - 1].ts - klines[0].ts) /
		86_400_000
	).toFixed(1);
	const firstClose = klines[0].close;
	const lastClose = klines[klines.length - 1].close;
	const netMovePct = (((lastClose - firstClose) / firstClose) * 100).toFixed(2);
	console.log(
		`fetched ${klines.length} bars over ${spanDays}d — price ${firstClose} -> ${lastClose} (${netMovePct}% net move)\n`,
	);

	const r = simulate(klines, cfg);
	const guardPausePct = ((r.guardPauseBars / r.bars) * 100).toFixed(1);
	const capHitPct = ((r.capHitBars / r.bars) * 100).toFixed(1);
	console.log("--- RESULT ---");
	console.log(`bars:            ${r.bars}`);
	console.log(`fills:           ${r.fills}`);
	console.log(`realized PnL:    $${r.finalPnl.toFixed(2)}`);
	console.log(`fees paid:       $${r.feesPaid.toFixed(2)}`);
	console.log(`max drawdown:    $${r.maxDrawdown.toFixed(2)}`);
	console.log(`final inv:       ${r.finalInvBase.toFixed(6)} ${symbol}`);
	console.log(`halted:          ${r.halted ?? "no"}`);
	console.log("--- TREND STRESS ---");
	console.log(
		`peak inventory:  $${r.peakInventoryUsd.toFixed(2)} (cap $${cfg.maxInventoryUsd})`,
	);
	console.log(`worst unrealized: $${r.worstUnrealizedUsd.toFixed(2)}`);
	console.log(`guard-paused:    ${r.guardPauseBars} bars (${guardPausePct}%)`);
	console.log(`at inv cap:      ${r.capHitBars} bars (${capHitPct}%)`);
	console.log(
		`\nNOTE: maker-only fill model, no queue/slippage. Directional sanity check only — NOT a profit guarantee.`,
	);
	console.log(
		`NOTE: guard-pause % is INFLATED here — backtest feeds 1m closes into a ${cfg.volWindowSec}s vol window (1 sample/min), so the drift slope is far noisier than live per-second ticks. Read peak-inventory / worst-unrealized / halts for trend risk, NOT the pause %.\n`,
	);
}

main().catch((err) => {
	console.error("Backtest error:", err);
	process.exit(1);
});
