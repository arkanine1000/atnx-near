import { createAdminClient } from '@/lib/supabase/admin';
import type { BmAnteSide, BmRoundRow, BmSeriesRow } from '@/lib/supabase/database-bm';
import { buildSettleInputs, settleCommitment, type SettleInputs, type SettleRow } from './commitment';
import { MAX_VI_AGE_MIN, readLiveVi, viIsFresh } from './open';
import * as rr from './rounds-registry';
import type { ClaimSeriesInput, RoundWithSeries, SeriesActivePatch } from './rounds-registry';
import { averageVi, fromE2, settleWindow, toE2, winnerOf } from './settle';
import { newSeriesRef, refToHex } from './series-ref';

// Rolling VI rounds, chain by chain: starting a series on an atnx market,
// and the keeper's rounds step. The contract (programs/vi_rounds on Solana
// devnet, near/rounds on NEAR testnet) holds the money and enforces the
// rules; this file decides when to call it and keeps the registry
// (bm.series, bm.rounds) in step with it. Whenever the two disagree, the
// chain wins. Each chain plugs in through a RoundsChain (./rounds.ts for
// Solana, ./rounds-near.ts for NEAR), and the registry rows of one chain
// are never touched by another's step.
//
// One tick, in this order (settling N frees the live slot that opening
// N+1 needs, and opening N+1 frees the presale slot for N+2):
//
//   1. reconcile rounds a previous run left `opening` or `settling`;
//   2. pending series (start crashed half way) → create on chain;
//   3. live rounds past close + delay → average the window's VI prints →
//      settle (or void when no print arrived 30 minutes after the close);
//      on a chain that takes an oracle commitment, the settle carries the
//      sha256 of the inputs and the registry keeps the inputs;
//   4. presale rounds whose time has come → ante an empty side → open at
//      the current VI → insert the next presale, opening at the close;
//   5. paused series → void their presale round (refunds; the series ends);
//   6. settled or void rounds the keeper anted on → claim its position
//      (payout or refund).
//
// Dry mode reads everything and logs `would-*`, and writes nothing.

