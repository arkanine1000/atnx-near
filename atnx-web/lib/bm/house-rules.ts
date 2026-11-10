import { houseAccountId } from '../near/house-account';
import type { HouseConfig, HouseMarket, HousePosition, HouseQuote, QuoteIn } from './house-types';
import { referenceToUuid, uuidToReference } from './house-types';
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
// crank ids per transaction (the call's log limit).
export const CRANK_BATCH = 20;
// settle_stale is called this long after the contract would allow it, so
// the keeper's clock never runs ahead of the chain's.
export const STALE_MARGIN_SECS = 60;

// ---------------------------------------------------------- the prices

export interface QuotePrices {
  lead: bigint;
  buy: bigint;
  sell: bigint;
}

// The lead moves lambda of the way from the score S to the reading R:
// lambda = min(1, lead_min + (1 − lead_min) · |R − S| / S / lead_full_gap).
// Buy at the higher of S and the lead, sell at the lower. All in _e2.
export function quotePrices(scoreE2: bigint, readingE2: bigint, rule: { leadMinBps: number; leadFullGapBps: number }): QuotePrices {
  const s = scoreE2;
  const r = readingE2;
  const leadMin = BigInt(rule.leadMinBps);
  const fullGap = BigInt(rule.leadFullGapBps);
  const diff = r - s;
  const absDiff = diff < 0n ? -diff : diff;
  let lambda: bigint;
  if (absDiff === 0n) lambda = leadMin;
  else if (s === 0n || fullGap === 0n) lambda = BPS;
  else lambda = leadMin + ((BPS - leadMin) * ((absDiff * BPS) / s)) / fullGap;
  if (lambda > BPS) lambda = BPS;
  const lead = s + (diff * lambda) / BPS;
  return { lead, buy: lead > s ? lead : s, sell: lead < s ? lead : s };
}

// ------------------------------------------------------------ the ring

// The newest quote of a market (the ring is sorted by print id).
export function newestQuote(m: HouseMarket): HouseQuote | null {
  return m.quotes.length ? m.quotes[m.quotes.length - 1] : null;
}

// The earliest quote read at or after `since` (unix seconds): what an order
// placed at `since − min_fill_delay_secs` fills at.
export function qualifyingQuote(m: HouseMarket, since: number): HouseQuote | null {
  return m.quotes.find((q) => q.lastReadAt >= since) ?? null;
}

// When a waiting position started waiting: the order's placement, or the
// close request.
export function waitingSince(p: HousePosition): number {
  return p.state === 'Closing' ? (p.closeRequestedAt ?? p.placedAt) : p.placedAt;
}

// The ring as it would be after these quotes, for decisions before a push
// has landed (dry runs, the one-transaction push and crank). The same
// print again only moves its last read; a newer print is appended, its
// score clipped to max_step_bps of the last one.
export function applyQuotes(markets: HouseMarket[], quotes: QuoteIn[], cfg: Pick<HouseConfig, 'maxStepBps'>, ringSize = RING_SIZE): HouseMarket[] {
  const byMarket = new Map(quotes.map((q) => [q.market, q]));
  return markets.map((m) => {
    const q = byMarket.get(m.id);
    if (!q) return m;
    const ring = m.quotes.map((x) => ({ ...x }));
    const last = ring[ring.length - 1];
    if (last && last.printId === q.printId) {
      last.lastReadAt = Math.max(last.lastReadAt, q.readAt);
    } else if (!last || q.printId > last.printId) {
      let score = q.scoreE2;
      if (last && cfg.maxStepBps && last.scoreE2 > 0n) {
        const step = BigInt(cfg.maxStepBps);
        const lo = (last.scoreE2 * (BPS - step)) / BPS;
        const hi = (last.scoreE2 * (BPS + step)) / BPS;
        score = score < lo ? lo : score > hi ? hi : score;
      }
      ring.push({ scoreE2: score, readingE2: q.readingE2, printId: q.printId, printAt: q.printAt, firstReadAt: q.readAt, lastReadAt: q.readAt });
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
  // When the keeper read it, unix seconds: the later of the second the
  // query started and the print's own second (a row cannot be read before
  // it was written).
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

export function readAtOf(queryStartedMs: number, row: PrintRow | null): number {
  const started = Math.floor(queryStartedMs / 1000);
  return row ? Math.max(started, printAtSecs(row.recorded_at)) : started;
}

export type QuotePlan =
  | { action: 'push' } // a print the chain does not have yet
  | { action: 'repush' } // the chain's newest print, read again: moves its last read
  | { action: 'skip'; reason: 'too_soon' | 'read_earlier' | 'numbers_differ' | 'already_read' | 'older_than_chain' };

// Whether a fresh quote can go to the chain, against the market's newest
// quote there. A newer print must come at least min_quote_gap_secs after
// the stored one; until then the market is left out rather than the older
// print being read again, so no order fills at a print older than one
// already public. The same print again must carry the same numbers and a
// later read.
export function planQuote(fresh: QuoteIn, chainNewest: HouseQuote | null, cfg: Pick<HouseConfig, 'minQuoteGapSecs'>): QuotePlan {
  if (!chainNewest) return { action: 'push' };
  if (fresh.printId > chainNewest.printId) {
    if (fresh.printAt < chainNewest.printAt + cfg.minQuoteGapSecs) return { action: 'skip', reason: 'too_soon' };
    if (fresh.readAt < chainNewest.lastReadAt) return { action: 'skip', reason: 'read_earlier' };
    return { action: 'push' };
  }
  if (fresh.printId === chainNewest.printId) {
    if (fresh.scoreE2 !== chainNewest.scoreE2 || fresh.readingE2 !== chainNewest.readingE2 || fresh.printAt !== chainNewest.printAt) {
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
