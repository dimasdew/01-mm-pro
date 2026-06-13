// Interactive startup wizard (PRO fork)
//
// Asks the operator three things before going live:
//   1) how many pairs to market-make
//   2) which pairs (validated, defaults offered)
//   3) margin per entry in USD (before leverage)
//
// Leverage is intentionally NOT asked: 01.xyz is cross-margin and leverage is
// fixed per market (max = 1/imf, "rata kanan"). The bot never sets leverage; it
// only sizes orders as notional = margin / imf. So margin-per-entry is the only
// capital knob the operator controls.
//
// Zero external deps — uses node:readline/promises.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export interface WizardResult {
	symbols: string[];
	marginPerEntryUsd: number;
}

const DEFAULT_PAIRS = ["BTC", "ETH", "SOL"];
const DEFAULT_MARGIN = 2;

// Whether to even run the wizard. Skipped when:
//   - NON_INTERACTIVE=1 (Docker / CI)
//   - stdin is not a TTY (piped / background)
//   - explicit symbols passed on the CLI (operator already decided)
export function shouldRunWizard(cliArgs: string[]): boolean {
	if (process.env.NON_INTERACTIVE === "1") return false;
	if (!stdin.isTTY) return false;
	if (cliArgs.length > 0) return false;
	return true;
}

function normalizeSymbol(s: string): string {
	return s
		.trim()
		.toUpperCase()
		.replace(/[-_/]?PERP$/, "")
		.replace(/USDT?$/, "")
		.replace(/[^A-Z0-9]/g, "");
}

function parsePairList(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(/[\s,]+/)) {
		const sym = normalizeSymbol(part);
		if (sym && !seen.has(sym)) {
			seen.add(sym);
			out.push(sym);
		}
	}
	return out;
}

export async function runWizard(): Promise<WizardResult> {
	const rl = createInterface({ input: stdin, output: stdout });

	try {
		console.log("");
		console.log("════════════════════════════════════════════");
		console.log("  01-mm-pro — setup");
		console.log("════════════════════════════════════════════");
		console.log("  Leverage = rata kanan (max per market, 1/imf).");
		console.log("  Notional per entry = margin / imf, auto per coin.");
		console.log("");

		// --- 1) how many pairs ---
		let count = 0;
		while (count <= 0) {
			const ans = (
				await rl.question(
					`Mau berapa pair? (default ${DEFAULT_PAIRS.length}): `,
				)
			).trim();
			if (ans === "") {
				count = DEFAULT_PAIRS.length;
				break;
			}
			const n = Number.parseInt(ans, 10);
			if (Number.isFinite(n) && n > 0 && n <= 50) {
				count = n;
			} else {
				console.log("  ! Masukin angka 1–50.");
			}
		}

		// --- 2) which pairs ---
		let symbols: string[] = [];
		while (symbols.length === 0) {
			const hint = DEFAULT_PAIRS.slice(0, count).join(",");
			const ans = await rl.question(
				`Pair apa aja? (pisah koma/spasi, default ${hint}): `,
			);
			const picked =
				ans.trim() === "" ? DEFAULT_PAIRS.slice(0, count) : parsePairList(ans);

			if (picked.length === 0) {
				console.log("  ! Minimal 1 pair valid.");
				continue;
			}
			if (picked.length !== count) {
				const ok = (
					await rl.question(
						`  ⚠️  Lo bilang ${count} pair tapi masukin ${picked.length} (${picked.join(", ")}). Pakai ${picked.length} ini? (y/n): `,
					)
				)
					.trim()
					.toLowerCase();
				if (ok !== "y" && ok !== "yes") continue;
			}
			symbols = picked;
		}

		// --- 3) margin per entry ---
		let margin = 0;
		while (margin <= 0) {
			const ans = (
				await rl.question(
					`Margin per entry berapa $? (sebelum leverage, default $${DEFAULT_MARGIN}): `,
				)
			).trim();
			if (ans === "") {
				margin = DEFAULT_MARGIN;
				break;
			}
			const m = Number.parseFloat(ans.replace(/^\$/, ""));
			if (Number.isFinite(m) && m > 0) {
				margin = m;
			} else {
				console.log("  ! Masukin angka > 0.");
			}
		}

		// --- recap + confirm ---
		console.log("");
		console.log("──────────── RECAP ────────────");
		console.log(`  Pairs        : ${symbols.join(", ")} (${symbols.length})`);
		console.log(`  Leverage     : rata kanan (max per market)`);
		console.log(`  Margin/entry : $${margin}`);
		console.log(`  Notional/coin: $${margin} / imf  (auto per market)`);
		console.log("────────────────────────────────");
		const go = (await rl.question("Lanjut LIVE dengan setting ini? (y/n): "))
			.trim()
			.toLowerCase();
		if (go !== "y" && go !== "yes") {
			console.log("Dibatalin. Bye.");
			process.exit(0);
		}

		return { symbols, marginPerEntryUsd: margin };
	} finally {
		rl.close();
	}
}
