// Server-side NEAR access for the house contract (near/house, deployed at
// NEXT_PUBLIC_BM_NEAR_HOUSE): typed views, the keeper's calls, and one
// transaction carrying a push_quotes and a crank together. Built on the
// rounds client in ./near (the RPC provider, the read-your-writes floor,
// error mapping and the testnet guard); the JSON shapes are in
// ./house-types.
//
// Two signers, both the keeper account (BM_NEAR_KEEPER_ACCOUNT): the main
// key (BM_NEAR_KEEPER_SECRET) for the cron runs, and a second access key
// (BM_NEAR_KEEPER_FAST_SECRET) for quotes on demand, so a quote sent from a
// user's request never takes a nonce the cron is using. Without the second
// key, both use the main one.
//
// Nothing here runs unless BM_NEAR_HOUSE_ENABLED=1 is checked by the
// caller (the routes and scripts); views and calls themselves do not look.
import { actions, type Account } from 'near-api-js';
import {
  NearCallError,
  assertTestnet,
  gasBurnt,
  nearAccount,
  nearEnv,
  nearKeeperAccount,
  nearKeeperAccountId,
  nearProvider,
  nearReadFloor,
  nearView,
  noteWrite,
  parseNearSecret,
  successValue,
  toNearCallError,
  tokensBurnt,
  txHashOf,
} from './near';
import {
  HOUSE_CALLS,
  HOUSE_VIEWS,
  accountArgs,
  crankArgs,
  decodeConfig,
  decodeList,
  decodeMarket,
  decodeMarketId,
  decodeOptional,
  decodePosition,
  decodePushResult,
  decodeQuotesPushed,
  decodeU128,
  decodeVault,
  houseEventsOf,
  listArgs,
  listMarketArgs,
  marketArgs,
  marketByReferenceArgs,
  positionArgs,
  pushQuotesArgs,
  pushResultOf,
  setMarketArgs,
  setPausedArgs,
  settleStaleArgs,
  type HouseConfig,
  type HouseMarket,
  type HouseMarketStatus,
  type HousePosition,
  type HouseVault,
  type PushQuotesResult,
  type QuoteIn,
} from './house-types';

export const DEFAULT_HOUSE_CONTRACT = 'house.atnx.testnet';

export interface HouseEnv {
  network: string;
  rpcUrl: string;
  house: string;
}

export function houseEnv(env: Record<string, string | undefined> = process.env): HouseEnv {
  const base = nearEnv();
  return { network: base.network, rpcUrl: base.rpcUrl, house: (env.NEXT_PUBLIC_BM_NEAR_HOUSE || DEFAULT_HOUSE_CONTRACT).trim() };
}

// The house keeper's switch: off unless exactly "1".
export function houseEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BM_NEAR_HOUSE_ENABLED === '1';
}

// ------------------------------------------------------------------ gas

const TGAS = 1_000_000_000_000n;
// A transaction may prepay up to 1 PGas; stay well under it.
export const HOUSE_GAS_MAX = 300n * TGAS;
export const HOUSE_GAS_CALL = 30n * TGAS;

const capGas = (g: bigint) => (g > HOUSE_GAS_MAX ? HOUSE_GAS_MAX : g);

// push_quotes reads and writes one market per quote and writes one event.
export function pushGas(quotes: number): bigint {
  return capGas(15n * TGAS + BigInt(Math.max(0, quotes)) * TGAS);
}

// crank does at most one thing per id (at most 20 ids): a fill, refund,
// close or liquidation, each a handful of reads and writes and one event.
export function crankGas(ids: number): bigint {
  return capGas(15n * TGAS + BigInt(Math.max(0, ids)) * 6n * TGAS);
}

// ---------------------------------------------------------------- views

export async function houseView(method: string, args: Record<string, unknown> = {}, contractId = houseEnv().house): Promise<unknown> {
  return nearView(method, args, contractId);
}

// Pages of list_markets and list_active hold at most this many entries.
export const HOUSE_PAGE = 100;

