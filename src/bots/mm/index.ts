// MarketMaker — PRO fork main logic.
// Adds over the original: RiskManager (drawdown kill switch + inventory cap),
// volatility-driven dynamic spread, inventory + funding skew, stale-feed halt,
// consecutive-error halt, and auto-flatten on halt.

import type { NordUser } from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { DebouncedFunc } from "lodash-es";
import { throttle } from "lodash-es";
import { BinancePriceFeed } from "../../pricing/binance.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
	type FairPriceProvider,
} from "../../pricing/fair-price.js";
import { FundingFeed } from "../../pricing/funding.js";
import { VolatilityEstimator } from "../../pricing/volatility.js";
import { AccountStream, type FillEvent } from "../../sdk/account.js";
import { createZoClient, type ZoClient } from "../../sdk/client.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import {
	type CachedOrder,
	cancelOrders,
	flattenPosition,
	TransientOrderError,
	updateQuotes,
} from "../../sdk/orders.js";
import type { MidPrice } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { MarketMakerConfig } from "./config.js";
import { type PositionConfig, PositionTracker } from "./position.js";
import { Quoter } from "./quoter.js";
import { RiskManager } from "./risk.js";

export type { MarketMakerConfig } from "./config.js";

interface ApiOrder {
	orderId: bigint | number;
	marketId: number;
	side: "bid" | "ask";
	price: number | string;
	size: number | string;
}

function mapApiOrdersToCached(orders: ApiOrder[]): CachedOrder[] {
	return orders.map((o) => ({
		orderId: o.orderId.toString(),
		side: o.side,
		price: new Decimal(o.price),
		size: new Decimal(o.size),
	}));
}

function deriveBinanceSymbol(marketSymbol: string): string {
	const baseSymbol = marketSymbol
		.replace(/-PERP$/i, "")
		.replace(/USD$/i, "")
		.toLowerCase();
	return `${baseSymbol}usdt`;
}

export class MarketMaker {
	private client: ZoClient | null = null;
	private marketId = 0;
	private marketSymbol = "";
	private accountStream: AccountStream | null = null;
	private orderbookStream: ZoOrderbookStream | null = null;
	private binanceFeed: BinancePriceFeed | null = null;
	private fairPriceCalc: FairPriceProvider | null = null;
	private positionTracker: PositionTracker | null = null;
	private quoter: Quoter | null = null;
	private risk: RiskManager | null = null;
	private vol: VolatilityEstimator | null = null;
	private funding: FundingFeed | null = null;
	private priceDecimals = 2;

	private isRunning = false;
	private lastLoggedSampleCount = -1;
	private activeOrders: CachedOrder[] = [];
	private isUpdating = false;
	private throttledUpdate: DebouncedFunc<
		(fairPrice: number) => Promise<void>
	> | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;
	private orderSyncInterval: ReturnType<typeof setInterval> | null = null;

	// effective per-side order notional (USD), derived from marginPerEntryUsd / imf
	private effectiveOrderSizeUsd: number;

	constructor(
		private readonly config: MarketMakerConfig,
		private readonly privateKey: string,
		// When provided, this MarketMaker shares an externally-owned client
		// (multi-symbol orchestration). It then does NOT own connect/exit lifecycle
		// for the wallet session and must not call process.exit on shutdown.
		private readonly sharedClient: ZoClient | null = null,
	) {
		this.effectiveOrderSizeUsd = config.orderSizeUsd;
	}

	private requireClient(): ZoClient {
		if (!this.client) throw new Error("Client not initialized");
		return this.client;
	}

	// Standalone run: owns client, signal handlers, and warmup wait.
	async run(): Promise<void> {
		log.banner();
		await this.initialize();
		this.setupEventHandlers();
		await this.syncInitialOrders();
		this.startIntervals();
		this.registerShutdownHandlers();
		log.info("Warming up price feeds...");
		await this.waitForever();
	}

