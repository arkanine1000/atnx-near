import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, PublicKey, actions, base64Encode, buildDelegateAction, encodeSignedDelegate, nearToYocto, type Action, type Signer } from 'near-api-js';
import { USER_METHODS } from './config';
import { GUEST_CAPS, GUEST_LOCK, GUEST_METHODS, clientIp, guestAccountId, hashIp, ipBucket, isGuestAccountId } from './guest';
import { checkDelegate, delegateSenderId, roundsRelayPolicy, type CheckedDelegate, type RelayResult } from './relay';
import { handleGuestCreate, handleRelay, type AccountChain, type GuestDeps, type RelayDeps, type RouteUser } from './routes';
import { accountCreationActions } from './server-chain';
import { memoryNearAccountStore, memoryNearGuestStore } from './store';

const PARENT = 'atnx.testnet';
const ROUNDS = 'rounds.atnx.testnet';
const SALT = 'test-salt';
const TGAS = 10n ** 12n;
const newKey = () => KeyPair.fromRandom('ed25519').getPublicKey().toString();
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

// ------------------------------------------------------------ the names

test('guest names: guest-<8 lowercase letters or digits>.<parent>, and only those', () => {
  for (let i = 0; i < 50; i++) {
    const id = guestAccountId(PARENT);
    assert.match(id, /^guest-[0-9a-z]{8}\.atnx\.testnet$/);
    assert.ok(isGuestAccountId(id, PARENT));
  }
  for (const id of ['alice.atnx.testnet', 'guest-abc.atnx.testnet', 'guest-ABCDEFGH.atnx.testnet', 'guest-abcdefgh1.atnx.testnet', 'x.guest-abcdefgh.atnx.testnet', 'guest-abcdefgh.testnet', 'guest-abcdefgh.other.testnet']) {
    assert.ok(!isGuestAccountId(id, PARENT), id);
  }
  // The relayer's sender rule takes them (a direct sub-account of the parent).
  assert.ok(roundsRelayPolicy(ROUNDS, PARENT, USER_METHODS).senderPattern!.test(guestAccountId(PARENT)));
});

// --------------------------------------------------------------- the IP

