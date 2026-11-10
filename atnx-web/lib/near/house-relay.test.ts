import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, PublicKey, actions, base64Encode, buildDelegateAction, encodeSignedDelegate, nearToYocto, type Action, type Signer } from 'near-api-js';
import { HOUSE_GUEST_METHODS, HOUSE_METHOD_GAS, HOUSE_USER_METHODS, USER_METHODS } from './config';
import { GUEST_CAPS } from './guest';
import { houseAccountId } from './house-account';
import {
  RelayRejected,
  callEvents,
  checkDelegate,
  delegateTarget,
  houseRelayPolicy,
  preflightDelegate,
  roundsRelayPolicy,
  selectPolicy,
  type AccessKeyInfo,
  type CheckedDelegate,
  type ChainReader,
  type RelayResult,
  type TxResponseLike,
} from './relay';
import {
  appCheckByReceiver,
  ensureHouseAccount,
  handleAccountCreate,
  handleGuestCreate,
  handleRelay,
  type AccountChain,
  type HouseAccountChain,
  type RelayDeps,
  type RouteUser,
} from './routes';
import { accountCreationActions, houseAccountCreationActions } from './server-chain';
import { memoryNearAccountStore, memoryNearGuestStore } from './store';
import type { AccountKey } from './house-account';

const PARENT = 'atnx.testnet';
const ROUNDS = 'rounds.atnx.testnet';
const HOUSE = 'house.atnx.testnet';
const TGAS = 10n ** 12n;
const rounds = roundsRelayPolicy(ROUNDS, PARENT, USER_METHODS);
const house = houseRelayPolicy(HOUSE, PARENT, HOUSE_USER_METHODS);
const both = [rounds, house];
const keySigner = () => new KeyPairSigner(KeyPair.fromRandom('ed25519'));
const newKey = () => KeyPair.fromRandom('ed25519').getPublicKey().toString();

