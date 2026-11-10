// What the house ticket and portfolio show, as pure functions over the
// contract's views (lib/bm/house-types.ts) and its rules
// (lib/bm/house-rules.ts): the two prices, the entry, the fee, the levels,
// the maximum win and the worth on fill; the worst price an order accepts;
// whether an order would be taken now and, if not, why; a position's value
// at the price it would close at; and what became of an order or a close
// after the tap. The relay's checks (lib/near/house-check.ts) use the same
// functions, so the ticket and the relay agree with each other, and both
// with the contract, which decides everything again.
import {
  capLevelE2,
  closePrice,
  feeOf,
  liquidationLevelE2,
  maxProfitOf,
  newestQuote,
  openPrice,
  payoutOf,
  pnlOf,
  qualifyingQuote,
  quotePrices,
  spreadBps,
  type QuotePrices,
} from './house-math';
import type { HouseClosed, HouseConfig, HouseMarket, HousePosition, HouseQuote, HouseSide, HouseVault } from './house-types';

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// The ticket fills in a worst price this far past the current one.
export const LIMIT_SLIP_BPS = 100n;
// After the tap, "Confirming…" turns into "taking longer than usual" here.
export const SLOW_ORDER_MS = 90_000;

export type QuoteRule = Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps'>;

// ------------------------------------------------------------ the ticket

export interface TicketNumbers {
  scoreE2: bigint;
  readingE2: bigint;
  buyE2: bigint;
  sellE2: bigint;
  // Where the order would fill at the newest quote: the buy price for UP,
  // the sell price for DOWN.
  entryE2: bigint;
  // The fee, on top of the stake; cost = stake + fee.
  fee: bigint;
  cost: bigint;
  maxProfit: bigint;
  liquidationE2: bigint;
  capE2: bigint;
  // What the position would be worth the moment it filled at the newest
  // quote: its payout at the close-side price.
  valueOnFill: bigint;
  // (valueOnFill − stake) / stake, in percent.
  valueOnFillPct: number;
  // How far apart the two prices are, in bps of the score (null: a zero
  // score with two different prices).
  spreadBps: bigint | null;
}

export function ticketNumbers(a: {
  cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'feeBps' | 'maxProfitBps'>;
  quote: Pick<HouseQuote, 'scoreE2' | 'readingE2'>;
  side: HouseSide;
  leverage: number;
  stake: bigint;
}): TicketNumbers {
  const px = quotePrices(a.quote.scoreE2, a.quote.readingE2, a.cfg);
  const entry = openPrice(px, a.side);
  const fee = feeOf(a.stake, a.cfg.feeBps ?? 100);
  const maxProfit = maxProfitOf(a.side, a.leverage, a.stake, a.cfg.maxProfitBps);
  const value = entry > 0n ? payoutOf(a.stake, pnlOf(a.side, a.leverage, a.stake, entry, closePrice(px, a.side)), maxProfit) : 0n;
  return {
    scoreE2: a.quote.scoreE2,
    readingE2: a.quote.readingE2,
    buyE2: px.buy,
    sellE2: px.sell,
    entryE2: entry,
    fee,
    cost: a.stake + fee,
    maxProfit,
    liquidationE2: entry > 0n ? liquidationLevelE2(a.side, a.leverage, entry) : 0n,
    capE2: entry > 0n ? capLevelE2(a.side, a.leverage, a.stake, entry, maxProfit) : 0n,
    valueOnFill: value,
    valueOnFillPct: a.stake > 0n ? (Number(value - a.stake) / Number(a.stake)) * 100 : 0,
    spreadBps: spreadBps(px, a.quote.scoreE2),
  };
}

// The worst price an order accepts, `slip` past `priceE2`:
//   open  UP: the highest entry, rounded up; DOWN: the lowest, rounded down;
//   close UP: the lowest exit, rounded down; DOWN: the highest, rounded up.
// Never zero (the contract refuses a limit of zero).
export function limitPastE2(priceE2: bigint, side: HouseSide, kind: 'open' | 'close', slipBps: bigint = LIMIT_SLIP_BPS): bigint {
  const up = (side === 'Long') === (kind === 'open');
  const v = up ? ceilDiv(priceE2 * (BPS + slipBps), BPS) : (priceE2 * (BPS - slipBps)) / BPS;
  return v > 0n ? v : 1n;
}

