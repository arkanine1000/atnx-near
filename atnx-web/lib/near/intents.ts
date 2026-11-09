// "Fund from any chain": what bringing USDC from another chain to NEAR
// would cost and how long it would take, priced live by NEAR Intents' 1Click
// API, and nothing more. ATNX runs on NEAR testnet with test USDG; NEAR
// Intents has no testnet, so every quote here is a dry run (`dry: true`),
// which returns the price and the time without a deposit address, so no
// money can move. The request builder only makes dry requests, and postQuote
// refuses to send any body that is not one. See lib/near/README.md.
//
// Pure and dependency-free: the route (app/api/near/intents/quote) wires in
// the real fetch, the tests a fake one. Browser-safe too, so the panel uses
// the same chain list and amount check as the server.
//
// Endpoints, fields and asset ids are from the 1Click docs
// (https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote,
// .../get-supported-tokens) and GET /v0/tokens as read on 2026-11-09.

export const ONECLICK_BASE = 'https://1click.chaindefuser.com';
export const QUOTE_PATH = '/v0/quote';
export const TOKENS_PATH = '/v0/tokens';

// Native USDC on NEAR mainnet (Circle's contract, an implicit account).
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// The chains the panel offers, by 1Click's `blockchain` name, each with its
// native USDC. The tokens list is checked on every quote (cached briefly),
// so a chain 1Click stops supporting reads as unavailable, not as an error.
export type OriginChain = 'sol' | 'base' | 'arb' | 'eth';

export interface OriginOption {
  chain: OriginChain;
  label: string;
  assetId: string;
  contract: string;
}

