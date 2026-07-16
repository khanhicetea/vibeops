import type { Random } from "./interfaces.ts";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRandom(): Random {
  return {
    bytes(length: number): Uint8Array {
      const buf = new Uint8Array(length);
      crypto.getRandomValues(buf);
      return buf;
    },
    hex(length: number): string {
      return toHex(this.bytes(length));
    },
    id(prefix = ""): string {
      const body = toHex(crypto.getRandomValues(new Uint8Array(8)));
      return prefix ? `${prefix}_${body}` : body;
    },
  };
}

export function createSeededRandom(seedHex: string): Random {
  // Deterministic PRNG for tests (xorshift-ish from seed).
  let state = BigInt(`0x${seedHex.slice(0, 16).padEnd(16, "0")}`) || 1n;
  function nextByte(): number {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    return Number(state & 0xffn);
  }
  return {
    bytes(length: number): Uint8Array {
      const buf = new Uint8Array(length);
      for (let i = 0; i < length; i++) buf[i] = nextByte();
      return buf;
    },
    hex(length: number): string {
      return toHex(this.bytes(length));
    },
    id(prefix = ""): string {
      const body = toHex(this.bytes(8));
      return prefix ? `${prefix}_${body}` : body;
    },
  };
}
