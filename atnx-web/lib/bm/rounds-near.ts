import type { BmSeriesRow } from '@/lib/supabase/database-bm';
import {
  ensureKeeperUsdg,
  nearKeeperAccount,
  getPosition,
  getRound,
  getSeriesByReference,
  isNearAccountId,
  keeperRounds,
  nearEnv,
  nearKeeperAccountId,
  NEAR_CHAIN_KEY,
  type NearRound,
  type NearSeries,
} from './near';
import { startSeriesOn, tickRoundsOn, type ChainRound, type RoundsChain, type RoundsDeps, type StartInput, type StartResult, type TickContext } from './rounds-core';

// Rolling VI rounds on NEAR testnet (near/rounds, deployed at
// NEXT_PUBLIC_BM_NEAR_ROUNDS): the NEAR chain under the shared rounds
// orchestration in ./rounds-core. Rows are bm.series.chain = 'near:testnet',
// with the contract's numeric series id in bm.series.onchain_series_id and
// NEAR account ids in finder_wallet and program_id. The keeper signs as
// BM_NEAR_KEEPER_ACCOUNT. The step runs with BM_NEAR_ROUNDS_ENABLED=1,
// independently of Solana's BM_ROUNDS_ENABLED.
//
// What differs from Solana:
//   - a series is found by its reference (get_series_by_reference); calls
//     name it by the numeric id, which the registry keeps and which is
//     checked against the chain on every read;
//   - rounds and positions have no addresses (round_pubkey stays null);
//   - settle carries the oracle commitment: the sha256 of the canonical
//     settle inputs, which the registry stores (./commitment);
//   - the keeper's money is its internal balance in the contract, topped
//     up from the contract's faucet; a claim credits that balance.

export type NearChainSeries = NearSeries;

export function nearRoundsEnabled(): boolean {
  return process.env.BM_NEAR_ROUNDS_ENABLED === '1';
}

export function chainRoundFromNear(r: NearRound): ChainRound {
  return {
    state: r.state,
    winner: r.winner,
    presaleUp: r.presaleUp,
    presaleDown: r.presaleDown,
    openedAt: r.openedAt,
    closeAt: r.closeAt,
    tradeUntil: r.tradeUntil,
    targetE2: r.targetE2,
    settleE2: r.settleE2,
    commitment: r.commitment,
  };
}

// The views and calls the NEAR chain uses, injectable for tests.
export interface NearRoundsApi {
  contractId(): string;
  keeperId(): string;
  seriesByReference(reference: string): Promise<NearSeries | null>;
  round(seriesId: number, idx: number): Promise<NearRound | null>;
  hasPosition(seriesId: number, idx: number, accountId: string): Promise<boolean>;
  createSeries(a: { reference: string; roundSecs: number; settleWindowSecs: number; ante: bigint; finder: string }): Promise<{ txHash: string; seriesId: number }>;
  commit(a: { seriesId: number; roundIndex: number; side: 'up' | 'down'; amount: bigint }): Promise<string>;
  openRound(a: { seriesId: number; targetE2: bigint }): Promise<string>;
  settle(a: { seriesId: number; settleE2: bigint; commitment: string }): Promise<string>;
  voidRound(a: { seriesId: number; roundIndex: number }): Promise<string>;
  pause(seriesId: number): Promise<string>;
  claim(a: { seriesId: number; roundIndex: number }): Promise<string>;
  ensureKeeperUsdg(minimum: bigint): Promise<void>;
}

export function liveNearApi(): NearRoundsApi {
  return {
    contractId: () => nearEnv().rounds,
    keeperId: () => nearKeeperAccountId(),
    seriesByReference: getSeriesByReference,
    round: getRound,
    hasPosition: async (seriesId, idx, accountId) => (await getPosition(seriesId, idx, accountId)) !== null,
    createSeries: (a) => keeperRounds().createSeries(a),
    commit: (a) => keeperRounds().commit(a),
    openRound: (a) => keeperRounds().openRound(a),
    settle: (a) => keeperRounds().settle(a),
    voidRound: (a) => keeperRounds().voidRound(a),
    pause: (seriesId) => keeperRounds().setSeries({ seriesId, paused: true }),
    claim: async (a) => (await keeperRounds().claim(a)).txHash,
    ensureKeeperUsdg: async (minimum) => {
      await ensureKeeperUsdg(minimum);
    },
  };
}