// The chain's clock: the latest block's timestamp in whole unix seconds,
// as the contract reads it (block_timestamp_ms / 1000). Every time the
// contract compares (read_at, placed_at, quote age) is on this clock, so
// the keeper's read_at is taken from it, never from its own. The block is
// at least as new as this process's last write, so read_at never goes
// back past a read the keeper itself pushed.
export async function houseChainNowSecs(): Promise<number> {
  const started = Date.now();
  for (;;) {
    const block = await nearProvider().viewBlock({ finality: 'optimistic' });
    if (Number(block.header.height) >= nearReadFloor() || Date.now() - started > 8_000) {
      return Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) / 1000);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const houseViews = {
  config: async (contractId?: string): Promise<HouseConfig> => decodeConfig(await houseView(HOUSE_VIEWS.config, {}, contractId)),
  vault: async (contractId?: string): Promise<HouseVault> => decodeVault(await houseView(HOUSE_VIEWS.vault, {}, contractId)),
  listMarkets: async (from: number, limit = HOUSE_PAGE, contractId?: string): Promise<HouseMarket[]> =>
    decodeList(await houseView(HOUSE_VIEWS.listMarkets, listArgs(from, limit), contractId), 'list_markets', decodeMarket),
  market: async (market: number, contractId?: string): Promise<HouseMarket | null> =>
    decodeOptional(await houseView(HOUSE_VIEWS.market, marketArgs(market), contractId), decodeMarket),
  marketByReference: async (reference: string, contractId?: string): Promise<HouseMarket | null> =>
    decodeOptional(await houseView(HOUSE_VIEWS.marketByReference, marketByReferenceArgs(reference), contractId), decodeMarket),
  listActive: async (from: number, limit = HOUSE_PAGE, contractId?: string): Promise<HousePosition[]> =>
    decodeList(await houseView(HOUSE_VIEWS.listActive, listArgs(from, limit), contractId), 'list_active', decodePosition),
  position: async (id: bigint, contractId?: string): Promise<HousePosition | null> =>
    decodeOptional(await houseView(HOUSE_VIEWS.position, positionArgs(id), contractId), decodePosition),
  positionsOf: async (account: string, contractId?: string): Promise<HousePosition[]> =>
    decodeList(await houseView(HOUSE_VIEWS.positionsOf, accountArgs(account), contractId), 'positions_of', decodePosition),
  balanceOf: async (account: string, contractId?: string): Promise<bigint> =>
    decodeU128(await houseView(HOUSE_VIEWS.balanceOf, accountArgs(account), contractId), 'balance_of'),
};

// ---------------------------------------------------------------- calls

export interface HouseCall {
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
}

export interface HouseSent {
  txHash: string;
  value: unknown;
  gasBurnt: bigint;
  // Every receipt's logs, in order.
  logs: string[];
}

export interface HousePushed {
  txHash: string;
  // The contract's counts, or null when neither the return value nor the
  // event could be read (the push landed either way).
  result: PushQuotesResult | null;
}

function logsOf(res: unknown): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  const out: string[] = [];
  for (const o of r?.receipts_outcome ?? []) for (const l of o?.outcome?.logs ?? []) if (typeof l === 'string') out.push(l);
  return out;
}

// push_quotes' counts: from its quotes_pushed event, which a combined push
// and crank also carries, else from the return value of a push alone.
export function pushResultFrom(sent: Pick<HouseSent, 'logs' | 'value'>, returnIsPush: boolean): PushQuotesResult | null {
  const ev = houseEventsOf(sent.logs).find((e) => e.event === 'quotes_pushed');
  const fromEvent = ev ? pushResultOf(decodeQuotesPushed(ev)) : null;
  if (fromEvent) return fromEvent;
  if (!returnIsPush) return null;
  try {
    return decodePushResult(sent.value);
  } catch {
    return null;
  }
}

// The house contract as one signer sees it.
export class HouseClient {
  readonly account: Account;
  readonly contractId: string;
  // yoctoNEAR burnt by this instance's transactions, refused ones included.
  burnt = 0n;

  constructor(account: Account, contractId = houseEnv().house) {
    assertTestnet();
    this.account = account;
    this.contractId = contractId;
  }

  get accountId(): string {
    return this.account.accountId;
  }

  // One transaction with one FunctionCall action per call, in order. The
  // actions run in one receipt: if one fails, none of them take effect.
  async send(calls: HouseCall[]): Promise<HouseSent> {
    if (calls.length === 0) throw new Error('house: nothing to send');
    const label = calls.map((c) => c.method).join('+');
    let total = 0n;
    for (const c of calls) total += c.gas;
    if (total > HOUSE_GAS_MAX * 3n) throw new Error(`${label}: ${total} gas is over the transaction limit`);
    let res;
    try {
      res = await this.account.signAndSendTransaction({
        receiverId: this.contractId,
        actions: calls.map((c) => actions.functionCall(c.method, c.args, c.gas, 0n)),
        waitUntil: 'EXECUTED_OPTIMISTIC',
        throwOnFailure: true,
      });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const failed = (err as any)?.transactionResult;
      this.burnt += tokensBurnt(failed);
      if (failed) await noteWrite(failed).catch(() => undefined);
      throw toNearCallError(label, err);
    }
    this.burnt += tokensBurnt(res);
    await noteWrite(res);
    return { txHash: txHashOf(res), value: successValue(res), gasBurnt: gasBurnt(res), logs: logsOf(res) };
  }

  // Keeper only. One event for the whole batch; a quote the contract cannot
  // take is skipped and counted.
  async pushQuotes(quotes: QuoteIn[], commitment: string): Promise<HousePushed> {
    if (quotes.length === 0) throw new Error('push_quotes: no quotes');
    const sent = await this.send([pushCall(quotes, commitment)]);
    return { txHash: sent.txHash, result: pushResultFrom(sent, true) };
  }

