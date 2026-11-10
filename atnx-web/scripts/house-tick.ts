// Runs one house keeper run by hand: the five-minute tick, with --fast the
// every-minute run, or with --list a listing of every eligible atnx.app
// market in one go (for the first deploy: one list_market after the other,
// no time budget). Dry by default: it reads the database and the chain,
// sends nothing and writes nothing, and prints what it would do.
//
//   npm run house:tick                                      dry five-minute tick
//   npm run house:tick -- --fast                            dry every-minute run
//   npm run house:tick -- --list                            dry listing of every eligible market
//   BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live    a real tick
//   BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live --fast
//   BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live --list
//
// --live refuses to run unless BM_NEAR_HOUSE_ENABLED=1, as the cron routes
// do. The contract is NEXT_PUBLIC_BM_NEAR_HOUSE (default house.atnx.testnet).
import { houseEnabled, houseEnv } from '../lib/bm/house-near';
import { listHouseMarkets, tickHouse, tickHouseFast } from '../lib/bm/house-keeper';

const live = process.argv.includes('--live');
const fast = process.argv.includes('--fast');
const list = process.argv.includes('--list');

async function main() {
  if (live && !houseEnabled()) {
    console.error('--live needs BM_NEAR_HOUSE_ENABLED=1');
    process.exit(2);
  }
  if (fast && list) {
    console.error('--fast and --list are separate runs; pick one');
    process.exit(2);
  }
  const what = list ? 'listing of every eligible market' : fast ? 'every-minute run' : 'five-minute tick';
  console.warn(`house keeper, ${what} on ${houseEnv().house}${live ? ' (live)' : ' (dry)'}`);
  const rep = list ? await listHouseMarkets({ dry: !live }) : fast ? await tickHouseFast({ dry: !live, force: true }) : await tickHouse({ dry: !live });
  console.log(JSON.stringify({ ...rep, notes: undefined }, null, 2));
  for (const n of rep.notes) console.log('  ' + n);
  if (rep.stopped) {
    console.error(`stopped: ${rep.stopped}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
