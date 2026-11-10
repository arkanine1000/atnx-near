// The NEP-366 relayer, ported from near/relayer-proto/relay.mjs (proven on
// testnet). It takes a base64 borsh SignedDelegate from the browser, checks
// it against a policy, wraps it in a transaction the relayer signs and pays
// for, and sends it. The user's account never holds NEAR.
//
// Three steps, so the route can hold a per-user lock around the last two:
//   check      parse and verify without touching the chain (free)
//   preflight  expiry, nonce and key scope against the chain (free)
//   send       the relayer's transaction (costs the relayer gas)
// A delegate that would fail on chain still costs the relayer its gas, so
// everything that can be checked first is.
//
// No Node-only APIs (WebCrypto, near-api-js, borsh): it runs in a Next route
// handler and in the e2e script alike. Secrets come in as arguments.
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  KeyType,
  PublicKey,
  SCHEMA,
  actions,
  base64Decode,
  encodeDelegateAction,
  encodeSignedDelegate,
  type DelegateAction,
  type KeyPairString,
  type Signature,
  type SignedDelegate,
} from 'near-api-js';
import { deserialize } from 'borsh';
import { rpcProvider } from './rpc';

// Refused before anything was sent: nothing spent. `reason` is a stable code
// for the API response.
export class RelayRejected extends Error {
  constructor(
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'RelayRejected';
  }
}

// Sent and failed on chain: the relayer paid the gas. `message` is the
// contract's panic text when there is one ("round is not the series' live
// round"), so the client can say it in words.
export class RelayFailed extends Error {
  constructor(
    public readonly txHash: string,
    public readonly failure: unknown,
    public readonly contractMessage: string | null,
  ) {
    super(`relayed tx ${txHash} failed: ${contractMessage ?? JSON.stringify(failure)}`);
    this.name = 'RelayFailed';
  }
}

const TGAS = 10n ** 12n;

export interface RelayPolicy {
  // The only receiver allowed. A relayer may hold several policies, one per
  // contract; a delegate is checked against the one its receiver names.
  contractId: string;
  // The methods allowed on it.
  methods: readonly string[];
  // Which senders we relay for, e.g. /^[a-z0-9_-]+\.atnx\.testnet$/.
  senderPattern?: RegExp;
  // Per FunctionCall.
  maxGas?: bigint;
  maxArgsBytes?: number;
  // A delegate valid for longer than this is refused.
  maxTtlBlocks?: number;
  // Only relay for keys scoped to contractId (never a full-access key).
  requireFunctionCallKey?: boolean;
  // The NEP-297 standard of the contract's events (default atnx_rounds).
  eventStandard?: string;
}

type FullPolicy = Required<Omit<RelayPolicy, 'senderPattern'>> & { senderPattern?: RegExp };

export function fullPolicy(p: RelayPolicy): FullPolicy {
  return { maxGas: 100n * TGAS, maxArgsBytes: 4096, maxTtlBlocks: 1000, requireFunctionCallKey: false, eventStandard: 'atnx_rounds', ...p };
}

// The policy for a receiver, or null when no policy names it.
export function selectPolicy(policies: RelayPolicy | readonly RelayPolicy[], receiverId: string): RelayPolicy | null {
  const list: readonly RelayPolicy[] = Array.isArray(policies) ? policies : [policies as RelayPolicy];
  return list.find((p) => p.contractId === receiverId) ?? null;
}

export interface CheckContext {
  // The signed-in user's mapped account: the delegate must come from it.
  expectedSenderId?: string;
  // The key on record for that account ("ed25519:..."): the delegate must
  // be signed by it.
  expectedPublicKey?: string;
}

// What check() hands on: the decoded delegate, the one call it makes and
// the policy it was checked against (the one its receiver names).
export interface CheckedDelegate {
  sd: SignedDelegate;
  da: DelegateAction;
  policy: RelayPolicy;
  publicKey: PublicKey;
  senderId: string;
  methodName: string;
  // The call's JSON arguments.
  args: Record<string, unknown>;
  gas: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
}

