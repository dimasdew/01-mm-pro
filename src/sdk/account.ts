import type { Nord, NordUser, WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import { log } from "../utils/logger.js";

const RECONNECT_DELAY_MS = 3000;

// Tracked order from WebSocket
export interface TrackedOrder {
	orderId: string;
	side: "bid" | "ask";
	price: number;
	size: number;
	marketId: number;
}

// Fill event data
export interface FillEvent {
	orderId: string;
	side: "bid" | "ask";
	size: number;
	price: number;
	remaining: number;
	marketId: number;
}

type FillCallback = (fill: FillEvent) => void;

export class AccountStream {
	private subscription: ReturnType<Nord["subscribeAccount"]> | null = null;
	private orders = new Map<string, TrackedOrder>();
	private onFill: FillCallback | null = null;
	private isClosing = false;
	private reconnectTimeout: NodeJS.Timeout | null = null;

	// For re-sync on reconnect
	private user: NordUser | null = null;

	constructor(
		private readonly nord: Nord,
		private readonly accountId: number,
	) {}

	setOnFill(callback: FillCallback): void {
		this.onFill = callback;
	}

	connect(): void {
		if (this.subscription) return;

		log.info(`Subscribing to account updates (${this.accountId})...`);

		this.subscription = this.nord.subscribeAccount(this.accountId);
		this.setupEventHandlers();

		log.info("Account subscription active");
	}

	private setupEventHandlers(): void {
		if (!this.subscription) return;

		this.subscription.on("message", (data: WebSocketAccountUpdate) => {
			this.handleUpdate(data);
		});

		this.subscription.on("error", (err: Error) => {
			log.error("Account WebSocket error:", err.message);
		});

		this.subscription.on("close", () => {
			if (!this.isClosing) {
				log.warn("Account stream disconnected");
				this.subscription = null;
				this.scheduleReconnect();
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;

		log.info(`Reconnecting to account stream in ${RECONNECT_DELAY_MS}ms...`);
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			void this.reconnect();
		}, RECONNECT_DELAY_MS);
	}

	private async reconnect(): Promise<void> {
		// Close existing subscription
		if (this.subscription) {
			this.subscription.close();
			this.subscription = null;
		}

		// Re-sync orders before reconnecting
		if (this.user) {
			await this.resyncOrders();
		}

		// Reconnect
		this.subscription = this.nord.subscribeAccount(this.accountId);
		this.setupEventHandlers();

		log.info("Account stream reconnected");
	}

	private async resyncOrders(): Promise<void> {
		if (!this.user) return;

		try {
			log.info("Re-syncing orders from server...");
			await this.user.fetchInfo();
			this.syncOrders(this.user, this.accountId);
			log.info(`Re-synced ${this.orders.size} orders`);
		} catch (err) {
			log.error("Failed to re-sync orders:", err);
		}
	}

	private handleUpdate(data: WebSocketAccountUpdate): void {
		// Handle new placements
		for (const [orderId, order] of Object.entries(data.places)) {
			this.orders.set(orderId, {
				orderId,
				side: order.side,
				price: order.price,
				size: order.current_size,
				marketId: order.market_id,
			});
		}

		// Handle fills - use fill.side directly
		for (const [orderId, fill] of Object.entries(data.fills)) {
			const fillSize = fill.quantity;

			if (fillSize > 0 && this.onFill) {
				this.onFill({
					orderId,
					side: fill.side,
					size: fillSize,
					price: fill.price,
					remaining: fill.remaining,
					marketId: fill.market_id,
				});
			}

			if (fill.remaining <= 0) {
				this.orders.delete(orderId);
			} else {
				const existing = this.orders.get(orderId);
				if (existing) {
					existing.size = fill.remaining;
				}
			}
		}

		// Handle cancellations
		for (const orderId of Object.keys(data.cancels)) {
			this.orders.delete(orderId);
		}
	}

	// Sync initial state from user.fetchInfo()
	syncOrders(user: NordUser, accountId: number): void {
		this.user = user; // Store for reconnect
		this.orders.clear();
		const accountOrders = user.orders[accountId] || [];
		for (const o of accountOrders) {
			this.orders.set(String(o.orderId), {
				orderId: String(o.orderId),
				side: o.side,
				price: o.price,
				size: o.size,
				marketId: o.marketId,
			});
		}
	}

	getOrdersForMarket(marketId: number): TrackedOrder[] {
		return Array.from(this.orders.values()).filter(
			(o) => o.marketId === marketId,
		);
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.subscription) {
			this.subscription.close();
			this.subscription = null;
		}
	}
}
