// Atomic order operations with immediate order ID tracking

import {
	FillMode,
	type NordUser,
	Side,
	type UserAtomicSubaction,
} from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { Quote } from "../types.js";
import { log } from "../utils/logger.js";

const MAX_ATOMIC_ACTIONS = 4;

// Errors the exchange returns under NORMAL operation — a PostOnly order that
// would cross, an order that can't rest, a cancel for an already-gone order.
// These are NOT failures of the bot or its connectivity; they happen constantly
// when the market moves while we're posting. They must NOT count toward the
// consecutive-error halt, or the bot dies mid-trade for doing its job correctly.
export class TransientOrderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransientOrderError";
	}
}

// Heuristic: does this exchange error look like a benign order rejection rather
// than a real connectivity/auth/sequencer failure? Matches on the common
// post-only / would-cross / reduce-only / already-cancelled signatures.
function isTransientOrderError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes("post") || // post-only would cross / post failed
		msg.includes("cross") || // would cross the book
		msg.includes("reduce") || // reduce-only rejection
		msg.includes("would match") ||
		msg.includes("immediately match") ||
		msg.includes("not found") || // cancel of an order that already filled/cancelled
		msg.includes("already") || // already cancelled / already filled
		msg.includes("unknown order") ||
		msg.includes("order does not exist") ||
		msg.includes("too small") || // size below min — transient if size is at edge
		msg.includes("min size") ||
		msg.includes("min order")
	);
}

// Cached order info
export interface CachedOrder {
	orderId: string;
	side: "bid" | "ask";
	price: Decimal;
	size: Decimal;
}

// Result type for atomic operations
interface AtomicResult {
	results: Array<{
		inner: {
			case: string;
			value: {
				orderId?: string;
				posted?: {
					orderId: string;
				};
			};
		};
	}>;
}

function formatAction(action: UserAtomicSubaction): string {
	if (action.kind === "cancel") {
		return `X${action.orderId}`;
	}
	const side = action.side === Side.Bid ? "B" : "A";
	const ro = action.isReduceOnly ? "RO" : "";
	const fm =
		action.fillMode === FillMode.PostOnly
			? "PO"
			: action.fillMode === FillMode.Limit
				? "LIM"
				: action.fillMode === FillMode.ImmediateOrCancel
					? "IOC"
					: "FOK";
	return `${side}${ro}[${fm}]@${action.price}x${action.size}`;
}

// Extract placed orders from atomic result
function extractPlacedOrders(
	result: AtomicResult,
	actions: UserAtomicSubaction[],
): CachedOrder[] {
	const orders: CachedOrder[] = [];
	const placeActions = actions.filter((a) => a.kind === "place");
	let placeIdx = 0;

	for (const r of result.results) {
		if (r.inner.case === "placeOrderResult" && r.inner.value.posted?.orderId) {
			const action = placeActions[placeIdx];
			if (action && action.kind === "place") {
				orders.push({
					orderId: r.inner.value.posted.orderId,
					side: action.side === Side.Bid ? "bid" : "ask",
					price: new Decimal(action.price as Decimal.Value),
					size: new Decimal(action.size as Decimal.Value),
				});
			}
			placeIdx++;
		}
	}
	return orders;
}

// Execute atomic operations in chunks of MAX_ATOMIC_ACTIONS
async function executeAtomic(
	user: NordUser,
	actions: UserAtomicSubaction[],
): Promise<CachedOrder[]> {
	if (actions.length === 0) return [];

	const allOrders: CachedOrder[] = [];
	const totalChunks = Math.ceil(actions.length / MAX_ATOMIC_ACTIONS);

	for (let i = 0; i < actions.length; i += MAX_ATOMIC_ACTIONS) {
		const chunkIdx = Math.floor(i / MAX_ATOMIC_ACTIONS) + 1;
		const chunk = actions.slice(i, i + MAX_ATOMIC_ACTIONS);

		log.info(
			`ATOMIC [${chunkIdx}/${totalChunks}]: ${chunk.map(formatAction).join(" ")}`,
		);

		let result: AtomicResult;
		try {
			result = (await user.atomic(chunk)) as AtomicResult;
		} catch (err) {
			// Benign exchange rejections (post-only would cross, cancel of an
			// already-gone order, size at min edge) are NORMAL market-making
			// outcomes — re-throw as transient so the risk layer doesn't count
			// them toward the consecutive-error halt.
			if (isTransientOrderError(err)) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn(`ATOMIC rejected (transient, ignored): ${msg}`);
				throw new TransientOrderError(msg);
			}
			throw err;
		}
		const placed = extractPlacedOrders(result, chunk);
		allOrders.push(...placed);

		if (placed.length > 0) {
			log.debug(`ATOMIC: placed [${placed.map((o) => o.orderId).join(", ")}]`);
		}
	}

	return allOrders;
}

