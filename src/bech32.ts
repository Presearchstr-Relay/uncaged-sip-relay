/**
 * Minimal bech32 (BIP-173) decode for `npub` → hex pubkey.
 *
 * Only what the payment path needs: parse the operator's configured npub to
 * the 32-byte hex pubkey compared against zap receipt `p` tags. No bech32m,
 * no encoding — decoding NIP-19 npubs is bech32-only.
 *
 * @module src/bech32
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARKEY = new Map([...CHARSET].map((c, i) => [c, i]));

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  return [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
}

/** Convert a buffer between bit widths (BIP-173 convertbits). */
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return ret;
}

/**
 * Decode a NIP-19 npub to a lowercase hex pubkey. Returns null for anything
 * malformed or not an npub.
 */
export function npubToHex(npub: string): string | null {
  try {
    const value = npub.trim().toLowerCase();
    const split = value.lastIndexOf('1');
    if (split < 1 || split + 7 > value.length) return null;
    const hrp = value.slice(0, split);
    if (hrp !== 'npub') return null;

    const dataPart = value.slice(split + 1);
    const data: number[] = [];
    for (const c of dataPart) {
      const d = CHARKEY.get(c);
      if (d === undefined) return null;
      data.push(d);
    }
    if (data.length < 6) return null;

    const checksum = polymod(hrpExpand(hrp).concat(data));
    if (checksum !== 1) return null;

    const words = convertBits(data.slice(0, -6), 5, 8, false);
    if (!words || words.length !== 32) return null;

    return words.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