export const ORIGINS: readonly OriginOption[] = [
  { chain: 'sol', label: 'Solana', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { chain: 'base', label: 'Base', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { chain: 'arb', label: 'Arbitrum', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  { chain: 'eth', label: 'Ethereum', assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
];

export function originByChain(chain: unknown): OriginOption | null {
  return ORIGINS.find((o) => o.chain === chain) ?? null;
}

// The stand-in recipient (and refund account) of every preview quote: the
// all-zero implicit NEAR account. A user's ATNX account lives on testnet
// only, and its mainnet look-alike (alice.atnx.testnet -> alice.atnx.near)
// is not theirs; 1Click refuses a named account that does not exist on
// mainnet anyway (400 on 2026-11-09). 64 hex characters is the implicit
// account format the docs list for NEAR, the zero key is not one anybody
// can sign for, and a dry quote has no deposit address, so nothing can ever
// be sent there.
export const PREVIEW_RECIPIENT = '0'.repeat(64);

// 1 % (basis points), as in the docs' examples and the ticket. It sets the
// floor on what arrives, not the price shown.
export const SLIPPAGE_BPS = 100;
// When 1Click would start refunding an unfinished swap; required, and long
// enough for an Ethereum deposit to be mined.
export const DEADLINE_MS = 30 * 60_000;

export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);
export const MIN_UNITS = 1n * UNIT;
export const MAX_UNITS = 100_000n * UNIT;

// ---------------------------------------------------------------- inputs

export type AmountCheck = { ok: true; units: bigint } | { ok: false; error: 'bad_amount' | 'too_small' | 'too_large' };

// "25", "25.5", ".5" -> 6-decimal units, between 1 and 100,000 USDC.
export function parseUsdcAmount(input: unknown): AmountCheck {
  const t = typeof input === 'string' ? input.trim() : typeof input === 'number' && Number.isFinite(input) ? String(input) : null;
  if (t === null || t.length === 0 || t.length > 24 || !/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(t)) return { ok: false, error: 'bad_amount' };
  const [w, f = ''] = t.split('.');
  const units = BigInt(w || '0') * UNIT + BigInt((f + '000000').slice(0, USDC_DECIMALS));
  if (units < MIN_UNITS) return { ok: false, error: 'too_small' };
  if (units > MAX_UNITS) return { ok: false, error: 'too_large' };
  return { ok: true, units };
}

export interface QuoteInput {
  origin: OriginOption;
  units: bigint;
}

export type InputCheck = { ok: true; input: QuoteInput } | { ok: false; error: 'bad_chain' | 'bad_amount' | 'too_small' | 'too_large' };

// The route's body: { chain: "sol" | "base" | "arb" | "eth", amount: "25" }.
export function parseQuoteInput(body: unknown): InputCheck {
  const b = (body && typeof body === 'object' ? body : {}) as { chain?: unknown; amount?: unknown };
  const origin = originByChain(b.chain);
  if (!origin) return { ok: false, error: 'bad_chain' };
  const a = parseUsdcAmount(b.amount);
  if (!a.ok) return a;
  return { ok: true, input: { origin, units: a.units } };
}

// ------------------------------------------------------------- the request

// The quote request, typed so that `dry` can only be true.
export interface DryQuoteRequest {
  dry: true;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  refundTo: string;
  refundType: 'INTENTS';
  deadline: string;
}

// USDC on the chosen chain, sent to a deposit address there (ORIGIN_CHAIN),
// delivered as native USDC to a NEAR account (DESTINATION_CHAIN). EXACT_INPUT:
// the amount is what the user sends. The refund side goes to the same
// stand-in inside Intents; a refund only happens when a swap fails, so it
// does not change the price, and a real version would refund to the sender
// on the origin chain (ORIGIN_CHAIN), which needs their address there.
export function buildDryQuoteRequest(input: QuoteInput, nowMs: number): DryQuoteRequest {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: input.origin.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_USDC_ASSET,
    amount: input.units.toString(),
    recipient: PREVIEW_RECIPIENT,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: PREVIEW_RECIPIENT,
    refundType: 'INTENTS',
    deadline: new Date(nowMs + DEADLINE_MS).toISOString(),
  };
}

export class NotDryError extends Error {
  constructor() {
    super('refusing to send a 1Click quote that is not a dry run');
  }
}

// Throws unless `body` is a quote request with dry === true (the boolean,
// not a truthy value). postQuote runs it on the object and again on the
// exact JSON it is about to send.
export function assertDry(body: unknown): asserts body is { dry: true } {
  if (!body || typeof body !== 'object' || (body as { dry?: unknown }).dry !== true) throw new NotDryError();
}

// --------------------------------------------------------------- transport

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface FetchResponse {
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export class IntentsTimeout extends Error {
  constructor(ms: number) {
    super(`1Click did not answer within ${ms} ms`);
  }
}

export const QUOTE_TIMEOUT_MS = 10_000;
export const TOKENS_TIMEOUT_MS = 8_000;

// One request, aborted after `ms`. Returns the status and the parsed JSON
// (null when the body is not JSON).
async function request(fetch: FetchLike, url: string, init: FetchInit, ms: number): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    if (timedOut) throw new IntentsTimeout(ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface PostQuoteOptions {
  fetch: FetchLike;
  baseUrl?: string;
  // A 1Click partner JWT, optional (sent as X-API-Key, per the docs). Without
  // one, 1Click adds its unauthenticated fee, which the quote already shows.
  apiKey?: string;
  timeoutMs?: number;
}

// POST /v0/quote with a dry request. The only function here that talks to
// the quote endpoint; it refuses anything but dry: true.
export async function postQuote(opts: PostQuoteOptions, body: DryQuoteRequest): Promise<{ status: number; json: unknown }> {
  assertDry(body);
  const payload = JSON.stringify(body);
  assertDry(JSON.parse(payload));
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (opts.apiKey) headers['X-API-Key'] = opts.apiKey;
  return request(opts.fetch, `${opts.baseUrl ?? ONECLICK_BASE}${QUOTE_PATH}`, { method: 'POST', headers, body: payload }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS);
}

// ------------------------------------------------------------- token list

export interface IntentsToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress: string | null;
}

// GET /v0/tokens -> the entries with the fields the panel needs; anything
// malformed is dropped. Throws if the body is not a list.
export function parseTokens(json: unknown): IntentsToken[] {
  if (!Array.isArray(json)) throw new Error('1Click tokens: not a list');
  const out: IntentsToken[] = [];
  for (const t of json) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.assetId !== 'string' || typeof r.blockchain !== 'string' || typeof r.symbol !== 'string') continue;
    if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 36) continue;
    out.push({
      assetId: r.assetId,
      decimals: r.decimals,
      blockchain: r.blockchain,
      symbol: r.symbol,
      contractAddress: typeof r.contractAddress === 'string' ? r.contractAddress : null,
    });
  }
  return out;
}

export interface TokenCache {
  get(): Promise<IntentsToken[]>;
}

