// Runs one house keeper run by hand: the five-minute tick, or with --fast
// the every-minute run. Dry by default: it reads the database and the
// chain, sends nothing and writes nothing, and prints what it would do.
//
//   npm run house:tick                                      dry five-minute tick
//   npm run house:tick -- --fast                            dry every-minute run
//   BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live    a real tick
//   BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live --fast
//
// --live refuses to run unless BM_NEAR_HOUSE_ENABLED=1, as the cron routes
// do. The contract is NEXT_PUBLIC_BM_NEAR_HOUSE (default house.atnx.testnet).
import { houseEnabled, houseEnv } from '../lib/bm/house-near';
import { tickHouse, tickHouseFast } from '../lib/bm/house-keeper';

const live = process.argv.includes('--live');
const fast = process.argv.includes('--fast');

async function main() {
  if (live && !houseEnabled()) {
    console.error('--live needs BM_NEAR_HOUSE_ENABLED=1');
    process.exit(2);
  }
  console.warn(`house keeper, ${fast ? 'every-minute run' : 'five-minute tick'} on ${houseEnv().house}${live ? ' (live)' : ' (dry)'}`);
  const rep = fast ? await tickHouseFast({ dry: !live, force: true }) : await tickHouse({ dry: !live });
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
