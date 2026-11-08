import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { handleAccountCreate, handleAccountGet, handleRelay, type AccountChain, type AccountDeps, type RelayDeps, type RouteUser } from './routes';
import { memoryNearAccountStore } from './store';
import { RelayFailed, RelayRejected, type CheckedDelegate, type RelayResult } from './relay';

const PARENT = 'atnx.testnet';
const alice: RouteUser = { id: '00000000-0000-4000-8000-00000000000a', username: 'Alice', handle: 'Attn_seeker#1111' };
const bob: RouteUser = { id: '00000000-0000-4000-8000-00000000000b', username: null, handle: 'Attn_seeker#2222' };
const newKey = () => KeyPair.fromRandom('ed25519').getPublicKey().toString();

// A chain that records what the parent created.
function fakeChain(opts: { existing?: string[]; failCreate?: boolean | 'landed' } = {}) {
  const accounts = new Map<string, Set<string>>((opts.existing ?? []).map((a) => [a, new Set<string>()]));
  const created: string[] = [];
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
      created.push(accountId);
      if (opts.failCreate === 'landed') throw new Error('timeout after send');
      return { txHash: `tx-${accountId}` };
    },
  };
  return { chain, accounts, created };
}

function accountDeps(over: Partial<AccountDeps> & { now?: () => number } = {}) {
  const fc = fakeChain();
  const deps: AccountDeps = { store: memoryNearAccountStore({ now: over.now }), chain: fc.chain, parentId: PARENT, ...over };
  return { deps, ...fc };
}

test('account: signed out, bad key', async () => {
  const { deps } = accountDeps();
  assert.equal((await handleAccountGet(deps, null)).status, 401);
  assert.equal((await handleAccountCreate(deps, null, { publicKey: newKey() })).status, 401);
  for (const publicKey of [undefined, 'nope', 'ed25519:', 'secp256k1:abc', 42, `ed25519:${'1'.repeat(200)}`]) {
    const r = await handleAccountCreate(deps, alice, { publicKey });
    assert.equal(r.status, 400, String(publicKey));
    assert.equal(r.body.error, 'bad_public_key');
  }
});

test('account: first sign-in creates <handle>.<parent>, the second call is idempotent', async () => {
  const { deps, created } = accountDeps();
  assert.deepEqual((await handleAccountGet(deps, alice)).body, { accountId: null });
  const pk = newKey();
  const r = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(r.status, 201);
  assert.equal(r.body.accountId, 'alice.atnx.testnet');
  assert.equal(r.body.publicKey, pk);
  assert.equal(r.body.state, 'active');
  assert.equal(r.body.txHash, 'tx-alice.atnx.testnet');
  assert.deepEqual(created, ['alice.atnx.testnet']);

  const again = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(created.length, 1);
  assert.equal((await handleAccountGet(deps, alice)).body.accountId, 'alice.atnx.testnet');
});

test('account: a taken name, in the registry or only on chain, gets a suffix', async () => {
  const fc = fakeChain({ existing: ['attn_seeker-2222.atnx.testnet'] });
  const deps: AccountDeps = { store: memoryNearAccountStore(), chain: fc.chain, parentId: PARENT };
  const r = await handleAccountCreate(deps, bob, { publicKey: newKey() });
  assert.equal(r.status, 201);
  assert.match(String(r.body.accountId), /^attn_seeker-2222-[0-9a-z]{4}\.atnx\.testnet$/);

  // Carol's username sanitises to the name Alice already holds in the registry.
  await handleAccountCreate(deps, alice, { publicKey: newKey() });
  const carol: RouteUser = { id: '00000000-0000-4000-8000-00000000000c', username: 'ALICE' };
  const c = await handleAccountCreate(deps, carol, { publicKey: newKey() });
  assert.equal(c.status, 201);
  assert.match(String(c.body.accountId), /^alice-[0-9a-z]{4}\.atnx\.testnet$/);
});

