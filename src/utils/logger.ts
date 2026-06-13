// Clean, human-readable terminal logger for 01-mm-pro.
// - Short HH:MM:SS timestamps (not noisy ISO strings).
// - Color-coded levels + green/red PnL.
// - Aligned category tags so the eye scans fast.
// - A boxed STATUS line every status interval showing TOTAL PROFIT at a glance.
// Colors auto-disable when not a TTY or when NO_COLOR is set.

type LogOutput = (message: string) => void;
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

// ── color support ───────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY ?? false);

const c = {
	reset: useColor ? "\x1b[0m" : "",
	dim: useColor ? "\x1b[2m" : "",
	bold: useColor ? "\x1b[1m" : "",
	red: useColor ? "\x1b[31m" : "",
	green: useColor ? "\x1b[32m" : "",
	yellow: useColor ? "\x1b[33m" : "",
	blue: useColor ? "\x1b[34m" : "",
	magenta: useColor ? "\x1b[35m" : "",
	cyan: useColor ? "\x1b[36m" : "",
	gray: useColor ? "\x1b[90m" : "",
};

function paint(color: string, s: string): string {
	return useColor ? `${color}${s}${c.reset}` : s;
}

// Green for >=0, red for <0. Always shows sign + $.
function money(n: number, decimals = 2): string {
	const sign = n >= 0 ? "+" : "-";
	const body = `${sign}$${Math.abs(n).toFixed(decimals)}`;
	return paint(n >= 0 ? c.green : c.red, body);
}