// Build place action from quote
function buildPlaceAction(marketId: number, quote: Quote): UserAtomicSubaction {
	const action = {
		kind: "place" as const,
		marketId,
		side: quote.side === "bid" ? Side.Bid : Side.Ask,
		fillMode: FillMode.PostOnly,
		isReduceOnly: false,
		price: quote.price,
		size: quote.size,
	};
	log.debug(`ORDER JSON: ${JSON.stringify(action)}`);
	return action;
}

// Build cancel action from order ID
function buildCancelAction(orderId: string): UserAtomicSubaction {
	return {
		kind: "cancel" as const,
		orderId,
	};
}

// Check if order matches quote (same side, price, size)
function orderMatchesQuote(order: CachedOrder, quote: Quote): boolean {
	return (
		order.side === quote.side &&
		order.price.eq(quote.price) &&
		order.size.eq(quote.size)
	);
}

// Update quotes: only cancel/place if changed
export async function updateQuotes(
	user: NordUser,
	marketId: number,
	currentOrders: CachedOrder[],
	newQuotes: Quote[],
): Promise<CachedOrder[]> {
	const keptOrders: CachedOrder[] = [];
	const ordersToCancel: CachedOrder[] = [];
	const quotesToPlace: Quote[] = [];

	// Track kept orders by orderId, not object identity. `includes(order)` did a
	// reference-equality check that breaks the moment an order object is remapped
	// on a sync (e.g. rebuilt from API) — a kept order would fail the identity
	// test and get cancelled, churning the book. orderId is the stable key.
	// We also mark each order consumed so two identical quotes can't both claim
	// the same resting order (which would leave a stale order uncancelled).
	const keptIds = new Set<string>();

	// For each new quote, check if a not-yet-claimed matching order exists.
	for (const quote of newQuotes) {
		const matchingOrder = currentOrders.find(
			(o) => !keptIds.has(o.orderId) && orderMatchesQuote(o, quote),
		);
		if (matchingOrder) {
			keptOrders.push(matchingOrder);
			keptIds.add(matchingOrder.orderId);
		} else {
			quotesToPlace.push(quote);
		}
	}

	// Cancel orders that weren't claimed by any new quote.
	for (const order of currentOrders) {
		if (!keptIds.has(order.orderId)) {
			ordersToCancel.push(order);
		}
	}

	// Skip if nothing to do
	if (ordersToCancel.length === 0 && quotesToPlace.length === 0) {
		return currentOrders;
	}

	// Build actions: cancels first, then places
	const actions: UserAtomicSubaction[] = [
		...ordersToCancel.map((o) => buildCancelAction(o.orderId)),
		...quotesToPlace.map((q) => buildPlaceAction(marketId, q)),
	];

	const placedOrders = await executeAtomic(user, actions);
	return [...keptOrders, ...placedOrders];
}

// Cancel orders
export async function cancelOrders(
	user: NordUser,
	orders: CachedOrder[],
): Promise<void> {
	if (orders.length === 0) return;
	const actions = orders.map((o) => buildCancelAction(o.orderId));
	await executeAtomic(user, actions);
}

// Emergency flatten: cancel all resting orders, then close the open position with
// a reduce-only IOC order that crosses the spread (taker). Used by the risk halt.
//   positionBase > 0 => long  => SELL (ask) to flatten
//   positionBase < 0 => short => BUY  (bid) to flatten
// `limitPrice` should be set past the BBO so the IOC actually fills (e.g. for a
// long, a low sell price; for a short, a high buy price). Returns true if a
// flatten order was submitted.
export async function flattenPosition(
	user: NordUser,
	marketId: number,
	restingOrders: CachedOrder[],
	positionBase: Decimal,
	limitPrice: Decimal,
): Promise<boolean> {
	const size = positionBase.abs();
	if (size.lte(0)) {
		// Nothing to flatten, just cancel resting orders.
		await cancelOrders(user, restingOrders);
		return false;
	}

	const isLong = positionBase.gt(0);
	const actions: UserAtomicSubaction[] = [
		...restingOrders.map((o) => buildCancelAction(o.orderId)),
		{
			kind: "place" as const,
			marketId,
			side: isLong ? Side.Ask : Side.Bid, // long => sell, short => buy
			fillMode: FillMode.ImmediateOrCancel,
			isReduceOnly: true,
			price: limitPrice,
			size,
		},
	];

	log.warn(
		`FLATTEN: ${isLong ? "SELL" : "BUY"} ${size.toString()} reduce-only IOC @ ${limitPrice.toString()}`,
	);
	await executeAtomic(user, actions);
	return true;
}
