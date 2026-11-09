import { NEAR_ROUNDS, isNearChain } from '@/lib/near/config';
import { listSettledNearRounds } from '@/lib/near/registry';
import { handleSettled } from '@/lib/near/verify';

// GET /api/near/rounds/settled?limit=20 (1 to 50) -> { contract, items: [{
//   series, round, market, marketId, target, settleAverage, prints, winner,
//   closeAt, commitment, settleTx, settleTxUrl, verify, verifyLocally }] }
// The latest settled NEAR rounds from the registry, newest close first;
// `series` is the contract's series id. Public, read only, no secrets: each
// item names the verify call and the command that checks it from anywhere
// (lib/near/verify.ts, scripts/rounds-verify-public.ts). NEAR build only.

const PUBLIC = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
  'Access-Control-Allow-Origin': '*',
};

export async function GET(request: Request) {
  if (!isNearChain() || !NEAR_ROUNDS) return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const r = await handleSettled({ listSettled: listSettledNearRounds, contractId: NEAR_ROUNDS }, new URL(request.url).searchParams);
    return Response.json(r.body, { status: r.status, headers: r.status === 200 ? PUBLIC : { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    console.error('[near/rounds/settled]', (err as Error)?.message ?? err);
    return Response.json({ error: 'server_error' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
