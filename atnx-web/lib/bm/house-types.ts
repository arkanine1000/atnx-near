// The house contract's interface as the keeper and the verifier see it:
// every method and view name, every argument object, every view result and
// event, with the encode and decode helpers. All assumptions about JSON
// shapes live in this file, so a change on the contract side is one edit
// here. Pure: no RPC, no database.
//
// Conventions:
//   - amounts (USDG, 6 decimals) are U128 decimal strings;
//   - u64 values (position ids, print ids, scores in hundredths, times in
//     unix seconds of the chain's clock) are U64 decimal strings both ways
//     (encU64); the decoders also read a JSON number;
//   - market ids are u32 JSON numbers, positions' leverage a u8 number,
//     basis points u16/u32 numbers;
//   - scores and readings are VI × 100 (`_e2`), as toE2 in ./settle writes
//     them;
//   - a market's reference is the ATNX market uuid as 32 lowercase hex
//     characters, without dashes;
//   - enums are their variant names: sides "Long" / "Short", position
//     states "Pending" / "Open" / "Closing", market statuses "Open" /
//     "CloseOnly" / "Settled";
//   - an absent Option is JSON null (or a missing key, read the same way).

// ------------------------------------------------------------- methods

export const HOUSE_VIEWS = {
  config: 'get_config',
  vault: 'get_vault',
  listMarkets: 'list_markets',
  market: 'get_market',
  marketByReference: 'get_market_by_reference',
  listActive: 'list_active',
  position: 'get_position',
  positionsOf: 'positions_of',
  balanceOf: 'balance_of',
} as const;

export const HOUSE_CALLS = {
  pushQuotes: 'push_quotes',
  crank: 'crank',
  listMarket: 'list_market',
  setMarket: 'set_market',
  setPaused: 'set_paused',
  settleStale: 'settle_stale',
} as const;

// NEP-297 standard name of the contract's events.
export const HOUSE_EVENT_STANDARD = 'atnx_house';

// crank acts on at most this many ids per call and ignores the rest.
export const CRANK_MAX_IDS = 20;

// ---------------------------------------------------------------- types

export type HouseSide = 'Long' | 'Short';
export type HousePositionState = 'Pending' | 'Open' | 'Closing';
export type HouseMarketStatus = 'Open' | 'CloseOnly' | 'Settled';

export interface HouseConfig {
  owner: string | null;
  keeper: string;
  treasury: string | null;
  token: string | null;
  feeBps: number | null;
  finderBps: number | null;
  // The quote rule: the lead moves lead_min_bps of the way from the score
  // to the reading at no gap, all the way at lead_full_gap_bps.
  leadMinBps: number;
  leadFullGapBps: number;
  maxOpenGapBps: number | null;
  // A long's profit cap, in bps of its stake (90000 = nine times the stake).
  maxProfitBps: number;
  minScoreE2: bigint;
  cooloffSecs: number;
  marketCapBps: number | null;
  utilisationCapBps: number | null;
  minStake: bigint | null;
  maxStake: bigint | null;
  maxPositionsPerAccount: number | null;
  minFillDelaySecs: number;
  orderTtlSecs: number;
  maxQuoteAgeSecs: number | null;
  emergencySecs: number;
  maxPositionSecs: number;
  lpExitDelaySecs: number | null;
  lpExitWindowSecs: number | null;
  // The most a score may move per 300 seconds of print time.
  maxStepBps: number | null;
  liqRewardBps: number | null;
  faucetPerAccount: bigint | null;
  storageFloor: bigint | null;
  opensPaused: boolean;
  lpOpen: boolean | null;
}

export interface HouseVault {
  assets: bigint;
  reserved: bigint;
  free: bigint;
  margin: bigint;
  shares: bigint;
  // As the contract writes it (its fixed-point form is not assumed).
  sharePrice: string;
  faucetPool: bigint;
}