	// Orchestrated start: client is injected, no signal handlers, no waitForever.
	// The orchestrator owns the process lifecycle and calls stop() on shutdown.
	async start(): Promise<void> {
		await this.initialize();
		this.setupEventHandlers();
		await this.syncInitialOrders();
		this.startIntervals();
	}

	// Graceful per-instance teardown used by the orchestrator. Cancels resting
	// orders and tears down feeds/intervals but never exits the process.
	async stop(): Promise<void> {
		await this.teardown();
	}

	private async initialize(): Promise<void> {
		this.throttledUpdate = throttle(
			(fairPrice: number) => this.executeUpdate(fairPrice),
			this.config.updateThrottleMs,
			{ leading: true, trailing: true },
		);

		this.client = this.sharedClient ?? (await createZoClient(this.privateKey));
		const { nord } = this.client;

		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.config.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(
				`Market "${this.config.symbol}" not found. Available: ${available}`,
			);
		}
		this.marketId = market.marketId;
		this.marketSymbol = market.symbol;
		this.priceDecimals = market.priceDecimals;

		// --- Auto-size from target margin per entry ---
		// 01 Exchange is cross-margin; "leverage" is fixed per-market via the
		// initial-margin fraction (imf). Max leverage = 1 / imf. The notional we
		// can open per `marginPerEntryUsd` of margin is margin / imf.
		// If marginPerEntryUsd is set (> 0), it OVERRIDES orderSizeUsd so the user
		// controls capital-at-risk directly regardless of which coin it is.
		const imf =
			typeof market.imf === "number" && market.imf > 0 ? market.imf : null;
		const maxLeverage = imf ? 1 / imf : null;
		if (this.config.marginPerEntryUsd > 0 && imf) {
			this.effectiveOrderSizeUsd = this.config.marginPerEntryUsd / imf;
		} else {
			this.effectiveOrderSizeUsd = this.config.orderSizeUsd;
		}
		log.info(
			`[${this.marketSymbol}] imf=${imf ?? "n/a"} | maxLev=${
				maxLeverage ? `${maxLeverage.toFixed(1)}x` : "n/a"
			} | margin/entry=$${this.config.marginPerEntryUsd} | order notional=$${this.effectiveOrderSizeUsd.toFixed(2)}`,
		);

		const binanceSymbol = deriveBinanceSymbol(market.symbol);
		this.logConfig(binanceSymbol);

		const fairPriceConfig: FairPriceConfig = {
			windowMs: this.config.fairPriceWindowMs,
			minSamples: this.config.warmupSeconds,
		};
		const positionConfig: PositionConfig = {
			closeThresholdUsd: this.config.closeThresholdUsd,
			maxInventoryUsd: this.config.maxInventoryUsd,
			syncIntervalMs: this.config.positionSyncIntervalMs,
		};

		this.fairPriceCalc = new FairPriceCalculator(fairPriceConfig);
		this.positionTracker = new PositionTracker(positionConfig);
		this.vol = new VolatilityEstimator(this.config.volWindowSec * 1000);
		this.risk = new RiskManager({
			maxInventoryUsd: this.config.maxInventoryUsd,
			maxDrawdownUsd: this.config.maxDrawdownUsd,
			staleFeedMs: this.config.staleFeedMs,
			maxConsecutiveErrors: this.config.maxConsecutiveErrors,
		});
		this.quoter = new Quoter({
			priceDecimals: market.priceDecimals,
			sizeDecimals: market.sizeDecimals,
			baseSpreadBps: this.config.spreadBps,
			takeProfitBps: this.config.takeProfitBps,
			orderSizeUsd: this.effectiveOrderSizeUsd,
			maxInventoryUsd: this.config.maxInventoryUsd,
			inventorySkewBps: this.config.inventorySkewBps,
			dynamicSpread: this.config.dynamicSpread,
			volSpreadMult: this.config.volSpreadMult,
			maxSpreadBps: this.config.maxSpreadBps,
			fundingSkewBps: this.config.fundingSkewBps,
			antiTrendGuard: this.config.antiTrendGuard,
			trendDriftThresholdBps: this.config.trendDriftThresholdBps,
			trendPauseDriftBps: this.config.trendPauseDriftBps,
			trendSpreadMult: this.config.trendSpreadMult,
		});

