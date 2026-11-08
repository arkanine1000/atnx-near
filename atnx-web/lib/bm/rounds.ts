import { PublicKey } from '@solana/web3.js';
import type { BmSeriesRow } from '@/lib/supabase/database-bm';
import {
  SETTLE_DELAY_SECS,
  roundParams,
  settlementFrom,
  settlementRows,
  startSeriesOn,
  tickRoundsOn,
  type ChainRound,
  type RoundParams,
  type RoundsChain,
  type RoundsCounts,
  type RoundsLog,
  type StartInput,
  type StartResult,
  type TickContext,
} from './rounds-core';
import {
  PROGRAM_ID,
  SOL_CHAIN_KEY,
  ensureKeeperUsdg,
  keeperKeypair,
  pdas,
  readPosition,
  readRound,
  readSeries,
  refFromHex,
  sendClaim,
  sendCommit,
  sendCreateSeries,
  sendOpenRound,
  sendSetSeries,
  sendSettle,
  sendVoid,
  type RoundAccount,
  type SeriesAccount,
} from './sol';

// Rolling VI rounds on Solana devnet (programs/vi_rounds): the Solana side
// of the rounds keeper. The orchestration (start a series, the six steps of
// a tick, reconciliation, dry mode) is shared with NEAR in ./rounds-core;
// this file is the Solana chain under it, PDAs and the keeper keypair from
// ./sol. Rows are bm.series.chain = 'solana:devnet'. The rounds step runs
// with BM_ROUNDS_ENABLED=1; NEAR's is ./rounds-near.

export { SETTLE_DELAY_SECS, roundParams };
export type { RoundParams, RoundsCounts, RoundsLog, StartInput, StartResult, TickContext };

export function roundsEnabled(): boolean {
  return process.env.BM_ROUNDS_ENABLED === '1';
}

// The series reference as stored at start; never recomputed from the
// market id, since each series carries its own nonce.
function refOf(series: BmSeriesRow): Uint8Array {
  return refFromHex(series.reference);
}

function key(k: PublicKey | string): string {
  return typeof k === 'string' ? k : k.toBase58();
}

function chainRound(acct: RoundAccount): ChainRound {
  return {
    state: acct.state,
    winner: acct.winner,
    presaleUp: acct.presaleUp,
    presaleDown: acct.presaleDown,
    openedAt: acct.openedAt,
    closeAt: acct.closeAt,
    tradeUntil: acct.tradeUntil,
    targetE2: acct.targetE2,
    settleE2: acct.settleE2,
    commitment: null,
  };
}

// The program reads the commitment as 32 zero bytes when none is passed
// (sendSettle's default); Solana settles carry no oracle commitment.
export const solanaChain: RoundsChain<SeriesAccount> = {
  key: SOL_CHAIN_KEY,
  programId: () => PROGRAM_ID.toBase58(),
  parseFinder(wallet: string): string | null {
    try {
      return new PublicKey(wallet).toBase58();
    } catch {
      return null;
    }
  },
  commitsInputs: false,

  readSeries: (series) => readSeries(pdas(refOf(series)).series),
  async readRound(series, idx) {
    const acct = await readRound(pdas(refOf(series)).round(idx));
    return acct ? chainRound(acct) : null;
  },
  async hasKeeperPosition(series, idx) {
    const p = pdas(refOf(series));
    return (await readPosition(p.position(p.round(idx), keeperKeypair().publicKey))) !== null;
  },
  roundKey: (series, idx) => pdas(refOf(series)).round(idx).toBase58(),
  activePatch: (series) => ({ series_pubkey: pdas(refOf(series)).series.toBase58() }),

  async createSeries(a) {
    const res = await sendCreateSeries({
      ref: refFromHex(a.reference),
      roundSecs: a.roundSecs,
      settleWindowSecs: a.settleWindowSecs,
      ante: a.ante,
      finder: new PublicKey(a.finder),
    });
    return { tx: res.sig, active: { series_pubkey: key(res.series) }, firstRoundKey: key(res.round) };
  },
  commit: (series, idx, side, amount) => sendCommit({ ref: refOf(series), roundIndex: idx, side, amount }),
  async openRound(series, idx, targetE2) {
    const res = await sendOpenRound({ ref: refOf(series), roundIndex: idx, targetE2 });
    return { tx: res.sig, nextRoundKey: key(res.nextRound) };
  },
  settle: (series, idx, settleE2) => sendSettle({ ref: refOf(series), roundIndex: idx, settleE2 }),
  voidRound: (series, idx) => sendVoid({ ref: refOf(series), roundIndex: idx }),
  pauseSeries: (series) => sendSetSeries({ ref: refOf(series), paused: true }),
  claim: (series, idx) => sendClaim({ ref: refOf(series), roundIndex: idx }),
  async ensureKeeperUsdg(minimum) {
    await ensureKeeperUsdg(minimum);
  },
};

// Starts a series of rounds on an atnx market (see startSeriesOn).
export function startSeries(input: StartInput): Promise<StartResult> {
  return startSeriesOn(solanaChain, input);
}

// The mean of the VI prints recorded in [close − window, close].
export async function settlementAverage(
  atnxMarketId: string,
  closeAt: Date,
  windowSecs: number
): Promise<{ avg: number | null; prints: number }> {
  const { avg, prints } = settlementFrom(await settlementRows(atnxMarketId, closeAt, windowSecs), null);
  return { avg, prints };
}

// The keeper's rounds step on Solana devnet (step 4 of keeper-run.ts).
export function tickRounds(ctx: TickContext): Promise<void> {
  return tickRoundsOn(solanaChain, ctx);
}

// The keeper's wallet, for scripts that default the finder to it.
export function keeperWallet(): string {
  return keeperKeypair().publicKey.toBase58();
}
