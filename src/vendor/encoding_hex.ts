const HEX = "0123456789abcdef";

export function encodeHex(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0xf]!;
  }
  return out;
}

export function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