// Borsh-decoded shapes (plain objects; enums are single-key objects).
interface RawFunctionCall {
  methodName: string;
  // borsh gives a plain number[] for Vec<u8>
  args: ArrayLike<number>;
  gas: bigint | number;
  deposit: bigint | number;
}
interface RawDelegate {
  senderId: string;
  receiverId: string;
  actions: Array<Record<string, unknown>>;
  nonce: bigint | number;
  maxBlockHeight: bigint | number;
  publicKey: { ed25519Key?: { data: ArrayLike<number> } } & Record<string, unknown>;
}
interface RawSignedDelegate {
  delegateAction: RawDelegate;
  signature: { ed25519Signature?: { data: ArrayLike<number> } } & Record<string, unknown>;
}

// The sender and receiver a SignedDelegate names, read without checking
// anything else, or null when it does not decode. Untrusted: the relay
// route uses them only to choose what to check the delegate against (the
// guest row, the rounds or the house account), then check() verifies the
// delegate against that (sender, key, signature, policy).
export function delegateTarget(signedDelegateBase64: string): { senderId: string; receiverId: string } | null {
  if (typeof signedDelegateBase64 !== 'string' || signedDelegateBase64.length === 0 || signedDelegateBase64.length > 16_384) return null;
  try {
    const sd = deserialize(SCHEMA.SignedDelegate, base64Decode(signedDelegateBase64)) as RawSignedDelegate;
    const senderId = sd?.delegateAction?.senderId;
    const receiverId = sd?.delegateAction?.receiverId;
    return typeof senderId === 'string' && typeof receiverId === 'string' ? { senderId, receiverId } : null;
  } catch {
    return null;
  }
}

// The sender alone (delegateTarget's senderId).
export function delegateSenderId(signedDelegateBase64: string): string | null {
  return delegateTarget(signedDelegateBase64)?.senderId ?? null;
}

/** Parse and check a SignedDelegate without touching the chain. With
 * several policies, the delegate is checked against the one its receiver
 * names; a receiver no policy names is refused. */
