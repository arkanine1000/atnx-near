import { houseAccountId } from '../near/house-account';
import { newestQuote, qualifyingQuote, quotePrices, waitingSince } from './house-math';
import type { HouseConfig, HouseMarket, HousePosition, HouseQuote, QuoteIn } from './house-types';
import { CRANK_MAX_IDS, referenceToUuid, uuidToReference } from './house-types';
import { printAtSecs, type PrintRow } from './quote-commitment';
import { toE2 } from './settle';

// The house keeper's decisions as pure functions: the two prices of a
// quote, what a crank would do for a position, which prints are fit to
// push, which atnx.app markets to list, close or settle. The contract makes
// every one of these decisions again and is the judge; the keeper only
// decides what to send. Sending an id that turns out not to be due costs a
// little gas (crank skips it), so the level checks lean towards sending.

const BPS = 10_000n;

// A position this close to its liquidation or cap level, in basis points
// of the level, is cranked: the contract's rounding may differ from this
// file's, and a crank that finds nothing to do is skipped there.
export const DUE_TOLERANCE_BPS = 25n;
// A market's newest print may be this old and still be pushed.
export const MAX_PRINT_AGE_SECS = 600;
// The VI cron writes one print per market per five-minute slot.
export const SLOT_SECS = 300;
// The contract keeps this many recent quotes per market.
export const RING_SIZE = 8;
// crank ids per transaction (the most one call acts on).
export const CRANK_BATCH = CRANK_MAX_IDS;
// The score's step allowance: max_step_bps per this many seconds of print
// time, and never less than MIN_STEP_BPS.
export const STEP_SECS = 300;
export const MIN_STEP_BPS = 10n;
// settle_stale is called this long after the contract would allow it, so
// the keeper's clock never runs ahead of the chain's.
export const STALE_MARGIN_SECS = 60;

// ---------------------------------------------------------- the prices

// The two prices, the fee, PnL, the payout and the levels live in
// ./house-math (no Node imports, so the browser's ticket uses the very same
// functions); re-exported here for the keeper.
export {
  capLevelE2,
  closePrice,
  feeOf,
  gapBps,
  liquidationLevelE2,
  maxProfitOf,
  newestQuote,
  openPrice,
  payoutOf,
  pnlOf,
  qualifyingQuote,
  quotePrices,
  spreadBps,
  waitingSince,
  type QuotePrices,
  type Side,
} from './house-math';

// ------------------------------------------------------------ the ring

// How far a new print's score may move from the stored effective score, in
// bps: max_step_bps per 300 seconds between the two prints' times, at
// least 10 bps.
export function stepAllowanceBps(maxStepBps: number, printAt: number, storedPrintAt: number): bigint {
  const dt = BigInt(Math.max(0, printAt - storedPrintAt));
  const allow = (BigInt(maxStepBps) * dt) / BigInt(STEP_SECS);
  return allow > MIN_STEP_BPS ? allow : MIN_STEP_BPS;
}

// The effective score of a new print: the pushed one, clipped to the step
// allowance around the stored effective score.
export function clipScore(pushedE2: bigint, stored: Pick<HouseQuote, 'scoreE2' | 'printAt'>, printAt: number, maxStepBps: number | null): bigint {
  if (!maxStepBps || stored.scoreE2 <= 0n) return pushedE2;
  const allow = stepAllowanceBps(maxStepBps, printAt, stored.printAt);
  const lo = allow >= BPS ? 0n : (stored.scoreE2 * (BPS - allow)) / BPS;
  const hi = (stored.scoreE2 * (BPS + allow)) / BPS;
  return pushedE2 < lo ? lo : pushedE2 > hi ? hi : pushedE2;
}

