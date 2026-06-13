// RiskManager — hard safety layer the original repo lacks.
// Responsibilities:
//   1. Track realized session PnL from fills, trip a drawdown kill switch.
//   2. Enforce max inventory (USD) — block quotes that would grow position past cap.
//   3. Halt on stale price feeds (feed age > threshold).
//   4. Halt after N consecutive update errors.
// When halted, the bot cancels all orders and (optionally) flattens, then refuses
// to quote until manually restarted. Fail-safe over fail-open.

import { log } from "../../utils/logger.js";

export type HaltReason = "drawdown" | "stale-feed" | "errors" | "manual" | null;

export interface RiskConfig {
	readonly maxInventoryUsd: number;
	readonly maxDrawdownUsd: number;
	readonly staleFeedMs: number;
	readonly maxConsecutiveErrors: number;
}

export class RiskManager {
	private realizedPnl = 0; // session realized PnL in USD
	private avgEntry = 0; // VWAP of current inventory (signed base)
	private invBase = 0; // signed base inventory used for PnL accounting
	private consecutiveErrors = 0;
	private halted: HaltReason = null;
	private fillCount = 0; // total fills this session
	private volumeUsd = 0; // total traded notional this session
	private readonly startedAt = Date.now();

	constructor(private readonly config: RiskConfig) {}

	// Apply a fill for PnL accounting (FIFO-ish via running VWAP).
	// side "bid" => buy (+base), "ask" => sell (-base).
	applyFill(side: "bid" | "ask", size: number, price: number): void {
		this.fillCount++;
		this.volumeUsd += Math.abs(size) * price;
		const signed = side === "bid" ? size : -size;
		const prevBase = this.invBase;
		const newBase = prevBase + signed;

		const sameDirection =
			prevBase === 0 || Math.sign(prevBase) === Math.sign(signed);

		if (sameDirection) {
			// Adding to position: update VWAP entry
			const totalAbs = Math.abs(prevBase) + Math.abs(signed);
			if (totalAbs > 0) {
				this.avgEntry =
					(Math.abs(prevBase) * this.avgEntry + Math.abs(signed) * price) /
					totalAbs;
			}
		} else {
			// Reducing / flipping: realize PnL on the closed portion
			const closedAbs = Math.min(Math.abs(prevBase), Math.abs(signed));
			// PnL per unit = (exit - entry) * direction of the position being closed
			const dir = Math.sign(prevBase); // +1 long closed by sell, -1 short closed by buy
			this.realizedPnl += dir * (price - this.avgEntry) * closedAbs;

			if (Math.abs(signed) > Math.abs(prevBase)) {
				// Flipped: remainder opens new position at this price
				this.avgEntry = price;
			}
			// if fully/partially closed but not flipped, avgEntry unchanged
		}

		this.invBase = newBase;
		if (Math.abs(this.invBase) < 1e-12) {
			this.invBase = 0;
			this.avgEntry = 0;
		}

		this.checkDrawdown();
	}

	private checkDrawdown(): void {
		if (this.halted) return;
		if (this.realizedPnl <= -this.config.maxDrawdownUsd) {
			this.trip("drawdown");
		}
	}

	// Returns true if placing `addUsd` of inventory on `side` is allowed.
	// addUsd is positive notional being added; we project new |inventory|.
	canIncreaseInventory(
		currentInvUsd: number,
		side: "bid" | "ask",
		addUsd: number,
	): boolean {
		// A bid grows long, an ask grows short — only block the side that *increases* |inv|.
		const projected =
			side === "bid" ? currentInvUsd + addUsd : currentInvUsd - addUsd;
		return Math.abs(projected) <= this.config.maxInventoryUsd;
	}

	// Feed staleness check. Pass max age (ms) of the freshest required feed.
	checkFeeds(feedAgesMs: number[]): void {
		if (this.halted) return;
		const stale = feedAgesMs.some((age) => age > this.config.staleFeedMs);
		if (stale) this.trip("stale-feed");
	}

	recordError(): void {
		this.consecutiveErrors++;
		if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
			this.trip("errors");
		}
	}

	recordSuccess(): void {
		this.consecutiveErrors = 0;
	}

	private trip(reason: HaltReason): void {
		if (this.halted) return;
		this.halted = reason;
		log.error(
			`🛑 RISK HALT [${reason}] — realizedPnL=$${this.realizedPnl.toFixed(2)}, inv=${this.invBase.toFixed(6)}. Cancelling orders & halting quoting.`,
		);
	}

	manualHalt(): void {
		this.trip("manual");
	}

	isHalted(): boolean {
		return this.halted !== null;
	}

	getHaltReason(): HaltReason {
		return this.halted;
	}

	getRealizedPnl(): number {
		return this.realizedPnl;
	}

	// Unrealized PnL of the open inventory at a given mark price.
	unrealizedPnl(markPrice: number): number {
		if (this.invBase === 0 || this.avgEntry === 0) return 0;
		// long: (mark - entry) * base ; short: (entry - mark) * |base|  -> same formula with signed base
		return (markPrice - this.avgEntry) * this.invBase;
	}

	// One-shot snapshot for clean status logging.
	getStats(markPrice: number): {
		realizedPnl: number;
		unrealizedPnl: number;
		totalPnl: number;
		invBase: number;
		avgEntry: number;
		fillCount: number;
		volumeUsd: number;
		uptimeSec: number;
		halted: HaltReason;
	} {
		const unrealized = this.unrealizedPnl(markPrice);
		return {
			realizedPnl: this.realizedPnl,
			unrealizedPnl: unrealized,
			totalPnl: this.realizedPnl + unrealized,
			invBase: this.invBase,
			avgEntry: this.avgEntry,
			fillCount: this.fillCount,
			volumeUsd: this.volumeUsd,
			uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
			halted: this.halted,
		};
	}

	getState(): {
		realizedPnl: number;
		invBase: number;
		avgEntry: number;
		halted: HaltReason;
		consecutiveErrors: number;
	} {
		return {
			realizedPnl: this.realizedPnl,
			invBase: this.invBase,
			avgEntry: this.avgEntry,
			halted: this.halted,
			consecutiveErrors: this.consecutiveErrors,
		};
	}
}