export async function checkDelegate(
  signedDelegateBase64: string,
  policies: RelayPolicy | readonly RelayPolicy[],
  ctx: CheckContext & { relayerId?: string } = {},
): Promise<CheckedDelegate> {
  if (typeof signedDelegateBase64 !== 'string' || signedDelegateBase64.length === 0 || signedDelegateBase64.length > 16_384) {
    throw new RelayRejected('malformed', 'expected a base64 SignedDelegate');
  }
  let bytes: Uint8Array;
  let sd: RawSignedDelegate;
  try {
    bytes = base64Decode(signedDelegateBase64);
    sd = deserialize(SCHEMA.SignedDelegate, bytes) as RawSignedDelegate;
  } catch (e) {
    throw new RelayRejected('malformed', (e as Error).message);
  }
  // Canonical encoding only: re-encode and compare, so trailing bytes or odd
  // encodings are refused.
  let again: Uint8Array;
  try {
    again = encodeSignedDelegate(sd as unknown as SignedDelegate);
  } catch (e) {
    throw new RelayRejected('malformed', (e as Error).message);
  }
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) {
    throw new RelayRejected('malformed', 'non-canonical encoding');
  }

  const da = sd.delegateAction;
  // The policy the receiver names. The sender is checked first, as with a
  // single policy, against that policy (or the first one when the receiver
  // names none, which is then refused just after).
  const chosen = selectPolicy(policies, da.receiverId);
  const policy = fullPolicy(chosen ?? (Array.isArray(policies) ? (policies as readonly RelayPolicy[])[0] : (policies as RelayPolicy)));
  if (ctx.expectedSenderId && da.senderId !== ctx.expectedSenderId) {
    throw new RelayRejected('sender_mismatch', `${da.senderId} is not the signed-in user's account`);
  }
  if (policy.senderPattern && !policy.senderPattern.test(da.senderId)) {
    throw new RelayRejected('sender_not_allowed', da.senderId);
  }
  if (ctx.relayerId && da.senderId === ctx.relayerId) throw new RelayRejected('sender_not_allowed', 'relayer itself');
  if (!chosen || da.receiverId !== policy.contractId) throw new RelayRejected('receiver_not_allowed', da.receiverId);

  // A function-call key may sign exactly one FunctionCall; neither contract
  // needs batching.
  if (da.actions.length !== 1) throw new RelayRejected('one_action_only', String(da.actions.length));
  const action = da.actions[0];
  const keys = Object.keys(action);
  if (keys.length !== 1 || keys[0] !== 'functionCall') throw new RelayRejected('action_not_allowed', keys.join(','));
  const fc = action.functionCall as RawFunctionCall;
  if (!policy.methods.includes(fc.methodName)) throw new RelayRejected('method_not_allowed', fc.methodName);
  if (BigInt(fc.deposit) !== 0n) throw new RelayRejected('deposit_not_zero', String(fc.deposit));
  const gas = BigInt(fc.gas);
  if (gas > policy.maxGas) throw new RelayRejected('gas_too_high', String(gas));
  if (fc.args.length > policy.maxArgsBytes) throw new RelayRejected('args_too_large', String(fc.args.length));
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(fc.args)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed as Record<string, unknown>;
  } catch (e) {
    throw new RelayRejected('args_not_json', (e as Error).message);
  }

  // Signature: ed25519 over sha256(NEP-461 prefix || borsh(DelegateAction)).
  const pkData = da.publicKey.ed25519Key?.data;
  const sigData = sd.signature.ed25519Signature?.data;
  if (!pkData || !sigData) throw new RelayRejected('key_type_not_allowed');
  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(pkData) });
  if (ctx.expectedPublicKey && publicKey.toString() !== ctx.expectedPublicKey) {
    throw new RelayRejected('key_mismatch', 'not the key on record for this account');
  }
  const encoded = encodeDelegateAction(da as unknown as DelegateAction);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  if (!publicKey.verify(hash, Uint8Array.from(sigData))) throw new RelayRejected('bad_signature');

  return {
    sd: sd as unknown as SignedDelegate,
    da: da as unknown as DelegateAction,
    policy: chosen,
    publicKey,
    senderId: da.senderId,
    methodName: fc.methodName,
    args,
    gas,
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
  };
}

// ---------------------------------------------------------------- chain

export type KeyPermission = 'FullAccess' | { receiverId: string; methodNames: string[] };

export interface AccessKeyInfo {
  nonce: bigint;
  permission: KeyPermission;
}

// The reads preflight needs; a fake in tests, RPC in production.
export interface ChainReader {
  finalHeight(): Promise<bigint>;
  // null when the account or the key does not exist.
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
}

const MISSING = /does not exist|unknown access key|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|doesn't exist/i;

export function rpcChainReader(provider: JsonRpcProvider): ChainReader {
  return {
    async finalHeight() {
      const block = await provider.viewBlock({ finality: 'final' });
      return BigInt(block.header.height);
    },
    async accessKey(accountId, publicKey) {
      try {
        const key = await provider.viewAccessKey({ accountId, publicKey: PublicKey.from(publicKey) });
        return { nonce: BigInt(key.nonce), permission: normalisePermission(key.permission) };
      } catch (e) {
        const err = e as { message?: string; type?: string; name?: string };
        if (MISSING.test(`${err?.message ?? e} ${err?.type ?? ''} ${err?.name ?? ''}`)) return null;
        throw e; // RPC trouble is not the user's fault
      }
    },
  };
}

