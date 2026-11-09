// Public verification of settled NEAR rounds, with no secrets: what
// GET /api/near/rounds/settled and GET /api/near/rounds/verify answer, and
// what scripts/rounds-verify-public.ts checks on someone else's machine.
//
// A NEAR settle posts a commitment, the sha256 of the canonical JSON of the
// keeper's settle inputs (lib/bm/commitment.ts). The registry keeps those
// inputs in bm.rounds.settle_inputs. Anyone can fetch them from the site,
// read the round's commitment straight from the chain over public RPC, hash
// the inputs themselves and compare. The script does exactly that and never
// uses the site's own hash; the verify route does the same on the server so
// a browser can see the answer too.
//
// Only fetch and the commitment code: no Supabase, no keys. The route
// handlers take their registry reads as dependencies (lib/near/registry.ts
// in the app, fixtures in lib/near/verify.test.ts).
import { canonicalJson, sha256Hex, verifySettleInputs } from '../bm/commitment';
import { parseRound, parseSeries, type NearRound, type NearSeries } from '../bm/near';

export const PUBLIC_RPC = 'https://test.rpc.fastnear.com';
export const PUBLIC_SITE = 'https://atnx-near.vercel.app';
export const PUBLIC_CONTRACT = 'rounds.atnx.testnet';

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ------------------------------------------------------------------ RPC

// One view call over NEAR JSON-RPC (query / call_function at final
// finality), decoded from the JSON bytes the contract returned. Null for a
// view that returned nothing or JSON null.
export async function rpcView(fetchFn: FetchFn, rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'atnx-verify',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
      },
    }),
  });
  if (!res.ok) throw new Error(`${method}: the RPC answered HTTP ${res.status}`);
  const body = (await res.json()) as { error?: unknown; result?: { result?: number[]; error?: string } };
  if (body.error) throw new Error(`${method}: RPC error ${JSON.stringify(body.error).slice(0, 300)}`);
  if (body.result?.error) throw new Error(`${method}: ${String(body.result.error).slice(0, 300)}`);
  const bytes = body.result?.result;
  if (!Array.isArray(bytes)) throw new Error(`${method}: the RPC returned no result`);
  if (bytes.length === 0) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

export interface ChainSource {
  fetch: FetchFn;
  rpcUrl: string;
  contractId: string;
}

export async function readChainRound(src: ChainSource, seriesId: number, roundIndex: number): Promise<NearRound | null> {
  const v = await rpcView(src.fetch, src.rpcUrl, src.contractId, 'get_round', { series_id: seriesId, round_index: roundIndex });
  return v === null ? null : parseRound(v);
}

export async function readChainSeries(src: ChainSource, seriesId: number): Promise<NearSeries | null> {
  const v = await rpcView(src.fetch, src.rpcUrl, src.contractId, 'get_series', { series_id: seriesId });
  return v === null ? null : parseSeries(v);
}

// --------------------------------------------------------------- verify

export interface ChainCheck {
  // The sha256 of the canonical inputs equals the round's commitment on chain.
  match: boolean;
  // match, and every other check holds: the inputs name this series'
  // reference and this round, their window ends at the round's close and
  // spans the series' settlement window, their prints average to the posted
  // settle_e2, the round is settled.
  ok: boolean;
  canonical: string;
  recomputed: string;
  onchainCommitment: string;
  problems: string[];
}

// The settle inputs against the round and its series as read from the
// chain. `series` is the chain's view, so the inputs cannot claim to be
// another series' or another round's.
export function checkAgainstChain(inputs: unknown, round: NearRound, series: NearSeries | null, roundIndex: number): ChainCheck {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return { match: false, ok: false, canonical: '', recomputed: '', onchainCommitment: round.commitment, problems: ['no settle inputs'] };
  }
  const canonical = canonicalJson(inputs);
  const recomputed = sha256Hex(canonical);
  const res = verifySettleInputs(inputs, round, {
    reference: series?.reference,
    roundIndex,
    windowSecs: series?.settleWindowSecs,
  });
  const problems = [...res.problems];
  if (!series) problems.push('the series is not on chain');
  if (round.state !== 'settled') problems.push(`the round is ${round.state} on chain, not settled`);
  const match = recomputed === round.commitment;
  return { match, ok: match && problems.length === 0, canonical, recomputed, onchainCommitment: round.commitment, problems };
}

