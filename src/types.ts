// Shared types across the codebase

import type Decimal from "decimal.js";

export interface MidPrice {
	mid: number;
	bid: number;
	ask: number;
	timestamp: number;
}

export type PriceCallback = (price: MidPrice) => void;

// Quote for order placement
export interface Quote {
	side: "bid" | "ask";
	price: Decimal;
	size: Decimal;
}