async function sign(
  signer: Signer,
  o: { senderId: string; receiverId?: string; method?: string; args?: Record<string, unknown>; gas?: bigint; nonce?: bigint },
): Promise<string> {
  const da = buildDelegateAction({
    senderId: o.senderId,
    receiverId: o.receiverId ?? HOUSE,
    actions: [actions.functionCall(o.method ?? 'open', o.args ?? { market: 1, side: 'Long', leverage: 3, stake: '100000000', limit_e2: '41289' }, o.gas ?? 30n * TGAS, 0n)] as Action[],
    nonce: o.nonce ?? 101n,
    maxBlockHeight: 1_200n,
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(da);
  return base64Encode(encodeSignedDelegate(signedDelegate));
}

async function rejects(p: Promise<unknown>, reason: string) {
  await assert.rejects(p, (e: unknown) => e instanceof RelayRejected && e.reason === reason, `expected ${reason}`);
}

// ------------------------------------------------------- the policies

test('house methods: the users list, and the guests list is the same without withdraw', () => {
  assert.deepEqual([...HOUSE_USER_METHODS].sort(), ['cancel', 'close', 'crank', 'faucet', 'open', 'withdraw']);
  assert.deepEqual([...HOUSE_GUEST_METHODS].sort(), ['cancel', 'close', 'crank', 'faucet', 'open']);
  for (const m of HOUSE_USER_METHODS) assert.ok(HOUSE_METHOD_GAS[m] > 0n && HOUSE_METHOD_GAS[m] <= 150n * TGAS, m);
  // Every attached gas passes the house policy's own cap.
  for (const m of HOUSE_USER_METHODS) assert.ok(HOUSE_METHOD_GAS[m] <= (house.maxGas ?? 0n), m);
});

test('policy selection: the delegate is checked against the policy its receiver names', async () => {
  const s = keySigner();
  assert.equal(selectPolicy(both, HOUSE), house);
  assert.equal(selectPolicy(both, ROUNDS), rounds);
  assert.equal(selectPolicy(both, 'usdg.atnx.testnet'), null);
  assert.equal(selectPolicy(rounds, ROUNDS), rounds);

  const h = await checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet' }), both);
  assert.equal(h.policy, house);
  assert.equal(h.methodName, 'open');
  const r = await checkDelegate(await sign(s, { senderId: 'alice.atnx.testnet', receiverId: ROUNDS, method: 'commit', args: { series_id: 1, round_index: 1, side: 'Up', amount: '1' } }), both);
  assert.equal(r.policy, rounds);
  await rejects(checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet', receiverId: 'usdg.atnx.testnet' }), both), 'receiver_not_allowed');
  // The rounds-only relayer refuses the house as before.
  await rejects(checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet' }), rounds), 'receiver_not_allowed');
});

test('house policy: its methods only, house senders only, its gas cap', async () => {
  const s = keySigner();
  const H = 'alice-h.atnx.testnet';
  for (const m of HOUSE_USER_METHODS) await checkDelegate(await sign(s, { senderId: H, method: m, args: {} }), both);
  for (const m of ['commit', 'buy', 'claim', 'push_quotes', 'list_market', 'set_config', 'set_paused', 'lp_deposit', 'migrate', 'settle_stale']) {
    await rejects(checkDelegate(await sign(s, { senderId: H, method: m, args: {} }), both), 'method_not_allowed');
  }
  // The rounds contract still takes only its own methods.
  await rejects(checkDelegate(await sign(s, { senderId: 'alice.atnx.testnet', receiverId: ROUNDS, method: 'open', args: {} }), both), 'method_not_allowed');
  // A house sender is <label>-h.<parent>.
  await rejects(checkDelegate(await sign(s, { senderId: 'alice.atnx.testnet' }), both), 'sender_not_allowed');
  await rejects(checkDelegate(await sign(s, { senderId: 'alice-h.near' }), both), 'sender_not_allowed');
  await rejects(checkDelegate(await sign(s, { senderId: 'x.alice-h.atnx.testnet' }), both), 'sender_not_allowed');
  // A full crank fits, more does not; the rounds cap is unchanged.
  await checkDelegate(await sign(s, { senderId: H, method: 'crank', args: {}, gas: 150n * TGAS }), both);
  await rejects(checkDelegate(await sign(s, { senderId: H, method: 'crank', args: {}, gas: 151n * TGAS }), both), 'gas_too_high');
  await rejects(checkDelegate(await sign(s, { senderId: 'alice.atnx.testnet', receiverId: ROUNDS, method: 'commit', args: {}, gas: 101n * TGAS }), both), 'gas_too_high');
});

function fakeChain(height: bigint, key: AccessKeyInfo | null): ChainReader {
  return { finalHeight: async () => height, accessKey: async () => key };
}

test('key scope: a house key has an empty method list, so the policy list is the gate', async () => {
  const s = keySigner();
  const c = await checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet' }), both);
  const houseKey: AccessKeyInfo = { nonce: 1n, permission: { receiverId: HOUSE, methodNames: [] } };
  // The policy defaults to the one the delegate was checked against.
  await preflightDelegate(fakeChain(1_000n, houseKey), c);
  await preflightDelegate(fakeChain(1_000n, houseKey), c, house);
  // A method outside the policy is refused even though the key would allow it.
  const outside = { ...c, methodName: 'push_quotes' } as CheckedDelegate;
  await rejects(preflightDelegate(fakeChain(1_000n, houseKey), outside), 'key_scope');
  // A key for another receiver (the rounds key), a full-access key.
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: ROUNDS, methodNames: [...USER_METHODS] } }), c), 'key_scope');
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: 'FullAccess' }), c), 'full_access_key_not_allowed');
  // A house key with a list still has to name the method.
  await preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: HOUSE, methodNames: ['open'] } }), c);
  await rejects(preflightDelegate(fakeChain(1_000n, { nonce: 1n, permission: { receiverId: HOUSE, methodNames: ['close'] } }), c), 'key_scope');
});

