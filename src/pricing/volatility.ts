// VolatilityEstimator — rolling realized volatility in bps from reference mid.
// Used to widen spread when the market moves fast (reduces adverse selection).
// Method: standard deviation of per-sample log returns over a time window,
// expressed in bps of price. Cheap, robust, no external deps.

interface PriceSample {
	price: number;
	ts: number;
}

export class VolatilityEstimator {
	private samples: PriceSample[] = [];

	constructor(private readonly windowMs: number) {}

	addSample(price: number): void {
		const ts = Date.now();
		this.samples.push({ price, ts });
		this.evict(ts);
	}

	private evict(now: number): void {
		const cutoff = now - this.windowMs;
		while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
			this.samples.shift();
		}
	}

	// Realized volatility expressed in bps (std-dev of returns * 10000).
	// Returns 0 until there are enough samples.
	getVolBps(): number {
		const n = this.samples.length;
		if (n < 5) return 0;

		const returns: number[] = [];
		for (let i = 1; i < n; i++) {
			const prev = this.samples[i - 1].price;
			const cur = this.samples[i].price;
			if (prev > 0) returns.push((cur - prev) / prev);
		}
		if (returns.length < 2) return 0;

		const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
		const variance =
			returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
		const std = Math.sqrt(variance);
		return std * 10000; // to bps
	}

	getSampleCount(): number {
		return this.samples.length;
	}
}
