// Checks a house quote push from anywhere, with no keys:
//
//   npm run house:verify:public -- <tx hash>
//     --sender <id>        the account that sent it, default keeper.atnx.testnet
//     --contract <id>      default house.atnx.testnet
//     --rpc <url>          default https://test.rpc.fastnear.com (public NEAR testnet RPC)
//     --supabase-url <url> the database's public URL (else NEXT_PUBLIC_SUPABASE_URL)
//     --anon-key <key>     its public anon key, the one the site's pages use
//                          (else NEXT_PUBLIC_SUPABASE_ANON_KEY)
//
// It reads the transaction from the public RPC (the push_quotes arguments
// and the quotes_pushed event), reads each quoted market's reference from
// the contract, fetches the vi_history rows by id with the anon key,
// rebuilds the committed batch and hashes it here (lib/bm/quote-commitment.ts,
// the keeper's own code), and compares it with the commitment in the call
// and in the event. It also checks that every quote's score_e2 and
// reading_e2 are the rows' vi and raw_vi in hundredths, that print_at is the
// row's time, and that each print belongs to the market it was pushed for.
// The commitment covers every quote in the call, including any the contract
// skipped; the event's counts are printed.
//
// Exit code 0 and "OK" when everything matches, 1 and "MISMATCH" when
// anything does not, 2 when the push cannot be checked.
import { PUBLIC_RPC, type FetchFn } from '../lib/near/verify';
import { HouseVerifyError, PUBLIC_HOUSE_CONTRACT, PUBLIC_KEEPER, verifyPushFromChain } from '../lib/near/house-verify';

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
  const [txHash] = positional();
  const supabaseUrl = flag('--supabase-url') ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = flag('--anon-key') ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!txHash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash) || !supabaseUrl || !anonKey) {
    console.error('usage: npm run house:verify:public -- <tx hash> [--sender <id>] [--contract <id>] [--rpc <url>] --supabase-url <url> --anon-key <key>');
    process.exit(2);
  }
  const r = await verifyPushFromChain({
    fetch: fetchWithTimeout,
    rpcUrl: flag('--rpc') ?? PUBLIC_RPC,
    contractId: flag('--contract') ?? PUBLIC_HOUSE_CONTRACT,
    senderId: flag('--sender') ?? PUBLIC_KEEPER,
    txHash,
    supabaseUrl,
    anonKey,
  });
  console.log(`house quote push ${txHash}`);
  line('sent by', r.push.signer);
  line('to', r.push.receiver);
  line('quotes', r.push.quotes.length);
  line('taken by the contract', r.push.event?.accepted ?? '(unknown)');
  line('skipped by the contract', r.push.event?.skipped ?? '(unknown)');
  line('rows found', r.rows);
  line('commitment in the call', r.push.commitment);
  line('commitment in the event', r.push.event?.commitment ?? '(no event)');
  line('sha256 computed here', r.result.hash || '(could not rebuild)');
  if (r.ok) {
    console.log('OK: the rows hash to the commitment on chain and every quote matches its row.');
    return;
  }
  console.log('MISMATCH:');
  for (const p of r.problems) console.log(`  - ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof HouseVerifyError ? err.message : String((err as Error)?.message ?? err));
  process.exit(2);
});
