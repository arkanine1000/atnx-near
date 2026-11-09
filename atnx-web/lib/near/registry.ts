// Registry reads for the NEAR rounds: the bm.series rows with chain
// 'near:testnet' and their rounds (supabase/bm/002_rounds.sql). Read only;
// the keeper writes them. Uses no column beyond 002's plus `chain` and
// `reference`: the chain side is found by get_series_by_reference.
import { createAdminClient } from '@/lib/supabase/admin';
import { loadMarketMeta } from '@/lib/bm/market-meta';
import { recentRounds } from '@/lib/bm/rounds-registry';
import type { BmRoundRow, BmSeriesRow } from '@/lib/supabase/database-bm';
import { NEAR_CHAIN_KEY, NEAR_ROUNDS } from './config';
import type { SettledRoundRecord, VerifyRecord } from './verify';

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

// ------------------------------------------------- public verification

type SeriesKey = Pick<BmSeriesRow, 'id' | 'atnx_market_id' | 'onchain_series_id'>;

function record(r: BmRoundRow, s: SeriesKey, names: Map<string, { name: string }>): SettledRoundRecord {
  return {
    onchainSeriesId: Number(s.onchain_series_id),
    roundIndex: r.idx,
    marketId: s.atnx_market_id,
    marketName: names.get(s.atnx_market_id)?.name ?? null,
    targetVi: r.target_vi,
    settleVi: r.settle_vi,
    settlePrints: r.settle_prints,
    winner: r.winner,
    settleTx: r.settle_tx,
    closeAt: r.close_at,
    settleCommitment: r.settle_commitment ?? null,
  };
}

// The latest settled rounds of NEAR series on this site's contract, newest
// close first (GET /api/near/rounds/settled). Read only.
export async function listSettledNearRounds(limit: number): Promise<SettledRoundRecord[]> {
  const { data, error } = await bm()
    .from('rounds')
    .select('*, series!inner(id, chain, program_id, onchain_series_id, atnx_market_id)')
    .eq('series.chain', NEAR_CHAIN_KEY)
    .eq('series.program_id', NEAR_ROUNDS)
    .not('series.onchain_series_id', 'is', null)
    .eq('state', 'settled')
    .order('close_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<BmRoundRow & { series: SeriesKey }>;
  const names = await loadMarketMeta(Array.from(new Set(rows.map((r) => r.series.atnx_market_id))));
  return rows.map(({ series, ...r }) => record(r as BmRoundRow, series, names));
}

// One NEAR round by its on-chain series id and index, with its stored settle
// inputs (GET /api/near/rounds/verify). Read only.
export async function findNearRoundForVerify(onchainSeriesId: number, roundIndex: number): Promise<VerifyRecord | null> {
  const { data: series, error } = await bm()
    .from('series')
    .select('id, atnx_market_id, onchain_series_id')
    .eq('chain', NEAR_CHAIN_KEY)
    .eq('program_id', NEAR_ROUNDS)
    .eq('onchain_series_id', onchainSeriesId)
    .maybeSingle();
  if (error) throw error;
  if (!series) return null;
  const { data: round, error: rErr } = await bm().from('rounds').select('*').eq('series_id', series.id).eq('idx', roundIndex).maybeSingle();
  if (rErr) throw rErr;
  if (!round) return null;
  const r = round as BmRoundRow;
  const names = await loadMarketMeta([series.atnx_market_id]);
  return { ...record(r, series as SeriesKey, names), state: r.state, settleInputs: r.settle_inputs ?? null };
}
