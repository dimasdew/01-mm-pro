import type {
	Nord,
	OrderbookEntry,
	WebSocketDeltaUpdate,
} from "@n1xyz/nord-ts";
import type { MidPrice, PriceCallback } from "../types.js";
import { log } from "../utils/logger.js";

const RECONNECT_DELAY_MS = 3000;
const STALE_THRESHOLD_MS = 60_000; // Consider stale after 60s without update
const STALE_CHECK_INTERVAL_MS = 10_000;
const MAX_LEVELS = 100; // Only keep top N levels (we only need BBO)

// Best Bid/Offer for clamping order prices
export interface BBO {
	bestBid: number;
	bestAsk: number;
}

// Callback for orderbook depth updates (for display)
export type OrderbookUpdateCallback = (
	bids: Map<number, number>,
	asks: Map<number, number>,
) => void;

// Sorted orderbook side (price -> size)
// Bids: descending (highest first), Asks: ascending (lowest first)
class OrderbookSide {
	private levels = new Map<number, number>();
	private sortedPrices: number[] = [];
	private readonly isAsk: boolean;

	constructor(isAsk: boolean) {
		this.isAsk = isAsk;
	}

	// Apply delta updates (size=0 means delete)
	applyDeltas(entries: OrderbookEntry[]): void {
		let needsSort = false;

		for (const { price, size } of entries) {
			if (size === 0) {
				if (this.levels.has(price)) {
					this.levels.delete(price);
					needsSort = true;
				}
			} else {
				if (!this.levels.has(price)) {
					needsSort = true;
				}
				this.levels.set(price, size);
			}
		}

		if (needsSort) {
			this.rebuildSortedPrices();
		}
	}

	// Set full snapshot (clears existing state)
	setSnapshot(entries: OrderbookEntry[]): void {
		this.levels.clear();
		for (const { price, size } of entries) {
			if (size > 0) {
				this.levels.set(price, size);
			}
		}
		this.rebuildSortedPrices();
	}

	private rebuildSortedPrices(): void {
		this.sortedPrices = Array.from(this.levels.keys());
		if (this.isAsk) {
			this.sortedPrices.sort((a, b) => a - b); // Ascending for asks
		} else {
			this.sortedPrices.sort((a, b) => b - a); // Descending for bids
		}

		// Trim to MAX_LEVELS to prevent memory growth
		if (this.sortedPrices.length > MAX_LEVELS) {
			const removed = this.sortedPrices.splice(MAX_LEVELS);
			for (const price of removed) {
				this.levels.delete(price);
			}
		}
	}

	// Get best price (top of book)
	getBest(): number | null {
		return this.sortedPrices.length > 0 ? this.sortedPrices[0] : null;
	}

	clear(): void {
		this.levels.clear();
		this.sortedPrices = [];
	}

	size(): number {
		return this.levels.size;
	}

	// Get all levels as a Map (for display)
	getLevels(): Map<number, number> {
		return new Map(this.levels);
	}
}

export class ZoOrderbookStream {
	private subscription: ReturnType<Nord["subscribeOrderbook"]> | null = null;
	private bids = new OrderbookSide(false);
	private asks = new OrderbookSide(true);
	private latestPrice: MidPrice | null = null;
	private lastUpdateId = 0;
	private lastUpdateTime = 0;
	private isClosing = false;
	private staleCheckInterval: NodeJS.Timeout | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private snapshotLoaded = false;
	private deltaBuffer: unknown[] = []; // Buffer deltas until snapshot is loaded

	// Public callbacks - can be set after construction
	onPrice: PriceCallback | null = null;
	onOrderbookUpdate: OrderbookUpdateCallback | null = null;

	constructor(
		private readonly nord: Nord,
		private readonly symbol: string,
		onPrice?: PriceCallback,
	) {
		this.onPrice = onPrice ?? null;
	}

