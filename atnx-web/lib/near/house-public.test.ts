import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pushQuotesArgs, type QuoteIn } from '../bm/house-types';
import { buildQuoteBatch, quoteCommitment, quoteFromRow, type PrintRow } from '../bm/quote-commitment';
import { PUSH_ROWS_READ, handleHousePushes, handleHouseVerify, pushItemOf, type KeeperLogRow } from './house-public';
import type { FetchFn } from './verify';

const CONTRACT = 'house.atnx.testnet';
const KEEPER = 'keeper.atnx.testnet';
const RPC = 'https://rpc.example';
const DB = 'https://db.example';
const TX = '7kxQ6ZbmnUJnfoUZm1NZAzQhtd6S5R4XrXbmpd3WZf6V';
const TX2 = 'F3pRnyZJtJ1qJm4dWj6PcB1M1uEnoBvV6v7jUVxcAbcD';
const COMMIT = 'ab'.repeat(32);
const A = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const B = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const T = 1_794_265_500;

// ---------------------------------------------------------------- pushes

const house = (detail: Record<string, unknown>) => ({ chain: 'near:testnet', step: 'house', contract: CONTRACT, ...detail });

function logRow(action: string, detail: Record<string, unknown>, tx: string | null = TX, at = '2026-11-10T09:01:12.5+00:00'): KeeperLogRow {
  return { action, detail, tx_hash: tx, created_at: at };
}

test('pushItemOf: a five-minute push, an every-minute push and a quote on demand', () => {
  assert.deepEqual(pushItemOf(logRow('house-push', house({ count: 56, commitment: COMMIT, accepted: 55, contractSkipped: 1, readAt: T })), CONTRACT), {
    txHash: TX,
    at: '2026-11-10T09:01:12.5+00:00',
    run: 'tick',
    quotes: 56,
    accepted: 55,
    skipped: 1,
    commitment: COMMIT,
    readAt: T,
    txUrl: `https://testnet.nearblocks.io/txns/${TX}`,
    verify: `/api/near/house/verify?tx=${TX}`,
  });
  const fast = pushItemOf(logRow('house-fast', house({ quotes: 2, commitment: COMMIT, accepted: 2, contractSkipped: 0, readAt: T, ids: ['4'] })), CONTRACT);
  assert.equal(fast?.run, 'fast');
  assert.equal(fast?.quotes, 2);
  const onDemand = pushItemOf(logRow('house-on-demand', house({ ok: true, sent: true, pushed: true, pushSkipped: false, readAt: T })), CONTRACT);
  assert.deepEqual([onDemand?.run, onDemand?.quotes, onDemand?.accepted, onDemand?.skipped, onDemand?.commitment], ['on_demand', 1, 1, 0, null]);
});

test('pushItemOf: rows that are not a landed push of quotes to this contract are left out', () => {
  const none = (row: KeeperLogRow) => assert.equal(pushItemOf(row, CONTRACT), null);
  none(logRow('house-fast', house({ quotes: 0, commitment: null })));
  none(logRow('house-on-demand', house({ sent: true, pushed: false })));
  none(logRow('house-on-demand', house({ sent: false, pushed: false, reason: 'not_waiting' })));
  none(logRow('house-push', house({ count: 3, commitment: COMMIT }), null));
  none(logRow('house-push', house({ count: 3, commitment: COMMIT }), 'not a hash!'));
  none(logRow('house-push', { ...house({ count: 3 }), contract: 'other.testnet' }));
  none(logRow('house-push', { ...house({ count: 3 }), chain: 'solana:devnet' }));
  none(logRow('house-crank', house({ ids: ['1'] })));
  // A commitment that is not 64 hex reads as unknown, not as itself.
  assert.equal(pushItemOf(logRow('house-push', house({ count: 3, commitment: 'nope' })), CONTRACT)?.commitment, null);
});