test('account: a user with no usable name gets a random handle', async () => {
  const { deps } = accountDeps();
  const r = await handleAccountCreate(deps, { id: '00000000-0000-4000-8000-00000000000d', username: '🚀', handle: null }, { publicKey: newKey() });
  assert.equal(r.status, 201);
  assert.match(String(r.body.accountId), /^u[0-9a-z]{7}\.atnx\.testnet$/);
});

test('account: another browser key needs fresh; fresh makes a new account and keeps the old id', async () => {
  const { deps, created } = accountDeps();
  const first = await handleAccountCreate(deps, alice, { publicKey: newKey() });
  const pk2 = newKey();
  const other = await handleAccountCreate(deps, alice, { publicKey: pk2 });
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'other_key');
  assert.equal(other.body.accountId, first.body.accountId);

  const fresh = await handleAccountCreate(deps, alice, { publicKey: pk2, fresh: true });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.accountId, first.body.accountId);
  assert.match(String(fresh.body.accountId), /^alice-[0-9a-z]{4}\.atnx\.testnet$/);
  assert.deepEqual(fresh.body.previousAccountIds, ['alice.atnx.testnet']);
  assert.equal(created.length, 2);
  // The relay now expects the new account.
  assert.equal((await handleAccountGet(deps, alice)).body.accountId, fresh.body.accountId);
});

test('account: the number of fresh starts is capped', async () => {
  const { deps } = accountDeps({ maxAccountsPerUser: 3 });
  await handleAccountCreate(deps, alice, { publicKey: newKey() });
  assert.equal((await handleAccountCreate(deps, alice, { publicKey: newKey(), fresh: true })).status, 201);
  assert.equal((await handleAccountCreate(deps, alice, { publicKey: newKey(), fresh: true })).status, 201);
  const r = await handleAccountCreate(deps, alice, { publicKey: newKey(), fresh: true });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'account_limit');
});

test('account: a failed creation is rolled back; a fresh start that fails keeps the old account', async () => {
  const fc = fakeChain({ failCreate: true });
  const store = memoryNearAccountStore();
  const deps: AccountDeps = { store, chain: fc.chain, parentId: PARENT };
  const r = await handleAccountCreate(deps, alice, { publicKey: newKey() });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'create_failed');
  assert.equal(await store.getByUser(alice.id), null);

  // With an account in place, a failed fresh start restores it.
  const ok = fakeChain();
  const pk = newKey();
  await handleAccountCreate({ ...deps, chain: ok.chain }, alice, { publicKey: pk });
  const before = await store.getByUser(alice.id);
  const failed = await handleAccountCreate(deps, alice, { publicKey: newKey(), fresh: true });
  assert.equal(failed.status, 502);
  const after = await store.getByUser(alice.id);
  assert.equal(after?.accountId, before?.accountId);
  assert.equal(after?.publicKey, pk);
  assert.equal(after?.state, 'active');
  assert.deepEqual(after?.previousAccountIds, []);
});

test('account: a send that timed out after landing still counts', async () => {
  const fc = fakeChain({ failCreate: 'landed' });
  const deps: AccountDeps = { store: memoryNearAccountStore(), chain: fc.chain, parentId: PARENT };
  const r = await handleAccountCreate(deps, alice, { publicKey: newKey() });
  assert.equal(r.status, 201);
  assert.equal(r.body.txHash, null);
  assert.equal(r.body.state, 'active');
});

