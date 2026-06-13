// Position Tracker with optimistic updates + periodic sync

import type { NordUser } from "@n1xyz/nord-ts";
import { log } from "../../utils/logger.js";

export interface PositionState {
	readonly sizeBase: number;
	readonly sizeUsd: number;
	readonly isLong: boolean;
	readonly isCloseMode: boolean;
}

export interface QuotingContext {
	readonly fairPrice: number;
	readonly positionState: PositionState;
	readonly allowedSides: readonly ("bid" | "ask")[];
}

export interface PositionConfig {
	readonly closeThresholdUsd: number; // Trigger close mode when position >= this
	readonly maxInventoryUsd: number; // Hard cap: block the side that grows |inv| past this
	readonly syncIntervalMs: number;
}

export class PositionTracker {
	private baseSize = 0;
	private isRunning = false;

	constructor(private readonly config: PositionConfig) {}

	startSync(user: NordUser, accountId: number, marketId: number): void {
		this.isRunning = true;
		this.syncLoop(user, accountId, marketId);
	}

	stopSync(): void {
		this.isRunning = false;
	}

	private async syncLoop(
		user: NordUser,
		accountId: number,
		marketId: number,
	): Promise<void> {
		await this.syncFromServer(user, accountId, marketId);

		while (this.isRunning) {
			await this.sleep(this.config.syncIntervalMs);
			if (!this.isRunning) break;
			await this.syncFromServer(user, accountId, marketId);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async syncFromServer(
		user: NordUser,
		accountId: number,
		marketId: number,
	): Promise<void> {
		try {
			await user.fetchInfo();

			const positions = user.positions[accountId] || [];
			const pos = positions.find((p) => p.marketId === marketId);

			const serverSize = pos?.perp
				? pos.perp.isLong
					? pos.perp.baseSize
					: -pos.perp.baseSize
				: 0;

			if (Math.abs(this.baseSize - serverSize) > 0.0001) {
				log.warn(
					`Position drift: local=${this.baseSize.toFixed(6)}, server=${serverSize.toFixed(6)}`,
				);
				this.baseSize = serverSize;
			}
		} catch (err) {
			log.error("Position sync error:", err);
		}
	}

	applyFill(side: "bid" | "ask", size: number, _price: number): void {
		if (side === "bid") {
			this.baseSize += size;
		} else {
			this.baseSize -= size;
		}
		log.debug(
			`Position updated: ${this.baseSize.toFixed(6)} (${side} ${size})`,
		);
	}

	getQuotingContext(fairPrice: number): QuotingContext {
		const positionState = this.getState(fairPrice);
		const allowedSides = this.getAllowedSides(positionState);
		return {
			fairPrice,
			positionState,
			allowedSides,
		};
	}

	private getState(fairPrice: number): PositionState {
		const sizeBase = this.baseSize;
		const sizeUsd = sizeBase * fairPrice;
		const isLong = sizeBase > 0;
		const isCloseMode = Math.abs(sizeUsd) >= this.config.closeThresholdUsd;

		return {
			sizeBase,
			sizeUsd,
			isLong,
			isCloseMode,
		};
	}

	private getAllowedSides(state: PositionState): ("bid" | "ask")[] {
		// Close mode: only allow reducing
		if (state.isCloseMode) {
			return state.isLong ? ["ask"] : ["bid"];
		}

		// Hard inventory cap: if at/over cap, block the side that would grow it.
		const cap = this.config.maxInventoryUsd;
		if (cap > 0 && Math.abs(state.sizeUsd) >= cap) {
			return state.isLong ? ["ask"] : ["bid"];
		}

		// Normal: both sides
		return ["bid", "ask"];
	}

	getBaseSize(): number {
		return this.baseSize;
	}

	isCloseMode(fairPrice: number): boolean {
		const sizeUsd = Math.abs(this.baseSize * fairPrice);
		return sizeUsd >= this.config.closeThresholdUsd;
	}
}
