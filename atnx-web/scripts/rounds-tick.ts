// Runs one keeper tick, the rounds steps included: Solana devnet when
// BM_ROUNDS_ENABLED=1, NEAR testnet when BM_NEAR_ROUNDS_ENABLED=1 (set
// either on the command line to try a chain's rounds locally without
// turning them on for the cron). Handy for on-camera timing on a fast
// series.
//
//   npm run rounds:tick                                     dry: nothing sent, nothing written
//   npm run rounds:tick -- --live                           a real tick
//   BM_NEAR_ROUNDS_ENABLED=1 npm run rounds:tick            dry, NEAR included
//   BM_ROUNDS_ENABLED=0 BM_NEAR_ROUNDS_ENABLED=1 npm run rounds:tick   dry, NEAR only
import { runKeeper } from '../lib/bm/keeper-run';

const live = process.argv.includes('--live');
const sol = process.env.BM_ROUNDS_ENABLED === '1';
const near = process.env.BM_NEAR_ROUNDS_ENABLED === '1';
if (!sol && !near) console.warn('neither BM_ROUNDS_ENABLED nor BM_NEAR_ROUNDS_ENABLED is 1: no rounds step will run');
else console.warn(`rounds steps: Solana ${sol ? 'on' : 'off'}, NEAR ${near ? 'on' : 'off'}${live ? ' (live)' : ' (dry)'}`);
runKeeper({ dry: !live })
  .then((rep) => {
    console.log(JSON.stringify({ ...rep, notes: undefined }, null, 2));
    for (const n of rep.notes) console.log('  ' + n);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