test('account: a creation in flight blocks a second one; an abandoned one is picked up', async () => {
  let t = 1_000_000;
  const now = () => t;
  const store = memoryNearAccountStore({ now });
  const fc = fakeChain();
  const deps: AccountDeps = { store, chain: fc.chain, parentId: PARENT, now };
  const pk = newKey();
  assert.equal(await store.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: pk }), 'ok');
  const busy = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'in_progress');

  // Three minutes later, and the chain never got it: create it now.
  t += 180_000;
  const r = await handleAccountCreate(deps, alice, { publicKey: pk });
  assert.equal(r.status, 201);
  assert.equal(r.body.accountId, 'alice.atnx.testnet');

  // Bob's creation landed on chain but the row was never finished.
  const pkB = newKey();
  await store.insertCreating({ userId: bob.id, accountId: 'bobby.atnx.testnet', publicKey: pkB });
  fc.accounts.set('bobby.atnx.testnet', new Set([pkB]));
  t += 180_000;
  const b = await handleAccountCreate(deps, bob, { publicKey: pkB });
  assert.equal(b.status, 200);
  assert.equal(b.body.accountId, 'bobby.atnx.testnet');
  assert.equal(fc.created.length, 1); // nothing new created for Bob
});

// ------------------------------------------------------------------ relay

function fakeChecked(senderId: string, methodName = 'commit'): CheckedDelegate {
  return { senderId, methodName, args: {}, gas: 1n, nonce: 1n, maxBlockHeight: 1n } as unknown as CheckedDelegate;
}

function fakeRelayer(over: { check?: (b64: string, ctx: { expectedSenderId?: string; expectedPublicKey?: string }) => Promise<CheckedDelegate>; send?: () => Promise<RelayResult>; preflight?: () => Promise<void> } = {}) {
  const calls = { check: 0, preflight: 0, send: 0, ctx: [] as Array<{ expectedSenderId?: string; expectedPublicKey?: string }> };
  return {
    calls,
    relayer: {
      async check(b64: string, ctx: { expectedSenderId?: string; expectedPublicKey?: string } = {}) {
        calls.check++;
        calls.ctx.push(ctx);
        if (over.check) return over.check(b64, ctx);
        if (b64 === 'bad') throw new RelayRejected('bad_signature');
        return fakeChecked(ctx.expectedSenderId ?? 'x.atnx.testnet');
      },
      async preflight() {
        calls.preflight++;
        if (over.preflight) return over.preflight();
      },
      async send() {
        calls.send++;
        if (over.send) return over.send();
        return { txHash: 'TXH', value: '1000000000', events: [] };
      },
    },
  };
}

async function withAccount() {
  const store = memoryNearAccountStore();
  const pk = newKey();
  await store.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: pk });
  await store.markActive(alice.id, 'alice.atnx.testnet', 'tx');
  return { store, pk };
}

test('relay: signed out, no account, bad body', async () => {
  const { store } = await withAccount();
  const { relayer } = fakeRelayer();
  const deps: RelayDeps = { store, relayer };
  assert.equal((await handleRelay(deps, null, { signedDelegate: 'x' })).status, 401);
  const nobody = await handleRelay(deps, bob, { signedDelegate: 'x' });
  assert.equal(nobody.status, 409);
  assert.equal(nobody.body.error, 'no_account');
  assert.equal((await handleRelay(deps, alice, {})).status, 400);
  assert.equal((await handleRelay(deps, alice, null)).status, 400);
});

