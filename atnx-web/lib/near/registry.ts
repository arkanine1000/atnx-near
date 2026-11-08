// Registry reads for the NEAR rounds: the bm.series rows with chain
// 'near:testnet' and their rounds (supabase/bm/002_rounds.sql). Read only;
// the keeper writes them. Uses no column beyond 002's plus `chain` and
// `reference`: the chain side is found by get_series_by_reference.
import { createAdminClient } from '@/lib/supabase/admin';
import { recentRounds } from '@/lib/bm/rounds-registry';
import type { BmRoundRow, BmSeriesRow } from '@/lib/supabase/database-bm';
import { NEAR_CHAIN_KEY } from './config';

function bm() {
  return createAdminClient().schema('bm');
}

// The running NEAR series of one atnx market (the daily one first, then
// the fast demo one) with its rounds, newest first, for the market page.
export async function getNearSeriesForMarket(atnxMarketId: string): Promise<{ series: BmSeriesRow; rounds: BmRoundRow[] } | null> {
  const { data, error } = await bm()
    .from('series')
    .select('*')
    .eq('atnx_market_id', atnxMarketId)
    .eq('chain', NEAR_CHAIN_KEY)
    .in('state', ['pending', 'active', 'paused'])
    .order('fast', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const series = data as BmSeriesRow;
  return { series, rounds: await recentRounds(series.id, 50) };
}

// Every NEAR series that reached the chain, whatever its state, so a
// position found on chain can be named by its market.
export async function listNearSeries(limit = 500): Promise<BmSeriesRow[]> {
  const { data, error } = await bm()
    .from('series')
    .select('*')
    .eq('chain', NEAR_CHAIN_KEY)
    .in('state', ['active', 'paused', 'ended'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BmSeriesRow[];
}
