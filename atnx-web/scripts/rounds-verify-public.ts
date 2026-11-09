// Checks a settled NEAR round's oracle commitment from anywhere, with no
// env file and no keys:
//
//   npm run rounds:verify:public                     the latest settled round the site lists
//   npm run rounds:verify:public -- <series> <round> that round (series = the contract's id)
//     --site <url>       default https://atnx-near.vercel.app
//     --rpc <url>        default https://test.rpc.fastnear.com (public NEAR testnet RPC)
//     --contract <id>    default rounds.atnx.testnet
//
// It fetches the round's settle inputs from the site
// (/api/near/rounds/verify), reads the round and its series straight from
// the rounds contract over public RPC, canonicalises the inputs and computes
// their sha256 here (lib/bm/commitment.ts, the keeper's own code), and
// compares that with the round's commitment on chain. It also checks that
// the inputs name the series' reference and this round, that their window
// ends at the round's close, and that their prints average to the posted
// settle_e2. The site's own hash and verdict are printed for comparison and
// never used to decide.
//
// Exit code 0 and "OK" when everything matches, 1 and "MISMATCH" when
// anything does not, 2 when the round cannot be checked.
import { PUBLIC_CONTRACT, PUBLIC_RPC, PUBLIC_SITE, PublicVerifyError, verifyFromSite, type FetchFn } from '../lib/near/verify';

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function positional(): string[] {
  const out: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

// Every request gives up after 20 seconds.
const fetchWithTimeout: FetchFn = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

async function main() {
  const [seriesArg, roundArg] = positional();
  const series = seriesArg === undefined ? null : Number(seriesArg);
  const round = roundArg === undefined ? null : Number(roundArg);
  if ((series === null) !== (round === null) || (series !== null && (!Number.isSafeInteger(series) || series < 1 || !Number.isSafeInteger(round) || round! < 1))) {
    console.error('usage: npm run rounds:verify:public -- [<series> <round>] [--site <url>] [--rpc <url>] [--contract <id>]');
    process.exit(2);
  }
  const site = flag('--site') ?? PUBLIC_SITE;
  const rpcUrl = flag('--rpc') ?? PUBLIC_RPC;
  const contractId = flag('--contract') ?? PUBLIC_CONTRACT;

  const r = await verifyFromSite({ site, rpcUrl, contractId, series, round, fetch: fetchWithTimeout });
  console.log(`NEAR series ${r.series}, round ${r.round}${r.marketName ? ` (${r.marketName})` : ''}`);
  line('inputs from', `${r.site}/api/near/rounds/verify?series=${r.series}&round=${r.round}`);
  line('chain read from', `${r.rpcUrl}, contract ${r.contractId}`);
  line('on-chain commitment', r.onchainCommitment);
  line('sha256 computed here', r.recomputed || '(no inputs)');
  line("the site's own hash", r.siteRecomputed ?? '(none given)');
  line('prints', r.prints);
  line('inputs average_e2', r.averageE2);
  line('on-chain settle_e2', r.settleE2);
  line('winner', r.winner);
  if (r.siteRecomputed !== null && r.siteRecomputed !== r.recomputed) {
    console.log("  note: the site's hash differs from the one computed here; only the one computed here counts.");
  }
  if (r.ok) {
    console.log('OK: the inputs hash to the commitment on chain and average to the posted settle_e2.');
    return;
  }
  console.log('MISMATCH:');
  for (const p of r.problems) console.log(`  - ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof PublicVerifyError ? err.message : String((err as Error)?.message ?? err));
  process.exit(2);
});
