// Quoter — calculates bid/ask prices with proper precision.
// PRO fork adds:
//   - Inventory skew: shift the effective fair price against current inventory so
//     the bot actively mean-reverts its position instead of waiting for close mode.
//   - Dynamic spread: widen the half-spread when realized volatility is high.
//   - Funding skew: nudge fair price to avoid paying funding on perps.

import Decimal from "decimal.js";
import type { BBO } from "../../sdk/orderbook.js";
import type { Quote } from "../../types.js";
import type { QuotingContext } from "./position.js";

export type { Quote } from "../../types.js";

export interface QuoterParams {
	priceDecimals: number;
	sizeDecimals: number;
	baseSpreadBps: number;
	takeProfitBps: number;
	orderSizeUsd: number;
	// risk/strategy
	maxInventoryUsd: number;
	inventorySkewBps: number;
	dynamicSpread: boolean;
	volSpreadMult: number;
	maxSpreadBps: number;
	fundingSkewBps: number;
	// anti-trend guard
	antiTrendGuard: boolean;
	trendDriftThresholdBps: number;
	trendPauseDriftBps: number;
	trendSpreadMult: number;
}

// Extra live signals passed per update.
export interface QuoteSignals {
	volBps: number; // realized volatility in bps
	fundingRate: number; // funding fraction (e.g. 0.0001)
	driftBps: number; // SIGNED directional drift in bps (+ up, - down)
}

export class Quoter {
	private readonly tickSize: Decimal;
	private readonly lotSize: Decimal;

	constructor(private readonly p: QuoterParams) {
		this.tickSize = new Decimal(10).pow(-p.priceDecimals);
		this.lotSize = new Decimal(10).pow(-p.sizeDecimals);
	}

	// Effective half-spread in bps given current volatility.
	private effectiveSpreadBps(volBps: number): number {
		if (!this.p.dynamicSpread) return this.p.baseSpreadBps;
		const widened = this.p.baseSpreadBps + volBps * this.p.volSpreadMult;
		return Math.min(widened, this.p.maxSpreadBps);
	}

	// Anti-trend guard. Given signed drift, decide per-side action:
	//   - extraBidBps / extraAskBps: extra half-spread added to the side that
	//     stands AGAINST the trend (it's the side most likely to be picked off).
	//   - pauseBid / pauseAsk: drop that side entirely (drift too strong).
	// Up-trend (drift > 0): the ASK gets adversely selected (we sell low into a
	// rising market) => widen/pause the ASK. Down-trend: widen/pause the BID.
	private trendGuard(driftBps: number): {
		extraBidBps: number;
		extraAskBps: number;
		pauseBid: boolean;
		pauseAsk: boolean;
	} {
		const none = {
			extraBidBps: 0,
			extraAskBps: 0,
			pauseBid: false,
			pauseAsk: false,
		};
		if (!this.p.antiTrendGuard) return none;

		const mag = Math.abs(driftBps);
		if (mag < this.p.trendDriftThresholdBps) return none;

		const pause = mag >= this.p.trendPauseDriftBps;
		// proportional widening above the threshold, capped by maxSpreadBps headroom
		const extra = Math.min(
			(mag - this.p.trendDriftThresholdBps) * this.p.trendSpreadMult,
			this.p.maxSpreadBps,
		);

		if (driftBps > 0) {
			// up-trend => protect ASK (against-trend side)
			return {
				extraBidBps: 0,
				extraAskBps: extra,
				pauseBid: false,
				pauseAsk: pause,
			};
		}
		// down-trend => protect BID (against-trend side)
		return {
			extraBidBps: extra,
			extraAskBps: 0,
			pauseBid: pause,
			pauseAsk: false,
		};
	}

