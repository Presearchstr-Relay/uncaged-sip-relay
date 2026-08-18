/**
 * Dependency-free synchronous SHA-256 (FIPS 180-4).
 *
 * Why a pure implementation lives here:
 *  - NIP-77 negentropy fingerprints are computed in tight synchronous loops;
 *    `crypto.subtle` is async and would poison the whole reconcile path.
 *  - `crypto.subtle` is unavailable in non-secure browsing contexts
 *    (plain http:// operator dashboards), where this is the fallback.
 *  - Zero dependencies keeps the Worker bundle small and auditable.
 *
 * This file is plain ES module JavaScript on purpose: it is shared verbatim
 * by the Cloudflare Worker (src/), the browser UI (ui/), and the Node test
 * suite (tests/). One implementation, three consumers, no drift.
 *
 * @module shared/sha256
 */

/** Round constants (first 32 bits of the fractional parts of the cube roots of the first 64 primes). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash values (first 32 bits of the fractional parts of the square roots of the first 8 primes). */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);

/**
 * Compute SHA-256 of a byte string.
 * @param {Uint8Array} data
 * @returns {Uint8Array} 32-byte digest
 */
export function sha256(data) {
  const H = new Uint32Array(H0);
  const byteLen = data.length;
  const bitLen = byteLen * 8;

  // Padded message length: 0x80 terminator + zero pad to ≡ 56 (mod 64),
  // then an 8-byte big-endian bit-length trailer.
  const padLen = (((56 - byteLen - 1) % 64) + 64) % 64 + 1;
  const msg = new Uint8Array(byteLen + padLen + 8);
  msg.set(data);
  msg[byteLen] = 0x80;
  // Length as 64-bit big-endian (bit lengths here stay < 2^53, high word is 0
  // unless data > 256 GB; write both words anyway).
  const dv = new DataView(msg.buffer);
  dv.setUint32(msg.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(msg.length - 4, bitLen >>> 0);

  for (let block = 0; block < msg.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = dv.getUint32(block + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const w2 = W[t - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i]);
  return out;
}

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Lowercase hex encode.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX_TABLE[bytes[i]];
  return out;
}

/**
 * Decode a hex string (accepts mixed case, validates strictly).
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** UTF-8 encode without Node Buffer. */
const textEncoder = new TextEncoder();

/**
 * Synchronous SHA-256 of a UTF-8 string, lowercase hex.
 * @param {string} text
 * @returns {string}
 */
export function sha256HexSync(text) {
  return bytesToHex(sha256(textEncoder.encode(text)));
}

/**
 * Async SHA-256 hex of a UTF-8 string using WebCrypto when available
 * (hardware-accelerated in browsers/workers), falling back to the pure JS
 * implementation in non-secure contexts and plain Node.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', textEncoder.encode(text));
    return bytesToHex(new Uint8Array(digest));
  }
  return sha256HexSync(text);
}