test('delegateTarget: the sender and the receiver, unchecked', async () => {
  const s = keySigner();
  assert.deepEqual(delegateTarget(await sign(s, { senderId: 'alice-h.atnx.testnet' })), { senderId: 'alice-h.atnx.testnet', receiverId: HOUSE });
  assert.equal(delegateTarget('nope'), null);
  assert.equal(delegateTarget(''), null);
});

test('events: the house standard is read from the house contract', () => {
  const tx: TxResponseLike = {
    transaction: { hash: 'T' },
    transaction_outcome: { id: 'T', outcome: { executor_id: 'relayer.atnx.testnet', status: { SuccessReceiptId: 'R1' }, receipt_ids: ['R1'], logs: [] } },
    receipts_outcome: [
      { id: 'R1', outcome: { executor_id: 'alice-h.atnx.testnet', status: { SuccessValue: '' }, receipt_ids: ['R2'], logs: [] } },
      {
        id: 'R2',
        outcome: {
          executor_id: HOUSE,
          status: { SuccessValue: Buffer.from('"7"').toString('base64') },
          receipt_ids: [],
          logs: ['EVENT_JSON:{"standard":"atnx_house","version":"1.0.0","event":"order_placed","data":[{"id":"7","market":"1"}]}'],
        },
      },
    ],
  };
  assert.deepEqual(callEvents(tx, HOUSE, 'atnx_house'), [{ event: 'order_placed', data: { id: '7', market: '1' } }]);
  assert.deepEqual(callEvents(tx, HOUSE), [], 'the rounds standard does not match');
});

// ------------------------------------------------------------ accounts

test('house key: CreateAccount plus the same browser key for the house contract, an empty method list, the same allowance, no NEAR', () => {
  const pk = newKey();
  const acts = houseAccountCreationActions(pk, HOUSE) as unknown as Array<Record<string, unknown>>;
  assert.equal(acts.length, 2);
  assert.ok('createAccount' in acts[0]);
  const addKey = acts[1].addKey as { publicKey: { ed25519Key: { data: Uint8Array } }; accessKey: { permission: Record<string, unknown> } };
  assert.deepEqual(Uint8Array.from(addKey.publicKey.ed25519Key.data), Uint8Array.from(PublicKey.from(pk).data));
  assert.ok(!('fullAccess' in addKey.accessKey.permission));
  const fc = addKey.accessKey.permission.functionCall as { receiverId: string; methodNames: string[]; allowance: bigint };
  assert.equal(fc.receiverId, HOUSE);
  assert.deepEqual(fc.methodNames, []);
  const roundsFc = ((accountCreationActions(pk, ROUNDS) as unknown as Array<Record<string, unknown>>)[1].addKey as typeof addKey).accessKey.permission.functionCall as typeof fc;
  assert.equal(fc.allowance, roundsFc.allowance);
  assert.equal(fc.allowance, nearToYocto('0.25'));
  assert.ok(!acts.some((a) => 'transfer' in a));
});

// A chain with accounts and their keys, recording what the parent made.
function chainWith(opts: { failCreate?: boolean | 'landed'; failHouse?: boolean | 'landed' } = {}) {
  const keys = new Map<string, AccountKey[]>();
  const created: string[] = [];
  const createdHouse: string[] = [];
  const chain: AccountChain & HouseAccountChain = {
    async accountExists(id) {
      return keys.has(id);
    },
    async hasKey(id, pk) {
      return keys.get(id)?.some((k) => k.publicKey === pk) ?? false;
    },
    async createAccount({ accountId, publicKey }) {
      if (opts.failCreate === true) throw new Error('rpc timeout');
      if (keys.has(accountId)) throw new Error('account already exists');
      keys.set(accountId, [{ publicKey, permission: { receiverId: ROUNDS, methodNames: [...USER_METHODS] } }]);
      created.push(accountId);
      return { txHash: `tx-${accountId}` };
    },
    async accessKeys(id) {
      return keys.get(id) ?? null;
    },
    async createHouseAccount({ accountId, publicKey }) {
      if (opts.failHouse === true) throw new Error('rpc timeout');
      if (keys.has(accountId)) throw new Error('account already exists');
      keys.set(accountId, [{ publicKey, permission: { receiverId: HOUSE, methodNames: [] } }]);
      createdHouse.push(accountId);
      if (opts.failHouse === 'landed') throw new Error('timeout after send');
      return { txHash: `htx-${accountId}` };
    },
  };
  return { chain, keys, created, createdHouse };
}

