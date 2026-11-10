import { createAdminClient } from '@/lib/supabase/admin';
import { NEAR_HOUSE, isNearChain } from '@/lib/near/config';
import { PUBLIC_HOUSE_CONTRACT } from '@/lib/near/house-verify';
import { PUSH_ACTIONS, handleHousePushes, type KeeperLogRow } from '@/lib/near/house-public';

// GET /api/near/house/pushes?limit=20 (1 to 20) -> { contract, items: [{
//   txHash, at, run, quotes, accepted, skipped, commitment, readAt, txUrl,
//   verify }] }
// The house keeper's newest quote pushes to the house contract, newest
// first, from the rows it writes to bm.keeper_log (lib/bm/house-keeper.ts):
// the five-minute run ('tick'), the every-minute run ('fast') and quotes on
// demand ('on_demand'). Each item names the verify call that checks it.
// Public, read only, no secrets (lib/near/house-public.ts). NEAR build only.

const PUBLIC = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
  'Access-Control-Allow-Origin': '*',
};
const ERROR = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

// The newest house transactions the keeper logged as landed.
async function recentRows(n: number): Promise<KeeperLogRow[]> {
  const { data, error } = await createAdminClient()
    .schema('bm')
    .from('keeper_log')
    .select('action, detail, tx_hash, created_at')
    .in('action', [...PUSH_ACTIONS])
    .not('tx_hash', 'is', null)
    .is('error', null)
    .order('created_at', { ascending: false })
    .limit(n);
  if (error) throw error;
  return (data ?? []) as KeeperLogRow[];
}

export async function GET(request: Request) {
  if (!isNearChain()) return Response.json({ error: 'not_found' }, { status: 404, headers: ERROR });
  try {
    const r = await handleHousePushes({ recentRows, contractId: NEAR_HOUSE || PUBLIC_HOUSE_CONTRACT }, new URL(request.url).searchParams);
    return Response.json(r.body, { status: r.status, headers: r.status === 200 ? PUBLIC : ERROR });
  } catch (err) {
    console.error('[near/house/pushes]', (err as Error)?.message ?? err);
    return Response.json({ error: 'server_error' }, { status: 500, headers: ERROR });
  }
}
