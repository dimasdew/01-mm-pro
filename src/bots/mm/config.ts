// MarketMaker configuration — PRO fork
// All risk/strategy knobs live here and are overridable via .env

export interface MarketMakerConfig {
	readonly symbol: string; // e.g., "BTC" or "ETH"

	// --- Core quoting ---
	readonly spreadBps: number; // Base spread from fair price (bps)
	readonly takeProfitBps: number; // Spread in close mode (bps) — MUST cover fees
	readonly orderSizeUsd: number; // Fallback order size in USD per side (used if marginPerEntryUsd<=0 or imf missing)
	readonly marginPerEntryUsd: number; // Target margin (collateral) committed per entry; notional = margin/imf. Overrides orderSizeUsd when > 0.
	readonly warmupSeconds: number; // Min samples before quoting
	readonly updateThrottleMs: number; // Min interval between quote updates
	readonly orderSyncIntervalMs: number; // Interval for syncing orders from API
	readonly statusIntervalMs: number; // Interval for status display
	readonly fairPriceWindowMs: number; // Window for fair price calc
	readonly positionSyncIntervalMs: number; // Interval for position sync

	// --- Inventory management (IMPROVED) ---
	readonly maxInventoryUsd: number; // Hard cap: never let |position| exceed this
	readonly closeThresholdUsd: number; // Enter close-bias when |position| >= this
	readonly inventorySkewBps: number; // Max fair-price skew at full inventory (bps)

	// --- Dynamic spread (NEW) ---
	readonly dynamicSpread: boolean; // Widen spread with volatility
	readonly volWindowSec: number; // Rolling window for realized vol (seconds)
	readonly volSpreadMult: number; // spread += vol(bps) * this multiplier
	readonly maxSpreadBps: number; // Spread ceiling

	// --- Risk guards (NEW) ---
	readonly maxDrawdownUsd: number; // Kill switch: halt+flatten if session PnL <= -this
	readonly staleFeedMs: number; // Halt quoting if any feed older than this
	readonly maxConsecutiveErrors: number; // Halt after N consecutive update errors

	// --- Funding-aware (NEW) ---
	readonly fundingAware: boolean; // Bias quotes against unfavorable funding
	readonly fundingPollMs: number; // Poll Binance funding rate interval
	readonly fundingSkewBps: number; // Max extra skew from funding (bps)

	// --- Anti-trend guard (NEW) ---
	readonly antiTrendGuard: boolean; // Defend against trending markets (adverse selection)
	readonly trendDriftThresholdBps: number; // |drift| above this => widen the against-trend side
	readonly trendPauseDriftBps: number; // |drift| above this => stop quoting the against-trend side entirely
	readonly trendSpreadMult: number; // extra against-trend half-spread = (|drift|-thresh) * this
}

function num(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === "") return fallback;
	return v === "1" || v.toLowerCase() === "true";
}

// Per-symbol numeric override. Looks up `<NAME>_<SYMBOL>` first (e.g.
// MAX_INVENTORY_USD_SOL), falling back to the global `<NAME>`, then `fallback`.
// Symbol is upper-cased and stripped to [A-Z0-9] so "btc-perp" -> "BTC".
function numForSymbol(name: string, symbol: string, fallback: number): number {
	const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
	const perSym = process.env[`${name}_${sym}`];
	if (perSym !== undefined && perSym !== "") {
		const n = Number(perSym);
		if (Number.isFinite(n)) return n;
	}
	return num(name, fallback);
}

// Resolve the close-bias trigger for a symbol. Priority:
//   1) explicit per-symbol  CLOSE_THRESHOLD_USD_<SYM>
//   2) explicit global      CLOSE_THRESHOLD_USD  (only if no per-symbol max set)
//   3) auto-scaled: per-symbol max * (globalClose / globalMax) ratio
// (3) means raising MAX_INVENTORY_USD_SOL alone keeps the close trigger at the
// same proportion of the cap as the global pair, so one knob per coin is enough.
function closeThresholdForSymbol(symbol: string): number {
	const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
	// 1) explicit per-symbol override wins outright.
	const perSym = process.env[`CLOSE_THRESHOLD_USD_${sym}`];
	if (perSym !== undefined && perSym !== "") {
		const n = Number(perSym);
		if (Number.isFinite(n)) return n;
	}

	const globalMax = num("MAX_INVENTORY_USD", 1000);
	const globalClose = num("CLOSE_THRESHOLD_USD", 600);
	const ratio = globalMax > 0 ? globalClose / globalMax : 0.6;

	const perSymMax = process.env[`MAX_INVENTORY_USD_${sym}`];
	const hasPerSymMax = perSymMax !== undefined && perSymMax !== "";

	// 2) no per-symbol cap => fall back to the global close threshold as-is.
	if (!hasPerSymMax) return globalClose;

	// 3) per-symbol cap set but no per-symbol close => scale by the global ratio.
	const symMax = numForSymbol("MAX_INVENTORY_USD", symbol, globalMax);
	return Math.round(symMax * ratio);
}