// Whether a price is within an order's limit, as the contract compares it.
export function withinLimit(side: HouseSide, kind: 'open' | 'close', priceE2: bigint, limitE2: bigint): boolean {
  const up = (side === 'Long') === (kind === 'open');
  return up ? priceE2 <= limitE2 : priceE2 >= limitE2;
}

// The largest stake the balance covers with its fee, within the contract's
// limits; null when it covers less than the minimum.
export function maxStakeFor(balance: bigint, cfg: Pick<HouseConfig, 'feeBps' | 'minStake' | 'maxStake'>): bigint | null {
  const feeBps = BigInt(cfg.feeBps ?? 100);
  let s = (balance * BPS) / (BPS + feeBps);
  while (s > 0n && s + feeOf(s, Number(feeBps)) > balance) s--;
  // Whole cents, so the amount box reads cleanly.
  s -= s % 10_000n;
  const max = cfg.maxStake ?? s;
  if (s > max) s = max;
  return s >= (cfg.minStake ?? 1n) ? s : null;
}

// --------------------------------------------- why an order can't go in

export type OpenBlock =
  | 'not_listed' // the page's market is not on chain
  | 'settled' // the market has ended
  | 'close_only' // positions close here, none open
  | 'paused' // new orders are paused everywhere
  | 'cooloff' // younger than the cool-off
  | 'no_quote' // no price on chain yet
  | 'stale' // the newest price is too old
  | 'low_score' // the score is under the minimum
  | 'spread' // the two prices are too far apart
  | 'zero_price' // the price is zero
  | 'full' // the reserve would break a cap
  | 'positions' // the account holds the most positions allowed
  | 'leverage' // not 2 or 3
  | 'stake_low'
  | 'stake_high'
  | 'balance'; // the balance does not cover stake + fee

type BlockConfig = Pick<
  HouseConfig,
  | 'leadMinBps'
  | 'leadFullGapBps'
  | 'maxOpenGapBps'
  | 'minScoreE2'
  | 'cooloffSecs'
  | 'maxQuoteAgeSecs'
  | 'opensPaused'
  | 'feeBps'
  | 'minStake'
  | 'maxStake'
  | 'maxPositionsPerAccount'
  | 'maxProfitBps'
  | 'marketCapBps'
  | 'utilisationCapBps'
>;

// Why the market takes no order now, whatever the order: null when it
// does. In this order: the market's state, the pause, the cool-off, the
// price (none, too old, the score under the minimum, the two prices too far
// apart, zero for this side).
export function marketBlock(a: { cfg: BlockConfig; market: HouseMarket | null; nowSecs: number; side?: HouseSide }): OpenBlock | null {
  const { cfg, market: m } = a;
  if (!m) return 'not_listed';
  if (m.status === 'Settled') return 'settled';
  if (m.status === 'CloseOnly') return 'close_only';
  if (cfg.opensPaused) return 'paused';
  if (a.nowSecs < m.liveSince + cfg.cooloffSecs) return 'cooloff';
  const q = newestQuote(m);
  if (!q) return 'no_quote';
  if (cfg.maxQuoteAgeSecs !== null && a.nowSecs > q.lastReadAt + cfg.maxQuoteAgeSecs) return 'stale';
  if (q.scoreE2 < cfg.minScoreE2) return 'low_score';
  const px = quotePrices(q.scoreE2, q.readingE2, cfg);
  if (cfg.maxOpenGapBps !== null) {
    const spread = spreadBps(px, q.scoreE2);
    if (spread === null || spread > BigInt(cfg.maxOpenGapBps)) return 'spread';
  }
  if (a.side && openPrice(px, a.side) === 0n) return 'zero_price';
  return null;
}

