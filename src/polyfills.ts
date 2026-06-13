// Polyfills to let the bot run on Node 22/23 instead of requiring Node 25.
// The @n1xyz/nord-ts SDK uses Uint8Array.prototype.toHex / fromHex (Node 24+).
// We shim them when missing so the original `engines: node>=25` is no longer required.

interface HexCapableUint8Array {
	toHex?: () => string;
}
interface HexCapableUint8ArrayCtor {
	fromHex?: (hex: string) => Uint8Array;
}

const proto = Uint8Array.prototype as unknown as HexCapableUint8Array;
if (typeof proto.toHex !== "function") {
	proto.toHex = function (this: Uint8Array): string {
		let out = "";
		for (let i = 0; i < this.length; i++) {
			out += this[i].toString(16).padStart(2, "0");
		}
		return out;
	};
}

const ctor = Uint8Array as unknown as HexCapableUint8ArrayCtor;
if (typeof ctor.fromHex !== "function") {
	ctor.fromHex = function (hex: string): Uint8Array {
		const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
		const len = clean.length / 2;
		const arr = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			arr[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
		}
		return arr;
	};
}

export {};