// The ring as it would be after these quotes, for decisions before a push
// has landed (dry runs, the one-transaction push and crank). The same
// print again only moves its last read; a newer print is appended, its
// score clipped by clipScore.
export function applyQuotes(markets: HouseMarket[], quotes: QuoteIn[], cfg: Pick<HouseConfig, 'maxStepBps'>, ringSize = RING_SIZE): HouseMarket[] {
  const byMarket = new Map(quotes.map((q) => [q.market, q]));
  return markets.map((m) => {
    const q = byMarket.get(m.id);
    if (!q) return m;
    const ring = m.quotes.map((x) => ({ ...x }));
    const last = ring[ring.length - 1];
    if (last && last.printId === q.printId) {
      last.lastReadAt = Math.max(last.lastReadAt, q.readAt);
    } else if (!last || (q.printId > last.printId && q.printAt > last.printAt)) {
      const score = last ? clipScore(q.scoreE2, last, q.printAt, cfg.maxStepBps) : q.scoreE2;
      ring.push({ scoreE2: score, pushedScoreE2: q.scoreE2, readingE2: q.readingE2, printId: q.printId, printAt: q.printAt, firstReadAt: q.readAt, lastReadAt: q.readAt });
      while (ring.length > ringSize) ring.shift();
    }
    return { ...m, quotes: ring };
  });
}

// ---------------------------------------------------------- crank rules

export type DueAction =
  | 'fill' // 1. a pending order with a quote read after it (fills, or is refunded at that quote)
  | 'refund' // 2. a pending order with no such quote within order_ttl_secs; or 7. its market settled
  | 'liquidate' // 3. at the liquidation level at the newest quote
  | 'cap' // 4. at the profit cap at the newest quote
  | 'close' // 5. a close request with a quote read after it
  | 'expire' // 6. open longer than max_position_secs
  | 'settled'; // 7. an open or closing position on a settled market

type RuleConfig = Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'maxProfitBps' | 'minFillDelaySecs' | 'orderTtlSecs' | 'maxPositionSecs'>;

// A long is liquidated when the buy price is at or below entry · (1 − 1/L);
// a short when the sell price is at or above entry · (1 + 1/L).
export function liquidationDue(p: HousePosition, q: HouseQuote, cfg: RuleConfig, tolBps = DUE_TOLERANCE_BPS): boolean {
  const entry = p.entryE2;
  const lev = BigInt(p.leverage);
  if (entry === null || entry <= 0n || lev < 1n) return false;
  const { buy, sell } = quotePrices(q.scoreE2, q.readingE2, cfg);
  if (p.side === 'Long') return buy * lev * BPS <= entry * (lev - 1n) * (BPS + tolBps);
  return sell * lev * BPS >= entry * (lev + 1n) * (BPS - tolBps);
}

// A long's profit is capped at max_profit_bps of its stake: the cap is
// reached when the sell price is entry · (1 + cap/L). A short's profit is
// at most L times its stake (or the cap when that is lower), reached as
// the buy price falls to entry · (1 − cap/L), zero at the full L.
export function capDue(p: HousePosition, q: HouseQuote, cfg: RuleConfig, tolBps = DUE_TOLERANCE_BPS): boolean {
  const entry = p.entryE2;
  const lev = BigInt(p.leverage);
  if (entry === null || entry <= 0n || lev < 1n) return false;
  const { buy, sell } = quotePrices(q.scoreE2, q.readingE2, cfg);
  const levBps = lev * BPS;
  if (p.side === 'Long') {
    const capBps = BigInt(cfg.maxProfitBps);
    return sell * levBps * BPS >= entry * (levBps + capBps) * (BPS - tolBps);
  }
  const capBps = BigInt(cfg.maxProfitBps) < levBps ? BigInt(cfg.maxProfitBps) : levBps;
  return buy * levBps * BPS <= entry * (levBps - capBps) * (BPS + tolBps);
}