function fmtUptime(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h${m}m`;
	if (m > 0) return `${m}m${s}s`;
	return `${s}s`;
}

let outputFn: LogOutput = (msg) => console.log(msg);
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function timestamp(): string {
	// HH:MM:SS local time — short and readable.
	return new Date().toTimeString().slice(0, 8);
}

function formatArg(a: unknown): string {
	if (a instanceof Error) return a.stack || a.message;
	if (typeof a === "object") return JSON.stringify(a);
	return String(a);
}

const LEVEL_TAG: Record<LogLevel, string> = {
	debug: paint(c.gray, "DBG"),
	info: paint(c.cyan, "INF"),
	warn: paint(c.yellow, "WRN"),
	error: paint(c.red, "ERR"),
};

function line(level: LogLevel, body: string, ...args: unknown[]): string {
	const argStr = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
	const ts = paint(c.gray, timestamp());
	return `${ts} ${LEVEL_TAG[level]} ${body}${argStr}`;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

// Category badge, padded so columns align.
function tag(label: string, color: string): string {
	return paint(color, label.padEnd(5));
}

export interface StatusSnapshot {
	symbol: string;
	mark: number; // current fair / mark price
	posBase: number; // signed position size in base
	posUsd: number; // signed position notional
	avgEntry: number;
	realizedPnl: number;
	unrealizedPnl: number;
	totalPnl: number;
	fillCount: number;
	volumeUsd: number;
	volBps: number;
	uptimeSec: number;
	bid: number | null;
	ask: number | null;
	halted: string | null;
}

export const log = {
	setOutput(fn: LogOutput): void {
		outputFn = fn;
	},

	setLevel(level: LogLevel): void {
		minLevel = level;
	},

	info(message: string, ...args: unknown[]): void {
		if (!shouldLog("info")) return;
		outputFn(line("info", message, ...args));
	},

	warn(message: string, ...args: unknown[]): void {
		if (!shouldLog("warn")) return;
		outputFn(line("warn", paint(c.yellow, message), ...args));
	},

	error(message: string, ...args: unknown[]): void {
		if (!shouldLog("error")) return;
		outputFn(line("error", paint(c.red, message), ...args));
	},

	debug(message: string, ...args: unknown[]): void {
		if (!shouldLog("debug")) return;
		outputFn(line("debug", paint(c.gray, message), ...args));
	},

	// ── MM-specific event logs ──────────────────────────────────

	quote(
		bid: number | null,
		ask: number | null,
		fair: number,
		spreadBps: number,
		mode: "normal" | "close",
	): void {
		if (!shouldLog("debug")) return; // quotes are noisy → debug only
		const bidStr = bid !== null ? paint(c.green, `$${bid.toFixed(2)}`) : "--";
		const askStr = ask !== null ? paint(c.red, `$${ask.toFixed(2)}`) : "--";
		const modeStr =
			mode === "close" ? paint(c.magenta, "CLOSE") : paint(c.dim, "quote");
		outputFn(
			line(
				"debug",
				`${tag("QUOTE", c.blue)} ${modeStr}  bid ${bidStr}  ask ${askStr}  fair $${fair.toFixed(2)}  ${paint(c.dim, `${spreadBps.toFixed(1)}bps`)}`,
			),
		);
	},

	position(
		sizeBase: number,
		sizeUsd: number,
		isLong: boolean,
		isCloseMode: boolean,
	): void {
		if (!shouldLog("debug")) return;
		const dir = isLong ? paint(c.green, "LONG ") : paint(c.red, "SHORT");
		const mode = isCloseMode ? paint(c.magenta, " [closing]") : "";
		outputFn(
			line(
				"debug",
				`${tag("POS", c.magenta)} ${dir} ${Math.abs(sizeBase).toFixed(5)} ($${Math.abs(sizeUsd).toFixed(2)})${mode}`,
			),
		);
	},

	fill(side: "buy" | "sell", price: number, size: number): void {
		const arrow =
			side === "buy" ? paint(c.green, "▲ BUY ") : paint(c.red, "▼ SELL");
		outputFn(
			line(
				"info",
				`${tag("FILL", c.bold)} ${arrow} ${size} @ $${price.toFixed(2)}`,
			),
		);
	},

	// Boxed status with TOTAL PROFIT front and center.
	status(s: StatusSnapshot): void {
		if (!shouldLog("info")) return;

		const posStr =
			s.posBase === 0
				? paint(c.dim, "flat")
				: `${s.posBase > 0 ? paint(c.green, "LONG") : paint(c.red, "SHORT")} ` +
					`${Math.abs(s.posBase).toFixed(4)} @ $${s.avgEntry.toFixed(2)}`;

		const haltStr = s.halted
			? `  ${paint(c.red, `🛑 HALTED:${s.halted}`)}`
			: "";

		const bidS = s.bid !== null ? `$${s.bid.toFixed(2)}` : "--";
		const askS = s.ask !== null ? `$${s.ask.toFixed(2)}` : "--";

		const header = paint(
			c.bold,
			`┌─ ${s.symbol} ─ ${fmtUptime(s.uptimeSec)} ${paint(c.dim, "uptime")} ─${haltStr}`,
		);
		const l1 = `│ ${paint(c.gray, "mark")}  $${s.mark.toFixed(2)}   ${paint(c.gray, "quotes")} ${paint(c.green, bidS)} / ${paint(c.red, askS)}   ${paint(c.gray, "vol")} ${s.volBps.toFixed(1)}bps`;
		const l2 = `│ ${paint(c.gray, "pos")}   ${posStr}`;
		const l3 =
			`│ ${paint(c.gray, "pnl")}   realized ${money(s.realizedPnl)}  ` +
			`unrealized ${money(s.unrealizedPnl)}`;
		const l4 = paint(
			c.bold,
			`│ ${paint(c.gray, "TOTAL")} ${money(s.totalPnl)}   ` +
				`${paint(c.dim, `${s.fillCount} fills · $${s.volumeUsd.toFixed(0)} vol`)}`,
		);
		const footer = paint(c.dim, "└────────────────────────────────────────");

		outputFn(`${header}\n${l1}\n${l2}\n${l3}\n${l4}\n${footer}`);
	},

	banner(): void {
		outputFn(
			paint(
				c.cyan,
				`
╔══════════════════════════════════════════╗
║   01-mm-pro · risk-managed market maker   ║
╚══════════════════════════════════════════╝`,
			),
		);
	},

	config(cfg: Record<string, unknown>): void {
		outputFn(line("info", paint(c.bold, "Config")));
		for (const [key, value] of Object.entries(cfg)) {
			outputFn(`  ${paint(c.gray, `${key}:`)} ${value}`);
		}
	},

	shutdown(): void {
		outputFn(
			line("info", paint(c.yellow, "Shutting down — cancelling orders...")),
		);
	},
};