const alice: RouteUser = { id: '00000000-0000-4000-8000-00000000000a', username: 'Alice' };

test('ensureHouseAccount: missing is created, the same key is reused, anything else is a clash', async () => {
  const pk = newKey();
  const w = chainWith();
  const h = { contractId: HOUSE, chain: w.chain };
  const made = await ensureHouseAccount(h, 'alice.atnx.testnet', pk, PARENT);
  assert.deepEqual(made, { ok: true, accountId: 'alice-h.atnx.testnet', created: true, txHash: 'htx-alice-h.atnx.testnet' });
  const again = await ensureHouseAccount(h, 'alice.atnx.testnet', pk, PARENT);
  assert.deepEqual(again, { ok: true, accountId: 'alice-h.atnx.testnet', created: false, txHash: null });
  assert.equal(w.createdHouse.length, 1);
  // Another browser key on the same name.
  const other = await ensureHouseAccount(h, 'alice.atnx.testnet', newKey(), PARENT);
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.error, 'house_account_clash');
  assert.equal(!other.ok && other.status, 409);
  // The right key, but also a second one; a full-access key; a rounds-scoped key.
  for (const ks of [
    [{ publicKey: pk, permission: { receiverId: HOUSE, methodNames: [] } }, { publicKey: newKey(), permission: { receiverId: HOUSE, methodNames: [] } }],
    [{ publicKey: pk, permission: 'FullAccess' as const }],
    [{ publicKey: pk, permission: { receiverId: ROUNDS, methodNames: [...USER_METHODS] } }],
  ]) {
    w.keys.set('bob-h.atnx.testnet', ks);
    const r = await ensureHouseAccount(h, 'bob.atnx.testnet', pk, PARENT);
    assert.equal(!r.ok && r.error, 'house_account_clash');
  }
  assert.equal(w.createdHouse.length, 1, 'nothing sent for a clash');
  // A name that does not derive.
  const bad = await ensureHouseAccount(h, 'alice.near', pk, PARENT);
  assert.equal(!bad.ok && bad.error, 'house_name');
});

test('ensureHouseAccount: a failed send is reported, one that landed counts', async () => {
  const pk = newKey();
  const failed = await ensureHouseAccount({ contractId: HOUSE, chain: chainWith({ failHouse: true }).chain }, 'alice.atnx.testnet', pk, PARENT);
  assert.equal(!failed.ok && failed.error, 'house_create_failed');
  assert.equal(!failed.ok && failed.status, 502);
  const landed = await ensureHouseAccount({ contractId: HOUSE, chain: chainWith({ failHouse: 'landed' }).chain }, 'alice.atnx.testnet', pk, PARENT);
  assert.deepEqual(landed, { ok: true, accountId: 'alice-h.atnx.testnet', created: true, txHash: null });
});

test('account, house on: the rounds account as before, then its house account; idempotent', async () => {
  const w = chainWith();
  const store = memoryNearAccountStore();
  const deps = { store, chain: w.chain, parentId: PARENT, house: { contractId: HOUSE, chain: w.chain } };
  const pk = newKey();
  const r = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(r.status, 201);
  assert.equal(r.body.accountId, 'alice.atnx.testnet');
  assert.equal(r.body.houseAccountId, 'alice-h.atnx.testnet');
  assert.equal(r.body.houseCreated, true);
  assert.deepEqual(w.created, ['alice.atnx.testnet']);
  assert.deepEqual(w.createdHouse, ['alice-h.atnx.testnet']);
  // The row is the rounds account, as before.
  assert.equal((await store.getByUser(alice.id))?.accountId, 'alice.atnx.testnet');
  const again = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(again.status, 200);
  assert.equal(again.body.houseCreated, false);
  assert.equal(w.createdHouse.length, 1);
});

