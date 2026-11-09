// NEAR configuration for the rounds: which chain the app trades on, the
// network, the RPC, and the contracts. Browser-safe: only NEXT_PUBLIC_
// variables, each read by its literal name so Next inlines it into the
// client bundle. The server-only secrets (the parent and relayer keys) are
// read in lib/near/server.ts.
//
// The contract is near/rounds (see near/SPEC.md and near/README.md). Every
// user action is a zero-deposit function call on it, signed in the browser
// by a function-call key and relayed as a NEP-366 meta-transaction, so a
// user's account never holds NEAR.

export type RoundsChain = 'near' | 'solana';

// Which chain the rounds UI trades on. Anything but "near" keeps the
// Solana devnet build exactly as it was.
export const BM_CHAIN: RoundsChain = process.env.NEXT_PUBLIC_BM_CHAIN === 'near' ? 'near' : 'solana';

export const NEAR_NETWORK: string = process.env.NEXT_PUBLIC_BM_NEAR_NETWORK || 'testnet';

// The registry key for NEAR series rows (bm.series.chain), CAIP-2 style like
// 'solana:devnet'.
export const NEAR_CHAIN_KEY = `near:${NEAR_NETWORK}`;

export const NEAR_RPC: string = process.env.NEXT_PUBLIC_BM_NEAR_RPC || 'https://test.rpc.fastnear.com';
export const NEAR_ROUNDS: string = process.env.NEXT_PUBLIC_BM_NEAR_ROUNDS || '';
export const NEAR_USDG: string = process.env.NEXT_PUBLIC_BM_NEAR_USDG || '';
// User accounts are created as <handle>.<parent>.
export const NEAR_PARENT: string = process.env.NEXT_PUBLIC_BM_NEAR_PARENT || '';

export function isNearChain(): boolean {
  return BM_CHAIN === 'near';
}

// The NEAR rounds are usable once the contract and the parent account are
// configured.
export function isNearRoundsDeployed(): boolean {
  return !!NEAR_ROUNDS && !!NEAR_PARENT;
}

// The only methods a user key may call, and the only ones the relayer
// relays. All take no deposit (near/README.md, rounds methods).
export const USER_METHODS = ['commit', 'buy', 'claim', 'claim_rollover', 'faucet', 'withdraw'] as const;
export type UserMethod = (typeof USER_METHODS)[number];

export function isUserMethod(m: string): m is UserMethod {
  return (USER_METHODS as readonly string[]).includes(m);
}

const TGAS = 10n ** 12n;

// Gas each call attaches. faucet and withdraw make a cross-contract call
// plus a callback (15 TGas of static gas between them), the rest stay
// inside the contract. Unused gas goes back to the relayer.
export const METHOD_GAS: Record<UserMethod, bigint> = {
  commit: 30n * TGAS,
  buy: 30n * TGAS,
  claim: 30n * TGAS,
  claim_rollover: 30n * TGAS,
  faucet: 50n * TGAS,
  withdraw: 50n * TGAS,
};

// The relayer refuses a delegate asking for more than this per call.
export const MAX_CALL_GAS = 100n * TGAS;

// How long a signed action stays valid, in blocks (about a second each).
export const DELEGATE_TTL_BLOCKS = 200;

// What "Get test USDG" mints, in 6-decimal units, and the contract's cap
// per call.
export const FAUCET_UNITS = 1_000n * 1_000_000n;
export const FAUCET_MAX_UNITS = 10_000n * 1_000_000n;

export const NEAR_EXPLORER = NEAR_NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';

export function nearTxUrl(hash: string): string {
  return `${NEAR_EXPLORER}/txns/${hash}`;
}

export function nearAccountUrl(accountId: string): string {
  return `${NEAR_EXPLORER}/address/${accountId}`;
}
