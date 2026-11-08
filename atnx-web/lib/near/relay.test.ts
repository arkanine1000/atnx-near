import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, actions, base64Decode, base64Encode, buildDelegateAction, encodeSignedDelegate, type Action, type Signer } from 'near-api-js';
import {
  RelayRejected,
  callEvents,
  callReturnValue,
  checkDelegate,
  contractMessage,
  findFailure,
  preflightDelegate,
  roundsRelayPolicy,
  type AccessKeyInfo,
  type ChainReader,
  type TxResponseLike,
} from './relay';
import { USER_METHODS } from './config';
import { WebCryptoSigner } from './signer';

const ROUNDS = 'rounds.atnx.testnet';
const PARENT = 'atnx.testnet';
const ALICE = 'alice.atnx.testnet';
const TGAS = 10n ** 12n;
const policy = roundsRelayPolicy(ROUNDS, PARENT, USER_METHODS);

async function sign(
  signer: Signer,
  over: { senderId?: string; receiverId?: string; actions?: Action[]; nonce?: bigint; maxBlockHeight?: bigint } = {},
): Promise<string> {
  const da = buildDelegateAction({
    senderId: over.senderId ?? ALICE,
    receiverId: over.receiverId ?? ROUNDS,
    actions: over.actions ?? [actions.functionCall('commit', { series_id: 1, round_index: 2, side: 'Up', amount: '25000000' }, 30n * TGAS, 0n)],
    nonce: over.nonce ?? 101n,
    maxBlockHeight: over.maxBlockHeight ?? 1_200n,
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(da);
  return base64Encode(encodeSignedDelegate(signedDelegate));
}

async function rejects(p: Promise<unknown>, reason: string) {
  await assert.rejects(p, (e: unknown) => e instanceof RelayRejected && e.reason === reason, `expected ${reason}`);
}

const keySigner = () => new KeyPairSigner(KeyPair.fromRandom('ed25519'));

test('a good delegate passes and hands on the call', async () => {
  const s = keySigner();
  const pk = (await s.getPublicKey()).toString();
  const c = await checkDelegate(await sign(s), policy, { expectedSenderId: ALICE, expectedPublicKey: pk });
  assert.equal(c.senderId, ALICE);
  assert.equal(c.methodName, 'commit');
  assert.deepEqual(c.args, { series_id: 1, round_index: 2, side: 'Up', amount: '25000000' });
  assert.equal(c.nonce, 101n);
  assert.equal(c.gas, 30n * TGAS);
  assert.equal(c.publicKey.toString(), pk);
});

test('the WebCrypto signer produces delegates the relayer accepts', async () => {
  const s = await WebCryptoSigner.generate();
  const c = await checkDelegate(await sign(s), policy, { expectedSenderId: ALICE, expectedPublicKey: s.publicKeyString });
  assert.equal(c.publicKey.toString(), s.publicKeyString);
  // And a key pair imported into WebCrypto signs the same bytes.
  const kp = KeyPair.fromRandom('ed25519');
  const w = await WebCryptoSigner.fromKeyPair(kp);
  assert.equal(w.publicKeyString, kp.getPublicKey().toString());
  await checkDelegate(await sign(w), policy, { expectedPublicKey: kp.getPublicKey().toString() });
});

test('policy: receiver, method, deposit, gas, action count, args', async () => {
  const s = keySigner();
  await rejects(checkDelegate(await sign(s, { receiverId: 'usdg.atnx.testnet' }), policy), 'receiver_not_allowed');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('withdraw_fees', { series_id: 1 }, 30n * TGAS, 0n)] }), policy), 'method_not_allowed');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('open_round', { series_id: 1, target_e2: 1 }, 30n * TGAS, 0n)] }), policy), 'method_not_allowed');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('commit', {}, 30n * TGAS, 1n)] }), policy), 'deposit_not_zero');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('commit', {}, 101n * TGAS, 0n)] }), policy), 'gas_too_high');
  const two = [actions.functionCall('faucet', { amount: '1' }, 30n * TGAS, 0n), actions.functionCall('faucet', { amount: '1' }, 30n * TGAS, 0n)];
  await rejects(checkDelegate(await sign(s, { actions: two }), policy), 'one_action_only');
  await rejects(checkDelegate(await sign(s, { actions: [actions.transfer(1n)] }), policy), 'action_not_allowed');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('commit', new Uint8Array([1, 2, 3]), 30n * TGAS, 0n)] }), policy), 'args_not_json');
  await rejects(checkDelegate(await sign(s, { actions: [actions.functionCall('commit', { pad: 'x'.repeat(2000) }, 30n * TGAS, 0n)] }), policy), 'args_too_large');
});

test('policy: who may send', async () => {
  const s = keySigner();
  await rejects(checkDelegate(await sign(s), policy, { expectedSenderId: 'bob.atnx.testnet' }), 'sender_mismatch');
  await rejects(checkDelegate(await sign(s, { senderId: 'alice.near' }), policy), 'sender_not_allowed');
  await rejects(checkDelegate(await sign(s, { senderId: 'deep.alice.atnx.testnet' }), policy), 'sender_not_allowed');
  await rejects(checkDelegate(await sign(s, { senderId: 'relayer.atnx.testnet' }), policy, { relayerId: 'relayer.atnx.testnet' }), 'sender_not_allowed');
  // Signed by a key other than the one on record for the account.
  await rejects(checkDelegate(await sign(s), policy, { expectedPublicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() }), 'key_mismatch');
});

