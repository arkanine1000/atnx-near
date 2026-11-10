// Public, read-only answers about the house keeper's quote pushes, with no
// secrets: what GET /api/near/house/pushes and GET /api/near/house/verify
// return.
//
// pushes: the newest pushes as the keeper logged them in bm.keeper_log
// (lib/bm/house-keeper.ts writes one row per transaction: 'house-push' for
// the five-minute run, 'house-fast' for the every-minute run, and
// 'house-on-demand' for a quote sent right after a user's order or close).
//
// verify: one push checked the way scripts/house-verify-public.ts checks
// it, on the server: the transaction from the public RPC, the contract's
// keeper and each quoted market's reference from the contract, the
// vi_history rows from the public REST API with the anon key, then
// verifyQuotePush (lib/bm/quote-commitment.ts). The answer carries the
// canonical batch, so anyone can hash it themselves.
//
// The route handlers take their reads as dependencies; the tests pass
// fakes (lib/near/house-public.test.ts).
import { decodeMarket, listArgs, type QuoteIn } from '../bm/house-types';
import { verifyQuotePush, type PrintRow } from '../bm/quote-commitment';
import { HouseVerifyError, fetchPrintRows, pushFromTx, type PushFromTx } from './house-verify';
import { rpcView, type FetchFn, type RouteResult } from './verify';

// A NEAR transaction hash: 32 bytes in base58.
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const PUSHES_MAX = 20;
// Log rows read to find PUSHES_MAX pushes: the every-minute run and the
// quotes on demand also log transactions that carried no quote.
export const PUSH_ROWS_READ = 100;
export const PUSH_ACTIONS = ['house-push', 'house-fast', 'house-on-demand'] as const;
const LOG_CHAIN = 'near:testnet';
const LIST_PAGE = 100;

const txUrl = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

type J = Record<string, unknown>;
const asObj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const hex64 = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

// ---------------------------------------------------------------- pushes

export interface KeeperLogRow {
  action: string;
  detail: unknown;
  tx_hash: string | null;
  created_at: string;
}

export interface HousePushItem {
  txHash: string;
  // When the keeper logged the transaction (after it landed).
  at: string;
  run: 'tick' | 'fast' | 'on_demand';
  // Quotes the transaction carried, and of those, taken and skipped by the
  // contract (null when the log does not say).
  quotes: number;
  accepted: number | null;
  skipped: number | null;
  // The commitment the push carried; null for a quote on demand, whose log
  // row does not keep it (the verify call reads it from the transaction).
  commitment: string | null;
  // The chain time the keeper read the rows at (the quotes' read_at).
  readAt: number | null;
  txUrl: string;
  verify: string;
}

// One log row as a push, or null when it is not a push of quotes to this
// contract that landed.
export function pushItemOf(row: KeeperLogRow, contractId: string): HousePushItem | null {
  const d = asObj(row.detail);
  if (d.chain !== LOG_CHAIN || d.step !== 'house' || d.contract !== contractId) return null;
  if (typeof row.tx_hash !== 'string' || !TX_HASH.test(row.tx_hash)) return null;
  let run: HousePushItem['run'];
  let quotes: number | null;
  let accepted: number | null = int(d.accepted);
  let skipped: number | null = int(d.contractSkipped);
  let commitment: string | null = hex64(d.commitment);
  if (row.action === 'house-push') {
    run = 'tick';
    quotes = int(d.count);
  } else if (row.action === 'house-fast') {
    run = 'fast';
    quotes = int(d.quotes);
  } else if (row.action === 'house-on-demand') {
    if (d.sent !== true || d.pushed !== true) return null;
    run = 'on_demand';
    quotes = 1;
    skipped = d.pushSkipped === true ? 1 : 0;
    accepted = 1 - skipped;
    commitment = null;
  } else {
    return null;
  }
  if (!quotes) return null;
  return {
    txHash: row.tx_hash,
    at: row.created_at,
    run,
    quotes,
    accepted,
    skipped,
    commitment,
    readAt: int(d.readAt),
    txUrl: txUrl(row.tx_hash),
    verify: `/api/near/house/verify?tx=${row.tx_hash}`,
  };
}

