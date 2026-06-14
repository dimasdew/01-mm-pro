// Demo: drive the real logger + RiskManager with simulated fills so you can
// see exactly what the live terminal output looks like (incl. the margin-based
// sizing line and the TOTAL PROFIT box). Mirrors a multi-symbol run.
// Run: npm run logdemo
import { RiskManager } from "../bots/mm/risk.js";
import { log } from "../utils/logger.js";

interface DemoMarket {
	symbol: string;
	binance: string;
	imf: number; // initial-margin fraction (e.g. 0.02 = 50x max)
	fair: number;
	risk: RiskManager;
	seq: Array<["bid" | "ask", number, number]>;
}

const MARGIN_PER_ENTRY = 5; // USD before leverage (rata kanan)

function mkRisk(): RiskManager {
	return new RiskManager({
		maxInventoryUsd: 1000,
		maxDrawdownUsd: 50,
		staleFeedMs: 5000,
		maxConsecutiveErrors: 5,
	});
}

const markets: DemoMarket[] = [
	{
		symbol: "BTC-PERP",
		binance: "btcusdt",
		imf: 0.02, // 50x
		fair: 64200,
		risk: mkRisk(),
		seq: [
			["bid", 0.003, 64180],
			["ask", 0.003, 64225],
			["bid", 0.003, 64150],
			["bid", 0.003, 64140],
			["ask", 0.003, 64210],
			["ask", 0.003, 64230],
			["bid", 0.004, 64190],
		],
	},
	{
		symbol: "SOL-PERP",
		binance: "solusdt",
		imf: 0.05, // 20x
		fair: 146.2,
		risk: mkRisk(),
		seq: [
			["bid", 0.68, 146.05],
			["ask", 0.68, 146.4],
			["bid", 0.68, 145.9],
			["ask", 0.68, 146.35],
			["bid", 0.68, 145.8],
		],
	},
];

function statusNow(
	m: DemoMarket,
	mark: number,
	bid: number | null,
	ask: number | null,
	vol: number,
) {
	const s = m.risk.getStats(mark);
	log.status({
		symbol: m.symbol,
		mark,
		posBase: s.invBase,
		posUsd: s.invBase * mark,
		avgEntry: s.avgEntry,
		realizedPnl: s.realizedPnl,
		unrealizedPnl: s.unrealizedPnl,
		totalPnl: s.totalPnl,
		fillCount: s.fillCount,
		volumeUsd: s.volumeUsd,
		volBps: vol,
		uptimeSec: s.uptimeSec,
		bid,
		ask,
		halted: s.halted,
	});
}

log.banner();
log.info("Multi-symbol market maker — markets: BTC, SOL");

// ── per-market init: shows the margin→imf sizing line you see live ──
for (const m of markets) {
	const maxLev = 1 / m.imf;
	const notional = MARGIN_PER_ENTRY / m.imf;
	log.info(
		`[${m.symbol}] imf=${m.imf} | maxLev=${maxLev.toFixed(1)}x | margin/entry=$${MARGIN_PER_ENTRY} | order notional=$${notional.toFixed(2)}`,
	);
	log.config({
		Market: m.symbol,
		Binance: m.binance,
		Spread: "8 bps (dyn: true)",
		"Order Size": `$${notional.toFixed(2)} (margin/entry $${MARGIN_PER_ENTRY})`,
		"Max Drawdown": "$50",
	});
}

log.info("Warming up price feeds...");
log.info("Running 2/2 markets: BTC, SOL.");

// ── simulate fills per market ──
for (const m of markets) {
	for (const [side, size, price] of m.seq) {
		m.risk.applyFill(side, size, price);
		log.fill(side === "bid" ? "buy" : "sell", price, size);
	}
}

// ── status boxes (what prints every status interval) ──
const btc = markets[0];
const sol = markets[1];

statusNow(btc, 64205, 64190.5, 64210.5, 6.2);
statusNow(sol, 146.25, 146.18, 146.32, 7.4);

log.info("");
log.info("... a bit later, prices drift ...");
statusNow(btc, 64260, 64248.0, 64272.0, 5.1);
statusNow(sol, 146.6, 146.52, 146.68, 6.8);

console.log("\n(demo only — no live orders placed)\n");