// One entry of a market's ring of recent quotes.
export interface HouseQuote {
  // The effective score: the pushed one, clipped to the step allowance.
  scoreE2: bigint;
  // The score as pushed; null when the view leaves it out.
  pushedScoreE2: bigint | null;
  readingE2: bigint;
  printId: bigint;
  printAt: number;
  firstReadAt: number;
  lastReadAt: number;
}

export interface HouseBook {
  stake: bigint;
  notional: bigint;
  reserved: bigint;
  count: number;
}

export interface HouseMarket {
  id: number;
  reference: string;
  finder: string | null;
  liveSince: number;
  status: HouseMarketStatus;
  // Sorted by print id, oldest first, whatever order the view used.
  quotes: HouseQuote[];
  finalE2: bigint | null;
  long: HouseBook | null;
  short: HouseBook | null;
}

export interface HousePosition {
  id: bigint;
  account: string;
  market: number;
  side: HouseSide;
  leverage: number;
  stake: bigint;
  fee: bigint;
  reserved: bigint;
  state: HousePositionState;
  placedAt: number;
  limitE2: bigint;
  entryE2: bigint | null;
  openedAt: number | null;
  closeRequestedAt: number | null;
  closeLimitE2: bigint | null;
}

// One quote as push_quotes takes it.
export interface QuoteIn {
  market: number;
  scoreE2: bigint;
  readingE2: bigint;
  printId: bigint;
  printAt: number;
  readAt: number;
}

// What push_quotes returns and its quotes_pushed event carries: the quotes
// sent, taken and skipped (a quote the contract cannot take is skipped,
// never failing the call).
export interface PushQuotesResult {
  count: number;
  accepted: number;
  skipped: number;
  firstPrintId: string | null;
  lastPrintId: string | null;
  commitment: string | null;
}

export type QuotesPushedEvent = { [K in keyof PushQuotesResult]: PushQuotesResult[K] | null };

// ------------------------------------------------------------- encoding

const U64_MAX = (1n << 64n) - 1n;

// A u64 argument. Every u64 the keeper sends goes through here: U64, a
// decimal string. If the contract takes plain u64 JSON numbers instead,
// this is the line to change.
export function encU64(v: bigint | number): string {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) ? BigInt(v) : NaN;
  if (typeof b !== 'bigint' || b < 0n || b > U64_MAX) throw new Error(`not a u64: ${String(v)}`);
  return b.toString();
}

export function encU128(v: bigint): string {
  if (typeof v !== 'bigint' || v < 0n) throw new Error(`not a u128: ${String(v)}`);
  return v.toString();
}

export function encU32(v: number): number {
  if (!Number.isSafeInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`not a u32: ${String(v)}`);
  return v;
}

export function encQuoteIn(q: QuoteIn): Record<string, unknown> {
  return {
    market: encU32(q.market),
    score_e2: encU64(q.scoreE2),
    reading_e2: encU64(q.readingE2),
    print_id: encU64(q.printId),
    print_at: encU64(q.printAt),
    read_at: encU64(q.readAt),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const REF32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pushQuotesArgs(quotes: QuoteIn[], commitment: string): Record<string, unknown> {
  if (!HEX64.test(commitment)) throw new Error('push_quotes: commitment must be 64 lowercase hex characters');
  return { quotes: quotes.map(encQuoteIn), commitment };
}

export function crankArgs(ids: bigint[]): Record<string, unknown> {
  if (ids.length > CRANK_MAX_IDS) throw new Error(`crank: at most ${CRANK_MAX_IDS} ids per call, got ${ids.length}`);
  return { position_ids: ids.map(encU64) };
}

export function listMarketArgs(a: { reference: string; finder: string | null; liveSince: number }): Record<string, unknown> {
  if (!REF32.test(a.reference)) throw new Error('list_market: reference must be 32 lowercase hex characters');
  return { reference: a.reference, finder: a.finder, live_since: encU64(a.liveSince) };
}

export function setMarketArgs(a: { market: number; status: HouseMarketStatus; finder?: string | null }): Record<string, unknown> {
  const args: Record<string, unknown> = { market: encU32(a.market), status: a.status };
  if (a.finder !== undefined) args.finder = a.finder;
  return args;
}

export function setPausedArgs(opens: boolean): Record<string, unknown> {
  return { opens };
}

export function settleStaleArgs(market: number): Record<string, unknown> {
  return { market: encU32(market) };
}

export function listArgs(from: number, limit: number): Record<string, unknown> {
  return { from: encU32(from), limit: encU32(limit) };
}

export const marketArgs = (market: number) => ({ market: encU32(market) });
export const marketByReferenceArgs = (reference: string) => ({ reference });
export const positionArgs = (id: bigint) => ({ id: encU64(id) });
export const accountArgs = (account: string) => ({ account });

// ------------------------------------------------------------- decoding

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Json;
}

const absent = (v: unknown) => v === null || v === undefined;

function bigOf(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${what}: expected a non-negative integer, got ${JSON.stringify(v)}`);
}

function numOf(v: unknown, what: string): number {
  const b = bigOf(v, what);
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what}: ${b} is too large`);
  return Number(b);
}