// GET /api/near/house/pushes?limit=N (1 to 20, default 20).
export async function handleHousePushes(deps: { recentRows: (n: number) => Promise<KeeperLogRow[]>; contractId: string }, params: URLSearchParams): Promise<RouteResult> {
  const raw = params.get('limit');
  const limit = raw === null ? PUSHES_MAX : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= PUSHES_MAX)) return { status: 400, body: { error: 'bad_limit', detail: `limit is 1 to ${PUSHES_MAX}` } };
  const rows = await deps.recentRows(PUSH_ROWS_READ);
  const seen = new Set<string>();
  const items: HousePushItem[] = [];
  for (const r of rows) {
    const it = pushItemOf(r, deps.contractId);
    if (!it || seen.has(it.txHash)) continue;
    seen.add(it.txHash);
    items.push(it);
    if (items.length >= limit) break;
  }
  return { status: 200, body: { contract: deps.contractId, items } };
}

// ---------------------------------------------------------------- verify

export interface HouseVerifyDeps {
  fetch: FetchFn;
  rpcUrl: string;
  contractId: string;
  supabaseUrl: string;
  anonKey: string;
}

type TxLookup = { kind: 'unknown' } | { kind: 'not_final'; status: string } | { kind: 'found'; tx: unknown };

// The transaction, sent by `senderId`, without waiting: a hash the chain
// has never seen answers at once instead of after the RPC's timeout.
export async function lookupTx(fetchFn: FetchFn, rpcUrl: string, txHash: string, senderId: string): Promise<TxLookup> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'atnx-house-verify', method: 'tx', params: { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' } }),
  });
  if (!res.ok) throw new Error(`tx: the RPC answered HTTP ${res.status}`);
  const body = asObj(await res.json());
  if (body.error) {
    const cause = asObj(asObj(body.error).cause).name;
    if (cause === 'UNKNOWN_TRANSACTION') return { kind: 'unknown' };
    throw new Error(`tx: RPC error ${JSON.stringify(body.error).slice(0, 300)}`);
  }
  const result = asObj(body.result);
  const status = String(result.final_execution_status ?? '');
  if (status !== 'FINAL') return { kind: 'not_final', status };
  return { kind: 'found', tx: result };
}

// Every market's reference, from list_markets in pages.
async function marketReferences(d: HouseVerifyDeps): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let from = 0, i = 0; i < 50; i++, from += LIST_PAGE) {
    const page = await rpcView(d.fetch, d.rpcUrl, d.contractId, 'list_markets', listArgs(from, LIST_PAGE));
    const list = Array.isArray(page) ? page : [];
    for (const v of list) {
      const m = decodeMarket(v);
      out.set(m.id, m.reference);
    }
    if (list.length < LIST_PAGE) break;
  }
  return out;
}

// The push's own consistency: its event against its arguments.
function eventProblems(push: PushFromTx): string[] {
  const p: string[] = [];
  const e = push.event;
  if (!e) return ['no quotes_pushed event in the transaction'];
  if (e.commitment !== push.commitment) p.push(`the event's commitment ${String(e.commitment)} is not the call's ${push.commitment}`);
  if (e.count !== push.quotes.length) p.push(`the event counts ${String(e.count)} quotes, the call has ${push.quotes.length}`);
  if (e.accepted === null || e.skipped === null) p.push('the event does not say how many quotes the contract took and skipped');
  else if (e.count !== null && e.accepted + e.skipped !== e.count) p.push(`the event's ${e.accepted} taken and ${e.skipped} skipped do not add up to its ${e.count} quotes`);
  return p;
}

function comparedQuote(q: QuoteIn, refs: Map<number, string>, rows: Map<string, PrintRow>) {
  const row = rows.get(q.printId.toString()) ?? null;
  return {
    market: q.market,
    reference: refs.get(q.market) ?? null,
    printId: q.printId.toString(),
    scoreE2: q.scoreE2.toString(),
    readingE2: q.readingE2.toString(),
    printAt: q.printAt,
    readAt: q.readAt,
    row: row ? { id: Number(row.id), market_id: row.market_id, vi: Number(row.vi), raw_vi: row.raw_vi === null ? null : Number(row.raw_vi), recorded_at: row.recorded_at } : null,
  };
}

