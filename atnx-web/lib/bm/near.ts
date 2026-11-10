// Server-side NEAR access for the rounds keeper: one RPC provider per
// process, the keeper account (BM_NEAR_KEEPER_ACCOUNT, signing with
// BM_NEAR_KEEPER_SECRET), views on the rounds contract and the USDG token,
// and the contract calls. Parallel to ./sol for Solana devnet. The
// contracts are near/rounds and near/usdg (interface in near/README.md):
// amounts are U128 strings in 6-decimal USDG units, sides "Up" / "Down",
// times unix seconds from the block clock, and every call moves balances
// inside the contract's own ledger (only faucet and withdraw call the
// token).
//
// A failed call throws a NearCallError whose `code` is the contract's panic
// message ("round has not reached its close", ...), matched against the
// list in near/README.md, so callers can branch on the text. Calls return
// the transaction hash.
//
// Testnet only: anything that signs refuses to run when
// NEXT_PUBLIC_BM_NEAR_NETWORK is not "testnet".
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { rpcProvider } from '../near/rpc';
import { serverRpcUrls } from '../near/rpc-urls';

export const NEAR_CHAIN_KEY = 'near:testnet' as const;
export const USDG_DECIMALS = 6;
// The contract's per-call faucet cap, and the balance the keeper tops up to.
export const MAX_FAUCET = 10_000_000_000n;
export const KEEPER_FLOAT = 10_000_000_000n;

const TGAS = 1_000_000_000_000n;
// Plain calls only touch the contract's own state and burn 2–6 TGas
// (measured by the e2e); faucet and withdraw attach 15 TGas of
// cross-contract work on top. On protocol 88 (testnet and mainnet,
// November 2026) a call and a transaction may each prepay up to 1 PGas,
// gas costs 0.0001 NEAR per TGas and the pessimistic inflation is 1, so
// the signer needs the prepaid gas at that price in hand (0.002 NEAR for
// 20 TGas) until the call's refund lands, a block after its outcome. A
// small prepaid amount keeps a thinly funded account able to send the
// next call.
export const GAS_CALL = 20n * TGAS;
export const GAS_CROSS = 30n * TGAS;

export interface NearEnv {
  network: string;
  // The server's endpoints (BM_NEAR_RPC, else NEXT_PUBLIC_BM_NEAR_RPC),
  // tried in order; rpcUrl is the first. They may carry keys: log hosts
  // only (lib/near/rpc.ts rpcHosts).
  rpcUrls: string[];
  rpcUrl: string;
  rounds: string;
  usdg: string;
}

export function nearEnv(): NearEnv {
  const rpcUrls = serverRpcUrls();
  return {
    network: (process.env.NEXT_PUBLIC_BM_NEAR_NETWORK || 'testnet').trim(),
    rpcUrls,
    rpcUrl: rpcUrls[0],
    rounds: process.env.NEXT_PUBLIC_BM_NEAR_ROUNDS || 'rounds.atnx.testnet',
    usdg: process.env.NEXT_PUBLIC_BM_NEAR_USDG || 'usdg.atnx.testnet',
  };
}

export function assertTestnet(env: NearEnv = nearEnv()): void {
  if (env.network !== 'testnet') {
    throw new Error(`the NEAR rounds keeper runs on testnet only (NEXT_PUBLIC_BM_NEAR_NETWORK is ${JSON.stringify(env.network)})`);
  }
}

// ------------------------------------------------------------- accounts

// NEAR account ids: 2–64 characters of lowercase letters, digits and
// - _ . separators, no separator at either end or twice in a row.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(id: string): boolean {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);
}

// "ed25519:<base58>" as near-cli writes it. Returns the key pair; the
// message never contains the secret.
export function parseNearSecret(raw: string | undefined, name: string): KeyPair {
  const s = raw?.trim();
  if (!s) throw new Error(`${name} is missing (an "ed25519:..." secret key)`);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(s)) throw new Error(`${name} is not an "ed25519:<base58>" secret key`);
  try {
    return KeyPair.fromString(s as KeyPairString);
  } catch {
    throw new Error(`${name} is not a valid ed25519 secret key`);
  }
}

