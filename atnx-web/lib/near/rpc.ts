// One NEAR RPC provider over several endpoints, tried in order. Every
// JsonRpcProvider method goes through sendJsonRpc, so the provider handed
// out is a plain JsonRpcProvider whose sendJsonRpc picks the endpoint:
//
//   - a read that an endpoint refuses for its own reasons (rate limited,
//     a 5xx, a timeout, the network) is asked of the next one, and that
//     endpoint rests for a while (REST_MS); an answer from the chain itself
//     (no such account, a contract panic, ...) comes back as it is;
//   - a transaction is never sent twice blindly: after such a failure the
//     next endpoint is first asked for the transaction by its hash, and only
//     one that does not know it gets it again. A refusal of that second send
//     (an invalid nonce, say) is checked by hash once more before it is
//     passed on, so an account never signs a new transaction for one that
//     went through.
//
// near-api-js's FailoverRpcProvider moves on after any error at all,
// answers from the chain included, and re-sends transactions as they are,
// so it is not used. With one endpoint nothing changes but the logs.
//
// An endpoint URL may carry a key: errors and logs name the host only.
import { JsonRpcProvider, base64Decode, baseEncode, decodeSignedTransaction, encodeTransaction } from 'near-api-js';
import { NEAR_RPC_URLS } from './config';
import { DEFAULT_NEAR_RPC, parseRpcUrls, rpcHost, serverRpcUrls } from './rpc-urls';

// How long an endpoint that refused is passed over.
export const REST_MS = 30_000;

// With several endpoints, each tries a failed request again only once,
// quickly, before the next endpoint is asked.
const MANY_OPTIONS = { retries: 2, wait: 200, backoff: 2 };

type Send = (method: string, params: unknown) => Promise<unknown>;

// The part of a provider the failover drives (a JsonRpcProvider, or a fake
// in tests).
export interface RpcEndpointClient {
  sendJsonRpc: Send;
}

export interface RpcProviderOptions {
  // Makes the client for one endpoint (default: a JsonRpcProvider).
  make?: (url: string, many: boolean) => RpcEndpointClient;
  // Where a failover is reported (default console.warn). Hosts only.
  log?: (line: string) => void;
  now?: () => number;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function texts(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    const x = e as { name?: unknown; type?: unknown; message?: unknown };
    parts.push(String(x?.name ?? ''), String(x?.type ?? ''), String(x?.message ?? e));
    e = (e as { cause?: unknown })?.cause;
    if (typeof e !== 'object') break;
  }
  return parts.join(' ');
}

// Whether an error is the endpoint's own trouble (worth asking another
// endpoint, or asking again shortly) rather than an answer from the chain.
export function isRetryableRpcError(err: unknown): boolean {
  if (!err) return false;
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (typeof cause === 'number' && RETRY_STATUS.has(cause)) return true;
    e = cause;
  }
  const t = texts(err);
  if (/rate limit|too many requests|"code":\s*-429/i.test(t)) return true;
  if (/RetriesExceeded|Exceeded \d+ attempts/i.test(t)) return true;
  return /fetch failed|failed to fetch|FetchError|NetworkError|load failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|other side closed/i.test(t);
}

// Whether the endpoint turned the request away unread (rate limited), so a
// transaction in it was certainly not sent on.
export function isRpcRefusal(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause === 429) return true;
    e = cause;
  }
  return /rate limit|too many requests|"code":\s*-429/i.test(texts(err));
}

// What the log says about a refusal: never the message, which may hold the
// URL.
function refusalWord(err: unknown): string {
  const t = texts(err);
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause === 429) return 'rate limited';
    if (typeof cause === 'number' && RETRY_STATUS.has(cause)) return `HTTP ${cause}`;
    e = cause;
  }
  if (/rate limit|too many requests|-429/i.test(t)) return 'rate limited';
  if (/Exceeded \d+ attempts|RetriesExceeded/i.test(t)) return 'no answer';
  return 'unreachable';
}

// Replaces every endpoint URL in an error's message and stack with its host.
export function redactRpcError<T>(err: T, urls: readonly string[]): T {
  const e = err as unknown as { message?: unknown; stack?: unknown };
  if (!e || typeof e !== 'object') return err;
  const swap = (s: string) => {
    let out = s;
    for (const url of urls) {
      const host = rpcHost(url);
      for (const form of [url, url.replace(/\/+$/, '')]) if (form && form !== host) out = out.split(form).join(host);
    }
    return out;
  };
  try {
    if (typeof e.message === 'string') e.message = swap(e.message);
    if (typeof e.stack === 'string') e.stack = swap(e.stack);
  } catch {
    // A frozen error keeps its text.
  }
  return err;
}

// The transaction a send carries: its hash and signer, or null when the
// params are not a signed transaction this code can read.
export async function sentTransaction(method: string, params: unknown): Promise<{ hash: string; signerId: string } | null> {
  try {
    const b64 = method === 'send_tx' ? (params as { signed_tx_base64?: unknown })?.signed_tx_base64 : Array.isArray(params) ? params[0] : null;
    if (typeof b64 !== 'string') return null;
    const signed = decodeSignedTransaction(base64Decode(b64));
    const bytes = encodeTransaction(signed.transaction);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
    return { hash: baseEncode(digest), signerId: signed.transaction.signerId };
  } catch {
    return null;
  }
}