// GET /api/near/house/verify?tx=<hash>.
export async function handleHouseVerify(deps: HouseVerifyDeps, params: URLSearchParams): Promise<RouteResult> {
  const tx = (params.get('tx') ?? '').trim();
  if (!TX_HASH.test(tx)) return { status: 400, body: { error: 'bad_request', detail: 'expected ?tx=<transaction hash, base58>' } };
  const fail = (status: number, error: string, extra: J = {}): RouteResult => ({ status, body: { error, tx, ...extra } });

  let keeper: string;
  let found: TxLookup;
  try {
    const cfg = asObj(await rpcView(deps.fetch, deps.rpcUrl, deps.contractId, 'get_config', {}));
    if (typeof cfg.keeper !== 'string') return fail(502, 'rpc_error', { detail: `${deps.contractId} returned no keeper` });
    keeper = cfg.keeper;
    found = await lookupTx(deps.fetch, deps.rpcUrl, tx, keeper);
  } catch (err) {
    return fail(502, 'rpc_error', { detail: String((err as Error)?.message ?? err).slice(0, 300) });
  }
  if (found.kind === 'unknown') return fail(404, 'unknown_transaction', { detail: `no transaction with this hash sent by ${keeper}` });
  if (found.kind === 'not_final') return fail(409, 'not_final', { detail: `the transaction is ${found.status || 'not final'}; ask again in a few seconds` });

  let push: PushFromTx;
  try {
    push = pushFromTx(found.tx);
  } catch (err) {
    if (err instanceof HouseVerifyError) return fail(422, 'not_a_push', { detail: err.message });
    throw err;
  }
  if (push.signer !== keeper || push.receiver !== deps.contractId) {
    return fail(422, 'not_a_house_push', { detail: `sent by ${push.signer} to ${push.receiver}, not by ${keeper} to ${deps.contractId}`, signer: push.signer, receiver: push.receiver });
  }
  if (!push.succeeded) return fail(422, 'failed_on_chain', { detail: 'the transaction failed on chain, so it pushed nothing' });

  let refs: Map<number, string>;
  try {
    refs = await marketReferences(deps);
  } catch (err) {
    return fail(502, 'rpc_error', { detail: String((err as Error)?.message ?? err).slice(0, 300) });
  }
  let rows: PrintRow[];
  try {
    rows = await fetchPrintRows(deps.fetch, deps.supabaseUrl, deps.anonKey, push.quotes.map((q) => q.printId));
  } catch (err) {
    return fail(502, 'db_error', { detail: String((err as Error)?.message ?? err).slice(0, 300) });
  }
  const quoted = new Set(push.quotes.map((q) => q.market));
  const references = new Map([...refs].filter(([m]) => quoted.has(m)));
  const result = verifyQuotePush({ quotes: push.quotes, commitment: push.commitment, rows, references });
  const problems = [...eventProblems(push), ...result.problems];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return {
    status: 200,
    body: {
      tx,
      txUrl: txUrl(tx),
      contract: deps.contractId,
      keeper,
      rpc: deps.rpcUrl,
      quotes: push.quotes.length,
      accepted: push.event?.accepted ?? null,
      skipped: push.event?.skipped ?? null,
      rowsFound: rows.length,
      // The commitment in the call's arguments, in the contract's
      // quotes_pushed event, and the sha256 of `canonical` computed here.
      hashes: { call: push.commitment, event: push.event?.commitment ?? null, recomputed: result.hash || null },
      // The exact string whose sha256 is the commitment: the rows behind the
      // quotes, as lib/bm/quote-commitment.ts builds the batch.
      canonical: result.json || null,
      ok: problems.length === 0,
      problems,
      // Each quote as pushed, beside the public row it came from.
      compared: push.quotes.map((q) => comparedQuote(q, refs, byId)),
    },
  };
}
