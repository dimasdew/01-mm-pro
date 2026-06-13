import WebSocket from "ws";
import type { MidPrice, PriceCallback } from "../types.js";
import { log } from "../utils/logger.js";

const BINANCE_FUTURES_WS = "wss://fstream.binance.com/ws";
const PING_INTERVAL_MS = 30_000; // Send ping every 30s
const PONG_TIMEOUT_MS = 10_000; // Expect pong within 10s
const STALE_THRESHOLD_MS = 60_000; // Consider stale after 60s without message
const STALE_CHECK_INTERVAL_MS = 10_000;

export type { MidPrice } from "../types.js";

export class BinancePriceFeed {
	private ws: WebSocket | null = null;
	private latestPrice: MidPrice | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private pingInterval: NodeJS.Timeout | null = null;
	private pongTimeout: NodeJS.Timeout | null = null;
	private staleCheckInterval: NodeJS.Timeout | null = null;
	private lastMessageTime = 0;
	private isClosing = false;
	private readonly wsUrl: string;

	// Public callback - can be set after construction
	onPrice: PriceCallback | null = null;

	constructor(symbol: string = "btcusdt") {
		this.wsUrl = `${BINANCE_FUTURES_WS}/${symbol.toLowerCase()}@bookTicker`;
	}

	connect(): void {
		if (this.ws) return;

		log.info(`Connecting to Binance Futures (${this.wsUrl})...`);

		this.ws = new WebSocket(this.wsUrl);

		this.ws.on("open", () => {
			log.info("Binance connected");
			this.lastMessageTime = Date.now();
			this.startPingInterval();
			this.startStaleCheck();
		});

		this.ws.on("message", (data: Buffer) => {
			this.lastMessageTime = Date.now();
			try {
				const msg = JSON.parse(data.toString()) as {
					b: string; // best bid
					a: string; // best ask
				};

				const bid = parseFloat(msg.b);
				const ask = parseFloat(msg.a);
				const mid = (bid + ask) / 2;

				this.latestPrice = {
					mid,
					bid,
					ask,
					timestamp: Date.now(),
				};

				if (this.onPrice) {
					this.onPrice(this.latestPrice);
				}
			} catch {
				// Ignore parse errors
			}
		});

		// Handle ping from server
		this.ws.on("ping", (data: Buffer) => {
			this.ws?.pong(data);
		});

		// Handle pong response (clears timeout)
		this.ws.on("pong", () => {
			this.clearPongTimeout();
		});

		this.ws.on("error", (err: Error) => {
			log.error("Binance WebSocket error:", err.message);
		});

		this.ws.on("close", () => {
			log.warn("Binance disconnected");
			this.cleanup();
			if (!this.isClosing) {
				this.scheduleReconnect();
			}
		});
	}

	private startPingInterval(): void {
		this.stopPingInterval();

		this.pingInterval = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.ping();
				this.startPongTimeout();
			}
		}, PING_INTERVAL_MS);
	}

	private stopPingInterval(): void {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
	}

	private startPongTimeout(): void {
		this.clearPongTimeout();

		this.pongTimeout = setTimeout(() => {
			log.warn("Binance pong timeout - connection dead");
			this.ws?.terminate(); // Force close
		}, PONG_TIMEOUT_MS);
	}

	private clearPongTimeout(): void {
		if (this.pongTimeout) {
			clearTimeout(this.pongTimeout);
			this.pongTimeout = null;
		}
	}

	private cleanup(): void {
		this.stopPingInterval();
		this.clearPongTimeout();
		this.stopStaleCheck();
		this.ws = null;
	}

	private startStaleCheck(): void {
		this.stopStaleCheck();

		this.staleCheckInterval = setInterval(() => {
			if (this.isClosing) return;

			const now = Date.now();
			const timeSinceMessage = now - this.lastMessageTime;

			if (this.lastMessageTime > 0 && timeSinceMessage > STALE_THRESHOLD_MS) {
				log.warn(
					`Binance stale (${timeSinceMessage}ms since last message). Reconnecting...`,
				);
				this.ws?.terminate();
			}
		}, STALE_CHECK_INTERVAL_MS);
	}

	private stopStaleCheck(): void {
		if (this.staleCheckInterval) {
			clearInterval(this.staleCheckInterval);
			this.staleCheckInterval = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;

		log.info("Reconnecting to Binance in 3s...");
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.connect();
		}, 3000);
	}

	getMidPrice(): MidPrice | null {
		return this.latestPrice;
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.cleanup();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
