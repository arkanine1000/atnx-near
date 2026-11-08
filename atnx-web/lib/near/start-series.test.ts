import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StartResult } from '@/lib/bm/rounds-core';
import type { BmSeriesRow } from '@/lib/supabase/database-bm';
import { START_ERRORS, startNearSeriesForSession, type NearStartDeps } from './start-series';
import { memoryNearAccountStore } from './store';

// The NEAR "Start rounds" action's logic against the in-memory account
// store and a fake start: who may start, which account becomes the finder,
// what the user reads when it fails, and what is revalidated.

const MARKET = '00000000-0000-4000-8000-0000000000aa';
const alice = { id: '00000000-0000-4000-8000-00000000000a' };
const bob = { id: '00000000-0000-4000-8000-00000000000b' };
const PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

type StartInput = Parameters<NearStartDeps['start']>[0];

function harness(opts: { user?: { id: string } | null; result?: StartResult | Error; enabled?: boolean } = {}) {
  const store = memoryNearAccountStore();
  const starts: StartInput[] = [];
  const revalidated: string[] = [];
  let sessionReads = 0;
  const deps: NearStartDeps = {
    enabled: opts.enabled ?? true,
    sessionUser: async () => {
      sessionReads++;
      return opts.user === undefined ? alice : opts.user;
    },
    store,
    start: async (input) => {
      starts.push(input);
      const r = opts.result ?? { ok: true, series: { id: 's1' } as BmSeriesRow, round: null };
      if (r instanceof Error) throw r;
      return r;
    },
    revalidate: (path) => {
      revalidated.push(path);
    },
  };
  return { deps, store, starts, revalidated, sessionReads: () => sessionReads };
}

async function activeAccount(store: ReturnType<typeof memoryNearAccountStore>, userId: string, accountId: string) {
  assert.equal(await store.insertCreating({ userId, accountId, publicKey: PK }), 'ok');
  assert.equal(await store.markActive(userId, accountId, 'tx-create'), true);
}

test('start: no session is a sign-in, and nothing is read or started', async () => {
  const h = harness({ user: null });
  await activeAccount(h.store, alice.id, 'alice.atnx.testnet');
  const r = await startNearSeriesForSession(h.deps, MARKET, false);
  assert.deepEqual(r, { ok: false, code: 'signed_out', error: START_ERRORS.signed_out });
  assert.equal(h.starts.length, 0);
  assert.deepEqual(h.revalidated, []);
});

test('start: a signed-in user without an account, or with one still being set up', async () => {
  const none = harness();
  assert.deepEqual(await startNearSeriesForSession(none.deps, MARKET, false), { ok: false, code: 'no_account', error: START_ERRORS.no_account });
  assert.equal(none.starts.length, 0);

  // Another user's active account is not this user's.
  await activeAccount(none.store, bob.id, 'bob.atnx.testnet');
  assert.equal((await startNearSeriesForSession(none.deps, MARKET, false)).ok, false);
  assert.equal(none.starts.length, 0);

  const creating = harness();
  assert.equal(await creating.store.insertCreating({ userId: alice.id, accountId: 'alice.atnx.testnet', publicKey: PK }), 'ok');
  assert.deepEqual(await startNearSeriesForSession(creating.deps, MARKET, false), {
    ok: false,
    code: 'account_creating',
    error: START_ERRORS.account_creating,
  });
  assert.equal(creating.starts.length, 0);
  assert.deepEqual(creating.revalidated, []);
});

test("start: the finder is the session user's active account; the market page and the list are revalidated", async () => {
  const h = harness();
  await activeAccount(h.store, alice.id, 'alice.atnx.testnet');
  await activeAccount(h.store, bob.id, 'bob.atnx.testnet');
  const r = await startNearSeriesForSession(h.deps, MARKET, false);
  // Only what the ticket needs goes back: no registry rows.
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(h.starts, [{ marketId: MARKET, finder: 'alice.atnx.testnet', fast: false }]);
  assert.deepEqual(h.revalidated, [`/app/markets/${MARKET}`, '/app']);

  // `fast` is passed on only as a real true (startNearSeries then applies
  // the site's fast-series rule).
  await startNearSeriesForSession(h.deps, MARKET, true);
  await startNearSeriesForSession(h.deps, MARKET, 'true');
  assert.deepEqual(
    h.starts.slice(1).map((s) => s.fast),
    [true, false]
  );
});