  // Anyone, at most 20 ids. Ids the contract cannot act on are skipped there.
  async crank(ids: bigint[]): Promise<string> {
    if (ids.length === 0) throw new Error('crank: no ids');
    return (await this.send([crankCall(ids)])).txHash;
  }

  // One transaction: the quotes first (when there are any), then the crank
  // (when there are ids), so the crank sees the quotes.
  async pushAndCrank(quotes: QuoteIn[], commitment: string | null, ids: bigint[]): Promise<HousePushed> {
    const calls: HouseCall[] = [];
    if (quotes.length > 0) {
      if (!commitment) throw new Error('push_quotes: a push needs its commitment');
      calls.push(pushCall(quotes, commitment));
    }
    if (ids.length > 0) calls.push(crankCall(ids));
    const sent = await this.send(calls);
    return { txHash: sent.txHash, result: quotes.length > 0 ? pushResultFrom(sent, ids.length === 0) : null };
  }

  // Keeper only. Returns the new market's id.
  async listMarket(a: { reference: string; finder: string | null; liveSince: number }): Promise<{ txHash: string; market: number }> {
    const sent = await this.send([{ method: HOUSE_CALLS.listMarket, args: listMarketArgs(a), gas: HOUSE_GAS_CALL }]);
    let market: number;
    try {
      market = decodeMarketId(sent.value);
    } catch (err) {
      throw new NearCallError(HOUSE_CALLS.listMarket, null, sent.txHash, (err as Error).message);
    }
    return { txHash: sent.txHash, market };
  }

  // Keeper or owner; the contract allows Open → CloseOnly only.
  async setMarket(a: { market: number; status: HouseMarketStatus; finder?: string | null }): Promise<string> {
    return (await this.send([{ method: HOUSE_CALLS.setMarket, args: setMarketArgs(a), gas: HOUSE_GAS_CALL }])).txHash;
  }

  // Keeper or owner. Pauses or resumes new orders, nothing else.
  async setPaused(opens: boolean): Promise<string> {
    return (await this.send([{ method: HOUSE_CALLS.setPaused, args: setPausedArgs(opens), gas: HOUSE_GAS_CALL }])).txHash;
  }

  // Anyone, once the market has had no quote for the contract's emergency_secs.
  async settleStale(market: number): Promise<string> {
    return (await this.send([{ method: HOUSE_CALLS.settleStale, args: settleStaleArgs(market), gas: HOUSE_GAS_CALL }])).txHash;
  }
}

export function pushCall(quotes: QuoteIn[], commitment: string): HouseCall {
  return { method: HOUSE_CALLS.pushQuotes, args: pushQuotesArgs(quotes, commitment), gas: pushGas(quotes.length) };
}

export function crankCall(ids: bigint[]): HouseCall {
  return { method: HOUSE_CALLS.crank, args: crankArgs(ids), gas: crankGas(ids.length) };
}

let mainClient: HouseClient | null = null;
let fastClient: HouseClient | null = null;

// The keeper's main key, shared with the rounds keeper's account object.
export function keeperHouse(): HouseClient {
  if (!mainClient) mainClient = new HouseClient(nearKeeperAccount());
  return mainClient;
}

export function hasFastKey(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.BM_NEAR_KEEPER_FAST_SECRET?.trim();
}

// The keeper account signing with its second key, for quotes on demand;
// the main key when BM_NEAR_KEEPER_FAST_SECRET is unset.
export function keeperHouseFast(): HouseClient {
  if (!hasFastKey()) return keeperHouse();
  if (!fastClient) {
    fastClient = new HouseClient(nearAccount(nearKeeperAccountId(), parseNearSecret(process.env.BM_NEAR_KEEPER_FAST_SECRET, 'BM_NEAR_KEEPER_FAST_SECRET')));
  }
  return fastClient;
}

// A failure from a view or call that says the contract is not there: the
// account does not exist, holds no code, or lacks the method.
export function contractMissing(err: unknown): boolean {
  const texts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    texts.push(String((e as Error)?.message ?? e));
    e = (e as { cause?: unknown })?.cause;
  }
  return texts.some((t) => /does not exist|doesn't exist|UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound|MethodResolveError|CompilationError|no contract code/i.test(t));
}

// A nonce clash: another transaction from the same key took the nonce.
export function isNonceError(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const name = (e as { name?: unknown })?.name;
    if (name === 'InvalidNonceError') return true;
    const msg = String((e as Error)?.message ?? e);
    if (/InvalidNonce|invalid nonce|nonce \d+ must be larger/i.test(msg)) return true;
    e = (e as { cause?: unknown })?.cause;
  }
  return false;
}