test('the client IP: x-forwarded-for first entry, else x-real-ip, else none', () => {
  assert.equal(clientIp(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(clientIp(headers({ 'x-forwarded-for': ' 203.0.113.7 ', 'x-real-ip': '198.51.100.1' })), '203.0.113.7');
  assert.equal(clientIp(headers({ 'x-real-ip': '198.51.100.1' })), '198.51.100.1');
  assert.equal(clientIp(headers({ 'x-forwarded-for': 'garbage', 'x-real-ip': '198.51.100.1' })), '198.51.100.1');
  assert.equal(clientIp(headers({ 'x-forwarded-for': '203.0.113.7:51234' })), '203.0.113.7');
  assert.equal(clientIp(headers({ 'x-forwarded-for': '[2001:db8::1]:443' })), '2001:db8::1');
  assert.equal(clientIp(headers({ 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' })), '2001:db8:1:2:3:4:5:6');
  assert.equal(clientIp(headers({})), null);
  assert.equal(clientIp(headers({ 'x-forwarded-for': '', 'x-real-ip': 'nope' })), null);
  assert.equal(clientIp(headers({ 'x-forwarded-for': '999.1.1.1' })), null);
});

test('IP buckets: IPv4 as it is, IPv6 by its /64, mapped IPv4 as IPv4, the rest "unknown"', () => {
  assert.equal(ipBucket('203.0.113.7'), 'v4:203.0.113.7');
  assert.equal(ipBucket('2001:db8:aa:bb:1:2:3:4'), 'v6:2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:DB8:AA:BB::9'), 'v6:2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8::1'), 'v6:2001:db8:0:0::/64');
  assert.equal(ipBucket('::ffff:203.0.113.7'), 'v4:203.0.113.7');
  assert.equal(ipBucket('::1'), 'v6:0:0:0:0::/64');
  assert.equal(ipBucket(null), 'unknown');
  assert.equal(ipBucket('not an ip'), 'unknown');
  assert.equal(ipBucket('1:2:3:4:5:6:7:8:9'), 'unknown');
  assert.equal(ipBucket('1::2::3'), 'unknown');
});

test('IP hashes: salted, stable, 64 hex, never the IP; one /64 is one hash', async () => {
  const a = await hashIp(SALT, '203.0.113.7');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashIp(SALT, '203.0.113.7'));
  assert.notEqual(a, await hashIp('another-salt', '203.0.113.7'));
  assert.notEqual(a, await hashIp(SALT, '203.0.113.8'));
  assert.ok(!a.includes('203'));
  assert.equal(await hashIp(SALT, '2001:db8:aa:bb::1'), await hashIp(SALT, '2001:db8:aa:bb:ffff::2'));
  assert.notEqual(await hashIp(SALT, '2001:db8:aa:bb::1'), await hashIp(SALT, '2001:db8:aa:bc::1'));
  // No address at all is one shared bucket.
  assert.equal(await hashIp(SALT, null), await hashIp(SALT, 'garbage'));
  await assert.rejects(hashIp('', '203.0.113.7'));
});

// ------------------------------------------------------------ the route

function fakeChain(opts: { existing?: string[]; failCreate?: boolean | 'landed' } = {}) {
  const accounts = new Map<string, Set<string>>((opts.existing ?? []).map((a) => [a, new Set<string>()]));
  const created: Array<{ accountId: string; publicKey: string }> = [];
  const chain: AccountChain = {
    async accountExists(id) {
      return accounts.has(id);
    },
    async hasKey(id, pk) {
      return accounts.get(id)?.has(pk) ?? false;
    },
    async createAccount({ accountId, publicKey }) {
      if (opts.failCreate === true) throw new Error('rpc timeout');
      if (accounts.has(accountId)) throw new Error('account already exists');
      accounts.set(accountId, new Set([publicKey]));
      created.push({ accountId, publicKey });
      if (opts.failCreate === 'landed') throw new Error('timeout after send');
      return { txHash: `tx-${accountId}` };
    },
  };
  return { chain, accounts, created };
}

function guestDeps(over: Partial<GuestDeps> = {}, now?: () => number) {
  const fc = fakeChain();
  const store = memoryNearGuestStore({ now });
  const deps: GuestDeps = { store, chain: fc.chain, parentId: PARENT, hashIp: (ip) => hashIp(SALT, ip), now, ...over };
  return { deps, store, ...fc };
}

const IP = { ip: '203.0.113.7' };

test('guest: a new key makes guest-<8>.<parent> with that key, once', async () => {
  const { deps, created, store } = guestDeps();
  const pk = newKey();
  const r = await handleGuestCreate(deps, IP, { publicKey: pk });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(String(r.body.accountId), /^guest-[0-9a-z]{8}\.atnx\.testnet$/);
  assert.equal(r.body.publicKey, pk);
  assert.equal(r.body.state, 'active');
  assert.equal(r.body.guest, true);
  assert.equal(r.body.txHash, `tx-${r.body.accountId}`);
  // The parent was asked for exactly this account with exactly this key.
  assert.deepEqual(created, [{ accountId: r.body.accountId, publicKey: pk }]);
  // The row holds a 64-hex hash of the IP, never the IP.
  const row = store.rows.get(String(r.body.accountId))!;
  assert.equal(row.ipHash, await hashIp(SALT, IP.ip));
  assert.ok(!JSON.stringify([...store.rows.values()]).includes('203.0.113.7'));

  const again = await handleGuestCreate(deps, { ip: '198.51.100.9' }, { publicKey: pk });
  assert.equal(again.status, 200);
  assert.equal(again.body.accountId, r.body.accountId);
  assert.equal(again.body.created, false);
  assert.equal(created.length, 1);
});

test('guest: a bad key is refused, nothing written', async () => {
  const { deps, store, created } = guestDeps();
  for (const publicKey of [undefined, 'nope', 'ed25519:', 42, `ed25519:${'1'.repeat(200)}`]) {
    const r = await handleGuestCreate(deps, IP, { publicKey });
    assert.equal(r.status, 400, String(publicKey));
    assert.equal(r.body.error, 'bad_public_key');
  }
  assert.equal((await handleGuestCreate(deps, IP, null)).status, 400);
  assert.equal(store.rows.size, 0);
  assert.equal(created.length, 0);
});

test('guest caps: GUEST_CAPS.perIp per IP per hour, then 429; another IP is unaffected; the hour passes', async () => {
  let t = 10_000_000;
  const { deps } = guestDeps({}, () => t);
  for (let i = 0; i < GUEST_CAPS.perIp; i++) assert.equal((await handleGuestCreate(deps, IP, { publicKey: newKey() })).status, 201);
  const over = await handleGuestCreate(deps, IP, { publicKey: newKey() });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'guest_limit_ip');
  // The same address again.
  assert.equal((await handleGuestCreate(deps, { ip: '203.0.113.7' }, { publicKey: newKey() })).body.error, 'guest_limit_ip');
  assert.equal((await handleGuestCreate(deps, { ip: '203.0.113.8' }, { publicKey: newKey() })).status, 201);
  t += 3_600_001;
  assert.equal((await handleGuestCreate(deps, IP, { publicKey: newKey() })).status, 201);
});

test('guest caps: one IPv6 /64 is one client; no address is one shared bucket', async () => {
  const { deps } = guestDeps();
  for (let i = 1; i <= GUEST_CAPS.perIp; i++) assert.equal((await handleGuestCreate(deps, { ip: `2001:db8:aa:bb::${i}` }, { publicKey: newKey() })).status, 201);
  assert.equal((await handleGuestCreate(deps, { ip: '2001:db8:aa:bb:ffff:ffff:ffff:ffff' }, { publicKey: newKey() })).body.error, 'guest_limit_ip');
  for (let i = 0; i < GUEST_CAPS.perIp; i++) assert.equal((await handleGuestCreate(deps, { ip: null }, { publicKey: newKey() })).status, 201);
  assert.equal((await handleGuestCreate(deps, { ip: null }, { publicKey: newKey() })).body.error, 'guest_limit_ip');
});

test('guest caps: the overall day cap, whatever the IP, over a rolling 24 hours', async () => {
  let t = 50_000_000;
  const { deps } = guestDeps({ caps: { perDay: 5 } }, () => t);
  for (let i = 0; i < 5; i++) assert.equal((await handleGuestCreate(deps, { ip: `198.51.100.${i}` }, { publicKey: newKey() })).status, 201);
  const sixth = await handleGuestCreate(deps, { ip: '198.51.100.99' }, { publicKey: newKey() });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'guest_limit_day');
  t += 86_400_001;
  assert.equal((await handleGuestCreate(deps, { ip: '198.51.100.99' }, { publicKey: newKey() })).status, 201);
  // The defaults: 10 per IP an hour, 300 a day.
  assert.equal(GUEST_CAPS.perDay, 300);
  assert.equal(GUEST_CAPS.perIp, 10);
  assert.equal(GUEST_CAPS.ipWindowSecs, 3_600);
});

test('guest: below the relayer or parent floor, nothing is made', async () => {
  const { deps, store, created } = guestDeps({ hasFunds: async () => false });
  const r = await handleGuestCreate(deps, IP, { publicKey: newKey() });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'relayer_empty');
  assert.equal(store.rows.size, 0);
  assert.equal(created.length, 0);
});