// Whether a fill of this order now would break a cap: the market's side
// would reserve more than its share of the vault, or the vault more than
// its total share. False when the vault is not known.
export function wouldBeFull(a: { cfg: BlockConfig; market: HouseMarket; vault: HouseVault | null; side: HouseSide; leverage: number; stake: bigint }): boolean {
  const { cfg, market: m, vault: v } = a;
  if (!v) return false;
  const reserve = maxProfitOf(a.side, a.leverage, a.stake, cfg.maxProfitBps);
  const sideCap = m.sideCap ?? (cfg.marketCapBps !== null ? (v.assets * BigInt(cfg.marketCapBps)) / BPS : null);
  const totalCap = cfg.utilisationCapBps !== null ? (v.assets * BigInt(cfg.utilisationCapBps)) / BPS : null;
  const book = a.side === 'Long' ? m.long : m.short;
  if (sideCap !== null && (book?.reserved ?? 0n) + reserve > sideCap) return true;
  if (totalCap !== null && v.reserved + reserve > totalCap) return true;
  return false;
}

// Why this order can't go in now, or null when it can: the market first
// (marketBlock), then the order's terms (leverage, the stake's limits),
// then the caps, then the account (its position limit, its balance).
export function openBlock(a: {
  cfg: BlockConfig;
  market: HouseMarket | null;
  vault: HouseVault | null;
  nowSecs: number;
  side: HouseSide;
  leverage: number;
  stake: bigint;
  // Unknown (null) for a check that has no account to look at.
  balance: bigint | null;
  openCount: number | null;
}): OpenBlock | null {
  const m = marketBlock({ cfg: a.cfg, market: a.market, nowSecs: a.nowSecs, side: a.side });
  if (m) return m;
  if (a.leverage !== 2 && a.leverage !== 3) return 'leverage';
  if (a.cfg.minStake !== null && a.stake < a.cfg.minStake) return 'stake_low';
  if (a.cfg.maxStake !== null && a.stake > a.cfg.maxStake) return 'stake_high';
  if (a.market && wouldBeFull({ cfg: a.cfg, market: a.market, vault: a.vault, side: a.side, leverage: a.leverage, stake: a.stake })) return 'full';
  if (a.openCount !== null && a.cfg.maxPositionsPerAccount !== null && a.openCount >= a.cfg.maxPositionsPerAccount) return 'positions';
  if (a.balance !== null && a.balance < a.stake + feeOf(a.stake, a.cfg.feeBps ?? 100)) return 'balance';
  return null;
}

// The contract's own words for each refusal at open (near/house
// HouseError), so the relay refuses with the text the contract would use.
export const CONTRACT_MESSAGE: Record<Exclude<OpenBlock, 'full'>, string> = {
  not_listed: 'no such market',
  settled: 'market is not open',
  close_only: 'market is not open',
  paused: 'new orders are paused',
  cooloff: 'market is inside its cool-off',
  no_quote: 'market has no quote',
  stale: "the market's newest quote is too old",
  low_score: 'score is under the minimum to open',
  spread: 'the two prices are too far apart',
  zero_price: 'the price is zero',
  positions: 'position limit reached for this account',
  leverage: 'leverage must be 2 or 3',
  stake_low: 'stake below the minimum',
  stake_high: 'stake above the maximum',
  balance: 'balance too low',
};

// A market page whose market is not on chain: why, from the page's own
// numbers (the house lists a market once it is old enough and scores high
// enough). 'cooloff' and 'low_score' read as "not tradable yet";
// 'not_listed' as "not on chain yet". The score comes first: a young market
// under the minimum does not open when its cool-off ends, so the time left
// would promise too much.
export function notListedReason(a: { createdAtSecs: number | null; score: number; nowSecs: number; minScoreE2: bigint; cooloffSecs: number }): 'cooloff' | 'low_score' | 'not_listed' {
  if (!Number.isFinite(a.score) || Math.round(a.score * 100) < Number(a.minScoreE2)) return 'low_score';
  if (a.createdAtSecs !== null && a.nowSecs < a.createdAtSecs + a.cooloffSecs) return 'cooloff';
  return 'not_listed';
}