test('account, house on: a rounds account made before gets its house account on the next call', async () => {
  const w = chainWith();
  const store = memoryNearAccountStore();
  const pk = newKey();
  // Made with the house off.
  const before = await handleAccountCreate({ store, chain: w.chain, parentId: PARENT }, alice, { publicKey: pk });
  assert.equal(before.status, 201);
  assert.equal('houseAccountId' in before.body, false, 'house off: the answer is as it was');
  const after = await handleAccountCreate({ store, chain: w.chain, parentId: PARENT, house: { contractId: HOUSE, chain: w.chain } }, alice, { publicKey: pk });
  assert.equal(after.status, 200);
  assert.equal(after.body.houseAccountId, 'alice-h.atnx.testnet');
  assert.equal(after.body.houseCreated, true);
});

test('account, house on: a clash on the house name is a clear error, and the rounds account stays', async () => {
  const w = chainWith();
  w.keys.set('alice-h.atnx.testnet', [{ publicKey: newKey(), permission: { receiverId: HOUSE, methodNames: [] } }]);
  const store = memoryNearAccountStore();
  const pk = newKey();
  // A rounds name whose house name is taken is skipped when picking a new one...
  const r = await handleAccountCreate({ store, chain: w.chain, parentId: PARENT, house: { contractId: HOUSE, chain: w.chain } }, alice, { publicKey: pk });
  assert.equal(r.status, 201);
  assert.match(String(r.body.accountId), /^alice-[0-9a-z]{4}\.atnx\.testnet$/);
  assert.equal(r.body.houseAccountId, houseAccountId(String(r.body.accountId)));
  // ...but an existing rounds account whose house name is taken gets the error.
  const w2 = chainWith();
  const store2 = memoryNearAccountStore();
  await handleAccountCreate({ store: store2, chain: w2.chain, parentId: PARENT }, alice, { publicKey: pk });
  w2.keys.set('alice-h.atnx.testnet', [{ publicKey: newKey(), permission: 'FullAccess' }]);
  const clash = await handleAccountCreate({ store: store2, chain: w2.chain, parentId: PARENT, house: { contractId: HOUSE, chain: w2.chain } }, alice, { publicKey: pk });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'house_account_clash');
  assert.equal(clash.body.accountId, 'alice.atnx.testnet');
  assert.equal(clash.body.houseAccountId, 'alice-h.atnx.testnet');
  assert.equal((await store2.getByUser(alice.id))?.state, 'active');
  assert.deepEqual(w2.createdHouse, []);
});

test('guest, house on: guest-<8> and guest-<8>-h with the same key; idempotent; a clash is reported', async () => {
  const w = chainWith();
  const store = memoryNearGuestStore();
  const deps = { store, chain: w.chain, parentId: PARENT, hashIp: async () => 'a'.repeat(64), house: { contractId: HOUSE, chain: w.chain } };
  const pk = newKey();
  const r = await handleGuestCreate(deps, { ip: '203.0.113.9' }, { publicKey: pk });
  assert.equal(r.status, 201);
  assert.match(String(r.body.accountId), /^guest-[0-9a-z]{8}\.atnx\.testnet$/);
  assert.equal(r.body.houseAccountId, houseAccountId(String(r.body.accountId)));
  assert.match(String(r.body.houseAccountId), /^guest-[0-9a-z]{8}-h\.atnx\.testnet$/);
  const again = await handleGuestCreate(deps, { ip: '203.0.113.9' }, { publicKey: pk });
  assert.equal(again.status, 200);
  assert.equal(again.body.houseCreated, false);
  assert.equal(w.createdHouse.length, 1);
  // House off: the guest answer is as it was.
  const off = await handleGuestCreate({ ...deps, house: undefined }, { ip: '203.0.113.9' }, { publicKey: pk });
  assert.equal('houseAccountId' in off.body, false);
  // A guest whose house name holds another key.
  const pk2 = newKey();
  const g2 = await handleGuestCreate({ ...deps, house: undefined }, { ip: '198.51.100.3' }, { publicKey: pk2 });
  w.keys.set(houseAccountId(String(g2.body.accountId))!, [{ publicKey: newKey(), permission: { receiverId: HOUSE, methodNames: [] } }]);
  const clash = await handleGuestCreate(deps, { ip: '198.51.100.3' }, { publicKey: pk2 });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'house_account_clash');
});