test('signature and encoding are checked', async () => {
  const s = keySigner();
  const good = base64Decode(await sign(s));
  // Flip one bit of the signature (the last bytes).
  const badSig = Uint8Array.from(good);
  badSig[badSig.length - 1] ^= 1;
  await rejects(checkDelegate(base64Encode(badSig), policy), 'bad_signature');
  // Change the amount inside the signed bytes: the signature no longer matches.
  const text = new TextDecoder('latin1').decode(good);
  const at = text.indexOf('25000000');
  assert.ok(at > 0);
  const tampered = Uint8Array.from(good);
  tampered[at] = '9'.charCodeAt(0);
  await rejects(checkDelegate(base64Encode(tampered), policy), 'bad_signature');
  // Trailing bytes.
  const trailing = new Uint8Array(good.length + 1);
  trailing.set(good);
  await rejects(checkDelegate(base64Encode(trailing), policy), 'malformed');
  await rejects(checkDelegate('not base64 at all!', policy), 'malformed');
  await rejects(checkDelegate('', policy), 'malformed');
});

function fakeChain(height: bigint, key: AccessKeyInfo | null): ChainReader {
  return { finalHeight: async () => height, accessKey: async () => key };
}

const scoped: AccessKeyInfo = { nonce: 100n, permission: { receiverId: ROUNDS, methodNames: [...USER_METHODS] } };

test('preflight: expiry, ttl, key, nonce and scope', async () => {
  const s = keySigner();
  const c = await checkDelegate(await sign(s, { nonce: 101n, maxBlockHeight: 1_200n }), policy);
  await preflightDelegate(fakeChain(1_000n, scoped), c, policy);
  await rejects(preflightDelegate(fakeChain(1_200n, scoped), c, policy), 'expired');
  await rejects(preflightDelegate(fakeChain(500n, scoped), c, policy), 'ttl_too_long');
  await rejects(preflightDelegate(fakeChain(1_000n, null), c, policy), 'unknown_key');
  await rejects(preflightDelegate(fakeChain(1_000n, { ...scoped, nonce: 101n }), c, policy), 'stale_nonce');
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: 'usdg.atnx.testnet', methodNames: [] } }), c, policy), 'key_scope');
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: ROUNDS, methodNames: ['faucet'] } }), c, policy), 'key_scope');
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: 'FullAccess' }), c, policy), 'full_access_key_not_allowed');
  // An empty method list means any method on the receiver.
  await preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: ROUNDS, methodNames: [] } }), c, policy);
});

// A relayed faucet: tx -> delegate receipt on alice -> faucet on rounds
// (returns a promise) -> mint on usdg -> on_faucet on rounds (the value).
const b64 = (s: string) => Buffer.from(s).toString('base64');
const faucetTx: TxResponseLike = {
  transaction: { hash: 'TX1' },
  status: { SuccessValue: '' },
  transaction_outcome: { id: 'TX1', outcome: { executor_id: 'relayer.atnx.testnet', status: { SuccessReceiptId: 'R1' }, receipt_ids: ['R1'], logs: [] } },
  receipts_outcome: [
    { id: 'R1', outcome: { executor_id: ALICE, status: { SuccessValue: '' }, receipt_ids: ['R2', 'RF'], logs: [] } },
    { id: 'R2', outcome: { executor_id: ROUNDS, status: { SuccessReceiptId: 'R4' }, receipt_ids: ['R3', 'R4'], logs: [] } },
    { id: 'R3', outcome: { executor_id: 'usdg.atnx.testnet', status: { SuccessValue: '' }, receipt_ids: [], logs: ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"rounds.atnx.testnet","amount":"1000000000"}]}'] } },
    {
      id: 'R4',
      outcome: {
        executor_id: ROUNDS,
        status: { SuccessValue: b64('"1000000000"') },
        receipt_ids: [],
        logs: ['EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"faucet","data":[{"account":"alice.atnx.testnet","amount":"1000000000"}]}'],
      },
    },
    { id: 'RF', outcome: { executor_id: 'relayer.atnx.testnet', status: { SuccessValue: '' }, receipt_ids: [], logs: [] } },
  ],
};

test('the return value follows the promise chain to the callback', () => {
  assert.equal(callReturnValue(faucetTx, ROUNDS), '1000000000');
  assert.deepEqual(callEvents(faucetTx, ROUNDS), [{ event: 'faucet', data: { account: ALICE, amount: '1000000000' } }]);
  assert.equal(findFailure(faucetTx), null);
  // A method that returns nothing.
  const commit: TxResponseLike = {
    ...faucetTx,
    receipts_outcome: [
      { id: 'R1', outcome: { executor_id: ALICE, status: { SuccessValue: '' }, receipt_ids: ['R2'], logs: [] } },
      { id: 'R2', outcome: { executor_id: ROUNDS, status: { SuccessValue: '' }, receipt_ids: [], logs: [] } },
    ],
  };
  assert.equal(callReturnValue(commit, ROUNDS), null);
});

test('a failure in the inner call is found and its message extracted', () => {
  const failed: TxResponseLike = {
    ...faucetTx,
    receipts_outcome: [
      { id: 'R1', outcome: { executor_id: ALICE, status: { SuccessValue: '' }, receipt_ids: ['R2'], logs: [] } },
      {
        id: 'R2',
        outcome: {
          executor_id: ROUNDS,
          status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: round is not the series' live round" } } } } },
          receipt_ids: [],
          logs: [],
        },
      },
    ],
  };
  const f = findFailure(failed);
  assert.ok(f);
  assert.equal(contractMessage(f), "round is not the series' live round");
  assert.equal(contractMessage({ InvalidTxError: 'Expired' }), null);
});