// -------------------------------------------------------- the routes

export interface SettledRoundRecord {
  onchainSeriesId: number;
  roundIndex: number;
  marketId: string;
  marketName: string | null;
  targetVi: number | null;
  settleVi: number | null;
  settlePrints: number | null;
  winner: string | null;
  settleTx: string | null;
  closeAt: string | null;
  settleCommitment: string | null;
}

export interface VerifyRecord extends SettledRoundRecord {
  state: string;
  settleInputs: unknown;
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

const txUrl = (hash: string | null) => (hash ? `https://testnet.nearblocks.io/txns/${hash}` : null);
const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

const MAX_U32 = 0xffff_ffff;

function positiveInt(v: string | null): number | null {
  if (v === null || !/^\d{1,10}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= MAX_U32 ? n : null;
}

// GET /api/near/rounds/settled?limit=N: the latest settled rounds, from the
// registry, with what to verify each by.
export async function handleSettled(deps: { listSettled: (limit: number) => Promise<SettledRoundRecord[]>; contractId: string }, params: URLSearchParams): Promise<RouteResult> {
  const raw = params.get('limit');
  const limit = raw === null ? 20 : positiveInt(raw);
  if (limit === null || limit > 50) return { status: 400, body: { error: 'bad_limit', detail: 'limit is 1 to 50' } };
  const rows = await deps.listSettled(limit);
  return {
    status: 200,
    body: {
      contract: deps.contractId,
      items: rows.map((r) => ({
        series: r.onchainSeriesId,
        round: r.roundIndex,
        market: r.marketName ?? 'Unknown market',
        marketId: r.marketId,
        target: num(r.targetVi),
        settleAverage: num(r.settleVi),
        prints: r.settlePrints,
        winner: r.winner,
        closeAt: r.closeAt,
        commitment: r.settleCommitment,
        settleTx: r.settleTx,
        settleTxUrl: txUrl(r.settleTx),
        verify: `/api/near/rounds/verify?series=${r.onchainSeriesId}&round=${r.roundIndex}`,
        verifyLocally: `npm run rounds:verify:public -- ${r.onchainSeriesId} ${r.roundIndex}`,
      })),
    },
  };
}

// GET /api/near/rounds/verify?series=<on-chain id>&round=<n>: the
// registry's canonical settle inputs and commitment, the round's commitment
// read live from the chain, the hash recomputed here, and whether they match.
export async function handleVerify(
  deps: { findRound: (onchainSeriesId: number, roundIndex: number) => Promise<VerifyRecord | null>; chain: ChainSource },
  params: URLSearchParams,
): Promise<RouteResult> {
  const series = positiveInt(params.get('series'));
  const round = positiveInt(params.get('round'));
  if (series === null || round === null) return { status: 400, body: { error: 'bad_request', detail: 'expected ?series=<on-chain series id>&round=<round index>' } };
  const rec = await deps.findRound(series, round);
  if (!rec) return { status: 404, body: { error: 'not_in_registry', series, round } };
  if (rec.state !== 'settled') return { status: 409, body: { error: 'not_settled', series, round, state: rec.state } };

  const [chainRound, chainSeries] = await Promise.all([readChainRound(deps.chain, series, round), readChainSeries(deps.chain, series)]);
  if (!chainRound) return { status: 404, body: { error: 'not_on_chain', series, round } };
  const c = checkAgainstChain(rec.settleInputs, chainRound, chainSeries, round);
  return {
    status: 200,
    body: {
      series,
      round,
      contract: deps.chain.contractId,
      rpc: deps.chain.rpcUrl,
      market: { id: rec.marketId, name: rec.marketName ?? 'Unknown market' },
      // The inputs as the registry holds them, keys in canonical order.
      settleInputs: c.canonical ? JSON.parse(c.canonical) : null,
      // The exact string whose sha256 is the commitment.
      canonical: c.canonical || null,
      registryCommitment: rec.settleCommitment,
      onchain: {
        state: chainRound.state,
        commitment: chainRound.commitment,
        targetE2: chainRound.targetE2.toString(),
        settleE2: chainRound.settleE2.toString(),
        closeAt: chainRound.closeAt,
        winner: chainRound.winner,
        reference: chainSeries?.reference ?? null,
        settleWindowSecs: chainSeries?.settleWindowSecs ?? null,
      },
      recomputed: c.recomputed || null,
      match: c.match,
      registryMatch: rec.settleCommitment === chainRound.commitment,
      ok: c.ok && rec.settleCommitment === chainRound.commitment,
      problems: c.problems,
      settleTx: rec.settleTx,
      settleTxUrl: txUrl(rec.settleTx),
      verifyLocally: `npm run rounds:verify:public -- ${series} ${round}`,
    },
  };
}

// ------------------------------------------------------------ the script

export interface PublicVerifyOptions {
  site: string;
  rpcUrl: string;
  contractId: string;
  // Both null: the latest settled round the site lists.
  series: number | null;
  round: number | null;
  fetch: FetchFn;
}

export interface PublicVerifyReport extends ChainCheck {
  series: number;
  round: number;
  site: string;
  rpcUrl: string;
  contractId: string;
  // What the site claimed, shown for comparison only; never used to decide.
  siteRecomputed: string | null;
  siteMatch: boolean | null;
  marketName: string | null;
  prints: number;
  averageE2: unknown;
  settleE2: string;
  winner: string | null;
}

async function getJson(fetchFn: FetchFn, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchFn(url, { method: 'GET', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: body ?? {} };
}

export class PublicVerifyError extends Error {}

// What scripts/rounds-verify-public.ts does: the settle inputs from the
// site, the round and its series from the chain over public RPC, the hash
// computed here. The site's own hash and verdict are reported, not trusted.
export async function verifyFromSite(o: PublicVerifyOptions): Promise<PublicVerifyReport> {
  const site = o.site.replace(/\/+$/, '');
  let series = o.series;
  let round = o.round;
  if (series === null || round === null) {
    const latest = await getJson(o.fetch, `${site}/api/near/rounds/settled?limit=1`);
    const item = (latest.body.items as Array<{ series?: unknown; round?: unknown }> | undefined)?.[0];
    if (latest.status !== 200 || !item || typeof item.series !== 'number' || typeof item.round !== 'number') {
      throw new PublicVerifyError(`the site lists no settled round (${site}/api/near/rounds/settled answered ${latest.status})`);
    }
    series = item.series;
    round = item.round;
  }

  const v = await getJson(o.fetch, `${site}/api/near/rounds/verify?series=${series}&round=${round}`);
  if (v.status !== 200) throw new PublicVerifyError(`the site has no settle inputs for series ${series} round ${round} (HTTP ${v.status} ${String(v.body.error ?? '')})`);
  const inputs = v.body.settleInputs;

  const chain: ChainSource = { fetch: o.fetch, rpcUrl: o.rpcUrl, contractId: o.contractId };
  const [chainRound, chainSeries] = await Promise.all([readChainRound(chain, series, round), readChainSeries(chain, series)]);
  if (!chainRound) throw new PublicVerifyError(`no round ${round} in series ${series} on ${o.contractId}`);
  const c = checkAgainstChain(inputs, chainRound, chainSeries, round);
  const s = (inputs ?? {}) as { prints?: unknown[]; average_e2?: unknown };
  return {
    ...c,
    series,
    round,
    site,
    rpcUrl: o.rpcUrl,
    contractId: o.contractId,
    siteRecomputed: typeof v.body.recomputed === 'string' ? v.body.recomputed : null,
    siteMatch: typeof v.body.match === 'boolean' ? v.body.match : null,
    marketName: (v.body.market as { name?: string } | undefined)?.name ?? null,
    prints: Array.isArray(s.prints) ? s.prints.length : 0,
    averageE2: s.average_e2 ?? null,
    settleE2: chainRound.settleE2.toString(),
    winner: chainRound.winner,
  };
}
