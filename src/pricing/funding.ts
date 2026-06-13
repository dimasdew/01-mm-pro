// FundingFeed — polls Binance Futures funding rate so the MM can bias quotes
// away from paying funding. Positive funding => longs pay shorts; we lean to be
// short-ish (quote asks tighter / bids wider). Negative => opposite.
// Source: GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT

import { log } from "../utils/logger.js";

export class FundingFeed {
	private rate = 0; // last funding rate (fraction, e.g. 0.0001 = 0.01%)
	private lastUpdate = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly url: string;

	constructor(
		binanceSymbol: string, // e.g. "btcusdt"
		private readonly pollMs: number,
	) {
		this.url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol.toUpperCase()}`;
	}

	async start(): Promise<void> {
		await this.poll();
		this.timer = setInterval(() => {
			void this.poll();
		}, this.pollMs);
	}

	private async poll(): Promise<void> {
		try {
			const res = await fetch(this.url);
			if (!res.ok) {
				log.warn(`Funding poll HTTP ${res.status}`);
				return;
			}
			const data = (await res.json()) as { lastFundingRate?: string };
			if (data.lastFundingRate !== undefined) {
				const r = Number(data.lastFundingRate);
				if (Number.isFinite(r)) {
					this.rate = r;
					this.lastUpdate = Date.now();
				}
			}
		} catch (err) {
			log.warn(
				`Funding poll error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Current funding rate as a fraction. 0 if never fetched.
	getRate(): number {
		return this.rate;
	}

	getAgeMs(): number {
		return this.lastUpdate === 0 ? Infinity : Date.now() - this.lastUpdate;
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