test('guest: a failed creation is kept as failed, counts against the cap, and spends the key', async () => {
  const fc = fakeChain({ failCreate: true });
  const store = memoryNearGuestStore();
  const deps: GuestDeps = { store, chain: fc.chain, parentId: PARENT, hashIp: (ip) => hashIp(SALT, ip) };
  const pk = newKey();
  const r = await handleGuestCreate(deps, IP, { publicKey: pk });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'create_failed');
  assert.equal([...store.rows.values()][0].state, 'failed');
  assert.equal((await handleGuestCreate(deps, IP, { publicKey: pk })).body.error, 'key_used');
  // The failed one counts: GUEST_CAPS.perIp − 1 more fill the hour.
  for (let i = 1; i < GUEST_CAPS.perIp; i++) await handleGuestCreate(deps, IP, { publicKey: newKey() });
  assert.equal((await handleGuestCreate({ ...deps, chain: fakeChain().chain }, IP, { publicKey: newKey() })).body.error, 'guest_limit_ip');
});

test('guest: a send that timed out after landing counts; an abandoned creation is finished or sent again', async () => {
  const landed = fakeChain({ failCreate: 'landed' });
  const r = await handleGuestCreate({ store: memoryNearGuestStore(), chain: landed.chain, parentId: PARENT, hashIp: (ip) => hashIp(SALT, ip) }, IP, { publicKey: newKey() });
  assert.equal(r.status, 201);
  assert.equal(r.body.txHash, null);

  let t = 1_000_000;
  const now = () => t;
  const store = memoryNearGuestStore({ now });
  const fc = fakeChain();
  const deps: GuestDeps = { store, chain: fc.chain, parentId: PARENT, hashIp: (ip) => hashIp(SALT, ip), now };
  const pk = newKey();
  assert.equal(await store.reserve({ accountId: 'guest-aaaaaaaa.atnx.testnet', publicKey: pk, ipHash: 'a'.repeat(64) }, GUEST_CAPS), 'ok');
  assert.equal((await handleGuestCreate(deps, IP, { publicKey: pk })).body.error, 'in_progress');
  t += 180_000;
  // Never landed: sent again for the same account.
  const again = await handleGuestCreate(deps, IP, { publicKey: pk });
  assert.equal(again.status, 201);
  assert.equal(again.body.accountId, 'guest-aaaaaaaa.atnx.testnet');
  assert.equal(fc.created.length, 1);

  // Landed, row left behind: finished without a second creation.
  const pk2 = newKey();
  await store.reserve({ accountId: 'guest-bbbbbbbb.atnx.testnet', publicKey: pk2, ipHash: 'b'.repeat(64) }, GUEST_CAPS);
  fc.accounts.set('guest-bbbbbbbb.atnx.testnet', new Set([pk2]));
  t += 180_000;
  const done = await handleGuestCreate(deps, IP, { publicKey: pk2 });
  assert.equal(done.status, 200);
  assert.equal(fc.created.length, 1);
  assert.equal(store.rows.get('guest-bbbbbbbb.atnx.testnet')?.state, 'active');
});

