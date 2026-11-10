import { NEAR_HOUSE, NEAR_RPC, isNearChain } from '@/lib/near/config';
import { PUBLIC_HOUSE_CONTRACT } from '@/lib/near/house-verify';
import { handleHouseVerify } from '@/lib/near/house-public';
import type { FetchFn } from '@/lib/near/verify';

// GET /api/near/house/verify?tx=<transaction hash>
//   -> 200 { tx, txUrl, contract, keeper, rpc, quotes, accepted, skipped,
//            rowsFound, hashes: { call, event, recomputed }, canonical, ok,
//            problems, compared: [{ market, reference, printId, scoreE2,
//            readingE2, printAt, readAt, row }] }
//   -> 400 bad_request, 404 unknown_transaction, 409 not_final,
//      422 not_a_push | not_a_house_push | failed_on_chain,
//      502 rpc_error | db_error, 503 not_configured
// One house quote push, checked: the transaction read from public RPC, the
// contract's keeper and its markets' references read from the contract,
// the vi_history rows fetched by id from the public REST API with the anon
// key (what anyone can read), the batch rebuilt and hashed here and
// compared with the commitment in the call and in its quotes_pushed event,
// and every quote's numbers against its row (verifyQuotePush,
// lib/bm/quote-commitment.ts). `canonical` is the exact string hashed.
// Public, read only, no secrets (lib/near/house-public.ts); the same check
// runs anywhere with `npm run house:verify:public`. NEAR build only.

export const maxDuration = 30;

const OK = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300', 'Access-Control-Allow-Origin': '*' };
const ERROR = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

// Every request gives up after 10 seconds.
const fetchWithTimeout: FetchFn = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

export async function GET(request: Request) {
  if (!isNearChain()) return Response.json({ error: 'not_found' }, { status: 404, headers: ERROR });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anonKey) return Response.json({ error: 'not_configured' }, { status: 503, headers: ERROR });
  try {
    const r = await handleHouseVerify(
      { fetch: fetchWithTimeout, rpcUrl: NEAR_RPC, contractId: NEAR_HOUSE || PUBLIC_HOUSE_CONTRACT, supabaseUrl, anonKey },
      new URL(request.url).searchParams,
    );
    return Response.json(r.body, { status: r.status, headers: r.status === 200 ? OK : ERROR });
  } catch (err) {
    console.error('[near/house/verify]', (err as Error)?.message ?? err);
    return Response.json({ error: 'server_error' }, { status: 500, headers: ERROR });
  }
}
