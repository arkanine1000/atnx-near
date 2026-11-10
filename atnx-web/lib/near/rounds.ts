// Reads and call arguments for the NEAR rounds contract (near/rounds),
// browser-safe. Views go straight to the RPC; calls are built here and
// signed and relayed by lib/near/client.ts.
//
// The contract's JSON uses snake_case and U128 strings; these helpers turn
// that into the camelCase bigint shapes the ticket already uses for Solana
// (lib/bm/dpm.ts RoundLike / PositionLike), so the same math and panes
// serve both chains.
import { JsonRpcProvider } from 'near-api-js';
import { payoutIf, type PositionLike, type RoundLike, type RoundSide } from '@/lib/bm/dpm';
import { NEAR_ROUNDS } from './config';
import { nearRpcProvider, rpcProvider } from './rpc';

export type { RoundSide };
export type NearRoundState = 'presale' | 'live' | 'settled' | 'void';

export interface NearSeries {
  id: number;
  finder: string;
  reference: string;
  roundSecs: number;
  settleWindowSecs: number;
  feeBps: number;
  finderBps: number;
  ante: bigint;
  paused: boolean;
  liveRound: number; // 0 = none
  presaleRound: number; // 0 = none (series ended)
  finderFees: bigint;
  platformFees: bigint;
}

export interface NearRound extends RoundLike {
  seriesId: number;
  index: number;
  state: NearRoundState;
  winner: RoundSide | null;
  openedAt: number;
  closeAt: number;
  tradeUntil: number;
  targetE2: bigint;
  settleE2: bigint;
  paidOut: bigint;
}

export interface NearPosition extends PositionLike {
  seriesId: number;
  roundIndex: number;
  accountId: string;
}

export interface NearQuote {
  shares: bigint;
  fee: bigint;
  finderFee: bigint;
  net: bigint;
}

// ------------------------------------------------------------ JSON shapes

interface SeriesJson {
  id: number;
  finder: string;
  reference: string;
  round_secs: number;
  settle_window_secs: number;
  fee_bps: number;
  finder_bps: number;
  ante: string;
  paused: boolean;
  live_round: number;
  presale_round: number;
  finder_fees: string;
  platform_fees: string;
}

interface RoundJson {
  series_id: number;
  index: number;
  state: 'Presale' | 'Live' | 'Settled' | 'Void';
  winner: 'Up' | 'Down' | null;
  presale_up: string;
  presale_down: string;
  m_up: string;
  m_down: string;
  n_up: string;
  n_down: string;
  opened_at: number;
  close_at: number;
  trade_until: number;
  target_e2: number;
  settle_e2: number;
  commitment: string;
  paid_out: string;
}

interface PositionJson {
  series_id: number;
  round_index: number;
  account_id: string;
  presale_up: string;
  presale_down: string;
  stake_up: string;
  stake_down: string;
  shares_up: string;
  shares_down: string;
}

interface QuoteJson {
  shares: string;
  fee: string;
  finder_fee: string;
  net: string;
}

const big = (v: string | number | null | undefined): bigint => BigInt(v ?? 0);

export function parseSeries(s: SeriesJson): NearSeries {
  return {
    id: s.id,
    finder: s.finder,
    reference: s.reference,
    roundSecs: s.round_secs,
    settleWindowSecs: s.settle_window_secs,
    feeBps: s.fee_bps,
    finderBps: s.finder_bps,
    ante: big(s.ante),
    paused: s.paused,
    liveRound: s.live_round,
    presaleRound: s.presale_round,
    finderFees: big(s.finder_fees),
    platformFees: big(s.platform_fees),
  };
}

const STATES: Record<RoundJson['state'], NearRoundState> = { Presale: 'presale', Live: 'live', Settled: 'settled', Void: 'void' };

export function parseRound(r: RoundJson): NearRound {
  return {
    seriesId: r.series_id,
    index: r.index,
    state: STATES[r.state],
    winner: r.winner === 'Up' ? 'up' : r.winner === 'Down' ? 'down' : null,
    presaleUp: big(r.presale_up),
    presaleDown: big(r.presale_down),
    mUp: big(r.m_up),
    mDown: big(r.m_down),
    nUp: big(r.n_up),
    nDown: big(r.n_down),
    openedAt: r.opened_at,
    closeAt: r.close_at,
    tradeUntil: r.trade_until,
    targetE2: big(r.target_e2),
    settleE2: big(r.settle_e2),
    paidOut: big(r.paid_out),
  };
}

export function parsePosition(p: PositionJson): NearPosition {
  return {
    seriesId: p.series_id,
    roundIndex: p.round_index,
    accountId: p.account_id,
    presaleUp: big(p.presale_up),
    presaleDown: big(p.presale_down),
    stakeUp: big(p.stake_up),
    stakeDown: big(p.stake_down),
    sharesUp: big(p.shares_up),
    sharesDown: big(p.shares_down),
  };
}

// ----------------------------------------------------------------- views

