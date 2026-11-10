import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushQuotesArgs, type QuoteIn } from '../bm/house-types';
import { buildQuoteBatch, quoteCommitment, quoteFromRow, type PrintRow } from '../bm/quote-commitment';
import { HouseVerifyError, pushFromTx, verifyPushFromChain } from './house-verify';
import type { FetchFn } from './verify';

const RPC = 'https://rpc.example';
const DB = 'https://db.example';
const CONTRACT = 'house.atnx.testnet';
const KEEPER = 'keeper.atnx.testnet';
const A = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const B = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const T = 1_794_265_500;

const ROWS: PrintRow[] = [
  { id: 901, market_id: B, vi: 673.07, raw_vi: 711.2, recorded_at: '2026-11-09T23:05:40.100000+00:00' },
  { id: 905, market_id: A, vi: 455.51, raw_vi: 513, recorded_at: '2026-11-09T23:05:41.250210+00:00' },
];
const MARKET_OF: Record<string, number> = { [B]: 1, [A]: 3 };

function pushTx(opts: { quotes?: QuoteIn[]; commitment?: string; event?: Record<string, string> | null; failed?: boolean; withCrank?: boolean } = {}) {
  const quotes = opts.quotes ?? ROWS.map((r) => quoteFromRow(r, MARKET_OF[r.market_id], T + 105));
  const commitment = opts.commitment ?? quoteCommitment(buildQuoteBatch(ROWS)).hash;
  const args = Buffer.from(JSON.stringify(pushQuotesArgs(quotes, commitment)), 'utf8').toString('base64');
  const actions = [{ FunctionCall: { method_name: 'push_quotes', args, gas: 100_000_000_000_000, deposit: '0' } }];
  if (opts.withCrank) actions.push({ FunctionCall: { method_name: 'crank', args: Buffer.from('{"position_ids":["7"]}').toString('base64'), gas: 1, deposit: '0' } });
  const event =
    opts.event === null
      ? []
      : [`EVENT_JSON:${JSON.stringify({ standard: 'atnx_house', version: '1.0.0', event: 'quotes_pushed', data: [opts.event ?? { count: String(quotes.length), first_print_id: '901', last_print_id: '905', commitment }] })}`];
  return {
    status: opts.failed ? { Failure: { ActionError: {} } } : { SuccessValue: '' },
    transaction: { signer_id: KEEPER, receiver_id: CONTRACT, actions },
    receipts_outcome: [{ outcome: { logs: ['unrelated'] } }, { outcome: { logs: event } }],
  };
}

function marketJson(id: number, uuid: string) {
  return { id, reference: uuid.replace(/-/g, ''), finder: null, live_since: T - 86400 * 5, status: 'Open', quotes: [], final_e2: null };
}

function fakeFetch(tx: unknown, rows: PrintRow[] = ROWS): FetchFn & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    urls.push(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === RPC) {
      const req = JSON.parse(init!.body!);
      if (req.method === 'tx') {
        assert.equal(req.params.sender_account_id, KEEPER);
        return ok({ result: tx });
      }
      const args = JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString('utf8'));
      assert.equal(req.params.method_name, 'get_market');
      const uuid = Object.keys(MARKET_OF).find((u) => MARKET_OF[u] === args.market);
      const bytes = uuid ? [...Buffer.from(JSON.stringify(marketJson(args.market, uuid)))] : [...Buffer.from('null')];
      return ok({ result: { result: bytes } });
    }
    if (url.startsWith(`${DB}/rest/v1/vi_history`)) {
      assert.equal(init?.headers?.apikey, 'anon');
      const ids = /id=in\.\(([^)]*)\)/.exec(url)![1].split(',');
      return ok(rows.filter((r) => ids.includes(String(r.id))));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as FetchFn & { urls: string[] };
  f.urls = urls;
  return f;
}

const run = (fetch: FetchFn) => verifyPushFromChain({ fetch, rpcUrl: RPC, contractId: CONTRACT, senderId: KEEPER, txHash: 'H1', supabaseUrl: `${DB}/`, anonKey: 'anon' });

test('verifyPushFromChain: a push checks out against the public rows', async () => {
  const fetch = fakeFetch(pushTx());
  const r = await run(fetch);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 2);
  assert.equal(r.references.get(3), A.replace(/-/g, ''));
  assert.ok(fetch.urls.some((u) => u === `${DB}/rest/v1/vi_history?select=id,market_id,vi,raw_vi,recorded_at&id=in.(901,905)`));
});

test('verifyPushFromChain: the push and crank of a quote on demand reads the same way', async () => {
  const r = await run(fakeFetch(pushTx({ withCrank: true })));
  assert.equal(r.ok, true);
});

test('verifyPushFromChain: an edited row, a wrong event or a missing event is a mismatch', async () => {
  const edited = ROWS.map((r) => (r.id === 905 ? { ...r, raw_vi: 514 } : r));
  const r1 = await run(fakeFetch(pushTx(), edited));
  assert.equal(r1.ok, false);
  assert.match(r1.problems.join('\n'), /reading_e2 51300 is not toE2\(raw_vi 514\)/);

  const r2 = await run(fakeFetch(pushTx({ event: { count: '3', commitment: 'f'.repeat(64) } })));
  assert.match(r2.problems.join('\n'), /the event's commitment f{64} is not the call's/);
  assert.match(r2.problems.join('\n'), /the event counts 3 quotes, the call has 2/);

  const r3 = await run(fakeFetch(pushTx({ event: null })));
  assert.match(r3.problems.join('\n'), /no quotes_pushed event/);
});

test('verifyPushFromChain: a failed transaction or one without a push cannot be checked', async () => {
  await assert.rejects(run(fakeFetch(pushTx({ failed: true }))), HouseVerifyError);
  assert.throws(() => pushFromTx({ transaction: { actions: [{ FunctionCall: { method_name: 'crank', args: '' } }] } }), /no push_quotes call/);
});
