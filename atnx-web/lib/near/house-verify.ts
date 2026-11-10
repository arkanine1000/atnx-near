// Public verification of a house quote push, with no secrets: what
// scripts/house-verify-public.ts checks on anyone's machine.
//
// A push_quotes call carries its quotes and a commitment, the sha256 of the
// canonical batch of the vi_history rows they came from
// (lib/bm/quote-commitment.ts), and the contract logs a quotes_pushed event
// with the same commitment. Every row is public. So: read the transaction
// from a public NEAR RPC (its arguments and its event), read each quoted
// market's reference from the contract, fetch the rows by id from the
// public Supabase REST API with the anon key, rebuild the batch, hash it,
// and compare; then check each quote's numbers against its row.
//
// Only fetch and the commitment code: no Supabase client, no keys.
import { decodeMarket, decodePushQuotesArgs, decodeQuotesPushed, houseEventsOf, marketArgs, type QuoteIn, type QuotesPushedEvent } from '../bm/house-types';
import { verifyQuotePush, type PrintRow, type QuoteVerifyResult } from '../bm/quote-commitment';
import { rpcView, type FetchFn } from './verify';

export const PUBLIC_HOUSE_CONTRACT = 'house.atnx.testnet';
export const PUBLIC_KEEPER = 'keeper.atnx.testnet';

export class HouseVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HouseVerifyError';
  }
}

// ------------------------------------------------------------------ RPC

// A transaction and its receipts' outcomes (NEAR JSON-RPC `tx`), final.
export async function rpcTx(fetchFn: FetchFn, rpcUrl: string, txHash: string, senderId: string): Promise<unknown> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'atnx-house-verify', method: 'tx', params: { tx_hash: txHash, sender_account_id: senderId, wait_until: 'FINAL' } }),
  });
  if (!res.ok) throw new HouseVerifyError(`tx: the RPC answered HTTP ${res.status}`);
  const body = (await res.json()) as { error?: unknown; result?: unknown };
  if (body.error) throw new HouseVerifyError(`tx: RPC error ${JSON.stringify(body.error).slice(0, 300)}`);
  if (!body.result) throw new HouseVerifyError('tx: the RPC returned no transaction');
  return body.result;
}

export interface PushFromTx {
  signer: string;
  receiver: string;
  succeeded: boolean;
  quotes: QuoteIn[];
  commitment: string;
  event: QuotesPushedEvent | null;
}

type J = Record<string, unknown>;
const asObj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});

// The push_quotes action of a transaction (it may also hold a crank), and
// the quotes_pushed event among its receipts' logs.
export function pushFromTx(tx: unknown): PushFromTx {
  const t = asObj(asObj(tx).transaction);
  const actions = Array.isArray(t.actions) ? t.actions : [];
  const call = actions.map((a) => asObj(asObj(a).FunctionCall)).find((fc) => fc.method_name === 'push_quotes');
  if (!call || typeof call.args !== 'string') throw new HouseVerifyError('the transaction has no push_quotes call');
  let args: unknown;
  try {
    args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
  } catch {
    throw new HouseVerifyError('the push_quotes arguments are not JSON');
  }
  const { quotes, commitment } = decodePushQuotesArgs(args);
  const status = asObj(asObj(tx).status);
  const logs: string[] = [];
  for (const r of Array.isArray(asObj(tx).receipts_outcome) ? (asObj(tx).receipts_outcome as unknown[]) : []) {
    const l = asObj(asObj(r).outcome).logs;
    if (Array.isArray(l)) for (const line of l) if (typeof line === 'string') logs.push(line);
  }
  const ev = houseEventsOf(logs).find((e) => e.event === 'quotes_pushed');
  return {
    signer: String(t.signer_id ?? ''),
    receiver: String(t.receiver_id ?? ''),
    succeeded: 'SuccessValue' in status && !('Failure' in status),
    quotes,
    commitment,
    event: ev ? decodeQuotesPushed(ev) : null,
  };
}

// ------------------------------------------------------------- the rows

// vi_history rows by id from the public REST API (the anon key reads them;
// the table is public).
export async function fetchPrintRows(fetchFn: FetchFn, supabaseUrl: string, anonKey: string, ids: bigint[]): Promise<PrintRow[]> {
  if (ids.length === 0) return [];
  const base = supabaseUrl.replace(/\/+$/, '');
  const url = `${base}/rest/v1/vi_history?select=id,market_id,vi,raw_vi,recorded_at&id=in.(${ids.map(String).join(',')})`;
  const res = await fetchFn(url, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, accept: 'application/json' } });
  if (!res.ok) throw new HouseVerifyError(`vi_history: the database answered HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new HouseVerifyError('vi_history: expected an array of rows');
  return body as PrintRow[];
}

// --------------------------------------------------------------- verify

export interface HousePushCheck {
  ok: boolean;
  txHash: string;
  push: PushFromTx;
  rows: number;
  references: Map<number, string>;
  result: QuoteVerifyResult;
  problems: string[];
}

export async function verifyPushFromChain(opts: {
  fetch: FetchFn;
  rpcUrl: string;
  contractId: string;
  senderId: string;
  txHash: string;
  supabaseUrl: string;
  anonKey: string;
}): Promise<HousePushCheck> {
  const tx = await rpcTx(opts.fetch, opts.rpcUrl, opts.txHash, opts.senderId);
  const push = pushFromTx(tx);
  if (!push.succeeded) throw new HouseVerifyError('the transaction failed on chain, so it pushed nothing');
  const problems: string[] = [];
  if (push.receiver !== opts.contractId) problems.push(`the transaction went to ${push.receiver}, not ${opts.contractId}`);
  if (!push.event) problems.push('no quotes_pushed event in the transaction');
  else {
    if (push.event.commitment !== push.commitment) problems.push(`the event's commitment ${String(push.event.commitment)} is not the call's ${push.commitment}`);
    if (push.event.count !== push.quotes.length) problems.push(`the event counts ${String(push.event.count)} quotes, the call has ${push.quotes.length}`);
  }

  const references = new Map<number, string>();
  for (const m of [...new Set(push.quotes.map((q) => q.market))]) {
    const v = await rpcView(opts.fetch, opts.rpcUrl, opts.contractId, 'get_market', marketArgs(m));
    if (v !== null) references.set(m, decodeMarket(v).reference);
  }
  const rows = await fetchPrintRows(opts.fetch, opts.supabaseUrl, opts.anonKey, push.quotes.map((q) => q.printId));
  const result = verifyQuotePush({ quotes: push.quotes, commitment: push.commitment, rows, references });
  problems.push(...result.problems);
  return { ok: problems.length === 0, txHash: opts.txHash, push, rows: rows.length, references, result, problems };
}