	async connect(): Promise<void> {
		if (this.subscription) return;

		log.info(`Subscribing to Zo orderbook (${this.symbol})...`);

		// Clear state on fresh connect
		this.resetState();

		// 1. Subscribe to WebSocket FIRST (buffer messages until snapshot loaded)
		this.subscription = this.nord.subscribeOrderbook(this.symbol);
		this.setupEventHandlers();

		// 2. Fetch snapshot via REST
		await this.fetchSnapshot();

		// 3. Apply buffered deltas that come after snapshot
		this.applyBufferedDeltas();

		// Start staleness monitoring
		this.startStaleCheck();

		log.info(
			`Zo orderbook active (${this.bids.size()} bids, ${this.asks.size()} asks)`,
		);
	}

	private setupEventHandlers(): void {
		if (!this.subscription) return;

		this.subscription.on("message", (data: unknown) => {
			this.lastUpdateTime = Date.now();
			if (!this.snapshotLoaded) {
				// Buffer until snapshot is loaded
				this.deltaBuffer.push(data);
			} else {
				this.handleUpdate(data);
			}
		});

		this.subscription.on("error", (err: Error) => {
			log.error("Zo orderbook error:", err.message);
		});

		// SDK type doesn't include "close" event but WebSocket may emit it
		(
			this.subscription as unknown as {
				on(event: "close", cb: () => void): void;
			}
		).on("close", () => {
			if (!this.isClosing) {
				log.warn("Zo orderbook disconnected");
				this.subscription = null;
				this.scheduleReconnect();
			}
		});
	}

	private async fetchSnapshot(): Promise<void> {
		try {
			log.debug(`Fetching orderbook snapshot for ${this.symbol}...`);
			const response = await this.nord.getOrderbook({ symbol: this.symbol });
			log.debug(
				`Snapshot received: ${response.bids?.length ?? 0} bids, ${response.asks?.length ?? 0} asks`,
			);

			// Normalize and set snapshot
			const bids = this.normalizeEntries(response.bids);
			const asks = this.normalizeEntries(response.asks);

			this.bids.setSnapshot(bids);
			this.asks.setSnapshot(asks);
			this.lastUpdateId = response.updateId;
			this.snapshotLoaded = true;

			// Calculate and emit initial price
			this.emitPrice();

			log.info(`Orderbook snapshot loaded (updateId: ${response.updateId})`);
		} catch (err) {
			log.error("Failed to fetch orderbook snapshot:", err);
			throw err;
		}
	}