let provider: JsonRpcProvider | null = null;
let providerUrl = '';

// One provider over the server's endpoints, with failover (lib/near/rpc.ts).
export function nearProvider(): JsonRpcProvider {
  const urls = nearEnv().rpcUrls;
  const key = urls.join(',');
  if (!provider || providerUrl !== key) {
    provider = rpcProvider(urls);
    providerUrl = key;
  }
  return provider;
}

// An account that signs with `secret`, for scripts (the e2e's user).
export function nearAccount(accountId: string, secret: KeyPair): Account {
  assertTestnet();
  if (!isNearAccountId(accountId)) throw new Error(`not a NEAR account id: ${accountId}`);
  return new Account(accountId, nearProvider(), new KeyPairSigner(secret));
}

let keeper: Account | null = null;

export function nearKeeperAccountId(): string {
  const id = process.env.BM_NEAR_KEEPER_ACCOUNT?.trim();
  if (!id) throw new Error('BM_NEAR_KEEPER_ACCOUNT is missing');
  if (!isNearAccountId(id)) throw new Error(`BM_NEAR_KEEPER_ACCOUNT is not a NEAR account id: ${id}`);
  return id;
}

export function nearKeeperAccount(): Account {
  if (keeper) return keeper;
  keeper = nearAccount(nearKeeperAccountId(), parseNearSecret(process.env.BM_NEAR_KEEPER_SECRET, 'BM_NEAR_KEEPER_SECRET'));
  return keeper;
}

// --------------------------------------------------------------- errors

// The contract's panic messages (near/README.md, Errors).
export const NEAR_ROUNDS_ERRORS = [
  'amount is zero',
  'series is paused',
  "round is not the series' presale round",
  "round is not the series' live round",
  'round is not settled',
  'trading closed for the settlement window',
  'round has not reached its close',
  'series is not paused',
  'a live round already exists',
  'both sides need money before a round can open',
  'fewer shares than the minimum you set',
  'a single buy may not exceed 1000x the money on its side',
  'arithmetic overflow',
  'nothing to claim',
  'round index or state does not fit this call',
  'settlement window must be shorter than the round, round at least 20 s',
  'fee above the cap',
  'mint above the per-call cap',
  'not the authority or the keeper',
  'not the owner',
  'not the keeper',
  'no such series',
  'no such round',
  'no position in this round',
  'reference must be 64 lowercase hex characters',
  'commitment must be 64 lowercase hex characters',
  'a series with this reference already exists',
  'balance too low',
] as const;

export type NearRoundsError = (typeof NEAR_ROUNDS_ERRORS)[number];