test('guest: a name already on chain is skipped', async () => {
  // rand gives the same bytes twice, then others: the first name exists.
  let call = 0;
  const rand = (n: number) => new Uint8Array(n).fill(call++ < 1 ? 0 : 1);
  const fc = fakeChain({ existing: ['guest-00000000.atnx.testnet'] });
  const r = await handleGuestCreate({ store: memoryNearGuestStore(), chain: fc.chain, parentId: PARENT, hashIp: (ip) => hashIp(SALT, ip), rand }, IP, { publicKey: newKey() });
  assert.equal(r.status, 201);
  assert.equal(r.body.accountId, 'guest-11111111.atnx.testnet');
});

test('guest store: hashes are cleared once no cap needs them', async () => {
  let t = 0;
  const store = memoryNearGuestStore({ now: () => t });
  await store.reserve({ accountId: 'guest-aaaaaaaa.atnx.testnet', publicKey: newKey(), ipHash: 'a'.repeat(64) }, GUEST_CAPS);
  t += 86_400_001;
  await store.reserve({ accountId: 'guest-bbbbbbbb.atnx.testnet', publicKey: newKey(), ipHash: 'b'.repeat(64) }, GUEST_CAPS);
  assert.equal(store.rows.get('guest-aaaaaaaa.atnx.testnet')?.ipHash, null);
  assert.equal(store.rows.get('guest-bbbbbbbb.atnx.testnet')?.ipHash, 'b'.repeat(64));
});

// ------------------------------------------------------------- key scope

test('key scope: CreateAccount plus one function-call key for the rounds contract and the user methods, no NEAR', () => {
  const pk = newKey();
  const acts = accountCreationActions(pk, ROUNDS) as unknown as Array<Record<string, unknown>>;
  assert.equal(acts.length, 2);
  assert.ok('createAccount' in acts[0]);
  const addKey = acts[1].addKey as { publicKey: { ed25519Key: { data: Uint8Array } }; accessKey: { permission: Record<string, unknown> } };
  assert.ok(addKey, 'the second action adds the key');
  assert.deepEqual(Uint8Array.from(addKey.publicKey.ed25519Key.data), Uint8Array.from(PublicKey.from(pk).data), 'the browser key, as given');
  assert.ok(!('fullAccess' in addKey.accessKey.permission), 'not a full-access key');
  const fc = addKey.accessKey.permission.functionCall as { receiverId: string; methodNames: string[]; allowance: bigint };
  assert.equal(fc.receiverId, ROUNDS);
  assert.deepEqual([...fc.methodNames].sort(), [...USER_METHODS].sort());
  assert.equal(fc.allowance, nearToYocto('0.25'));
  assert.ok(!acts.some((a) => 'transfer' in a), 'no NEAR is sent');
});