export function nearChain(api: NearRoundsApi = liveNearApi()): RoundsChain<NearChainSeries> {
  // reference → series id; ids never change once a series exists.
  const ids = new Map<string, number>();

  const readSeries = async (row: BmSeriesRow): Promise<NearSeries | null> => {
    const s = await api.seriesByReference(row.reference);
    if (!s) return null;
    if (s.reference !== row.reference) throw new Error(`chain series ${s.id} has reference ${s.reference}, registry ${row.reference}`);
    if (row.onchain_series_id != null && Number(row.onchain_series_id) !== s.id) {
      throw new Error(`registry says series ${row.onchain_series_id}, the chain has this reference as series ${s.id}`);
    }
    ids.set(row.reference, s.id);
    return s;
  };

  const seriesId = async (row: BmSeriesRow): Promise<number> => {
    const known = ids.get(row.reference);
    if (known !== undefined) return known;
    const s = await readSeries(row);
    if (!s) throw new Error(`no series with reference ${row.reference} on ${api.contractId()}`);
    return s.id;
  };

  return {
    key: NEAR_CHAIN_KEY,
    programId: () => api.contractId(),
    parseFinder: (wallet) => {
      const w = typeof wallet === 'string' ? wallet.trim() : '';
      return isNearAccountId(w) ? w : null;
    },
    commitsInputs: true,

    readSeries,
    async readRound(row, idx) {
      const r = await api.round(await seriesId(row), idx);
      return r ? chainRoundFromNear(r) : null;
    },
    hasKeeperPosition: async (row, idx) => api.hasPosition(await seriesId(row), idx, api.keeperId()),
    roundKey: () => null,
    activePatch: (_row, acct) => ({ onchain_series_id: acct.id }),

    async createSeries(a) {
      const res = await api.createSeries(a);
      ids.set(a.reference, res.seriesId);
      return { tx: res.txHash, active: { onchain_series_id: res.seriesId }, firstRoundKey: null };
    },
    commit: async (row, idx, side, amount) => api.commit({ seriesId: await seriesId(row), roundIndex: idx, side, amount }),
    // open_round opens the series' presale round; the caller has checked
    // that it is `idx`.
    openRound: async (row, _idx, targetE2) => ({ tx: await api.openRound({ seriesId: await seriesId(row), targetE2 }), nextRoundKey: null }),
    // settle settles the series' live round; the caller has read `idx` as live.
    async settle(row, _idx, settleE2, commitment) {
      if (!commitment) throw new Error('a NEAR settle needs the oracle commitment');
      return api.settle({ seriesId: await seriesId(row), settleE2, commitment });
    },
    voidRound: async (row, idx) => api.voidRound({ seriesId: await seriesId(row), roundIndex: idx }),
    pauseSeries: async (row) => api.pause(await seriesId(row)),
    claim: async (row, idx) => api.claim({ seriesId: await seriesId(row), roundIndex: idx }),
    ensureKeeperUsdg: (minimum) => api.ensureKeeperUsdg(minimum),
  };
}

// Starts a NEAR series for operations (scripts/rounds-start.ts --chain
// near): any finder account, a fast series whenever asked, and --dry.
export function startNearSeriesForOps(input: StartInput, deps?: RoundsDeps): Promise<StartResult> {
  return startSeriesOn(nearChain(), input, deps);
}

// A fast (hourly demo) series from the site only where the ticket shows the
// toggle (next dev) or where it is allowed on purpose, as for Solana's
// startSeriesAction; the laptop script can always start one. Otherwise any
// signed-in user could fill production with hourly series.
export function fastFromSiteAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.BM_FAST_FROM_CLIENT === '1';
}

// "Start rounds" on a market page, NEAR testnet. Server-side only, not a
// server action: the caller resolves the signed-in user's NEAR account and
// passes it as the finder (it earns the finder's share of the fees), and
// revalidates the market page and the list on success. Validates like the
// Solana start (market id, finder, the market scored with a VI under 30
// minutes old, one running series per market, chain and speed), reserves
// the registry row, then creates the series on chain with the keeper key,
// which pays for it. A start whose send failed half way is finished by the
// keeper's next tick (step 2) or marked failed.
export async function startNearSeries(
  { marketId, finder, fast }: { marketId: string; finder: string; fast?: boolean },
  opts: { deps?: RoundsDeps; chain?: RoundsChain<NearChainSeries>; env?: Record<string, string | undefined> } = {}
): Promise<StartResult> {
  if (typeof marketId !== 'string' || !/^[0-9a-f-]{36}$/i.test(marketId)) {
    return { ok: false, error: 'Bad request', code: 'not_found' };
  }
  const account = typeof finder === 'string' ? finder.trim() : '';
  if (!isNearAccountId(account)) return { ok: false, error: 'bad wallet', code: 'chain' };
  let chain = opts.chain;
  if (!chain) {
    try {
      // The keeper signs the create; without its key nothing can start.
      nearKeeperAccount();
    } catch (err) {
      console.error('[rounds] NEAR keeper not configured', (err as Error).message);
      return { ok: false, error: 'Rounds are not live on NEAR testnet yet', code: 'chain' };
    }
    chain = nearChain();
  }
  const allowFast = fast === true && fastFromSiteAllowed(opts.env);
  return startSeriesOn(chain, { atnxMarketId: marketId, finderWallet: account, fast: allowFast }, opts.deps);
}

// The keeper's rounds step on NEAR testnet (keeper-run.ts, with
// BM_NEAR_ROUNDS_ENABLED=1).
export function tickNearRounds(ctx: TickContext, deps?: RoundsDeps): Promise<void> {
  return tickRoundsOn(nearChain(), ctx, deps);
}