function unescapeRust(s: string): string {
  return s.replace(/\\(["\\'nrt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

function textsOf(err: unknown, depth = 0): string[] {
  if (err === null || err === undefined || depth > 4) return [];
  if (typeof err === 'string') return [err];
  if (typeof err !== 'object') return [String(err)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const out: string[] = [];
  if (typeof e.panicMessage === 'string') out.push(`panic_msg: ${JSON.stringify(e.panicMessage)}`);
  if (typeof e.message === 'string') out.push(e.message);
  if (e.transactionResult) {
    const tr = e.transactionResult;
    if (tr.status?.Failure) out.push(JSON.stringify(tr.status.Failure));
    for (const r of tr.receipts_outcome ?? []) {
      if (r?.outcome?.status?.Failure) out.push(JSON.stringify(r.outcome.status.Failure));
    }
  }
  if (e.cause) out.push(...textsOf(e.cause, depth + 1));
  if (out.length === 0) {
    try {
      out.push(JSON.stringify(e));
    } catch {
      out.push(String(e));
    }
  }
  return out;
}

// The raw panic text behind a failed view or transaction, whichever shape
// near-api-js gave it: a view's "HostError(GuestPanic { panic_msg: \"...\" })",
// a transaction's "Smart contract panicked: ...", a HostGuestPanicError's
// panicMessage, or the same inside a failure's JSON. Null when the failure
// is not a contract panic (RPC trouble, a timeout, a bad nonce).
export function nearPanicMessage(err: unknown): string | null {
  for (const text of textsOf(err)) {
    const guest = /panic_msg: "((?:[^"\\]|\\.)*)"/.exec(text);
    if (guest) return unescapeRust(guest[1]);
    const json = /panic_msg\\?":\s*\\?"((?:[^"\\]|\\.)*?)\\?"/.exec(text);
    if (json) return unescapeRust(json[1]);
    const exec = /Smart contract panicked: ((?:[^"\\]|\\.)*)/.exec(text);
    if (exec) return unescapeRust(exec[1]).trim();
    const host = /Contract panicked: (.*)$/s.exec(text);
    if (host) return host[1].trim();
  }
  return null;
}

// The contract's error string for a failure: one of NEAR_ROUNDS_ERRORS
// when the panic is one of the contract's own, else the panic text as it
// came (near-sdk's argument errors, "Method ... is private"), else null.
export function nearErrorName(err: unknown): string | null {
  const msg = nearPanicMessage(err);
  if (msg === null) return null;
  const exact = NEAR_ROUNDS_ERRORS.find((k) => k === msg);
  if (exact) return exact;
  const prefixed = NEAR_ROUNDS_ERRORS.find((k) => msg.startsWith(k));
  return prefixed ?? msg;
}

export class NearCallError extends Error {
  readonly method: string;
  // The contract's message, or null when the call failed before or
  // outside the contract.
  readonly code: string | null;
  readonly txHash: string | null;
  constructor(method: string, code: string | null, txHash: string | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NearCallError';
    this.method = method;
    this.code = code;
    this.txHash = txHash;
  }
}

function txHashOfError(err: unknown): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const h = e?.txHash || e?.transactionResult?.transaction?.hash || e?.transactionResult?.transaction_outcome?.id;
  return typeof h === 'string' && h.length > 0 ? h : null;
}

export function toNearCallError(method: string, err: unknown): NearCallError {
  if (err instanceof NearCallError) return err;
  const code = nearErrorName(err);
  const raw = (err as Error)?.message ?? String(err);
  return new NearCallError(method, code, txHashOfError(err), `${method}: ${code ?? raw}`, { cause: err });
}

// ------------------------------------------------------------ responses

interface TxResponseLike {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  status?: unknown;
}

export function txHashOf(res: TxResponseLike): string {
  const h = res.transaction?.hash ?? res.transaction_outcome?.id;
  if (!h) throw new Error('transaction response without a hash');
  return h;
}

// Gas burnt by a transaction and all its receipts.
export function gasBurnt(res: unknown): bigint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  let sum = 0n;
  const add = (v: unknown) => {
    if (typeof v === 'number' && Number.isSafeInteger(v)) sum += BigInt(v);
    else if (typeof v === 'string' && /^\d+$/.test(v)) sum += BigInt(v);
  };
  add(r?.transaction_outcome?.outcome?.gas_burnt);
  for (const o of r?.receipts_outcome ?? []) add(o?.outcome?.gas_burnt);
  return sum;
}

// yoctoNEAR burnt by a transaction and all its receipts.
export function tokensBurnt(res: unknown): bigint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  let sum = 0n;
  const add = (v: unknown) => {
    if (typeof v === 'string' && /^\d+$/.test(v)) sum += BigInt(v);
    else if (typeof v === 'number' && Number.isSafeInteger(v)) sum += BigInt(v);
  };
  add(r?.transaction_outcome?.outcome?.tokens_burnt);
  for (const o of r?.receipts_outcome ?? []) add(o?.outcome?.tokens_burnt);
  return sum;
}

// The call's return value: status.SuccessValue is base64 JSON ("" for a
// method that returns nothing, which reads as undefined).
export function successValue(res: TxResponseLike): unknown {
  const st = res.status as { SuccessValue?: string } | undefined;
  if (!st || typeof st !== 'object' || typeof st.SuccessValue !== 'string') return undefined;
  if (st.SuccessValue === '') return undefined;
  const text = Buffer.from(st.SuccessValue, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------- views

export type NearRoundState = 'presale' | 'live' | 'settled' | 'void';
export type NearSideLower = 'up' | 'down';

export interface NearConfig {
  owner: string;
  keeper: string;
  treasury: string;
  token: string;
  feeBps: number;
  finderBps: number;
  seriesCount: number;
}

export interface NearSeries {
  id: number;
  finder: string;
  reference: string;
  roundSecs: number;
  settleWindowSecs: number;
  feeBps: number;
  finderBps: number;
  ante: bigint;
  paused: boolean;
  liveRound: number;
  presaleRound: number;
  finderFees: bigint;
  platformFees: bigint;
}

export interface NearRound {
  seriesId: number;
  index: number;
  state: NearRoundState;
  winner: NearSideLower | null;
  presaleUp: bigint;
  presaleDown: bigint;
  mUp: bigint;
  mDown: bigint;
  nUp: bigint;
  nDown: bigint;
  openedAt: number;
  closeAt: number;
  tradeUntil: number;
  targetE2: bigint;
  settleE2: bigint;
  commitment: string;
  paidOut: bigint;
}

export interface NearPosition {
  seriesId: number;
  roundIndex: number;
  accountId: string;
  presaleUp: bigint;
  presaleDown: bigint;
  stakeUp: bigint;
  stakeDown: bigint;
  sharesUp: bigint;
  sharesDown: bigint;
}

export interface NearQuote {
  shares: bigint;
  fee: bigint;
  finderFee: bigint;
  net: bigint;
}

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Json;
}

function u128(o: Json, k: string, what: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`${what}.${k}: expected a U128 string`);
  return BigInt(v);
}

function int(o: Json, k: string, what: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what}.${k}: expected an integer`);
  return v;
}

function bigFromInt(o: Json, k: string, what: string): bigint {
  // u64 fields the contract serialises as JSON numbers (target_e2, settle_e2).
  const v = o[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${what}.${k}: expected an integer`);
}

function str(o: Json, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`${what}.${k}: expected a string`);
  return v;
}

function bool(o: Json, k: string, what: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new Error(`${what}.${k}: expected a boolean`);
  return v;
}

const STATES: Record<string, NearRoundState> = { Presale: 'presale', Live: 'live', Settled: 'settled', Void: 'void' };

export function sideFromNear(v: unknown): NearSideLower | null {
  if (v === null || v === undefined) return null;
  if (v === 'Up') return 'up';
  if (v === 'Down') return 'down';
  throw new Error(`unknown side ${JSON.stringify(v)}`);
}

export function sideToNear(side: NearSideLower): 'Up' | 'Down' {
  if (side === 'up') return 'Up';
  if (side === 'down') return 'Down';
  throw new Error(`unknown side ${JSON.stringify(side)}`);
}

export function parseConfig(v: unknown): NearConfig {
  const o = obj(v, 'config');
  return {
    owner: str(o, 'owner', 'config'),
    keeper: str(o, 'keeper', 'config'),
    treasury: str(o, 'treasury', 'config'),
    token: str(o, 'token', 'config'),
    feeBps: int(o, 'fee_bps', 'config'),
    finderBps: int(o, 'finder_bps', 'config'),
    seriesCount: int(o, 'series_count', 'config'),
  };
}

export function parseSeries(v: unknown): NearSeries {
  const o = obj(v, 'series');
  const w = 'series';
  return {
    id: int(o, 'id', w),
    finder: str(o, 'finder', w),
    reference: str(o, 'reference', w),
    roundSecs: int(o, 'round_secs', w),
    settleWindowSecs: int(o, 'settle_window_secs', w),
    feeBps: int(o, 'fee_bps', w),
    finderBps: int(o, 'finder_bps', w),
    ante: u128(o, 'ante', w),
    paused: bool(o, 'paused', w),
    liveRound: int(o, 'live_round', w),
    presaleRound: int(o, 'presale_round', w),
    finderFees: u128(o, 'finder_fees', w),
    platformFees: u128(o, 'platform_fees', w),
  };
}

export function parseRound(v: unknown): NearRound {
  const o = obj(v, 'round');
  const w = 'round';
  const state = STATES[str(o, 'state', w)];
  if (!state) throw new Error(`round.state: unknown ${JSON.stringify(o.state)}`);
  const commitment = str(o, 'commitment', w);
  if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error('round.commitment: expected 64 hex characters');
  return {
    seriesId: int(o, 'series_id', w),
    index: int(o, 'index', w),
    state,
    winner: sideFromNear(o.winner),
    presaleUp: u128(o, 'presale_up', w),
    presaleDown: u128(o, 'presale_down', w),
    mUp: u128(o, 'm_up', w),
    mDown: u128(o, 'm_down', w),
    nUp: u128(o, 'n_up', w),
    nDown: u128(o, 'n_down', w),
    openedAt: int(o, 'opened_at', w),
    closeAt: int(o, 'close_at', w),
    tradeUntil: int(o, 'trade_until', w),
    targetE2: bigFromInt(o, 'target_e2', w),
    settleE2: bigFromInt(o, 'settle_e2', w),
    commitment,
    paidOut: u128(o, 'paid_out', w),
  };
}

export function parsePosition(v: unknown): NearPosition {
  const o = obj(v, 'position');
  const w = 'position';
  return {
    seriesId: int(o, 'series_id', w),
    roundIndex: int(o, 'round_index', w),
    accountId: str(o, 'account_id', w),
    presaleUp: u128(o, 'presale_up', w),
    presaleDown: u128(o, 'presale_down', w),
    stakeUp: u128(o, 'stake_up', w),
    stakeDown: u128(o, 'stake_down', w),
    sharesUp: u128(o, 'shares_up', w),
    sharesDown: u128(o, 'shares_down', w),
  };
}

export function parseQuote(v: unknown): NearQuote {
  const o = obj(v, 'quote');
  return {
    shares: u128(o, 'shares', 'quote'),
    fee: u128(o, 'fee', 'quote'),
    finderFee: u128(o, 'finder_fee', 'quote'),
    net: u128(o, 'net', 'quote'),
  };
}

export function parseU128(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`${what}: expected a U128 string, got ${JSON.stringify(v)}`);
  return BigInt(v);
}

// Read-your-writes. The RPC endpoint balances over several nodes, and a
// view sent right after a transaction can land on one that is a block
// behind it. Each write raises this floor to the highest block its receipts
// executed in, and views retry until the node answering has reached it.
let readFloor = 0;
const READ_FLOOR_WAIT_MS = 8_000;

export function nearReadFloor(): number {
  return readFloor;
}

export function raiseReadFloor(height: number): void {
  if (Number.isSafeInteger(height) && height > readFloor) readFloor = height;
}

// Block hashes a transaction's outcomes executed in.
export function outcomeBlockHashes(res: unknown): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  const out = new Set<string>();
  if (typeof r?.transaction_outcome?.block_hash === 'string') out.add(r.transaction_outcome.block_hash);
  for (const o of r?.receipts_outcome ?? []) if (typeof o?.block_hash === 'string') out.add(o.block_hash);
  return [...out];
}