test('relay: the delegate is checked against the mapped account and key, then sent', async () => {
  const { store, pk } = await withAccount();
  const { relayer, calls } = fakeRelayer();
  const checked: string[] = [];
  const r = await handleRelay({ store, relayer, appCheck: async (c) => void checked.push(c.methodName) }, alice, { signedDelegate: 'ok' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { txHash: 'TXH', value: '1000000000', events: [], method: 'commit' });
  assert.deepEqual(calls.ctx[0], { expectedSenderId: 'alice.atnx.testnet', expectedPublicKey: pk });
  assert.deepEqual(checked, ['commit']);
  assert.equal(calls.send, 1);
});

test('relay: a rejection before sending costs nothing and releases the lock', async () => {
  const { store } = await withAccount();
  const bad = await handleRelay({ store, relayer: fakeRelayer().relayer }, alice, { signedDelegate: 'bad' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_signature');

  const { relayer, calls } = fakeRelayer({
    preflight: async () => {
      throw new RelayRejected('stale_nonce', '5 <= 5');
    },
  });
  const stale = await handleRelay({ store, relayer }, alice, { signedDelegate: 'ok' });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error, 'stale_nonce');
  assert.equal(calls.send, 0);

  const wouldFail = await handleRelay(
    {
      store,
      relayer: fakeRelayer().relayer,
      appCheck: async () => {
        throw new RelayRejected('would_fail', "round is not the series' presale round");
      },
    },
    alice,
    { signedDelegate: 'ok' },
  );
  assert.equal(wouldFail.status, 400);
  assert.equal(wouldFail.body.detail, "round is not the series' presale round");

  // The lock was released every time: the next relay goes straight through.
  const ok = await handleRelay({ store, relayer: fakeRelayer().relayer, lock: { waitMs: 0 } }, alice, { signedDelegate: 'ok' });
  assert.equal(ok.status, 200);
});

test('relay: a failure on chain is reported with its hash and message', async () => {
  const { store } = await withAccount();
  const { relayer } = fakeRelayer({
    send: async () => {
      throw new RelayFailed('TXF', {}, 'fewer shares than the minimum you set');
    },
  });
  const r = await handleRelay({ store, relayer }, alice, { signedDelegate: 'ok' });
  assert.equal(r.status, 422);
  assert.deepEqual(r.body, { error: 'failed_on_chain', txHash: 'TXF', message: 'fewer shares than the minimum you set' });
  const crash = await handleRelay({ store, relayer: fakeRelayer({ send: async () => Promise.reject(new Error('socket hang up')) }).relayer }, alice, { signedDelegate: 'ok' });
  assert.equal(crash.status, 502);
});

test('relay: one delegate in flight per user', async () => {
  const { store } = await withAccount();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = fakeRelayer({
    send: async () => {
      await gate;
      return { txHash: 'SLOW', value: null, events: [] };
    },
  });
  const first = handleRelay({ store, relayer: slow.relayer }, alice, { signedDelegate: 'ok' });
  await new Promise((r) => setImmediate(r));
  // A second relay waits for the lock, then gives up.
  let slept = 0;
  const second = await handleRelay(
    { store, relayer: fakeRelayer().relayer, lock: { waitMs: 50, pollMs: 10 }, sleep: async () => void slept++, now: (() => { let t = 0; return () => (t += 10); })() },
    alice,
    { signedDelegate: 'ok' },
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy');
  assert.ok(slept > 0);
  release();
  assert.equal((await first).status, 200);
  // Free again.
  assert.equal((await handleRelay({ store, relayer: fakeRelayer().relayer }, alice, { signedDelegate: 'ok' })).status, 200);
});

test('relay: an expired lock does not block, and the hourly cap holds', async () => {
  let t = 5_000_000;
  const store = memoryNearAccountStore({ now: () => t });
  await store.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: newKey() });
  await store.markActive(alice.id, 'alice.atnx.testnet', null);
  // A crashed relay left the lock behind.
  assert.equal(await store.acquireRelayLock(alice.id, 'dead', { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 3 }), 'ok');
  assert.equal(await store.acquireRelayLock(alice.id, 'live', { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 3 }), 'busy');
  t += 61_000;
  const lock = { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 3, waitMs: 0 };
  assert.equal((await handleRelay({ store, relayer: fakeRelayer().relayer, lock }, alice, { signedDelegate: 'ok' })).status, 200);
  assert.equal((await handleRelay({ store, relayer: fakeRelayer().relayer, lock }, alice, { signedDelegate: 'ok' })).status, 200);
  const capped = await handleRelay({ store, relayer: fakeRelayer().relayer, lock }, alice, { signedDelegate: 'ok' });
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error, 'rate_limited');
  t += 3_600_000;
  assert.equal((await handleRelay({ store, relayer: fakeRelayer().relayer, lock }, alice, { signedDelegate: 'ok' })).status, 200);
});