function envNum(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

export interface RoundParams {
  roundSecs: number;
  settleWindowSecs: number;
  firstPresaleSecs: number;
  anteUsdg: number;
}

export function roundParams(fast: boolean): RoundParams {
  return fast
    ? {
        roundSecs: envNum('BM_FAST_ROUND_SECS', 3600),
        settleWindowSecs: envNum('BM_FAST_SETTLE_WINDOW_SECS', 900),
        firstPresaleSecs: envNum('BM_FAST_FIRST_PRESALE_SECS', 600, 0),
        anteUsdg: envNum('BM_ANTE_USDG', 10),
      }
    : {
        roundSecs: envNum('BM_ROUND_SECS', 86400),
        settleWindowSecs: envNum('BM_SETTLE_WINDOW_SECS', 1800),
        firstPresaleSecs: envNum('BM_FIRST_PRESALE_SECS', 3600, 0),
        anteUsdg: envNum('BM_ANTE_USDG', 10),
      };
}

// Settle this long after the close, so the window's last prints land.
export const SETTLE_DELAY_SECS = envNum('BM_SETTLE_DELAY_SECS', 300, 0);
// A live round with no print in its window is voided this long after
// its close (everyone is refunded).
export const VOID_AFTER_MS = 30 * 60_000;
// A row in flight (or a pending series) younger than this may belong to a
// run that is still going; leave it alone.
export const IN_FLIGHT_GRACE_MS = 2 * 60_000;

export const USDG_DECIMALS = 6;
const USDG_UNITS = 10 ** USDG_DECIMALS;

export function usdgUnits(usdg: number): bigint {
  return BigInt(Math.round(usdg * USDG_UNITS));
}

export function unitsUsdg(units: bigint): number {
  return Number(units) / USDG_UNITS;
}

function isoFromUnix(secs: number): string {
  return new Date(secs * 1000).toISOString();
}

// ------------------------------------------------------------ the chain

export type ChainRoundState = 'none' | 'presale' | 'live' | 'settled' | 'void';
export type ChainSide = 'up' | 'down';

// What the keeper needs to know about a round on chain.
export interface ChainRound {
  state: ChainRoundState;
  winner: ChainSide | null;
  presaleUp: bigint;
  presaleDown: bigint;
  openedAt: number;
  closeAt: number;
  tradeUntil: number;
  targetE2: bigint;
  settleE2: bigint;
  // The oracle commitment posted at settle, hex; null on a chain that
  // keeps none.
  commitment: string | null;
}

export interface ChainSeries {
  paused: boolean;
  liveRound: number;
  presaleRound: number;
  ante: bigint;
}

// One chain's contract, as the keeper drives it. A series is named by its
// registry row; the adapter finds it on chain from the row's reference
// (and, on NEAR, the numeric id). Every send returns the transaction id.
export interface RoundsChain<S extends ChainSeries = ChainSeries> {
  // bm.series.chain for this chain's rows.
  key: string;
  // bm.series.program_id for new rows: the program id or contract account.
  programId(): string;
  // A finder wallet in its canonical form, or null when it is not one.
  parseFinder(wallet: string): string | null;
  // Whether settle carries a commitment to the oracle inputs and the
  // registry stores them (bm.rounds.settle_inputs, settle_commitment).
  commitsInputs: boolean;

  readSeries(series: BmSeriesRow): Promise<S | null>;
  readRound(series: BmSeriesRow, idx: number): Promise<ChainRound | null>;
  hasKeeperPosition(series: BmSeriesRow, idx: number): Promise<boolean>;
  // bm.rounds.round_pubkey for a round, or null on a chain without round
  // addresses.
  roundKey(series: BmSeriesRow, idx: number): string | null;
  // The registry fields that record where an existing series lives.
  activePatch(series: BmSeriesRow, acct: S): SeriesActivePatch;

  createSeries(a: { reference: string; roundSecs: number; settleWindowSecs: number; ante: bigint; finder: string }): Promise<{
    tx: string;
    active: SeriesActivePatch;
    firstRoundKey: string | null;
  }>;
  commit(series: BmSeriesRow, idx: number, side: ChainSide, amount: bigint): Promise<string>;
  openRound(series: BmSeriesRow, idx: number, targetE2: bigint): Promise<{ tx: string; nextRoundKey: string | null }>;
  settle(series: BmSeriesRow, idx: number, settleE2: bigint, commitment: string | null): Promise<string>;
  voidRound(series: BmSeriesRow, idx: number): Promise<string>;
  pauseSeries(series: BmSeriesRow): Promise<string>;
  claim(series: BmSeriesRow, idx: number): Promise<string>;
  ensureKeeperUsdg(minimum: bigint): Promise<void>;
}

// ------------------------------------------------------- the registry

export type RoundsRegistry = Pick<
  typeof rr,
  | 'claimSeries'
  | 'hasRunningSeries'
  | 'markSeriesActive'
  | 'markSeriesFailed'
  | 'updateSeries'
  | 'getSeries'
  | 'listPendingSeries'
  | 'insertPresale'
  | 'transitionRound'
  | 'updateRound'
  | 'getRound'
  | 'listDueLive'
  | 'listPresaleReady'
  | 'listInFlight'
  | 'listPausedWithPresale'
  | 'listRoundsToClaim'
  | 'hasOpenRounds'
>;

export interface ViSnapshot {
  vi: number;
  state: string;
  updatedAt: string | null;
}

// Everything the keeper reads besides the chain, so tests can fake it.
export interface RoundsDeps {
  registry: RoundsRegistry;
  readLiveVi(atnxMarketId: string): Promise<ViSnapshot | null>;
  // The vi_history rows recorded in [close − window, close], in the order
  // the database returns them.
  settlementRows(atnxMarketId: string, closeAt: Date, windowSecs: number): Promise<SettleRow[]>;
  marketCreator(atnxMarketId: string): Promise<string | null>;
}

async function marketCreator(atnxMarketId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('markets')
    .select('created_by')
    .eq('id', atnxMarketId)
    .maybeSingle();
  if (error) throw error;
  return data?.created_by ?? null;
}

// Filtered on recorded_at, never on id: seed rows are inserted later with
// backdated timestamps.
export async function settlementRows(atnxMarketId: string, closeAt: Date, windowSecs: number): Promise<SettleRow[]> {
  const { from, to } = settleWindow(closeAt, windowSecs);
  const { data, error } = await createAdminClient()
    .from('vi_history')
    .select('vi, recorded_at')
    .eq('market_id', atnxMarketId)
    .gte('recorded_at', from.toISOString())
    .lte('recorded_at', to.toISOString())
    .limit(5000);
  if (error) throw error;
  return (data ?? []).map((r) => ({ vi: Number(r.vi), recorded_at: String(r.recorded_at) }));
}

export function defaultDeps(): RoundsDeps {
  return { registry: rr, readLiveVi, settlementRows, marketCreator };
}

// --------------------------------------------------------- start series

export type StartResult =
  | { ok: true; series: BmSeriesRow; round: BmRoundRow | null }
  | { ok: true; dry: true; plan: ClaimSeriesInput }
  | {
      ok: false;
      error: string;
      code: 'not_found' | 'scoring' | 'no_vi' | 'stale_vi' | 'already_active' | 'chain' | 'tx';
    };

export interface StartInput {
  atnxMarketId: string;
  finderWallet: string;
  finderUserId?: string | null;
  fast: boolean;
  dry?: boolean;
}

// Starts a series of rounds on an atnx market: validates the VI, reserves
// the registry slot, creates the series (and round 1 in presale) on
// chain, and records round 1 with its presale open until now + the
// first presale length.
export async function startSeriesOn<S extends ChainSeries>(chain: RoundsChain<S>, input: StartInput, deps: RoundsDeps = defaultDeps()): Promise<StartResult> {
  const reg = deps.registry;
  const fast = !!input.fast;
  const finder = chain.parseFinder(input.finderWallet);
  if (!finder) return { ok: false, error: 'bad wallet', code: 'chain' };
  const programId = chain.programId();

  const snap = await deps.readLiveVi(input.atnxMarketId);
  if (!snap) return { ok: false, error: 'Market not found', code: 'not_found' };
  if (snap.state === 'scoring') return { ok: false, error: 'Market is still being scored', code: 'scoring' };
  if (!(snap.vi > 0)) return { ok: false, error: 'Market has no score yet', code: 'no_vi' };
  if (!viIsFresh(snap.updatedAt)) {
    return { ok: false, error: `The VI has not been updated for over ${MAX_VI_AGE_MIN} minutes`, code: 'stale_vi' };
  }
  if (await reg.hasRunningSeries(input.atnxMarketId, chain.key, fast)) {
    return { ok: false, error: 'Rounds are already running on this market', code: 'already_active' };
  }

  const params = roundParams(fast);
  const reference = refToHex(newSeriesRef(input.atnxMarketId, fast));
  const plan: ClaimSeriesInput = {
    atnxMarketId: input.atnxMarketId,
    chain: chain.key,
    programId,
    reference,
    finderWallet: finder,
    finderUserId: input.finderUserId ?? (await deps.marketCreator(input.atnxMarketId)),
    fast,
    ...params,
  };
  if (input.dry) return { ok: true, dry: true, plan };

  const row = await reg.claimSeries(plan);
  if (!row) return { ok: false, error: 'Rounds are already running on this market', code: 'already_active' };

  try {
    const existing = await chain.readSeries(row);
    if (existing) return await adoptSeries(chain, reg, row, existing, null);
    const res = await chain.createSeries({
      reference,
      roundSecs: params.roundSecs,
      settleWindowSecs: params.settleWindowSecs,
      ante: usdgUnits(params.anteUsdg),
      finder,
    });
    await reg.markSeriesActive(row.id, { ...res.active, create_tx: res.tx });
    const round =
      (await reg.insertPresale(row.id, 1, new Date(Date.now() + params.firstPresaleSecs * 1000), res.firstRoundKey)) ??
      (await reg.getRound(row.id, 1));
    return { ok: true, series: (await reg.getSeries(row.id)) ?? row, round };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[rounds] start failed', msg);
    // The send may have landed even though the call threw (a confirmation
    // timeout); the chain decides.
    const landed = await chain.readSeries(row).catch(() => null);
    if (landed) {
      try {
        return await adoptSeries(chain, reg, row, landed, null);
      } catch (err2) {
        return { ok: false, error: (err2 as Error).message, code: 'tx' };
      }
    }
    await reg.markSeriesFailed(row.id, msg);
    return { ok: false, error: msg, code: 'tx' };
  }
}

// A pending registry row whose series exists on chain: mark it active and
// record its presale round. A series with neither a presale nor a live
// round has ended. References carry a time nonce, so a fresh start never
// lands on an ended series; the check stays as a guard.
async function adoptSeries<S extends ChainSeries>(
  chain: RoundsChain<S>,
  reg: RoundsRegistry,
  row: BmSeriesRow,
  acct: S,
  sig: string | null
): Promise<StartResult> {
  if (acct.presaleRound === 0 && acct.liveRound === 0) {
    const reason = 'this series reference belongs to an ended series on chain';
    await reg.markSeriesFailed(row.id, reason);
    return { ok: false, error: reason, code: 'chain' };
  }
  await reg.markSeriesActive(row.id, { ...chain.activePatch(row, acct), create_tx: sig ?? row.create_tx });
  let round: BmRoundRow | null = null;
  if (acct.presaleRound > 0) {
    const opensAt = new Date(new Date(row.created_at).getTime() + row.first_presale_secs * 1000);
    round =
      (await reg.insertPresale(row.id, acct.presaleRound, opensAt, chain.roundKey(row, acct.presaleRound))) ??
      (await reg.getRound(row.id, acct.presaleRound));
  }
  return { ok: true, series: (await reg.getSeries(row.id)) ?? row, round };
}

// ------------------------------------------------------------ settlement

export interface Settlement {
  avg: number | null;
  prints: number;
  // On a chain that commits to its inputs: what the keeper settles on, and
  // its sha256.
  inputs: SettleInputs | null;
  commitment: string | null;
}

// The mean of the window's prints. Without commitments, the prints are
// averaged in the order the database returns them (as the Solana keeper
// always has); with them, in the canonical order the inputs fix, so anyone
// can recompute the average from the stored inputs.
export function settlementFrom(
  rows: SettleRow[],
  commit: { marketId: string; reference: string; roundIndex: number; closeAt: number; windowSecs: number } | null
): Settlement {
  if (!commit) {
    return { avg: averageVi(rows.map((r) => ({ vi: Number(r.vi) }))), prints: rows.length, inputs: null, commitment: null };
  }
  const inputs = buildSettleInputs({ ...commit, rows });
  if (!inputs) return { avg: null, prints: 0, inputs: null, commitment: null };
  return { avg: fromE2(BigInt(inputs.average_e2)), prints: inputs.prints.length, inputs, commitment: settleCommitment(inputs).hash };
}

// ------------------------------------------------------------------ tick

export interface RoundsCounts {
  settled: number;
  opened: number;
  anted: number;
  voided: number;
  claimed: number;
  reconciled: number;
  errors: number;
}

export function emptyCounts(): RoundsCounts {
  return { settled: 0, opened: 0, anted: 0, voided: 0, claimed: 0, reconciled: 0, errors: 0 };
}

export type RoundsLog = (entry: {
  action: string;
  seriesId?: string | null;
  roundId?: string | null;
  detail?: Record<string, unknown> | null;
  error?: string | null;
  txHash?: string | null;
}) => Promise<void>;

export interface TickContext {
  dry: boolean;
  log: RoundsLog;
  rep: RoundsCounts;
  // Epoch ms after which no new work starts.
  deadline: number;
}

function ids(r: RoundWithSeries) {
  return { seriesId: r.series_id, roundId: r.id };
}

function olderThan(iso: string, ms: number): boolean {
  return Date.now() - new Date(iso).getTime() > ms;
}

export async function tickRoundsOn<S extends ChainSeries>(chain: RoundsChain<S>, ctx: TickContext, deps: RoundsDeps = defaultDeps()): Promise<void> {
  const { dry, log, rep } = ctx;
  const reg = deps.registry;
  let stopped = false;
  const late = () => {
    if (Date.now() <= ctx.deadline) return false;
    stopped = true;
    return true;
  };
  const fail = async (action: string, err: unknown, extra: Parameters<RoundsLog>[0] = { action }) => {
    rep.errors++;
    await log({ ...extra, action, error: (err as Error)?.message ?? String(err) });
  };

  // Brings a registry row in line with the chain's round. Returns false
  // when the chain shows nothing the row does not already know.
  const syncFromChain = async (r: RoundWithSeries, acct: ChainRound, sig: string | null): Promise<boolean> => {
    if (acct.state === 'live' && (r.state === 'opening' || r.state === 'presale')) {
      await finishOpen(r, acct, sig, chain.roundKey(r.series, r.idx + 1));
      return true;
    }
    if (acct.state === 'settled' && r.state !== 'settled') {
      await reg.transitionRound(r.id, ['opening', 'live', 'settling'], 'settled', {
        winner: acct.winner,
        settle_vi: fromE2(acct.settleE2),
        target_vi: fromE2(acct.targetE2),
        settle_tx: sig ?? r.settle_tx,
        error: null,
        ...(chain.commitsInputs && acct.commitment ? { settle_commitment: acct.commitment } : {}),
      });
      await maybeEndSeries(r.series);
      return true;
    }
    if (acct.state === 'void' && r.state !== 'void') {
      await reg.transitionRound(r.id, ['presale', 'opening', 'live', 'settling'], 'void', { void_tx: sig ?? r.void_tx });
      await maybeEndSeries(r.series);
      return true;
    }
    return false;
  };

  // Marks an opened round live with the chain's numbers, then records the
  // next round's presale, opening when this one closes.
  const finishOpen = async (r: RoundWithSeries, acct: ChainRound, sig: string | null, nextRoundKey: string | null): Promise<void> => {
    const patch: Partial<BmRoundRow> = {
      opened_at: isoFromUnix(acct.openedAt),
      close_at: isoFromUnix(acct.closeAt),
      trade_until: isoFromUnix(acct.tradeUntil),
      target_vi: fromE2(acct.targetE2),
      presale_up_usdg: unitsUsdg(acct.presaleUp),
      presale_down_usdg: unitsUsdg(acct.presaleDown),
      round_pubkey: chain.roundKey(r.series, r.idx),
      open_tx: sig ?? r.open_tx,
      error: null,
    };
    await reg.transitionRound(r.id, ['opening', 'presale'], 'live', patch);
    await reg.insertPresale(r.series_id, r.idx + 1, patch.close_at!, nextRoundKey);
  };

  // A paused series with nothing left to settle or open has ended.
  const maybeEndSeries = async (series: BmSeriesRow): Promise<void> => {
    const fresh = await reg.getSeries(series.id);
    if (!fresh || fresh.state !== 'paused') return;
    if (!(await reg.hasOpenRounds(series.id))) await reg.updateSeries(series.id, { state: 'ended' });
  };

  // 1. reconcile rounds left in flight
  for (const r of await reg.listInFlight(chain.key)) {
    if (late()) break;
    if (!olderThan(r.updated_at, IN_FLIGHT_GRACE_MS)) continue;
    try {
      const acct = await chain.readRound(r.series, r.idx);
      if (!acct) throw new Error('round account not found on chain');
      if (dry) {
        await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        continue;
      }
      if (await syncFromChain(r, acct, null)) {
        rep.reconciled++;
        await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        continue;
      }
      // The chain never moved: the transaction did not land. Put the row
      // back so this tick (steps 3 and 4) tries again.
      const back = r.state === 'opening' ? 'presale' : 'live';
      if ((r.state === 'opening' && acct.state === 'presale') || (r.state === 'settling' && acct.state === 'live')) {
        await reg.transitionRound(r.id, r.state, back, { error: `${r.state} did not land; retrying` });
        rep.reconciled++;
        await log({ action: 'reconcile-retry', ...ids(r), detail: { from: r.state, to: back } });
      } else {
        throw new Error(`registry ${r.state}, chain ${acct.state}`);
      }
    } catch (err) {
      await fail('reconcile', err, { action: 'reconcile', ...ids(r) });
    }
  }

  // 2. pending series
  for (const s of await reg.listPendingSeries(chain.key)) {
    if (late()) break;
    if (!olderThan(s.created_at, IN_FLIGHT_GRACE_MS)) continue;
    const at = { seriesId: s.id };
    try {
      const acct = await chain.readSeries(s);
      if (dry) {
        await log({ action: acct ? 'would-activate' : 'would-create', ...at, detail: { atnxMarketId: s.atnx_market_id, fast: s.fast } });
        continue;
      }
      if (acct) {
        const res = await adoptSeries(chain, reg, s, acct, null);
        if (res.ok) rep.reconciled++;
        await log({ action: res.ok ? 'series-adopted' : 'series-failed', ...at, error: res.ok ? null : res.error });
        continue;
      }
      try {
        const res = await chain.createSeries({
          reference: s.reference,
          roundSecs: s.round_secs,
          settleWindowSecs: s.settle_window_secs,
          ante: usdgUnits(Number(s.ante_usdg)),
          finder: s.finder_wallet,
        });
        await reg.markSeriesActive(s.id, { ...res.active, create_tx: res.tx });
        await reg.insertPresale(s.id, 1, new Date(Date.now() + s.first_presale_secs * 1000), res.firstRoundKey);
        await log({ action: 'series-created', ...at, txHash: res.tx });
      } catch (err) {
        const landed = await chain.readSeries(s).catch(() => null);
        if (landed) {
          await adoptSeries(chain, reg, s, landed, null);
          await log({ action: 'series-adopted', ...at });
        } else {
          await reg.markSeriesFailed(s.id, (err as Error).message ?? String(err));
          throw err;
        }
      }
    } catch (err) {
      await fail('create-series', err, { action: 'create-series', ...at });
    }
  }

  // 3. due live rounds
  for (const r of await reg.listDueLive(chain.key, new Date(), SETTLE_DELAY_SECS)) {
    if (late()) break;
    try {
      const acct = await chain.readRound(r.series, r.idx);
      if (!acct) throw new Error('round account not found on chain');
      if (acct.state !== 'live') {
        if (dry) {
          await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else if (await syncFromChain(r, acct, null)) {
          rep.reconciled++;
          await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else {
          throw new Error(`registry live, chain ${acct.state}`);
        }
        continue;
      }
      const closeAt = new Date(acct.closeAt * 1000);
      const rows = await deps.settlementRows(r.series.atnx_market_id, closeAt, r.series.settle_window_secs);
      const { avg, prints, inputs, commitment } = settlementFrom(
        rows,
        chain.commitsInputs
          ? { marketId: r.series.atnx_market_id, reference: r.series.reference, roundIndex: r.idx, closeAt: acct.closeAt, windowSecs: r.series.settle_window_secs }
          : null
      );

      if (avg === null) {
        if (Date.now() < closeAt.getTime() + VOID_AFTER_MS) {
          await log({ action: 'settle-waiting', ...ids(r), detail: { reason: 'no prints in the window yet' } });
          continue;
        }
        if (dry) {
          rep.voided++;
          await log({ action: 'would-void', ...ids(r), detail: { reason: 'no prints in the settlement window' } });
          continue;
        }
        if (!(await reg.transitionRound(r.id, 'live', 'settling', { settle_prints: 0 }))) {
          await log({ action: 'skip-concurrent', ...ids(r) });
          continue;
        }
        const sig = await chain.voidRound(r.series, r.idx);
        await reg.transitionRound(r.id, 'settling', 'void', { void_tx: sig, error: 'no VI prints in the settlement window' });
        rep.voided++;
        await log({ action: 'voided', ...ids(r), txHash: sig, detail: { reason: 'no prints' } });
        await maybeEndSeries(r.series);
        continue;
      }

      const settleE2 = toE2(avg);
      const winner = winnerOf(settleE2, acct.targetE2);
      const detail: Record<string, unknown> = { avg, prints, target: fromE2(acct.targetE2), winner };
      if (commitment) detail.commitment = commitment;
      if (dry) {
        rep.settled++;
        await log({ action: 'would-settle', ...ids(r), detail });
        continue;
      }
      // The inputs go in with the move to `settling`, before the send, so a
      // settle that lands while this run dies still has them on record.
      const committed: Partial<BmRoundRow> = inputs && commitment ? { settle_inputs: inputs as unknown as BmRoundRow['settle_inputs'], settle_commitment: commitment } : {};
      if (!(await reg.transitionRound(r.id, 'live', 'settling', { settle_vi: avg, settle_prints: prints, ...committed }))) {
        await log({ action: 'skip-concurrent', ...ids(r) });
        continue;
      }
      const sig = await chain.settle(r.series, r.idx, settleE2, commitment);
      const after = await chain.readRound(r.series, r.idx).catch(() => null);
      await reg.transitionRound(r.id, 'settling', 'settled', {
        winner: after?.winner ?? winner,
        settle_vi: avg,
        settle_prints: prints,
        settle_tx: sig,
        error: null,
      });
      rep.settled++;
      await log({ action: 'settled', ...ids(r), txHash: sig, detail });
      await maybeEndSeries(r.series);
    } catch (err) {
      // A row left `settling` is reconciled from the chain next tick.
      await fail('settle', err, { action: 'settle', ...ids(r) });
    }
  }

  // 4. presale rounds ready to open
  for (const r of await reg.listPresaleReady(chain.key, new Date())) {
    if (late()) break;
    try {
      const acct = await chain.readRound(r.series, r.idx);
      if (!acct) throw new Error('round account not found on chain');
      if (acct.state !== 'presale') {
        // Opened (or ended) by a run whose bookkeeping did not finish.
        if (dry) {
          await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else if (await syncFromChain(r, acct, null)) {
          rep.reconciled++;
          await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else {
          throw new Error(`registry presale, chain ${acct.state}`);
        }
        continue;
      }
      const chainSeries = await chain.readSeries(r.series);
      if (!chainSeries) throw new Error('series account not found on chain');
      if (chainSeries.paused) {
        await log({ action: 'open-deferred', ...ids(r), detail: { reason: 'series paused on chain' } });
        continue;
      }
      if (chainSeries.liveRound !== 0 || chainSeries.presaleRound !== r.idx) {
        throw new Error(`chain series live ${chainSeries.liveRound}, presale ${chainSeries.presaleRound}; registry presale ${r.idx}`);
      }

      // The VI first: no ante on a round that cannot open yet.
      const snap = await deps.readLiveVi(r.series.atnx_market_id);
      const reason = !snap
        ? 'market not found'
        : snap.state === 'scoring'
          ? 'market is being scored'
          : !(snap.vi > 0)
            ? 'no VI'
            : !viIsFresh(snap.updatedAt)
              ? `VI older than ${MAX_VI_AGE_MIN} minutes`
              : null;
      if (reason || !snap) {
        await log({ action: 'open-deferred', ...ids(r), detail: { reason } });
        continue;
      }

      // Both pots need money for the opening prices; the keeper antes an
      // empty side with an ordinary commit it can win or lose.
      const empty: ChainSide[] = [];
      if (acct.presaleUp === 0n) empty.push('up');
      if (acct.presaleDown === 0n) empty.push('down');
      if (empty.length > 0) {
        const ante = chainSeries.ante > 0n ? chainSeries.ante : usdgUnits(Number(r.series.ante_usdg));
        const anteSide: BmAnteSide = empty.length === 2 ? 'both' : empty[0];
        const anteDetail = { side: anteSide, usdg: unitsUsdg(ante) };
        if (dry) {
          rep.anted++;
          await log({ action: 'would-ante', ...ids(r), detail: anteDetail });
        } else {
          await chain.ensureKeeperUsdg(ante * BigInt(empty.length));
          for (const side of empty) {
            const sig = await chain.commit(r.series, r.idx, side, ante);
            await log({ action: 'anted', ...ids(r), txHash: sig, detail: { side, usdg: unitsUsdg(ante) } });
          }
          await reg.updateRound(r.id, { ante_side: anteSide, ante_usdg: unitsUsdg(ante) * empty.length });
          rep.anted++;
        }
      }

      const targetE2 = toE2(snap.vi);
      if (dry) {
        rep.opened++;
        await log({
          action: 'would-open',
          ...ids(r),
          detail: { target: fromE2(targetE2), presaleUp: unitsUsdg(acct.presaleUp), presaleDown: unitsUsdg(acct.presaleDown) },
        });
        continue;
      }
      if (!(await reg.transitionRound(r.id, 'presale', 'opening', { target_vi: fromE2(targetE2) }))) {
        await log({ action: 'skip-concurrent', ...ids(r) });
        continue;
      }
      // From here a failure leaves the row `opening`; step 1 of a later
      // tick reads the chain and finishes or retries it.
      const res = await chain.openRound(r.series, r.idx, targetE2);
      const after = await chain.readRound(r.series, r.idx);
      if (!after || after.state !== 'live') throw new Error('open_round sent but the round is not live yet');
      await finishOpen(r, after, res.tx, res.nextRoundKey);
      rep.opened++;
      await log({
        action: 'opened',
        ...ids(r),
        txHash: res.tx,
        detail: { target: fromE2(after.targetE2), closeAt: isoFromUnix(after.closeAt), presaleUp: unitsUsdg(after.presaleUp), presaleDown: unitsUsdg(after.presaleDown) },
      });
    } catch (err) {
      await fail('open', err, { action: 'open', ...ids(r) });
    }
  }

  // 5. paused series: void the presale round (refunds), which ends the
  // series on chain.
  for (const r of await reg.listPausedWithPresale(chain.key)) {
    if (late()) break;
    try {
      const acct = await chain.readRound(r.series, r.idx);
      if (dry) {
        rep.voided++;
        await log({ action: 'would-void', ...ids(r), detail: { reason: 'series paused', chain: acct?.state ?? null } });
        continue;
      }
      if (acct && acct.state === 'void') {
        await reg.transitionRound(r.id, 'presale', 'void', {});
      } else {
        const chainSeries = await chain.readSeries(r.series);
        if (chainSeries && !chainSeries.paused) await chain.pauseSeries(r.series);
        const sig = await chain.voidRound(r.series, r.idx);
        await reg.transitionRound(r.id, 'presale', 'void', { void_tx: sig, error: 'series paused' });
        await log({ action: 'voided', ...ids(r), txHash: sig, detail: { reason: 'series paused' } });
      }
      rep.voided++;
      await maybeEndSeries(r.series);
    } catch (err) {
      await fail('void', err, { action: 'void', ...ids(r) });
    }
  }

  // 6. the keeper's antes on finished rounds: claim the payout (or the
  // refund on a void round). A position that is gone was claimed already.
  for (const r of await reg.listRoundsToClaim(chain.key)) {
    if (late()) break;
    try {
      if (!(await chain.hasKeeperPosition(r.series, r.idx))) continue;
      const detail = { idx: r.idx, side: r.ante_side, usdg: r.ante_usdg };
      if (dry) {
        rep.claimed++;
        await log({ action: 'would-claim-ante', ...ids(r), detail });
        continue;
      }
      const sig = await chain.claim(r.series, r.idx);
      rep.claimed++;
      await log({ action: 'claimed-ante', ...ids(r), txHash: sig, detail });
    } catch (err) {
      await fail('claim-ante', err, { action: 'claim-ante', ...ids(r) });
    }
  }

  if (stopped) await log({ action: 'rounds-deadline', detail: { note: 'stopped starting new work; the next tick resumes' } });
}