// ---------------------------------------------------------------- relay

const GUEST = 'guest-k3y9q2zx.atnx.testnet';
const GUEST_H = 'guest-k3y9q2zx-h.atnx.testnet';

// The real policies and signature check; the chain steps are fakes.
function relayerOver(policies = both) {
  const calls = { send: 0, sent: [] as string[] };
  return {
    calls,
    relayer: {
      check: (b64: string, ctx: { expectedSenderId?: string; expectedPublicKey?: string } = {}) => checkDelegate(b64, policies, { ...ctx, relayerId: 'relayer.atnx.testnet' }),
      async preflight() {},
      async send(c: CheckedDelegate): Promise<RelayResult> {
        calls.send++;
        calls.sent.push(`${c.senderId}:${c.da.receiverId}:${c.methodName}`);
        return { txHash: `TX${calls.send}`, value: c.methodName === 'open' ? '42' : null, events: [] };
      },
    },
  };
}

async function world(policies = both) {
  const guestKey = keySigner();
  const aliceKey = keySigner();
  const guests = memoryNearGuestStore();
  await guests.reserve({ accountId: GUEST, publicKey: (await guestKey.getPublicKey()).toString(), ipHash: 'c'.repeat(64) }, GUEST_CAPS);
  await guests.markActive(GUEST, 'tx');
  const users = memoryNearAccountStore();
  await users.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: (await aliceKey.getPublicKey()).toString() });
  await users.markActive(alice.id, 'alice.atnx.testnet', 'tx');
  const r = relayerOver(policies);
  const deps: RelayDeps = { store: users, guests: { store: guests, parentId: PARENT }, relayer: r.relayer, lock: { waitMs: 0 }, house: { contractId: HOUSE, parentId: PARENT } };
  return { deps, guests, users, guestKey, aliceKey, calls: r.calls };
}

test('relay, house on: a user relays from the house account; the rounds still from the rounds account', async () => {
  const { deps, aliceKey, calls } = await world();
  const r = await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.value, '42');
  const rr = await handleRelay(deps, alice, {
    signedDelegate: await sign(aliceKey, { senderId: 'alice.atnx.testnet', receiverId: ROUNDS, method: 'faucet', args: { amount: '1' }, nonce: 102n }),
  });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.deepEqual(calls.sent, ['alice-h.atnx.testnet:house.atnx.testnet:open', 'alice.atnx.testnet:rounds.atnx.testnet:faucet']);
  // The rounds account cannot send to the house, nor the house account to the rounds.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice.atnx.testnet' }) })).body.error, 'sender_mismatch');
  assert.equal(
    (await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet', receiverId: ROUNDS, method: 'faucet', args: { amount: '1' } }) })).body.error,
    'sender_mismatch',
  );
  // Someone else's house account, or a key that is not on record.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, { senderId: 'bob-h.atnx.testnet' }) })).body.error, 'sender_mismatch');
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(keySigner(), { senderId: 'alice-h.atnx.testnet' }) })).body.error, 'key_mismatch');
  assert.equal(calls.send, 2);
});

