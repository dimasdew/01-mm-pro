// Backtest harness — simulates the PRO market-maker strategy against historical
// Binance Futures 1m klines. This is an APPROXIMATION, not a guarantee:
//   - Fill model: a resting quote at price P fills if the bar's high/low crosses P.
//   - We assume maker fills (no taker fee) and ignore queue position / partial fills.
//   - Fair price = bar close (proxy; live uses 01-vs-Binance offset).
// Purpose: sanity-check that risk guards engage and that the strategy isn't
// obviously bleeding before risking real funds. Treat results as directional only.
//
// Usage: npm run backtest -- BTC 1000 200
//   args: <symbol> <days*1440 bars max via limit> <orderSizeUsd>

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

async function fetchKlines(symbol: string, limit: number): Promise<Kline[]> {
	const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=${Math.min(limit, 1500)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
	const raw = (await res.json()) as unknown[][];
	return raw.map((k) => ({
		ts: Number(k[0]),
		open: Number(k[1]),
		high: Number(k[2]),
		low: Number(k[3]),
		close: Number(k[4]),
	}));
}

interface SimResult {
	bars: number;
	fills: number;
	finalPnl: number;
	maxDrawdown: number;
	halted: string | null;
	finalInvBase: number;
	feesPaid: number;
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

	// 01.xyz: maker ~0bps, taker ~ small. We model a tiny round-trip cost.
	const makerFeeBps = 0;

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

		const bidPrice = skewedFair * (1 - half / 10000);
		const askPrice = skewedFair * (1 + half / 10000);

		const atCap = Math.abs(invUsd) >= cfg.maxInventoryUsd;
		const isLong = invBase > 0;

		// allowed sides
		const allowBid = inCloseMode ? !isLong : !(atCap && isLong);
		const allowAsk = inCloseMode ? isLong : !(atCap && !isLong);

		const sizeBase = cfg.orderSizeUsd / fair;
		const closeSize = Math.abs(invBase);

		// Fill model: bid fills if bar low <= bidPrice; ask fills if bar high >= askPrice.
		// Process the side that improves inventory first to be conservative.
		const tryFill = (side: "bid" | "ask", price: number, size: number) => {
			if (size <= 0) return;
			const filled = side === "bid" ? bar.low <= price : bar.high >= price;
			if (!filled) return;

			fills++;
			feesPaid += price * size * (makerFeeBps / 10000);
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
	}

	return {
		bars: klines.length,
		fills,
		finalPnl: realizedPnl - feesPaid,
		maxDrawdown,
		halted: risk.getHaltReason(),
		finalInvBase: invBase,
		feesPaid,
	};
}

async function main(): Promise<void> {
	const symbol = (process.argv[2] ?? "BTC").toUpperCase();
	const limit = Number(process.argv[3] ?? 1500);
	const orderSize = process.argv[4];
	if (orderSize) process.env.ORDER_SIZE_USD = orderSize;

	const binanceSymbol = `${symbol}USDT`;
	const cfg = loadConfig(symbol);

	console.log(`\n=== Backtest: ${symbol} (${limit} 1m bars) ===`);
	console.log(
		`config: spread=${cfg.spreadBps}bps dyn=${cfg.dynamicSpread} tp=${cfg.takeProfitBps}bps size=$${cfg.orderSizeUsd} maxInv=$${cfg.maxInventoryUsd} maxDD=$${cfg.maxDrawdownUsd} skew=${cfg.inventorySkewBps}bps`,
	);

	const klines = await fetchKlines(binanceSymbol, limit);
	console.log(`fetched ${klines.length} bars\n`);

	const r = simulate(klines, cfg);
	console.log("--- RESULT ---");
	console.log(`bars:          ${r.bars}`);
	console.log(`fills:         ${r.fills}`);
	console.log(`realized PnL:  $${r.finalPnl.toFixed(2)}`);
	console.log(`fees paid:     $${r.feesPaid.toFixed(2)}`);
	console.log(`max drawdown:  $${r.maxDrawdown.toFixed(2)}`);
	console.log(`final inv:     ${r.finalInvBase.toFixed(6)} ${symbol}`);
	console.log(`halted:        ${r.halted ?? "no"}`);
	console.log(
		`\nNOTE: maker-only fill model, no queue/slippage. Directional sanity check only — NOT a profit guarantee.\n`,
	);
}

main().catch((err) => {
	console.error("Backtest error:", err);
	process.exit(1);
});
