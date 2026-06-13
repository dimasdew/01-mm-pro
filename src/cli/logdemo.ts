// Demo: drive the real logger + RiskManager with simulated fills so you can
// see exactly what the live terminal output looks like (incl. TOTAL PROFIT).
// Run: npm run logdemo
import { RiskManager } from "../bots/mm/risk.js";
import { log } from "../utils/logger.js";

const risk = new RiskManager({
	maxInventoryUsd: 1000,
	maxDrawdownUsd: 50,
	staleFeedMs: 5000,
	maxConsecutiveErrors: 5,
});

const SYMBOL = "BTC-PERP";

function statusNow(
	mark: number,
	bid: number | null,
	ask: number | null,
	vol: number,
) {
	const s = risk.getStats(mark);
	log.status({
		symbol: SYMBOL,
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
log.config({
	Market: SYMBOL,
	Binance: "btcusdt",
	Spread: "8 bps (dyn: true)",
	"Order Size": "$200",
	"Max Drawdown": "$50",
});

log.info("Warming up price feeds...");
log.info("Ready! Fair price: $64200.00");

// Simulate a profitable ranging session: buy low, sell high, repeat.
const seq: Array<["bid" | "ask", number, number]> = [
	["bid", 0.003, 64180], // buy
	["ask", 0.003, 64225], // sell  -> realize +
	["bid", 0.003, 64150], // buy
	["bid", 0.003, 64140], // buy more
	["ask", 0.003, 64210], // sell  -> realize +
	["ask", 0.003, 64230], // sell  -> realize +
	["bid", 0.004, 64190], // buy (open inventory, unrealized)
];

let mark = 64200;
for (const [side, size, price] of seq) {
	risk.applyFill(side, size, price);
	log.fill(side === "bid" ? "buy" : "sell", price, size);
}

log.position(0.004, 0.004 * 64205, true, false);
log.quote(64190.5, 64210.5, 64200.5, 6.2, "normal");

mark = 64205;
statusNow(mark, 64190.5, 64210.5, 6.2);

// A bit later, price drifted up — unrealized improves.
mark = 64260;
log.info("");
statusNow(mark, 64248.0, 64272.0, 5.1);

console.log("\n(demo only — no live orders placed)\n");