// Whether the account can fund an order: 'ok' when the balance covers the
// smallest order and its fee; 'faucet' when it does not and the faucet
// still has some of its allowance for this account; 'used_up' when it
// does not and the faucet has given all it gives.
export function fundingState(a: { balance: bigint; claimed: bigint | null; cfg: Pick<HouseConfig, 'minStake' | 'feeBps' | 'faucetPerAccount'> }): 'ok' | 'faucet' | 'used_up' {
  const min = a.cfg.minStake ?? 0n;
  if (a.balance >= min + feeOf(min, a.cfg.feeBps ?? 100) && a.balance > 0n) return 'ok';
  const cap = a.cfg.faucetPerAccount;
  if (cap !== null && a.claimed !== null && a.claimed >= cap) return 'used_up';
  return 'faucet';
}

// ---------------------------------------------------------- positions

export interface PositionMark {
  // The price it would close at: the sell price for UP, the buy price for
  // DOWN, at the newest quote (the final price on a settled market).
  closeE2: bigint;
  value: bigint;
  pnl: bigint;
  pnlPct: number;
  maxProfit: bigint;
  liquidationE2: bigint;
  capE2: bigint;
  // Worth nothing at the close price, but not liquidated: the score has not
  // followed the reading down (UP) or up (DOWN) yet.
  atRisk: boolean;
}

// A filled position valued at the price it would close at; null while it
// is pending or when the market has no price.
export function markPosition(p: HousePosition, m: HouseMarket | null, cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'maxProfitBps'>): PositionMark | null {
  if (p.state === 'Pending' || p.entryE2 === null || p.entryE2 <= 0n || !m) return null;
  const entry = p.entryE2;
  const maxProfit = p.reserved > 0n ? p.reserved : maxProfitOf(p.side, p.leverage, p.stake, cfg.maxProfitBps);
  let close: bigint;
  let px: QuotePrices | null = null;
  if (m.status === 'Settled' && m.finalE2 !== null) close = m.finalE2;
  else {
    const q = newestQuote(m);
    if (!q) return null;
    px = quotePrices(q.scoreE2, q.readingE2, cfg);
    close = closePrice(px, p.side);
  }
  const pnl = pnlOf(p.side, p.leverage, p.stake, entry, close);
  const value = payoutOf(p.stake, pnl, maxProfit);
  const liq = liquidationLevelE2(p.side, p.leverage, entry);
  // Liquidation needs both prices at the level: for UP the buy price (the
  // higher one), for DOWN the sell price (the lower one).
  const liquidatable = px ? (p.side === 'Long' ? px.buy <= liq : px.sell >= liq) : false;
  return {
    closeE2: close,
    value,
    pnl: value - p.stake,
    pnlPct: p.stake > 0n ? (Number(value - p.stake) / Number(p.stake)) * 100 : 0,
    maxProfit,
    liquidationE2: liq,
    capE2: capLevelE2(p.side, p.leverage, p.stake, entry, maxProfit),
    atRisk: value === 0n && !liquidatable,
  };
}

// Seconds until a filled position ends by itself (its 14 days), or null
// before the fill.
export function secondsLeft(p: HousePosition, cfg: Pick<HouseConfig, 'maxPositionSecs'>, nowSecs: number): number | null {
  const end = p.expiresAt ?? (p.openedAt !== null ? p.openedAt + cfg.maxPositionSecs : null);
  return end === null ? null : Math.max(0, end - nowSecs);
}

// The PnL of a closed position: what it paid back less its stake.
export function closedPnl(c: HouseClosed): { pnl: bigint; pnlPct: number } {
  const pnl = c.payout - c.stake;
  return { pnl, pnlPct: c.stake > 0n ? (Number(pnl) / Number(c.stake)) * 100 : 0 };
}

// --------------------------------------------------------- after the tap

export type RefundReason = 'limit' | 'spread' | 'full' | 'score' | 'zero_price' | 'market_closed' | 'expired' | 'cancelled';

