// NEP-366 relayer: takes a base64 borsh SignedDelegate, checks it against a policy,
// wraps it in a transaction signed by the relayer and sends it. The relayer pays the gas.
//
// No Node-only APIs (WebCrypto + near-api-js + borsh), so it drops into a Next.js
// route handler (see route.example.ts). `borsh` is a dependency of near-api-js 7;
// add it to the app's package.json explicitly, since near-api-js exports no
// decodeSignedDelegate.
import {
  Account, JsonRpcProvider, KeyPair, KeyPairSigner, KeyType, PublicKey, SCHEMA,
  actions, base64Decode, encodeDelegateAction, encodeSignedDelegate,
} from "near-api-js";
import { deserialize } from "borsh";

export class RelayRejected extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason; // stable code for the API response
  }
}

export class RelayFailed extends Error {
  constructor(txHash, failure) {
    super(`relayed tx ${txHash} failed: ${JSON.stringify(failure)}`);
    this.txHash = txHash;
    this.failure = failure;
  }
}

const TGAS = 10n ** 12n;

/**
 * @param {object} cfg
 * @param {string} cfg.relayerId      e.g. relayer.atnx.testnet
 * @param {string} cfg.relayerKey     "ed25519:..." secret key (env var in production)
 * @param {string} cfg.rpcUrl
 * @param {object} cfg.policy
 * @param {string} cfg.policy.contractId          the only allowed receiver
 * @param {string[]} cfg.policy.methods           allowed method names
 * @param {RegExp} [cfg.policy.senderPattern]     which accounts we relay for
 * @param {bigint} [cfg.policy.maxGas]            per FunctionCall
 * @param {number} [cfg.policy.maxArgsBytes]
 * @param {number} [cfg.policy.maxTtlBlocks]      reject delegates valid for longer than this
 * @param {boolean} [cfg.policy.requireFunctionCallKey]  only relay for keys scoped to contractId
 */
