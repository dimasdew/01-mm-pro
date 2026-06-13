// CLI entry point for market maker bot (PRO fork)

import "dotenv/config";
import { loadConfig } from "../bots/mm/config.js";
import { MarketMaker } from "../bots/mm/index.js";
import { log } from "../utils/logger.js";

function main(): void {
	const symbol = process.argv[2]?.toUpperCase();
	if (!symbol) {
		console.error("Usage: npm run bot -- <symbol>");
		console.error("Example: npm run bot -- BTC");
		process.exit(1);
	}

	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const bot = new MarketMaker(loadConfig(symbol), privateKey);
	bot.run().catch((err) => {
		log.error("Fatal error:", err);
		process.exit(1);
	});
}

main();