	// Skew (in bps) applied to fair price. Negative skew lowers fair => makes the
	// bot lean to SELL (good when long). Positive raises it => lean to BUY.
	private computeSkewBps(invUsd: number, fundingRate: number): number {
		// Inventory skew: proportional to inventory fraction, opposing the position.
		const invFrac =
			this.p.maxInventoryUsd > 0
				? Math.max(-1, Math.min(1, invUsd / this.p.maxInventoryUsd))
				: 0;
		const invSkew = -invFrac * this.p.inventorySkewBps; // long => negative => sell-lean

		// Funding skew: positive funding (longs pay) => lean short => negative skew.
		const fundingSkew =
			-Math.sign(fundingRate) *
			Math.min(Math.abs(fundingRate) * 10000, this.p.fundingSkewBps);

		return invSkew + fundingSkew;
	}

	// Calculate quotes from quoting context + live signals, clamped to BBO.
	getQuotes(
		ctx: QuotingContext,
		bbo: BBO | null,
		signals: QuoteSignals,
	): Quote[] {
		const { fairPrice, positionState, allowedSides } = ctx;

		const halfSpreadBps = positionState.isCloseMode
			? this.p.takeProfitBps
			: this.effectiveSpreadBps(signals.volBps);

		// Apply skew to fair price (skip in close mode — we just want out).
		const skewBps = positionState.isCloseMode
			? 0
			: this.computeSkewBps(positionState.sizeUsd, signals.fundingRate);

		const fair = new Decimal(fairPrice).mul(
			new Decimal(1).add(new Decimal(skewBps).div(10000)),
		);

		// Anti-trend guard: per-side extra half-spread + side pause. Disabled in
		// close mode (we just want out, symmetric take-profit).
		const guard = positionState.isCloseMode
			? { extraBidBps: 0, extraAskBps: 0, pauseBid: false, pauseAsk: false }
			: this.trendGuard(signals.driftBps);

		const bidHalfBps = Math.min(
			halfSpreadBps + guard.extraBidBps,
			this.p.maxSpreadBps,
		);
		const askHalfBps = Math.min(
			halfSpreadBps + guard.extraAskBps,
			this.p.maxSpreadBps,
		);
		const bidSpreadAmount = fair.mul(bidHalfBps).div(10000);
		const askSpreadAmount = fair.mul(askHalfBps).div(10000);

		// Size: in close mode, only quote the position size; else fixed USD.
		let size: Decimal;
		if (positionState.isCloseMode) {
			size = this.alignSize(new Decimal(positionState.sizeBase).abs());
		} else {
			size = this.usdToSize(this.p.orderSizeUsd, fair);
		}
		if (size.lte(0)) return [];

		const quotes: Quote[] = [];

		if (allowedSides.includes("bid") && !guard.pauseBid) {
			let bidPrice = this.alignPrice(fair.sub(bidSpreadAmount), "floor");
			if (bbo && bidPrice.gte(bbo.bestAsk)) {
				bidPrice = this.alignPrice(
					new Decimal(bbo.bestAsk).sub(this.tickSize),
					"floor",
				);
			}
			if (bidPrice.gt(0)) quotes.push({ side: "bid", price: bidPrice, size });
		}

		if (allowedSides.includes("ask") && !guard.pauseAsk) {
			let askPrice = this.alignPrice(fair.add(askSpreadAmount), "ceil");
			if (bbo && askPrice.lte(bbo.bestBid)) {
				askPrice = this.alignPrice(
					new Decimal(bbo.bestBid).add(this.tickSize),
					"ceil",
				);
			}
			if (askPrice.gt(0)) quotes.push({ side: "ask", price: askPrice, size });
		}

		return quotes;
	}

	private alignPrice(price: Decimal, round: "floor" | "ceil"): Decimal {
		const ticks = price.div(this.tickSize);
		const aligned = round === "floor" ? ticks.floor() : ticks.ceil();
		return aligned.mul(this.tickSize);
	}

	private usdToSize(usd: number, fairPrice: Decimal): Decimal {
		return this.alignSize(new Decimal(usd).div(fairPrice));
	}

	private alignSize(size: Decimal): Decimal {
		const lots = size.div(this.lotSize).floor();
		return lots.mul(this.lotSize);
	}
}
