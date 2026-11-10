// Signing and relaying one call, browser-safe (also used by the e2e script):
// read the key's nonce and the block height, build a NEP-366 delegate for
// one zero-deposit FunctionCall on the rounds contract, sign it with the
// user's key, POST it to /api/near/relay, return the result.
//
// One action in flight per account: delegate nonces have to land in order,
// and a second delegate signed before the first landed would carry the same
// nonce. The server holds a lock too; this one keeps a page from tripping
// over itself.
import { Account, JsonRpcProvider, actions, base64Encode, buildDelegateAction, encodeSignedDelegate, type Signer } from 'near-api-js';
import { DELEGATE_TTL_BLOCKS, METHOD_GAS, NEAR_ROUNDS, type HouseMethod, type UserMethod } from './config';
import { isRetryableRpcError, nearRpcProvider, rpcProvider } from './rpc';
import type { RoundsEvent } from './relay';

export interface SignedCall {
  signedDelegateBase64: string;
  nonce: bigint;
}

// The highest nonce this page has used per key: the RPC can lag a landed
// delegate by a block or two, and nonce + 1 from a stale read would repeat it.
const usedNonce = new Map<string, bigint>();

export async function signCall(opts: {
  provider: JsonRpcProvider;
  accountId: string;
  signer: Signer;
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  ttlBlocks?: number;
}): Promise<SignedCall> {
  const publicKey = await opts.signer.getPublicKey();
  const keyId = `${opts.accountId}/${publicKey.toString()}`;
  const account = new Account(opts.accountId, opts.provider, opts.signer);
  const [key, block] = await Promise.all([account.getAccessKey(publicKey), opts.provider.viewBlock({ finality: 'optimistic' })]);
  const nonce = [BigInt(key.nonce) + 1n, (usedNonce.get(keyId) ?? 0n) + 1n].reduce((a, b) => (a > b ? a : b));
  const delegateAction = buildDelegateAction({
    senderId: opts.accountId,
    receiverId: opts.contractId,
    actions: [actions.functionCall(opts.methodName, opts.args, opts.gas, 0n)],
    nonce,
    maxBlockHeight: BigInt(block.header.height) + BigInt(opts.ttlBlocks ?? DELEGATE_TTL_BLOCKS),
    publicKey,
  });
  const { signedDelegate } = await opts.signer.signDelegateAction(delegateAction);
  usedNonce.set(keyId, nonce);
  return { signedDelegateBase64: base64Encode(encodeSignedDelegate(signedDelegate)), nonce };
}

export interface ActResult {
  txHash: string;
  // The method's decoded return value: claim, claim_rollover, faucet and
  // withdraw return an amount as a U128 string; commit and buy return null.
  value: unknown;
  events: RoundsEvent[];
}

// A refused or failed action. `code` is the route's error code
// (failed_on_chain, would_fail, stale_nonce, busy, ...); `contractMessage`
// the contract's error text when it gave one.
export class NearActError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly contractMessage: string | null,
    readonly txHash: string | null,
    detail?: string | null,
  ) {
    super(contractMessage ?? (detail ? `${code}: ${detail}` : code));
    this.name = 'NearActError';
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ActorConfig {
  accountId: string;
  signer: Signer;
  rpcUrl?: string;
  contractId?: string;
  endpoint?: string;
  fetch?: FetchLike;
  // A guest account (/api/near/guest): the relay's guest branch, which
  // needs no session, so no cookie is sent.
  guest?: boolean;
  // The gas each method attaches (default METHOD_GAS, the rounds'; the
  // house passes HOUSE_METHOD_GAS).
  gas?: Readonly<Record<string, bigint>>;
}

export type NearMethod = UserMethod | HouseMethod;
export type Act = (method: NearMethod, args: Record<string, unknown>) => Promise<ActResult>;

const inFlight = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inFlight.set(key, next);
  next
    .finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    })
    .catch(() => {});
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createActor(cfg: ActorConfig): { act: Act } {
  const provider = cfg.rpcUrl ? rpcProvider(cfg.rpcUrl) : nearRpcProvider();
  const contractId = cfg.contractId ?? NEAR_ROUNDS;
  const endpoint = cfg.endpoint ?? '/api/near/relay';
  const doFetch: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, { ...init, credentials: cfg.guest ? 'omit' : 'same-origin' }));

  const gasTable: Readonly<Record<string, bigint>> = cfg.gas ?? METHOD_GAS;

  async function once(method: NearMethod, args: Record<string, unknown>): Promise<ActResult> {
    const gas = gasTable[method];
    if (gas === undefined) throw new NearActError('method_not_allowed', 0, null, null, method);
    let signedDelegateBase64: string;
    try {
      ({ signedDelegateBase64 } = await signCall({ provider, accountId: cfg.accountId, signer: cfg.signer, contractId, methodName: method, args, gas }));
    } catch (err) {
      // The reads a signature needs (the key's nonce, a recent block) did
      // not get through: nothing was sent.
      if (isRetryableRpcError(err)) throw new NearActError('rpc_busy', 503, null, null);
      throw err;
    }
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg.guest ? { signedDelegate: signedDelegateBase64, guest: true } : { signedDelegate: signedDelegateBase64 }),
    });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (res.status === 200 && typeof body.txHash === 'string') {
      return { txHash: body.txHash, value: body.value ?? null, events: (body.events as RoundsEvent[]) ?? [] };
    }
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    const message = typeof body.message === 'string' ? body.message : code === 'would_fail' && typeof body.detail === 'string' ? body.detail : null;
    throw new NearActError(code, res.status, message, typeof body.txHash === 'string' ? body.txHash : null, typeof body.detail === 'string' ? body.detail : null);
  }

  const act: Act = (method, args) =>
    oneAtATime(cfg.accountId, async () => {
      // A nonce the chain had not caught up with, or the server's lock held
      // by another tab: both free, so try again shortly, twice.
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(method, args);
        } catch (err) {
          const retry = err instanceof NearActError && (err.code === 'stale_nonce' || err.code === 'busy') && attempt < 2;
          if (!retry) throw err;
          await sleep(1_200 * (attempt + 1));
        }
      }
    });

  return { act };
}
