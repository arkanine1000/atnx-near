import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database';
import * as rr from './rounds-registry';

// The registry's queries, against a fake Supabase client that records the
// builder calls of each query and answers from a handler. Checks the chain
// filter on every list the keeper works from (in the query, so one chain's
// rows never use up the other's limit) and the NEAR columns of 003_near.sql.

type Call = [string, ...unknown[]];
interface Query {
  table: string;
  calls: Call[];
}

function fake(answer: (q: Query) => { data: unknown; error: unknown } = () => ({ data: [], error: null })) {
  const queries: Query[] = [];
  const builder = (table: string) => {
    const q: Query = { table, calls: [] };
    queries.push(q);
    const b: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve().then(() => answer(q)).then(ok, ko);
          }
          return (...args: unknown[]) => {
            q.calls.push([String(prop), ...args]);
            return b;
          };
        },
      }
    );
    return b;
  };
  const client = { schema: (name: string) => ({ from: (t: string) => builder(`${name}.${t}`) }), from: (t: string) => builder(t) };
  rr.setRegistryClientForTests(client as unknown as SupabaseClient<Database>);
  return queries;
}

const call = (q: Query, name: string) => q.calls.filter((c) => c[0] === name);

const SERIES_NEAR = { id: 's-near', chain: 'near:testnet', state: 'active' };
const ROUND = { id: 'r1', series_id: 's-near', idx: 1, state: 'live', series: { chain: 'near:testnet' } };

function roundsThenSeries(q: Query) {
  if (q.table === 'bm.rounds') return { data: [ROUND], error: null };
  if (q.table === 'bm.series') return { data: [SERIES_NEAR], error: null };
  return { data: [], error: null };
}

test('listDueLive: rounds of one chain through the inner join on their series', async () => {
  const queries = fake(roundsThenSeries);
  const at = new Date('2026-11-08T12:00:00Z');
  const rows = await rr.listDueLive('near:testnet', at, 300);
  const q = queries[0];
  assert.equal(q.table, 'bm.rounds');
  assert.deepEqual(call(q, 'select'), [['select', '*, series!inner(chain)']]);
  assert.deepEqual(call(q, 'eq'), [
    ['eq', 'series.chain', 'near:testnet'],
    ['eq', 'state', 'live'],
  ]);
  assert.deepEqual(call(q, 'lte'), [['lte', 'close_at', '2026-11-08T11:55:00.000Z']]);
  assert.deepEqual(call(q, 'limit'), [['limit', 100]]);
  // The embedded {chain} is replaced by the full series row.
  assert.deepEqual(rows, [{ id: 'r1', series_id: 's-near', idx: 1, state: 'live', series: SERIES_NEAR }]);
  assert.deepEqual(call(queries[1], 'in'), [['in', 'id', ['s-near']]]);
});

test('the keeper lists all take the chain', async () => {
  const queries = fake(roundsThenSeries);
  await rr.listInFlight('solana:devnet');
  await rr.listPresaleReady('solana:devnet', new Date('2026-11-08T12:00:00Z'));
  await rr.listRoundsToClaim('solana:devnet');
  const roundQueries = queries.filter((q) => q.table === 'bm.rounds' && call(q, 'select')[0]?.[1] === '*, series!inner(chain)');
  assert.equal(roundQueries.length, 3);
  for (const q of roundQueries) assert.deepEqual(call(q, 'eq')[0], ['eq', 'series.chain', 'solana:devnet']);
  assert.deepEqual(call(roundQueries[0], 'in'), [['in', 'state', ['opening', 'settling']]]);
  assert.deepEqual(call(roundQueries[2], 'in'), [['in', 'state', ['settled', 'void']]]);
  assert.deepEqual(call(roundQueries[2], 'limit'), [['limit', 50]]);

  const seriesQueries = fake(() => ({ data: [], error: null }));
  await rr.listPendingSeries('near:testnet');
  await rr.listPausedWithPresale('near:testnet');
  assert.deepEqual(call(seriesQueries[0], 'eq'), [
    ['eq', 'state', 'pending'],
    ['eq', 'chain', 'near:testnet'],
  ]);
  assert.deepEqual(call(seriesQueries[1], 'eq'), [
    ['eq', 'state', 'paused'],
    ['eq', 'chain', 'near:testnet'],
  ]);
});

test('hasRunningSeries: one per market, chain and speed', async () => {
  const queries = fake(() => ({ data: [{ id: 'x' }], error: null }));
  assert.equal(await rr.hasRunningSeries('m1', 'near:testnet', true), true);
  assert.deepEqual(call(queries[0], 'eq'), [
    ['eq', 'atnx_market_id', 'm1'],
    ['eq', 'chain', 'near:testnet'],
    ['eq', 'fast', true],
  ]);
  assert.deepEqual(call(queries[0], 'in'), [['in', 'state', ['pending', 'active', 'paused']]]);
  fake(() => ({ data: [], error: null }));
  assert.equal(await rr.hasRunningSeries('m1', 'solana:devnet', false), false);
});