const u64 = (o: Json, k: string, w: string) => bigOf(o[k], `${w}.${k}`);
const u64n = (o: Json, k: string, w: string) => numOf(o[k], `${w}.${k}`);
const optU64 = (o: Json, k: string, w: string) => (absent(o[k]) ? null : u64(o, k, w));
const optU64n = (o: Json, k: string, w: string) => (absent(o[k]) ? null : u64n(o, k, w));

function str(o: Json, k: string, w: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`${w}.${k}: expected a string`);
  return v;
}

const optStr = (o: Json, k: string, w: string) => (absent(o[k]) ? null : str(o, k, w));

function bool(o: Json, k: string, w: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new Error(`${w}.${k}: expected a boolean`);
  return v;
}

const optBool = (o: Json, k: string, w: string) => (absent(o[k]) ? null : bool(o, k, w));

function oneOf<T extends string>(o: Json, k: string, w: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new Error(`${w}.${k}: unknown ${JSON.stringify(v)}`);
  return v as T;
}

export function decodeU128(v: unknown, what: string): bigint {
  return bigOf(v, what);
}

export function decodeConfig(v: unknown): HouseConfig {
  const w = 'config';
  const o = obj(v, w);
  return {
    owner: optStr(o, 'owner', w),
    keeper: str(o, 'keeper', w),
    treasury: optStr(o, 'treasury', w),
    token: optStr(o, 'token', w),
    feeBps: optU64n(o, 'fee_bps', w),
    finderBps: optU64n(o, 'finder_bps', w),
    leadMinBps: u64n(o, 'lead_min_bps', w),
    leadFullGapBps: u64n(o, 'lead_full_gap_bps', w),
    maxOpenGapBps: optU64n(o, 'max_open_gap_bps', w),
    maxProfitBps: u64n(o, 'max_profit_bps', w),
    minScoreE2: u64(o, 'min_score_e2', w),
    cooloffSecs: u64n(o, 'cooloff_secs', w),
    marketCapBps: optU64n(o, 'market_cap_bps', w),
    utilisationCapBps: optU64n(o, 'utilisation_cap_bps', w),
    minStake: optU64(o, 'min_stake', w),
    maxStake: optU64(o, 'max_stake', w),
    maxPositionsPerAccount: optU64n(o, 'max_positions_per_account', w),
    minFillDelaySecs: u64n(o, 'min_fill_delay_secs', w),
    orderTtlSecs: u64n(o, 'order_ttl_secs', w),
    maxQuoteAgeSecs: optU64n(o, 'max_quote_age_secs', w),
    emergencySecs: u64n(o, 'emergency_secs', w),
    maxPositionSecs: u64n(o, 'max_position_secs', w),
    lpExitDelaySecs: optU64n(o, 'lp_exit_delay_secs', w),
    lpExitWindowSecs: optU64n(o, 'lp_exit_window_secs', w),
    maxStepBps: optU64n(o, 'max_step_bps', w),
    liqRewardBps: optU64n(o, 'liq_reward_bps', w),
    faucetPerAccount: optU64(o, 'faucet_per_account', w),
    storageFloor: optU64(o, 'storage_floor', w),
    opensPaused: optBool(o, 'opens_paused', w) ?? false,
    lpOpen: optBool(o, 'lp_open', w),
  };
}