test('start: an account set up again uses the current account, not a previous one', async () => {
  const h = harness();
  await activeAccount(h.store, alice.id, 'alice.atnx.testnet');
  const row = (await h.store.getByUser(alice.id))!;
  assert.equal(await h.store.replaceIfUnchanged(row, { accountId: 'alice1.atnx.testnet', publicKey: PK }), 'ok');
  // Mid set-up: the old account is no longer the user's.
  assert.equal((await startNearSeriesForSession(h.deps, MARKET, false)).ok, false);
  assert.equal(await h.store.markActive(alice.id, 'alice1.atnx.testnet', null), true);
  assert.deepEqual(await startNearSeriesForSession(h.deps, MARKET, false), { ok: true });
  assert.deepEqual(h.starts.map((s) => s.finder), ['alice1.atnx.testnet']);
});

test('start: what startNearSeries refuses reads as plain sentences', async () => {
  const cases: Array<[StartResult, { code: string; error: string }]> = [
    // The market and index messages are the Solana start's own.
    [{ ok: false, code: 'already_active', error: 'Rounds are already running on this market' }, { code: 'already_active', error: 'Rounds are already running on this market' }],
    [{ ok: false, code: 'stale_vi', error: 'The VI has not been updated for over 30 minutes' }, { code: 'stale_vi', error: 'The VI has not been updated for over 30 minutes' }],
    [{ ok: false, code: 'scoring', error: 'Market is still being scored' }, { code: 'scoring', error: 'Market is still being scored' }],
    [{ ok: false, code: 'no_vi', error: 'Market has no score yet' }, { code: 'no_vi', error: 'Market has no score yet' }],
    [{ ok: false, code: 'not_found', error: 'Market not found' }, { code: 'not_found', error: 'Market not found' }],
    // What the chain or the send said is not shown.
    [{ ok: false, code: 'tx', error: 'Error: Transaction 7xYz failed: Exceeded the prepaid gas' }, { code: 'tx', error: START_ERRORS.tx }],
    [{ ok: false, code: 'chain', error: 'this series reference belongs to an ended series on chain' }, { code: 'chain', error: START_ERRORS.tx }],
    [{ ok: false, code: 'chain', error: 'bad wallet' }, { code: 'chain', error: START_ERRORS.bad_account }],
    [{ ok: false, code: 'chain', error: 'Rounds are not live on NEAR testnet yet' }, { code: 'not_live', error: START_ERRORS.not_live }],
  ];
  for (const [result, want] of cases) {
    const h = harness({ result });
    await activeAccount(h.store, alice.id, 'alice.atnx.testnet');
    const r = await startNearSeriesForSession(h.deps, MARKET, false);
    assert.deepEqual(r, { ok: false, ...want }, result.ok ? '' : result.error);
    assert.deepEqual(h.revalidated, [], 'nothing is revalidated on a failure');
  }
});

test('start: a throw from the start, the session or the account table is one plain sentence', async () => {
  const thrown = harness({ result: new Error('relation "bm.series" does not exist') });
  await activeAccount(thrown.store, alice.id, 'alice.atnx.testnet');
  assert.deepEqual(await startNearSeriesForSession(thrown.deps, MARKET, false), { ok: false, code: 'server', error: START_ERRORS.server });
  assert.deepEqual(thrown.revalidated, []);

  const session = harness();
  session.deps.sessionUser = async () => {
    throw new Error('auth down');
  };
  assert.deepEqual(await startNearSeriesForSession(session.deps, MARKET, false), { ok: false, code: 'server', error: START_ERRORS.server });

  // bm.near_accounts missing (004 not applied).
  const table = harness();
  table.deps.store = {
    getByUser: async () => {
      throw Object.assign(new Error('relation "bm.near_accounts" does not exist'), { code: '42P01' });
    },
  };
  assert.deepEqual(await startNearSeriesForSession(table.deps, MARKET, false), { ok: false, code: 'server', error: START_ERRORS.server });
  assert.equal(table.starts.length, 0);
});

test('start: a bad market id, or a site that does not trade NEAR, starts nothing and reads no session', async () => {
  for (const id of [undefined, 42, 'nope', `${MARKET}/../x`, '']) {
    const h = harness();
    await activeAccount(h.store, alice.id, 'alice.atnx.testnet');
    assert.deepEqual(await startNearSeriesForSession(h.deps, id, false), { ok: false, code: 'not_found', error: 'Bad request' }, String(id));
    assert.equal(h.sessionReads(), 0);
    assert.equal(h.starts.length, 0);
  }
  const solana = harness({ enabled: false });
  await activeAccount(solana.store, alice.id, 'alice.atnx.testnet');
  assert.deepEqual(await startNearSeriesForSession(solana.deps, MARKET, false), { ok: false, code: 'not_live', error: START_ERRORS.not_live });
  assert.equal(solana.sessionReads(), 0);
  assert.equal(solana.starts.length, 0);
});