export interface RoundsViewer {
  seriesByReference(reference: string): Promise<NearSeries | null>;
  series(seriesId: number): Promise<NearSeries | null>;
  round(seriesId: number, roundIndex: number): Promise<NearRound | null>;
  position(seriesId: number, roundIndex: number, accountId: string): Promise<NearPosition | null>;
  positionsOf(accountId: string): Promise<NearPosition[]>;
  balanceOf(accountId: string): Promise<bigint>;
  quoteBuy(seriesId: number, roundIndex: number, side: RoundSide, amount: bigint): Promise<NearQuote>;
  // The account's native NEAR balance in yoctoNEAR (0 for a gasless user
  // account), or null when the account does not exist.
  nearBalance(accountId: string): Promise<bigint | null>;
}

// A raw view call, for the server-side checks.
export type ViewFn = <T>(method: string, args: Record<string, unknown>) => Promise<T>;

export function viewFn(provider: JsonRpcProvider, contractId: string): ViewFn {
  return async <T>(method: string, args: Record<string, unknown>) =>
    (await provider.callFunction<never>({ contractId, method, args })) as unknown as T;
}

export function roundsViewer(opts: { rpcUrl?: string; contractId?: string; provider?: JsonRpcProvider } = {}): RoundsViewer {
  const provider = opts.provider ?? (opts.rpcUrl ? rpcProvider(opts.rpcUrl) : nearRpcProvider());
  const view = viewFn(provider, opts.contractId ?? NEAR_ROUNDS);
  return {
    async seriesByReference(reference) {
      const s = await view<SeriesJson | null>('get_series_by_reference', { reference });
      return s ? parseSeries(s) : null;
    },
    async series(seriesId) {
      const s = await view<SeriesJson | null>('get_series', { series_id: seriesId });
      return s ? parseSeries(s) : null;
    },
    async round(seriesId, roundIndex) {
      const r = await view<RoundJson | null>('get_round', { series_id: seriesId, round_index: roundIndex });
      return r ? parseRound(r) : null;
    },
    async position(seriesId, roundIndex, accountId) {
      const p = await view<PositionJson | null>('get_position', { series_id: seriesId, round_index: roundIndex, account_id: accountId });
      return p ? parsePosition(p) : null;
    },
    async positionsOf(accountId) {
      const ps = await view<PositionJson[] | null>('positions_of', { account_id: accountId });
      return (ps ?? []).map(parsePosition);
    },
    async balanceOf(accountId) {
      return big(await view<string | null>('balance_of', { account_id: accountId }));
    },
    async quoteBuy(seriesId, roundIndex, side, amount) {
      const q = await view<QuoteJson>('quote_buy', { series_id: seriesId, round_index: roundIndex, side: sideArg(side), amount: amount.toString() });
      return { shares: big(q.shares), fee: big(q.fee), finderFee: big(q.finder_fee), net: big(q.net) };
    },
    async nearBalance(accountId) {
      try {
        const a = await provider.viewAccount({ accountId });
        return BigInt(a.amount);
      } catch (e) {
        if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error)?.message ?? e))) return null;
        throw e;
      }
    },
  };
}

// ------------------------------------------------------------ call args

export function sideArg(side: RoundSide): 'Up' | 'Down' {
  return side === 'up' ? 'Up' : 'Down';
}

// The JSON arguments of each user call. commit and buy name the round they
// act on: a commit sent just as the keeper opens round N fails instead of
// landing in N+1 (near/SPEC.md).
export const callArgs = {
  commit: (seriesId: number, roundIndex: number, side: RoundSide, amount: bigint) => ({
    series_id: seriesId,
    round_index: roundIndex,
    side: sideArg(side),
    amount: amount.toString(),
  }),
  buy: (seriesId: number, roundIndex: number, side: RoundSide, amount: bigint, minShares: bigint) => ({
    series_id: seriesId,
    round_index: roundIndex,
    side: sideArg(side),
    amount: amount.toString(),
    min_shares: minShares.toString(),
  }),
  claim: (seriesId: number, roundIndex: number) => ({ series_id: seriesId, round_index: roundIndex }),
  claimRollover: (seriesId: number, roundIndex: number) => ({ series_id: seriesId, round_index: roundIndex }),
  faucet: (amount: bigint) => ({ amount: amount.toString() }),
  withdraw: (amount: bigint) => ({ amount: amount.toString() }),
};

// ------------------------------------------------------------------ math

// What a position is owed once its round is settled or void, as the
// contract's `due` computes it.
export function nearDue(r: NearRound, p: PositionLike): bigint {
  if (r.state === 'void') return p.presaleUp + p.presaleDown + p.stakeUp + p.stakeDown;
  if (r.state !== 'settled' || !r.winner) return 0n;
  try {
    return payoutIf(p, r, r.winner);
  } catch {
    return 0n;
  }
}

// A U128 return value (a JSON string) as bigint; 0 for anything else.
export function u128(v: unknown): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return 0n;
}