export const TOKENS_TTL_MS = 5 * 60_000;
// A list this old is still used when a refresh fails.
export const TOKENS_MAX_STALE_MS = 60 * 60_000;

// The tokens list, fetched at most once per TTL, one fetch at a time. If a
// refresh fails, the last good list serves for up to an hour.
export function createTokenCache(opts: { fetch: FetchLike; baseUrl?: string; ttlMs?: number; maxStaleMs?: number; timeoutMs?: number; now?: () => number }): TokenCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? TOKENS_TTL_MS;
  const maxStale = opts.maxStaleMs ?? TOKENS_MAX_STALE_MS;
  let cached: { at: number; tokens: IntentsToken[] } | null = null;
  let inflight: Promise<IntentsToken[]> | null = null;

  async function load(): Promise<IntentsToken[]> {
    const r = await request(opts.fetch, `${opts.baseUrl ?? ONECLICK_BASE}${TOKENS_PATH}`, { method: 'GET', headers: { Accept: 'application/json' } }, opts.timeoutMs ?? TOKENS_TIMEOUT_MS);
    if (r.status !== 200) throw new Error(`1Click tokens: HTTP ${r.status}`);
    const tokens = parseTokens(r.json);
    cached = { at: now(), tokens };
    return tokens;
  }

  return {
    async get() {
      if (cached && now() - cached.at < ttl) return cached.tokens;
      if (!inflight) {
        inflight = load().finally(() => {
          inflight = null;
        });
      }
      try {
        return await inflight;
      } catch (err) {
        if (cached && now() - cached.at < maxStale) return cached.tokens;
        throw err;
      }
    },
  };
}

export interface RouteTokens {
  origin: IntentsToken;
  destination: IntentsToken;
}

// Both ends of the route in the current list: the origin chain's USDC and
// NEAR's native USDC, by asset id, chain and symbol. Null if either is gone.
export function findRoute(tokens: IntentsToken[], origin: OriginOption): RouteTokens | null {
  const o = tokens.find((t) => t.assetId === origin.assetId && t.blockchain === origin.chain && t.symbol === 'USDC');
  const d = tokens.find((t) => t.assetId === NEAR_USDC_ASSET && t.blockchain === 'near' && t.symbol === 'USDC');
  return o && d ? { origin: o, destination: d } : null;
}

// ------------------------------------------------------------ the response

// What the panel shows, in 6-decimal USDC units as strings (JSON has no
// bigint). fee is what is lost on the way: sent minus received, never
// below 0. timeSecs is 1Click's estimate from the deposit being confirmed
// on the origin chain to the USDC arriving.
export interface QuotePreview {
  chain: OriginChain;
  sendUnits: string;
  receiveUnits: string;
  minReceiveUnits: string;
  feeUnits: string;
  timeSecs: number;
  quotedAt: string;
}

const INT = /^\d{1,40}$/;

// Units of a token with `decimals` -> 6-decimal units (rounded down).
export function toUsdcUnits(units: bigint, decimals: number): bigint {
  if (decimals === USDC_DECIMALS) return units;
  if (decimals > USDC_DECIMALS) return units / 10n ** BigInt(decimals - USDC_DECIMALS);
  return units * 10n ** BigInt(USDC_DECIMALS - decimals);
}

export class BadQuoteResponse extends Error {}