export function decodeVault(v: unknown): HouseVault {
  const w = 'vault';
  const o = obj(v, w);
  const sp = o.share_price;
  if (typeof sp !== 'string' && typeof sp !== 'number') throw new Error('vault.share_price: expected a string');
  return {
    assets: u64(o, 'assets', w),
    reserved: u64(o, 'reserved', w),
    free: u64(o, 'free', w),
    margin: u64(o, 'margin', w),
    shares: u64(o, 'shares', w),
    sharePrice: String(sp),
    faucetPool: u64(o, 'faucet_pool', w),
  };
}

export function decodeQuote(v: unknown, what = 'quote'): HouseQuote {
  const o = obj(v, what);
  return {
    scoreE2: u64(o, 'score_e2', what),
    pushedScoreE2: optU64(o, 'pushed_score_e2', what),
    readingE2: u64(o, 'reading_e2', what),
    printId: u64(o, 'print_id', what),
    printAt: u64n(o, 'print_at', what),
    firstReadAt: u64n(o, 'first_read_at', what),
    lastReadAt: u64n(o, 'last_read_at', what),
  };
}

function decodeBook(v: unknown, what: string): HouseBook | null {
  if (absent(v)) return null;
  const o = obj(v, what);
  return { stake: u64(o, 'stake', what), notional: u64(o, 'notional', what), reserved: u64(o, 'reserved', what), count: u64n(o, 'count', what) };
}

const STATUSES = ['Open', 'CloseOnly', 'Settled'] as const;
const STATES = ['Pending', 'Open', 'Closing'] as const;
const SIDES = ['Long', 'Short'] as const;

export function decodeMarket(v: unknown): HouseMarket {
  const w = 'market';
  const o = obj(v, w);
  const reference = str(o, 'reference', w);
  if (!REF32.test(reference)) throw new Error(`market.reference: expected 32 lowercase hex characters, got ${JSON.stringify(reference)}`);
  const rawQuotes = o.quotes;
  if (!Array.isArray(rawQuotes)) throw new Error('market.quotes: expected an array');
  const quotes = rawQuotes.map((q, i) => decodeQuote(q, `market.quotes[${i}]`)).sort((a, b) => (a.printId < b.printId ? -1 : a.printId > b.printId ? 1 : 0));
  return {
    id: u64n(o, 'id', w),
    reference,
    finder: optStr(o, 'finder', w),
    liveSince: u64n(o, 'live_since', w),
    status: oneOf(o, 'status', w, STATUSES),
    quotes,
    finalE2: optU64(o, 'final_e2', w),
    long: decodeBook(o.long, 'market.long'),
    short: decodeBook(o.short, 'market.short'),
  };
}

export function decodePosition(v: unknown): HousePosition {
  const w = 'position';
  const o = obj(v, w);
  return {
    id: u64(o, 'id', w),
    account: str(o, 'account', w),
    market: u64n(o, 'market', w),
    side: oneOf(o, 'side', w, SIDES),
    leverage: u64n(o, 'leverage', w),
    stake: u64(o, 'stake', w),
    fee: u64(o, 'fee', w),
    reserved: u64(o, 'reserved', w),
    state: oneOf(o, 'state', w, STATES),
    placedAt: u64n(o, 'placed_at', w),
    limitE2: u64(o, 'limit_e2', w),
    entryE2: optU64(o, 'entry_e2', w),
    openedAt: optU64n(o, 'opened_at', w),
    closeRequestedAt: optU64n(o, 'close_requested_at', w),
    closeLimitE2: optU64(o, 'close_limit_e2', w),
  };
}