// Why a pending order that disappeared without a history entry was
// refunded, worked out from the market as it is now: the quote it was due
// to fill at (the earliest read after it), checked the way a fill checks
// it. The contract's refund event says it outright, but it lands in the
// keeper's transaction, which the browser does not see. Null when the ring
// no longer says.
export function inferRefundReason(
  order: Pick<HousePosition, 'side' | 'leverage' | 'stake' | 'limitE2' | 'placedAt'>,
  m: HouseMarket | null,
  cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'maxOpenGapBps' | 'minScoreE2' | 'minFillDelaySecs' | 'orderTtlSecs'>,
  nowSecs: number,
): RefundReason | null {
  if (!m || m.status !== 'Open') return 'market_closed';
  const q = qualifyingQuote(m, order.placedAt + cfg.minFillDelaySecs);
  if (!q) return nowSecs >= order.placedAt + cfg.orderTtlSecs ? 'expired' : null;
  const px = quotePrices(q.scoreE2, q.readingE2, cfg);
  const entry = openPrice(px, order.side);
  if (entry === 0n) return 'zero_price';
  if (!withinLimit(order.side, 'open', entry, order.limitE2)) return 'limit';
  if (cfg.maxOpenGapBps !== null) {
    const spread = spreadBps(px, q.scoreE2);
    if (spread === null || spread > BigInt(cfg.maxOpenGapBps)) return 'spread';
  }
  if (q.scoreE2 < cfg.minScoreE2) return 'score';
  // Every other fill-time check passed at that quote: the cap refused it.
  return 'full';
}

// How long a read may lag a call that went through.
const LAG_GRACE_MS = 20_000;
// How long a closed position may be missing from the history read.
const CLOSE_HISTORY_GRACE_MS = 60_000;

// One order or close the ticket is following after the tap.
export interface Tracked {
  id: bigint;
  kind: 'open' | 'close' | 'cancel';
  sentAtMs: number;
  // The position as last seen while it waited (null before the first read).
  last: HousePosition | null;
  // A close has been seen as Closing at least once.
  sawClosing?: boolean;
}

export type TrackedOutcome =
  | { phase: 'waiting'; slow: boolean; cancellable: boolean }
  | { phase: 'filled'; entryE2: bigint }
  | { phase: 'refunded'; reason: RefundReason | null }
  | { phase: 'closed'; closed: HouseClosed | null }
  | { phase: 'close_missed' };

// What became of a tracked order or close, from the position's view (null
// once it has ended) and the account's history:
//   open:  Pending → waiting; Open or Closing → filled; gone with a history
//          entry → closed; gone without one → refunded (why, when the ring
//          says);
//   close: Closing → waiting; back to Open after being seen Closing (or
//          still Open 20 seconds on) → close_missed; gone → closed (with
//          what it paid, once the history has it: until then, for up to
//          a minute, still waiting);
//   cancel: gone → refunded as cancelled.
export function trackOutcome(
  t: Tracked,
  now: { position: HousePosition | null; history: readonly HouseClosed[]; market: HouseMarket | null },
  cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'maxOpenGapBps' | 'minScoreE2' | 'minFillDelaySecs' | 'orderTtlSecs'>,
  nowMs: number,
): TrackedOutcome {
  const p = now.position;
  const slow = nowMs - t.sentAtMs >= SLOW_ORDER_MS;
  const nowSecs = Math.floor(nowMs / 1000);
  if (p) {
    if (t.kind === 'close') {
      if (p.state === 'Closing') return { phase: 'waiting', slow, cancellable: false };
      if (p.state === 'Open' && (t.sawClosing || nowMs - t.sentAtMs >= LAG_GRACE_MS)) return { phase: 'close_missed' };
      return { phase: 'waiting', slow, cancellable: false };
    }
    if (p.state === 'Pending') return { phase: 'waiting', slow, cancellable: nowSecs >= p.placedAt + cfg.orderTtlSecs };
    return { phase: 'filled', entryE2: p.entryE2 ?? 0n };
  }
  const closed = now.history.find((c) => c.id === t.id) ?? null;
  if (closed) return { phase: 'closed', closed };
  // A close whose position is gone before its history entry has been read:
  // still closing for a while, so the line goes straight to what it paid.
  if (t.kind === 'close') return nowMs - t.sentAtMs < CLOSE_HISTORY_GRACE_MS ? { phase: 'waiting', slow: false, cancellable: false } : { phase: 'closed', closed: null };
  if (t.kind === 'cancel') return { phase: 'refunded', reason: 'cancelled' };
  // The node read right after the tap can lag the order by a block or two:
  // an order never seen is still waiting for its first 20 seconds.
  if (!t.last && nowMs - t.sentAtMs < LAG_GRACE_MS) return { phase: 'waiting', slow: false, cancellable: false };
  return { phase: 'refunded', reason: t.last ? inferRefundReason(t.last, now.market, cfg, nowSecs) : null };
}