// A 1Click quote response -> the preview. `amount` is the base-unit amount
// the request sent. Throws BadQuoteResponse when the shape is wrong, the
// quote is for another amount, or it carries a deposit address (which only
// a non-dry quote has).
export function parseQuoteResponse(json: unknown, ctx: { chain: OriginChain; amount: string; route: RouteTokens; now: number }): QuotePreview {
  if (!json || typeof json !== 'object') throw new BadQuoteResponse('not an object');
  const r = json as { quote?: unknown; quoteRequest?: unknown; timestamp?: unknown };
  const q = r.quote as Record<string, unknown> | undefined;
  if (!q || typeof q !== 'object') throw new BadQuoteResponse('no quote');
  if (q.depositAddress !== undefined) throw new BadQuoteResponse('a deposit address: not a dry quote');
  const req = r.quoteRequest as { dry?: unknown } | undefined;
  if (req && typeof req === 'object' && req.dry !== true) throw new BadQuoteResponse('echoed request is not dry');
  for (const k of ['amountIn', 'amountOut', 'minAmountOut'] as const) {
    if (typeof q[k] !== 'string' || !INT.test(q[k] as string)) throw new BadQuoteResponse(`bad ${k}`);
  }
  if (typeof q.timeEstimate !== 'number' || !Number.isFinite(q.timeEstimate) || q.timeEstimate < 0) throw new BadQuoteResponse('bad timeEstimate');
  const amountIn = BigInt(q.amountIn as string);
  if (amountIn !== BigInt(ctx.amount)) throw new BadQuoteResponse('quote is for another amount');
  const send = toUsdcUnits(amountIn, ctx.route.origin.decimals);
  const receive = toUsdcUnits(BigInt(q.amountOut as string), ctx.route.destination.decimals);
  const minReceive = toUsdcUnits(BigInt(q.minAmountOut as string), ctx.route.destination.decimals);
  const fee = send > receive ? send - receive : 0n;
  const quotedAt = typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp)) ? new Date(r.timestamp).toISOString() : new Date(ctx.now).toISOString();
  return {
    chain: ctx.chain,
    sendUnits: send.toString(),
    receiveUnits: receive.toString(),
    minReceiveUnits: minReceive.toString(),
    feeUnits: fee.toString(),
    timeSecs: Math.round(q.timeEstimate),
    quotedAt,
  };
}

// ---------------------------------------------------------------- failures

export type QuoteErrorCode = 'bad_chain' | 'bad_amount' | 'too_small' | 'too_large' | 'unavailable' | 'timeout' | 'busy' | 'upstream';

// A refused quote -> why. 1Click answers 400 { message } for anything it will
// not quote: "Amount is too low for bridge, try at least N" (N in the
// origin token's units, sometimes 0), "tokenIn is not valid", or a bare
// "Internal server error" for a recipient it cannot deliver to. Everything
// but the amount reads as no route.
export function classifyQuoteFailure(status: number, json: unknown): { code: 'too_small'; minUnits: bigint | null } | { code: 'unavailable' | 'busy' | 'upstream' } {
  const message = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : '';
  if (status === 429) return { code: 'busy' };
  if (status >= 500 || status === 401 || status === 403) return { code: 'upstream' };
  if (/amount is too low/i.test(message)) {
    const m = /at least\s+(\d{1,40})/i.exec(message);
    const min = m ? BigInt(m[1]) : 0n;
    return { code: 'too_small', minUnits: min > 0n ? min : null };
  }
  return { code: 'unavailable' };
}

// Amounts for the panel: 6-decimal units -> "24.9956", 2 to 4 decimals,
// rounded down (what arrives) or up (the fee), so neither looks better
// than it is.
export function fmtUsdc(units: bigint | string, round: 'down' | 'up' = 'down'): string {
  let u = typeof units === 'string' ? BigInt(units) : units;
  if (round === 'up' && u % 100n !== 0n) u += 100n - (u % 100n);
  const whole = u / UNIT;
  const frac4 = (u % UNIT) / 100n; // 0..9999
  let f = frac4.toString().padStart(4, '0').replace(/0+$/, '');
  if (f.length < 2) f = f.padEnd(2, '0');
  return `${whole.toLocaleString('en-US')}.${f}`;
}

// The fee line: "0.0044 USDC", "under 0.0001 USDC" or "none".
export function fmtFee(units: bigint | string): string {
  const u = typeof units === 'string' ? BigInt(units) : units;
  if (u === 0n) return 'none';
  if (u < 100n) return 'under 0.0001 USDC';
  return `${fmtUsdc(u, 'up')} USDC`;
}

// "About 20 seconds", "About 2 minutes", "About 1 hour".
export function fmtDuration(secs: number): string {
  const plural = (n: number, w: string) => `About ${n} ${w}${n === 1 ? '' : 's'}`;
  if (secs < 60) return plural(Math.max(1, Math.round(secs)), 'second');
  const min = Math.round(secs / 60);
  if (min < 60) return plural(min, 'minute');
  return plural(Math.round(min / 60), 'hour');
}

const wholeUsdc = (units: bigint) => (units / UNIT).toLocaleString('en-US');