	private startStaleCheck(): void {
		if (this.staleCheckInterval) return;

		this.staleCheckInterval = setInterval(() => {
			if (this.isClosing) return;

			const now = Date.now();
			const timeSinceUpdate = now - this.lastUpdateTime;

			if (this.lastUpdateTime > 0 && timeSinceUpdate > STALE_THRESHOLD_MS) {
				log.warn(
					`Zo orderbook stale (${timeSinceUpdate}ms since last update). Reconnecting...`,
				);
				this.scheduleReconnect();
			}
		}, STALE_CHECK_INTERVAL_MS);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;

		// Close existing subscription immediately
		if (this.subscription) {
			this.subscription.close();
			this.subscription = null;
		}

		log.info(`Reconnecting to Zo orderbook in ${RECONNECT_DELAY_MS}ms...`);
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			void this.reconnect();
		}, RECONNECT_DELAY_MS);
	}

	private async reconnect(): Promise<void> {
		// Reset state
		this.resetState();

		// 1. Subscribe to WebSocket FIRST (buffer messages)
		this.subscription = this.nord.subscribeOrderbook(this.symbol);
		this.setupEventHandlers();

		// 2. Fetch fresh snapshot
		await this.fetchSnapshot();

		// 3. Apply buffered deltas
		this.applyBufferedDeltas();

		log.info("Zo orderbook reconnected");
	}

	private resetState(): void {
		this.bids.clear();
		this.asks.clear();
		this.latestPrice = null;
		this.lastUpdateId = 0;
		this.lastUpdateTime = 0;
		this.snapshotLoaded = false;
		this.deltaBuffer = [];
	}

	private applyBufferedDeltas(): void {
		const validDeltas = this.deltaBuffer.filter((data) => {
			const d = data as { update_id?: number; last_update_id?: number };
			// Apply deltas where last_update_id >= snapshot's updateId
			// This ensures we don't miss any updates
			return d.update_id !== undefined && d.update_id > this.lastUpdateId;
		});

		log.info(
			`Applying ${validDeltas.length} buffered deltas (discarded ${this.deltaBuffer.length - validDeltas.length})`,
		);

		for (const data of validDeltas) {
			this.handleUpdate(data);
		}

		this.deltaBuffer = [];
	}

	// Handle both {price, size} objects and [price, size] tuples
	private normalizeEntries(entries: unknown[] | undefined): OrderbookEntry[] {
		if (!entries || entries.length === 0) return [];

		return entries
			.map((entry) => {
				if (Array.isArray(entry)) {
					// Tuple format: [price, size]
					return { price: Number(entry[0]), size: Number(entry[1]) };
				}
				if (typeof entry === "object" && entry !== null) {
					// Object format: {price, size}
					const obj = entry as Record<string, unknown>;
					return { price: Number(obj.price), size: Number(obj.size) };
				}
				return null;
			})
			.filter(
				(e): e is OrderbookEntry =>
					e !== null && !Number.isNaN(e.price) && !Number.isNaN(e.size),
			);
	}

	private handleUpdate(rawData: unknown): void {
		// Skip updates until snapshot is loaded
		if (!this.snapshotLoaded) return;

		// Cast to expected type but handle defensively
		const data = rawData as WebSocketDeltaUpdate & { type?: string };

		// Sequence handling:
		// - REST snapshot gives us updateId N
		// - WebSocket delta has last_update_id (previous state) and update_id (new state)
		// - Skip stale updates where update_id <= our lastUpdateId
		// - Accept updates where last_update_id >= our lastUpdateId (we might miss some, but orderbook will self-correct)
		if (data.update_id !== undefined && data.update_id <= this.lastUpdateId) {
			// Stale update, skip
			return;
		}

		if (data.update_id !== undefined) {
			this.lastUpdateId = data.update_id;
		}

		// Normalize entries - handle both {price, size} objects and [price, size] tuples
		const normalizeBids = this.normalizeEntries(data.bids);
		const normalizeAsks = this.normalizeEntries(data.asks);

		// Apply deltas to local orderbook
		this.bids.applyDeltas(normalizeBids);
		this.asks.applyDeltas(normalizeAsks);

		// Emit price update
		this.emitPrice();
	}

	private emitPrice(): void {
		const bestBid = this.bids.getBest();
		const bestAsk = this.asks.getBest();

		if (bestBid === null || bestAsk === null) {
			return; // No valid BBO yet
		}

		const mid = (bestBid + bestAsk) / 2;
		const timestamp = Date.now();

		this.latestPrice = {
			mid,
			bid: bestBid,
			ask: bestAsk,
			timestamp,
		};

		if (this.onPrice) {
			this.onPrice(this.latestPrice);
		}

		// Emit orderbook depth for display
		if (this.onOrderbookUpdate) {
			this.onOrderbookUpdate(this.bids.getLevels(), this.asks.getLevels());
		}
	}

	getMidPrice(): MidPrice | null {
		return this.latestPrice;
	}

	// Get BBO for order price clamping
	getBBO(): BBO | null {
		const bestBid = this.bids.getBest();
		const bestAsk = this.asks.getBest();

		if (bestBid === null || bestAsk === null) {
			return null;
		}

		return { bestBid, bestAsk };
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.staleCheckInterval) {
			clearInterval(this.staleCheckInterval);
			this.staleCheckInterval = null;
		}
		if (this.subscription) {
			this.subscription.close();
			this.subscription = null;
		}
		this.resetState();
	}
}
