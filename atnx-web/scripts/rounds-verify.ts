// Checks a settled NEAR round's oracle commitment: reads the settle inputs
// the keeper stored in bm.rounds.settle_inputs, recomputes their sha256
// over the canonical JSON (lib/bm/commitment.ts) and compares it with the
// round's `commitment` on chain; recomputes the average from the prints and
// compares it with the posted settle_e2; and, unless --no-history, reads
// vi_history for the round's window again and says whether it still holds
// the same prints. Read-only: nothing is written or sent.
//
//   npm run rounds:verify -- <series-uuid-or-reference> <round>
//   npm run rounds:verify -- <series-uuid-or-reference> <round> --no-history
//   npm run rounds:verify -- --onchain <near-series-id> <round> --inputs <file.json>
//
// The last form needs no registry: it checks a saved inputs file (the
// NEAR e2e writes one per settle with --out) against the chain.
//
// Exit code 0 when everything matches, 1 on a mismatch, 2 when the round
// cannot be checked (not NEAR, not settled, no inputs).
import { readFileSync } from 'node:fs';
import { buildSettleInputs, canonicalJson, verifySettleInputs, ZERO_COMMITMENT } from '../lib/bm/commitment';
import { NEAR_CHAIN_KEY, getRound, getSeries, getSeriesByReference } from '../lib/bm/near';

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function positional(): string[] {
  const out: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inputs' || args[i] === '--onchain') {
      if (args[i] === '--onchain') out.push(args[i + 1] ?? '');
      i++;
      continue;
    }
    if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  const [who, roundArg] = positional();
  const idx = Number(roundArg);
  if (!who || !Number.isSafeInteger(idx) || idx < 1) {
    console.error('usage: npm run rounds:verify -- <series-uuid-or-reference> <round> [--no-history]');
    console.error('       npm run rounds:verify -- --onchain <near-series-id> <round> --inputs <file.json>');
    process.exit(2);
  }

  let seriesId: number;
  let stored: unknown;
  let registryCommitment: string | null = null;
  let expect: { marketId?: string; reference?: string; roundIndex: number; windowSecs?: number } = { roundIndex: idx };
  let marketId: string | null = null;

  const inputsPath = flag('--inputs');
  if (process.argv.includes('--onchain')) {
    if (!inputsPath) throw new Error('--onchain needs --inputs <file.json>');
    seriesId = Number(who);
    if (!Number.isSafeInteger(seriesId) || seriesId < 1) throw new Error(`not a NEAR series id: ${who}`);
    const chainSeries = await getSeries(seriesId);
    if (!chainSeries) throw new Error(`no series ${seriesId} on chain`);
    stored = JSON.parse(readFileSync(inputsPath, 'utf8'));
    expect = { reference: chainSeries.reference, roundIndex: idx, windowSecs: chainSeries.settleWindowSecs };
    console.log(`NEAR series ${seriesId} (reference ${chainSeries.reference}), round ${idx}, inputs from ${inputsPath}`);
  } else {
    const rr = await import('../lib/bm/rounds-registry');
    const series = await rr.findSeries(who);
    if (!series) throw new Error(`no registry series with id or reference ${who}`);
    console.log(`series ${series.id} (${series.chain}, market ${series.atnx_market_id}), round ${idx}`);
    if (series.chain !== NEAR_CHAIN_KEY) {
      console.log(`  ${series.chain} rounds settle with the zero commitment (${ZERO_COMMITMENT.slice(0, 8)}…); there is nothing to verify.`);
      process.exit(2);
    }
    const row = await rr.getRound(series.id, idx);
    if (!row) throw new Error(`no registry round ${idx} in series ${series.id}`);
    if (row.state !== 'settled') {
      console.log(`  round ${idx} is ${row.state} in the registry; only settled rounds carry a commitment.`);
      process.exit(2);
    }
    const onchain = series.onchain_series_id ?? (await getSeriesByReference(series.reference))?.id ?? null;
    if (!onchain) throw new Error(`series reference ${series.reference} not found on chain`);
    seriesId = Number(onchain);
    stored = row.settle_inputs ?? null;
    registryCommitment = row.settle_commitment ?? null;
    marketId = series.atnx_market_id;
    expect = { marketId: series.atnx_market_id, reference: series.reference, roundIndex: idx, windowSecs: series.settle_window_secs };
  }

  const chainRound = await getRound(seriesId, idx);
  if (!chainRound) throw new Error(`no round ${idx} in NEAR series ${seriesId}`);
  if (chainRound.state !== 'settled') {
    console.log(`  round ${idx} is ${chainRound.state} on chain; only settled rounds carry a commitment.`);
    process.exit(2);
  }
  if (!stored) {
    console.log('  no settle inputs stored for this round.');
    process.exit(2);
  }

  const res = verifySettleInputs(stored, chainRound, expect);
  const s = stored as { prints?: unknown[]; average_e2?: number };
  line('on-chain commitment', chainRound.commitment);
  line('recomputed sha256', res.hash);
  if (registryCommitment !== null) line('registry commitment', registryCommitment);
  line('on-chain settle_e2', chainRound.settleE2.toString());
  line('inputs average_e2', s.average_e2 ?? null);
  line('prints', Array.isArray(s.prints) ? s.prints.length : 0);
  line('winner', chainRound.winner);
  const problems = [...res.problems];
  if (registryCommitment !== null && registryCommitment !== chainRound.commitment) {
    problems.push(`registry settle_commitment ${registryCommitment} is not the on-chain commitment`);
  }

  if (marketId && !process.argv.includes('--no-history')) {
    const { settlementRows } = await import('../lib/bm/rounds-core');
    const window = expect.windowSecs!;
    const rows = await settlementRows(marketId, new Date(chainRound.closeAt * 1000), window);
    const now = buildSettleInputs({ marketId, reference: expect.reference!, roundIndex: idx, closeAt: chainRound.closeAt, windowSecs: window, rows });
    const same = now !== null && canonicalJson(now.prints) === canonicalJson(s.prints ?? []);
    line('vi_history now', same ? `the same ${now!.prints.length} prints` : `${now?.prints.length ?? 0} prints, which differ from the inputs`);
  }

  if (problems.length === 0) {
    console.log('OK: the stored inputs hash to the on-chain commitment and average to the posted settle_e2.');
    return;
  }
  console.log('MISMATCH:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error((err as Error).message ?? err);
  process.exit(2);
});