test('markSeriesActive: the NEAR series id, or the Solana account, with the create tx', async () => {
  const queries = fake(() => ({ data: null, error: null }));
  await rr.markSeriesActive('s1', { onchain_series_id: 7, create_tx: 'NEARHASH' });
  await rr.markSeriesActive('s2', { series_pubkey: 'PDA', create_tx: 'sig' });
  const [near, sol] = queries.map((q) => call(q, 'update')[0][1] as Record<string, unknown>);
  assert.deepEqual({ ...near, updated_at: 'T' }, { onchain_series_id: 7, create_tx: 'NEARHASH', state: 'active', error: null, updated_at: 'T' });
  assert.deepEqual({ ...sol, updated_at: 'T' }, { series_pubkey: 'PDA', create_tx: 'sig', state: 'active', error: null, updated_at: 'T' });
  assert.deepEqual(call(queries[0], 'eq'), [['eq', 'id', 's1']]);
});

test('transitionRound: a compare-and-set that carries the settle inputs and commitment', async () => {
  const queries = fake(() => ({ data: [{ id: 'r1' }], error: null }));
  const inputs = { version: 1, prints: [{ at: '2026-11-08T11:59:00.000000Z', vi: 412.3 }], average_e2: 41230 };
  const ok = await rr.transitionRound('r1', 'live', 'settling', {
    settle_vi: 412.3,
    settle_prints: 1,
    settle_inputs: inputs,
    settle_commitment: 'ab'.repeat(32),
  });
  assert.equal(ok, true);
  const q = queries[0];
  const patch = call(q, 'update')[0][1] as Record<string, unknown>;
  assert.deepEqual(patch.settle_inputs, inputs);
  assert.equal(patch.settle_commitment, 'ab'.repeat(32));
  assert.equal(patch.state, 'settling');
  assert.deepEqual(call(q, 'eq'), [['eq', 'id', 'r1']]);
  assert.deepEqual(call(q, 'in'), [['in', 'state', ['live']]]);
  fake(() => ({ data: [], error: null }));
  assert.equal(await rr.transitionRound('r1', ['opening', 'presale'], 'live'), false);
});

test('findSeries: by 64-hex reference or by uuid; anything else is no series', async () => {
  const queries = fake(() => ({ data: { id: 's1' }, error: null }));
  const ref = 'AB'.repeat(32);
  assert.deepEqual(await rr.findSeries(`0x${ref}`), { id: 's1' });
  assert.deepEqual(call(queries[0], 'eq'), [['eq', 'reference', ref.toLowerCase()]]);
  await rr.findSeries('00000000-0000-4000-8000-000000000001');
  assert.deepEqual(call(queries[1], 'eq'), [['eq', 'id', '00000000-0000-4000-8000-000000000001']]);
  assert.equal(await rr.findSeries('series 7'), null);
  assert.equal(queries.length, 2);
});

test('registry errors surface', async () => {
  fake(() => ({ data: null, error: { message: 'boom', code: 'XX000' } }));
  await assert.rejects(rr.listDueLive('near:testnet', new Date(), 300), (e: { message?: string }) => e.message === 'boom');
  fake(() => ({ data: null, error: { message: 'dup', code: '23505' } }));
  assert.equal(await rr.insertPresale('s1', 2, new Date(), null), null, 'a second presale is not an error');
  rr.setRegistryClientForTests(null);
});

// -------------------------------------------- the site reads its chain

test('activeRoundsChain: NEXT_PUBLIC_BM_CHAIN=near is NEAR testnet, anything else Solana devnet', () => {
  assert.equal(rr.activeRoundsChain('near'), 'near:testnet');
  assert.equal(rr.activeRoundsChain(' NEAR '), 'near:testnet');
  assert.equal(rr.activeRoundsChain('solana'), 'solana:devnet');
  assert.equal(rr.activeRoundsChain(''), 'solana:devnet');
  assert.equal(rr.activeRoundsChain(undefined), 'solana:devnet');
});

async function withChainEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.NEXT_PUBLIC_BM_CHAIN;
  if (value === undefined) delete process.env.NEXT_PUBLIC_BM_CHAIN;
  else process.env.NEXT_PUBLIC_BM_CHAIN = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_BM_CHAIN;
    else process.env.NEXT_PUBLIC_BM_CHAIN = before;
  }
}

test('getSeriesForMarket: only the running series of the site chain', async () => {
  for (const [env, chain] of [
    ['near', 'near:testnet'],
    ['solana', 'solana:devnet'],
    [undefined, 'solana:devnet'],
  ] as const) {
    const queries = fake(() => ({ data: null, error: null }));
    await withChainEnv(env, () => rr.getSeriesForMarket('m1'));
    assert.deepEqual(call(queries[0], 'eq'), [
      ['eq', 'atnx_market_id', 'm1'],
      ['eq', 'chain', chain],
    ]);
    assert.deepEqual(call(queries[0], 'in'), [['in', 'state', ['active', 'paused']]]);
  }
  const queries = fake(() => ({ data: null, error: null }));
  await rr.getSeriesForMarket('m1', 'near:testnet');
  assert.deepEqual(call(queries[0], 'eq')[1], ['eq', 'chain', 'near:testnet']);
});

