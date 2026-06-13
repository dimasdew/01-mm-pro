// Fair Price Provider interface (Dependency Inversion)
export interface FairPriceProvider {
	/** Record price sample from local and reference exchanges */
	addSample(localMid: number, referenceMid: number): void;
	/** Calculate fair price based on reference price + median offset */
	getFairPrice(referenceMid: number): number | null;
	/** Get current median offset (local - reference), null if insufficient samples */
	getMedianOffset(): number | null;
	/** Get raw median offset (ignores minSamples, for display during warmup) */
	getRawMedianOffset(): number | null;
	/** Get number of valid samples in window */
	getSampleCount(): number;
	/** Get current state for debugging */
	getState(): { offset: number | null; samples: number };
}

// Offset-median fair price calculator
// fair_price = reference_mid + median(local_mid - reference_mid)
// Creates per-second offset samples and takes median over configurable window

const MAX_SAMPLES = 500; // 5 minutes * 60 seconds + buffer

export interface FairPriceConfig {
	readonly windowMs: number; // Time window for samples (5 min = 300,000ms)
	readonly minSamples: number; // Min samples before producing fair price
}

interface OffsetSample {
	offset: number; // zo_mid - binance_mid
	second: number; // Unix second (timestamp / 1000 floored)
}

export class FairPriceCalculator implements FairPriceProvider {
	// Circular buffer: fixed-size array with head pointer
	private samples: OffsetSample[] = [];
	private head = 0; // Next write position
	private count = 0; // Actual sample count
	private lastSecond = 0; // Last recorded second

	constructor(private readonly config: FairPriceConfig) {}

	// Add a new sample when both prices are available (once per second)
	addSample(localMid: number, referenceMid: number): void {
		const now = Date.now();
		const currentSecond = Math.floor(now / 1000);

		// Only record one sample per second
		if (currentSecond <= this.lastSecond) {
			return;
		}
		this.lastSecond = currentSecond;

		const offset = localMid - referenceMid;

		// Write to circular buffer
		this.samples[this.head] = { offset, second: currentSecond };
		this.head = (this.head + 1) % MAX_SAMPLES;
		if (this.count < MAX_SAMPLES) {
			this.count++;
		}
	}

	// Get samples within time window
	private getValidSamples(): OffsetSample[] {
		const cutoffSecond = Math.floor((Date.now() - this.config.windowMs) / 1000);
		const valid: OffsetSample[] = [];

		for (let i = 0; i < this.count; i++) {
			const sample = this.samples[i];
			if (sample && sample.second > cutoffSecond) {
				valid.push(sample);
			}
		}

		return valid;
	}

	// Get median offset from samples
	getMedianOffset(): number | null {
		const valid = this.getValidSamples();

		if (valid.length < this.config.minSamples) {
			return null;
		}

		const offsets = valid.map((s) => s.offset).sort((a, b) => a - b);
		const mid = Math.floor(offsets.length / 2);

		if (offsets.length % 2 === 0) {
			return (offsets[mid - 1] + offsets[mid]) / 2;
		}
		return offsets[mid];
	}

	// Calculate fair price: reference + median(local - reference)
	getFairPrice(referenceMid: number): number | null {
		const offset = this.getMedianOffset();
		if (offset === null) return null;
		return referenceMid + offset;
	}

	getSampleCount(): number {
		return this.getValidSamples().length;
	}

	// Get raw median offset (ignores minSamples, for display during warmup)
	getRawMedianOffset(): number | null {
		const valid = this.getValidSamples();
		if (valid.length === 0) return null;

		const offsets = valid.map((s) => s.offset).sort((a, b) => a - b);
		const mid = Math.floor(offsets.length / 2);

		if (offsets.length % 2 === 0) {
			return (offsets[mid - 1] + offsets[mid]) / 2;
		}
		return offsets[mid];
	}

	// For debugging
	getState(): { offset: number | null; samples: number } {
		return {
			offset: this.getRawMedianOffset(),
			samples: this.getSampleCount(),
		};
	}
}