// ------------------------------------------------------- the relay branch

const policy = roundsRelayPolicy(ROUNDS, PARENT, USER_METHODS);

async function sign(signer: Signer, senderId: string, method = 'commit', args: Record<string, unknown> = { series_id: 1, round_index: 2, side: 'Up', amount: '25000000' }, nonce = 101n): Promise<string> {
  const da = buildDelegateAction({
    senderId,
    receiverId: ROUNDS,
    actions: [actions.functionCall(method, args, 30n * TGAS, 0n)] as Action[],
    nonce,
    maxBlockHeight: 1_200n,
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(da);
  return base64Encode(encodeSignedDelegate(signedDelegate));
}

// The real policy and signature check; the chain steps are fakes that count.
function relayer() {
  const calls = { preflight: 0, send: 0, sent: [] as string[] };
  return {
    calls,
    relayer: {
      check: (b64: string, ctx: { expectedSenderId?: string; expectedPublicKey?: string } = {}) => checkDelegate(b64, policy, { ...ctx, relayerId: 'relayer.atnx.testnet' }),
      async preflight() {
        calls.preflight++;
      },
      async send(c: CheckedDelegate): Promise<RelayResult> {
        calls.send++;
        calls.sent.push(`${c.senderId}:${c.methodName}`);
        return { txHash: `TX${calls.send}`, value: null, events: [] };
      },
    },
  };
}

const alice: RouteUser = { id: '00000000-0000-4000-8000-00000000000a' };
const GUEST = 'guest-k3y9q2zx.atnx.testnet';

async function world() {
  const guestKey = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  const aliceKey = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  const guests = memoryNearGuestStore();
  await guests.reserve({ accountId: GUEST, publicKey: (await guestKey.getPublicKey()).toString(), ipHash: 'c'.repeat(64) }, GUEST_CAPS);
  await guests.markActive(GUEST, 'tx');
  const users = memoryNearAccountStore();
  await users.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: (await aliceKey.getPublicKey()).toString() });
  await users.markActive(alice.id, 'alice.atnx.testnet', 'tx');
  const r = relayer();
  const deps: RelayDeps = { store: users, guests: { store: guests, parentId: PARENT }, relayer: r.relayer, lock: { waitMs: 0 } };
  return { deps, guests, users, guestKey, aliceKey, calls: r.calls };
}