		this.accountStream = new AccountStream(nord, this.client.accountId);
		this.orderbookStream = new ZoOrderbookStream(nord, this.marketSymbol);
		this.binanceFeed = new BinancePriceFeed(binanceSymbol);

		if (this.config.fundingAware) {
			this.funding = new FundingFeed(binanceSymbol, this.config.fundingPollMs);
			await this.funding.start();
		}

		this.isRunning = true;
	}

	private setupEventHandlers(): void {
		const { user, accountId } = this.requireClient();

		this.accountStream?.syncOrders(user, accountId);
		this.accountStream?.setOnFill((fill: FillEvent) => {
			log.fill(fill.side === "bid" ? "buy" : "sell", fill.price, fill.size);
			this.positionTracker?.applyFill(fill.side, fill.size, fill.price);
			this.risk?.applyFill(fill.side, fill.size, fill.price);

			// Halt triggered by this fill (drawdown) => emergency flatten.
			// Only latched halts flatten; transient ones auto-recover and must
			// not dump the position.
			if (this.risk?.isHalted()) {
				const reason = this.risk.getHaltReason();
				if (reason === "drawdown" || reason === "manual") {
					void this.emergencyFlatten();
					return;
				}
			}
			if (this.positionTracker?.isCloseMode(fill.price)) {
				this.cancelOrdersAsync();
			}
		});

		if (this.binanceFeed) {
			this.binanceFeed.onPrice = (price) => this.handleBinancePrice(price);
		}
		if (this.orderbookStream) {
			this.orderbookStream.onPrice = (price) => this.handleZoPrice(price);
		}

		this.accountStream?.connect();
		this.orderbookStream?.connect();
		this.binanceFeed?.connect();
	}

	private handleBinancePrice(binancePrice: MidPrice): void {
		this.vol?.addSample(binancePrice.mid);

		const zoPrice = this.orderbookStream?.getMidPrice();
		if (
			zoPrice &&
			Math.abs(binancePrice.timestamp - zoPrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, binancePrice.mid);
		}

		if (!this.isRunning) return;

		const fairPrice = this.fairPriceCalc?.getFairPrice(binancePrice.mid);
		if (!fairPrice) {
			this.logWarmupProgress(binancePrice);
			return;
		}

		if (this.lastLoggedSampleCount < this.config.warmupSeconds) {
			this.lastLoggedSampleCount = this.config.warmupSeconds;
			log.info(`Ready! Fair price: $${fairPrice.toFixed(2)}`);
		}

		this.throttledUpdate?.(fairPrice);
	}

	private handleZoPrice(zoPrice: MidPrice): void {
		const binancePrice = this.binanceFeed?.getMidPrice();
		if (
			binancePrice &&
			Math.abs(zoPrice.timestamp - binancePrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, binancePrice.mid);
		}
	}

	private logWarmupProgress(binancePrice: MidPrice): void {
		const state = this.fairPriceCalc?.getState();
		if (!state || state.samples === this.lastLoggedSampleCount) return;
		this.lastLoggedSampleCount = state.samples;
		const zoPrice = this.orderbookStream?.getMidPrice();
		const offsetBps =
			state.offset !== null && binancePrice.mid > 0
				? ((state.offset / binancePrice.mid) * 10000).toFixed(1)
				: "--";
		log.info(
			`Warming up: ${state.samples}/${this.config.warmupSeconds} samples | Binance $${binancePrice.mid.toFixed(2)} | 01 $${zoPrice?.mid.toFixed(2) ?? "--"} | Offset ${offsetBps}bps`,
		);
	}

	private async syncInitialOrders(): Promise<void> {
		const { user, accountId } = this.requireClient();
		await user.fetchInfo();
		const existingOrders = (user.orders[accountId] ?? []) as ApiOrder[];
		const marketOrders = existingOrders.filter(
			(o) => o.marketId === this.marketId,
		);
		this.activeOrders = mapApiOrdersToCached(marketOrders);
		if (this.activeOrders.length > 0) {
			log.info(`Synced ${this.activeOrders.length} existing orders`);
		}
		this.positionTracker?.startSync(user, accountId, this.marketId);
	}

	private startIntervals(): void {
		const { user, accountId } = this.requireClient();
		this.statusInterval = setInterval(
			() => this.logStatus(),
			this.config.statusIntervalMs,
		);
		this.orderSyncInterval = setInterval(
			() => this.syncOrders(user, accountId),
			this.config.orderSyncIntervalMs,
		);
	}

	private registerShutdownHandlers(): void {
		const shutdown = () => this.shutdown();
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}

	private async shutdown(): Promise<void> {
		log.shutdown();
		await this.teardown();
		process.exit(0);
	}

	// Tears down all per-instance resources and cancels resting orders.
	// Does NOT touch the wallet session (shared client) or the process.
	private async teardown(): Promise<void> {
		this.isRunning = false;
		this.throttledUpdate?.cancel();
		this.positionTracker?.stopSync();
		this.funding?.stop();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.orderSyncInterval) {
			clearInterval(this.orderSyncInterval);
			this.orderSyncInterval = null;
		}

		this.binanceFeed?.close();
		this.orderbookStream?.close();
		this.accountStream?.close();

		try {
			if (this.activeOrders.length > 0 && this.client) {
				await cancelOrders(this.client.user, this.activeOrders);
				log.info(
					`[${this.marketSymbol}] Cancelled ${this.activeOrders.length} orders.`,
				);
				this.activeOrders = [];
			} else {
				log.info(`[${this.marketSymbol}] No active orders to cancel.`);
			}
		} catch (err) {
			log.error("Shutdown error:", err);
		}
	}

	private async waitForever(): Promise<void> {
		await new Promise(() => {});
	}

	// Emergency flatten: cancel all resting orders AND close the residual position
	// with a reduce-only IOC (taker) order that crosses the book so it actually fills.
	// Guarded so it only fires once per halt.
	private flattening = false;
	private async emergencyFlatten(): Promise<void> {
		if (this.flattening) return;
		this.flattening = true;

		log.error(
			"⚠️ Emergency flatten: risk halt — closing position via reduce-only IOC.",
		);

		try {
			if (!this.client || !this.positionTracker) {
				this.cancelOrdersAsync();
				return;
			}

			const baseSize = this.positionTracker.getBaseSize(); // signed: + long, - short
			const bbo = this.orderbookStream?.getBBO() ?? null;

			if (baseSize === 0 || !bbo) {
				// No position (or no book) — just clear resting orders.
				await cancelOrders(this.client.user, this.activeOrders);
				this.activeOrders = [];
				log.info("Emergency flatten: no position to close, orders cancelled.");
				return;
			}

			// Aggressive limit past the BBO (+/-50bps) so the IOC sweeps and fills.
			// long  => SELL into the bid, price below bestBid
			// short => BUY  into the ask, price above bestAsk
			const SLIPPAGE_BPS = 50;
			const ref = baseSize > 0 ? bbo.bestBid : bbo.bestAsk;
			const adj =
				baseSize > 0
					? ref * (1 - SLIPPAGE_BPS / 10000)
					: ref * (1 + SLIPPAGE_BPS / 10000);
			const limitPrice = new Decimal(adj.toFixed(this.priceDecimals));

			const submitted = await flattenPosition(
				this.client.user,
				this.marketId,
				this.activeOrders,
				new Decimal(baseSize),
				limitPrice,
			);
			this.activeOrders = [];

			if (submitted) {
				log.info(
					`Emergency flatten submitted: ${baseSize > 0 ? "SOLD" : "BOUGHT"} ${Math.abs(baseSize)} @ ~${limitPrice.toString()}`,
				);
			}
		} catch (err) {
			log.error("Emergency flatten failed:", err);
			// Last-resort: at least try to cancel resting orders.
			this.cancelOrdersAsync();
		}
	}

	private feedAges(): number[] {
		const now = Date.now();
		const bin = this.binanceFeed?.getMidPrice()?.timestamp ?? 0;
		const zo = this.orderbookStream?.getMidPrice()?.timestamp ?? 0;
		return [now - bin, now - zo];
	}

	private async executeUpdate(fairPrice: number): Promise<void> {
		if (this.isUpdating) return;
		this.isUpdating = true;

		try {
			if (!this.positionTracker || !this.quoter || !this.client || !this.risk) {
				return;
			}

			// Stale-feed circuit breaker (auto-recovers when feeds are fresh).
			this.risk.checkFeeds(this.feedAges());

			// If halted, decide between flatten and pause:
			//   - Latched halts (drawdown / manual) = real risk event => flatten
			//     the position and stop until a manual restart.
			//   - Transient halts (stale-feed / errors) auto-recover; do NOT
			//     flatten (that would dump the position at a taker loss for a
			//     momentary blip). Just skip this cycle and wait for recovery.
			if (this.risk.isHalted()) {
				const reason = this.risk.getHaltReason();
				const latched = reason === "drawdown" || reason === "manual";
				if (latched && !this.flattening) void this.emergencyFlatten();
				return;
			}

			const quotingCtx = this.positionTracker.getQuotingContext(fairPrice);
			const { positionState } = quotingCtx;

			if (positionState.sizeBase !== 0) {
				log.position(
					positionState.sizeBase,
					positionState.sizeUsd,
					positionState.isLong,
					positionState.isCloseMode,
				);
			}

			const bbo = this.orderbookStream?.getBBO() ?? null;
			const driftBps = this.vol?.getDriftBps() ?? 0;
			const signals = {
				volBps: this.vol?.getVolBps() ?? 0,
				fundingRate: this.funding?.getRate() ?? 0,
				driftBps,
			};
			const quotes = this.quoter.getQuotes(quotingCtx, bbo, signals);

			// Surface anti-trend guard activity so it's visible in logs.
			if (
				this.config.antiTrendGuard &&
				!positionState.isCloseMode &&
				Math.abs(driftBps) >= this.config.trendDriftThresholdBps
			) {
				const dir = driftBps > 0 ? "UP" : "DOWN";
				const paused = Math.abs(driftBps) >= this.config.trendPauseDriftBps;
				const guarded = driftBps > 0 ? "ask" : "bid";
				log.warn(
					`Trend guard: drift ${driftBps.toFixed(1)}bps ${dir} — ${
						paused ? `PAUSED ${guarded} side` : `widening ${guarded} side`
					}`,
				);
			}

			if (quotes.length === 0) {
				log.warn("No quotes generated (size too small or fully capped)");
				return;
			}

			const bid = quotes.find((q) => q.side === "bid");
			const ask = quotes.find((q) => q.side === "ask");
			const isClose = positionState.isCloseMode;
			const spreadBps = isClose
				? this.config.takeProfitBps
				: Math.min(
						this.config.spreadBps + signals.volBps * this.config.volSpreadMult,
						this.config.maxSpreadBps,
					);
			log.quote(
				bid?.price.toNumber() ?? null,
				ask?.price.toNumber() ?? null,
				fairPrice,
				spreadBps,
				isClose ? "close" : "normal",
			);

			const newOrders = await updateQuotes(
				this.client.user,
				this.marketId,
				this.activeOrders,
				quotes,
			);
			this.activeOrders = newOrders;
			this.risk.recordSuccess();
		} catch (err) {
			// Transient order rejections (post-only would cross, cancel-of-gone,
			// size-at-min) are NORMAL — log and clear orders, but DON'T count
			// toward the consecutive-error halt. Only real failures (RPC down,
			// auth, sequencer) trip recordError().
			if (err instanceof TransientOrderError) {
				this.activeOrders = [];
				// A transient reject still means we acted, not that we're broken —
				// treat it as a successful cycle for halt-tracking purposes.
				this.risk?.recordSuccess();
			} else {
				log.error("Update error:", err);
				this.activeOrders = [];
				this.risk?.recordError();
			}
		} finally {
			this.isUpdating = false;
		}
	}

	private logConfig(binanceSymbol: string): void {
		log.config({
			Market: this.marketSymbol,
			Binance: binanceSymbol,
			Spread: `${this.config.spreadBps} bps (dyn: ${this.config.dynamicSpread})`,
			"Take Profit": `${this.config.takeProfitBps} bps`,
			"Order Size": `$${this.effectiveOrderSizeUsd.toFixed(2)} (margin/entry $${this.config.marginPerEntryUsd})`,
			"Close Mode": `>=$${this.config.closeThresholdUsd}`,
			"Max Inventory": `$${this.config.maxInventoryUsd}`,
			"Max Drawdown": `$${this.config.maxDrawdownUsd}`,
			"Funding Aware": `${this.config.fundingAware}`,
			"Trend Guard": this.config.antiTrendGuard
				? `on (widen >=${this.config.trendDriftThresholdBps}bps, pause >=${this.config.trendPauseDriftBps}bps)`
				: "off",
		});
	}

	private cancelOrdersAsync(): void {
		if (this.activeOrders.length === 0 || !this.client) return;
		const orders = this.activeOrders;
		cancelOrders(this.client.user, orders)
			.then(() => {
				this.activeOrders = [];
			})
			.catch((err) => {
				log.error("Failed to cancel orders:", err);
				this.activeOrders = [];
			});
	}

	private syncOrders(user: NordUser, accountId: number): void {
		user
			.fetchInfo()
			.then(() => {
				const apiOrders = (user.orders[accountId] ?? []) as ApiOrder[];
				const marketOrders = apiOrders.filter(
					(o) => o.marketId === this.marketId,
				);
				this.activeOrders = mapApiOrdersToCached(marketOrders);
			})
			.catch((err) => log.error("Order sync error:", err));
	}

	private logStatus(): void {
		if (!this.isRunning || !this.risk) return;
		const mark =
			this.orderbookStream?.getMidPrice()?.mid ??
			this.binanceFeed?.getMidPrice()?.mid ??
			0;
		const stats = this.risk.getStats(mark);
		const bids = this.activeOrders.filter((o) => o.side === "bid");
		const asks = this.activeOrders.filter((o) => o.side === "ask");
		const bestBid =
			bids.length > 0 ? Math.max(...bids.map((o) => o.price.toNumber())) : null;
		const bestAsk =
			asks.length > 0 ? Math.min(...asks.map((o) => o.price.toNumber())) : null;

		// Prefer EXCHANGE-TRUTH numbers for the open position. The RiskManager
		// reconstructs position/uPnL from the fills it observed, which can drift
		// from the actual account (missed/duplicate fills, a position that
		// pre-dates the bot, funding, taker fees) — that drift is exactly why
		// the displayed uPnL didn't match real margin. The PositionTracker syncs
		// avg-entry and uPnL straight from the venue, so use those when fresh and
		// only fall back to the local estimate before the first sync lands.
		const ex = this.positionTracker?.getExchangeSnapshot() ?? null;
		const hasExchange = ex !== null;
		const posBase = hasExchange ? ex.baseSize : stats.invBase;
		const avgEntry = hasExchange ? ex.avgEntry : stats.avgEntry;
		const unrealizedPnl = hasExchange
			? ex.sizePricePnl + ex.fundingPnl
			: stats.unrealizedPnl;

		log.status({
			symbol: this.marketSymbol,
			mark,
			posBase,
			posUsd: posBase * mark,
			avgEntry,
			realizedPnl: stats.realizedPnl,
			unrealizedPnl,
			totalPnl: stats.realizedPnl + unrealizedPnl,
			fillCount: stats.fillCount,
			volumeUsd: stats.volumeUsd,
			volBps: this.vol?.getVolBps() ?? 0,
			uptimeSec: stats.uptimeSec,
			bid: bestBid,
			ask: bestAsk,
			halted: stats.halted,
		});
	}
}