const SENDS = new Set(['send_tx', 'broadcast_tx_commit', 'broadcast_tx_async']);
const UNKNOWN_TX = /UNKNOWN_TRANSACTION|doesn't exist|does not exist|not found/i;

export function rpcProvider(urls: string | readonly string[], opts: RpcProviderOptions = {}): JsonRpcProvider {
  const list = typeof urls === 'string' ? parseRpcUrls(urls) : [...urls];
  if (list.length === 0) list.push(DEFAULT_NEAR_RPC);
  const many = list.length > 1;
  const make = opts.make ?? ((url: string, m: boolean) => new JsonRpcProvider({ url }, m ? MANY_OPTIONS : undefined) as unknown as RpcEndpointClient);
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const endpoints = list.map((url) => ({ url, host: rpcHost(url), client: make(url, many), restUntil: 0 }));
  type Endpoint = (typeof endpoints)[number];
  const redact = <T>(err: T): T => redactRpcError(err, list);

  // The endpoints in order, the resting ones last.
  const order = (): Endpoint[] => {
    const t = now();
    return [...endpoints.filter((e) => e.restUntil <= t), ...endpoints.filter((e) => e.restUntil > t)];
  };
  const rest = (e: Endpoint, err: unknown, next: Endpoint | undefined) => {
    const fresh = e.restUntil <= now();
    e.restUntil = now() + REST_MS;
    if (fresh) log(`[near/rpc] ${e.host}: ${refusalWord(err)}${next ? `; trying ${next.host}` : ''}`);
  };

  async function read(method: string, params: unknown): Promise<unknown> {
    const tried = order();
    let last: unknown = null;
    for (let i = 0; i < tried.length; i++) {
      try {
        return await tried[i].client.sendJsonRpc(method, params);
      } catch (err) {
        if (!many || !isRetryableRpcError(err)) throw redact(err);
        last = err;
        rest(tried[i], err, tried[i + 1]);
      }
    }
    throw redact(last);
  }

  // The transaction's status at one endpoint, waiting as the send would
  // have; null when that endpoint does not know it.
  async function statusAt(e: Endpoint, tx: { hash: string; signerId: string }, waitUntil: string): Promise<unknown | null> {
    try {
      return await e.client.sendJsonRpc('tx', { tx_hash: tx.hash, sender_account_id: tx.signerId, wait_until: waitUntil });
    } catch (err) {
      if (!isRetryableRpcError(err) && UNKNOWN_TX.test(texts(err))) return null;
      throw err;
    }
  }

  async function send(method: string, params: unknown): Promise<unknown> {
    const tried = order();
    try {
      return await tried[0].client.sendJsonRpc(method, params);
    } catch (first) {
      if (!many || !isRetryableRpcError(first)) throw redact(first);
      const tx = await sentTransaction(method, params);
      if (!tx) throw redact(first);
      rest(tried[0], first, tried[1]);
      const noWait = method === 'broadcast_tx_async' || (params as { wait_until?: unknown })?.wait_until === 'NONE';
      const waitUntil = String((params as { wait_until?: unknown })?.wait_until ?? 'EXECUTED_OPTIMISTIC');
      const known = async (e: Endpoint) => {
        const s = await statusAt(e, tx, noWait ? 'NONE' : waitUntil);
        return s === null ? null : method === 'broadcast_tx_async' ? tx.hash : s;
      };
      // The error passed on when every endpoint fails: a refusal only while
      // no send could have gone out, else one that leaves it open.
      let blame: unknown = first;
      for (let i = 1; i < tried.length; i++) {
        const e = tried[i];
        try {
          // Did the first send land? Only a transaction this endpoint does
          // not know is sent again.
          const landed = await known(e);
          if (landed !== null) return landed;
          try {
            return await e.client.sendJsonRpc(method, params);
          } catch (again) {
            if (isRetryableRpcError(again)) {
              if (isRpcRefusal(blame)) blame = again;
              throw again;
            }
            const late = await known(e).catch(() => null);
            if (late !== null) return late;
            throw redact(again);
          }
        } catch (err) {
          if (!isRetryableRpcError(err)) throw redact(err);
          rest(e, err, tried[i + 1]);
        }
      }
      throw redact(blame);
    }
  }

  const front = new JsonRpcProvider({ url: list[0] });
  (front as unknown as RpcEndpointClient).sendJsonRpc = (method, params) => (SENDS.has(method) ? send(method, params) : read(method, params));
  return front;
}

// The process's shared provider: on the server over serverRpcUrls()
// (BM_NEAR_RPC), in the browser over NEXT_PUBLIC_BM_NEAR_RPC.
let shared: { key: string; provider: JsonRpcProvider } | null = null;

export function nearRpcUrls(): readonly string[] {
  return typeof window === 'undefined' ? serverRpcUrls() : NEAR_RPC_URLS;
}

export function nearRpcProvider(): JsonRpcProvider {
  const urls = nearRpcUrls();
  const key = urls.join(',');
  if (!shared || shared.key !== key) shared = { key, provider: rpcProvider(urls) };
  return shared.provider;
}

// The endpoints' hosts, for a log line.
export function rpcHosts(urls: readonly string[]): string {
  return urls.map(rpcHost).join(', ');
}