test('relay, house off: a delegate to the house is checked as the rounds account and refused', async () => {
  const { deps, aliceKey, calls } = await world([rounds]);
  const off: RelayDeps = { ...deps, house: undefined };
  // From the house account: not the rounds account on record (the sender is
  // checked first, as before).
  const r = await handleRelay(off, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet' }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'sender_mismatch');
  // From the rounds account to the house: no policy names it.
  const r2 = await handleRelay(off, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice.atnx.testnet' }) });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, 'receiver_not_allowed');
  assert.equal(calls.send, 0);
});

test('relay, house on: a guest relays from its house account, without withdraw', async () => {
  const { deps, guestKey, calls } = await world();
  for (const m of HOUSE_GUEST_METHODS) {
    const r = await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: GUEST_H, method: m, args: {}, nonce: 300n }), guest: true });
    assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.body)}`);
  }
  const w = await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: GUEST_H, method: 'withdraw', args: { amount: '1' } }), guest: true });
  assert.equal(w.status, 400);
  assert.equal(w.body.error, 'method_not_allowed');
  // The rounds guest still relays to the rounds.
  const rr = await handleRelay(deps, null, {
    signedDelegate: await sign(guestKey, { senderId: GUEST, receiverId: ROUNDS, method: 'faucet', args: { amount: '1' } }),
    guest: true,
  });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  // A house name that is not a guest's, a guest not on record, the rounds guest name to the house.
  assert.equal((await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: 'alice-h.atnx.testnet' }), guest: true })).body.error, 'not_a_guest');
  assert.equal((await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: 'guest-zzzzzzzz-h.atnx.testnet' }), guest: true })).body.error, 'no_account');
  assert.equal((await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: GUEST }), guest: true })).body.error, 'not_a_guest');
  assert.equal(calls.send, HOUSE_GUEST_METHODS.length + 1);
});

test('relay, house on: one lock per guest for both contracts', async () => {
  const { deps, guests, guestKey } = await world();
  assert.equal(await guests.acquireRelayLock(GUEST, 'held', { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 60 }), 'ok');
  const r = await handleRelay(deps, null, { signedDelegate: await sign(guestKey, { senderId: GUEST_H }), guest: true });
  assert.equal(r.body.error, 'busy');
});

test('relay: afterSend runs once after a successful send, never after a refusal, and cannot fail the relay', async () => {
  const { deps, aliceKey } = await world();
  const seen: Array<[string, unknown]> = [];
  const withHook: RelayDeps = { ...deps, afterSend: (c, r) => void seen.push([c.methodName, r.value]) };
  assert.equal((await handleRelay(withHook, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet' }) })).status, 200);
  assert.deepEqual(seen, [['open', '42']]);
  // Refused before sending: no hook.
  await handleRelay(withHook, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet', method: 'push_quotes', args: {} }) });
  assert.equal(seen.length, 1);
  // A hook that throws.
  const throwing: RelayDeps = {
    ...deps,
    afterSend: () => {
      throw new Error('boom');
    },
  };
  const r = await handleRelay(throwing, alice, { signedDelegate: await sign(aliceKey, { senderId: 'alice-h.atnx.testnet', nonce: 400n }) });
  assert.equal(r.status, 200);
});

test('appCheckByReceiver: one check per contract, by the delegate receiver', async () => {
  const ran: string[] = [];
  const check = appCheckByReceiver({ [ROUNDS]: async () => void ran.push('rounds'), [HOUSE]: async () => void ran.push('house') });
  const s = keySigner();
  await check(await checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet' }), both));
  await check(await checkDelegate(await sign(s, { senderId: 'alice.atnx.testnet', receiverId: ROUNDS, method: 'faucet', args: { amount: '1' } }), both));
  assert.deepEqual(ran, ['house', 'rounds']);
  const onlyRounds = appCheckByReceiver({ [ROUNDS]: async () => {} });
  await rejects(onlyRounds(await checkDelegate(await sign(s, { senderId: 'alice-h.atnx.testnet' }), both)), 'receiver_not_allowed');
  await rejects(appCheckByReceiver({})({ policy: { contractId: 'toString' } } as unknown as CheckedDelegate), 'receiver_not_allowed');
});