// Raises the read floor past a transaction sent outside NearRounds.
export async function noteWrite(res: unknown): Promise<void> {
  const p = nearProvider();
  for (const blockId of outcomeBlockHashes(res)) {
    for (let i = 0; i < 20; i++) {
      try {
        raiseReadFloor(Number((await p.viewBlock({ blockId })).header.height));
        break;
      } catch {
        // That node has not seen the block yet.
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
}

function decodeViewResult(bytes: number[] | Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function nearView(method: string, args: Record<string, unknown> = {}, contractId = nearEnv().rounds): Promise<unknown> {
  const started = Date.now();
  for (;;) {
    let res;
    try {
      res = await nearProvider().callFunctionRaw({ contractId, method, args });
    } catch (err) {
      throw toNearCallError(method, err);
    }
    if (Number(res.block_height) >= readFloor) return decodeViewResult(res.result);
    if (Date.now() - started > READ_FLOOR_WAIT_MS) {
      throw new NearCallError(method, null, null, `${method}: the NEAR RPC is at block ${res.block_height}, behind this process's last write at ${readFloor}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const orNull = <T>(v: unknown, parse: (x: unknown) => T): T | null => (v === null || v === undefined ? null : parse(v));

export async function getConfig(): Promise<NearConfig> {
  return parseConfig(await nearView('get_config'));
}

export async function getSeries(seriesId: number): Promise<NearSeries | null> {
  return orNull(await nearView('get_series', { series_id: seriesId }), parseSeries);
}

export async function getSeriesByReference(reference: string): Promise<NearSeries | null> {
  return orNull(await nearView('get_series_by_reference', { reference }), parseSeries);
}

export async function getRound(seriesId: number, roundIndex: number): Promise<NearRound | null> {
  return orNull(await nearView('get_round', { series_id: seriesId, round_index: roundIndex }), parseRound);
}

export async function getPosition(seriesId: number, roundIndex: number, accountId: string): Promise<NearPosition | null> {
  return orNull(await nearView('get_position', { series_id: seriesId, round_index: roundIndex, account_id: accountId }), parsePosition);
}

export async function positionsOf(accountId: string): Promise<NearPosition[]> {
  const v = await nearView('positions_of', { account_id: accountId });
  if (!Array.isArray(v)) throw new Error('positions_of: expected an array');
  return v.map(parsePosition);
}

// The account's internal USDG balance inside the rounds contract.
export async function balanceOf(accountId: string): Promise<bigint> {
  return parseU128(await nearView('balance_of', { account_id: accountId }), 'balance_of');
}

export async function quoteBuy(seriesId: number, roundIndex: number, side: NearSideLower, amount: bigint): Promise<NearQuote> {
  return parseQuote(await nearView('quote_buy', { series_id: seriesId, round_index: roundIndex, side: sideToNear(side), amount: amount.toString() }));
}

// USDG held in the token contract (outside the rounds ledger).
export async function ftBalanceOf(accountId: string): Promise<bigint> {
  return parseU128(await nearView('ft_balance_of', { account_id: accountId }, nearEnv().usdg), 'ft_balance_of');
}

export async function ftTotalSupply(): Promise<bigint> {
  return parseU128(await nearView('ft_total_supply', {}, nearEnv().usdg), 'ft_total_supply');
}

// The chain clock: the latest block's timestamp, unix seconds. The
// contract times trading and settlement by it.
export async function chainNowSecs(): Promise<number> {
  const block = await nearProvider().viewBlock({ finality: 'optimistic' });
  return Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) / 1000);
}

// ---------------------------------------------------------------- calls

const HEX64 = /^[0-9a-f]{64}$/;

function positive(amount: bigint, what: string): string {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error(`${what}: amount must be a positive bigint`);
  return amount.toString();
}

function index(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0xffff_ffff) throw new Error(`${what}: expected a u32 from 1`);
  return n;
}

// Faucet calls that bring `balance` to KEEPER_FLOAT (or to `minimum` when
// that is higher) once it is under `minimum`, each within the per-call cap.
export function faucetPlan(balance: bigint, minimum: bigint, target = KEEPER_FLOAT): bigint[] {
  if (balance >= minimum) return [];
  let want = (minimum > target ? minimum : target) - balance;
  const out: bigint[] = [];
  while (want > 0n) {
    const a = want > MAX_FAUCET ? MAX_FAUCET : want;
    out.push(a);
    want -= a;
  }
  return out;
}

// The rounds contract as one account sees it. The keeper's instance is
// keeperRounds(); scripts build others for test users.
export class NearRounds {
  readonly account: Account;
  readonly contractId: string;
  // yoctoNEAR burnt by this instance's transactions, refused ones included,
  // and the gas the last one burnt.
  burnt = 0n;
  lastGas = 0n;

  constructor(account: Account, contractId = nearEnv().rounds) {
    assertTestnet();
    this.account = account;
    this.contractId = contractId;
  }

  get accountId(): string {
    return this.account.accountId;
  }

  async call(method: string, args: Record<string, unknown>, gas = GAS_CALL, receiverId = this.contractId): Promise<{ txHash: string; value: unknown }> {
    let res;
    try {
      res = await this.account.signAndSendTransaction({
        receiverId,
        actions: [actions.functionCall(method, args, gas, 0n)],
        waitUntil: 'EXECUTED_OPTIMISTIC',
        throwOnFailure: true,
      });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const failed = (err as any)?.transactionResult;
      this.burnt += tokensBurnt(failed);
      this.lastGas = gasBurnt(failed);
      lastGasAny = this.lastGas;
      if (failed) await noteWrite(failed).catch(() => undefined);
      throw toNearCallError(method, err);
    }
    this.burnt += tokensBurnt(res);
    this.lastGas = gasBurnt(res);
    lastGasAny = this.lastGas;
    await noteWrite(res);
    return { txHash: txHashOf(res), value: successValue(res) };
  }

  // Keeper only. Creates the series and its round 1 in presale.
  async createSeries(a: { reference: string; roundSecs: number; settleWindowSecs: number; ante: bigint; finder: string }): Promise<{ txHash: string; seriesId: number }> {
    if (!HEX64.test(a.reference)) throw new Error('create_series: reference must be 64 lowercase hex characters');
    if (!isNearAccountId(a.finder)) throw new Error(`create_series: finder is not a NEAR account id: ${a.finder}`);
    if (typeof a.ante !== 'bigint' || a.ante < 0n) throw new Error('create_series: ante must be a non-negative bigint');
    const { txHash, value } = await this.call('create_series', {
      reference: a.reference,
      round_secs: a.roundSecs,
      settle_window_secs: a.settleWindowSecs,
      ante: a.ante.toString(),
      finder: a.finder,
    });
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new NearCallError('create_series', null, txHash, `create_series: unexpected return ${JSON.stringify(value)}`);
    }
    return { txHash, seriesId: value };
  }

  // Keeper or owner.
  async setSeries(a: { seriesId: number; paused?: boolean; finder?: string; ante?: bigint }): Promise<string> {
    const args: Record<string, unknown> = { series_id: index(a.seriesId, 'set_series') };
    if (a.paused !== undefined) args.paused = a.paused;
    if (a.finder !== undefined) args.finder = a.finder;
    if (a.ante !== undefined) args.ante = a.ante.toString();
    return (await this.call('set_series', args)).txHash;
  }

  async commit(a: { seriesId: number; roundIndex: number; side: NearSideLower; amount: bigint }): Promise<string> {
    return (
      await this.call('commit', {
        series_id: index(a.seriesId, 'commit'),
        round_index: index(a.roundIndex, 'commit'),
        side: sideToNear(a.side),
        amount: positive(a.amount, 'commit'),
      })
    ).txHash;
  }

  // Keeper only. Opens the series' presale round at the target and creates
  // the next one in presale.
  async openRound(a: { seriesId: number; targetE2: bigint }): Promise<string> {
    if (a.targetE2 <= 0n) throw new Error('open_round: target must be positive');
    return (await this.call('open_round', { series_id: index(a.seriesId, 'open_round'), target_e2: Number(a.targetE2) })).txHash;
  }

  async buy(a: { seriesId: number; roundIndex: number; side: NearSideLower; amount: bigint; minShares: bigint }): Promise<string> {
    return (
      await this.call('buy', {
        series_id: index(a.seriesId, 'buy'),
        round_index: index(a.roundIndex, 'buy'),
        side: sideToNear(a.side),
        amount: positive(a.amount, 'buy'),
        min_shares: a.minShares.toString(),
      })
    ).txHash;
  }

  // Keeper only. Settles the series' live round.
  async settle(a: { seriesId: number; settleE2: bigint; commitment: string }): Promise<string> {
    if (!HEX64.test(a.commitment)) throw new Error('settle: commitment must be 64 lowercase hex characters');
    if (a.settleE2 < 0n || a.settleE2 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('settle: settle_e2 out of range');
    return (await this.call('settle', { series_id: index(a.seriesId, 'settle'), settle_e2: Number(a.settleE2), commitment: a.commitment })).txHash;
  }

  // Keeper only: the live round past its close, or the presale round of a
  // paused series.
  async voidRound(a: { seriesId: number; roundIndex: number }): Promise<string> {
    return (await this.call('void_round', { series_id: index(a.seriesId, 'void_round'), round_index: index(a.roundIndex, 'void_round') })).txHash;
  }

  // The payout or refund to the caller's internal balance; the position is
  // deleted. Returns the amount credited.
  async claim(a: { seriesId: number; roundIndex: number }): Promise<{ txHash: string; amount: bigint }> {
    const { txHash, value } = await this.call('claim', { series_id: index(a.seriesId, 'claim'), round_index: index(a.roundIndex, 'claim') });
    return { txHash, amount: parseU128(value, 'claim') };
  }

  async claimRollover(a: { seriesId: number; roundIndex: number }): Promise<{ txHash: string; net: bigint }> {
    const { txHash, value } = await this.call('claim_rollover', {
      series_id: index(a.seriesId, 'claim_rollover'),
      round_index: index(a.roundIndex, 'claim_rollover'),
    });
    return { txHash, net: parseU128(value, 'claim_rollover') };
  }

  async withdrawFees(seriesId: number): Promise<string> {
    return (await this.call('withdraw_fees', { series_id: index(seriesId, 'withdraw_fees') })).txHash;
  }

  // Mints test USDG into the caller's internal balance (at most 10,000 per
  // call). Throws when the mint failed and nothing was credited.
  async faucet(amount: bigint): Promise<{ txHash: string; credited: bigint }> {
    if (amount > MAX_FAUCET) throw new Error('faucet: mint above the per-call cap');
    const { txHash, value } = await this.call('faucet', { amount: positive(amount, 'faucet') }, GAS_CROSS);
    const credited = parseU128(value, 'faucet');
    if (credited !== amount) throw new NearCallError('faucet', null, txHash, `faucet: credited ${credited} of ${amount} (the mint failed)`);
    return { txHash, credited };
  }

  // Sends USDG from the internal balance to the caller's token account.
  async withdraw(amount: bigint): Promise<{ txHash: string; sent: bigint }> {
    const { txHash, value } = await this.call('withdraw', { amount: positive(amount, 'withdraw') }, GAS_CROSS);
    return { txHash, sent: parseU128(value, 'withdraw') };
  }
}

let lastGasAny = 0n;

// The gas the last call made through any NearRounds burnt (for scripts
// that print it per step).
export function nearLastGas(): bigint {
  return lastGasAny;
}

let keeperClient: NearRounds | null = null;

export function keeperRounds(): NearRounds {
  if (!keeperClient) keeperClient = new NearRounds(nearKeeperAccount());
  return keeperClient;
}

// Makes sure the keeper can ante: when its internal balance is under
// `minimum`, tops it up from the faucet to 10,000 USDG (or to `minimum`
// when that is higher). Returns the balance after and the faucet txs.
export async function ensureKeeperUsdg(minimum: bigint): Promise<{ balance: bigint; txHashes: string[] }> {
  const k = keeperRounds();
  let balance = await balanceOf(k.accountId);
  const txHashes: string[] = [];
  for (const amount of faucetPlan(balance, minimum)) {
    const r = await k.faucet(amount);
    txHashes.push(r.txHash);
    balance += r.credited;
  }
  return { balance, txHashes };
}

export function nearTxUrl(txHash: string): string {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}
