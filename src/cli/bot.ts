// CLI entry point for market maker bot (PRO fork)
//
// Interactive by default: when run in a TTY with no explicit symbols, a setup
// wizard asks how many pairs, which pairs, and margin per entry. Skip the wizard
// with NON_INTERACTIVE=1 (Docker/CI), by piping stdin, or by passing symbols on
// the CLI.
//
//   npm run bot                 -> wizard (TTY) or SYMBOLS env / default BTC ETH SOL
//   npm run bot -- BTC ETH SOL  -> explicit list, no wizard
//   npm run bot -- BTC          -> single market, no wizard
//   SYMBOLS=BTC,ETH npm run bot -> via env (use NON_INTERACTIVE=1 to skip wizard)
//
// Sizing: each entry commits ~MARGIN_PER_ENTRY_USD of margin; the order notional
// is auto-derived per market from its initial-margin fraction (imf):
// notional = margin / imf. Leverage is NOT set by the bot — 01.xyz is
// cross-margin and leverage is fixed per market (max = 1/imf, "rata kanan").

import "dotenv/config";
import { parseSymbols } from "../bots/mm/config.js";
import { MultiMarketMaker } from "../bots/mm/multi.js";
import { log } from "../utils/logger.js";
import { runWizard, shouldRunWizard } from "./wizard.js";

async function main(): Promise<void> {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const cliArgs = process.argv.slice(2);

	let symbols: string[];
	let marginPerEntryUsd: number | undefined;

	if (shouldRunWizard(cliArgs)) {
		const res = await runWizard();
		symbols = res.symbols;
		marginPerEntryUsd = res.marginPerEntryUsd;
	} else {
		// Non-interactive: CLI args > SYMBOLS env > SYMBOL env > default.
		// Margin comes from env (MARGIN_PER_ENTRY_USD) via loadConfig.
		symbols = parseSymbols(cliArgs);
	}

	const fleet = new MultiMarketMaker({
		symbols,
		privateKey,
		marginPerEntryUsd,
	});
	await fleet.run();
}

main().catch((err) => {
	log.error("Fatal error:", err);
	process.exit(1);
});
