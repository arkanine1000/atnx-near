// Starts a series of VI rounds on an atnx market from the keeper, without
// the site (operations use). Pass a market uuid or a name fragment; with
// no argument it lists the ten liveliest candidates.
//
//   npm run rounds:start -- "Labubu"                  daily rounds on Solana devnet
//   npm run rounds:start -- <uuid> --fast             the hourly demo series
//   npm run rounds:start -- <uuid> --finder <pubkey>  someone else is the finder
//   npm run rounds:start -- <uuid> --dry              validate only
//   npm run rounds:start -- <uuid> --chain near       on NEAR testnet (finder: a NEAR account)
//
// The finder defaults to the keeper's wallet (BM_SOL_KEEPER_SECRET's key on
// Solana, BM_NEAR_KEEPER_ACCOUNT on NEAR).
import { createAdminClient } from '../lib/supabase/admin';
import { readLiveVi, viIsFresh } from '../lib/bm/open';
import { roundParams, type StartResult } from '../lib/bm/rounds-core';

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const finderArg = flag('--finder');
  const chain = (flag('--chain') ?? 'solana').toLowerCase();
  if (chain !== 'solana' && chain !== 'near') throw new Error(`--chain is solana or near, not ${chain}`);
  const arg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--finder' && args[i - 1] !== '--chain');
  const fast = args.includes('--fast');
  const dry = args.includes('--dry');
  const db = createAdminClient();
  if (!arg) {
    const { data } = await db
      .from('markets')
      .select('id, entity_name, current_vi, vi_state, vi_last_updated')
      .is('deleted_at', null)
      .eq('vi_state', 'live')
      .gt('current_vi', 0)
      .order('current_vi', { ascending: false })
      .limit(10);
    for (const m of data ?? []) {
      console.log(`${m.id}  VI ${Number(m.current_vi).toFixed(2).padStart(8)}  ${viIsFresh(m.vi_last_updated) ? 'fresh' : 'STALE'}  ${m.entity_name}`);
    }
    return;
  }
  let id = arg;
  if (!/^[0-9a-f-]{36}$/i.test(arg)) {
    const { data } = await db
      .from('markets')
      .select('id, entity_name')
      .is('deleted_at', null)
      .ilike('entity_name', `%${arg}%`)
      .limit(1);
    if (!data?.length) throw new Error(`no market matching ${arg}`);
    id = data[0].id;
    console.log(`matched ${data[0].entity_name} (${id})`);
  }
  console.log('VI', await readLiveVi(id));
  console.log(`${fast ? 'fast' : 'daily'} series on ${chain === 'near' ? 'NEAR testnet' : 'Solana devnet'}`, roundParams(fast));
  let r: StartResult;
  if (chain === 'near') {
    const [{ startNearSeriesForOps }, { nearKeeperAccountId }] = await Promise.all([import('../lib/bm/rounds-near'), import('../lib/bm/near')]);
    r = await startNearSeriesForOps({ atnxMarketId: id, finderWallet: finderArg ?? nearKeeperAccountId(), fast, dry });
  } else {
    const { keeperWallet, startSeries } = await import('../lib/bm/rounds');
    r = await startSeries({ atnxMarketId: id, finderWallet: finderArg ?? keeperWallet(), fast, dry });
  }
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