test('relay, guest: an active guest relays with no session, through every check', async () => {
  const { deps, guestKey, calls } = await world();
  const checked: string[] = [];
  const r = await handleRelay({ ...deps, appCheck: async (c) => void checked.push(c.methodName) }, null, { signedDelegate: await sign(guestKey, GUEST), guest: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.method, 'commit');
  assert.deepEqual(checked, ['commit'], 'the rounds checks ran');
  assert.equal(calls.preflight, 1, 'the chain checks ran');
  assert.deepEqual(calls.sent, [`${GUEST}:commit`]);
  // A session on the request changes nothing on the guest branch.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(guestKey, GUEST, 'faucet', { amount: '1000000000' }, 102n), guest: true })).status, 200);
  for (const m of GUEST_METHODS) {
    const args = m === 'faucet' ? { amount: '1' } : { series_id: 1, round_index: 1 };
    assert.equal((await handleRelay(deps, null, { signedDelegate: await sign(guestKey, GUEST, m, args, 200n), guest: true })).status, 200, m);
  }
});

test('relay, guest: refused before sending', async () => {
  const { deps, guests, guestKey, aliceKey, calls } = await world();
  const refuse = async (body: unknown, status: number, error: string) => {
    const r = await handleRelay(deps, null, body);
    assert.equal(r.status, status, `${error}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error);
  };
  // Not a guest: a user's account, even signed by its own key.
  await refuse({ signedDelegate: await sign(aliceKey, 'alice.atnx.testnet'), guest: true }, 403, 'not_a_guest');
  // Guest-shaped but not on record, or signed by a key that is not the one on record.
  await refuse({ signedDelegate: await sign(guestKey, 'guest-zzzzzzzz.atnx.testnet'), guest: true }, 409, 'no_account');
  await refuse({ signedDelegate: await sign(aliceKey, GUEST), guest: true }, 400, 'key_mismatch');
  // withdraw is a user method, but not a guest's.
  await refuse({ signedDelegate: await sign(guestKey, GUEST, 'withdraw', { amount: '1' }), guest: true }, 400, 'method_not_allowed');
  // Garbage.
  await refuse({ signedDelegate: 'AAAA', guest: true }, 400, 'malformed');
  await refuse({ guest: true }, 400, 'bad_request');
  // A guest still being created, or whose creation failed.
  const pk = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  await guests.reserve({ accountId: 'guest-pending1.atnx.testnet', publicKey: (await pk.getPublicKey()).toString(), ipHash: 'd'.repeat(64) }, GUEST_CAPS);
  await refuse({ signedDelegate: await sign(pk, 'guest-pending1.atnx.testnet'), guest: true }, 409, 'no_account');
  // Without a guest store, the branch is off.
  const off = await handleRelay({ ...deps, guests: undefined }, null, { signedDelegate: await sign(guestKey, GUEST), guest: true });
  assert.equal(off.body.error, 'guests_off');
  assert.equal(calls.send, 0, 'nothing was sent');
});

test('relay, guest: never crosses with a user', async () => {
  const { deps, guestKey, aliceKey, calls } = await world();
  // A guest's delegate on the user branch: no session is signed_out...
  assert.equal((await handleRelay(deps, null, { signedDelegate: await sign(guestKey, GUEST) })).body.error, 'signed_out');
  // ...and with Alice's session it is not Alice's account.
  const asAlice = await handleRelay(deps, alice, { signedDelegate: await sign(guestKey, GUEST) });
  assert.equal(asAlice.status, 400);
  assert.equal(asAlice.body.error, 'sender_mismatch');
  // Alice's own delegate on the guest branch is refused, session or not.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, 'alice.atnx.testnet'), guest: true })).body.error, 'not_a_guest');
  // A guest-named delegate signed with Alice's key on Alice's branch.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, GUEST) })).body.error, 'sender_mismatch');
  assert.equal(calls.send, 0);
  // Alice's path is as before.
  assert.equal((await handleRelay(deps, alice, { signedDelegate: await sign(aliceKey, 'alice.atnx.testnet') })).status, 200);
  assert.deepEqual(calls.sent, ['alice.atnx.testnet:commit']);
});

test('relay, guest: its own lock and a cap of 60 an hour, apart from the users', async () => {
  const { deps, guests, users, guestKey, aliceKey } = await world();
  const timed: RelayDeps = deps;
  assert.equal(GUEST_LOCK.maxPerWindow, 60);
  // A guest holding its lock is busy for itself only.
  assert.equal(await guests.acquireRelayLock(GUEST, 'held', GUEST_LOCK), 'ok');
  assert.equal((await handleRelay(timed, null, { signedDelegate: await sign(guestKey, GUEST), guest: true })).body.error, 'busy');
  assert.equal((await handleRelay(timed, alice, { signedDelegate: await sign(aliceKey, 'alice.atnx.testnet') })).status, 200);
  await guests.releaseRelayLock(GUEST, 'held');
  // The hourly cap (3 here) counts the guest's relays only.
  const capped: RelayDeps = { ...timed, guests: { store: guests, parentId: PARENT, lock: { maxPerWindow: 3 } } };
  // The held lock above already counted once.
  assert.equal((await handleRelay(capped, null, { signedDelegate: await sign(guestKey, GUEST), guest: true })).status, 200);
  assert.equal((await handleRelay(capped, null, { signedDelegate: await sign(guestKey, GUEST), guest: true })).status, 200);
  const over = await handleRelay(capped, null, { signedDelegate: await sign(guestKey, GUEST), guest: true });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'rate_limited');
  assert.equal(await users.acquireRelayLock(alice.id, 'x', { ttlSecs: 1, windowSecs: 3600, maxPerWindow: 200 }), 'ok', 'Alice is not counted');
});

test('relay: the sender peek reads the delegate and nothing else', async () => {
  const k = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  assert.equal(delegateSenderId(await sign(k, GUEST)), GUEST);
  assert.equal(delegateSenderId('not base64 at all'), null);
  assert.equal(delegateSenderId(''), null);
  assert.equal(delegateSenderId('A'.repeat(20_000)), null);
});
