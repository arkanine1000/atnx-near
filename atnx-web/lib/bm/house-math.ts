// The house's price arithmetic in TypeScript, as near/house computes it
// (quote.rs): the two prices of a quote, the spread, the fee, the maximum
// profit, PnL, the payout and the liquidation and cap levels, plus the
// quote ring's lookups. Integers only, rounded the way the contract rounds.
// No Node imports: the keeper (through ./house-rules) and the browser's
// ticket (./house-ticket) use these same functions.
import type { HouseMarket, HousePosition, HouseQuote } from './house-types';

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

export interface QuotePrices {
  lead: bigint;
  buy: bigint;
  sell: bigint;
}

// |R − S| / S in bps, rounded up; a zero score with a non-zero reading is
// an infinite gap (null).
export function gapBps(scoreE2: bigint, readingE2: bigint): bigint | null {
  const d = scoreE2 > readingE2 ? scoreE2 - readingE2 : readingE2 - scoreE2;
  if (d === 0n) return 0n;
  if (scoreE2 <= 0n) return null;
  return ceilDiv(d * BPS, scoreE2);
}

// The lead moves lambda of the way from the score S to the reading R:
// lambda = min(1, lead_min + (1 − lead_min) · gap / lead_full_gap), with
// gap = |R − S| / S. Buy at the higher of S and the lead, sell at the lower.
// All in _e2, rounded as the contract rounds (near/house quote.rs): the
// gap, lambda and the lead's distance from S round up, and the lead never
// passes R, so the buy price rounds up and the sell price down.
export function quotePrices(scoreE2: bigint, readingE2: bigint, rule: { leadMinBps: number; leadFullGapBps: number }): QuotePrices {
  const s = scoreE2;
  const r = readingE2;
  const leadMin = BigInt(Math.min(Math.max(rule.leadMinBps, 0), 10_000));
  const fullGap = BigInt(Math.max(rule.leadFullGapBps, 0));
  const d = r > s ? r - s : s - r;
  const gap = gapBps(s, r);
  let lambda: bigint;
  if (fullGap === 0n || gap === null || gap >= fullGap) lambda = BPS;
  else lambda = leadMin + ceilDiv((BPS - leadMin) * gap, fullGap);
  if (lambda > BPS) lambda = BPS;
  let moved = ceilDiv(d * lambda, BPS);
  if (moved > d) moved = d;
  const lead = r >= s ? s + moved : s - moved;
  return { lead, buy: lead > s ? lead : s, sell: lead < s ? lead : s };
}

// How far apart the two prices are, (buy − sell) / S in bps, rounded up:
// the open guard compares this with max_open_gap_bps. Two different prices
// at a score of zero are infinitely far apart (null).
export function spreadBps(p: QuotePrices, scoreE2: bigint): bigint | null {
  const d = p.buy - p.sell;
  if (d === 0n) return 0n;
  if (scoreE2 <= 0n) return null;
  return ceilDiv(d * BPS, scoreE2);
}

export type Side = 'Long' | 'Short';

// A long opens at the buy price and closes at the sell price; a short the
// other way round.
export const openPrice = (p: QuotePrices, side: Side) => (side === 'Long' ? p.buy : p.sell);
export const closePrice = (p: QuotePrices, side: Side) => (side === 'Long' ? p.sell : p.buy);

// The fee on a stake, charged on top of it at the fill, rounded up.
export function feeOf(stake: bigint, feeBps: number): bigint {
  return ceilDiv(stake * BigInt(feeBps), BPS);
}

// The most a position can win, reserved in the vault at the fill:
// max_profit_bps of the stake for a long; the same for a short, but never
// more than leverage × stake (a short's best case is a price of zero).
export function maxProfitOf(side: Side, leverage: number, stake: bigint, maxProfitBps: number): bigint {
  const cap = (stake * BigInt(maxProfitBps)) / BPS;
  if (side === 'Long') return cap;
  const full = stake * BigInt(leverage);
  return cap < full ? cap : full;
}

// Profit or loss before the floor and the cap, rounded down:
// long  stake × leverage × (exit / entry − 1);
// short stake × leverage × (1 − exit / entry).
export function pnlOf(side: Side, leverage: number, stake: bigint, entryE2: bigint, exitE2: bigint): bigint {
  if (entryE2 <= 0n) return 0n;
  const diff = side === 'Long' ? exitE2 - entryE2 : entryE2 - exitE2;
  return floorDiv(stake * BigInt(leverage) * diff, entryE2);
}

// What a position pays back: stake + PnL, at least 0, at most stake + the
// maximum profit.
export function payoutOf(stake: bigint, pnl: bigint, maxProfit: bigint): bigint {
  const v = stake + pnl;
  return v < 0n ? 0n : v > stake + maxProfit ? stake + maxProfit : v;
}

// The liquidation level: the highest buy price that liquidates a long,
// entry × (1 − 1/L) rounded down; the lowest sell price that liquidates a
// short, entry × (1 + 1/L) rounded up.
export function liquidationLevelE2(side: Side, leverage: number, entryE2: bigint): bigint {
  const lev = BigInt(Math.max(leverage, 2));
  return side === 'Long' ? (entryE2 * (lev - 1n)) / lev : ceilDiv(entryE2 * (lev + 1n), lev);
}

// The cap level: the lowest sell price at which a long's profit reaches
// its maximum, the highest buy price at which a short's does (0 when the
// maximum is the whole notional).
export function capLevelE2(side: Side, leverage: number, stake: bigint, entryE2: bigint, maxProfit: bigint): bigint {
  const notional = stake * BigInt(leverage);
  if (notional === 0n) return 0n;
  const move = ceilDiv(maxProfit * entryE2, notional);
  if (side === 'Long') return entryE2 + move;
  return entryE2 > move ? entryE2 - move : 0n;
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