test('listLiveRounds (the list badges, /api/bm/rounds): rounds of the site chain, running series only', async () => {
  const series = [
    { id: 's-near', chain: 'near:testnet', state: 'active', atnx_market_id: 'm1', fast: false },
    { id: 's-ended', chain: 'near:testnet', state: 'ended', atnx_market_id: 'm2', fast: false },
  ];
  const rounds = [
    { id: 'r1', series_id: 's-near', idx: 3, state: 'live', series: { chain: 'near:testnet' } },
    { id: 'r2', series_id: 's-ended', idx: 1, state: 'presale', series: { chain: 'near:testnet' } },
  ];
  for (const [env, chain] of [
    ['near', 'near:testnet'],
    [undefined, 'solana:devnet'],
  ] as const) {
    const queries = fake((q) => ({ data: q.table === 'bm.rounds' ? rounds : series, error: null }));
    const rows = await withChainEnv(env, () => rr.listLiveRounds());
    assert.deepEqual(call(queries[0], 'select'), [['select', '*, series!inner(chain)']]);
    assert.deepEqual(call(queries[0], 'eq'), [['eq', 'series.chain', chain]]);
    assert.deepEqual(call(queries[0], 'in'), [['in', 'state', ['presale', 'opening', 'live', 'settling']]]);
    assert.deepEqual(rows.map((r) => [r.id, r.series.id]), [['r1', 's-near']]);
  }
  rr.setRegistryClientForTests(null);
});

test('listSeriesWithPubkey (the portfolio): series of the site chain only', async () => {
  for (const [env, chain] of [
    ['near', 'near:testnet'],
    ['solana', 'solana:devnet'],
    [undefined, 'solana:devnet'],
  ] as const) {
    const queries = fake(() => ({ data: [], error: null }));
    await withChainEnv(env, () => rr.listSeriesWithPubkey());
    assert.equal(queries[0].table, 'bm.series');
    assert.deepEqual(call(queries[0], 'eq'), [['eq', 'chain', chain]]);
    assert.deepEqual(call(queries[0], 'not'), [['not', 'series_pubkey', 'is', null]]);
    assert.deepEqual(call(queries[0], 'limit'), [['limit', 500]]);
  }
  const queries = fake(() => ({ data: [], error: null }));
  await withChainEnv('solana', () => rr.listSeriesWithPubkey(20, 'near:testnet'));
  assert.deepEqual(call(queries[0], 'eq'), [['eq', 'chain', 'near:testnet']]);
  assert.deepEqual(call(queries[0], 'limit'), [['limit', 20]]);
  rr.setRegistryClientForTests(null);
});

test('getSiteSeries: one series by id, only on the site chain; getSeries (the keeper) stays unfiltered', async () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  for (const [env, chain] of [
    ['near', 'near:testnet'],
    [undefined, 'solana:devnet'],
  ] as const) {
    const queries = fake(() => ({ data: { id: ID, chain }, error: null }));
    assert.deepEqual(await withChainEnv(env, () => rr.getSiteSeries(ID)), { id: ID, chain });
    assert.deepEqual(call(queries[0], 'eq'), [
      ['eq', 'id', ID],
      ['eq', 'chain', chain],
    ]);
  }
  const queries = fake(() => ({ data: null, error: null }));
  assert.equal(await rr.getSiteSeries(ID, 'near:testnet'), null);
  await rr.getSeries(ID);
  assert.deepEqual(call(queries[0], 'eq'), [
    ['eq', 'id', ID],
    ['eq', 'chain', 'near:testnet'],
  ]);
  assert.deepEqual(call(queries[1], 'eq'), [['eq', 'id', ID]]);
  rr.setRegistryClientForTests(null);
});

test('/api/bm/rounds?series=: a series of the other chain is a 404; the listing reads the site chain', async () => {
  const { GET } = await import('@/app/api/bm/rounds/route');
  const ID = '00000000-0000-4000-8000-000000000001';
  for (const [env, chain] of [
    ['near', 'near:testnet'],
    ['solana', 'solana:devnet'],
  ] as const) {
    // The registry answers as the database would to the chain filter: no row.
    const queries = fake(() => ({ data: null, error: null }));
    const res = await withChainEnv(env, () => GET(new Request(`https://markets.atnx.app/api/bm/rounds?series=${ID}`)));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { items: [] });
    assert.equal(queries.length, 1, 'no rounds are read for a series of the other chain');
    assert.equal(queries[0].table, 'bm.series');
    assert.deepEqual(call(queries[0], 'eq'), [
      ['eq', 'id', ID],
      ['eq', 'chain', chain],
    ]);

    const listQueries = fake(() => ({ data: [], error: null }));
    const list = await withChainEnv(env, () => GET(new Request('https://markets.atnx.app/api/bm/rounds')));
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { items: [] });
    assert.deepEqual(call(listQueries[0], 'eq'), [['eq', 'series.chain', chain]]);
  }
  const bad = fake();
  const res = await GET(new Request('https://markets.atnx.app/api/bm/rounds?series=nope'));
  assert.equal(res.status, 400);
  assert.equal(bad.length, 0);
  rr.setRegistryClientForTests(null);
});