test('handleHousePushes: limit 1 to 20, newest first, each transaction once', async () => {
  const asked: number[] = [];
  const rows = [
    logRow('house-push', house({ count: 5, commitment: COMMIT })),
    logRow('house-push', house({ count: 5, commitment: COMMIT })),
    logRow('house-fast', house({ quotes: 0 }), TX2),
    logRow('house-fast', house({ quotes: 1, commitment: COMMIT }), TX2),
  ];
  const deps = { contractId: CONTRACT, recentRows: async (n: number) => (asked.push(n), rows) };
  const r = await handleHousePushes(deps, new URLSearchParams());
  assert.equal(r.status, 200);
  assert.equal(r.body.contract, CONTRACT);
  assert.deepEqual((r.body.items as Array<{ txHash: string }>).map((i) => i.txHash), [TX, TX2]);
  assert.deepEqual(asked, [PUSH_ROWS_READ]);
  const one = await handleHousePushes(deps, new URLSearchParams('limit=1'));
  assert.equal((one.body.items as unknown[]).length, 1);
  for (const bad of ['0', '21', '-1', 'x', '1.5', '']) {
    const b = await handleHousePushes(deps, new URLSearchParams({ limit: bad }));
    assert.equal(b.status, 400, bad);
    assert.equal(b.body.error, 'bad_limit');
  }
});

// ---------------------------------------------------------------- verify

const ROWS: PrintRow[] = [
  { id: 901, market_id: B, vi: 673.07, raw_vi: 711.2, recorded_at: '2026-11-09T23:05:40.100000+00:00' },
  { id: 905, market_id: A, vi: 455.51, raw_vi: 513, recorded_at: '2026-11-09T23:05:41.250210+00:00' },
];
const MARKET_OF: Record<string, number> = { [B]: 1, [A]: 3 };

function pushTx(o: { signer?: string; receiver?: string; method?: string; failed?: boolean; quotes?: QuoteIn[] } = {}) {
  const quotes = o.quotes ?? ROWS.map((r) => quoteFromRow(r, MARKET_OF[r.market_id], T + 105));
  const commitment = quoteCommitment(buildQuoteBatch(ROWS)).hash;
  const args = Buffer.from(JSON.stringify(pushQuotesArgs(quotes, commitment)), 'utf8').toString('base64');
  const event = `EVENT_JSON:${JSON.stringify({ standard: 'atnx_house', version: '1.0.0', event: 'quotes_pushed', data: [{ count: String(quotes.length), accepted: String(quotes.length), skipped: '0', first_print_id: '901', last_print_id: '905', commitment }] })}`;
  return {
    final_execution_status: 'FINAL',
    status: o.failed ? { Failure: { ActionError: {} } } : { SuccessValue: '' },
    transaction: { signer_id: o.signer ?? KEEPER, receiver_id: o.receiver ?? CONTRACT, actions: [{ FunctionCall: { method_name: o.method ?? 'push_quotes', args, gas: 1, deposit: '0' } }] },
    receipts_outcome: [{ outcome: { logs: [event] } }],
  };
}

function marketJson(id: number, uuid: string) {
  return { id, reference: uuid.replace(/-/g, ''), finder: null, live_since: String(T - 86400 * 5), status: 'Open', quotes: [], final_e2: null, long: null, short: null };
}

type TxAnswer = { result: unknown } | { error: unknown };

function fakeFetch(o: { tx?: TxAnswer; rows?: PrintRow[]; dbStatus?: number; rpcStatus?: number } = {}): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const ok = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
  const bytes = (v: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(v))] } });
  const f = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url === RPC) {
      const req = JSON.parse(init!.body!);
      calls.push(req.method === 'tx' ? `tx ${req.params.sender_account_id} ${req.params.wait_until}` : req.params.method_name);
      if (o.rpcStatus) return ok({}, o.rpcStatus);
      if (req.method === 'tx') return ok(o.tx ?? { result: pushTx() });
      if (req.params.method_name === 'get_config') return ok(bytes({ keeper: KEEPER, owner: 'atnx.testnet' }));
      if (req.params.method_name === 'list_markets') return ok(bytes(Object.entries(MARKET_OF).map(([uuid, id]) => marketJson(id, uuid))));
      return ok({ error: 'unexpected' });
    }
    if (url.startsWith(`${DB}/rest/v1/vi_history`)) {
      calls.push('vi_history');
      assert.equal(init?.headers?.apikey, 'anon');
      if (o.dbStatus) return ok([], o.dbStatus);
      const ids = /id=in\.\(([^)]*)\)/.exec(url)![1].split(',');
      return ok((o.rows ?? ROWS).filter((r) => ids.includes(String(r.id))));
    }
    return ok({}, 404);
  }) as FetchFn & { calls: string[] };
  f.calls = calls;
  return f;
}