export function normalisePermission(p: unknown): KeyPermission {
  if (p === 'FullAccess') return 'FullAccess';
  const fc = (p as { FunctionCall?: { receiver_id: string; method_names: string[] } })?.FunctionCall;
  if (fc) return { receiverId: fc.receiver_id, methodNames: fc.method_names ?? [] };
  throw new Error(`unknown access key permission ${JSON.stringify(p)}`);
}

/** Cheap chain checks so the relayer does not pay for a delegate the runtime would refuse. */
export async function preflightDelegate(chain: ChainReader, checked: CheckedDelegate, policyIn: RelayPolicy = checked.policy): Promise<void> {
  const policy = fullPolicy(policyIn);
  const [height, key] = await Promise.all([chain.finalHeight(), chain.accessKey(checked.senderId, checked.publicKey.toString())]);
  if (checked.maxBlockHeight <= height) throw new RelayRejected('expired', `max ${checked.maxBlockHeight} <= ${height}`);
  if (checked.maxBlockHeight - height > BigInt(policy.maxTtlBlocks)) {
    throw new RelayRejected('ttl_too_long', String(checked.maxBlockHeight - height));
  }
  if (!key) throw new RelayRejected('unknown_key', `${checked.publicKey} on ${checked.senderId}`);
  if (checked.nonce <= key.nonce) throw new RelayRejected('stale_nonce', `${checked.nonce} <= ${key.nonce}`);
  if (key.permission === 'FullAccess') {
    if (policy.requireFunctionCallKey) throw new RelayRejected('full_access_key_not_allowed');
    return;
  }
  if (key.permission.receiverId !== policy.contractId) throw new RelayRejected('key_scope', key.permission.receiverId);
  const listed = key.permission.methodNames;
  if (listed.length > 0) {
    // A rounds key names its methods: the call has to be one of them.
    if (!listed.includes(checked.methodName)) throw new RelayRejected('key_scope', checked.methodName);
    return;
  }
  // A house key has an empty method list, so the runtime would let it call
  // any method on its receiver; the policy's own list is then the only
  // gate, checked again here against the policy the key is scoped to.
  if (!policy.methods.includes(checked.methodName)) throw new RelayRejected('key_scope', checked.methodName);
}

// ------------------------------------------------------------- outcomes

interface OutcomeLike {
  id: string;
  outcome: {
    executor_id: string;
    status: Record<string, unknown> | string;
    receipt_ids: string[];
    logs: string[];
  };
}

export interface TxResponseLike {
  transaction: { hash: string };
  status?: Record<string, unknown> | string;
  transaction_outcome: OutcomeLike;
  receipts_outcome: OutcomeLike[];
}

export interface RoundsEvent {
  event: string;
  data: Record<string, string>;
}

export interface RelayResult {
  txHash: string;
  // The called method's return value, decoded from JSON (a U128 is a
  // string: claim, claim_rollover, faucet and withdraw return amounts);
  // null for methods that return nothing.
  value: unknown;
  // The contract's NEP-297 events from the call.
  events: RoundsEvent[];
}

function statusOf(o: OutcomeLike): Record<string, unknown> {
  return typeof o.outcome.status === 'string' ? { [o.outcome.status]: null } : o.outcome.status;
}

// The first failure anywhere in the transaction: the outer status, the
// delegate receipt or the inner call (and its callbacks).
export function findFailure(res: TxResponseLike): unknown | null {
  const top = res.status && typeof res.status === 'object' ? (res.status as Record<string, unknown>).Failure : undefined;
  if (top) return top;
  for (const r of res.receipts_outcome ?? []) {
    const f = statusOf(r).Failure;
    if (f) return f;
  }
  return null;
}

// "Smart contract panicked: round is not the series' live round" -> the
// part after the prefix.
export function contractMessage(failure: unknown): string | null {
  const text = findExecutionError(failure);
  if (!text) return null;
  return text.replace(/^Smart contract panicked:\s*/i, '').trim();
}

