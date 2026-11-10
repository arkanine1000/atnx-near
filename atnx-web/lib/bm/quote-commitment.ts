import { canonicalJson, canonicalTimestamp, sha256Hex } from './commitment';
import { referenceToUuid, uuidToReference, type QuoteIn } from './house-types';
import { toE2 } from './settle';

// The commitment a house quote push carries: the sha256 of a canonical JSON
// of the vi_history rows the quotes came from. Every input is a public row,
// so anyone can fetch the rows by id, rebuild the batch, hash it and compare
// with the push's `commitment` argument and its quotes_pushed event.
//
// The batch, version 2:
//
//   { "kind": "quotes",
//     "prints": [{ "at": "<ts>",           the row's recorded_at
//                  "id": 123456,           the vi_history row id
//                  "market": "<uuid>",     the ATNX market, lowercase
//                  "raw_vi": 513,          the reading
//                  "vi": 455.51 }, ...],   the score
//     "version": 2 }
//
// One print per market pushed, sorted by market, then by id. Timestamps and
// canonical JSON are those of the version 1 settle inputs (./commitment):
// UTC with six fractional digits and a Z, keys sorted, no whitespace,
// numbers as JSON.stringify writes them; the hash is 64 lowercase hex.
//
// Each pushed quote then carries score_e2 = toE2(vi), reading_e2 =
// toE2(raw_vi), print_id = id, print_at = the row's time in whole unix
// seconds, and read_at, the chain's clock just before the keeper read the
// row (not committed: it is a chain fact, not a database one, and the two
// clocks differ by seconds, so read_at may be earlier than print_at).

export const QUOTE_BATCH_VERSION = 2;
export const QUOTE_BATCH_KIND = 'quotes';

export interface QuotePrint {
  market: string;
  id: number;
  at: string;
  vi: number;
  raw_vi: number;
}

export interface QuoteBatch {
  version: typeof QUOTE_BATCH_VERSION;
  kind: typeof QUOTE_BATCH_KIND;
  prints: QuotePrint[];
}

// A vi_history row as PostgREST returns it.
export interface PrintRow {
  id: number | string;
  market_id: string;
  vi: number | string;
  raw_vi: number | string | null;
  recorded_at: string;
}