// Sane, fee-aware defaults. 01.xyz maker fee ~0, taker fee applies on close-mode
// crosses — takeProfitBps default keeps closes profitable after costs.
// `overrides` lets the interactive wizard inject runtime values (e.g. margin per
// entry chosen at startup) without mutating process.env.
export function loadConfig(
	symbol: string,
	overrides: Partial<MarketMakerConfig> = {},
): MarketMakerConfig {
	const base: MarketMakerConfig = {
		symbol,

		// Core
		spreadBps: num("SPREAD_BPS", 8),
		takeProfitBps: num("TAKE_PROFIT_BPS", 3), // was 0.1 — too small to cover fees
		orderSizeUsd: num("ORDER_SIZE_USD", 200), // fallback only; used when MARGIN_PER_ENTRY_USD<=0
		marginPerEntryUsd: num("MARGIN_PER_ENTRY_USD", 2), // default $2 margin/entry; notional auto-derived from market imf
		warmupSeconds: num("WARMUP_SECONDS", 10),
		updateThrottleMs: num("UPDATE_THROTTLE_MS", 100),
		orderSyncIntervalMs: num("ORDER_SYNC_INTERVAL_MS", 3000),
		statusIntervalMs: num("STATUS_INTERVAL_MS", 1000),
		fairPriceWindowMs: num("FAIR_PRICE_WINDOW_MS", 5 * 60 * 1000),
		positionSyncIntervalMs: num("POSITION_SYNC_INTERVAL_MS", 5000),

		// Inventory — per-symbol caps. MAX_INVENTORY_USD_<SYM> overrides the global
		// MAX_INVENTORY_USD per coin (e.g. BTC=1500, SOL=500). closeThreshold scales
		// with the same ratio as the global pair so you only set ONE number per coin:
		// if you raise MAX_INVENTORY_USD_SOL but leave CLOSE_THRESHOLD_USD_SOL unset,
		// the close-bias trigger auto-tracks at the global close/max ratio (0.6).
		maxInventoryUsd: numForSymbol("MAX_INVENTORY_USD", symbol, 1000),
		closeThresholdUsd: closeThresholdForSymbol(symbol),
		inventorySkewBps: num("INVENTORY_SKEW_BPS", 6),

		// Dynamic spread
		dynamicSpread: bool("DYNAMIC_SPREAD", true),
		volWindowSec: num("VOL_WINDOW_SEC", 60),
		volSpreadMult: num("VOL_SPREAD_MULT", 1.0),
		maxSpreadBps: num("MAX_SPREAD_BPS", 40),

		// Risk guards
		maxDrawdownUsd: num("MAX_DRAWDOWN_USD", 50),
		staleFeedMs: num("STALE_FEED_MS", 5000),
		maxConsecutiveErrors: num("MAX_CONSECUTIVE_ERRORS", 5),

		// Funding
		fundingAware: bool("FUNDING_AWARE", true),
		fundingPollMs: num("FUNDING_POLL_MS", 60_000),
		fundingSkewBps: num("FUNDING_SKEW_BPS", 4),

		// Anti-trend guard — protect against one-sided momentum (adverse selection).
		// drift below threshold => no effect. Between threshold and pause => widen
		// the against-trend side proportionally. Above pause => stop quoting that
		// side (don't feed liquidity to a falling/rising knife).
		antiTrendGuard: bool("ANTI_TREND_GUARD", true),
		trendDriftThresholdBps: num("TREND_DRIFT_THRESHOLD_BPS", 8),
		trendPauseDriftBps: num("TREND_PAUSE_DRIFT_BPS", 20),
		trendSpreadMult: num("TREND_SPREAD_MULT", 1.5),
	};
	return { ...base, ...overrides, symbol };
}

// Back-compat export (symbol injected by caller)
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, "symbol"> =
	loadConfig("__DEFAULT__");

// Parse the list of symbols to market-make. Priority:
//   1) explicit CLI args (space/comma separated), e.g. `bot BTC ETH SOL`
//   2) SYMBOLS env (comma separated), e.g. SYMBOLS=BTC,ETH,SOL
//   3) single SYMBOL env
//   4) default BTC,ETH,SOL
// Symbols are upper-cased and de-duplicated, order preserved.
export function parseSymbols(cliArgs: string[] = []): string[] {
	const fromCli = cliArgs
		.flatMap((a) => a.split(","))
		.map((s) => s.trim())
		.filter(Boolean);

	let raw: string[];
	if (fromCli.length > 0) {
		raw = fromCli;
	} else if (process.env.SYMBOLS && process.env.SYMBOLS.trim() !== "") {
		raw = process.env.SYMBOLS.split(",");
	} else if (process.env.SYMBOL && process.env.SYMBOL.trim() !== "") {
		raw = [process.env.SYMBOL];
	} else {
		raw = ["BTC", "ETH", "SOL"];
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of raw) {
		const sym = s.trim().toUpperCase();
		if (sym && !seen.has(sym)) {
			seen.add(sym);
			out.push(sym);
		}
	}
	return out;
}