// What a failure means, in plain words for someone who has never traded.
export function quoteErrorText(code: QuoteErrorCode, opts: { chainLabel?: string; minUnits?: bigint | null } = {}): string {
  const from = opts.chainLabel ? ` from ${opts.chainLabel}` : '';
  switch (code) {
    case 'bad_chain':
      return 'Pick the chain your USDC is on.';
    case 'bad_amount':
      return 'Enter an amount in USDC, like 25.';
    case 'too_small':
      // minUnits undefined: our own floor; null or a number: 1Click's.
      if (opts.minUnits === undefined) return `Enter at least ${wholeUsdc(MIN_UNITS)} USDC.`;
      return opts.minUnits ? `That is too little to send${from}. Try at least ${fmtUsdc(opts.minUnits, 'up')} USDC.` : `That is too little to send${from}. Try a larger amount.`;
    case 'too_large':
      return `Enter at most ${wholeUsdc(MAX_UNITS)} USDC.`;
    case 'unavailable':
      return `USDC can't come over${from} right now. Try another chain.`;
    case 'timeout':
      return 'Getting a price took too long. Try again.';
    case 'busy':
      return 'Too many price checks just now. Try again in a minute.';
    case 'upstream':
      return 'Live prices are unavailable right now. Try again later.';
  }
}

// ------------------------------------------------------------------- route

export interface IntentsRouteResult {
  status: number;
  body: Record<string, unknown>;
}

export interface IntentsDeps {
  fetch: FetchLike;
  tokens: TokenCache;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  now?: () => number;
  log?: (msg: string, detail?: unknown) => void;
}

const fail = (status: number, code: QuoteErrorCode, opts: { chainLabel?: string; minUnits?: bigint | null } = {}): IntentsRouteResult => ({
  status,
  body: { error: code, message: quoteErrorText(code, opts), ...(opts.minUnits ? { minUnits: opts.minUnits.toString() } : {}) },
});

// POST { chain, amount } -> 200 { quote: QuotePreview, preview: true, recipient }
// or { error, message } with 400 (input), 422 (no quote for this route or
// amount), 503 (rate limited), 502 (1Click failed) or 504 (timeout).
export async function handleIntentsQuote(deps: IntentsDeps, body: unknown): Promise<IntentsRouteResult> {
  const now = deps.now ?? Date.now;
  const parsed = parseQuoteInput(body);
  if (!parsed.ok) return fail(400, parsed.error);
  const { origin } = parsed.input;
  const chainLabel = origin.label;

  try {
    let tokens: IntentsToken[];
    try {
      tokens = await deps.tokens.get();
    } catch (err) {
      deps.log?.('tokens', err);
      return fail(err instanceof IntentsTimeout ? 504 : 502, err instanceof IntentsTimeout ? 'timeout' : 'upstream');
    }
    const route = findRoute(tokens, origin);
    if (!route) return fail(422, 'unavailable', { chainLabel });
    // The panel's amounts are 6-decimal USDC; a USDC with other decimals
    // would need its own scaling of `amount`.
    if (route.origin.decimals !== USDC_DECIMALS) return fail(422, 'unavailable', { chainLabel });

    const req = buildDryQuoteRequest(parsed.input, now());
    const r = await postQuote({ fetch: deps.fetch, baseUrl: deps.baseUrl, apiKey: deps.apiKey, timeoutMs: deps.timeoutMs }, req);
    if (r.status !== 200 && r.status !== 201) {
      const f = classifyQuoteFailure(r.status, r.json);
      deps.log?.(`quote ${r.status}`, r.json);
      if (f.code === 'too_small') return fail(422, 'too_small', { chainLabel, minUnits: f.minUnits === null ? null : toUsdcUnits(f.minUnits, route.origin.decimals) });
      if (f.code === 'unavailable') return fail(422, 'unavailable', { chainLabel });
      if (f.code === 'busy') return fail(503, 'busy');
      return fail(502, 'upstream');
    }
    const quote = parseQuoteResponse(r.json, { chain: origin.chain, amount: req.amount, route, now: now() });
    return { status: 200, body: { quote, preview: true, recipient: { kind: 'placeholder', accountId: PREVIEW_RECIPIENT } } };
  } catch (err) {
    if (err instanceof IntentsTimeout) return fail(504, 'timeout');
    if (err instanceof NotDryError) throw err;
    deps.log?.('quote', err);
    return fail(502, 'upstream');
  }
}