// What crank would do for this position now, or null when nothing is due.
// The rules in the contract's order; the first that applies wins.
export function dueAction(p: HousePosition, m: HouseMarket | undefined | null, cfg: RuleConfig, nowSecs: number, tolBps = DUE_TOLERANCE_BPS): DueAction | null {
  if (!m) return null;
  if (m.status === 'Settled') return p.state === 'Pending' ? 'refund' : 'settled';
  if (p.state === 'Pending') {
    if (qualifyingQuote(m, p.placedAt + cfg.minFillDelaySecs)) return 'fill';
    if (nowSecs >= p.placedAt + cfg.orderTtlSecs) return 'refund';
    return null;
  }
  const q = newestQuote(m);
  if (q && liquidationDue(p, q, cfg, tolBps)) return 'liquidate';
  if (q && capDue(p, q, cfg, tolBps)) return 'cap';
  if (p.state === 'Closing') return qualifyingQuote(m, waitingSince(p) + cfg.minFillDelaySecs) ? 'close' : null;
  if (p.openedAt !== null && nowSecs >= p.openedAt + cfg.maxPositionSecs) return 'expire';
  return null;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`chunk: bad size ${n}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ------------------------------------------------------- reading prints

export interface PrintRead {
  row: PrintRow | null;
  // When the keeper read it: the chain's clock (the latest block's
  // timestamp, whole seconds) fetched just before the query.
  readAt: number;
}

export type GateReason = 'no_print' | 'no_reading' | 'stale';

// A print is pushed only when there is one, it has a reading, and it is at
// most MAX_PRINT_AGE_SECS old. A market left out stops getting quotes, so
// its on-chain quote ages and new orders stop by themselves.
export function healthGate(read: PrintRead | null, nowSecs: number, maxAgeSecs = MAX_PRINT_AGE_SECS): { ok: true } | { ok: false; reason: GateReason } {
  if (!read?.row) return { ok: false, reason: 'no_print' };
  if (read.row.raw_vi === null || read.row.raw_vi === undefined) return { ok: false, reason: 'no_reading' };
  if (nowSecs - printAtSecs(read.row.recorded_at) > maxAgeSecs) return { ok: false, reason: 'stale' };
  return { ok: true };
}

export function slotStart(nowSecs: number, slotSecs = SLOT_SECS): number {
  return Math.floor(nowSecs / slotSecs) * slotSecs;
}

// The print for the current five-minute slot has not been written yet.
export function missingSlot(read: PrintRead | null, nowSecs: number): boolean {
  if (!read?.row) return true;
  return printAtSecs(read.row.recorded_at) < slotStart(nowSecs);
}

export type QuotePlan =
  | { action: 'push' } // a print the chain does not have yet
  | { action: 'repush' } // the chain's newest print, read again: moves its last read
  | { action: 'skip'; reason: 'not_later' | 'read_earlier' | 'numbers_differ' | 'already_read' | 'older_than_chain' };

// Whether a fresh quote can go to the chain, against the market's newest
// quote there. A newer print needs a later print time; the same print
// again must carry the numbers it was pushed with (the score as pushed,
// before any clipping) and a later read. read_at never goes back.
export function planQuote(fresh: QuoteIn, chainNewest: HouseQuote | null): QuotePlan {
  if (!chainNewest) return { action: 'push' };
  if (fresh.printId > chainNewest.printId) {
    if (fresh.printAt <= chainNewest.printAt) return { action: 'skip', reason: 'not_later' };
    if (fresh.readAt < chainNewest.lastReadAt) return { action: 'skip', reason: 'read_earlier' };
    return { action: 'push' };
  }
  if (fresh.printId === chainNewest.printId) {
    const pushed = chainNewest.pushedScoreE2 ?? chainNewest.scoreE2;
    if (fresh.scoreE2 !== pushed || fresh.readingE2 !== chainNewest.readingE2 || fresh.printAt !== chainNewest.printAt) {
      return { action: 'skip', reason: 'numbers_differ' };
    }
    if (fresh.readAt <= chainNewest.lastReadAt) return { action: 'skip', reason: 'already_read' };
    return { action: 'repush' };
  }
  return { action: 'skip', reason: 'older_than_chain' };
}

// ---------------------------------------------------- atnx.app markets

// The columns of public.markets the keeper reads.
export interface AtnxMarketRow {
  id: string;
  created_at: string;
  created_by: string | null;
  current_vi: number | string | null;
  vi_state: string | null;
  vi_last_updated: string | null;
  deleted_at: string | null;
}

export interface ListingCandidate {
  uuid: string;
  reference: string;
  // When the market's life began on atnx.app, unix seconds.
  liveSince: number;
  creator: string | null;
  // The reference is on chain already, as a settled market.
  relist: boolean;
}

export type ListingSkip = 'bad_id' | 'deleted' | 'scoring' | 'listed' | 'low_score' | 'cooloff' | 'stale';

const secsOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// The newest on-chain market per reference (a reference settled and
// listed again has two).
export function chainByReference(markets: HouseMarket[]): Map<string, HouseMarket> {
  const out = new Map<string, HouseMarket>();
  for (const m of markets) {
    const prev = out.get(m.reference);
    if (!prev || m.id > prev.id) out.set(m.reference, m);
  }
  return out;
}

// atnx.app markets to list: live (not scoring), not deleted, a score of at
// least min_score_e2, a life longer than cooloff_secs, a VI updated within
// MAX_PRINT_AGE_SECS, and not on chain (or on chain only as a settled
// market, which comes back as a new one).
export function listingPlan(args: {
  atnx: AtnxMarketRow[];
  chainByRef: Map<string, HouseMarket>;
  cfg: Pick<HouseConfig, 'minScoreE2' | 'cooloffSecs'>;
  nowSecs: number;
  maxViAgeSecs?: number;
}): { list: ListingCandidate[]; skipped: Partial<Record<ListingSkip, number>> } {
  const list: ListingCandidate[] = [];
  const skipped: Partial<Record<ListingSkip, number>> = {};
  const skip = (r: ListingSkip) => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };
  const maxAge = args.maxViAgeSecs ?? MAX_PRINT_AGE_SECS;
  for (const row of args.atnx) {
    let reference: string;
    try {
      reference = uuidToReference(row.id);
    } catch {
      skip('bad_id');
      continue;
    }
    if (row.deleted_at) {
      skip('deleted');
      continue;
    }
    if (row.vi_state !== 'live') {
      skip('scoring');
      continue;
    }
    const onChain = args.chainByRef.get(reference);
    if (onChain && onChain.status !== 'Settled') {
      skip('listed');
      continue;
    }
    const vi = Number(row.current_vi);
    if (!Number.isFinite(vi) || vi < 0 || toE2(vi) < args.cfg.minScoreE2) {
      skip('low_score');
      continue;
    }
    const created = secsOf(row.created_at);
    if (!Number.isFinite(created) || args.nowSecs - created < args.cfg.cooloffSecs) {
      skip('cooloff');
      continue;
    }
    const updated = row.vi_last_updated ? secsOf(row.vi_last_updated) : NaN;
    if (!Number.isFinite(updated) || args.nowSecs - updated > maxAge) {
      skip('stale');
      continue;
    }
    list.push({ uuid: row.id.toLowerCase(), reference, liveSince: created, creator: row.created_by, relist: !!onChain });
  }
  return { list, skipped };
}

// The finder of a new market: the house account of the market creator's
// NEAR account (bm.near_accounts, user id → rounds account id), or none.
export function finderFor(creator: string | null, accounts: Map<string, string>, parent?: string): string | null {
  if (!creator) return null;
  const rounds = accounts.get(creator);
  if (!rounds) return null;
  return houseAccountId(rounds, parent);
}

// Open on-chain markets whose atnx.app market was deleted (or purged):
// they go to CloseOnly, where positions close and liquidate but none open.
export function closeOnlyPlan(markets: HouseMarket[], atnxById: Map<string, AtnxMarketRow>): HouseMarket[] {
  return markets.filter((m) => {
    if (m.status !== 'Open') return false;
    const row = atnxById.get(referenceToUuid(m.reference));
    return !row || !!row.deleted_at;
  });
}

// Markets whose newest quote was last read emergency_secs ago (plus a
// margin): anyone may settle them at their last score, and the keeper does.
// A market that never had a quote is left alone.
export function stalePlan(markets: HouseMarket[], cfg: Pick<HouseConfig, 'emergencySecs'>, nowSecs: number, marginSecs = STALE_MARGIN_SECS): HouseMarket[] {
  return markets.filter((m) => {
    if (m.status === 'Settled' || m.quotes.length === 0) return false;
    const lastRead = Math.max(...m.quotes.map((q) => q.lastReadAt));
    return nowSecs - lastRead >= cfg.emergencySecs + marginSecs;
  });
}
