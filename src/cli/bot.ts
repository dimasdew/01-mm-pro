// CLI entry point for market maker bot (PRO fork)
//
// Multi-symbol by default: runs BTC, ETH, SOL in ONE process sharing a single
// wallet session (01 Exchange cross-margin account). Override which markets to
// run via CLI args or env:
//
//   npm run bot                 -> SYMBOLS env, or default BTC ETH SOL
//   npm run bot -- BTC ETH SOL  -> explicit list
//   npm run bot -- BTC          -> single market
//   SYMBOLS=BTC,ETH npm run bot -> via env
//
// Sizing: each entry commits ~MARGIN_PER_ENTRY_USD (default $2) of margin; the
// order notional is auto-derived per market from its initial-margin fraction
// (imf): notional = margin / imf. Leverage is NOT set by the bot — 01.xyz is
// cross-margin and leverage is fixed per market (max = 1/imf).

import "dotenv/config";
import { parseSymbols } from "../bots/mm/config.js";
import { MultiMarketMaker } from "../bots/mm/multi.js";
import { log } from "../utils/logger.js";

function main(): void {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const symbols = parseSymbols(process.argv.slice(2));

	const fleet = new MultiMarketMaker({ symbols, privateKey });
	fleet.run().catch((err) => {
		log.error("Fatal error:", err);
		process.exit(1);
	});
}

main();
