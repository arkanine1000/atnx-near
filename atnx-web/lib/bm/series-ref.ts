// The 32-byte series reference shared by both rounds chains: bytes 0–15
// the ATNX market uuid, byte 16 a flag (1 = the fast demo series), bytes
// 17–23 reserved zero, bytes 24–31 a big-endian u64 nonce. The nonce lets a
// market start a new series of the same speed after an earlier one has
// ended (each reference can exist only once on chain: it seeds the Series
// PDA on Solana and is a unique key in the NEAR contract). Pure, no chain
// library: ./sol-shared re-exports these, and the NEAR keeper imports them
// directly.
//
// The reference of a live series is stored in bm.series.reference; read it
// back with refFromHex, never recompute it.

// Pass the nonce as 8 bytes or as a non-negative safe integer; omitted, it
// is 0.
export function refForSeries(atnxMarketId: string, fast: boolean, nonce: Uint8Array | number = 0): Uint8Array {
  const hex = atnxMarketId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('refForSeries: not a uuid');
  const ref = new Uint8Array(32);
  for (let i = 0; i < 16; i++) ref[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  ref[16] = fast ? 1 : 0;
  if (typeof nonce === 'number') {
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('refForSeries: nonce must be a non-negative integer');
    let n = BigInt(nonce);
    for (let i = 31; i >= 24; i--) {
      ref[i] = Number(n & 0xffn);
      n >>= 8n;
    }
  } else {
    if (nonce.length !== 8) throw new Error('refForSeries: nonce must be 8 bytes');
    ref.set(nonce, 24);
  }
  return ref;
}

// A fresh reference for a new series: the nonce is the current unix time
// in seconds.
export function newSeriesRef(atnxMarketId: string, fast: boolean): Uint8Array {
  return refForSeries(atnxMarketId, fast, Math.floor(Date.now() / 1000));
}

// Lowercase hex, 64 characters, no 0x prefix.
export function refToHex(ref: Uint8Array): string {
  return Array.from(ref, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Inverse of refToHex; accepts an optional 0x prefix.
export function refFromHex(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('refFromHex: need 32 bytes of hex');
  const ref = new Uint8Array(32);
  for (let i = 0; i < 32; i++) ref[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return ref;
}