function findExecutionError(v: unknown, depth = 0): string | null {
  if (depth > 8 || v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ExecutionError === 'string') return o.ExecutionError;
  for (const k of Object.keys(o)) {
    const found = findExecutionError(o[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeValue(b64: unknown): unknown {
  if (typeof b64 !== 'string' || b64 === '') return null;
  const text = new TextDecoder().decode(base64Decode(b64));
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The return value of the delegated call: the delegate receipt spawns one
// receipt on the contract; follow its SuccessReceiptId chain (a promise
// result, e.g. faucet -> on_faucet) to the SuccessValue.
export function callReturnValue(res: TxResponseLike, contractId: string): unknown {
  const byId = new Map((res.receipts_outcome ?? []).map((r) => [r.id, r]));
  const delegateId = res.transaction_outcome?.outcome.receipt_ids[0];
  const delegate = delegateId ? byId.get(delegateId) : undefined;
  let id = delegate?.outcome.receipt_ids.find((rid) => byId.get(rid)?.outcome.executor_id === contractId);
  for (let hops = 0; id && hops < 16; hops++) {
    const o = byId.get(id);
    if (!o) return null;
    const st = statusOf(o);
    if ('SuccessValue' in st) return decodeValue(st.SuccessValue);
    if (typeof st.SuccessReceiptId === 'string') {
      id = st.SuccessReceiptId;
      continue;
    }
    return null;
  }
  return null;
}

export function callEvents(res: TxResponseLike, contractId: string, standard = 'atnx_rounds'): RoundsEvent[] {
  const out: RoundsEvent[] = [];
  for (const r of res.receipts_outcome ?? []) {
    if (r.outcome.executor_id !== contractId) continue;
    for (const line of r.outcome.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard: string; event: string; data: Record<string, string>[] };
        if (ev.standard !== standard) continue;
        for (const d of ev.data ?? []) out.push({ event: ev.event, data: d });
      } catch {
        /* not ours */
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- relayer

export interface RelayerConfig {
  relayerId: string;
  relayerKey: string; // "ed25519:..." secret key
  // One endpoint, or several tried in order (lib/near/rpc.ts).
  rpcUrl: string | readonly string[];
  // One policy per contract the relayer relays for.
  policy: RelayPolicy | readonly RelayPolicy[];
  // Refuse to send when the relayer's spendable balance is below this (in
  // yoctoNEAR); every call in flight needs about 0.03 NEAR of float.
  minFloatYocto?: bigint;
}

export interface Relayer {
  readonly relayerId: string;
  // The first policy (the rounds'), and all of them.
  readonly policy: RelayPolicy;
  readonly policies: readonly RelayPolicy[];
  readonly provider: JsonRpcProvider;
  check(signedDelegateBase64: string, ctx?: CheckContext): Promise<CheckedDelegate>;
  preflight(checked: CheckedDelegate): Promise<void>;
  send(checked: CheckedDelegate): Promise<RelayResult>;
  // Whether the relayer's spendable balance is at or above its floor (the
  // check send() makes; the guest route asks before making a guest).
  hasFloat(): Promise<boolean>;
  // check + preflight + send, one at a time per sender in this process.
  relay(signedDelegateBase64: string, ctx?: CheckContext): Promise<RelayResult>;
  relayerAccount: Account;
}

export function createRelayer(cfg: RelayerConfig): Relayer {
  const provider = rpcProvider(cfg.rpcUrl);
  const signer = new KeyPairSigner(KeyPair.fromString(cfg.relayerKey as KeyPairString));
  const relayer = new Account(cfg.relayerId, provider, signer);
  const chain = rpcChainReader(provider);
  const policies: readonly RelayPolicy[] = Array.isArray(cfg.policy) ? cfg.policy : [cfg.policy as RelayPolicy];
  if (policies.length === 0) throw new Error('createRelayer: no policy');
  const minFloat = cfg.minFloatYocto ?? 50_000_000_000_000_000_000_000n; // 0.05 NEAR

  // The relayer's balance, re-read at most every 30 s.
  let float: { at: number; available: bigint } | null = null;
  async function ensureFloat() {
    if (minFloat <= 0n) return;
    if (!float || Date.now() - float.at > 30_000) {
      const state = await relayer.getState();
      float = { at: Date.now(), available: BigInt(state.balance.available) };
    }
    if (float.available < minFloat) throw new RelayRejected('relayer_empty', 'the relayer is out of NEAR');
  }

  const check = (b64: string, ctx: CheckContext = {}) => checkDelegate(b64, policies, { ...ctx, relayerId: cfg.relayerId });
  const preflight = (checked: CheckedDelegate) => preflightDelegate(chain, checked, checked.policy);

  async function send(checked: CheckedDelegate): Promise<RelayResult> {
    await ensureFloat();
    const res = (await relayer.signAndSendTransaction({
      // The outer transaction goes to the user; the runtime then calls the
      // contract as the user.
      receiverId: checked.senderId,
      actions: [actions.signedDelegate({ delegateAction: checked.da, signature: checked.sd.signature as Signature })],
      waitUntil: 'EXECUTED_OPTIMISTIC',
      throwOnFailure: false,
    })) as unknown as TxResponseLike;
    const txHash = res.transaction.hash;
    // The delegate receipt and the inner FunctionCall receipt both have to succeed.
    const failure = findFailure(res);
    if (failure) throw new RelayFailed(txHash, failure, contractMessage(failure));
    const p = fullPolicy(checked.policy);
    return { txHash, value: callReturnValue(res, p.contractId), events: callEvents(res, p.contractId, p.eventStandard) };
  }

  // One relay at a time per sender in this process: delegate nonces must
  // land in order. Across serverless instances the route holds a DB lock
  // (bm.near_relay_acquire) instead.
  const queues = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  async function relay(b64: string, ctx: CheckContext = {}): Promise<RelayResult> {
    const checked = await check(b64, ctx);
    return serialized(checked.senderId, async () => {
      await preflight(checked);
      return send(checked);
    });
  }

  async function hasFloat(): Promise<boolean> {
    try {
      await ensureFloat();
      return true;
    } catch (err) {
      if (err instanceof RelayRejected) return false;
      throw err;
    }
  }

  return { relayerId: cfg.relayerId, policy: policies[0], policies, provider, check, preflight, send, hasFloat, relay, relayerAccount: relayer };
}

// The relay policy for the rounds contract: user methods only, senders
// that are direct sub-accounts of the parent, function-call keys only.
export function roundsRelayPolicy(contractId: string, parentId: string, methods: readonly string[]): RelayPolicy {
  const escaped = parentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    contractId,
    methods,
    senderPattern: new RegExp(`^[a-z0-9]+([_-][a-z0-9]+)*\\.${escaped}$`),
    maxGas: 100n * TGAS,
    maxArgsBytes: 1024,
    maxTtlBlocks: 600,
    requireFunctionCallKey: true,
  };
}

// The relay policy for the house contract: the house methods only (the
// guests' shorter list is applied by the route), senders that are house
// accounts (<label>-h.<parent>, lib/near/house-account.ts), function-call
// keys only. Its keys have an empty method list, so this list is the gate
// (preflightDelegate checks it again against the key).
export function houseRelayPolicy(contractId: string, parentId: string, methods: readonly string[], maxGas: bigint = 150n * TGAS): RelayPolicy {
  const escaped = parentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    contractId,
    methods,
    senderPattern: new RegExp(`^[a-z0-9]+([_-][a-z0-9]+)*-h\\.${escaped}$`),
    maxGas,
    maxArgsBytes: 1024,
    maxTtlBlocks: 600,
    requireFunctionCallKey: true,
    eventStandard: 'atnx_house',
  };
}
