// Reads of the house contract (near/house), browser-safe: views go straight
// to the RPC, decoded by lib/bm/house-types.ts, the one place the
// contract's JSON shapes live. The ticket, the portfolio and Settings read
// through it in the browser, and the relay's checks (./house-check.ts) on
// the server with the relayer's provider. Calls are built by house-types
// (openArgs, closeArgs, ...) and signed and relayed by ./client.ts.
import { JsonRpcProvider, PublicKey } from 'near-api-js';
import {
  HOUSE_VIEWS,
  accountArgs,
  decodeConfig,
  decodeHistory,
  decodeList,
  decodeMarket,
  decodeOpenQuote,
  decodeOptional,
  decodePosition,
  decodeU128,
  decodeVault,
  listArgs,
  marketArgs,
  marketByReferenceArgs,
  positionArgs,
  quoteOpenArgs,
  type HouseClosed,
  type HouseConfig,
  type HouseMarket,
  type HouseOpenQuote,
  type HousePosition,
  type HouseSide,
  type HouseVault,
} from '@/lib/bm/house-types';
import { NEAR_HOUSE, NEAR_RPC } from './config';

export interface HouseViewer {
  readonly contractId: string;
  config(): Promise<HouseConfig>;
  vault(): Promise<HouseVault>;
  market(id: number): Promise<HouseMarket | null>;
  marketByReference(reference: string): Promise<HouseMarket | null>;
  // One page of markets in id order (at most 100).
  listMarkets(from: number, limit: number): Promise<HouseMarket[]>;
  // Null once the position has ended (it is in history_of then).
  position(id: bigint): Promise<HousePosition | null>;
  // The account's pending, open and closing positions.
  positionsOf(account: string): Promise<HousePosition[]>;
  // The account's last closed positions, newest first.
  historyOf(account: string): Promise<HouseClosed[]>;
  balanceOf(account: string): Promise<bigint>;
  // How much of the faucet the account has had; null when the contract has
  // no such view.
  faucetClaimed(account: string): Promise<bigint | null>;
  // What open would do with these terms now; null when the contract has no
  // such view or its answer does not decode.
  quoteOpen(a: { market: number; side: HouseSide; leverage: number; stake: bigint }): Promise<HouseOpenQuote | null>;
  // The chain's clock: the latest block's time, whole unix seconds.
  nowSecs(): Promise<number>;
}

// A failure that says the contract is not there (yet): the account does not
// exist, holds no code, or lacks the method.
export function houseContractMissing(err: unknown): boolean {
  const texts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    texts.push(String((e as Error)?.message ?? e));
    e = (e as { cause?: unknown })?.cause;
  }
  return texts.some((t) => /does not exist|doesn't exist|UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound|MethodResolveError|CompilationError|no contract code/i.test(t));
}

export function houseViewer(opts: { rpcUrl?: string; contractId?: string; provider?: JsonRpcProvider } = {}): HouseViewer {
  const provider = opts.provider ?? new JsonRpcProvider({ url: opts.rpcUrl ?? NEAR_RPC });
  const contractId = opts.contractId ?? NEAR_HOUSE;
  const view = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!contractId) throw new Error('the house contract is not configured (does not exist)');
    return (await provider.callFunction<never>({ contractId, method, args })) as unknown;
  };
  return {
    contractId,
    config: async () => decodeConfig(await view(HOUSE_VIEWS.config, {})),
    vault: async () => decodeVault(await view(HOUSE_VIEWS.vault, {})),
    market: async (id) => decodeOptional(await view(HOUSE_VIEWS.market, marketArgs(id)), decodeMarket),
    marketByReference: async (reference) => decodeOptional(await view(HOUSE_VIEWS.marketByReference, marketByReferenceArgs(reference)), decodeMarket),
    listMarkets: async (from, limit) => decodeList(await view(HOUSE_VIEWS.listMarkets, listArgs(from, limit)), 'list_markets', decodeMarket),
    position: async (id) => decodeOptional(await view(HOUSE_VIEWS.position, positionArgs(id)), decodePosition),
    positionsOf: async (account) => decodeList((await view(HOUSE_VIEWS.positionsOf, accountArgs(account))) ?? [], 'positions_of', decodePosition),
    historyOf: async (account) => decodeHistory((await view(HOUSE_VIEWS.historyOf, accountArgs(account))) ?? []),
    balanceOf: async (account) => decodeU128((await view(HOUSE_VIEWS.balanceOf, accountArgs(account))) ?? '0', 'balance_of'),
    async faucetClaimed(account) {
      try {
        return decodeU128((await view(HOUSE_VIEWS.faucetClaimed, accountArgs(account))) ?? '0', 'faucet_claimed');
      } catch (err) {
        if (/MethodNotFound|MethodResolveError/i.test(String((err as Error)?.message ?? err))) return null;
        throw err;
      }
    },
    async quoteOpen(a) {
      try {
        return decodeOpenQuote(await view(HOUSE_VIEWS.quoteOpen, quoteOpenArgs(a)));
      } catch {
        return null;
      }
    },
    async nowSecs() {
      const block = await provider.viewBlock({ finality: 'optimistic' });
      return Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) / 1000);
    },
  };
}

// The browser's one viewer.
let shared: HouseViewer | null = null;
export function nearHouseViewer(): HouseViewer {
  if (!shared) shared = houseViewer();
  return shared;
}

// Whether `accountId` holds `publicKey` as a key for the house contract:
// how the browser tells that its house account is set up. False when the
// account or the key does not exist.
export async function hasHouseKey(provider: JsonRpcProvider, accountId: string, publicKey: string, contractId: string = NEAR_HOUSE): Promise<boolean> {
  try {
    const key = await provider.viewAccessKey({ accountId, publicKey: PublicKey.from(publicKey) });
    const fc = (key.permission as { FunctionCall?: { receiver_id: string } } | string | undefined) ?? null;
    return !!fc && typeof fc === 'object' && fc.FunctionCall?.receiver_id === contractId;
  } catch (e) {
    const err = e as { message?: string; type?: string; name?: string };
    if (/does not exist|unknown access key|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|doesn't exist/i.test(`${err?.message ?? e} ${err?.type ?? ''} ${err?.name ?? ''}`)) return false;
    throw e;
  }
}