// --------------------------------------------------------------- words

// One plain line per reason an order can't go in. `side` names the side
// for "full"; the cool-off line gets the time left when it is known.
export function blockLine(
  b: OpenBlock,
  a: { side?: HouseSide; minScore?: number; cooloffHours?: number; opensIn?: string | null; minStake?: number; maxStake?: number } = {},
): string {
  const min = a.minScore ?? 100;
  const hours = a.cooloffHours ?? 48;
  switch (b) {
    case 'not_listed':
      return 'Not on chain yet. Markets are added a few minutes after they qualify.';
    case 'settled':
      return 'This market has ended. Its positions closed at its last score.';
    case 'close_only':
      return 'Close only: you can close positions here, not open new ones.';
    case 'paused':
      return 'New orders are paused for now. You can still close positions.';
    case 'cooloff':
      return `Not tradable yet: markets open ${hours} hours after they go live${a.opensIn ? ` (in ${a.opensIn})` : ''}.`;
    case 'no_quote':
      return 'No price on chain yet. Try again in a few minutes.';
    case 'stale':
      return 'The price feed is late. New orders wait for a fresh price.';
    case 'low_score':
      return `Not tradable yet: the index has to be ${min} or more.`;
    case 'spread':
      return 'The two prices are too far apart right now. Try again in a few minutes.';
    case 'zero_price':
      return 'The price is zero right now. Try again in a few minutes.';
    case 'full':
      return `This market is full on the ${a.side === 'Short' ? 'DOWN' : 'UP'} side right now.`;
    case 'positions':
      return 'You hold the most positions allowed. Close one to open another.';
    case 'leverage':
      return 'Pick 2x or 3x.';
    case 'stake_low':
    case 'stake_high':
      return `The amount has to be between ${a.minStake ?? 10} and ${a.maxStake ?? 250} USDG.`;
    case 'balance':
      return 'Not enough test USDG for this amount and the fee.';
  }
}

export function refundLine(r: RefundReason | null): string {
  switch (r) {
    case 'limit':
      return 'Not filled: the price moved past your limit. Your stake and fee are back in your balance.';
    case 'spread':
      return 'Not filled: the two prices were too far apart. Your stake and fee are back in your balance.';
    case 'full':
      return 'Not filled: the market was full. Your stake and fee are back in your balance.';
    case 'score':
      return 'Not filled: the index fell under the minimum. Your stake and fee are back in your balance.';
    case 'zero_price':
      return 'Not filled: the price was zero. Your stake and fee are back in your balance.';
    case 'market_closed':
      return 'Not filled: the market stopped taking orders. Your stake and fee are back in your balance.';
    case 'expired':
      return 'Not filled in time. Your stake and fee are back in your balance.';
    case 'cancelled':
      return 'Cancelled. Your stake and fee are back in your balance.';
    default:
      return 'Not filled. Your stake and fee are back in your balance.';
  }
}

export function closeReasonLine(reason: string): string {
  switch (reason) {
    case 'close':
      return 'Closed';
    case 'cap':
      return 'Hit the 10x cap';
    case 'liquidation':
      return 'Liquidated';
    case 'expiry':
      return 'Ended after 14 days';
    case 'settled':
      return 'Market ended';
    default:
      return reason;
  }
}

// A price in hundredths as the ticket writes it: one decimal from 100 up,
// two below ("408.8", "272.5", "1,635.2", "45.25").
export function fmtPriceE2(e2: bigint): string {
  const v = Number(e2) / 100;
  return v.toLocaleString('en-US', { minimumFractionDigits: v >= 100 ? 1 : 2, maximumFractionDigits: v >= 100 ? 1 : 2 });
}

// A price typed by the trader ("408.8") in hundredths, or null.
export function parsePriceE2(text: string): bigint | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const v = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return v > 0n ? v : null;
}

// "3 d 4 h", "5 h 12 min", "12 min".
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${Math.max(m, s > 0 ? 1 : 0)} min`;
}
