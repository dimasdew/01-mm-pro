// Multi-symbol orchestrator (PRO fork)
//
// Runs several MarketMaker instances inside a SINGLE process, all sharing ONE
// wallet session / ZoClient. 01 Exchange uses cross-margin, so every market the
// account trades draws from the same collateral pool — sharing one client keeps
// position/account state consistent and avoids opening N redundant sessions.
//
// The orchestrator owns the process lifecycle: it installs the SIGINT/SIGTERM
// handlers once and tears down every instance gracefully (cancel resting orders)
// before exiting. Individual MarketMaker instances run with `start()` (no signal
// handlers, no process.exit) when driven from here.

import { createZoClient, type ZoClient } from "../../sdk/client.js";
import { log } from "../../utils/logger.js";
import { loadConfig, type MarketMakerConfig } from "./config.js";
import { MarketMaker } from "./index.js";

export interface MultiMarketMakerOptions {
	readonly symbols: string[];
	readonly privateKey: string;
	// Optional runtime override for margin committed per entry (USD). When set,
	// it overrides MARGIN_PER_ENTRY_USD from env for every market in this run.
	readonly marginPerEntryUsd?: number;
}

export class MultiMarketMaker {
	private client: ZoClient | null = null;
	private readonly instances: { symbol: string; mm: MarketMaker }[] = [];
	private shuttingDown = false;

	constructor(private readonly opts: MultiMarketMakerOptions) {}

	async run(): Promise<void> {
		log.banner();

		if (this.opts.symbols.length === 0) {
			throw new Error("No symbols configured. Set SYMBOLS=BTC,ETH,SOL");
		}

		log.info(
			`Multi-symbol market maker — markets: ${this.opts.symbols.join(", ")}`,
		);

		// One shared wallet session for all markets (cross-margin account).
		this.client = await createZoClient(this.opts.privateKey);

		// Install lifecycle handlers ONCE at the orchestrator level.
		this.registerShutdownHandlers();

		// Build one MarketMaker per symbol, all sharing the same client.
		const overrides =
			this.opts.marginPerEntryUsd !== undefined
				? { marginPerEntryUsd: this.opts.marginPerEntryUsd }
				: {};
		for (const symbol of this.opts.symbols) {
			const cfg: MarketMakerConfig = loadConfig(symbol, overrides);
			const mm = new MarketMaker(cfg, this.opts.privateKey, this.client);
			this.instances.push({ symbol, mm });
		}

		// Start each instance. If one symbol fails to initialize (e.g. market not
		// listed), we log and skip it instead of killing the whole fleet.
		const started: string[] = [];
		for (const { symbol, mm } of this.instances) {
			try {
				await mm.start();
				started.push(symbol);
				log.info(`[${symbol}] market maker started.`);
			} catch (err) {
				log.error(`[${symbol}] failed to start — skipping:`, err);
			}
		}

		if (started.length === 0) {
			log.error("No market makers started successfully. Exiting.");
			await this.shutdown();
			return;
		}

		log.info(
			`Running ${started.length}/${this.instances.length} markets: ${started.join(", ")}. Warming up feeds...`,
		);

		// Keep the process alive; instances run on their own timers/streams.
		await new Promise(() => {});
	}

	private registerShutdownHandlers(): void {
		const handler = () => {
			void this.shutdown();
		};
		process.on("SIGINT", handler);
		process.on("SIGTERM", handler);
	}

	private async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		log.shutdown();

		// Tear down all instances in parallel (each cancels its own resting orders).
		await Promise.allSettled(
			this.instances.map(({ symbol, mm }) =>
				mm.stop().catch((err) => log.error(`[${symbol}] stop error:`, err)),
			),
		);

		log.info("All markets stopped. Goodbye!");
		process.exit(0);
	}
}