function finite(v: number | string | null, what: string): number {
  const n = v === null ? NaN : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what}: ${String(v)} is not a non-negative number`);
  return n;
}

function rowId(v: number | string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`vi_history id ${String(v)} is not a positive safe integer`);
  return n;
}

// Whole unix seconds of a recorded_at, floored.
export function printAtSecs(recordedAt: string): number {
  const iso = canonicalTimestamp(recordedAt);
  return Date.parse(`${iso.slice(0, 19)}Z`) / 1000;
}

export function quotePrintOf(row: PrintRow): QuotePrint {
  // Through the reference and back: lowercase, with dashes, validated.
  const market = referenceToUuid(uuidToReference(row.market_id));
  return {
    market,
    id: rowId(row.id),
    at: canonicalTimestamp(row.recorded_at),
    vi: finite(row.vi, `vi of row ${String(row.id)}`),
    raw_vi: finite(row.raw_vi, `raw_vi of row ${String(row.id)}`),
  };
}

export function sortQuotePrints(prints: QuotePrint[]): QuotePrint[] {
  return [...prints].sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : a.id - b.id));
}

// The batch for the rows behind one push, in any order. Throws on a row
// that cannot be committed (no reading, a bad id or time).
export function buildQuoteBatch(rows: PrintRow[]): QuoteBatch {
  return { version: QUOTE_BATCH_VERSION, kind: QUOTE_BATCH_KIND, prints: sortQuotePrints(rows.map(quotePrintOf)) };
}

export function quoteCommitment(batch: QuoteBatch): { json: string; hash: string } {
  const json = canonicalJson(batch);
  return { json, hash: sha256Hex(json) };
}

// The quote push_quotes takes for a row, read at `readAt` (chain time,
// unix seconds).
export function quoteFromRow(row: PrintRow, market: number, readAt: number): QuoteIn {
  const p = quotePrintOf(row);
  if (!Number.isSafeInteger(readAt) || readAt < 0) throw new Error(`read_at ${readAt} is not a unix time`);
  return { market, scoreE2: toE2(p.vi), readingE2: toE2(p.raw_vi), printId: BigInt(p.id), printAt: printAtSecs(row.recorded_at), readAt };
}

// Quotes in the batch's order (market uuid, then print id), so arguments
// and commitment line up one to one.
export function sortQuotesLike(quotes: QuoteIn[], uuidOf: (market: number) => string): QuoteIn[] {
  return [...quotes].sort((a, b) => {
    const ua = uuidOf(a.market);
    const ub = uuidOf(b.market);
    if (ua !== ub) return ua < ub ? -1 : 1;
    return a.printId < b.printId ? -1 : a.printId > b.printId ? 1 : 0;
  });
}

// ----------------------------------------------------------------- verify

export interface QuoteVerifyResult {
  ok: boolean;
  // The sha256 of the batch rebuilt from the rows ('' when it could not be
  // built).
  hash: string;
  json: string;
  problems: string[];
}

// Checks a push against the public rows: the quotes and commitment as the
// push carried them, the vi_history rows fetched by the quotes' print ids,
// and optionally each on-chain market's reference (from get_market), so a
// quote cannot claim another market's print.
export function verifyQuotePush(args: {
  quotes: QuoteIn[];
  commitment: string;
  rows: PrintRow[];
  references?: Map<number, string>;
}): QuoteVerifyResult {
  const problems: string[] = [];
  const { quotes, commitment } = args;
  if (!/^[0-9a-f]{64}$/.test(commitment)) problems.push(`commitment ${JSON.stringify(commitment)} is not 64 lowercase hex characters`);
  if (quotes.length === 0) problems.push('the push carries no quotes');

  const byId = new Map<string, PrintRow>();
  for (const r of args.rows) byId.set(String(r.id), r);

  const used: PrintRow[] = [];
  const seenMarkets = new Set<number>();
  const seenPrints = new Set<string>();
  for (const q of quotes) {
    const pid = q.printId.toString();
    if (seenMarkets.has(q.market)) problems.push(`market ${q.market} is quoted more than once`);
    seenMarkets.add(q.market);
    if (seenPrints.has(pid)) problems.push(`print ${pid} is quoted more than once`);
    seenPrints.add(pid);
    const row = byId.get(pid);
    if (!row) {
      problems.push(`print ${pid} (market ${q.market}) is not among the rows`);
      continue;
    }
    used.push(row);
    let p: QuotePrint;
    try {
      p = quotePrintOf(row);
    } catch (err) {
      problems.push(`print ${pid}: ${(err as Error).message}`);
      continue;
    }
    if (q.scoreE2 !== toE2(p.vi)) problems.push(`print ${pid}: score_e2 ${q.scoreE2} is not toE2(vi ${p.vi}) = ${toE2(p.vi)}`);
    if (q.readingE2 !== toE2(p.raw_vi)) problems.push(`print ${pid}: reading_e2 ${q.readingE2} is not toE2(raw_vi ${p.raw_vi}) = ${toE2(p.raw_vi)}`);
    const at = printAtSecs(row.recorded_at);
    if (q.printAt !== at) problems.push(`print ${pid}: print_at ${q.printAt} is not the row's time ${at}`);
    const ref = args.references?.get(q.market);
    if (args.references && ref === undefined) problems.push(`market ${q.market} has no reference on chain`);
    if (ref !== undefined && ref !== uuidToReference(p.market)) problems.push(`print ${pid} belongs to market ${p.market}, but on-chain market ${q.market} is ${ref}`);
  }

  let json = '';
  let hash = '';
  try {
    ({ json, hash } = quoteCommitment(buildQuoteBatch(used)));
    if (used.length === quotes.length && hash !== commitment) problems.push(`the rows hash to ${hash}, the push committed to ${commitment}`);
  } catch (err) {
    problems.push(`the batch cannot be rebuilt: ${(err as Error).message}`);
  }
  return { ok: problems.length === 0, hash, json, problems };
}