const verify = (fetch: FetchFn, tx: string | null = TX) =>
  handleHouseVerify({ fetch, rpcUrl: RPC, contractId: CONTRACT, supabaseUrl: DB, anonKey: 'anon' }, new URLSearchParams(tx === null ? '' : `tx=${encodeURIComponent(tx)}`));

test('handleHouseVerify: a push checks out, with the three hashes and the string they hash', async () => {
  const fetch = fakeFetch();
  const r = await verify(fetch);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.problems, []);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.keeper, KEEPER);
  assert.equal(r.body.quotes, 2);
  const h = r.body.hashes as { call: string; event: string; recomputed: string };
  assert.equal(h.call, quoteCommitment(buildQuoteBatch(ROWS)).hash);
  assert.equal(h.event, h.call);
  assert.equal(h.recomputed, h.call);
  assert.equal(createHash('sha256').update(String(r.body.canonical)).digest('hex'), h.call, 'anyone can hash `canonical` and get the commitment');
  const compared = r.body.compared as Array<{ market: number; reference: string; printId: string; row: { vi: number } | null }>;
  assert.deepEqual(
    compared.map((c) => [c.market, c.reference, c.printId, c.row?.vi]),
    [
      [1, B.replace(/-/g, ''), '901', 673.07],
      [3, A.replace(/-/g, ''), '905', 455.51],
    ],
  );
  // The keeper is the contract's, and the transaction is looked up without waiting.
  assert.deepEqual(fetch.calls, ['get_config', `tx ${KEEPER} NONE`, 'list_markets', 'vi_history']);
});

test('handleHouseVerify: an edited row is a 200 with ok false and the problem named', async () => {
  const rows = ROWS.map((r) => (r.id === 905 ? { ...r, raw_vi: 514 } : r));
  const r = await verify(fakeFetch({ rows }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match((r.body.problems as string[]).join('\n'), /reading_e2 51300 is not toE2\(raw_vi 514\)/);
  assert.notEqual((r.body.hashes as { recomputed: string }).recomputed, (r.body.hashes as { call: string }).call);
});

test('handleHouseVerify: a malformed hash is a 400 and reaches nothing', async () => {
  for (const bad of [null, '', 'abc', '0'.repeat(44), TX + 'x'.repeat(10), `${TX}&x=1`, 'I'.repeat(43)]) {
    const fetch = fakeFetch();
    const r = await verify(fetch, bad);
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.body.error, 'bad_request');
    assert.deepEqual(fetch.calls, []);
  }
});

test('handleHouseVerify: unknown, unfinished and foreign transactions are clean 4xx answers', async () => {
  const unknown = await verify(fakeFetch({ tx: { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } } }));
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown_transaction']);

  const pending = await verify(fakeFetch({ tx: { result: { ...pushTx(), final_execution_status: 'EXECUTED_OPTIMISTIC' } } }));
  assert.deepEqual([pending.status, pending.body.error], [409, 'not_final']);

  const settle = await verify(fakeFetch({ tx: { result: pushTx({ method: 'settle' }) } }));
  assert.deepEqual([settle.status, settle.body.error], [422, 'not_a_push']);

  const other = await verify(fakeFetch({ tx: { result: pushTx({ signer: 'mallory.testnet' }) } }));
  assert.deepEqual([other.status, other.body.error, other.body.signer], [422, 'not_a_house_push', 'mallory.testnet']);

  const elsewhere = await verify(fakeFetch({ tx: { result: pushTx({ receiver: 'rounds.atnx.testnet' }) } }));
  assert.deepEqual([elsewhere.status, elsewhere.body.error], [422, 'not_a_house_push']);

  const failed = await verify(fakeFetch({ tx: { result: pushTx({ failed: true }) } }));
  assert.deepEqual([failed.status, failed.body.error], [422, 'failed_on_chain']);
});

test('handleHouseVerify: the RPC or the database failing is a 502 with a reason, never a throw', async () => {
  const rpc = await verify(fakeFetch({ rpcStatus: 503 }));
  assert.deepEqual([rpc.status, rpc.body.error], [502, 'rpc_error']);
  const other = await verify(fakeFetch({ tx: { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } }));
  assert.deepEqual([other.status, other.body.error], [502, 'rpc_error']);
  const db = await verify(fakeFetch({ dbStatus: 500 }));
  assert.deepEqual([db.status, db.body.error], [502, 'db_error']);
  assert.equal(db.body.tx, TX);
});
