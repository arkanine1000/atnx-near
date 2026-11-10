// The NEAR RPC endpoints as the environment names them, browser-safe and
// free of near-api-js (lib/near/config.ts imports it). A variable may hold
// one URL or a comma-separated list, tried in order (lib/near/rpc.ts).
// An endpoint URL may carry a key, so anything written to a log names its
// host only (rpcHost).

export const DEFAULT_NEAR_RPC = 'https://test.rpc.fastnear.com';

// "a, b ,c" → the http(s) URLs among them, in order, without repeats.
export function parseRpcUrls(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// The endpoint's host, for logs ("test.rpc.fastnear.com").
export function rpcHost(url: string): string {
  try {
    return new URL(url).host || 'rpc';
  } catch {
    return 'rpc';
  }
}

// The endpoints the server reads and sends through: BM_NEAR_RPC (server
// only, may hold keyed URLs), else NEXT_PUBLIC_BM_NEAR_RPC, else the
// default.
export function serverRpcUrls(env: Record<string, string | undefined> = process.env): string[] {
  const own = parseRpcUrls(env.BM_NEAR_RPC);
  if (own.length > 0) return own;
  const shared = parseRpcUrls(env.NEXT_PUBLIC_BM_NEAR_RPC);
  return shared.length > 0 ? shared : [DEFAULT_NEAR_RPC];
}