export function createRelayer(cfg) {
  const policy = {
    maxGas: 100n * TGAS,
    maxArgsBytes: 4096,
    maxTtlBlocks: 1000,
    requireFunctionCallKey: false,
    ...cfg.policy,
  };
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(cfg.relayerKey));
  const relayer = new Account(cfg.relayerId, provider, signer);

  /** Parse and check a SignedDelegate without touching the chain. */
  async function check(signedDelegateBase64, { expectedSenderId } = {}) {
    let bytes, sd;
    try {
      bytes = base64Decode(signedDelegateBase64);
      sd = deserialize(SCHEMA.SignedDelegate, bytes);
    } catch (e) {
      throw new RelayRejected("malformed", e.message);
    }
    // Canonical encoding only: re-encode and compare, so trailing bytes or odd encodings are refused.
    const again = encodeSignedDelegate(sd);
    if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) {
      throw new RelayRejected("malformed", "non-canonical encoding");
    }

    const da = sd.delegateAction;
    if (expectedSenderId && da.senderId !== expectedSenderId) {
      throw new RelayRejected("sender_mismatch", `${da.senderId} is not the signed-in user`);
    }
    if (policy.senderPattern && !policy.senderPattern.test(da.senderId)) {
      throw new RelayRejected("sender_not_allowed", da.senderId);
    }
    if (da.senderId === cfg.relayerId) throw new RelayRejected("sender_not_allowed", "relayer itself");
    if (da.receiverId !== policy.contractId) {
      throw new RelayRejected("receiver_not_allowed", da.receiverId);
    }
    // A function-call key may sign exactly one FunctionCall; the rounds contract needs no batching.
    if (da.actions.length !== 1) throw new RelayRejected("one_action_only", String(da.actions.length));
    for (const a of da.actions) {
      const keys = Object.keys(a);
      if (keys.length !== 1 || keys[0] !== "functionCall") {
        throw new RelayRejected("action_not_allowed", keys.join(","));
      }
      const fc = a.functionCall;
      if (!policy.methods.includes(fc.methodName)) throw new RelayRejected("method_not_allowed", fc.methodName);
      if (BigInt(fc.deposit) !== 0n) throw new RelayRejected("deposit_not_zero", String(fc.deposit));
      if (BigInt(fc.gas) > policy.maxGas) throw new RelayRejected("gas_too_high", String(fc.gas));
      if (fc.args.length > policy.maxArgsBytes) throw new RelayRejected("args_too_large", String(fc.args.length));
    }

    // Signature: ed25519 over sha256(NEP-461 prefix || borsh(DelegateAction)).
    if (!("ed25519Key" in da.publicKey) || !("ed25519Signature" in sd.signature)) {
      throw new RelayRejected("key_type_not_allowed");
    }
    const publicKey = new PublicKey({
      keyType: KeyType.ED25519,
      data: Uint8Array.from(da.publicKey.ed25519Key.data),
    });
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeDelegateAction(da)));
    if (!publicKey.verify(hash, Uint8Array.from(sd.signature.ed25519Signature.data))) {
      throw new RelayRejected("bad_signature");
    }
    return { sd, da, publicKey };
  }

  /** Cheap chain checks so we don't pay gas for a delegate the runtime would refuse. */
  async function preflight({ da, publicKey }) {
    const [block, key] = await Promise.all([
      provider.viewBlock({ finality: "final" }),
      provider.viewAccessKey({ accountId: da.senderId, publicKey }).catch((e) => {
        if (/does not exist|unknown access key|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i.test(String(e?.message ?? e) + (e?.type ?? ""))) return null;
        throw e; // RPC trouble is not the user's fault
      }),
    ]);
    const height = BigInt(block.header.height);
    if (BigInt(da.maxBlockHeight) <= height) throw new RelayRejected("expired", `max ${da.maxBlockHeight} <= ${height}`);
    if (BigInt(da.maxBlockHeight) - height > BigInt(policy.maxTtlBlocks)) {
      throw new RelayRejected("ttl_too_long", String(BigInt(da.maxBlockHeight) - height));
    }
    if (!key) throw new RelayRejected("unknown_key", `${publicKey} on ${da.senderId}`);
    if (BigInt(da.nonce) <= BigInt(key.nonce)) {
      throw new RelayRejected("stale_nonce", `${da.nonce} <= ${key.nonce} (replay?)`);
    }
    const perm = key.permission;
    if (perm !== "FullAccess") {
      const fc = perm.FunctionCall;
      if (fc.receiver_id !== policy.contractId) throw new RelayRejected("key_scope", fc.receiver_id);
      const m = da.actions[0].functionCall.methodName;
      if (fc.method_names.length && !fc.method_names.includes(m)) throw new RelayRejected("key_scope", m);
    } else if (policy.requireFunctionCallKey) {
      throw new RelayRejected("full_access_key_not_allowed");
    }
  }

  // One relay at a time per sender: delegate nonces must land in order, and a second delegate
  // signed before the first landed carries the same nonce. Queueing makes both cases fail in
  // preflight (free) instead of on chain (relayer pays). In-process only: on serverless with
  // several instances, use a DB lock or have the client send one action at a time.
  const queues = new Map();
  function serialized(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }

  /**
   * relay(signedDelegateBase64) -> txHash
   * Throws RelayRejected before sending (nothing spent) or RelayFailed after (gas spent).
   */
  async function relay(signedDelegateBase64, ctx = {}) {
    const checked = await check(signedDelegateBase64, ctx);
    return serialized(checked.da.senderId, () => send(checked, ctx));
  }

  async function send(checked, ctx) {
    await preflight(checked);
    const res = await relayer.signAndSendTransaction({
      receiverId: checked.da.senderId, // the outer tx goes to the user; the runtime then calls the contract as the user
      actions: [actions.signedDelegate({ delegateAction: checked.da, signature: checked.sd.signature })],
      waitUntil: ctx.waitUntil ?? "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    });
    const txHash = res.transaction.hash;
    // The delegate receipt and the inner FunctionCall receipt both have to succeed.
    const failure = res.status?.Failure
      ?? res.receipts_outcome?.find((r) => r.outcome.status?.Failure)?.outcome.status.Failure;
    if (failure) throw new RelayFailed(txHash, failure);
    return txHash;
  }

  return { relay, check, preflight, relayerAccount: relayer };
}