export function decodeList<T>(v: unknown, what: string, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected an array`);
  return v.map(item);
}

export function decodeOptional<T>(v: unknown, item: (x: unknown) => T): T | null {
  return absent(v) ? null : item(v);
}

// list_market's return: the new market's id.
export function decodeMarketId(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffff_ffff) return v;
  throw new Error(`list_market: expected a u32, got ${JSON.stringify(v)}`);
}

// One quote from push_quotes' arguments, as a transaction carries them.
export function decodeQuoteIn(v: unknown, what = 'quote'): QuoteIn {
  const o = obj(v, what);
  return {
    market: u64n(o, 'market', what),
    scoreE2: u64(o, 'score_e2', what),
    readingE2: u64(o, 'reading_e2', what),
    printId: u64(o, 'print_id', what),
    printAt: u64n(o, 'print_at', what),
    readAt: u64n(o, 'read_at', what),
  };
}

export function decodePushQuotesArgs(v: unknown): { quotes: QuoteIn[]; commitment: string } {
  const o = obj(v, 'push_quotes args');
  const commitment = str(o, 'commitment', 'push_quotes args');
  return { quotes: decodeList(o.quotes, 'push_quotes args.quotes', (q) => decodeQuoteIn(q)), commitment };
}

// --------------------------------------------------------------- events

export interface HouseEvent {
  event: string;
  version: string | null;
  data: Json[];
}

// The contract's NEP-297 events in a receipt's logs.
export function houseEventsOf(logs: string[]): HouseEvent[] {
  const out: HouseEvent[] = [];
  for (const line of logs) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line.slice('EVENT_JSON:'.length));
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const e = v as Json;
    if (e.standard !== HOUSE_EVENT_STANDARD || typeof e.event !== 'string') continue;
    const data = Array.isArray(e.data) ? (e.data.filter((d) => d && typeof d === 'object') as Json[]) : e.data && typeof e.data === 'object' ? [e.data as Json] : [];
    out.push({ event: e.event, version: typeof e.version === 'string' ? e.version : null, data });
  }
  return out;
}

// quotes_pushed and push_quotes' return: { count, accepted, skipped,
// first_print_id, last_print_id, commitment }, every value a string.
function pushedFields(d: Json): QuotesPushedEvent {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : typeof d[k] === 'number' ? String(d[k]) : null);
  const n = (k: string) => {
    const v = s(k);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };
  return { count: n('count'), accepted: n('accepted'), skipped: n('skipped'), firstPrintId: s('first_print_id'), lastPrintId: s('last_print_id'), commitment: s('commitment') };
}

export function decodeQuotesPushed(e: HouseEvent): QuotesPushedEvent {
  return pushedFields(e.data[0] ?? {});
}

// A complete result (from the return value or the event), or null when the
// counts are missing.
export function pushResultOf(v: QuotesPushedEvent): PushQuotesResult | null {
  if (v.count === null || v.accepted === null || v.skipped === null) return null;
  return { ...v, count: v.count, accepted: v.accepted, skipped: v.skipped };
}

export function decodePushResult(v: unknown): PushQuotesResult {
  const r = pushResultOf(pushedFields(obj(v, 'push_quotes result')));
  if (!r) throw new Error('push_quotes result: expected count, accepted and skipped');
  return r;
}

// ------------------------------------------------------------ references

export function isMarketReference(s: string): boolean {
  return typeof s === 'string' && REF32.test(s);
}

// An ATNX market uuid to its on-chain reference.
export function uuidToReference(uuid: string): string {
  const u = typeof uuid === 'string' ? uuid.trim().toLowerCase() : '';
  if (!UUID.test(u)) throw new Error(`not a market uuid: ${JSON.stringify(uuid)}`);
  return u.replace(/-/g, '');
}

// The reference back to the uuid, lowercase with dashes.
export function referenceToUuid(reference: string): string {
  if (!REF32.test(reference)) throw new Error(`not a market reference: ${JSON.stringify(reference)}`);
  const r = reference;
  return `${r.slice(0, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}-${r.slice(16, 20)}-${r.slice(20)}`;
}
